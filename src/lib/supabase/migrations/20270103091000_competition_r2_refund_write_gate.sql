-- 20270103091000_competition_r2_refund_write_gate.sql
--
-- CI-D / Competition R2 cutover GATE (separately reviewable; apply directly after 20270103090000).
--
-- Problem: after the R2 SQL lands but before the R2 application is deployed, the OLD webhook (and the generic
-- "refund event registration" staff action) still write refund state straight onto event_payments for a competition
-- order. That money never reaches the R2 ledger, the dated competition_entry_refund accounting entries or the RB3/RB3R
-- evidence, and the provider event is then marked processed, so the new app would never replay it.
--
-- Gate: a competition order's event_payments row may change its refund state (refund_amount, refunded_at,
-- stripe_refund_id, or move to / from status 'refunded') ONLY to the value the R2 ledger already proves: the new
-- refund_amount must equal the sum of the order's SUCCEEDED ledger refunds, and the status must be 'refunded' exactly
-- when that sum covers the captured amount. R2's own writer (_r2_recompute_order) always satisfies this (the ledger row
-- is already succeeded or reversed when it recomputes), so it needs no marker; any other writer (the old webhook, the
-- generic staff refund action) is refused with COMP_REFUND_LEDGER_GATE. The old webhook's thrown error finalises the
-- provider event as `failed` (complete_payment_provider_event), the route answers 500, the claim is retryable and Stripe
-- redelivers the same event, which the NEW app then records through observe_competition_stripe_refund.
--   * Non-competition payments are untouched (classified with the R2 helper).
--   * Inserts of an already-refunded competition payment row (generic action fallback) are gated the same way.
--   * Fail-open only when the R2 ledger does not exist (R2 rolled back): there the legacy path is the only path.
--   * The trigger is ENABLE ALWAYS (survives session_replication_role = replica).
-- Rollback: rollback/20270103091000_competition_r2_refund_write_gate_rollback.sql (drops the triggers and function only; touches no data). The gate is a mandatory
-- dependency of R2: request_competition_order_refund refuses (COMP_REFUND_GATE_MISSING) unless both triggers exist and are ENABLE ALWAYS, and this rollback is refused while R2 is
-- active, so roll back R2 first.

begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.event_order_refunds') is null
     or to_regclass('public.event_order_refund_allocations') is null
     or to_regprocedure('public._r2_event_payment_is_competition(uuid,text,text)') is null then
    raise exception 'R2 gate preflight: the R2 refund ledger (20270103090000) is not installed.';
  end if;
  if to_regprocedure('public._r2g_guard_event_payment_refund()') is not null
     or exists (select 1 from pg_trigger where tgname in ('r2g_guard_event_payment_refund_upd', 'r2g_guard_event_payment_refund_ins')
                and tgrelid = 'public.event_payments'::regclass and not tgisinternal) then
    raise exception 'R2 gate preflight: the gate already exists.';
  end if;
end $$;

create function public._r2g_guard_event_payment_refund()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_ledger bigint;
  v_captured bigint;
begin
  -- R2 rolled back: the ledger is gone and the legacy path is the only path.
  if to_regclass('public.event_order_refunds') is null then
    return new;
  end if;
  if not public._r2_event_payment_is_competition(new.registration_id, new.stripe_checkout_session_id, new.stripe_payment_intent_id) then
    return new;
  end if;

  select eo.id into v_order
  from public.event_orders eo
  where eo.id = (select er.order_id from public.event_registrations er where er.id = new.registration_id)
     or (new.stripe_payment_intent_id is not null and eo.stripe_payment_intent_id = new.stripe_payment_intent_id)
  order by (eo.id = (select er.order_id from public.event_registrations er where er.id = new.registration_id)) desc
  limit 1;

  select coalesce(sum(r.amount_cents) filter (where r.status = 'succeeded'), 0) into v_ledger
  from public.event_order_refunds r where r.order_id = v_order;
  v_captured := round(coalesce(new.amount, 0) * 100)::bigint;

  if round(coalesce(new.refund_amount, 0) * 100)::bigint is distinct from v_ledger
     or (new.status::text = 'refunded') is distinct from (v_ledger > 0 and v_ledger >= v_captured)
     -- a refund id written onto the payment must be one the ledger holds for this order
     or (new.stripe_refund_id is not null and (tg_op = 'INSERT' or new.stripe_refund_id is distinct from old.stripe_refund_id)
         and not exists (select 1 from public.event_order_refunds r where r.order_id = v_order and r.stripe_refund_id = new.stripe_refund_id)) then
    raise exception 'COMP_REFUND_LEDGER_GATE: a competition payment''s refund state is written only by the R2 refund ledger (ledger % cents, write % cents, status %). Deploy the R2 application; the event will be redelivered.',
      v_ledger, round(coalesce(new.refund_amount, 0) * 100)::bigint, new.status::text
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._r2g_guard_event_payment_refund() from public, anon, authenticated, service_role;

create trigger r2g_guard_event_payment_refund_upd
  before update on public.event_payments
  for each row
  when (old.refund_amount is distinct from new.refund_amount
        or old.refunded_at is distinct from new.refunded_at
        or old.stripe_refund_id is distinct from new.stripe_refund_id
        or old.status::text is distinct from new.status::text and (old.status::text = 'refunded' or new.status::text = 'refunded'))
  execute function public._r2g_guard_event_payment_refund();
create trigger r2g_guard_event_payment_refund_ins
  before insert on public.event_payments
  for each row
  when (coalesce(new.refund_amount, 0) > 0 or new.status::text = 'refunded' or new.stripe_refund_id is not null)
  execute function public._r2g_guard_event_payment_refund();
alter table public.event_payments enable always trigger r2g_guard_event_payment_refund_upd;
alter table public.event_payments enable always trigger r2g_guard_event_payment_refund_ins;

do $$
begin
  if (select count(*) from pg_trigger where tgname in ('r2g_guard_event_payment_refund_upd', 'r2g_guard_event_payment_refund_ins')
        and tgrelid = 'public.event_payments'::regclass and tgenabled = 'A' and not tgisinternal) <> 2 then
    raise exception 'R2 gate postflight: the gate triggers are missing or not ENABLE ALWAYS.';
  end if;
  if has_function_privilege('anon', 'public._r2g_guard_event_payment_refund()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._r2g_guard_event_payment_refund()', 'EXECUTE') then
    raise exception 'R2 gate postflight: the gate function must not be executable by clients.';
  end if;
end $$;

commit;
