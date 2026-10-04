#!/usr/bin/env bash
# GC-S1C-2 -- real two-session concurrency harness for the attendance/cancel
# serialization (cancel_group_class_appointment FOR UPDATE vs the attendance
# guard trigger's FOR SHARE). Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsc2_concurrency.sh
# Creates committed synthetic fixtures (studio ...e9001), runs eight scenarios with two
# overlapping sessions each, asserts the outcome, and always cleans up.
set -u
T="${TMPDIR:-/tmp}/gcsc2-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000e9001; U=00000000-0000-0000-0000-0000000e9101
C1=00000000-0000-0000-0000-0000000e9301
AP() { echo "00000000-0000-0000-0000-0000000e94$1"; }   # class ids e9411..e9418
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.attendance_records where studio_id='$S';
delete from public.appointment_attendees where studio_id='$S';
delete from public.appointments where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id='$U';
delete from auth.users where id='$U';
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left"; }
trap cleanup EXIT

# fixtures: 8 past scheduled classes, each with a booked attendee; 11/12 and 13/14 pair UPDATE (existing registered record) / INSERT (no record)
{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSC2 conc studio','t-gcsc2-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$U','t-gcsc2-conc-owner@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$U','t-gcsc2-conc-owner@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$U','$S','studio_owner',true);"
echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$C1','$S','Conc','One','active',false);"
for n in 11 12 13 14 15 16 17 18; do
  echo "insert into public.appointments (id,studio_id,client_id,instructor_id,appointment_type,status,starts_at,ends_at,title) values ('$(AP $n)','$S',null,null,'group_class','scheduled',now()-interval '2 days',now()-interval '2 days'+interval '1 hour','CONC-$n');"
  echo "insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$(AP $n)','$C1','booked','staff','free_comped');"
done
for n in 11 13 15 17; do echo "insert into public.attendance_records (studio_id,appointment_id,client_id,status) values ('$S','$(AP $n)','$C1','registered');"; done
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$U')::text, true); set local role authenticated;"; }
cancel_sql() { echo "begin; $(as_owner) select public.cancel_group_class_appointment('$(AP $1)'); reset role; select pg_sleep($2); commit;"; }
dcancel_sql() { echo "begin; $(as_owner) update public.appointments set status='cancelled', cancelled_at=now() where id='$(AP $1)'; reset role; select pg_sleep($2); commit;"; }
upd_sql() { echo "begin; $(as_owner) update public.attendance_records set status='attended', marked_attended_at=now() where appointment_id='$(AP $1)' and client_id='$C1'; select pg_sleep($2); commit;"; }
ins_sql() { echo "begin; $(as_owner) insert into public.attendance_records (studio_id,appointment_id,client_id,status,marked_attended_at) values ('$S','$(AP $1)','$C1','attended',now()); select pg_sleep($2); commit;"; }

# scenario FIRST SECOND: FIRST starts, holds its transaction ~12s after acting; SECOND starts ~7s later
scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
state() { echo "select (select status::text from public.appointments where id='$(AP $1)') appt, coalesce((select string_agg(status,',') from public.attendance_records where appointment_id='$(AP $1)'),'-') att;" > "$T/st.sql"; run "$T/st.sql" | grep -E '"(appt|att)"' | tr -d ' \n'; echo; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { grep -q "$2" "$T/$1" && echo yes || echo no; }

# 8a/8b ATTENDANCE FIRST (UPDATE path / INSERT path): cancel must block, then refuse; class stays scheduled
scenario af_update "$(upd_sql 11 12)" "$(cancel_sql 11 0)"
check "attendance-first/update: cancel refused after waiting" "$(has af_update.second.out GCSC2_ATTENDANCE_RECORDED)" yes
check "attendance-first/update: cancel blocked (>=3s)" "$([ "$(cat $T/af_update.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "attendance-first/update: final state" "$(state 11)" '"appt":"scheduled","att":"attended"'
scenario af_insert "$(ins_sql 12 12)" "$(cancel_sql 12 0)"
check "attendance-first/insert: cancel refused after waiting" "$(has af_insert.second.out GCSC2_ATTENDANCE_RECORDED)" yes
check "attendance-first/insert: cancel blocked (>=3s)" "$([ "$(cat $T/af_insert.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "attendance-first/insert: final state" "$(state 12)" '"appt":"scheduled","att":"attended"'

# 9a/9b CANCEL FIRST: attendance must block, then refuse; class ends cancelled with no terminal record
scenario cf_update "$(cancel_sql 13 12)" "$(upd_sql 13 0)"
check "cancel-first/update: attendance refused after waiting" "$(has cf_update.second.out GCSC2_CLASS_CANCELLED)" yes
check "cancel-first/update: attendance blocked (>=3s)" "$([ "$(cat $T/cf_update.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "cancel-first/update: final state" "$(state 13)" '"appt":"cancelled","att":"registered"'
scenario cf_insert "$(cancel_sql 14 12)" "$(ins_sql 14 0)"
check "cancel-first/insert: attendance refused after waiting" "$(has cf_insert.second.out GCSC2_CLASS_CANCELLED)" yes
check "cancel-first/insert: attendance blocked (>=3s)" "$([ "$(cat $T/cf_insert.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "cancel-first/insert: final state" "$(state 14)" '"appt":"cancelled","att":"-"'


# 11/12 DIRECT appointment UPDATE (no RPC) vs terminal attendance, both orders, UPDATE + INSERT attendance paths
scenario daf_update "$(upd_sql 15 12)" "$(dcancel_sql 15 0)"
check "direct-attendance-first/update: direct cancel refused after waiting" "$(has daf_update.second.out GCSC2_ATTENDANCE_RECORDED)" yes
check "direct-attendance-first/update: direct cancel blocked (>=3s)" "$([ "$(cat $T/daf_update.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "direct-attendance-first/update: final state" "$(state 15)" '"appt":"scheduled","att":"attended"'
scenario daf_insert "$(ins_sql 16 12)" "$(dcancel_sql 16 0)"
check "direct-attendance-first/insert: direct cancel refused after waiting" "$(has daf_insert.second.out GCSC2_ATTENDANCE_RECORDED)" yes
check "direct-attendance-first/insert: direct cancel blocked (>=3s)" "$([ "$(cat $T/daf_insert.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "direct-attendance-first/insert: final state" "$(state 16)" '"appt":"scheduled","att":"attended"'
scenario dcf_update "$(dcancel_sql 17 12)" "$(upd_sql 17 0)"
check "direct-cancel-first/update: attendance refused after waiting" "$(has dcf_update.second.out GCSC2_CLASS_CANCELLED)" yes
check "direct-cancel-first/update: attendance blocked (>=3s)" "$([ "$(cat $T/dcf_update.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "direct-cancel-first/update: final state" "$(state 17)" '"appt":"cancelled","att":"registered"'
scenario dcf_insert "$(dcancel_sql 18 12)" "$(ins_sql 18 0)"
check "direct-cancel-first/insert: attendance refused after waiting" "$(has dcf_insert.second.out GCSC2_CLASS_CANCELLED)" yes
check "direct-cancel-first/insert: attendance blocked (>=3s)" "$([ "$(cat $T/dcf_insert.second.elapsed)" -ge 3 ] && echo yes || echo no)" yes
check "direct-cancel-first/insert: final state" "$(state 18)" '"appt":"cancelled","att":"-"'
# 10 no deadlocks / lock timeouts in any session
check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
