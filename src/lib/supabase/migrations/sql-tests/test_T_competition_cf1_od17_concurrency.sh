#!/usr/bin/env bash
# Competition CF1 OD-17 enforcement switch -- multi-session probes on a THROWAWAY local Postgres container.
#
#   CONTAINER=cf1od17-pg DBUSER=supabase_admin bash test_T_competition_cf1_od17_concurrency.sh
#
# The database must already carry the chain through CF1 A7, RB3/RB3R, U66, F3 and 20270120105000. The script COMMITS synthetic fixtures (UUID block
# ...-<run tag>XXXXXX, a random 6-hex tag per run) and, when R2 is absent, ONE RB3 gate override ("qa fixture") so the refund gate can pass.
# Run it only on a disposable container. Never against a shared or hosted DB.
# Every race is deterministic: session A holds the event / od17 lock inside an open transaction (pg_sleep), session B starts after A has the lock.
#   C1  enable (holds) vs a concurrent placement of an unavailable couple (B starts 1s later)   -> B waits, then sees ON and is refused
#   C2  placement of an unavailable couple (holds, uncommitted) vs a concurrent enable           -> enable waits, then sees the placement and refuses (roster_clean)
#   C3  two enables with different request ids                                                   -> both audited, one changed, one no-op, state ON
#   C4  the same enable request id from two sessions                                             -> one audit row, the other replays
#   C5  enable (holds) vs a concurrent round start of a clean round                              -> the start waits, then runs under ON and succeeds
#   C6  disable (holds) vs a concurrent placement of an unavailable couple                        -> B waits, then sees OFF and succeeds (nothing refused after disable)
set -u
C="${CONTAINER:?set CONTAINER}"
DBUSER="${DBUSER:-postgres}"
FAILS=0
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT
psq() { docker exec -i "$C" psql -U "$DBUSER" -h localhost -d postgres -At -q "$@"; }
TAG=$(printf '%06x' $(( (RANDOM * 32768 + RANDOM) % 16777216 )))
u() { echo "00000000-0000-0000-0000-$TAG$1"; }
OWN=$(u 000001); EV=$(u 00e001); ST=$(u 00a001); P=$(u 001001); CT=$(u 002001); VER=$(u 00c001)
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1  ($2)"; FAILS=$((FAILS + 1)); }
as_sql() { printf "set role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false);\n%s\n" "$1" "$2"; }
q() { psq -c "$1"; }

echo "== fixtures =="
psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$OWN', 't-$TAG-owner@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'OD17 ' || split_part(email, '@', 1) from auth.users where email like 't-$TAG-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-$TAG-%';
insert into public.studios (id, name, slug) values ('$ST', 'OD17 Race Studio', 't-$TAG-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWN', '$ST', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('$EV', '$ST', 'OD17 Race', 't-$TAG-e1', 'competition', current_date + 30, current_date + 30, 'draft', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values ('$P', '$EV', '$ST', 'P', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CT', '$EV', '$P', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$VER', '$EV', 1, 'v1', 'published', now());
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values ('$(u 0a0001)', '$EV', '$ST', 'B', 'od17-$TAG@example.test', 'paid');
SQL
# R2 absent: the refund gate needs an owner override (committed on this disposable database)
if [ "$(q "select public._cf1_refund_evidence_mode()")" != r2_ledger ]; then
  psq -v ON_ERROR_STOP=1 -c "select public._cf1_rb3_record_gate_override('absent', 'owner (qa fixture)', 'qa fixture acceptance of the absent refund-evidence false negative $TAG');" >/dev/null
fi

# mk K: round K (division, scheduled, one heat, two available couples); mkbad K: the unavailable couple 'bad' of round K (cancelled registration), not placed
mk() {
  k=$1; D=$(u "00300$k"); R=$(u "00600$k"); H=$(u "00d00$k")
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$D', '$EV', '$P', '$CT', 'D$k', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
values ('$R', '$EV', '$P', '$D', 'R$k', 'final', 1, 'scheduled', 'ordinal_majority');
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
values ('$H', '$EV', '$D', '$R', $k, '$CT', '$VER', 'scheduled');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('$(u "0080${k}")' || n)::uuid, '$EV', '$P', '$D', 'e$k' || n, 'confirmed', 'eligible', '${k}0' || n from generate_series(1, 2) n;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select '$EV', '$D', '$H', ('$(u "0080${k}")' || n)::uuid, n from generate_series(1, 2) n;
SQL
}
mkbad() {
  k=$1; D=$(u "00300$k"); G=$(u "0b00b$k")
  psq -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email)
values ('$G', '$ST', '$EV', '$(u 0a0001)', 'cancelled', 'paid', 'G', 'B$k', 'od17-b$k-$TAG@example.test');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id)
values ('$(u "0080${k}9")', '$EV', '$P', '$D', 'bad$k', 'confirmed', 'eligible', '${k}09', '$G');
SQL
}
BADENT() { u "0080${1}9"; }
PLACE() { echo "set session_replication_role = replica; insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV', '$(u "00300$1")', '$(u "00d00$1")', '$(BADENT $1)', 9);"; }
ENABLE() { echo "select public.cf1_od17_set_enforcement('$EV', true, 'race enable $TAG $2', '$1');"; }
DISABLE() { echo "select public.cf1_od17_set_enforcement('$EV', false, 'race disable $TAG $2', '$1');"; }
hold() { { as_sql "$1" "begin;"; echo "$2"; echo "select pg_sleep($3);"; echo "commit;"; } | psq -v ON_ERROR_STOP=0 2>&1; }
run() { as_sql "$1" "$2" | psq -v ON_ERROR_STOP=0 2>&1; }
sw() { q "select coalesce((select enabled::text from public.competition_cf1_od17_enforcement where event_id = '$EV'), 'none')"; }
aud() { q "select count(*) from public.competition_cf1_od17_audit where event_id = '$EV'"; }
placed() { q "select count(*) from public.event_competition_heat_entries where entry_id = '$(BADENT $1)'"; }

# --- C1 enable holds; a placement of the unavailable couple started 1s later is refused after the enable commits
mk 1; mkbad 1
hold "$OWN" "$(ENABLE $(u 0e0001) c1)" 3 > $TMPD/c1a.out &
sleep 1
START=$(date +%s)
psq -v ON_ERROR_STOP=0 -c "$(PLACE 1)" > $TMPD/c1b.out 2>&1
EL=$(( $(date +%s) - START ))
wait
if [ "$(sw)" = true ] && [ "$(placed 1)" = 0 ] && grep -q 'COMP_OD17_ROSTER_ENTRY_UNAVAILABLE' $TMPD/c1b.out && [ "$EL" -ge 1 ]; then
  ok "C1 enable vs placement: the placement waited (${EL}s) and was refused under ON; the couple is not placed"; else bad "C1 enable vs placement" "sw=$(sw) placed=$(placed 1) waited=${EL}s $(head -c 250 $TMPD/c1b.out) | $(head -c 200 $TMPD/c1a.out)"; fi

# --- C6 disable holds; the same placement started 1s later waits and then succeeds (OFF)
hold "$OWN" "$(DISABLE $(u 0e0006) c6)" 3 > $TMPD/c6a.out &
sleep 1
START=$(date +%s)
psq -v ON_ERROR_STOP=0 -c "$(PLACE 1)" > $TMPD/c6b.out 2>&1
EL=$(( $(date +%s) - START ))
wait
if [ "$(sw)" = false ] && [ "$(placed 1)" = 1 ] && ! grep -q 'ERROR' $TMPD/c6b.out && [ "$EL" -ge 1 ]; then
  ok "C6 disable vs placement: the placement waited (${EL}s) and succeeded once OFF"; else bad "C6 disable vs placement" "sw=$(sw) placed=$(placed 1) waited=${EL}s $(head -c 250 $TMPD/c6b.out) | $(head -c 200 $TMPD/c6a.out)"; fi

# --- C2 placement holds (uncommitted, OFF); the enable started 1s later waits, then sees the placement and is refused (roster_clean)
mk 2; mkbad 2
{ echo "begin;"; PLACE 2 | sed "s/set session_replication_role/set local session_replication_role/"; echo "select pg_sleep(3);"; echo "commit;"; } | psq -v ON_ERROR_STOP=0 > $TMPD/c2a.out 2>&1 &
sleep 1
START=$(date +%s)
run "$OWN" "$(ENABLE $(u 0e0002) c2)" > $TMPD/c2b.out
EL=$(( $(date +%s) - START ))
wait
if [ "$(sw)" = false ] && [ "$(placed 2)" = 1 ] && grep -q 'COMP_OD17_GATES_NOT_MET' $TMPD/c2b.out && grep -q 'roster_clean' $TMPD/c2b.out && [ "$EL" -ge 1 ]; then
  ok "C2 placement vs enable: the enable waited (${EL}s), saw the committed placement and was refused (roster_clean); the switch stays OFF"; else bad "C2 placement vs enable" "sw=$(sw) placed=$(placed 2) waited=${EL}s $(head -c 300 $TMPD/c2b.out)"; fi
# resolve (scratch is never gated) so later probes have a clean event
psq -c "update public.event_competition_heat_entries set status = 'scratched' where entry_id = '$(BADENT 2)'; update public.event_competition_heat_entries set status = 'scratched' where entry_id = '$(BADENT 1)';" >/dev/null

# --- C3 two enables, different request ids: both audited, exactly one changed
A0=$(aud)
hold "$OWN" "$(ENABLE $(u 0e0003) c3a)" 3 > $TMPD/c3a.out &
sleep 1
run "$OWN" "$(ENABLE $(u 0e0004) c3b)" > $TMPD/c3b.out
wait
CH=$(q "select count(*) from public.competition_cf1_od17_audit where event_id = '$EV' and request_id in ('$(u 0e0003)', '$(u 0e0004)') and changed")
if [ "$(sw)" = true ] && [ $(( $(aud) - A0 )) = 2 ] && [ "$CH" = 1 ]; then
  ok "C3 two enables: both audited, exactly one changed the state, the switch is ON"; else bad "C3 two enables" "sw=$(sw) audit+=$(( $(aud) - A0 )) changed=$CH $(head -c 200 $TMPD/c3b.out)"; fi

# --- C4 the same request id from two sessions: one audit row, the other replays
A0=$(aud)
hold "$OWN" "$(DISABLE $(u 0e0005) c4)" 3 > $TMPD/c4a.out &
sleep 1
run "$OWN" "$(DISABLE $(u 0e0005) c4)" > $TMPD/c4b.out
wait
if [ "$(sw)" = false ] && [ $(( $(aud) - A0 )) = 1 ] && grep -q '"replayed": true' $TMPD/c4b.out; then
  ok "C4 same request id from two sessions: one audit row, the second session replays"; else bad "C4 same request id" "sw=$(sw) audit+=$(( $(aud) - A0 )) $(head -c 250 $TMPD/c4b.out)"; fi

# --- C5 enable holds; a round start of a clean round started 1s later waits, then runs under ON and succeeds
mk 5
hold "$OWN" "$(ENABLE $(u 0e0007) c5)" 3 > $TMPD/c5a.out &
sleep 1
START=$(date +%s)
psq -v ON_ERROR_STOP=0 <<SQL > $TMPD/c5b.out 2>&1
begin;
select public._compo1_record('$EV', '$(u 006005)', null, 'round_started', 'scheduled', 'active', '$OWN', gen_random_uuid(), null, '{}'::jsonb);
update public.event_competition_rounds set status = 'active' where id = '$(u 006005)';
commit;
SQL
EL=$(( $(date +%s) - START ))
wait
if [ "$(sw)" = true ] && [ "$(q "select status from public.event_competition_rounds where id = '$(u 006005)'")" = active ] && ! grep -q 'ERROR' $TMPD/c5b.out; then
  ok "C5 enable vs round start: the start ran under the committed ON (clean roster) and succeeded (waited ${EL}s)"; else bad "C5 enable vs round start" "sw=$(sw) $(head -c 250 $TMPD/c5b.out)"; fi

echo "TALLY: $((6 - FAILS)) passed, $FAILS failed"
[ "$FAILS" = 0 ] && echo "CONCURRENCY PASS (6 probes)" || echo "CONCURRENCY FAIL ($FAILS)"
[ "$FAILS" = 0 ]
