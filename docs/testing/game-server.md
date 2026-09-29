# Game server check

End-to-end check that a server can be created, joined from a Minecraft client, stopped and started
with its world intact, through the real API and lifecycle workflows. Rerun after changes to the
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

"Not clean" instead means the agent didn't report saving before the instance powered off.

## 4. Start again

```bash
hearth start <serverId>             # prints the new address; the IP changes every start
```

Join again: what you built is still there.

## 5. Check the rest

```bash
hearth list                         # one line per server
hearth start <serverId>             # while RUNNING: "Already running.", nothing new starts
```

## 6. Clean up

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
