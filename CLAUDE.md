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
| M5 Game updates and backups | In progress: PR1–PR2 merged; PR3 (retention) in review |
| M6 Idle shutdown, M7 Move your world | Not started |

**M5 plan:**
- PR1, done: the stop workflow stops the agent through SSM Run Command before stopping the instance.
- PR2, done: on that stop, the agent backs the world up to S3 and the API records it (tested on dev:
  about 10s for a small world).
- PR3, in review: keep the newest 10 backups per server.
- Then: restore, and `hearth set-version` (forward only, needs a backup).

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
