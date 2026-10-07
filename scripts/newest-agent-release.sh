#!/bin/bash
# Prints the newest agent release in the releases bucket as a channel value,
# {"version":"2026.10.07-3f2a9c1","sha256":"…"}, or nothing when there is none.
#
#   BUCKET=hearth-agent-releases-<account> scripts/newest-agent-release.sh
#
# Needs the AWS CLI and jq.
set -euo pipefail

: "${BUCKET:?}"
BINARY=hearth-agent-linux-arm64

version=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix agent/ \
  --query "Contents[?ends_with(Key, '/$BINARY')].[LastModified,Key]" --output text |
  grep -v '^None' | sort | tail -n 1 | cut -f2 | sed -E "s#^agent/(.*)/$BINARY\$#\1#" || true)
[ -n "$version" ] || exit 0

sha=$(aws s3 cp "s3://$BUCKET/agent/$version/$BINARY.sha256" -)
jq -nc --arg v "$version" --arg s "$sha" '{version: $v, sha256: $s}'
