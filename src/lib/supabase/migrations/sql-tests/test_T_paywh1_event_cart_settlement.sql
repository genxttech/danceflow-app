-- PAY-WH-1 -- event cart settlement integrity regression suite.
--
-- Covers 20261116090000 (webhook claims), 20261116091000 (outbox), 20261116092000 (settlement lifecycle) and
-- 20261116093000 (direct-write guards). One transaction, synthetic fixtures only (UUID block
-- 00000000-0000-0000-0000-00a1f00XXXXX). The final block ALWAYS raises, so nothing persists; its message is the verdict:
--   "PAY-WH-1 SQL SUITE PASS (<n> checks)"  or  "PAY-WH-1 SQL SUITE FAIL: <failures>".
-- Concurrency (separate sessions) is covered by sql-tests/paywh1_concurrency.sh.

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
    insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
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

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------------------
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00a1f0000001', 'paywh1-owner@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00a1f0000002', 'paywh1-other@e2e.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00a1f0000001', 'paywh1-owner@e2e.test', 'PAYWH1 Owner'),
  ('00000000-0000-0000-0000-00a1f0000002', 'paywh1-other@e2e.test', 'PAYWH1 Other')
on conflict (id) do nothing;
insert into public.studios (id, name, slug, stripe_connected_account_id) values
  ('00000000-0000-0000-0000-00a1f0000101', 'PAYWH1 Studio', 'paywh1-sql-studio', 'acct_paywh1studio'),
  ('00000000-0000-0000-0000-00a1f0000102', 'PAYWH1 Other', 'paywh1-sql-other', 'acct_paywh1other');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00a1f0000001', '00000000-0000-0000-0000-00a1f0000101', 'studio_owner', true),
  ('00000000-0000-0000-0000-00a1f0000002', '00000000-0000-0000-0000-00a1f0000102', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000101', 'PAYWH1 Event', 'paywh1-sql-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');
insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket) values
  ('00000000-0000-0000-0000-00a1f0000301', '00000000-0000-0000-0000-00a1f0000201', 'Open', 30, 'USD', null, true, 1),
  ('00000000-0000-0000-0000-00a1f0000302', '00000000-0000-0000-0000-00a1f0000201', 'Capped', 30, 'USD', 2, true, 1);

-- An order with p_qty tickets of p_ticket at p_unit, its registration + attendees, and optionally a payment attempt.
create or replace function pg_temp.mk_order(
  p_key text, p_ticket uuid, p_qty integer, p_unit numeric, p_attempt text,
  p_expires interval default interval '30 minutes', p_attendees integer default null
) returns uuid
language plpgsql as $$
declare
  v_order uuid := gen_random_uuid();
  v_reg uuid := gen_random_uuid();
  i integer;
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency,
                                   status, payment_status, expires_at, metadata)
  values (v_order, '00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000101', 'Pat Buyer',
          'paywh1-' || p_key || '@example.com', p_qty * p_unit, p_qty * p_unit, 'USD', 'pending', 'pending', now() + p_expires,
          '{"source":"event_cart_v1"}'::jsonb);
  insert into public.event_registrations (id, order_id, event_id, ticket_type_id, studio_id, status, payment_status, quantity,
                                          unit_price, total_price, currency, registration_source, attendee_first_name,
                                          attendee_last_name, attendee_email)
  values (v_reg, v_order, '00000000-0000-0000-0000-00a1f0000201', p_ticket, '00000000-0000-0000-0000-00a1f0000101', 'pending',
          'pending', p_qty, p_unit, p_qty * p_unit, 'USD', 'public_event_page', 'Pat', 'Buyer', 'paywh1-' || p_key || '@example.com');
  for i in 1..coalesce(p_attendees, p_qty) loop
    insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order)
    values (v_reg, '00000000-0000-0000-0000-00a1f0000201', p_ticket, 'Guest', i::text, i);
  end loop;
  if p_attempt = 'session' then
    perform public.record_event_cart_payment_attempt(v_order, 'acct_paywh1studio', 'checkout_session', 'cs_test_' || p_key, null,
      round(p_qty * p_unit * 100)::bigint, 'usd', 'web', null);
  elsif p_attempt = 'pi' then
    perform public.record_event_cart_payment_attempt(v_order, 'acct_paywh1studio', 'payment_intent', null, 'pi_test_' || p_key,
      round(p_qty * p_unit * 100)::bigint, 'usd', 'student_app', null);
  end if;
  insert into t_kv values ('order:' || p_key, v_order::text), ('reg:' || p_key, v_reg::text);
  return v_order;
end $$;

create or replace function pg_temp.settle(p_session text, p_pi text, p_cents bigint, p_account text default 'acct_paywh1studio', p_currency text default 'usd')
returns jsonb language sql as $$
  select pg_temp.try_jsonb(format('select public.settle_event_cart_order(%L, null, null, %L, %L, %L, %s, %L)',
    'reconcile', p_account, p_session, p_pi, p_cents, p_currency));
$$;

-- ===============================================================================================================
-- M1 claims
-- ===============================================================================================================
select pg_temp.chk('claim: first delivery claimed',
  (public.claim_payment_provider_event('stripe', 'evt_paywh1_a', 'checkout.session.completed', 'h', '00000000-0000-0000-0000-00a1f0000a01', 60)->>'outcome') = 'claimed');
select pg_temp.chk('claim: concurrent other owner -> in_progress',
  (public.claim_payment_provider_event('stripe', 'evt_paywh1_a', 'checkout.session.completed', 'h', '00000000-0000-0000-0000-00a1f0000a02', 60)->>'outcome') = 'in_progress');
select pg_temp.chk('claim: non-owner cannot complete',
  public.complete_payment_provider_event('stripe', 'evt_paywh1_a', '00000000-0000-0000-0000-00a1f0000a02', 'processed') = false);
select pg_temp.chk('claim: owner completes',
  public.complete_payment_provider_event('stripe', 'evt_paywh1_a', '00000000-0000-0000-0000-00a1f0000a01', 'processed') = true);
select pg_temp.chk('claim: processed event acknowledged idempotently',
  (public.claim_payment_provider_event('stripe', 'evt_paywh1_a', 'checkout.session.completed', 'h', '00000000-0000-0000-0000-00a1f0000a03', 60)->>'outcome') = 'already_processed');
select public.claim_payment_provider_event('stripe', 'evt_paywh1_b', 'payment_intent.succeeded', 'h', '00000000-0000-0000-0000-00a1f0000b01', 60);
update public.payment_provider_events set claim_expires_at = now() - interval '1 second' where provider_event_id = 'evt_paywh1_b';
select pg_temp.chk('claim: expired lease is reclaimable',
  (public.claim_payment_provider_event('stripe', 'evt_paywh1_b', 'payment_intent.succeeded', 'h', '00000000-0000-0000-0000-00a1f0000b02', 60)->>'outcome') = 'claimed');
select pg_temp.chk('claim: stale owner cannot complete after takeover',
  public.complete_payment_provider_event('stripe', 'evt_paywh1_b', '00000000-0000-0000-0000-00a1f0000b01', 'processed') = false);
select pg_temp.chk('claim: failed delivery is retryable',
  public.complete_payment_provider_event('stripe', 'evt_paywh1_b', '00000000-0000-0000-0000-00a1f0000b02', 'failed', null, 'boom')
  and (public.claim_payment_provider_event('stripe', 'evt_paywh1_b', 'payment_intent.succeeded', 'h', '00000000-0000-0000-0000-00a1f0000b03', 60)->>'outcome') = 'claimed');
select pg_temp.expect_msg('claim: processing state requires an owner',
  $q$update public.payment_provider_events set claim_owner = null where provider_event_id = 'evt_paywh1_b'$q$, 'claim_consistency');

-- ===============================================================================================================
-- Payment attempts
-- ===============================================================================================================
select pg_temp.mk_order('a1', '00000000-0000-0000-0000-00a1f0000301', 2, 30, 'session');
select pg_temp.chk('attempt: recorded and legacy column set once',
  (select stripe_checkout_session_id from public.event_orders where id = pg_temp.kv('order:a1')::uuid) = 'cs_test_a1'
  and (select count(*) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:a1')::uuid) = 1);
select pg_temp.chk('attempt: re-recording the same Session is idempotent',
  (public.record_event_cart_payment_attempt(pg_temp.kv('order:a1')::uuid, 'acct_paywh1studio', 'checkout_session', 'cs_test_a1', null, 6000, 'usd', 'web', null)->>'outcome') = 'existing');
select public.record_event_cart_payment_attempt(pg_temp.kv('order:a1')::uuid, 'acct_paywh1studio', 'checkout_session', 'cs_test_a1_second', null, 6000, 'usd', 'web', null);
select pg_temp.chk('attempt: a second Session is recorded; the compatibility column names the newest',
  (select stripe_checkout_session_id from public.event_orders where id = pg_temp.kv('order:a1')::uuid) = 'cs_test_a1_second'
  and (select count(*) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:a1')::uuid) = 2);
select pg_temp.expect_msg('attempt: wrong connected account refused',
  format($q$select public.record_event_cart_payment_attempt(%L, 'acct_paywh1other', 'checkout_session', 'cs_test_bad', null, 6000, 'usd', 'web', null)$q$, pg_temp.kv('order:a1')), 'account_mismatch');
select pg_temp.expect_msg('attempt: wrong amount refused',
  format($q$select public.record_event_cart_payment_attempt(%L, 'acct_paywh1studio', 'checkout_session', 'cs_test_bad', null, 5999, 'usd', 'web', null)$q$, pg_temp.kv('order:a1')), 'amount_mismatch');
select pg_temp.mk_order('a2', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
select pg_temp.expect_msg('attempt: a Session of another order is refused',
  format($q$select public.record_event_cart_payment_attempt(%L, 'acct_paywh1studio', 'checkout_session', 'cs_test_a1', null, 3000, 'usd', 'web', null)$q$, pg_temp.kv('order:a2')), 'belongs_to_another_order');

-- ===============================================================================================================
-- Settlement
-- ===============================================================================================================
select pg_temp.save('acct', pg_temp.settle('cs_test_a1', 'pi_a1', 6000, 'acct_paywh1other'));
select pg_temp.chk('settle: wrong account -> mismatch, nothing written',
  pg_temp.out('acct') = 'mismatch:account'
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:a1')::uuid) = 'pending'
  and not exists (select 1 from public.event_payments where registration_id = pg_temp.kv('reg:a1')::uuid), pg_temp.kv('acct'));
select pg_temp.chk('settle: wrong amount -> mismatch', (pg_temp.settle('cs_test_a1', 'pi_a1', 5000)->>'outcome') = 'mismatch:amount');
select pg_temp.chk('settle: wrong currency -> mismatch', (pg_temp.settle('cs_test_a1', 'pi_a1', 6000, 'acct_paywh1studio', 'eur')->>'outcome') = 'mismatch:currency');
select pg_temp.chk('settle: unknown reference -> mismatch', (pg_temp.settle('cs_test_unknown', 'pi_unknown', 6000)->>'outcome') = 'mismatch:unknown_payment_reference');
select pg_temp.chk('settle: mismatches are recorded as exceptions',
  (select count(*) from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:a1')::uuid and kind like 'mismatch_%') >= 3);

select pg_temp.chk('settle: valid Session + PaymentIntent -> settled', (pg_temp.settle('cs_test_a1', 'pi_a1', 6000)->>'outcome') = 'settled');
insert into t_kv select 'paid_at:a1', paid_at::text from public.event_orders where id = pg_temp.kv('order:a1')::uuid;
select pg_temp.chk('settle: order paid exactly once',
  (select status = 'confirmed' and payment_status = 'paid' and settlement_state = 'paid' and stripe_payment_intent_id = 'pi_a1'
   from public.event_orders where id = pg_temp.kv('order:a1')::uuid));
select pg_temp.chk('settle: registration confirmed + paid with Stripe identity',
  (select status = 'confirmed' and payment_status = 'paid' and stripe_payment_intent_id = 'pi_a1' and stripe_checkout_session_id = 'cs_test_a1'
   from public.event_registrations where id = pg_temp.kv('reg:a1')::uuid));
select pg_temp.chk('settle: one payment row with the registration amount and account',
  (select count(*) = 1 and sum(amount) = 60 and bool_and(stripe_account_id = 'acct_paywh1studio' and status = 'paid')
   from public.event_payments where registration_id = pg_temp.kv('reg:a1')::uuid));
select pg_temp.chk('settle: attempt succeeded, other open attempt superseded',
  (select string_agg(status, ',' order by stripe_checkout_session_id) from public.event_order_payment_attempts
   where order_id = pg_temp.kv('order:a1')::uuid) = 'succeeded,superseded');
select pg_temp.chk('settle: outbox effects written in the same transaction (studio lead + confirmation + fee + close)',
  (select string_agg(effect, ',' order by effect) from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid)
  = 'close_superseded_attempts,fee_sync,order_confirmation,studio_lead');

select public.claim_payment_provider_event('stripe', 'evt_paywh1_settle', 'checkout.session.completed', 'h', '00000000-0000-0000-0000-00a1f0000f01', 60);
select pg_temp.expect_msg('claim: a webhook settlement by a non-owner of the event claim is refused',
  $q$select public.settle_event_cart_order('webhook', 'evt_paywh1_settle', '00000000-0000-0000-0000-00a1f0000f02', 'acct_paywh1studio', 'cs_test_a1', 'pi_a1', 6000, 'usd')$q$, 'paywh1_claim_not_owned');
select pg_temp.chk('claim: the claim owner''s webhook settlement is accepted',
  (pg_temp.try_jsonb($q$select public.settle_event_cart_order('webhook', 'evt_paywh1_settle', '00000000-0000-0000-0000-00a1f0000f01', 'acct_paywh1studio', 'cs_test_a1', 'pi_a1', 6000, 'usd')$q$)->>'outcome') = 'already_settled');
select pg_temp.chk('replay: same evidence -> already_settled', (pg_temp.settle('cs_test_a1', 'pi_a1', 6000)->>'outcome') = 'already_settled');
select pg_temp.chk('replay: PaymentIntent-only replay -> already_settled', (pg_temp.settle(null, 'pi_a1', 6000)->>'outcome') = 'already_settled');
select pg_temp.chk('replay: paid_at, rows and outbox unchanged',
  (select paid_at::text from public.event_orders where id = pg_temp.kv('order:a1')::uuid) = pg_temp.kv('paid_at:a1')
  and (select count(*) from public.event_payments where registration_id = pg_temp.kv('reg:a1')::uuid) = 1
  and (select count(*) from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid) = 4);
-- (Each action runs in its own statement and stores its result; verification reads state in a LATER statement, because
-- a statement cannot see rows written by functions it calls.)
select pg_temp.save('dup', pg_temp.settle('cs_test_a1_second', 'pi_a1_second', 6000));
select pg_temp.chk('duplicate: a second paid Session on a paid order -> duplicate_payment exception',
  pg_temp.out('dup') = 'duplicate_payment'
  and exists (select 1 from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:a1')::uuid and kind = 'duplicate_payment')
  and (select stripe_payment_intent_id from public.event_orders where id = pg_temp.kv('order:a1')::uuid) = 'pi_a1', pg_temp.kv('dup'));

-- PaymentIntent-first: the Session attempt has no PaymentIntent yet; Session from Stripe + PaymentIntent bind it.
select pg_temp.mk_order('p1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select pg_temp.chk('PI-first: PaymentIntent without its Session is refused', (pg_temp.settle(null, 'pi_p1', 3000)->>'outcome') = 'mismatch:unknown_payment_reference');
select pg_temp.chk('PI-first: Session resolved from Stripe + PaymentIntent -> settled', (pg_temp.settle('cs_test_p1', 'pi_p1', 3000)->>'outcome') = 'settled');
select pg_temp.chk('PI-first: later checkout.session.completed -> already_settled', (pg_temp.settle('cs_test_p1', 'pi_p1', 3000)->>'outcome') = 'already_settled');
select pg_temp.chk('PI-first: a different PaymentIntent for the same Session is refused', (pg_temp.settle('cs_test_p1', 'pi_p1_other', 3000)->>'outcome') = 'mismatch:payment_intent');

select pg_temp.chk('PI-first: a known PaymentIntent presented with a different Session is refused',
  (pg_temp.settle('cs_test_p1_forged', 'pi_p1', 3000)->>'outcome') = 'mismatch:session');

-- A cancelled order whose registration was left pending by a legacy / partial write is still never resurrected.
select pg_temp.mk_order('g1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
update public.event_orders set status = 'cancelled', payment_status = 'failed' where id = pg_temp.kv('order:g1')::uuid;
select pg_temp.save('g1', pg_temp.settle('cs_test_g1', 'pi_g1', 3000));
select pg_temp.chk('late payment: a cancelled order with a stray pending registration is not resurrected',
  pg_temp.out('g1') = 'late_payment_after_release'
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:g1')::uuid) = 'failed'
  and (select status from public.event_registrations where id = pg_temp.kv('reg:g1')::uuid) = 'pending'
  and not exists (select 1 from public.event_payments where registration_id = pg_temp.kv('reg:g1')::uuid), pg_temp.kv('g1'));

-- Native PaymentIntent attempt.
select pg_temp.mk_order('n1', '00000000-0000-0000-0000-00a1f0000301', 2, 30, 'pi');
select pg_temp.chk('native: a Session cannot settle a PaymentIntent attempt', (pg_temp.settle('cs_test_n1', 'pi_test_n1', 6000)->>'outcome') = 'mismatch:session');
select pg_temp.chk('native: PaymentIntent attempt settles', (pg_temp.settle(null, 'pi_test_n1', 6000)->>'outcome') = 'settled');

-- Entitlement mismatch and payment-row conflict roll back every write.
select pg_temp.mk_order('e1', '00000000-0000-0000-0000-00a1f0000301', 2, 30, 'session', interval '30 minutes', 1);
select pg_temp.save('e1', pg_temp.settle('cs_test_e1', 'pi_e1', 6000));
select pg_temp.chk('entitlements: missing ticket -> integrity mismatch, nothing written',
  pg_temp.out('e1') = 'mismatch:entitlements_mismatch'
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:e1')::uuid) = 'pending'
  and (select status from public.event_registrations where id = pg_temp.kv('reg:e1')::uuid) = 'pending'
  and not exists (select 1 from public.event_payments where registration_id = pg_temp.kv('reg:e1')::uuid), pg_temp.kv('e1'));
select pg_temp.mk_order('c1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id, stripe_account_id)
values (pg_temp.kv('reg:c1')::uuid, 99, 'USD', 'stripe_checkout', 'paid', 'stripe', 'pi_c1', 'acct_paywh1studio');
select pg_temp.save('c1', pg_temp.settle('cs_test_c1', 'pi_c1', 3000));
select pg_temp.chk('payment row: conflicting existing row is never treated as a duplicate',
  pg_temp.out('c1') = 'mismatch:payment_row_conflict'
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:c1')::uuid) = 'pending'
  and (select status from public.event_registrations where id = pg_temp.kv('reg:c1')::uuid) = 'pending', pg_temp.kv('c1'));

-- Late payment after release: never resurrected, exception recorded, no refund.
select pg_temp.mk_order('l1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select public.begin_event_cart_order_release(pg_temp.kv('order:l1')::uuid, 'test');
select public.finalize_event_cart_order_release(pg_temp.kv('order:l1')::uuid,
  (select jsonb_agg(jsonb_build_object('attempt_id', id, 'stripe_state', 'closed')) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:l1')::uuid));
select pg_temp.save('l1', pg_temp.settle('cs_test_l1', 'pi_l1', 3000));
select pg_temp.chk('late payment: released order is not resurrected',
  pg_temp.out('l1') = 'late_payment_after_release'
  and (select status = 'cancelled' and payment_status = 'failed' from public.event_orders where id = pg_temp.kv('order:l1')::uuid)
  and (select status from public.event_registrations where id = pg_temp.kv('reg:l1')::uuid) = 'cancelled'
  and exists (select 1 from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:l1')::uuid and kind = 'late_payment_after_release' and status = 'open')
  and not exists (select 1 from public.event_payments where registration_id = pg_temp.kv('reg:l1')::uuid), pg_temp.kv('l1'));

-- Lapsed hold whose capacity was taken: payment cannot oversell.
select pg_temp.mk_order('k1', '00000000-0000-0000-0000-00a1f0000302', 1, 30, 'session', interval '-1 minute');
select pg_temp.mk_order('k2', '00000000-0000-0000-0000-00a1f0000302', 2, 30, 'session');
select pg_temp.chk('capacity: the live buyer settles first', (pg_temp.settle('cs_test_k2', 'pi_k2', 6000)->>'outcome') = 'settled');
select pg_temp.save('k1', pg_temp.settle('cs_test_k1', 'pi_k1', 3000));
select pg_temp.chk('capacity: late payment for a lapsed hold cannot oversell',
  pg_temp.out('k1') = 'late_payment_after_release'
  and exists (select 1 from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:k1')::uuid and kind = 'paid_capacity_unavailable')
  and (select coalesce(sum(quantity), 0) from public.event_registrations where ticket_type_id = '00000000-0000-0000-0000-00a1f0000302' and payment_status = 'paid') = 2
  and (select status from public.event_orders where id = pg_temp.kv('order:k1')::uuid) = 'cancelled', pg_temp.kv('k1'));
select pg_temp.chk('capacity: cancelling a row on a full ticket type no longer raises',
  (select pg_temp.try_jsonb(format($q$with u as (update public.event_registrations set status = 'cancelled' where id = %L returning 1) select jsonb_build_object('outcome', 'ok')$q$, pg_temp.kv('reg:k2')))->>'outcome') = 'ok');

-- ===============================================================================================================
-- Delayed payments and failures
-- ===============================================================================================================
select pg_temp.mk_order('d1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select pg_temp.save('d1p', pg_temp.try_jsonb($q$select public.mark_event_cart_order_processing('reconcile', null, null, 'acct_paywh1studio', 'cs_test_d1', 'pi_d1', 3000, 'usd', now() + interval '7 days')$q$));
select pg_temp.chk('processing: hold extended, state processing',
  pg_temp.out('d1p') = 'processing'
  and (select settlement_state = 'processing' and expires_at >= now() + interval '6 days' from public.event_orders where id = pg_temp.kv('order:d1')::uuid), pg_temp.kv('d1p'));
select pg_temp.chk('processing: release is refused while payment is in flight',
  (public.begin_event_cart_order_release(pg_temp.kv('order:d1')::uuid, 'test')->>'outcome') = 'processing');
select pg_temp.chk('processing: delayed success settles', (pg_temp.settle('cs_test_d1', 'pi_d1', 3000)->>'outcome') = 'settled');
select pg_temp.save('d1f', pg_temp.try_jsonb($q$select public.fail_event_cart_payment_attempt('reconcile', null, null, 'acct_paywh1studio', 'cs_test_d1', 'pi_d1', true, 'failed', 'late failure')$q$));
select pg_temp.chk('failure after settlement never reverses it',
  pg_temp.out('d1f') = 'ignored_paid'
  and (select payment_status from public.event_orders where id = pg_temp.kv('order:d1')::uuid) = 'paid'
  and (select status from public.event_registrations where id = pg_temp.kv('reg:d1')::uuid) = 'confirmed'
  and exists (select 1 from public.event_order_settlement_exceptions where order_id = pg_temp.kv('order:d1')::uuid and kind = 'failure_after_settlement'), pg_temp.kv('d1f'));

select pg_temp.mk_order('f1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select pg_temp.save('f1a', pg_temp.try_jsonb($q$select public.fail_event_cart_payment_attempt('reconcile', null, null, 'acct_paywh1studio', 'cs_test_f1', null, false, 'failed', 'card_declined')$q$));
select pg_temp.chk('failure: non-final (card declined, retry possible) keeps the order',
  pg_temp.out('f1a') = 'recorded' and (select status from public.event_orders where id = pg_temp.kv('order:f1')::uuid) = 'pending', pg_temp.kv('f1a'));
select public.record_event_cart_payment_attempt(pg_temp.kv('order:f1')::uuid, 'acct_paywh1studio', 'checkout_session', 'cs_test_f1_b', null, 3000, 'usd', 'web', null);
select pg_temp.save('f1b', pg_temp.try_jsonb($q$select public.fail_event_cart_payment_attempt('reconcile', null, null, 'acct_paywh1studio', 'cs_test_f1', null, true, 'failed', 'async_failed')$q$));
select pg_temp.chk('failure: final failure with another live attempt only closes that attempt',
  pg_temp.out('f1b') = 'attempt_closed' and (select status from public.event_orders where id = pg_temp.kv('order:f1')::uuid) = 'pending', pg_temp.kv('f1b'));
select pg_temp.save('f1c', pg_temp.try_jsonb($q$select public.fail_event_cart_payment_attempt('reconcile', null, null, 'acct_paywh1studio', 'cs_test_f1_b', null, true, 'expired', 'session_expired')$q$));
select pg_temp.chk('failure: final failure of the last live attempt releases the order',
  pg_temp.out('f1c') = 'released'
  and (select status = 'expired' and settlement_state = 'expired' from public.event_orders where id = pg_temp.kv('order:f1')::uuid)
  and (select status from public.event_registrations where id = pg_temp.kv('reg:f1')::uuid) = 'cancelled', pg_temp.kv('f1c'));

-- ===============================================================================================================
-- Two-phase release
-- ===============================================================================================================
select pg_temp.mk_order('r1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select pg_temp.save('r1b', public.begin_event_cart_order_release(pg_temp.kv('order:r1')::uuid, 'test'));
select pg_temp.chk('release: begin keeps the hold and returns live attempts',
  pg_temp.out('r1b') = 'releasing' and jsonb_array_length(pg_temp.kv('r1b')::jsonb -> 'attempts') = 1
  and (select status = 'pending' and settlement_state = 'releasing' from public.event_orders where id = pg_temp.kv('order:r1')::uuid), pg_temp.kv('r1b'));
select pg_temp.chk('release: still-open Stripe attempt -> retry, nothing released',
  (public.finalize_event_cart_order_release(pg_temp.kv('order:r1')::uuid,
     (select jsonb_agg(jsonb_build_object('attempt_id', id, 'stripe_state', 'open')) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:r1')::uuid))->>'outcome') = 'retry');
select pg_temp.expect_msg('release: a finding for another order''s attempt is refused',
  format($q$select public.finalize_event_cart_order_release(%L, jsonb_build_array(jsonb_build_object('attempt_id', (select id from public.event_order_payment_attempts where stripe_checkout_session_id = 'cs_test_a1'), 'stripe_state', 'closed')))$q$, pg_temp.kv('order:r1')), 'another order');
select pg_temp.chk('release: payment found -> caller settles',
  (public.finalize_event_cart_order_release(pg_temp.kv('order:r1')::uuid,
     (select jsonb_agg(jsonb_build_object('attempt_id', id, 'stripe_state', 'paid')) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:r1')::uuid))->>'outcome') = 'payment_found');
select pg_temp.chk('release race: payment settles while releasing', (pg_temp.settle('cs_test_r1', 'pi_r1', 3000)->>'outcome') = 'settled');
select pg_temp.chk('release race: finalize after payment -> already_paid (no release)',
  (public.finalize_event_cart_order_release(pg_temp.kv('order:r1')::uuid, '[]'::jsonb)->>'outcome') = 'already_paid');
select pg_temp.chk('release race: order stays paid', (select payment_status from public.event_orders where id = pg_temp.kv('order:r1')::uuid) = 'paid');

select pg_temp.mk_order('r2', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select public.begin_event_cart_order_release(pg_temp.kv('order:r2')::uuid, 'test');
select pg_temp.save('r2f', public.finalize_event_cart_order_release(pg_temp.kv('order:r2')::uuid,
  (select jsonb_agg(jsonb_build_object('attempt_id', id, 'stripe_state', 'closed')) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:r2')::uuid)));
select pg_temp.chk('release: closed attempts -> released exactly once',
  pg_temp.out('r2f') = 'released'
  and (public.finalize_event_cart_order_release(pg_temp.kv('order:r2')::uuid, '[]'::jsonb)->>'outcome') = 'not_releasing', pg_temp.kv('r2f'));

select pg_temp.mk_order('u1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
select pg_temp.mk_order('u2', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
-- u2 reached Stripe: it has a payment attempt; its legacy reference column is cleared so the attempt alone must protect it.
update public.event_orders set created_at = now() - interval '5 minutes', buyer_email = 'paywh1-same@example.com'
where id in (pg_temp.kv('order:u1')::uuid, pg_temp.kv('order:u2')::uuid);
update public.event_orders set stripe_checkout_session_id = null where id = pg_temp.kv('order:u2')::uuid;
select pg_temp.save('u', jsonb_build_object('outcome', public.release_unattempted_event_cart_orders('00000000-0000-0000-0000-00a1f0000201', 'paywh1-same@example.com', null)));
select pg_temp.chk('cleanup: only an order that never reached Stripe is released',
  pg_temp.out('u') = '1'
  and (select status from public.event_orders where id = pg_temp.kv('order:u1')::uuid) = 'cancelled'
  and (select status from public.event_orders where id = pg_temp.kv('order:u2')::uuid) = 'pending', pg_temp.kv('u'));

-- ===============================================================================================================
-- Outbox and lead capture
-- ===============================================================================================================
select pg_temp.chk('outbox: claim leases due effects to one owner',
  (select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c01', 100, 60, pg_temp.kv('order:a1')::uuid)) = 4);
select pg_temp.chk('outbox: a second worker gets nothing while leased',
  (select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c02', 100, 60, pg_temp.kv('order:a1')::uuid)) = 0);
select pg_temp.chk('outbox: only the owner completes',
  (select bool_and(not public.complete_event_settlement_outbox(id, '00000000-0000-0000-0000-00a1f0000c02', true))
   from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid));
select pg_temp.chk('outbox: owner records failures',
  (select bool_and(public.complete_event_settlement_outbox(id, '00000000-0000-0000-0000-00a1f0000c01', false, 'boom'))
   from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid));
select pg_temp.chk('outbox: failure backs off and stays visible',
  (select bool_and(status = 'failed' and next_attempt_at > now() and last_error = 'boom') from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid));
update public.event_settlement_outbox set status = 'processing', claim_owner = '00000000-0000-0000-0000-00a1f0000c03', claim_expires_at = now() - interval '1 second', next_attempt_at = now()
where order_id = pg_temp.kv('order:a1')::uuid;
select pg_temp.chk('outbox: an interrupted worker''s expired lease is recovered',
  (select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c04', 100, 60, pg_temp.kv('order:a1')::uuid)) = 4);
update public.event_settlement_outbox set attempts = max_attempts where order_id = pg_temp.kv('order:a1')::uuid;
select pg_temp.chk('outbox: final failure recorded by the owner',
  (select bool_and(public.complete_event_settlement_outbox(id, '00000000-0000-0000-0000-00a1f0000c04', false, 'still failing'))
   from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid));
select pg_temp.chk('outbox: repeated failure becomes dead (visible, not dropped)',
  (select bool_and(status = 'dead') from public.event_settlement_outbox where order_id = pg_temp.kv('order:a1')::uuid));

select pg_temp.save('lead1', public.capture_event_registration_lead(pg_temp.kv('reg:a1')::uuid));
select pg_temp.save('lead2', public.capture_event_registration_lead(pg_temp.kv('reg:a1')::uuid));
select pg_temp.chk('lead: captured once from a paid registration (re-run adds nothing)',
  pg_temp.out('lead1') = 'captured' and pg_temp.out('lead2') = 'captured'
  and (select count(*) from public.clients where studio_id = '00000000-0000-0000-0000-00a1f0000101' and lower(email) = 'paywh1-a1@example.com') = 1
  and (select count(*) from public.notifications where dedupe_key = 'event_registration_lead:' || pg_temp.kv('reg:a1')) = 1
  and (select client_id is not null from public.event_registrations where id = pg_temp.kv('reg:a1')::uuid), pg_temp.kv('lead1'));
select pg_temp.chk('lead: never from an unpaid registration',
  (public.capture_event_registration_lead(pg_temp.kv('reg:u2')::uuid)->>'reason') = 'registration_not_paid');

-- ===============================================================================================================
-- Shared sender claims (outbound_deliveries)
-- ===============================================================================================================
insert into public.outbound_deliveries (id, studio_id, channel, template_key, recipient_email, subject, body_text, status, dedupe_key)
values ('00000000-0000-0000-0000-00a1f0000d01', '00000000-0000-0000-0000-00a1f0000101', 'email', 'paywh1_test', 'paywh1-d@example.com', 's', 'b', 'queued', 'paywh1-test-d01'),
       ('00000000-0000-0000-0000-00a1f0000d02', '00000000-0000-0000-0000-00a1f0000101', 'email', 'paywh1_test', 'paywh1-d@example.com', 's', 'b', 'sent', 'paywh1-test-d02');
select pg_temp.chk('sender: a queued delivery is leased to one dispatcher',
  exists (select 1 from public.claim_outbound_deliveries('00000000-0000-0000-0000-00a1f0000e01', 200, 300) where id = '00000000-0000-0000-0000-00a1f0000d01'));
select pg_temp.chk('sender: a second dispatcher cannot take a live lease',
  not exists (select 1 from public.claim_outbound_deliveries('00000000-0000-0000-0000-00a1f0000e02', 200, 300) where id = '00000000-0000-0000-0000-00a1f0000d01'));
update public.outbound_deliveries set claim_expires_at = now() - interval '1 second' where id = '00000000-0000-0000-0000-00a1f0000d01';
select pg_temp.chk('sender: an expired lease is reclaimable',
  exists (select 1 from public.claim_outbound_deliveries('00000000-0000-0000-0000-00a1f0000e03', 200, 300) where id = '00000000-0000-0000-0000-00a1f0000d01'));
select pg_temp.chk('sender: a sent delivery is never claimed',
  not exists (select 1 from public.claim_outbound_deliveries('00000000-0000-0000-0000-00a1f0000e04', 200, 300) where id = '00000000-0000-0000-0000-00a1f0000d02'));
select pg_temp.chk('sender: status values are unchanged by a claim',
  (select status from public.outbound_deliveries where id = '00000000-0000-0000-0000-00a1f0000d01') = 'queued');

-- ===============================================================================================================
-- Direct-write guards (client roles) -- each refusal has an orderless control that RLS allows.
-- ===============================================================================================================
insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price,
                                        currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values ('00000000-0000-0000-0000-00a1f0000401', '00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000301',
        '00000000-0000-0000-0000-00a1f0000101', 'pending', 'pending', 1, 30, 30, 'USD', 'admin', 'Box', 'Office', 'paywh1-box@example.com');

insert into t_kv select 'exception:late', id::text from public.event_order_settlement_exceptions
where order_id = pg_temp.kv('order:l1')::uuid and kind = 'late_payment_after_release';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00a1f0000001","role":"authenticated"}', true);

select pg_temp.chk('guard control: staff can update an orderless registration payment',
  (select pg_temp.try_jsonb($q$with u as (update public.event_registrations set payment_status = 'paid', status = 'confirmed' where id = '00000000-0000-0000-0000-00a1f0000401' returning 1) select jsonb_build_object('outcome', (select count(*) from u)::text)$q$)->>'outcome') = '1');
select pg_temp.expect_msg('guard: staff cannot forge payment status of an order-backed registration',
  format($q$update public.event_registrations set payment_status = 'paid' where id = %L$q$, pg_temp.kv('reg:u2')), 'set only by payment settlement');
select pg_temp.expect_msg('guard: staff cannot confirm an unpaid order-backed registration',
  format($q$update public.event_registrations set status = 'confirmed' where id = %L$q$, pg_temp.kv('reg:u2')), 'cannot be confirmed');
select pg_temp.expect_msg('guard: staff cannot reinstate a cancelled order-backed registration',
  format($q$update public.event_registrations set status = 'confirmed' where id = %L$q$, pg_temp.kv('reg:l1')), 'cannot be');
select pg_temp.expect_msg('guard: staff cannot change price of an order-backed registration',
  format($q$update public.event_registrations set total_price = 1 where id = %L$q$, pg_temp.kv('reg:a1')), 'fixed at checkout');
select pg_temp.expect_msg('guard: staff cannot insert an order-backed registration',
  format($q$insert into public.event_registrations (event_id, ticket_type_id, studio_id, order_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email) values ('00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000301', '00000000-0000-0000-0000-00a1f0000101', %L, 'confirmed', 'paid', 1, 30, 30, 'USD', 'admin', 'X', 'Y', 'x@example.com')$q$, pg_temp.kv('order:a1')), 'created only by checkout');
select pg_temp.expect_msg('guard: staff cannot delete an order-backed registration',
  format($q$delete from public.event_registrations where id = %L$q$, pg_temp.kv('reg:u2')), 'cannot be deleted');
select pg_temp.chk('guard control: staff can record an orderless payment row',
  (select pg_temp.try_jsonb($q$with i as (insert into public.event_payments (registration_id, amount, currency, payment_method, status, source) values ('00000000-0000-0000-0000-00a1f0000401', 30, 'USD', 'cash', 'paid', 'manual') returning 1) select jsonb_build_object('outcome', (select count(*) from i)::text)$q$)->>'outcome') = '1');
select pg_temp.expect_msg('guard: staff cannot write a payment row for an order-backed registration',
  format($q$insert into public.event_payments (registration_id, amount, currency, payment_method, status, source) values (%L, 30, 'USD', 'cash', 'paid', 'manual')$q$, pg_temp.kv('reg:u2')), 'written only by payment settlement');
select pg_temp.expect_msg('guard: staff cannot edit a settled Stripe payment row',
  format($q$update public.event_payments set amount = 1 where registration_id = %L$q$, pg_temp.kv('reg:a1')), 'written only by payment settlement');
select pg_temp.expect_msg('guard: no extra tickets beyond the paid entitlement',
  format($q$insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order) values (%L, '00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000301', 'Extra', 'Ticket', 9)$q$, pg_temp.kv('reg:a1')), 'every ticket it paid for');
select pg_temp.expect_msg('guard: no tickets on an unpaid hold',
  format($q$insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order) values (%L, '00000000-0000-0000-0000-00a1f0000201', '00000000-0000-0000-0000-00a1f0000301', 'Extra', 'Ticket', 9)$q$, pg_temp.kv('reg:u2')), 'unpaid or cancelled');
select pg_temp.expect_msg('privilege: client cannot call settlement', $q$select public.settle_event_cart_order('reconcile', null, null, 'acct_paywh1studio', 'cs_test_u2', 'pi_x', 3000, 'usd')$q$, 'permission denied');
select pg_temp.expect_msg('privilege: client cannot claim webhook events', $q$select public.claim_payment_provider_event('stripe', 'evt_x', 't', 'h', gen_random_uuid(), 60)$q$, 'permission denied');
select pg_temp.expect_msg('privilege: client cannot claim outbox effects', $q$select * from public.claim_event_settlement_outbox(gen_random_uuid(), 1, 60, null)$q$, 'permission denied');
select pg_temp.expect_msg('privilege: client cannot read payment attempts', $q$select count(*) from public.event_order_payment_attempts$q$, 'permission denied');
select pg_temp.chk('exceptions: the studio manager sees their exceptions',
  (select count(*) from public.event_order_settlement_exceptions where studio_id = '00000000-0000-0000-0000-00a1f0000101') > 0);
select pg_temp.chk('exceptions: manager can resolve with a note',
  public.resolve_event_order_settlement_exception((select id from public.event_order_settlement_exceptions where kind = 'duplicate_payment' and studio_id = '00000000-0000-0000-0000-00a1f0000101' limit 1), 'Refunded manually in Stripe'));

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00a1f0000002","role":"authenticated"}', true);
select pg_temp.chk('exceptions: another studio sees none',
  (select count(*) from public.event_order_settlement_exceptions where studio_id = '00000000-0000-0000-0000-00a1f0000101') = 0);
select pg_temp.expect_msg('exceptions: another studio cannot resolve',
  format($q$select public.resolve_event_order_settlement_exception(%L, 'x')$q$, pg_temp.kv('exception:late')), 'not authorized');
reset role;

-- ===============================================================================================================
-- Review fixes: legacy references, compatibility columns, unknown references, processing hold, outbox, old sweeper
-- ===============================================================================================================
select pg_temp.chk('unknown reference: actionable exception recorded (no order)',
  exists (select 1 from public.event_order_settlement_exceptions where kind = 'unknown_payment_reference'
          and order_id is null and stripe_checkout_session_id = 'cs_test_unknown' and amount_cents = 6000 and status = 'open'));

-- A pre-PAY-WH-1 order: stored Session, no attempt row. Release must hand it to Stripe, not drop it.
select pg_temp.mk_order('lg1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
update public.event_orders set stripe_checkout_session_id = 'cs_legacy_lg1' where id = pg_temp.kv('order:lg1')::uuid;
select pg_temp.save('lg1b', public.begin_event_cart_order_release(pg_temp.kv('order:lg1')::uuid, 'test'));
select pg_temp.chk('legacy release: the stored Session is returned as a live attempt to expire in Stripe',
  (pg_temp.kv('lg1b')::jsonb -> 'attempts' -> 0 ->> 'stripe_checkout_session_id') = 'cs_legacy_lg1'
  and (select surface from public.event_order_payment_attempts where stripe_checkout_session_id = 'cs_legacy_lg1') = 'legacy', pg_temp.kv('lg1b'));
select pg_temp.chk('legacy release: without Stripe evidence the order is NOT released',
  (public.finalize_event_cart_order_release(pg_temp.kv('order:lg1')::uuid, '[]'::jsonb)->>'outcome') = 'retry');
-- The Session.expired webhook caused by the release itself must not pre-empt the release's own final state.
select pg_temp.save('lg1x', public.fail_event_cart_payment_attempt('reconcile', null, null, 'acct_paywh1studio', 'cs_legacy_lg1', null, true, 'expired', 'session_expired'));
select pg_temp.chk('release in progress: a final-failure webhook only closes the attempt',
  pg_temp.out('lg1x') = 'attempt_closed'
  and (select settlement_state from public.event_orders where id = pg_temp.kv('order:lg1')::uuid) = 'releasing', pg_temp.kv('lg1x'));
select pg_temp.save('lg1f', public.finalize_event_cart_order_release(pg_temp.kv('order:lg1')::uuid, '[]'::jsonb, 'released'));
select pg_temp.chk('release in progress: the release finalizes with its own final state, once',
  pg_temp.out('lg1f') = 'released'
  and (select status || '/' || settlement_state from public.event_orders where id = pg_temp.kv('order:lg1')::uuid) = 'cancelled/released', pg_temp.kv('lg1f'));

-- Resume of a legacy order: the old reference stays bound, the compatibility columns name the newest attempt.
select pg_temp.mk_order('lg2', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
update public.event_orders set stripe_checkout_session_id = 'cs_legacy_lg2' where id = pg_temp.kv('order:lg2')::uuid;
select public.record_event_cart_payment_attempt(pg_temp.kv('order:lg2')::uuid, 'acct_paywh1studio', 'checkout_session', 'cs_new_lg2', null, 3000, 'usd', 'web', null);
select pg_temp.chk('legacy resume: both Sessions recorded; compatibility column = newest',
  (select count(*) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:lg2')::uuid) = 2
  and (select stripe_checkout_session_id from public.event_orders where id = pg_temp.kv('order:lg2')::uuid) = 'cs_new_lg2');
select pg_temp.save('lg2s', pg_temp.settle('cs_legacy_lg2', 'pi_legacy_lg2', 3000));
select pg_temp.chk('legacy resume: a payment on the old Session still settles the order (bound, not lost)',
  pg_temp.out('lg2s') = 'settled' and (select payment_status from public.event_orders where id = pg_temp.kv('order:lg2')::uuid) = 'paid', pg_temp.kv('lg2s'));

select pg_temp.mk_order('lg3', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
update public.event_orders set stripe_payment_intent_id = 'pi_legacy_lg3' where id = pg_temp.kv('order:lg3')::uuid;
select public.extend_event_cart_order_hold(pg_temp.kv('order:lg3')::uuid, now() + interval '35 minutes');
select pg_temp.chk('legacy native resume: the stored PaymentIntent is visible to resume as an attempt',
  (select kind || ':' || status from public.event_order_payment_attempts where stripe_payment_intent_id = 'pi_legacy_lg3') = 'payment_intent:open');

-- Legacy order with BOTH a web Session and a PaymentSheet PaymentIntent (the old app wrote each per surface).
select pg_temp.mk_order('lg4', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
update public.event_orders set stripe_checkout_session_id = 'cs_legacy_lg4', stripe_payment_intent_id = 'pi_legacy_lg4',
  metadata = metadata || '{"payment_intent_attempt_count": 1}'::jsonb where id = pg_temp.kv('order:lg4')::uuid;
select pg_temp.save('lg4b', public.begin_event_cart_order_release(pg_temp.kv('order:lg4')::uuid, 'test'));
select pg_temp.chk('legacy release: a stored Session AND a stored PaymentSheet PaymentIntent are both closed in Stripe',
  jsonb_array_length(pg_temp.kv('lg4b')::jsonb -> 'attempts') = 2
  and (select string_agg(kind, ',' order by kind) from public.event_order_payment_attempts where order_id = pg_temp.kv('order:lg4')::uuid) = 'checkout_session,payment_intent', pg_temp.kv('lg4b'));
-- Without a PaymentSheet marker the stored PaymentIntent may be the Session's own: it must not become a rival attempt.
select pg_temp.mk_order('lg5', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null);
update public.event_orders set stripe_checkout_session_id = 'cs_legacy_lg5', stripe_payment_intent_id = 'pi_legacy_lg5'
where id = pg_temp.kv('order:lg5')::uuid;
select public.begin_event_cart_order_release(pg_temp.kv('order:lg5')::uuid, 'test');
select pg_temp.chk('legacy release: a Session''s own PaymentIntent is not bootstrapped as a separate attempt',
  (select string_agg(kind, ',') from public.event_order_payment_attempts where order_id = pg_temp.kv('order:lg5')::uuid) = 'checkout_session');

-- A stalled release is retried by the sweeper with its own outcome: a lapsed hold -> expired; a cancel -> released.
select pg_temp.mk_order('lg6', '00000000-0000-0000-0000-00a1f0000301', 1, 30, null, interval '-10 minutes');
update public.event_orders set stripe_checkout_session_id = 'cs_legacy_lg6' where id = pg_temp.kv('order:lg6')::uuid;
select public.begin_event_cart_order_release(pg_temp.kv('order:lg6')::uuid, 'test');
update public.event_orders set release_requested_at = now() - interval '6 minutes'
where id in (pg_temp.kv('order:lg6')::uuid, pg_temp.kv('order:lg4')::uuid);
select pg_temp.chk('sweeper: stalled releases keep their own final state',
  (select retry_final_state from public.list_event_cart_orders_due_for_reconcile(500) where order_id = pg_temp.kv('order:lg6')::uuid) = 'expired'
  and (select retry_final_state from public.list_event_cart_orders_due_for_reconcile(500) where order_id = pg_temp.kv('order:lg4')::uuid) = 'released');

-- Release that finds a delayed payment in flight keeps a bounded hold (as mark_processing does).
select pg_temp.mk_order('pr1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select public.begin_event_cart_order_release(pg_temp.kv('order:pr1')::uuid, 'test');
select pg_temp.save('pr1f', public.finalize_event_cart_order_release(pg_temp.kv('order:pr1')::uuid,
  jsonb_build_array(jsonb_build_object('attempt_id', (select id from public.event_order_payment_attempts where stripe_checkout_session_id = 'cs_test_pr1'), 'stripe_state', 'processing'))));
select pg_temp.chk('release: payment processing -> processing with a bounded multi-day hold',
  pg_temp.out('pr1f') = 'processing'
  and (select expires_at > now() + interval '6 days' and expires_at <= now() + interval '7 days 1 minute' from public.event_orders where id = pg_temp.kv('order:pr1')::uuid), pg_temp.kv('pr1f'));

-- Outbox: a worker that dies every time (never completes) still ends in 'dead'; a crashed claim backs off.
select pg_temp.mk_order('ob1', '00000000-0000-0000-0000-00a1f0000301', 1, 30, 'session');
select pg_temp.settle('cs_test_ob1', 'pi_ob1', 3000);
select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c05', 100, 60, pg_temp.kv('order:ob1')::uuid);
select pg_temp.chk('outbox: a claim backs off even if the worker never completes',
  (select count(*) > 0 and bool_and(next_attempt_at > claim_expires_at) from public.event_settlement_outbox where order_id = pg_temp.kv('order:ob1')::uuid));
update public.event_settlement_outbox set claim_expires_at = now() - interval '1 second' where order_id = pg_temp.kv('order:ob1')::uuid;
select pg_temp.chk('outbox: an expired lease is not reclaimed before its back-off',
  (select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c06', 100, 60, pg_temp.kv('order:ob1')::uuid)) = 0);
update public.event_settlement_outbox set attempts = max_attempts, next_attempt_at = now() where order_id = pg_temp.kv('order:ob1')::uuid;
select count(*) from public.claim_event_settlement_outbox('00000000-0000-0000-0000-00a1f0000c06', 100, 60, pg_temp.kv('order:ob1')::uuid);
select pg_temp.chk('outbox: repeated lease expiry at max attempts becomes dead (visible, not retried forever)',
  (select count(*) > 0 and bool_and(status = 'dead' and claim_owner is null) from public.event_settlement_outbox where order_id = pg_temp.kv('order:ob1')::uuid));

select pg_temp.chk('privilege: the pre-PAY-WH-1 sweeper is not callable by client roles or the API',
  not has_function_privilege('anon', 'public.expire_event_ticket_holds()', 'execute')
  and not has_function_privilege('authenticated', 'public.expire_event_ticket_holds()', 'execute')
  and not has_function_privilege('service_role', 'public.expire_event_ticket_holds()', 'execute'));

set local role anon;
select pg_temp.expect_msg('privilege: anon cannot call settlement', $q$select public.settle_event_cart_order('reconcile', null, null, 'acct_paywh1studio', 'cs_test_u2', 'pi_x', 3000, 'usd')$q$, 'permission denied');
reset role;

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
    raise exception 'PAY-WH-1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PAY-WH-1 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
