#!/usr/bin/env bash
# Competition SS1 -- configure vs publish, with a REAL second database connection per actor.
#
# Usage: bash run_ss1_configure_vs_publish.sh [container]   (default: ss1-db; the DB must have 10B, REG and 20270116090000 applied)
# Needs a superuser (supabase_admin). Fixtures COMMIT (a second connection cannot see an open transaction) and are removed by
# deleting the event at the end, even on failure. The "publish" actor performs exactly the writes publish_competition_program ends
# with (lock evidence row, then status + profile_locked_at on the program row), which is the row the guard trigger locks.
#   A  the real configure RPC is in flight, uncommitted, when publish runs
#        -> publish WAITS, then commits; the configure landed BEFORE the lock and the pin records it
#   B  publish is in flight, uncommitted, when the configure RPC arrives
#        -> the configure WAITS, then is REFUSED (COMP_METHOD_LOCKED); the locked round keeps its published values
#   C  a direct column write after the lock is refused by the trigger (COMP_ROUND_SCORING_LOCKED)
# (publish is simulated by the row writes publish_competition_program ends with; the real function takes the same row lock.)
# Prints "SS1 CONCURRENCY PASS (<n> checks)" or "SS1 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-ss1-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
U() { printf '00000000-0000-0000-0000-55c1f0%06x' "$((16#$1))"; }
MGR=$(U a0); EV=$(U e0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
cleanup() { SU -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.profiles where id::text like '00000000-0000-0000-0000-55c1f0%'; delete from auth.users where id::text like '00000000-0000-0000-0000-55c1f0%';" >/dev/null 2>&1; }
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

setup_program() { # $1 = digit: program 6$1, contest 7$1, division 8$1, round 9$1
  local i=$1
  SU <<SQL
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, rules_profile_key, rules_profile_version)
  values ('$(U 6$i)','$EV','$STUDIO','P$i','showcase','relative','ordinal_majority','draft','studio_simple',1);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 7$i)','$EV','$(U 6$i)','C$i','single_dance','couple','open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$(U 8$i)','$EV','$(U 6$i)','$(U 7$i)','D$i','draft');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
  values ('$(U 9$i)','$EV','$(U 6$i)','$(U 8$i)','Final','final',1,'custom');
SQL
}
publish_sql() { # $1 = program id
  echo "insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at) values ('$1','$EV','studio_simple',1,'{\"profile\":{\"key\":\"studio_simple\",\"version\":1}}'::jsonb, now());"
  echo "update public.event_competition_programs set status='configured', profile_locked_at=(select locked_at from public.event_competition_program_locks where program_id='$1') where id='$1';"
}
as_mgr() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$MGR','role','authenticated')::text, false);"; }
now_ms() { date +%s%3N; }

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-ss1c-mgr@example.test');
insert into public.profiles (id, email, full_name) values ('$MGR','t-ss1c-mgr@example.test','SS1C Mgr');
insert into public.studios (id, name, slug) values ('$STUDIO','SS1C Studio','t-ss1c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','SS1C Comp','t-ss1c-e','competition', current_date+30, current_date+30,'published','public',true);
SQL
setup_program 1
setup_program 2

# The configure actor calls the REAL apply_competition_scoring_setup RPC (one transaction, program row FOR SHARE) and then holds
# the transaction open. Timing is detected by polling pg_stat_activity (no fixed sleeps): we wait until the holder is inside its
# pg_sleep before starting the other actor.
ops_for() { # $1 = round id
  echo "jsonb_build_array(jsonb_build_object('op','update_round','round_id','$1','patch',jsonb_build_object('scoring_method','ordinal_majority','sequence_number',2)))"
}
wait_for_marker() { # $1 = marker text in a sleeping query
  local n=0
  while [ $n -lt 100 ]; do
    [ "$(SU -c "select count(*) from pg_stat_activity where state = 'active' and query like '%$1%' and query not like '%pg_stat_activity%'")" -ge 1 ] && return 0
    sleep 0.2; n=$((n+1))
  done
  return 1
}

# ---------------------------------------------- Scenario A: publish waits for an in-flight configure
(
SU <<SQL
begin;
$(as_mgr)
select public.apply_competition_scoring_setup('$(U 61)', $(ops_for "$(U 91)"));
select pg_sleep(6) /* ss1-marker-a */;
commit;
SQL
) &
A_PID=$!
wait_for_marker "ss1-marker-a" || ok "A: configure holder started" 0
T0=$(now_ms)
SU <<SQL
begin;
$(publish_sql "$(U 61)")
commit;
SQL
ELAPSED=$(( $(now_ms) - T0 ))
wait $A_PID
ok "A: publish waited for the in-flight configure (waited ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1000 ] && echo 1 || echo 0)"
ok "A: the configure landed before the lock" "$([ "$(SU -c "select scoring_method||'/'||sequence_number from public.event_competition_rounds where id='$(U 91)'")" = "ordinal_majority/2" ] && echo 1 || echo 0)"
ok "A: the pin records the configured round" "$([ "$(SU -c "select count(*) from public.event_competition_scoring_pins where round_id='$(U 91)' and resolution='legacy_map' and method_key='studio_ordinal_majority'")" = "1" ] && echo 1 || echo 0)"

# ---------------------------------------------- Scenario B: configure waits for an in-flight publish, then is refused whole
(
SU <<SQL
begin;
$(publish_sql "$(U 62)")
select pg_sleep(6) /* ss1-marker-b */;
commit;
SQL
) &
B_PID=$!
wait_for_marker "ss1-marker-b" || ok "B: publish holder started" 0
T0=$(now_ms)
OUT=$(SU 2>&1 <<SQL
$(as_mgr)
select public.apply_competition_scoring_setup('$(U 62)', $(ops_for "$(U 92)"));
SQL
)
ELAPSED=$(( $(now_ms) - T0 ))
wait $B_PID
ok "B: the configure waited for the in-flight publish (waited ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1000 ] && echo 1 || echo 0)"
ok "B: the configure was refused (COMP_METHOD_LOCKED)" "$(printf '%s' "$OUT" | grep -q COMP_METHOD_LOCKED && echo 1 || echo 0)"
ok "B: the locked round kept its published values" "$([ "$(SU -c "select scoring_method||'/'||sequence_number from public.event_competition_rounds where id='$(U 92)'")" = "custom/1" ] && echo 1 || echo 0)"

# ---------------------------------------------- Scenario C: the raw column write is also refused after the publish (trigger layer)
OUT=$(SU 2>&1 <<SQL
$(as_mgr)
update public.event_competition_rounds set scoring_method='callback_tally' where id='$(U 92)';
SQL
)
ok "C: a direct column write on the locked round is refused" "$(printf '%s' "$OUT" | grep -q COMP_ROUND_SCORING_LOCKED && echo 1 || echo 0)"

if [ -z "$FAILS" ]; then echo "SS1 CONCURRENCY PASS ($PASS checks)"; else echo "SS1 CONCURRENCY FAIL:$FAILS"; exit 1; fi
