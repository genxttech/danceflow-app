create table if not exists public.aria_digest_preferences (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  morning_digest_enabled boolean not null default true,
  end_of_day_digest_enabled boolean not null default true,
  delivery_channel text not null default 'in_app' check (delivery_channel in ('in_app', 'email')),
  default_recipient_user_id uuid null,
  morning_digest_time time without time zone not null default time '08:00',
  end_of_day_digest_time time without time zone not null default time '17:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null
);

create index if not exists aria_digest_preferences_recipient_idx
  on public.aria_digest_preferences(default_recipient_user_id)
  where default_recipient_user_id is not null;

alter table public.aria_digest_preferences enable row level security;

drop policy if exists "Users can view ARIA digest preferences for their studios"
  on public.aria_digest_preferences;

drop policy if exists "Managers can manage ARIA digest preferences for their studios"
  on public.aria_digest_preferences;

create policy "Users can view ARIA digest preferences for their studios"
  on public.aria_digest_preferences
  for select
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
    )
  );

create policy "Managers can manage ARIA digest preferences for their studios"
  on public.aria_digest_preferences
  for all
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'owner',
          'admin',
          'manager',
          'studio_owner',
          'studio_admin',
          'studio_manager'
        )
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'owner',
          'admin',
          'manager',
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = aria_digest_preferences.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'owner',
          'admin',
          'manager',
          'studio_owner',
          'studio_admin',
          'studio_manager'
        )
    )
    or exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where o.studio_id = aria_digest_preferences.studio_id
        and ou.user_id = auth.uid()
        and ou.active = true
        and ou.role::text in (
          'owner',
          'admin',
          'manager',
          'organizer_owner',
          'organizer_admin',
          'organizer_staff'
        )
    )
  );
