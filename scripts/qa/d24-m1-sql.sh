#!/usr/bin/env bash
# D24 M1: run the real D24 migration (and its rollback) against a DISPOSABLE Postgres container.
# Container df-d24-m1-pg: no published ports, no volumes, removed on exit. It never touches any other database.
# The PAY-WH-1 claim migration is applied unmodified on a reconstructed base table (same limitation as stage3-claim-sql.sh).
# Usage: bash scripts/qa/d24-m1-sql.sh
set -uo pipefail

NAME=df-d24-m1-pg
M_CLAIM="src/lib/supabase/migrations/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="src/lib/supabase/migrations/20270203090000_d24_hosted_invoice_facts.sql"
M_RB="src/lib/supabase/migrations/rollback/20270203090000_d24_hosted_invoice_facts_rollback.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24" "$M_RB"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done

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
# run as a role; prints "ERR <sqlstate>" on failure instead of aborting
as() { docker exec -i "$NAME" psql -U postgres -qAt -c "set role $1; $2" 2>&1 | tr '
' ' ' | sed -E 's/^SET //; s/ERROR:  /ERR /' | sed -E 's/ +$//' | cut -c1-900; }

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

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1 (expected '$3', got '$2')"; fi; }

SA=00000000-0000-0000-0000-00000000005a
SB=00000000-0000-0000-0000-00000000005b
O1=00000000-0000-0000-0000-0000000000a1
O2=00000000-0000-0000-0000-0000000000a2
q "insert into public.studios (id, name) values ('$SA','A'),('$SB','B')" >/dev/null
H=hash1

# helpers --------------------------------------------------------------------------------------------------------------
claim() { q "select (public.claim_payment_provider_event('stripe','$1','x','$H','${2:-$O1}'))->>'outcome'"; }
# apply EVENT KIND TYPE CREATED ACCOUNT(or null) OBJECT_JSON [OWNER] [HASH] [LIVEMODE]
ap() {
  local acct="null"; [ "$5" != "null" ] && acct="'$5'"
  q "select public.d24_apply_event('$1','${7:-$O1}','$3',$4,$acct,${9:-false},'${8:-$H}','$2','$6'::jsonb)::text"
}
inv() { # status total paid remaining due created
  echo "{\"invoice_id\":\"$1\",\"status\":\"$2\",\"total\":$3,\"amount_due\":$6,\"amount_paid\":$4,\"amount_remaining\":$5,\"currency\":\"usd\"}"
}
rowof() { q "select $3 from public.hosted_invoices where stripe_invoice_id='$2' and coalesce(stripe_account_id,'')='$1'"; }
reg() { q "select (public.d24_register_invoice('$1',$2,'$3',false,'event_fee','bo-$3'))->>'outcome'"; }

# 1. migration shape ---------------------------------------------------------------------------------------------------
check "7 D24 tables exist" "$(q "select count(*) from information_schema.tables where table_schema='public' and (table_name like 'hosted\\_%')")" "7"
check "RLS enabled on all 7" "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'hosted\\_%' and c.relkind='r' and c.relrowsecurity")" "7"
check "no RLS policies exist (deny by default for tenants)" "$(q "select count(*) from pg_policies where tablename like 'hosted\\_%'")" "0"
check "anon has no table privilege" "$(q "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated','public') and table_name like 'hosted\\_%'")" "0"
check "service_role holds SELECT only" "$(q "select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants where grantee='service_role' and table_name like 'hosted\\_%'")" "SELECT"
check "anon cannot call d24_apply_event" "$(q "select has_function_privilege('anon','public.d24_apply_event(text,uuid,text,bigint,text,boolean,text,text,jsonb)','execute')")" "f"
check "authenticated cannot call d24_register_invoice" "$(q "select has_function_privilege('authenticated','public.d24_register_invoice(uuid,text,text,boolean,text,text,uuid)','execute')")" "f"
check "service_role can call d24_apply_event" "$(q "select has_function_privilege('service_role','public.d24_apply_event(text,uuid,text,bigint,text,boolean,text,text,jsonb)','execute')")" "t"
check "service_role cannot call internal helpers" "$(q "select has_function_privilege('service_role','public._d24_flag(uuid,text,boolean)','execute')")" "f"

# 2. direct-write safeguards -------------------------------------------------------------------------------------------
check "anon cannot select hosted_invoices" "$(as anon 'select count(*) from public.hosted_invoices' | grep -c "permission denied for table")" "1"
check "authenticated cannot insert registry" "$(as authenticated "insert into public.hosted_invoice_registry (studio_id,stripe_invoice_id,livemode,business_object_type,business_object_id) values ('$SA','in_x',false,'a','b')" | grep -c "permission denied for table")" "1"
check "service_role cannot insert directly" "$(as service_role "insert into public.hosted_invoice_registry (studio_id,stripe_invoice_id,livemode,business_object_type,business_object_id) values ('$SA','in_x',false,'a','b')" | grep -c "permission denied for table")" "1"
check "even the owner role is refused a direct insert (no writer flag)" "$(as postgres "insert into public.hosted_invoice_registry (studio_id,stripe_invoice_id,livemode,business_object_type,business_object_id) values ('$SA','in_x',false,'a','b')" | grep -c 'only allowed through the d24 functions')" "1"
check "service_role can select" "$(as service_role 'select count(*) from public.hosted_invoices')" "0"

# 3. claim ownership is required -----------------------------------------------------------------------------------------
OBJ=$(inv in_t1 void 10000 0 10000 10000)
r=$(q "select public.d24_apply_event('evt_noclaim','$O1','invoice.voided',1000,null,false,'$H','invoice','$OBJ'::jsonb)" 2>&1 | tr -d '\n' | cut -c1-60)
check "apply without a claim is refused" "$(echo "$r" | grep -c paywh1_claim_not_owned)" "1"
claim evt_a >/dev/null
r=$(q "select public.d24_apply_event('evt_a','$O2','invoice.voided',1000,null,false,'$H','invoice','$OBJ'::jsonb)" 2>&1 | tr -d '\n' | cut -c1-80)
check "apply by a non-owner of the claim is refused" "$(echo "$r" | grep -c paywh1_claim_not_owned)" "1"
check "refused applies wrote nothing" "$(q "select count(*) from public.hosted_invoices")" "0"

# 4. unmatched invoice is preserved, never attributed by guesswork ---------------------------------------------------------
out=$(ap evt_a invoice invoice.voided 1000 null "$OBJ")
check "first void creates an unmatched fact" "$(echo "$out" | grep -o '"reconciliation_state": "[a-z]*"')" '"reconciliation_state": "unmatched"'
check "studio is null (not guessed)" "$(rowof '' in_t1 "studio_id is null")" "t"
check "void is recorded faithfully" "$(rowof '' in_t1 status)" "void"
check "unverified void origin is flagged" "$(rowof '' in_t1 "anomaly_codes @> array['unverified_void_origin']")" "t"
check "a transition row exists, unverified, no authorization" "$(q "select origin_state||'/'||coalesce(authorization_ref::text,'none') from public.hosted_invoice_status_transitions where source_event_id='evt_a'")" "unverified/none"
check "source event evidence stored" "$(q "select count(*) from public.hosted_invoice_source_events where provider_event_id='evt_a'")" "1"
check "audit: null -> unmatched" "$(q "select coalesce(from_state,'-')||'>'||to_state from public.hosted_invoice_recon_audit order by id limit 1")" "->unmatched"
claim evt_a >/dev/null  # processed? no: evt_a still processing under O1; replay path next
out=$(ap evt_a invoice invoice.voided 1000 null "$OBJ")
check "replay of the same event id is a no-op" "$(echo "$out" | grep -o '"outcome": "[a-z]*"')" '"outcome": "replayed"'
check "replay recorded no second transition" "$(q "select count(*) from public.hosted_invoice_status_transitions")" "1"
out=$(ap evt_a invoice invoice.voided 1000 null "$OBJ" "$O1" other-hash)
check "replay with a different payload hash is acknowledged (no retry storm)" "$(echo "$out" | grep -c '"outcome": "replayed"')" "1"
check "...and surfaces the disagreement for review" "$(rowof '' in_t1 "anomaly_codes @> array['replay_payload_mismatch']")" "t"
check "...while the original evidence is untouched" "$(q "select payload_hash from public.hosted_invoice_source_events where provider_event_id='evt_a'")" "$H"

# 5. registry + adoption, out of order -----------------------------------------------------------------------------------
check "registration succeeds" "$(reg $SA null in_t1)" "registered"
check "registration adopted the earlier unmatched fact" "$(rowof '' in_t1 "studio_id = '$SA'")" "t"
check "state moves unmatched -> anomalous (unverified origin)" "$(rowof '' in_t1 reconciliation_state)" "anomalous"
check "audit shows the registration transition" "$(q "select count(*) from public.hosted_invoice_recon_audit where trigger_kind='registration' and from_state='unmatched' and to_state='anomalous'")" "1"
check "idempotent re-registration" "$(reg $SA null in_t1)" "already_registered"
r=$(q "select public.d24_register_invoice('$SB',null,'in_t1',false,'event_fee','bo-in_t1')" 2>&1 | tr -d '\n' | cut -c1-90)
check "a different studio cannot take over a registered invoice" "$(echo "$r" | grep -c d24_registration_conflict)" "1"
check "attribution is permanent (cannot be changed)" "$(as postgres "select set_config('d24.writer','on',false); update public.hosted_invoices set studio_id='$SB' where stripe_invoice_id='in_t1'" 2>&1 | grep -c 'attribution is permanent')" "1"

# 6. registered-first, then events; metadata is not authoritative ----------------------------------------------------------
check "register before any event" "$(reg $SA "'acct_conn1'" in_t2)" "registered"
claim evt_b >/dev/null
OBJ2="{\"invoice_id\":\"in_t2\",\"status\":\"uncollectible\",\"total\":5000,\"amount_due\":5000,\"amount_paid\":0,\"amount_remaining\":5000,\"currency\":\"usd\",\"metadata_ref\":\"$O2\",\"metadata_studio\":\"$SB\"}"
ap evt_b invoice invoice.marked_uncollectible 2000 acct_conn1 "$OBJ2" >/dev/null
check "matched under the right account scope" "$(rowof acct_conn1 in_t2 "studio_id = '$SA'")" "t"
check "forged metadata flags a mismatch but never re-attributes" "$(rowof acct_conn1 in_t2 "studio_id = '$SA' and anomaly_codes @> array['metadata_mismatch']")" "t"
check "uncollectible stays distinct from void" "$(rowof acct_conn1 in_t2 status)" "uncollectible"
claim evt_c >/dev/null
OBJ3=$(inv in_t2 void 5000 0 5000 5000)
ap evt_c invoice invoice.voided 2100 acct_conn1 "$OBJ3" >/dev/null
check "later void outranks uncollectible" "$(rowof acct_conn1 in_t2 status)" "void"
claim evt_d >/dev/null
ap evt_d invoice invoice.marked_uncollectible 2050 acct_conn1 "$OBJ2" >/dev/null
check "a late uncollectible never reopens a void (out of order)" "$(rowof acct_conn1 in_t2 status)" "void"
check "both transitions kept as history" "$(q "select count(*) from public.hosted_invoice_status_transitions t join public.hosted_invoices i on i.id=t.invoice_row_id where i.stripe_invoice_id='in_t2'")" "3"
check "seen statuses keep the whole history" "$(rowof acct_conn1 in_t2 "array_to_string(seen_statuses,',')")" "uncollectible,void"

# 7. cross-account / cross-tenant isolation --------------------------------------------------------------------------------
claim evt_e >/dev/null
ap evt_e invoice invoice.voided 2200 acct_other "$OBJ3" >/dev/null
check "same invoice id under another account scope is NOT attributed" "$(rowof acct_other in_t2 "studio_id is null")" "t"
check "...and is flagged account_scope_mismatch" "$(rowof acct_other in_t2 "anomaly_codes @> array['account_scope_mismatch']")" "t"
check "...while the registered row is untouched" "$(rowof acct_conn1 in_t2 "studio_id = '$SA'")" "t"
claim evt_f >/dev/null
ap evt_f invoice invoice.voided 2300 null "$OBJ3" >/dev/null
check "platform-scope event for a connect-registered invoice is unmatched" "$(rowof '' in_t2 "studio_id is null")" "t"

# 8. invoice_payment.paid: keyed by invoice-payment id, no side effects ----------------------------------------------------
PAY="{\"invoice_id\":\"in_t3\",\"object_id\":\"inpay_1\",\"status\":\"paid\",\"amount_requested\":4000,\"amount_paid\":4000,\"currency\":\"usd\"}"
claim evt_p1 >/dev/null; claim evt_p2 >/dev/null
ap evt_p1 invoice_payment invoice_payment.paid 3000 null "$PAY" >/dev/null
out=$(ap evt_p2 invoice_payment invoice_payment.paid 3001 null "$PAY")
check "duplicate payment event with a NEW event id adds no second payment" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "1"
check "payment amount counted once" "$(q "select amount_paid from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "4000"
check "both source events kept as evidence" "$(q "select count(*) from public.hosted_invoice_source_events where object_id='inpay_1'")" "2"
check "payment before its invoice makes an unobserved shell (status null)" "$(rowof '' in_t3 "status is null")" "t"
check "payment-first shell is unmatched" "$(rowof '' in_t3 reconciliation_state)" "unmatched"
PAYO="{\"invoice_id\":\"in_t3\",\"object_id\":\"inpay_1\",\"status\":\"open\",\"amount_requested\":4000,\"amount_paid\":0,\"currency\":\"usd\"}"
claim evt_p3 >/dev/null
ap evt_p3 invoice_payment invoice_payment.paid 2990 null "$PAYO" >/dev/null
check "a late 'open' never downgrades a paid payment" "$(q "select status from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "paid"
PAYC="{\"invoice_id\":\"in_t3\",\"object_id\":\"inpay_1\",\"status\":\"paid\",\"amount_requested\":9999,\"amount_paid\":9999,\"currency\":\"usd\"}"
claim evt_p4 >/dev/null
ap evt_p4 invoice_payment invoice_payment.paid 3002 null "$PAYC" >/dev/null
check "conflicting amounts for one payment id flag a conflict and change nothing" "$(q "select amount_paid||'/'||conflict from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "4000/true"
check "conflict is surfaced on the invoice" "$(rowof '' in_t3 "anomaly_codes @> array['invoice_payment_conflict']")" "t"
check "no settlement tables or ledger rows were touched (only hosted_* tables exist for D24)" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name not like 'hosted\\_%' and table_name not in ('studios','payment_provider_events')")" "0"
PAYB="{\"invoice_id\":\"in_t3\",\"object_id\":\"inpay_2\",\"status\":\"paid\",\"amount_requested\":4000,\"amount_paid\":4000,\"currency\":\"usd\"}"
claim evt_p5 >/dev/null
ap evt_p5 invoice_payment invoice_payment.paid 3003 acct_conn1 "$PAYB" >/dev/null
check "same invoice-payment id under another account scope is a separate fact" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id in ('inpay_1','inpay_2')")" "2"

# 9. void after payment never erases it ------------------------------------------------------------------------------------
claim evt_v3 >/dev/null
ap evt_v3 invoice invoice.voided 3100 null "$(inv in_t3 void 4000 4000 0 0)" >/dev/null
check "void on an invoice with a paid payment keeps the payment" "$(q "select status from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "paid"
check "...and flags void_invoice_has_payments" "$(rowof '' in_t3 "anomaly_codes @> array['void_invoice_has_payments']")" "t"
check "no refund or credit tables were created" "$(q "select count(*) from public.hosted_credit_notes")" "0"

# 10. credit notes: facts only ---------------------------------------------------------------------------------------------
CN="{\"invoice_id\":\"in_t3\",\"object_id\":\"cn_1\",\"status\":\"issued\",\"credit_note_type\":\"post_payment\",\"amount\":1500,\"currency\":\"usd\"}"
CNV="{\"invoice_id\":\"in_t3\",\"object_id\":\"cn_1\",\"status\":\"void\",\"credit_note_type\":\"post_payment\",\"amount\":1500,\"currency\":\"usd\"}"
claim evt_n1 >/dev/null; claim evt_n2 >/dev/null; claim evt_n3 >/dev/null
ap evt_n2 credit_note credit_note.voided 3300 null "$CNV" >/dev/null
ap evt_n1 credit_note credit_note.created 3200 null "$CN" >/dev/null
check "credit note: late 'issued' never reopens a voided note" "$(q "select status from public.hosted_credit_notes where stripe_credit_note_id='cn_1'")" "void"
ap evt_n3 credit_note credit_note.created 3200 null "$CN" >/dev/null
check "credit note stays one row across 3 events" "$(q "select count(*) from public.hosted_credit_notes")" "1"
check "credit note linked to its invoice row" "$(q "select count(*) from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id where i.stripe_invoice_id='in_t3'")" "1"
check "payment amount unchanged by the credit note" "$(q "select amount_paid from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_1'")" "4000"

# 11. input validation -----------------------------------------------------------------------------------------------------
claim evt_bad >/dev/null
r=$(ap evt_bad invoice invoice_payment.paid 1 null "$OBJ" 2>&1 | tr -d '\n' | cut -c1-80)
check "event type / kind mismatch is refused" "$(echo "$r" | grep -c 'does not match kind')" "1"
r=$(ap evt_bad invoice invoice.voided 1 "bad_acct" "$OBJ" 2>&1 | tr -d '\n' | cut -c1-80)
check "malformed account id is refused" "$(echo "$r" | grep -c 'malformed account')" "1"
r=$(ap evt_bad invoice invoice.voided 1 null "{\"invoice_id\":\"in_t9\",\"status\":\"paid\",\"total\":1,\"amount_due\":0,\"amount_paid\":1,\"amount_remaining\":0,\"currency\":\"usd\"}" 2>&1 | tr -d '\n' | cut -c1-80)
check "invoice event with a non-void/uncollectible status is refused" "$(echo "$r" | grep -c 'unsupported status')" "1"
check "refused calls left no row for in_t9" "$(q "select count(*) from public.hosted_invoices where stripe_invoice_id='in_t9'")" "0"

# 12. evidence is immutable ------------------------------------------------------------------------------------------------
check "source events cannot be updated" "$(as postgres "update public.hosted_invoice_source_events set livemode=true" 2>&1 | grep -c 'append-only')" "1"
check "source events cannot be deleted" "$(as postgres "delete from public.hosted_invoice_source_events" 2>&1 | grep -c 'append-only')" "1"
check "audit log cannot be updated" "$(as postgres "update public.hosted_invoice_recon_audit set reason='x'" 2>&1 | grep -c 'append-only')" "1"
check "registry rows cannot be deleted" "$(as postgres "delete from public.hosted_invoice_registry" 2>&1 | grep -c 'append-only')" "1"
check "transitions cannot be truncated" "$(as postgres "truncate public.hosted_invoice_status_transitions" 2>&1 | grep -c 'append-only')" "1"
check "facts cannot be deleted even with the writer flag" "$(as postgres "select set_config('d24.writer','on',false); delete from public.hosted_invoices" 2>&1 | grep -c 'permanent evidence')" "1"
check "facts cannot be truncated" "$(as postgres "truncate public.hosted_invoices cascade" 2>&1 | grep -c 'append-only')" "1"

# 13. acknowledgement is the only manual transition ------------------------------------------------------------------------
ROW=$(rowof '' in_t1 id)
r=$(q "select public.d24_acknowledge_anomalies('$ROW','{unverified_void_origin}','$O1','   ')" 2>&1 | tr -d '\n' | cut -c1-160)
check "acknowledgement without a reason is refused" "$(echo "$r" | grep -c 'a reason are required')" "1"
r=$(q "select public.d24_acknowledge_anomalies('$ROW','{not_a_code}','$O1','reviewed')" 2>&1 | tr -d '\n' | cut -c1-80)
check "acknowledging a code that is not present is refused" "$(echo "$r" | grep -c d24_unknown_anomaly_code)" "1"
q "select public.d24_acknowledge_anomalies('$ROW','{replay_payload_mismatch,unverified_void_origin}','$O1','reviewed by operator')" >/dev/null
check "acknowledgement moves anomalous -> resolved" "$(rowof '' in_t1 reconciliation_state)" "resolved"
check "the anomaly code is still there (history is not erased)" "$(rowof '' in_t1 "anomaly_codes @> array['unverified_void_origin']")" "t"
check "acknowledgement is audited with actor and reason" "$(q "select actor_user_id::text||'/'||reason from public.hosted_invoice_recon_audit where trigger_kind='acknowledgement'")" "$O1/reviewed by operator"
UROW=$(rowof acct_other in_t2 id)
r=$(q "select public.d24_acknowledge_anomalies('$UROW','{unverified_void_origin}','$O1','reviewed')" 2>&1 | tr -d '\n' | cut -c1-100)
check "an unmatched invoice can never be acknowledged into a studio" "$(echo "$r" | grep -c d24_unmatched_invoice_cannot_be_acknowledged)" "1"
claim evt_r1 >/dev/null
ap evt_r1 invoice invoice.marked_uncollectible 3400 null "$(inv in_t1 uncollectible 10000 0 10000 10000)" >/dev/null
check "a NEW anomaly code re-opens a resolved invoice? (uncollectible origin is new)" "$(rowof '' in_t1 reconciliation_state)" "anomalous"

# 14. concurrency (real sessions) -------------------------------------------------------------------------------------------
reg $SA null in_race >/dev/null
for i in 1 2 3 4 5 6 7 8; do claim "evt_race$i" "$O1" >/dev/null; done
RP="{\"invoice_id\":\"in_race\",\"object_id\":\"inpay_race\",\"status\":\"paid\",\"amount_requested\":700,\"amount_paid\":700,\"currency\":\"usd\"}"
for i in 1 2 3 4 5 6 7 8; do
  ( ap "evt_race$i" invoice_payment invoice_payment.paid "$((5000 + i))" null "$RP" >"$TMPD/race_$i.txt" 2>&1 ) &
done
wait
check "8 simultaneous distinct events for one payment id: exactly one payment row" "$(q "select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_race'")" "1"
check "...recorded once, amount 700" "$(q "select amount_paid from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_race'")" "700"
check "...all 8 left evidence" "$(q "select count(*) from public.hosted_invoice_source_events where object_id='inpay_race'")" "8"
check "...no failures or deadlocks" "$(cat "$TMPD"/race_*.txt | grep -ci 'error\|deadlock')" "0"
# same event id delivered concurrently: the claim serializes (second caller must own the claim to proceed)
claim evt_dup "$O1" >/dev/null
DP="{\"invoice_id\":\"in_dup\",\"object_id\":\"inpay_dup\",\"status\":\"paid\",\"amount_requested\":50,\"amount_paid\":50,\"currency\":\"usd\"}"
for i in 1 2 3 4; do ( ap evt_dup invoice_payment invoice_payment.paid 6000 null "$DP" >"$TMPD/dup_$i.txt" 2>&1 ) & done
wait
check "4 concurrent applies of one event id: one payment, one evidence row" "$(q "select (select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_dup')||'/'||(select count(*) from public.hosted_invoice_source_events where provider_event_id='evt_dup')")" "1/1"
# registration racing events: whichever order, the invoice ends up attributed exactly once
for i in 1 2 3 4 5 6; do claim "evt_rr$i" "$O1" >/dev/null; done
RRO=$(inv in_rr void 100 0 100 100)
( reg $SA null in_rr >"$TMPD/rr_reg.txt" 2>&1 ) &
for i in 1 2 3 4 5 6; do ( ap "evt_rr$i" invoice invoice.voided "$((7000 + i))" null "$RRO" >"$TMPD/rr_$i.txt" 2>&1 ) & done
wait
check "registration racing 6 events: attributed to the studio" "$(rowof '' in_rr "studio_id = '$SA'")" "t"
check "registration racing 6 events: one invoice row" "$(q "select count(*) from public.hosted_invoices where stripe_invoice_id='in_rr'")" "1"
check "registration racing 6 events: no unmatched state left behind" "$(rowof '' in_rr reconciliation_state)" "anomalous"
check "registration racing 6 events: no errors" "$(cat "$TMPD"/rr_*.txt | grep -ci 'error\|deadlock')" "0"

# 14b. review fixes -------------------------------------------------------------------------------------------------------
pj() { echo "{\"invoice_id\":\"$1\",\"object_id\":\"$2\",\"status\":\"paid\",\"amount_requested\":$3,\"amount_paid\":$3,\"currency\":\"usd\"}"; }
# P1-1: registered invoice whose FIRST event is a payment (or credit note): the child must carry the studio
reg $SA null in_first >/dev/null
claim evt_first >/dev/null
ap evt_first invoice_payment invoice_payment.paid 8000 null "$(pj in_first inpay_first 900)" >/dev/null
check "payment as first event of a registered invoice is attributed to the studio" "$(q "select coalesce(studio_id::text,'NULL') from public.hosted_invoice_payments where stripe_invoice_payment_id='inpay_first'")" "$SA"
reg $SA null in_firstcn >/dev/null
claim evt_firstcn >/dev/null
ap evt_firstcn credit_note credit_note.created 8001 null "{\"invoice_id\":\"in_firstcn\",\"object_id\":\"cn_first\",\"status\":\"issued\",\"credit_note_type\":null,\"amount\":10,\"currency\":\"usd\"}" >/dev/null
check "credit note as first event of a registered invoice is attributed to the studio" "$(q "select coalesce(studio_id::text,'NULL') from public.hosted_credit_notes where stripe_credit_note_id='cn_first'")" "$SA"
check "no attributed child row disagrees with its invoice" "$(q "select count(*) from (select p.studio_id ps, i.studio_id is_ from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id union all select c.studio_id, i.studio_id from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id) x where ps is distinct from is_ and ps is not null")" "0"
# P2-1: the anomaly set does not depend on arrival order
mk() {
  local i=$1
  reg $SA null $i >/dev/null
  claim evt_${i}_v >/dev/null; claim evt_${i}_p >/dev/null
  local pay; pay=$(pj $i inpay_${i//_/} 900)
  local voi; voi=$(inv $i void 100 0 100 100)
  if [ "$2" = PV ]; then ap evt_${i}_p invoice_payment invoice_payment.paid 9000 null "$pay" >/dev/null; ap evt_${i}_v invoice invoice.voided 9001 null "$voi" >/dev/null
  else ap evt_${i}_v invoice invoice.voided 9001 null "$voi" >/dev/null; ap evt_${i}_p invoice_payment invoice_payment.paid 9000 null "$pay" >/dev/null; fi
  rowof '' $i "array_to_string(anomaly_codes,',')"
}
check "payment-then-void and void-then-payment end with identical anomaly codes" "$(mk in_ord1 PV)" "$(mk in_ord2 VP)"
check "...including payments_exceed_invoice_total" "$(rowof '' in_ord1 "anomaly_codes @> array['payments_exceed_invoice_total']")" "t"
# P2-2: an acknowledged code is re-opened by a new occurrence
claim evt_ack1 >/dev/null; claim evt_ack2 >/dev/null; claim evt_ack3 >/dev/null
reg $SA null in_ack >/dev/null
ap evt_ack1 invoice_payment invoice_payment.paid 9100 null "$(pj in_ack inpay_ack1 10)" >/dev/null
ap evt_ack2 invoice_payment invoice_payment.paid 9101 null "$(pj in_ack inpay_ack1 99)" >/dev/null
AROW=$(rowof '' in_ack id)
check "conflict makes the invoice anomalous" "$(rowof '' in_ack reconciliation_state)" "anomalous"
q "select public.d24_acknowledge_anomalies('$AROW','{invoice_payment_conflict}','$O1','reviewed')" >/dev/null
check "acknowledged -> resolved" "$(rowof '' in_ack reconciliation_state)" "resolved"
ap evt_ack3 invoice_payment invoice_payment.paid 9102 null "$(pj in_ack inpay_ack1 77)" >/dev/null
check "a new conflict occurrence re-opens the acknowledged invoice" "$(rowof '' in_ack reconciliation_state)" "anomalous"
# account-scope mismatch is flagged regardless of order
claim evt_sc1 >/dev/null
ap evt_sc1 invoice invoice.voided 9200 acct_early "$(inv in_scope void 1 0 1 1)" >/dev/null
reg $SA "'acct_real'" in_scope >/dev/null
check "event under another scope BEFORE registration is flagged at registration" "$(rowof acct_early in_scope "anomaly_codes @> array['account_scope_mismatch']")" "t"
check "...and stays unattributed" "$(rowof acct_early in_scope "studio_id is null")" "t"
# negative invoice total is storable
claim evt_neg >/dev/null
ap evt_neg invoice invoice.voided 9300 null "$(inv in_neg void -250 0 0 0)" >/dev/null
check "a negative invoice total is recorded" "$(rowof '' in_neg total)" "-250"

# 15. rollback -------------------------------------------------------------------------------------------------------------
r=$(docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q < "$M_RB" 2>&1 | tr -d '\n' | cut -c1-120)
check "rollback is refused while evidence rows exist" "$(echo "$r" | grep -c 'rollback refused')" "1"
check "refused rollback left the schema intact" "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted\\_%'")" "7"

# fresh database: migration -> rollback -> migration again
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
$F < "$M_D24" >/dev/null 2>&1
check "fresh DB: migration applies" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted\\_%'")" "7"
$F < "$M_RB" >/dev/null 2>&1
check "fresh DB: rollback of an empty install removes every D24 object" "$($F -c "select (select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted\\_%')||'/'||(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%d24%')")" "0/0"
$F < "$M_D24" >/dev/null 2>&1
check "fresh DB: migration re-applies after rollback" "$($F -c "select count(*) from information_schema.tables where table_schema='public' and table_name like 'hosted\\_%'")" "7"

echo "SQL RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
