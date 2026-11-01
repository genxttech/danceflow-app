#!/usr/bin/env bash
# D7 WP-3 price transition records: migration, rollback and SQL tests against a DISPOSABLE postgres container (local QA only).
# Never point this at a hosted database. Usage: bash scripts/qa/d7_price_transitions_sql.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=df-d7wp3-pg
MIG="$(cd "$(dirname "$0")/../../src/lib/supabase/migrations" && (pwd -W 2>/dev/null || pwd))"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$C" -e POSTGRES_PASSWORD=pw postgres:17 >/dev/null
for i in $(seq 1 40); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i "$C" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -X -q "${@:2}"; }

stub() {
  P "$1" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios(id uuid primary key);
SQL
}
apply() { docker cp "$MIG/$2" "$C:/tmp/$(basename "$2")"; P "$1" -f "/tmp/$(basename "$2")" >/dev/null; }

echo "=== postgres: $(docker exec "$C" psql -U postgres -Atc 'show server_version')"
P postgres -c "create database t" -c "create database rb" -c "create database pre"

echo "=== precondition guard: migration refuses without the registry table"
stub pre
if docker cp "$MIG/20270204090000_billing_price_transitions.sql" "$C:/tmp/m.sql" && P pre -f /tmp/m.sql >/dev/null 2>&1; then echo "FAIL: applied without registry"; exit 1; fi
echo "PASS refused"

echo "=== apply registry migration + WP-3 migration (twice: idempotent)"
stub t
apply t 20270201090000_billing_protected_subscriptions.sql
apply t 20270204090000_billing_price_transitions.sql
apply t 20270204090000_billing_price_transitions.sql
echo "PASS applied"

echo "=== SQL tests"
docker cp "$MIG/sql-tests/test_D7_price_transitions.sql" "$C:/tmp/tests.sql"
P t -f /tmp/tests.sql 2>&1 | tee /tmp/d7wp3_sqltests.txt | grep -E 'ALL PASS|ERROR|FAILED' || true
grep -q 'ALL PASS' /tmp/d7wp3_sqltests.txt || { echo "FAIL sql tests"; cat /tmp/d7wp3_sqltests.txt; exit 1; }

echo "=== concurrency: two simultaneous open transitions for one subscription"
P t -c "insert into public.price_transition_notices(id, protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference) values ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000a1','2027-07-09T04:00:00Z','price_regular',15900,'w')"
INS="insert into public.price_transitions(protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run) values ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c2','sub_TEST2','price_regular','2027-07-09T04:00:00Z','00000000-0000-0000-0000-0000000000d1','{}')"
( P t -Atc "begin; $INS; select pg_sleep(3); commit;" > /tmp/d7wp3_a.txt 2>&1 ) &
A=$!
sleep 1
set +e; P t -Atc "$INS" > /tmp/d7wp3_b.txt 2>&1; RB=$?; set -e
wait $A
N=$(P t -Atc "select count(*) from public.price_transitions where protected_subscription_id='00000000-0000-0000-0000-0000000000b2' and status in ('approved','scheduled')")
if [ "$N" != "1" ] || [ "$RB" = "0" ]; then echo "FAIL concurrency: open=$N exit_b=$RB"; cat /tmp/d7wp3_b.txt; exit 1; fi
grep -q 'duplicate key' /tmp/d7wp3_b.txt && echo "PASS exactly one open transition; the second writer was refused (duplicate key)"

echo "=== concurrency: two simultaneous reconciliations of one transition"
P t <<'SQL'
insert into public.protected_subscriptions(id, studio_id, stripe_subscription_id, stripe_customer_id, protection_kind, terms_reference)
  values ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1', 'sub_TEST5', 'cus_TEST5', 'contractual_exception', 'test');
insert into public.price_transition_notices(id, protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference, approved_by, approved_at, sent_at, recipient, message_id, delivery_status)
  values ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1', '2027-07-09T04:00:00Z', 'price_regular', 15900, 'w', '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days', now() - interval '1 day', 'o@example.test', 'm', 'delivered');
insert into public.price_transitions(id, protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run)
  values ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000c5', 'sub_TEST5', 'price_regular', '2026-07-09T04:00:00Z', '00000000-0000-0000-0000-0000000000d1', '{}');
update public.price_transitions set status='scheduled', stripe_schedule_id='sub_sched_5' where id='00000000-0000-0000-0000-0000000000e5';
SQL
EV="'{\"subscription_id\":\"sub_TEST5\",\"price_id\":\"price_regular\",\"schedule_id\":\"sub_sched_5\",\"boundary_at\":\"2026-07-09T04:00:00Z\",\"period_start\":\"2026-07-09T04:00:00Z\",\"observed_at\":\"2026-07-10T04:00:00Z\",\"observed_amount_cents\":15900,\"customer_matches\":\"true\",\"studio_matches\":\"true\",\"phase_entered\":\"true\",\"price_changed\":\"true\",\"amount_matches_notice\":\"true\"}'::jsonb"
CALLR="set role service_role; select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e5', $EV);"
( P t -Atc "begin; $CALLR select pg_sleep(3); commit;" > /tmp/d7wp3_ra.txt 2>&1 ) &
RA=$!
sleep 1
P t -Atc "begin; $CALLR commit;" > /tmp/d7wp3_rb.txt 2>&1
wait $RA
grep -q '^reconciled$' /tmp/d7wp3_ra.txt && grep -q '^already_reconciled$' /tmp/d7wp3_rb.txt || { echo "FAIL reconcile concurrency"; cat /tmp/d7wp3_ra.txt /tmp/d7wp3_rb.txt; exit 1; }
REL=$(P t -Atc "select count(*) from public.protected_subscriptions where id='00000000-0000-0000-0000-0000000000b5' and released_reason like 'price_transition_reconciled:%'")
[ "$REL" = "1" ] || { echo "FAIL: registry release count $REL"; exit 1; }
echo "PASS reconcile concurrency: one reconciled, one already_reconciled, registry released once"

echo "=== rollback refuses while records exist"
docker cp "$MIG/rollback/20270204090000_billing_price_transitions_rollback.sql" "$C:/tmp/rb.sql"
if P t -f /tmp/rb.sql >/dev/null 2>&1; then echo "FAIL: rollback ran with rows"; exit 1; fi
P t -Atc "select to_regclass('public.price_transitions') is not null" | grep -q t && echo "PASS refused, tables intact"

echo "=== rollback succeeds on an empty database, and the migration re-applies"
stub rb
apply rb 20270201090000_billing_protected_subscriptions.sql
apply rb 20270204090000_billing_price_transitions.sql
P rb -f /tmp/rb.sql >/dev/null
P rb -Atc "select to_regclass('public.price_transitions') is null and to_regclass('public.price_transition_notices') is null and to_regclass('public.protected_subscriptions') is not null" | grep -q t
apply rb 20270204090000_billing_price_transitions.sql
echo "PASS rollback removed only WP-3 objects; re-apply works"
echo "ALL WP-3 SQL CHECKS PASSED"
