#!/usr/bin/env bash
# Competition Option D -- two-connection race: a manager's direct heat write against a draft running order while that order is being published.
# LOCAL DISPOSABLE QA DATABASE ONLY (fixtures COMMIT and are not removed: discard the container). Usage: bash run_d_publish_race.sh <container>
#   R1 publication in flight, then INSERT of a heat into that version (via the version column)      -> waits, then refused
#   R2 publication in flight, then INSERT of an unversioned heat under that version's floor heat    -> waits, then refused
#   R3 publication in flight, then round_id change of a heat of that version                        -> waits, then refused
#   R4 a draft heat write in flight, then publication -> publication waits for it and then succeeds
# Publication runs through publish_competition_schedule_version as the manager. Without 20270301170000 R1-R3 are accepted (the gap).
# Prints "D RACES PASS (<n> checks)" or "D RACES FAIL: ..." (exit 1).
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
scenario() { # <n> <label> <sql run as the manager while publication is in flight; placeholders are the ids below>
  local n=$1 label=$2
  local EV=$(U e$n) PG=$(U b$n) CT=$(U c$n) DV=$(U d$n) R1=$(U 1$n) R2=$(U 2$n) V=$(U f$n) FH=$(U 9$n) H=$(U 8$n)
  local sql=$3
  SU -c "insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values ('$EV','$STUDIO','D race $n','t-d-race-$n','competition', current_date+30, current_date+30, 'published','public', true);
   insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values ('$PG','$EV','$STUDIO','Country','country','relative','skating','configured');
   insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT','$EV','$PG','ProAm','single_dance','pro_am','open');
   insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$DV','$EV','$PG','$CT','D','open');
   insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values ('$R1','$EV','$PG','$DV','R1','final',1,'draft','ordinal_majority'), ('$R2','$EV','$PG','$DV','R2','final',2,'draft','ordinal_majority');
   insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values ('$V','$EV',1,'v1','draft');
   insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$FH','$EV','$V',1);
   insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('$H','$EV','$DV','$R1',1,'$CT','$V','$FH','scheduled');" >/dev/null || { ok "$label: fixtures" 0; return; }
  sql=${sql//__EV__/$EV}; sql=${sql//__DV__/$DV}; sql=${sql//__R2__/$R2}; sql=${sql//__CT__/$CT}; sql=${sql//__V__/$V}; sql=${sql//__FH__/$FH}; sql=${sql//__H__/$H}
  # connection 1: publish (superuser stands in for the publication transaction; it holds the version row for 4 s)
  ( printf "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, true); select public.publish_competition_schedule_version('%s'); select pg_sleep(5); commit;\n" "$MGR" "$V" | SUN -v ON_ERROR_STOP=1 >"/tmp/d_pub_$n.out" 2>&1 ) &
  sleep 1.5
  local start out ms
  start=$(date +%s%3N)
  out=$(printf "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, false);\n%s;\n" "$MGR" "$sql" | SUN -v ON_ERROR_STOP=1 2>&1)
  ms=$(( $(date +%s%3N) - start ))
  wait
  echo "$label: ${ms} ms: $(echo "$out" | grep -m1 -E 'ERROR' | cut -c1-200)"
  ok "$label: refused" "$(echo "$out" | grep -qE 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED|editable draft schedule' && echo 1 || echo 0)"
  ok "$label: waited for the publication" "$([ "$ms" -ge 2000 ] && echo 1 || echo 0)"
  ok "$label: the publication itself succeeded" "$([ "$(SU -c "select status from public.event_competition_schedule_versions where id='$V'")" = published ] && echo 1 || echo 0)"
}
scenario 1 "R1 insert into the version being published" "insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('__EV__','__DV__','__R2__',2,'__CT__','__V__','__FH__','scheduled')"
scenario 2 "R2 unversioned heat under the floor heat being published" "insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, floor_heat_id, status) values ('__EV__','__DV__','__R2__',3,'__CT__','__FH__','scheduled')"
scenario 3 "R3 round change of a heat being published" "update public.event_competition_heats set round_id='__R2__' where id='__H__'"
# R4: writer first, publication second
EV=$(U e4); PG=$(U b4); CT=$(U c4); DV=$(U d4); R1=$(U 14); V=$(U f4); FH=$(U 94); H=$(U 84)
SU -c "insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values ('$EV','$STUDIO','D race 4','t-d-race-4','competition', current_date+30, current_date+30, 'published','public', true);
 insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values ('$PG','$EV','$STUDIO','Country','country','relative','skating','configured');
 insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT','$EV','$PG','ProAm','single_dance','pro_am','open');
 insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$DV','$EV','$PG','$CT','D','open');
 insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values ('$R1','$EV','$PG','$DV','R1','final',1,'draft','ordinal_majority');
 insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values ('$V','$EV',1,'v1','draft');
 insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$FH','$EV','$V',1);
 insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values ('$H','$EV','$DV','$R1',1,'$CT','$V','$FH','scheduled');" >/dev/null || ok "R4: fixtures" 0
( printf "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, true); update public.event_competition_heats set heat_number = 5 where id = '%s'; select pg_sleep(5); commit;\n" "$MGR" "$H" | SUN -v ON_ERROR_STOP=1 >/tmp/d_w4.out 2>&1 ) &
sleep 1.5
start=$(date +%s%3N)
out=$(printf "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, false); select public.publish_competition_schedule_version('%s');\n" "$MGR" "$V" | SUN -v ON_ERROR_STOP=1 2>&1)
ms=$(( $(date +%s%3N) - start )); wait
echo "R4 publication behind a draft write: ${ms} ms: $(echo "$out" | grep -m1 ERROR | cut -c1-200)"
ok "R4: publication waited for the write" "$([ "$ms" -ge 2000 ] && echo 1 || echo 0)"
ok "R4: publication then succeeded with the written heat" "$([ "$(SU -c "select v.status || ' ' || h.heat_number from public.event_competition_schedule_versions v join public.event_competition_heats h on h.schedule_version_id = v.id where v.id='$V'")" = "published 5" ] && echo 1 || echo 0)"
if [ -z "$FAILS" ]; then echo "D RACES PASS ($PASS checks)"; exit 0; fi
echo "D RACES FAIL: $FAILS"; exit 1
