-- ARIA Safe Automation Defaults and Pack Preferences V1
-- Run in production before deploying the matching application files.

alter table if exists public.aria_action_policies
  add column if not exists default_source text not null default 'studio_override',
  add column if not exists handling_mode text,
  add column if not exists pack_key text;

alter table if exists public.aria_action_policies
  drop constraint if exists aria_action_policies_handling_mode_check;

alter table if exists public.aria_action_policies
  add constraint aria_action_policies_handling_mode_check
  check (
    handling_mode is null or handling_mode in (
      'automatic',
      'automatic_with_notification',
      'approval_required'
    )
  );

create table if not exists public.aria_automation_pack_preferences (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  pack_key text not null,
  enabled boolean not null default true,
  paused_at timestamptz,
  paused_by uuid references auth.users(id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint aria_automation_pack_preferences_pack_key_check check (
    pack_key in (
      'front_desk',
      'lead_follow_up',
      'schedule_readiness',
      'client_retention',
      'documents',
      'membership_package_care',
      'post_lesson_closeout',
      'payment_follow_up'
    )
  ),
  constraint aria_automation_pack_preferences_studio_pack_key unique (studio_id, pack_key)
);

create index if not exists aria_automation_pack_preferences_studio_enabled_idx
  on public.aria_automation_pack_preferences (studio_id, enabled, pack_key);

alter table public.aria_automation_pack_preferences enable row level security;

drop policy if exists aria_automation_pack_preferences_select_by_workspace
  on public.aria_automation_pack_preferences;

drop policy if exists aria_automation_pack_preferences_manage_by_workspace
  on public.aria_automation_pack_preferences;

create policy aria_automation_pack_preferences_select_by_workspace
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
      join public.organizer_users ou
        on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

create policy aria_automation_pack_preferences_manage_by_workspace
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
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou
        on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_automation_pack_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
    or exists (
      select 1
      from public.organizers o
      join public.organizer_users ou
        on ou.organizer_id = o.id
      where o.studio_id = aria_automation_pack_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'organizer_owner',
          'organizer_admin'
        )
    )
  );
