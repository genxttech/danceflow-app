#!/usr/bin/env bash
# BILLING-QA-6 two-session proof that apply_studio_subscription_state serializes per studio and rejects an older read.
# SCRATCH database only (public schema + migrations 20270202090000 and 20270202100000 applied). Leaves fixture rows in the scratch db.
#   DB_EXEC="docker exec -i <container> psql -U postgres -q -At <scratch_db>" ./billing_qa6_concurrency.sh
set -euo pipefail
P="${DB_EXEC:?set DB_EXEC to a psql command for the scratch database}"
STUDIO=00000000-0000-0000-0000-0000000000bb
PLAN=00000000-0000-0000-0000-0000000000aa

$P <<SQL
insert into subscription_plans (id, code, name, active) values ('$PLAN','qa6c','QA6C',true) on conflict do nothing;
insert into studios (id, name, slug, billing_plan, billing_override_enabled, subscription_status)
  values ('$STUDIO','QA6 conc','qa6-conc','starter',false,'inactive') on conflict do nothing;
SQL

sub() { printf '{"subscription_plan_id":"%s","stripe_subscription_id":"sub_c","status":"%s","billing_interval":"month"}' "$PLAN" "$1"; }
snap() { printf '{"stripe_customer_id":"cus_c","stripe_subscription_id":"sub_c","subscription_status":"%s","billing_plan":"growth"}' "$1"; }

# NEWER read (10:00:10, cancelled) holds the studio lock for 3 s; OLDER read (10:00:01, active) arrives 1 s later.
( echo "begin; select 'newer:'||public.apply_studio_subscription_state('$STUDIO','$(sub cancelled)'::jsonb,'2026-10-30T10:00:10Z','$(snap canceled)'::jsonb,null); select pg_sleep(3); commit;" | $P > /tmp/billing_qa6_conc_a.txt ) &
sleep 1
echo "select 'older:'||public.apply_studio_subscription_state('$STUDIO','$(sub active)'::jsonb,'2026-10-30T10:00:01Z','$(snap active)'::jsonb,null);" | $P > /tmp/billing_qa6_conc_b.txt
wait

grep -q 'newer:applied' /tmp/billing_qa6_conc_a.txt
grep -q 'older:stale' /tmp/billing_qa6_conc_b.txt
test "$($P -c "select ss.status||'/'||s.subscription_status from studio_subscriptions ss join studios s on s.id=ss.studio_id where s.id='$STUDIO'")" = "cancelled/canceled"
echo "billing_qa6 concurrency: PASSED (older read queued behind the lock and was stale; final state is the newer read)"
