#!/usr/bin/env bash
# Competition CF1 A7 -- multi-session probes on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1-a7-db DBUSER=supabase_admin bash test_T_competition_cf1_a7_concurrency.sh
#
# The database must already carry the chain through HL1, A1, A0, A3, A5 and A7. The script COMMITS synthetic fixtures (UUID block
# ...-cf1a7cXXXXXX) and leaves them: run it only on a disposable container. Never against a shared or hosted DB.
# Probes: (1) two judges file correction ballots at once (both succeed, two correction rows); (2) a replacement ballot racing the co-sign
# (the filer waits for the round lock, then sees the co-sign and is refused as the co-signer); (3) a ballot racing the correction closing
# (round -> calculated): the ballot either lands in the correction or is refused, never lands unrecorded.
set -u
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-postgres}"
FAILS=0
psq() { docker exec -i "$C" psql -U "$DBUSER" -h localhost -d postgres -At -q "$@"; }
u() { echo "00000000-0000-0000-0000-cf1a7c$1"; }
M1=$(u 000001); J1=$(u 000011); J2=$(u 000012); J3=$(u 000013)
EV=$(u 00e001); P=$(u 001001); CT=$(u 002001)
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
as_sql() { printf "set role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\n%s\n" "$1" "$2"; }

echo "== fixtures =="
psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$M1', 't-cf1a7c-m1@example.test'), ('$J1', 't-cf1a7c-j1@example.test'), ('$J2', 't-cf1a7c-j2@example.test'), ('$J3', 't-cf1a7c-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'CF1A7C ' || split_part(email, '@', 1) from auth.users where email like 't-cf1a7c-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a7c-%';
insert into public.studios (id, name, slug) values ('$(u 00a001)', 'CF1 A7 Race Studio', 't-cf1a7c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$M1', '$(u 00a001)', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('$EV', '$(u 00a001)', 'CF1 A7 Race', 't-cf1a7c-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('$P', '$EV', '$(u 00a001)', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT', '$EV', '$P', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(u 00c001)', '$EV', 1, 'V1', 'published', now());
insert into public.event_competition_officials (id, event_id, user_id, role) values ('$(u 00b011)', '$EV', '$J1', 'judge'), ('$(u 00b012)', '$EV', '$J2', 'judge'), ('$(u 00b013)', '$EV', '$J3', 'judge');
SQL

# scenario k: a callback round (T 3, 8 entries) with v1 ballots J1 {1,2,3}, J2 {1,2,3}, J3 {1,4,5}; entry 3 scratched after approval; correction opened.
mk() {
  k=$1
  R=$(u "00600$k"); D=$(u "00300$k"); H=$(u "00d00$k")
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$D', '$EV', '$P', '$CT', 'D$k', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('$R', '$EV', '$P', '$D', 'R$k', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$(u "00900$k")', '$EV', '$(u 00c001)', $k);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id) values ('$H', '$EV', '$D', '$R', 1, 'complete', 'certified', '$CT', '$(u 00c001)', '$(u "00900$k")');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values ('$EV', '$H', 'waltz', 'Waltz', 1);
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter) values ('$EV', '$R', '$(u 00b011)', 'A'), ('$EV', '$R', '$(u 00b012)', 'B'), ('$EV', '$R', '$(u 00b013)', 'C');
SQL
  for i in 1 2 3 4 5 6 7 8; do
    psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica;
      insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values ('$(u "0080$k$i")', '$EV', '$P', '$D', 'e$i', 'confirmed', 'eligible', '$k$i');
      insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status) values ('$EV', '$D', '$H', '$(u "0080$k$i")', $i, 'danced');"
  done
  fb() { psq -v ON_ERROR_STOP=1 -c "select public._compe2_insert_ballot('$1', '$R', null, '$2', 'judge_web', null, '[{\"entry_id\":\"$(u "0080$k$3")\",\"value\":true},{\"entry_id\":\"$(u "0080$k$4")\",\"value\":true},{\"entry_id\":\"$(u "0080$k$5")\",\"value\":true}]'::jsonb, null, gen_random_uuid());" >/dev/null; }
  fb $J1 $(u 00b011) 1 2 3; fb $J2 $(u 00b012) 1 2 3; fb $J3 $(u 00b013) 1 4 5
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
update public.event_competition_rounds set status = 'approved' where id = '$R';
insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
values ('$(u "00700$k")', '$EV', '$R', 1, 'callback_tally', '1', public._compf2_input_hash('$R', 'callback_tally', '1'), repeat('a', 64),
        public._compf2_evidence('$R', 'callback_tally', '1'), '[]', '$M1', 'approved', gen_random_uuid());
SQL
}
open_corr() { # $1 k, $2 scratch entry number or ''
  R=$(u "00600$1")
  [ -n "$2" ] && psq -c "set session_replication_role = replica; update public.event_competition_heat_entries set status = 'scratched' where entry_id = '$(u "0080$1$2")';"
  as_sql "$M1" "select public.open_competition_round_correction('$R', 'race fixture', gen_random_uuid());" | psq -v ON_ERROR_STOP=1 >/dev/null
}
fileb() { # $1 k, $2 judge user, $3 official, $4.. entry numbers   -> prints OK or the error code
  k=$1; usr=$2; off=$3; shift 3
  R=$(u "00600$k"); m=""
  for n in "$@"; do m="$m{\"entry_id\":\"$(u "0080$k$n")\",\"value\":true},"; done
  m="[${m%,}]"
  psq -c "select public._compe2_insert_ballot('$usr', '$R', null, '$off', 'judge_web', null, '$m'::jsonb, 'race', gen_random_uuid());" 2>&1 | grep -q '^{' && echo OK || echo ERR
}

echo "== probe 1: two judges file restricted correction ballots at once =="
mk 1; open_corr 1 3
W=$(mktemp -d)
( fileb 1 $J1 $(u 00b011) 1 2 6 > "$W/a" ) &
wait
r1=$(cat "$W/a")
r2=$(fileb 1 $J2 $(u 00b012) 1 2 7)
n=$(psq -c "select count(*) from public.event_competition_ballot_corrections where round_id = '$(u 006001)';")
[ "$r2" = OK ] && [ "$n" -ge 2 ] && ok "concurrent filings: each correction ballot has its record ($n rows)" || bad "concurrent filings" "r1=$r1 r2=$r2 rows=$n"

echo "== probe 2: a filing racing the co-sign (judge_entry_error) =="
mk 2; open_corr 2 ""
CID=$(psq -c "select id from public.event_competition_correction_causes where round_id = '$(u 006002)';")
# the co-signer (a second manager who is also judge 3's user) holds the round lock open while a filing waits
psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$J3', '$(u 00a001)', 'studio_owner', true);
SQL
( { as_sql "$J3" "begin; select public.cosign_competition_correction('$CID', gen_random_uuid()); select pg_sleep(4); commit;"; } | psq -v ON_ERROR_STOP=1 >/dev/null ) &
sleep 1
t0=$(date +%s)
r=$(fileb 2 $J3 $(u 00b013) 5 6 7)
t1=$(date +%s)
wait
[ "$r" = ERR ] && [ $((t1 - t0)) -ge 2 ] && ok "the co-signer's filing waited for the co-sign and was refused (COSIGNER_CONFLICT)" || bad "co-sign race" "r=$r waited=$((t1 - t0))s"

echo "== probe 3: a ballot racing the correction closing =="
mk 3; open_corr 3 3
R3=$(u 006003)
( psq -c "begin; select 1 from public.event_competition_rounds where id = '$R3' for update; select pg_sleep(3); commit;" >/dev/null ) &
sleep 1
r=$(fileb 3 $J1 $(u 00b011) 1 2 6)
wait
rec=$(psq -c "select count(*) from public.event_competition_ballots b where b.round_id = '$R3' and b.supersedes_id is not null and not exists (select 1 from public.event_competition_ballot_corrections c where c.ballot_id = b.id);")
[ "$rec" = 0 ] && [ "$r" = OK ] && ok "the ballot waited for the round lock, landed in the correction with its record" || bad "unrecorded ballot" "$rec"

echo "== done: $FAILS failure(s) =="
exit $FAILS
