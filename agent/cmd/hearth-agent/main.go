// Command hearth-agent runs on each game server instance and manages the game container.
// It runs as a systemd service: started at boot, and stopped (SIGTERM) when the instance shuts down.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/tarik-alauddin/hearth/agent/internal/agent"
	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/games"
	"github.com/tarik-alauddin/hearth/agent/internal/update"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// exitRestartForUpdate tells systemd (Restart=on-failure) to restart us, so the bootstrap starts the
// staged update. 75 is EX_TEMPFAIL.
const exitRestartForUpdate = 75

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("hearth-agent", flag.ContinueOnError)
	flags.SetOutput(stderr)
	showVersion := flags.Bool("version", false, "print the version and exit")
	logLevel := flags.String("log-level", envOr("HEARTH_LOG_LEVEL", "info"), "debug, info, warn or error")
	stopTimeout := flags.Duration("stop-timeout", 90*time.Second, "how long a graceful stop may take")
	env := flags.String("env", os.Getenv("HEARTH_ENV"), "environment (dev, stage or prod); used to find the API")
	homeRegion := flags.String("home-region", envOr("HEARTH_HOME_REGION", "us-west-2"), "region of the Hearth API")
	apiURL := flags.String("api-url", os.Getenv("HEARTH_API_URL"), "API endpoint; read from SSM /hearth/<env>/api-url if empty")
	dataDir := flags.String("data-dir", envOr("HEARTH_DATA_DIR", "/srv/hearth"), "root of the world data volume")
	binDir := flags.String("bin-dir", envOr("HEARTH_BIN_DIR", "/opt/hearth/bin"), "where the bootstrap keeps agent binaries")
	stateDir := flags.String("state-dir", envOr("HEARTH_STATE_DIR", "/var/lib/hearth"), "agent health records shared with the bootstrap")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintln(stdout, version)
		return 0
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		fmt.Fprintf(stderr, "invalid -log-level %q\n", *logLevel)
		return 2
	}
	if *apiURL == "" && *env == "" {
		fmt.Fprintln(stderr, "one of -env or -api-url is required")
		return 2
	}
	// JSON on stdout; journald keeps it, and it's ready to ship to CloudWatch later.
	logger := slog.New(slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: level})).With("version", version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// On an instance, credentials come from the instance role via IMDS.
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(*homeRegion))
	if err != nil {
		logger.Error("loading AWS config failed", "err", err)
		return 1
	}
	if *apiURL == "" {
		if *apiURL, err = lookupAPIURL(ctx, logger, ssm.NewFromConfig(awsCfg), *env); err != nil {
			logger.Error("finding the API failed", "err", err)
			return 1
		}
	}
	logger.Info("using API", "url", *apiURL)

	s3Client := s3.NewFromConfig(awsCfg)
	updater := &update.Updater{
		BinDir:   *binDir,
		StateDir: *stateDir,
		Version:  version,
		Download: func(ctx context.Context, url string) (io.ReadCloser, error) {
			bucket, key, err := update.ParseS3URL(url)
			if err != nil {
				return nil, err
			}
			out, err := s3Client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
			if err != nil {
				return nil, err
			}
			return out.Body, nil
		},
	}

	a := agent.New(agent.Options{
		Logger:      logger,
		Version:     version,
		API:         api.New(*apiURL, *homeRegion, awsCfg.Credentials),
		Runtime:     container.NewDocker(),
		Games:       games.Registry(),
		DataDir:     *dataDir,
		MemoryMiB:   agent.HostMemoryMiB(),
		StopTimeout: *stopTimeout,
		Updater:     updater,
	})
	switch err := a.Run(ctx); {
	case errors.Is(err, agent.ErrUpdateStaged):
		return exitRestartForUpdate
	case err != nil:
		logger.Error("agent failed", "err", err)
		return 1
	}
	return 0
}

// lookupAPIURL reads the API endpoint ApiStack publishes, retrying while the instance's
// network and credentials settle at boot.
func lookupAPIURL(ctx context.Context, logger *slog.Logger, client *ssm.Client, env string) (string, error) {
	name := "/hearth/" + env + "/api-url"
	for attempt := 1; ; attempt++ {
		out, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name)})
		if err == nil {
			return aws.ToString(out.Parameter.Value), nil
		}
		if attempt == 5 {
			return "", fmt.Errorf("read %s: %w", name, err)
		}
		logger.Warn("reading the API URL failed; retrying", "parameter", name, "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return "", errors.Join(ctx.Err(), err)
		case <-time.After(time.Duration(attempt) * 2 * time.Second):
		}
	}
}

func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}
