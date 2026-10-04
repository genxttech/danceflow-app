#!/usr/bin/env bash
# GC-S1C-4 -- real two-session concurrency harness for "This and following classes" (cancel_group_class_series_from).
# Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsc4_concurrency.sh
# Creates committed synthetic fixtures (studio ...ed001, four 4-class series), runs four scenarios with two overlapping
# sessions each, asserts the outcome (including that the second session really blocked), and always cleans up.
#   SC1 enrollment first      vs series cancel   -> the cancel waits, then cancels the class AND the attendee just booked
#   SC2 series cancel first   vs enrollment      -> the booking waits, then is refused (GCSC3_CLASS_CANCELLED)
#   SC3 single cancel first   vs series cancel   -> the series cancel waits on that class, then counts it as already cancelled
#   SC4 series cancel first   vs series cancel   -> the second waits on the series lock and then changes nothing
set -u
T="${TMPDIR:-/tmp}/gcsc4-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000ed001; OWN=00000000-0000-0000-0000-0000000ed101; INS=00000000-0000-0000-0000-0000000ed102; IID=00000000-0000-0000-0000-0000000ed201
CL() { echo "00000000-0000-0000-0000-0000000ed30$1"; }
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.appointment_attendees where studio_id='$S';
delete from public.group_class_enrollment_policies where appointment_id in (select id from public.appointments where studio_id='$S');
delete from public.appointments where studio_id='$S';
delete from public.group_class_series where studio_id='$S';
delete from public.instructors where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id in ('$OWN','$INS');
delete from auth.users where id in ('$OWN','$INS');
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left, (select count(*) from public.group_class_series where studio_id='$S') series_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left|series_left"; }
trap cleanup EXIT

{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSC4 conc studio','t-gcsc4-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcsc4-conc-owner@example.test'),('$INS','t-gcsc4-conc-instr@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsc4-conc-owner@example.test',null),('$INS','t-gcsc4-conc-instr@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$INS','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$IID','$S','$INS','Conc','Instructor',true,true);"
echo "alter table public.instructors enable trigger user;"
for n in 1 2 3; do echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$(CL $n)','$S','Conc','C$n','active',false);"; done
echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"
for n in 1 2 3 4; do
  echo "select public.create_group_class_series(p_studio_id=>'$S', p_client_request_id=>'00000000-0000-0000-0000-0000000ed70$n', p_title=>'CS-$n', p_description=>null, p_instructor_id=>'$IID', p_room_id=>null, p_location_name=>null, p_roster_capacity=>5, p_weekdays=>array[2]::smallint[], p_interval_weeks=>1, p_starts_on=>(current_date+20), p_ends_on=>null, p_occurrence_count=>4, p_local_start_time=>time '18:30', p_duration_minutes=>60);"
done
echo "reset role;"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"?([^",]*)"?.*/\1/'; }
occ() { val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='CS-$1' and a.series_occurrence_index=$2"; }
A1=$(occ 1 1); A2=$(occ 1 2); B1=$(occ 2 1); B3=$(occ 2 3); C1=$(occ 3 1); C2=$(occ 3 2); D1=$(occ 4 1)
[ -z "$A1" ] || [ -z "$D1" ] && { echo "could not resolve occurrence ids"; exit 1; }
# CS-3 occurrence 2 carries a booked attendee so a single cancellation has something to cancel
echo "insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$C2','$(CL 2)','booked','staff','free_comped');" > "$T/seed.sql"; run "$T/seed.sql" | grep -E "ERROR"

as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
enroll_sql() { echo "begin; $(as_owner) select public.enroll_class_attendee('$1','$(CL $2)','free_comped'); reset role; select pg_sleep($3); commit;"; }
series_sql() { echo "begin; $(as_owner) select set_config('t.res', public.cancel_group_class_series_from('$1')::text, true); reset role; select pg_sleep($2); select current_setting('t.res') as res; commit;"; }
single_sql() { echo "begin; $(as_owner) select public.cancel_group_class_appointment('$1'); reset role; select pg_sleep($2); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
state() { echo "select coalesce(string_agg(a.status::text, ',' order by a.series_occurrence_index), '-') as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='CS-$1'" > "$T/st.sql"; run "$T/st.sql" | grep -E '"v"' | sed -E 's/.*"v": *"([^"]*)".*/\1/'; }
booked() { val "select count(*)::text as v from public.appointment_attendees aa join public.appointments a on a.id=aa.appointment_id join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='CS-$1' and aa.status='booked'"; }
sstatus() { val "select status as v from public.group_class_series where studio_id='$S' and title='CS-$1'"; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { tr -d '\\' <"$T/$1" | grep -qE "$2" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }
ALLC="cancelled,cancelled,cancelled,cancelled"

# SC1: the booking holds occurrence 2 (CS-1); the series cancel from occurrence 1 waits, then cancels all four and the new attendee
scenario sc1 "$(enroll_sql "$A2" 1 12)" "$(series_sql "$A1" 0)"
check "enrollment-first/series-cancel: series cancel blocked (>=3s)" "$(blocked sc1)" yes
check "enrollment-first/series-cancel: all four classes cancelled" "$(has sc1.second.out '"cancelled_class_count": 4')" yes
check "enrollment-first/series-cancel: the just-booked attendee was cancelled with its class" "$(has sc1.second.out '"enrollments_cancelled": 1')" yes
check "enrollment-first/series-cancel: final state" "$(state 1)/$(booked 1)/$(sstatus 1)" "$ALLC/0/cancelled"

# SC2: the series cancel from occurrence 1 (CS-2) holds; the booking into occurrence 3 waits, then is refused
scenario sc2 "$(series_sql "$B1" 12)" "$(enroll_sql "$B3" 1 0)"
check "series-cancel-first/enrollment: booking blocked (>=3s)" "$(blocked sc2)" yes
check "series-cancel-first/enrollment: booking refused (cancelled class)" "$(has sc2.second.out GCSC3_CLASS_CANCELLED)" yes
check "series-cancel-first/enrollment: final state" "$(state 2)/$(booked 2)/$(sstatus 2)" "$ALLC/0/cancelled"

# SC3: a single cancellation of occurrence 2 (CS-3, one booked attendee) holds; the series cancel waits on that class and counts it as already cancelled
scenario sc3 "$(single_sql "$C2" 12)" "$(series_sql "$C1" 0)"
check "single-cancel-first/series-cancel: series cancel blocked (>=3s)" "$(blocked sc3)" yes
check "single-cancel-first/series-cancel: cancelled the other three" "$(has sc3.second.out '"cancelled_class_count": 3')" yes
check "single-cancel-first/series-cancel: counted the single-cancelled class as already cancelled" "$(has sc3.second.out '"already_cancelled_count": 1')" yes
check "single-cancel-first/series-cancel: no recipients duplicated from the single cancellation" "$(has sc3.second.out '"enrollments_cancelled": 0')" yes
check "single-cancel-first/series-cancel: final state" "$(state 3)/$(booked 3)/$(sstatus 3)" "$ALLC/0/cancelled"

# SC4: two series cancels of CS-4: the second waits on the series lock and then changes nothing
scenario sc4 "$(series_sql "$D1" 12)" "$(series_sql "$D1" 0)"
check "series-cancel/series-cancel: second blocked (>=3s)" "$(blocked sc4)" yes
check "series-cancel/series-cancel: second cancelled nothing" "$(has sc4.second.out '"cancelled_class_count": 0')" yes
check "series-cancel/series-cancel: second saw all four already cancelled" "$(has sc4.second.out '"already_cancelled_count": 4')" yes
check "series-cancel/series-cancel: second did not re-cancel the series" "$(has sc4.second.out '"series_cancelled_by_this_call": false')" yes
check "series-cancel/series-cancel: final state" "$(state 4)/$(sstatus 4)" "$ALLC/cancelled"

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
