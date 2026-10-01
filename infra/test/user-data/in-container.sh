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
# aws: records the call. `ssm get-parameter` answers with the stable channel (/tmp/stable-release);
# `s3 cp` "downloads" /tmp/first-agent to the destination (the last argument).
cat > /stubs/aws <<'STUB'
#!/bin/bash
echo "aws $*" >> /tmp/calls
case "$1 $2" in
  "ssm get-parameter") cat /tmp/stable-release ;;
  "s3 cp") cp /tmp/first-agent "${@: -1}" ;;
esac
STUB
chmod +x /stubs/aws
export PATH="/stubs:$PATH"

# GameInfraStack prepends these to the script in the launch template's user data.
export HEARTH_ENV=dev HEARTH_HOME_REGION=us-west-2 HEARTH_AGENT_BUCKET=hearth-agent-releases-123456789012

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
grep -q "^HEARTH_AGENT_BUCKET=hearth-agent-releases-123456789012$" /etc/hearth/agent.env \
  || fail "agent.env missing HEARTH_AGENT_BUCKET"
grep -q "^HEARTH_DATA_DIR=/srv/hearth$" /etc/hearth/agent.env || fail "agent.env missing HEARTH_DATA_DIR"
[ -x /usr/local/bin/hearth-bootstrap ] || fail "bootstrap not executable"
bash -n /usr/local/bin/hearth-bootstrap || fail "bootstrap has a syntax error"
# shellcheck disable=SC2016 # the literal text $agent, as written in the bootstrap
grep -q '^exec "$agent"$' /usr/local/bin/hearth-bootstrap || fail "bootstrap doesn't exec the agent"
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

echo "# bootstrap: first download, cache, updates and fallback"
# A fake agent: prints its version for -version; otherwise records that it ran and, if healthy,
# marks itself healthy the way the real agent does after reaching the API.
make_agent() { # make_agent <path> <version> <healthy: yes|no>
  cat > "$1" <<AGENT
#!/bin/bash
if [ "\${1:-}" = -version ]; then echo $2; exit 0; fi
echo $2 >> /tmp/ran
if [ $3 = yes ]; then echo $2 > /var/lib/hearth/agent-healthy; fi
AGENT
  chmod +x "$1"
}
bootstrap() { : > /tmp/calls; : > /tmp/ran; bash /usr/local/bin/hearth-bootstrap; }
# The stable channel points at /tmp/first-agent, as the release workflows write it.
publish_stable() { # publish_stable <version>
  printf '{"version":"%s","sha256":"%s"}' "$1" "$(sha256sum /tmp/first-agent | cut -d' ' -f1)" > /tmp/stable-release
}
ran() { tr '\n' ' ' < /tmp/ran | sed 's/ $//'; }
B=/opt/hearth/bin
rm -rf "$B" /var/lib/hearth

make_agent /tmp/first-agent 1.0.0 yes
publish_stable 1.0.0
bootstrap
[ "$(ran)" = 1.0.0 ] || fail "first boot should run the downloaded agent, ran '$(ran)'"
grep -q "^aws ssm get-parameter .*--name /hearth/dev/agent/stable" /tmp/calls || fail "first boot should read the stable channel"
grep -q "^aws s3 cp .*s3://hearth-agent-releases-123456789012/agent/1.0.0/hearth-agent-linux-arm64" /tmp/calls \
  || fail "first boot should download the stable release"
ok "first boot downloads the stable release, checks it and runs it"

bootstrap
[ "$(ran)" = 1.0.0 ] || fail "cached start ran '$(ran)'"
! grep -q "^aws" /tmp/calls || fail "a normal start must not download"
ok "later starts run the cached agent without downloading"

make_agent "$B/hearth-agent.next" 2.0.0 yes
bootstrap
[ "$(ran)" = 2.0.0 ] || fail "update should run the new agent, ran '$(ran)'"
[ "$("$B/hearth-agent.previous" -version)" = 1.0.0 ] || fail "the healthy old agent should be kept as previous"
[ ! -e "$B/hearth-agent.next" ] || fail "the staged update should be consumed"
ok "a staged update becomes current, keeping the old agent as last known good"

make_agent "$B/hearth-agent.next" 3.0.0 no
bootstrap; bootstrap
[ "$(ran)" = 3.0.0 ] || fail "an unhealthy agent gets $(( 2 )) tries, ran '$(ran)'"
bootstrap
[ "$(ran)" = 2.0.0 ] || fail "the third start should fall back to 2.0.0, ran '$(ran)'"
[ "$(cat /var/lib/hearth/agent-failed)" = 3.0.0 ] || fail "the failed version should be recorded"
[ "$(cat /var/lib/hearth/agent-healthy)" = 2.0.0 ] || fail "the restored agent counts as healthy"
[ "$("$B/hearth-agent.failed" -version)" = 3.0.0 ] || fail "the failed agent should be kept aside"
ok "an agent that never becomes healthy falls back to the last known good one"

rm -rf "$B" /var/lib/hearth
make_agent /tmp/first-agent 1.0.0 no
publish_stable 1.0.0
bootstrap; bootstrap; bootstrap
[ "$(ran)" = 1.0.0 ] || fail "with nothing to fall back to, keep running the only agent"
ok "with no previous agent, it keeps running the one it has"

rm -rf "$B" /var/lib/hearth
publish_stable 1.0.0
echo "tampered" >> /tmp/first-agent
if bootstrap > /tmp/out 2>&1; then
  fail "a download that fails its checksum must not run"
fi
grep -q "failed its checksum" /tmp/out || fail "should say the checksum failed"
[ ! -e "$B/hearth-agent" ] && [ -z "$(ran)" ] || fail "a bad download must not be installed or run"
ok "a first download that fails its checksum is rejected"

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
if HEARTH_AGENT_BUCKET='' bash "$SCRIPT" > /tmp/out 2>&1; then
  fail "script ran without HEARTH_AGENT_BUCKET"
fi
grep -q "HEARTH_AGENT_BUCKET" /tmp/out || fail "error should name the missing variable"
ok "refuses to run without its variables"

echo "all user data tests passed"
