#!/usr/bin/env bash
# Competition E2 -- concurrent submit vs lock, with a REAL second database connection per actor.
#
# Usage: bash run_e2_submit_vs_lock.sh [container]   (default: e2-db; the DB must have 10A..10D, E1 and E2 applied)
# Needs a superuser (supabase_admin) for fixtures only; the actors run as `authenticated` with a JWT sub claim.
# Fixtures COMMIT (a second connection cannot see an open transaction) and are removed by deleting the event at the end,
# even on failure. Scenarios:
#   A  a judge's submit is in flight (uncommitted) when the manager locks  -> the lock WAITS, then sees the ballot and succeeds
#   B  the lock is in flight when a judge submits                            -> the submit WAITS, then is refused (round not active)
#   C  two corrections by one judge at once                                  -> serialized: versions 2 and 3, chain never forks
# Prints "E2 CONCURRENCY PASS (<n> checks)" or "E2 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-e2-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
U() { printf '00000000-0000-0000-0000-e20ff3%06x' "$((16#$1))"; }
JUDGE1=$(U a1); JUDGE2=$(U a2); MGR=$(U a0)
EV=$(U e0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

cleanup() { SU -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from auth.users where id::text like '00000000-0000-0000-0000-e20ff3%';" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-e2c-mgr@example.test'),('$JUDGE1','t-e2c-j1@example.test'),('$JUDGE2','t-e2c-j2@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'E2C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-e20ff3%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-e20ff3%';
insert into public.studios (id, name, slug) values ('$STUDIO','E2C Studio','t-e2c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$JUDGE1','$STUDIO','instructor',true),('$JUDGE2','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','E2C Comp','t-e2c-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$(U 61)','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 62)','$EV','$(U 61)','C','single_dance','pro_am','open');
SQL
for i in 1 2 3; do
SU <<SQL
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$(U 7$i)','$EV','$(U 61)','$(U 62)','D$i','open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values ('$(U 8$i)','$EV','$(U 61)','$(U 7$i)','R$i','final',1,'draft','ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  ('$(U 9${i}1)','$EV','$(U 61)','$(U 7$i)','E${i}1','confirmed','eligible','${i}01'), ('$(U 9${i}2)','$EV','$(U 61)','$(U 7$i)','E${i}2','confirmed','eligible','${i}02');
SQL
done
SU <<SQL
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(U c1)','$EV',1,'v1','published',now());
$(for i in 1 2 3; do echo "insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$(U d$i)','$EV','$(U 7$i)','$(U 8$i)',$i,'$(U 62)','$(U c1)','scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}1)',1),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}2)',2);"; done)
set session_replication_role = origin;
SQL

# Officials / panels through the real RPCs as the manager (one session, committed)
as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }
SU <<SQL
$(as_user "$MGR")
select public.add_competition_official('$EV','$JUDGE1','judge','$(U f001)');
select public.add_competition_official('$EV','$JUDGE2','judge','$(U f002)');
$(for i in 1 2 3; do echo "select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE1'), 'A', '$(U f1$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE2'), 'B', '$(U f2$i)');"; done)
SQL
SU -c "update public.event_competition_rounds set status='active' where event_id='$EV';"
SU <<SQL
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d1)','locked','done');
select public.set_competition_heat_lock_state('$(U d2)','locked','done');
SQL
marks() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"value\":$2},{\"entry_id\":\"$(U 9${1}2)\",\"value\":$3}]'::jsonb"; }
now_ms() { date +%s%3N; }

# ------------------------------------------------------------- Scenario A: lock waits for an in-flight submit
SU <<SQL
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks 1 1 2),'$(U a101)');
SQL
( SU <<SQL
$(as_user "$JUDGE2")
begin;
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks 1 2 1),'$(U a102)');
select pg_sleep(4);
commit;
SQL
) > /tmp/e2c_a_submit.out 2>&1 &
SUBMIT_PID=$!
sleep 1.5
T0=$(now_ms)
LOCK_OUT=$(SU <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 81)','$(U a103)');
SQL
)
T1=$(now_ms); wait $SUBMIT_PID
ELAPSED=$((T1-T0))
echo "A: lock took ${ELAPSED}ms -> $LOCK_OUT"
ok "A: lock waited for the in-flight submit (>=1800ms, was ${ELAPSED}ms)" $([ "$ELAPSED" -ge 1800 ] && echo 1 || echo 0)
ok "A: lock succeeded after seeing the submitted ballot" $(echo "$LOCK_OUT" | grep -q '"status": "ballots_locked"' && echo 1 || echo 0)
ok "A: round is ballots_locked and holds 2 ballots" $([ "$(SU -c "select (select status from public.event_competition_rounds where id='$(U 81)') || ':' || (select count(*) from public.event_competition_ballots where round_id='$(U 81)')")" = "ballots_locked:2" ] && echo 1 || echo 0)

# ------------------------------------------------------------- Scenario B: submit waits for an in-flight lock
SU <<SQL
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 82)','$(U d2)',$(marks 2 1 2),'$(U b101)');
$(as_user "$JUDGE2")
select public.submit_competition_ballot('$(U 82)','$(U d2)',$(marks 2 2 1),'$(U b102)');
SQL
SU -c "select 1" >/dev/null
# the lock txn holds the round row (FOR UPDATE) for 4s
( SU <<SQL
$(as_user "$MGR")
begin;
select public.lock_competition_round_ballots('$(U 82)','$(U b103)');
select pg_sleep(4);
commit;
SQL
) > /tmp/e2c_b_lock.out 2>&1 &
LOCK_PID=$!
sleep 1.5
T0=$(now_ms)
SUB_OUT=$(SU <<SQL 2>&1
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 82)','$(U d2)',$(marks 2 2 1),'$(U b104)','late correction');
SQL
)
T1=$(now_ms); wait $LOCK_PID
ELAPSED=$((T1-T0))
echo "B: submit took ${ELAPSED}ms -> $SUB_OUT"
ok "B: submit waited for the in-flight lock (>=1800ms, was ${ELAPSED}ms)" $([ "$ELAPSED" -ge 1800 ] && echo 1 || echo 0)
ok "B: submit was refused as round not active" $(echo "$SUB_OUT" | grep -q 'COMP_BALLOT_ROUND_NOT_ACTIVE' && echo 1 || echo 0)
ok "B: no ballot slipped in after the lock (2 ballots, round locked)" $([ "$(SU -c "select (select status from public.event_competition_rounds where id='$(U 82)') || ':' || (select count(*) from public.event_competition_ballots where round_id='$(U 82)')")" = "ballots_locked:2" ] && echo 1 || echo 0)

# ------------------------------------------------------------- Scenario C: simultaneous corrections serialize
SU <<SQL
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks 3 1 2),'$(U c101)');
SQL
( SU <<SQL
$(as_user "$JUDGE1")
begin;
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks 3 2 1),'$(U c102)','first fix');
select pg_sleep(3);
commit;
SQL
) > /tmp/e2c_c1.out 2>&1 &
P1=$!
sleep 1
OUT2=$(SU <<SQL 2>&1
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks 3 1 2),'$(U c103)','second fix');
SQL
)
wait $P1
echo "C: second correction -> $OUT2"
ok "C: both corrections succeeded" $(echo "$OUT2" | grep -q '"version": 3' && grep -q '"version": 2' /tmp/e2c_c1.out && echo 1 || echo 0)
ok "C: chain is 1,2,3 with no fork" $([ "$(SU -c "select string_agg(version::text, ',' order by version) from public.event_competition_ballots where round_id='$(U 83)' and official_id=(select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE1')")" = "1,2,3" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "E2 CONCURRENCY PASS ($PASS checks)"; exit 0; fi
echo "E2 CONCURRENCY FAIL:$FAILS"; exit 1
