# Hearth: notes for Claude

Hearth is a game server hosting platform on AWS (CDK in TypeScript, a Go agent on each game instance),
built for a small gaming group first. This file is read at the start of every session; keep it current
as part of each PR. The repo layout and commands are in [README.md](README.md).

## Where things are

- **Architecture doc:** Claude Doc "Hearth — Architecture", https://claude.ai/artifact/9a4UdwjXfggsVDFotYdqxJ
  - **Architecture** tab: the reference; its Roadmap table tracks milestones.
  - **System map** tab: diagram and components as built; update it as milestones land.
  - **Outdated: original architecture** tab: history only, never edit.
- **Testing guides:** `docs/testing/`. The owner runs AWS checks from CloudShell or their own terminal.

## Working agreement

- The owner creates branches, commits and merges; one reviewable PR at a time. Ask before starting a
  new milestone.
- Keep PRs small: one layer or concern each (e.g. API route, then infra, then agent). Split a
  milestone PR into several before starting, and agree the split with the owner.
- Be concise, in replies and especially in doc updates: tables and short bullets, folded into existing
  sections.
- Use `pnpm`. pnpm is pinned in `package.json`, and build scripts must be approved in `pnpm-workspace.yaml`
  (`allowBuilds`). After changing dependencies, check `pnpm install --frozen-lockfile` passes, as CI uses it.
- Before handing over a change, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. Use `pnpm synth` for
  infra changes, and shellcheck (`koalaman/shellcheck:latest` in Docker) for shell scripts.
- Windows + Git Bash: set `MSYS_NO_PATHCONV=1` for AWS CLI calls with `/hearth/...` paths. `.sh` and `.go`
  files must stay LF (`.gitattributes`). Prefer the Edit tool over shell or Python rewrites of source files.

## Status (update with each PR)

| Milestone | Status |
| --- | --- |
| M0–M4: foundation, infra, agent, lifecycle workflows, agent releases; plus monitoring | Done |
| M5 Game updates and backups | Done (PR1–PR9; follow-ups under Deferred) |
| M6 Idle shutdown | In progress: PR1–PR3 merged; PR4 (idle setting) in review |
| M7 Move your world | Not started |

**M6 plan** (stop servers nobody is playing on; detection runs on the instance, no heartbeats):
- PR1, merged: adapters gain `Players()` (Minecraft: the server list ping); the agent checks
  every 15 seconds while the game is ready and logs changes.
- PR2, merged: `POST /agent/idle` lets an agent stop its own `RUNNING` server through the normal
  stop workflow (so it still backs up), recording `stopReason`; `hearth status` shows it. Its
  Lambda may start only the stop workflow.
- PR3, merged: the agent's idle timer. Idle = the latest check worked and saw nobody, and no
  check has seen anyone for `IdleAfter` (30 min; `-idle-after` / `HEARTH_IDLE_AFTER` override).
  A failed check neither counts nor resets. Asks once; after a refused request, waits 5 min.
- PR4, in review: per-server `idleStopMinutes` (default 30, 0 = never) through the settings route;
  the agent config always carries it, and it wins over the agent's `-idle-after` fallback.
  `hearth set-idle <id> <minutes|off>`; `hearth status` shows it. Applies from the next start.

**M5 plan:**
- PR1, done: the stop workflow stops the agent through SSM Run Command before stopping the instance.
- PR2, done: on that stop, the agent backs the world up to S3 and the API records it (tested on dev:
  about 10s for a small world).
- PR3, done: keep the newest 10 backups per server (tested on dev).
- PR4, done: `hearth backups <id>` lists a server's backups (`GET /admin/servers/{id}/backups`).
- PR6, done: `hearth restore <id> [<key>] [--force]` and `--cancel` record or clear
  `restoreKey` on a stopped server. Also moves the backup storage code to
  `services/api/src/backups.ts`, shared by agent and admin routes.
- PR7 (R3a, API), done: agent config carries `restore: { key, url }` (presigned when the config is
  fetched, 15 min) while a restore is pending; `POST /agent/restored` clears it; restore/cancel
  accept a stopped `FAILED` server.
- PR8 (R3b, agent), done (tested on dev): before starting the game, the agent downloads and unpacks
  the backup beside the world (refusing paths and symlinks outside it), swaps it in, then clears the
  request. Any failure fails the start with the world untouched.
- PR9, done (tested on dev, 26.2 → 26.3): `hearth set-version <id> <version>` (`POST /admin/servers/{id}/version`): stopped
  servers only; the version must be a full release in the game's version list (Mojang's manifest,
  cached 10 min, ordered by release date) and newer than the current one; needs a clean last stop
  with a backup since the server last ran. Applies on the next start.

## Decisions and why

- **One AWS account, envs dev/stage/prod** (only dev deployed): separate accounts are too much overhead
  for this scale. EC2 events reach every env's rule; a router Lambda is the planned fix (not built).
- **Deploys use the owner's existing `github-deploy` role** (OIDC, ID-based subject
  `repo:tarik-alauddin@92332908/hearth@1391534026:*`): no per-environment roles.
- **All Servers table writes go through `services/core`**; the API is the only entry point for callers.
- **Instances have no S3 write access.** They read agent releases only; backups use short-lived,
  per-server credentials from the API.
- **Launches use the launch template's `$Latest`.** A pinned version number went stale: a user-data-only
  change doesn't redeploy the stack that consumes it.
- **A failed workflow never leaves an instance running.** Create/start failure paths stop the instance;
  instances are tagged with `serverId` at launch.
- **Agent releases:** a merge to `main` touching `agent/` cuts `YYYY.MM.DD-<sha7>` onto dev canary;
  "Promote agent" moves any release to any env and channel. Pruning is count-based (each channel's last
  3, the newest 5).
- **Backup during the stop workflow, before the instance stops**, via Run Command
  `hearth-<env>-stop-agent`. The command finishing means the agent is done; the agent's `stopped` report
  says how it went. The agent gets 5 minutes; after about 6 the workflow stops the instance anyway and
  cancels the command. Only this path backs up: the command creates `/run/hearth/backup-on-stop`
  before stopping the agent. An OS shutdown (no marker) saves the world but skips the backup, as EC2
  may not wait long enough.
- **Backups:** `servers/<serverId>/<yyyymmdd>T<hhmmss>Z.tar.gz`, streamed (gzip, multipart upload,
  nothing staged on disk) after the game container stops. `POST /agent/backup-credentials` returns
  15-minute credentials from the `BackupWriter` role, narrowed to that one key; `POST /agent/backups`
  checks the object exists and records `lastBackup*`. Only a game that became ready is backed up.
- **A failed backup doesn't fail the stop:** the world is saved, so the agent reports `stopped` with
  the failure as its message, and `lastStopClean` stays true.
- **Stop timeouts are nested**, each a backstop for the one inside it: game container 60s, agent
  stop 270s (15s of it kept back for the final report), systemd `TimeoutStopSec` 300s, SSM command
  330s, workflow about 360s.
- **Backup retention: the newest 10 per server** (count-based), pruned by `POST /agent/backups` right
  after it records a new one; a failed prune is logged and retried by the next backup. The bucket is
  versioned, so a pruned backup stays recoverable for 30 days. Known cost: the bucket moves backups
  to Glacier IR after 30 days, which bills a 90-day minimum, so backups the count rule deletes early
  are still billed to day 90. Accepted at this scale.
- **Restores download through a presigned S3 URL** for the one backup (read-only, short-lived), not
  STS credentials.
- **A restore replaces the current world** and is refused after an unclean last stop (that world may
  not be in any backup) unless forced.
- **Restore happens in the start workflow, not a workflow of its own:** a restore always needs the
  game stopped and then started. A pending restore arrives in the agent's config, so ordinary starts
  pay nothing; only a start with a restore pending downloads and unpacks a backup first.
- **S3 answers a missing backup with 403, not 404,** because the link's signer (the config Lambda)
  can't list the bucket. On a 403 the agent fetches a new link once (it may have expired), then
  fails with "no longer exists, or S3 refused the link".
- **A restore whose backup is gone fails the start** (the server ends `FAILED`, world untouched) rather
  than starting without it, so the gap is visible. This can happen when a start fails before
  restoring and the next stop's backup prunes the oldest. `hearth restore` and `--cancel` also accept
  a `FAILED` server whose instance is stopped, so another backup can be chosen.
- **Backup rules live in each game's adapter** (`Backup()` with an exclude list), not in the agent core.
- **The fleet check reports and never fixes** (stuck, failed and mismatched servers, untracked instances).
  It is scheduled in prod only; `hearth fleet-check` runs it anywhere.
- **Game code is not coupled to Minecraft:** one adapter per game under `agent/internal/game/`.

## Decided against

- **Agent check-ins or heartbeats:** API cost at scale. Push through SSM Run Command instead; M6 idle
  detection runs on the instance.
- **Backing up on OS shutdown:** EC2 may not wait 5 minutes; the SSM stop path is the backup path.
- **Marking a stop FAILED when the SSM path fails but the OS-shutdown save works:** the server is fine.
  Making that fallback visible (record field, metric, alarm) is deferred.
- **Time-based expiry of agent releases or backups:** count-based retention instead.
- **Manual semver tags for agent releases:** date tags are generated automatically.
- **15-minute agent stop window:** 5 minutes; slower means something is wrong.

## Deferred

- **Version rollback.** Upgrades are one-way (the game converts the world), so `set-version` is
  forward only. Restoring a pre-upgrade backup does *not* put the server back on the old version:
  backups don't record their game version, so the old world would just be upgraded again. To roll
  back properly: record the version on each backup (S3 metadata at upload), have restore set it, and
  show it in `hearth backups`. Until then, rolling back is manual.
- **Snapshot versions** (the group may want them). Do rollback (above) first: snapshots are where
  worlds break, and forward-only can't step back. Then one small PR: keep snapshots in the version
  list, marked as such (release-date ordering already spans both), opt in with
  `hearth set-version … --snapshot` (maybe `create --snapshot`), and confirm on a test server that
  the Minecraft image takes snapshot IDs in `VERSION`. Players switch their launcher to match.
- **Join/leave events from the game's log** (M6 follow-up). Polling every 15s can miss a visit of a
  few seconds, which shouldn't count as idle. The agent can follow the container's output through
  Docker's API on its local socket (no extra process, unlike `docker logs -f`; a few lines a minute,
  negligible CPU), with the adapter recognising join lines (Minecraft: `… joined the game`). Joins
  reset the idle timer instantly; the poll stays the source of truth for the count, correcting
  anything the log missed or reworded.
- **Agent logs in CloudWatch.** Today they're only in journald (Session Manager:
  `journalctl -u hearth-agent`); CloudWatch has the status reports and Lambda logs. If needed: the
  agent sends its own `info` logs with `PutLogEvents` (no CloudWatch agent daemon, which costs game
  RAM), 14-day retention; a few cents a month. Not the game's own logs (too chatty).
- **Warn when restoring the newest backup after a clean stop:** it's the current world, so nothing
  changes (this confused the first restore test on dev).
- **Telling players about a version change** (their clients must match): a printed reminder or a
  Discord announcement, later.
