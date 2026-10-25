#!/usr/bin/env bash
# SC1 -- multi-session concurrency tests for 20270108090000 (run against an ISOLATED, DISPOSABLE QA database only).
#
# Usage: PSQL="docker exec -i supabase_db_int-qa psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/sc1_concurrency.sh
#        (add SC1_SOFT_ROLLBACK=1 to finish with the soft-rollback check; it uninstalls the SC1 RPCs)
#
# Fixtures are committed (both sessions must see them). Scratch rows are append-only, so they CANNOT be cleaned up:
# run this against a throw-away database and a fresh one per run (the script refuses to run twice).
# Each race holds the contended lock in session A (pg_sleep inside its transaction) while session B starts.
set -euo pipefail
: "${PSQL:?set PSQL to a psql command for the isolated QA database}"

q() { $PSQL -c "$1"; }
pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi
}
U() { echo "00000000-0000-0000-0000-0005c1$1"; }

guard=$(q "select count(*) from auth.users where email not like '%@e2e.test' and email not like '%@example.%'")
if [ "$guard" != "0" ]; then echo "refusing: database contains non-test accounts"; exit 2; fi
if [ "$(q "select count(*) from public.studios where slug = 'sc1-conc-studio'")" != "0" ]; then echo "refusing: fixtures exist (scratch history is append-only; use a fresh database)"; exit 2; fi

OWNER=$(U 000001); STUDIO=$(U 00a001); EVENT=$(U 00e001); PROGRAM=$(U 001001); DIVISION=$(U 003001)
H1=$(U 009001); H2=$(U 009002); H3=$(U 009003)
E1=$(U 008001); E2=$(U 008002); E3=$(U 008003); E4=$(U 008004); E5=$(U 008005); E6=$(U 008006)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

q "begin;
   insert into auth.users (id, email) values ('$OWNER', 'sc1-conc-owner@example.test');
   insert into public.profiles (id, email, full_name) values ('$OWNER', 'sc1-conc-owner@example.test', 'Conc Owner');
   insert into public.studios (id, name, slug) values ('$STUDIO', 'SC1 Conc', 'sc1-conc-studio');
   insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$OWNER', '$STUDIO', 'studio_owner', true);
   insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
     values ('$EVENT', '$STUDIO', 'SC1 Conc Comp', 'sc1-conc-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
   insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
     values ('$PROGRAM', '$EVENT', '$STUDIO', 'Country', 'country', 'relative', 'skating', 'configured');
   insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
     values ('$(U 002001)', '$EVENT', '$PROGRAM', 'Couples', 'single_dance', 'couple', 'open');
   insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
     values ('$DIVISION', '$EVENT', '$PROGRAM', '$(U 002001)', 'Bronze Couples', 'open');
   insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number)
     values ('$(U 006001)', '$EVENT', '$PROGRAM', '$DIVISION', 'Final', 'final', 1);
   insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name) values
     ('$H1', '$EVENT', '$DIVISION', '$(U 006001)', 1, 'H1'), ('$H2', '$EVENT', '$DIVISION', '$(U 006001)', 2, 'H2'), ('$H3', '$EVENT', '$DIVISION', '$(U 006001)', 3, 'H3');
   insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status)
     select e, '$EVENT', '$PROGRAM', '$DIVISION', 'Entry ' || right(e::text, 3), 'confirmed', 'eligible'
     from unnest(array['$E1', '$E2', '$E3', '$E4', '$E5', '$E6']::uuid[]) e;
   insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, status) values
     ('$EVENT', '$DIVISION', '$H1', '$E1', 'scheduled'), ('$EVENT', '$DIVISION', '$H1', '$E2', 'scheduled'),
     ('$EVENT', '$DIVISION', '$H2', '$E3', 'scheduled'), ('$EVENT', '$DIVISION', '$H2', '$E4', 'scheduled'),
     ('$EVENT', '$DIVISION', '$H3', '$E5', 'scheduled'), ('$EVENT', '$DIVISION', '$H1', '$E6', 'scheduled');
   set constraints all immediate;
   commit;" >/dev/null

AS_OWNER="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true);"
scratch_sql() { echo "select 'result:' || public.scratch_competition_entry('$1', '$2', $3, null)"; } # entry request reason-literal
uuid_of() { grep -oE 'result:[0-9a-f-]{36}' "$1" | head -1 | cut -d: -f2 || true; }

# ---- 1. Two sessions scratch the same entry with DIFFERENT request ids: one scratch, the other is refused after waiting.
R1=$(U f00001); R2=$(U f00002)
( $PSQL -c "begin; $AS_OWNER $(scratch_sql $E1 $R1 "'Left early'"); select pg_sleep(2); commit;" > "$TMP/a1.out" 2>&1 || true ) &
sleep 0.7
B1=$($PSQL -c "begin; $AS_OWNER $(scratch_sql $E1 $R2 "'Left early too'"); commit;" 2>&1 || true)
wait
check "scratch vs scratch: first session scratches" "$(grep -c 'result:' "$TMP/a1.out")" "1"
check "scratch vs scratch: second session waits, then is refused" "$(echo "$B1" | grep -c 'COMP_SC1_ALREADY_SCRATCHED')" "1"
check "scratch vs scratch: exactly one scratch row" "$(q "select count(*) from public.event_competition_scratches where entry_id = '$E1'")" "1"
check "scratch vs scratch: entry and placement scratched once" "$(q "select e.status || '/' || string_agg(he.status, ',') from public.event_competition_entries e join public.event_competition_heat_entries he on he.entry_id = e.id where e.id = '$E1' group by e.status")" "scratched/scratched"
check "scratch vs scratch: one entry-change audit row" "$(q "select count(*) from public.event_competition_entry_changes where entry_id = '$E1' and change_type = 'scratch'")" "1"

# ---- 2. Two sessions submit the SAME request id for the same entry (a double click): both get the same scratch id.
R3=$(U f00003)
( $PSQL -c "begin; $AS_OWNER $(scratch_sql $E2 $R3 "'Double click'"); select pg_sleep(2); commit;" > "$TMP/a2.out" 2>&1 || true ) &
sleep 0.7
$PSQL -c "begin; $AS_OWNER $(scratch_sql $E2 $R3 "'Double click'"); commit;" > "$TMP/b2.out" 2>&1 || true
wait
check "same request twice: first session scratches" "$(grep -c 'result:' "$TMP/a2.out")" "1"
check "same request twice: second session returns the SAME scratch id" "$(uuid_of "$TMP/b2.out")" "$(uuid_of "$TMP/a2.out")"
check "same request twice: one scratch row" "$(q "select count(*) from public.event_competition_scratches where entry_id = '$E2'")" "1"

# ---- 3. Scratch vs heat lock (lock first): the scratch waits for the lock to commit, then sees the LOCKED heat.
LOCKH2="select public.set_competition_heat_lock_state('$H2', 'locked', 'Check-in done')"
( $PSQL -c "begin; $AS_OWNER $LOCKH2; select pg_sleep(2); commit;" > "$TMP/a3.out" 2>&1 || true ) &
sleep 0.7
B3=$($PSQL -c "begin; $AS_OWNER $(scratch_sql $E3 "$(U f00004)" "null"); commit;" 2>&1 || true)
wait
check "heat lock vs scratch: the scratch waited and saw the locked heat (reason now required)" "$(echo "$B3" | grep -c 'COMP_SC1_REASON_REQUIRED')" "1"
check "heat lock vs scratch: the refused entry is untouched" "$(q "select e.status || '/' || he.status from public.event_competition_entries e join public.event_competition_heat_entries he on he.entry_id = e.id where e.id = '$E3'")" "confirmed/scheduled"
B3b=$($PSQL -c "begin; $AS_OWNER $(scratch_sql $E3 "$(U f00005)" "'Official: injury'"); commit;" 2>&1 || true)
check "heat lock vs scratch: an official with a reason scratches in the locked heat" "$(echo "$B3b" | grep -c 'result:')" "1"
check "heat lock vs scratch: recorded as the official locked path, heat stays locked" "$(q "select s.path || '/' || h.lock_state from public.event_competition_scratches s join public.event_competition_heats h on h.id = '$H2' where s.entry_id = '$E3'")" "official_locked/locked"

# ---- 4. Scratch vs heat lock (scratch first): the lock waits for the scratch, then locks; the scratched placement stays scratched.
( $PSQL -c "begin; $AS_OWNER $(scratch_sql $E5 "$(U f00006)" "null"); select pg_sleep(2); commit;" > "$TMP/a4.out" 2>&1 || true ) &
sleep 0.7
B4=$($PSQL -c "begin; $AS_OWNER select public.set_competition_heat_lock_state('$H3', 'locked', 'Check-in done'); commit;" 2>&1 || true)
wait
check "scratch vs heat lock: the scratch committed first (normal path)" "$(q "select path from public.event_competition_scratches where entry_id = '$E5'")" "normal"
check "scratch vs heat lock: the lock completed after the scratch (no deadlock, no error)" "$(echo "$B4" | grep -ci 'error\|deadlock')" "0"
check "scratch vs heat lock: heat locked, placement stays scratched" "$(q "select h.lock_state || '/' || he.status from public.event_competition_heats h join public.event_competition_heat_entries he on he.heat_id = h.id where h.id = '$H3' and he.entry_id = '$E5'")" "locked/scratched"

# ---- 5. A scratch and a placement update on the same entry (check-in) race: no deadlock, consistent result.
( $PSQL -c "begin; $AS_OWNER $(scratch_sql $E6 "$(U f00007)" "null"); select pg_sleep(2); commit;" > "$TMP/a5.out" 2>&1 || true ) &
sleep 0.7
$PSQL -c "update public.event_competition_heat_entries set status = 'checked_in' where entry_id = '$E6' returning 'upd:' || status" > "$TMP/b5.out" 2>&1 || true
wait
check "scratch vs check-in write: no deadlock" "$(cat "$TMP"/a5.out "$TMP"/b5.out | grep -ci 'deadlock')" "0"
end6=$(q "select e.status || '/' || he.status from public.event_competition_entries e join public.event_competition_heat_entries he on he.entry_id = e.id where e.id = '$E6'")
# the entry is always scratched; the placement ends scratched (the check-in write was refused or applied first) or checked_in (written after) -- never scheduled
check "scratch vs check-in write: entry scratched, placement not left scheduled" "$(case "$end6" in scratched/scratched|scratched/checked_in) echo ok;; *) echo "$end6";; esac)" "ok"

# ---- 6. Soft rollback while scratch history exists (optional: it uninstalls the SC1 RPCs of this database).
if [ "${SC1_SOFT_ROLLBACK:-0}" = "1" ]; then
  ROLLBACK="$(dirname "$0")/../rollback/20270108090000_competition_sc1_scratch_rollback.sql"
  before=$(q "select count(*) from public.event_competition_scratches")
  out=$($PSQL < "$ROLLBACK" 2>&1 || true)
  check "soft rollback: reports the audit tables were kept" "$(echo "$out" | grep -c 'audit tables kept')" "1"
  check "soft rollback: scratch history untouched" "$(q "select count(*) from public.event_competition_scratches")" "$before"
  check "soft rollback: scratched entries stay scratched" "$(q "select count(*) from public.event_competition_entries where id in ('$E1','$E2','$E3','$E5','$E6') and status = 'scratched'")" "5"
  check "soft rollback: scratch RPC and policy RPCs dropped" "$(q "select count(*) from pg_proc where proname in ('scratch_competition_entry', 'set_competition_scratch_policy', 'set_competition_scratch_policy_default', '_sc1_guard_api_scratch_writes')")" "0"
  check "soft rollback: 10A guard body restored (md5 7997313d)" "$(q "select left(md5(replace(prosrc, E'\\r', '')), 8) from pg_proc where oid = 'public.protect_locked_competition_heat_children()'::regprocedure")" "7997313d"
  check "soft rollback: lifecycle RPC executable by authenticated again" "$(q "select has_function_privilege('authenticated', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'execute')")" "t"
  check "soft rollback: kept audit table is still append-only" "$($PSQL -c "update public.event_competition_scratches set reason = 'x'" 2>&1 | grep -c 'append-only' || true)" "1"
  check "soft rollback: re-applying SC1 is refused while the kept tables exist" "$($PSQL < "$(dirname "$0")/../20270108090000_competition_sc1_scratch.sql" 2>&1 | grep -q 'ERROR' && echo 1 || echo 0)" "1"
fi

echo "---- passed: $pass, failed: $fail"
[ "$fail" = "0" ]
