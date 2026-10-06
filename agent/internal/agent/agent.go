// Package agent runs a game server's lifecycle on its instance. It knows nothing about any
// particular game: everything game-specific comes from a game.Adapter.
package agent

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"time"
	"unicode/utf8"

	"github.com/tarik-alauddin/hearth/agent/internal/api"
	"github.com/tarik-alauddin/hearth/agent/internal/backup"
	"github.com/tarik-alauddin/hearth/agent/internal/container"
	"github.com/tarik-alauddin/hearth/agent/internal/game"
)

// ContainerName is the one game container on each instance.
const ContainerName = "hearth-game"

// API is the Hearth API's agent routes.
type API interface {
	Config(ctx context.Context) (game.Config, error)
	ReportStatus(ctx context.Context, report api.StatusReport) error
	Restored(ctx context.Context, key string) error
	Idle(ctx context.Context, idleMinutes int) error
}

// Updater replaces the agent with its channel's release (see package update).
type Updater interface {
	// Proven reports whether this version has reached the API before.
	Proven() bool
	MarkHealthy() error
	// FailedVersion is a version the bootstrap fell back from, or "".
	FailedVersion() string
	// Stage downloads and verifies target for the next start; true if staged.
	Stage(ctx context.Context, target game.AgentTarget) (bool, error)
}

var (
	// ErrUpdateStaged: a new agent is staged; exit so the bootstrap starts it.
	ErrUpdateStaged = errors.New("agent update staged")
	// ErrNeverHealthy: this unproven version couldn't reach the API; exit so the bootstrap can fall back.
	ErrNeverHealthy = errors.New("agent never reached the API")
)

// Backups backs the game data up (see package backup).
type Backups interface {
	Backup(ctx context.Context, spec game.BackupSpec) (backup.Result, error)
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
	// DataDir is the root of the game data volume.
	DataDir   string
	MemoryMiB int
	// StopTimeout bounds the graceful stop (save the game, stop the container, back up) after
	// shutdown is requested.
	StopTimeout time.Duration
	// Backups, if set, backs the game data up after the game stops, when BackupMarker exists then.
	Backups Backups
	// Restore replaces dir with the backup at url (see backup.Restore, the default).
	Restore func(ctx context.Context, url, dir string) error
	// BackupMarker is the file the stop workflow's Run Command creates to ask for a backup. Other
	// stops (an OS shutdown) don't create it: EC2 may not wait long enough for an upload.
	BackupMarker string
	// ReadyTimeout bounds how long the game may take to accept players. Defaults to 15 minutes,
	// enough for a first start that downloads the server and generates its data.
	ReadyTimeout time.Duration
	// PollInterval is how often readiness is checked. Defaults to 5 seconds.
	PollInterval time.Duration
	// PlayerInterval is how often the player count is checked while the game is ready. Defaults to
	// 15 seconds: short enough to catch a brief visit (logging in alone takes several seconds), and
	// the check is a ping on loopback.
	PlayerInterval time.Duration
	// IdleAfter is how long the game may run with nobody playing before the agent asks for a stop,
	// when the config doesn't say (the server's own setting wins). Defaults to 30 minutes; negative
	// never stops.
	IdleAfter time.Duration
	// MaxBackoff caps the wait between retries of API calls and container starts. Defaults to 30 seconds.
	MaxBackoff time.Duration
	// Updater, if set, keeps the agent on its channel's release. Nil disables self-update.
	Updater Updater
	// HealthDeadline is how long an unproven agent may fail to reach the API before giving up.
	// Defaults to 3 minutes.
	HealthDeadline time.Duration
}

type Agent struct {
	Options
	log     *slog.Logger
	started time.Time
	healthy bool
}

func New(opts Options) *Agent {
	if opts.ReadyTimeout == 0 {
		opts.ReadyTimeout = 15 * time.Minute
	}
	if opts.PollInterval == 0 {
		opts.PollInterval = 5 * time.Second
	}
	if opts.PlayerInterval == 0 {
		opts.PlayerInterval = 15 * time.Second
	}
	if opts.IdleAfter == 0 {
		opts.IdleAfter = 30 * time.Minute
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = 30 * time.Second
	}
	if opts.HealthDeadline == 0 {
		opts.HealthDeadline = 3 * time.Minute
	}
	if opts.Restore == nil {
		opts.Restore = func(ctx context.Context, url, dir string) error {
			return backup.Restore(ctx, http.DefaultClient, url, dir)
		}
	}
	return &Agent{Options: opts, log: opts.Logger}
}

// Run starts the game and keeps it running until ctx is cancelled (the instance is shutting
// down), then saves and stops it within StopTimeout. Problems are reported to the API as the
// "error" state rather than ending the agent, so they're visible without logging in.
//
// It returns ErrUpdateStaged when it has staged a newer agent, and ErrNeverHealthy when this
// unproven version can't reach the API; the caller exits so the bootstrap can act on either.
func (a *Agent) Run(ctx context.Context) error {
	a.log.Info("agent starting")
	a.started = time.Now()
	// A marker left from an earlier stop that never got to use it isn't a request for this run.
	a.takeBackupMarker()
	notice := ""
	if a.Updater != nil {
		if failed := a.Updater.FailedVersion(); failed != "" && failed != a.Version {
			notice = fmt.Sprintf("agent %s never became healthy; running %s", failed, a.Version)
			a.log.Warn(notice)
		}
	}

	cfg, err := a.fetchConfig(ctx)
	if errors.Is(err, ErrNeverHealthy) {
		return err
	}
	if err != nil {
		a.log.Info("shutdown requested before the config arrived")
		return nil
	}
	a.log = a.log.With("serverId", cfg.ServerID, "game", cfg.Game)

	if a.Updater != nil && cfg.Agent != nil {
		staged, err := a.Updater.Stage(ctx, *cfg.Agent)
		switch {
		case err != nil:
			// Keep running this version; the next start tries again.
			a.log.Error("agent update failed; staying on this version", "target", cfg.Agent.Version, "err", err)
		case staged:
			a.log.Info("agent update staged; restarting into it", "target", cfg.Agent.Version)
			a.report(ctx, "starting", "updating agent to "+cfg.Agent.Version)
			return ErrUpdateStaged
		}
	}

	newAdapter, ok := a.Games[cfg.Game]
	if !ok {
		a.fail(ctx, fmt.Sprintf("this agent can't run game %q", cfg.Game))
		<-ctx.Done()
		return nil
	}
	adapter := newAdapter()
	cfg.DataDir, cfg.MemoryMiB = a.DataDir, a.MemoryMiB

	if cfg.Restore != nil {
		if err := a.restore(ctx, cfg, adapter); err != nil {
			if ctx.Err() == nil {
				a.fail(ctx, err.Error())
				<-ctx.Done()
			}
			return nil
		}
	}

	spec := adapter.Container(cfg)
	spec.Name = ContainerName

	a.report(ctx, "starting", notice)
	if err := a.startContainer(ctx, spec); err != nil {
		if ctx.Err() == nil {
			a.fail(ctx, err.Error())
			<-ctx.Done()
		}
		return a.shutdown(ctx, spec, adapter, false, nil)
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
	// Back up only data the game got as far as loading; even if it later crashed, what's on
	// disk is the newest copy there is.
	var backupSpec *game.BackupSpec
	if ready {
		s := adapter.Backup(cfg)
		backupSpec = &s
	}
	if ready {
		a.log.Info("game ready")
		a.report(ctx, "ready", "")
		if msg := a.whileReady(ctx, adapter, exited, a.idleAfter(cfg)); msg != "" {
			a.fail(ctx, msg)
			ready = false
			<-ctx.Done()
		}
	} else {
		<-ctx.Done()
	}
	stopWaiting()
	return a.shutdown(ctx, spec, adapter, ready, backupSpec)
}

// fetchConfig retries until the API answers. Early failures are expected: IAM and the
// instance's server record may not be in place yet when the instance first boots. A version
// that has never reached the API gives up after HealthDeadline, so the bootstrap can fall back.
func (a *Agent) fetchConfig(ctx context.Context) (game.Config, error) {
	unproven := a.Updater != nil && !a.Updater.Proven()
	for attempt := 1; ; attempt++ {
		cfg, err := a.API.Config(ctx)
		if err == nil {
			return cfg, nil
		}
		if unproven && time.Since(a.started) > a.HealthDeadline {
			a.log.Error("this agent version never reached the API; giving up", "err", err)
			return game.Config{}, ErrNeverHealthy
		}
		a.log.Warn("fetching config failed; retrying", "attempt", attempt, "err", err)
		if !a.sleep(ctx, a.backoff(attempt)) {
			return game.Config{}, ctx.Err()
		}
	}
}

// restore replaces the game data with the requested backup, before the game starts, then clears the
// request. Any failure fails the start, leaving the data as it was (unless only the clearing
// failed: the data is restored, but the request would restore it again on the next start).
func (a *Agent) restore(ctx context.Context, cfg game.Config, adapter game.Adapter) error {
	key, dir := cfg.Restore.Key, adapter.Backup(cfg).Dir
	a.log.Info("restoring backup", "key", key, "dir", dir)
	a.report(ctx, "starting", "restoring backup "+key)
	started := time.Now()
	// The start workflow waits 15 minutes for the game; a restore that takes that long has stalled.
	restoreCtx, cancel := context.WithTimeout(ctx, a.ReadyTimeout)
	defer cancel()

	err := a.Restore(restoreCtx, cfg.Restore.URL, dir)
	if errors.Is(err, backup.ErrLinkRefused) {
		// The link may have expired with the credentials that signed it: get a new one, once.
		a.log.Warn("download link refused; fetching a new one", "key", key)
		fresh, ferr := a.fetchConfig(ctx)
		if ferr != nil {
			return ferr
		}
		if fresh.Restore == nil || fresh.Restore.Key != key {
			return fmt.Errorf("the restore of %s changed while starting", key)
		}
		err = a.Restore(restoreCtx, fresh.Restore.URL, dir)
	}
	switch {
	case errors.Is(err, backup.ErrBackupGone):
		return fmt.Errorf("backup %s no longer exists; choose another with hearth restore", key)
	case errors.Is(err, backup.ErrLinkRefused):
		return fmt.Errorf("backup %s couldn't be downloaded: it no longer exists, or S3 refused the link", key)
	case err != nil:
		return fmt.Errorf("restoring backup %s failed: %w", key, err)
	}
	a.log.Info("backup restored", "key", key, "took", time.Since(started).Round(time.Millisecond))

	for attempt := 1; ; attempt++ {
		if err = a.API.Restored(ctx, key); err == nil {
			return nil
		}
		a.log.Warn("clearing the restore request failed", "attempt", attempt, "err", err)
		if attempt == 3 || !a.sleep(ctx, a.backoff(attempt)) {
			return fmt.Errorf("backup %s is restored, but the request couldn't be cleared (%v); "+
				"cancel it with hearth restore --cancel before starting again", key, err)
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

// idleAfter is the server's idle limit from its config (0 there = never), or IdleAfter when the
// API doesn't send one.
func (a *Agent) idleAfter(cfg game.Config) time.Duration {
	if cfg.IdleStopMinutes == nil {
		return a.IdleAfter
	}
	if *cfg.IdleStopMinutes <= 0 {
		return -1
	}
	return time.Duration(*cfg.IdleStopMinutes) * time.Minute
}

// whileReady watches the running game until shutdown is requested (returning "") or the game
// exits (returning why), checking the player count every PlayerInterval and asking for a stop
// once nobody has played for idleAfter (negative: never).
func (a *Agent) whileReady(ctx context.Context, adapter game.Adapter, exited <-chan string, idleAfter time.Duration) string {
	ticker := time.NewTicker(a.PlayerInterval)
	defer ticker.Stop()
	var players playerCount
	idle := idleTimer{after: idleAfter, lastSeen: time.Now()}
	if idleAfter > 0 {
		a.log.Info("will ask to stop after this long with nobody playing", "idleAfter", idleAfter)
	} else {
		a.log.Info("idle stop is off for this server")
	}
	for {
		select {
		case <-ctx.Done():
			return ""
		case msg := <-exited:
			return msg
		case <-ticker.C:
			checkCtx, cancel := context.WithTimeout(ctx, a.PollInterval)
			n, err := adapter.Players(checkCtx)
			cancel()
			players.record(a.log, n, err)
			if idle.due(time.Now(), n, err) {
				a.askToStop(ctx, &idle)
			}
		}
	}
}

// idleRetry is how long to wait before asking again after the API refused an idle stop or
// couldn't be reached.
const idleRetry = 5 * time.Minute

// askToStop asks the API to stop this server for being idle. On success the stop workflow stops
// the agent (with a backup), as for any stop; until then, it doesn't ask again.
func (a *Agent) askToStop(ctx context.Context, idle *idleTimer) {
	minutes := max(int(idle.after.Round(time.Minute)/time.Minute), 1)
	a.log.Info("nobody has played for a while; asking to stop", "idleMinutes", minutes)
	if err := a.API.Idle(ctx, minutes); err != nil {
		a.log.Warn("asking to stop failed; will ask again later", "err", err, "retryIn", idleRetry)
		idle.retryAt = time.Now().Add(idleRetry)
		return
	}
	idle.asked = true
}

// idleTimer decides when nobody has played for long enough. Only a check that worked counts: a
// failed one neither resets the timer nor makes the server idle, so a glitch never stops a game.
type idleTimer struct {
	after    time.Duration // 0 = never stop
	lastSeen time.Time     // when a check last saw players (or the game became ready)
	retryAt  time.Time     // after a failed request, don't ask again before this
	asked    bool          // the API accepted a stop
}

// due records a check's result and reports whether to ask for a stop now.
func (t *idleTimer) due(now time.Time, players int, err error) bool {
	if err != nil {
		return false
	}
	if players > 0 {
		t.lastSeen = now
		return false
	}
	return t.after > 0 && !t.asked && now.Sub(t.lastSeen) >= t.after && !now.Before(t.retryAt)
}

// playerCount logs the player count when it changes, and a failing check once per run of failures.
type playerCount struct {
	known   bool
	n       int
	failing bool
}

func (p *playerCount) record(log *slog.Logger, n int, err error) {
	if err != nil {
		if !p.failing {
			log.Warn("couldn't check the player count", "err", err)
		}
		p.failing = true
		return
	}
	p.failing = false
	if !p.known || n != p.n {
		log.Info("players online", "count", n)
	}
	p.known, p.n = true, n
}

// shutdown saves the game (if it got as far as loading its data), stops the container, then
// backs up backupSpec if the stop asked for it. It runs on its own deadline: ctx is already
// cancelled, but the save and backup must still finish.
func (a *Agent) shutdown(ctx context.Context, spec container.Spec, adapter game.Adapter, save bool, backupSpec *game.BackupSpec) error {
	wantBackup := a.takeBackupMarker()
	a.log.Info("shutdown requested", "backup", wantBackup)
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
			a.log.Info("game saved")
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

	// The game is saved, so a failed backup is reported but doesn't make the stop an error.
	msg := ""
	if wantBackup && backupSpec != nil && a.Backups != nil {
		if err := a.backup(stopCtx, *backupSpec); err != nil {
			a.log.Error("backup failed", "err", err)
			msg = "game saved, but the backup failed: " + err.Error()
		}
	}
	a.report(stopCtx, "stopped", msg)
	a.log.Info("agent stopped")
	return nil
}

// reportReserve is kept back from the backup (up to a quarter of StopTimeout), so the stopped
// report can still go out after it.
const reportReserve = 15 * time.Second

func (a *Agent) backup(ctx context.Context, spec game.BackupSpec) error {
	a.report(ctx, "stopping", "backing up the game data")
	if deadline, ok := ctx.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline.Add(-min(reportReserve, a.StopTimeout/4)))
		defer cancel()
	}
	started := time.Now()
	res, err := a.Backups.Backup(ctx, spec)
	if err != nil {
		return err
	}
	a.log.Info("game data backed up", "key", res.Key, "bytes", res.Bytes, "took", time.Since(started).Round(time.Millisecond))
	return nil
}

// takeBackupMarker reports whether a backup was asked for, removing the request.
func (a *Agent) takeBackupMarker() bool {
	if a.BackupMarker == "" {
		return false
	}
	err := os.Remove(a.BackupMarker)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		a.log.Warn("couldn't remove the backup marker", "path", a.BackupMarker, "err", err)
	}
	return err == nil
}

func (a *Agent) fail(ctx context.Context, msg string) {
	a.log.Error(msg)
	a.report(ctx, "error", msg)
}

// report sends a status report, retrying briefly. Reports are best effort: failing to report
// never stops the game from running or saving.
func (a *Agent) report(ctx context.Context, state, msg string) {
	report := api.StatusReport{State: state, AgentVersion: a.Version, Message: truncate(msg, maxMessageLength)}
	for attempt := 1; attempt <= 3; attempt++ {
		err := a.API.ReportStatus(ctx, report)
		if err == nil {
			a.markHealthy()
			return
		}
		a.log.Warn("status report failed", "state", state, "attempt", attempt, "err", err)
		if attempt < 3 && !a.sleep(ctx, a.backoff(attempt)) {
			return
		}
	}
}

// maxMessageLength is the longest message the API accepts (MAX_MESSAGE_LENGTH in services/api).
const maxMessageLength = 500

// truncate shortens s to at most n bytes, cutting between characters and ending with "...". The
// API counts UTF-16 code units, and no character is longer in UTF-16 than in UTF-8.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n - len("...")
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

// markHealthy records, once per run, that this version reached the API.
func (a *Agent) markHealthy() {
	if a.healthy || a.Updater == nil {
		return
	}
	a.healthy = true
	if err := a.Updater.MarkHealthy(); err != nil {
		a.log.Warn("couldn't record that this agent is healthy", "err", err)
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
