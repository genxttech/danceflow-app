#!/usr/bin/env bash
# Competition S6 -- entry status guard under a REAL race: four connections on one entry. Synchronised inside the database (no timing assumptions about the client):
#   A  manager, lifecycle RPC (definer): scratches the entry, then takes advisory lock 424242 and keeps its transaction open until THREE other backends are waiting on a lock
#      (or 120 s pass), reports how many it saw, and commits
#   B  manager (authenticated): waits until A's advisory lock is visible, then a direct UPDATE status -> 'withdrawn'. Must wait on A's row lock, then be REFUSED (42501 COMP_S6_ENTRY_STATUS_WRITER)
#   C  owner-role definer writer (the real _r2_withdraw_entry), same gate: must wait, then change nothing (its WHERE excludes terminal states) and not error
#   D  manager, second submit of the same scratch, same gate: must wait, then be a no-op without error (20270301140000)
# Expected end state: entry 'scratched', exactly ONE audit row (change_type scratch), B refused, C and D no error, A saw 3 lock waiters.
# Usage: bash test_T_competition_s6_entry_status_concurrency.sh [container]   (needs the chain through BOTH S6 migrations; superuser supabase_admin)
# Fixtures COMMIT and are removed at the end (even on failure). Prints "S6 CONCURRENCY PASS (<n> checks)" or "S6 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-s6-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUX() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
RUN="${RUN:-$(printf '%02x' $(($(date +%s) % 256)))}"
U() { printf '00000000-0000-0000-0000-c1a6%s%06x' "$RUN" "$((16#$1))"; }
MGR=$(U a0); STUDIO=$(U 51); EV=$(U e0); PROG=$(U 61); CON=$(U 62); DIV=$(U 71); ENT=$(U 91); ENT2=$(U 92); RND=$(U 81); VER=$(U c1); FH=$(U f1); HEAT=$(U d1)
OUT="${S6_OUT:-${TMPDIR:-/tmp}}"
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
cleanup() { SUX -c "delete from public.events where id = '$EV'; delete from public.studios where id = '$STUDIO'; delete from auth.users where id = '$MGR';" >/dev/null 2>&1; }
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
set session_replication_role = replica;
insert into auth.users (id, email) values ('$MGR', 't-s6c-$RUN@example.test');
insert into public.profiles (id, email, full_name) values ('$MGR', 't-s6c-$RUN@example.test', 'S6C manager');
insert into public.studios (id, name, slug) values ('$STUDIO', 'S6C Studio $RUN', 't-s6c-$RUN-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR', '$STUDIO', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV', '$STUDIO', 'S6C', 't-s6c-$RUN-e', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
  values ('$PROG', '$EV', '$STUDIO', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$CON', '$EV', '$PROG', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$DIV', '$EV', '$PROG', '$CON', 'D', 'open');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('$ENT', '$EV', '$PROG', '$DIV', 'race', 'confirmed', 'eligible', '1'), ('$ENT2', '$EV', '$PROG', '$DIV', 'heat race', 'confirmed', 'eligible', '2');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$VER', '$EV', 1, 'v1', 'published', now());
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
  values ('$RND', '$EV', '$PROG', '$DIV', 'R', 'preliminary', 1, 'active', 'callback_tally', 1);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values ('$FH', '$EV', '$VER', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
  values ('$HEAT', '$EV', '$DIV', '$RND', 1, 'scheduled', 'open', '$CON', '$VER', '$FH');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status) values ('$EV', '$DIV', '$HEAT', '$ENT2', 1, 'scheduled');
SQL
VER0=$(SU -c "select lifecycle_version from public.event_competition_entries where id = '$ENT'")

CLAIMS="select set_config('request.jwt.claims', json_build_object('sub','$MGR','role','authenticated')::text, false);"
# gate: wait (server side, up to 120 s) until A has scratched and holds the advisory lock
GATE="do \$g\$ begin for i in 1..600 loop exit when exists (select 1 from pg_locks where locktype = 'advisory' and objid = 424242 and granted); perform pg_sleep(0.2); end loop; if not exists (select 1 from pg_locks where locktype = 'advisory' and objid = 424242 and granted) then raise exception 'S6 gate timeout'; end if; end \$g\$;"

( SU <<SQL > "$OUT/s6c_a.out" 2>&1
set role authenticated; $CLAIMS
begin;
select public.change_competition_entry_lifecycle('$ENT', 'scratched', 'S6 race', 'retain');
reset role;
select pg_advisory_xact_lock(424242);
do \$w\$
declare n integer := 0;
begin
  for i in 1..600 loop
    perform pg_stat_clear_snapshot();
    select count(*) into n from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid() and backend_type = 'client backend';
    exit when n >= 3;
    perform pg_sleep(0.2);
  end loop;
  raise notice 'S6WAITERS=%', n;
end \$w\$;
commit;
SQL
) &
PA=$!
( SUX <<SQL > "$OUT/s6c_b.out" 2>&1
$GATE
set role authenticated; $CLAIMS
update public.event_competition_entries set status = 'withdrawn' where id = '$ENT';
SQL
) &
PB=$!
( SUX <<SQL > "$OUT/s6c_c.out" 2>&1
$GATE
select public._r2_withdraw_entry('$ENT', 'S6 race owner writer', 'retain');
SQL
) &
PC=$!
( SUX <<SQL > "$OUT/s6c_d.out" 2>&1
$GATE
set role authenticated; $CLAIMS
select public.change_competition_entry_lifecycle('$ENT', 'scratched', 'S6 race second submit', 'retain');
SQL
) &
PD=$!
wait $PA; wait $PB; wait $PC; wait $PD

STATUS=$(SU -c "select status from public.event_competition_entries where id = '$ENT'")
AUD=$(SU -c "select count(*) from public.event_competition_entry_changes where entry_id = '$ENT'")
AUDS=$(SU -c "select count(*) from public.event_competition_entry_changes where entry_id = '$ENT' and change_type = 'scratch' and reason = 'S6 race'")
WAITERS=$(grep -o 'S6WAITERS=[0-9]*' "$OUT/s6c_a.out" | head -1 | cut -d= -f2)
noerr() { [ -z "$(grep -i 'error' "$1")" ] && echo 1 || echo 0; }
ok "A (lifecycle RPC) finished without error" "$(noerr "$OUT/s6c_a.out")"
ok "B, C and D were all waiting on a lock while A held its transaction (A saw ${WAITERS:-none})" "$([ "${WAITERS:-0}" -ge 3 ] && echo 1 || echo 0)"
ok "B (direct manager write) was refused with COMP_S6_ENTRY_STATUS_WRITER (42501)" "$(grep -q 'COMP_S6_ENTRY_STATUS_WRITER' "$OUT/s6c_b.out" && echo 1 || echo 0)"
ok "C (owner definer writer) raised no error" "$(noerr "$OUT/s6c_c.out")"
ok "D (second manager submit) was a no-op without error" "$(noerr "$OUT/s6c_d.out")"
ok "final status is scratched (not withdrawn)" "$([ "$STATUS" = "scratched" ] && echo 1 || echo 0)"
ok "exactly one audit row, the scratch with the reason" "$([ "$AUD" = "1" ] && [ "$AUDS" = "1" ] && echo 1 || echo 0)"
ok "A's evidence survived the second submit (reason 'S6 race', version advanced exactly once)" "$([ "$(SU -c "select (scratch_reason = 'S6 race' and lifecycle_version = $VER0 + 1)::int from public.event_competition_entries where id = '$ENT'")" = "1" ] && echo 1 || echo 0)"

# Race 2: the heat starts AFTER the RPC's unlocked check and BEFORE its locks. H holds the heat row (status -> active, uncommitted) until the RPC is waiting on it.
( SU <<SQL > "$OUT/s6c_h.out" 2>&1
begin;
set local session_replication_role = replica;
update public.event_competition_heats set status = 'active' where id = '$HEAT';
select pg_advisory_xact_lock(424243);
do \$w\$
declare n integer := 0;
begin
  for i in 1..150 loop
    perform pg_stat_clear_snapshot();
    select count(*) into n from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid() and backend_type = 'client backend';
    exit when n >= 1;
    perform pg_sleep(0.2);
  end loop;
  raise notice 'S6HEATWAITERS=%', n;
end \$w\$;
commit;
SQL
) &
PH=$!
( SUX <<SQL > "$OUT/s6c_r.out" 2>&1
${GATE//424242/424243}
set role authenticated; $CLAIMS
select public.change_competition_entry_lifecycle('$ENT2', 'scratched', 'S6 heat race', 'retain');
SQL
) &
PR=$!
wait $PH; wait $PR
ok "race 2: the RPC waited for the starting heat" "$(grep -q 'S6HEATWAITERS=[1-9]' "$OUT/s6c_h.out" && echo 1 || echo 0)"
ok "race 2: the RPC re-checked under the lock and refused (COMP_ENTRY_LIFECYCLE_PLACED)" "$(grep -q 'COMP_ENTRY_LIFECYCLE_PLACED' "$OUT/s6c_r.out" && echo 1 || echo 0)"
ok "race 2: entry still confirmed and heat entry still scheduled" "$([ "$(SU -c "select (e.status = 'confirmed' and h.status = 'scheduled')::int from public.event_competition_entries e join public.event_competition_heat_entries h on h.entry_id = e.id where e.id = '$ENT2'")" = "1" ] && echo 1 || echo 0)"
if [ -z "$FAILS" ]; then echo "S6 CONCURRENCY PASS ($PASS checks; $WAITERS lock waiters observed)"; exit 0; else echo "S6 CONCURRENCY FAIL:$FAILS (status=$STATUS audit=$AUD waiters=${WAITERS:-none})"; sed 's/^/  A| /' "$OUT/s6c_a.out"; sed 's/^/  B| /' "$OUT/s6c_b.out"; sed 's/^/  C| /' "$OUT/s6c_c.out"; sed 's/^/  D| /' "$OUT/s6c_d.out"; exit 1; fi
