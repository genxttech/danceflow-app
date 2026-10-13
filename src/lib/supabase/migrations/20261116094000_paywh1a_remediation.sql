-- PAY-WH-1A M5 -- Remediation of the PAY-WH-1 final audit (forward migration; requires 20261116090000..093000).
--
--   H-1  Captured-payment exceptions become actionable: money classification, acknowledgement/resolution with an audit
--        trail, a durable leased alert queue (branded staff email + in-app notification, sent by the cron), and dead
--        settlement-outbox effects / stuck reconciles raise exceptions too.
--   M-2  Box-office capacity: unpaid orderless registrations are capacity-checked again (as before PAY-WH-1), a
--        card-reader sale reserves its tickets for a short terminal hold, and terminal fulfilment confirms through a
--        locked function that records an exception (never a silent failure) when a charge cannot be fulfilled.
--   M-1  Competition desk payments go through a narrowly scoped SECURITY DEFINER function (manager authorization,
--        competition source, balance and state checks, audit row) instead of blocked client writes.
--   L-1  Sweeper backoff + "reconcile_stuck" exception.   L-2  Guard lookup helpers callable only from triggers.
--   L-3  Attendee entitlement guard serialises on the registration row.
--
-- No refunds, no automatic fulfilment, no resurrection of released orders. Competition registration stays OFF.
-- Rollback: rollback/20261116094000_paywh1a_remediation_rollback.sql.

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.settle_event_cart_order(text, text, uuid, text, text, text, bigint, text)') is null
     or to_regclass('public.event_settlement_outbox') is null
     or to_regprocedure('public._paywh1_guard_order_attendee_writes()') is null then
    raise exception 'paywh1a: apply 20261116090000..20261116093000 first';
  end if;
end $$;

-- =================================================================================================================
-- H-1  Settlement exceptions: classification, acknowledgement, audit trail, alert queue
-- =================================================================================================================
alter table public.event_order_settlement_exceptions
  add column if not exists money_state text not null default 'informational',
  add column if not exists registration_id uuid null references public.event_registrations(id) on delete set null,
  add column if not exists payment_id uuid null,
  add column if not exists acknowledged_at timestamptz null,
  add column if not exists acknowledged_by uuid null,
  add column if not exists acknowledgement_note text null,
  add column if not exists alert_status text not null default 'not_required',
  add column if not exists alert_attempts integer not null default 0,
  add column if not exists alert_next_at timestamptz null,
  add column if not exists alert_claim_owner uuid null,
  add column if not exists alert_claim_expires_at timestamptz null,
  add column if not exists alert_sent_at timestamptz null,
  add column if not exists alert_last_error text null;

alter table public.event_order_settlement_exceptions drop constraint if exists event_order_settlement_exceptions_status_check;
alter table public.event_order_settlement_exceptions
  add constraint event_order_settlement_exceptions_status_check check (status in ('open', 'acknowledged', 'resolved'));
alter table public.event_order_settlement_exceptions drop constraint if exists event_order_settlement_exceptions_money_state_check;
alter table public.event_order_settlement_exceptions
  add constraint event_order_settlement_exceptions_money_state_check
  check (money_state in ('captured', 'reversed', 'in_flight', 'operational', 'informational'));
alter table public.event_order_settlement_exceptions drop constraint if exists event_order_settlement_exceptions_alert_status_check;
alter table public.event_order_settlement_exceptions
  add constraint event_order_settlement_exceptions_alert_status_check
  check (alert_status in ('not_required', 'pending', 'processing', 'sent', 'failed'));
alter table public.event_order_settlement_exceptions drop constraint if exists event_order_settlement_exceptions_alert_claim_check;
alter table public.event_order_settlement_exceptions
  add constraint event_order_settlement_exceptions_alert_claim_check
  check (alert_status <> 'processing' or (alert_claim_owner is not null and alert_claim_expires_at is not null));

create index if not exists event_order_settlement_exceptions_alert_due_idx
  on public.event_order_settlement_exceptions (alert_next_at) where alert_status in ('pending', 'processing');
create index if not exists event_order_settlement_exceptions_event_idx
  on public.event_order_settlement_exceptions (event_id, created_at);

-- What happened to the money. captured: the buyer was charged and nothing (or the wrong thing) was fulfilled.
-- reversed: a settled payment later failed. in_flight: a delayed payment is still processing (no money yet).
-- operational: settlement succeeded but a follow-up could not complete / an order cannot be reconciled.
create or replace function public._paywh1_exception_money_state(p_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_kind in ('late_payment_after_release', 'duplicate_payment', 'paid_capacity_unavailable',
                    'unknown_payment_reference', 'settlement_integrity_conflict',
                    'terminal_paid_capacity_unavailable', 'terminal_payment_unfulfilled')
         or p_kind like 'mismatch\_%' and p_kind not in ('mismatch_processing', 'mismatch_failure_account') then 'captured'
    when p_kind = 'failure_after_settlement' then 'reversed'
    when p_kind in ('processing_hold_lapsed', 'mismatch_processing', 'processing_after_release') then 'in_flight'
    when p_kind in ('settlement_effect_dead', 'reconcile_stuck') then 'operational'
    else 'informational'
  end;
$$;

update public.event_order_settlement_exceptions
set money_state = public._paywh1_exception_money_state(kind),
    alert_status = case when status = 'open' and public._paywh1_exception_money_state(kind) in ('captured', 'reversed', 'operational')
                        then 'pending' else 'not_required' end,
    alert_next_at = case when status = 'open' and public._paywh1_exception_money_state(kind) in ('captured', 'reversed', 'operational')
                         then now() else null end
where alert_status = 'not_required' and money_state = 'informational';

create table if not exists public.event_order_settlement_exception_events (
  id uuid primary key default gen_random_uuid(),
  exception_id uuid not null references public.event_order_settlement_exceptions(id) on delete cascade,
  action text not null check (action in ('recorded', 'recurred', 'alert_sent', 'alert_failed', 'acknowledged', 'resolved')),
  actor_user_id uuid null,
  note text null,
  created_at timestamptz not null default now()
);
create index if not exists event_order_settlement_exception_events_exception_idx
  on public.event_order_settlement_exception_events (exception_id, created_at);
alter table public.event_order_settlement_exception_events enable row level security;
revoke all on public.event_order_settlement_exception_events from public, anon, authenticated;
grant select on public.event_order_settlement_exception_events to authenticated;
grant select, insert on public.event_order_settlement_exception_events to service_role;

-- Visibility: event managers (studio owner/admin, organizer owner/admin) and platform admins. An exception that
-- names no event (unknown payment reference) is visible to its studio's owners/admins and to platform admins.
create or replace function public._paywh1_actor_can_manage_exception(p_event_id uuid, p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
    or (p_event_id is not null and public._paywh1_actor_can_manage_event(p_event_id))
    or (p_event_id is null and p_studio_id is not null and exists (
          select 1 from public.user_studio_roles usr
          where usr.studio_id = p_studio_id and usr.user_id = auth.uid() and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin')))
  );
$$;
revoke all on function public._paywh1_actor_can_manage_exception(uuid, uuid) from public, anon;
grant execute on function public._paywh1_actor_can_manage_exception(uuid, uuid) to authenticated, service_role;

drop policy if exists event_order_settlement_exceptions_manager_select on public.event_order_settlement_exceptions;
create policy event_order_settlement_exceptions_manager_select
  on public.event_order_settlement_exceptions for select to authenticated
  using (public._paywh1_actor_can_manage_exception(event_id, studio_id));

drop policy if exists event_order_settlement_exception_events_manager_select on public.event_order_settlement_exception_events;
create policy event_order_settlement_exception_events_manager_select
  on public.event_order_settlement_exception_events for select to authenticated
  using (exists (select 1 from public.event_order_settlement_exceptions x
                 where x.id = exception_id and public._paywh1_actor_can_manage_exception(x.event_id, x.studio_id)));

-- Recorder (same signature as 092000). Classifies the money state and queues the staff alert in the SAME transaction
-- as the exception, so an alert is never lost and never sent for an exception that rolled back. A recurrence (webhook
-- replay) is counted, never re-alerted; an exception with no order is attributed to the studio owning the account.
create or replace function public._paywh1_record_exception(
  p_order_id uuid, p_kind text, p_event_id text, p_account text, p_session text, p_pi text,
  p_amount_cents bigint, p_currency text, p_details jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_studio uuid;
  v_event uuid;
  v_registration uuid;
  v_money text := public._paywh1_exception_money_state(p_kind);
  v_alert boolean := public._paywh1_exception_money_state(p_kind) in ('captured', 'reversed', 'operational');
  v_inserted boolean;
begin
  if p_order_id is not null then
    select studio_id, event_id into v_studio, v_event from public.event_orders where id = p_order_id;
  elsif p_account is not null then
    select id into v_studio from public.studios where stripe_connected_account_id = p_account limit 1;
  end if;
  select er.id into v_registration from public.event_registrations er
  where er.id = nullif(p_details ->> 'registration_id', '')::uuid;
  if v_studio is null and v_registration is not null then
    select studio_id into v_studio from public.event_registrations where id = v_registration;
  end if;
  insert into public.event_order_settlement_exceptions as x (
    order_id, studio_id, event_id, registration_id, payment_id, kind, money_state, stripe_event_id, stripe_account_id,
    stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, currency, details,
    alert_status, alert_next_at
  )
  values (p_order_id, v_studio, coalesce(v_event, nullif(p_details ->> 'event_id', '')::uuid), v_registration,
          nullif(p_details ->> 'payment_id', '')::uuid, p_kind, v_money, p_event_id, p_account, p_session, p_pi,
          p_amount_cents, lower(p_currency), coalesce(p_details, '{}'::jsonb),
          case when v_alert then 'pending' else 'not_required' end, case when v_alert then now() else null end)
  on conflict (kind, coalesce(order_id::text, ''), coalesce(stripe_payment_intent_id, ''), coalesce(stripe_checkout_session_id, ''))
  do update set occurrences = x.occurrences + 1, last_seen_at = now(),
                stripe_event_id = coalesce(excluded.stripe_event_id, x.stripe_event_id),
                details = x.details || excluded.details,
                status = case when x.status = 'resolved' and x.money_state = 'operational' then 'open' else x.status end,
                resolved_at = case when x.status = 'resolved' and x.money_state = 'operational' then null else x.resolved_at end,
                alert_status = case when x.status = 'resolved' and x.money_state = 'operational' then 'pending' else x.alert_status end,
                alert_attempts = case when x.status = 'resolved' and x.money_state = 'operational' then 0 else x.alert_attempts end,
                alert_next_at = case when x.status = 'resolved' and x.money_state = 'operational' then now() else x.alert_next_at end
  returning id, (xmax = 0) into v_id, v_inserted;
  insert into public.event_order_settlement_exception_events (exception_id, action, note)
  values (v_id, case when v_inserted then 'recorded' else 'recurred' end, p_kind);
  return v_id;
end;
$$;
revoke all on function public._paywh1_record_exception(uuid, text, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;

create or replace function public.acknowledge_event_order_settlement_exception(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_x public.event_order_settlement_exceptions%rowtype;
begin
  select * into v_x from public.event_order_settlement_exceptions where id = p_exception_id for update;
  if not found then
    return false;
  end if;
  if not public._paywh1_actor_can_manage_exception(v_x.event_id, v_x.studio_id) then
    raise exception 'not authorized to acknowledge this settlement exception' using errcode = '42501';
  end if;
  if v_x.status <> 'open' then
    return false;
  end if;
  update public.event_order_settlement_exceptions
  set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = auth.uid(),
      acknowledgement_note = nullif(left(btrim(coalesce(p_note, '')), 2000), '')
  where id = p_exception_id;
  insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
  values (p_exception_id, 'acknowledged', auth.uid(), nullif(left(btrim(coalesce(p_note, '')), 2000), ''));
  return true;
end;
$$;
revoke all on function public.acknowledge_event_order_settlement_exception(uuid, text) from public, anon;
grant execute on function public.acknowledge_event_order_settlement_exception(uuid, text) to authenticated;

-- Resolution (after a manual refund decision, re-issued tickets, etc.). Never moves money. Requires a note.
create or replace function public.resolve_event_order_settlement_exception(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_x public.event_order_settlement_exceptions%rowtype;
begin
  select * into v_x from public.event_order_settlement_exceptions where id = p_exception_id for update;
  if not found then
    return false;
  end if;
  if not public._paywh1_actor_can_manage_exception(v_x.event_id, v_x.studio_id) then
    raise exception 'not authorized to resolve this settlement exception' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  if v_x.status not in ('open', 'acknowledged') then
    return false;
  end if;
  update public.event_order_settlement_exceptions
  set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = left(p_note, 2000),
      -- a resolved exception no longer needs its alert
      alert_status = case when alert_status in ('pending', 'failed') then 'not_required' else alert_status end,
      alert_next_at = case when alert_status in ('pending', 'failed') then null else alert_next_at end
  where id = p_exception_id;
  insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
  values (p_exception_id, 'resolved', auth.uid(), left(p_note, 2000));
  return true;
end;
$$;
revoke all on function public.resolve_event_order_settlement_exception(uuid, text) from public, anon;
grant execute on function public.resolve_event_order_settlement_exception(uuid, text) to authenticated;

-- Alert queue (service_role). Leased like the outbox; delivery is idempotent per exception and recipient.
create or replace function public.claim_settlement_exception_alerts(p_owner uuid, p_limit integer default 20, p_lease_seconds integer default 120)
returns setof public.event_order_settlement_exceptions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner is null then
    raise exception 'claim_settlement_exception_alerts: owner is required' using errcode = '22023';
  end if;
  -- a worker that dies on every attempt still ends in 'failed' (visible on the exception and platform pages)
  update public.event_order_settlement_exceptions x
  set alert_status = 'failed', alert_claim_owner = null, alert_claim_expires_at = null,
      alert_last_error = coalesce(x.alert_last_error, 'alert worker lease expired on every attempt')
  where x.alert_status = 'processing' and x.alert_claim_expires_at <= now() and x.alert_attempts >= 8;

  return query
  with due as (
    select x.id from public.event_order_settlement_exceptions x
    where x.status <> 'resolved'
      and ((x.alert_status = 'pending' and coalesce(x.alert_next_at, now()) <= now())
           or (x.alert_status = 'processing' and x.alert_claim_expires_at <= now() and coalesce(x.alert_next_at, now()) <= now()))
    order by x.created_at
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update skip locked
  )
  update public.event_order_settlement_exceptions x
  set alert_status = 'processing', alert_claim_owner = p_owner,
      alert_claim_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      alert_next_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900))
                            + make_interval(mins => least(power(2, least(x.alert_attempts, 8))::integer, 240)),
      alert_attempts = x.alert_attempts + 1
  from due
  where x.id = due.id
  returning x.*;
end;
$$;

create or replace function public.complete_settlement_exception_alert(p_exception_id uuid, p_owner uuid, p_ok boolean, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update public.event_order_settlement_exceptions
    set alert_status = 'sent', alert_sent_at = now(), alert_claim_owner = null, alert_claim_expires_at = null,
        alert_next_at = null, alert_last_error = null
    where id = p_exception_id and alert_status = 'processing' and alert_claim_owner = p_owner;
  else
    update public.event_order_settlement_exceptions
    set alert_status = case when alert_attempts >= 8 then 'failed' else 'pending' end,
        alert_last_error = left(coalesce(p_error, 'failed'), 2000),
        alert_next_at = now() + make_interval(mins => least(power(2, least(alert_attempts, 8))::integer, 240)),
        alert_claim_owner = null, alert_claim_expires_at = null
    where id = p_exception_id and alert_status = 'processing' and alert_claim_owner = p_owner;
  end if;
  if found then
    insert into public.event_order_settlement_exception_events (exception_id, action, note)
    values (p_exception_id, case when p_ok then 'alert_sent' else 'alert_failed' end, case when p_ok then null else left(p_error, 500) end);
  end if;
  return found;
end;
$$;
revoke all on function public.claim_settlement_exception_alerts(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_settlement_exception_alert(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_settlement_exception_alerts(uuid, integer, integer) to service_role;
grant execute on function public.complete_settlement_exception_alert(uuid, uuid, boolean, text) to service_role;

-- In-app notification type for the alert. The existing CHECK list is extended in place (its current definition is
-- kept verbatim, whatever list this database has) and saved for the rollback.
create table if not exists public._paywh1a_saved_constraints (
  table_name text not null,
  constraint_name text not null,
  definition text not null,
  saved_at timestamptz not null default now(),
  primary key (table_name, constraint_name)
);
revoke all on public._paywh1a_saved_constraints from public, anon, authenticated;

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
  where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  if v_def is null then
    raise exception 'paywh1a: notifications_type_check not found';
  end if;
  if position('payment_exception' in v_def) > 0 then
    return; -- already extended
  end if;
  insert into public._paywh1a_saved_constraints (table_name, constraint_name, definition)
  values ('notifications', 'notifications_type_check', v_def)
  on conflict (table_name, constraint_name) do nothing;
  execute 'alter table public.notifications drop constraint notifications_type_check';
  execute format('alter table public.notifications add constraint notifications_type_check check ((%s) or type = %L)',
                 regexp_replace(v_def, '^CHECK \((.*)\)$', '\1'), 'payment_exception');
end $$;

-- Dead settlement effects are exceptions too (operational; alert staff).
create or replace function public._paywh1_outbox_dead_exception()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'dead' and old.status is distinct from 'dead' then
    perform public._paywh1_record_exception(new.order_id, 'settlement_effect_dead', null, null, null, null, null, null,
      jsonb_build_object('effect', new.effect, 'outbox_id', new.id, 'attempts', new.attempts, 'last_error', left(coalesce(new.last_error, ''), 500)));
  end if;
  return new;
end;
$$;
revoke all on function public._paywh1_outbox_dead_exception() from public, anon, authenticated;
drop trigger if exists trg_paywh1_outbox_dead_exception on public.event_settlement_outbox;
create trigger trg_paywh1_outbox_dead_exception
  after update of status on public.event_settlement_outbox
  for each row execute function public._paywh1_outbox_dead_exception();

-- =================================================================================================================
-- L-1  Sweeper backoff: an order that keeps failing to reconcile backs off and, after repeated failures, becomes an
--      operational exception instead of being re-listed forever (and starving other orders).
-- =================================================================================================================
alter table public.event_orders
  add column if not exists reconcile_attempts integer not null default 0,
  add column if not exists reconcile_next_at timestamptz null;

create or replace function public.note_event_cart_reconcile_outcome(p_order_id uuid, p_ok boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
begin
  if p_ok then
    update public.event_orders set reconcile_attempts = 0, reconcile_next_at = null where id = p_order_id and reconcile_attempts > 0;
    return jsonb_build_object('outcome', 'ok');
  end if;
  update public.event_orders
  set reconcile_attempts = reconcile_attempts + 1,
      reconcile_next_at = now() + make_interval(mins => least(power(2, least(reconcile_attempts, 8))::integer * 5, 360))
  where id = p_order_id
  returning reconcile_attempts into v_attempts;
  if v_attempts = 6 then
    perform public._paywh1_record_exception(p_order_id, 'reconcile_stuck', null, null, null, null, null, null,
      jsonb_build_object('attempts', v_attempts, 'last_error', left(coalesce(p_error, ''), 500)));
  end if;
  return jsonb_build_object('outcome', 'backoff', 'attempts', v_attempts);
end;
$$;
revoke all on function public.note_event_cart_reconcile_outcome(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.note_event_cart_reconcile_outcome(uuid, boolean, text) to service_role;

create or replace function public.list_event_cart_orders_due_for_reconcile(p_limit integer default 50)
returns table (order_id uuid, state text, expires_at timestamptz, retry_final_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- retry_final_state: a stalled release keeps its own outcome. begin_event_cart_order_release extends a still-valid
  -- hold past the request, so a hold that had already lapsed when the release began was an expiry.
  select o.id, public._paywh1_effective_state(o.status, o.payment_status, o.settlement_state), o.expires_at,
         case when o.expires_at is not null and o.release_requested_at is not null and o.expires_at <= o.release_requested_at
              then 'expired' else 'released' end
  from public.event_orders o
  where o.status = 'pending' and o.payment_status = 'pending'
    and coalesce(o.metadata ->> 'source', '') <> 'competition_registration'
    and (o.reconcile_next_at is null or o.reconcile_next_at <= now())
    and (
      (coalesce(o.settlement_state, 'pending') = 'pending' and o.expires_at is not null and o.expires_at <= now())
      or (o.settlement_state = 'processing' and o.expires_at is not null and o.expires_at <= now()
          and not exists (select 1 from public.event_order_settlement_exceptions x
                          where x.order_id = o.id and x.kind = 'processing_hold_lapsed' and x.status = 'open'))
      or (o.settlement_state = 'releasing' and o.release_requested_at <= now() - interval '5 minutes')
    )
  order by o.reconcile_attempts, o.expires_at nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- =================================================================================================================
-- M-2  Box-office capacity
-- =================================================================================================================
alter table public.event_registrations add column if not exists terminal_hold_until timestamptz null;

-- Capacity check (replaces 092000's version). Every row that reserves or consumes capacity is checked, including an
-- unpaid orderless row (box office / manual) exactly as before PAY-WH-1; an orderless row reserves capacity only while
-- its terminal hold is valid. Rows being cancelled/expired/failed are never blocked.
create or replace function public.enforce_event_ticket_capacity_holds()
returns trigger
language plpgsql
as $$
declare
  ticket_capacity integer;
  reserved_admissions integer;
  requested_admissions integer;
  admits_per_ticket integer;
  new_order_holds boolean;
begin
  if new.ticket_type_id is null then
    return new;
  end if;

  if new.payment_status = 'paid' or new.status in ('confirmed', 'checked_in', 'attended') then
    null; -- consumes capacity
  elsif new.status = 'pending' and new.payment_status = 'pending' and new.order_id is not null then
    select (eo.status = 'pending' and eo.payment_status = 'pending' and (eo.expires_at is null or eo.expires_at > now()))
    into new_order_holds
    from public.event_orders eo where eo.id = new.order_id;
    if not coalesce(new_order_holds, false) then
      return new; -- a lapsed/released order's row does not reserve capacity
    end if;
  elsif new.status = 'pending' and new.payment_status = 'pending' and new.order_id is null then
    -- Orderless unpaid row: checked when created, and whenever its capacity-relevant fields or hold change.
    if tg_op = 'UPDATE'
       and old.status = 'pending' and old.payment_status = 'pending' and old.order_id is null
       and new.ticket_type_id is not distinct from old.ticket_type_id
       and new.quantity is not distinct from old.quantity
       and not (new.terminal_hold_until is not null and new.terminal_hold_until > now()
                and (old.terminal_hold_until is null or old.terminal_hold_until < new.terminal_hold_until)) then
      return new;
    end if;
  else
    return new; -- cancelled / expired / failed / refunded rows never reserve and are never blocked
  end if;

  select
    ett.capacity,
    greatest(coalesce(ett.attendees_per_ticket, 1), 1)
  into
    ticket_capacity,
    admits_per_ticket
  from public.event_ticket_types ett
  where ett.id = new.ticket_type_id
  for update;

  if ticket_capacity is null then
    return new;
  end if;

  requested_admissions := greatest(coalesce(new.quantity, 1), 1) * admits_per_ticket;

  select coalesce(
    sum(
      greatest(coalesce(er.quantity, 1), 1)
      * greatest(coalesce(ett.attendees_per_ticket, 1), 1)
    ),
    0
  )
  into reserved_admissions
  from public.event_registrations er
  join public.event_ticket_types ett
    on ett.id = er.ticket_type_id
  left join public.event_orders eo
    on eo.id = er.order_id
  where er.ticket_type_id = new.ticket_type_id
    and er.id is distinct from new.id
    and (
      er.payment_status = 'paid'
      or er.status in ('confirmed', 'checked_in', 'attended')
      or (
        er.status = 'pending'
        and er.payment_status = 'pending'
        and er.order_id is not null
        and eo.status = 'pending'
        and eo.payment_status = 'pending'
        and (eo.expires_at is null or eo.expires_at > now())
      )
      or (
        er.status = 'pending'
        and er.payment_status = 'pending'
        and er.order_id is null
        and er.terminal_hold_until is not null
        and er.terminal_hold_until > now()
      )
    );

  if reserved_admissions + requested_admissions > ticket_capacity then
    raise exception
      'Selected ticket quantity is no longer available. % admission spot(s) remain.',
      greatest(ticket_capacity - reserved_admissions, 0)
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- The capacity trigger must also run when a terminal hold is (re)taken.
drop trigger if exists trg_enforce_event_ticket_capacity_holds on public.event_registrations;
create trigger trg_enforce_event_ticket_capacity_holds
  before insert or update of ticket_type_id, quantity, status, payment_status, order_id, terminal_hold_until
  on public.event_registrations
  for each row execute function public.enforce_event_ticket_capacity_holds();

-- Terminal (card reader) fulfilment of a box-office sale. The charge has already succeeded; this confirms the
-- registration under its lock, or -- if it can no longer be fulfilled (sold out after the terminal hold lapsed,
-- cancelled, not an orderless box-office sale) -- records a captured-payment exception and leaves it unconfirmed.
create or replace function public.confirm_terminal_event_registration(
  p_studio_id uuid, p_payment_id uuid, p_registration_id uuid, p_payment_intent_id text,
  p_amount_cents bigint, p_currency text, p_stripe_account text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg public.event_registrations%rowtype;
  v_ex uuid;
  v_details jsonb;
  v_prior_kind text;
begin
  select * into v_reg from public.event_registrations where id = p_registration_id and studio_id = p_studio_id for update;
  v_details := jsonb_build_object('registration_id', p_registration_id, 'payment_id', p_payment_id,
                                  'event_id', v_reg.event_id, 'source', 'terminal');
  if v_reg.id is null then
    v_ex := public._paywh1_record_exception(null, 'terminal_payment_unfulfilled', null, p_stripe_account, null,
      p_payment_intent_id, p_amount_cents, p_currency, v_details || jsonb_build_object('reason', 'registration_not_found'));
    return jsonb_build_object('outcome', 'not_fulfilled', 'reason', 'registration_not_found', 'exception_id', v_ex);
  end if;
  if v_reg.payment_status = 'paid' and v_reg.stripe_payment_intent_id = p_payment_intent_id then
    return jsonb_build_object('outcome', 'already_confirmed');
  end if;
  select x.kind into v_prior_kind from public.event_order_settlement_exceptions x
  where x.stripe_payment_intent_id = p_payment_intent_id and x.order_id is null
    and x.kind in ('terminal_paid_capacity_unavailable', 'terminal_payment_unfulfilled')
  order by x.created_at limit 1;
  if v_prior_kind is not null then
    v_ex := public._paywh1_record_exception(null, v_prior_kind, null, p_stripe_account, null,
      p_payment_intent_id, p_amount_cents, p_currency, v_details || jsonb_build_object('replay', true));
    return jsonb_build_object('outcome', 'not_fulfilled', 'reason', 'exception_already_recorded', 'exception_id', v_ex);
  end if;
  if v_reg.order_id is not null or v_reg.status <> 'pending' or v_reg.payment_status <> 'pending' then
    v_ex := public._paywh1_record_exception(null, 'terminal_payment_unfulfilled', null, p_stripe_account, null,
      p_payment_intent_id, p_amount_cents, p_currency,
      v_details || jsonb_build_object('reason', case when v_reg.order_id is not null then 'order_backed' else 'registration_' || v_reg.status end));
    return jsonb_build_object('outcome', 'not_fulfilled', 'reason', 'registration_not_payable', 'exception_id', v_ex);
  end if;
  begin
    update public.event_registrations
    set status = 'confirmed', payment_status = 'paid', stripe_payment_intent_id = p_payment_intent_id,
        terminal_hold_until = null, updated_at = now()
    where id = p_registration_id;
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'Selected ticket quantity is no longer available%' then
      raise;
    end if;
    v_ex := public._paywh1_record_exception(null, 'terminal_paid_capacity_unavailable', null, p_stripe_account, null,
      p_payment_intent_id, p_amount_cents, p_currency, v_details || jsonb_build_object('reason', sqlerrm));
    return jsonb_build_object('outcome', 'not_fulfilled', 'reason', 'capacity_unavailable', 'exception_id', v_ex);
  end;
  return jsonb_build_object('outcome', 'confirmed');
end;
$$;
revoke all on function public.confirm_terminal_event_registration(uuid, uuid, uuid, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.confirm_terminal_event_registration(uuid, uuid, uuid, text, bigint, text, text) to service_role;

-- (Re)take the terminal hold of an orderless box-office sale right before the card reader is charged. The capacity
-- trigger re-checks availability when the hold is (re)taken, so a sold-out sale is refused BEFORE any charge.
create or replace function public.hold_terminal_event_registration(p_studio_id uuid, p_registration_id uuid, p_minutes integer default 15)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg public.event_registrations%rowtype;
  v_until timestamptz := now() + make_interval(mins => least(greatest(coalesce(p_minutes, 15), 5), 30));
begin
  select * into v_reg from public.event_registrations where id = p_registration_id and studio_id = p_studio_id for update;
  if v_reg.id is null then
    return jsonb_build_object('ok', false, 'reason', 'registration_not_found');
  end if;
  if v_reg.order_id is not null or v_reg.status <> 'pending' or v_reg.payment_status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'registration_not_payable');
  end if;
  begin
    update public.event_registrations set terminal_hold_until = v_until, updated_at = now() where id = p_registration_id;
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'Selected ticket quantity is no longer available%' then
      raise;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'capacity_unavailable', 'message', sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'hold_until', v_until);
end;
$$;

create or replace function public.release_terminal_event_registration_hold(p_studio_id uuid, p_registration_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.event_registrations set terminal_hold_until = null, updated_at = now()
  where id = p_registration_id and studio_id = p_studio_id and order_id is null
    and status = 'pending' and payment_status = 'pending' and terminal_hold_until is not null;
  return found;
end;
$$;
revoke all on function public.hold_terminal_event_registration(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_terminal_event_registration_hold(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hold_terminal_event_registration(uuid, uuid, integer) to service_role;
grant execute on function public.release_terminal_event_registration_hold(uuid, uuid) to service_role;

-- =================================================================================================================
-- M-1  Competition registration-desk payment
-- =================================================================================================================
create table if not exists public.event_competition_checkin_payment_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  checkin_session_id uuid not null,
  registration_id uuid not null,
  order_id uuid null,
  event_payment_id uuid not null,
  amount numeric not null,
  currency text not null,
  payment_method text not null,
  balance_before numeric not null,
  balance_after numeric not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists event_competition_checkin_payment_audit_event_idx
  on public.event_competition_checkin_payment_audit (event_id, created_at);
alter table public.event_competition_checkin_payment_audit enable row level security;
revoke all on public.event_competition_checkin_payment_audit from public, anon, authenticated;
grant select on public.event_competition_checkin_payment_audit to authenticated;
grant select, insert on public.event_competition_checkin_payment_audit to service_role;
drop policy if exists event_competition_checkin_payment_audit_manager_select on public.event_competition_checkin_payment_audit;
create policy event_competition_checkin_payment_audit_manager_select
  on public.event_competition_checkin_payment_audit for select to authenticated
  using (public._paywh1_actor_can_manage_event(event_id));

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

  select coalesce(sum(amount - coalesce(refund_amount, 0)), 0) into v_paid
  from public.event_payments where registration_id = v_reg.id and status = 'paid';
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

-- =================================================================================================================
-- L-2 / L-3  Guard helpers: usable only from inside a trigger (no client lookup of other registrations); the
--            attendee entitlement check serialises concurrent writers on the registration row.
-- =================================================================================================================
create or replace function public._paywh1_registration_order_facts(p_registration_id uuid)
returns table (order_backed boolean, payment_status text, status text, entitlement integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception '_paywh1_registration_order_facts is internal to the PAY-WH-1 guards' using errcode = '42501';
  end if;
  return query
  select er.order_id is not null, er.payment_status, er.status,
         greatest(coalesce(er.quantity, 1), 1) * greatest(coalesce(ett.attendees_per_ticket, 1), 1)
  from public.event_registrations er
  left join public.event_ticket_types ett on ett.id = er.ticket_type_id
  where er.id = p_registration_id;
end;
$$;

create or replace function public._paywh1_registration_attendee_count(p_registration_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if pg_trigger_depth() = 0 then
    raise exception '_paywh1_registration_attendee_count is internal to the PAY-WH-1 guards' using errcode = '42501';
  end if;
  -- Serialise attendee inserts for the same registration so concurrent writers cannot both pass the entitlement check.
  perform 1 from public.event_registrations where id = p_registration_id for update;
  select count(*)::integer into v_count from public.event_registration_attendees where registration_id = p_registration_id;
  return v_count;
end;
$$;

revoke all on function public._paywh1_registration_order_facts(uuid) from public;
revoke all on function public._paywh1_registration_attendee_count(uuid) from public;
grant execute on function public._paywh1_registration_order_facts(uuid) to anon, authenticated, service_role;
grant execute on function public._paywh1_registration_attendee_count(uuid) to anon, authenticated, service_role;

create or replace function public._paywh1a_fill_event_payment_event_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.event_id is null then
    select er.event_id into new.event_id from public.event_registrations er where er.id = new.registration_id;
  end if;
  return new;
end;
$$;
revoke all on function public._paywh1a_fill_event_payment_event_id() from public, anon, authenticated;

-- Installed only where the column exists (callable again after the DEV drift is reconciled).
create or replace function public._paywh1a_install_event_payment_event_id_fill()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'event_payments' and column_name = 'event_id') then
    return false;
  end if;
  drop trigger if exists trg_paywh1a_fill_event_payment_event_id on public.event_payments;
  create trigger trg_paywh1a_fill_event_payment_event_id
    before insert on public.event_payments
    for each row execute function public._paywh1a_fill_event_payment_event_id();
  return true;
end;
$$;
revoke all on function public._paywh1a_install_event_payment_event_id_fill() from public, anon, authenticated;
select public._paywh1a_install_event_payment_event_id_fill();

revoke all on function public._paywh1_exception_money_state(text) from public, anon, authenticated;
grant execute on function public._paywh1_exception_money_state(text) to service_role;

notify pgrst, 'reload schema';

commit;
