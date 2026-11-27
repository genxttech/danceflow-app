#!/usr/bin/env bash
# Short run of the R-11 route probe alone, to obtain the control verdicts the first composed run did not give.
# Reuses the migrations an earlier comp-p1-integrated-run.sh composed (<chain-dir> = its out dir; its heads.txt says which heads). LOCAL ONLY: disposable
# containers from cf1host:found, no network. FIFO rules 7-8 as the full runner; only what this run created is removed.
#
#   bash scripts/qa/p1/comp-p1-replay-only.sh <ticket-file> <out-dir> <composed-out-dir> [wait-minutes] [hold-minutes]
#
# ONLY_BASE=1 runs chain A alone (no snapshots, same bounded hold on an inconclusive A verdict).
# A base chain, B + corrections, C + restriction; the probe after each. If a B or C verdict is INCONCLUSIVE (a probe defect), the lock and the databases are
# held for at most <hold-minutes> so the probe can be corrected against them; creating <out-dir>/release ends the hold. Everything is removed at the end.
set -uo pipefail
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; SRC="${3:?composed out dir}"; WAIT_MIN="${4:-2880}"; HOLD_MIN="${5:-25}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; HERE="$REPO/scripts/qa/p1"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)" || exit 3
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue; IMAGE=cf1host:found; RUN_ID="$$-$(date +%s)"; NAME="df-p1rp-$RUN_ID"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
blocked(){ log "BLOCKED: $*"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
TOOK=0
cleanup(){
  for c in $(docker ps -aq --filter "label=df.p1int=$RUN_ID" 2>/dev/null); do docker rm -f -v "$c" >/dev/null 2>&1; done
  for p in a b; do docker rmi -f "df-p1rp-snap-$RUN_ID-$p" >/dev/null 2>&1; done
  [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"
  log "cleaned up"
}
trap cleanup EXIT
rm -f "$OUT/ready" "$OUT/release" "$OUT/result.txt"
CHAIN="$SRC/chain"
ls "$CHAIN"/base/*.sql "$CHAIN"/new/*.sql "$CHAIN"/p1/*.sql >/dev/null 2>&1 || blocked "no composed chain in $SRC"
cp "$SRC/heads.txt" "$OUT/heads.txt"; ( cd "$CHAIN" && sha256sum base/*.sql new/*.sql p1/*.sql ) > "$OUT/migrations.sha256"

deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && blocked "lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"
  sleep 60
done
printf 'session: od02-s5 P1 route replay\njob: local Postgres (%s): route probe on three chains, then at most %s min held for probe corrections\nstart: %s\nexpected minutes: %s\n' "$NAME" "$HOLD_MIN" "$(date -u +%FT%TZ)" "$((HOLD_MIN+10))" > "$LOCK/owner.txt"
log "lock taken"

export MSYS_NO_PATHCONV=1
wait_db(){ for i in $(seq 1 90); do docker exec -e PGPASSWORD=postgres "$1" psql -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
docker run -d --pull=never --name "$NAME" --label "df.p1int=$RUN_ID" --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null && wait_db "$NAME" || blocked "database not ready"
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
: > "$OUT/steps.txt"
apply(){ if "${PSQL[@]}" -1 < "$1" > "$OUT/$2-$(basename "$1").log" 2>&1; then echo "OK   $2 $(basename "$1")" >> "$OUT/steps.txt"; else echo "FAIL $2 $(basename "$1")" >> "$OUT/steps.txt"; blocked "$2 $(basename "$1") did not apply: $(grep -m1 -E 'ERROR|FATAL' "$OUT/$2-$(basename "$1").log")"; fi; }
snapshot(){ "${PSQL[@]}" -c checkpoint >/dev/null 2>&1; docker commit "$NAME" "df-p1rp-snap-$RUN_ID-$1" >/dev/null && wait_db "$NAME" || log "snapshot $1 failed"; }
probe(){ # <phase>
  cp "$HERE/probe_p1_r11_routes.sql" "$OUT/probe-used-$1.sql"
  tr -d '\r' < "$OUT/probe-used-$1.sql" | timeout 600 "${PSQL[@]}" -At -v ON_ERROR_STOP=0 > "$OUT/bypass-$1.log" 2>&1
  { grep -E '^VERDICT[ -]' "$OUT/bypass-$1.log" || echo "NO VERDICT: $(grep -m1 -E 'ERROR|FATAL' "$OUT/bypass-$1.log")"; grep -q '^P1R11 PROBE COMPLETE' "$OUT/bypass-$1.log" || echo "PROBE INCOMPLETE"; } > "$OUT/bypass-$1.txt"
  log "[$1] reached $(grep -c ': REACHED' "$OUT/bypass-$1.txt"), not reached $(grep -c ': NOT REACHED' "$OUT/bypass-$1.txt"), closed at setup $(grep -c ': CLOSED AT SETUP' "$OUT/bypass-$1.txt"), inconclusive $(grep -c ': INCONCLUSIVE' "$OUT/bypass-$1.txt")"
}
for f in $(ls "$CHAIN/base" | sort); do v="${f%%_*}"; case "$v" in 20270103090000|20270103091000) ;; *) [[ "$v" > "20270119090000" ]] || continue ;; esac; apply "$CHAIN/base/$f" A; done
probe A
if [ "${ONLY_BASE:-0}" = 1 ]; then
  echo "$NAME $RUN_ID" > "$OUT/ready"
  if grep -qE 'INCONCLUSIVE|NO VERDICT|PROBE INCOMPLETE' "$OUT/bypass-A.txt"; then
    log "held for probe corrections (up to ${HOLD_MIN} min)"; end=$(( $(date +%s) + HOLD_MIN*60 ))
    while [ ! -f "$OUT/release" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 10; done
  fi
  echo DONE > "$OUT/result.txt"; exit 0
fi
snapshot a
for f in $(ls "$CHAIN/new" | sort); do apply "$CHAIN/new/$f" B; done
snapshot b; probe B
for f in $(ls "$CHAIN/p1" | sort); do apply "$CHAIN/p1/$f" C; done
probe C
echo "$NAME $RUN_ID" > "$OUT/ready"
if grep -qE 'INCONCLUSIVE|NO VERDICT|PROBE INCOMPLETE' "$OUT/bypass-B.txt" "$OUT/bypass-C.txt"; then
  log "held for probe corrections (up to ${HOLD_MIN} min)"
  end=$(( $(date +%s) + HOLD_MIN*60 ))
  while [ ! -f "$OUT/release" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 10; done
fi
echo DONE > "$OUT/result.txt"
