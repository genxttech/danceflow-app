#!/usr/bin/env bash
# R-11 STANDALONE local run: the composed Competition base chain (same composition and fingerprint as scripts/qa/comp-s5-integrated-run.sh, PR 863)
# plus ONLY 20270301090000 (PR 865). LOCAL ONLY: one disposable container from the committed local image cf1host:found, NO network, NO published port.
# Never touches a hosted database, sb.sh, Stripe, Twilio or another session's container. FIFO rules (C:\dfr\HEAVY_LOCK_RULES.md 7-8): the caller creates
# its ticket first; the lock is taken only when that ticket is the OLDEST and the lock is free; only a lock taken here is removed, with the ticket.
#
#   bash scripts/qa/r11/run-r11-standalone.sh <ticket-file> <out-dir> [wait-minutes]
#
# Migrations and suites come from git objects: base = origin/release/website-embeds competition files + JC1/U18/U18-S from
# origin/release/competition-cf1-app-candidate; the R-11 migration, rollback and suites = HEAD of this worktree.
#   baseline : suites on the base chain (attribution: the R-11 suite is EXPECTED to fail here)
#   forward  : apply R-11, suites again; a suite that passed on the baseline must still pass; then the cancel-and-recreate probe (observation)
#   rollback : rollback (md5 + ACL = base), rollback replay, suites f2 / a3 / pv1 again
#   reapply  : apply again, replay (no-op), R-11 suite and f2 again
# Exit codes: 0 all R-11 expectations met; 1 an expectation failed; 4 BLOCKED (nothing is reported as passed when it did not run).
set -uo pipefail
export MSYS_NO_PATHCONV=1
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; WAIT_MIN="${3:-45}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
LIVE=origin/release/website-embeds; CAND=origin/release/competition-cf1-app-candidate
M=src/lib/supabase/migrations
IMAGE=cf1host:found
NAME="df-r11sa-$$"
MIG=20270301090000_competition_r11_approval_override_scope.sql
PRE=3cf63c3bb00a78142ea2c8e70a8b4a0c
mkdir -p "$OUT"; CHAIN="$OUT/chain"; rm -rf "$CHAIN"; mkdir -p "$CHAIN/base" "$CHAIN/new" "$CHAIN/rollback" "$CHAIN/sql-tests/fixtures"; rm -f "$OUT/result.txt" "$OUT/probe-forward.txt"
: > "$OUT/runner.log"; BAD=0
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0
# The ticket is deleted only when the whole job passed (rule 8: a multi-step job keeps one ticket until it is done); on anything else the lock is
# released and the ticket stays so the corrected job can run next. Delete it by hand when giving up.
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; if [ "$(cat "$OUT/result.txt" 2>/dev/null)" = PASS ]; then rm -f "$TICKET"; fi; }
trap cleanup EXIT
cd "$REPO" || exit 4

# 1. compose
for f in $(git ls-tree --name-only "$LIVE" "$M/" | grep -E "/[0-9]{14}_.*competition.*\.sql$"); do git show "$LIVE:$f" > "$CHAIN/base/$(basename "$f")"; done
for n in 20270215092000_competition_jc1_inactive_judge_absent 20270215093000_competition_u18_heat_entry_status_guard 20270215094000_competition_u18s_heat_entry_scratch_audit; do git show "$CAND:$M/$n.sql" > "$CHAIN/base/$n.sql"; done
( cd "$CHAIN/base" && sha256sum *.sql ) > "$OUT/migrations-base.sha256"
sha256sum "$OUT/migrations-base.sha256" | cut -d' ' -f1 > "$OUT/base-fingerprint.txt"
git show "HEAD:$M/$MIG" > "$CHAIN/new/$MIG"
git show "HEAD:$M/rollback/${MIG%.sql}_rollback.sql" > "$CHAIN/rollback/${MIG%.sql}_rollback.sql"
SUITES="test_T_competition_r11_approval_override_scope test_T_competition_f2_results test_T_competition_cf1_a3_results test_T_competition_pv1_recompute test_T_competition_cf1_f3_publication test_T_competition_cf1_a5_exclusion test_T_competition_cf1_a4_minimum_integration test_T_competition_cf1_a6_withdrawal"
for s in $SUITES; do git show "HEAD:$M/sql-tests/$s.sql" > "$CHAIN/sql-tests/$s.sql" || { log "BLOCKED: suite $s missing at HEAD"; exit 4; }; done
git show "HEAD:$M/sql-tests/fixtures/competition_round_ready.sql" > "$CHAIN/sql-tests/fixtures/competition_round_ready.sql" 2>/dev/null
git show "HEAD:$M/sql-tests/concurrency/run_f2_races.sh" > "$CHAIN/run_f2_races.sh"
git show "HEAD:$M/sql-tests/probe_R_competition_r11_cancel_recreate.sql" > "$CHAIN/probe.sql" || { log "BLOCKED: probe missing at HEAD"; exit 4; }
for f in "$CHAIN"/base/*.sql "$CHAIN/new/$MIG" "$CHAIN/rollback/${MIG%.sql}_rollback.sql" "$CHAIN"/sql-tests/*.sql "$CHAIN/probe.sql" "$CHAIN/run_f2_races.sh"; do
  [ -s "$f" ] || { log "BLOCKED: composed file is empty or missing: $f"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
done
HEADSHA=$(git rev-parse HEAD); POST=$(grep -o "v_post constant text := '[0-9a-f]*'" "$CHAIN/new/$MIG" | grep -o "[0-9a-f]\{32\}")
log "HEAD $HEADSHA; live $(git rev-parse "$LIVE"); candidate $(git rev-parse "$CAND"); base files $(wc -l < "$OUT/migrations-base.sha256"), base fingerprint $(cat "$OUT/base-fingerprint.txt"); migration sha256 $(sha256sum "$CHAIN/new/$MIG" | cut -d' ' -f1); pins pre=$PRE post=$POST"

# 2. FIFO
deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"; echo BLOCKED > "$OUT/result.txt"; trap - EXIT; exit 4; }
  sleep 30
done
printf 'session: r11-correction-migration (PR 865)\njob: local Postgres (%s) standalone base chain + R-11 only, suites, rollback, re-apply\nstart: %s\nexpected minutes: 30\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken"

# 3. database
docker run -d --name "$NAME" --label df.r11sa=1 --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" > /dev/null || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: docker run failed"; exit 4; }
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
for i in $(seq 1 90); do "${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
"${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: database not ready"; exit 4; }
log "image $(docker image inspect "$IMAGE" --format '{{.Id}}'); $("${PSQL[@]}" -Atc 'select version()' | tr -d '\r' | cut -c1-40)"
q() { "${PSQL[@]}" -Atc "$1" 2>&1 | tr -d '\r'; }
amd5() { q "select md5(replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), chr(13), ''))"; }
acl() { q "select p.proowner::regrole || ' ' || coalesce(p.proacl::text,'null') || ' ' || p.prosecdef || ' ' || coalesce(p.proconfig::text,'null') from pg_proc p where p.oid = 'public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure"; }
check() { if [ "$2" = "$3" ]; then log "PASS  $1 ($2)"; else log "FAIL  $1 (got '$2', expected '$3')"; BAD=$((BAD+1)); fi; }
apply() { if "${PSQL[@]}" -1 < "$1" > "$OUT/$2-$(basename "$1").log" 2>&1; then return 0; else log "APPLY FAILED ($2) $(basename "$1"): $(grep -m2 -E 'ERROR|FATAL' "$OUT/$2-$(basename "$1").log")"; return 1; fi; }

OK=0; FAILED=0
for f in $(ls "$CHAIN/base" | sort); do
  v="${f%%_*}"
  case "$v" in 20270103090000|20270103091000) ;; *) [ "$v" \> "20270119090000" ] || continue ;; esac
  if apply "$CHAIN/base/$f" base; then OK=$((OK+1)); else FAILED=$((FAILED+1)); fi
done
log "base chain: $OK applied, $FAILED failed"; [ "$FAILED" = 0 ] || { echo BLOCKED > "$OUT/result.txt"; exit 4; }

run_suite() { # <tag> <suite>
  local f="$CHAIN/sql-tests/$2.sql" pre=()
  grep -q 'pg_temp\.compo1_fixture_' "$f" && pre+=("$CHAIN/sql-tests/fixtures/competition_round_ready.sql")
  cat ${pre[@]+"${pre[@]}"} "$f" | sed 's/\r$//' | timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/suite-$1-$2.log" 2>&1
  local line; line="$(grep -E "ERROR:  COMPETITION .*SUITE (PASS|FAIL)" "$OUT/suite-$1-$2.log" | head -1 | sed 's/^.*ERROR:  //' | cut -c1-400)"
  [ -n "$line" ] || line="NO VERDICT: $(grep -m1 ERROR "$OUT/suite-$1-$2.log" | cut -c1-300)"
  case "$line" in *"SUITE PASS"*) RES=PASS;; *) RES=FAIL;; esac
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$RES" "$line" >> "$OUT/suites.tsv"; log "[$1] ${2#test_T_}: $RES  $(echo "$line" | cut -c1-220)"
}
races() { # <tag>
  local r; r="$(sed 's/\r$//' "$CHAIN/run_f2_races.sh" > "$CHAIN/races.sh"; timeout 600 bash "$CHAIN/races.sh" "$NAME" 2>&1 | tee "$OUT/races-$1.log" | grep -E "F2 RACES (PASS|FAIL)" | head -1 | cut -c1-400)"
  [ -n "$r" ] || r="NO VERDICT: $(grep -m1 ERROR "$OUT/races-$1.log" | cut -c1-300)"
  case "$r" in *"RACES PASS"*) RES=PASS;; *) RES=FAIL;; esac
  printf '%s\t%s\t%s\t%s\n' "$1" run_f2_races "$RES" "$r" >> "$OUT/suites.tsv"; log "[$1] run_f2_races: $RES  $(echo "$r" | cut -c1-220)"
}
res_of() { awk -F'\t' -v t="$1" -v s="$2" '$1==t && $2==s {print $3}' "$OUT/suites.tsv" | head -1; }
: > "$OUT/suites.tsv"

check "pre: approve md5 on the base chain = pre pin" "$(amd5)" "$PRE"
ACL0="$(acl)"; log "ACL before: $ACL0"
for s in $SUITES; do run_suite baseline "$s"; done
races baseline

apply "$CHAIN/new/$MIG" forward || { echo FAIL > "$OUT/result.txt"; exit 1; }
check "forward: approve md5 = post pin" "$(amd5)" "$POST"
check "forward: owner / ACL / definer / search_path unchanged" "$(acl)" "$ACL0"
for s in $SUITES; do run_suite forward "$s"; done
races forward
# observation only (no pass/fail expectation): what the cancel-and-recreate path allows after the migration
tr -d '\r' < "$CHAIN/probe.sql" | timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/probe-forward.log" 2>&1
PL="$(grep -m1 "CANCEL-RECREATE PROBE" "$OUT/probe-forward.log")"
if [ -n "$PL" ]; then
  echo "${PL#*PROBE: }" | awk '{ gsub(/ \|\| /, "\n"); print }' > "$OUT/probe-forward.txt"
  log "PROBE (observation):"; cat "$OUT/probe-forward.txt" >> "$OUT/runner.log"; cat "$OUT/probe-forward.txt"
else log "PROBE: NO VERDICT: $(grep -m1 ERROR "$OUT/probe-forward.log" | cut -c1-300)"; BAD=$((BAD+1)); fi
check "forward: the R-11 suite passes" "$(res_of forward test_T_competition_r11_approval_override_scope)" PASS
check "baseline: the R-11 suite ran to its verdict, failed, and the failures name the blockers" "$(awk -F'	' '$1=="baseline" && $2=="test_T_competition_r11_approval_override_scope" && $4 ~ /SUITE FAIL/ {print "FAIL-with-verdict"}' "$OUT/suites.tsv") $(grep -c "RB-11" "$OUT/suite-baseline-test_T_competition_r11_approval_override_scope.log" | awk '{print ($1>0)?"RB-11":"no-RB-11"}')" "FAIL-with-verdict RB-11"
check "every SQL suite produced a verdict (baseline and forward)" "$(awk -F'	' '($1=="baseline"||$1=="forward") && $2!="run_f2_races" && $4 !~ /SUITE (PASS|FAIL)/' "$OUT/suites.tsv" | wc -l | tr -d ' ')" 0
for s in test_T_competition_cf1_a3_results test_T_competition_pv1_recompute; do check "forward: ${s#test_T_} passes" "$(res_of forward "$s")" PASS; done
check "the probe completed routes NC, CS, CA and R" "$(grep -cE '^.(NC|CS|CA|R). RESULT' "$OUT/probe-forward.txt" 2>/dev/null)" 4
for s in $SUITES run_f2_races; do
  [ "$(res_of baseline "$s")" = PASS ] && check "no regression: ${s#test_T_} passed on the base chain and still passes" "$(res_of forward "$s")" PASS
done

apply "$CHAIN/new/$MIG" replay || BAD=$((BAD+1)); check "replay: no-op" "$(amd5)" "$POST"
apply "$CHAIN/rollback/${MIG%.sql}_rollback.sql" rollback || BAD=$((BAD+1))
check "rollback: approve md5 = pre pin" "$(amd5)" "$PRE"; check "rollback: ACL = base" "$(acl)" "$ACL0"
apply "$CHAIN/rollback/${MIG%.sql}_rollback.sql" rollback2 || BAD=$((BAD+1)); check "rollback replay: no-op" "$(amd5)" "$PRE"
for s in test_T_competition_f2_results test_T_competition_cf1_a3_results test_T_competition_pv1_recompute; do run_suite rolledback "$s"; check "rolled back: ${s#test_T_} same verdict as baseline" "$(res_of rolledback "$s")" "$(res_of baseline "$s")"; done
apply "$CHAIN/new/$MIG" reapply || BAD=$((BAD+1)); check "re-apply: approve md5 = post pin" "$(amd5)" "$POST"; check "re-apply: ACL = base" "$(acl)" "$ACL0"
for s in test_T_competition_r11_approval_override_scope test_T_competition_f2_results; do run_suite reapply "$s"; done
check "re-apply: the R-11 suite passes" "$(res_of reapply test_T_competition_r11_approval_override_scope)" PASS

if [ "$BAD" = 0 ]; then log "R-11 STANDALONE: PASS (every expectation met; see per-suite verdicts, including any that fail on the baseline too)"; echo PASS > "$OUT/result.txt"; exit 0; fi
log "R-11 STANDALONE: FAIL ($BAD expectation(s) not met)"; echo FAIL > "$OUT/result.txt"; exit 1
