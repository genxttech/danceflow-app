-- ARIA operational pack preferences and explicit delivery permission.
-- Run after:
--   20260710_aria_operations_action_review_lifecycle.sql
--   20260712_aria_scheduled_operations_runs.sql
--   20260710000400_expand_automation_rule_keys_for_aria_operations.sql
--   20260710000500_expand_automation_action_event_types_for_aria.sql
--   20260710000600_expand_aria_execution_event_types.sql

create table if not exists public.aria_automation_pack_preferences (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  pack_key text not null,
  enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (studio_id, pack_key),
  constraint aria_automation_pack_preferences_pack_key_check check (
    pack_key in (
      'front_desk',
      'client_relations',
      'scheduling',
      'sales_retention',
      'marketing',
      'billing_payments',
      'documents',
      'events',
      'staff_payroll',
      'retail_inventory',
      'studio_health'
    )
  )
);

create index if not exists aria_automation_pack_preferences_studio_idx
  on public.aria_automation_pack_preferences (studio_id, pack_key);

alter table public.aria_automation_pack_preferences enable row level security;

drop policy if exists "aria pack preferences workspace read"
  on public.aria_automation_pack_preferences;
create policy "aria pack preferences workspace read"
  on public.aria_automation_pack_preferences
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_automation_pack_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

drop policy if exists "aria pack preferences managers write"
  on public.aria_automation_pack_preferences;
create policy "aria pack preferences managers write"
  on public.aria_automation_pack_preferences
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_automation_pack_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin', 'studio_owner', 'studio_admin')
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in ('organizer_owner', 'organizer_admin')
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_automation_pack_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin', 'studio_owner', 'studio_admin')
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in ('organizer_owner', 'organizer_admin')
    )
  );

alter table if exists public.aria_action_policies
  add column if not exists pack_key text,
  add column if not exists handling_mode text,
  add column if not exists delivery_mode text,
  add column if not exists default_source text not null default 'studio_override';

alter table if exists public.automation_rules
  add column if not exists pack_key text,
  add column if not exists default_source text not null default 'studio_override';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aria_action_policies_handling_mode_check'
  ) then
    alter table public.aria_action_policies
      add constraint aria_action_policies_handling_mode_check
      check (
        handling_mode is null or handling_mode in (
          'automatic',
          'automatic_with_notification',
          'approval_required'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'aria_action_policies_delivery_mode_check'
  ) then
    alter table public.aria_action_policies
      add constraint aria_action_policies_delivery_mode_check
      check (
        delivery_mode is null or delivery_mode in (
          'internal_only',
          'suggestion_only',
          'draft_for_review',
          'auto_send'
        )
      );
  end if;
end $$;

create index if not exists aria_action_policies_studio_pack_idx
  on public.aria_action_policies (studio_id, pack_key);

create index if not exists automation_rules_studio_pack_idx
  on public.automation_rules (studio_id, pack_key);

comment on column public.aria_action_policies.auto_approve is
  'Approves the operational decision only. It does not grant external delivery permission.';

comment on column public.aria_action_policies.delivery_mode is
  'Describes the default delivery boundary. External delivery is enforced by automation_rules.mode.';

comment on column public.automation_rules.mode is
  'External delivery permission. Only enabled rules with mode auto_send may send automatically.';
