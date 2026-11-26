#!/usr/bin/env bash
# Option D STANDALONE local run: the composed Competition base chain (as scripts/qa/comp-s5-integrated-run.sh: release/website-embeds competition files
# plus JC1/U18/U18-S from release/competition-cf1-app-candidate) plus ONLY 20270301170000. LOCAL ONLY: one disposable container from cf1host:found, no
# network, no published port; never a hosted database. FIFO rules 7-8: the caller creates its ticket first; the lock is taken only when that ticket is
# the oldest and the lock is free; only a lock taken here is removed; the ticket is removed when the job ends, whatever the result, so a failed or blocked run never holds up the queue.
#
#   bash scripts/qa/comp-d/run-d-standalone.sh <ticket-file> <out-dir> [wait-minutes]
#
#   baseline : the D suite and race script (expected to FAIL: the gap), and the existing suites (attribution)
#   forward  : apply D; D suite and races must PASS; every existing suite that passed on the baseline must still pass
#   rollback : rollback (no compd object left), rollback replay, re-apply, D suite again
set -uo pipefail
export MSYS_NO_PATHCONV=1
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; WAIT_MIN="${3:-45}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
LIVE=origin/release/website-embeds; CAND=origin/release/competition-cf1-app-candidate
M=src/lib/supabase/migrations; IMAGE=cf1host:found; NAME="df-compd-$$"
MIG=20270301170000_competition_d_published_order_write_guard.sql
mkdir -p "$OUT"; CHAIN="$OUT/chain"; rm -rf "$CHAIN"; mkdir -p "$CHAIN/base" "$CHAIN/new" "$CHAIN/rollback" "$CHAIN/sql-tests/fixtures"; rm -f "$OUT/result.txt"
: > "$OUT/runner.log"; : > "$OUT/suites.tsv"; BAD=0
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"; }
trap cleanup EXIT
cd "$REPO" || exit 4

for f in $(git ls-tree --name-only "$LIVE" "$M/" | grep -E "/[0-9]{14}_.*competition.*\.sql$"); do git show "$LIVE:$f" > "$CHAIN/base/$(basename "$f")"; done
for n in 20270215092000_competition_jc1_inactive_judge_absent 20270215093000_competition_u18_heat_entry_status_guard 20270215094000_competition_u18s_heat_entry_scratch_audit; do git show "$CAND:$M/$n.sql" > "$CHAIN/base/$n.sql"; done
( cd "$CHAIN/base" && sha256sum *.sql ) > "$OUT/migrations-base.sha256"; sha256sum "$OUT/migrations-base.sha256" | cut -d' ' -f1 > "$OUT/base-fingerprint.txt"
git show "HEAD:$M/$MIG" > "$CHAIN/new/$MIG"; git show "HEAD:$M/rollback/${MIG%.sql}_rollback.sql" > "$CHAIN/rollback/${MIG%.sql}_rollback.sql"
D_SUITE=test_T_competition_d_published_order_write_guard
SUITES="test_T_competition_o1_day_of test_T_phase10d_floor_schedule test_T_phase10d1_heat_entry_eligibility test_T_competition_f2_results test_T_competition_cf1_a3_results test_T_competition_cf1_f3_publication test_T_competition_cf1_a0_tie_policy test_T_competition_cf1_a4_minimum_integration test_T_competition_cf1_a5_exclusion test_T_competition_cf1_a6_withdrawal test_T_competition_hl1_heat_guards test_T_competition_ns1_no_show test_T_competition_cf1_callback_final_advancement"
git show "HEAD:$M/sql-tests/$D_SUITE.sql" > "$CHAIN/sql-tests/$D_SUITE.sql"
git show "HEAD:$M/sql-tests/probe_D_planted_heat.sql" > "$CHAIN/sql-tests/probe_D_planted_heat.sql"
# the revision under which the planted-heat finding was made (before the fix)
PREFIX=02cf1c73d; mkdir -p "$CHAIN/prefix"; git show "$PREFIX:$M/$MIG" > "$CHAIN/prefix/$MIG"
FOUND=""
for s in $SUITES; do if git cat-file -e "HEAD:$M/sql-tests/$s.sql" 2>/dev/null; then git show "HEAD:$M/sql-tests/$s.sql" > "$CHAIN/sql-tests/$s.sql"; FOUND="$FOUND $s"; else log "BLOCKED: suite not in this tree: $s"; echo BLOCKED > "$OUT/result.txt"; exit 4; fi; done
SUITES="$FOUND"
git show "HEAD:$M/sql-tests/fixtures/competition_round_ready.sql" > "$CHAIN/sql-tests/fixtures/competition_round_ready.sql"
git show "HEAD:$M/sql-tests/concurrency/run_d_publish_race.sh" > "$CHAIN/races.sh"
for f in "$CHAIN"/base/*.sql "$CHAIN/prefix/$MIG" "$CHAIN/new/$MIG" "$CHAIN/rollback/${MIG%.sql}_rollback.sql" "$CHAIN"/sql-tests/*.sql "$CHAIN/races.sh"; do
  [ -s "$f" ] || { log "BLOCKED: composed file is empty or missing: $f"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
done
log "HEAD $(git rev-parse HEAD); live $(git rev-parse "$LIVE"); candidate $(git rev-parse "$CAND"); base files $(wc -l < "$OUT/migrations-base.sha256"), base fingerprint $(cat "$OUT/base-fingerprint.txt"); migration sha256 $(sha256sum "$CHAIN/new/$MIG" | cut -d' ' -f1); suites:$SUITES"

deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available within ${WAIT_MIN} min (oldest: $oldest)"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
  sleep 30
done
printf 'session: r11-correction-migration (Option D)\njob: local Postgres (%s) base chain + Option D, suites, races, rollback\nstart: %s\nexpected minutes: 35\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken"

start_db() { docker rm -f -v "$NAME" >/dev/null 2>&1; docker run -d --name "$NAME" --label df.compd=1 --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" > /dev/null || return 1
  for i in $(seq 1 90); do "${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
apply() { if "${PSQL[@]}" -1 < "$1" > "$OUT/$2-$(basename "$1").log" 2>&1; then return 0; else log "APPLY FAILED ($2) $(basename "$1"): $(grep -m2 -E 'ERROR|FATAL' "$OUT/$2-$(basename "$1").log")"; return 1; fi; }
base_chain() { local n=0 f v; for f in $(ls "$CHAIN/base" | sort); do v="${f%%_*}"; case "$v" in 20270103090000|20270103091000) ;; *) [ "$v" \> "20270119090000" ] || continue ;; esac; apply "$CHAIN/base/$f" base || return 1; n=$((n+1)); done; log "base chain: $n applied"; }
check() { if [ "$2" = "$3" ]; then log "PASS  $1 ($2)"; else log "FAIL  $1 (got '$2', expected '$3')"; BAD=$((BAD+1)); fi; }
run_suite() { local f="$CHAIN/sql-tests/$2.sql" pre=() line res
  grep -q 'pg_temp\.compo1_fixture_' "$f" && pre+=("$CHAIN/sql-tests/fixtures/competition_round_ready.sql")
  cat ${pre[@]+"${pre[@]}"} "$f" | tr -d '\r' | timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/suite-$1-$2.log" 2>&1
  line="$(grep -E "ERROR:  .*SUITE (PASS|FAIL)" "$OUT/suite-$1-$2.log" | head -1 | sed 's/^.*ERROR:  //' | cut -c1-400)"
  [ -n "$line" ] || line="NO VERDICT: $(grep -m1 ERROR "$OUT/suite-$1-$2.log" | cut -c1-300)"
  case "$line" in *"SUITE PASS"*) res=PASS;; *) res=FAIL;; esac
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$res" "$line" >> "$OUT/suites.tsv"; log "[$1] ${2#test_T_}: $res  $(echo "$line" | cut -c1-260)"; }
races() { local r res; tr -d '\r' < "$CHAIN/races.sh" > "$CHAIN/races.run.sh"; r="$(timeout 300 bash "$CHAIN/races.run.sh" "$NAME" 2>&1 | tee "$OUT/races-$1.log" | grep -E "D RACES (PASS|FAIL)" | head -1 | cut -c1-400)"
  [ -n "$r" ] || r="NO VERDICT"; case "$r" in *"RACES PASS"*) res=PASS;; *) res=FAIL;; esac
  printf '%s\t%s\t%s\t%s\n' "$1" races "$res" "$r" >> "$OUT/suites.tsv"; log "[$1] races: $res  $r"; }
res_of() { awk -F'\t' -v t="$1" -v s="$2" '$1==t && $2==s {print $3}' "$OUT/suites.tsv" | head -1; }
objs() { "${PSQL[@]}" -Atc "select (select count(*) from pg_trigger where tgname like 'zz_compd_%' and not tgisinternal) || '/' || (select count(*) from pg_proc where proname like 'compd\_guard\_%')" | tr -d '\r'; }

probe() { local l; tr -d '\r' < "$CHAIN/sql-tests/probe_D_planted_heat.sql" | timeout 300 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/probe-$1.log" 2>&1
  l="$(grep -m1 -E "ERROR:  D PROBE:" "$OUT/probe-$1.log" | sed 's/^.*ERROR:  //')"; [ -n "$l" ] || l="NO VERDICT: $(grep -m1 ERROR "$OUT/probe-$1.log" | cut -c1-300)"
  log "[probe $1] $l"; echo "$l" > "$OUT/probe-$1.txt"; }
verdict() { sed -E 's/^D PROBE: (NOT REPRODUCED|REPRODUCED).*/\1/' "$OUT/probe-$1.txt"; }
start_db || { log "BLOCKED: database not ready"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
base_chain || { echo BLOCKED > "$OUT/result.txt"; exit 4; }
apply "$CHAIN/prefix/$MIG" prefix || { echo BLOCKED > "$OUT/result.txt"; exit 4; }
probe before-fix
check "planted heat reproduces on the revision before the fix" "$(verdict before-fix)" "REPRODUCED"
# a planted heat already inside a published order: the fixed migration must refuse to apply
start_db && base_chain || { log "BLOCKED: could not rebuild"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
{ sed -n '/^begin;$/,/^set session_replication_role = origin;$/p' "$CHAIN/sql-tests/$D_SUITE.sql" | tr -d '\r'; echo "commit;"; } | "${PSQL[@]}" > "$OUT/preflight-fixtures.log" 2>&1 || log "INFO: preflight fixtures did not load: $(grep -m1 ERROR "$OUT/preflight-fixtures.log")"
if "${PSQL[@]}" -1 < "$CHAIN/new/$MIG" > "$OUT/preflight.log" 2>&1; then PF=applied; elif grep -q "D preflight: a heat already sits" "$OUT/preflight.log"; then PF=refused; else PF=other; fi
check "apply preflight refuses an already planted published order" "$PF" "refused"
start_db && base_chain || { log "BLOCKED: could not rebuild"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
for s in $D_SUITE $SUITES; do run_suite baseline "$s"; done
races baseline          # commits fixtures: the database is rebuilt afterwards
start_db && base_chain || { log "BLOCKED: could not rebuild"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
apply "$CHAIN/new/$MIG" forward || { echo FAIL > "$OUT/result.txt"; exit 1; }
check "forward: objects installed (triggers/functions)" "$(objs)" "2/2"
probe after-fix
check "planted heat does not reproduce with the fix" "$(verdict after-fix)" "NOT REPRODUCED"
check "with the fix the plant step itself is refused by D" "$(grep -c -E '1\. plant a heat[^|]*-> refused: COMPD_PUBLISHED_ORDER_WRITE_REFUSED' "$OUT/probe-after-fix.txt")" 1
for s in $D_SUITE $SUITES; do run_suite forward "$s"; done
check "baseline: the D suite ran and fails on the gap checks" "$(awk -F'\t' -v s="$D_SUITE" '$1=="baseline" && $2==s && $4 ~ /SUITE FAIL/ {print "FAIL-with-verdict"}' "$OUT/suites.tsv") $(grep -c 'SUITE FAIL.*D: move a never-run published heat to another round' "$OUT/suite-baseline-$D_SUITE.log")" "FAIL-with-verdict 1"
check "every suite produced a verdict" "$(awk -F'\t' '$2!="races" && $4 !~ /SUITE (PASS|FAIL)/' "$OUT/suites.tsv" | wc -l | tr -d ' ')" 0
check "forward: the D suite passes" "$(res_of forward $D_SUITE)" PASS
for s in $SUITES; do if [ "$(res_of baseline "$s")" = PASS ]; then check "no regression: ${s#test_T_}" "$(res_of forward "$s")" PASS; else log "NOT COVERED (already failing on the base chain): ${s#test_T_}"; fi; done
apply "$CHAIN/rollback/${MIG%.sql}_rollback.sql" rollback || BAD=$((BAD+1)); check "rollback: no D object left" "$(objs)" "0/0"
apply "$CHAIN/rollback/${MIG%.sql}_rollback.sql" rollback2 || BAD=$((BAD+1)); check "rollback replay" "$(objs)" "0/0"
apply "$CHAIN/new/$MIG" reapply || BAD=$((BAD+1)); check "re-apply" "$(objs)" "2/2"
run_suite reapply "$D_SUITE"; check "re-apply: the D suite passes" "$(res_of reapply $D_SUITE)" PASS
races forward
check "forward: races pass" "$(res_of forward races)" PASS
check "baseline: races reproduce the gap (R1, R2 and R3 not refused)" "$(grep -m1 'D RACES FAIL' "$OUT/races-baseline.log" | grep -o 'R[123][^;]*: refused' | wc -l | tr -d ' ')" 3

# The informational PR 865 lifecycle races of earlier revisions are not part of this job (they hit their time limit; PR 865 is outside D).
if [ "$BAD" = 0 ]; then log "D STANDALONE: PASS"; echo PASS > "$OUT/result.txt"; exit 0; fi
log "D STANDALONE: FAIL ($BAD expectation(s) not met)"; echo FAIL > "$OUT/result.txt"; exit 1
