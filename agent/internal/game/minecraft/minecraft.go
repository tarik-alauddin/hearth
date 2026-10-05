// Package minecraft is the game adapter for Minecraft: Java Edition, run with the
// itzg/minecraft-server image (https://docker-minecraft-server.readthedocs.io).
package minecraft

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path"
	"strconv"
	"time"

	"github.com/gorcon/rcon"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

const (
	// RCON is published on loopback only; nothing outside the instance can reach it.
	rconPort    = 25575
	stopTimeout = 60 * time.Second
	minHeapMiB  = 1024
)

type Adapter struct {
	port         int
	rconPassword string
	// Replaced in tests.
	ping func(ctx context.Context, addr string) (Status, error)
	rcon func(ctx context.Context, addr, password, command string) (string, error)
}

func New() *Adapter {
	return &Adapter{ping: Ping, rcon: execRCON}
}

func (a *Adapter) Container(cfg game.Config) container.Spec {
	a.port = cfg.Port
	a.rconPassword = randomPassword()
	return container.Spec{
		Image: cfg.Image,
		Env: map[string]string{
			// Running a server requires accepting Mojang's EULA (https://aka.ms/MinecraftEULA).
			// Before public launch, server owners must accept it themselves in the UI.
			"EULA":          "TRUE",
			"TYPE":          "VANILLA",
			"VERSION":       cfg.Version,
			"MEMORY":        heapSize(cfg.MemoryMiB),
			"SERVER_PORT":   strconv.Itoa(cfg.Port),
			"ENABLE_RCON":   "true",
			"RCON_PORT":     strconv.Itoa(rconPort),
			"RCON_PASSWORD": a.rconPassword,
		},
		Ports: []container.Port{
			{HostIP: "0.0.0.0", HostPort: cfg.Port, ContainerPort: cfg.Port, Protocol: "tcp"},
			{HostIP: "127.0.0.1", HostPort: rconPort, ContainerPort: rconPort, Protocol: "tcp"},
		},
		Mounts:      []container.Mount{{Source: dataDir(cfg), Target: "/data"}},
		StopTimeout: stopTimeout,
	}
}

// Backup keeps the world, settings and player lists. The image downloads the server jar and its
// libraries again for the configured version, and the rest is logs and per-run files.
func (a *Adapter) Backup(cfg game.Config) game.BackupSpec {
	return game.BackupSpec{
		Dir:     dataDir(cfg),
		Exclude: []string{"*.jar", "libraries", "versions", "logs", "crash-reports", "debug", ".rcon-cli.*"},
	}
}

func dataDir(cfg game.Config) string {
	return path.Join(cfg.DataDir, "minecraft")
}

// Ready succeeds once the server answers a server list ping, which is when players can join.
func (a *Adapter) Ready(ctx context.Context) error {
	_, err := a.ping(ctx, fmt.Sprintf("127.0.0.1:%d", a.port))
	return err
}

// Players reads the online count from a server list ping: the same check as Ready, so it needs
// no RCON and works however players connect.
func (a *Adapter) Players(ctx context.Context) (int, error) {
	status, err := a.ping(ctx, fmt.Sprintf("127.0.0.1:%d", a.port))
	if err != nil {
		return 0, err
	}
	return status.Players.Online, nil
}

// Save writes all chunks to disk. Stopping the container afterwards makes the server save again
// and exit cleanly; saving first means the world is safe even if that stop is cut short.
func (a *Adapter) Save(ctx context.Context) error {
	_, err := a.rcon(ctx, fmt.Sprintf("127.0.0.1:%d", rconPort), a.rconPassword, "save-all flush")
	return err
}

// heapSize leaves a quarter of the instance's memory for the OS, Docker and the agent.
func heapSize(memoryMiB int) string {
	return fmt.Sprintf("%dM", max(memoryMiB*3/4, minHeapMiB))
}

func randomPassword() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b) // never fails; see crypto/rand
	return hex.EncodeToString(b)
}

func execRCON(ctx context.Context, addr, password, command string) (string, error) {
	timeout := stopTimeout
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
	}
	conn, err := rcon.Dial(addr, password, rcon.SetDialTimeout(5*time.Second), rcon.SetDeadline(timeout))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	return conn.Execute(command)
}
