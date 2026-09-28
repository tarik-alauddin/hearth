// Package container runs a game container from a Spec using the docker CLI.
package container

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Spec is a game-agnostic description of the container to run; game adapters build it.
type Spec struct {
	Name  string
	Image string
	// Env may contain secrets; it is passed to docker in a private env file, never on the command line.
	Env    map[string]string
	Ports  []Port
	Mounts []Mount
	// StopTimeout is how long docker waits after SIGTERM before killing the container.
	StopTimeout time.Duration
}

type Port struct {
	// HostIP is "0.0.0.0" for players, "127.0.0.1" for ports only the agent uses.
	HostIP        string
	HostPort      int
	ContainerPort int
	Protocol      string // "tcp" or "udp"
}

type Mount struct {
	Source string // host path; created if missing
	Target string
}

// Docker runs containers through the docker CLI.
type Docker struct {
	// run executes docker with args and returns its trimmed stdout. Replaced in tests.
	run func(ctx context.Context, args ...string) (string, error)
}

func NewDocker() *Docker {
	return &Docker{run: runDocker}
}

// Start replaces any container left from a previous boot with a fresh one from spec.
// Game data lives in mounts, so nothing is lost by recreating the container.
func (d *Docker) Start(ctx context.Context, spec Spec) error {
	for _, m := range spec.Mounts {
		if err := os.MkdirAll(m.Source, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", m.Source, err)
		}
	}

	envFile, err := writeEnvFile(spec.Env)
	if err != nil {
		return err
	}
	defer os.Remove(envFile)

	_, _ = d.run(ctx, "rm", "--force", spec.Name) // fails harmlessly when there is no old container
	if _, err := d.run(ctx, runArgs(spec, envFile)...); err != nil {
		return fmt.Errorf("start %s: %w", spec.Name, err)
	}
	return nil
}

func runArgs(spec Spec, envFile string) []string {
	args := []string{
		"run", "--detach", "--name", spec.Name,
		"--env-file", envFile,
		"--stop-timeout", strconv.Itoa(int(spec.StopTimeout.Seconds())),
		"--log-opt", "max-size=10m", "--log-opt", "max-file=3",
	}
	for _, p := range spec.Ports {
		args = append(args, "--publish", fmt.Sprintf("%s:%d:%d/%s", p.HostIP, p.HostPort, p.ContainerPort, p.Protocol))
	}
	for _, m := range spec.Mounts {
		args = append(args, "--volume", m.Source+":"+m.Target)
	}
	return append(args, spec.Image)
}

// Running reports whether the named container is running.
func (d *Docker) Running(ctx context.Context, name string) (bool, error) {
	out, err := d.run(ctx, "inspect", "--format", "{{.State.Running}}", name)
	if err != nil {
		return false, err
	}
	return out == "true", nil
}

// Wait blocks until the named container exits and returns its exit code.
func (d *Docker) Wait(ctx context.Context, name string) (int, error) {
	out, err := d.run(ctx, "wait", name)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(out)
}

// Stop sends SIGTERM and waits up to the container's stop timeout before killing it.
func (d *Docker) Stop(ctx context.Context, name string, timeout time.Duration) error {
	_, err := d.run(ctx, "stop", "--time", strconv.Itoa(int(timeout.Seconds())), name)
	return err
}

func writeEnvFile(env map[string]string) (string, error) {
	f, err := os.CreateTemp("", "hearth-env-*") // created with mode 0600
	if err != nil {
		return "", err
	}
	defer f.Close()
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if strings.ContainsAny(env[k], "\r\n") {
			os.Remove(f.Name())
			return "", fmt.Errorf("env %s contains a newline", k)
		}
		fmt.Fprintf(f, "%s=%s\n", k, env[k])
	}
	return f.Name(), nil
}

func runDocker(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}
