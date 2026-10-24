
-- ============================================================================
-- R2 on orders built by the REAL competition checkout path (the prefix is the first 710 lines of
-- test_T_phase10c_competitor_registration.sql: START -> PREPARE -> ATTACH -> finalize_competition_registration, release ...).
-- Orders: o1 finalized and paid; r2 expired with a late payment; r4 failed; r5 started and unpaid; r6 abandoned (cancelled).
-- Nothing here sets settlement_state: finalize_competition_registration never writes it (it is NULL in production too).
-- ============================================================================
create or replace function pg_temp.ord(p_k text) returns uuid language sql stable as $$ select ((select v from t_kv where k = p_k)->>'order_id')::uuid $$;
create or replace function pg_temp.o1() returns uuid language sql stable as $$ select ((select v from t_kv where k = 'o1')->>'id')::uuid $$;
create or replace function pg_temp.rid(p_n text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0c10c0ff' || p_n)::uuid $$;
-- the lines of o1 at their remaining cap (cap minus what is already refunded or requested); p_only_first_cents = just the first line at that amount
create or replace function pg_temp.o1_lines(p_only_first_cents bigint default null) returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('orderItemId', x.order_item_id, 'amountCents', x.rem, 'withdrawEntry', false) order by x.order_item_id), '[]'::jsonb)
  from (select c.order_item_id,
               case when p_only_first_cents is null then c.cap_cents - coalesce((select sum(a.amount_cents) from public.event_order_refund_allocations a where a.order_item_id = c.order_item_id), 0)
                    else p_only_first_cents end as rem,
               row_number() over (order by c.order_item_id) rn
        from public._r2_order_line_caps(pg_temp.o1()) c) x
  where x.rem > 0 and (p_only_first_cents is null or x.rn = 1)
$$;
create or replace function pg_temp.o1_item() returns uuid language sql stable security definer as $$ select order_item_id from public._r2_order_line_caps(pg_temp.o1()) order by 1 limit 1 $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

select pg_temp.chk('R2CO: the checkout-built order is paid and has NO settlement_state (the production shape)',
  (select payment_status = 'paid' and status = 'confirmed' and settlement_state is null and stripe_payment_intent_id = 'pi_test_p10c_1' from public.event_orders where id = pg_temp.o1()));

-- Refusals that must stay (all with a NULL settlement_state)
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_msg('R2CO: an unpaid (started, not finalized) order is refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.ord('r5'), pg_temp.rid('0001')), 'COMP_REFUND_ORDER_NOT_PAID');
select pg_temp.expect_msg('R2CO: a cancelled order is refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.ord('r6'), pg_temp.rid('0002')), 'COMP_REFUND_ORDER_NOT_PAID');
select pg_temp.expect_msg('R2CO: a failed-payment order is refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.ord('r4'), pg_temp.rid('0003')), 'COMP_REFUND_ORDER_NOT_PAID');
select pg_temp.expect_msg('R2CO: an expired order with a late payment is refused (needs review, not a refund)',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.ord('r2'), pg_temp.rid('0004')), 'COMP_REFUND_ORDER_NOT_PAID');
select pg_temp.expect_msg('R2CO: another event is still refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(2), pg_temp.o1(), pg_temp.rid('0005')), 'COMP_REFUND_ORDER_NOT_IN_EVENT');
reset role;

-- A signing-incomplete paid order (finalize records the payment but leaves the order pending): simulate its state on r5 -- refused
update public.event_orders set payment_status = 'paid', stripe_payment_intent_id = 'pi_r2co_signing', metadata = metadata || '{"needs_review": "signing_incomplete_payment_recorded"}'
where id = pg_temp.ord('r5');
insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id, stripe_account_id)
select er.id, 10, 'USD', 'stripe_checkout', 'paid', 'stripe', 'pi_r2co_signing', 'acct_p10cStudioA' from public.event_registrations er where er.order_id = pg_temp.ord('r5') limit 1;
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_msg('R2CO: a PENDING order that carries a paid payment (signing incomplete) is refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, '[]'::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.ord('r5'), pg_temp.rid('0007')), 'COMP_REFUND_ORDER_NOT_PAID');
reset role;

-- A settlement_state that says the order is NOT settled still refuses
update public.event_orders set settlement_state = 'processing' where id = pg_temp.o1();
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_msg('R2CO: settlement_state processing is refused',
  format($q$select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.o1(), pg_temp.rid('0006'), pg_temp.o1_lines(500)::text), 'COMP_REFUND_ORDER_NOT_PAID');
reset role;
do $blk$
declare v_state text;
begin
  foreach v_state in array array['pending', 'releasing', 'released', 'failed', 'expired'] loop
    update public.event_orders set settlement_state = v_state where id = pg_temp.o1();
    perform pg_temp.as_user(pg_temp.u('0c10c0000001'));
    perform pg_temp.expect_msg('R2CO: settlement_state ' || v_state || ' is refused',
      format($q$select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, 'x')$q$, pg_temp.ev(1), pg_temp.o1(), pg_temp.rid('0008'), pg_temp.o1_lines(500)::text), 'COMP_REFUND_ORDER_NOT_PAID');
    reset role;
  end loop;
end $blk$;
update public.event_orders set settlement_state = null where id = pg_temp.o1();

-- Partial refund on the real order (NULL settlement_state), then the Stripe refund succeeds
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_ok('R2CO: partial refund request on the checkout-built order is accepted',
  format($q$insert into t_kv values ('rq1', public.request_competition_order_refund(%L, %L, %L, %L::jsonb, 'Injury'))$q$, pg_temp.ev(1), pg_temp.o1(), pg_temp.rid('0010'), pg_temp.o1_lines(500)::text));
reset role;
select pg_temp.expect_ok('R2CO: Stripe reports the partial refund succeeded',
  format($q$select public.observe_competition_stripe_refund('pi_test_p10c_1', 'acct_p10cStudioA', 're_r2co_1', %L, 500, 'succeeded', 'evt_r2co_1')$q$, pg_temp.rid('0010')));
select pg_temp.chk('R2CO: partial: order partially_refunded, one succeeded 5.00 refund on the stored account, one dated refund entry',
  (select payment_status from public.event_orders where id = pg_temp.o1()) = 'partially_refunded'
  and (select status || '/' || amount_cents || '/' || stripe_account_id from public.event_order_refunds where refund_request_id = pg_temp.rid('0010')) = 'succeeded/500/acct_p10cStudioA'
  and (select count(*) from public.accounting_entries where category = 'competition_entry_refund' and source_id in (select id from public.event_order_refunds where order_id = pg_temp.o1())) = 1);

-- Cart style: settlement_state 'paid' (set by settle_event_cart_order) stays accepted; the rest of the order is refunded in full
update public.event_orders set settlement_state = 'paid' where id = pg_temp.o1();
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_ok('R2CO: a partially refunded order with settlement_state paid (cart style) accepts the remaining full refund',
  format($q$insert into t_kv values ('rq2', public.request_competition_order_refund(%L, %L, %L, %L::jsonb, 'Event cancelled'))$q$, pg_temp.ev(1), pg_temp.o1(), pg_temp.rid('0011'), pg_temp.o1_lines()::text));
reset role;
select pg_temp.expect_ok('R2CO: Stripe reports the remaining refund succeeded',
  format($q$select public.observe_competition_stripe_refund('pi_test_p10c_1', 'acct_p10cStudioA', 're_r2co_2', %L, %s, 'succeeded', 'evt_r2co_2')$q$, pg_temp.rid('0011'),
         (select (v->>'amountCents') from t_kv where k = 'rq2')));
select pg_temp.chk('R2CO: full: succeeded refunds total the captured 103.30; order, payment and registration refunded',
  (select sum(amount_cents) from public.event_order_refunds where order_id = pg_temp.o1() and status = 'succeeded') = 10330
  and (select payment_status from public.event_orders where id = pg_temp.o1()) = 'refunded'
  and (select status from public.event_payments where stripe_payment_intent_id = 'pi_test_p10c_1') = 'refunded'
  and (select payment_status from public.event_registrations where id = ((select v from t_kv where k = 'o1')->>'reg')::uuid) = 'refunded',
  (select coalesce(sum(amount_cents), -1)::text from public.event_order_refunds where order_id = pg_temp.o1() and status = 'succeeded'));
select pg_temp.chk('R2CO: competition revenue stays gross; two dated refund entries (one per succeeded refund)',
  (select count(*) from public.accounting_entries where category = 'competition_entry_refund' and source_id in (select id from public.event_order_refunds where order_id = pg_temp.o1())) = 2
  and exists (select 1 from public.accounting_entries where source_table = 'event_payments' and category = 'competition_entry_revenue' and entry_status = 'active' and gross_amount = 103.30));
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_msg('R2CO: a fully refunded order accepts no further refund',
  format($q$select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, 'again')$q$, pg_temp.ev(1), pg_temp.o1(), pg_temp.rid('0012'),
         jsonb_build_array(jsonb_build_object('orderItemId', pg_temp.o1_item(), 'amountCents', 100, 'withdrawEntry', false))::text), 'COMP_REFUND_ORDER_NOT_PAID');
reset role;

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results where name like 'R2CO:%';
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where name like 'R2CO:%' and not ok;
  if v_failures is null then
    raise exception 'R2 CHECKOUT ORDERS SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'R2 CHECKOUT ORDERS SUITE FAIL: %', v_failures;
end $$;
