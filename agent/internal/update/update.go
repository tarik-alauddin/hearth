// Package update lets the agent replace itself with the release its channel points at, and records
// whether this version has proven healthy. It shares a few files with the bootstrap script
// (infra/lib/user-data/game-instance.sh), which promotes staged updates and falls back to the last
// known good agent:
//
//	<binDir>/hearth-agent.next     a downloaded, verified update, waiting for the next start
//	<stateDir>/agent-healthy       this version has sent a status report (contains the version)
//	<stateDir>/agent-failed        a version the bootstrap gave up on; never staged again
package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// Download returns the contents at an s3:// URL.
type Download func(ctx context.Context, url string) (io.ReadCloser, error)

type Updater struct {
	BinDir   string
	StateDir string
	// Version is the running agent's version.
	Version  string
	Download Download
}

// Proven reports whether this version has sent a status report before. A proven agent retries
// forever when the API is unreachable; an unproven one gives up so the bootstrap can fall back.
func (u *Updater) Proven() bool {
	b, err := os.ReadFile(filepath.Join(u.StateDir, "agent-healthy"))
	return err == nil && strings.TrimSpace(string(b)) == u.Version
}

// MarkHealthy records that this version works (it has reached the API).
func (u *Updater) MarkHealthy() error {
	if err := os.MkdirAll(u.StateDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(u.StateDir, "agent-healthy"), []byte(u.Version+"\n"), 0o644)
}

// FailedVersion is a version the bootstrap fell back from, or "".
func (u *Updater) FailedVersion() string {
	b, err := os.ReadFile(filepath.Join(u.StateDir, "agent-failed"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Stage downloads and verifies target as the next agent, if it differs from this one and hasn't
// failed before. It returns true when an update is staged; the agent should then exit so the
// bootstrap starts it.
func (u *Updater) Stage(ctx context.Context, target game.AgentTarget) (bool, error) {
	if target.Version == "" || target.Version == u.Version || target.Version == u.FailedVersion() {
		return false, nil
	}
	want, err := hex.DecodeString(target.SHA256)
	if err != nil || len(want) != sha256.Size {
		return false, fmt.Errorf("release %s has an invalid sha256", target.Version)
	}

	body, err := u.Download(ctx, target.URL)
	if err != nil {
		return false, fmt.Errorf("download %s: %w", target.Version, err)
	}
	defer body.Close()
	tmp, err := os.CreateTemp(u.BinDir, ".hearth-agent-download-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed

	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hash), body); err != nil {
		tmp.Close()
		return false, fmt.Errorf("download %s: %w", target.Version, err)
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if got := hash.Sum(nil); !bytes.Equal(got, want) {
		return false, fmt.Errorf("release %s failed its checksum (got %x)", target.Version, got)
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return false, err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(u.BinDir, "hearth-agent.next")); err != nil {
		return false, err
	}
	return true, nil
}

// ErrInvalidURL is returned for a release URL that isn't s3://bucket/key.
var ErrInvalidURL = errors.New("release URL must be s3://bucket/key")

// ParseS3URL splits s3://bucket/key.
func ParseS3URL(url string) (bucket, key string, err error) {
	rest, ok := strings.CutPrefix(url, "s3://")
	bucket, key, found := strings.Cut(rest, "/")
	if !ok || !found || bucket == "" || key == "" {
		return "", "", ErrInvalidURL
	}
	return bucket, key, nil
}
