-- PAY-WH-1 M3 -- Durable, transactional side effects for event-cart settlement.
--
-- Applied BEFORE the settlement migration (20261116092000), because settle_event_cart_order inserts outbox rows
-- in the same transaction that marks an order paid: an effect exists if and only if the settlement committed.
--
-- 1. event_settlement_outbox: one row per effect (studio lead, organizer contact, order confirmation, fee sync,
--    closing superseded payment attempts) with a stable dedupe key, lease-based claiming, retry with backoff, and a
--    terminal 'dead' state after repeated failure -- failures stay visible instead of being swallowed.
-- 2. capture_event_registration_lead: the studio CRM lead capture that previously ran as lookup-then-insert from the
--    webhook (concurrent deliveries could create duplicate clients and every run added a notification). It now
--    serializes per (studio, email) with a transaction advisory lock and writes its notification with a dedupe key.
-- 3. outbound_deliveries claims: the shared sender selected 'queued' rows with no claim, so overlapping cron runs
--    could send the same message twice. Rows are now leased to one dispatcher (status values unchanged, so every
--    other producer/reader of outbound_deliveries is unaffected).
--
-- Additive. Rollback: rollback/20261116091000_paywh1_settlement_outbox_rollback.sql.

begin;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Settlement outbox
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.event_settlement_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.event_orders(id) on delete cascade,
  studio_id uuid not null,
  effect text not null check (effect in ('studio_lead', 'organizer_contact', 'order_confirmation', 'fee_sync', 'close_superseded_attempts')),
  subject_id uuid null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  next_attempt_at timestamptz not null default now(),
  claim_owner uuid null,
  claim_expires_at timestamptz null,
  last_error text null,
  last_error_at timestamptz null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint event_settlement_outbox_dedupe_key_key unique (dedupe_key),
  constraint event_settlement_outbox_claim_consistency check (status <> 'processing' or (claim_owner is not null and claim_expires_at is not null))
);

create index if not exists event_settlement_outbox_due_idx
  on public.event_settlement_outbox (next_attempt_at)
  where status in ('pending', 'processing', 'failed');
create index if not exists event_settlement_outbox_order_idx on public.event_settlement_outbox (order_id);

alter table public.event_settlement_outbox enable row level security;
revoke all on public.event_settlement_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.event_settlement_outbox to service_role;

-- Claim due effects (optionally for one order). Expired leases and failed rows whose backoff elapsed are reclaimable.
create or replace function public.claim_event_settlement_outbox(
  p_owner uuid,
  p_limit integer default 20,
  p_lease_seconds integer default 120,
  p_order_id uuid default null
)
returns setof public.event_settlement_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner is null then
    raise exception 'claim_event_settlement_outbox: owner is required' using errcode = '22023';
  end if;

  -- A worker that dies on every attempt never calls complete(); its expired lease must still end in 'dead'.
  update public.event_settlement_outbox o
  set status = 'dead',
      last_error = coalesce(o.last_error, 'worker lease expired on every attempt'),
      last_error_at = now(),
      claim_owner = null,
      claim_expires_at = null
  where (p_order_id is null or o.order_id = p_order_id)
    and o.status = 'processing'
    and o.claim_expires_at <= now()
    and o.attempts >= o.max_attempts;

  return query
  with due as (
    select o.id
    from public.event_settlement_outbox o
    where (p_order_id is null or o.order_id = p_order_id)
      and (
        (o.status in ('pending', 'failed') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.claim_expires_at <= now() and o.next_attempt_at <= now())
      )
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 20), 1), 200)
    for update skip locked
  )
  update public.event_settlement_outbox o
  set status = 'processing',
      claim_owner = p_owner,
      claim_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      -- Back-off also applies when the worker dies without completing (complete() overwrites it otherwise).
      next_attempt_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900))
                              + make_interval(mins => least(power(2, least(o.attempts, 9))::integer, 360)),
      attempts = o.attempts + 1
  from due
  where o.id = due.id
  returning o.*;
end;
$$;

-- Complete a claimed effect. Only the current owner can complete it. Failures back off exponentially and become
-- 'dead' (still visible, never silently dropped) after max_attempts.
create or replace function public.complete_event_settlement_outbox(
  p_id uuid,
  p_owner uuid,
  p_ok boolean,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update public.event_settlement_outbox
    set status = 'done', completed_at = now(), claim_owner = null, claim_expires_at = null, last_error = null
    where id = p_id and status = 'processing' and claim_owner = p_owner;
  else
    update public.event_settlement_outbox
    set status = case when attempts >= max_attempts then 'dead' else 'failed' end,
        last_error = left(coalesce(p_error, 'failed'), 2000),
        last_error_at = now(),
        next_attempt_at = now() + make_interval(mins => least(power(2, least(attempts, 9))::integer, 360)),
        claim_owner = null,
        claim_expires_at = null
    where id = p_id and status = 'processing' and claim_owner = p_owner;
  end if;
  return found;
end;
$$;

revoke all on function public.claim_event_settlement_outbox(uuid, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.complete_event_settlement_outbox(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_event_settlement_outbox(uuid, integer, integer, uuid) to service_role;
grant execute on function public.complete_event_settlement_outbox(uuid, uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Studio lead capture (idempotent, serialized per studio + email)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.notifications add column if not exists dedupe_key text null;
create unique index if not exists notifications_dedupe_key_uidx on public.notifications (dedupe_key) where dedupe_key is not null;

create or replace function public.capture_event_registration_lead(p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reg record;
  v_email text;
  v_first text;
  v_last text;
  v_client_id uuid;
  v_existing record;
begin
  select er.id, er.studio_id, er.client_id, er.status, er.payment_status, er.attendee_first_name, er.attendee_last_name,
         er.attendee_email, er.attendee_phone, e.id as event_id, e.name as event_name, e.studio_id as event_studio_id,
         e.organizer_id
  into v_reg
  from public.event_registrations er
  join public.events e on e.id = er.event_id
  where er.id = p_registration_id;

  if not found then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'registration_not_found');
  end if;
  -- Leads are captured only from committed, paid registrations, and never for organizer listings
  -- (organizer listings use organizer contacts).
  if v_reg.payment_status <> 'paid' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'registration_not_paid');
  end if;
  if v_reg.organizer_id is not null then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'organizer_listing');
  end if;

  v_email := lower(btrim(coalesce(v_reg.attendee_email, '')));
  if coalesce(v_reg.event_studio_id, v_reg.studio_id) is null or v_email = '' then
    return jsonb_build_object('outcome', 'skipped', 'reason', 'missing_studio_or_email');
  end if;
  v_first := coalesce(nullif(btrim(coalesce(v_reg.attendee_first_name, '')), ''), 'Event');
  v_last := coalesce(nullif(btrim(coalesce(v_reg.attendee_last_name, '')), ''), 'Registrant');

  -- Serialize concurrent captures for the same studio + email (no unique index exists on clients.email).
  perform pg_advisory_xact_lock(hashtextextended('paywh1_lead:' || coalesce(v_reg.event_studio_id, v_reg.studio_id)::text || ':' || v_email, 0));

  v_client_id := v_reg.client_id;
  if v_client_id is null then
    select c.id, c.referral_source, c.source_system into v_existing
    from public.clients c
    where c.studio_id = coalesce(v_reg.event_studio_id, v_reg.studio_id) and lower(c.email) = v_email
    order by c.created_at asc
    limit 1;

    if found then
      v_client_id := v_existing.id;
      update public.clients
      set referral_source = coalesce(referral_source, 'Event Registration'),
          source_system = coalesce(source_system, 'event_registration')
      where id = v_client_id and (referral_source is null or source_system is null);
    else
      insert into public.clients (studio_id, first_name, last_name, email, phone, status, referral_source, source_system, notes)
      values (coalesce(v_reg.event_studio_id, v_reg.studio_id), v_first, v_last, v_email, nullif(v_reg.attendee_phone, ''), 'lead',
              'Event Registration', 'event_registration', format('Created from event registration for %s.', v_reg.event_name))
      returning id into v_client_id;
    end if;

    update public.event_registrations set client_id = v_client_id where id = v_reg.id and client_id is null;
  end if;

  insert into public.notifications (studio_id, client_id, type, title, body, dedupe_key)
  values (coalesce(v_reg.event_studio_id, v_reg.studio_id), v_client_id, 'event_registration', 'New event registration',
          format('%s %s registered for %s.', v_first, v_last, v_reg.event_name), 'event_registration_lead:' || v_reg.id::text)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('outcome', 'captured', 'client_id', v_client_id);
end;
$$;

revoke all on function public.capture_event_registration_lead(uuid) from public, anon, authenticated;
grant execute on function public.capture_event_registration_lead(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Outbound delivery claims for the shared sender
-- ---------------------------------------------------------------------------------------------------------------
alter table public.outbound_deliveries
  add column if not exists claim_owner uuid null,
  add column if not exists claim_expires_at timestamptz null;

create index if not exists outbound_deliveries_queued_claim_idx
  on public.outbound_deliveries (created_at)
  where status = 'queued';

-- Lease up to p_limit queued deliveries to one dispatcher. Rows stay 'queued' (status values are shared with every
-- other producer); a row leased to another live dispatcher is skipped; an expired lease is reclaimable.
create or replace function public.claim_outbound_deliveries(
  p_owner uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns setof public.outbound_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner is null then
    raise exception 'claim_outbound_deliveries: owner is required' using errcode = '22023';
  end if;

  return query
  with due as (
    select d.id
    from public.outbound_deliveries d
    where d.status = 'queued'
      and (d.claim_owner is null or d.claim_expires_at <= now())
    order by d.created_at
    limit least(greatest(coalesce(p_limit, 25), 1), 200)
    for update skip locked
  )
  update public.outbound_deliveries d
  set claim_owner = p_owner,
      claim_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 1800))
  from due
  where d.id = due.id
  returning d.*;
end;
$$;

revoke all on function public.claim_outbound_deliveries(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_outbound_deliveries(uuid, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
