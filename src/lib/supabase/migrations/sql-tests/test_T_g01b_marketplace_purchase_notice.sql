-- G-01b -- studio notification for a COMMITTED marketplace purchase (migration 20270220100000, stacked on 20270220090000).
-- (migration 20270220090000). One transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00a3f0XXXXXX); the
-- final block ALWAYS raises: "G-01b SQL SUITE PASS (<n> checks)" or "G-01 SQL SUITE FAIL: <failures>".

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

insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00a3f0000004', 'g01b-4@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a3f0000005', 'g01b-5@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
alter table public.payments disable trigger trg_reward_paid_payment; -- local baseline drift, rolled back with the suite
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-00a3f0000c02', '00000000-0000-0000-0000-00a3f0000102', 'Other', 'Tenant', 'g01b-other@example.com', 'active');

create or replace function pg_temp.notices(p_order uuid) returns integer language sql as $$
  select count(*)::integer from public.notifications where dedupe_key = 'marketplace_purchase:' || p_order::text $$;
create or replace function pg_temp.all_notices() returns integer language sql as $$
  select count(*)::integer from public.notifications where type = 'marketplace_purchase' $$;

select pg_temp.counts() as before \gset

select pg_temp.chk('type check accepts marketplace_purchase and still rejects unknown types',
  pg_temp.try($q$insert into public.notifications (studio_id, type, title) values ('00000000-0000-0000-0000-00a3f0000101', 'marketplace_purchase', 'x')$q$) = 'ok'
  and pg_temp.try($q$insert into public.notifications (studio_id, type, title) values ('00000000-0000-0000-0000-00a3f0000101', 'not_a_type', 'x')$q$) like '%notifications_type_check%'
  and pg_temp.try($q$insert into public.notifications (studio_id, type, title) values ('00000000-0000-0000-0000-00a3f0000101', 'event_registration', 'x')$q$) = 'ok'
  and pg_temp.try($q$insert into public.notifications (studio_id, type, title) values ('00000000-0000-0000-0000-00a3f0000101', 'payment_exception', 'x')$q$) = 'ok');
delete from public.notifications where title = 'x';

-- pending / failed / cancelled: nothing
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b01', '00000000-0000-0000-0000-00a3f0000001', null);
select pg_temp.chk('pending order (checkout created, unpaid): no notice', pg_temp.all_notices() = 0);
select pg_temp.chk('failed settlement (amount / currency mismatch) raises and emits no notice, no entitlement',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b01', 'pi_bad', 1, 'usd')$q$) like '%amount does not match%'
  and pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b01', 'pi_bad', 25, 'eur')$q$) like '%currency does not match%'
  and pg_temp.all_notices() = 0
  and not exists (select 1 from public.commerce_entitlements where order_id = '00000000-0000-0000-0000-00a3f0000b01'));
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b02', '00000000-0000-0000-0000-00a3f0000001', null, 'cancelled', 'failed');
select pg_temp.chk('cancelled / abandoned order: refused, no notice',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b02', 'pi_c', 25, 'usd')$q$) like '%not awaiting payment%'
  and pg_temp.all_notices() = 0);

-- success (guest)
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b01', 'pi_ok', 25, 'usd') as e1 \gset
select pg_temp.chk('success (guest): exactly one notice for the selling studio, entitlement committed, no client / link',
  pg_temp.notices('00000000-0000-0000-0000-00a3f0000b01') = 1
  and pg_temp.all_notices() = 1
  and (select studio_id = '00000000-0000-0000-0000-00a3f0000101' and client_id is null and category = 'payment' and read_at is null
       from public.notifications where dedupe_key = 'marketplace_purchase:00000000-0000-0000-0000-00a3f0000b01')
  and exists (select 1 from public.commerce_entitlements where id = :'e1')
  and pg_temp.counts() = :'before');
select pg_temp.chk('notice content is minimal: buyer name, item, amount, order number; no email or payment identifiers',
  (select body like 'Guest Buyer bought "G01 Video" for 25.00 USD (order COM-%' and body not like '%@%' and body not like '%pi_%' and title = 'New marketplace purchase'
   from public.notifications where dedupe_key = 'marketplace_purchase:00000000-0000-0000-0000-00a3f0000b01'));

-- replay / redelivery / duplicate
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b01', 'pi_ok', 25, 'usd') as e1b \gset
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b01', 'pi_ok', 25, 'usd') as e1c \gset
select pg_temp.chk('replay / webhook redelivery / confirm-route double call: same entitlement, still exactly one notice',
  :'e1b' = :'e1' and :'e1c' = :'e1' and pg_temp.notices('00000000-0000-0000-0000-00a3f0000b01') = 1 and pg_temp.all_notices() = 1);
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b03', '00000000-0000-0000-0000-00a3f0000001', null);
select pg_temp.chk('duplicate purchase of already-owned content: refused, no extra notice',
  pg_temp.try($q$select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b03', 'pi_dup', 25, 'usd')$q$) like '%already owns%'
  and pg_temp.all_notices() = 1);

-- existing client: name from the client record, client kept on the notice, still once
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b04', '00000000-0000-0000-0000-00a3f0000002', '00000000-0000-0000-0000-00a3f0000c01');
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b04', 'pi_cl', 25, 'usd') as e2 \gset
select pg_temp.chk('existing client: notice names the client, carries client_id, exactly one, nothing created',
  (select client_id = '00000000-0000-0000-0000-00a3f0000c01' and body like 'Existing Client bought%' and studio_id = '00000000-0000-0000-0000-00a3f0000101'
   from public.notifications where dedupe_key = 'marketplace_purchase:00000000-0000-0000-0000-00a3f0000b04')
  and pg_temp.notices('00000000-0000-0000-0000-00a3f0000b04') = 1 and pg_temp.counts() = :'before');

-- wrong tenant: another studio client id cannot name the buyer or leak into this notice
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b05', '00000000-0000-0000-0000-00a3f0000003', '00000000-0000-0000-0000-00a3f0000c02');
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b05', 'pi_xt', 25, 'usd') as e3 \gset
select pg_temp.chk('tenant isolation: the notice belongs only to the order studio; a client of another studio never names the buyer',
  (select count(*) from public.notifications where type = 'marketplace_purchase' and studio_id = '00000000-0000-0000-0000-00a3f0000102') = 0
  and (select body not like '%Tenant%' and studio_id = '00000000-0000-0000-0000-00a3f0000101' from public.notifications where dedupe_key = 'marketplace_purchase:00000000-0000-0000-0000-00a3f0000b05'));

-- a notification failure never takes a paid purchase down
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'notice sink down'; end $$;
create trigger t_boom before insert on public.notifications for each row when (new.type = 'marketplace_purchase') execute function pg_temp.boom();
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b06', '00000000-0000-0000-0000-00a3f0000004', null);
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b06', 'pi_boom', 25, 'usd') as e4 \gset
select pg_temp.chk('notice sink failure: settlement still commits (entitlement + order completed), no notice, warning only',
  exists (select 1 from public.commerce_entitlements where id = :'e4') and (select status = 'completed' from public.commerce_orders where id = '00000000-0000-0000-0000-00a3f0000b06')
  and pg_temp.notices('00000000-0000-0000-0000-00a3f0000b06') = 0);
drop trigger t_boom on public.notifications;

-- a pre-existing notice with the same dedupe key does not break or duplicate
select pg_temp.mk_order('00000000-0000-0000-0000-00a3f0000b07', '00000000-0000-0000-0000-00a3f0000005', null);
insert into public.notifications (studio_id, type, title, dedupe_key) values ('00000000-0000-0000-0000-00a3f0000101', 'marketplace_purchase', 'pre', 'marketplace_purchase:00000000-0000-0000-0000-00a3f0000b07');
select public.commerce_finalize_student_digital_order('00000000-0000-0000-0000-00a3f0000b07', 'pi_pre', 25, 'usd') as e5 \gset
select pg_temp.chk('pre-existing dedupe row: settlement succeeds and the order still has exactly one notice', :'e5' is not null and pg_temp.notices('00000000-0000-0000-0000-00a3f0000b07') = 1);

select pg_temp.chk('privileges unchanged: finalize is service_role only',
  has_function_privilege('service_role', 'public.commerce_finalize_student_digital_order(uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.commerce_finalize_student_digital_order(uuid,text,numeric,text)', 'execute')
  and not has_function_privilege('anon', 'public.commerce_finalize_student_digital_order(uuid,text,numeric,text)', 'execute'));

do $$
declare v_total integer; v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_total, v_failures from t_results;
  if v_failures is null then raise exception 'G-01b SQL SUITE PASS (% checks)', v_total; end if;
  raise exception 'G-01b SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
