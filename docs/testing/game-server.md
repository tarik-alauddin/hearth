# Game server check

End-to-end check that a server can be created (fresh, or from an uploaded world), joined from a
Minecraft client, stopped (with a backup) and started with its world intact, through the real API
and lifecycle workflows. Rerun after changes to the
agent, the API, the workflows, the startup script or the launch template.

**Where to run:** locally (`pnpm hearth …`, with AWS credentials for the account) or in AWS CloudShell
in `us-west-2`. For CloudShell, build the CLI once with `pnpm --filter @hearth/cli bundle`, upload
`cli/dist/hearth.cjs` (**Actions → Upload file**) and run `node hearth.cjs …`. Commands below use
`hearth` for either. **Costs:** a few cents per hour while the server runs.

## 0. Before you start

- The change is deployed (for dev: merged to `main`, Deploy workflow green).
- Your Minecraft Java client's version (title screen, bottom left); the server must match it.

## 1. Create

```bash
hearth create --version 1.21.4      # your client's version
```

Expect `PROVISIONING` → `STARTING · agent starting` → `RUNNING · agent ready`, then
`Ready. Join at <ip>:25565`. The first start takes about 3–5 minutes.

## 2. Join and leave a mark

**Multiplayer → Direct Connection** → the address from step 1. Build something near spawn, disconnect.

## 3. Stop

```bash
hearth stop <serverId>              # ends with "Stopped. World saved."
```

"Not clean" instead means the agent didn't report saving before the instance powered off. A clean
stop whose backup failed ends with `Agent: world saved, but the backup failed: …`.

Check the backup (the bucket is `hearth-<env>-backups-<account>-us-west-2`):

```bash
hearth status <serverId>            # "last backup  <time> (<size> MiB)"
hearth backups <serverId>           # newest first; the top one matches "last backup"
aws s3 ls s3://<bucket>/servers/<serverId>/            # one <yyyymmdd>T<hhmmss>Z.tar.gz per stop
aws s3 cp s3://<bucket>/<key> - | tar tz | head        # world/…, server.properties; no logs/ or *.jar
```

Retention keeps the newest 10 per server. Rather than stopping 11 times, copy an existing backup to
older names (PowerShell), then start and stop once:

```powershell
$B = "<bucket>"; $P = "servers/<serverId>"
foreach ($day in 1..11) {
  $d = "202001{0:D2}" -f $day
  aws s3 cp "s3://$B/$P/<existing key>" "s3://$B/$P/${d}T000000Z.tar.gz"
}
```

After the stop, `aws s3 ls "s3://$B/$P/"` shows exactly 10, with the oldest 2020 names gone.

## 4. Start again

```bash
hearth start <serverId>             # prints the new address; the IP changes every start
```

Join again: what you built is still there.

## 5. Restore

Needs the agent with restores: the server on a channel that has it (dev canary first).

1. Stop, then note the newest backup with `hearth backups <serverId>`: call it A.
2. Start, join, build something new, stop. That stop's backup (B) has the new build.
3. Ask for A and start:

   ```bash
   hearth restore <serverId> <A's file name>
   hearth start <serverId>           # STARTING · agent starting: restoring backup …
   ```

4. Join: the new build is gone (the world is A's). `hearth status` shows no `restore` row.
5. Restore B the same way to get the build back.

A missing backup fails the start: copy A to a made-up name, ask for that, delete it from S3, then
start. Expect `FAILED` with `backup … no longer exists` (or `… or S3 refused the link`), and the
world untouched. `hearth restore <serverId> --cancel` (allowed while `FAILED`), then start.

## 6. Change version

Needs a newer release than the server's (or create a test server on an older one, e.g. `1.21.4`).
After a clean stop:

```bash
hearth set-version <serverId> <newer release>   # "… runs minecraft-java <version> from its next start."
hearth set-version <serverId> <older release>   # refused: versions only move forward
hearth start <serverId>                         # join with a client on the new version
```

## 7. Create from an upload

A zip (or .tar.gz) holding a world, e.g. a single-player save from `.minecraft/saves/<name>`,
zipped. Pick the world's version or a newer one: the game upgrades a world on load, never back.

```bash
hearth create --version <version> --upload <MyWorld.zip>
```

Expect `Uploading MyWorld.zip (… MiB)…` → `Uploaded. Checking it…` → `Accepted (…)` → the usual
create, with `STARTING · agent starting` while the agent restores it. Join: it's your world, not a
new one. After the first `hearth stop`, `hearth backups <serverId>` lists it as the first backup.

Refused, and nothing created:

| Upload | Message |
| --- | --- |
| Not a zip or .tar.gz (e.g. a .txt) | `The upload was rejected: the upload must be a .zip or .tar.gz file` |
| A zip with no world in it | `… no Minecraft world found: the upload needs exactly one folder holding level.dat` |
| Over 4 GiB | `… uploads can be at most 4096.0 MiB` (before anything is uploaded) |

`--from-upload <uploadId>` creates from an upload already accepted (accepted uploads expire after
7 days).

## 8. Check the rest

```bash
hearth list                         # one line per server
hearth start <serverId>             # while RUNNING: "Already running.", nothing new starts
```

## 9. Clean up

```bash
hearth stop <serverId>              # destroy refuses a server that isn't stopped
hearth destroy <serverId>           # shows what goes, then asks you to type the ID; --yes skips that
```

Expect `DESTROYING`, then `Destroyed.` The instance and data volume are deleted (EC2 console);
`hearth status <serverId>` now answers 404. Its backups are kept under `servers/<serverId>/` in the
backups bucket.

Refused: `hearth destroy` on a running server (`stop it before destroying it`), and a typed ID that
doesn't match (`Not destroyed`).

## Troubleshooting

`hearth status <serverId>` shows the status, the agent's last report and any failure reason.

| Symptom | Look at |
| --- | --- |
| `FAILED` with a message | The message; then the workflow's execution in **Step Functions** (`hearth-<env>-<op>-server`) |
| Stuck at `STARTING`, no agent report | `journalctl -u hearth-agent` on the instance (Session Manager) |
| `API 403` | Your credentials lack `execute-api:Invoke`, or you're using a game instance's role |
| `API 409` | The server is mid-operation (e.g. stop while starting); wait and retry |
| Can't connect from the client | Version mismatch, or an old IP after a start |
| A destroy ends `FAILED` | The message; the `hearth-<env>-destroy-server` execution in **Step Functions**. `hearth destroy` again retries it |
| An upload stays "Checking it…" | The `Repack` Lambda's logs (`upload accepted` / `upload rejected` / `repack failed`); `aws s3 ls s3://hearth-<env>-uploads-<account>-us-west-2/landing/` |
| A server from an upload `FAILED` on first start | `hearth status` (e.g. `backup … no longer exists`: the upload expired before the first start); create again with a new upload |
| Backup failed, or no `last backup` | `journalctl -u hearth-agent` (`backup failed`); the `AgentBackupCredentials`/`AgentBackupDone` Lambda logs |
