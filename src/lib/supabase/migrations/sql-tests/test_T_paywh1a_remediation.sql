-- PAY-WH-1A -- remediation regression suite for 20261116094000 (requires 20261116090000..094000).
--
-- H-1 exception classification / alert queue / acknowledgement / audit / visibility, M-2 box-office capacity and
-- terminal fulfilment, M-1 competition desk payments, L-1 sweeper backoff, L-2 guard helpers.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-00a1fa0XXXXX). The final block ALWAYS
-- raises, so nothing persists: "PAY-WH-1A SQL SUITE PASS (<n> checks)" or "PAY-WH-1A SQL SUITE FAIL: <failures>".
-- Concurrency (separate sessions) is covered by sql-tests/paywh1a_concurrency.sh.

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

create or replace function pg_temp.try_jsonb(p_sql text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  execute p_sql into r;
  return r;
exception when others then
  return jsonb_build_object('outcome', 'error', 'error', sqlstate || ' ' || sqlerrm);
end $$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into t_kv values (p_k, p_v::text) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.out(p_k text) returns text language sql as $$ select (v::jsonb) ->> 'outcome' from t_kv where k = p_k $$;
create or replace function pg_temp.as_user(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00a1fa000001', 'paywh1a-owner@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a1fa000002', 'paywh1a-front@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a1fa000003', 'paywh1a-other@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a1fa000004', 'paywh1a-platform@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00a1fa000001', 'paywh1a-owner@e2e.test', 'A Owner'),
  ('00000000-0000-0000-0000-00a1fa000002', 'paywh1a-front@e2e.test', 'A Front'),
  ('00000000-0000-0000-0000-00a1fa000003', 'paywh1a-other@e2e.test', 'B Owner'),
  ('00000000-0000-0000-0000-00a1fa000004', 'paywh1a-platform@e2e.test', 'Platform')
on conflict (id) do nothing;
update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00a1fa000004';
insert into public.studios (id, name, slug, stripe_connected_account_id) values
  ('00000000-0000-0000-0000-00a1fa000101', 'PAYWH1A Studio', 'paywh1a-studio', 'acct_paywh1astudio'),
  ('00000000-0000-0000-0000-00a1fa000102', 'PAYWH1A Other', 'paywh1a-other', 'acct_paywh1aother');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00a1fa000001', '00000000-0000-0000-0000-00a1fa000101', 'studio_owner', true),
  ('00000000-0000-0000-0000-00a1fa000002', '00000000-0000-0000-0000-00a1fa000101', 'front_desk', true),
  ('00000000-0000-0000-0000-00a1fa000003', '00000000-0000-0000-0000-00a1fa000102', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00a1fa000201', '00000000-0000-0000-0000-00a1fa000101', 'PAYWH1A Event', 'paywh1a-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago'),
  ('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000101', 'PAYWH1A Competition', 'paywh1a-comp', 'competition', 'published', 'public', '2027-06-06', '2027-06-06', 'America/Chicago');
insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket) values
  ('00000000-0000-0000-0000-00a1fa000301', '00000000-0000-0000-0000-00a1fa000201', 'Cap1', 20, 'USD', 1, true, 1),
  ('00000000-0000-0000-0000-00a1fa000302', '00000000-0000-0000-0000-00a1fa000201', 'Cap2', 20, 'USD', 2, true, 1),
  ('00000000-0000-0000-0000-00a1fa000303', '00000000-0000-0000-0000-00a1fa000201', 'Open', 20, 'USD', null, true, 1);

-- An orderless box-office registration (optionally holding a terminal reservation).
create or replace function pg_temp.box(p_key text, p_ticket uuid, p_status text, p_payment text, p_hold interval default null)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price,
    total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email, terminal_hold_until)
  values (v, '00000000-0000-0000-0000-00a1fa000201', p_ticket, '00000000-0000-0000-0000-00a1fa000101', p_status, p_payment, 1, 20,
    20, 'USD', 'admin', 'Box', p_key, 'box-' || p_key || '@example.com', case when p_hold is null then null else now() + p_hold end);
  insert into t_kv values ('reg:' || p_key, v::text);
  return v;
end $$;

-- An ordinary order (pending, optionally lapsed) with one registration.
create or replace function pg_temp.order_with_reg(p_key text, p_event uuid, p_ticket uuid, p_total numeric, p_source text, p_expires interval)
returns uuid language plpgsql as $$
declare o uuid := gen_random_uuid(); r uuid := gen_random_uuid();
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status,
    payment_status, expires_at, metadata)
  values (o, p_event, '00000000-0000-0000-0000-00a1fa000101', 'Pat', 'paywh1a-' || p_key || '@example.com', p_total, p_total, 'USD',
    'pending', 'pending', now() + p_expires, jsonb_build_object('source', p_source));
  insert into public.event_registrations (id, order_id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price,
    total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
  values (r, o, p_event, p_ticket, '00000000-0000-0000-0000-00a1fa000101', 'pending', 'pending', 1, p_total, p_total, 'USD',
    'public_event_page', 'Pat', p_key, 'paywh1a-' || p_key || '@example.com');
  insert into t_kv values ('order:' || p_key, o::text), ('reg:' || p_key, r::text);
  return o;
end $$;

-- ===============================================================================================================
-- H-1  Exceptions: classification, alert queue, audit trail
-- ===============================================================================================================
select pg_temp.order_with_reg('x1', '00000000-0000-0000-0000-00a1fa000201', '00000000-0000-0000-0000-00a1fa000303', 20, 'event_cart_v1', interval '30 minutes');
select pg_temp.save('x1', jsonb_build_object('outcome', public._paywh1_record_exception(pg_temp.kv('order:x1')::uuid, 'late_payment_after_release', 'evt_x1', 'acct_paywh1astudio', 'cs_x1', 'pi_x1', 2000, 'usd', '{}'::jsonb)));
select pg_temp.chk('exception: captured money is classified and its staff alert is queued in the same transaction',
  (select money_state || '/' || alert_status || '/' || studio_id::text || '/' || event_id::text from public.event_order_settlement_exceptions where id = pg_temp.out('x1')::uuid)
  = 'captured/pending/00000000-0000-0000-0000-00a1fa000101/00000000-0000-0000-0000-00a1fa000201');
select public._paywh1_record_exception(pg_temp.kv('order:x1')::uuid, 'late_payment_after_release', 'evt_x1b', 'acct_paywh1astudio', 'cs_x1', 'pi_x1', 2000, 'usd', '{}'::jsonb);
select pg_temp.chk('exception: a replay is counted once more, never re-alerted, and audited',
  (select occurrences = 2 and alert_status = 'pending' and alert_attempts = 0 from public.event_order_settlement_exceptions where id = pg_temp.out('x1')::uuid)
  and (select string_agg(action, ',' order by created_at, action) from public.event_order_settlement_exception_events where exception_id = pg_temp.out('x1')::uuid) in ('recorded,recurred', 'recorded,recurred'));
select pg_temp.save('x2', jsonb_build_object('outcome', public._paywh1_record_exception(pg_temp.kv('order:x1')::uuid, 'processing_hold_lapsed', null, 'acct_paywh1astudio', 'cs_x1', 'pi_x1', 2000, 'usd', '{}'::jsonb)));
select pg_temp.chk('exception: a payment still processing is NOT a captured-money alert',
  (select money_state || '/' || alert_status from public.event_order_settlement_exceptions where id = pg_temp.out('x2')::uuid) = 'in_flight/not_required');
select pg_temp.save('x3', jsonb_build_object('outcome', public._paywh1_record_exception(null, 'unknown_payment_reference', null, 'acct_paywh1astudio', 'cs_unknown_a', 'pi_unknown_a', 500, 'usd', '{}'::jsonb)));
select pg_temp.chk('exception: an unknown payment is attributed to the studio owning the Stripe account',
  (select studio_id::text || '/' || money_state || '/' || alert_status from public.event_order_settlement_exceptions where id = pg_temp.out('x3')::uuid)
  = '00000000-0000-0000-0000-00a1fa000101/captured/pending');
select pg_temp.chk('classification: mismatches with captured money alert; failures after settlement are reversals',
  public._paywh1_exception_money_state('mismatch_amount') = 'captured' and public._paywh1_exception_money_state('mismatch_processing') = 'in_flight'
  and public._paywh1_exception_money_state('failure_after_settlement') = 'reversed' and public._paywh1_exception_money_state('mismatch_failure_account') = 'informational'
  and public._paywh1_exception_money_state('settlement_effect_dead') = 'operational');

-- Alert queue
select pg_temp.save('claim1', jsonb_build_object('outcome', (select string_agg(id::text, ',') from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c001', 100, 60))));
select pg_temp.chk('alerts: one worker leases every due alert (captured ones only)',
  position(pg_temp.out('x1') in pg_temp.out('claim1')) > 0 and position(pg_temp.out('x3') in pg_temp.out('claim1')) > 0
  and position(pg_temp.out('x2') in pg_temp.out('claim1')) = 0, pg_temp.out('claim1'));
select pg_temp.chk('alerts: a second worker gets nothing while they are leased',
  (select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c002', 100, 60)) = 0);
select pg_temp.chk('alerts: only the lease owner completes',
  not public.complete_settlement_exception_alert(pg_temp.out('x1')::uuid, '00000000-0000-0000-0000-00a1fa00c002', true));
select pg_temp.chk('alerts: the owner records delivery',
  public.complete_settlement_exception_alert(pg_temp.out('x1')::uuid, '00000000-0000-0000-0000-00a1fa00c001', true));
select pg_temp.chk('alerts: delivered once (sent, audited)',
  (select alert_status from public.event_order_settlement_exceptions where id = pg_temp.out('x1')::uuid) = 'sent'
  and exists (select 1 from public.event_order_settlement_exception_events where exception_id = pg_temp.out('x1')::uuid and action = 'alert_sent'));
select pg_temp.chk('alerts: a failed delivery backs off and stays visible',
  public.complete_settlement_exception_alert(pg_temp.out('x3')::uuid, '00000000-0000-0000-0000-00a1fa00c001', false, 'smtp down'));
select pg_temp.chk('alerts: failed delivery -> pending with future retry and the error recorded',
  (select alert_status = 'pending' and alert_next_at > now() and alert_last_error = 'smtp down' from public.event_order_settlement_exceptions where id = pg_temp.out('x3')::uuid));
update public.event_order_settlement_exceptions set alert_status = 'processing', alert_claim_owner = '00000000-0000-0000-0000-00a1fa00c009',
  alert_claim_expires_at = now() - interval '1 second', alert_attempts = 8 where id = pg_temp.out('x3')::uuid;
select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c003', 100, 60);
select pg_temp.chk('alerts: a worker that dies on every attempt ends in failed (visible, not retried forever)',
  (select alert_status from public.event_order_settlement_exceptions where id = pg_temp.out('x3')::uuid) = 'failed');

-- Dead outbox effect -> operational exception
insert into public.event_settlement_outbox (order_id, studio_id, effect, dedupe_key, status, attempts)
values (pg_temp.kv('order:x1')::uuid, '00000000-0000-0000-0000-00a1fa000101', 'order_confirmation', 'paywh1a:dead:x1', 'pending', 10);
update public.event_settlement_outbox set status = 'dead', claim_owner = null, claim_expires_at = null, last_error = 'boom' where dedupe_key = 'paywh1a:dead:x1';
select pg_temp.chk('outbox: a dead settlement effect raises an alerted operational exception',
  (select money_state || '/' || alert_status || '/' || (details ->> 'effect') from public.event_order_settlement_exceptions
   where order_id = pg_temp.kv('order:x1')::uuid and kind = 'settlement_effect_dead') = 'operational/pending/order_confirmation');
update public.event_order_settlement_exceptions set status = 'resolved', resolved_at = now(), alert_status = 'sent'
where order_id = pg_temp.kv('order:x1')::uuid and kind = 'settlement_effect_dead';
insert into public.event_settlement_outbox (order_id, studio_id, effect, dedupe_key, status, attempts)
values (pg_temp.kv('order:x1')::uuid, '00000000-0000-0000-0000-00a1fa000101', 'studio_lead', 'paywh1a:dead:x1b', 'pending', 10);
update public.event_settlement_outbox set status = 'dead', last_error = 'boom again' where dedupe_key = 'paywh1a:dead:x1b';
select pg_temp.chk('outbox: a NEW dead effect after the first was resolved reopens it and alerts again',
  (select status || '/' || alert_status || '/' || occurrences::text from public.event_order_settlement_exceptions
   where order_id = pg_temp.kv('order:x1')::uuid and kind = 'settlement_effect_dead') = 'open/pending/2');

-- L-1 sweeper backoff
select pg_temp.order_with_reg('s1', '00000000-0000-0000-0000-00a1fa000201', '00000000-0000-0000-0000-00a1fa000303', 20, 'event_cart_v1', interval '-1 minute');
select pg_temp.chk('sweeper: a lapsed order is due',
  exists (select 1 from public.list_event_cart_orders_due_for_reconcile(500) where order_id = pg_temp.kv('order:s1')::uuid));
select public.note_event_cart_reconcile_outcome(pg_temp.kv('order:s1')::uuid, false, 'stripe timeout');
select pg_temp.chk('sweeper: a failed reconcile backs off (not re-listed every run)',
  not exists (select 1 from public.list_event_cart_orders_due_for_reconcile(500) where order_id = pg_temp.kv('order:s1')::uuid));
select public.note_event_cart_reconcile_outcome(pg_temp.kv('order:s1')::uuid, false, 'stripe timeout') from generate_series(1, 5);
select pg_temp.chk('sweeper: repeated failure becomes an alerted reconcile_stuck exception (once)',
  (select count(*) from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:s1')::uuid and kind = 'reconcile_stuck' and alert_status = 'pending') = 1);
select public.note_event_cart_reconcile_outcome(pg_temp.kv('order:s1')::uuid, true);
select pg_temp.chk('sweeper: a successful run resets the backoff',
  (select reconcile_attempts = 0 and reconcile_next_at is null from public.event_orders where id = pg_temp.kv('order:s1')::uuid));

select pg_temp.chk('notifications: the payment_exception type is accepted and existing types still are',
  (select count(*) from (
     select 1 from (values (1)) v
     where pg_temp.try_jsonb($q$with i as (insert into public.notifications (studio_id, type, category, priority, title, dedupe_key) values ('00000000-0000-0000-0000-00a1fa000101', 'payment_exception', 'payment', 'urgent', 'x', 'paywh1a:n1') returning 1) select jsonb_build_object('outcome', 'ok') from i$q$) ->> 'outcome' = 'ok'
       and pg_temp.try_jsonb($q$with i as (insert into public.notifications (studio_id, type, category, priority, title) values ('00000000-0000-0000-0000-00a1fa000101', 'event_registration', 'event', 'normal', 'x') returning 1) select jsonb_build_object('outcome', 'ok') from i$q$) ->> 'outcome' = 'ok'
   ) t) = 1);
select pg_temp.expect_msg('notifications: unknown types are still rejected',
  $q$insert into public.notifications (studio_id, type, category, priority, title) values ('00000000-0000-0000-0000-00a1fa000101', 'not_a_type', 'payment', 'normal', 'x')$q$, 'notifications_type_check');

-- Visibility + acknowledgement / resolution (as client roles)
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000001');
select pg_temp.chk('visibility: the studio owner sees the event''s exceptions and the studio''s unattributed one',
  (select count(*) from public.event_order_settlement_exceptions where id in (pg_temp.out('x1')::uuid, pg_temp.out('x3')::uuid)) = 2);
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000003');
select pg_temp.chk('visibility: another studio sees none of them',
  (select count(*) from public.event_order_settlement_exceptions where studio_id = '00000000-0000-0000-0000-00a1fa000101') = 0);
select pg_temp.expect_msg('acknowledge: another studio cannot acknowledge',
  format($q$select public.acknowledge_event_order_settlement_exception(%L, 'x')$q$, pg_temp.out('x1')), '42501');
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000002');
select pg_temp.expect_msg('acknowledge: front desk (not an event manager) cannot acknowledge',
  format($q$select public.acknowledge_event_order_settlement_exception(%L, 'x')$q$, pg_temp.out('x1')), '42501');
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000001');
select pg_temp.chk('acknowledge: the event manager acknowledges with a note',
  public.acknowledge_event_order_settlement_exception(pg_temp.out('x1')::uuid, 'Calling the buyer'));
select pg_temp.chk('acknowledge: twice is a no-op',
  not public.acknowledge_event_order_settlement_exception(pg_temp.out('x1')::uuid, 'again'));
select pg_temp.expect_msg('resolve: a note is required',
  format($q$select public.resolve_event_order_settlement_exception(%L, '  ')$q$, pg_temp.out('x1')), '22023');
select pg_temp.chk('resolve: the event manager resolves an acknowledged exception',
  public.resolve_event_order_settlement_exception(pg_temp.out('x1')::uuid, 'Refunded in Stripe dashboard'));
select pg_temp.chk('resolve: an exception whose alert never went out stops alerting once resolved',
  public.resolve_event_order_settlement_exception(pg_temp.out('x3')::uuid, 'Not ours; reported to platform'));
reset role;
select pg_temp.chk('audit: acknowledgement and resolution are recorded with the actor',
  (select count(*) from public.event_order_settlement_exception_events where exception_id = pg_temp.out('x1')::uuid
     and action in ('acknowledged', 'resolved') and actor_user_id = '00000000-0000-0000-0000-00a1fa000001') = 2
  and (select status || '/' || resolved_by::text from public.event_order_settlement_exceptions where id = pg_temp.out('x1')::uuid)
      = 'resolved/00000000-0000-0000-0000-00a1fa000001'
  and (select alert_status from public.event_order_settlement_exceptions where id = pg_temp.out('x3')::uuid) = 'not_required');
select pg_temp.chk('alerts: resolved exceptions are never claimed again',
  (select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c004', 100, 60) c
   where c.id in (pg_temp.out('x1')::uuid, pg_temp.out('x3')::uuid)) = 0);

-- An exception resolved while its alert is being delivered, by a worker that then dies, is never re-alerted.
select pg_temp.save('x4', jsonb_build_object('outcome', public._paywh1_record_exception(pg_temp.kv('order:x1')::uuid, 'duplicate_payment', null, 'acct_paywh1astudio', 'cs_x4', 'pi_x4', 2000, 'usd', '{}'::jsonb)));
select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c006', 100, 60) c where c.id = pg_temp.out('x4')::uuid;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000001');
select public.resolve_event_order_settlement_exception(pg_temp.out('x4')::uuid, 'Second charge refunded');
reset role;
update public.event_order_settlement_exceptions set alert_claim_expires_at = now() - interval '1 second', alert_next_at = now() - interval '1 second'
where id = pg_temp.out('x4')::uuid;
select pg_temp.chk('alerts: an exception resolved mid-delivery is not re-alerted after the worker dies',
  (select count(*) from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c007', 100, 60) c where c.id = pg_temp.out('x4')::uuid) = 0);

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000004');
select pg_temp.chk('visibility: a platform admin sees every studio''s exceptions',
  (select count(*) from public.event_order_settlement_exceptions where studio_id = '00000000-0000-0000-0000-00a1fa000101') >= 4);
reset role;
set local role anon;
select pg_temp.expect_msg('privilege: anon cannot acknowledge', format($q$select public.acknowledge_event_order_settlement_exception(%L, 'x')$q$, pg_temp.out('x2')), 'permission denied');
select pg_temp.expect_msg('privilege: anon cannot claim alerts', $q$select * from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c005', 1, 60)$q$, 'permission denied');
reset role;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000001');
select pg_temp.expect_msg('privilege: staff cannot claim alerts or confirm terminal sales directly',
  $q$select * from public.claim_settlement_exception_alerts('00000000-0000-0000-0000-00a1fa00c005', 1, 60)$q$, 'permission denied');
select pg_temp.expect_msg('privilege: staff cannot call terminal confirmation',
  $q$select public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', gen_random_uuid(), gen_random_uuid(), 'pi_x', 100, 'usd', 'acct_paywh1astudio')$q$, 'permission denied');
reset role;

-- ===============================================================================================================
-- M-2  Box-office capacity and terminal fulfilment
-- ===============================================================================================================
select pg_temp.box('sold', '00000000-0000-0000-0000-00a1fa000301', 'confirmed', 'paid');
select pg_temp.expect_msg('capacity: an unpaid box-office sale of a sold-out ticket is refused again (pre-PAY-WH-1 behaviour)',
  $q$select pg_temp.box('late', '00000000-0000-0000-0000-00a1fa000301', 'pending', 'pending')$q$, 'no longer available');

select pg_temp.box('h1', '00000000-0000-0000-0000-00a1fa000302', 'pending', 'pending', interval '15 minutes');
select pg_temp.box('h2', '00000000-0000-0000-0000-00a1fa000302', 'pending', 'pending', interval '15 minutes');
select pg_temp.expect_msg('capacity: terminal holds reserve the tickets (a third card-reader sale is refused)',
  $q$select pg_temp.box('h3', '00000000-0000-0000-0000-00a1fa000302', 'pending', 'pending', interval '15 minutes')$q$, 'no longer available');
update public.event_registrations set terminal_hold_until = now() - interval '1 minute' where id = pg_temp.kv('reg:h1')::uuid;
select pg_temp.chk('capacity: an expired terminal hold frees its reservation',
  pg_temp.try_jsonb($q$select jsonb_build_object('outcome', pg_temp.box('h3', '00000000-0000-0000-0000-00a1fa000302', 'pending', 'pending', interval '15 minutes'))$q$) ->> 'outcome' <> 'error');
select pg_temp.save('hold1', public.hold_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', pg_temp.kv('reg:h1')::uuid, 15));
select pg_temp.chk('terminal: re-taking a lapsed hold on a sold-out ticket is refused BEFORE any charge',
  (pg_temp.kv('hold1')::jsonb ->> 'reason') = 'capacity_unavailable'
  and (select terminal_hold_until < now() from public.event_registrations where id = pg_temp.kv('reg:h1')::uuid), pg_temp.kv('hold1'));
select pg_temp.save('c2', public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a002', pg_temp.kv('reg:h2')::uuid, 'pi_term_h2', 2000, 'usd', 'acct_paywh1astudio'));
select pg_temp.chk('terminal: a held sale is confirmed after the charge', pg_temp.out('c2') = 'confirmed'
  and (select status || '/' || payment_status || '/' || coalesce(terminal_hold_until::text, 'none') from public.event_registrations where id = pg_temp.kv('reg:h2')::uuid) = 'confirmed/paid/none');
select pg_temp.chk('terminal: confirming the same charge again is idempotent',
  (public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a002', pg_temp.kv('reg:h2')::uuid, 'pi_term_h2', 2000, 'usd', 'acct_paywh1astudio') ->> 'outcome') = 'already_confirmed');
select pg_temp.save('c1', public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a001', pg_temp.kv('reg:h1')::uuid, 'pi_term_h1', 2000, 'usd', 'acct_paywh1astudio'));
select pg_temp.chk('terminal: a charge that can no longer be fulfilled is NOT treated as fulfilment',
  pg_temp.out('c1') = 'not_fulfilled' and (pg_temp.kv('c1')::jsonb ->> 'reason') = 'capacity_unavailable'
  and (select status || '/' || payment_status from public.event_registrations where id = pg_temp.kv('reg:h1')::uuid) = 'pending/pending', pg_temp.kv('c1'));
select pg_temp.chk('terminal: it becomes a durable, alerted captured-payment exception naming the sale',
  (select kind || '/' || money_state || '/' || alert_status || '/' || registration_id::text || '/' || payment_id::text || '/' || event_id::text
   from public.event_order_settlement_exceptions where id = (pg_temp.kv('c1')::jsonb ->> 'exception_id')::uuid)
  = 'terminal_paid_capacity_unavailable/captured/pending/' || pg_temp.kv('reg:h1') || '/00000000-0000-0000-0000-00a1fa00a001/00000000-0000-0000-0000-00a1fa000201');
update public.event_registrations set status = 'cancelled' where id = pg_temp.kv('reg:h2')::uuid;
select pg_temp.save('c1b', public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a001', pg_temp.kv('reg:h1')::uuid, 'pi_term_h1', 2000, 'usd', 'acct_paywh1astudio'));
select pg_temp.chk('terminal: a replay after a seat frees up never fulfils a charge already recorded as not fulfilled',
  pg_temp.out('c1b') = 'not_fulfilled' and (pg_temp.kv('c1b')::jsonb ->> 'reason') = 'exception_already_recorded'
  and (select status || '/' || payment_status from public.event_registrations where id = pg_temp.kv('reg:h1')::uuid) = 'pending/pending'
  and (select occurrences from public.event_order_settlement_exceptions where id = (pg_temp.kv('c1')::jsonb ->> 'exception_id')::uuid) = 2, pg_temp.kv('c1b'));
select pg_temp.order_with_reg('ob', '00000000-0000-0000-0000-00a1fa000201', '00000000-0000-0000-0000-00a1fa000303', 20, 'event_cart_v1', interval '30 minutes');
select pg_temp.save('c3', public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a003', pg_temp.kv('reg:ob')::uuid, 'pi_term_ob', 2000, 'usd', 'acct_paywh1astudio'));
select pg_temp.chk('terminal: an order-backed registration is never confirmed by a terminal charge (exception instead)',
  pg_temp.out('c3') = 'not_fulfilled'
  and (select payment_status from public.event_registrations where id = pg_temp.kv('reg:ob')::uuid) = 'pending'
  and exists (select 1 from public.event_order_settlement_exceptions where id = (pg_temp.kv('c3')::jsonb ->> 'exception_id')::uuid and kind = 'terminal_payment_unfulfilled'));
select pg_temp.chk('terminal: an order-backed registration cannot take a terminal hold',
  (public.hold_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', pg_temp.kv('reg:ob')::uuid, 15) ->> 'reason') = 'registration_not_payable');
select pg_temp.save('c4', public.confirm_terminal_event_registration('00000000-0000-0000-0000-00a1fa000101', '00000000-0000-0000-0000-00a1fa00a004', gen_random_uuid(), 'pi_term_missing', 2000, 'usd', 'acct_paywh1astudio'));
select pg_temp.chk('terminal: a charge for a missing sale is recorded (no foreign-key failure, no silent loss)',
  pg_temp.out('c4') = 'not_fulfilled' and (pg_temp.kv('c4')::jsonb ->> 'exception_id') is not null, pg_temp.kv('c4'));
select pg_temp.save('rel3', jsonb_build_object('outcome', public.release_terminal_event_registration_hold('00000000-0000-0000-0000-00a1fa000101', pg_temp.kv('reg:h3')::uuid)));
select pg_temp.chk('terminal: releasing a hold after a cancelled reader payment frees it',
  pg_temp.out('rel3') = 'true'
  and (select terminal_hold_until is null from public.event_registrations where id = pg_temp.kv('reg:h3')::uuid));
select pg_temp.chk('capacity: cancelling an unpaid box-office row is never blocked',
  pg_temp.try_jsonb(format($q$with u as (update public.event_registrations set status = 'cancelled' where id = %L returning 1) select jsonb_build_object('outcome', 'ok') from u$q$, pg_temp.kv('reg:h1'))) ->> 'outcome' = 'ok');

-- ===============================================================================================================
-- M-1  Competition registration-desk payments
-- ===============================================================================================================
select pg_temp.order_with_reg('comp', '00000000-0000-0000-0000-00a1fa000202', null, 100, 'competition_registration', interval '30 days');
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
values ('00000000-0000-0000-0000-00a1fa000501', '00000000-0000-0000-0000-00a1fa000202', pg_temp.kv('reg:comp')::uuid, pg_temp.kv('order:comp')::uuid, 'in_progress', 100, 'USD');
select pg_temp.order_with_reg('plain', '00000000-0000-0000-0000-00a1fa000202', null, 50, 'event_cart_v1', interval '30 days');
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
values ('00000000-0000-0000-0000-00a1fa000502', '00000000-0000-0000-0000-00a1fa000202', pg_temp.kv('reg:plain')::uuid, pg_temp.kv('order:plain')::uuid, 'in_progress', 50, 'USD');

set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000002');
select pg_temp.save('d1', public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 40, 'cash', null));
select pg_temp.chk('desk: front desk records a partial cash payment', pg_temp.out('d1') = 'recorded'
  and (pg_temp.kv('d1')::jsonb ->> 'balance_after')::numeric = 60, pg_temp.kv('d1'));
select pg_temp.expect_msg('desk: a payment above the live balance is refused',
  $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 70, 'cash', null)$q$, 'exceeds the current balance');
select pg_temp.expect_msg('desk: invalid methods are refused',
  $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 10, 'stripe', null)$q$, '22023');
select pg_temp.expect_msg('desk: a non-competition order is refused',
  $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000502', 10, 'cash', null)$q$, 'only to competition');
select pg_temp.expect_msg('desk: direct client writes of order-backed payment rows stay blocked',
  format($q$insert into public.event_payments (registration_id, amount, currency, payment_method, status, source) values (%L, 60, 'USD', 'cash', 'paid', 'competition_checkin')$q$, pg_temp.kv('reg:comp')), '42501');
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000003');
select pg_temp.expect_msg('desk: another studio cannot record payments',
  $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 1000, 'cash', null)$q$, '42501');
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000001');
select pg_temp.save('d2', public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 60, 'check', 'Check #1001'));
reset role;
select pg_temp.chk('desk: the final payment marks the competition registration and order paid and zeroes the balance',
  pg_temp.out('d2') = 'recorded'
  and (select payment_status || '/' || status from public.event_registrations where id = pg_temp.kv('reg:comp')::uuid) = 'paid/confirmed'
  and (select payment_status || '/' || status || '/' || (paid_at is not null)::text from public.event_orders where id = pg_temp.kv('order:comp')::uuid) = 'paid/confirmed/true'
  and (select balance_due from public.event_competition_checkin_sessions where id = '00000000-0000-0000-0000-00a1fa000501') = 0);
select pg_temp.chk('desk: two payment rows and two audit rows with the acting staff member and balances',
  (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:comp')::uuid and source = 'competition_checkin') = 2
  and (select string_agg(actor_user_id::text || ':' || (balance_before::int)::text || '>' || (balance_after::int)::text, ',' order by created_at, balance_before desc)
       from public.event_competition_checkin_payment_audit where checkin_session_id = '00000000-0000-0000-0000-00a1fa000501')
      = '00000000-0000-0000-0000-00a1fa000002:100>60,00000000-0000-0000-0000-00a1fa000001:60>0');
set local role anon;
select pg_temp.expect_msg('desk: anon cannot call it', $q$select public.record_competition_checkin_payment('00000000-0000-0000-0000-00a1fa000202', '00000000-0000-0000-0000-00a1fa000501', 1, 'cash', null)$q$, 'permission denied');
reset role;

-- ===============================================================================================================
-- L-2  Guard helpers are internal to the triggers
-- ===============================================================================================================
set local role anon;
select pg_temp.expect_msg('helpers: anon cannot look up registration facts', format($q$select * from public._paywh1_registration_order_facts(%L)$q$, pg_temp.kv('reg:comp')), 'internal');
select pg_temp.expect_msg('helpers: anon cannot count attendees', format($q$select public._paywh1_registration_attendee_count(%L)$q$, pg_temp.kv('reg:comp')), 'internal');
reset role;
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-00a1fa000003');
select pg_temp.expect_msg('helpers: another studio cannot probe a registration', format($q$select * from public._paywh1_registration_order_facts(%L)$q$, pg_temp.kv('reg:comp')), 'internal');
reset role;

-- ===============================================================================================================
-- event_payments.event_id (present on production; simulated here inside the rolled-back transaction)
-- ===============================================================================================================
select pg_temp.chk('event_id fill: not installed where the column does not exist',
  (select count(*) from pg_trigger where tgname = 'trg_paywh1a_fill_event_payment_event_id') = 0
  or exists (select 1 from information_schema.columns where table_name = 'event_payments' and column_name = 'event_id'));
alter table public.event_payments add column if not exists event_id uuid null;
select public._paywh1a_install_event_payment_event_id_fill();
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source)
values (pg_temp.kv('reg:plain')::uuid, 1, 'USD', 'cash', 'pending', 'paywh1a_event_id_probe');
select pg_temp.chk('event_id fill: payment rows written without event_id get it from their registration',
  (select event_id::text from public.event_payments where source = 'paywh1a_event_id_probe') = '00000000-0000-0000-0000-00a1fa000202');

-- ===============================================================================================================
-- Verdict (always raises: nothing persists)
-- ===============================================================================================================
do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'PAY-WH-1A SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PAY-WH-1A SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
