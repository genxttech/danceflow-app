#!/bin/sh
# Competition CF1 package A6 -- two-session races with REAL second connections.
#
# Needs a disposable Postgres with the chain through HL1, A1, A0 and A6 applied (never a hosted database), and the shared slot lock held by the caller.
# Fixtures are committed (a synthetic event ...cf6c0e), then the event is removed at the end (the history triggers allow the cascade).
#   CONTAINER=cf1-a6-db sh test_T_competition_cf1_a6_concurrency.sh
# Exit 0 = every assertion held, 1 = a failure, 3 = blocked (could not set up).
# Races: R1 two co-signs for different couples (U41: seq 1,2, no duplicate, the second waits on the round lock),
#        R2 co-sign || the callback correction (heat NOWAIT: 55P03 COMP_ADVANCEMENT_CONCURRENT_CHANGE, nothing half-done),
#        R3 co-sign || apply (event lock + Final round lock serialize them: the final roster is the advanced list minus the withdrawal),
#        R4 U51: a direct un-scratch waits on the co-sign's row lock and, once it commits, the VOLATILE guard re-fires on the newest row version and refuses,
#        R5 U51 negative control: the same race with the guard declared STABLE lets the un-scratch through (why the guard must be VOLATILE).
set -u
C="${CONTAINER:-cf1-a6-db}"
P="docker exec -i $C psql -U postgres -h localhost -v ON_ERROR_STOP=1 -X -q -At"
PN="docker exec -i $C psql -U postgres -h localhost -X -q -At"
E=00000000-0000-0000-0000-cf6c0e000001
S=00000000-0000-0000-0000-cf6c0e00a001
U1=00000000-0000-0000-0000-cf6c0e000011
U2=00000000-0000-0000-0000-cf6c0e000012
FAIL=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
T=$(mktemp -d 2>/dev/null || echo /tmp/cf6c.$$)
mkdir -p "$T"

cleanup() {
  $PN >/dev/null 2>&1 <<SQL
alter function public.cf1_guard_withdrawn_heat_entry() volatile;
delete from public.events where id = '$E';
drop schema if exists cf6c cascade;
SQL
}

cleanup
$P <<'SQL' || { echo "BLOCKED: fixture setup failed"; cleanup; exit 3; }
create schema cf6c;
create function cf6c.id(k text, n int default 0, j int default 0) returns uuid language sql immutable as $$ select md5('cf6c:' || k || ':' || n || ':' || j)::uuid $$;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf6c0e000011', 't-cf6c-u1@example.test'), ('00000000-0000-0000-0000-cf6c0e000012', 't-cf6c-u2@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) select id, email, 'CF6C ' || email from auth.users where email like 't-cf6c-%' on conflict do nothing;
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf6c-%' on conflict do nothing;
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf6c0e00a001', 'CF6C Studio', 't-cf6c-studio') on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-cf6c0e000011', '00000000-0000-0000-0000-cf6c0e00a001', 'studio_owner', true),
  ('00000000-0000-0000-0000-cf6c0e000012', '00000000-0000-0000-0000-cf6c0e00a001', 'studio_admin', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('00000000-0000-0000-0000-cf6c0e000001', '00000000-0000-0000-0000-cf6c0e00a001', 'CF6C', 't-cf6c', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
  values (cf6c.id('prg'), '00000000-0000-0000-0000-cf6c0e000001', '00000000-0000-0000-0000-cf6c0e00a001', 'CB', 'country', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values (cf6c.id('cts'), '00000000-0000-0000-0000-cf6c0e000001', cf6c.id('prg'), 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
  values (cf6c.id('sv'), '00000000-0000-0000-0000-cf6c0e000001', 1, 'V1', 'published', now());
create function cf6c.mk(n int) returns void language plpgsql as $$
declare e uuid := '00000000-0000-0000-0000-cf6c0e000001'; k int; h text;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values (cf6c.id('div', n), e, cf6c.id('prg'), cf6c.id('cts'), 'D' || n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
    values (cf6c.id('src', n), e, cf6c.id('prg'), cf6c.id('div', n), 'cb' || n, 'preliminary', 1, 'approved', 'callback_tally', 4);
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
    values (cf6c.id('fin', n), e, cf6c.id('prg'), cf6c.id('div', n), 'fin' || n, 'final', 2, 'scheduled', 'ordinal_majority');
  for k in 1..5 loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
      values (cf6c.id('ent', n, k), e, cf6c.id('prg'), cf6c.id('div', n), 'e' || n || '-' || k, 'confirmed', 'eligible', k::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (cf6c.id('cbf', n), e, cf6c.id('sv'), n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
    values (cf6c.id('cbh', n), e, cf6c.id('div', n), cf6c.id('src', n), 1, 'complete', 'certified', cf6c.id('cts'), cf6c.id('sv'), cf6c.id('cbf', n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (e, cf6c.id('cbh', n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    select e, cf6c.id('div', n), cf6c.id('cbh', n), cf6c.id('ent', n, k2), k2, 'danced' from generate_series(1, 5) k2;
  h := public._compf2_input_hash(cf6c.id('src', n), 'callback_tally', '1');
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
    values (cf6c.id('rv', n), e, cf6c.id('src', n), 1, 'callback_tally', '1', h, 't', '{}', '{}', '00000000-0000-0000-0000-cf6c0e000011', 'approved', cf6c.id('rq', n));
  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
    select e, cf6c.id('rv', n), cf6c.id('ent', n, k2), k2 <= 4, '{}' from generate_series(1, 5) k2;
  perform set_config('session_replication_role', 'origin', true);
end $$;
select cf6c.mk(n) from generate_series(1, 5) n;
grant usage on schema cf6c to authenticated;
grant execute on all functions in schema cf6c to authenticated;
SQL

AS1="select set_config('request.jwt.claims', '{\"sub\":\"$U1\",\"role\":\"authenticated\"}', false); set role authenticated;"
AS2="select set_config('request.jwt.claims', '{\"sub\":\"$U2\",\"role\":\"authenticated\"}', false); set role authenticated;"
ID() { $P -c "select cf6c.id('$1', $2, ${3:-0})"; }
apply() { $P -c "$AS1 select (public.apply_competition_round_advancement(cf6c.id('src', $1), cf6c.id('rv', $1), cf6c.id('ap', $1, $2)))->>'generation';" 2>&1 | tail -1; }
request() { $P -c "$AS1 select (public.withdraw_advanced_entry_from_final(cf6c.id('fin', $1), cf6c.id('ent', $1, $2), 'the couple asked to leave the final after an injury', cf6c.id('rw', $1, $2)))->>'state';" 2>&1 | tail -1; }
q() { $P -c "$1" 2>&1; }

# ---------------------------------------------------------------- R1: two co-signs, seq 1 and 2
[ "$(apply 1 1)" = "1" ] || { echo "BLOCKED: apply 1 failed"; cleanup; exit 3; }
[ "$(request 1 1)" = "pending" ] && [ "$(request 1 2)" = "pending" ] || { echo "BLOCKED: requests failed"; cleanup; exit 3; }
( $PN >"$T/r1a.out" 2>&1 <<SQL
begin;
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 1, 1)))->>'seq';
select pg_sleep(3);
commit;
SQL
) &
sleep 1
( $PN >"$T/r1b.out" 2>&1 <<SQL
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 1, 2)))->>'seq';
SQL
) &
wait
[ "$(q "select string_agg(seq::text, ',' order by seq) from public.event_competition_final_withdrawals where target_round_id = cf6c.id('fin', 1)")" = "1,2" ] \
  && ok "R1 U41: two concurrent co-signs got seq 1 and 2 (monotonic, no duplicate; the second waited on the round lock)" || bad "R1 seqs: $(q "select string_agg(seq::text, ',') from public.event_competition_final_withdrawals where target_round_id = cf6c.id('fin', 1)") A=$(cat "$T/r1a.out") B=$(cat "$T/r1b.out")"
[ "$(q "select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = cf6c.id('fin', 1) and he.status = 'scratched'")" = "2" ] \
  && ok "R1: both Final heat entries are scratched" || bad "R1 scratch count"

# ---------------------------------------------------------------- R2: co-sign || correction (heat NOWAIT)
[ "$(apply 2 2)" = "1" ] || { echo "BLOCKED: apply 2 failed"; cleanup; exit 3; }
[ "$(request 2 1)" = "pending" ] || { echo "BLOCKED: request 2 failed"; cleanup; exit 3; }
( $PN >"$T/r2a.out" 2>&1 <<SQL
begin;
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 2, 1)))->>'seq';
select pg_sleep(3);
commit;
SQL
) &
sleep 1
( $PN >"$T/r2b.out" 2>&1 <<SQL
$AS1
select public.open_competition_round_correction(cf6c.id('src', 2), 'judge error found in the callback', cf6c.id('cr', 2));
SQL
) &
wait
if grep -q 'COMP_ADVANCEMENT_CONCURRENT_CHANGE' "$T/r2b.out" || grep -q '55P03' "$T/r2b.out" || grep -qi 'could not obtain lock' "$T/r2b.out"; then
  ok "R2: the correction behind a held Final heat is refused retryably (55P03 / CONCURRENT_CHANGE) and the co-sign committed"
else bad "R2: correction output: $(cat "$T/r2b.out")"; fi
[ "$(q "select status from public.event_competition_rounds where id = cf6c.id('src', 2)")" = "approved" ] && [ "$(q "select count(*) from public.event_competition_final_withdrawals where target_round_id = cf6c.id('fin', 2)")" = "1" ] \
  && ok "R2: nothing half-done (callback still approved, one withdrawal row, advancement still active)" || bad "R2 state"

# ---------------------------------------------------------------- R3: co-sign || apply (between a revoke and the next apply)
[ "$(apply 3 3)" = "1" ] || { echo "BLOCKED: apply 3 failed"; cleanup; exit 3; }
$P -c "$AS1 select public.open_competition_round_correction(cf6c.id('src', 3), 'judge error found in the callback', cf6c.id('cr', 3));" >/dev/null 2>&1 || { echo "BLOCKED: correction 3 failed"; cleanup; exit 3; }
$P <<SQL >/dev/null 2>&1 || { echo "BLOCKED: regen 3 failed"; cleanup; exit 3; }
begin;
select set_config('session_replication_role', 'replica', true);
update public.event_competition_rounds set status = 'approved' where id = cf6c.id('src', 3);
insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (cf6c.id('rv2', 3), '$E', cf6c.id('src', 3), 2, 'callback_tally', '1', public._compf2_input_hash(cf6c.id('src', 3), 'callback_tally', '1'), 't2', '{}', '{}', '$U1', 'approved', cf6c.id('rq2', 3));
insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
  select '$E', cf6c.id('rv2', 3), cf6c.id('ent', 3, k), k <= 4, '{}' from generate_series(1, 5) k;
commit;
SQL
[ "$(request 3 2)" = "pending" ] || { echo "BLOCKED: request 3 failed"; cleanup; exit 3; }
( $PN >"$T/r3a.out" 2>&1 <<SQL
begin;
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 3, 2)))->>'seq';
select pg_sleep(3);
commit;
SQL
) &
sleep 1
( $PN >"$T/r3b.out" 2>&1 <<SQL
$AS1
select (public.apply_competition_round_advancement(cf6c.id('src', 3), cf6c.id('rv2', 3), cf6c.id('ap', 3, 2)))->>'carried';
SQL
) &
wait
[ "$(tail -1 "$T/r3b.out")" = "1" ] && ok "R3: apply waited for the co-sign (event lock) and then carried the withdrawn couple" || bad "R3 apply output: $(cat "$T/r3b.out")"
[ "$(q "select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = cf6c.id('fin', 3) and h.status <> 'cancelled'")" = "3" ] \
  && ok "R3: the active heat holds the advanced list minus the withdrawal (3 of 4)" || bad "R3 roster size"

# ---------------------------------------------------------------- R4 / R5: U51
[ "$(apply 4 4)" = "1" ] || { echo "BLOCKED: apply 4 failed"; cleanup; exit 3; }
[ "$(request 4 1)" = "pending" ] || { echo "BLOCKED: request 4 failed"; cleanup; exit 3; }
( $PN >"$T/r4a.out" 2>&1 <<SQL
begin;
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 4, 1)))->>'seq';
select pg_sleep(4);
commit;
SQL
) &
sleep 1
( $PN >"$T/r4b.out" 2>&1 <<SQL
update public.event_competition_heat_entries set status = 'checked_in' where entry_id = cf6c.id('ent', 4, 1) and heat_id in (select id from public.event_competition_heats where round_id = cf6c.id('fin', 4));
SQL
) &
wait
if grep -q 'COMP_WITHDRAWAL_GUARD' "$T/r4b.out"; then ok "R4 U51: the direct un-scratch waited on the row lock, the guard re-fired on the newest row version, saw the committed withdrawal and refused"
else bad "R4 output: $(cat "$T/r4b.out")"; fi
[ "$(q "select he.status from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = cf6c.id('fin', 4) and he.entry_id = cf6c.id('ent', 4, 1)")" = "scratched" ] \
  && ok "R4: the withdrawn couple is still scratched" || bad "R4 final status"

[ "$(apply 5 5)" = "1" ] || { echo "BLOCKED: apply 5 failed"; cleanup; exit 3; }
[ "$(request 5 1)" = "pending" ] || { echo "BLOCKED: request 5 failed"; cleanup; exit 3; }
$P -c "alter function public.cf1_guard_withdrawn_heat_entry() stable;" >/dev/null
( $PN >"$T/r5a.out" 2>&1 <<SQL
begin;
$AS2
select (public.cosign_final_withdrawal_request(cf6c.id('rw', 5, 1)))->>'seq';
select pg_sleep(4);
commit;
SQL
) &
sleep 1
( $PN >"$T/r5b.out" 2>&1 <<SQL
update public.event_competition_heat_entries set status = 'checked_in' where entry_id = cf6c.id('ent', 5, 1) and heat_id in (select id from public.event_competition_heats where round_id = cf6c.id('fin', 5));
SQL
) &
wait
$P -c "alter function public.cf1_guard_withdrawn_heat_entry() volatile;" >/dev/null
if ! grep -q 'COMP_WITHDRAWAL_GUARD' "$T/r5b.out" && [ "$(q "select he.status from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = cf6c.id('fin', 5) and he.entry_id = cf6c.id('ent', 5, 1)")" = "checked_in" ]; then
  ok "R5 control: with the guard STABLE the same race lets the un-scratch through (a withdrawn couple un-scratched), which is why the guard is VOLATILE (restored to VOLATILE)"
else bad "R5 control did not demonstrate the stale-snapshot bypass: $(cat "$T/r5b.out")"; fi
[ "$(q "select provolatile from pg_proc where proname = 'cf1_guard_withdrawn_heat_entry'")" = "v" ] && ok "the guard is VOLATILE again" || bad "guard volatility not restored"

cleanup
rm -rf "$T"
[ "$FAIL" = "0" ] && echo "COMPETITION CF1 A6 CONCURRENCY PASS" || echo "COMPETITION CF1 A6 CONCURRENCY FAIL"
exit $FAIL
