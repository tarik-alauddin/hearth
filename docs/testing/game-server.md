# Game server check

End-to-end check that a server created in an environment can be joined from a Minecraft client,
survives a stop/start with its world intact, and cleans up. First run for M2 ("you join the server
by IP from your Minecraft client"); rerun after changes to the agent, the API's agent routes, the
startup script or the launch template.

Uses `scripts/dev-server.sh`, which stands in for the lifecycle workflows and CLI until M3.
The agent's own behaviour is also covered in CI by `agent/harness`; this check adds real EC2, IAM,
the API and your client.

**Where to run:** AWS CloudShell in `us-west-2`. Get the script there with **Actions → Upload file**
(`scripts/dev-server.sh`), or clone the repo. **Costs:** a few cents per hour while the server runs.

## 0. Before you start

- The change is deployed to the environment (for dev: merged to `main` and the Deploy workflow is green).
- Know your Minecraft Java client's version (title screen, bottom left). The server must match it.

## 1. Create a server

```bash
bash dev-server.sh create 1.21.4      # use your client's version
```

The script writes the server record, launches an instance from the launch template, tags it and its
world volume with the server ID, then follows the agent's reports:

```
agent: no report yet
agent: starting
agent: ready
ready. Join at 35.x.x.x:25565   (server 01M...)
```

The first start takes about 3–5 minutes: instance boot, Docker, the agent download, the Minecraft
image and server download, and world generation. Note the server ID for the next steps.

## 2. Join and leave a mark

In Minecraft: **Multiplayer → Direct Connection** → the `ip:25565` from step 1. Build something
recognisable near spawn, then disconnect.

## 3. Look around the instance (optional)

Connect with **EC2 → the instance → Connect → Session Manager**:

```bash
systemctl status hearth-agent          # active (running)
journalctl -u hearth-agent -n 50       # the agent's JSON logs
sudo docker ps                         # hearth-game, 0.0.0.0:25565 and 127.0.0.1:25575 only
sudo docker logs --tail 20 hearth-game
```

## 4. Stop: the agent saves the world during shutdown

```bash
bash dev-server.sh stop <serverId>     # ends with "Last agent report: stopped"
```

`stopped` means the agent saved over RCON and the game exited cleanly before the instance powered off.

## 5. Start again: same world, new IP

```bash
bash dev-server.sh start <serverId>    # prints the new join address
```

Join at the new address; what you built in step 2 is still there.

## 6. Clean up

```bash
bash dev-server.sh destroy <serverId> --yes   # instance, world volume and record
bash dev-server.sh list                       # the server is gone
```

## Troubleshooting

`bash dev-server.sh status <serverId>` shows the agent's last report and message.

| Symptom | Look at |
| --- | --- |
| Stuck on "no report yet" | `journalctl -u hearth-agent`: the bootstrap's S3 download, then "fetching config failed" lines with the API's answer |
| API answers 403 | The caller isn't the instance role; check `INSTANCE_ROLE_NAMES` on the AgentConfig Lambda |
| API answers 404 for a while | Normal right after launch: the index catches up with the new `instanceId` within seconds |
| `agent: error` | The message says what failed; `sudo docker logs hearth-game` for game-side problems |
| Can't connect from the client | Version mismatch (client and server must match), or the IP changed after a start |
| Startup script problems | `/var/log/cloud-init-output.log`, lines starting `hearth-user-data:` |
