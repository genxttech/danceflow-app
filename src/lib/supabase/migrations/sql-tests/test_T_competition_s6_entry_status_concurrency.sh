#!/usr/bin/env bash
# Competition S6 -- entry status guard under a REAL race: three connections on one entry.
#   A  manager, lifecycle RPC (definer): scratch the entry, then holds its transaction open for 4 s (row lock held)
#   B  manager (authenticated), starts 1 s later: direct UPDATE status -> 'withdrawn'. Must WAIT on A's row lock, then be REFUSED (42501 COMP_S6_ENTRY_STATUS_WRITER)
#   D  manager, second submit of the same scratch (hardening 20270301142000): must WAIT, then be a no-op
#   C  owner-role definer writer (the real _r2_withdraw_entry), starts 1 s later: must WAIT, then change nothing (the entry is already scratched, its WHERE excludes terminal states) and not error
# Expected end state: entry 'scratched', exactly ONE audit row (change_type scratch), B refused, C no error and no second audit row.
# Usage: bash test_T_competition_s6_entry_status_concurrency.sh [container]   (needs the chain through BOTH S6 migrations; superuser supabase_admin)
# Fixtures COMMIT and are removed at the end (even on failure). Prints "S6 CONCURRENCY PASS (<n> checks)" or "S6 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-s6-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUX() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
RUN="${RUN:-$(printf '%02x' $(($(date +%s) % 256)))}"
U() { printf '00000000-0000-0000-0000-c1a6%s%06x' "$RUN" "$((16#$1))"; }
MGR=$(U a0); STUDIO=$(U 51); EV=$(U e0); PROG=$(U 61); CON=$(U 62); DIV=$(U 71); ENT=$(U 91)
OUT=${TMPDIR:-/tmp}
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
  values ('$ENT', '$EV', '$PROG', '$DIV', 'race', 'confirmed', 'eligible', '1');
SQL

CLAIMS="select set_config('request.jwt.claims', json_build_object('sub','$MGR','role','authenticated')::text, false);"
( SU <<SQL > "$OUT/s6c_a.out" 2>&1
set role authenticated; $CLAIMS
begin;
select public.change_competition_entry_lifecycle('$ENT', 'scratched', 'S6 race', 'retain');
select pg_sleep(4);
commit;
SQL
) &
PA=$!
sleep 1
( SUX <<SQL > "$OUT/s6c_b.out" 2>&1
set role authenticated; $CLAIMS
update public.event_competition_entries set status = 'withdrawn' where id = '$ENT';
SQL
) &
PB=$!
( SUX <<SQL > "$OUT/s6c_c.out" 2>&1
select public._r2_withdraw_entry('$ENT', 'S6 race owner writer', 'retain');
SQL
) &
PC=$!
( SUX <<SQL > "$OUT/s6c_d.out" 2>&1
set role authenticated; $CLAIMS
select public.change_competition_entry_lifecycle('$ENT', 'scratched', 'S6 race second submit', 'retain');
SQL
) &
PD=$!
wait $PA; wait $PB; wait $PC; wait $PD

STATUS=$(SU -c "select status from public.event_competition_entries where id = '$ENT'")
AUD=$(SU -c "select count(*) from public.event_competition_entry_changes where entry_id = '$ENT'")
AUDS=$(SU -c "select count(*) from public.event_competition_entry_changes where entry_id = '$ENT' and change_type = 'scratch' and reason = 'S6 race'")
ok "A (lifecycle RPC) finished without error" "$([ -z "$(grep -i error "$OUT/s6c_a.out")" ] && echo 1 || echo 0)"
ok "B (direct manager write) was refused with COMP_S6_ENTRY_STATUS_WRITER (42501)" "$(grep -q 'COMP_S6_ENTRY_STATUS_WRITER' "$OUT/s6c_b.out" && echo 1 || echo 0)"
ok "C (owner definer writer) raised no error" "$([ -z "$(grep -i error "$OUT/s6c_c.out")" ] && echo 1 || echo 0)"
ok "D (second manager submit of the same scratch) waited, then was a no-op without error (needs 20270301142000)" "$([ -z "$(grep -i error "$OUT/s6c_d.out")" ] && echo 1 || echo 0)"
ok "final status is scratched (not withdrawn)" "$([ "$STATUS" = "scratched" ] && echo 1 || echo 0)"
ok "exactly one audit row, the scratch with the reason" "$([ "$AUD" = "1" ] && [ "$AUDS" = "1" ] && echo 1 || echo 0)"
if [ -z "$FAILS" ]; then echo "S6 CONCURRENCY PASS ($PASS checks)"; exit 0; else echo "S6 CONCURRENCY FAIL:$FAILS (status=$STATUS audit=$AUD)"; exit 1; fi
