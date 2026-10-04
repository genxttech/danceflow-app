#!/usr/bin/env bash
# GC-S1C-3 -- real two-session concurrency harness for the class-row lock shared by enrollment (enforce_group_class_roster_capacity,
# FOR UPDATE), the capacity floor (the UPDATE's own row lock) and cancel_group_class_appointment (FOR UPDATE). Run against DEV only,
# from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsc3_concurrency.sh
# Creates committed synthetic fixtures (studio ...eb001), runs four scenarios with two overlapping sessions each, asserts the outcome
# (including that the second session really blocked), and always cleans up.
set -u
T="${TMPDIR:-/tmp}/gcsc3-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000eb001; OWN=00000000-0000-0000-0000-0000000eb101; INS=00000000-0000-0000-0000-0000000eb102
IID=00000000-0000-0000-0000-0000000eb201
CL() { echo "00000000-0000-0000-0000-0000000eb30$1"; }     # clients eb301..eb305
AP() { echo "00000000-0000-0000-0000-0000000eb40$1"; }     # classes eb401..eb404
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.appointment_attendees where studio_id='$S';
delete from public.group_class_enrollment_policies where appointment_id in (select id from public.appointments where studio_id='$S');
delete from public.appointments where studio_id='$S';
delete from public.instructors where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id in ('$OWN','$INS');
delete from auth.users where id in ('$OWN','$INS');
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left"; }
trap cleanup EXIT

# fixtures: K1 cap 3 + c1 booked; K2 cap 3 + c1,c2 booked; K3 no cap, nobody; K4 no cap, nobody
{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSC3 conc studio','t-gcsc3-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcsc3-conc-owner@example.test'),('$INS','t-gcsc3-conc-instr@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsc3-conc-owner@example.test',null),('$INS','t-gcsc3-conc-instr@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$INS','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$IID','$S','$INS','Conc','Instructor',true,true);"
echo "alter table public.instructors enable trigger user;"
for n in 1 2 3 4 5; do echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$(CL $n)','$S','Conc','C$n','active',false);"; done
for n in 1 2 3 4; do
  cap="null"; [ $n -le 2 ] && cap=3
  echo "insert into public.appointments (id,studio_id,client_id,instructor_id,appointment_type,status,starts_at,ends_at,title,roster_capacity) values ('$(AP $n)','$S',null,'$IID','group_class','scheduled',now()+interval '3 days',now()+interval '3 days 1 hour','CONC-K$n',$cap);"
done
echo "insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$(AP 1)','$(CL 1)','booked','staff','free_comped'),('$S','$(AP 2)','$(CL 1)','booked','staff','free_comped'),('$S','$(AP 2)','$(CL 2)','booked','staff','free_comped');"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

as_user() { echo "select set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); set local role authenticated;"; }
enroll_sql() { echo "begin; $(as_user $OWN) select public.enroll_class_attendee('$(AP $1)','$(CL $2)','free_comped'); reset role; select pg_sleep($3); commit;"; }
cancel_sql() { echo "begin; $(as_user $OWN) select public.cancel_group_class_appointment('$(AP $1)'); reset role; select pg_sleep($2); commit;"; }
cap_sql()    { echo "begin; $(as_user $INS) update public.appointments set roster_capacity=$2 where id='$(AP $1)'; reset role; select pg_sleep($3); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
state() { echo "select (select status::text from public.appointments where id='$(AP $1)') appt, (select coalesce(roster_capacity::text,'-') from public.appointments where id='$(AP $1)') cap, (select count(*) from public.appointment_attendees where appointment_id='$(AP $1)' and status='booked') booked, (select count(*) from public.appointment_attendees where appointment_id='$(AP $1)' and status='cancelled') cancelled;" > "$T/st.sql"; run "$T/st.sql" | grep -E '"(appt|cap|booked|cancelled)"' | tr -d ' \n'; echo; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { grep -q "$2" "$T/$1" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }

# C1 ENROLLMENT FIRST, capacity floor second: the booking holds the class row; the capacity cut waits, then sees two booked and refuses
scenario c1 "$(enroll_sql 1 2 12)" "$(cap_sql 1 1 0)"
check "enrollment-first/capacity-lower: capacity cut refused after waiting" "$(has c1.second.out GCSC3_CAPACITY_BELOW_BOOKED)" yes
check "enrollment-first/capacity-lower: capacity cut blocked (>=3s)" "$(blocked c1)" yes
check "enrollment-first/capacity-lower: final state" "$(state 1)" '"appt":"scheduled","booked":2,"cancelled":0,"cap":"3"'

# C2 CAPACITY CUT FIRST (to exactly the booked count), enrollment second: the booking waits, then finds the class full
scenario c2 "$(cap_sql 2 2 12)" "$(enroll_sql 2 3 0)"
check "capacity-lower-first/enrollment: booking refused after waiting (no seats)" "$(has c2.second.out 'no available seats')" yes
check "capacity-lower-first/enrollment: booking blocked (>=3s)" "$(blocked c2)" yes
check "capacity-lower-first/enrollment: final state" "$(state 2)" '"appt":"scheduled","booked":2,"cancelled":0,"cap":"2"'

# C3 CANCELLATION FIRST, enrollment second: the booking waits, then sees the cancelled class and refuses
scenario c3 "$(cancel_sql 3 12)" "$(enroll_sql 3 1 0)"
check "cancel-first/enrollment: booking refused after waiting (cancelled)" "$(has c3.second.out GCSC3_CLASS_CANCELLED)" yes
check "cancel-first/enrollment: booking blocked (>=3s)" "$(blocked c3)" yes
check "cancel-first/enrollment: final state" "$(state 3)" '"appt":"cancelled","booked":0,"cancelled":0,"cap":"-"'

# C4 ENROLLMENT FIRST, cancellation second: the cancellation waits, then cancels the class AND the attendee the booking just created
scenario c4 "$(enroll_sql 4 1 12)" "$(cancel_sql 4 0)"
check "enrollment-first/cancel: cancellation succeeded after waiting" "$(has c4.second.out ERROR)" no
check "enrollment-first/cancel: cancellation blocked (>=3s)" "$(blocked c4)" yes
check "enrollment-first/cancel: final state (no booked attendee on the cancelled class)" "$(state 4)" '"appt":"cancelled","booked":0,"cancelled":1,"cap":"-"'

# no deadlocks / lock timeouts in any session
check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
