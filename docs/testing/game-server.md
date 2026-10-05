# Game server check

End-to-end check that a server can be created, joined from a Minecraft client, stopped (with a
backup) and started with its world intact, through the real API and lifecycle workflows. Rerun after changes to the
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

## 7. Check the rest

```bash
hearth list                         # one line per server
hearth start <serverId>             # while RUNNING: "Already running.", nothing new starts
```

## 8. Clean up

There's no delete in the API until archiving exists (it would lose the world). Use the dev script
(needs the AWS CLI; CloudShell has it):

```bash
bash scripts/dev-server.sh destroy <serverId> --yes
```

## Troubleshooting

`hearth status <serverId>` shows the status, the agent's last report and any failure reason.

| Symptom | Look at |
| --- | --- |
| `FAILED` with a message | The message; then the workflow's execution in **Step Functions** (`hearth-<env>-<op>-server`) |
| Stuck at `STARTING`, no agent report | `journalctl -u hearth-agent` on the instance (Session Manager) |
| `API 403` | Your credentials lack `execute-api:Invoke`, or you're using a game instance's role |
| `API 409` | The server is mid-operation (e.g. stop while starting); wait and retry |
| Can't connect from the client | Version mismatch, or an old IP after a start |
| Backup failed, or no `last backup` | `journalctl -u hearth-agent` (`backup failed`); the `AgentBackupCredentials`/`AgentBackupDone` Lambda logs |
