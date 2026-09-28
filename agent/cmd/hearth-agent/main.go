// Command hearth-agent runs on each game server instance and manages the game container.
// It runs as a systemd service: started at boot, and stopped (SIGTERM) when the instance shuts down.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tarik-alauddin/hearth/agent/internal/agent"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("hearth-agent", flag.ContinueOnError)
	flags.SetOutput(stderr)
	showVersion := flags.Bool("version", false, "print the version and exit")
	logLevel := flags.String("log-level", envOr("HEARTH_LOG_LEVEL", "info"), "debug, info, warn or error")
	stopTimeout := flags.Duration("stop-timeout", 90*time.Second, "how long a graceful stop may take")
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
	// JSON on stdout; journald keeps it, and it's ready to ship to CloudWatch later.
	logger := slog.New(slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: level})).With("version", version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a := agent.New(agent.Options{Logger: logger, StopTimeout: *stopTimeout})
	if err := a.Run(ctx); err != nil {
		logger.Error("agent failed", "err", err)
		return 1
	}
	return 0
}

func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}
