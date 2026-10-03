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
-- Two scopes, kept apart.
--   ENTITLEMENT SCOPE  = the whole logical campaign send. A reservation commits
--                        capacity for every pending recipient of the campaign at
--                        admission, so a campaign is admitted all-or-nothing and no
--                        concurrent campaign can take capacity already committed to
--                        it. Recipient ordering never decides who is mailed.
--   DELIVERY SCOPE     = the existing safe execution batch (500 recipients per
--                        action). Each batch is a unit of work inside the one
--                        campaign-level reservation.
--
-- Campaign reservation lifecycle (status 'reserved' -> 'finalized' | 'released').
--   reserve_usage_allowance   Admission or continuation, under a per
--                             (workspace, feature, month) advisory lock.
--                             - No active reservation for the idempotency key:
--                               requires  used + committed(all) + pending  <=
--                               allowance, then commits `pending` recipients.
--                               allowance <= 0 is refused, never "unlimited".
--                             - Active reservation (a later batch): the capacity is
--                               ALREADY committed, so it continues without a new
--                               allowance check, even if other campaigns started
--                               in between. Only if more recipients are pending
--                               than are still committed (the list grew) is the
--                               difference checked and added, atomically.
--                             Opens a batch (batch_started_at, batch_recipient_ids).
--                             A second open batch on the same campaign is refused
--                             ('in_progress'); a batch left open longer than the
--                             stale window (a crashed request) must be reconciled
--                             first ('needs_reconcile').
--   settle_usage_reservation  Closes the open batch: records ONE usage_events row
--                             for the recipients whose send succeeded in that batch
--                             (0 = none), then shrinks the commitment to
--                             consumed + still-pending (capacity held for recipients
--                             that failed is released), and closes the reservation
--                             when nothing is pending or when nothing was ever
--                             delivered (a campaign that has not mailed anyone holds
--                             no commitment). Idempotent: settling a batch that is
--                             already settled changes nothing, so a retry never
--                             double counts.
--   A reservation commits capacity only until its period (the month) ends, and a
--   started campaign that is abandoned holds its still-pending recipients' capacity
--   until the month ends or the campaign completes. There is no time-based expiry
--   that could take capacity away from a campaign that is legitimately in progress.
--
-- Durable counting. Successful sends must never disappear from usage. The
-- committed capacity is NEVER released while a batch is unsettled (batch_started_at
-- set): if the settle call fails, the capacity stays held, conservative, until a
-- later settle succeeds. The application settles with its in-run count, and
-- reconciles any stale open batch from the durable per-recipient 'sent' records
-- (batch_recipient_ids tells it exactly which recipients to count) before it admits
-- anything else for the workspace.
--
-- Trust boundary. Both functions are callable by service_role ONLY. The application
-- resolves the workspace's allowance from the canonical plan resolution
-- (src/lib/usage/campaignAllowance.ts) after authorizing the caller, and passes it
-- in; the database computes current usage and commitments itself and never trusts a
-- client-supplied usage total. No tenant role can call these functions or read
-- usage_reservations (RLS enabled, no policies, no table privileges): there is no
-- cross-tenant visibility.
--
-- Not touched: usage_events, usage_monthly_summaries, usage_addon_entitlements,
-- record_usage_event (existing AI metering keeps working unchanged).
--
-- Rollout note. An earlier candidate of this migration (per-batch reservations,
-- 15-minute expiry) was applied to DEV only and never reached main or PROD. Before
-- this version was applied to DEV, the candidate's objects were dropped (its
-- rollback file) so DEV and a fresh PROD apply converge on exactly this file.

begin;

create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_type text not null check (workspace_type in ('studio', 'organizer')),
  studio_id uuid references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete cascade,
  feature_key text not null,
  period_start date not null,
  period_end date not null,
  -- capacity committed to the logical campaign (consumed + still pending)
  quantity_reserved integer not null check (quantity_reserved > 0),
  -- recipients already recorded as usage across all settled batches
  quantity_consumed integer not null default 0 check (quantity_consumed >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'finalized', 'released')),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  source text not null,
  related_table text,
  related_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  -- the open (unsettled) delivery batch, if any
  batch_started_at timestamptz,
  batch_recipient_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint usage_reservations_one_workspace_check check (
    (workspace_type = 'studio' and studio_id is not null and organizer_id is null)
    or
    (workspace_type = 'organizer' and organizer_id is not null and studio_id is null)
  ),
  constraint usage_reservations_consumed_within_reserved check (quantity_consumed <= quantity_reserved),
  constraint usage_reservations_batch_state check (
    (status = 'reserved') or (batch_started_at is null)
  )
);

-- One active reservation per workspace / feature / month / logical send.
create unique index if not exists usage_reservations_active_key_unique
  on public.usage_reservations (coalesce(studio_id, organizer_id), feature_key, period_start, idempotency_key)
  where status = 'reserved';

create index if not exists usage_reservations_active_studio_idx
  on public.usage_reservations (studio_id, feature_key, period_start)
  where status = 'reserved' and studio_id is not null;

create index if not exists usage_reservations_active_organizer_idx
  on public.usage_reservations (organizer_id, feature_key, period_start)
  where status = 'reserved' and organizer_id is not null;

alter table public.usage_reservations enable row level security;
revoke all on table public.usage_reservations from public, anon, authenticated;

-- ============================================================================
-- reserve_usage_allowance: admission of a logical send, or continuation of an admitted one
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
  p_batch_recipient_ids uuid[] default '{}',
  p_stale_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_used integer;
  v_committed integer;
  v_existing public.usage_reservations%rowtype;
  v_have_existing boolean;
  v_remaining_commit integer;
  v_extra integer;
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
  if p_stale_seconds is null or p_stale_seconds < 60 or p_stale_seconds > 86400 then
    raise exception 'Invalid stale-batch window';
  end if;

  -- Serialize every reserve/settle for this workspace, feature and period.
  perform pg_advisory_xact_lock(
    hashtextextended(v_ws::text || ':' || p_feature_key || ':' || p_period_start::text, 0)
  );

  if p_workspace_type = 'studio' then
    select coalesce(max(quantity_used), 0) into v_used
    from public.usage_monthly_summaries
    where studio_id = p_studio_id and feature_key = p_feature_key and period_start = p_period_start;

    select coalesce(sum(quantity_reserved - quantity_consumed), 0) into v_committed
    from public.usage_reservations
    where studio_id = p_studio_id and feature_key = p_feature_key
      and period_start = p_period_start and status = 'reserved';
  else
    select coalesce(max(quantity_used), 0) into v_used
    from public.usage_monthly_summaries
    where organizer_id = p_organizer_id and feature_key = p_feature_key and period_start = p_period_start;

    select coalesce(sum(quantity_reserved - quantity_consumed), 0) into v_committed
    from public.usage_reservations
    where organizer_id = p_organizer_id and feature_key = p_feature_key
      and period_start = p_period_start and status = 'reserved';
  end if;

  select * into v_existing
  from public.usage_reservations
  where coalesce(studio_id, organizer_id) = v_ws
    and feature_key = p_feature_key
    and period_start = p_period_start
    and idempotency_key = p_idempotency_key
    and status = 'reserved'
  for update;
  v_have_existing := found;

  -- No entitlement, no send: zero is never unlimited (also for a campaign already in progress).
  if p_allowance <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_allowance', 'allowance', p_allowance,
                              'used', v_used, 'committed', v_committed, 'remaining', 0);
  end if;

  if v_have_existing then
    -- A batch is already open on this logical send.
    if v_existing.batch_started_at is not null then
      if v_existing.batch_started_at > now() - make_interval(secs => p_stale_seconds) then
        return jsonb_build_object('ok', false, 'reason', 'in_progress', 'reservation_id', v_existing.id);
      end if;
      return jsonb_build_object('ok', false, 'reason', 'needs_reconcile', 'reservation_id', v_existing.id);
    end if;

    v_remaining_commit := v_existing.quantity_reserved - v_existing.quantity_consumed;

    if p_quantity > v_remaining_commit then
      -- More recipients are pending than are still committed (the list grew): admit the difference atomically.
      v_extra := p_quantity - v_remaining_commit;
      if v_used + v_committed + v_extra > p_allowance then
        return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'allowance', p_allowance,
                                  'used', v_used, 'committed', v_committed,
                                  'remaining', greatest(0, p_allowance - v_used - v_committed + v_remaining_commit));
      end if;
      update public.usage_reservations
      set quantity_reserved = quantity_reserved + v_extra, updated_at = now()
      where id = v_existing.id;
      v_committed := v_committed + v_extra;
    end if;

    update public.usage_reservations
    set batch_started_at = now(), batch_recipient_ids = coalesce(p_batch_recipient_ids, '{}'), updated_at = now()
    where id = v_existing.id;

    return jsonb_build_object('ok', true, 'continued', true, 'reservation_id', v_existing.id,
                              'allowance', p_allowance, 'used', v_used, 'committed', v_committed,
                              'remaining', p_allowance - v_used - v_committed);
  end if;

  -- Admission: the whole logical send must fit, or nothing is committed.
  if v_used + v_committed + p_quantity > p_allowance then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'allowance', p_allowance,
                              'used', v_used, 'committed', v_committed,
                              'remaining', greatest(0, p_allowance - v_used - v_committed));
  end if;

  insert into public.usage_reservations (
    workspace_type, studio_id, organizer_id, feature_key, period_start, period_end,
    quantity_reserved, idempotency_key, source, related_table, related_id, created_by,
    batch_started_at, batch_recipient_ids
  ) values (
    p_workspace_type, p_studio_id, p_organizer_id, p_feature_key, p_period_start, p_period_end,
    p_quantity, p_idempotency_key, p_source, p_related_table, p_related_id, p_created_by,
    now(), coalesce(p_batch_recipient_ids, '{}')
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'continued', false, 'reservation_id', v_id, 'allowance', p_allowance,
                            'used', v_used, 'committed', v_committed + p_quantity,
                            'remaining', p_allowance - v_used - v_committed - p_quantity);
end;
$$;

-- ============================================================================
-- settle_usage_reservation: closes the open batch, records successes, shrinks or closes the commitment
-- ============================================================================
create or replace function public.settle_usage_reservation(
  p_reservation_id uuid,
  p_batch_sent integer,
  p_pending_remaining integer default null,
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
  v_new_consumed integer;
  v_new_reserved integer;
  v_status text;
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

  -- Already closed, or the batch was already settled: a retry changes nothing and never double counts.
  if v_r.status <> 'reserved' or v_r.batch_started_at is null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'status', v_r.status, 'quantity_consumed', v_r.quantity_consumed);
  end if;

  if p_batch_sent is null or p_batch_sent < 0 then
    raise exception 'Sent quantity must be zero or greater';
  end if;
  if v_r.quantity_consumed + p_batch_sent > v_r.quantity_reserved then
    raise exception 'Sent quantity exceeds the committed capacity';
  end if;
  if cardinality(v_r.batch_recipient_ids) > 0 and p_batch_sent > cardinality(v_r.batch_recipient_ids) then
    raise exception 'Sent quantity exceeds the open batch';
  end if;
  if p_pending_remaining is not null and p_pending_remaining < 0 then
    raise exception 'Pending quantity must be zero or greater';
  end if;

  if p_batch_sent > 0 then
    insert into public.usage_events (
      studio_id, organizer_id, workspace_type, feature_key, quantity, source,
      related_table, related_id, metadata, period_start, period_end, created_by
    ) values (
      v_r.studio_id, v_r.organizer_id, v_r.workspace_type, v_r.feature_key, p_batch_sent, v_r.source,
      v_r.related_table, v_r.related_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('reservation_id', v_r.id, 'batch_size', cardinality(v_r.batch_recipient_ids)),
      v_r.period_start, v_r.period_end, v_r.created_by
    );
  end if;

  v_new_consumed := v_r.quantity_consumed + p_batch_sent;
  v_new_reserved := v_r.quantity_reserved;
  v_status := 'reserved';

  if p_pending_remaining is not null then
    if p_pending_remaining = 0 then
      v_status := case when v_new_consumed > 0 then 'finalized' else 'released' end;
    elsif v_new_consumed = 0 then
      -- nothing has ever been delivered: no commitment is held for a campaign that has not mailed anyone
      v_status := 'released';
    else
      -- capacity held for recipients that failed is released; what is still pending stays committed
      v_new_reserved := greatest(v_new_consumed, least(v_r.quantity_reserved, v_new_consumed + p_pending_remaining));
    end if;
  end if;

  update public.usage_reservations
  set quantity_consumed = v_new_consumed,
      quantity_reserved = v_new_reserved,
      status = v_status,
      batch_started_at = null,
      batch_recipient_ids = '{}',
      updated_at = now(),
      closed_at = case when v_status = 'reserved' then null else now() end
  where id = v_r.id;

  return jsonb_build_object('ok', true, 'idempotent', false, 'status', v_status, 'quantity_consumed', v_new_consumed,
                            'quantity_still_committed', case when v_status = 'reserved' then v_new_reserved - v_new_consumed else 0 end);
end;
$$;

-- ============================================================================
-- Grants: service_role only. No tenant role can reserve, settle or read.
-- ============================================================================
revoke all on function public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer)
  from public, anon, authenticated;
revoke all on function public.settle_usage_reservation(uuid, integer, integer, jsonb) from public, anon, authenticated;

grant execute on function public.reserve_usage_allowance(text, uuid, uuid, text, integer, integer, date, date, text, text, text, uuid, uuid, uuid[], integer)
  to service_role;
grant execute on function public.settle_usage_reservation(uuid, integer, integer, jsonb) to service_role;
grant select, insert, update, delete on table public.usage_reservations to service_role;

commit;
