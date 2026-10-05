package agent

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/backup"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// The core is tested with a fake game, so these tests also prove it doesn't depend on Minecraft.

type fakeAPI struct {
	mu          sync.Mutex
	config      game.Config
	configFails int // Config fails this many times before succeeding
	reports     []api.StatusReport
	restored    []string
	restoredErr error
}

func (f *fakeAPI) Restored(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.restoredErr != nil {
		return f.restoredErr
	}
	f.restored = append(f.restored, key)
	return nil
}

func (f *fakeAPI) Config(context.Context) (game.Config, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.configFails > 0 {
		f.configFails--
		return game.Config{}, errors.New("no server yet")
	}
	return f.config, nil
}

func (f *fakeAPI) ReportStatus(_ context.Context, r api.StatusReport) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, r)
	return nil
}

func (f *fakeAPI) states() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var s []string
	for _, r := range f.reports {
		s = append(s, r.State)
	}
	return s
}

func (f *fakeAPI) firstMessage() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reports[0].Message
}

func (f *fakeAPI) lastMessage() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reports[len(f.reports)-1].Message
}

type fakeRuntime struct {
	mu       sync.Mutex
	events   []string
	started  container.Spec
	exitCode chan int // send to make the container exit
}

func newFakeRuntime() *fakeRuntime { return &fakeRuntime{exitCode: make(chan int, 1)} }

func (f *fakeRuntime) record(e string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, e)
}

func (f *fakeRuntime) Start(_ context.Context, spec container.Spec) error {
	f.mu.Lock()
	f.started = spec
	f.mu.Unlock()
	f.record("start")
	return nil
}

func (f *fakeRuntime) startedSpec() container.Spec {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.started
}

func (f *fakeRuntime) Wait(ctx context.Context, _ string) (int, error) {
	select {
	case code := <-f.exitCode:
		return code, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (f *fakeRuntime) Stop(_ context.Context, name string, timeout time.Duration) error {
	f.record("stop " + name + " " + timeout.String())
	return nil
}

type fakeGame struct {
	rt         *fakeRuntime
	cfg        game.Config
	readyAt    time.Time // Ready succeeds from this time on
	neverReady bool
}

func (g *fakeGame) Container(cfg game.Config) container.Spec {
	g.cfg = cfg
	return container.Spec{Image: cfg.Image, StopTimeout: 7 * time.Second}
}

func (g *fakeGame) Ready(context.Context) error {
	if g.neverReady || time.Now().Before(g.readyAt) {
		return errors.New("not yet")
	}
	return nil
}

func (g *fakeGame) Save(context.Context) error {
	g.rt.record("save")
	return nil
}

func (g *fakeGame) Players(context.Context) (int, error) {
	g.rt.record("players")
	return 0, nil
}

func (g *fakeGame) Backup(cfg game.Config) game.BackupSpec {
	return game.BackupSpec{Dir: cfg.DataDir + "/fake"}
}

type fakeBackups struct {
	rt  *fakeRuntime
	err error
}

func (f *fakeBackups) Backup(ctx context.Context, spec game.BackupSpec) (backup.Result, error) {
	if ctx.Err() != nil {
		return backup.Result{}, ctx.Err()
	}
	f.rt.record("backup " + spec.Dir)
	return backup.Result{Key: "k"}, f.err
}

type harness struct {
	api    *fakeAPI
	rt     *fakeRuntime
	game   *fakeGame
	agent  *Agent
	cancel context.CancelFunc
	done   chan error
}

func start(t *testing.T, configure func(h *harness)) *harness {
	t.Helper()
	h := &harness{
		api: &fakeAPI{config: game.Config{ServerID: "s1", Game: "fake", Version: "1.0", Image: "fake/image", Port: 1234}},
		rt:  newFakeRuntime(),
	}
	h.game = &fakeGame{rt: h.rt, readyAt: time.Now().Add(30 * time.Millisecond)}
	h.agent = New(Options{
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Version:        "0.1.0",
		API:            h.api,
		Runtime:        h.rt,
		Games:          map[string]game.Factory{"fake": func() game.Adapter { return h.game }},
		DataDir:        "/srv/hearth",
		MemoryMiB:      4000,
		StopTimeout:    time.Second,
		ReadyTimeout:   time.Second,
		PollInterval:   10 * time.Millisecond,
		PlayerInterval: time.Hour, // tests that want player checks shorten it
		MaxBackoff:     10 * time.Millisecond,
	})
	if configure != nil {
		configure(h)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	go func() { h.done <- h.agent.Run(ctx) }()
	return h
}

// stop requests shutdown and waits for Run to return.
func (h *harness) stop(t *testing.T) error {
	t.Helper()
	h.cancel()
	select {
	case err := <-h.done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after shutdown was requested")
		return nil
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestHappyPath(t *testing.T) {
	h := start(t, nil)
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })

	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	if got, want := h.api.states(), []string{"starting", "ready", "stopping", "stopped"}; !slices.Equal(got, want) {
		t.Errorf("reported %v, want %v", got, want)
	}
	if got, want := h.rt.events, []string{"start", "save", "stop hearth-game 7s"}; !slices.Equal(got, want) {
		t.Errorf("runtime events %v, want %v (save before stop, adapter's stop timeout)", got, want)
	}
	if h.rt.started.Name != ContainerName || h.rt.started.Image != "fake/image" {
		t.Errorf("started %+v", h.rt.started)
	}
	if h.game.cfg.DataDir != "/srv/hearth" || h.game.cfg.MemoryMiB != 4000 || h.game.cfg.Version != "1.0" {
		t.Errorf("adapter got config %+v", h.game.cfg)
	}
	if h.api.reports[0].AgentVersion != "0.1.0" {
		t.Error("reports should carry the agent version")
	}
}

func TestRetriesConfigUntilTheServerExists(t *testing.T) {
	h := start(t, func(h *harness) { h.api.configFails = 3 })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
}

func TestShutdownWhileWaitingForConfig(t *testing.T) {
	h := start(t, func(h *harness) { h.api.configFails = 1 << 30 })
	time.Sleep(30 * time.Millisecond)
	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	if len(h.rt.events) != 0 || len(h.api.states()) != 0 {
		t.Errorf("nothing should have started: %v %v", h.rt.events, h.api.states())
	}
}

func TestUnknownGame(t *testing.T) {
	h := start(t, func(h *harness) { h.api.config.Game = "tetris" })
	eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
	if !strings.Contains(h.api.lastMessage(), `"tetris"`) {
		t.Errorf("message %q should name the game", h.api.lastMessage())
	}
	_ = h.stop(t)
	if len(h.rt.events) != 0 {
		t.Errorf("no container should start: %v", h.rt.events)
	}
}

func TestGameNeverReady(t *testing.T) {
	h := start(t, func(h *harness) {
		h.game.neverReady = true
		h.agent.ReadyTimeout = 50 * time.Millisecond
	})
	eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
	if !strings.Contains(h.api.lastMessage(), "wasn't ready") {
		t.Errorf("message %q", h.api.lastMessage())
	}
	_ = h.stop(t)
	if slices.Contains(h.rt.events, "save") {
		t.Error("should not try to save a game that never became ready")
	}
	if !slices.Contains(h.rt.events, "stop hearth-game 7s") {
		t.Error("should still stop the container")
	}
}

func TestGameExitsBeforeReady(t *testing.T) {
	h := start(t, func(h *harness) { h.game.neverReady = true })
	eventually(t, "container start", func() bool { return h.rt.startedSpec().Name != "" })
	h.rt.exitCode <- 1
	eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
	if !strings.Contains(h.api.lastMessage(), "exited with code 1 before it was ready") {
		t.Errorf("message %q", h.api.lastMessage())
	}
	_ = h.stop(t)
}

func TestGameCrashesWhileRunning(t *testing.T) {
	h := start(t, nil)
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	h.rt.exitCode <- 137
	eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
	if !strings.Contains(h.api.lastMessage(), "exited with code 137") {
		t.Errorf("message %q", h.api.lastMessage())
	}
	_ = h.stop(t)
	if slices.Contains(h.rt.events, "save") {
		t.Error("should not try to save over RCON after the game exited")
	}
}

// withBackups gives the agent fake backups and a marker path in a temp dir, returning both.
func withBackups(t *testing.T, h *harness, err error) (*fakeBackups, string) {
	t.Helper()
	b := &fakeBackups{rt: h.rt, err: err}
	marker := filepath.Join(t.TempDir(), "backup-on-stop")
	h.agent.Backups, h.agent.BackupMarker = b, marker
	return b, marker
}

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBacksUpAfterStoppingWhenTheStopAsksForIt(t *testing.T) {
	var marker string
	h := start(t, func(h *harness) { _, marker = withBackups(t, h, nil) })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	touch(t, marker) // what the stop-agent Run Command does
	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	if got, want := h.rt.events, []string{"start", "save", "stop hearth-game 7s", "backup /srv/hearth/fake"}; !slices.Equal(got, want) {
		t.Errorf("events %v, want %v (back up after the game stops)", got, want)
	}
	if got, want := h.api.states(), []string{"starting", "ready", "stopping", "stopping", "stopped"}; !slices.Equal(got, want) {
		t.Errorf("reported %v, want %v", got, want)
	}
	if h.api.lastMessage() != "" {
		t.Errorf("message %q", h.api.lastMessage())
	}
	if _, err := os.Stat(marker); !errors.Is(err, fs.ErrNotExist) {
		t.Error("the marker should be removed once used")
	}
}

func TestNoBackupWithoutTheMarker(t *testing.T) {
	h := start(t, func(h *harness) { withBackups(t, h, nil) })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t) // an OS shutdown: SIGTERM with no marker
	if slices.ContainsFunc(h.rt.events, func(e string) bool { return strings.HasPrefix(e, "backup") }) {
		t.Errorf("should not back up: %v", h.rt.events)
	}
}

func TestIgnoresAMarkerLeftFromBeforeItStarted(t *testing.T) {
	var marker string
	h := start(t, func(h *harness) {
		_, marker = withBackups(t, h, nil)
		touch(t, marker)
	})
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
	if slices.ContainsFunc(h.rt.events, func(e string) bool { return strings.HasPrefix(e, "backup") }) {
		t.Errorf("a stale marker should not cause a backup: %v", h.rt.events)
	}
}

func TestFailedBackupStillStopsCleanly(t *testing.T) {
	var marker string
	h := start(t, func(h *harness) { _, marker = withBackups(t, h, errors.New("S3 said no")) })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	touch(t, marker)
	if err := h.stop(t); err != nil {
		t.Fatalf("a failed backup should not fail the stop: %v", err)
	}
	if states := h.api.states(); states[len(states)-1] != "stopped" {
		t.Errorf("reported %v; the world is saved, so the stop is clean", states)
	}
	if msg := h.api.lastMessage(); !strings.Contains(msg, "backup failed: S3 said no") {
		t.Errorf("message %q should say the backup failed", msg)
	}
}

func TestNoBackupOfAGameThatNeverBecameReady(t *testing.T) {
	var marker string
	h := start(t, func(h *harness) {
		_, marker = withBackups(t, h, nil)
		h.game.neverReady = true
		h.agent.ReadyTimeout = 50 * time.Millisecond
	})
	eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
	touch(t, marker)
	_ = h.stop(t)
	if slices.ContainsFunc(h.rt.events, func(e string) bool { return strings.HasPrefix(e, "backup") }) {
		t.Errorf("should not back up: %v", h.rt.events)
	}
}

const restoreKey = "servers/s1/20261004T120000Z.tar.gz"

// withRestore puts a pending restore in the config and fakes the download, returning the result
// of each attempt in turn (the last one repeats).
func withRestore(h *harness, results ...error) {
	h.api.config.Restore = &game.RestoreTarget{Key: restoreKey, URL: "https://s3/link"}
	attempt := 0
	h.agent.Restore = func(_ context.Context, url, dir string) error {
		h.rt.record("restore " + url + " " + dir)
		err := results[min(attempt, len(results)-1)]
		attempt++
		return err
	}
}

func TestRestoresBeforeStartingTheGameThenClearsTheRequest(t *testing.T) {
	h := start(t, func(h *harness) { withRestore(h, nil) })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
	if got := h.rt.events[:2]; !slices.Equal(got, []string{"restore https://s3/link /srv/hearth/fake", "start"}) {
		t.Errorf("events %v: the world should be restored before the game starts", h.rt.events)
	}
	if !slices.Equal(h.api.restored, []string{restoreKey}) {
		t.Errorf("restored %v", h.api.restored)
	}
	if !strings.Contains(h.api.firstMessage(), "restoring backup "+restoreKey) {
		t.Errorf("first report %q should say it's restoring", h.api.firstMessage())
	}
}

func TestFetchesANewLinkOnceWhenS3RefusesIt(t *testing.T) {
	h := start(t, func(h *harness) { withRestore(h, backup.ErrLinkRefused, nil) })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
	if n := len(slices.DeleteFunc(slices.Clone(h.rt.events), func(e string) bool { return !strings.HasPrefix(e, "restore") })); n != 2 {
		t.Errorf("%d restore attempts, want 2: %v", n, h.rt.events)
	}
}

func TestRestoreFailuresFailTheStartWithoutStartingTheGame(t *testing.T) {
	for _, tc := range []struct {
		name        string
		results     []error
		restoredErr error
		want        string
	}{
		{"backup gone", []error{backup.ErrBackupGone}, nil, "no longer exists; choose another"},
		{"link refused twice", []error{backup.ErrLinkRefused}, nil, "no longer exists, or S3 refused the link"},
		{"unpack error", []error{errors.New("disk full")}, nil, "restoring backup " + restoreKey + " failed: disk full"},
		{"request not cleared", []error{nil}, errors.New("API down"), "couldn't be cleared"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := start(t, func(h *harness) {
				withRestore(h, tc.results...)
				h.api.restoredErr = tc.restoredErr
			})
			eventually(t, "error report", func() bool { return slices.Contains(h.api.states(), "error") })
			if !strings.Contains(h.api.lastMessage(), tc.want) {
				t.Errorf("message %q should contain %q", h.api.lastMessage(), tc.want)
			}
			_ = h.stop(t)
			if slices.Contains(h.rt.events, "start") {
				t.Errorf("the game must not start after a failed restore: %v", h.rt.events)
			}
		})
	}
}

func TestChecksPlayersWhileReady(t *testing.T) {
	h := start(t, func(h *harness) { h.agent.PlayerInterval = 10 * time.Millisecond })
	eventually(t, "a player check", func() bool {
		h.rt.mu.Lock()
		defer h.rt.mu.Unlock()
		return slices.Contains(h.rt.events, "players")
	})
	_ = h.stop(t)
	if first := slices.Index(h.rt.events, "players"); first < slices.Index(h.rt.events, "start") {
		t.Errorf("players checked before the game started: %v", h.rt.events)
	}
}

func TestLogsPlayerCountChangesAndFailuresOnce(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		if a.Key == slog.TimeKey || a.Key == slog.LevelKey {
			return slog.Attr{}
		}
		return a
	}}))
	var p playerCount
	refused := errors.New("refused")
	for _, c := range []struct {
		n   int
		err error
	}{{0, nil}, {0, nil}, {2, nil}, {0, refused}, {0, refused}, {2, nil}, {0, nil}} {
		p.record(log, c.n, c.err)
	}
	want := `msg="players online" count=0
msg="players online" count=2
msg="couldn't check the player count" err=refused
msg="players online" count=0
`
	if buf.String() != want {
		t.Errorf("logged:\n%s\nwant:\n%s", buf.String(), want)
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("short", 500); got != "short" {
		t.Errorf("got %q", got)
	}
	long := strings.Repeat("é", 300) // 600 bytes
	got := truncate(long, 500)
	if len(got) > 500 || !utf8.ValidString(got) || !strings.HasSuffix(got, "...") {
		t.Errorf("got %d bytes, valid %t: %q", len(got), utf8.ValidString(got), got[len(got)-10:])
	}
}

func TestParseMemTotal(t *testing.T) {
	meminfo := "MemTotal:        3995648 kB\nMemFree:          123456 kB\n"
	if got := parseMemTotalMiB(strings.NewReader(meminfo)); got != 3902 {
		t.Errorf("got %d", got)
	}
	if got := parseMemTotalMiB(strings.NewReader("nothing here")); got != 0 {
		t.Errorf("got %d", got)
	}
}

// fakeUpdater records what the agent asks of the updater.
type fakeUpdater struct {
	mu       sync.Mutex
	proven   bool
	failed   string
	stageErr error
	staged   []string
	healthy  int
}

func (f *fakeUpdater) Proven() bool          { return f.proven }
func (f *fakeUpdater) FailedVersion() string { return f.failed }
func (f *fakeUpdater) MarkHealthy() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.healthy++
	return nil
}
func (f *fakeUpdater) Stage(_ context.Context, target game.AgentTarget) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.staged = append(f.staged, target.Version)
	if f.stageErr != nil {
		return false, f.stageErr
	}
	return target.Version != "0.1.0", nil
}

func (f *fakeUpdater) healthyCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.healthy
}

var newRelease = &game.AgentTarget{Version: "0.2.0", URL: "s3://releases/agent/0.2.0/x", SHA256: "abc"}

func TestStagesAnUpdateAndExitsBeforeStartingTheGame(t *testing.T) {
	up := &fakeUpdater{proven: true}
	h := start(t, func(h *harness) {
		h.agent.Updater = up
		h.api.config.Agent = newRelease
	})
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrUpdateStaged) {
			t.Fatalf("Run returned %v, want ErrUpdateStaged", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return")
	}
	if len(h.rt.events) != 0 {
		t.Errorf("the game should not start before the update: %v", h.rt.events)
	}
	if h.api.lastMessage() != "updating agent to 0.2.0" {
		t.Errorf("message %q", h.api.lastMessage())
	}
}

func TestKeepsRunningWhenTheUpdateFails(t *testing.T) {
	up := &fakeUpdater{proven: true, stageErr: errors.New("checksum mismatch")}
	h := start(t, func(h *harness) {
		h.agent.Updater = up
		h.api.config.Agent = newRelease
	})
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
}

func TestNoTargetNoUpdate(t *testing.T) {
	up := &fakeUpdater{proven: true}
	h := start(t, func(h *harness) { h.agent.Updater = up })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
	if len(up.staged) != 0 {
		t.Errorf("staged %v without a target", up.staged)
	}
}

func TestMarksItselfHealthyAfterReachingTheAPI(t *testing.T) {
	up := &fakeUpdater{}
	h := start(t, func(h *harness) { h.agent.Updater = up })
	eventually(t, "ready", func() bool { return slices.Contains(h.api.states(), "ready") })
	_ = h.stop(t)
	if up.healthyCount() != 1 {
		t.Errorf("MarkHealthy called %d times, want once", up.healthyCount())
	}
}

func TestUnprovenAgentGivesUpWhenTheAPIIsUnreachable(t *testing.T) {
	h := start(t, func(h *harness) {
		h.agent.Updater = &fakeUpdater{proven: false}
		h.agent.HealthDeadline = 50 * time.Millisecond
		h.api.configFails = 1 << 30
	})
	select {
	case err := <-h.done:
		if !errors.Is(err, ErrNeverHealthy) {
			t.Fatalf("Run returned %v, want ErrNeverHealthy", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("an unproven agent should give up")
	}
}

func TestProvenAgentKeepsRetryingWhenTheAPIIsUnreachable(t *testing.T) {
	h := start(t, func(h *harness) {
		h.agent.Updater = &fakeUpdater{proven: true}
		h.agent.HealthDeadline = 50 * time.Millisecond
		h.api.configFails = 1 << 30
	})
	time.Sleep(200 * time.Millisecond)
	if err := h.stop(t); err != nil {
		t.Fatalf("a proven agent should retry until shutdown, got %v", err)
	}
}

func TestReportsAFallback(t *testing.T) {
	h := start(t, func(h *harness) { h.agent.Updater = &fakeUpdater{proven: true, failed: "0.2.0"} })
	eventually(t, "starting", func() bool { return slices.Contains(h.api.states(), "starting") })
	if msg := h.api.firstMessage(); msg != "agent 0.2.0 never became healthy; running 0.1.0" {
		t.Errorf("starting message %q", msg)
	}
	_ = h.stop(t)
}
