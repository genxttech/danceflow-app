-- PROPOSAL ONLY. NOT APPLIED to any hosted database. This is not a migration: it deliberately lives outside
-- src/lib/supabase/migrations. Moving it there, and any DEV or PROD apply, needs review and the owner SQL gate.
-- Design: docs/ai/AI_Usage_Ledger_Proposal.md. Rollback: ai_usage_ledger_v1_rollback.sql.

begin;

-- Database-held switches and caps. A feature with no row, or a disabled row, is refused: fail closed.
-- The row with feature '*' is the platform-wide switch and daily cost ceiling.
create table public.ai_spend_controls (
  feature text primary key check (length(feature) between 1 and 60),
  enabled boolean not null default false,
  per_payer_day integer not null default 0 check (per_payer_day >= 0),
  per_payer_month integer not null default 0 check (per_payer_month >= 0),
  day_cost_cap_micros bigint not null default 0 check (day_cost_cap_micros >= 0),
  updated_at timestamptz not null default now()
);

-- One row per provider request. No prompt or response content.
create table public.ai_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  feature text not null references public.ai_spend_controls(feature),
  -- who pays. Studio sponsorship is deliberately absent until it is approved.
  payer_scope text not null check (payer_scope in ('platform_personal', 'platform_public', 'studio_ops', 'studio_lumi_pool')),
  payer_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  -- whose data was used, which is not necessarily who pays
  studio_context_id uuid references public.studios(id) on delete set null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  reserved_cost_micros bigint not null check (reserved_cost_micros > 0),
  settled_cost_micros bigint check (settled_cost_micros >= 0),
  model text,
  input_tokens integer,
  output_tokens integer,
  cached_tokens integer,
  outcome text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create unique index ai_usage_ledger_idempotency_unique
  on public.ai_usage_ledger (feature, payer_scope, payer_id, idempotency_key);
create index ai_usage_ledger_payer_idx on public.ai_usage_ledger (feature, payer_scope, payer_id, created_at);
create index ai_usage_ledger_created_idx on public.ai_usage_ledger (created_at);

alter table public.ai_spend_controls enable row level security;
alter table public.ai_usage_ledger enable row level security;
-- Hosted Supabase grants new tables to service_role by default: revoke first, then grant only what is needed.
revoke all on table public.ai_spend_controls, public.ai_usage_ledger from public, anon, authenticated, service_role;
grant select, insert, update on table public.ai_spend_controls to service_role;
grant select on table public.ai_usage_ledger to service_role;

-- Reserve capacity BEFORE the provider call. p_cost_micros is the worst-case cost of the request.
create function public.ai_reserve(
  p_feature text,
  p_payer_scope text,
  p_payer_id uuid,
  p_actor_user_id uuid,
  p_studio_context_id uuid,
  p_idempotency_key text,
  p_cost_micros bigint
) returns table (reservation_id uuid, admitted boolean, reason text, reused boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_global public.ai_spend_controls%rowtype;
  v_control public.ai_spend_controls%rowtype;
  v_existing public.ai_usage_ledger%rowtype;
  v_day timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_count integer;
  v_cost bigint;
  v_id uuid;
begin
  if p_cost_micros is null or p_cost_micros <= 0 or p_payer_id is null then
    return query select null::uuid, false, 'invalid_request'::text, false;
    return;
  end if;

  -- Lock order is always global row then feature row: reservations are serialized, so no cap can be raced.
  select * into v_global from public.ai_spend_controls c where c.feature = '*' for update;
  if not found or not v_global.enabled then
    return query select null::uuid, false, 'disabled'::text, false;
    return;
  end if;
  select * into v_control from public.ai_spend_controls c where c.feature = p_feature and c.feature <> '*' for update;
  if not found or not v_control.enabled then
    return query select null::uuid, false, 'disabled'::text, false;
    return;
  end if;

  -- A retry with the same key never reserves twice and is never admitted again: the caller must not dispatch a second
  -- provider call. A key stays used after release; a deliberate new attempt needs a new key.
  select * into v_existing from public.ai_usage_ledger l
   where l.feature = p_feature and l.payer_scope = p_payer_scope and l.payer_id = p_payer_id
     and l.idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, false, 'duplicate_' || v_existing.status, true;
    return;
  end if;

  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.payer_scope = p_payer_scope and l.payer_id = p_payer_id
     and l.status <> 'released' and l.created_at >= v_day;
  if v_count >= v_control.per_payer_day then
    return query select null::uuid, false, 'payer_day'::text, false;
    return;
  end if;

  select count(*) into v_count from public.ai_usage_ledger l
   where l.feature = p_feature and l.payer_scope = p_payer_scope and l.payer_id = p_payer_id
     and l.status <> 'released' and l.created_at >= v_month;
  if v_count >= v_control.per_payer_month then
    return query select null::uuid, false, 'payer_month'::text, false;
    return;
  end if;

  select coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)), 0) into v_cost
    from public.ai_usage_ledger l
   where l.feature = p_feature and l.status <> 'released' and l.created_at >= v_day;
  if v_cost + p_cost_micros > v_control.day_cost_cap_micros then
    return query select null::uuid, false, 'feature_day_cost'::text, false;
    return;
  end if;

  select coalesce(sum(coalesce(l.settled_cost_micros, l.reserved_cost_micros)), 0) into v_cost
    from public.ai_usage_ledger l
   where l.status <> 'released' and l.created_at >= v_day;
  if v_cost + p_cost_micros > v_global.day_cost_cap_micros then
    return query select null::uuid, false, 'global_day_cost'::text, false;
    return;
  end if;

  insert into public.ai_usage_ledger (
    feature, payer_scope, payer_id, actor_user_id, studio_context_id, idempotency_key, reserved_cost_micros
  ) values (
    p_feature, p_payer_scope, p_payer_id, p_actor_user_id, p_studio_context_id, p_idempotency_key, p_cost_micros
  ) returning id into v_id;

  return query select v_id, true, 'reserved'::text, false;
end;
$$;

-- Settle ('settled', billable or possibly billable) or release ('released', provably not billed). Idempotent: only a
-- reserved row changes. A reservation that is never settled stays counted at its worst-case cost (conservative).
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
as $$
begin
  if p_status not in ('settled', 'released') then
    return false;
  end if;
  update public.ai_usage_ledger
     set status = p_status,
         settled_cost_micros = case when p_status = 'settled' then coalesce(p_cost_micros, reserved_cost_micros) else 0 end,
         model = p_model,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         cached_tokens = p_cached_tokens,
         outcome = p_outcome,
         settled_at = now()
   where id = p_reservation_id and status = 'reserved';
  return found;
end;
$$;

revoke all on function public.ai_reserve(text, text, uuid, uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.ai_settle(uuid, text, bigint, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ai_reserve(text, text, uuid, uuid, uuid, text, bigint) to service_role;
grant execute on function public.ai_settle(uuid, text, bigint, text, integer, integer, integer, text) to service_role;

commit;
