#!/bin/bash
# Runs inside the container started by run.sh.
set -euo pipefail

SCRIPT=/work/game-instance.sh
MOUNT=/srv/hearth
LOOP=

dnf install -y -q xfsprogs e2fsprogs util-linux grep >/dev/null

# dnf and systemctl need a real instance; stub them and record their calls.
mkdir -p /stubs
for cmd in dnf systemctl; do
  printf '#!/bin/bash\necho "%s $*" >> /tmp/calls\n' "$cmd" > "/stubs/$cmd"
  chmod +x "/stubs/$cmd"
done
export PATH="/stubs:$PATH"

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

echo "all user data tests passed"
