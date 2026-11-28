#!/usr/bin/env bash
# ADAPTED COPY for R-15 (Competition S4, PR 866). This is NOT the released suite: a pass of this file is never a pass of its source.
# Source: test_T_competition_cf1_a5_concurrency_with_s6.sh, blob 446a681269651922ee45a5227006a22764d70d00
#         PR 877 head 98ae57a2965c (itself an adapted copy of the A5 race script for S6). The source stays unchanged; use it on a chain WITHOUT R-15.
# Why: the fixture places ineligible couples directly into published, running heats.
# Changes, and nothing else:
#   * fixtures: couples are seeded as before, made eligible, cleared through set_competition_entry_eligibility (one adult participant added per couple), placed, then set back to ineligible; a fixture failure stops the script;
#   * one added check (P0) proves the restored starting state; the verdict text is prefixed "ADAPTED COPY R-15". Every probe is unchanged.
# Dropped assertions: none.
# Run: as the source; reads fixtures/r15_clear_entries.sql beside this file; needs the real S5 predicate; disposable container only. For a chain with R-15 AND S6.
#
# ADAPTED COPY (S6, PR 877; owner decision of 2026-11-26, option A: whole-entry scratch / withdrawal stays refused once any heat of the entry is active, completed, danced or
# disqualified; DanceFlow Studio/Custom policy). Source: test_T_competition_cf1_a5_concurrency.sh, kept unmodified beside this file; use it on a chain WITHOUT S6.
# Changes, and nothing else:
#   * P1 / P2 keep the same two races with the same expectations, but the lifecycle writer is EMULATED (as the A2 script already does) with the S6 function's lock order
#     (heats FOR SHARE, entry FOR NO KEY UPDATE, entry update, heat-entry update; replica mode so only the locks are exercised), because the real function now refuses these entries.
#   * P9 / P10 / P11 are new: the REAL function refuses an entry in a completed heat and in an active heat, changes nothing, and refuses without waiting while another session holds the entry row.
#   * the psql password is passed explicitly.
# Competition CF1 A5 -- multi-session probes (U78 lock probe, request-id race, seq race) on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1-a5-db DBUSER=postgres bash test_T_competition_cf1_a5_concurrency.sh
#
# The database must already carry the chain through HL1, A1 and A5 (A5 applied). The script COMMITS synthetic fixtures (UUID block
# ...-cf1a5cXXXXXX) and leaves them: run it only on a disposable container (docker rm -v afterwards). Never against a shared or hosted DB.
# Each probe prints PASS / FAIL. Real sessions, real transactions; the sleeps hold locks open inside an explicit transaction.
set -u
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-postgres}"
W="$(mktemp -d)"
FAILS=0

psq() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$DBUSER" -h localhost -d postgres -v ON_ERROR_STOP=1 -At -q "$@"; }
u() { echo "00000000-0000-0000-0000-cf1a5c$1"; }
M1=$(u 000001); M2=$(u 000002); CH=$(u 000017)
EV=$(u 00e001); RA=$(u 006001); RL=$(u 006002)
E() { u "0080$1"; }
rid() { u "f0$1"; }

# $1 user, $2 sql  (as an authenticated API user)
as_sql() { printf "set role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\n%s\n" "$1" "$2"; }
now_ms() { date +%s%3N; }
# $1 entry, $2 new status, $3 extra statement after begin, $4 closing statements: the writes and lock order of change_competition_entry_lifecycle, one transaction, triggers bypassed
emu() { printf "set session_replication_role = replica;\nbegin;\n%s\nselect 1 from public.event_competition_heats h where h.id in (select he.heat_id from public.event_competition_heat_entries he where he.entry_id = '%s') order by h.id for share;\nselect 1 from public.event_competition_entries where id = '%s' for no key update;\nupdate public.event_competition_entries set status = '%s', lifecycle_version = lifecycle_version + 1 where id = '%s';\nupdate public.event_competition_heat_entries set status = 'scratched' where entry_id = '%s' and status in ('scheduled', 'checked_in');\n%s\n" "$3" "$1" "$1" "$2" "$1" "$1" "$4"; }
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }

echo "== fixtures =="
psq <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$M1', 't-cf1a5c-m1@example.test'), ('$M2', 't-cf1a5c-m2@example.test'), ('$CH', 't-cf1a5c-chair@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'CF1A5C ' || split_part(email, '@', 1) from auth.users where id in ('$M1', '$M2', '$CH');
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id in ('$M1', '$M2', '$CH');
insert into public.studios (id, name, slug) values ('$(u 00a001)', 'CF1 A5 Race Studio', 't-cf1a5c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('$M1', '$(u 00a001)', 'studio_owner', true), ('$M2', '$(u 00a001)', 'studio_owner', true), ('$CH', '$(u 00a001)', 'instructor', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('$EV', '$(u 00a001)', 'CF1 A5 Race', 't-cf1a5c-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('$(u 001001)', '$EV', '$(u 00a001)', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('$(u 002001)', '$EV', '$(u 001001)', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  ('$(u 003001)', '$EV', '$(u 001001)', '$(u 002001)', 'D1', 'open'), ('$(u 003002)', '$EV', '$(u 001001)', '$(u 002001)', 'D2', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values
  ('$RA', '$EV', '$(u 001001)', '$(u 003001)', 'RA', 'final', 1, 'active', 'ordinal_majority'),
  ('$RL', '$EV', '$(u 001001)', '$(u 003002)', 'RL', 'final', 1, 'ballots_locked', 'ordinal_majority');
SQL
# (R-15 adaptation: the loop below still seeds ineligible couples; the blocks after it clear them before placement.)
# entries 01..06 in D1, 07..09 in D2
for i in 1 2 3 4 5 6 7 8 9; do
  d=$([ "$i" -le 6 ] && echo 003001 || echo 003002)
  psq -c "set session_replication_role = replica; insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values ('$(E 0$i)', '$EV', '$(u 001001)', '$(u $d)', 'e$i', 'confirmed', 'ineligible', '$((200 + i))');" >/dev/null
done
# R-15 ADAPTATION (fixture): R-15 refuses to place a couple that is not cleared in a published order. Seed eligible, record clearance as the organizer would (the
# real RPC), place, then set the couples back to ineligible (below). A failure here stops the script.
HERE="$(cd "$(dirname "$0")" && pwd)"
r15_stop() { echo "FAIL  fixtures: $1"; echo "ADAPTED COPY R-15: COMPETITION CF1 A5 CONCURRENCY FAIL (fixtures)"; rm -rf "$W"; exit 1; }
{ cat "$HERE/fixtures/r15_clear_entries.sql"
  printf "set session_replication_role = replica;\nupdate public.event_competition_entries set eligibility_status = 'eligible' where event_id = '%s';\nset session_replication_role = origin;\nselect pg_temp.r15_clear_entries('%s');\n" "$EV" "$EV"
} | psq >/dev/null || r15_stop "R-15 clearance"
psq <<SQL
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(u 00c001)', '$EV', 1, 'v1', 'published', now()) on conflict do nothing;
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  ('$(u 00d001)', '$EV', '$(u 003001)', '$RA', 1, '$(u 002001)', '$(u 00c001)', 'active'),
  ('$(u 00d002)', '$EV', '$(u 003002)', '$RL', 2, '$(u 002001)', '$(u 00c001)', 'complete');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select '$EV', '$(u 003001)', '$(u 00d001)', ('00000000-0000-0000-0000-cf1a5c0080' || lpad(i::text, 2, '0'))::uuid, i, 'scheduled' from generate_series(1, 6) i;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select '$EV', '$(u 003002)', '$(u 00d002)', ('00000000-0000-0000-0000-cf1a5c0080' || lpad(i::text, 2, '0'))::uuid, i, 'scheduled' from generate_series(7, 9) i;
SQL
# R-15 ADAPTATION (fixture): back to the seeded status, now that every couple is placed.
psq -c "set session_replication_role = replica; update public.event_competition_entries set eligibility_status = 'ineligible' where event_id = '$EV';" >/dev/null || r15_stop "restore ineligible"
R15=$(psq -c "select count(*) filter (where e.eligibility_status = 'ineligible') || '/' || count(h.id) from public.event_competition_entries e left join public.event_competition_heat_entries h on h.entry_id = e.id where e.event_id = '$EV'")
if [ "$R15" = "9/9" ]; then ok "P0 (added) fixtures: 9 couples placed, all ineligible again"; else r15_stop "expected 9 ineligible couples with 9 placements, got $R15"; fi
psq -c "select 'fixture rounds=' || count(*) from public.event_competition_rounds where event_id = '$EV'"
psq <<SQL
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"$M1","role":"authenticated"}', false);
select public.add_competition_official('$EV', '$CH', 'chair', '$(u f10001)');
SQL

req() { # user round entry reqnum label
  as_sql "$1" "select public.request_round_exclusion('$2','$(E $3)','ineligible','race probe $5','$(rid $4)');"
}

echo "== P1: request holding its locks vs change_competition_entry_lifecycle (U78, shared entry -> heat-entry order) =="
# Session A (exclusion, e1) holds event lock + round FOR UPDATE + entry/heat-entry FOR SHARE for 4 s; session B (lifecycle scratch of e1) must wait for the entry row.
( { as_sql "$M1" "begin; select public.request_round_exclusion('$RA','$(E 01)','ineligible','probe P1','$(rid 0101)'); select pg_sleep(4); commit;"; } | psq > "$W/p1a.out" 2> "$W/p1a.err" ) &
PA=$!; sleep 1.2
T0=$(now_ms)
{ emu "$(E 01)" scratched "" "commit;"; } | psq > "$W/p1b.out" 2> "$W/p1b.err"
T1=$(now_ms); wait $PA
if ! grep -qi "deadlock" "$W/p1a.err" "$W/p1b.err" && [ -s "$W/p1a.out" ] && [ $((T1 - T0)) -ge 1500 ]; then ok "P1 lifecycle waited for the in-flight exclusion ($((T1 - T0)) ms), no deadlock"; else bad "P1" "$(cat "$W/p1a.err" "$W/p1b.err" | head -3) waited=$((T1 - T0))ms"; fi

echo "== P2: lifecycle holding the entry row vs request (U78, opposite arrival) =="
( { emu "$(E 02)" withdrawn "" "select pg_sleep(4); commit;"; } | psq > "$W/p2a.out" 2> "$W/p2a.err" ) &
PA=$!; sleep 1.2
T0=$(now_ms)
{ req "$M1" "$RA" 02 0102 P2; } | psq > "$W/p2b.out" 2> "$W/p2b.err"
T1=$(now_ms); wait $PA
if ! grep -qi "deadlock" "$W/p2a.err" "$W/p2b.err" && [ $((T1 - T0)) -ge 1500 ] && grep -q "COMP_EXCLUSION_NOT_DANCED" "$W/p2b.err"; then ok "P2 request waited for the lifecycle writer ($((T1 - T0)) ms), then saw the scratched heat entry (NOT_DANCED), no deadlock"; else bad "P2" "$(cat "$W/p2b.err" | head -2) waited=$((T1 - T0))ms"; fi

echo "== P3: exclusion vs reopen of the ballots (round FOR UPDATE serialization) =="
# Session A reopens RL (ballots_locked -> active) and sleeps holding the round lock; B requests an exclusion on RL and must wait, then see the round active.
( { as_sql "$M1" "begin; select public.reopen_competition_round_ballots('$RL','probe P3 reopen','$(rid 0103)'); select pg_sleep(4); commit;"; } | psq > "$W/p3a.out" 2> "$W/p3a.err" ) &
PA=$!; sleep 1.2
T0=$(now_ms)
{ req "$M1" "$RL" 07 0104 P3; } | psq > "$W/p3b.out" 2> "$W/p3b.err"
T1=$(now_ms); wait $PA
ST=$(psq -c "select status from public.event_competition_rounds where id = '$RL'")
if [ "$ST" = "active" ] && [ -s "$W/p3b.out" ] && [ $((T1 - T0)) -ge 1500 ] && ! grep -qi deadlock "$W/p3a.err" "$W/p3b.err"; then ok "P3 exclusion waited for the reopen ($((T1 - T0)) ms) and ran against the active round"; else bad "P3" "status=$ST $(cat "$W/p3b.err" | head -2) waited=$((T1 - T0))ms"; fi

echo "== P4: reopen waits for an in-flight exclusion on a ballots_locked round =="
psq -c "set session_replication_role = replica; update public.event_competition_rounds set status = 'ballots_locked' where id = '$RL';" >/dev/null
( { as_sql "$M1" "begin; select public.request_round_exclusion('$RL','$(E 08)','ineligible','probe P4','$(rid 0105)'); select pg_sleep(4); commit;"; } | psq > "$W/p4a.out" 2> "$W/p4a.err" ) &
PA=$!; sleep 1.2
T0=$(now_ms)
{ as_sql "$M1" "select public.reopen_competition_round_ballots('$RL','probe P4 reopen','$(rid 0106)');"; } | psq > "$W/p4b.out" 2> "$W/p4b.err"
T1=$(now_ms); wait $PA
ST=$(psq -c "select status from public.event_competition_rounds where id = '$RL'")
N=$(psq -c "select count(*) from public.event_competition_round_exclusions where round_id = '$RL' and entry_id = '$(E 08)'")
if [ "$ST" = "active" ] && [ "$N" = "1" ] && [ $((T1 - T0)) -ge 1500 ] && ! grep -qi deadlock "$W/p4a.err" "$W/p4b.err"; then ok "P4 reopen waited ($((T1 - T0)) ms); the exclusion row is committed once, the round ended active"; else bad "P4" "status=$ST rows=$N waited=$((T1 - T0))ms $(cat "$W/p4a.err" "$W/p4b.err" | head -2)"; fi

echo "== P5: lock-ballots lock order (EMULATED: round FOR UPDATE, heats + heat entries FOR SHARE, entries FOR SHARE) vs request =="
( { printf "begin;\nselect id from public.event_competition_rounds where id = '$RA' for update;\nselect id from public.event_competition_heats where round_id = '$RA' for share;\nselect he.id from public.event_competition_heat_entries he where he.heat_id in (select id from public.event_competition_heats where round_id = '$RA') order by he.id for share;\nselect e.id from public.event_competition_entries e where e.id in (select entry_id from public.event_competition_heat_entries where heat_id = '$(u 00d001)') order by e.id for share;\nselect pg_sleep(4);\ncommit;\n"; } | psq > "$W/p5a.out" 2> "$W/p5a.err" ) &
PA=$!; sleep 1.2
T0=$(now_ms)
{ req "$M1" "$RA" 03 0107 P5; } | psq > "$W/p5b.out" 2> "$W/p5b.err"
T1=$(now_ms); wait $PA
if ! grep -qi deadlock "$W/p5a.err" "$W/p5b.err" && [ -s "$W/p5b.out" ] && [ $((T1 - T0)) -ge 1500 ]; then ok "P5 request waited for the lock-order holder ($((T1 - T0)) ms), no deadlock (emulation, not the real A2 lock function)"; else bad "P5" "waited=$((T1 - T0))ms $(cat "$W/p5b.err" | head -2)"; fi

echo "== P6: the same request id from two sessions at once: one row, the second is a replay =="
( { as_sql "$M1" "select public.request_round_exclusion('$RA','$(E 04)','ineligible','probe P6','$(rid 0108)');"; } | psq > "$W/p6a.out" 2> "$W/p6a.err" ) &
PA=$!
{ as_sql "$M1" "select public.request_round_exclusion('$RA','$(E 04)','ineligible','probe P6','$(rid 0108)');"; } | psq > "$W/p6b.out" 2> "$W/p6b.err"
wait $PA
N=$(psq -c "select count(*) from public.event_competition_round_exclusions where request_id = '$(rid 0108)'")
R=$(cat "$W/p6a.out" "$W/p6b.out" | grep -c '"replayed": true')
if [ "$N" = "1" ] && [ "$R" = "1" ] && [ ! -s "$W/p6a.err" ] && [ ! -s "$W/p6b.err" ]; then ok "P6 one row, exactly one replayed result, no error"; else bad "P6" "rows=$N replayed=$R $(cat "$W/p6a.err" "$W/p6b.err" | head -2)"; fi

echo "== P7: two different requests in one round at once: distinct seq, no unique violation =="
( { as_sql "$M1" "select public.request_round_exclusion('$RA','$(E 05)','ineligible','probe P7a','$(rid 0109)');"; } | psq > "$W/p7a.out" 2> "$W/p7a.err" ) &
PA=$!
{ as_sql "$M2" "select public.request_round_exclusion('$RA','$(E 06)','ineligible','probe P7b','$(rid 0110)');"; } | psq > "$W/p7b.out" 2> "$W/p7b.err"
wait $PA
D=$(psq -c "select count(*) - count(distinct seq) from public.event_competition_round_exclusions where round_id = '$RA'")
MX=$(psq -c "select max(seq) = count(*) from public.event_competition_round_exclusions where round_id = '$RA'")
if [ "$D" = "0" ] && [ "$MX" = "t" ] && [ ! -s "$W/p7a.err" ] && [ ! -s "$W/p7b.err" ]; then ok "P7 seq values distinct and gap-free in the round"; else bad "P7" "dups=$D gapfree=$MX $(cat "$W/p7a.err" "$W/p7b.err" | head -2)"; fi

echo "== P8: concurrent co-sign of the same request by two co-signers: exactly one co-sign row =="
RQ=$(psq -c "select id from public.event_competition_round_exclusions where request_id = '$(rid 0107)'")
( { as_sql "$CH" "select public.cosign_round_exclusion('$RQ','$(rid 0111)');"; } | psq > "$W/p8a.out" 2> "$W/p8a.err" ) &
PA=$!
{ as_sql "$M2" "select public.cosign_round_exclusion('$RQ','$(rid 0112)');"; } | psq > "$W/p8b.out" 2> "$W/p8b.err"
wait $PA
N=$(psq -c "select count(*) from public.event_competition_round_exclusions where decision_id = '$RQ'")
if [ "$N" = "1" ] && ! grep -qi deadlock "$W/p8a.err" "$W/p8b.err" && grep -q "DECISION_COMPLETED" "$W/p8a.err" "$W/p8b.err"; then ok "P8 one co-sign row; the loser was refused COMP_EXCLUSION_DECISION_COMPLETED"; else bad "P8" "rows=$N $(cat "$W/p8a.err" "$W/p8b.err" | head -3)"; fi

# policy probes with the REAL function (no writer emulation). Entry 06 sits in the active heat, entry 09 in the completed heat.
policy_refusal() { # $1 label, $2 entry, $3 status
  local before after
  before=$(psq -c "select e.status || '|' || e.lifecycle_version || '|' || coalesce(string_agg(h.status, ',' order by h.id), '') from public.event_competition_entries e left join public.event_competition_heat_entries h on h.entry_id = e.id where e.id = '$2' group by e.id")
  { as_sql "$M1" "select public.change_competition_entry_lifecycle('$2', '$3', 'policy probe', 'retain');"; } | psq > "$W/pol.out" 2> "$W/pol.err"
  after=$(psq -c "select e.status || '|' || e.lifecycle_version || '|' || coalesce(string_agg(h.status, ',' order by h.id), '') from public.event_competition_entries e left join public.event_competition_heat_entries h on h.entry_id = e.id where e.id = '$2' group by e.id")
  if grep -q "COMP_ENTRY_LIFECYCLE_PLACED" "$W/pol.err" && [ -n "$before" ] && [ "$before" = "$after" ]; then ok "$1 refused (PLACED), entry and heat entry unchanged ($after)"; else bad "$1" "before=$before after=$after err=$(head -c 200 "$W/pol.err")"; fi
}
echo "== P9: real function, entry in a COMPLETED heat =="
policy_refusal "P9 scratch in a completed heat" "$(E 09)" scratched
echo "== P10: real function, entry in an ACTIVE heat (withdrawal) =="
policy_refusal "P10 withdrawal in an active heat" "$(E 06)" withdrawn
echo "== P11: the refusal takes no row lock: another session holds the entry row =="
( { printf "begin; select 1 from public.event_competition_entries where id = '%s' for update; select pg_sleep(6); commit;\n" "$(E 06)"; } | psq > "$W/p11a.out" 2> "$W/p11a.err" ) &
PA=$!; sleep 1.5
T0=$(now_ms)
{ as_sql "$M1" "select public.change_competition_entry_lifecycle('$(E 06)', 'scratched', 'probe P11', 'retain');"; } | psq > "$W/p11b.out" 2> "$W/p11b.err"
T1=$(now_ms); wait $PA
if grep -q "COMP_ENTRY_LIFECYCLE_PLACED" "$W/p11b.err" && [ $((T1 - T0)) -lt 4000 ]; then ok "P11 refused without waiting for the row lock ($((T1 - T0)) ms)"; else bad "P11" "ms=$((T1 - T0)) err=$(head -c 200 "$W/p11b.err")"; fi

echo "== summary =="
if [ "$FAILS" = "0" ]; then echo "ADAPTED COPY R-15: COMPETITION CF1 A5 CONCURRENCY PASS"; else echo "ADAPTED COPY R-15: COMPETITION CF1 A5 CONCURRENCY FAIL ($FAILS)"; fi
rm -rf "$W"
exit "$FAILS"
