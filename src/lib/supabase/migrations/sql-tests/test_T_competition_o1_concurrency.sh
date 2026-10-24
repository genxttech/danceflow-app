#!/bin/sh
# Competition O1 -- concurrent double start with a REAL second connection.
#
# Needs a disposable Postgres with E1 and O1 applied (E1 readiness is overridden during the run and restored) (never a hosted database). Fixtures are committed, then
# removed again at the end (the event delete cascades the append-only audit rows; the 10A history trigger allows exactly that).
#   CONTAINER=o1-db sh test_T_competition_o1_concurrency.sh
# The synthetic studio/user rows are left in place (a studio delete cascades through the whole schema and is slow); only the event is removed.
# Exit 0 = every assertion held, 1 = a failure, 3 = blocked (could not set up).
set -u
C="${CONTAINER:-o1-db}"
P="docker exec -i $C psql -U postgres -h localhost -v ON_ERROR_STOP=1 -X -q -At"
OUT="${TMPDIR:-/tmp}"
E=00000000-0000-0000-0000-0c0a20e00001
S=00000000-0000-0000-0000-0c0a20a00001
U=00000000-0000-0000-0000-0c0a20000001
R=00000000-0000-0000-0000-0c0a20600001
F=00000000-0000-0000-0000-0c0a20500001
FAIL=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAIL=1; }

cleanup() {
  $P >/dev/null 2>&1 <<SQL
delete from public.events where id = '$E';
SQL
  # Put E1's real readiness function back (the run replaces it with a stand-in).
  if [ -n "${RESTORE:-}" ]; then $P -c "$RESTORE" >/dev/null 2>&1; fi
}

RESTORE="$($P -c "select pg_get_functiondef('public.competition_round_panel_ready(uuid)'::regprocedure)")"
if [ -z "$RESTORE" ]; then echo "BLOCKED: E1 competition_round_panel_ready is not installed"; exit 3; fi
cleanup

$P <<SQL || { echo "BLOCKED: fixture setup failed"; cleanup; exit 3; }
create or replace function public.competition_round_panel_ready(p_round_id uuid) returns boolean language sql stable as \$\$ select true \$\$;
grant execute on function public.competition_round_panel_ready(uuid) to authenticated;
insert into auth.users (id, email) values ('$U', 't-o1-conc@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('$U', 't-o1-conc@example.test', 'Conc Owner') on conflict do nothing;
insert into public.studios (id, name, slug) values ('$S', 'O1 Conc Studio', 't-o1-conc-studio') on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) select '$U', '$S', 'studio_owner', true where not exists (select 1 from public.user_studio_roles where user_id = '$U' and studio_id = '$S');
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$E', '$S', 'O1 Conc', 't-o1-conc', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('00000000-0000-0000-0000-0c0a20100001', '$E', '$S', 'Conc', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values ('00000000-0000-0000-0000-0c0a20200001', '$E', '00000000-0000-0000-0000-0c0a20100001', 'ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values ('00000000-0000-0000-0000-0c0a20300001', '$E', '00000000-0000-0000-0000-0c0a20100001', '00000000-0000-0000-0000-0c0a20200001', 'Conc Div', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number)
  values ('$R', '$E', '00000000-0000-0000-0000-0c0a20100001', '00000000-0000-0000-0000-0c0a20300001', 'Final', 'final', 1);
insert into public.event_competition_schedule_versions (id, event_id, name, version_number, status)
  values ('00000000-0000-0000-0000-0c0a20400001', '$E', 'v1', 1, 'draft');
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
  values ('$F', '$E', '00000000-0000-0000-0000-0c0a20400001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name, contest_id, schedule_version_id, floor_heat_id, status)
  values ('00000000-0000-0000-0000-0c0a20700001', '$E', '00000000-0000-0000-0000-0c0a20300001', '$R', 1, 'Heat', '00000000-0000-0000-0000-0c0a20200001',
          '00000000-0000-0000-0000-0c0a20400001', '$F', 'scheduled');
update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = '00000000-0000-0000-0000-0c0a20400001';
SQL

# call <sql expression> <hold seconds>: one authenticated session; the transaction stays open for the hold so a second
# connection has to wait on the event / round lock.
call() {
  $P 2>&1 <<SQL | tr '\n' ' '
begin;
select set_config('request.jwt.claims', json_build_object('sub', '$U', 'role', 'authenticated')::text, true);
set local role authenticated;
select ($1)::text;
select pg_sleep($2);
commit;
SQL
}

# --- schedule, then a double start ---------------------------------------------------------------------------------
call "public.schedule_competition_round('$R', gen_random_uuid())" 0 >/dev/null
[ "$($P -c "select status from public.event_competition_rounds where id='$R'")" = "scheduled" ] && ok "schedule" || bad "schedule"

T0=$(date +%s)
call "public.start_competition_round('$R', '00000000-0000-0000-0000-0c0a2000a001')" 4 > "$OUT/o1_a.out" &
PA=$!
sleep 1
call "public.start_competition_round('$R', '00000000-0000-0000-0000-0c0a2000b001')" 0 > "$OUT/o1_b.out" &
PB=$!
call "public.start_competition_round('$R', '00000000-0000-0000-0000-0c0a2000a001')" 0 > "$OUT/o1_c.out" &
PC=$!
wait $PA $PB $PC
T1=$(date +%s)
echo "A: $(cat "$OUT/o1_a.out")"; echo "B: $(cat "$OUT/o1_b.out")"; echo "C: $(cat "$OUT/o1_c.out")"
grep -q '"replayed": false' "$OUT/o1_a.out" && ok "A (first) started the round" || bad "A (first) started the round"
grep -q 'COMPO1_BAD_STATE' "$OUT/o1_b.out" && ok "B (other request id) lost with COMPO1_BAD_STATE" || bad "B lost with COMPO1_BAD_STATE"
grep -q '"replayed": true' "$OUT/o1_c.out" && ok "C (same request id as A) replayed" || bad "C replayed"
[ $((T1 - T0)) -ge 4 ] && ok "second connection waited for the first (elapsed $((T1 - T0))s)" || bad "second connection waited for the first"
N=$($P -c "select count(*) from public.event_competition_round_transition_events where round_id='$R' and kind='round_started'")
[ "$N" = "1" ] && ok "exactly one round_started audit row" || bad "exactly one round_started audit row ($N)"
[ "$($P -c "select status from public.event_competition_rounds where id='$R'")" = "active" ] && ok "round is active" || bad "round is active"

# --- concurrent heat staging ---------------------------------------------------------------------------------------
call "public.advance_competition_floor_heat('$F', 'staging', '00000000-0000-0000-0000-0c0a2000d001')" 3 > "$OUT/o1_d.out" &
PD=$!
sleep 1
call "public.advance_competition_floor_heat('$F', 'staging', '00000000-0000-0000-0000-0c0a2000e001')" 0 > "$OUT/o1_e.out" &
PE=$!
wait $PD $PE
echo "D: $(cat "$OUT/o1_d.out")"; echo "E: $(cat "$OUT/o1_e.out")"
WON=$(cat "$OUT/o1_d.out" "$OUT/o1_e.out" | grep -c "\"replayed\": false"); LOST=$(cat "$OUT/o1_d.out" "$OUT/o1_e.out" | grep -c COMPO1_BAD_STATE)
[ "$WON" = "1" ] && [ "$LOST" = "1" ] && ok "one heat call won, the other lost with COMPO1_BAD_STATE" || bad "one heat call won, the other lost ($WON/$LOST)"
N=$($P -c "select count(*) from public.event_competition_round_transition_events where heat_id is not null and kind='heat_staged'")
[ "$N" = "1" ] && ok "exactly one heat_staged audit row" || bad "exactly one heat_staged audit row ($N)"

cleanup
[ "$($P -c "select count(*) from public.events where id='$E'")" = "0" ] && ok "fixtures removed (audit cascade through the event delete)" || bad "fixtures removed"
if [ $FAIL -eq 0 ]; then echo "O1 CONCURRENCY PASS"; else echo "O1 CONCURRENCY FAIL"; fi
exit $FAIL
