-- G-01 -- marketplace settlement delivers the entitlement to the buyer's account without any studio client / link
-- (migration 20270220090000). One transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00a3f0XXXXXX); the
-- final block ALWAYS raises: "G-01 SQL SUITE PASS (<n> checks)" or "G-01 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00a3f0000001', 'g01-buyer@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a3f0000002', 'g01-buyer2@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a3f0000003', 'g01-buyer3@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00a3f0000101', 'G01 Studio', 'g01-sql-studio'),
  ('00000000-0000-0000-0000-00a3f0000102', 'G01 Other', 'g01-sql-other');
insert into public.commerce_catalog_items (id, studio_id, name, item_type, price, currency, active, published, marketplace_visible) values
  ('00000000-0000-0000-0000-00a3f0000201', '00000000-0000-0000-0000-00a3f0000101', 'G01 Video', 'digital_video', 25, 'usd', true, true, true);
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-00a3f0000c01', '00000000-0000-0000-0000-00a3f0000101', 'Existing', 'Client', 'g01-existing@example.com', 'active');

create or replace function pg_temp.mk_order(p_id uuid, p_user uuid, p_client uuid, p_status text default 'open', p_pay text default 'pending')
returns uuid language plpgsql as $$
begin
  insert into public.commerce_orders (id, studio_id, order_number, client_id, customer_type, guest_name, guest_email, status, payment_status,
                                      fulfillment_status, subtotal, total, currency, metadata)
  values (p_id, '00000000-0000-0000-0000-00a3f0000101', 'COM-' || upper(substr(replace(p_id::text, '-', ''), 21, 12)), p_client,
          case when p_client is null then 'guest' else 'client' end,
          case when p_client is null then 'Guest Buyer' end, case when p_client is null then 'g01-buyer@e2e.test' end,
          p_status, p_pay, 'unfulfilled', 25, 25, 'usd',
          jsonb_build_object('source', 'student_marketplace', 'student_user_id', p_user, 'buyer_email', 'g01-buyer@e2e.test',
                             'catalog_item_id', '00000000-0000-0000-0000-00a3f0000201'));
  insert into public.commerce_order_items (order_id, studio_id, catalog_item_id, item_type, name_snapshot, quantity, unit_price, line_total)
  values (p_id, '00000000-0000-0000-0000-00a3f0000101', '00000000-0000-0000-0000-00a3f0000201', 'digital_video', 'G01 Video', 1, 25, 25);
  return p_id;
end $$;

create or replace function pg_temp.counts() returns text language sql as $$
  select (select count(*) from public.clients)::text || '/' || (select count(*) from public.client_account_links)::text $$;

select pg_temp.counts() as before \gset

-- ---------------------------------------------------------------------------------------------------------------
-- Pending / failed / cancelled: no entitlement, no relationship
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000a01', '00000000-0000-0000-0000-00a3f0000001', null);
select pg_temp.chk('pending (checkout created, never paid): no entitlement, no payment, no client, no link',
  not exists (select 1 from public.commerce_entitlements where order_id = '00000000-0000-0000-0000-00a3f0000a01')
  and not exists (select 1 from public.payments where commerce_order_id = '00000000-0000-0000-0000-00a3f0000a01')
  and pg_temp.counts() = :'before');

select pg_temp.chk('failed: an amount mismatch is refused and leaves no entitlement or payment',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a01', 'pi_g01_bad', 1.00, 'usd')$q$) like '%amount does not match%'
  and not exists (select 1 from public.commerce_entitlements where order_id = '00000000-0000-0000-0000-00a3f0000a01')
  and not exists (select 1 from public.payments where commerce_order_id = '00000000-0000-0000-0000-00a3f0000a01'));
select pg_temp.chk('failed: a currency mismatch is refused',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a01', 'pi_g01_bad', 25, 'eur')$q$) like '%currency does not match%');

select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000a02', '00000000-0000-0000-0000-00a3f0000001', null, 'cancelled', 'failed');
select pg_temp.chk('abandoned/cancelled order: finalize is refused, no entitlement',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a02', 'pi_g01_x', 25, 'usd')$q$) like '%not awaiting payment%'
  and not exists (select 1 from public.commerce_entitlements where order_id = '00000000-0000-0000-0000-00a3f0000a02'));

-- ---------------------------------------------------------------------------------------------------------------
-- Successful guest settlement: entitlement to the buyer's account, no client, no link
-- ---------------------------------------------------------------------------------------------------------------
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a01', 'pi_g01_ok', 25, 'usd') as ent1 \gset
select pg_temp.chk('success (guest buyer): entitlement is owned by the buyer account with no client',
  (select user_id = '00000000-0000-0000-0000-00a3f0000001' and client_id is null and status = 'active' and entitlement_type = 'purchase'
     and studio_id = '00000000-0000-0000-0000-00a3f0000101' and catalog_item_id = '00000000-0000-0000-0000-00a3f0000201'
   from public.commerce_entitlements where id = :'ent1'));
select pg_temp.chk('success (guest buyer): order completed/paid, payment recorded for the studio, still no client and no link',
  (select status = 'completed' and payment_status = 'paid' and client_id is null and payment_id is not null from public.commerce_orders where id = '00000000-0000-0000-0000-00a3f0000a01')
  and (select client_id is null and status = 'paid' and amount = 25 and studio_id = '00000000-0000-0000-0000-00a3f0000101'
       from public.payments where commerce_order_id = '00000000-0000-0000-0000-00a3f0000a01')
  and pg_temp.counts() = :'before');

-- Replays / duplicates
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a01', 'pi_g01_ok', 25, 'usd') as ent1b \gset
select pg_temp.chk('replay: re-delivery returns the same entitlement; exactly one entitlement and one payment exist',
  :'ent1b' = :'ent1'
  and (select count(*) from public.commerce_entitlements where order_id = '00000000-0000-0000-0000-00a3f0000a01') = 1
  and (select count(*) from public.payments where commerce_order_id = '00000000-0000-0000-0000-00a3f0000a01') = 1
  and pg_temp.counts() = :'before');

select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000a03', '00000000-0000-0000-0000-00a3f0000001', null);
select pg_temp.chk('duplicate purchase of already-owned content: refused, no second entitlement',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a03', 'pi_g01_dup', 25, 'usd')$q$) like '%already owns%'
  and (select count(*) from public.commerce_entitlements where user_id = '00000000-0000-0000-0000-00a3f0000001' and catalog_item_id = '00000000-0000-0000-0000-00a3f0000201') = 1);

-- Existing client relationship preserved: the order's client flows to the entitlement exactly as before.
-- (The local baseline's rewards trigger fails for ANY client-attached payment -- unrelated to G-01; disabled inside this rolled-back transaction only.)
alter table public.payments disable trigger trg_reward_paid_payment;
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000a04', '00000000-0000-0000-0000-00a3f0000002', '00000000-0000-0000-0000-00a3f0000c01');
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000a04', 'pi_g01_client', 25, 'usd') as ent2 \gset
select pg_temp.chk('existing studio client: entitlement keeps that client and the buyer account; no client or link was created',
  (select client_id = '00000000-0000-0000-0000-00a3f0000c01' and user_id = '00000000-0000-0000-0000-00a3f0000002' from public.commerce_entitlements where id = :'ent2')
  and pg_temp.counts() = :'before');

-- Delivery to the buyer's Learn/Wallet: the student read policy is by user_id, independent of any client
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00a3f0000001","role":"authenticated"}', true);
select count(*) as visible from public.commerce_entitlements \gset
select count(*) as visible_other from public.commerce_entitlements where user_id <> '00000000-0000-0000-0000-00a3f0000001' \gset
reset role;
select pg_temp.chk('Learn/Wallet read: the guest buyer sees their own entitlement and nobody else (RLS by user_id)', :visible = 1 and :visible_other = 0, :'visible' || '/' || :'visible_other');

-- Tenant isolation: the other studio cannot see or own this entitlement
select pg_temp.chk('tenant: the entitlement is bound to the selling studio only',
  not exists (select 1 from public.commerce_entitlements where studio_id = '00000000-0000-0000-0000-00a3f0000102'));

-- Schema contract: owner account still required
select pg_temp.chk('an entitlement still requires an owner account (user_id NOT NULL) while client_id is nullable',
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'commerce_entitlements' and column_name = 'client_id') = 'YES'
  and (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'commerce_entitlements' and column_name = 'user_id') = 'NO');
select pg_temp.chk('manual-sale policies still require a real studio client (client_id null is rejected for a studio manager insert)',
  exists (select 1 from pg_policies where tablename = 'commerce_entitlements' and policyname = 'commerce entitlements managers insert' and with_check ilike '%clients%'));

do $$
declare v_total integer; v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_total, v_failures from t_results;
  if v_failures is null then raise exception 'G-01 SQL SUITE PASS (% checks)', v_total; end if;
  raise exception 'G-01 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
