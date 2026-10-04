#!/usr/bin/env bash
# GC-S1C-5 -- real two-session concurrency harness for "This and following classes" series editing
# (edit_group_class_series_from). Run against DEV only, from the repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcsc5_concurrency.sh
# Creates committed synthetic fixtures (studio ...ef001, six 6-class series), runs the scenarios with two overlapping
# sessions each, asserts the outcome (including that the second session really blocked), and always cleans up.
#   SC1 same request id twice (double submit)        -> the second waits, then replays; one successor
#   SC2 same anchor, different edits                 -> serialized on the series lock; the later one edits in place
#   SC3 different anchors in one series              -> serialized; the later anchor is found in the successor; chain of three
#   SC4 enrollment first vs capacity-lowering edit   -> the edit waits, then is refused by the capacity floor, nothing changed
#   SC5 single cancellation first vs edit            -> the edit waits, leaves the cancelled class cancelled and unedited
#   SC6 terminal attendance first vs edit            -> the edit waits, then preserves the class that gained attendance
#   SC7 series edit (split) first vs series cancel   -> the cancel waits, then cancels the successor's classes too
#   SC8 series cancel first vs edit                  -> the edit waits, then is refused (series cancelled), nothing edited
set -u
T="${TMPDIR:-/tmp}/gcsc5-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000000ef001; OWN=00000000-0000-0000-0000-0000000ef101; INS=00000000-0000-0000-0000-0000000ef102; IID=00000000-0000-0000-0000-0000000ef201
CL() { echo "00000000-0000-0000-0000-0000000ef30$1"; }
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
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left, (select count(*) from public.group_class_series where studio_id='$S') series_left, (select count(*) from public.group_class_series_edit_requests where studio_id='$S') ledger_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left|series_left|ledger_left"; }
trap cleanup EXIT

{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSC5 conc studio','t-gcsc5-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcsc5-conc-owner@example.test'),('$INS','t-gcsc5-conc-instr@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcsc5-conc-owner@example.test',null),('$INS','t-gcsc5-conc-instr@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$INS','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$IID','$S','$INS','Conc','Instructor',true,true);"
echo "alter table public.instructors enable trigger user;"
for n in 1 2 3; do echo "insert into public.clients (id,studio_id,first_name,last_name,status,is_independent_instructor) values ('$(CL $n)','$S','Conc','C$n','active',false);"; done
echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"
for n in 1 2 3 4 5 6; do
  echo "select public.create_group_class_series(p_studio_id=>'$S', p_client_request_id=>'00000000-0000-0000-0000-0000000ef70$n', p_title=>'CS-$n', p_description=>null, p_instructor_id=>'$IID', p_room_id=>null, p_location_name=>null, p_roster_capacity=>5, p_weekdays=>array[$n]::smallint[], p_interval_weeks=>1, p_starts_on=>(current_date+20), p_ends_on=>null, p_occurrence_count=>6, p_local_start_time=>make_time($((7 + n * 2)),0,0), p_duration_minutes=>60);"
done
echo "reset role;"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/; t; s/.*"v": *([^,}]*).*/\1/'; }
occ() { val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='CS-$1' and a.series_occurrence_index=$2"; }
# occurrence ids per series: O<series><idx>
for n in 1 2 3 4 5 6; do for i in 1 2 3 4 5 6; do eval "O${n}${i}=\$(occ $n $i)"; done; done
[ -z "$O11" ] || [ -z "$O66" ] && { echo "could not resolve occurrence ids"; exit 1; }

as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
# edit_sql <anchor> <request-suffix> <changes-json> <sleep-after> [overwrite]
edit_sql() { echo "begin; $(as_owner) select set_config('t.res', public.edit_group_class_series_from('$1','00000000-0000-0000-0000-0000000ef$2'::uuid,'$3'::jsonb,${5:-false})::text, true); reset role; select pg_sleep($4); select current_setting('t.res') as res; commit;"; }
enroll_sql() { echo "begin; $(as_owner) select public.enroll_class_attendee('$1','$(CL $2)','free_comped'); reset role; select pg_sleep($3); commit;"; }
single_cancel_sql() { echo "begin; $(as_owner) select public.cancel_group_class_appointment('$1'); reset role; select pg_sleep($2); commit;"; }
series_cancel_sql() { echo "begin; $(as_owner) select set_config('t.res', public.cancel_group_class_series_from('$1')::text, true); reset role; select pg_sleep($2); select current_setting('t.res') as res; commit;"; }
# attendance first: lock the class row, then record terminal attendance for a booked student and commit
attend_sql() { echo "begin; select 1 from public.appointments where id='$1' for update; select pg_sleep($2); insert into public.attendance_records (studio_id, appointment_id, client_id, status) values ('$S','$1','$(CL $3)','attended'); commit;"; }

scenario() { # name firstsql secondsql
  echo "$2" > "$T/$1.first.sql"; echo "$3" > "$T/$1.second.sql"
  ( run "$T/$1.first.sql" > "$T/$1.first.out" ) & p1=$!
  sleep 7
  s2=$(date +%s); run "$T/$1.second.sql" > "$T/$1.second.out"; e2=$(date +%s)
  wait $p1
  echo "$((e2 - s2))" > "$T/$1.second.elapsed"
}
# title list of one logical series by occurrence index: all occurrences whose original series title started as CS-<n>
tl() { val "select string_agg(a.title || '/' || a.status::text, ',' order by a.series_occurrence_index) as v from public.appointments a where a.studio_id='$S' and a.id in ($(for i in 1 2 3 4 5 6; do eval "printf \"'%s',\" \$O$1$i"; done | sed 's/,$//'))"; }
nseries() { val "select count(*)::text as v from public.group_class_series where studio_id='$S'"; }
chainlen() { val "select count(*)::text as v from public.group_class_series s where s.studio_id='$S' and s.id in (select group_class_series_id from public.appointments where id in ($(for i in 1 2 3 4 5 6; do eval "printf \"'%s',\" \$O$1$i"; done | sed 's/,$//')))"; }
sstatus_of() { val "select s.status as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where a.id='$1'"; }
booked() { val "select count(*)::text as v from public.appointment_attendees where appointment_id='$1' and status='booked'"; }

fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] expected [$3]"; fail=1; fi; }
has() { tr -d '\\' < "$T/$1" | grep -qE "$2" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 3 ] && echo yes || echo no; }

# SC1: same request twice; the first holds for 12s, the second waits on the request lock and replays
base1=$(nseries)
scenario sc1 "$(edit_sql "$O13" 801 '{"title":"S1 edit"}' 12)" "$(edit_sql "$O13" 801 '{"title":"S1 edit"}' 0)"
check "double-submit: second blocked (>=3s)" "$(blocked sc1)" yes
check "double-submit: second is a replay of the stored result" "$(has sc1.second.out '"replay": true')" yes
check "double-submit: exactly one successor created" "$(( $(nseries) - base1 ))" 1
check "double-submit: following classes edited once" "$(tl 1)" "CS-1/scheduled,CS-1/scheduled,S1 edit/scheduled,S1 edit/scheduled,S1 edit/scheduled,S1 edit/scheduled"

# SC2: same anchor, two DIFFERENT requests; the second waits on the series lock, then edits the successor in place
scenario sc2 "$(edit_sql "$O23" 802 '{"title":"First"}' 12)" "$(edit_sql "$O23" 803 '{"roster_capacity":7}' 0)"
check "same-anchor: second blocked (>=3s)" "$(blocked sc2)" yes
check "same-anchor: second edited in place (no extra split)" "$(has sc2.second.out '"split_created": false')" yes
check "same-anchor: two series only (original + one successor)" "$(chainlen 2)" 2
check "same-anchor: final titles" "$(tl 2)" "CS-2/scheduled,CS-2/scheduled,First/scheduled,First/scheduled,First/scheduled,First/scheduled"
check "same-anchor: final capacity from the second edit" "$(val "select string_agg(coalesce(a.roster_capacity::text,'-'), ',' order by a.series_occurrence_index) as v from public.appointments a where a.id in ('$O21','$O22','$O23','$O24','$O25','$O26')")" "5,5,7,7,7,7"

# SC3: different anchors in one series; the second anchor is found in the successor and split again (chain of three)
scenario sc3 "$(edit_sql "$O33" 804 '{"title":"Seg A"}' 12)" "$(edit_sql "$O35" 805 '{"title":"Seg B"}' 0)"
check "different-anchors: second blocked (>=3s)" "$(blocked sc3)" yes
check "different-anchors: second split the successor" "$(has sc3.second.out '"split_created": true')" yes
check "different-anchors: chain of three series" "$(chainlen 3)" 3
check "different-anchors: final titles" "$(tl 3)" "CS-3/scheduled,CS-3/scheduled,Seg A/scheduled,Seg A/scheduled,Seg B/scheduled,Seg B/scheduled"
check "different-anchors: no series has two successors" "$(val "select count(*)::text as v from (select split_from_series_id from public.group_class_series where studio_id='$S' and split_from_series_id is not null group by 1 having count(*) > 1) x")" 0

# SC4: an enrollment holds occurrence 3 of CS-4; the capacity-lowering edit waits, then is refused by the floor
echo "update public.appointments set roster_capacity = 2 where id in ('$O43','$O44','$O45','$O46')" > "$T/cap.sql"; run "$T/cap.sql" | grep ERROR
echo "insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$O43','$(CL 1)','booked','staff','free_comped');" > "$T/seed.sql"; run "$T/seed.sql" | grep ERROR
scenario sc4 "$(enroll_sql "$O43" 2 12)" "$(edit_sql "$O43" 806 '{"roster_capacity":1}' 0)"
check "enrollment-first/edit: edit blocked (>=3s)" "$(blocked sc4)" yes
check "enrollment-first/edit: edit refused by the capacity floor" "$(has sc4.second.out GCSC3_CAPACITY_BELOW_BOOKED)" yes
check "enrollment-first/edit: nothing split or edited" "$(chainlen 4)/$(val "select string_agg(coalesce(a.roster_capacity::text,'-'), ',' order by a.series_occurrence_index) as v from public.appointments a where a.id in ('$O43','$O44','$O45','$O46')")/$(booked "$O43")" "1/2,2,2,2/2"

# SC5: a single cancellation of occurrence 5 (CS-5) holds; the edit from occurrence 3 waits, then leaves occurrence 5 cancelled and unedited
scenario sc5 "$(single_cancel_sql "$O55" 12)" "$(edit_sql "$O53" 807 '{"title":"S5 edit"}' 0)"
check "single-cancel-first/edit: edit blocked (>=3s)" "$(blocked sc5)" yes
check "single-cancel-first/edit: cancelled class excluded from edits" "$(has sc5.second.out '"edited_class_count": 3')" yes
check "single-cancel-first/edit: final titles and status" "$(tl 5)" "CS-5/scheduled,CS-5/scheduled,S5 edit/scheduled,S5 edit/scheduled,CS-5/cancelled,S5 edit/scheduled"

# SC6: terminal attendance on occurrence 4 (CS-6) is recorded first; the edit from occurrence 3 waits, then preserves it
echo "insert into public.appointment_attendees (studio_id,appointment_id,client_id,status,source,billing_type) values ('$S','$O64','$(CL 3)','booked','staff','free_comped');" > "$T/seed6.sql"; run "$T/seed6.sql" | grep ERROR
scenario sc6 "$(attend_sql "$O64" 12 3)" "$(edit_sql "$O63" 808 '{"title":"S6 edit"}' 0)"
check "attendance-first/edit: edit blocked (>=3s)" "$(blocked sc6)" yes
check "attendance-first/edit: upcoming class that gained terminal attendance is preserved" "$(tl 6)" "CS-6/scheduled,CS-6/scheduled,S6 edit/scheduled,CS-6/scheduled,S6 edit/scheduled,S6 edit/scheduled"

# SC7: the split edit of CS-1 (anchor 5, title) holds; the series cancel from occurrence 2 waits, then cancels the successor's classes too
scenario sc7 "$(edit_sql "$O15" 809 '{"title":"Late split"}' 12)" "$(series_cancel_sql "$O12" 0)"
check "split-first/series-cancel: cancel blocked (>=3s)" "$(blocked sc7)" yes
check "split-first/series-cancel: cancelled the classes moved to the successor too" "$(has sc7.second.out '"cancelled_class_count": 5')" yes
check "split-first/series-cancel: classes 2..6 cancelled, class 1 untouched" "$(val "select string_agg(a.status::text, ',' order by a.series_occurrence_index) as v from public.appointments a where a.id in ('$O11','$O12','$O13','$O14','$O15','$O16')")" "scheduled,cancelled,cancelled,cancelled,cancelled,cancelled"
check "split-first/series-cancel: predecessor active (class 1 upcoming), successor cancelled" "$(sstatus_of "$O11")/$(sstatus_of "$O16")" "active/cancelled"

# SC8: a series cancel of CS-2 (from occurrence 2) holds; the edit from occurrence 3 waits, then is refused (cancelled series / class)
scenario sc8 "$(series_cancel_sql "$O22" 12)" "$(edit_sql "$O25" 810 '{"title":"too late"}' 0)"
check "series-cancel-first/edit: edit blocked (>=3s)" "$(blocked sc8)" yes
check "series-cancel-first/edit: refused" "$(has sc8.second.out 'GCSC5_(SERIES_NOT_EDITABLE|ANCHOR_NOT_EDITABLE)')" yes
check "series-cancel-first/edit: nothing edited" "$(val "select count(*)::text as v from public.appointments a where a.id in ('$O21','$O22','$O23','$O24','$O25','$O26') and a.title = 'too late'")" 0

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
