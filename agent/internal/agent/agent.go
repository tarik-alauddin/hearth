// Package agent runs a game server's lifecycle on its instance. It knows nothing about any
// particular game: everything game-specific comes from a game.Adapter.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// ContainerName is the one game container on each instance.
const ContainerName = "hearth-game"

// API is the Hearth API's agent routes.
type API interface {
	Config(ctx context.Context) (game.Config, error)
	ReportStatus(ctx context.Context, report api.StatusReport) error
}

// Runtime runs the game container.
type Runtime interface {
	Start(ctx context.Context, spec container.Spec) error
	Wait(ctx context.Context, name string) (int, error)
	Stop(ctx context.Context, name string, timeout time.Duration) error
}

type Options struct {
	Logger  *slog.Logger
	Version string
	API     API
	Runtime Runtime
	Games   map[string]game.Factory
	// DataDir is the root of the world data volume.
	DataDir   string
	MemoryMiB int
	// StopTimeout bounds the graceful stop (save the world, stop the container) after shutdown is requested.
	StopTimeout time.Duration
	// ReadyTimeout bounds how long the game may take to accept players. Defaults to 15 minutes,
	// enough for a first start that downloads the server and generates a world.
	ReadyTimeout time.Duration
	// PollInterval is how often readiness is checked. Defaults to 5 seconds.
	PollInterval time.Duration
	// MaxBackoff caps the wait between retries of API calls and container starts. Defaults to 30 seconds.
	MaxBackoff time.Duration
}

type Agent struct {
	Options
	log *slog.Logger
}

func New(opts Options) *Agent {
	if opts.ReadyTimeout == 0 {
		opts.ReadyTimeout = 15 * time.Minute
	}
	if opts.PollInterval == 0 {
		opts.PollInterval = 5 * time.Second
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = 30 * time.Second
	}
	return &Agent{Options: opts, log: opts.Logger}
}

// Run starts the game and keeps it running until ctx is cancelled (the instance is shutting
// down), then saves and stops it within StopTimeout. Problems are reported to the API as the
// "error" state rather than ending the agent, so they're visible without logging in.
func (a *Agent) Run(ctx context.Context) error {
	a.log.Info("agent starting")

	cfg, err := a.fetchConfig(ctx)
	if err != nil {
		a.log.Info("shutdown requested before the config arrived")
		return nil
	}
	a.log = a.log.With("serverId", cfg.ServerID, "game", cfg.Game)

	newAdapter, ok := a.Games[cfg.Game]
	if !ok {
		a.fail(ctx, fmt.Sprintf("this agent can't run game %q", cfg.Game))
		<-ctx.Done()
		return nil
	}
	adapter := newAdapter()
	cfg.DataDir, cfg.MemoryMiB = a.DataDir, a.MemoryMiB
	spec := adapter.Container(cfg)
	spec.Name = ContainerName

	a.report(ctx, "starting", "")
	if err := a.startContainer(ctx, spec); err != nil {
		if ctx.Err() == nil {
			a.fail(ctx, err.Error())
			<-ctx.Done()
		}
		return a.shutdown(ctx, spec, adapter, false)
	}

	waitCtx, stopWaiting := context.WithCancel(context.WithoutCancel(ctx))
	defer stopWaiting()
	exited := make(chan string, 1)
	go func() {
		code, err := a.Runtime.Wait(waitCtx, ContainerName)
		if err != nil {
			exited <- fmt.Sprintf("lost track of the game container: %v", err)
		} else {
			exited <- fmt.Sprintf("the game exited with code %d", code)
		}
	}()

	ready := a.waitReady(ctx, adapter, exited)
	if ready {
		a.log.Info("game ready")
		a.report(ctx, "ready", "")
		select {
		case <-ctx.Done():
		case msg := <-exited:
			a.fail(ctx, msg)
			ready = false
			<-ctx.Done()
		}
	} else {
		<-ctx.Done()
	}
	stopWaiting()
	return a.shutdown(ctx, spec, adapter, ready)
}

// fetchConfig retries until the API answers. Early failures are expected: IAM and the
// instance's server record may not be in place yet when the instance first boots.
func (a *Agent) fetchConfig(ctx context.Context) (game.Config, error) {
	for attempt := 1; ; attempt++ {
		cfg, err := a.API.Config(ctx)
		if err == nil {
			return cfg, nil
		}
		a.log.Warn("fetching config failed; retrying", "attempt", attempt, "err", err)
		if !a.sleep(ctx, a.backoff(attempt)) {
			return game.Config{}, ctx.Err()
		}
	}
}

// startContainer retries a few times, since image pulls can fail while the network settles at boot.
func (a *Agent) startContainer(ctx context.Context, spec container.Spec) error {
	const attempts = 3
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err = a.Runtime.Start(ctx, spec); err == nil {
			a.log.Info("game container started", "image", spec.Image)
			return nil
		}
		a.log.Warn("starting the game container failed", "attempt", attempt, "err", err)
		if attempt < attempts && !a.sleep(ctx, a.backoff(attempt)) {
			return ctx.Err()
		}
	}
	return fmt.Errorf("couldn't start the game container: %w", err)
}

// waitReady polls the adapter until the game accepts players. It gives up, reporting an error,
// if the game exits or takes longer than ReadyTimeout; it returns false quietly on shutdown.
func (a *Agent) waitReady(ctx context.Context, adapter game.Adapter, exited <-chan string) bool {
	deadline := time.NewTimer(a.ReadyTimeout)
	defer deadline.Stop()
	for {
		checkCtx, cancel := context.WithTimeout(ctx, a.PollInterval)
		err := adapter.Ready(checkCtx)
		cancel()
		if err == nil {
			return true
		}
		a.log.Debug("game not ready yet", "err", err)

		select {
		case <-ctx.Done():
			return false
		case msg := <-exited:
			a.fail(ctx, msg+" before it was ready")
			return false
		case <-deadline.C:
			a.fail(ctx, fmt.Sprintf("the game wasn't ready after %s", a.ReadyTimeout))
			return false
		case <-time.After(a.PollInterval):
		}
	}
}

// shutdown saves the world (if the game got far enough to have one loaded) and stops the container.
// It runs on its own deadline: ctx is already cancelled, but the save must still finish.
func (a *Agent) shutdown(ctx context.Context, spec container.Spec, adapter game.Adapter, save bool) error {
	a.log.Info("shutdown requested")
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.StopTimeout)
	defer cancel()

	a.report(stopCtx, "stopping", "")
	var errs []error
	if save {
		if err := adapter.Save(stopCtx); err != nil {
			// Keep going: stopping the container also makes the game save.
			a.log.Error("saving before stop failed", "err", err)
			errs = append(errs, fmt.Errorf("save: %w", err))
		} else {
			a.log.Info("world saved")
		}
	}
	if err := a.Runtime.Stop(stopCtx, ContainerName, spec.StopTimeout); err != nil {
		a.log.Error("stopping the game container failed", "err", err)
		errs = append(errs, fmt.Errorf("stop container: %w", err))
	}

	if err := errors.Join(errs...); err != nil {
		a.report(stopCtx, "error", err.Error())
		return err
	}
	a.report(stopCtx, "stopped", "")
	a.log.Info("agent stopped")
	return nil
}

func (a *Agent) fail(ctx context.Context, msg string) {
	a.log.Error(msg)
	a.report(ctx, "error", msg)
}

// report sends a status report, retrying briefly. Reports are best effort: failing to report
// never stops the game from running or saving.
func (a *Agent) report(ctx context.Context, state, msg string) {
	report := api.StatusReport{State: state, AgentVersion: a.Version, Message: msg}
	for attempt := 1; attempt <= 3; attempt++ {
		err := a.API.ReportStatus(ctx, report)
		if err == nil {
			return
		}
		a.log.Warn("status report failed", "state", state, "attempt", attempt, "err", err)
		if attempt < 3 && !a.sleep(ctx, a.backoff(attempt)) {
			return
		}
	}
}

// backoff doubles from one second up to MaxBackoff.
func (a *Agent) backoff(attempt int) time.Duration {
	d := time.Second << min(attempt-1, 10)
	return min(d, a.MaxBackoff)
}

// sleep waits for d, returning false if ctx is cancelled first.
func (a *Agent) sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
