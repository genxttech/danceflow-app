#!/bin/sh
# Competition CF1 package A0 -- two-session races with REAL second connections.
#
# Needs a disposable Postgres with the chain through HL1, A1 and A0 applied (never a hosted database), and the shared slot lock held by the caller.
# Fixtures are committed (a synthetic event 00000000-...-cf1c0e), then the event is removed at the end (the 10A history triggers allow the cascade).
#   CONTAINER=cf1-a0-db sh test_T_competition_cf1_concurrency.sh
# Exit 0 = every assertion held, 1 = a failure, 3 = blocked (could not set up).
# Races: R1 apply || apply (second request id), R2 apply || a direct entry update (U23), R3 apply never waits on a version-row update (U1/U3),
#        R4 Final start || a held Final heat (U47: NOWAIT -> 55P03 COMP_ADVANCEMENT_CONCURRENT_CHANGE, the round does not start),
#        R5 correction (revoke) || a held Final heat (55P03, correction not opened, advancement still active).
set -u
C="${CONTAINER:-cf1-a0-db}"
P="docker exec -i $C psql -U postgres -h localhost -v ON_ERROR_STOP=1 -X -q -At"
PN="docker exec -i $C psql -U postgres -h localhost -X -q -At"
E=00000000-0000-0000-0000-cf1c0e000001
S=00000000-0000-0000-0000-cf1c0e00a001
U=00000000-0000-0000-0000-cf1c0e000011
FAIL=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAIL=1; }

cleanup() {
  $PN >/dev/null 2>&1 <<SQL
delete from public.events where id = '$E';
drop schema if exists cf1c cascade;
SQL
}

cleanup
# One scenario builder (committed). Ids: md5-derived like the suite. cf1c.mk(n) builds division n with 4 entries, 3 advanced.
$P <<'SQL' || { echo "BLOCKED: fixture setup failed"; cleanup; exit 3; }
create schema cf1c;
create function cf1c.id(k text, n int default 0, j int default 0) returns uuid language sql immutable as $$ select md5('cf1c:' || k || ':' || n || ':' || j)::uuid $$;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1c0e000011', 't-cf1c-owner@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1c0e000011', 't-cf1c-owner@example.test', 'CF1C Owner') on conflict do nothing;
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  values ('00000000-0000-0000-0000-cf1c0e000011', 't-cf1c-owner@example.test', now(), now(), 'otp', 'web_callback', 'bound', now()) on conflict do nothing;
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1c0e00a001', 'CF1C Studio', 't-cf1c-studio') on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select '00000000-0000-0000-0000-cf1c0e000011', '00000000-0000-0000-0000-cf1c0e00a001', 'studio_owner', true
  where not exists (select 1 from public.user_studio_roles where user_id = '00000000-0000-0000-0000-cf1c0e000011' and studio_id = '00000000-0000-0000-0000-cf1c0e00a001');
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('00000000-0000-0000-0000-cf1c0e000001', '00000000-0000-0000-0000-cf1c0e00a001', 'CF1C', 't-cf1c', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
  values (cf1c.id('prg'), '00000000-0000-0000-0000-cf1c0e000001', '00000000-0000-0000-0000-cf1c0e00a001', 'CB', 'country', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values (cf1c.id('cts'), '00000000-0000-0000-0000-cf1c0e000001', cf1c.id('prg'), 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
  values (cf1c.id('sv'), '00000000-0000-0000-0000-cf1c0e000001', 1, 'V1', 'published', now());
create function cf1c.mk(n int) returns void language plpgsql as $$
declare e uuid := '00000000-0000-0000-0000-cf1c0e000001'; k int; h text;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values (cf1c.id('div', n), e, cf1c.id('prg'), cf1c.id('cts'), 'D' || n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
    values (cf1c.id('src', n), e, cf1c.id('prg'), cf1c.id('div', n), 'cb' || n, 'preliminary', 1, 'approved', 'callback_tally', 3);
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
    values (cf1c.id('fin', n), e, cf1c.id('prg'), cf1c.id('div', n), 'fin' || n, 'final', 2, 'scheduled', 'ordinal_majority');
  for k in 1..4 loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
      values (cf1c.id('ent', n, k), e, cf1c.id('prg'), cf1c.id('div', n), 'e' || n || '-' || k, 'confirmed', 'eligible', k::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (cf1c.id('cbf', n), e, cf1c.id('sv'), n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
    values (cf1c.id('cbh', n), e, cf1c.id('div', n), cf1c.id('src', n), 1, 'complete', 'certified', cf1c.id('cts'), cf1c.id('sv'), cf1c.id('cbf', n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (e, cf1c.id('cbh', n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    select e, cf1c.id('div', n), cf1c.id('cbh', n), cf1c.id('ent', n, k2), k2, 'danced' from generate_series(1, 4) k2;
  h := public._compf2_input_hash(cf1c.id('src', n), 'callback_tally', '1');
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
    values (cf1c.id('rv', n), e, cf1c.id('src', n), 1, 'callback_tally', '1', h, 't', '{}', '{}', '00000000-0000-0000-0000-cf1c0e000011', 'approved', cf1c.id('rq', n));
  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
    select e, cf1c.id('rv', n), cf1c.id('ent', n, k2), k2 <= 3, '{}' from generate_series(1, 4) k2;
  perform set_config('session_replication_role', 'origin', true);
end $$;
select cf1c.mk(n) from generate_series(1, 6) n;
SQL

# As the owner through the authenticated role (apply needs auth.uid()).
AS="select set_config('request.jwt.claims', '{\"sub\":\"$U\",\"role\":\"authenticated\"}', false); set role authenticated;"
adv_count() { echo "select count(*) from public.event_competition_round_advancements where source_round_id = cf1c.id('src', $1)" | $PN | tr -d '\r'; }

# ---------------------------------------------------------------- R1 apply || apply (different request ids)
(echo "$AS begin; select public.apply_competition_round_advancement(cf1c.id('src',1), cf1c.id('rv',1), cf1c.id('req1',1)); select pg_sleep(3); commit;" | $PN > /tmp/cf1c_r1a.out 2>&1) &
sleep 1
echo "$AS select public.apply_competition_round_advancement(cf1c.id('src',1), cf1c.id('rv',1), cf1c.id('req2',1));" | $PN > /tmp/cf1c_r1b.out 2>&1
wait
if [ "$(adv_count 1)" = "1" ] && grep -q "COMP_ADVANCEMENT_ALREADY_APPLIED" /tmp/cf1c_r1b.out; then ok "R1 apply || apply: exactly one advancement, the second is ALREADY_APPLIED after waiting"; else bad "R1 ($(adv_count 1)): $(cat /tmp/cf1c_r1b.out | head -3)"; fi

# ---------------------------------------------------------------- R2 apply || direct entry update (U23)
(echo "begin; update public.event_competition_entries set eligibility_status = 'ineligible' where id = cf1c.id('ent', 2, 2); select pg_sleep(3); commit;" | $PN > /tmp/cf1c_r2a.out 2>&1) &
sleep 1
echo "$AS select public.apply_competition_round_advancement(cf1c.id('src',2), cf1c.id('rv',2), cf1c.id('req1',2));" | $PN > /tmp/cf1c_r2b.out 2>&1
wait
if [ "$(adv_count 2)" = "0" ] && grep -q "COMP_ADVANCEMENT_ENTRY_UNAVAILABLE" /tmp/cf1c_r2b.out; then ok "R2 apply waits for the entry writer, revalidates and refuses ENTRY_UNAVAILABLE"; else bad "R2 ($(adv_count 2)): $(head -3 /tmp/cf1c_r2b.out)"; fi
echo "update public.event_competition_entries set eligibility_status = 'eligible' where id = cf1c.id('ent', 2, 2);" | $PN >/dev/null

# ---------------------------------------------------------------- R3 apply never waits on a version-row UPDATE (FOR KEY SHARE vs NO KEY UPDATE)
(echo "begin; update public.event_competition_schedule_versions set name = 'V1 renamed' where id = cf1c.id('sv'); select pg_sleep(4); commit;" | $PN > /tmp/cf1c_r3a.out 2>&1) &
sleep 1
T0=$(date +%s)
echo "$AS select public.apply_competition_round_advancement(cf1c.id('src',3), cf1c.id('rv',3), cf1c.id('req1',3));" | $PN > /tmp/cf1c_r3b.out 2>&1
T1=$(date +%s)
wait
if [ "$(adv_count 3)" = "1" ] && [ $((T1 - T0)) -le 2 ]; then ok "R3 apply did not wait for a version-row update ($((T1 - T0))s)"; else bad "R3 ($(adv_count 3), $((T1 - T0))s): $(head -3 /tmp/cf1c_r3b.out)"; fi

# ---------------------------------------------------------------- R4 start || a held Final heat (NOWAIT)
echo "$AS select public.apply_competition_round_advancement(cf1c.id('src',4), cf1c.id('rv',4), cf1c.id('req1',4));" | $PN >/dev/null 2>&1
(echo "begin; select 1 from public.event_competition_heats where round_id = cf1c.id('fin', 4) and status <> 'cancelled' for update; select pg_sleep(4); commit;" | $PN > /tmp/cf1c_r4a.out 2>&1) &
sleep 1
echo "set session_replication_role = replica; update public.event_competition_rounds set status = 'active' where id = cf1c.id('fin', 4);" | $PN > /tmp/cf1c_r4b.out 2>&1
wait
ST="$(echo "select status from public.event_competition_rounds where id = cf1c.id('fin', 4)" | $PN | tr -d '\r')"
if [ "$ST" = "scheduled" ] && grep -q "COMP_ADVANCEMENT_CONCURRENT_CHANGE" /tmp/cf1c_r4b.out; then ok "R4 start never waits on a held Final heat: 55P03 COMP_ADVANCEMENT_CONCURRENT_CHANGE, round still scheduled"; else bad "R4 ($ST): $(head -3 /tmp/cf1c_r4b.out)"; fi
echo "set session_replication_role = replica; update public.event_competition_rounds set status = 'active' where id = cf1c.id('fin', 4);" | $PN > /tmp/cf1c_r4c.out 2>&1
ST="$(echo "select status from public.event_competition_rounds where id = cf1c.id('fin', 4)" | $PN | tr -d '\r')"
if [ "$ST" = "active" ]; then ok "R4b once the holder committed the same start succeeds"; else bad "R4b ($ST): $(head -3 /tmp/cf1c_r4c.out)"; fi

# ---------------------------------------------------------------- R5 correction (revoke) || a held Final heat (NOWAIT)
echo "$AS select public.apply_competition_round_advancement(cf1c.id('src',5), cf1c.id('rv',5), cf1c.id('req1',5));" | $PN >/dev/null 2>&1
(echo "begin; select 1 from public.event_competition_heats where round_id = cf1c.id('fin', 5) and status <> 'cancelled' for update; select pg_sleep(4); commit;" | $PN > /tmp/cf1c_r5a.out 2>&1) &
sleep 1
echo "$AS select public.open_competition_round_correction(cf1c.id('src',5), 'judge error found in the callback', cf1c.id('corr', 5));" | $PN > /tmp/cf1c_r5b.out 2>&1
wait
ST="$(echo "select status from public.event_competition_rounds where id = cf1c.id('src', 5)" | $PN | tr -d '\r')"
ACT="$(echo "select public._cf1_active_advancement(cf1c.id('fin', 5)) is not null" | $PN | tr -d '\r')"
if [ "$ST" = "approved" ] && [ "$ACT" = "t" ] && grep -q "COMP_ADVANCEMENT_CONCURRENT_CHANGE" /tmp/cf1c_r5b.out; then ok "R5 correction vs a held Final heat: 55P03, correction not opened, advancement still active"; else bad "R5 ($ST $ACT): $(head -3 /tmp/cf1c_r5b.out)"; fi

cleanup
rm -f /tmp/cf1c_*.out
[ $FAIL -eq 0 ] && { echo "COMPETITION CF1 A0 CONCURRENCY PASS"; exit 0; }
echo "COMPETITION CF1 A0 CONCURRENCY FAIL"
exit 1
