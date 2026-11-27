#!/usr/bin/env bash
# Bring the P1 local full stack up, check it and take it down, under the FIFO heavy lock. Local only. Removes only its own lock, ticket and stack.
# Exit 0 only when up, check and down all succeed and no container is left.
#   bash run-stack-verify.sh <repo-worktree> <ticket-file> <out-dir> <pins-file> [wait-minutes]
set -uo pipefail
REPO="${1:?repo}"; TICKET="${2:?ticket}"; OUT="${3:?out}"; PINS="${4:?pins}"; WAIT_MIN="${5:-600}"
HERE="$(cd "$(dirname "$0")" && pwd)"; LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue; mkdir -p "$OUT"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0; UP=0
cleanup(){ [ "$UP" = 1 ] && node "$HERE/p1-stack.mjs" down --repo "$REPO" >> "$OUT/down.log" 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"; }
trap cleanup EXIT
[ -f "$PINS" ] || { log "BLOCKED: pins file $PINS not found"; exit 4; }
deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  [ -f "$TICKET" ] || { log "BLOCKED: ticket vanished"; exit 4; }
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available (oldest: $oldest)"; exit 4; }
  sleep 60
done
printf 'session: comp-sc1 (P1 walkthrough stack)\njob: disposable local full stack up / check / down (docker)\nstart: %s\nexpected minutes: 25\n' "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken; head $(git -C "$REPO" rev-parse --short HEAD); pins $PINS"
# A stack that already exists is not ours to remove: `up` refuses it, and `down` must not run.
if [ -n "$(docker ps -aq --filter label=df.p1walk=1)" ]; then log "BLOCKED: a P1 walkthrough stack already exists; left untouched"; exit 4; fi
UP=1; check_rc=skipped
node "$HERE/p1-stack.mjs" up --repo "$REPO" --pins "$PINS" --env-out "$OUT/env" > "$OUT/up.log" 2>&1; up_rc=$?; log "up exit $up_rc"
if [ "$up_rc" = 0 ]; then
  node "$HERE/p1-stack.mjs" check --repo "$REPO" --pins "$PINS" --env-out "$OUT/env" > "$OUT/check.log" 2>&1; check_rc=$?; log "check exit $check_rc"
  tee -a "$OUT/runner.log" < "$OUT/check.log"
else tail -40 "$OUT/up.log" | tee -a "$OUT/runner.log"; fi
node "$HERE/p1-stack.mjs" down --repo "$REPO" > "$OUT/down.log" 2>&1; down_rc=$?; log "down exit $down_rc"; UP=0
left="$(docker ps -a --filter label=df.p1walk=1 --format '{{.Names}}')"; [ -n "$left" ] && log "containers left: $left"
if [ "$up_rc" = 0 ] && [ "$check_rc" = 0 ] && [ "$down_rc" = 0 ] && [ -z "$left" ]; then log "RESULT PASS"; exit 0; fi
log "RESULT FAIL (up $up_rc, check $check_rc, down $down_rc)"; exit 1
