-- Rewards V1 foundation.
-- Studios define reward rules and reward value. DanceFlow tracks progress and awards consistently.
-- Run in dev first, verify RLS and table creation, then run the same migration in production
-- before deploying Rewards V1 application code.

begin;

-- ---------------------------------------------------------------------------
-- 1. Access helpers
-- ---------------------------------------------------------------------------

create or replace function public.can_manage_studio_rewards(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
      and usr.role::text in ('studio_owner', 'studio_admin')
  );
$$;

create or replace function public.can_view_studio_rewards(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
  )
  or exists (
    select 1
    from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = target_studio_id
      and cal.status = 'linked'
  );
$$;

create or replace function public.can_view_client_rewards(
  target_studio_id uuid,
  target_client_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
  )
  or exists (
    select 1
    from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = target_studio_id
      and cal.client_id = target_client_id
      and cal.status = 'linked'
  );
$$;

revoke all on function public.can_manage_studio_rewards(uuid) from public;
revoke all on function public.can_view_studio_rewards(uuid) from public;
revoke all on function public.can_view_client_rewards(uuid, uuid) from public;

grant execute on function public.can_manage_studio_rewards(uuid)
  to authenticated, service_role;
grant execute on function public.can_view_studio_rewards(uuid)
  to authenticated, service_role;
grant execute on function public.can_view_client_rewards(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Studio reward definitions
-- ---------------------------------------------------------------------------

create table if not exists public.studio_rewards (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  description text,
  reward_type text not null,
  reward_value numeric(12,2),
  reward_config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  expires_after_days integer,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint studio_rewards_name_not_blank
    check (length(trim(name)) > 0),

  constraint studio_rewards_reward_type_check
    check (
      reward_type in (
        'points',
        'account_credit',
        'fixed_discount',
        'percent_discount',
        'free_class',
        'package_credit',
        'custom_perk'
      )
    ),

  constraint studio_rewards_value_check
    check (
      (reward_type in ('points', 'account_credit', 'fixed_discount', 'percent_discount')
        and reward_value is not null
        and reward_value > 0)
      or
      (reward_type in ('free_class', 'package_credit', 'custom_perk'))
    ),

  constraint studio_rewards_percent_check
    check (
      reward_type <> 'percent_discount'
      or (reward_value > 0 and reward_value <= 100)
    ),

  constraint studio_rewards_expiration_check
    check (expires_after_days is null or expires_after_days > 0)
);

create index if not exists studio_rewards_studio_active_idx
  on public.studio_rewards(studio_id, active, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Reward rules
-- ---------------------------------------------------------------------------

create table if not exists public.reward_rules (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  reward_id uuid not null references public.studio_rewards(id) on delete restrict,
  name text not null,
  description text,
  trigger_type text not null,
  threshold_value numeric(12,2) not null default 1,
  threshold_unit text not null default 'count',
  evaluation_window text not null default 'lifetime',
  eligibility_config jsonb not null default '{}'::jsonb,
  repeatable boolean not null default false,
  cooldown_days integer,
  max_awards_per_client integer,
  active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reward_rules_name_not_blank
    check (length(trim(name)) > 0),

  constraint reward_rules_trigger_type_check
    check (
      trigger_type in (
        'referral_converted',
        'attendance_milestone',
        'membership_renewal',
        'intro_completed',
        'spend_milestone',
        'participation_milestone',
        'review_or_feedback_completed'
      )
    ),

  constraint reward_rules_threshold_positive_check
    check (threshold_value > 0),

  constraint reward_rules_threshold_unit_check
    check (threshold_unit in ('count', 'currency')),

  constraint reward_rules_evaluation_window_check
    check (evaluation_window in ('lifetime', 'calendar_month', 'calendar_year', 'membership_period')),

  constraint reward_rules_cooldown_check
    check (cooldown_days is null or cooldown_days >= 0),

  constraint reward_rules_max_awards_check
    check (max_awards_per_client is null or max_awards_per_client > 0),

  constraint reward_rules_dates_check
    check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists reward_rules_studio_active_trigger_idx
  on public.reward_rules(studio_id, active, trigger_type);

create index if not exists reward_rules_reward_idx
  on public.reward_rules(reward_id);

-- Prevent accidentally linking a rule to another studio's reward definition.
create or replace function public.enforce_reward_rule_studio_match()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  reward_studio_id uuid;
begin
  select studio_id
    into reward_studio_id
  from public.studio_rewards
  where id = new.reward_id;

  if reward_studio_id is null or reward_studio_id <> new.studio_id then
    raise exception 'Reward rule and reward definition must belong to the same studio.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_reward_rule_studio_match
  on public.reward_rules;

create trigger trg_enforce_reward_rule_studio_match
before insert or update of studio_id, reward_id
on public.reward_rules
for each row execute function public.enforce_reward_rule_studio_match();

-- ---------------------------------------------------------------------------
-- 4. Per-client rule progress
-- ---------------------------------------------------------------------------

create table if not exists public.client_reward_progress (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  rule_id uuid not null references public.reward_rules(id) on delete cascade,
  progress_value numeric(12,2) not null default 0,
  period_key text not null default 'lifetime',
  qualified_at timestamptz,
  last_source_type text,
  last_source_id uuid,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_reward_progress_nonnegative_check
    check (progress_value >= 0),

  constraint client_reward_progress_period_key_not_blank
    check (length(trim(period_key)) > 0),

  unique (studio_id, client_id, rule_id, period_key)
);

create index if not exists client_reward_progress_client_idx
  on public.client_reward_progress(studio_id, client_id, updated_at desc);

create index if not exists client_reward_progress_rule_idx
  on public.client_reward_progress(rule_id, period_key);

-- ---------------------------------------------------------------------------
-- 5. Earned rewards
-- ---------------------------------------------------------------------------

create table if not exists public.client_rewards (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  rule_id uuid references public.reward_rules(id) on delete set null,
  reward_id uuid not null references public.studio_rewards(id) on delete restrict,

  status text not null default 'earned',
  reward_name_snapshot text not null,
  reward_type_snapshot text not null,
  reward_value_snapshot numeric(12,2),
  reward_config_snapshot jsonb not null default '{}'::jsonb,

  earned_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  expires_at timestamptz,
  redeemed_at timestamptz,
  voided_at timestamptz,
  void_reason text,

  source_type text,
  source_id uuid,
  idempotency_key text,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_rewards_status_check
    check (status in ('earned', 'redeemed', 'expired', 'voided')),

  constraint client_rewards_reward_type_check
    check (
      reward_type_snapshot in (
        'points',
        'account_credit',
        'fixed_discount',
        'percent_discount',
        'free_class',
        'package_credit',
        'custom_perk'
      )
    ),

  constraint client_rewards_dates_check
    check (
      (expires_at is null or expires_at >= available_at)
      and (redeemed_at is null or redeemed_at >= earned_at)
      and (voided_at is null or voided_at >= earned_at)
    )
);

create index if not exists client_rewards_client_status_idx
  on public.client_rewards(studio_id, client_id, status, earned_at desc);

create index if not exists client_rewards_rule_idx
  on public.client_rewards(rule_id, earned_at desc);

create unique index if not exists client_rewards_idempotency_idx
  on public.client_rewards(studio_id, client_id, rule_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 6. Immutable rewards activity ledger
-- ---------------------------------------------------------------------------

create table if not exists public.reward_activity_history (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  rule_id uuid references public.reward_rules(id) on delete set null,
  reward_id uuid references public.studio_rewards(id) on delete set null,
  client_reward_id uuid references public.client_rewards(id) on delete set null,

  activity_type text not null,
  points_delta numeric(12,2),
  value_amount numeric(12,2),
  actor_user_id uuid references auth.users(id) on delete set null,
  source_type text,
  source_id uuid,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint reward_activity_history_activity_type_check
    check (
      activity_type in (
        'progress_recorded',
        'qualified',
        'reward_earned',
        'reward_redeemed',
        'reward_expired',
        'reward_voided',
        'manual_adjustment'
      )
    )
);

create index if not exists reward_activity_history_client_idx
  on public.reward_activity_history(studio_id, client_id, created_at desc);

create index if not exists reward_activity_history_reward_idx
  on public.reward_activity_history(client_reward_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_rewards_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_studio_rewards_updated_at on public.studio_rewards;
create trigger trg_studio_rewards_updated_at
before update on public.studio_rewards
for each row execute function public.set_rewards_updated_at();

drop trigger if exists trg_reward_rules_updated_at on public.reward_rules;
create trigger trg_reward_rules_updated_at
before update on public.reward_rules
for each row execute function public.set_rewards_updated_at();

drop trigger if exists trg_client_reward_progress_updated_at on public.client_reward_progress;
create trigger trg_client_reward_progress_updated_at
before update on public.client_reward_progress
for each row execute function public.set_rewards_updated_at();

drop trigger if exists trg_client_rewards_updated_at on public.client_rewards;
create trigger trg_client_rewards_updated_at
before update on public.client_rewards
for each row execute function public.set_rewards_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Row-level security
-- ---------------------------------------------------------------------------

alter table public.studio_rewards enable row level security;
alter table public.reward_rules enable row level security;
alter table public.client_reward_progress enable row level security;
alter table public.client_rewards enable row level security;
alter table public.reward_activity_history enable row level security;

-- Reward definitions: owners/admins manage; staff and linked clients may read.
drop policy if exists studio_rewards_select on public.studio_rewards;
drop policy if exists studio_rewards_insert on public.studio_rewards;
drop policy if exists studio_rewards_update on public.studio_rewards;
drop policy if exists studio_rewards_delete on public.studio_rewards;

create policy studio_rewards_select
on public.studio_rewards
for select to authenticated
using (public.can_view_studio_rewards(studio_id));

create policy studio_rewards_insert
on public.studio_rewards
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

create policy studio_rewards_update
on public.studio_rewards
for update to authenticated
using (public.can_manage_studio_rewards(studio_id))
with check (public.can_manage_studio_rewards(studio_id));

create policy studio_rewards_delete
on public.studio_rewards
for delete to authenticated
using (public.can_manage_studio_rewards(studio_id));

-- Rules: owners/admins manage; staff and linked clients may read.
drop policy if exists reward_rules_select on public.reward_rules;
drop policy if exists reward_rules_insert on public.reward_rules;
drop policy if exists reward_rules_update on public.reward_rules;
drop policy if exists reward_rules_delete on public.reward_rules;

create policy reward_rules_select
on public.reward_rules
for select to authenticated
using (public.can_view_studio_rewards(studio_id));

create policy reward_rules_insert
on public.reward_rules
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

create policy reward_rules_update
on public.reward_rules
for update to authenticated
using (public.can_manage_studio_rewards(studio_id))
with check (public.can_manage_studio_rewards(studio_id));

create policy reward_rules_delete
on public.reward_rules
for delete to authenticated
using (public.can_manage_studio_rewards(studio_id));

-- Progress: studio staff and the linked client can read. Writes are owner/admin or service role.
drop policy if exists client_reward_progress_select on public.client_reward_progress;
drop policy if exists client_reward_progress_insert on public.client_reward_progress;
drop policy if exists client_reward_progress_update on public.client_reward_progress;
drop policy if exists client_reward_progress_delete on public.client_reward_progress;

create policy client_reward_progress_select
on public.client_reward_progress
for select to authenticated
using (public.can_view_client_rewards(studio_id, client_id));

create policy client_reward_progress_insert
on public.client_reward_progress
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

create policy client_reward_progress_update
on public.client_reward_progress
for update to authenticated
using (public.can_manage_studio_rewards(studio_id))
with check (public.can_manage_studio_rewards(studio_id));

create policy client_reward_progress_delete
on public.client_reward_progress
for delete to authenticated
using (public.can_manage_studio_rewards(studio_id));

-- Earned rewards: studio staff and linked client can read. Owners/admins may manage status.
drop policy if exists client_rewards_select on public.client_rewards;
drop policy if exists client_rewards_insert on public.client_rewards;
drop policy if exists client_rewards_update on public.client_rewards;
drop policy if exists client_rewards_delete on public.client_rewards;

create policy client_rewards_select
on public.client_rewards
for select to authenticated
using (public.can_view_client_rewards(studio_id, client_id));

create policy client_rewards_insert
on public.client_rewards
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

create policy client_rewards_update
on public.client_rewards
for update to authenticated
using (public.can_manage_studio_rewards(studio_id))
with check (public.can_manage_studio_rewards(studio_id));

create policy client_rewards_delete
on public.client_rewards
for delete to authenticated
using (public.can_manage_studio_rewards(studio_id));

-- Activity history is append-only from the client application's perspective.
drop policy if exists reward_activity_history_select on public.reward_activity_history;
drop policy if exists reward_activity_history_insert on public.reward_activity_history;

create policy reward_activity_history_select
on public.reward_activity_history
for select to authenticated
using (
  client_id is not null
  and public.can_view_client_rewards(studio_id, client_id)
);

create policy reward_activity_history_insert
on public.reward_activity_history
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

-- No UPDATE or DELETE policies are intentionally created for reward_activity_history.

-- ---------------------------------------------------------------------------
-- 9. Default templates
-- ---------------------------------------------------------------------------
-- Templates are application-owned rather than inserted for every studio here.
-- This keeps studio activation explicit and prevents migration-time creation
-- of active reward value.

commit;
