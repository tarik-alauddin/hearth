package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"-version"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code %d, stderr: %s", code, stderr.String())
	}
	if got := strings.TrimSpace(stdout.String()); got != version {
		t.Errorf("printed %q, want %q", got, version)
	}
}

func TestInvalidLogLevel(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"-log-level", "loud"}, &stdout, &stderr); code != 2 {
		t.Errorf("exit code %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "invalid -log-level") {
		t.Errorf("stderr: %s", stderr.String())
	}
}

func TestUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"-nope"}, &stdout, &stderr); code != 2 {
		t.Errorf("exit code %d, want 2", code)
	}
}

func TestRequiresEnvOrAPIURL(t *testing.T) {
	t.Setenv("HEARTH_ENV", "")
	t.Setenv("HEARTH_API_URL", "")
	var stdout, stderr bytes.Buffer
	if code := run(nil, &stdout, &stderr); code != 2 {
		t.Errorf("exit code %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "-env or -api-url") {
		t.Errorf("stderr: %s", stderr.String())
	}
}
