-- PAY-WH-1 M1 -- Stripe webhook event claims (lease ownership) on payment_provider_events.
--
-- Before: the route did select -> insert/update -> process -> update, so two concurrent deliveries of the same
-- event could both process it, and a slow worker could finalize an event another worker had already retried.
-- After: one atomic claim per delivery attempt. A claim has an owner and a lease; only the current owner can
-- complete it; an expired lease can be reclaimed; a processed event is acknowledged idempotently.
-- Settlement functions (M2) additionally lock and verify the claim inside their own transaction, so a worker whose
-- lease was taken over can never commit a settlement.
--
-- Additive and compatible with the pre-PAY-WH-1 route (it keeps using status received/processed/failed and never
-- sets the new columns). Rollback: rollback/20261116090000_paywh1_webhook_event_claims_rollback.sql.

begin;

alter table public.payment_provider_events
  add column if not exists claim_owner uuid null,
  add column if not exists claim_expires_at timestamptz null,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz null,
  add column if not exists last_error_at timestamptz null,
  add column if not exists outcome text null;

-- Existing statuses: received / processed / failed. 'processing' = claimed by an owner with a lease.
alter table public.payment_provider_events
  drop constraint if exists payment_provider_events_status_check;
alter table public.payment_provider_events
  add constraint payment_provider_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed')) not valid;
alter table public.payment_provider_events
  validate constraint payment_provider_events_status_check;

alter table public.payment_provider_events
  drop constraint if exists payment_provider_events_claim_consistency;
alter table public.payment_provider_events
  add constraint payment_provider_events_claim_consistency
  check (status <> 'processing' or (claim_owner is not null and claim_expires_at is not null)) not valid;
alter table public.payment_provider_events
  validate constraint payment_provider_events_claim_consistency;

create index if not exists payment_provider_events_unresolved_idx
  on public.payment_provider_events (status, created_at)
  where status in ('received', 'processing', 'failed');

-- Claim a delivery of a provider event.
-- Returns {outcome: 'claimed' | 'already_processed' | 'in_progress', attempt_count}.
create or replace function public.claim_payment_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_payload_hash text,
  p_owner uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.payment_provider_events%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 15), 900);
begin
  if p_provider is null or p_provider_event_id is null or length(p_provider_event_id) = 0 or p_owner is null then
    raise exception 'claim_payment_provider_event: provider, event id and owner are required' using errcode = '22023';
  end if;

  insert into public.payment_provider_events (provider, provider_event_id, event_type, status, payload_hash)
  values (p_provider, p_provider_event_id, p_event_type, 'received', p_payload_hash)
  on conflict (provider, provider_event_id) do nothing;

  select * into v_row
  from public.payment_provider_events
  where provider = p_provider and provider_event_id = p_provider_event_id
  for update;

  if v_row.status = 'processed' then
    return jsonb_build_object('outcome', 'already_processed', 'attempt_count', v_row.attempt_count);
  end if;

  if v_row.status = 'processing' and v_row.claim_expires_at > now() and v_row.claim_owner <> p_owner then
    return jsonb_build_object('outcome', 'in_progress', 'attempt_count', v_row.attempt_count);
  end if;

  update public.payment_provider_events
  set status = 'processing',
      event_type = coalesce(p_event_type, event_type),
      payload_hash = coalesce(p_payload_hash, payload_hash),
      claim_owner = p_owner,
      claim_expires_at = now() + make_interval(secs => v_lease),
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      processed_at = null
  where id = v_row.id;

  return jsonb_build_object('outcome', 'claimed', 'attempt_count', v_row.attempt_count + 1);
end;
$$;

-- Complete a claimed delivery. Only the current claim owner can complete it; returns false otherwise
-- (the claim was taken over after its lease expired, or the event was already finalized).
create or replace function public.complete_payment_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_owner uuid,
  p_status text,
  p_outcome text default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('processed', 'failed') then
    raise exception 'complete_payment_provider_event: status must be processed or failed' using errcode = '22023';
  end if;

  update public.payment_provider_events
  set status = p_status,
      outcome = p_outcome,
      processed_at = case when p_status = 'processed' then now() else null end,
      error_message = case when p_status = 'failed' then left(coalesce(p_error, 'failed'), 2000) else null end,
      last_error_at = case when p_status = 'failed' then now() else last_error_at end,
      claim_owner = null,
      claim_expires_at = null
  where provider = p_provider
    and provider_event_id = p_provider_event_id
    and status = 'processing'
    and claim_owner = p_owner;

  return found;
end;
$$;

-- Used inside settlement functions: lock the claim row and require that the caller still owns it.
create or replace function public._paywh1_require_event_claim(p_provider_event_id text, p_owner uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_status text;
begin
  select claim_owner, status into v_owner, v_status
  from public.payment_provider_events
  where provider = 'stripe' and provider_event_id = p_provider_event_id
  for update;

  if not found or v_status <> 'processing' or v_owner is distinct from p_owner then
    raise exception 'paywh1_claim_not_owned' using errcode = '55000';
  end if;
end;
$$;

revoke all on function public.claim_payment_provider_event(text, text, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_payment_provider_event(text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public._paywh1_require_event_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_payment_provider_event(text, text, text, text, uuid, integer) to service_role;
grant execute on function public.complete_payment_provider_event(text, text, uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
