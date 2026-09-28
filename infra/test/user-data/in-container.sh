#!/bin/bash
# Runs inside the container started by run.sh.
set -euo pipefail

SCRIPT=/work/game-instance.sh
MOUNT=/srv/hearth
LOOP=

dnf install -y -q xfsprogs e2fsprogs util-linux grep systemd >/dev/null
mkdir -p /etc/systemd/system # exists on a real instance

# dnf and systemctl need a real instance; stub them and record their calls.
mkdir -p /stubs
for cmd in dnf systemctl; do
  printf '#!/bin/bash\necho "%s $*" >> /tmp/calls\n' "$cmd" > "/stubs/$cmd"
  chmod +x "/stubs/$cmd"
done
export PATH="/stubs:$PATH"

# GameInfraStack prepends these to the script in the launch template's user data.
export HEARTH_ENV=dev HEARTH_HOME_REGION=us-west-2 HEARTH_AGENT_REGION=us-west-2
export HEARTH_AGENT_URL=s3://cdk-hearthdev-assets-123456789012-us-west-2/abc_noext

cleanup() {
  umount "$MOUNT" 2>/dev/null || true
  if [ -n "$LOOP" ]; then losetup -d "$LOOP"; fi
}
trap cleanup EXIT

fail() { echo "not ok - $*"; exit 1; }
ok() { echo "ok - $*"; }

# A blank 512 MiB disk at /dev/sdf, an empty fstab and a clean call log.
new_disk() {
  cleanup
  rm -f /tmp/disk.img
  truncate -s 512M /tmp/disk.img
  LOOP=$(losetup -f --show /tmp/disk.img)
  ln -sf "$LOOP" /dev/sdf
  : > /etc/fstab
  : > /tmp/calls
}

run_script() {
  if ! bash "$SCRIPT" > /tmp/out 2>&1; then
    cat /tmp/out
    fail "script exited non-zero"
  fi
}

fstab_entries() { grep -c "[[:space:]]${MOUNT}[[:space:]]" /etc/fstab || true; }
fstype() { blkid -o value -s TYPE /dev/sdf; }

echo "# blank volume"
new_disk
run_script
grep -q "formatting empty data volume" /tmp/out || fail "did not format a blank volume"
[ "$(fstype)" = xfs ] || fail "expected xfs, got $(fstype)"
[ "$(blkid -o value -s LABEL /dev/sdf)" = hearth-data ] || fail "missing hearth-data label"
mountpoint -q "$MOUNT" || fail "not mounted at $MOUNT"
[ "$(fstab_entries)" = 1 ] || fail "expected 1 fstab entry, got $(fstab_entries)"
grep -q "nofail" /etc/fstab || fail "fstab entry missing nofail"
grep -q "^dnf install -y docker$" /tmp/calls || fail "did not install docker"
grep -q "^systemctl enable --now docker$" /tmp/calls || fail "did not enable docker"
ok "formats, labels and mounts a blank volume, and installs docker"

echo "# agent service"
grep -q "^HEARTH_ENV=dev$" /etc/hearth/agent.env || fail "agent.env missing HEARTH_ENV"
grep -q "^HEARTH_AGENT_URL=s3://cdk-hearthdev-assets-123456789012-us-west-2/abc_noext$" /etc/hearth/agent.env   || fail "agent.env missing HEARTH_AGENT_URL"
grep -q "^HEARTH_DATA_DIR=/srv/hearth$" /etc/hearth/agent.env || fail "agent.env missing HEARTH_DATA_DIR"
[ -x /usr/local/bin/hearth-bootstrap ] || fail "bootstrap not executable"
bash -n /usr/local/bin/hearth-bootstrap || fail "bootstrap has a syntax error"
grep -q 'exec /opt/hearth/bin/hearth-agent' /usr/local/bin/hearth-bootstrap || fail "bootstrap doesn't exec the agent"
unit=/etc/systemd/system/hearth-agent.service
grep -q "^RequiresMountsFor=/srv/hearth$" "$unit" || fail "unit not tied to the data volume"
grep -q "^After=docker.service" "$unit" || fail "unit not ordered after docker"
grep -q "^EnvironmentFile=/etc/hearth/agent.env$" "$unit" || fail "unit doesn't load agent.env"
grep -q "^systemctl enable --now --no-block hearth-agent.service$" /tmp/calls || fail "agent service not enabled"
# systemd must accept the unit (docker.service is a stand-in; the real one comes with the docker package).
printf '[Service]
ExecStart=/bin/true
' > /etc/systemd/system/docker.service
if ! verify=$(SYSTEMD_LOG_LEVEL=warning systemd-analyze verify "$unit" 2>&1) || [ -n "$verify" ]; then
  echo "$verify"
  fail "systemd-analyze rejected the unit"
fi
ok "writes agent.env, the bootstrap and the systemd unit, and enables the service"

echo "# run again with the world mounted"
echo "world" > "$MOUNT/level.dat"
run_script
grep -q "not formatting" /tmp/out || fail "did not report skipping format"
[ "$(cat "$MOUNT/level.dat")" = world ] || fail "world file lost"
[ "$(fstab_entries)" = 1 ] || fail "fstab entry duplicated"
ok "second run keeps the data and does not duplicate fstab"

echo "# reboot"
umount "$MOUNT"
mount -a
mountpoint -q "$MOUNT" || fail "fstab did not mount the volume"
[ "$(cat "$MOUNT/level.dat")" = world ] || fail "world file lost after remount"
ok "fstab entry remounts the volume"

echo "# existing world on a new instance (empty fstab)"
umount "$MOUNT"
: > /etc/fstab
run_script
grep -q "not formatting" /tmp/out || fail "reformatted an existing volume"
[ "$(cat "$MOUNT/level.dat")" = world ] || fail "world file lost"
[ "$(fstab_entries)" = 1 ] || fail "expected 1 fstab entry"
ok "mounts an existing xfs volume without formatting"

echo "# existing ext4 volume"
new_disk
mkfs.ext4 -q /dev/sdf
mkdir -p "$MOUNT"
mount /dev/sdf "$MOUNT"
echo "imported" > "$MOUNT/level.dat"
umount "$MOUNT"
run_script
[ "$(fstype)" = ext4 ] || fail "ext4 volume was reformatted"
[ "$(cat "$MOUNT/level.dat")" = imported ] || fail "imported world lost"
grep -q "[[:space:]]${MOUNT}[[:space:]]ext4[[:space:]]" /etc/fstab || fail "fstab should record ext4"
ok "keeps a non-xfs filesystem and records its type"

echo "# missing variables"
if HEARTH_AGENT_URL='' bash "$SCRIPT" > /tmp/out 2>&1; then
  fail "script ran without HEARTH_AGENT_URL"
fi
grep -q "HEARTH_AGENT_URL" /tmp/out || fail "error should name the missing variable"
ok "refuses to run without its variables"

echo "all user data tests passed"
