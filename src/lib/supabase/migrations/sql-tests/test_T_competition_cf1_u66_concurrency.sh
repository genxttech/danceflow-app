#!/usr/bin/env bash
# Competition CF1 U66 -- multi-session probes for the correction recovery path on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1f3u-pg DBUSER=supabase_admin bash test_T_competition_cf1_u66_concurrency.sh
#
# The database must already carry the chain through CF1 A7, U66 (20270120103000) and, for probes 4a / 4b, F3 (20270122090000; those probes are skipped as
# BLOCKED when the publication table is absent). The script COMMITS synthetic fixtures (UUID block ...-<run tag>XXXXXX, a random 6-hex tag per run) and
# leaves them: run it only on a disposable container. Never against a shared or hosted DB.
# Every race is deterministic: session A holds the round row lock inside an open transaction (pg_sleep), session B starts after A has the lock and must wait.
#   1a  recovery vs recovery, same request id                          -> one cancellation + one exclusion row; the second replays
#   1b  recovery vs recovery, different request ids                    -> one wins; the loser is refused (COMP_CORRECTION_NOT_OPEN); one audit row
#   2a  replacement ballot first, then recovery                        -> recovery refused (replacement_ballot); correction still open
#   2b  recovery first, then a replacement ballot                      -> the ballot waits and is refused (round no longer in a correction); no unrecorded ballot
#   3a  co-sign first, then recovery                                   -> recovery refused (cosign)
#   3b  recovery first, then co-sign                                   -> co-sign refused (COMP_CORRECTION_NOT_OPEN); no co-sign row
#   4a  recovery first, then publish                                   -> publish refused (round not approved); no publication row           (needs F3)
#   4b  publication withdraw first, then recovery                      -> recovery succeeds after the withdraw commits; publication row kept   (needs F3)
#   5   recovery vs the plain A5 exclusion request (the old route)     -> the plain request is refused (A7 guard) until the recovery commits; exactly one open request row
set -u
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-postgres}"
FAILS=0; SKIPS=0
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
psq() { docker exec -i "$C" psql -U "$DBUSER" -h localhost -d postgres -At -q "$@"; }
q() { psq -c "$1"; }
TAG=$(printf '%06x' $(( (RANDOM * 32768 + RANDOM) % 16777216 )))
u() { echo "00000000-0000-0000-0000-$TAG$1"; }
M1=$(u 000001); M2=$(u 000002); J1=$(u 000011); J2=$(u 000012); J3=$(u 000013)
EV=$(u 00e001); ST=$(u 00a001); P=$(u 001001); CT=$(u 002001)
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
skip() { echo "BLOCKED  $1  ($2)"; SKIPS=$((SKIPS + 1)); }
as_sql() { printf "set role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\n%s\n" "$1" "$2"; }
hold() { { as_sql "$1" "begin;"; echo "$2"; echo "select pg_sleep($3);"; echo "commit;"; } | psq -v ON_ERROR_STOP=0 2>&1; }
run() { as_sql "$1" "$2" | psq -v ON_ERROR_STOP=0 2>&1; }

echo "== fixtures =="
psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$M1', 't-$TAG-m1@example.test'), ('$M2', 't-$TAG-m2@example.test'), ('$J1', 't-$TAG-j1@example.test'), ('$J2', 't-$TAG-j2@example.test'), ('$J3', 't-$TAG-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'CF1U66C ' || split_part(email, '@', 1) from auth.users where email like 't-$TAG-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-$TAG-%';
insert into public.studios (id, name, slug) values ('$ST', 'CF1 U66 Race Studio', 't-$TAG-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$M1', '$ST', 'studio_owner', true), ('$M2', '$ST', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('$EV', '$ST', 'CF1 U66 Race', 't-$TAG-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('$P', '$EV', '$ST', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT', '$EV', '$P', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(u 00c001)', '$EV', 1, 'V1', 'published', now());
insert into public.event_competition_officials (id, event_id, user_id, role) values ('$(u 00b011)', '$EV', '$J1', 'judge'), ('$(u 00b012)', '$EV', '$J2', 'judge'), ('$(u 00b013)', '$EV', '$J3', 'judge');
SQL

# mk K [published]: a callback round (T 3, 8 entries), v1 ballots J1 {1,2,3}, J2 {1,2,3}, J3 {1,4,5}, approved version 1; entry 5 becomes ineligible. Status approved
# (or published when asked, with the correction then opened from it).
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
  [ "${2:-}" = published ] && psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'published' where id = '$R';"
  return 0
}
# open_corr K [scratch entry number]: the manager M1 opens the correction (a scratched entry makes it an entry_exclusion correction); entry 5 then turns ineligible
open_corr() {
  R=$(u "00600$1")
  [ -n "${2:-}" ] && psq -c "set session_replication_role = replica; update public.event_competition_heat_entries set status = 'scratched' where entry_id = '$(u "0080$1$2")';" >/dev/null
  as_sql "$M1" "select public.open_competition_round_correction('$R', 'race fixture', gen_random_uuid());" | psq -v ON_ERROR_STOP=1 >/dev/null
  psq -c "set session_replication_role = replica; update public.event_competition_entries set eligibility_status = 'ineligible' where id = '$(u "0080${1}5")';" >/dev/null
}
REC() { echo "select public.recover_correction_for_exclusion('$(u "00600$1")', '$(u "0080${1}5")', 'ineligible', 'race recover', '$2');"; }
fileb() { # $1 k, $2 judge user, $3 official, $4.. entry numbers -> prints OK or ERR:<first line>
  k=$1; usr=$2; off=$3; shift 3
  R=$(u "00600$k"); m=""
  for n in "$@"; do m="$m{\"entry_id\":\"$(u "0080$k$n")\",\"value\":true},"; done
  m="[${m%,}]"
  o=$(psq -c "select public._compe2_insert_ballot('$usr', '$R', null, '$off', 'judge_web', null, '$m'::jsonb, 'race', gen_random_uuid());" 2>&1)
  echo "$o" | grep -q '^{' && echo OK || echo "ERR:$(echo "$o" | head -1 | cut -c1-120)"
}
rs() { q "select status || ':' || correction_open::text from public.event_competition_rounds where id = '$(u "00600$1")'"; }
u66n() { q "select count(*) from public.event_competition_result_events where round_id = '$(u "00600$1")' and refs ->> 'u66_recovery' = 'true'"; }
exn() { q "select count(*) from public.event_competition_round_exclusions where round_id = '$(u "00600$1")'"; }
HAS_F3=$(q "select to_regclass('public.event_competition_result_publications') is not null")

# --- 1a same request id from two sessions
mk 1; open_corr 1
hold "$M1" "$(REC 1 $(u 0e0001))" 3 > $TMPD/c1a.out &
sleep 1
run "$M1" "$(REC 1 $(u 0e0001))" > $TMPD/c1b.out
wait
if [ "$(rs 1)" = ballots_locked:false ] && [ "$(u66n 1)" = 1 ] && [ "$(exn 1)" = 1 ] && grep -q '"replayed": true' $TMPD/c1b.out; then
  ok "1a same request id: one cancellation, one exclusion request, the second session replays"; else bad "1a same request id" "state=$(rs 1) u66=$(u66n 1) excl=$(exn 1) $(head -c 200 $TMPD/c1b.out)"; fi

# --- 1b different request ids
mk 2; open_corr 2
hold "$M1" "$(REC 2 $(u 0e0002))" 3 > $TMPD/c1c.out &
sleep 1
run "$M2" "$(REC 2 $(u 0e0003))" > $TMPD/c1d.out
wait
if [ "$(rs 2)" = ballots_locked:false ] && [ "$(u66n 2)" = 1 ] && [ "$(exn 2)" = 1 ] && grep -q 'COMP_CORRECTION_NOT_OPEN' $TMPD/c1d.out; then
  ok "1b two recoveries: one wins, one audit row, one exclusion row, the loser is refused (no open correction)"; else bad "1b two recoveries" "state=$(rs 2) u66=$(u66n 2) excl=$(exn 2) $(head -c 200 $TMPD/c1d.out)"; fi

# --- 2a replacement ballot first (entry_exclusion correction: entry 3 scratched), recovery waits
mk 3; open_corr 3 3
{ echo "begin;"; echo "select public._compe2_insert_ballot('$J1', '$(u 006003)', null, '$(u 00b011)', 'judge_web', null, '[{\"entry_id\":\"$(u 008031)\",\"value\":true},{\"entry_id\":\"$(u 008032)\",\"value\":true},{\"entry_id\":\"$(u 008036)\",\"value\":true}]'::jsonb, 'entry 3 scratched', gen_random_uuid());"; echo "select pg_sleep(3);"; echo "commit;"; } | psq -v ON_ERROR_STOP=0 > $TMPD/c2a.out 2>&1 &
sleep 1
run "$M1" "$(REC 3 $(u 0e0004))" > $TMPD/c2b.out
wait
if [ "$(rs 3)" = ballots_locked:true ] && [ "$(u66n 3)" = 0 ] && [ "$(exn 3)" = 0 ] && grep -q 'replacement_ballot' $TMPD/c2b.out && grep -q COMP_CORRECTION_EXCLUSION_DURING_CORRECTION $TMPD/c2b.out; then
  ok "2a replacement ballot then recovery: refused with the existing code (replacement_ballot), correction still open, nothing written"; else bad "2a ballot then recovery" "state=$(rs 3) $(head -c 300 $TMPD/c2b.out)"; fi

# --- 2b recovery first, a replacement ballot filer waits and is refused
mk 4; open_corr 4 3
hold "$M1" "$(REC 4 $(u 0e0005))" 3 > $TMPD/c2c.out &
sleep 1
r=$(fileb 4 $J1 $(u 00b011) 1 2 6)
wait
unrec=$(q "select count(*) from public.event_competition_ballots b where b.round_id = '$(u 006004)' and b.supersedes_id is not null")
if [ "$(rs 4)" = ballots_locked:false ] && [ "$(u66n 4)" = 1 ] && [ "$unrec" = 0 ] && echo "$r" | grep -q 'ERR:.*COMP_BALLOT_ROUND_NOT_ACTIVE'; then
  ok "2b recovery then ballot: the filer waited, was refused (round not active), no replacement ballot exists"; else bad "2b recovery then ballot" "state=$(rs 4) u66=$(u66n 4) unrec=$unrec r=$r"; fi

# --- 3a co-sign first (judge_entry_error), recovery waits and is refused
mk 5; open_corr 5
CID5=$(q "select id from public.event_competition_correction_causes where round_id = '$(u 006005)'")
hold "$M2" "select public.cosign_competition_correction('$CID5', '$(u 0e0006)');" 3 > $TMPD/c3a.out &
sleep 1
run "$M1" "$(REC 5 $(u 0e0007))" > $TMPD/c3b.out
wait
if [ "$(rs 5)" = ballots_locked:true ] && [ "$(u66n 5)" = 0 ] && grep -q cosign $TMPD/c3b.out && grep -q COMP_CORRECTION_EXCLUSION_DURING_CORRECTION $TMPD/c3b.out \
   && [ "$(q "select count(*) from public.event_competition_correction_cosigns where cause_id = '$CID5'")" = 1 ]; then
  ok "3a co-sign then recovery: refused with the existing code (cosign), the co-sign stands"; else bad "3a cosign then recovery" "state=$(rs 5) $(head -c 300 $TMPD/c3b.out)"; fi

# --- 3b recovery first, the co-sign waits and is refused
mk 6; open_corr 6
CID6=$(q "select id from public.event_competition_correction_causes where round_id = '$(u 006006)'")
hold "$M1" "$(REC 6 $(u 0e0008))" 3 > $TMPD/c3c.out &
sleep 1
run "$M2" "select public.cosign_competition_correction('$CID6', '$(u 0e0009)');" > $TMPD/c3d.out
wait
if [ "$(rs 6)" = ballots_locked:false ] && [ "$(u66n 6)" = 1 ] && grep -q COMP_CORRECTION_NOT_OPEN $TMPD/c3d.out \
   && [ "$(q "select count(*) from public.event_competition_correction_cosigns where cause_id = '$CID6'")" = 0 ]; then
  ok "3b recovery then co-sign: the co-sign waited and was refused (not open), no co-sign row"; else bad "3b recovery then cosign" "state=$(rs 6) $(head -c 300 $TMPD/c3d.out)"; fi

# --- 4a recovery first, then publish (F3)
if [ "$HAS_F3" = t ]; then
  mk 7; open_corr 7
  hold "$M1" "$(REC 7 $(u 0e000a))" 3 > $TMPD/c4a.out &
  sleep 1
  run "$M2" "select public.publish_competition_round_result('$(u 006007)', '$(u 007007)', 'entrants', '$(u 0e000b)');" > $TMPD/c4b.out
  wait
  if [ "$(rs 7)" = ballots_locked:false ] && [ "$(u66n 7)" = 1 ] && grep -q COMP_RESULT_INVALID_TRANSITION $TMPD/c4b.out \
     && [ "$(q "select count(*) from public.event_competition_result_publications where round_id = '$(u 006007)'")" = 0 ]; then
    ok "4a recovery then publish: the publish waited and was refused (round not approved), no publication row"; else bad "4a recovery then publish" "state=$(rs 7) $(head -c 300 $TMPD/c4b.out)"; fi

  # --- 4b a current publication blocks; a withdraw that commits first lets the recovery through
  mk 8 published
  psq -v ON_ERROR_STOP=1 -c "set session_replication_role = replica; insert into public.event_competition_result_publications (id, event_id, round_id, result_version_id, publication_version, visibility, published_by, request_id)
    values ('$(u 00a008)', '$EV', '$(u 006008)', '$(u 007008)', 1, 'entrants', '$M1', gen_random_uuid());"
  open_corr 8
  run "$M1" "$(REC 8 $(u 0e000c))" > $TMPD/c4c.out
  blocked_first=$(grep -c "current_publication" $TMPD/c4c.out)
  hold "$M2" "select public.withdraw_competition_round_result('$(u 006008)', '$(u 00a008)', 'withdrawn before the recovery', '$(u 0e000d)');" 3 > $TMPD/c4d.out &
  sleep 1
  run "$M1" "$(REC 8 $(u 0e000e))" > $TMPD/c4e.out
  wait
  if [ "$blocked_first" -ge 1 ] && [ "$(rs 8)" = ballots_locked:false ] && [ "$(u66n 8)" = 1 ] \
     && [ "$(q "select withdrawn_at is not null from public.event_competition_result_publications where id = '$(u 00a008)'")" = t ]; then
    ok "4b current publication blocks the recovery; once the withdraw commits the recovery proceeds and the publication row is kept"; else bad "4b withdraw then recovery" "first=$blocked_first state=$(rs 8) u66=$(u66n 8) $(head -c 300 $TMPD/c4e.out)"; fi
else
  skip "4a / 4b recovery vs publish / withdraw" "F3 is not applied in this chain"
fi

# --- 5 recovery vs the plain A5 exclusion request
mk 9; open_corr 9
hold "$M1" "$(REC 9 $(u 0e000f))" 3 > $TMPD/c5a.out &
sleep 1
run "$M2" "select public.request_round_exclusion('$(u 006009)', '$(u 008095)', 'ineligible', 'plain request', '$(u 0e0010)');" > $TMPD/c5b.out
wait
# after the recovery commits the plain request sees an already pending request row: it creates a SECOND request (different requester), which is the ordinary A5 behaviour
if [ "$(rs 9)" = ballots_locked:false ] && [ "$(u66n 9)" = 1 ] && [ "$(exn 9)" -ge 1 ] && ! grep -q 'deadlock detected' $TMPD/c5b.out $TMPD/c5a.out; then
  ok "5 recovery vs plain exclusion request: serialised on the round lock, no deadlock ($(exn 9) request row(s))"; else bad "5 recovery vs plain request" "state=$(rs 9) $(head -c 300 $TMPD/c5b.out)"; fi

echo "== done: $FAILS failure(s), $SKIPS blocked =="
[ "$FAILS" = 0 ] && echo "CONCURRENCY PASS" || echo "CONCURRENCY FAIL"
exit "$FAILS"
