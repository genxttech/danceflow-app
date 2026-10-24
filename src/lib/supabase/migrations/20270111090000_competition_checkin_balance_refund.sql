-- CI-B desk balance: refunds never appear as competition desk balance due.
--
-- Before: record_competition_checkin_payment computed v_paid = sum(amount - refund_amount) over status 'paid'
-- payments, so after an R2 refund (event_payments.refund_amount > 0; event_orders.total_amount is never lowered)
-- refunded money re-appeared as balance due, and a fully refunded payment (status 'refunded') dropped out entirely.
-- After: v_paid = sum(amount) over collected payments (status 'paid' or 'refunded'), i.e. balance = total - captured.
-- Only succeeded refunds ever write refund_amount (R2 _r2_recompute_order), and refund_amount is no longer read, so
-- pending / failed refunds cannot change the balance. Everything else in the function is unchanged except one
-- guard: a desk payment that settles the balance of a 'partially_refunded' order keeps that order (and the
-- registration's 'partial') state instead of overwriting it with 'paid'.
--
-- Apply order: AFTER 20270103090000 (R2) and PAY-WH-1A (20261116094000); SQL before app. Rollback: app first, then
-- rollback/20270111090000_competition_checkin_balance_refund_rollback.sql.

begin;

do $$
declare
  v_md5 text;
begin
  select md5(prosrc) into v_md5 from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment';
  if v_md5 is null then
    raise exception 'CI-B preflight: record_competition_checkin_payment is missing.';
  end if;
  -- LF body (repo / local) or the CRLF body a Windows checkout produces (10D gotcha); anything else is drift.
  if v_md5 not in ('387aacac2effd055340e27211b8f7e4f', '3ed808a49f21759971b9bf8084b3b6ec', '2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7') then
    raise exception 'CI-B preflight: record_competition_checkin_payment drifted from the PAY-WH-1A body (md5 %).', v_md5;
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

  -- CI-B: a refund settles captured money and never re-creates a debt, so the balance is total - captured (gross).
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
  set payment_status = case when v_remaining <= 0 and v_order.payment_status is distinct from 'partially_refunded' then 'paid' else 'partial' end,
      status = case when v_remaining <= 0 and status = 'pending' then 'confirmed' else status end,
      updated_at = now()
  where id = v_reg.id;
  if v_remaining <= 0 then
    update public.event_orders
    set payment_status = case when payment_status = 'partially_refunded' then payment_status else 'paid' end,
        status = case when status = 'pending' then 'confirmed' else status end,
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

do $$
declare
  v_md5 text;
begin
  select md5(prosrc) into v_md5 from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment';
  if v_md5 not in ('2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7') then
    raise exception 'CI-B postflight: record_competition_checkin_payment body md5 % is not the expected one.', v_md5;
  end if;
  if not has_function_privilege('authenticated', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute') then
    raise exception 'CI-B postflight: authenticated lost execute on record_competition_checkin_payment.';
  end if;
end $$;

commit;
