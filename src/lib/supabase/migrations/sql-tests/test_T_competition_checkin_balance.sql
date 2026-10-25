-- CI-B desk balance -- regression suite for 20270111090000_competition_checkin_balance_refund.sql
-- (requires PAY-WH-1A 20261116090000..094000 and R2 20270103090000).
--
-- Rule under test: balance = max(0, order total - captured), captured = sum(amount) over payments in ('paid',
-- 'refunded'); refunds never create a debt. One transaction, synthetic fixtures (UUID block
-- 00000000-0000-0000-0000-00cb1a0XXXXX). The final block ALWAYS raises, so nothing persists:
-- "CIB BALANCE SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".

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

-- 1: partial refund of 1 of 3 entries (total 300, captured 300, refunded 100): nothing due, any desk payment refused.
select pg_temp.comp('p1', 1, 300, 'partially_refunded');
select pg_temp.pay('p1', 300, 100, 'paid');
-- 2: full refund: the order is refunded and not payable; the payment row is 'refunded'.
select pg_temp.comp('f1', 2, 300, 'refunded');
select pg_temp.pay('f1', 300, 300, 'refunded');
-- 3: genuine desk balance with a refund (total 300, captured 200, refunded 50): 100 stays due.
select pg_temp.comp('g1', 3, 300, 'partially_refunded');
select pg_temp.pay('g1', 200, 50, 'paid');
-- 4: genuine desk balance, no refund (baseline).
select pg_temp.comp('b1', 4, 300, 'pending');
select pg_temp.pay('b1', 200, 0, 'paid');
-- 5: a pending (uncaptured) payment row and a failed one never count as captured; refund_amount is zero (no succeeded refund).
select pg_temp.comp('n1', 5, 300, 'pending');
select pg_temp.pay('n1', 300, 0, 'pending');
select pg_temp.pay('n1', 300, 0, 'failed');
-- 6: partial refund bigger than the unpaid remainder (total 300, captured 100, refunded 100): still 200 due.
select pg_temp.comp('g2', 6, 300, 'partially_refunded');
select pg_temp.pay('g2', 100, 100, 'paid');

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
select pg_temp.save('g1', pg_temp.desk('g1', 100)::jsonb);
-- 4
select pg_temp.expect_msg('no refund: the cap is still total - paid (100)', $q$select pg_temp.desk('b1', 100.01)$q$, 'exceeds the current balance (100');
select pg_temp.save('b1a', pg_temp.desk('b1', 40)::jsonb);
select pg_temp.save('b1b', pg_temp.desk('b1', 60)::jsonb);
-- 5
select pg_temp.save('n1', pg_temp.desk('n1', 10)::jsonb);
-- 6
select pg_temp.expect_msg('refund larger than the unpaid remainder: 200 stays due and is the cap',
  $q$select pg_temp.desk('g2', 200.01)$q$, 'exceeds the current balance (200');

reset role;

select pg_temp.chk('genuine balance + refund: balance_before 100, paid off to 0', (pg_temp.kv('g1')::jsonb ->> 'balance_before')::numeric = 100
  and (pg_temp.kv('g1')::jsonb ->> 'balance_after')::numeric = 0, pg_temp.kv('g1'));
select pg_temp.chk('genuine balance + refund: the order stays partially_refunded and the registration partial (state not overwritten)',
  (select payment_status from public.event_orders where id = pg_temp.kv('order:g1')::uuid) = 'partially_refunded'
  and (select payment_status from public.event_registrations where id = pg_temp.kv('reg:g1')::uuid) = 'partial');
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

select pg_temp.chk('function body is the pinned CI-B or CB-2 body (LF or CRLF)',
  (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment')
    in ('2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7', 'a6de5932ce3894f944f0c4f2ef83be52', 'd852206591aebdc6f350fdb134ccecdb'));  -- 0111 body, or the CB-2 (0112) body

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
