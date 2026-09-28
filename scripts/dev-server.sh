#!/bin/bash
# Creates and manages game servers by hand until M3's workflows and CLI replace this.
# Runs in AWS CloudShell or any shell with the AWS CLI and python3.
#
#   scripts/dev-server.sh create [version]    # e.g. create 1.21.4 (default)
#   scripts/dev-server.sh list
#   scripts/dev-server.sh status  <serverId>
#   scripts/dev-server.sh stop    <serverId>   # graceful: the agent saves the world
#   scripts/dev-server.sh start   <serverId>
#   scripts/dev-server.sh destroy <serverId> --yes   # deletes the instance, the world volume and the record
#
# HEARTH_ENV picks the environment (default dev); AWS_REGION defaults to us-west-2.
set -euo pipefail

ENV=${HEARTH_ENV:-dev}
export AWS_REGION=${AWS_REGION:-us-west-2}
GAME=minecraft-java
GAME_PORT=25565
TABLE="hearth-$ENV-Servers"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "error: $*" >&2; exit 1; }

python() { if command -v python3 >/dev/null; then python3 "$@"; else command python "$@"; fi; }

new_ulid() {
  python -c '
import os, time
n = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
print("".join(alphabet[(n >> (5 * i)) & 31] for i in reversed(range(26))))'
}

# field <serverId> <attribute>: one string attribute of the server record, or empty.
field() {
  aws dynamodb get-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$1\"}}" \
    --consistent-read --query "Item.$2.S" --output text | sed 's/^None$//'
}

set_status() {
  aws dynamodb update-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$1\"}}" \
    --update-expression 'SET #s = :s' --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":s\":{\"S\":\"$2\"}}"
}

require_server() {
  [ -n "${1:-}" ] || die "server ID required"
  [ -n "$(field "$1" serverId)" ] || die "no server $1 in $TABLE"
}

public_ip() {
  aws ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text | sed 's/^None$//'
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; } # same format the API writes, so strings compare by time

# wait_for_agent <serverId> <state> <since>: follows the agent's reports made after <since>
# (ignoring older ones, e.g. the "stopped" from the last shutdown) until <state> or an error.
wait_for_agent() {
  local id=$1 want=$2 since=$3 last="-" state at deadline=$((SECONDS + 900))
  while [ $SECONDS -lt $deadline ]; do
    at=$(field "$id" agentReportedAt)
    state=""
    [[ "$at" > "$since" ]] && state=$(field "$id" agentState)
    if [ "$state" != "$last" ]; then
      log "agent: ${state:-no report yet}"
      last=$state
    fi
    [ "$state" = "$want" ] && return 0
    if [ "$state" = error ]; then
      die "agent reported an error: $(field "$id" agentMessage)"
    fi
    sleep 10
  done
  die "agent didn't report $want within 15 minutes"
}

cmd_create() {
  local version=${1:-1.21.4} id subnet instance volume now
  id=$(new_ulid)
  now=$(now_iso)
  log "creating server $id ($GAME $version) in $ENV"
  aws dynamodb put-item --table-name "$TABLE" --condition-expression 'attribute_not_exists(serverId)' --item "{
    \"serverId\": {\"S\": \"$id\"}, \"ownerId\": {\"S\": \"dev-script\"}, \"game\": {\"S\": \"$GAME\"},
    \"region\": {\"S\": \"$AWS_REGION\"}, \"status\": {\"S\": \"PROVISIONING\"}, \"version\": {\"S\": \"$version\"},
    \"autoUpdate\": {\"BOOL\": false}, \"createdAt\": {\"S\": \"$now\"}}"

  subnet=$(aws ec2 describe-subnets --filters Name=tag:app,Values=hearth "Name=tag:env,Values=$ENV" \
    --query 'Subnets[0].SubnetId' --output text)
  # $Latest: CloudFormation adds a template version on every deploy but never moves the default.
  instance=$(aws ec2 run-instances --launch-template "LaunchTemplateName=hearth-$ENV-$GAME,Version=\$Latest" \
    --subnet-id "$subnet" --query 'Instances[0].InstanceId' --output text)
  log "launched $instance"
  aws ec2 create-tags --resources "$instance" --tags "Key=serverId,Value=$id" "Key=Name,Value=hearth-$ENV-$id"
  aws ec2 wait instance-running --instance-ids "$instance"
  volume=$(aws ec2 describe-volumes \
    --filters "Name=attachment.instance-id,Values=$instance" Name=attachment.device,Values=/dev/sdf \
    --query 'Volumes[0].VolumeId' --output text)
  aws ec2 create-tags --resources "$volume" --tags "Key=serverId,Value=$id"

  aws dynamodb update-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$id\"}}" \
    --update-expression 'SET instanceId = :i, volumeId = :v, #s = :s' \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":i\":{\"S\":\"$instance\"},\":v\":{\"S\":\"$volume\"},\":s\":{\"S\":\"STARTING\"}}"
  log "waiting for the agent (first start downloads the server and generates a world)"
  wait_for_agent "$id" ready "$now"
  set_status "$id" RUNNING
  log "ready. Join at $(public_ip "$instance"):$GAME_PORT   (server $id)"
}

cmd_list() {
  aws dynamodb scan --table-name "$TABLE" \
    --query 'Items[].[serverId.S, status.S, agentState.S, version.S, instanceId.S]' --output table
}

cmd_status() {
  require_server "${1:-}"
  local instance
  instance=$(field "$1" instanceId)
  echo "server:     $1"
  echo "status:     $(field "$1" status)"
  echo "agent:      $(field "$1" agentState) (version $(field "$1" agentVersion), at $(field "$1" agentReportedAt))"
  [ -n "$(field "$1" agentMessage)" ] && echo "message:    $(field "$1" agentMessage)"
  echo "instance:   $instance ($(aws ec2 describe-instances --instance-ids "$instance" \
    --query 'Reservations[0].Instances[0].State.Name' --output text))"
  local ip
  ip=$(public_ip "$instance")
  [ -n "$ip" ] && echo "join at:    $ip:$GAME_PORT"
  return 0
}

cmd_stop() {
  require_server "${1:-}"
  local instance
  instance=$(field "$1" instanceId)
  set_status "$1" STOPPING
  log "stopping $instance; the agent saves the world and stops the game during shutdown"
  aws ec2 stop-instances --instance-ids "$instance" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$instance"
  set_status "$1" STOPPED
  log "stopped. Last agent report: $(field "$1" agentState)"
}

cmd_start() {
  require_server "${1:-}"
  local instance since
  instance=$(field "$1" instanceId)
  since=$(now_iso)
  set_status "$1" STARTING
  aws ec2 start-instances --instance-ids "$instance" >/dev/null
  log "starting $instance"
  aws ec2 wait instance-running --instance-ids "$instance"
  wait_for_agent "$1" ready "$since"
  set_status "$1" RUNNING
  log "ready. Join at $(public_ip "$instance"):$GAME_PORT (the IP changes on every start)"
}

cmd_destroy() {
  require_server "${1:-}"
  [ "${2:-}" = --yes ] || die "destroy deletes the world; rerun with: destroy $1 --yes"
  local instance volume
  instance=$(field "$1" instanceId)
  volume=$(field "$1" volumeId)
  log "terminating $instance"
  aws ec2 terminate-instances --instance-ids "$instance" >/dev/null
  aws ec2 wait instance-terminated --instance-ids "$instance"
  log "deleting world volume $volume"
  aws ec2 delete-volume --volume-id "$volume"
  aws dynamodb delete-item --table-name "$TABLE" --key "{\"serverId\":{\"S\":\"$1\"}}"
  log "destroyed $1"
}

command=${1:-}
shift || true
case "$command" in
  create | list | status | stop | start | destroy) "cmd_$command" "$@" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
