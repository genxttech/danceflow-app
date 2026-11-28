#!/bin/bash
# =====================================================================================================================================
# ADAPTED COPY (after review: session errors are printed on failure)
# ADAPTED COPY, not a released script and never counted as a pass of one. NOT EXECUTED.
# Source: concurrency/run_cf1_a3_locks.sh (identical in p1run6 chain tests-A and tests-B), git blob 57af360695382ee0a7b031734e3a2b89d0c29d3e.
# Exact changes: (1) this header; (2) the "cannot create a3probe" exit also prints a FAIL line (still exit 2); (3) a verdict block appended
#   after the last source line: the nine RESULT lines exactly once each, no extra RESULT line, WRITER_COMMITTED, the writer's UPDATE 1 and
#   COMMIT, p1_calc = calculated, p2_approve = approved, no ERROR/FATAL line in any session output; final PASS/FAIL line and exit code.
#   No source step, probe, sleep or fixture is changed.
# Check count: before 0 (the source asserts and prints no verdict; only the database-creation guard), after 15.
# Must sit in the tests' concurrency/ directory: it reads ../test_T_competition_cf1_a3_results.sql.
# =====================================================================================================================================
# CF1 A3, gate U61 (lock probe): two real sessions against a throwaway database cloned from the QA Postgres that already has A3 applied.
#   phase 1  session 1 runs calculate on r1 and holds its transaction open; session 2 probes row locks (entries FOR SHARE, round FOR UPDATE)
#   phase 2  session 1 runs approve on r3 and holds; session 2 probes (entries FOR SHARE, heat locked by the certification loop, round FOR UPDATE)
#   phase 3  an entry writer holds an entry (NO KEY UPDATE) and commits "ineligible" while calculate on r2 waits for it: no deadlock, and the
#            roster check (a separate statement after the lock) sees the committed change and refuses
# Usage: CONTAINER=cf1-a3-db bash run_cf1_a3_locks.sh   (needs the shared DB slot; LOCAL QA database only, never a hosted project)
set -u
export MSYS_NO_PATHCONV=1   # Git Bash on Windows must not rewrite the container paths below
C="${CONTAINER:-cf1-a3-db}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUITE="$HERE/../test_T_competition_cf1_a3_results.sql"
W="$(mktemp -d)"
PS() { docker exec -i "$C" psql -h 127.0.0.1 -U supabase_admin "$@"; }

PS -d postgres -qc "drop database if exists a3probe" >/dev/null 2>&1
# CREATE DATABASE needs the template idle: the only other sessions are extension workers (pg_net, pg_cron); stop them and retry until it works.
for i in $(seq 1 40); do
  # terminate the extension workers and CREATE DATABASE in ONE psql session (they respawn between separate sessions)
  PS -d postgres -qAt -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()" -c "create database a3probe template postgres" >/dev/null 2>&1 && break
  sleep 1   # template must be idle (extension workers respawn); retry for up to ~40s
done
PS -d postgres -qAtc "select 1 from pg_database where datname = 'a3probe'" | grep -q 1 || { echo "cannot create a3probe"; echo "CF1 A3 LOCKS CONCURRENCY FAIL: cannot create a3probe"; exit 2; }

# Session 1 script = suite fixtures (up to section 1), committed, then the three phases.
N=$(grep -n '^-- 1\. U79' "$SUITE" | head -1 | cut -d: -f1)
{
  head -n $((N - 2)) "$SUITE" | sed 's/ on commit drop//'
  echo "commit;"
  cat <<'EOS'
\set ON_ERROR_STOP off
begin; select pg_temp.as_user(pg_temp.u('000001')); select pg_temp.calc(3); reset role; commit;
\echo PHASE1
begin; select pg_temp.as_user(pg_temp.u('000001')); select (pg_temp.calc(1) ->> 'status') as p1_calc; reset role;
\! touch /tmp/a3_p1_ready
select pg_sleep(8);
commit;
\echo PHASE2
begin; select pg_temp.as_user(pg_temp.u('000002')); select (pg_temp.approve(3, 1) ->> 'status') as p2_approve; reset role;
\! touch /tmp/a3_p2_ready
select pg_sleep(8);
commit;
\echo PHASE3
\! touch /tmp/a3_p3_start
select pg_sleep(1.5);
begin; select pg_temp.as_user(pg_temp.u('000001'));
do $$ begin perform pg_temp.calc(2); raise notice 'RESULT p3_calc=COMPLETED_OK'; exception when others then raise notice 'RESULT p3_calc=ERROR % %', sqlstate, left(sqlerrm, 60); end $$;
rollback;
\echo DONE
EOS
} > "$W/s1.sql"

probe() { # name, sql-statement-returning-nothing (runs under lock_timeout 1500ms)
  cat <<EOS
do \$\$ begin perform set_config('lock_timeout', '1500ms', true);
  begin $2 raise notice 'RESULT $1=NOT_BLOCKED';
  exception when lock_not_available then raise notice 'RESULT $1=BLOCKED'; end;
end \$\$;
EOS
}
E() { echo "00000000-0000-0000-0000-cf1a30$1"; }
{
  echo "\set ON_ERROR_STOP off"
  probe p1_entry_for_update_ranking_set      "perform 1 from public.event_competition_entries where id = '$(E 080101)' for update;"
  probe p1_entry_for_key_share               "perform 1 from public.event_competition_entries where id = '$(E 080101)' for key share;"
  probe p1_entry_for_update_other_round      "perform 1 from public.event_competition_entries where id = '$(E 080401)' for update;"
  probe p1_round_for_update                  "perform 1 from public.event_competition_rounds where id = '$(E 060100)' for update;"
} > "$W/p1.sql"
{
  echo "\set ON_ERROR_STOP off"
  probe p2_entry_for_update_ranking_set      "perform 1 from public.event_competition_entries where id = '$(E 080301)' for update;"
  probe p2_entry_for_key_share               "perform 1 from public.event_competition_entries where id = '$(E 080301)' for key share;"
  probe p2_heat_for_update_certified         "perform 1 from public.event_competition_heats where id = '$(E 0d0300)' for update;"
  probe p2_round_for_update                  "perform 1 from public.event_competition_rounds where id = '$(E 060300)' for update;"
} > "$W/p2.sql"
cat > "$W/p3.sql" <<EOS
\set ON_ERROR_STOP off
begin;
update public.event_competition_entries set eligibility_status = 'ineligible' where id = '$(E 080201)';
select pg_sleep(4);
commit;
\echo WRITER_COMMITTED
EOS

docker exec "$C" rm -f /tmp/a3_p1_ready /tmp/a3_p2_ready /tmp/a3_p3_start
WW="$W"; command -v cygpath >/dev/null && WW="$(cygpath -w "$W")"
for f in s1 p1 p2 p3; do docker cp "$WW/$f.sql" "$C:/tmp/a3_$f.sql" >/dev/null; done
waitrun() { docker exec "$C" sh -c "i=0; while [ ! -f /tmp/$1 ] && [ \$i -lt 600 ]; do sleep 0.3; i=\$((i+1)); done; psql -h 127.0.0.1 -U supabase_admin -d a3probe -f /tmp/$2" > "$W/$3.out" 2>&1; }
waitrun a3_p1_ready a3_p1.sql p1 & P1=$!
waitrun a3_p2_ready a3_p2.sql p2 & P2=$!
waitrun a3_p3_start a3_p3.sql p3 & P3=$!
docker exec "$C" psql -h 127.0.0.1 -U supabase_admin -d a3probe -f /tmp/a3_s1.sql > "$W/s1.out" 2>&1
wait $P1 $P2 $P3
grep -hE "RESULT|WRITER" "$W"/p1.out "$W"/p2.out "$W"/p3.out "$W"/s1.out | sed 's/^.*NOTICE:  //'
grep -E "p1_calc|p2_approve|^PHASE|DONE" "$W/s1.out" | head
PS -d postgres -qc "drop database if exists a3probe" >/dev/null
echo "outputs kept in $W"

# ------------------------------------------------------------- verdict (added in this copy; the steps above are the source's)
CHECKS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then CHECKS=$((CHECKS+1)); else FAILS="$FAILS; $1"; fi; }
R=$(grep -h "RESULT" "$W"/p1.out "$W"/p2.out "$W"/p3.out "$W"/s1.out | sed 's/^.*NOTICE:  //' | tr -d '\r')
for e in \
  "RESULT p1_entry_for_update_ranking_set=BLOCKED" \
  "RESULT p1_entry_for_key_share=NOT_BLOCKED" \
  "RESULT p1_entry_for_update_other_round=NOT_BLOCKED" \
  "RESULT p1_round_for_update=BLOCKED" \
  "RESULT p2_entry_for_update_ranking_set=BLOCKED" \
  "RESULT p2_entry_for_key_share=NOT_BLOCKED" \
  "RESULT p2_heat_for_update_certified=BLOCKED" \
  "RESULT p2_round_for_update=BLOCKED" \
  "RESULT p3_calc=ERROR P0001 COMP_ROSTER_ENTRY_UNAVAILABLE: 1 couple(s) in the ranking se"; do
  ok "expected exactly once: $e" $([ "$(printf '%s\n' "$R" | grep -cxF "$e")" = "1" ] && echo 1 || echo 0)
done
ok "exactly 9 RESULT lines, none extra" $([ "$(printf '%s\n' "$R" | grep -c .)" = "9" ] && echo 1 || echo 0)
ok "p3 writer script reached WRITER_COMMITTED" $(grep -qx 'WRITER_COMMITTED' "$W/p3.out" && echo 1 || echo 0)
ok "p3 writer updated one entry and committed" $(grep -qx 'UPDATE 1' "$W/p3.out" && grep -qx 'COMMIT' "$W/p3.out" && echo 1 || echo 0)
# value printed under a one-column psql header in session 1 (header, dashes, value)
col() { awk -v h="$1" '{ t = $0; gsub(/^[ \t]+|[ \t\r]+$/, "", t) } f == 2 { print t; exit } f == 1 { f = 2; next } t == h { f = 1 }' "$W/s1.out"; }
ok "p1_calc succeeded (calculated)" $([ "$(col p1_calc)" = "calculated" ] && echo 1 || echo 0)
ok "p2_approve succeeded (approved)" $([ "$(col p2_approve)" = "approved" ] && echo 1 || echo 0)
ok "no ERROR line in any session output" $([ -s "$W/s1.out" ] && ! grep -qE '^(psql:[^ ]* )?(ERROR|FATAL):' "$W/s1.out" "$W/p1.out" "$W/p2.out" "$W/p3.out" && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "CF1 A3 LOCKS CONCURRENCY PASS ($CHECKS checks)"; exit 0; fi
# the cause must reach the race log (the runner decides on a clearance-seeded rerun from the error codes it finds there)
grep -hE '(ERROR|FATAL):' "$W"/*.out 2>/dev/null | head -5
echo "CF1 A3 LOCKS CONCURRENCY FAIL:$FAILS"; exit 1
