//go:build harness

// Package harness runs the real agent against real containers and a mock API. It needs Docker
// and pulls images, so it only runs with -tags harness:
//
//	go test -tags harness -timeout 30m -v ./harness/
package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/tarik-alauddin/hearth/agent/internal/agent"
	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
	"github.com/tarik-alauddin/hearth/agent/internal/game/minecraft"
	"github.com/tarik-alauddin/hearth/agent/internal/games"
)

// mockAPI serves one server's config and records status reports, checking every request is signed.
type mockAPI struct {
	t      *testing.T
	config game.Config
	mu     sync.Mutex
	states []string
}

func (m *mockAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
		m.t.Errorf("unsigned request to %s", r.URL.Path)
		w.WriteHeader(http.StatusForbidden)
		return
	}
	switch r.URL.Path {
	case "/agent/config":
		_ = json.NewEncoder(w).Encode(m.config)
	case "/agent/status":
		var report api.StatusReport
		_ = json.NewDecoder(r.Body).Decode(&report)
		m.mu.Lock()
		m.states = append(m.states, report.State)
		m.mu.Unlock()
		if report.State == "error" {
			m.t.Errorf("agent reported an error: %s", report.Message)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (m *mockAPI) reported() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.states)
}

// run is one agent run: from start until the test requests shutdown.
type run struct {
	api    *mockAPI
	cancel context.CancelFunc
	done   chan error
}

func startAgent(t *testing.T, cfg game.Config, registry map[string]game.Factory, dataDir string) *run {
	t.Helper()
	mock := &mockAPI{t: t, config: cfg}
	srv := httptest.NewServer(mock)
	t.Cleanup(srv.Close)

	a := agent.New(agent.Options{
		Logger:       slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Version:      "harness",
		API:          api.New(srv.URL, "us-west-2", credentials.NewStaticCredentialsProvider("AKIDHARNESS", "secret", "")),
		Runtime:      container.NewDocker(),
		Games:        registry,
		DataDir:      dataDir,
		MemoryMiB:    2048,
		StopTimeout:  2 * time.Minute,
		ReadyTimeout: 10 * time.Minute,
		PollInterval: 2 * time.Second,
	})
	ctx, cancel := context.WithCancel(context.Background())
	r := &run{api: mock, cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- a.Run(ctx) }()
	return r
}

func (r *run) waitFor(t *testing.T, state string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !slices.Contains(r.api.reported(), state) {
		if time.Now().After(deadline) {
			t.Fatalf("no %q report within %s; reported %v", state, timeout, r.api.reported())
		}
		time.Sleep(time.Second)
	}
}

// stop requests shutdown, as systemd's SIGTERM does, and waits for the agent to finish.
func (r *run) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		if err != nil {
			t.Fatalf("agent stop failed: %v", err)
		}
	case <-time.After(3 * time.Minute):
		t.Fatal("agent did not stop")
	}
}

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// dataDir is a fresh world volume stand-in. The game writes files as its own user, so it's
// removed through a container rather than by the test process.
func dataDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hearth-harness-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "--force", agent.ContainerName).Run()
		_ = exec.Command("docker", "run", "--rm", "-v", dir+":/d", "public.ecr.aws/docker/library/alpine:3", "sh", "-c", "rm -rf /d/*").Run()
		_ = os.RemoveAll(dir)
	})
	return dir
}

// TestMinecraft covers a whole server life: first start with world generation, a graceful stop
// that saves, and a restart on the same data that keeps the world.
func TestMinecraft(t *testing.T) {
	data := dataDir(t)
	cfg := game.Config{
		ServerID: "01HARNESS",
		Game:     "minecraft-java",
		Version:  "1.21.4",
		Image:    "docker.io/itzg/minecraft-server",
		Port:     25565,
	}

	first := startAgent(t, cfg, games.Registry(), data)
	first.waitFor(t, "ready", 10*time.Minute)

	status, err := minecraft.Ping(context.Background(), "127.0.0.1:25565")
	if err != nil {
		t.Fatalf("players can't reach the server: %v", err)
	}
	if status.Version.Name != "1.21.4" {
		t.Errorf("server runs %q, want 1.21.4", status.Version.Name)
	}

	first.stop(t)
	if got, want := first.api.reported(), []string{"starting", "ready", "stopping", "stopped"}; !slices.Equal(got, want) {
		t.Errorf("reported %v, want %v", got, want)
	}
	if code := docker(t, "inspect", "--format", "{{.State.ExitCode}}", agent.ContainerName); code != "0" {
		t.Errorf("game exited with %s, want a clean exit", code)
	}
	logs := docker(t, "logs", agent.ContainerName)
	if !strings.Contains(logs, "[Rcon: Saved the game]") {
		t.Error("the agent's save-all over RCON did not run")
	}
	world := filepath.Join(data, "minecraft", "world")
	regions := regionFiles(t, world)
	if len(regions) == 0 {
		t.Fatal("world not saved to the data volume")
	}
	firstContainer := docker(t, "inspect", "--format", "{{.Id}}", agent.ContainerName)

	// Restart on the same volume, as after an instance stop/start: the old container is
	// replaced and the saved world is loaded.
	second := startAgent(t, cfg, games.Registry(), data)
	second.waitFor(t, "ready", 5*time.Minute)
	if docker(t, "inspect", "--format", "{{.Id}}", agent.ContainerName) == firstContainer {
		t.Error("the container from the previous run was reused, not replaced")
	}
	second.stop(t)
	for _, region := range regions {
		if _, err := os.Stat(region); err != nil {
			t.Errorf("region file lost across restart: %v", err)
		}
	}
}

func regionFiles(t *testing.T, world string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(world, "region", "*.mca"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// fakeGame is a game adapter for a plain web server, proving the agent core runs a game it knows
// nothing about with a real container runtime.
type fakeGame struct{ port int }

func (g *fakeGame) Container(cfg game.Config) container.Spec {
	g.port = cfg.Port
	return container.Spec{
		Image:       cfg.Image,
		Ports:       []container.Port{{HostIP: "127.0.0.1", HostPort: cfg.Port, ContainerPort: 80, Protocol: "tcp"}},
		Mounts:      []container.Mount{{Source: filepath.Join(cfg.DataDir, "fake"), Target: "/data"}},
		StopTimeout: 10 * time.Second,
	}
}

func (g *fakeGame) Ready(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", g.port), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return errors.New(resp.Status)
	}
	return nil
}

func (g *fakeGame) Save(context.Context) error { return nil }

func TestAnyGame(t *testing.T) {
	registry := map[string]game.Factory{"fake": func() game.Adapter { return &fakeGame{} }}
	r := startAgent(t, game.Config{ServerID: "01FAKE", Game: "fake", Image: "public.ecr.aws/nginx/nginx:alpine", Port: 18080}, registry, dataDir(t))
	r.waitFor(t, "ready", 3*time.Minute)
	r.stop(t)
	if got, want := r.api.reported(), []string{"starting", "ready", "stopping", "stopped"}; !slices.Equal(got, want) {
		t.Errorf("reported %v, want %v", got, want)
	}
}
