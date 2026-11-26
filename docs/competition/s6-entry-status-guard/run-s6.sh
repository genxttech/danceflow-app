#!/usr/bin/env bash
# S6 local runner. LOCAL ONLY: one disposable container from the committed local image, NO network, NO published port; never touches a hosted database or sb.sh.
# Heavy-job FIFO (C:\dfr\HEAVY_LOCK_RULES.md rules 7-8): the caller creates its ticket first; this script takes C:\dfr\heavy.lock only when that ticket is the OLDEST and the lock is free,
# removes only a lock it took, stops its own container by exact name and deletes the ticket when done.
#
#   bash run-s6.sh <ticket-file> <out-dir> [--wait-minutes N]
#
# Chain: image cf1host:found (hosted-equivalent baseline + Competition foundation E1..HL1), then every *competition* migration of THIS worktree (live line + the PR 867 guards + S6)
# in version order from R2 on, EXCEPT the two S6 files, which are applied in step 3 so that the rollback can be proven byte-exact against the state before them.
#   1 apply chain through U18-S           2 capture catalog state P0 (functions, ACLs, triggers, grants)
#   3 apply S6 140000 then 141000         4 run suites (S6 first)         5 concurrency script
#   6 roll back 141000 then 140000, capture P1, require P0 == P1 byte for byte    7 re-apply S6 forward and re-run the S6 suite
set -uo pipefail
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; WAIT_MIN=45
[ "${3:-}" = "--wait-minutes" ] && WAIT_MIN="${4:-45}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
M="$REPO/src/lib/supabase/migrations"
IMAGE=cf1host:found; NAME="df-s6-$$"
mkdir -p "$OUT"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0
cleanup(){ docker rm -f -v "$NAME" >/dev/null 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"; }
trap cleanup EXIT

( cd "$M" && ls | grep -E '^[0-9]{14}_.*competition.*\.sql$' | LC_ALL=C sort | xargs sha256sum ) > "$OUT/migrations.sha256"
sha256sum "$OUT/migrations.sha256" | cut -d' ' -f1 > "$OUT/migrations.fingerprint"
( cd "$REPO" && git rev-parse HEAD > "$OUT/head.txt" )
log "composed $(wc -l < "$OUT/migrations.sha256") competition migrations; fingerprint $(cat "$OUT/migrations.fingerprint"); head $(cat "$OUT/head.txt")"

deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
  sleep 60
done
printf 'session: Competition OD-31 S6 entry status guard\njob: local Postgres %s (chain + S6 + suites + rollback proof)\nstart: %s\nexpected minutes: 30\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken"
# recorded again under the lock: this is what actually runs
( cd "$M" && ls | grep -E '^[0-9]{14}_.*competition.*\.sql$' | LC_ALL=C sort | xargs sha256sum ) > "$OUT/migrations.sha256"
sha256sum "$OUT/migrations.sha256" | cut -d' ' -f1 > "$OUT/migrations.fingerprint"; ( cd "$REPO" && git rev-parse HEAD > "$OUT/head.txt"; git status --porcelain > "$OUT/tree-dirty.txt" )
log "under lock: head $(cat "$OUT/head.txt"), fingerprint $(cat "$OUT/migrations.fingerprint"), uncommitted files $(wc -l < "$OUT/tree-dirty.txt")"

docker run -d --name "$NAME" --label df.s6=1 --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" > /dev/null || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: docker run failed"; exit 4; }
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
for i in $(seq 1 60); do "${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
"${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: database not ready"; exit 4; }
docker image inspect "$IMAGE" --format '{{.Id}}' > "$OUT/image-id.txt"; "${PSQL[@]}" -Atc "select version()" > "$OUT/db-version.txt"

apply(){ # $1 file
  local f; f="$(basename "$1")"
  if "${PSQL[@]}" -1 < "$1" > "$OUT/mig-${f%%_*}.log" 2>&1; then echo "OK   $f" >> "$OUT/migrations-applied.txt"; else echo "FAIL $f" >> "$OUT/migrations-applied.txt"; log "migration FAILED: $f"; return 1; fi
}
: > "$OUT/migrations-applied.txt"
for f in $(ls "$M" | grep -E '^[0-9]{14}_.*competition.*\.sql$' | LC_ALL=C sort); do
  v="${f%%_*}"
  case "$v" in 20270301140000|20270301141000) continue ;; esac
  case "$v" in 20270103090000|20270103091000) ;; *) [ "$v" \> "20270119090000" ] || continue ;; esac
  apply "$M/$f"
done
log "chain applied: $(grep -c '^OK' "$OUT/migrations-applied.txt") ok, $(grep -c '^FAIL' "$OUT/migrations-applied.txt") failed"

cat > "$OUT/state.sql" <<'SQL'
select 'fn|' || p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, 'NULL') || '|' || coalesce(p.proconfig::text, 'NULL') || '|' || md5(replace(p.prosrc, chr(13), ''))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('change_competition_entry_lifecycle', 'cf1_s6_guard_entry_status', '_r2_withdraw_entry', '_r2_apply_participation', 'cf1_s6_guard_started_participation') order by 1;
select 'trg|' || g.tgname || '|' || g.tgenabled::text || '|' || pg_get_triggerdef(g.oid) from pg_trigger g where g.tgrelid = 'public.event_competition_entries'::regclass and not g.tgisinternal order by 1;
select 'acl|' || coalesce(c.relacl::text, 'NULL') from pg_class c where c.oid = 'public.event_competition_entries'::regclass;
select 'priv|' || r || '|' || string_agg(p, ',' order by p) from unnest(array['anon','authenticated','service_role']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p
  where has_table_privilege(r, 'public.event_competition_entries', p) group by r order by 1;
SQL
cat >> "$OUT/state.sql" <<'SQL'
select 'trg2|' || g.tgrelid::regclass || '|' || g.tgname || '|' || g.tgenabled::text from pg_trigger g where g.tgrelid in ('public.event_competition_heat_entries'::regclass, 'public.event_competition_heats'::regclass) and not g.tgisinternal order by 1;
SQL
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-P0-before-S6.txt"

TSV="$OUT/suites.tsv"
runsuite(){ # $1 name [$2 directory]
  local s="$1" d="${2:-$M/sql-tests}"
  [ -f "$d/$s.sql" ] || { printf '%s\tMISSING\t\n' "$s" >> "$TSV"; return; }
  timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 < "$d/$s.sql" > "$OUT/suite-$(basename "$TSV" .tsv)-$s.log" 2>&1
  local line res; line="$(grep -E "SUITE (PASS|FAIL)|PASS \(|FAIL" "$OUT/suite-$(basename "$TSV" .tsv)-$s.log" | tail -1 | cut -c1-500)"
  case "$line" in *"SUITE PASS ("*) res=PASS;; *) res=FAIL;; esac
  printf '%s\t%s\t%s\n' "$s" "$res" "$line" >> "$TSV"; log "$(basename "$TSV" .tsv) $s: $res"
}
# PR 867 evidence: the chain at this point is exactly the PR 867 migration set (live line + JC1 / U18 / U18-S; no S6 file applied yet), and the SQL suites in this tree
# are run from the PR 867 head commit (the S6 stage uses the adapted U18-S copy; the pinned original is not modified).
TSV="$OUT/suites-pr867.tsv"; : > "$TSV"
PR867_REF=6dc6b2d4e5657f27754c9dfc62e977f642ecb04c; mkdir -p "$OUT/pr867-sql-tests"
for s in ${PR867_SUITES:-test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_competition_jc1_inactive_judge_absent test_T_competition_cf1_callback_final_advancement test_T_competition_cf1_a5_exclusion test_T_competition_cf1_a6_withdrawal test_T_competition_hl1_heat_guards test_T_competition_f2_results}; do ( cd "$REPO" && git show "$PR867_REF:src/lib/supabase/migrations/sql-tests/$s.sql" ) > "$OUT/pr867-sql-tests/$s.sql"; runsuite "$s" "$OUT/pr867-sql-tests"; done

a5(){ # $1 label  $2 script
  CONTAINER="$NAME" DBUSER=supabase_admin timeout 600 bash "$M/sql-tests/$2" > "$OUT/a5-$1.log" 2>&1; log "a5 $1: rc=$? $(grep -E 'CONCURRENCY (PASS|FAIL)' "$OUT/a5-$1.log" | tail -1)"; }
[ -n "${A5_PRE:-}" ] && a5 original-before-S6 test_T_competition_cf1_a5_concurrency.sh

# F3 read-back BEFORE S6 (state read-back of the forged-marker chain on the pre-S6 database)
"${PSQL[@]}" -v ON_ERROR_STOP=0 < "$REPO/docs/competition/s6-entry-status-guard/f3-readback.sql" > "$OUT/f3-readback-before-S6.log" 2>&1
apply "$M/20270301140000_competition_s6_entry_lifecycle_definer.sql"; apply "$M/20270301141000_competition_s6_entry_status_write_guard.sql"
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-P2-after-140000-141000.txt"
"${PSQL[@]}" -v ON_ERROR_STOP=0 < "$REPO/docs/competition/s6-entry-status-guard/f3-readback.sql" > "$OUT/f3-readback-after-S6.log" 2>&1
cat > "$OUT/probe.sql" <<'SQL'
select 'fn:'||p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('cf1_s6_guard_entry_status','change_competition_entry_lifecycle','cf1_u18_guard_heat_entry_status','cf1_u18s_guard_heat_entry_scratch') order by 1;
SQL
"${PSQL[@]}" -At < "$OUT/probe.sql" > "$OUT/state-after.txt"

SUITES="${ONLY_SUITES:-test_T_competition_s6_entry_status_guard test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit_with_s6 test_T_competition_jc1_inactive_judge_absent test_T_competition_cf1_a5_exclusion test_T_competition_cf1_a6_withdrawal test_T_competition_cf1_a2_lock test_T_competition_hl1_heat_guards test_T_competition_f2_results test_T_competition_cf1_od17_enforcement test_T_competition_cf1_a4_minimum_integration test_T_competition_cf1_callback_final_advancement test_T_competition_r2_refund_write_gate test_T_competition_e2_ballots test_T_competition_o1_day_of test_T_phase10a_competition_foundation test_T_phase10d1_heat_entry_eligibility}"
TSV="$OUT/suites.tsv"; : > "$TSV"
for s in $SUITES; do runsuite "$s"; done

# concurrency (real second connections)
S6_OUT="$OUT" bash "$M/sql-tests/test_T_competition_s6_entry_status_concurrency.sh" "$NAME" > "$OUT/concurrency.log" 2>&1; log "concurrency: $(tail -1 "$OUT/concurrency.log")"

# A5 probes, policy-A adapted copy, with S6 (uses its own fixed fixtures: only one of the two A5 scripts can run per database, so A5_PRE and this stage are alternatives)
[ -z "${A5_PRE:-}" ] && a5 adapted-with-S6 test_T_competition_cf1_a5_concurrency_with_s6.sh

# mutation checks: a deliberately broken guard or function must make the tests FAIL, otherwise the tests prove nothing about that rule
: > "$OUT/mutants.tsv"
mutant(){ # $1 name  $2 function signature  $3 anchor text  $4 replacement  $5 test (suite|race)  $6 label of the check that must fail
  printf "drop table if exists public._s6_mut; create table public._s6_mut as select pg_get_functiondef('%s'::regprocedure) as d;\ndo \$m\$ declare d text := (select d from public._s6_mut); begin if position(\$a\$%s\$a\$ in d) = 0 then raise exception 'mutant anchor missing'; end if; execute replace(d, \$a\$%s\$a\$, \$b\$%s\$b\$); end \$m\$;\n" "$2" "$3" "$3" "$4" > "$OUT/mut-$1.sql"
  if ! "${PSQL[@]}" < "$OUT/mut-$1.sql" > "$OUT/mut-$1.log" 2>&1; then printf '%s\tNOT APPLIED\n' "$1" >> "$OUT/mutants.tsv"; return; fi
  local det=NOT-DETECTED
  if [ "$5" = race ]; then mkdir -p "$OUT/mut-$1"; S6_OUT="$OUT/mut-$1" bash "$M/sql-tests/test_T_competition_s6_entry_status_concurrency.sh" "$NAME" > "$OUT/mut-$1-test.log" 2>&1 || det=WRONG-REASON
    grep -E 'S6 CONCURRENCY FAIL:' "$OUT/mut-$1-test.log" | grep -qF "$6" && det=DETECTED
  else "${PSQL[@]}" -v ON_ERROR_STOP=0 < "$M/sql-tests/test_T_competition_s6_entry_status_guard.sql" > "$OUT/mut-$1-test.log" 2>&1; grep -q "SUITE PASS (" "$OUT/mut-$1-test.log" || det=WRONG-REASON
    grep -E 'SUITE FAIL:' "$OUT/mut-$1-test.log" | grep -qF "$6" && det=DETECTED; fi
  "${PSQL[@]}" -c "do \$r\$ begin execute (select d from public._s6_mut); end \$r\$; drop table public._s6_mut;" >> "$OUT/mut-$1.log" 2>&1 || det=RESTORE-FAILED
  printf '%s\t%s\n' "$1" "$det" >> "$OUT/mutants.tsv"; log "mutant $1: $det"
}
G='public.cf1_s6_guard_entry_status()'; L='public.change_competition_entry_lifecycle(uuid, text, text, text)'
mutant insert-link-rule "$G" "if new.registration_id is not null or new.order_id is not null or new.order_item_id is not null or new.registration_cart_id is not null then" "if false then" suite "D3c inslink"
mutant delete-status-rule "$G" "if old.status not in ('pending', 'confirmed')" "if false" suite "D4d dd_840001"
mutant delete-order-link "$G" "or old.order_id is not null " "" suite "D4d dd_840003"
mutant evidence-rule "$G" "new.scratch_reason is distinct from old.scratch_reason or " "" suite "D3d ev_scratch_reason"
mutant entry-lock "$L" "for no key update;" ";" race "evidence survived"
mutant participation-guard 'public.cf1_s6_guard_started_participation()' "or old.status in ('danced', 'disqualified') then" "and false then" suite "P4 x_del_he"
mutant heat-lock "$L" "order by h.id
  for share;" "order by h.id;" race "race 2: the RPC re-checked"
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-after-mutants.txt"
diff -q "$OUT/state-P2-after-140000-141000.txt" "$OUT/state-after-mutants.txt" >/dev/null || { log "mutants: state NOT restored"; echo "restore	NOT-DETECTED" >> "$OUT/mutants.tsv"; }

# rollback proof: back to exactly the pre-S6 state
"${PSQL[@]}" -1 < "$M/rollback/20270301141000_competition_s6_entry_status_write_guard_rollback.sql" > "$OUT/rb-141000.log" 2>&1; echo "rollback 141000 rc=$?" >> "$OUT/migrations-applied.txt"
"${PSQL[@]}" -1 < "$M/rollback/20270301140000_competition_s6_entry_lifecycle_definer_rollback.sql" > "$OUT/rb-140000.log" 2>&1; echo "rollback 140000 rc=$?" >> "$OUT/migrations-applied.txt"
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-P1-after-rollback.txt"
if grep -q '^trg|' "$OUT/state-P0-before-S6.txt" && grep -q '^acl|' "$OUT/state-P0-before-S6.txt" && grep -q '^priv|' "$OUT/state-P0-before-S6.txt" && grep -q '^trg|cf1_s6' "$OUT/state-P2-after-140000-141000.txt" && diff -u "$OUT/state-P0-before-S6.txt" "$OUT/state-P1-after-rollback.txt" > "$OUT/rollback-diff.txt"; then log "rollback proof: PASS (catalog state identical to pre-S6, $(wc -l < "$OUT/state-P0-before-S6.txt") lines)"; echo PASS > "$OUT/rollback-result.txt"; else log "rollback proof: FAIL (see rollback-diff.txt)"; echo FAIL > "$OUT/rollback-result.txt"; fi
# forward again, then the S6 suite once more
apply "$M/20270301140000_competition_s6_entry_lifecycle_definer.sql"; apply "$M/20270301141000_competition_s6_entry_status_write_guard.sql"
TSV="$OUT/suite-s6-after-reapply.tsv"; : > "$TSV"; runsuite test_T_competition_s6_entry_status_guard
# joint 877 + 878 stage (optional, SC1_DIR = the SC1 session's local DB suite folder; used as the files are, not committed here). Runs last, on the re-applied S6 chain,
# because its concurrency script disables guard triggers while seeding.
if [ -n "${SC1_DIR:-}" ]; then
  ( cd "$SC1_DIR" && sha256sum sc1_suite.sql sc1_concurrency.sh ) > "$OUT/sc1-harness.sha256"
  ( cd "$REPO" && git rev-parse origin/claude/sc1-port-live-line origin/claude/r15-s4-eligibility-clearance ) > "$OUT/sc1-heads.txt" 2>&1
  { ( cd "$REPO" && git show origin/claude/r15-s4-eligibility-clearance:src/lib/supabase/migrations/sql-tests/fixtures/r15_clear_entries.sql ); cat "$SC1_DIR/sc1_suite.sql"; } | timeout 600 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/sc1-suite.log" 2>&1
  log "sc1 suite: $(grep -E 'PASS|FAIL' "$OUT/sc1-suite.log" | grep -E '^(ERROR|NOTICE)' | tail -1 | cut -c1-300)"
  bash "$SC1_DIR/sc1_concurrency.sh" "$NAME" t > "$OUT/sc1-concurrency.log" 2>&1; log "sc1 concurrency: rc=$? $(tail -1 "$OUT/sc1-concurrency.log" | cut -c1-200)"
fi
FAILS=0
grep -q '^FAIL' "$OUT/migrations-applied.txt" && FAILS=$((FAILS+1))
grep -Eq 'rc=[1-9]' "$OUT/migrations-applied.txt" && FAILS=$((FAILS+1))
# a with-S6 failure counts as pre-existing only if the same suite failed before S6 with the identical first error line
: > "$OUT/suite-classification.tsv"
while IFS=$'\t' read -r name res rest; do
  [ "$res" = PASS ] && continue
  a="$(grep -m1 -E '^ERROR' "$OUT/suite-suites-pr867-$name.log" 2>/dev/null)"; b="$(grep -m1 -E '^ERROR' "$OUT/suite-suites-$name.log" 2>/dev/null)"
  if [ -n "$a" ] && [ "$a" = "$b" ] && grep -qP "^$name\tFAIL" "$OUT/suites-pr867.tsv"; then printf '%s\tFAIL-ALSO-WITHOUT-S6\n' "$name" >> "$OUT/suite-classification.tsv"; else printf '%s\tFAIL-NEW-OR-UNEXPLAINED\n' "$name" >> "$OUT/suite-classification.tsv"; fi
done < "$OUT/suites.tsv"
n=$(grep -c 'FAIL-NEW-OR-UNEXPLAINED' "$OUT/suite-classification.tsv"); [ "$n" -gt 0 ] && { log "suites.tsv: $n new or unexplained failure(s)"; FAILS=$((FAILS+1)); }
log "failures also present without S6: $(grep -c 'FAIL-ALSO-WITHOUT-S6' "$OUT/suite-classification.tsv")"
n=$(awk -F'\t' '$2!="PASS"' "$OUT/suite-s6-after-reapply.tsv" | wc -l); [ "$n" -gt 0 ] && { log "S6 suite after re-apply not PASS"; FAILS=$((FAILS+1)); }
grep -q 'S6 CONCURRENCY PASS' "$OUT/concurrency.log" || FAILS=$((FAILS+1))
if [ -z "${A5_PRE:-}" ]; then grep -q 'COMPETITION CF1 A5 CONCURRENCY PASS' "$OUT/a5-adapted-with-S6.log" || FAILS=$((FAILS+1)); fi
awk -F'\t' '$2!="DETECTED"' "$OUT/mutants.tsv" | grep -q . && { log "mutants not all detected"; FAILS=$((FAILS+1)); }
[ "$(cat "$OUT/rollback-result.txt" 2>/dev/null)" = PASS ] || FAILS=$((FAILS+1))
log "done"; if [ "$FAILS" = 0 ]; then echo PASS > "$OUT/result.txt"; else echo "NOT-ALL-PASS ($FAILS groups)" > "$OUT/result.txt"; exit 1; fi
