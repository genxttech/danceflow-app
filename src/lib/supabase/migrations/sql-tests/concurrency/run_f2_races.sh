#!/usr/bin/env bash
# Competition F2 -- real two-connection races for the results lifecycle (one psql session per actor, fixtures COMMIT).
#
# Usage: bash run_f2_races.sh [container]   (default: f2-db; the DB must have 10A..10D, E1, O1, E2 and F2 applied)
# Needs a superuser (supabase_admin) for fixtures only; actors run as `authenticated` with a JWT sub claim. Fixtures are removed
# by deleting the event at the end, even on failure (heats are reopened first by a privileged fixture shortcut; KEEP=1 skips it).
# Scenarios:
#   A  double calculate, different request ids   the second WAITS for the first, then is refused (round already calculated); one version
#   A2 double calculate, same request id         the second WAITS, then replays; one version
#   B  approve (in flight) vs open_correction    the correction WAITS, then runs; final: version stale, round ballots_locked, heat certified, one approval
#   B2 open_correction (in flight) vs approve    the approve WAITS, then is refused (round no longer calculated); no approval
#   C  calculate (old hash) vs corrected ballot  the calculate WAITS for the ballot, then is refused STALE; a fresh read+calculate succeeds
#   D  approve (in flight) vs judge submit       the submit WAITS, then is refused (round not active); no ballot slipped in; version stays approved
# Prints "F2 RACES PASS (<n> checks)" or "F2 RACES FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-f2-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUN() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }  # no ON_ERROR_STOP: capture refusals
U() { printf '00000000-0000-0000-0000-f20ff3%06x' "$((16#$1))"; }
MGR1=$(U a0); MGR2=$(U a9); J1=$(U a1); J2=$(U a2); J3=$(U a3)
EV=$(U e0); STUDIO=$(U 51)
TH=$(printf '%s' '[{"step":1}]' | sha256sum | cut -d' ' -f1)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
now_ms() { date +%s%3N; }
as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }

cleanup() {
  SU -c "set session_replication_role = replica; update public.event_competition_heats set lock_state = 'open' where event_id = '$EV'; reset session_replication_role;" >/dev/null 2>&1
  SU -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-f20ff3%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-f20ff3%'; delete from auth.users where id::text like '00000000-0000-0000-0000-f20ff3%';" >/dev/null 2>&1
}
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR1','t-f2c-m1@example.test'),('$MGR2','t-f2c-m2@example.test'),('$J1','t-f2c-j1@example.test'),('$J2','t-f2c-j2@example.test'),('$J3','t-f2c-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'F2C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-f20ff3%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-f20ff3%';
insert into public.studios (id, name, slug) values ('$STUDIO','F2C Studio','t-f2c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR1','$STUDIO','studio_owner',true),('$MGR2','$STUDIO','studio_owner',true),
  ('$J1','$STUDIO','instructor',true),('$J2','$STUDIO','instructor',true),('$J3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','F2C Comp','t-f2c-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$(U 61)','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 62)','$EV','$(U 61)','C','single_dance','pro_am','open');
SQL
# rounds 1..6 (A, A2, B, B2, C, D): division U(7i), round U(8i), entries U(9i1..9i3), heat U(di)
for i in 1 2 3 4 5 6; do
SU <<SQL
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$(U 7$i)','$EV','$(U 61)','$(U 62)','D$i','open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values ('$(U 8$i)','$EV','$(U 61)','$(U 7$i)','R$i','final',1,'draft','ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  ('$(U 9${i}1)','$EV','$(U 61)','$(U 7$i)','E${i}1','confirmed','eligible','${i}01'), ('$(U 9${i}2)','$EV','$(U 61)','$(U 7$i)','E${i}2','confirmed','eligible','${i}02'),
  ('$(U 9${i}3)','$EV','$(U 61)','$(U 7$i)','E${i}3','confirmed','eligible','${i}03');
SQL
done
SU <<SQL
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(U c1)','$EV',1,'v1','published',now());
$(for i in 1 2 3 4 5 6; do echo "insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$(U d$i)','$EV','$(U 7$i)','$(U 8$i)',$i,'$(U 62)','$(U c1)','scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}1)',1),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}2)',2),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}3)',3);"; done)
set session_replication_role = origin;
SQL
SU <<SQL
$(as_user "$MGR1")
select public.add_competition_official('$EV','$J1','judge','$(U f001)');
select public.add_competition_official('$EV','$J2','judge','$(U f002)');
select public.add_competition_official('$EV','$J3','judge','$(U f003)');
$(for i in 1 2 3 4 5 6; do echo "select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J1'), 'A', '$(U f1$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J2'), 'B', '$(U f2$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$J3'), 'C', '$(U f3$i)');"; done)
SQL
SU <<SQL
do \$\$
begin
  if to_regprocedure('public.pin_competition_round_scoring(uuid)') is not null then
    set local session_replication_role = replica;
    update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now() where event_id = '$EV';
    insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
    select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at
    from public.event_competition_programs where event_id = '$EV';
    set local session_replication_role = origin;
    perform public.pin_competition_round_scoring(id) from public.event_competition_rounds where event_id = '$EV';
  end if;
end \$\$;
SQL
SU -c "set session_replication_role = replica; update public.event_competition_rounds set status='active' where event_id='$EV';"
marks() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"value\":$2},{\"entry_id\":\"$(U 9${1}2)\",\"value\":$3},{\"entry_id\":\"$(U 9${1}3)\",\"value\":$4}]'::jsonb"; }
rows() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"placement\":1},{\"entry_id\":\"$(U 9${1}2)\",\"placement\":2},{\"entry_id\":\"$(U 9${1}3)\",\"placement\":3}]'::jsonb"; }
# ballots + heat lock + ballot lock for round $1 (committed)
prep() {
  local i=$1
  SU <<SQL
$(as_user "$J1")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 1 2 3),'$(U 1a$i)');
$(as_user "$J2")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 1 3 2),'$(U 1b$i)');
$(as_user "$J3")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 2 1 3),'$(U 1c$i)');
$(as_user "$MGR1")
select public.set_competition_heat_lock_state('$(U d$i)','locked','race');
select public.lock_competition_round_ballots('$(U 8$i)','$(U 1d$i)');
SQL
}
# calculate round $1 with the hash read just now; request id $2; prints the RPC result or the error
calc_sql() {
  local i=$1 req=$2
  echo "select public.calculate_competition_round('$(U 8$i)','studio_ordinal_majority','1', public.competition_round_calculation_input('$(U 8$i)')->>'input_hash', '$TH', '[{\"step\":1}]'::jsonb, $(rows $i), '[]'::jsonb, '$req');"
}
status_of() { SU -c "select status from public.event_competition_rounds where id='$(U 8$1)'"; }
nver() { SU -c "select count(*) from public.event_competition_result_versions where round_id='$(U 8$1)'"; }
vstat() { SU -c "select string_agg(status, ',' order by version) from public.event_competition_result_versions where round_id='$(U 8$1)'"; }

for i in 1 2 3 4 5 6; do prep "$i"; done
ok "fixture: six rounds ballots_locked" $([ "$(SU -c "select count(*) from public.event_competition_rounds where event_id='$EV' and status='ballots_locked'")" = "6" ] && echo 1 || echo 0)

# ------------------------------------------------------------- A: double calculate, different request ids
( SUN <<SQL
$(as_user "$MGR1")
begin;
$(calc_sql 1 "$(U a101)")
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_a1.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
A_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR2")
$(calc_sql 1 "$(U a102)")
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "A: second calculate took ${EL}ms -> $A_OUT"
ok "A: second calculate waited for the first (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "A: second calculate refused as already calculated" $(echo "$A_OUT" | grep -q 'COMP_RESULT_INVALID_TRANSITION' && echo 1 || echo 0)
ok "A: exactly one version, round calculated" $([ "$(nver 1)" = "1" ] && [ "$(status_of 1)" = "calculated" ] && echo 1 || echo 0)

# ------------------------------------------------------------- A2: double calculate, same request id
( SUN <<SQL
$(as_user "$MGR1")
begin;
$(calc_sql 2 "$(U a201)")
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_a2.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
A2_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR1")
$(calc_sql 2 "$(U a201)")
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "A2: replay took ${EL}ms -> $A2_OUT"
ok "A2: the retry waited (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "A2: the retry replayed instead of failing" $(echo "$A2_OUT" | grep -q '"replayed": true' && echo 1 || echo 0)
ok "A2: still exactly one version" $([ "$(nver 2)" = "1" ] && echo 1 || echo 0)

# ------------------------------------------------------------- B: approve in flight vs open_correction
SU <<SQL
$(as_user "$MGR1")
$(calc_sql 3 "$(U b301)")
SQL
VID3=$(SU -c "select id from public.event_competition_result_versions where round_id='$(U 83)' and version=1")
( SUN <<SQL
$(as_user "$MGR2")
begin;
select public.approve_competition_round_result('$(U 83)','$VID3',null,'$(U b302)');
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_b1.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
B_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR1")
select public.open_competition_round_correction('$(U 83)','race: correct after approve','$(U b303)');
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "B: correction took ${EL}ms -> $B_OUT"
ok "B: the correction waited for the approval (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "B: the correction then succeeded" $(echo "$B_OUT" | grep -q '"status": "ballots_locked"' && echo 1 || echo 0)
ok "B: final state: round ballots_locked, version stale, one approval, heat certified" $([ "$(status_of 3)" = "ballots_locked" ] && [ "$(vstat 3)" = "stale" ] \
  && [ "$(SU -c "select count(*) from public.event_competition_result_approvals where result_version_id='$VID3'")" = "1" ] \
  && [ "$(SU -c "select lock_state from public.event_competition_heats where id='$(U d3)'")" = "certified" ] && echo 1 || echo 0)

# ------------------------------------------------------------- B2: open_correction in flight vs approve
SU <<SQL
$(as_user "$MGR1")
$(calc_sql 4 "$(U b401)")
SQL
VID4=$(SU -c "select id from public.event_competition_result_versions where round_id='$(U 84)' and version=1")
( SUN <<SQL
$(as_user "$MGR1")
begin;
select public.open_competition_round_correction('$(U 84)','race: correction first','$(U b402)');
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_b2.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
B2_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR2")
select public.approve_competition_round_result('$(U 84)','$VID4',null,'$(U b403)');
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "B2: approve took ${EL}ms -> $B2_OUT"
ok "B2: the approval waited for the correction (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "B2: the approval was refused (round no longer calculated)" $(echo "$B2_OUT" | grep -q 'COMP_RESULT_INVALID_TRANSITION' && echo 1 || echo 0)
ok "B2: no approval, version stale, heat not certified" $([ "$(vstat 4)" = "stale" ] && [ "$(SU -c "select count(*) from public.event_competition_result_approvals where result_version_id='$VID4'")" = "0" ] \
  && [ "$(SU -c "select lock_state from public.event_competition_heats where id='$(U d4)'")" = "locked" ] && echo 1 || echo 0)

# ------------------------------------------------------------- C: calculate with an old hash vs a corrected ballot (round 4 is in a correction)
OLD_HASH=$(SU <<SQL
$(as_user "$MGR1")
select public.competition_round_calculation_input('$(U 84)')->>'input_hash';
SQL
)
OLD_HASH=$(echo "$OLD_HASH" | tail -1)
( SUN <<SQL
$(as_user "$J2")
begin;
select public.submit_competition_ballot('$(U 84)','$(U d4)',$(marks 4 3 2 1),'$(U c401)','race: corrected ballot');
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_c1.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
C_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR1")
select public.calculate_competition_round('$(U 84)','studio_ordinal_majority','1','$OLD_HASH','$TH','[{"step":1}]'::jsonb,$(rows 4),'[]'::jsonb,'$(U c402)');
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "C: calculate took ${EL}ms -> $C_OUT"
ok "C: the calculate waited for the in-flight corrected ballot (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "C: the old-hash calculate was refused as stale" $(echo "$C_OUT" | grep -q 'COMP_RESULT_STALE' && echo 1 || echo 0)
ok "C: the corrected ballot committed (version 2) and no new result version exists" $([ "$(SU -c "select count(*) from public.event_competition_ballots where round_id='$(U 84)' and version=2")" = "1" ] && [ "$(nver 4)" = "1" ] && echo 1 || echo 0)
C2_OUT=$(SUN <<SQL 2>&1
$(as_user "$MGR1")
$(calc_sql 4 "$(U c403)")
SQL
)
ok "C: a fresh read + calculate succeeds and supersedes the stale version" $(echo "$C2_OUT" | grep -q '"version": 2' && [ "$(vstat 4)" = "superseded,calculated" ] && echo 1 || echo 0)

# ------------------------------------------------------------- D: approve in flight vs a judge submit on the calculated round
SU <<SQL
$(as_user "$MGR1")
$(calc_sql 5 "$(U d501)")
SQL
VID5=$(SU -c "select id from public.event_competition_result_versions where round_id='$(U 85)' and version=1")
( SUN <<SQL
$(as_user "$MGR2")
begin;
select public.approve_competition_round_result('$(U 85)','$VID5',null,'$(U d502)');
select pg_sleep(4);
commit;
SQL
) > /tmp/f2_d1.out 2>&1 &
P1=$!
sleep 1.5
T0=$(now_ms)
D_OUT=$(SUN <<SQL 2>&1
$(as_user "$J1")
select public.submit_competition_ballot('$(U 85)','$(U d5)',$(marks 5 3 2 1),'$(U d503)','race: late correction');
SQL
)
T1=$(now_ms); wait $P1
EL=$((T1-T0))
echo "D: submit took ${EL}ms -> $D_OUT"
ok "D: the submit waited for the approval (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "D: the submit was refused (round not active)" $(echo "$D_OUT" | grep -q 'COMP_BALLOT_ROUND_NOT_ACTIVE' && echo 1 || echo 0)
ok "D: no ballot slipped in, version approved, round approved" $([ "$(SU -c "select count(*) from public.event_competition_ballots where round_id='$(U 85)'")" = "3" ] && [ "$(vstat 5)" = "approved" ] && [ "$(status_of 5)" = "approved" ] && echo 1 || echo 0)
ok "D: the approved version still matches the ballots (hash binding intact)" $([ "$(SU -c "select v.input_hash = public._compf2_input_hash(v.round_id, v.engine_key, v.engine_version) from public.event_competition_result_versions v where v.id='$VID5'")" = "t" ] && echo 1 || echo 0)

# ------------------------------------------------------------- Z: SQL evidence hash == TypeScript evidence hash (round 6)
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../../../../.." && pwd)"
SU <<SQL | tail -1 > $ROOT/f2-evidence.tmp.json
$(as_user "$MGR1")
select public.competition_round_calculation_input('$(U 86)');
SQL
if [ -d "$ROOT/node_modules" ]; then
  PARITY=$(cd "$ROOT" && F2_EVIDENCE_JSON="$(cygpath -m "$ROOT")/f2-evidence.tmp.json" npx vitest run src/lib/competition/results/__tests__/evidence.parity.test.ts 2>&1)
  ok "Z: TypeScript recomputes the database's evidence hash byte for byte" $(echo "$PARITY" | grep -q "1 passed" && echo 1 || echo 0)
  rm -f "$ROOT/f2-evidence.tmp.json"
else
  rm -f "$ROOT/f2-evidence.tmp.json"
  echo "Z: skipped (no node_modules at $ROOT)"
fi

if [ -z "$FAILS" ]; then echo "F2 RACES PASS ($PASS checks)"; exit 0; fi
echo "F2 RACES FAIL:$FAILS"; exit 1
