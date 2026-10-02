#!/bin/bash
# Tests scripts/prune-agent-releases.sh against stub aws and gh commands. Needs bash and jq.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script="$here/../prune-agent-releases.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/fix"
export FIX="$work/fix" BUCKET=test-bucket GH_TOKEN=x PATH="$work/bin:$PATH"

cat > "$work/bin/aws" <<'STUB'
#!/bin/bash
case "$1 $2" in
  "s3api list-objects-v2") cat "$FIX/objects" ;;
  "ssm get-parameter-history")
    while [ "$1" != --name ]; do shift; done
    file="$FIX/history$(tr / _ <<<"$2")"
    if [ -n "${FAIL_HISTORY:-}" ]; then echo "An error occurred (AccessDeniedException)" >&2; exit 254; fi
    if [ ! -f "$file" ]; then echo "An error occurred (ParameterNotFound)" >&2; exit 254; fi
    cat "$file" ;;
  "s3 rm") echo "s3 rm ${*: -1}" >> "$FIX/calls" ;;
esac
STUB
cat > "$work/bin/gh" <<'STUB'
#!/bin/bash
echo "gh $*" >> "$FIX/calls"
STUB
chmod +x "$work/bin/aws" "$work/bin/gh"

fail() { echo "not ok - $*"; exit 1; }
ok() { echo "ok - $*"; }
history() { # history <env> <channel> <version>...: oldest first, as SSM returns it
  local file="$FIX/history_hearth_$1_agent_$2"; shift 2
  local values=()
  for v in "$@"; do values+=("{\"version\":\"$v\",\"sha256\":\"x\"}"); done
  (IFS=$'\t'; echo "${values[*]}") > "$file"
}
reset() {
  rm -f "$FIX"/history_* "$FIX/calls"; : > "$FIX/calls"
  # Twelve releases, v01 oldest. Listed out of order: the script must sort by upload time.
  for i in 07 01 12 03 02 05 04 06 09 08 11 10; do
    printf '2026-09-%sT00:00:00+00:00\tagent/v%s/hearth-agent-linux-arm64\n' "$i" "$i"
  done > "$FIX/objects"
}
pruned() { grep '^s3 rm' "$FIX/calls" | sed -E 's#.*/agent/(.*)/#\1#' | sort | tr '\n' ' ' | sed 's/ $//'; }

echo "# keeps what's in use, recent rollbacks and the newest releases"
reset
history dev canary v12
history dev stable v01 v02 v03 v04   # current v04; previous two v03, v02; v01 is three back
history prod stable v05 v05 v06      # promoted twice: v05 still counts once
bash "$script" > "$work/out"
[ "$(pruned)" = "v01 v07" ] || fail "pruned '$(pruned)', want 'v01 v07'"
grep -q "^gh release delete agent-v01 --yes" "$FIX/calls" || fail "should remove the GitHub Release too"
grep -q "12 total, keeping 10" "$work/out" || fail "summary: $(cat "$work/out")"
ok "prunes only releases that are neither in use, a recent rollback, nor among the newest 5"

echo "# dry run"
reset
history dev stable v12
bash "$script" --dry-run > "$work/out"
[ ! -s "$FIX/calls" ] || fail "a dry run must not delete: $(cat "$FIX/calls")"
grep -q "would prune v01" "$work/out" || fail "dry run should list what it would prune"
ok "a dry run deletes nothing"

echo "# no channels set yet"
reset
bash "$script" > "$work/out"
[ "$(pruned)" = "v01 v02 v03 v04 v05 v06 v07" ] || fail "with no channels, keep only the newest 5; pruned '$(pruned)'"
ok "with no channels set, keeps the newest 5"

echo "# channel history can't be read"
reset
if FAIL_HISTORY=1 bash "$script" > "$work/out" 2>&1; then fail "must stop when it can't read a channel"; fi
[ ! -s "$FIX/calls" ] || fail "must not delete anything when a channel can't be read"
ok "deletes nothing if it can't tell what's in use"

echo "# empty bucket"
reset
: > "$FIX/objects"
bash "$script" > "$work/out"
grep -q "No releases" "$work/out" || fail "empty bucket: $(cat "$work/out")"
ok "does nothing on an empty bucket"

echo "all prune tests passed"
