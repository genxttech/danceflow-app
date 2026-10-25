-- CB-2 front-desk competition check-in (owner decision 2026-10-24: allow front_desk to perform competition admission,
-- mark attendance and collect authorized desk payments; NOT refunds, scratches, eligibility edits or heat changes).
--
-- Before: RLS on the four competition check-in tables used can_manage_event_competition, which excludes front_desk, so
-- a front-desk user could open the desk page (CI-B) but every read and write returned nothing.
-- After:
--   1. public.can_check_in_event_competition(event_id) = can_manage_event_competition(event_id) OR an active front_desk
--      role in the hosting studio.
--   2. Admission tables, least privilege (managers keep competition_manage = ALL):
--        event_competition_checkin_sessions       front desk: select, insert, update  (start/recalculate/complete a session)
--        event_competition_checkin_participants   front desk: select, insert, update  (arrival / presence)
--        event_competition_participant_waivers    front desk: select, insert          (staff-signed waiver is part of admission; signed rows immutable for it)
--        event_competition_credentials            front desk: select, insert          (issue a number; voiding stays manager-only)
--      No delete on any of them.
--   3. Read-only (SELECT) for front desk on what the desk screen and the session recalculation read: entries, entry
--      participants, divisions, contest registration rules, registration carts. No write policy is added, so
--      eligibility/verification edits, scratch, heat/schedule/division/lock/settings writes stay refused by RLS and by
--      the can_manage_event_competition checks inside the SECURITY DEFINER RPCs.
--   4. record_competition_checkin_payment (20270111090000 body) now authorizes through the helper; same role set.
--
-- Apply order: AFTER 20270111090000 (CI-B desk balance); SQL before app. Rollback: app first, then
-- rollback/20270112090000_competition_checkin_front_desk_rollback.sql.

begin;

do $$
declare
  v_md5 text;
begin
  select md5(prosrc) into v_md5 from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment';
  if v_md5 is null then
    raise exception 'CB-2 preflight: record_competition_checkin_payment is missing.';
  end if;
  -- The 20270111090000 body: LF (repo / local) or CRLF (Windows checkout, 10D gotcha); anything else is drift.
  if v_md5 not in ('2ec3f0f026cf2efad12eeb848b9058eb', 'e84c859505cc445528e5a040745056f7') then
    raise exception 'CB-2 preflight: record_competition_checkin_payment drifted from the 20270111090000 body (md5 %).', v_md5;
  end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null then
    raise exception 'CB-2 preflight: can_manage_event_competition is missing.';
  end if;
end $$;

create or replace function public.can_check_in_event_competition(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_event_competition(target_event_id)
    or exists (
      select 1
      from public.events e
      join public.user_studio_roles usr on usr.studio_id = e.studio_id
      where e.id = target_event_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role = 'front_desk'
    );
$$;

revoke all on function public.can_check_in_event_competition(uuid) from public, anon;
grant execute on function public.can_check_in_event_competition(uuid) to authenticated, service_role;

-- Admission tables: command-specific front-desk policies next to the existing competition_manage (ALL) policy.
do $$
declare
  t text;
  cmd text;
  spec text[];
begin
  foreach spec slice 1 in array array[
    array['event_competition_checkin_sessions', 'select,insert,update'],
    array['event_competition_checkin_participants', 'select,insert,update'],
    array['event_competition_participant_waivers', 'select,insert'],
    array['event_competition_credentials', 'select,insert']
  ] loop
    t := spec[1];
    foreach cmd in array string_to_array(spec[2], ',') loop
      execute format('drop policy if exists competition_checkin_%s on public.%I', cmd, t);
      if cmd = 'select' then
        execute format('create policy competition_checkin_select on public.%I for select to authenticated using (public.can_check_in_event_competition(event_id))', t);
      elsif cmd = 'insert' then
        execute format('create policy competition_checkin_insert on public.%I for insert to authenticated with check (public.can_check_in_event_competition(event_id))', t);
      else
        execute format('create policy competition_checkin_update on public.%I for update to authenticated using (public.can_check_in_event_competition(event_id)) with check (public.can_check_in_event_competition(event_id))', t);
      end if;
    end loop;
  end loop;
end $$;

-- Review hardening (CB-2 security review P1/P2/P3): the front desk keeps raw INSERT/UPDATE on the admission tables
-- (the desk screen recalculates and completes sessions itself), so a guard trigger makes the derived and
-- money-relevant columns trustworthy when the caller is a plain API role without competition-manager rights.
-- service_role and the superuser are not API roles and are exempt; the desk payment RPC runs under the caller's role setting and passes the guard on its own consistent writes.
--   sessions:     registration/order/cart/event links are immutable; a new session starts in_progress and not complete;
--                 payment_status 'complete' and status ready/complete need a zero balance computed from the order and
--                 captured payments; balance_due must equal that computed balance; status complete also needs every
--                 participant present/excused; waiver_status 'complete' needs every participant signed/waived/not_required;
--                 entry_status 'complete' and status ready/complete need confirmed, eligible and verified entries;
--                 completed_by must be the caller.
--   participants: waiver_status 'waived' is manager-only; 'signed' needs a signed waiver row; 'not_required' needs no
--                 required document; a present mark must carry the caller as checked_in_by.
-- credentials: the front desk may insert only issued credentials issued/assigned by itself.
-- waivers: no front-desk UPDATE policy (signed evidence is immutable for it; the app upserts with ignoreDuplicates).
create or replace function public._cb2_guard_checkin_writes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total numeric;
  v_paid numeric;
  v_balance numeric;
  v_order_ok boolean;
  v_entries_ok boolean;
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') not in ('authenticated', 'anon') then
    return new;
  end if;
  if public.can_manage_event_competition(new.event_id) then
    return new;
  end if;

  if tg_table_name = 'event_competition_checkin_participants' then
    if new.waiver_status = 'waived' and (tg_op = 'INSERT' or old.waiver_status is distinct from 'waived') then
      raise exception 'CB2: only a competition manager can waive a waiver' using errcode = '42501';
    end if;
    if new.waiver_status = 'signed' and (tg_op = 'INSERT' or old.waiver_status is distinct from 'signed')
       and not exists (select 1 from public.event_competition_participant_waivers w where w.checkin_participant_id = new.id) then
      raise exception 'CB2: a participant is signed only after a waiver is recorded' using errcode = '42501';
    end if;
    if new.waiver_status = 'not_required' and (tg_op = 'INSERT' or old.waiver_status is distinct from 'not_required')
       and exists (select 1 from public.event_document_requirements r where r.event_id = new.event_id and r.active = true and r.is_required = true) then
      raise exception 'CB2: this event has required waivers' using errcode = '42501';
    end if;
    if new.presence_status = 'present' and (tg_op = 'INSERT' or old.presence_status is distinct from 'present')
       and new.checked_in_by is distinct from auth.uid() then
      raise exception 'CB2: arrival must be recorded by the signed-in user' using errcode = '42501';
    end if;
    return new;
  end if;

  -- sessions
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id or new.registration_id is distinct from old.registration_id
       or new.order_id is distinct from old.order_id or new.registration_cart_id is distinct from old.registration_cart_id then
      raise exception 'CB2: a check-in session cannot be re-linked' using errcode = '42501';
    end if;
  else
    if new.status <> 'in_progress' or new.completed_at is not null or new.completed_by is not null
       or new.payment_status = 'complete' or new.waiver_status = 'complete' or new.entry_status = 'complete' then
      raise exception 'CB2: a new check-in session must start in progress' using errcode = '42501';
    end if;
    return new;
  end if;

  select coalesce(o.total_amount, 0), (o.payment_status not in ('refunded', 'failed') and o.status not in ('cancelled', 'expired', 'refunded'))
  into v_total, v_order_ok
  from public.event_orders o where o.id = new.order_id;
  select coalesce(sum(p.amount), 0) into v_paid
  from public.event_payments p where p.registration_id = new.registration_id and p.status in ('paid', 'refunded');
  v_balance := greatest(round(coalesce(v_total, 0) - v_paid, 2), 0);
  v_order_ok := coalesce(v_order_ok, false);

  select exists (
    select 1 from public.event_competition_entries e
    where e.event_id = new.event_id
      and ((new.registration_cart_id is not null and e.registration_cart_id = new.registration_cart_id)
        or (new.registration_cart_id is null and e.registration_id = new.registration_id))
  ) and not exists (
    select 1 from public.event_competition_entries e
    where e.event_id = new.event_id
      and ((new.registration_cart_id is not null and e.registration_cart_id = new.registration_cart_id)
        or (new.registration_cart_id is null and e.registration_id = new.registration_id))
      and not (e.status in ('confirmed', 'complete') and e.eligibility_status in ('eligible', 'waived') and e.verification_status in ('verified', 'corrected'))
  ) into v_entries_ok;

  if new.balance_due is distinct from old.balance_due and new.balance_due <> v_balance then
    raise exception 'CB2: balance_due must equal the order total minus captured payments' using errcode = '42501';
  end if;
  if new.payment_status = 'complete' and old.payment_status is distinct from 'complete' and not (v_balance = 0 and v_order_ok) then
    raise exception 'CB2: payment cannot be marked complete while a balance is due' using errcode = '42501';
  end if;
  if new.waiver_status = 'complete' and old.waiver_status is distinct from 'complete'
     and exists (select 1 from public.event_competition_checkin_participants cp where cp.checkin_session_id = new.id and cp.waiver_status not in ('signed', 'waived', 'not_required')) then
    raise exception 'CB2: waivers cannot be marked complete while a participant is missing one' using errcode = '42501';
  end if;
  if new.entry_status = 'complete' and old.entry_status is distinct from 'complete' and not v_entries_ok then
    raise exception 'CB2: entries cannot be marked complete before they are confirmed, eligible and verified' using errcode = '42501';
  end if;
  if new.status in ('ready', 'complete') and old.status is distinct from new.status then
    if not (v_balance = 0 and v_order_ok and v_entries_ok) then
      raise exception 'CB2: a session is ready only when paid in full with verified entries' using errcode = '42501';
    end if;
    if exists (select 1 from public.event_competition_checkin_participants cp where cp.checkin_session_id = new.id and cp.waiver_status not in ('signed', 'waived', 'not_required')) then
      raise exception 'CB2: a session is ready only when every waiver is in' using errcode = '42501';
    end if;
    if new.status = 'complete' and exists (select 1 from public.event_competition_checkin_participants cp where cp.checkin_session_id = new.id and cp.presence_status not in ('present', 'excused')) then
      raise exception 'CB2: a session completes only when every participant is present or excused' using errcode = '42501';
    end if;
  end if;
  if new.completed_by is not null and new.completed_by is distinct from old.completed_by and new.completed_by is distinct from auth.uid() then
    raise exception 'CB2: completion must be recorded by the signed-in user' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._cb2_guard_checkin_writes() from public, anon, authenticated;

drop trigger if exists cb2_guard_checkin_sessions on public.event_competition_checkin_sessions;
create trigger cb2_guard_checkin_sessions before insert or update on public.event_competition_checkin_sessions
for each row execute function public._cb2_guard_checkin_writes();
drop trigger if exists cb2_guard_checkin_participants on public.event_competition_checkin_participants;
create trigger cb2_guard_checkin_participants before insert or update on public.event_competition_checkin_participants
for each row execute function public._cb2_guard_checkin_writes();

-- Credentials: the front desk issues numbers as itself, as 'issued'; managers keep competition_manage (ALL).
drop policy if exists competition_checkin_insert on public.event_competition_credentials;
create policy competition_checkin_insert on public.event_competition_credentials for insert to authenticated
with check (public.can_manage_event_competition(event_id)
  or (public.can_check_in_event_competition(event_id) and status = 'issued' and issued_by = auth.uid() and assigned_by = auth.uid() and holder_type in ('participant', 'entry')));

-- Read-only access to the rows the desk screen and the session recalculation read.
do $$
declare t text;
begin
  foreach t in array array[
    'event_competition_entries',
    'event_competition_entry_participants',
    'event_competition_divisions',
    'event_competition_contest_registration_rules',
    'event_competition_registration_carts'
  ] loop
    execute format('drop policy if exists competition_checkin_read on public.%I', t);
    execute format('create policy competition_checkin_read on public.%I for select to authenticated using (public.can_check_in_event_competition(event_id))', t);
  end loop;
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
  -- CB-2: the same roles as before (platform admin, studio owner/admin/front desk of the hosting studio, organizer
  -- owner/admin/staff), now through the single helper that also gates the check-in tables' row level security.
  if not public.can_check_in_event_competition(p_event_id) then
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
  if v_md5 not in ('a6de5932ce3894f944f0c4f2ef83be52', 'd852206591aebdc6f350fdb134ccecdb') then
    raise exception 'CB-2 postflight: record_competition_checkin_payment body md5 % is not the expected one.', v_md5;
  end if;
  if not has_function_privilege('authenticated', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute') then
    raise exception 'CB-2 postflight: authenticated lost execute on record_competition_checkin_payment.';
  end if;
  if has_function_privilege('anon', 'public.can_check_in_event_competition(uuid)', 'execute') then
    raise exception 'CB-2 postflight: anon can execute can_check_in_event_competition.';
  end if;
end $$;

commit;
