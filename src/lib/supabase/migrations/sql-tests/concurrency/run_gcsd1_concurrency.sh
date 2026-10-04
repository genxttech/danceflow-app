#!/usr/bin/env bash
# GC-S1D-1 -- real two-session check that removing a dancer serializes with attendance recording.
# Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsd1_concurrency.sh
# Creates committed synthetic fixtures (studio ...f2001, one past class, two booked dancers), then:
#   SC1 attendance write first (holds the class row FOR SHARE) vs removal of that dancer -> the removal waits, then is refused
#   SC2 removal first (holds the class row FOR UPDATE)         vs removal of the other dancer -> the second waits, then succeeds
# and always cleans up.
set -u
T="${TMPDIR:-/tmp}/gcsd1-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000f2001; OWN=00000000-0000-0000-0000-0000000f2101; CLS=00000000-0000-0000-0000-0000000f2401
C1=00000000-0000-0000-0000-0000000f2301; C2=00000000-0000-0000-0000-0000000f2302; A1=00000000-0000-0000-0000-0000000f2501; A2=00000000-0000-0000-0000-0000000f2502
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.attendance_records where studio_id='$S';
delete from public.appointment_attendees where studio_id='$S';
delete from public.group_class_enrollment_policies where appointment_id in (select id from public.appointments where studio_id='$S');
delete from public.appointments where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id='$OWN';
delete from auth.users where id='$OWN';
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left"; }
trap cleanup EXIT

cat > "$T/fixture.sql" <<SQL
begin;
insert into public.studios (id,name,slug,timezone) values ('$S','GCSD1 conc studio','t-gcsd1-conc','America/New_York');
insert into auth.users (id,email) values ('$OWN','t-gcsd1-conc-owner@example.test');
insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsd1-conc-owner@example.test',null);
insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true);
insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$C1','$S','Conc','One','active',false),('$C2','$S','Conc','Two','active',false);
insert into public.appointments (id,studio_id,appointment_type,status,starts_at,ends_at,title) values ('$CLS','$S','group_class','scheduled',now()-interval '3 hours',now()-interval '2 hours','GCSD1 conc');
insert into public.appointment_attendees (id,studio_id,appointment_id,client_id,status,source,billing_type) values ('$A1','$S','$CLS','$C1','booked','staff','free_comped'),('$A2','$S','$CLS','$C2','booked','staff','free_comped');
commit;
SQL
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/'; }
as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
remove_sql() { echo "begin; $(as_owner) select public.cancel_class_attendee('$1'); reset role; select pg_sleep($2); commit;"; }
attend_sql() { echo "begin; insert into public.attendance_records (studio_id, appointment_id, client_id, status) values ('$S','$CLS','$1','attended'); select pg_sleep($2); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }
has() { grep -q "$2" "$T/$1" && echo yes || echo no; }

# SC1: attendance for dancer 1 is being recorded (uncommitted); the removal of dancer 1 waits, then sees it and is refused
scenario sc1 "$(attend_sql "$C1" 12)" "$(remove_sql "$A1" 0)"
check "attendance-first/removal: removal blocked (>=3s)" "$(blocked sc1)" yes
check "attendance-first/removal: removal refused after the wait" "$(has sc1.second.out GCSD1_ATTENDEE_ATTENDANCE_RECORDED)" yes
check "attendance-first/removal: dancer still booked with attendance recorded" "$(val "select (select status from public.appointment_attendees where id='$A1') || '/' || (select count(*) from public.attendance_records where appointment_id='$CLS' and client_id='$C1')::text as v")" "booked/1"

# SC2: removal of dancer 2 holds the class row; a second removal (dancer 2 again) waits and is a harmless no-op
scenario sc2 "$(remove_sql "$A2" 12)" "$(remove_sql "$A2" 0)"
check "removal-first/removal: second blocked (>=3s)" "$(blocked sc2)" yes
check "removal-first/removal: second finished without error" "$(has sc2.second.out ERROR)" no
check "removal-first/removal: dancer 2 removed once" "$(val "select status as v from public.appointment_attendees where id='$A2'")" cancelled

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
