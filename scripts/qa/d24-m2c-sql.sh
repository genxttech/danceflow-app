#!/usr/bin/env bash
# D24 M2-C: run the real M1 + M2-C migrations (and the M2-C rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m2c-pg: no published ports, no volumes, removed on exit. It never touches any other database.
# Exercises: bounded drain, duplicates, out-of-order, concurrent drains, retries, partial failure, poison events, audited requeue, monitoring, rollback.
# Usage: bash scripts/qa/d24-m2c-sql.sh
set -uo pipefail

NAME=df-d24-m2c-pg
M_CLAIM="src/lib/supabase/migrations/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="src/lib/supabase/migrations/20270203110000_d24_hosted_invoice_facts.sql"
M_RB1="src/lib/supabase/migrations/rollback/20270203110000_d24_hosted_invoice_facts_rollback.sql"
M_C="src/lib/supabase/migrations/20270206090000_d24_m2c_drain_recovery.sql"
M_RBC="src/lib/supabase/migrations/rollback/20270206090000_d24_m2c_drain_recovery_rollback.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24" "$M_RB1" "$M_C" "$M_RBC"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"; cleanup' EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=d24-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec "$NAME" pg_isready -U postgres >/dev/null

P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -qAt"
q() { $P -c "$1"; }
# run as a role; prints "ERR <message>" on failure instead of aborting
as() { docker exec -i "$NAME" psql -U postgres -qAt -c "set role $1; $2" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/^SET //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-900; }
# run, never abort, return flattened error text
try() { docker exec -i "$NAME" psql -U postgres -qAt -c "$1" </dev/null 2>&1 | tr '
' ' ' | sed -E 's/ERROR:  /ERR /' | cut -c1-400; }

$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_CLAIM" >/dev/null
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_D24" >/dev/null
docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_C" >/dev/null || { echo "M2C migration failed to apply"; exit 2; }

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi; }

SA=00000000-0000-0000-0000-00000000005a
O1=00000000-0000-0000-0000-0000000000a1
ACT=00000000-0000-0000-0000-0000000000c1
H=hash1
q "insert into public.studios (id, name) values ('$SA','A')" >/dev/null

# fault injection used only in this disposable database -----------------------------------------------------------------------
$P <<'SQL'
create table public.qa_flags (k text primary key);
create function public.qa_fault() returns trigger language plpgsql as $$
begin
  if new.stripe_invoice_payment_id = 'inpay_poison' and exists (select 1 from public.qa_flags where k = 'poison') then
    raise exception 'qa poison' using errcode = 'XX001';
  end if;
  if new.stripe_invoice_payment_id like 'inpay_trans%' and exists (select 1 from public.qa_flags where k = 'transient') then
    raise exception 'qa transient' using errcode = '40001';
  end if;
  return new;
end $$;
create trigger qa_fault_trg before insert on public.hosted_invoice_payments for each row execute function public.qa_fault();
SQL

# helpers ---------------------------------------------------------------------------------------------------------------------
pj() { echo "{\"invoice_id\":\"$1\",\"object_id\":\"$2\",\"status\":\"paid\",\"amount_requested\":$3,\"amount_paid\":$3,\"currency\":\"usd\"}"; }
claim() { q "select (public.claim_payment_provider_event('stripe','$1','x','$H','${2:-$O1}'))->>'outcome'" >/dev/null; }
# defer EVENT INVOICE PAYMENT AMOUNT CREATED (amount = $4, created = $5)
dfr() { claim "$1"; q "select (public.d24_defer_event('$1','$O1','invoice_payment.paid',$5,null,false,'$H','invoice_payment','$(pj "$2" "$3" "$4")'::jsonb))->>'outcome'"; }
# one controlled batch: picked/applied/rejected/failed/pending_after/outcome
rd() { q "select coalesce(r->>'picked','-')||'/'||coalesce(r->>'applied','-')||'/'||coalesce(r->>'rejected','-')||'/'||coalesce(r->>'failed','-')||'/'||coalesce(r->>'pending_after','-')||'/'||(r->>'outcome') from (select public.d24_run_drain(${1:-25}, '${2:-manual}') r) x"; }
st() { q "select state||'/'||attempts||'/'||coalesce(last_error_code,'-')||'/'||requeue_count from public.hosted_invoice_deferred_events where provider_event_id='$1'"; }
cnt() { q "select count(*) from public.$1"; }

# 1. shape and privileges ----------------------------------------------------------------------------------------------------
check "2 new audit tables exist" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues')")" "2"
check "RLS enabled on the new tables, no policies" "$(q "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues') and c.relrowsecurity")/$(q "select count(*) from pg_policies where tablename in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues')")" "2/0"
check "service_role holds SELECT only on the new tables" "$(q "select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where grantee='service_role' and table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues')")" "SELECT"
check "anon/authenticated/public hold nothing on the new tables" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','public') and table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues')")" "0"
for sig in "d24_run_drain(integer,text)" "d24_record_drain_failure(text,text)" "d24_drain_health(integer,integer)" "d24_requeue_deferred_event(text,uuid,text)"; do
  check "service_role executes / anon + authenticated do not: $sig" "$(q "select has_function_privilege('service_role','public.$sig','execute')::text||has_function_privilege('anon','public.$sig','execute')::text||has_function_privilege('authenticated','public.$sig','execute')::text")" "truefalsefalse"
done
check "the bare batch function is internal: service_role cannot call it any more" "$(q "select has_function_privilege('service_role','public.d24_drain_deferred(integer)','execute')::text||has_function_privilege('anon','public.d24_drain_deferred(integer)','execute')::text")" "falsefalse"
check "anon cannot run the drain (permission denied)" "$(as anon "select public.d24_run_drain(1,'manual')" | grep -c 'permission denied')" "1"
check "authenticated cannot requeue (permission denied)" "$(as authenticated "select public.d24_requeue_deferred_event('x','$ACT','r')" | grep -c 'permission denied')" "1"
check "service_role cannot write the new tables directly" "$(as service_role "insert into public.hosted_invoice_drain_runs (trigger_kind, outcome, error_code) values ('manual','error','X')" | grep -c 'permission denied')" "1"
check "even the owner role cannot insert a drain run without the writer flag" "$(try "insert into public.hosted_invoice_drain_runs (trigger_kind, outcome, error_code) values ('manual','error','X')" | grep -c 'only allowed through the d24 functions')" "1"
check "static: M2-C never reads or writes payment_provider_events (no resend, no claim mutation)" "$(grep -vE '^\s*--' "$M_C" | grep -c 'payment_provider_events')" "0"

# 2. drain basics: out-of-order, duplicates, replay with live route -----------------------------------------------------------------
check "empty queue: a run is a clean no-op and is audited" "$(rd 25)/$(cnt hosted_invoice_drain_runs)" "0/0/0/0/0/completed/1"
dfr evt_q2 in_q inpay_q2 30 2000 >/dev/null     # arrives later but was created later
dfr evt_q1 in_q inpay_q1 10 1000 >/dev/null     # arrives later in time, created earlier
check "duplicate defer of the same event id is a no-op" "$(dfr evt_q1 in_q inpay_q1 10 1000)" "deferred"
check "...and stored once" "$(q "select count(*) from public.hosted_invoice_deferred_events where provider_event_id='evt_q1'")" "1"
check "run applies both, nothing rejected" "$(rd 25)" "2/2/0/0/0/completed"
check "both payments recorded once, attributed to nobody (unregistered)" "$(q "select count(*)||'/'||count(studio_id) from public.hosted_invoice_payments where stripe_invoice_id='in_q'")" "2/0"
check "deferred rows are 'applied' with their error cleared" "$(st evt_q1)/$(st evt_q2)" "applied/1/-/0/applied/1/-/0"
check "a second run finds nothing (idempotent)" "$(rd 25)" "0/0/0/0/0/completed"
check "no duplicate source events" "$(q "select count(*) from public.hosted_invoice_source_events where stripe_invoice_id='in_q'")" "2"
# event applied live (route) and ALSO deferred earlier: drain must see 'replayed', never double-record
dfr evt_live in_live inpay_live 50 3000 >/dev/null
q "select (public.d24_apply_event('evt_live','$O1','invoice_payment.paid',3000,null,false,'$H','invoice_payment','$(pj in_live inpay_live 50)'::jsonb))->>'outcome'" >/dev/null
check "live apply settles the pending deferred copy" "$(st evt_live)" "applied/0/-/0"
check "...and the drain then has nothing to do" "$(rd 25)" "0/0/0/0/0/completed"
check "one payment, not two" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_live'")" "1"
# register after the fact: adoption still works for facts that arrived through the drain
q "select public.d24_register_invoice('$SA',null,'in_q',false,'event_fee','bo-in_q')" >/dev/null
check "registration adopts drained facts (both payments attributed)" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_id='in_q' and studio_id='$SA'")" "2"

# 3. batch cap -------------------------------------------------------------------------------------------------------------------
$P -c "do \$\$ declare i int; begin for i in 1..120 loop
  perform public.claim_payment_provider_event('stripe','evt_bulk'||i,'x','$H','$O1');
  perform public.d24_defer_event('evt_bulk'||i,'$O1','invoice_payment.paid',10000+i,null,false,'$H','invoice_payment',
    jsonb_build_object('invoice_id','in_bulk'||(i % 7),'object_id','inpay_bulk'||i,'status','paid','amount_requested',5,'amount_paid',5,'currency','usd'));
end loop; end \$\$;" >/dev/null
check "120 events deferred" "$(q "select count(*) from public.hosted_invoice_deferred_events where state='pending'")" "120"
check "a request for 1000 is capped at 100 per batch; 'more' is signalled" "$(q "select (r->>'picked')||'/'||(r->>'applied')||'/'||(r->>'more') from (select public.d24_run_drain(1000,'scheduled') r) x")" "100/100/true"
check "the next batch drains the remaining 20; 'more' is false" "$(q "select (r->>'picked')||'/'||(r->>'applied')||'/'||(r->>'more') from (select public.d24_run_drain(100,'scheduled') r) x")" "20/20/false"
check "120 payments, one per event" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id like 'inpay_bulk%'")" "120"
check "a batch size of 0 or NULL is clamped, not an error" "$(q "select (public.d24_run_drain(0,'manual'))->>'outcome'")/$(q "select (public.d24_run_drain(null,'manual'))->>'outcome'")" "completed/completed"
check "an unknown trigger kind is refused (22023)" "$(try "select public.d24_run_drain(5,'cron')" | grep -c 'trigger must be')" "1"

# 4. concurrency -----------------------------------------------------------------------------------------------------------------
$P -c "do \$\$ declare i int; begin for i in 1..40 loop
  perform public.claim_payment_provider_event('stripe','evt_cc'||i,'x','$H','$O1');
  perform public.d24_defer_event('evt_cc'||i,'$O1','invoice_payment.paid',20000+i,null,false,'$H','invoice_payment',
    jsonb_build_object('invoice_id','in_cc'||(i % 3),'object_id','inpay_cc'||i,'status','paid','amount_requested',5,'amount_paid',5,'currency','usd'));
end loop; end \$\$;" >/dev/null
for n in 1 2 3 4; do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_drain_deferred(10)->>'applied'" </dev/null >"$TMPD/cc_$n.txt" 2>&1 ) & done
wait
CCSUM=$(cat "$TMPD"/cc_*.txt | grep -E "^[0-9]+$" | paste -sd+ | awk -F+ '{s=0; for(i=1;i<=NF;i++) s+=$i; print s}')
check "4 concurrent bare drains (skip locked) never exceed their limits and never overlap on a row" "$([ "$CCSUM" -le 40 ] && [ "$CCSUM" -ge 10 ] && echo ok)" "ok"
while [ "$(q "select count(*) from public.hosted_invoice_deferred_events where state='pending' and provider_event_id like 'evt_cc%'")" != 0 ]; do q "select public.d24_drain_deferred(10)" >/dev/null; done
check "after follow-up drains every event is applied exactly once overall" "$(q "select count(*) from public.hosted_invoice_deferred_events where provider_event_id like 'evt_cc%' and state='applied' and attempts=1")" "40"
check "...no duplicated payments or evidence" "$(q "select (select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id like 'inpay_cc%')||'/'||(select count(*) from public.hosted_invoice_source_events where provider_event_id like 'evt_cc%')")" "40/40"
check "...all deferred rows applied" "$(q "select count(*) from public.hosted_invoice_deferred_events where provider_event_id like 'evt_cc%' and state='applied'")" "40"

$P -c "do \$\$ declare i int; begin for i in 1..40 loop
  perform public.claim_payment_provider_event('stripe','evt_cr'||i,'x','$H','$O1');
  perform public.d24_defer_event('evt_cr'||i,'$O1','invoice_payment.paid',30000+i,null,false,'$H','invoice_payment',
    jsonb_build_object('invoice_id','in_cr'||(i % 2),'object_id','inpay_cr'||i,'status','paid','amount_requested',5,'amount_paid',5,'currency','usd'));
end loop; end \$\$;" >/dev/null
for n in 1 2 3 4; do ( docker exec -i "$NAME" psql -U postgres -qAt -c "select public.d24_run_drain(25,'scheduled')->>'outcome'" </dev/null >"$TMPD/cr_$n.txt" 2>&1 ) & done
wait
check "4 concurrent controlled runs: every outcome is completed or busy, at least one completed" "$(cat "$TMPD"/cr_*.txt | grep -cE '^(completed|busy)$')/$(cat "$TMPD"/cr_*.txt | grep -c '^completed$' | awk '{print ($1>=1)?"ok":"none"}')" "4/ok"
rd 25 >/dev/null; rd 25 >/dev/null
check "...after follow-up runs all 40 events are applied exactly once" "$(q "select (select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id like 'inpay_cr%')||'/'||(select count(*) from public.hosted_invoice_deferred_events where provider_event_id like 'evt_cr%' and state='applied')")" "40/40"
check "busy callers wrote no audit row (audit rows == completed runs)" "$(q "select count(*) from public.hosted_invoice_drain_runs where outcome='completed'")" "$(( $(cnt hosted_invoice_drain_runs) ))"

# singleton: a held run lock makes the next caller back off, touching nothing
dfr evt_busy in_busy inpay_busy 5 40000 >/dev/null
RUNS_BEFORE=$(cnt hosted_invoice_drain_runs)
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select pg_advisory_xact_lock(hashtextextended('d24:drain-run',0)); select pg_sleep(6); commit;" </dev/null >"$TMPD/hold.txt" 2>&1 ) &
sleep 3
check "while a run is in progress, a second caller gets 'busy'" "$(rd 25)" "-/-/-/-/-/busy"
wait
check "...and recorded nothing, and left the event pending" "$(cnt hosted_invoice_drain_runs)/$(st evt_busy)" "$RUNS_BEFORE/pending/0/-/0"
check "after the lock is released the event drains" "$(rd 25)/$(st evt_busy)" "1/1/0/0/0/completed/applied/1/-/0"

# 5. partial failure + poison isolation + retries ----------------------------------------------------------------------------------
q "insert into public.qa_flags values ('poison')" >/dev/null
dfr evt_pz in_poison inpay_poison 7 50000 >/dev/null      # permanent non-validation failure (XX001), oldest -> first in the batch
dfr evt_g1 in_g1 inpay_g1 7 50001 >/dev/null
dfr evt_g2 in_g2 inpay_g2 7 50002 >/dev/null
# permanent validation poison: cannot enter through d24_defer_event (it validates), so plant it the way a bug or an old version could have
q "select set_config('d24.writer','on',false); insert into public.hosted_invoice_deferred_events (provider_event_id,event_type,livemode,event_created,payload_hash,object_kind,object_snapshot) values ('evt_bad22','invoice_payment.paid',false,49999,'h','invoice_payment','{\"invoice_id\":\"in_bad22\",\"object_id\":\"inpay_bad22\",\"status\":\"paid\",\"amount_requested\":1,\"amount_paid\":1,\"currency\":\"USD\"}'::jsonb)" >/dev/null
check "first batch: validation poison rejected at once, XX001 failure counted, good events applied" "$(rd 25)" "4/2/1/1/1/completed"
check "validation poison: rejected with code 22023 on attempt 1" "$(st evt_bad22)" "rejected/1/22023/0"
check "XX001 poison: still pending, attempt counted, code recorded" "$(st evt_pz)" "pending/1/XX001/0"
check "partial failure left nothing behind (savepoint rolled back, no invoice row)" "$(q "select count(*) from public.hosted_invoices where stripe_invoice_id in ('in_poison','in_bad22')")" "0"
check "the good events behind the poison were applied" "$(st evt_g1)/$(st evt_g2)" "applied/1/-/0/applied/1/-/0"
for i in 2 3 4; do rd 25 >/dev/null; done
check "attempts 2..4 keep it pending" "$(st evt_pz)" "pending/4/XX001/0"
check "5th failed attempt quarantines it (rejected, kept as evidence)" "$(rd 25)/$(st evt_pz)" "1/0/1/0/0/completed/rejected/5/XX001/0"
check "rejected events are never picked again" "$(rd 25)" "0/0/0/0/0/completed"
check "poison rows are still present (no deletion)" "$(q "select count(*) from public.hosted_invoice_deferred_events where state='rejected'")" "2"

# transient errors: retried, not counted; ordered behind fresh events so they cannot starve newer ones
q "insert into public.qa_flags values ('transient')" >/dev/null
dfr evt_t1 in_t1 inpay_trans1 7 60000 >/dev/null
dfr evt_t2 in_t2 inpay_trans2 7 60001 >/dev/null
dfr evt_fresh in_fresh inpay_fresh 7 60002 >/dev/null
check "batch of 2: the two older (transient-failing) events are tried first" "$(rd 2)" "2/0/0/2/3/completed"
check "transient failure: still pending, attempts NOT incremented, code 40001 recorded" "$(st evt_t1)" "pending/0/40001/0"
check "next batch of 2: the never-tried fresh event goes first (no starvation) and applies" "$(rd 2)/$(st evt_fresh)" "2/1/0/1/2/completed/applied/1/-/0"
for i in 1 2 3 4 5 6 7; do rd 25 >/dev/null; done
check "7 more transient failures never quarantine it" "$(st evt_t1)" "pending/0/40001/0"
q "delete from public.qa_flags where k='transient'" >/dev/null
check "once the condition clears, both transient events apply" "$(rd 25)/$(st evt_t1)/$(st evt_t2)" "2/2/0/0/0/completed/applied/1/-/0/applied/1/-/0"

# 6. audited requeue ------------------------------------------------------------------------------------------------------------------
SNAP_PZ=$(q "select payload_hash||object_snapshot::text||received_at::text from public.hosted_invoice_deferred_events where provider_event_id='evt_pz'")
check "requeue without a reason is refused" "$(try "select public.d24_requeue_deferred_event('evt_pz','$ACT','  ')" | grep -c 'reason')" "1"
check "requeue without an actor is refused" "$(try "select public.d24_requeue_deferred_event('evt_pz',null,'fixed the trigger')" | grep -c 'actor')" "1"
check "requeue of an unknown event is refused" "$(try "select public.d24_requeue_deferred_event('evt_nope','$ACT','x')" | grep -c 'd24_deferred_event_not_found')" "1"
check "requeue of an applied event is refused" "$(try "select public.d24_requeue_deferred_event('evt_g1','$ACT','x')" | grep -c 'd24_requeue_requires_rejected_event')" "1"
check "requeue of a pending event is refused" "$( dfr evt_pend in_pend inpay_pend 1 70000 >/dev/null; try "select public.d24_requeue_deferred_event('evt_pend','$ACT','x')" | grep -c 'd24_requeue_requires_rejected_event')" "1"
check "a refused requeue changed nothing and logged nothing" "$(st evt_pz)/$(cnt hosted_invoice_deferred_requeues)" "rejected/5/XX001/0/0"
check "direct UPDATE rejected -> pending is refused (owner role, writer flag set, no requeue flag)" "$(try "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set state='pending', settled_at=null where provider_event_id='evt_pz'" | grep -c 'cannot change state')" "1"
check "a forged requeue flag cannot reset attempts" "$(try "select set_config('d24.writer','on',false), set_config('d24.requeue','on',false); update public.hosted_invoice_deferred_events set state='pending', settled_at=null, attempts=0, attempt_base=0, requeue_count=1 where provider_event_id='evt_pz'" | grep -c 'must keep attempts')" "1"
check "DELETE of a deferred event is refused" "$(try "select set_config('d24.writer','on',false); delete from public.hosted_invoice_deferred_events where provider_event_id='evt_pz'" | grep -c 'permanent evidence')" "1"
check "requeue with the poison still in place succeeds" "$(q "select (public.d24_requeue_deferred_event('evt_pz','$ACT','retry after plan'))->>'outcome'")" "requeued"
check "...state pending, attempts preserved, error cleared, requeue_count 1" "$(st evt_pz)" "pending/5/-/1"
check "requeue evidence is complete" "$(q "select (actor_user_id::text = '$ACT')::text||'/'||reason||'/'||requeue_number||'/'||prior_attempts||'/'||prior_error_code from public.hosted_invoice_deferred_requeues where provider_event_id='evt_pz'")" "true/retry after plan/1/5/XX001"
check "...and the original event evidence is untouched" "$(q "select payload_hash||object_snapshot::text||received_at::text from public.hosted_invoice_deferred_events where provider_event_id='evt_pz'")" "$SNAP_PZ"
check "a requeued event gets a FRESH attempt budget (not rejected on the first failure)" "$(rd 25)/$(st evt_pz)" "2/1/0/1/1/completed/pending/6/XX001/1"
q "delete from public.qa_flags where k='poison'" >/dev/null
check "after the fix the requeued event applies" "$(rd 25)/$(st evt_pz)" "1/1/0/0/0/completed/applied/7/-/1"
check "...and the invoice payment exists exactly once" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_poison'")" "1"
check "requeue log is append-only (update and delete refused)" "$(try "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_requeues set reason='x'" | grep -c append-only)/$(try "delete from public.hosted_invoice_deferred_requeues" | grep -c append-only)" "1/1"
check "drain-run log is append-only" "$(try "update public.hosted_invoice_drain_runs set picked=0" | grep -c append-only)/$(try "truncate public.hosted_invoice_drain_runs" | grep -c append-only)" "1/1"
# a validation-poison requeue loops back to rejected after one attempt; the 5-requeue cap stops it being endless
for i in 1 2 3 4 5; do
  q "select public.d24_requeue_deferred_event('evt_bad22','$ACT','try $i')" >/dev/null; rd 25 >/dev/null
done
check "validation poison: five requeues each end in rejected again (attempt budget irrelevant for 22023)" "$(st evt_bad22)" "rejected/6/22023/5"
check "the sixth requeue is refused (cap)" "$(try "select public.d24_requeue_deferred_event('evt_bad22','$ACT','one more')" | grep -c 'd24_requeue_limit_reached')" "1"
check "requeue log holds every request" "$(q "select count(*) from public.hosted_invoice_deferred_requeues where provider_event_id='evt_bad22'")" "5"

# 7. monitoring: counts and codes only, no payload leakage ----------------------------------------------------------------------------------
HEALTH=$(q "select public.d24_drain_health()::text")
check "health reports rejected count and codes" "$(q "select (public.d24_drain_health()->'by_state'->'rejected'->>'count')||'/'||(public.d24_drain_health()->'error_codes'->>'22023')")" "1/1"
check "health classifies recovery states" "$(q "select (public.d24_drain_health()->'recovery'->>'rejected_validation')||'/'||(public.d24_drain_health()->'recovery'->>'applied_after_requeue')")" "1/1"
check "health shows the last run and requeue counters" "$(q "select (public.d24_drain_health()->'last_run'->>'outcome')||'/'||(public.d24_drain_health()->>'requeues_total')")" "completed/6"
check "health raises rejected_present" "$(q "select public.d24_drain_health()->'alarms' ? 'rejected_present'")" "t"
check "no payload, event id, invoice id or error message appears in health output" "$(echo "$HEALTH" | grep -cE 'inpay_|"in_|evt_|qa poison|object_snapshot|"payload"')" "0"
dfr evt_old in_old inpay_old 1 80000 >/dev/null
check "pending_stale fires when the oldest pending event is past the threshold" "$(q "select public.d24_drain_health(-1, 1800)->'alarms' ? 'pending_stale'")" "t"
check "...and is quiet below it" "$(q "select public.d24_drain_health(900, 1800)->'alarms' ? 'pending_stale'")" "f"
check "drain_not_running fires when pending exists and no recent completed run" "$(q "select public.d24_drain_health(900, -1)->'alarms' ? 'drain_not_running'")" "t"
check "oldest pending age and counts are reported" "$(q "select (public.d24_drain_health()->'by_state'->'pending'->>'count')||'/'||((public.d24_drain_health()->'by_state'->'pending'->>'oldest_age_seconds')::bigint >= 0)")" "1/true"
check "record_drain_failure rejects free text / long codes" "$(try "select public.d24_record_drain_failure('manual','bad code with spaces')" | grep -c 'error code')" "1"
check "record_drain_failure writes an error run row" "$(q "select public.d24_record_drain_failure('scheduled','57014')->>'outcome'")/$(q "select outcome||'/'||error_code from public.hosted_invoice_drain_runs order by id desc limit 1")" "recorded/error/57014"
check "health raises drain_errors after a failed run" "$(q "select public.d24_drain_health()->'alarms' ? 'drain_errors'")" "t"
check "health is read-only (stable) and callable by service_role" "$(as service_role "select public.d24_drain_health()->>'alarms'" | grep -c '\[')" "1"
rd 25 >/dev/null
check "a drain that settles the queue clears pending_stale" "$(q "select public.d24_drain_health(-1, 1800)->'alarms' ? 'pending_stale'")" "f"

# 7b. live route vs a drain-held key lock: bounded wait, nothing written, claim kept, retry succeeds exactly once ---------------------------------------
LKP=$(pj in_lk inpay_lk 77)
claim evt_lk >/dev/null
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select pg_advisory_xact_lock(hashtextextended('d24::in_lk',0)); select pg_sleep(9); commit;" </dev/null >"$TMPD/lk_hold.txt" 2>&1 ) &
sleep 2
T0=$(date +%s)
LKR=$(try "select public.d24_apply_event('evt_lk','$O1','invoice_payment.paid',90000,null,false,'$H','invoice_payment','$LKP'::jsonb)")
T1=$(date +%s)
check "live apply waiting on a held key lock fails with a lock timeout (55P03), not an unbounded wait" "$(echo "$LKR" | grep -c 'lock timeout')" "1"
check "...within the bound (<= 6 s, held lock lasts 9 s)" "$([ $((T1 - T0)) -le 6 ] && echo ok)" "ok"
check "...and wrote nothing (no evidence, no invoice row, no payment)" "$(q "select (select count(*) from public.hosted_invoice_source_events where provider_event_id='evt_lk')||'/'||(select count(*) from public.hosted_invoices where stripe_invoice_id='in_lk')||'/'||(select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_lk')")" "0/0/0"
check "...and the PAY-WH-1 claim is still owned by the same worker (so the retry can proceed)" "$(q "select count(*) from public.payment_provider_events where provider_event_id='evt_lk' and status='processing'")" "1"
wait
RT=$(try "select (public.d24_apply_event('evt_lk','$O1','invoice_payment.paid',90000,null,false,'$H','invoice_payment','$LKP'::jsonb))->>'outcome'" | tr -d " ")
check "the retry after the lock is released applies" "$RT" "applied"
RT2=$(try "select (public.d24_apply_event('evt_lk','$O1','invoice_payment.paid',90000,null,false,'$H','invoice_payment','$LKP'::jsonb))->>'outcome'" | tr -d " ")
check "a further retry is a replay: exactly one payment and one evidence row" "$RT2/$(q "select (select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_lk')||'/'||(select count(*) from public.hosted_invoice_source_events where provider_event_id='evt_lk')")" "replayed/1/1"
check "the key-lock timeout is transaction-local (a fresh session still has none)" "$(q "show lock_timeout")" "0"
# a drain that is itself blocked on a held key gives up quickly (1 s) and keeps the event pending, uncounted
dfr evt_lk2 in_lk2 inpay_lk2 5 90100 >/dev/null
( docker exec -i "$NAME" psql -U postgres -qAt -c "begin; select pg_advisory_xact_lock(hashtextextended('d24::in_lk2',0)); select pg_sleep(5); commit;" </dev/null >"$TMPD/lk_hold2.txt" 2>&1 ) &
sleep 2
check "drain blocked on a held key: event stays pending, transient code, not counted" "$(rd 25)/$(st evt_lk2)" "1/0/0/1/1/completed/pending/0/55P03/0"
wait
check "once the key is free the same event drains" "$(rd 25)/$(st evt_lk2)" "1/1/0/0/0/completed/applied/1/-/0"
# duplicates and out-of-order across live and drain for one invoice
dfr evt_oo2 in_oo inpay_oo2 4 91002 >/dev/null
dfr evt_oo1 in_oo inpay_oo1 3 91001 >/dev/null
claim evt_oo3 >/dev/null
q "select public.d24_apply_event('evt_oo3','$O1','invoice_payment.paid',91003,null,false,'$H','invoice_payment','$(pj in_oo inpay_oo3 2)'::jsonb)" >/dev/null
rd 25 >/dev/null; rd 25 >/dev/null
check "live + deferred events for one invoice, any order: three payments, three evidence rows, once each" "$(q "select (select count(*) from public.hosted_invoice_payments where stripe_invoice_id='in_oo')||'/'||(select count(*) from public.hosted_invoice_source_events where stripe_invoice_id='in_oo')")" "3/3"

# 8. M1 behaviors still hold -------------------------------------------------------------------------------------------------------------------
check "d24_drain_deferred keeps its M1 result keys (plus picked)" "$(q "select string_agg(k, ',' order by k) from jsonb_object_keys(public.d24_drain_deferred(1)) k")" "applied,failed,picked,rejected"
check "an applied deferred event still cannot change state" "$(try "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set state='pending', settled_at=null where provider_event_id='evt_g1'" | grep -c 'cannot change state')" "1"
check "event evidence columns stay immutable" "$(try "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set payload_hash='z' where provider_event_id='evt_g1'" | grep -c 'immutable')" "1"
check "attempt_base / requeue_count cannot be edited outside a requeue" "$(try "select set_config('d24.writer','on',false); update public.hosted_invoice_deferred_events set attempt_base=0 where provider_event_id='evt_pz'" | grep -c 'recovery bookkeeping')" "1"

# 9. rollback ----------------------------------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RBC" 2>&1 | tr -d '\n' | cut -c1-120)
check "M2-C rollback is refused while audit evidence exists" "$(echo "$r" | grep -c 'rollback refused')" "1"
check "...and left the schema intact" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues')")" "2"
(echo "set d24.m2c_rollback_exported = 'yes';"; cat "$M_RBC") | docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null 2>&1
check "after an explicit export acknowledgement the rollback proceeds and removes the M2-C objects" "$(q "select (select count(*) from information_schema.tables where table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues'))||'/'||(select count(*) from pg_proc where proname in ('d24_run_drain','d24_drain_health','d24_record_drain_failure','d24_requeue_deferred_event'))")" "0/0"
check "...the original deferred events (evidence) survive the rollback" "$(q "select count(*) > 100 from public.hosted_invoice_deferred_events")" "t"

docker exec "$NAME" psql -U postgres -qAt -c "create database d24fresh" >/dev/null
F="docker exec -i $NAME psql -U postgres -d d24fresh -v ON_ERROR_STOP=1 -qAt"
$F <<'SQL'
create role d24_dummy nologin;
create schema if not exists public;
create table public.studios (id uuid primary key default gen_random_uuid());
create table public.payment_provider_events (id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text, created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
$F < "$M_CLAIM" >/dev/null 2>&1
check "fresh DB: M2-C refuses to apply without M1" "$($F < "$M_C" 2>&1 | grep -c 'M1 .* is not applied')" "1"
$F < "$M_D24" >/dev/null 2>&1
$F < "$M_C" >/dev/null 2>&1
check "fresh DB: M1 + M2-C apply" "$($F -c "select count(*) from information_schema.columns where table_name='hosted_invoice_deferred_events' and column_name in ('last_error_code','last_attempt_at','attempt_base','requeue_count')")" "4"
$F < "$M_RBC" >/dev/null 2>&1
check "fresh DB: rollback of an empty M2-C install restores the M1 shape" "$($F -c "select (select count(*) from information_schema.columns where table_name='hosted_invoice_deferred_events' and column_name in ('last_error_code','last_attempt_at','attempt_base','requeue_count'))||'/'||(select count(*) from pg_proc where proname in ('d24_run_drain','d24_drain_health','d24_requeue_deferred_event','d24_record_drain_failure'))||'/'||(select count(*) from information_schema.tables where table_name in ('hosted_invoice_drain_runs','hosted_invoice_deferred_requeues'))")" "0/0/0"
check "fresh DB: the restored M1 drain returns the M1 result keys" "$($F -c "select string_agg(k, ',' order by k) from jsonb_object_keys(public.d24_drain_deferred(1)) k")" "applied,failed,rejected"
check "fresh DB: rollback restores the M1 service_role grant on the bare drain" "$($F -c "select has_function_privilege('service_role','public.d24_drain_deferred(integer)','execute')")" "t"
check "fresh DB: the M1 guard is restored (no requeue path)" "$($F -c "select prosrc like '%d24.requeue%' from pg_proc where proname='_d24_deferred_guard'")" "f"
$F < "$M_C" >/dev/null 2>&1
check "fresh DB: M2-C re-applies after rollback" "$($F -c "select count(*) from pg_proc where proname in ('d24_run_drain','d24_drain_health','d24_requeue_deferred_event','d24_record_drain_failure')")" "4"

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
