#!/usr/bin/env bash
# Competition CF1 package A0 -- tie-over-capacity (SCN-11.4b) multi-session races on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1-a0-tie-pg DBUSER=supabase_admin bash test_T_competition_cf1_a0_tie_concurrency.sh
#
# The database must already carry the chain through HL1, A1, A0, A3, A5 and A7 (same chain as test_T_competition_cf1_a0_tie_policy.sql).
# The script COMMITS synthetic fixtures (schema cf1tie, users t-cf1a0t-*, event md5('cf1a0t:evt:1:0')) and removes them again at the end
# (best effort): run it only on a disposable container, with the shared slot lock held by the caller. Never against a shared or hosted DB.
# The helper functions and the fixture rows are NOT duplicated here: the block between the SHARED-BEGIN and SHARED-END marker comments of the SQL suite is
# loaded with "pg_temp." renamed to "cf1tie." so both files always use the same scenario builder and the same model of the F1 engine rows.
# Exit 0 = every assertion held, 1 = a failure, 3 = blocked (could not set up).
# Races (every scenario is a CALCULATED callback_tally version whose rows are ALL advanced = NULL, i.e. an over-capacity tie):
#   i-a   approve queued first, correction open queued second, both behind a held round row   -> approve refused COMP_ADVANCEMENT_BLOCKED, correction opens, nothing approved
#   i-b   correction open queued first, approve second                                        -> approve refused (round no longer calculated), correction opens
#   ii-a  calculate (uncommitted) || F1 capacity raise-to-T (legacy Final capacity 2 < T 3)   -> blocked version stored; raise may commit; nothing advances
#   ii-b  F1 capacity raise-to-T (uncommitted) || calculate                                    -> same invariants
#   iii   two applies (different request ids) + a replay, queued behind a held round row      -> all refused, nothing written
#   e     a result row inserted for the blocked version from a LATER transaction               -> COMPF2_ROW_IMMUTABLE, rows unchanged (history guard from another transaction)
#   S4    two successive committed corrections: still blocked, then resolved (generation 1)
set -u
export MSYS_NO_PATHCONV=1   # Git Bash on Windows must not rewrite the container paths below
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-supabase_admin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SUITE="$HERE/test_T_competition_cf1_a0_tie_policy.sql"
W="$(mktemp -d)"
FAIL=0
psq() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$DBUSER" -h localhost -d postgres -At -q -X "$@"; }
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAIL=1; }
note() { echo "NOTE  $1"; }
Q() { psq -c "$1" </dev/null 2>&1 | tr -d '\r'; }
as_sql() { printf "select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\nset role authenticated;\n%s\n" "$1" "$2"; }
S() { echo "cf1tie.id('src', $1)"; }
F() { echo "cf1tie.id('fin', $1)"; }
V() { echo "(select id from public.event_competition_result_versions where round_id = cf1tie.id('src', $1) and version = $2)"; }

cleanup() {
  psq >/dev/null 2>&1 <<'SQL'
set session_replication_role = replica;
update public.event_competition_heats set lock_state = 'open' where event_id = md5('cf1a0t:evt:1:0')::uuid;
set session_replication_role = origin;
delete from public.events where id = md5('cf1a0t:evt:1:0')::uuid;
delete from public.studios where slug = 't-cf1a0t-a';
delete from public.verified_email_identities where email like 't-cf1a0t-%';
delete from public.user_studio_roles where studio_id not in (select id from public.studios);
delete from public.profiles where email like 't-cf1a0t-%';
delete from auth.users where email like 't-cf1a0t-%';
drop schema if exists cf1tie cascade;
SQL
}
cleanup

# ---- load the shared helper / fixture block as schema cf1tie (committed)
B=$(grep -n '^-- @@SHARED-BEGIN' "$SUITE" | head -1 | cut -d: -f1); E=$(grep -n '^-- @@SHARED-END$' "$SUITE" | head -1 | cut -d: -f1)
[ -n "$B" ] && [ -n "$E" ] || { echo "BLOCKED: shared block markers not found in $SUITE"; exit 3; }
{ echo "create schema cf1tie;"; echo "grant usage on schema cf1tie to authenticated, anon, service_role;"
  sed -n "${B},${E}p" "$SUITE" | sed 's/\r$//; s/schema pg_temp/schema cf1tie/g; s/pg_temp\./cf1tie./g'; } | psq -v ON_ERROR_STOP=1 >/dev/null 2>"$W/load.err" || { echo "BLOCKED: shared block failed to load: $(head -3 "$W/load.err")"; cleanup; exit 3; }
[ "$(Q "select to_regprocedure('public.cosign_competition_correction(uuid,uuid)') is not null")" = "t" ] || { echo "BLOCKED: A7 (cosign_competition_correction) is not installed"; cleanup; exit 3; }
U1=$(Q "select cf1tie.id('user', 1)"); U2=$(Q "select cf1tie.id('user', 2)")
[ -n "$U1" ] || { echo "BLOCKED: fixtures missing"; cleanup; exit 3; }

# A7 helpers (also defined in the suite inside its \if block)
psq -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || { echo "BLOCKED: A7 helpers"; cleanup; exit 3; }
create function cf1tie.open_corr(p_n int, p_user int default 1, p_req int default 1) returns jsonb language plpgsql as $$
begin
  return cf1tie.run_as(cf1tie.id('user', p_user), format($q$select public.open_competition_round_correction(%L, 'judge entry error found after the callback was calculated', %L)$q$,
                       cf1tie.id('src', p_n), cf1tie.id('creq', p_n, p_req)));
end $$;
create function cf1tie.cause(p_n int) returns public.event_competition_correction_causes language sql stable security definer as $$
  select c from public.event_competition_correction_causes c where c.round_id = cf1tie.id('src', p_n) order by c.seq desc limit 1
$$;
create function cf1tie.cosign(p_n int, p_user int default 2) returns jsonb language plpgsql as $$
begin
  return cf1tie.run_as(cf1tie.id('user', p_user), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (cf1tie.cause(p_n)).id));
end $$;
SQL

# blocked n cap: scenario n, Final capacity cap (via the RPC), ballots J11 {1,2,3} J12 {1,2,4} J13 {1,3,4}, locked, calculated -> a blocked tie
blocked() {
  psq -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "BLOCKED: scenario $1 setup failed"; cleanup; exit 3; }
select cf1tie.mk($1, 3);
select cf1tie.set_cap($1, $2);
select cf1tie.vtie($1);
select cf1tie.lockit($1);
select cf1tie.calc($1, $2);
SQL
  [ "$(Q "select count(*) = 8 and count(*) filter (where advanced is null) = 8 from public.event_competition_result_rows where result_version_id = $(V $1 1)")" = "t" ] || { echo "BLOCKED: scenario $1 is not a blocked tie"; cleanup; exit 3; }
}
snap() { Q "select cf1tie.snap($1)"; }
adv() { Q "select count(*) from public.event_competition_round_advancements where source_round_id = $(S $1)"; }
approvals() { Q "select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = $(S $1)"; }
rstatus() { Q "select status from public.event_competition_rounds where id = $(S $1)"; }
vstatus() { Q "select status from public.event_competition_result_versions where id = $(V $1 $2)"; }
nullrows() { Q "select count(*) filter (where advanced is null) || '/' || count(*) from public.event_competition_result_rows where result_version_id = $(V $1 $2)"; }
HOLD() { psq -c "begin; select 1 from public.event_competition_rounds where id = $(S $1) for update; select pg_sleep($2); commit;" </dev/null >/dev/null 2>&1; }
APPROVE() { as_sql "$U2" "select public.approve_competition_round_result($(S $1), $(V $1 $2), null, gen_random_uuid());" | psq; }
OPENCORR() { as_sql "$U1" "select public.open_competition_round_correction($(S $1), 'judge entry error found after the callback was calculated', gen_random_uuid());" | psq; }
APPLY() { as_sql "$U1" "select public.apply_competition_round_advancement($(S $1), $(V $1 $2), $3);" | psq; }

# ---------------------------------------------------------------- i-a approve queued first, correction second (behind a held round row)
echo "== i-a: approve || correction-open on a blocked version (approve queued first) =="
blocked 11 3
( HOLD 11 3 ) &
sleep 1
( APPROVE 11 1 > "$W/ia_a" 2>&1 ) &
sleep 0.6
( OPENCORR 11 > "$W/ia_b" 2>&1 ) &
wait
if grep -q "COMP_ADVANCEMENT_BLOCKED" "$W/ia_a" && [ "$(approvals 11)" = "0" ] && [ "$(adv 11)" = "0" ] && [ "$(rstatus 11)" = "ballots_locked" ] && [ "$(vstatus 11 1)" = "stale" ] \
   && [ "$(nullrows 11 1)" = "8/8" ] && [ "$(Q "select count(*) from public.event_competition_correction_causes where round_id = $(S 11)")" = "1" ]; then
  ok "i-a approve refused COMP_ADVANCEMENT_BLOCKED, then the correction opened once: no approval, no advancement, v1 stale with all 8 rows still NULL"
else bad "i-a" "approve: $(head -2 "$W/ia_a" | tr '\n' ' ') corr: $(head -2 "$W/ia_b" | tr '\n' ' ') status=$(rstatus 11) v1=$(vstatus 11 1) approvals=$(approvals 11) adv=$(adv 11) null=$(nullrows 11 1)"; fi

# ---------------------------------------------------------------- i-b correction queued first, approve second
echo "== i-b: correction-open || approve on a blocked version (correction queued first) =="
blocked 12 3
( HOLD 12 3 ) &
sleep 1
( OPENCORR 12 > "$W/ib_b" 2>&1 ) &
sleep 0.6
( APPROVE 12 1 > "$W/ib_a" 2>&1 ) &
wait
if grep -q "COMP_RESULT_INVALID_TRANSITION" "$W/ib_a" && [ "$(approvals 12)" = "0" ] && [ "$(adv 12)" = "0" ] && [ "$(rstatus 12)" = "ballots_locked" ] && [ "$(vstatus 12 1)" = "stale" ] \
   && [ "$(nullrows 12 1)" = "8/8" ] && [ "$(Q "select count(*) from public.event_competition_correction_causes where round_id = $(S 12)")" = "1" ]; then
  ok "i-b the correction opened first; the queued approve was refused (round no longer calculated): no approval, no advancement, evidence intact"
else bad "i-b" "approve: $(head -2 "$W/ib_a" | tr '\n' ' ') corr: $(head -2 "$W/ib_b" | tr '\n' ' ') status=$(rstatus 12) v1=$(vstatus 12 1) approvals=$(approvals 12) adv=$(adv 12) null=$(nullrows 12 1)"; fi

# ---------------------------------------------------------------- ii capacity vs calculate (legacy Final capacity 2 < T 3, so the F1 raise-to-T path is open)
ii_setup() {
  psq -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "BLOCKED: scenario $1 setup failed"; cleanup; exit 3; }
select cf1tie.mk($1, 3);
select cf1tie.legacy_cap($1, 2);
select cf1tie.vtie($1);
select cf1tie.lockit($1);
SQL
}
ii_check() { # $1 scenario, $2 label
  n=$1; cap=$(Q "select configuration->>'max_entries_per_heat' from public.event_competition_rounds where id = $(F $n)")
  fe=$(Q "select count(*) from public.event_competition_round_capacity_events where round_id = $(F $n) and exemption = 'f1_raise_to_t'")
  tied=$(Q "select count(*) from public.event_competition_result_rows where result_version_id = $(V $n 1) and output->>'tie_status' in ('above_cut', 'tied_at_cut')")
  appr=$(APPROVE $n 1 2>&1)
  capok=0
  { [ "$cap" = "3" ] && [ "$fe" = "1" ]; } && capok=1
  { [ "$cap" = "2" ] && [ "$fe" = "0" ]; } && capok=1
  if [ "$(vstatus $n 1)" = "calculated" ] && [ "$(nullrows $n 1)" = "8/8" ] && [ "$(adv $n)" = "0" ] && [ "$(approvals $n)" = "0" ] && echo "$appr" | grep -qE "COMP_ADVANCEMENT_BLOCKED|COMP_RESULT_STALE"      && [ $capok = 1 ] && [ "$tied" -gt "$cap" ]; then
    ok "$2 invariants: blocked version stored (all rows NULL), approve refused, nothing advanced, capacity $cap ($fe F1 raise), tie of $tied couples still exceeds the capacity"
    note "$2 observed order: $([ "$cap" = "3" ] && echo 'F1 raise-to-T committed and the blocked version also committed (benign: a tie has more than T couples, so raising capacity to exactly T cannot dissolve it)' || echo 'raise refused / not applied')"
  else bad "$2" "version=$(vstatus $n 1) null=$(nullrows $n 1) adv=$(adv $n) approvals=$(approvals $n) cap=$cap f1events=$fe tied=$tied approve: $(echo "$appr" | head -2 | tr '\n' ' ')"; fi
}
echo "== ii-a: calculate (uncommitted) || F1 capacity raise-to-T =="
ii_setup 13
CS=$(Q "select cf1tie.calc_sql(13, 2)")
( as_sql "$U1" "begin; $CS; select pg_sleep(3); commit;" | psq > "$W/iia_calc" 2>&1 ) &
sleep 1
as_sql "$U1" "select public.set_competition_round_heat_capacity($(F 13), 3, 'Floor limit now allows three couples.', gen_random_uuid());" | psq > "$W/iia_cap" 2>&1
wait
ii_check 13 "ii-a"
echo "== ii-b: F1 capacity raise-to-T (uncommitted) || calculate =="
ii_setup 14
CS=$(Q "select cf1tie.calc_sql(14, 2)")
( as_sql "$U1" "begin; select public.set_competition_round_heat_capacity($(F 14), 3, 'Floor limit now allows three couples.', gen_random_uuid()); select pg_sleep(3); commit;" | psq > "$W/iib_cap" 2>&1 ) &
sleep 1
as_sql "$U1" "$CS;" | psq > "$W/iib_calc" 2>&1
wait
ii_check 14 "ii-b"
# the capacity that is committed AFTER a blocked version exists is refused (sequential, after the race): the F1 guard
echo "== ii-c: after a committed blocked version, the F1 raise-to-T is refused =="
blocked 15 3
Q "select cf1tie.legacy_cap(15, 2)" >/dev/null
as_sql "$U1" "select public.set_competition_round_heat_capacity($(F 15), 3, 'Floor limit now allows three couples.', gen_random_uuid());" | psq > "$W/iic" 2>&1
if grep -q "COMP_CAPACITY_F1_BLOCKED_TIE" "$W/iic" && [ "$(Q "select configuration->>'max_entries_per_heat' from public.event_competition_rounds where id = $(F 15)")" = "2" ]; then
  ok "ii-c F1 raise-to-T refused COMP_CAPACITY_F1_BLOCKED_TIE once the blocked version is committed; capacity unchanged"
else bad "ii-c" "$(head -2 "$W/iic" | tr '\n' ' ')"; fi

# ---------------------------------------------------------------- iii two applies (+ a replay) on a blocked version
echo "== iii: concurrent applies on a blocked version =="
blocked 16 3
SN0=$(snap 16)
( HOLD 16 3 ) &
sleep 1
( APPLY 16 1 "gen_random_uuid()" > "$W/iii_a" 2>&1 ) &
( APPLY 16 1 "gen_random_uuid()" > "$W/iii_b" 2>&1 ) &
sleep 0.4
( APPLY 16 1 "cf1tie.id('areq', 16, 1)" > "$W/iii_c" 2>&1 ) &
wait
bothrefused=1
for x in iii_a iii_b iii_c; do grep -q "COMP_ADVANCEMENT_SOURCE_STATE\|COMP_ADVANCEMENT_BLOCKED" "$W/$x" || bothrefused=0; done
if [ $bothrefused = 1 ] && [ "$(adv 16)" = "0" ] && [ "$(snap 16)" = "$SN0" ]; then
  ok "iii three concurrent applies queued behind a held round row are all refused; nothing written (advancement, Final heat, floor heat, approval, versions unchanged)"
else bad "iii" "a=$(head -1 "$W/iii_a") b=$(head -1 "$W/iii_b") c=$(head -1 "$W/iii_c") snap=$(snap 16)"; fi

# ---------------------------------------------------------------- e a row inserted for the blocked version in a later transaction
echo "== e: a result row insert from a later transaction =="
psq >"$W/e1" 2>&1 <<SQL
insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
values (cf1tie.id('evt', 1), $(V 16 1), cf1tie.id('ent', 16, 1), true, '{}');
SQL
if grep -q "COMPF2_ROW_IMMUTABLE" "$W/e1" && [ "$(nullrows 16 1)" = "8/8" ]; then ok "e a row written for the blocked version outside its creating transaction is refused COMPF2_ROW_IMMUTABLE (rows unchanged)"
else bad "e" "$(head -2 "$W/e1" | tr '\n' ' ') rows=$(nullrows 16 1)"; fi
psq >"$W/e2" 2>&1 <<SQL
update public.event_competition_result_rows set advanced = true where result_version_id = $(V 16 1);
SQL
if grep -q "append-only evidence" "$W/e2" && [ "$(nullrows 16 1)" = "8/8" ]; then ok "e an UPDATE of the blocked version's rows from a later transaction is refused (append-only evidence)"
else bad "e2" "$(head -2 "$W/e2" | tr '\n' ' ') rows=$(nullrows 16 1)"; fi

# ---------------------------------------------------------------- S4 two successive committed corrections
echo "== S4: first correction leaves the tie, the second resolves it (committed transactions) =="
blocked 17 3
Q "select cf1tie.open_corr(17, 1, 1)" >/dev/null
Q "select cf1tie.cosign(17, 2)" >/dev/null
Q "select cf1tie.file(17, 13, array[1, 2, 5], 'entry error')" >/dev/null
Q "select cf1tie.calc(17, 3)" >/dev/null
if [ "$(vstatus 17 2)" = "calculated" ] && [ "$(nullrows 17 2)" = "8/8" ] && [ "$(vstatus 17 1)" = "superseded" ]; then ok "S4 first corrected ballot (J13 {1,2,5}) still leaves a tie: v2 blocked (8/8 NULL), v1 superseded"
else bad "S4 step 1" "v1=$(vstatus 17 1) v2=$(vstatus 17 2) null=$(nullrows 17 2)"; fi
r=$(APPROVE 17 2 2>&1)
echo "$r" | grep -q "COMP_ADVANCEMENT_BLOCKED" && ok "S4 the still-blocked v2 cannot be approved (COMP_ADVANCEMENT_BLOCKED)" || bad "S4 approve v2" "$(echo "$r" | head -2 | tr '\n' ' ')"
Q "select cf1tie.open_corr(17, 1, 2)" >/dev/null
Q "select cf1tie.cosign(17, 2)" >/dev/null
Q "select cf1tie.file(17, 12, array[1, 2, 3], 'entry error again')" >/dev/null
Q "select cf1tie.calc(17, 3)" >/dev/null
if [ "$(vstatus 17 3)" = "calculated" ] && [ "$(nullrows 17 3)" = "0/8" ] && [ "$(vstatus 17 2)" = "superseded" ] && [ "$(nullrows 17 1)" = "8/8" ] && [ "$(nullrows 17 2)" = "8/8" ]; then ok "S4 the second correction resolves it: v3 decided (0/8 NULL), v1 and v2 superseded with their tie evidence intact"
else bad "S4 step 2" "v3=$(vstatus 17 3) null3=$(nullrows 17 3) v2=$(vstatus 17 2) null2=$(nullrows 17 2) null1=$(nullrows 17 1)"; fi
r=$(APPROVE 17 3 2>&1); a=$(APPLY 17 3 "gen_random_uuid()" 2>&1)
if [ "$(rstatus 17)" = "approved" ] && [ "$(adv 17)" = "1" ] && [ "$(Q "select generation from public.event_competition_round_advancements where source_round_id = $(S 17)")" = "1" ] \
   && [ "$(Q "select count(*) from public.event_competition_round_advancement_entries ae join public.event_competition_round_advancements a on a.id = ae.advancement_id where a.source_round_id = $(S 17)")" = "3" ]; then
  ok "S4 v3 approves and applies: generation 1, 3 advanced couples"
else bad "S4 step 3" "approve: $(echo "$r" | head -2 | tr '\n' ' ') apply: $(echo "$a" | head -2 | tr '\n' ' ')"; fi

cleanup
rm -rf "$W"
if [ $FAIL -eq 0 ]; then echo "COMPETITION CF1 A0 TIE CONCURRENCY PASS"; exit 0; fi
echo "COMPETITION CF1 A0 TIE CONCURRENCY FAIL"
exit 1
