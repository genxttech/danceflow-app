-- PROPOSAL ONLY. NOT APPLIED to any hosted database. This is not a migration: it deliberately lives outside
-- src/lib/supabase/migrations. Moving it there, and any DEV or PROD apply, needs review and the owner SQL gate.
-- Design: docs/ai/AI_Usage_Ledger_Proposal.md. Rollback: ai_usage_ledger_v1_rollback.sql.

begin;

-- The foreign keys below briefly lock auth.users and studios: give up rather than queue logins behind a long transaction.
set local lock_timeout = '3s';

-- Database-held switches and caps. A feature with no row, or a disabled row, is refused: fail closed. Every limit
-- defaults to 0, so a row enabled without limits admits nothing.
-- The row with feature '*' is the platform-wide switch and cost ceilings; its count limits are not used.
create table public.ai_spend_controls (
  feature text primary key check (length(feature) between 1 and 60),
  enabled boolean not null default false,
  -- the only payer this feature may charge (null on the '*' row)
  payer_scope text check (payer_scope in ('platform_personal', 'platform_public', 'studio_ops', 'studio_lumi_pool')),
  per_payer_day integer not null default 0 check (per_payer_day >= 0),
  per_payer_month integer not null default 0 check (per_payer_month >= 0),
  -- per person (or per anonymous client), whoever pays
  per_actor_day integer not null default 0 check (per_actor_day >= 0),
  per_actor_minute integer not null default 0 check (per_actor_minute >= 0),
  per_actor_in_flight integer not null default 0 check (per_actor_in_flight >= 0),
  -- how long an unsettled reservation counts as in flight; longer than the provider timeout plus settlement
  in_flight_window_seconds integer not null default 60 check (in_flight_window_seconds between 20 and 600),
  day_cost_cap_micros bigint not null default 0 check (day_cost_cap_micros >= 0),
  month_cost_cap_micros bigint not null default 0 check (month_cost_cap_micros >= 0),
  updated_at timestamptz not null default now(),
  constraint ai_spend_controls_scope_check check ((feature = '*') = (payer_scope is null))
);

-- One row per admitted provider request. No prompt or response content.
create table public.ai_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  feature text not null references public.ai_spend_controls(feature),
  -- who pays. Studio sponsorship is deliberately absent until it is approved.
  payer_scope text not null check (payer_scope in ('platform_personal', 'platform_public', 'studio_ops', 'studio_lumi_pool')),
  payer_id uuid not null,
  -- who asked: the user id as text, or for an anonymous visitor a server-made keyed hash. Never a raw address.
  actor_key text not null check (length(actor_key) between 1 and 100),
  actor_user_id uuid references auth.users(id) on delete set null,
  -- whose data was used, which is not necessarily who pays
  studio_context_id uuid references public.studios(id) on delete set null,
  -- the caller's per-attempt requestId
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  reserved_cost_micros bigint not null check (reserved_cost_micros > 0),
  settled_cost_micros bigint check (settled_cost_micros >= 0),
  model text check (length(model) <= 100),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cached_tokens integer check (cached_tokens >= 0),
  -- short codes only, never content
  outcome text check (length(outcome) <= 60),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

-- Scoped to the actor, not the payer: two people can never collide, and a resend is a duplicate even if the payer
-- were resolved differently the second time.
create unique index ai_usage_ledger_idempotency_unique
  on public.ai_usage_ledger (feature, actor_key, idempotency_key);
create index ai_usage_ledger_payer_idx on public.ai_usage_ledger (feature, payer_scope, payer_id, created_at);
create index ai_usage_ledger_actor_idx on public.ai_usage_ledger (feature, actor_key, created_at);
create index ai_usage_ledger_feature_idx on public.ai_usage_ledger (feature, created_at);
create index ai_usage_ledger_created_idx on public.ai_usage_ledger (created_at);

alter table public.ai_spend_controls enable row level security;
alter table public.ai_usage_ledger enable row level security;
-- Hosted Supabase grants new tables to service_role by default: revoke first, then grant only what is needed.
revoke all on table public.ai_spend_controls, public.ai_usage_ledger from public, anon, authenticated, service_role;
grant select, insert, update on table public.ai_spend_controls to service_role;
grant select on table public.ai_usage_ledger to service_role;

-- Reserve capacity BEFORE the provider call. p_cost_micros is the worst-case cost of the request. Every payer and actor
-- value must be derived by the server from the authenticated identity, never taken from a client.
create function public.ai_reserve(
  p_feature text,
  p_payer_scope text,
  p_payer_id uuid,
  p_actor_key text,
  p_actor_user_id uuid,
  p_studio_context_id uuid,
  p_idempotency_key text,
  p_cost_micros bigint,
  -- The payer's own allowance, which differs by studio. Only ever tightens the feature's per-payer limits. A studio
  -- payer must pass the monthly one.
  p_payer_day_limit integer default null,
  p_payer_month_limit integer default null
) returns table (reservation_id uuid, admitted boolean, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_global public.ai_spend_controls%rowtype;
  v_control public.ai_spend_controls%rowtype;
  v_existing_status text;
  v_now timestamptz;
  v_day timestamptz;
  v_month timestamptz;
  v_count bigint;
  v_day_cost numeric;
  v_month_cost numeric;
  v_id uuid;
begin
  if p_cost_micros is null or p_cost_micros <= 0 or p_payer_id is null
     or coalesce(length(p_actor_key), 0) not between 1 and 100
     or coalesce(length(p_idempotency_key), 0) not between 1 and 200
     or p_payer_day_limit < 0 or p_payer_month_limit < 0
     or (p_payer_scope in ('studio_ops', 'studio_lumi_pool') and p_payer_month_limit is null) then
    return query select null::uuid, false, 'invalid_request'::text;
    return;
  end if;

  -- The counts below rely on each statement seeing what committed before the lock was taken.
  if current_setting('transaction_isolation') <> 'read committed' then
    return query select null::uuid, false, 'invalid_isolation'::text;
    return;
  end if;

  -- Lock order is always global row then feature row: reservations are serialized, so no cap can be raced.
  select * into v_global from public.ai_spend_controls c where c.feature = '*' for update;
  if not found or not v_global.enabled then
    return query select null::uuid, false, 'disabled'::text;
    return;
  end if;
  select * into v_control from public.ai_spend_controls c where c.feature = p_feature and c.feature <> '*' for update;
  if not found or not v_control.enabled then
    return query select null::uuid, false, 'disabled'::text;
    return;
  end if;

  -- Taken after the locks: a request that waited is dated, and windowed, by when it is actually decided.
  v_now := clock_timestamp();
  v_day := date_trunc('day', v_now at time zone 'utc') at time zone 'utc';
  v_month := date_trunc('month', v_now at time zone 'utc') at time zone 'utc';

  -- A feature charges one kind of payer. A personal payer is the actor; anything but an anonymous request has a user.
  -- The public payer is one fixed id with no user.
  if p_payer_scope is distinct from v_control.payer_scope
     or (p_payer_scope <> 'platform_public' and (p_actor_user_id is null or p_actor_key <> p_actor_user_id::text))
     or (p_payer_scope = 'platform_personal' and p_payer_id <> p_actor_user_id)
     or (p_payer_scope = 'platform_public'
         and (p_payer_id <> '00000000-0000-0000-0000-000000000000'::uuid or p_actor_user_id is not null)) then
    return query select null::uuid, false, 'invalid_payer'::text;
    return;
  end if;

  -- A resend of the same attempt is never admitted again, and gets no reservation id, so it cannot settle or release the
  -- original. The key stays used after release: a new attempt needs a new requestId.
  select l.status into v_existing_status from public.ai_usage_ledger l
   where l.feature = p_feature and l.actor_key = p_actor_key and l.idempotency_key = p_idempotency_key;
  if found then
    return query select null::uuid, false, 'duplicate_' || v_existing_status;
    return;
  end if;

  -- Concurrency: unsettled reservations that are still recent. An abandoned one stops counting here after the window,
  -- but stays counted in the day, month and cost limits.
  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.actor_key = p_actor_key and l.status = 'reserved'
     and l.created_at > v_now - make_interval(secs => v_control.in_flight_window_seconds);
  if v_count >= v_control.per_actor_in_flight then
    return query select null::uuid, false, 'actor_in_flight'::text;
    return;
  end if;

  -- Burst: every admitted attempt in the last minute, including released ones.
  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.actor_key = p_actor_key and l.created_at > v_now - interval '1 minute';
  if v_count >= v_control.per_actor_minute then
    return query select null::uuid, false, 'actor_burst'::text;
    return;
  end if;

  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.actor_key = p_actor_key and l.status <> 'released' and l.created_at >= v_day;
  if v_count >= v_control.per_actor_day then
    return query select null::uuid, false, 'actor_day'::text;
    return;
  end if;

  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.payer_scope = p_payer_scope and l.payer_id = p_payer_id
     and l.status <> 'released' and l.created_at >= v_day;
  -- least() ignores a null argument, so without a caller allowance the feature limit applies.
  if v_count >= least(v_control.per_payer_day, p_payer_day_limit) then
    return query select null::uuid, false, 'payer_day'::text;
    return;
  end if;

  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.payer_scope = p_payer_scope and l.payer_id = p_payer_id
     and l.status <> 'released' and l.created_at >= v_month;
  if v_count >= least(v_control.per_payer_month, p_payer_month_limit) then
    return query select null::uuid, false, 'payer_month'::text;
    return;
  end if;

  -- Cost ceilings: this feature, then the whole platform; unsettled rows count at their worst case.
  select coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)) filter (where l.created_at >= v_day), 0),
         coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)), 0)
    into v_day_cost, v_month_cost
    from public.ai_usage_ledger l
   where l.feature = p_feature and l.status <> 'released' and l.created_at >= v_month;
  if v_day_cost + p_cost_micros > v_control.day_cost_cap_micros then
    return query select null::uuid, false, 'feature_day_cost'::text;
    return;
  end if;
  if v_month_cost + p_cost_micros > v_control.month_cost_cap_micros then
    return query select null::uuid, false, 'feature_month_cost'::text;
    return;
  end if;

  select coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)) filter (where l.created_at >= v_day), 0),
         coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)), 0)
    into v_day_cost, v_month_cost
    from public.ai_usage_ledger l
   where l.status <> 'released' and l.created_at >= v_month;
  if v_day_cost + p_cost_micros > v_global.day_cost_cap_micros then
    return query select null::uuid, false, 'global_day_cost'::text;
    return;
  end if;
  if v_month_cost + p_cost_micros > v_global.month_cost_cap_micros then
    return query select null::uuid, false, 'global_month_cost'::text;
    return;
  end if;

  insert into public.ai_usage_ledger (
    feature, payer_scope, payer_id, actor_key, actor_user_id, studio_context_id, idempotency_key, reserved_cost_micros, created_at
  ) values (
    p_feature, p_payer_scope, p_payer_id, p_actor_key, p_actor_user_id, p_studio_context_id, p_idempotency_key, p_cost_micros, v_now
  ) returning id into v_id;

  return query select v_id, true, 'reserved'::text;
exception
  -- Waited longer than lock_timeout: refuse rather than eat the request's time budget. Nothing was written.
  when lock_not_available then
    return query select null::uuid, false, 'lock_timeout'::text;
end;
$$;

-- Settle ('settled', billable or possibly billable) or release ('released', provably not billed). Idempotent: only a
-- reserved row changes. A reservation that is never settled stays counted at its worst-case cost (conservative).
-- A lock timeout raises, so the caller can retry.
-- A settled cost of null or 0 keeps the worst case: a call that may have been billed never frees cost capacity. A real
-- overrun is recorded, bounded at ten times the reservation (or 1 dollar if larger) so one bad value cannot block a month.
create function public.ai_settle(
  p_reservation_id uuid,
  p_status text,
  p_cost_micros bigint default null,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_cached_tokens integer default null,
  p_outcome text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
begin
  if p_status is null or p_status not in ('settled', 'released') or p_cost_micros < 0 then
    return false;
  end if;
  update public.ai_usage_ledger
     set status = p_status,
         settled_cost_micros = case
           when p_status = 'settled' then
             least(coalesce(nullif(p_cost_micros, 0), reserved_cost_micros), greatest(reserved_cost_micros * 10, 1000000))
           else 0
         end,
         model = left(p_model, 100),
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         cached_tokens = p_cached_tokens,
         outcome = left(p_outcome, 60),
         settled_at = now()
   where id = p_reservation_id and status = 'reserved';
  return found;
end;
$$;

revoke all on function public.ai_reserve(text, text, uuid, text, uuid, uuid, text, bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.ai_settle(uuid, text, bigint, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ai_reserve(text, text, uuid, text, uuid, uuid, text, bigint, integer, integer) to service_role;
grant execute on function public.ai_settle(uuid, text, bigint, text, integer, integer, integer, text) to service_role;

commit;
