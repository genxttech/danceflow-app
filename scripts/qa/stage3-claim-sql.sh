#!/usr/bin/env bash
# Stage 3 (WP2/WP6): run the real PAY-WH-1 claim/complete SQL against a DISPOSABLE Postgres container.
#
# The container is created and removed by this script (name df-s3-claim-pg, no published ports, no volumes). It never
# touches any other database. payment_provider_events was created outside the repo migrations, so a minimal compatible
# base table is reconstructed here; the PAY-WH-1 migration itself is applied unmodified.
#
# LIMITATION: the base table is a reconstruction, so this cannot detect NOT NULL or default drift against the real table.
#
# Usage: bash scripts/qa/stage3-claim-sql.sh
set -euo pipefail

NAME=df-s3-claim-pg
MIGRATION="src/lib/supabase/migrations/20261116090000_paywh1_webhook_event_claims.sql"
cd "$(dirname "$0")/../.."
[ -f "$MIGRATION" ] || { echo "missing $MIGRATION"; exit 2; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=stage3-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
docker exec "$NAME" pg_isready -U postgres >/dev/null

P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -qAt"
q() { $P -c "$1"; }

$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text,
  status text not null default 'received',
  payload_hash text,
  processed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
SQL
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$MIGRATION" >/dev/null

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"; cleanup' EXIT
pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi
}

A=00000000-0000-0000-0000-0000000000a1
B=00000000-0000-0000-0000-0000000000b2
claim() { q "select (public.claim_payment_provider_event('stripe','$1','invoice_payment.paid','h','$2',${3:-120}))->>'outcome'"; }
complete() { q "select public.complete_payment_provider_event('stripe','$1','$2','$3',null,${4:-null})"; }
row() { q "select status||'/'||attempt_count||'/'||coalesce(claim_owner::text,'-') from public.payment_provider_events where provider_event_id='$1'"; }

# 1. first claim, same owner re-claim, other owner blocked while the lease is live
check "first delivery is claimed" "$(claim evt_s3_1 $A)" "claimed"
check "other owner is told in_progress while the lease is live" "$(claim evt_s3_1 $B)" "in_progress"
check "same owner may re-claim (attempt counted)" "$(claim evt_s3_1 $A)" "claimed"
check "attempt_count counts both claims" "$(row evt_s3_1)" "processing/2/$A"

# 2. only the owner can complete; completion is idempotent-safe
check "non-owner cannot complete" "$(complete evt_s3_1 $B processed)" "f"
check "owner completes as processed" "$(complete evt_s3_1 $A processed)" "t"
check "second completion by the owner finds nothing to complete" "$(complete evt_s3_1 $A processed)" "f"
check "processed event is acknowledged for every later delivery" "$(claim evt_s3_1 $B)" "already_processed"
check "processed event is never re-claimed, even by its old owner" "$(claim evt_s3_1 $A)" "already_processed"

# 3. failure and replay (WP6)
check "claim for a failing event" "$(claim evt_s3_2 $A)" "claimed"
check "owner finalizes as failed" "$(complete evt_s3_2 $A failed "'boom'")" "t"
check "failed event keeps the error and clears the claim" "$(q "select status||'/'||error_message||'/'||coalesce(claim_owner::text,'-') from public.payment_provider_events where provider_event_id='evt_s3_2'")" "failed/boom/-"
check "a failed event is claimable again by any owner" "$(claim evt_s3_2 $B)" "claimed"
check "replay succeeds and is processed" "$(complete evt_s3_2 $B processed)" "t"
check "replayed event history: 2 attempts" "$(row evt_s3_2)" "processed/2/-"

# 4. lease expiry and take-over; the old owner can no longer finalize
check "claim with the shortest lease" "$(claim evt_s3_3 $A 15)" "claimed"
q "update public.payment_provider_events set claim_expires_at = now() - interval '1 second' where provider_event_id='evt_s3_3'" >/dev/null
check "expired lease is taken over by another owner" "$(claim evt_s3_3 $B)" "claimed"
check "the old owner cannot complete after take-over" "$(complete evt_s3_3 $A processed)" "f"
check "the new owner can" "$(complete evt_s3_3 $B processed)" "t"
lease() { q "select round(extract(epoch from (claim_expires_at - last_attempt_at)))::int from public.payment_provider_events where provider_event_id='$1'"; }
claim evt_s3_4 $A 1 >/dev/null
check "a 1 second lease is clamped up to 15" "$(lease evt_s3_4)" "15"
claim evt_s3_5 $A 100000 >/dev/null
check "a huge lease is clamped down to 900" "$(lease evt_s3_5)" "900"

# 5. input validation: missing event id or owner is refused, nothing is written
if $P -c "select public.claim_payment_provider_event('stripe','','t','h','$A',120)" >/dev/null 2>&1; then r=accepted; else r=refused; fi
check "an empty event id is refused" "$r" "refused"
check "no row was written for the refused claim" "$(q "select count(*) from public.payment_provider_events where provider_event_id=''")" "0"

# 6. duplicate deliveries with different event ids are separate rows (event-id dedupe only; business-key dedupe is app-level)
claim evt_s3_dupA $A >/dev/null; complete evt_s3_dupA $A processed >/dev/null
check "a second event id for the same invoice payment is claimable (needs business-key idempotency in handlers)" "$(claim evt_s3_dupB $A)" "claimed"

# 7. real concurrency: session A holds the row lock inside a transaction while B and nine more race it
EVT=evt_s3_race
( $P -c "begin; select public.claim_payment_provider_event('stripe','$EVT','t','h','$A',120); select pg_sleep(3); commit;" >$TMPD/s3_race_a.txt 2>&1 ) &
sleep 1
for i in 1 2 3 4 5 6 7 8 9; do
  ( q "select (public.claim_payment_provider_event('stripe','$EVT','t','h','00000000-0000-0000-0000-0000000000c$i',120))->>'outcome'" >$TMPD/s3_race_$i.txt 2>&1 ) &
done
wait
claimed_by_losers=$(cat $TMPD/s3_race_[1-9].txt | grep -c '^claimed$' || true)
blocked=$(cat $TMPD/s3_race_[1-9].txt | grep -c '^in_progress$' || true)
check "10 simultaneous claims: the lock holder claimed" "$(grep -c '"outcome": "claimed"\|"outcome":"claimed"' $TMPD/s3_race_a.txt || true)" "1"
check "10 simultaneous claims: none of the 9 racers also claimed" "$claimed_by_losers" "0"
check "10 simultaneous claims: the 9 racers were told in_progress" "$blocked" "9"
check "exactly one attempt was counted" "$(row $EVT | cut -d/ -f2)" "1"
[ "$blocked" = "9" ] || { echo "--- racer output sample:"; head -c 300 $TMPD/s3_race_1.txt; echo "--- holder:"; head -c 300 $TMPD/s3_race_a.txt; }
rm -f $TMPD/s3_race_*.txt

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
