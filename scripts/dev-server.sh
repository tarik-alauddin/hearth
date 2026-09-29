#!/bin/bash
# Deletes a server by hand: its instance, world volume and record. Dev only, and there's no backup:
# the world is gone. The hearth CLI does everything else; this goes when archiving arrives.
# Runs in AWS CloudShell or any shell with the AWS CLI.
#
#   scripts/dev-server.sh destroy <serverId> --yes
#
# HEARTH_ENV picks the environment (default dev); AWS_REGION defaults to us-west-2.
set -euo pipefail

ENV=${HEARTH_ENV:-dev}
export AWS_REGION=${AWS_REGION:-us-west-2}
TABLE="hearth-$ENV-Servers"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "error: $*" >&2; exit 1; }

field() {
  aws dynamodb get-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$1\"}}" \
    --consistent-read --query "Item.$2.S" --output text | sed 's/^None$//'
}

[ "${1:-}" = destroy ] || { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
id=${2:-}
[ -n "$id" ] || die "server ID required"
[ -n "$(field "$id" serverId)" ] || die "no server $id in $TABLE"
[ "${3:-}" = --yes ] || die "destroy deletes the world; rerun with: destroy $id --yes"

instance=$(field "$id" instanceId)
volume=$(field "$id" volumeId)
if [ -n "$instance" ]; then
  log "terminating $instance"
  aws ec2 terminate-instances --instance-ids "$instance" >/dev/null
  aws ec2 wait instance-terminated --instance-ids "$instance"
fi
if [ -n "$volume" ]; then
  log "deleting world volume $volume"
  aws ec2 delete-volume --volume-id "$volume"
fi
aws dynamodb delete-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$id\"}}"
log "destroyed $id"
