#!/bin/bash
# Deletes agent releases nobody can need any more. A release is kept if it is:
#   - what any channel (canary, stable) in any environment points at now,
#   - one of a channel's previous KEEP_PREVIOUS releases (rollback targets), or
#   - one of the newest KEEP_NEWEST releases (recent builds still worth promoting).
# Deleted releases stay recoverable for 30 days (the bucket is versioned). Agents built before they
# joined platform releases also had a GitHub Release (agent-<version>); it's removed too; tags are kept.
#
#   BUCKET=hearth-agent-releases-<account> scripts/prune-agent-releases.sh [--dry-run]
#
# Needs the AWS CLI and jq; removes GitHub Releases when gh and GH_TOKEN are available.
set -euo pipefail

: "${BUCKET:?}"
KEEP_NEWEST=${KEEP_NEWEST:-5}
KEEP_PREVIOUS=${KEEP_PREVIOUS:-2}
ENVIRONMENTS=${ENVIRONMENTS:-dev stage prod}
CHANNELS="canary stable"
BINARY=hearth-agent-linux-arm64
dry_run=false
[ "${1:-}" = --dry-run ] && dry_run=true

# Every release, oldest first by upload time.
all=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix agent/ \
  --query "Contents[?ends_with(Key, '/$BINARY')].[LastModified,Key]" --output text |
  grep -v '^None' | sort | cut -f2 | sed -E "s#^agent/(.*)/$BINARY\$#\1#" || true)
[ -n "$all" ] || { echo "No releases in $BUCKET."; exit 0; }

keep=$(tail -n "$KEEP_NEWEST" <<<"$all")

# Each channel's current release and the KEEP_PREVIOUS distinct ones before it.
for env in $ENVIRONMENTS; do
  for channel in $CHANNELS; do
    name="/hearth/$env/agent/$channel"
    if ! history=$(aws ssm get-parameter-history --name "$name" --query 'Parameters[].Value' --output text 2>&1); then
      if grep -q ParameterNotFound <<<"$history"; then
        continue # this channel has never been set
      fi
      # Without the history we can't know what's in use: delete nothing.
      echo "error: couldn't read $name: $history" >&2
      exit 1
    fi
    versions=$(tr '\t' '\n' <<<"$history" | jq -r '.version' | tac | awk '!seen[$0]++' | head -n "$((KEEP_PREVIOUS + 1))")
    keep=$(printf '%s\n%s' "$keep" "$versions")
  done
done
keep=$(sort -u <<<"$keep" | grep -v '^$')

prune=$(comm -23 <(sort <<<"$all") <(echo "$keep") || true)
echo "Releases: $(wc -l <<<"$all" | tr -d ' ') total, keeping $(comm -12 <(sort <<<"$all") <(echo "$keep") | wc -l | tr -d ' ')."
if [ -z "$prune" ]; then
  echo "Nothing to prune."
  exit 0
fi

while read -r version; do
  if $dry_run; then
    echo "would prune $version"
    continue
  fi
  echo "pruning $version"
  aws s3 rm --only-show-errors --recursive "s3://$BUCKET/agent/$version/"
  if [ -n "${GH_TOKEN:-}" ] && command -v gh >/dev/null; then
    gh release delete "agent-$version" --yes >/dev/null 2>&1 || echo "  (no GitHub Release agent-$version to remove)"
  fi
done <<<"$prune"
