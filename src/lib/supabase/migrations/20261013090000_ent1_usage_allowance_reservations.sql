-- 20261013090000_ent1_usage_allowance_reservations.sql
--
-- ENT-1: atomic monthly allowance enforcement for metered usage (first consumer:
-- email-campaign recipients, studio and organizer).
--
-- Problem. getUsageAllowance + record_usage_event is check-then-record: two
-- concurrent campaign sends can both read the same remaining allowance and both
-- send, overshooting the monthly entitlement. Allowance is a billing/entitlement
-- integrity boundary, so it is enforced in the database.
--
-- Model (reserve -> send -> finalize / release).
--   reserve_usage_allowance   Under a per-(workspace, feature, period) advisory
--                             lock, requires  used + active reservations +
--                             requested  <=  allowance, then records a
--                             'reserved' row. Fails closed (allowance <= 0 is
--                             refused, never "unlimited"). Idempotent per
--                             idempotency key.
--   finalize_usage_reservation Under the same lock, records ONE usage_events row
--                             for the quantity that actually succeeded (0 =
--                             none) and closes the reservation. The unused part
--                             is released simply by not being recorded. The
--                             existing usage_events trigger maintains
--                             usage_monthly_summaries, so the summary reflects
--                             successful usage only and a reservation is never
--                             counted twice (a finalized reservation no longer
--                             counts as reserved, in the same transaction).
--   release_usage_reservation Closes a reservation without recording usage.
--   A reservation that is never closed (a crashed request) stops counting after
--   its expiry (default 15 minutes) so it cannot lock an allowance forever.
--
-- Trust boundary. All three functions are callable by service_role ONLY. The
-- application resolves the workspace's allowance from the canonical plan
-- resolution (src/lib/usage/campaignAllowance.ts) after authorizing the caller,
-- and passes it in; the database computes current usage and reservations
-- itself and never trusts a client-supplied usage total. No tenant role can
-- call these functions or read usage_reservations (RLS enabled, no policies,
-- no table privileges), so there is no cross-tenant visibility.
--
-- Not touched: usage_events, usage_monthly_summaries, usage_addon_entitlements,
-- record_usage_event (existing AI metering keeps working unchanged).

begin;

create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_type text not null check (workspace_type in ('studio', 'organizer')),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  feature_key text not null,
  period_start date not null,
  period_end date not null,
  quantity_reserved integer not null check (quantity_reserved > 0),
  quantity_consumed integer not null default 0 check (quantity_consumed >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'finalized', 'released', 'expired')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  source text not null,
  related_table text,
  related_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  usage_event_id uuid references public.usage_events(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint usage_reservations_one_workspace_check check (
    (workspace_type = 'studio' and studio_id is not null and organizer_id is null)
    or
    (workspace_type = 'organizer' and organizer_id is not null and studio_id is null)
  ),
  constraint usage_reservations_consumed_within_reserved check (quantity_consumed <= quantity_reserved)
);

-- One live reservation (or one finalized record) per workspace/feature/key.
create unique index if not exists usage_reservations_workspace_key_unique
  on public.usage_reservations (coalesce(studio_id, organizer_id), feature_key, idempotency_key)
  where status in ('reserved', 'finalized');

create index if not exists usage_reservations_active_studio_idx
  on public.usage_reservations (studio_id, feature_key, period_start)
  where status = 'reserved' and studio_id is not null;

create index if not exists usage_reservations_active_organizer_idx
  on public.usage_reservations (organizer_id, feature_key, period_start)
  where status = 'reserved' and organizer_id is not null;

alter table public.usage_reservations enable row level security;
revoke all on table public.usage_reservations from public, anon, authenticated;

-- ============================================================================
-- reserve_usage_allowance
-- ============================================================================
create or replace function public.reserve_usage_allowance(
  p_workspace_type text,
  p_studio_id uuid,
  p_organizer_id uuid,
  p_feature_key text,
  p_quantity integer,
  p_allowance integer,
  p_period_start date,
  p_period_end date,
  p_idempotency_key text,
  p_source text,
  p_related_table text default null,
  p_related_id uuid default null,
  p_created_by uuid default null,
  p_ttl_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_used integer;
  v_reserved integer;
  v_existing public.usage_reservations%rowtype;
  v_id uuid;
begin
  if p_workspace_type = 'studio' then
    if p_studio_id is null or p_organizer_id is not null then
      raise exception 'Invalid studio usage workspace';
    end if;
    v_ws := p_studio_id;
  elsif p_workspace_type = 'organizer' then
    if p_organizer_id is null or p_studio_id is not null then
      raise exception 'Invalid organizer usage workspace';
    end if;
    v_ws := p_organizer_id;
  else
    raise exception 'Invalid usage workspace type';
  end if;

  if p_feature_key is null or length(p_feature_key) = 0 then
    raise exception 'Usage feature key is required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Usage quantity must be greater than zero';
  end if;
  if p_allowance is null or p_allowance < 0 then
    raise exception 'Usage allowance must be zero or greater';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'Invalid usage period';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'An idempotency key is required';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'Invalid reservation lifetime';
  end if;

  -- Serialize every reserve/finalize/release for this workspace, feature and period.
  perform pg_advisory_xact_lock(
    hashtextextended(v_ws::text || ':' || p_feature_key || ':' || p_period_start::text, 0)
  );

  -- Reservations that were never closed stop counting once expired.
  update public.usage_reservations
  set status = 'expired'
  where status = 'reserved'
    and expires_at <= now()
    and feature_key = p_feature_key
    and coalesce(studio_id, organizer_id) = v_ws;

  -- Idempotency: the same request key returns the same reservation.
  select * into v_existing
  from public.usage_reservations
  where coalesce(studio_id, organizer_id) = v_ws
    and feature_key = p_feature_key
    and idempotency_key = p_idempotency_key
    and status in ('reserved', 'finalized')
  limit 1;

  if found then
    if v_existing.status = 'finalized' then
      return jsonb_build_object('ok', false, 'reason', 'already_finalized', 'reservation_id', v_existing.id);
    end if;
    return jsonb_build_object('ok', true, 'idempotent', true, 'reservation_id', v_existing.id,
                              'quantity', v_existing.quantity_reserved);
  end if;

  if p_workspace_type = 'studio' then
    select coalesce(max(quantity_used), 0) into v_used
    from public.usage_monthly_summaries
    where studio_id = p_studio_id and feature_key = p_feature_key and period_start = p_period_start;

    select coalesce(sum(quantity_reserved), 0) into v_reserved
    from public.usage_reservations
    where studio_id = p_studio_id and feature_key = p_feature_key
      and period_start = p_period_start and status = 'reserved';
  else
    select coalesce(max(quantity_used), 0) into v_used
    from public.usage_monthly_summaries
    where organizer_id = p_organizer_id and feature_key = p_feature_key and period_start = p_period_start;

    select coalesce(sum(quantity_reserved), 0) into v_reserved
    from public.usage_reservations
    where organizer_id = p_organizer_id and feature_key = p_feature_key
      and period_start = p_period_start and status = 'reserved';
  end if;

  if p_allowance <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_allowance', 'allowance', p_allowance,
                              'used', v_used, 'reserved', v_reserved, 'remaining', 0);
  end if;

  if v_used + v_reserved + p_quantity > p_allowance then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'allowance', p_allowance,
                              'used', v_used, 'reserved', v_reserved,
                              'remaining', greatest(0, p_allowance - v_used - v_reserved));
  end if;

  insert into public.usage_reservations (
    workspace_type, studio_id, organizer_id, feature_key, period_start, period_end,
    quantity_reserved, idempotency_key, source, related_table, related_id, created_by, expires_at
  ) values (
    p_workspace_type, p_studio_id, p_organizer_id, p_feature_key, p_period_start, p_period_end,
    p_quantity, p_idempotency_key, p_source, p_related_table, p_related_id, p_created_by,
    now() + make_interval(secs => p_ttl_seconds)
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'idempotent', false, 'reservation_id', v_id, 'quantity', p_quantity,
                            'allowance', p_allowance, 'used', v_used, 'reserved', v_reserved + p_quantity,
                            'remaining', p_allowance - v_used - v_reserved - p_quantity);
end;
$$;

-- ============================================================================
-- finalize_usage_reservation
-- ============================================================================
create or replace function public.finalize_usage_reservation(
  p_reservation_id uuid,
  p_quantity_consumed integer,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.usage_reservations%rowtype;
  v_ws uuid;
  v_event_id uuid;
begin
  select * into v_r from public.usage_reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_ws := coalesce(v_r.studio_id, v_r.organizer_id);
  perform pg_advisory_xact_lock(
    hashtextextended(v_ws::text || ':' || v_r.feature_key || ':' || v_r.period_start::text, 0)
  );

  select * into v_r from public.usage_reservations where id = p_reservation_id for update;

  if v_r.status = 'finalized' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'quantity_consumed', v_r.quantity_consumed);
  end if;
  if v_r.status = 'released' then
    return jsonb_build_object('ok', false, 'reason', 'released');
  end if;

  if p_quantity_consumed is null or p_quantity_consumed < 0 or p_quantity_consumed > v_r.quantity_reserved then
    raise exception 'Consumed quantity must be between 0 and the reserved quantity';
  end if;

  -- 'reserved' and 'expired' both record what really happened: deliveries that
  -- succeeded are real usage even if the request outlived its reservation.
  if p_quantity_consumed > 0 then
    insert into public.usage_events (
      studio_id, organizer_id, workspace_type, feature_key, quantity, source,
      related_table, related_id, metadata, period_start, period_end, created_by
    ) values (
      v_r.studio_id, v_r.organizer_id, v_r.workspace_type, v_r.feature_key, p_quantity_consumed, v_r.source,
      v_r.related_table, v_r.related_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('reservation_id', v_r.id, 'reserved', v_r.quantity_reserved),
      v_r.period_start, v_r.period_end, v_r.created_by
    )
    returning id into v_event_id;
  end if;

  update public.usage_reservations
  set status = 'finalized',
      quantity_consumed = p_quantity_consumed,
      finalized_at = now(),
      usage_event_id = v_event_id
  where id = v_r.id;

  return jsonb_build_object('ok', true, 'idempotent', false, 'quantity_consumed', p_quantity_consumed,
                            'quantity_released', v_r.quantity_reserved - p_quantity_consumed);
end;
$$;

-- ============================================================================
-- release_usage_reservation
-- ============================================================================
create or replace function public.release_usage_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.usage_reservations%rowtype;
  v_ws uuid;
begin
  select * into v_r from public.usage_reservations where id = p_reservation_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_ws := coalesce(v_r.studio_id, v_r.organizer_id);
  perform pg_advisory_xact_lock(
    hashtextextended(v_ws::text || ':' || v_r.feature_key || ':' || v_r.period_start::text, 0)
  );

  select * into v_r from public.usage_reservations where id = p_reservation_id for update;

  if v_r.status = 'finalized' then
    return jsonb_build_object('ok', false, 'reason', 'already_finalized');
  end if;

  if v_r.status = 'reserved' then
    update public.usage_reservations set status = 'released', finalized_at = now() where id = v_r.id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ============================================================================
-- Grants: service_role only. No tenant role can reserve, finalize, release or read.
-- ============================================================================
revoke all on function public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_usage_reservation(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.release_usage_reservation(uuid) from public, anon, authenticated;

grant execute on function public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, integer)
  to service_role;
grant execute on function public.finalize_usage_reservation(uuid, integer, jsonb) to service_role;
grant execute on function public.release_usage_reservation(uuid) to service_role;
grant select, insert, update, delete on table public.usage_reservations to service_role;

commit;
