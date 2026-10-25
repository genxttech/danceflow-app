-- Rollback of 20270112090000_competition_checkin_front_desk.sql: restores the exact 20270111090000 body of
-- record_competition_checkin_payment, removes the front-desk policies and the helper. Roll the APPLICATION back first.
-- Rows written by front-desk users stay; those users lose access again.

begin;

do $$
declare
  v_md5 text;
begin
  select md5(prosrc) into v_md5 from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment';
  if v_md5 is null or v_md5 not in ('a6de5932ce3894f944f0c4f2ef83be52', 'd852206591aebdc6f350fdb134ccecdb', '2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7') then
    raise exception 'CB-2 rollback refused: record_competition_checkin_payment is not the CB-2 or 20270111090000 body (md5 %).', v_md5;
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
declare t text;
begin
  foreach t in array array[
    'event_competition_checkin_sessions',
    'event_competition_checkin_participants',
    'event_competition_participant_waivers',
    'event_competition_credentials'
  ] loop
    execute format('drop policy if exists competition_checkin_select on public.%I', t);
    execute format('drop policy if exists competition_checkin_insert on public.%I', t);
    execute format('drop policy if exists competition_checkin_update on public.%I', t);
  end loop;
  foreach t in array array[
    'event_competition_entries',
    'event_competition_entry_participants',
    'event_competition_divisions',
    'event_competition_contest_registration_rules',
    'event_competition_registration_carts'
  ] loop
    execute format('drop policy if exists competition_checkin_read on public.%I', t);
  end loop;
end $$;

drop function if exists public.can_check_in_event_competition(uuid);

do $$
begin
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment') not in ('2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7') then
    raise exception 'CB-2 rollback postflight: restored body does not match the 20270111090000 pin.';
  end if;
end $$;

commit;
