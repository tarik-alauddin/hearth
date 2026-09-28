#!/bin/bash
# First-boot setup for a Hearth game instance: Docker, the world data volume at /srv/hearth,
# and the game agent as a systemd service.
# Safe to run again: the data volume is only formatted when it has no filesystem.
#
# GameInfraStack prepends these variables when it builds the launch template's user data:
#   HEARTH_ENV           environment (dev, stage, prod)
#   HEARTH_HOME_REGION   region of the Hearth API
#   HEARTH_AGENT_URL     s3:// URL of the agent binary
#   HEARTH_AGENT_REGION  region of the bucket holding the agent
set -euo pipefail
: "${HEARTH_ENV:?}" "${HEARTH_HOME_REGION:?}" "${HEARTH_AGENT_URL:?}" "${HEARTH_AGENT_REGION:?}"

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
HEARTH_AGENT_URL=$HEARTH_AGENT_URL
HEARTH_AGENT_REGION=$HEARTH_AGENT_REGION
HEARTH_DATA_DIR=$DATA_MOUNT
EOF

# The bootstrap stays small and stable: it downloads the agent on every service start, then
# becomes it (exec), so systemd's stop signal goes straight to the agent.
cat > /usr/local/bin/hearth-bootstrap <<'EOF'
#!/bin/bash
set -euo pipefail
install -d -m 0755 /opt/hearth/bin
tmp=$(mktemp /opt/hearth/bin/.hearth-agent.XXXXXX)
trap 'rm -f "$tmp"' EXIT
aws s3 cp --only-show-errors --region "$HEARTH_AGENT_REGION" "$HEARTH_AGENT_URL" "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" /opt/hearth/bin/hearth-agent
trap - EXIT
exec /opt/hearth/bin/hearth-agent
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
