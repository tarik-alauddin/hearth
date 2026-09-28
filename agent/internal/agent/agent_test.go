package agent

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestRunStopsWhenContextIsCancelled(t *testing.T) {
	var logs bytes.Buffer
	a := New(Options{Logger: slog.New(slog.NewTextHandler(&logs, nil)), StopTimeout: time.Second})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	select {
	case err := <-done:
		t.Fatalf("Run returned before shutdown was requested: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after shutdown was requested")
	}

	for _, msg := range []string{"agent starting", "shutdown requested", "agent stopped"} {
		if !strings.Contains(logs.String(), msg) {
			t.Errorf("logs missing %q:\n%s", msg, logs.String())
		}
	}
}
