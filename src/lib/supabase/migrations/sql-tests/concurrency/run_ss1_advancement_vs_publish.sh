#!/usr/bin/env bash
# Competition SS1 -- advancement_method update vs publish, with a REAL second database connection per actor.
#
# Usage: bash run_ss1_advancement_vs_publish.sh [container]   (default: ss1-db; needs 10B and 20270118090000 applied)
# Needs a superuser (supabase_admin). Fixtures COMMIT and are removed at the end, even on failure. Publish is simulated with the row
# writes publish_competition_program ends with (lock evidence row, then status + profile_locked_at on the program row).
#   A  an advancement_method update on a draft is in flight, uncommitted, when publish runs
#        -> publish WAITS, then commits; the advancement value landed BEFORE the lock
#   B  publish is in flight, uncommitted, when an advancement_method update arrives
#        -> the update WAITS, then is REFUSED (COMP_PROGRAM_ADVANCEMENT_FROZEN); the locked value is unchanged
# Prints "SS1 ADVANCEMENT CONCURRENCY PASS (<n> checks)" or "... FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-ss1-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
U() { printf '00000000-0000-0000-0000-55c1f1%06x' "$((16#$1))"; }
EV=$(U e0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
cleanup() { SU -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO';" >/dev/null 2>&1; }
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

publish_sql() { # $1 = program id
  echo "insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at) values ('$1','$EV','studio_simple',3,'{\"profile\":{\"key\":\"studio_simple\",\"version\":3}}'::jsonb, now());"
  echo "update public.event_competition_programs set status='configured', profile_locked_at=(select locked_at from public.event_competition_program_locks where program_id='$1') where id='$1';"
}
now_ms() { date +%s%3N; }
wait_for_marker() {
  local n=0
  while [ $n -lt 100 ]; do
    [ "$(SU -c "select count(*) from pg_stat_activity where state = 'active' and query like '%$1%' and query not like '%pg_stat_activity%'")" -ge 1 ] && return 0
    sleep 0.2; n=$((n+1))
  done
  return 1
}

SU <<SQL
insert into public.studios (id, name, slug) values ('$STUDIO','SS1D Studio','t-ss1d-studio');
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','SS1D Comp','t-ss1d-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, advancement_method, status, rules_profile_key, rules_profile_version)
  values ('$(U 61)','$EV','$STUDIO','P1','showcase','relative','ordinal_majority','none','draft','studio_simple',3),
         ('$(U 62)','$EV','$STUDIO','P2','showcase','relative','ordinal_majority','none','draft','studio_simple',3);
SQL

# ---------------------------------------------- Scenario A: publish waits for an in-flight advancement update
(
SU <<SQL
begin;
update public.event_competition_programs set advancement_method='promote_callback' where id='$(U 61)';
select pg_sleep(6) /* ss1d-marker-a */;
commit;
SQL
) &
A_PID=$!
wait_for_marker "ss1d-marker-a" || ok "A: holder started" 0
T0=$(now_ms)
SU <<SQL
begin;
$(publish_sql "$(U 61)")
commit;
SQL
ELAPSED=$(( $(now_ms) - T0 ))
wait $A_PID
ok "A: publish waited for the in-flight update (waited ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1000 ] && echo 1 || echo 0)"
ok "A: the advancement value landed before the lock" "$([ "$(SU -c "select advancement_method from public.event_competition_programs where id='$(U 61)'")" = "promote_callback" ] && echo 1 || echo 0)"
ok "A: the program is locked" "$([ "$(SU -c "select (profile_locked_at is not null) from public.event_competition_programs where id='$(U 61)'")" = "t" ] && echo 1 || echo 0)"

# ---------------------------------------------- Scenario B: an update waits for an in-flight publish, then is refused
(
SU <<SQL
begin;
$(publish_sql "$(U 62)")
select pg_sleep(6) /* ss1d-marker-b */;
commit;
SQL
) &
B_PID=$!
wait_for_marker "ss1d-marker-b" || ok "B: holder started" 0
T0=$(now_ms)
OUT=$(SU 2>&1 <<SQL
update public.event_competition_programs set advancement_method='promote_callback' where id='$(U 62)';
SQL
)
ELAPSED=$(( $(now_ms) - T0 ))
wait $B_PID
ok "B: the update waited for the in-flight publish (waited ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1000 ] && echo 1 || echo 0)"
ok "B: the update was refused (COMP_PROGRAM_ADVANCEMENT_FROZEN)" "$(printf '%s' "$OUT" | grep -q COMP_PROGRAM_ADVANCEMENT_FROZEN && echo 1 || echo 0)"
ok "B: the locked value is unchanged" "$([ "$(SU -c "select advancement_method from public.event_competition_programs where id='$(U 62)'")" = "none" ] && echo 1 || echo 0)"

if [ -z "$FAILS" ]; then echo "SS1 ADVANCEMENT CONCURRENCY PASS ($PASS checks)"; else echo "SS1 ADVANCEMENT CONCURRENCY FAIL:$FAILS"; exit 1; fi
