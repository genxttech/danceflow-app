#!/usr/bin/env bash
# GC-S1D-3 -- real two-session concurrency harness for series enrollment settings
# (apply_group_class_series_enrollment_settings). Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsd3_concurrency.sh
# Creates committed synthetic fixtures (studio ...f6001, seven 4-class series), runs each scenario with two overlapping
# sessions, asserts the outcome (including that the second session really blocked), and always cleans up.
#   SC1 series edit (split) first               -> the settings apply waits on the series lock, then covers the successor classes too
#   SC2 settings apply first                    -> a direct single-class settings update waits, then wins that one class; no deadlock
#   SC3 series cancellation first               -> the settings apply waits, then skips the cancelled classes
#   SC4 two settings applies, different values  -> serialized; the later one wins every class (uniform result)
#   SC5 settings apply first                    -> a series enrollment (GC-S1D-2) waits on the series lock, then succeeds under the new settings; no deadlock
#   SC6 settings apply first                    -> a series cancellation (GC-S1C-4) waits, then cancels the later classes; the settings stay as applied
#   SC7 settings apply first                    -> a series split edit (GC-S1C-5) waits, then splits; every class keeps the applied settings
set -u
T="${TMPDIR:-/tmp}/gcsd3-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000f6001; OWN=00000000-0000-0000-0000-0000000f6101; INS=00000000-0000-0000-0000-0000000f6102; IID=00000000-0000-0000-0000-0000000f6201
CLI=00000000-0000-0000-0000-0000000f6301
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.group_class_series_edit_requests where studio_id='$S';
delete from public.attendance_records where studio_id='$S';
delete from public.appointment_attendees where studio_id='$S';
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
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left, (select count(*) from public.group_class_series where studio_id='$S') series_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left|series_left"; }
trap cleanup EXIT

{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSD3 conc studio','t-gcsd3-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcsd3-conc-owner@example.test'),('$INS','t-gcsd3-conc-instr@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsd3-conc-owner@example.test',null),('$INS','t-gcsd3-conc-instr@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$INS','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$IID','$S','$INS','Conc','Instructor',true,true);"
echo "alter table public.instructors enable trigger user;"
echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$CLI','$S','Conc','C1','active',false);"
echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"
for n in 1 2 3 4 5 6 7; do
  echo "select public.create_group_class_series(p_studio_id=>'$S', p_client_request_id=>'00000000-0000-0000-0000-0000000f670$n', p_title=>'ES-$n', p_description=>null, p_instructor_id=>'$IID', p_room_id=>null, p_location_name=>null, p_roster_capacity=>null, p_weekdays=>array[$n]::smallint[], p_interval_weeks=>1, p_starts_on=>(current_date+20), p_ends_on=>null, p_occurrence_count=>4, p_local_start_time=>make_time($((7 + n * 2)),0,0), p_duration_minutes=>60);"
done
echo "reset role;"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/; t; s/.*"v": *([^,}]*).*/\1/'; }
occ() { val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='ES-$1' and a.series_occurrence_index=$2"; }
for n in 1 2 3 4 5 6 7; do for i in 1 2 3 4; do eval "O${n}${i}=\$(occ $n $i)"; done; done
[ -z "$O11" ] || [ -z "$O74" ] && { echo "could not resolve occurrence ids"; exit 1; }

as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
# apply_sql <anchor> <discoverable> <self> <package> <membership> <sleep-after>
apply_sql() { echo "begin; $(as_owner) select set_config('t.res', public.apply_group_class_series_enrollment_settings('$1',$2,$3,$4,$5,null)::text, true); reset role; select pg_sleep($6); select current_setting('t.res') as res; commit;"; }
edit_sql() { echo "begin; $(as_owner) select set_config('t.res', public.edit_group_class_series_from('$1','00000000-0000-0000-0000-0000000f68$2'::uuid,'$3'::jsonb,false)::text, true); reset role; select pg_sleep($4); select current_setting('t.res') as res; commit;"; }
series_cancel_sql() { echo "begin; $(as_owner) select set_config('t.res', public.cancel_group_class_series_from('$1')::text, true); reset role; select pg_sleep($2); select current_setting('t.res') as res; commit;"; }
# a direct single-class settings update (what the class editor does)
single_update_sql() { echo "begin; $(as_owner) update public.group_class_enrollment_policies set publicly_discoverable=false, self_enrollment_allowed=false, accepted_funding_types=array['membership']::text[] where appointment_id='$1'; reset role; select pg_sleep($2); commit;"; }
enroll_series_sql() { echo "begin; $(as_owner) select set_config('t.res', public.enroll_group_class_series_from('$1','$CLI','package_credit',null,null,null)::text, true); reset role; select pg_sleep($2); select current_setting('t.res') as res; commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
# one token per occurrence of series n: D/d discoverable, S/s self enroll, then funding list, joined with commas
pol() { val "select string_agg((case when p.publicly_discoverable then 'D' else 'd' end) || (case when p.self_enrollment_allowed then 'S' else 's' end) || '/' || coalesce(array_to_string(p.accepted_funding_types, '+'), '-'), ',' order by a.series_occurrence_index) as v from public.appointments a join public.group_class_enrollment_policies p on p.appointment_id=a.id where a.id in ('$(eval echo \$O${1}1)','$(eval echo \$O${1}2)','$(eval echo \$O${1}3)','$(eval echo \$O${1}4)')"; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { tr -d '\\' < "$T/$1" | grep -qE "$2" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }

# SC1: a series edit splitting ES-1 at occurrence 3 holds first; the settings apply from occurrence 2 waits, then covers the successor
scenario sc1 "$(edit_sql "$O13" 01 '{"title":"ES-1 successor"}' 12)" "$(apply_sql "$O12" true true true false 0)"
check "split first / settings apply: apply blocked (>=3s)" "$(blocked sc1)" yes
check "split first / settings apply: updated all of 2..4 across the split" "$(has sc1.second.out '"updated_count": 3')" yes
check "split first / settings apply: occurrence 1 untouched, 2..4 updated" "$(pol 1)" "ds/-,DS/package,DS/package,DS/package"

# SC2: the settings apply on ES-2 holds first; a direct single-class update of occurrence 3 waits, then wins that one class
scenario sc2 "$(apply_sql "$O21" true true true true 12)" "$(single_update_sql "$O23" 0)"
check "apply first / single update: single update blocked (>=3s)" "$(blocked sc2)" yes
check "apply first / single update: the later single update wins its class, the rest keep the series result" "$(pol 2)" "DS/package+membership,DS/package+membership,ds/membership,DS/package+membership"

# SC3: a series cancellation of ES-3 from occurrence 2 holds first; the settings apply from occurrence 1 waits, then skips the cancelled classes
scenario sc3 "$(series_cancel_sql "$O32" 12)" "$(apply_sql "$O31" true true true false 0)"
check "cancel first / settings apply: apply blocked (>=3s)" "$(blocked sc3)" yes
check "cancel first / settings apply: only the earlier class was updated, three cancelled classes skipped" "$(has sc3.second.out '"skipped_cancelled": 3')" yes
check "cancel first / settings apply: cancelled classes keep their settings" "$(pol 3)" "DS/package,ds/-,ds/-,ds/-"

# SC4: two applies with different values on ES-4; serialized, the later one wins every class
scenario sc4 "$(apply_sql "$O41" true true true false 12)" "$(apply_sql "$O41" false false false true 0)"
check "two applies: second blocked (>=3s)" "$(blocked sc4)" yes
check "two applies: the later apply won every class (uniform)" "$(pol 4)" "ds/membership,ds/membership,ds/membership,ds/membership"

# SC5: the settings apply on ES-5 holds first; a series enrollment (GC-S1D-2) waits on the series lock, then succeeds
scenario sc5 "$(apply_sql "$O51" true true true false 12)" "$(enroll_series_sql "$O51" 0)"
check "settings first / series enrollment: enrollment blocked (>=3s)" "$(blocked sc5)" yes
check "settings first / series enrollment: enrolled all four after the wait" "$(has sc5.second.out '"enrolled_count": 4')" yes
check "settings first / series enrollment: settings unchanged by the enrollment" "$(pol 5)" "DS/package,DS/package,DS/package,DS/package"

# SC6: the settings apply on ES-6 holds first; a series cancellation from occurrence 2 waits, then cancels the later classes
scenario sc6 "$(apply_sql "$O61" true true true false 12)" "$(series_cancel_sql "$O62" 0)"
check "settings first / series cancel: cancellation blocked (>=3s)" "$(blocked sc6)" yes
check "settings first / series cancel: later classes cancelled after the wait" "$(val "select string_agg(a.status::text, ',' order by a.series_occurrence_index) as v from public.appointments a where a.id in ('$O61','$O62','$O63','$O64')")" "scheduled,cancelled,cancelled,cancelled"
check "settings first / series cancel: the applied settings are intact on every class" "$(pol 6)" "DS/package,DS/package,DS/package,DS/package"

# SC7: the settings apply on ES-7 holds first; a split edit from occurrence 3 waits, then splits; every class keeps the applied settings
scenario sc7 "$(apply_sql "$O71" true true true false 12)" "$(edit_sql "$O73" 02 '{"title":"ES-7 successor"}' 0)"
check "settings first / split edit: split blocked (>=3s)" "$(blocked sc7)" yes
check "settings first / split edit: the series was split into two segments" "$(val "select count(distinct a.group_class_series_id)::text as v from public.appointments a where a.id in ('$O71','$O72','$O73','$O74')")" 2
check "settings first / split edit: the applied settings are intact on every class" "$(pol 7)" "DS/package,DS/package,DS/package,DS/package"

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
