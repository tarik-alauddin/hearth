#!/bin/bash
# First-boot setup for a Hearth game instance: Docker, the world data volume at /srv/hearth,
# and the game agent as a systemd service.
# Safe to run again: the data volume is only formatted when it has no filesystem.
#
# GameInfraStack prepends these variables when it builds the launch template's user data:
#   HEARTH_ENV           environment (dev, stage, prod)
#   HEARTH_HOME_REGION   region of the Hearth API, the agent channels and the releases bucket
#   HEARTH_AGENT_BUCKET  the agent releases bucket
set -euo pipefail
: "${HEARTH_ENV:?}" "${HEARTH_HOME_REGION:?}" "${HEARTH_AGENT_BUCKET:?}"

DATA_DEVICE=/dev/sdf
DATA_LABEL=hearth-data
DATA_MOUNT=/srv/hearth

log() { echo "hearth-user-data: $*"; }

log "installing docker"
dnf install -y docker
systemctl enable --now docker

# EBS volumes are NVMe devices on Graviton; amazon-ec2-utils adds the /dev/sdf symlink.
for _ in $(seq 1 60); do
  [ -e "$DATA_DEVICE" ] && break
  sleep 1
done
if [ ! -e "$DATA_DEVICE" ]; then
  log "data volume $DATA_DEVICE not found"
  exit 1
fi

fstype=$(blkid -o value -s TYPE "$DATA_DEVICE" || true)
if [ -z "$fstype" ]; then
  log "formatting empty data volume"
  mkfs.xfs -L "$DATA_LABEL" "$DATA_DEVICE"
  fstype=xfs
else
  log "data volume already has a $fstype filesystem; not formatting"
fi

mkdir -p "$DATA_MOUNT"
if ! grep -q "[[:space:]]${DATA_MOUNT}[[:space:]]" /etc/fstab; then
  uuid=$(blkid -o value -s UUID "$DATA_DEVICE")
  # nofail: a missing data volume must not stop the instance from booting.
  echo "UUID=$uuid $DATA_MOUNT $fstype defaults,nofail,x-systemd.device-timeout=30s 0 2" >> /etc/fstab
  systemctl daemon-reload
fi
mountpoint -q "$DATA_MOUNT" || mount "$DATA_MOUNT"
log "data volume mounted at $DATA_MOUNT"

log "installing the agent service"
install -d -m 0755 /etc/hearth
cat > /etc/hearth/agent.env <<EOF
HEARTH_ENV=$HEARTH_ENV
HEARTH_HOME_REGION=$HEARTH_HOME_REGION
HEARTH_AGENT_BUCKET=$HEARTH_AGENT_BUCKET
HEARTH_DATA_DIR=$DATA_MOUNT
EOF

# The bootstrap runs on every service start, then becomes the agent (exec), so systemd's stop
# signal goes straight to it. An instance keeps this bootstrap for life, so it stays small: the
# agent does the updating (see agent/internal/update), the bootstrap only swaps files.
cat > /usr/local/bin/hearth-bootstrap <<'EOF'
#!/bin/bash
set -euo pipefail
BIN=${HEARTH_BIN_DIR:-/opt/hearth/bin}
STATE=${HEARTH_STATE_DIR:-/var/lib/hearth}
MAX_UNHEALTHY_STARTS=2
agent="$BIN/hearth-agent"
log() { echo "hearth-bootstrap: $*"; }
install -d -m 0755 "$BIN" "$STATE"

# The agent staged an update and exited: make it current. The current agent becomes the last
# known good one, but only if it ever reached the API.
if [ -x "$agent.next" ]; then
  if [ -x "$agent" ] && [ -f "$STATE/agent-healthy" ]; then
    mv -f "$agent" "$agent.previous"
  fi
  mv -f "$agent.next" "$agent"
  rm -f "$STATE/agent-healthy" "$STATE/agent-failed"
  echo 0 > "$STATE/unhealthy-starts"
  log "updated the agent"
fi

# First boot: no agent yet, so download the environment's stable release. The agent then updates
# itself to its server's channel.
if [ ! -x "$agent" ]; then
  release=$(aws ssm get-parameter --region "$HEARTH_HOME_REGION" --name "/hearth/$HEARTH_ENV/agent/stable" \
    --query Parameter.Value --output text)
  # Written by the release workflows as {"version":"…","sha256":"…"}.
  version=$(sed -E 's/.*"version":"([^"]+)".*/\1/' <<<"$release")
  sha256=$(sed -E 's/.*"sha256":"([0-9a-f]{64})".*/\1/' <<<"$release")
  tmp=$(mktemp "$BIN/.hearth-agent.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  aws s3 cp --only-show-errors --region "$HEARTH_HOME_REGION" \
    "s3://$HEARTH_AGENT_BUCKET/agent/$version/hearth-agent-linux-arm64" "$tmp"
  if ! echo "$sha256  $tmp" | sha256sum --check --quiet; then
    log "agent $version failed its checksum"
    exit 1
  fi
  chmod 0755 "$tmp"
  mv -f "$tmp" "$agent"
  trap - EXIT
  log "downloaded agent $version"
fi

# A new agent that keeps exiting before it ever reaches the API goes back to the last known good
# one. The agent then won't stage the failed version again, and reports the fallback.
if [ ! -f "$STATE/agent-healthy" ]; then
  starts=$(( $(cat "$STATE/unhealthy-starts" 2>/dev/null || echo 0) + 1 ))
  echo "$starts" > "$STATE/unhealthy-starts"
  if [ "$starts" -gt "$MAX_UNHEALTHY_STARTS" ] && [ -x "$agent.previous" ]; then
    failed=$("$agent" -version 2>/dev/null || echo unknown)
    log "agent $failed never became healthy; falling back to the previous agent"
    echo "$failed" > "$STATE/agent-failed"
    mv -f "$agent" "$agent.failed"
    mv -f "$agent.previous" "$agent"
    "$agent" -version 2>/dev/null > "$STATE/agent-healthy" || true
    echo 0 > "$STATE/unhealthy-starts"
  fi
fi

exec "$agent"
EOF
chmod 0755 /usr/local/bin/hearth-bootstrap

cat > /etc/systemd/system/hearth-agent.service <<EOF
[Unit]
Description=Hearth game agent
# Start after Docker and the world volume; on shutdown systemd stops units in reverse,
# so the agent saves the world and stops the game before Docker goes away.
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor=$DATA_MOUNT
StartLimitIntervalSec=0

[Service]
EnvironmentFile=/etc/hearth/agent.env
ExecStart=/usr/local/bin/hearth-bootstrap
Restart=on-failure
RestartSec=10
# SIGTERM goes to the agent only; it stops the game itself. Longer than the agent's own 90s stop timeout.
KillMode=mixed
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
# --no-block: cloud-init is still running; don't wait on the agent's start here.
systemctl enable --now --no-block hearth-agent.service
log "agent service installed"
