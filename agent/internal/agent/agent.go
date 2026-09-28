// Package agent runs a game server's lifecycle on its instance.
package agent

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

type Options struct {
	Logger *slog.Logger
	// StopTimeout bounds the graceful stop (save the world, stop the container) after shutdown is requested.
	StopTimeout time.Duration
}

type Agent struct {
	log         *slog.Logger
	stopTimeout time.Duration
}

func New(opts Options) *Agent {
	return &Agent{log: opts.Logger, stopTimeout: opts.StopTimeout}
}

// Run starts the game, then blocks until ctx is cancelled (the instance is shutting down)
// and stops the game gracefully within StopTimeout.
func (a *Agent) Run(ctx context.Context) error {
	a.log.Info("agent starting")
	if err := a.start(ctx); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	<-ctx.Done()
	a.log.Info("shutdown requested")

	// The stop gets its own deadline: ctx is already cancelled, but saving the world must still finish.
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.stopTimeout)
	defer cancel()
	if err := a.stop(stopCtx); err != nil {
		return fmt.Errorf("stop: %w", err)
	}
	a.log.Info("agent stopped")
	return nil
}

// start fetches config, starts the game container and reports status. Filled in later in M2.
func (a *Agent) start(ctx context.Context) error {
	return nil
}

// stop saves the world over RCON and stops the container. Filled in later in M2.
func (a *Agent) stop(ctx context.Context) error {
	return nil
}
