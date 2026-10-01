package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

var release = []byte("#!/bin/sh\necho new agent\n")

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func newUpdater(t *testing.T, body []byte) (*Updater, *[]string) {
	t.Helper()
	var downloads []string
	u := &Updater{
		BinDir:   t.TempDir(),
		StateDir: t.TempDir(),
		Version:  "1.2.3",
		Download: func(_ context.Context, url string) (io.ReadCloser, error) {
			downloads = append(downloads, url)
			return io.NopCloser(bytes.NewReader(body)), nil
		},
	}
	return u, &downloads
}

func target(version string, sha string) game.AgentTarget {
	return game.AgentTarget{Version: version, URL: "s3://releases/agent/" + version + "/hearth-agent-linux-arm64", SHA256: sha}
}

func TestStagesAVerifiedUpdate(t *testing.T) {
	u, downloads := newUpdater(t, release)
	staged, err := u.Stage(context.Background(), target("1.3.0", sum(release)))
	if err != nil || !staged {
		t.Fatalf("Stage = %v, %v", staged, err)
	}
	next := filepath.Join(u.BinDir, "hearth-agent.next")
	got, err := os.ReadFile(next)
	if err != nil || !bytes.Equal(got, release) {
		t.Fatalf("staged binary %q, %v", got, err)
	}
	if info, _ := os.Stat(next); runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Errorf("mode %v, want executable", info.Mode())
	}
	if len(*downloads) != 1 {
		t.Errorf("downloads %v", *downloads)
	}
}

func TestSkipsTheRunningVersion(t *testing.T) {
	u, downloads := newUpdater(t, release)
	if staged, err := u.Stage(context.Background(), target("1.2.3", sum(release))); staged || err != nil {
		t.Fatalf("Stage = %v, %v", staged, err)
	}
	if len(*downloads) != 0 {
		t.Error("should not download the version already running")
	}
}

func TestSkipsAVersionThatFailedBefore(t *testing.T) {
	u, downloads := newUpdater(t, release)
	_ = os.WriteFile(filepath.Join(u.StateDir, "agent-failed"), []byte("1.3.0\n"), 0o644)
	if staged, _ := u.Stage(context.Background(), target("1.3.0", sum(release))); staged {
		t.Fatal("staged a version the bootstrap fell back from")
	}
	if len(*downloads) != 0 {
		t.Error("should not download a failed version")
	}
	if u.FailedVersion() != "1.3.0" {
		t.Errorf("FailedVersion = %q", u.FailedVersion())
	}
}

func TestRejectsACorruptDownload(t *testing.T) {
	u, _ := newUpdater(t, []byte("tampered"))
	staged, err := u.Stage(context.Background(), target("1.3.0", sum(release)))
	if staged || err == nil {
		t.Fatalf("Stage = %v, %v; want a checksum error", staged, err)
	}
	entries, _ := os.ReadDir(u.BinDir)
	if len(entries) != 0 {
		t.Errorf("left files behind: %v", entries)
	}
}

func TestRejectsAnInvalidChecksum(t *testing.T) {
	u, downloads := newUpdater(t, release)
	if _, err := u.Stage(context.Background(), target("1.3.0", "not-hex")); err == nil {
		t.Fatal("expected an error")
	}
	if len(*downloads) != 0 {
		t.Error("should not download without a valid checksum")
	}
}

func TestDownloadFailure(t *testing.T) {
	u, _ := newUpdater(t, nil)
	u.Download = func(context.Context, string) (io.ReadCloser, error) { return nil, errors.New("access denied") }
	if staged, err := u.Stage(context.Background(), target("1.3.0", sum(release))); staged || err == nil {
		t.Fatalf("Stage = %v, %v", staged, err)
	}
}

func TestHealthIsPerVersion(t *testing.T) {
	u, _ := newUpdater(t, nil)
	if u.Proven() {
		t.Fatal("a new version starts unproven")
	}
	if err := u.MarkHealthy(); err != nil {
		t.Fatal(err)
	}
	if !u.Proven() {
		t.Fatal("should be proven after MarkHealthy")
	}
	u.Version = "1.3.0"
	if u.Proven() {
		t.Fatal("another version's health doesn't count")
	}
}

func TestParseS3URL(t *testing.T) {
	bucket, key, err := ParseS3URL("s3://releases/agent/1.3.0/hearth-agent-linux-arm64")
	if err != nil || bucket != "releases" || key != "agent/1.3.0/hearth-agent-linux-arm64" {
		t.Errorf("got %q %q %v", bucket, key, err)
	}
	for _, bad := range []string{"https://x/y", "s3://bucket", "s3:///key", ""} {
		if _, _, err := ParseS3URL(bad); err == nil {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
