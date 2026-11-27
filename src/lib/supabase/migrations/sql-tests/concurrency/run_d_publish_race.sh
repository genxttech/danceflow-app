#!/usr/bin/env bash
# Competition Option D -- two-connection races between publication of a draft running order and a manager's write against that order.
# LOCAL DISPOSABLE QA DATABASE ONLY (fixtures COMMIT and are not removed: discard the container). Usage: bash run_d_publish_race.sh <container>
#   R1 publication in flight, then INSERT of a heat into that version (version column)            -> waits, then refused
#   R2 publication in flight, then INSERT of a heat with no version under its floor heat          -> refused
#   R3 publication in flight, then round change of a heat of that version                         -> waits, then refused
#   R5 publication in flight, then a direct heat ENTRY insert (an entry never cleared)           -> waits, then refused
#   R6 publication in flight, then move_competition_scoring_heat (SECURITY DEFINER draft writer) -> waits, then refused
#   R7 publication in flight, then a schedule SESSION insert (advanced-mode order content)     -> waits, then refused
#   R4 a draft heat write in flight, then publication -> publication waits for it and then succeeds
# "Waits" is observed in the database (pg_stat_activity wait_event_type = 'Lock'), not from elapsed time: the first connection holds its
# transaction open until it has seen the second one blocked, or gone. Fixtures keep one round per division (usable beside pilot restrictions).
# Without 20270301170000 R1-R3 are accepted (the gap). Prints "D RACES PASS (<n> checks)" or "D RACES FAIL: ..." (exit 1).
set -u
export MSYS_NO_PATHCONV=1
C="${1:?container}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUN() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
U() { printf '00000000-0000-0000-0000-d0acff%06x' "$((16#$1))"; }
MGR=$(U a0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
SU -c "insert into auth.users (id, email) values ('$MGR','t-drace@example.test');
 insert into public.profiles (id, email, full_name) values ('$MGR','t-drace@example.test','D race');
 insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at) values ('$MGR','t-drace@example.test', now(), now(), 'otp', 'web_callback', 'bound', now());
 insert into public.studios (id, name, slug) values ('$STUDIO','D Race','t-d-race');
 insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner', true);" >/dev/null || { echo "D RACES FAIL: fixtures"; exit 1; }
ids() { local n=$1; EV=$(U e$n); PG=$(U b$n); CT=$(U c$n); DV=$(U d$n); DV2=$(U 7$n); R1=$(U 1$n); R2=$(U 2$n); V=$(U f$n); FH=$(U 9$n); FH2=$(U 6$n); H=$(U 8$n); H2=$(U 5$n); EN=$(U 4$n); }
fixtures() { local n=$1
  SU -c "insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values ('$EV','$STUDIO','D race $n','t-d-race-$n','competition', current_date+30, current_date+30, 'published','public', true);
   insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values ('$PG','$EV','$STUDIO','Country','country','relative','skating','configured');
   insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT','$EV','$PG','ProAm','single_dance','pro_am','open');
   insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$DV','$EV','$PG','$CT','D','open'), ('$DV2','$EV','$PG','$CT','D2','open');
   insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values ('$R1','$EV','$PG','$DV','R1','final',1,'draft','ordinal_majority'), ('$R2','$EV','$PG','$DV2','R2','final',1,'draft','ordinal_majority');
   insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, entry_number) values ('$EN','$EV','$PG','$DV','Race entry','confirmed','1');
   insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values ('$V','$EV',1,'v1','draft');
   insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$FH','$EV','$V',1);
   insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('$H','$EV','$DV','$R1',1,'$CT','$V','$FH','scheduled');" >/dev/null
}
claims() { printf "select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, %s);" "$MGR" "$1"; }
# SQL that holds the open transaction until the session named $1 is seen blocked on a lock (WAITED) or has come and gone (NOWAIT).
observe() { cat <<SQL
do \$o\$ declare seen boolean := false; w int; l int;
begin
  for i in 1..900 loop
    perform pg_stat_clear_snapshot();
    select count(*), count(*) filter (where wait_event_type = 'Lock') into w, l from pg_stat_activity where application_name = '$1';
    if l > 0 then raise notice 'OBSERVED WAITED'; return; end if;
    if w > 0 then seen := true; elsif seen then raise notice 'OBSERVED NOWAIT'; return; end if;
    perform pg_sleep(0.1);
  end loop;
  raise notice 'OBSERVED NOTHING';
end \$o\$;
SQL
}
holding() { local i; for i in $(seq 1 60); do [ "$(SU -c "select count(*) from pg_stat_activity where application_name = '$1' and state = 'active' and query like 'do %'")" = 1 ] && return 0; sleep 1; done; return 1; }
OUT=""; SEEN=""
race() { # <n> <sql run as the manager while publication holds its transaction>
  local n=$1 sql=$2
  ( { echo "set application_name = 'd_pub_$n';"; echo "begin;"; claims true; echo "set local role authenticated;"; echo "select public.publish_competition_schedule_version('$V');"; echo "reset role;"; observe "d_w_$n"; echo "commit;"; } | SUN -v ON_ERROR_STOP=1 >"/tmp/d_pub_$n.out" 2>&1 ) &
  if ! holding "d_pub_$n"; then wait; OUT="publication never held: $(grep -m1 ERROR /tmp/d_pub_$n.out)"; SEEN=NONE; return; fi
  OUT=$({ echo "set application_name = 'd_w_$n';"; claims false; echo "set role authenticated;"; echo "select pg_sleep(2);"; echo "$sql;"; } | SUN -v ON_ERROR_STOP=1 2>&1)
  wait
  SEEN=$(grep -oE 'OBSERVED (WAITED|NOWAIT|NOTHING)' "/tmp/d_pub_$n.out" | head -1 | awk '{print $2}')
}
published() { [ "$(SU -c "select status from public.event_competition_schedule_versions where id='$V'")" = published ] && echo 1 || echo 0; }
report() { echo "$1: writer=$(echo "$OUT" | grep -qE 'ERROR|publication never held' && echo refused || echo ACCEPTED) observed=$SEEN publication=$(published) $2 $(echo "$OUT" | grep -m1 -E 'ERROR|never held' | cut -c1-180)"; }
refused() { echo "$OUT" | grep -qE "$1" && echo 1 || echo 0; }
D_ERR='COMPD_PUBLISHED_ORDER_WRITE_REFUSED|editable draft schedule'
scenario() { # <n> <label> <expect wait: yes|any> <refusal pattern> <read-back sql that must return 0> <sql>
  local n=$1 label=$2 waitx=$3 pat=$4 back=$5 sql=$6 left
  race "$n" "$sql"
  left=$(SU -c "$back")
  report "$label" "readback=$left"
  ok "$label: refused" "$(refused "$pat")"
  [ "$waitx" = yes ] && ok "$label: waited for the publication" "$([ "$SEEN" = WAITED ] && echo 1 || echo 0)"
  ok "$label: the publication itself succeeded" "$(published)"
  ok "$label: nothing entered the published order" "$([ "$left" = 0 ] && echo 1 || echo 0)"
}
prep() { ids "$1"; fixtures "$1" || { ok "$2: fixtures" 0; return 1; }; }
prep 1 R1 && scenario 1 "R1 insert into the version being published" yes "$D_ERR" "select count(*) from public.event_competition_heats where round_id='$R2'" \
  "insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('$EV','$DV2','$R2',2,'$CT','$V','$FH','scheduled')"
prep 2 R2 && scenario 2 "R2 unversioned heat under the floor heat being published" any "$D_ERR" "select count(*) from public.event_competition_heats where round_id='$R2'" \
  "insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, floor_heat_id, status) values ('$EV','$DV2','$R2',3,'$CT','$FH','scheduled')"
prep 3 R3 && scenario 3 "R3 round change of a heat being published" yes "$D_ERR" "select count(*) from public.event_competition_heats where id='$H' and round_id='$R2'" \
  "update public.event_competition_heats set round_id='$R2', division_id='$DV2' where id='$H'"
prep 5 R5 && scenario 5 "R5 entry added to a heat being published" yes "COMP10D_SCHEDULE_PUBLISHED" "select count(*) from public.event_competition_heat_entries where heat_id='$H'" \
  "insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$DV','$H','$EN',1)"
if prep 6 R6 && SU -c "insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$FH2','$EV','$V',2);
   insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('$H2','$EV','$DV2','$R2',2,'$CT','$V','$FH2','scheduled');" >/dev/null; then
  scenario 6 "R6 definer move of a heat in the order being published" yes "editable draft schedule|COMP10D_SCHEDULE_PUBLISHED" \
    "select count(*) from public.event_competition_heats where id='$H2' and floor_heat_id='$FH'" "select public.move_competition_scoring_heat('$H2','$FH')"
else ok "R6: fixtures" 0; fi
prep 7 R7 && scenario 7 "R7 session added to the order being published" yes "Only draft schedule versions may be edited" "select count(*) from public.event_competition_schedule_sessions where schedule_version_id='$V'" \
  "insert into public.event_competition_schedule_sessions (event_id, schedule_version_id, name, session_date, starts_at, ends_at) values ('$EV','$V','late', current_date+30, now() + interval '30 days', now() + interval '30 days 1 hour')"
# R4: writer first, publication second
if prep 4 R4; then
  ( { echo "set application_name = 'd_wfirst';"; echo "begin;"; claims true; echo "set local role authenticated;"; echo "update public.event_competition_heats set heat_number = 5 where id = '$H';"; echo "reset role;"; observe "d_pub_4"; echo "commit;"; } | SUN -v ON_ERROR_STOP=1 >/tmp/d_w4.out 2>&1 ) &
  if holding d_wfirst; then
    OUT=$({ echo "set application_name = 'd_pub_4';"; claims false; echo "set role authenticated;"; echo "select pg_sleep(2);"; echo "select public.publish_competition_schedule_version('$V');"; } | SUN -v ON_ERROR_STOP=1 2>&1)
  else OUT="publication never held: writer"; fi
  wait
  SEEN=$(grep -oE 'OBSERVED (WAITED|NOWAIT|NOTHING)' /tmp/d_w4.out | head -1 | awk '{print $2}')
  report "R4 publication behind a draft write" ""
  ok "R4: publication waited for the write" "$([ "$SEEN" = WAITED ] && echo 1 || echo 0)"
  ok "R4: publication then succeeded with the written heat" "$([ "$(SU -c "select v.status || ' ' || h.heat_number from public.event_competition_schedule_versions v join public.event_competition_heats h on h.schedule_version_id = v.id where v.id='$V'")" = "published 5" ] && echo 1 || echo 0)"
fi
if [ -z "$FAILS" ]; then echo "D RACES PASS ($PASS checks)"; exit 0; fi
echo "D RACES FAIL: $FAILS"; exit 1
