-- CI-B desk balance -- regression suite for 20270211090000_competition_checkin_balance_refund.sql
-- (requires the PROD-like chain: PAY-WH-1A, R2 20270103090000 + gate, D7 desk gate 20270205100000).
--
-- Rule under test: balance = max(0, order total - captured), captured = sum(amount) over payments in ('paid',
-- 'refunded'); refunds never create a debt. Synthetic fixtures (UUID block 00000000-0000-0000-0000-00cb1a0XXXXX), plus
-- scenarios driven through the real R2 recompute (_r2_recompute_order) from event_order_refunds ledger rows.
-- Run as the superuser role on a disposable database. The final block ALWAYS raises, so nothing persists:
-- "CIB BALANCE SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".
-- Failing-first: against the D7 body (before the migration) the balance checks FAIL; after it they PASS.

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlstate || ' ' || sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into t_kv values (p_k, p_v::text) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.as_user(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true) $$;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00cb1a000001', 'cib-front@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00cb1a000001', 'cib-front@e2e.test', 'CIB Front')
on conflict (id) do nothing;
insert into public.studios (id, name, slug, stripe_connected_account_id) values
  ('00000000-0000-0000-0000-00cb1a000101', 'CIB Studio', 'cib-studio', 'acct_cibstudio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00cb1a000001', '00000000-0000-0000-0000-00cb1a000101', 'front_desk', true);
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000101', 'CIB Competition', 'cib-comp', 'competition', 'published', 'public', '2027-06-06', '2027-06-06', 'America/Chicago');

-- A competition order + registration + desk session. p_order_pay is the order's payment_status, p_reg_pay the registration's.
create or replace function pg_temp.comp(p_key text, p_idx int, p_total numeric, p_order_pay text, p_order_status text default 'confirmed')
returns void language plpgsql as $$
declare o uuid := gen_random_uuid(); r uuid := gen_random_uuid();
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status,
    payment_status, expires_at, metadata)
  values (o, '00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000101', 'Pat', 'cib-' || p_key || '@example.com', p_total, p_total, 'USD',
    p_order_status, p_order_pay, now() + interval '30 days', jsonb_build_object('source', 'competition_registration'));
  insert into public.event_registrations (id, order_id, event_id, studio_id, status, payment_status, quantity, unit_price,
    total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
  values (r, o, '00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000101', 'confirmed', 'paid', 1, p_total, p_total, 'USD',
    'public_event_page', 'Pat', p_key, 'cib-' || p_key || '@example.com');
  insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
  values (('00000000-0000-0000-0000-00cb1a0005' || lpad(p_idx::text, 2, '0'))::uuid, '00000000-0000-0000-0000-00cb1a000201', r, o, 'in_progress', 0, 'USD');
  insert into t_kv values ('order:' || p_key, o::text), ('reg:' || p_key, r::text), ('sess:' || p_key, ('00000000-0000-0000-0000-00cb1a0005' || lpad(p_idx::text, 2, '0')));
end $$;

create or replace function pg_temp.pay(p_key text, p_amount numeric, p_refund numeric, p_status text) returns void language plpgsql as $$
begin
  insert into public.event_payments (registration_id, amount, refund_amount, currency, payment_method, status, source)
  values (pg_temp.kv('reg:' || p_key)::uuid, p_amount, p_refund, 'USD', 'card', p_status, 'cib_fixture');
end $$;

create or replace function pg_temp.desk(p_key text, p_amount numeric) returns text language sql as $$
  select public.record_competition_checkin_payment('00000000-0000-0000-0000-00cb1a000201', pg_temp.kv('sess:' || p_key)::uuid, p_amount, 'cash', null)::text $$;

-- Like desk(), but a refusal is captured as {"error": ...} so a failing body does not abort the whole suite.
create or replace function pg_temp.try_desk(p_key text, p_amount numeric) returns jsonb language plpgsql as $$
begin
  return public.record_competition_checkin_payment('00000000-0000-0000-0000-00cb1a000201', pg_temp.kv('sess:' || p_key)::uuid, p_amount, 'cash', null);
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end $$;

-- 1: partial refund of 1 of 3 entries (total 300, captured 300, refunded 100): nothing due, any desk payment refused.
select pg_temp.comp('p1', 1, 300, 'partially_refunded');
select pg_temp.pay('p1', 300, 100, 'paid');
-- 2: full refund: the order is refunded and not payable; the payment row is 'refunded'.
select pg_temp.comp('f1', 2, 300, 'refunded');
select pg_temp.pay('f1', 300, 300, 'refunded');
-- 3: genuine desk balance with a refund (total 300, captured 200, refunded 50): 100 stays due.
select pg_temp.comp('g1', 3, 300, 'pending', 'pending');
select pg_temp.pay('g1', 200, 50, 'paid');
-- 4: genuine desk balance, no refund (baseline).
select pg_temp.comp('b1', 4, 300, 'pending');
select pg_temp.pay('b1', 200, 0, 'paid');
-- 5: a pending (uncaptured) payment row and a failed one never count as captured; refund_amount is zero (no succeeded refund).
select pg_temp.comp('n1', 5, 300, 'pending');
select pg_temp.pay('n1', 300, 0, 'pending');
select pg_temp.pay('n1', 300, 0, 'failed');
-- 6: partial refund bigger than the unpaid remainder (total 300, captured 100, refunded 100): still 200 due.
select pg_temp.comp('g2', 6, 300, 'pending', 'pending');
select pg_temp.pay('g2', 100, 100, 'paid');

-- 7: REAL R2 partial refund: Stripe payment of the full 300, ledger row (succeeded, 100.00) + R2 recompute. refund_amount = 100,
--    order partially_refunded, payment still 'paid'. Nothing is due; the 100 must not be collectible at the desk.
create or replace function pg_temp.stripe_pay(p_key text, p_amount numeric) returns void language plpgsql as $$
begin
  insert into public.event_payments (registration_id, amount, refund_amount, currency, payment_method, status, source, stripe_payment_intent_id)
  values (pg_temp.kv('reg:' || p_key)::uuid, p_amount, 0, 'USD', 'card', 'paid', 'cib_fixture', 'pi_cib_' || p_key);
  update public.event_orders set stripe_payment_intent_id = 'pi_cib_' || p_key where id = pg_temp.kv('order:' || p_key)::uuid;
end $$;
create or replace function pg_temp.ledger(p_key text, p_cents bigint) returns text language plpgsql as $$
begin
  insert into public.event_order_refunds (event_id, order_id, registration_id, stripe_refund_id, stripe_account_id, stripe_payment_intent_id,
    amount_cents, currency, status, source, succeeded_at)
  values ('00000000-0000-0000-0000-00cb1a000201', pg_temp.kv('order:' || p_key)::uuid, pg_temp.kv('reg:' || p_key)::uuid,
    're_cib_' || p_key || '_' || p_cents, 'acct_cibstudio', 'pi_cib_' || p_key, p_cents, 'USD', 'succeeded', 'stripe_dashboard', now());
  return public._r2_recompute_order(pg_temp.kv('order:' || p_key)::uuid);
end $$;
select pg_temp.comp('r1', 7, 300, 'paid');
select pg_temp.stripe_pay('r1', 300);
select pg_temp.save('r1_state', to_jsonb(pg_temp.ledger('r1', 10000)));
-- 8: REAL R2 full refund (30000): order refunded, payment 'refunded', registration refunded.
select pg_temp.comp('r2', 8, 300, 'paid');
select pg_temp.stripe_pay('r2', 300);
select pg_temp.save('r2_state', to_jsonb(pg_temp.ledger('r2', 30000)));
-- 9: payment marked 'refunded' while the order row still says paid/confirmed (legacy or mid-update state): captured money, nothing due.
select pg_temp.comp('f2', 9, 300, 'paid');
select pg_temp.pay('f2', 300, 300, 'refunded');
-- 10: R2 partial refund (50 on a Stripe payment of 200 against a 300 order) plus a genuinely unpaid remainder of 100.
select pg_temp.comp('m1', 10, 300, 'pending', 'pending');
select pg_temp.stripe_pay('m1', 200);
select pg_temp.save('m1_state', to_jsonb(pg_temp.ledger('m1', 5000)));
-- 11: a user without any desk role
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00cb1a000002', 'cib-nobody@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-00cb1a000002', 'cib-nobody@e2e.test', 'CIB Nobody') on conflict (id) do nothing;
select pg_temp.comp('a1', 11, 300, 'pending', 'pending');

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00cb1a000001');

-- 1
select pg_temp.expect_msg('partial refund: a desk payment is refused because nothing is due (balance 0)',
  $q$select pg_temp.desk('p1', 1)$q$, 'exceeds the current balance (0');
-- 2
select pg_temp.expect_msg('full refund: the refunded order is still not payable', $q$select pg_temp.desk('f1', 1)$q$, 'not payable');
-- 3
select pg_temp.expect_msg('genuine balance + refund: the cap is the true balance 100, not 150',
  $q$select pg_temp.desk('g1', 100.01)$q$, 'exceeds the current balance (100');
select pg_temp.save('g1', pg_temp.try_desk('g1', 100));
-- 4
select pg_temp.expect_msg('no refund: the cap is still total - paid (100)', $q$select pg_temp.desk('b1', 100.01)$q$, 'exceeds the current balance (100');
select pg_temp.save('b1a', pg_temp.try_desk('b1', 40));
select pg_temp.save('b1b', pg_temp.try_desk('b1', 60));
-- 5
select pg_temp.save('n1', pg_temp.try_desk('n1', 10));
-- 6
select pg_temp.expect_msg('refund larger than the unpaid remainder: 200 stays due and is the cap',
  $q$select pg_temp.desk('g2', 200.01)$q$, 'exceeds the current balance (200');

-- 7: real R2 partial refund
select pg_temp.expect_msg('R2 partial refund: the refunded 100 is NOT collectible (cap is 0)', $q$select pg_temp.desk('r1', 100)$q$, 'exceeds the current balance (0');
select pg_temp.expect_msg('R2 partial refund: even one cent is refused', $q$select pg_temp.desk('r1', 0.01)$q$, 'exceeds the current balance (0');
-- 8: real R2 full refund
select pg_temp.expect_msg('R2 full refund: the refunded order is not payable', $q$select pg_temp.desk('r2', 300)$q$, 'not payable');
-- 9: refunded payment, order still paid
select pg_temp.expect_msg('refunded payment on a still-paid order: nothing collectible (cap 0)', $q$select pg_temp.desk('f2', 300)$q$, 'exceeds the current balance (0');
-- 10: R2 partial refund + true remainder 100
select pg_temp.expect_msg('R2 partial refund + unpaid remainder: cap is the true remainder 100, not 150', $q$select pg_temp.desk('m1', 150)$q$, 'exceeds the current balance (100');
select pg_temp.save('m1', pg_temp.try_desk('m1', 100));
-- idempotency / duplicate collection: after the remainder is paid, a second collection is refused
select pg_temp.expect_msg('duplicate collection of the same remainder is refused (cap 0)', $q$select pg_temp.desk('m1', 100)$q$, 'exceeds the current balance (0');
-- 11: authorization unchanged
select pg_temp.as_user('00000000-0000-0000-0000-00cb1a000002');
select pg_temp.expect_msg('no desk role: still refused (42501)', $q$select pg_temp.desk('a1', 10)$q$, 'not authorized');
select pg_temp.as_user('00000000-0000-0000-0000-00cb1a000001');

reset role;

select pg_temp.chk('genuine balance + refund: balance_before 100, paid off to 0', (pg_temp.kv('g1')::jsonb ->> 'balance_before')::numeric = 100
  and (pg_temp.kv('g1')::jsonb ->> 'balance_after')::numeric = 0, pg_temp.kv('g1'));
select pg_temp.chk('genuine balance + refund: the order is paid once the true remainder is collected',
  (select payment_status from public.event_orders where id = pg_temp.kv('order:g1')::uuid) = 'paid');
select pg_temp.chk('genuine balance + refund: session balance_due is 0', (select balance_due from public.event_competition_checkin_sessions where id = pg_temp.kv('sess:g1')::uuid) = 0);
select pg_temp.chk('no refund: 40 then 60 pays the order off (balance 60 then 0) and marks it paid',
  (pg_temp.kv('b1a')::jsonb ->> 'balance_after')::numeric = 60 and (pg_temp.kv('b1b')::jsonb ->> 'balance_after')::numeric = 0
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:b1')::uuid) = 'paid'
  and (select payment_status from public.event_registrations where id = pg_temp.kv('reg:b1')::uuid) = 'paid');
select pg_temp.chk('pending/failed payment rows are not captured: balance_before is the full 300',
  (pg_temp.kv('n1')::jsonb ->> 'balance_before')::numeric = 300 and (pg_temp.kv('n1')::jsonb ->> 'balance_after')::numeric = 290, pg_temp.kv('n1'));
select pg_temp.chk('refused attempts wrote no payment rows',
  (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:g2')::uuid) = 1
  and (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:p1')::uuid) = 1
  and (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:f1')::uuid) = 1);

select pg_temp.chk('R2 recompute states: partial -> partially_refunded, full -> refunded, refund_amount = ledger sum',
  pg_temp.kv('r1_state') = '"partially_refunded"' and pg_temp.kv('r2_state') = '"refunded"'
  and (select max(refund_amount) from public.event_payments where registration_id = pg_temp.kv('reg:r1')::uuid and stripe_payment_intent_id is not null) = 100
  and (select max(status) from public.event_payments where registration_id = pg_temp.kv('reg:r2')::uuid and stripe_payment_intent_id is not null) = 'refunded',
  pg_temp.kv('r1_state') || ' ' || pg_temp.kv('r2_state'));
select pg_temp.chk('R2 partial refund: no desk payment row written',
  (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:r1')::uuid) = 1);
select pg_temp.chk('R2 partial refund + remainder: balance_before 100, after 0; exactly one desk payment row',
  (pg_temp.kv('m1')::jsonb ->> 'balance_before')::numeric = 100 and (pg_temp.kv('m1')::jsonb ->> 'balance_after')::numeric = 0
  and (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:m1')::uuid and source = 'competition_checkin') = 1, pg_temp.kv('m1'));
select pg_temp.chk('no-role refusal wrote nothing', (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:a1')::uuid) = 0);
select pg_temp.chk('grants unchanged: authenticated yes, anon no; SECURITY DEFINER; search_path public, pg_temp',
  has_function_privilege('authenticated', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute')
  and (select prosecdef from pg_proc where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'))
  and (select proconfig::text from pg_proc where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)')) like '%search_path=public, pg_temp%');

-- Non-competition orders are unchanged: still refused.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, expires_at, metadata)
values ('00000000-0000-0000-0000-00cb1a000301', '00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000101', 'Pat', 'cib-plain@example.com', 50, 50, 'USD', 'pending', 'pending', now() + interval '1 day', '{"source":"event_cart_v1"}');
insert into public.event_registrations (id, order_id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values ('00000000-0000-0000-0000-00cb1a000302', '00000000-0000-0000-0000-00cb1a000301', '00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000101', 'pending', 'pending', 1, 50, 50, 'USD', 'public_event_page', 'Pat', 'plain', 'cib-plain@example.com');
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
values ('00000000-0000-0000-0000-00cb1a000599', '00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000302', '00000000-0000-0000-0000-00cb1a000301', 'in_progress', 50, 'USD');
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00cb1a000001');
select pg_temp.expect_msg('non-competition order: still refused',
  $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00cb1a000201', '00000000-0000-0000-0000-00cb1a000599', 10, 'cash', null)$q$, 'only to competition');
reset role;

select pg_temp.chk('function definition is the pinned CI-B body',
  (select md5(replace(pg_get_functiondef(oid), E'\r', '')) from pg_proc where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'))
    = 'f7ff073516597c474c59189df7b3e0d2');

do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'CIB BALANCE SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'CIB BALANCE SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
