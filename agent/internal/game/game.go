// Package game defines what the agent needs from each game. The agent core only uses this
// interface; everything game-specific lives in one package per game (e.g. game/minecraft).
package game

import (
	"context"
	"path"

	"github.com/tarik-alauddin/hearth/agent/internal/container"
)

// Config is the server's config from the API (AgentConfig in packages/shared) plus facts about
// the instance the agent adds.
type Config struct {
	ServerID string `json:"serverId"`
	Game     string `json:"game"`
	Version  string `json:"version"`
	Image    string `json:"image"`
	Port     int    `json:"port"`
	// Agent is the release this server's channel points at (AgentTarget in packages/shared); nil
	// until the channel has one.
	Agent *AgentTarget `json:"agent,omitempty"`
	// Restore is a requested restore (RestoreTarget in packages/shared): replace the world with
	// this backup before starting the game. Nil when none is pending.
	Restore *RestoreTarget `json:"restore,omitempty"`

	// Filled in by the agent, not the API.
	DataDir   string `json:"-"` // root of the world data volume, e.g. /srv/hearth
	MemoryMiB int    `json:"-"` // instance memory; adapters size the game's heap from it
}

// AgentTarget is the agent release a server should run.
type AgentTarget struct {
	Version string `json:"version"`
	URL     string `json:"url"` // s3://bucket/key
	SHA256  string `json:"sha256"`
}

// RestoreTarget is a backup to restore.
type RestoreTarget struct {
	Key string `json:"key"`
	URL string `json:"url"` // presigned download link, valid for 15 minutes from the config fetch
}

// BackupSpec says what a backup holds: everything under Dir except paths matching Exclude.
type BackupSpec struct {
	Dir string
	// Exclude holds path.Match patterns for paths relative to Dir, with forward slashes, e.g.
	// "logs" or "*.jar" (both top level only). An excluded directory is skipped with its contents.
	Exclude []string
}

// Excludes reports whether name (relative to Dir, with forward slashes) matches an Exclude pattern.
func (s BackupSpec) Excludes(name string) bool {
	for _, pattern := range s.Exclude {
		if ok, _ := path.Match(pattern, name); ok {
			return true
		}
	}
	return false
}

// Adapter is everything game-specific the agent needs. It grows with the milestones:
// version resolution arrives in M5, player counts in M6.
type Adapter interface {
	// Container describes the container to run. Image and port come from cfg (the shared game
	// definition); the adapter adds game settings, mounts under cfg.DataDir and any secrets.
	Container(cfg Config) container.Spec
	// Ready makes one attempt to check that players can connect; nil means ready.
	// The agent calls it repeatedly until it succeeds or the start times out.
	Ready(ctx context.Context) error
	// Save flushes the world to disk. The agent calls it before stopping the container.
	Save(ctx context.Context) error
	// Backup says what to back up. The agent archives it after the container has stopped, so
	// nothing is writing to it.
	Backup(cfg Config) BackupSpec
}

// Factory creates a fresh adapter for one run of the game.
type Factory func() Adapter
