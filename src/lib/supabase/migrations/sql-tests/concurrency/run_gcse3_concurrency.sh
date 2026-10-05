#!/usr/bin/env bash
# GC-S1E-3 -- real two-session concurrency harness for group-class conflict authority. Run against DEV only, from the
# repo root:
#   bash src/lib/supabase/migrations/sql-tests/concurrency/run_gcse3_concurrency.sh
# Creates committed synthetic fixtures (studio ...e5e40001), runs each scenario with two overlapping sessions (the first
# holds its transaction open for 12s after writing, the second starts 7s in), asserts the outcome and whether the second
# session really waited, and always cleans up.
#   SC1  create vs create, same instructor/time           -> second waits, then is refused (instructor); one class exists
#   SC2  create vs single edit onto that instructor/time  -> edit waits, then is refused; the edited class is unchanged
#   SC3  single edit vs single edit onto the same slot     -> second waits, then is refused
#   SC4  S1C-5 series edit vs one-time create              -> create waits, then is refused
#   SC4b S1C-5 series edit vs series create                -> series create waits, then is refused (nothing written)
#   SC5a create vs create, full room (capacity 1)          -> second waits, then is refused (room_busy)
#   SC5b create vs single edit moving a class into the room-> edit waits, then is refused (room_busy)
#   SC6  unrelated instructor and room, same time          -> second does NOT wait and succeeds
#   SC7  edit A: I1 -> I2 vs edit B: I2 -> I1 (no conflict) -> second waits (same lock set, same order), both succeed, no deadlock
#   SC8  P4 membership lock helper vs class create          -> create waits on the shared instructor row lock, then succeeds
set -u
T="${TMPDIR:-/tmp}/gcse3-conc"; mkdir -p "$T"
S=00000000-0000-0000-0000-0000e5e40001; OWN=00000000-0000-0000-0000-0000e5e41001
U1=00000000-0000-0000-0000-0000e5e41003; U2=00000000-0000-0000-0000-0000e5e41004; U3=00000000-0000-0000-0000-0000e5e41005
I1=00000000-0000-0000-0000-0000e5e42001; I2=00000000-0000-0000-0000-0000e5e42002; I3=00000000-0000-0000-0000-0000e5e42003
R2=00000000-0000-0000-0000-0000e5e49002; R3=00000000-0000-0000-0000-0000e5e49003
run() { supabase db query --linked -f "$1" 2>&1; }

cleanup() { cat > "$T/cleanup.sql" <<SQL
begin;
delete from public.group_class_series_edit_requests where studio_id='$S';
delete from public.group_class_enrollment_policies where appointment_id in (select id from public.appointments where studio_id='$S');
delete from public.appointments where studio_id='$S';
update public.group_class_series set split_from_series_id = null where studio_id='$S';
delete from public.group_class_series where studio_id='$S';
delete from public.instructors where studio_id='$S';
delete from public.rooms where studio_id='$S';
delete from public.user_studio_roles where studio_id='$S';
delete from public.profiles where id in ('$OWN','$U1','$U2','$U3');
delete from auth.users where id in ('$OWN','$U1','$U2','$U3');
delete from public.studios where id='$S';
commit;
select (select count(*) from public.studios where id='$S') studios_left, (select count(*) from public.appointments where studio_id='$S') appts_left, (select count(*) from public.group_class_series where studio_id='$S') series_left;
SQL
run "$T/cleanup.sql" | grep -E "ERROR|studios_left|appts_left|series_left"; }
trap cleanup EXIT

D="(current_date + 50)"
at() { echo "(($D + $1)::text || ' $2')::timestamp at time zone 'UTC'"; }   # at <day offset> <HH:MI>
as_owner() { echo "select set_config('request.jwt.claims', json_build_object('sub','$OWN')::text, true); set local role authenticated;"; }
mk() { echo "public.create_group_class_appointment('$S', $1, $2, '$3', $(at $4 $5), $(at $4 $6))"; }   # mk <ins> <room> <title> <day> <from> <to>
series() { echo "public.create_group_class_series(p_studio_id=>'$S', p_client_request_id=>'$1', p_title=>'$2', p_description=>null, p_instructor_id=>$3, p_room_id=>null, p_location_name=>null, p_roster_capacity=>null, p_weekdays=>array[$4]::smallint[], p_interval_weeks=>1, p_starts_on=>(current_date+60), p_ends_on=>null, p_occurrence_count=>$5, p_local_start_time=>make_time(7,0,0), p_duration_minutes=>60)"; }

{
echo "begin;"
echo "insert into public.studios (id,name,slug,timezone) values ('$S','GCSE3 conc studio','t-gcse3-conc','America/New_York');"
echo "insert into auth.users (id,email) values ('$OWN','t-gcse3-conc-owner@example.test'),('$U1','t-gcse3-conc-i1@example.test'),('$U2','t-gcse3-conc-i2@example.test'),('$U3','t-gcse3-conc-i3@example.test');"
echo "insert into public.profiles (id,email,platform_role) values ('$OWN','t-gcse3-conc-owner@example.test',null),('$U1','t-gcse3-conc-i1@example.test',null),('$U2','t-gcse3-conc-i2@example.test',null),('$U3','t-gcse3-conc-i3@example.test',null);"
echo "insert into public.user_studio_roles (user_id,studio_id,role,active) values ('$OWN','$S','studio_owner',true),('$U1','$S','instructor',true),('$U2','$S','instructor',true),('$U3','$S','instructor',true);"
echo "alter table public.instructors disable trigger user;"
echo "insert into public.instructors (id,studio_id,user_id,first_name,last_name,active,can_instruct) values ('$I1','$S','$U1','Conc','One',true,true),('$I2','$S','$U2','Conc','Two',true,true),('$I3','$S','$U3','Conc','Three',true,true);"
echo "alter table public.instructors enable trigger user;"
echo "insert into public.rooms (id,studio_id,name,active,max_simultaneous_bookings) values ('$R2','$S','Conc open room',true,null),('$R3','$S','Conc single room',true,1);"
echo "$(as_owner)"
echo "select $(mk "'$I2'" null X2 0 08:00 09:00);"
echo "select $(mk "'$I2'" null Y3 0 06:00 07:00);"
echo "select $(mk "'$I3'" null Z3 0 06:00 07:00);"
echo "select $(mk null "'$R2'" W5 0 20:00 21:00);"
echo "select $(mk "'$I1'" null P7 1 08:00 09:00);"
echo "select $(mk "'$I2'" null Q7 1 10:00 11:00);"
echo "select $(series 00000000-0000-0000-0000-0000e5e47001 SER4 "'$I2'" 3 3);"
echo "select $(series 00000000-0000-0000-0000-0000e5e47002 SER5 "'$I2'" 4 3);"
echo "reset role;"
echo "commit;"
} > "$T/fixture.sql"
run "$T/fixture.sql" | grep -E "ERROR" && { echo "fixture failed"; exit 1; }

val() { echo "$1" > "$T/v.sql"; run "$T/v.sql" | grep -E '"v"' | head -1 | sed -E 's/.*"v": *"([^"]*)".*/\1/; t; s/.*"v": *([^,}]*).*/\1/'; }
cid() { val "select id::text as v from public.appointments where studio_id='$S' and title='$1'"; }
X2=$(cid X2); Y3=$(cid Y3); Z3=$(cid Z3); W5=$(cid W5); P7=$(cid P7); Q7=$(cid Q7)
SER4_1=$(val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='SER4' and a.series_occurrence_index=1")
SER4_2_AT=$(val "select a.starts_at::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='SER4' and a.series_occurrence_index=2")
SER5_1=$(val "select a.id::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='SER5' and a.series_occurrence_index=1")
[ -z "$X2" ] || [ -z "$Q7" ] || [ -z "$SER4_1" ] || [ -z "$SER4_2_AT" ] || [ -z "$SER5_1" ] && { echo "could not resolve fixture ids"; exit 1; }

hold() { echo "reset role; select pg_sleep($1);"; }
create_sql() { echo "begin; $(as_owner) select $(mk "$1" "$2" "$3" "$4" "$5" "$6") as created; $(hold "$7") commit;"; }
edit_sql() { echo "begin; $(as_owner) update public.appointments set instructor_id=$2, room_id=$3, starts_at=$(at "$4" "$5"), ends_at=$(at "$4" "$6") where id='$1'; $(hold "$7") commit; select 'edit-committed' as edited;"; }
s1c5_sql() { echo "begin; $(as_owner) select public.edit_group_class_series_from('$1','$2'::uuid,'$3'::jsonb,false) as series_edit; $(hold "$4") commit;"; }
series_sql() { echo "begin; $(as_owner) select $(series "$1" "$2" "$3" "$4" "$5") as series_created; $(hold 0) commit;"; }
p4_sql() { echo "begin; select public._lock_and_check_scheduling_resources('$S', '$1', null, $(at 3 06:00), $(at 3 07:00), null); select pg_sleep($2); commit;"; }

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
has() { tr -d '\\' < "$T/$1" | grep -qE "$2" && echo yes || echo no; }
blocked() { [ "$(cat "$T/$1.second.elapsed")" -ge 4 ] && echo yes || echo no; }
count() { val "select count(*)::text as v from public.appointments where studio_id='$S' and status='scheduled' and $1"; }

# SC1: two creates for I1 at the same time
scenario sc1 "$(create_sql "'$I1'" null SC1a 0 10:00 11:00 12)" "$(create_sql "'$I1'" null SC1b 0 10:00 11:00 0)"
check "SC1 create vs create: first committed" "$(count "title='SC1a'")" 1
check "SC1 create vs create: second waited (>=4s)" "$(blocked sc1)" yes
check "SC1 create vs create: second refused (instructor)" "$(has sc1.second.out 'GCSE3_CONFLICT: reason=instructor')" yes
check "SC1 create vs create: exactly one class in the slot" "$(count "instructor_id='$I1' and starts_at < $(at 0 11:00) and ends_at > $(at 0 10:00)")" 1

# SC2: create I1 12:00-13:00 vs editing X2 onto I1 12:30-13:30
scenario sc2 "$(create_sql "'$I1'" null SC2 0 12:00 13:00 12)" "$(edit_sql "$X2" "'$I1'" null 0 12:30 13:30 0)"
check "SC2 create vs edit: edit waited (>=4s)" "$(blocked sc2)" yes
check "SC2 create vs edit: edit refused (instructor)" "$(has sc2.second.out 'GCSE3_CONFLICT: reason=instructor')" yes
check "SC2 create vs edit: edited class unchanged" "$(val "select (instructor_id='$I2' and starts_at=$(at 0 08:00))::text as v from public.appointments where id='$X2'")" true

# SC3: edit Y3 onto I1 14:00-15:00 vs edit Z3 onto I1 14:30-15:30
scenario sc3 "$(edit_sql "$Y3" "'$I1'" null 0 14:00 15:00 12)" "$(edit_sql "$Z3" "'$I1'" null 0 14:30 15:30 0)"
check "SC3 edit vs edit: first committed" "$(val "select (instructor_id='$I1')::text as v from public.appointments where id='$Y3'")" true
check "SC3 edit vs edit: second waited (>=4s)" "$(blocked sc3)" yes
check "SC3 edit vs edit: second refused (instructor)" "$(has sc3.second.out 'GCSE3_CONFLICT: reason=instructor')" yes
check "SC3 edit vs edit: second class unchanged" "$(val "select (instructor_id='$I3' and starts_at=$(at 0 06:00))::text as v from public.appointments where id='$Z3'")" true

# SC4: S1C-5 moves SER4 (all occurrences) to I1; a one-time I1 class at SER4 occurrence 2's time
scenario sc4 "$(s1c5_sql "$SER4_1" 00000000-0000-0000-0000-0000e5e48001 "{\"instructor_id\":\"$I1\"}" 12)" \
  "begin; $(as_owner) select public.create_group_class_appointment('$S', '$I1', null, 'SC4', '$SER4_2_AT'::timestamptz, '$SER4_2_AT'::timestamptz + interval '1 hour') as created; reset role; commit;"
check "SC4 series edit vs create: series edit committed (every SER4 class on I1)" "$(val "select count(*)::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='SER4' and a.instructor_id='$I1'")" 3
check "SC4 series edit vs create: create waited (>=4s)" "$(blocked sc4)" yes
check "SC4 series edit vs create: create refused (instructor)" "$(has sc4.second.out 'GCSE3_CONFLICT: reason=instructor')" yes

# SC4b: S1C-5 moves SER5 to I3; a new I3 series on the same weekday and time
scenario sc4b "$(s1c5_sql "$SER5_1" 00000000-0000-0000-0000-0000e5e48002 "{\"instructor_id\":\"$I3\"}" 12)" \
  "$(series_sql 00000000-0000-0000-0000-0000e5e47003 SER6 "'$I3'" 4 3)"
check "SC4b series edit vs series create: series edit committed (every SER5 class on I3)" "$(val "select count(*)::text as v from public.appointments a join public.group_class_series s on s.id=a.group_class_series_id where s.studio_id='$S' and s.title='SER5' and a.instructor_id='$I3'")" 3
check "SC4b series edit vs series create: series create waited (>=4s)" "$(blocked sc4b)" yes
check "SC4b series edit vs series create: series create refused (instructor)" "$(has sc4b.second.out 'GCSE3_CONFLICT: reason=instructor index=1 count=3')" yes
check "SC4b series edit vs series create: nothing written for the refused series" "$(val "select count(*)::text as v from public.group_class_series where studio_id='$S' and title='SER6'")" 0

# SC5a: two classes in the capacity-1 room
scenario sc5a "$(create_sql null "'$R3'" SC5a1 0 16:00 17:00 12)" "$(create_sql null "'$R3'" SC5a2 0 16:30 17:30 0)"
check "SC5a room create vs create: second waited (>=4s)" "$(blocked sc5a)" yes
check "SC5a room create vs create: second refused (room_busy)" "$(has sc5a.second.out 'GCSE3_CONFLICT: reason=room_busy')" yes
check "SC5a room create vs create: one class in the room" "$(count "room_id='$R3' and starts_at < $(at 0 17:30) and ends_at > $(at 0 16:00)")" 1

# SC5b: create in the capacity-1 room vs moving W5 into it
scenario sc5b "$(create_sql null "'$R3'" SC5b 0 18:00 19:00 12)" "$(edit_sql "$W5" null "'$R3'" 0 18:00 19:00 0)"
check "SC5b room create vs edit: edit waited (>=4s)" "$(blocked sc5b)" yes
check "SC5b room create vs edit: edit refused (room_busy)" "$(has sc5b.second.out 'GCSE3_CONFLICT: reason=room_busy')" yes
check "SC5b room create vs edit: moved class unchanged" "$(val "select (room_id='$R2')::text as v from public.appointments where id='$W5'")" true

# SC6: unrelated instructor and room at the same time do not wait on each other
scenario sc6 "$(create_sql "'$I1'" null SC6a 0 20:00 21:00 12)" "$(create_sql "'$I2'" "'$R3'" SC6b 0 20:00 21:00 0)"
check "SC6 unrelated: second did not wait (<4s)" "$(blocked sc6)" no
check "SC6 unrelated: both committed" "$(count "title in ('SC6a','SC6b')")" 2

# SC7: opposite moves between I1 and I2 (no conflict) lock {I1, I2} in the same order
scenario sc7 "$(edit_sql "$P7" "'$I2'" null 1 12:00 13:00 12)" "$(edit_sql "$Q7" "'$I1'" null 1 14:00 15:00 0)"
check "SC7 opposite moves: second waited (>=4s)" "$(blocked sc7)" yes
check "SC7 opposite moves: both committed" "$(val "select ((select instructor_id from public.appointments where id='$P7')='$I2' and (select instructor_id from public.appointments where id='$Q7')='$I1')::text as v")" true

# SC8: the existing P4 helper (membership private-lesson RPCs) and class writes share the instructor row lock
scenario sc8 "$(p4_sql "$I3" 12)" "$(create_sql "'$I3'" null SC8 0 22:00 23:00 0)"
check "SC8 P4 lock vs create: create waited on the shared instructor lock (>=4s)" "$(blocked sc8)" yes
check "SC8 P4 lock vs create: create then committed" "$(count "title='SC8'")" 1
# SC8b: the reverse: a class create holds I3; the P4 lock-and-check for the same slot waits, then sees the class and refuses
scenario sc8b "$(create_sql "'$I3'" null SC8b 3 06:00 07:00 12)" "$(p4_sql "$I3" 0)"
check "SC8b create vs P4 lock-and-check: P4 waited (>=4s)" "$(blocked sc8b)" yes
check "SC8b create vs P4 lock-and-check: P4 refused after the class committed" "$(has sc8b.second.out 'not available at the requested time')" yes

check "no deadlock or lock timeout in any session" "$(cat "$T"/*.out | grep -ciE 'deadlock|lock timeout|could not obtain lock')" 0
exit $fail
