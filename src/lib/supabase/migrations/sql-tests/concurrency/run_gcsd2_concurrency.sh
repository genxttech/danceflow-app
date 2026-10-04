#!/usr/bin/env bash
# GC-S1D-2 -- real two-session concurrency harness for series enroll / remove
# (enroll_group_class_series_from, remove_group_class_series_from). Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsd2_concurrency.sh
# Creates committed synthetic fixtures (studio ...f4001, six 4-class series), runs each scenario with two overlapping
# sessions, asserts the outcome (including that the second session really blocked), and always cleans up.
#   SC1 single enrollment takes the last seat first      -> the series enrollment waits, then is blocked (capacity); nothing enrolled
#   SC2 series enrollment first                          -> a single enrollment for the last seat waits, then is refused (full)
#   SC3 terminal attendance written first                -> the series removal waits, then skips that class and removes the rest
#   SC4 series removal first                             -> a terminal attendance write waits, then cannot leave a removed dancer attended
#   SC5 series edit (split) first                        -> the series enrollment waits, then targets the successor classes too
#   SC6 series cancellation first                        -> the series removal waits, then reports the cancelled classes
#   SC7 single membership enrollment first               -> the membership series enrollment waits (no deadlock), reports it already enrolled
#   SC8 membership series enrollment first               -> a single membership enrollment waits (no deadlock), then reports already enrolled
set -u
T="${TMPDIR:-/tmp}/gcsd2-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000f4001; OWN=00000000-0000-0000-0000-0000000f4101; INS=00000000-0000-0000-0000-0000000f4102; IID=00000000-0000-0000-0000-0000000f4201
PLAN=00000000-0000-0000-0000-0000000f4a01; BEN=00000000-0000-0000-0000-0000000f4b01; MEM=00000000-0000-0000-0000-0000000f4c01
CL() { echo "00000000-0000-0000-0000-0000000f430$1"; }
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.group_class_series_edit_requests where studio_id='$S';
delete from public.attendance_records where studio_id='$S';
delete from public.appointment_attendees where studio_id='$S';
delete from public.client_membership_usage where client_membership_id='$MEM';
delete from public.client_membership_periods where client_membership_id='$MEM';
delete from public.client_memberships where id='$MEM';
delete from public.membership_plan_benefits where id='$BEN';
delete from public.membership_plans where id='$PLAN';
delete from public.group_class_enrollment_policies where appointment_id in (select id from public.appointments where studio_id='$S');
delete from public.appointments where studio_id='$S';
update public.group_class_series set split_from_series_id = null where studio_id='$S';
delete from public.group_class_series where studio_id='$S';
delete from public.instructors where studio_id='$S';
delete from public.clients where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id in ('$OWN','$INS');
delete from auth.users where id in ('$OWN','$INS');
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left, (select count(*) from public.group_class_series where studio_id='$S') series_left, (select count(*) from public.client_memberships where id='$MEM') memberships_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left|series_left|memberships_left"; }
trap cleanup EXIT

{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSD2 conc studio','t-gcsd2-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcsd2-conc-owner@example.test'),('$INS','t-gcsd2-conc-instr@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsd2-conc-owner@example.test',null),('$INS','t-gcsd2-conc-instr@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$INS','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$IID','$S','$INS','Conc','Instructor',true,true);"
echo "alter table public.instructors enable trigger user;"
for n in 1 2 3 4; do echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$(CL $n)','$S','Conc','C$n','active',false);"; done
echo "insert into public.membership_plans (id,studio_id,name,active) values ('$PLAN','$S','GCSD2 conc plan',true);"
echo "insert into public.membership_plan_benefits (id,membership_plan_id,benefit_type,quantity,usage_period) values ('$BEN','$PLAN','included_group_classes',10,'billing_cycle');"
echo "insert into public.client_memberships (id,studio_id,client_id,membership_plan_id,name_snapshot,status,starts_on,current_period_start,current_period_end,billing_interval_snapshot,auto_renew,price_snapshot,created_by) values ('$MEM','$S','$(CL 1)','$PLAN','GCSD2 conc plan','active',current_date-1,current_date-1,current_date+90,'monthly',true,0,'$OWN');"
echo "insert into public.client_membership_periods (studio_id,client_id,client_membership_id,period_start,period_end,amount_due,amount_paid,currency,payment_status,payment_due_at,created_by) select studio_id,client_id,id,current_period_start,current_period_end,0,0,'usd','paid',current_period_start::timestamptz,created_by from public.client_memberships where id='$MEM';"
echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"
for n in 1 2 3 4 5 6; do
  cap="null"; [ "$n" = "1" ] && cap="2"
  echo "select public.create_group_class_series(p_studio_id=>'$S', p_client_request_id=>'00000000-0000-0000-0000-0000000f470$n', p_title=>'DS-$n', p_description=>null, p_instructor_id=>'$IID', p_room_id=>null, p_location_name=>null, p_roster_capacity=>$cap, p_weekdays=>array[$n]::smallint[], p_interval_weeks=>1, p_starts_on=>(current_date+20), p_ends_on=>null, p_occurrence_count=>4, p_local_start_time=>make_time($((7 + n * 2)),0,0), p_duration_minutes=>60);"
done
echo "reset role;"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/; t; s/.*"v": *([^,}]*).*/\1/'; }
occ() { val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='DS-$1' and a.series_occurrence_index=$2"; }
for n in 1 2 3 4 5 6; do for i in 1 2 3 4; do eval "O${n}${i}=\$(occ $n $i)"; done; done
[ -z "$O11" ] || [ -z "$O64" ] && { echo "could not resolve occurrence ids"; exit 1; }

as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
book_sql() { echo "insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type) values ('$S','$1','$(CL $2)','booked','staff','free_comped');"; }

# setup committed state
{
echo "begin;"
book_sql "$O13" 2                                   # DS-1 occurrence 3 holds one of its two seats
for i in 1 2 3 4; do book_sql "$(eval echo \$O2$i)" 1; book_sql "$(eval echo \$O4$i)" 1; done
echo "update public.appointments set starts_at = now() - interval '30 minutes', ends_at = now() + interval '30 minutes' where id='$O23';"
echo "commit;"
} > "$T/setup.sql"
run "$T/setup.sql" | grep -E "ERROR" && { echo "setup failed"; exit 1; }

# series enroll / remove as the owner, with a hold before commit; the result is selected so it can be asserted
enroll_series_sql() { echo "begin; $(as_owner) select set_config('t.res', public.enroll_group_class_series_from('$1','$(CL $2)','${3:-free_comped}',null,${4:-null},null)::text, true); reset role; select pg_sleep($5); select current_setting('t.res') as res; commit;"; }
remove_series_sql() { echo "begin; $(as_owner) select set_config('t.res', public.remove_group_class_series_from('$1','$(CL $2)',null)::text, true); reset role; select pg_sleep($3); select current_setting('t.res') as res; commit;"; }
single_enroll_sql() { echo "begin; $(as_owner) select public.enroll_class_attendee('$1','$(CL $2)','${3:-free_comped}',null,${4:-null}); reset role; select pg_sleep($5); commit;"; }
edit_sql() { echo "begin; $(as_owner) select set_config('t.res', public.edit_group_class_series_from('$1','00000000-0000-0000-0000-0000000f48$2'::uuid,'$3'::jsonb,false)::text, true); reset role; select pg_sleep($4); select current_setting('t.res') as res; commit;"; }
series_cancel_sql() { echo "begin; $(as_owner) select set_config('t.res', public.cancel_group_class_series_from('$1')::text, true); reset role; select pg_sleep($2); select current_setting('t.res') as res; commit;"; }
attend_sql() { echo "begin; insert into public.attendance_records (studio_id, appointment_id, client_id, status) values ('$S','$1','$(CL $2)','attended'); select pg_sleep($3); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
# one char per occurrence of series n for client c: B booked, x only cancelled, - none
states() { val "select string_agg(case when exists (select 1 from public.appointment_attendees aa where aa.appointment_id=a.id and aa.client_id='$(CL $2)' and aa.status='booked') then 'B' when exists (select 1 from public.appointment_attendees aa where aa.appointment_id=a.id and aa.client_id='$(CL $2)') then 'x' else '-' end, '' order by a.series_occurrence_index) as v from public.appointments a where a.id in ('$(eval echo \$O${1}1)','$(eval echo \$O${1}2)','$(eval echo \$O${1}3)','$(eval echo \$O${1}4)')"; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { tr -d '\\' < "$T/$1" | grep -qE "$2" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }

# SC1: a single enrollment takes the last seat of DS-1 occurrence 3 (held 12s); the series enrollment from occurrence 2 waits
scenario sc1 "$(single_enroll_sql "$O13" 3 free_comped null 12)" "$(enroll_series_sql "$O12" 1 free_comped null 0)"
check "capacity race (single first): series enrollment blocked (>=3s)" "$(blocked sc1)" yes
check "capacity race (single first): series enrollment reports blocked on capacity" "$(has sc1.second.out '"outcome": "blocked"')" yes
check "capacity race (single first): nothing enrolled for the series dancer" "$(states 1 1)" "----"
check "capacity race (single first): the single enrollment holds the seat" "$(states 1 3)" "--B-"

# SC2: reset DS-1 occurrence 3, then the series enrollment holds first; a single enrollment for the last seat waits, then is refused
echo "begin; delete from public.appointment_attendees where studio_id='$S' and appointment_id in ('$O11','$O12','$O13','$O14') and client_id in ('$(CL 1)','$(CL 3)'); commit;" > "$T/reset1.sql"; run "$T/reset1.sql" > /dev/null
scenario sc2 "$(enroll_series_sql "$O12" 1 free_comped null 12)" "$(single_enroll_sql "$O13" 3 free_comped null 0)"
check "capacity race (series first): single enrollment blocked (>=3s)" "$(blocked sc2)" yes
check "capacity race (series first): single enrollment refused, class full" "$(has sc2.second.out 'no available seats')" yes
check "capacity race (series first): series enrolled the dancer on 2..4" "$(states 1 1)" "-BBB"
check "capacity race (series first): the other dancer is not enrolled" "$(states 1 3)" "----"

# SC3: terminal attendance for the dancer on DS-2 occurrence 3 is being recorded (held); the series removal from occurrence 2 waits
scenario sc3 "$(attend_sql "$O23" 1 12)" "$(remove_series_sql "$O22" 1 0)"
check "attendance first / series removal: removal blocked (>=3s)" "$(blocked sc3)" yes
check "attendance first / series removal: attended class skipped" "$(has sc3.second.out '"skipped_terminal": 1')" yes
check "attendance first / series removal: other classes removed, attended class and earlier class kept" "$(states 2 1)" "BxBx"
check "attendance first / series removal: attendance recorded once" "$(val "select count(*)::text as v from public.attendance_records where appointment_id='$O23' and client_id='$(CL 1)' and status='attended'")" 1

# SC4: series removal of DS-4 holds first; a terminal attendance write for occurrence 3 waits, and a removed dancer is never left attended
scenario sc4 "$(remove_series_sql "$O42" 1 12)" "$(attend_sql "$O43" 1 0)"
check "series removal first / attendance: attendance write blocked (>=3s)" "$(blocked sc4)" yes
check "series removal first / attendance: removed on 2..4, earlier kept" "$(states 4 1)" "Bxxx"
check "series removal first / attendance: no attended record for a removed dancer" "$(val "select count(*)::text as v from public.attendance_records ar where ar.appointment_id='$O43' and ar.client_id='$(CL 1)' and ar.status='attended' and not exists (select 1 from public.appointment_attendees aa where aa.appointment_id=ar.appointment_id and aa.client_id=ar.client_id and aa.status='booked')")" 0

# SC5: a series edit (split at occurrence 3 of DS-3) holds first; the series enrollment from occurrence 2 waits, then covers the successor
scenario sc5 "$(edit_sql "$O33" 01 '{"title":"DS-3 successor"}' 12)" "$(enroll_series_sql "$O32" 1 free_comped null 0)"
check "split first / series enrollment: enrollment blocked (>=3s)" "$(blocked sc5)" yes
check "split first / series enrollment: all of 2..4 enrolled across the split" "$(states 3 1)" "-BBB"
check "split first / series enrollment: result enrolled three" "$(has sc5.second.out '"enrolled_count": 3')" yes

# SC6: a series cancellation of DS-5 holds first (the dancer is booked on all four); the series removal waits, then reports cancelled classes
echo "begin; $(book_sql "$O51" 1) $(book_sql "$O52" 1) $(book_sql "$O53" 1) $(book_sql "$O54" 1) commit;" > "$T/sc6setup.sql"; run "$T/sc6setup.sql" > /dev/null
scenario sc6 "$(series_cancel_sql "$O52" 12)" "$(remove_series_sql "$O51" 1 0)"
check "series cancel first / series removal: removal blocked (>=3s)" "$(blocked sc6)" yes
check "series cancel first / series removal: cancelled classes reported" "$(has sc6.second.out '"skipped_cancelled": 3')" yes
check "series cancel first / series removal: dancer ends removed everywhere" "$(states 5 1)" "xxxx"

# SC7: a single membership enrollment (membership row then class row) holds first; the membership series enrollment waits at the membership
scenario sc7 "$(single_enroll_sql "$O63" 1 membership "'$MEM'" 12)" "$(enroll_series_sql "$O61" 1 membership "'$MEM'" 0)"
check "membership single first / series: series blocked (>=3s)" "$(blocked sc7)" yes
check "membership single first / series: reports the single enrollment as already enrolled" "$(has sc7.second.out '"already_enrolled": 1')" yes
check "membership single first / series: dancer enrolled on all four" "$(states 6 1)" "BBBB"

# SC8: reset DS-6, then the membership series enrollment holds first; a single membership enrollment waits, then is refused as duplicate
echo "begin; delete from public.appointment_attendees where studio_id='$S' and appointment_id in ('$O61','$O62','$O63','$O64') and client_id='$(CL 1)'; commit;" > "$T/reset6.sql"; run "$T/reset6.sql" > /dev/null
scenario sc8 "$(enroll_series_sql "$O61" 1 membership "'$MEM'" 12)" "$(single_enroll_sql "$O62" 1 membership "'$MEM'" 0)"
check "membership series first / single: single blocked (>=3s)" "$(blocked sc8)" yes
check "membership series first / single: duplicate refused after the wait" "$(has sc8.second.out 'already enrolled')" yes
check "membership series first / single: dancer enrolled once on every class" "$(states 6 1)" "BBBB"

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
