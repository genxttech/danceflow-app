-- 20270211090000_competition_checkin_balance_refund.sql
-- CI-B desk balance: a refund never re-appears as competition desk balance due.
--   Bug: record_competition_checkin_payment computed v_paid = sum(amount - refund_amount) over payments with status 'paid'.
--   R2 (20270103090000) records a refund as event_payments.refund_amount (succeeded ledger sum) and sets the Stripe payment
--   to status 'refunded' once fully refunded, and it NEVER lowers event_orders.total_amount. So after an R2 refund the refunded
--   amount counted as unpaid balance (and a fully refunded payment dropped out entirely), and the desk could collect it again.
--   Fix: balance = total - captured gross, captured = sum(amount) over payments with status 'paid' or 'refunded'.
--   refund_amount is no longer read. Everything else in the function is byte-for-byte the D7 body (20270205100000): auth,
--   role check, validation, locks, refusal rules, D7 Organizer Suite gate, writes, audit, return shape. Signature, SECURITY
--   DEFINER, search_path, owner and grants are unchanged.
--   Pin: the current body must be exactly the D7 body (md5 of the CR-stripped pg_get_functiondef 70285eaf8c11f4cb34cb487fa1d3f47a, the PROD body); anything
--   else raises and nothing is changed. Requires 20270205100000 applied (D7 body). Idempotent: re-running on the new body is refused
--   by the pin (use the rollback first).
--   Order: SQL before the app or after it (old app is safe with the new body; see CIB-PROPOSAL.md). Rollback:
--   rollback/20270211090000_competition_checkin_balance_refund_rollback.sql (restores the exact D7 body, hash-verified).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_md5 text;
  v_n int;
begin
  select count(*) into v_n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment';
  if v_n <> 1 then
    raise exception 'CI-B preflight: expected exactly one public.record_competition_checkin_payment, found %.', v_n;
  end if;
  select md5(replace(pg_get_functiondef(oid), E'\r', '')) into v_md5 from pg_proc
  where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)');
  if v_md5 is null then
    raise exception 'CI-B preflight: public.record_competition_checkin_payment(uuid,uuid,numeric,text,text) is missing.';
  end if;
  if v_md5 <> '70285eaf8c11f4cb34cb487fa1d3f47a' then
    raise exception 'CI-B preflight: record_competition_checkin_payment is not the D7 body (md5 %, expected 70285eaf8c11f4cb34cb487fa1d3f47a); refusing to replace it.', v_md5;
  end if;
end $$;

create or replace function public.record_competition_checkin_payment(
  p_event_id uuid, p_session_id uuid, p_amount numeric, p_payment_method text, p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_event public.events%rowtype;
  v_session record;
  v_reg public.event_registrations%rowtype;
  v_order public.event_orders%rowtype;
  v_paid numeric;
  v_balance numeric;
  v_remaining numeric;
  v_payment uuid;
  v_currency text;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;
  -- Same roles as the desk page: studio owner/admin/front desk, organizer owner/admin/staff, platform admin.
  if not (
    exists (select 1 from public.profiles p where p.id = v_user and p.platform_role = 'platform_admin')
    or exists (select 1 from public.user_studio_roles usr
               where usr.studio_id = v_event.studio_id and usr.user_id = v_user and usr.active = true
                 and usr.role in ('studio_owner', 'studio_admin', 'front_desk'))
    or (v_event.organizer_id is not null and exists (
          select 1 from public.organizer_users ou
          where ou.organizer_id = v_event.organizer_id and ou.user_id = v_user and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')))
  ) then
    raise exception 'not authorized to record competition desk payments for this event' using errcode = '42501';
  end if;
  if p_payment_method not in ('cash', 'check', 'external_card', 'other') then
    raise exception 'invalid payment method' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'invalid amount' using errcode = '22023';
  end if;

  select id, registration_id, order_id, status into v_session
  from public.event_competition_checkin_sessions
  where id = p_session_id and event_id = p_event_id
  for update;
  if not found or v_session.registration_id is null or v_session.order_id is null then
    raise exception 'check-in session or its registration was not found' using errcode = 'P0002';
  end if;
  if v_session.status = 'complete' then
    raise exception 'this check-in session is already complete' using errcode = '55000';
  end if;
  select * into v_order from public.event_orders where id = v_session.order_id and event_id = p_event_id for update;
  if not found or coalesce(v_order.metadata ->> 'source', '') <> 'competition_registration' then
    raise exception 'desk payments apply only to competition registrations' using errcode = '22023';
  end if;
  if v_order.status in ('cancelled', 'expired', 'refunded') or v_order.payment_status in ('refunded', 'failed') then
    raise exception 'this competition order is not payable' using errcode = '55000';
  end if;
  select * into v_reg from public.event_registrations
  where id = v_session.registration_id and event_id = p_event_id and order_id = v_order.id for update;
  if not found or v_reg.status in ('cancelled', 'refunded') then
    raise exception 'this competition registration is not payable' using errcode = '55000';
  end if;

  -- D7 (Organizer Suite desk gate): completing an UNPAID PENDING order of an ORGANIZER event needs a current Organizer Suite
  -- entitlement (same decision as the app gate in competition/checkin/actions.ts). Every existing refusal above runs first;
  -- this runs before any write, so a refusal records nothing. Confirmed / already-paid orders and ordinary studio events
  -- (no organizer) are never gated.
  if v_event.organizer_id is not null
     and v_order.status = 'pending'
     and v_order.payment_status is distinct from 'paid'
     and not public._d7_competition_desk_suite_allows(v_event.studio_id, now()) then
    raise exception 'organizer_suite_required: this organizer is not accepting new registrations or payments for this event right now'
      using errcode = 'D7001';
  end if;

  -- CI-B: a refund settles money that was already captured and never re-creates a debt (R2 leaves event_orders.total_amount
  -- unchanged and records refunds in event_payments.refund_amount / status 'refunded'), so balance = total - captured gross.
  select coalesce(sum(amount), 0) into v_paid
  from public.event_payments where registration_id = v_reg.id and status in ('paid', 'refunded');
  v_balance := greatest(round(coalesce(v_order.total_amount, 0) - v_paid, 2), 0);
  if p_amount > v_balance then
    raise exception 'payment exceeds the current balance (%)', v_balance using errcode = '22023';
  end if;
  v_remaining := round(v_balance - p_amount, 2);
  v_currency := coalesce(v_order.currency, v_reg.currency, 'USD');

  insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, notes)
  values (v_reg.id, p_amount, v_currency, p_payment_method, 'paid', 'competition_checkin',
          left(coalesce(nullif(btrim(p_notes), ''), 'Collected at competition registration-desk check-in.'), 1000))
  returning id into v_payment;

  update public.event_registrations
  set payment_status = case when v_remaining <= 0 then 'paid' else 'partial' end,
      status = case when v_remaining <= 0 and status = 'pending' then 'confirmed' else status end,
      updated_at = now()
  where id = v_reg.id;
  if v_remaining <= 0 then
    update public.event_orders
    set payment_status = 'paid', status = case when status = 'pending' then 'confirmed' else status end,
        paid_at = coalesce(paid_at, now()), updated_at = now()
    where id = v_order.id;
  end if;
  update public.event_competition_checkin_sessions set balance_due = v_remaining, updated_at = now() where id = p_session_id;

  insert into public.event_competition_checkin_payment_audit (
    event_id, checkin_session_id, registration_id, order_id, event_payment_id, amount, currency, payment_method,
    balance_before, balance_after, actor_user_id
  ) values (p_event_id, p_session_id, v_reg.id, v_order.id, v_payment, p_amount, v_currency, p_payment_method,
            v_balance, v_remaining, v_user);

  return jsonb_build_object('outcome', 'recorded', 'event_payment_id', v_payment, 'balance_before', v_balance, 'balance_after', v_remaining);
end;
$$;

revoke all on function public.record_competition_checkin_payment(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.record_competition_checkin_payment(uuid, uuid, numeric, text, text) to authenticated;

do $$
declare
  v_md5 text;
  v_def boolean;
begin
  select md5(replace(pg_get_functiondef(oid), E'\r', '')), prosecdef into v_md5, v_def from pg_proc
  where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)');
  if v_md5 is distinct from 'f7ff073516597c474c59189df7b3e0d2' then
    raise exception 'CI-B postflight: record_competition_checkin_payment definition md5 % is not the expected f7ff073516597c474c59189df7b3e0d2.', v_md5;
  end if;
  if v_def is not true then
    raise exception 'CI-B postflight: record_competition_checkin_payment is not SECURITY DEFINER.';
  end if;
  if not has_function_privilege('authenticated', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute')
     or has_function_privilege('anon', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute') then
    raise exception 'CI-B postflight: record_competition_checkin_payment grants are not authenticated-only.';
  end if;
end $$;

commit;
