#!/usr/bin/env bash
# R2 x SC1 integration -- multi-session concurrency and rollback tests (needs BOTH 20270103090000 and 20270108090000; ISOLATED, DISPOSABLE database only).
#
# Usage: PSQL="docker exec -i supabase_db_int-qa psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt" \
#        bash src/lib/supabase/migrations/sql-tests/int_r2_sc1_concurrency.sh [race|rollback]
#   race      (default) fixtures + scratch vs refund request, scratch vs observe(withdraw) races
#   rollback  combined rollback with evidence (run AFTER race; it uninstalls SC1 softly and shows R2 refuses)
#
# Fixtures are the committed first 265 lines of test_T_competition_r2_entry_refunds.sql (orders O1..O4, locked and certified heats).
# Refund ledger and scratch rows are append-only: use a fresh database per run (the script refuses to seed twice).
set -euo pipefail
: "${PSQL:?set PSQL to a psql command for the isolated QA database}"
MODE="${1:-race}"
HERE="$(cd "$(dirname "$0")" && pwd)"

q() { $PSQL -c "$1"; }
pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi
}
U() { echo "00000000-0000-0000-0000-0c1d20$1"; }
guard=$(q "select count(*) from auth.users where email not like '%@e2e.test' and email not like '%@example.%'")
if [ "$guard" != "0" ]; then echo "refusing: database contains non-test accounts"; exit 2; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

OWNER=$(U 000001); EVENT=$(U 00e001)
AS_OWNER="set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true);"
scratch_sql() { echo "select 'result:' || public.scratch_competition_entry('$1', '$2', '$3', null)"; }
request_sql() { echo "select 'result:' || (public.request_competition_order_refund('$EVENT', '$1', '$2', '$3'::jsonb, 'Injury') ->> 'refundId')"; }
observe_sql() { echo "select 'result:' || (public.observe_competition_stripe_refund('$1', 'acct_r2test1', '$2', '$3', $4, 'succeeded', 'evt_$2') ->> 'handled')"; }
line() { echo "[{\"orderItemId\":\"$(U $1)\",\"amountCents\":$2,\"withdrawEntry\":$3}]"; }
status_of() { q "select status from public.event_competition_entries where id = '$(U $1)'"; }

if [ "$MODE" = "race" ]; then
  if [ "$(q "select count(*) from public.studios where slug = 't-r2-studio'")" != "0" ]; then echo "refusing: fixtures exist; use a fresh database"; exit 2; fi
  { sed -n '1,265p' "$HERE/test_T_competition_r2_entry_refunds.sql"; echo "commit;"; } | $PSQL -f - >/dev/null
  check "fixtures: four paid orders, entries and locked/certified heats seeded" "$(q "select count(*) from public.event_competition_entries where event_id = '$EVENT'")" "19"

  # ---- 1. Scratch (session A) vs refund REQUEST on the same order (session B): neither waits for the other, both commit.
  ENTRY=$(U 008106); REQ_S=$(U f00101); REQ_R=$(U aa1101)
  ( $PSQL -c "begin; $AS_OWNER $(scratch_sql $ENTRY $REQ_S 'Injury'); select pg_sleep(8); select 'adone:' || extract(epoch from clock_timestamp()); commit;" > "$TMP/a1.out" 2>&1 || true ) &
  sleep 0.7
  $PSQL -c "begin; $AS_OWNER $(request_sql "$(U 00b004)" "$REQ_R" "$(line 00c401 2500 false)"); select 'bdone:' || extract(epoch from clock_timestamp()); commit;" > "$TMP/b1.out" 2>&1 || true
  wait
  check "scratch vs refund request: scratch committed" "$(grep -c 'result:' "$TMP/a1.out")" "1"
  check "scratch vs refund request: refund request committed (returned a refund id)" "$(grep -c 'result:' "$TMP/b1.out")" "1"
  a_done=$(grep -o 'adone:[0-9.]*' "$TMP/a1.out" | cut -d: -f2); b_done=$(grep -o 'bdone:[0-9.]*' "$TMP/b1.out" | cut -d: -f2)
  check "scratch vs refund request: the request did NOT wait for the scratch (it finished before the scratch released its locks)" "$(awk -v a="${a_done:-0}" -v b="${b_done:-9e12}" 'BEGIN{print (b < a) ? "yes" : "no"}')" "yes"
  check "scratch vs refund request: entry scratched, one scratch row" "$(status_of 008106)/$(q "select count(*) from public.event_competition_scratches where entry_id = '$ENTRY'")" "scratched/1"
  check "scratch vs refund request: exactly one refund (the staff request), requested, 25.00" "$(q "select count(*) || '/' || min(status) || '/' || min(amount_cents) from public.event_order_refunds where order_id = '$(U 00b004)'")" "1/requested/2500"
  check "scratch vs refund request: the scratch reserved no cap and wrote no refund of its own (refund rows reference only B's request id)" "$(q "select count(*) from public.event_order_refunds where order_id = '$(U 00b004)' and refund_request_id <> '$REQ_R'")" "0"
  check "scratch vs refund request: no refund accounting entry yet" "$(q "select count(*) from public.accounting_entries where category = 'competition_entry_refund'")" "0"
  # The Stripe-side success of that refund (withdrawEntry false) leaves the scratched entry scratched.
  q "$(observe_sql pi_r2_o4 re_int_1 "$REQ_R" 2500)" >/dev/null
  check "scratched entry stays scratched after a refund that did not ask to withdraw it" "$(status_of 008106)/$(q "select participation_outcome from public.event_order_refund_allocations a join public.event_order_refunds r on r.id = a.refund_id where r.refund_request_id = '$REQ_R'")" "scratched/not_requested"

  # ---- 2. Refund observed first (A) vs scratch of the same entry (B): the scratch waits, then is refused (entry already withdrawn).
  ENTRY2=$(U 008107); REQ_R2=$(U aa1102)
  q "set local role authenticated; $AS_OWNER $(request_sql "$(U 00b004)" "$REQ_R2" "$(line 00c402 2500 true)")" >/dev/null
  ( $PSQL -c "begin; $(observe_sql pi_r2_o4 re_int_2 "$REQ_R2" 2500); select pg_sleep(2); commit;" > "$TMP/a2.out" 2>&1 || true ) &
  sleep 0.7
  B2=$($PSQL -c "begin; $AS_OWNER $(scratch_sql $ENTRY2 "$(U f00102)" 'Late scratch'); commit;" 2>&1 || true)
  wait
  check "refund(withdraw) vs scratch: the refund observation committed" "$(grep -c 'result:' "$TMP/a2.out")" "1"
  check "refund(withdraw) vs scratch: the scratch waited, then was refused (already withdrawn)" "$(echo "$B2" | grep -c 'COMP_SC1_ALREADY_SCRATCHED')" "1"
  check "refund(withdraw) vs scratch: entry withdrawn by the refund, no scratch row" "$(status_of 008107)/$(q "select count(*) from public.event_competition_scratches where entry_id = '$ENTRY2'")" "withdrawn/0"

  # ---- 3. Scratch first (A) vs refund observation that asks to withdraw the SAME entry (B): the entry stays scratched, the allocation says so.
  ENTRY3=$(U 008105); REQ_R3=$(U aa1103)
  q "set local role authenticated; $AS_OWNER $(request_sql "$(U 00b002)" "$REQ_R3" "$(line 00c201 3000 true)")" >/dev/null
  ( $PSQL -c "begin; $AS_OWNER $(scratch_sql $ENTRY3 "$(U f00103)" 'Scratched while the refund is in flight'); select pg_sleep(2); commit;" > "$TMP/a3.out" 2>&1 || true ) &
  sleep 0.7
  B3=$($PSQL -c "begin; $(observe_sql pi_r2_o2 re_int_3 "$REQ_R3" 3000); commit;" 2>&1 || true)
  wait
  check "scratch vs refund(withdraw): both committed, no deadlock" "$(grep -c 'result:' "$TMP/a3.out")/$(echo "$B3" | grep -c 'result:')/$(cat "$TMP"/a3.out | grep -ci deadlock)" "1/1/0"
  check "scratch vs refund(withdraw): the entry is scratched (not overwritten to withdrawn)" "$(status_of 008105)" "scratched"
  check "scratch vs refund(withdraw): the allocation does not claim the entry was withdrawn by the refund" "$(q "select participation_outcome from public.event_order_refund_allocations a join public.event_order_refunds r on r.id = a.refund_id where r.refund_request_id = '$REQ_R3'")" "not_applicable"
  check "scratch vs refund(withdraw): the refund itself succeeded (money recorded once)" "$(q "select status || '/' || amount_cents from public.event_order_refunds where refund_request_id = '$REQ_R3'")" "succeeded/3000"
  check "scratch vs refund(withdraw): three succeeded refunds so far -> three refund accounting entries (one each, none for scratches)" "$(q "select count(*) from public.accounting_entries where category = 'competition_entry_refund'")" "3"

  # ---- 4. Two refund requests and a scratch on three different entries of ONE order at once: no deadlock, all commit.
  echo "(no further race: entries of one order are independent rows; order-level serialisation is covered by R2's own suite)"
fi

if [ "$MODE" = "rollback" ]; then
  # Evidence exists (refund ledger, scratch history). SC1 rolls back softly (skipped if sc1_concurrency.sh with SC1_SOFT_ROLLBACK=1 already did it); R2 refuses.
  SC1RB="$HERE/../rollback/20270108090000_competition_sc1_scratch_rollback.sql"
  R2RB="$HERE/../rollback/20270103090000_competition_r2_entry_refunds_rollback.sql"
  pins() { q "select string_agg(left(md5(replace(prosrc, E'\\r', '')), 8), ',' order by oid::regprocedure::text) from pg_proc where oid in (to_regprocedure('public.sync_competition_entries_from_registration()'), to_regprocedure('public.sync_event_payment_accounting_entry()'), to_regprocedure('public._paywh1_exception_money_state(text)'), to_regprocedure('public.resolve_event_order_settlement_exception(uuid,text)'))"; }
  sc1_live() { q "select to_regprocedure('public.scratch_competition_entry(uuid,uuid,text,text)') is not null"; }
  R2_PINS="5469516f,dd85d688,3a19d4b4,4577dc12"
  scratches=$(q "select count(*) from public.event_competition_scratches")
  refunds=$(q "select count(*) from public.event_order_refunds")
  check "evidence exists before rollback (scratch history and refund ledger)" "$([ "$scratches" -gt 0 ] && [ "$refunds" -gt 0 ] && echo yes || echo no)" "yes"
  if [ "$(sc1_live)" = "t" ]; then
    out=$($PSQL < "$R2RB" 2>&1 || true)
    check "R2 rolled back FIRST while SC1 is applied: refused (SC1 must go first)" "$(echo "$out" | grep -c 'SC1 (scratch workflow) is still applied' || true)" "1"
    out=$($PSQL < "$SC1RB" 2>&1 || true)
    check "combined rollback step 1: SC1 rolls back softly (keeps its audit tables) while scratch history exists" "$(echo "$out" | grep -c 'audit tables kept' || true)" "1"
  fi
  check "combined rollback step 1: 10A guard restored (7997313d), scratch history kept" "$(q "select left(md5(replace(prosrc, E'\\r', '')), 8) from pg_proc where oid = 'public.protect_locked_competition_heat_children()'::regprocedure")/$(q "select count(*) from public.event_competition_scratches")" "7997313d/$scratches"
  check "combined rollback step 1: R2 function bodies are still the R2 pins (the SC1 rollback did not touch them)" "$(pins)" "$R2_PINS"
  out=$($PSQL < "$R2RB" 2>&1 || true)
  check "combined rollback step 2: R2 refuses while refund evidence exists" "$(echo "$out" | grep -c 'R2 rollback refused: refund ledger' || true)" "1"
  check "combined rollback step 2: nothing changed (refund ledger intact, R2 bodies still the R2 pins)" "$(q "select count(*) from public.event_order_refunds")/$(pins)" "$refunds/$R2_PINS"
  check "combined rollback: refunded and scratched entries keep their statuses" "$(status_of 008106)/$(status_of 008107)/$(status_of 008105)" "scratched/withdrawn/scratched"
fi

echo "---- passed: $pass, failed: $fail"
[ "$fail" = "0" ]
