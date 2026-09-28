#!/bin/bash
# First-boot setup for a Hearth game instance: Docker, and the world data volume at /srv/hearth.
# Safe to run again: the data volume is only formatted when it has no filesystem.
set -euo pipefail

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
