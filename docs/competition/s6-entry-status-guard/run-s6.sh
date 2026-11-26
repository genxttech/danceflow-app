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
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('change_competition_entry_lifecycle', 'cf1_s6_guard_entry_status', '_r2_withdraw_entry', '_r2_apply_participation') order by 1;
select 'trg|' || g.tgname || '|' || g.tgenabled::text || '|' || pg_get_triggerdef(g.oid) from pg_trigger g where g.tgrelid = 'public.event_competition_entries'::regclass and not g.tgisinternal order by 1;
select 'acl|' || coalesce(c.relacl::text, 'NULL') from pg_class c where c.oid = 'public.event_competition_entries'::regclass;
select 'priv|' || r || '|' || string_agg(p, ',' order by p) from unnest(array['anon','authenticated','service_role']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p
  where has_table_privilege(r, 'public.event_competition_entries', p) group by r order by 1;
SQL
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-P0-before-S6.txt"

TSV="$OUT/suites.tsv"
runsuite(){ # $1 name [$2 directory]
  local s="$1" d="${2:-$M/sql-tests}"
  [ -f "$d/$s.sql" ] || { printf '%s\tMISSING\t\n' "$s" >> "$TSV"; return; }
  timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 < "$d/$s.sql" > "$OUT/suite-$(basename "$TSV" .tsv)-$s.log" 2>&1
  local line res; line="$(grep -E "SUITE (PASS|FAIL)|PASS \(|FAIL" "$OUT/suite-$(basename "$TSV" .tsv)-$s.log" | tail -1 | cut -c1-500)"
  case "$line" in *PASS*) res=PASS;; *) res=FAIL;; esac
  printf '%s\t%s\t%s\n' "$s" "$res" "$line" >> "$TSV"; log "$(basename "$TSV" .tsv) $s: $res"
}
# PR 867 evidence: the chain at this point is exactly the PR 867 migration set (live line + JC1 / U18 / U18-S; no S6 file applied yet), and the SQL suites in this tree
# are run from the PR 867 head commit (the S6 stage uses the adapted U18-S copy; the pinned original is not modified).
TSV="$OUT/suites-pr867.tsv"; : > "$TSV"
PR867_REF=6dc6b2d4e5657f27754c9dfc62e977f642ecb04c; mkdir -p "$OUT/pr867-sql-tests"
for s in ${PR867_SUITES:-test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_competition_jc1_inactive_judge_absent test_T_competition_cf1_callback_final_advancement test_T_competition_cf1_a5_exclusion test_T_competition_cf1_a6_withdrawal test_T_competition_hl1_heat_guards test_T_competition_f2_results}; do ( cd "$REPO" && git show "$PR867_REF:src/lib/supabase/migrations/sql-tests/$s.sql" ) > "$OUT/pr867-sql-tests/$s.sql"; runsuite "$s" "$OUT/pr867-sql-tests"; done

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

# rollback proof: back to exactly the pre-S6 state
"${PSQL[@]}" -1 < "$M/rollback/20270301141000_competition_s6_entry_status_write_guard_rollback.sql" > "$OUT/rb-141000.log" 2>&1; echo "rollback 141000 rc=$?" >> "$OUT/migrations-applied.txt"
"${PSQL[@]}" -1 < "$M/rollback/20270301140000_competition_s6_entry_lifecycle_definer_rollback.sql" > "$OUT/rb-140000.log" 2>&1; echo "rollback 140000 rc=$?" >> "$OUT/migrations-applied.txt"
"${PSQL[@]}" -At < "$OUT/state.sql" > "$OUT/state-P1-after-rollback.txt"
if grep -q '^trg|' "$OUT/state-P0-before-S6.txt" && grep -q '^acl|' "$OUT/state-P0-before-S6.txt" && grep -q '^priv|' "$OUT/state-P0-before-S6.txt" && grep -q '^trg|cf1_s6' "$OUT/state-P2-after-140000-141000.txt" && diff -u "$OUT/state-P0-before-S6.txt" "$OUT/state-P1-after-rollback.txt" > "$OUT/rollback-diff.txt"; then log "rollback proof: PASS (catalog state identical to pre-S6, $(wc -l < "$OUT/state-P0-before-S6.txt") lines)"; echo PASS > "$OUT/rollback-result.txt"; else log "rollback proof: FAIL (see rollback-diff.txt)"; echo FAIL > "$OUT/rollback-result.txt"; fi
# forward again, then the S6 suite once more
apply "$M/20270301140000_competition_s6_entry_lifecycle_definer.sql"; apply "$M/20270301141000_competition_s6_entry_status_write_guard.sql"
TSV="$OUT/suite-s6-after-reapply.tsv"; : > "$TSV"; runsuite test_T_competition_s6_entry_status_guard
FAILS=0
grep -q '^FAIL' "$OUT/migrations-applied.txt" && FAILS=$((FAILS+1))
grep -Eq 'rc=[1-9]' "$OUT/migrations-applied.txt" && FAILS=$((FAILS+1))
for tsv in suites.tsv suites-pr867.tsv suite-s6-after-reapply.tsv; do n=$(awk -F'\t' '$2!="PASS"' "$OUT/$tsv" | wc -l); [ "$n" -gt 0 ] && { log "$tsv: $n suite(s) not PASS"; FAILS=$((FAILS+1)); }; done
grep -q 'S6 CONCURRENCY PASS' "$OUT/concurrency.log" || FAILS=$((FAILS+1))
[ "$(cat "$OUT/rollback-result.txt" 2>/dev/null)" = PASS ] || FAILS=$((FAILS+1))
log "done"; if [ "$FAILS" = 0 ]; then echo PASS > "$OUT/result.txt"; else echo "NOT-ALL-PASS ($FAILS groups)" > "$OUT/result.txt"; exit 1; fi
