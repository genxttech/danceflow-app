-- Event Attendee Details V1
-- Adds attendees-per-ticket support and stores attendee rows with event registrations.
-- Save in: src/lib/supabase/migrations/<timestamp>_event_attendee_details_v1.sql

alter table if exists public.event_ticket_types
  add column if not exists attendees_per_ticket integer not null default 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_ticket_types_attendees_per_ticket_check'
  ) then
    alter table public.event_ticket_types
      add constraint event_ticket_types_attendees_per_ticket_check
      check (attendees_per_ticket >= 1 and attendees_per_ticket <= 20);
  end if;
end $$;

create table if not exists public.event_registration_attendees (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  ticket_type_id uuid references public.event_ticket_types(id) on delete set null,
  first_name text,
  last_name text,
  email text,
  phone text,
  attendee_role text not null default 'attendee',
  sort_order integer not null default 1,
  checked_in_at timestamp with time zone,
  checked_in_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table if exists public.event_registration_attendees
  add column if not exists event_id uuid references public.events(id) on delete cascade,
  add column if not exists ticket_type_id uuid references public.event_ticket_types(id) on delete set null,
  add column if not exists sort_order integer not null default 1,
  add column if not exists checked_in_at timestamp with time zone,
  add column if not exists checked_in_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_at timestamp with time zone not null default now();

update public.event_registration_attendees era
set
  event_id = er.event_id,
  ticket_type_id = er.ticket_type_id
from public.event_registrations er
where era.registration_id = er.id
  and (era.event_id is null or era.ticket_type_id is null);

create index if not exists event_registration_attendees_registration_id_idx
  on public.event_registration_attendees(registration_id);

create index if not exists event_registration_attendees_event_id_idx
  on public.event_registration_attendees(event_id);

create index if not exists event_registration_attendees_ticket_type_id_idx
  on public.event_registration_attendees(ticket_type_id);

create index if not exists event_registration_attendees_sort_idx
  on public.event_registration_attendees(registration_id, sort_order);

alter table public.event_registration_attendees enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'event_registration_attendees'
      and policyname = 'event_registration_attendees_public_insert'
  ) then
    create policy event_registration_attendees_public_insert
      on public.event_registration_attendees
      for insert
      with check (
        exists (
          select 1
          from public.event_registrations er
          join public.events e on e.id = er.event_id
          where er.id = registration_id
            and e.id = event_id
            and e.status = 'published'
            and e.visibility in ('public', 'unlisted')
            and e.registration_required = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'event_registration_attendees'
      and policyname = 'event_registration_attendees_studio_member_select'
  ) then
    create policy event_registration_attendees_studio_member_select
      on public.event_registration_attendees
      for select
      using (
        exists (
          select 1
          from public.event_registrations er
          join public.user_studio_roles usr on usr.studio_id = er.studio_id
          where er.id = registration_id
            and usr.user_id = auth.uid()
            and usr.active = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'event_registration_attendees'
      and policyname = 'event_registration_attendees_studio_member_manage'
  ) then
    create policy event_registration_attendees_studio_member_manage
      on public.event_registration_attendees
      for all
      using (
        exists (
          select 1
          from public.event_registrations er
          join public.user_studio_roles usr on usr.studio_id = er.studio_id
          where er.id = registration_id
            and usr.user_id = auth.uid()
            and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
        )
      )
      with check (
        exists (
          select 1
          from public.event_registrations er
          join public.user_studio_roles usr on usr.studio_id = er.studio_id
          where er.id = registration_id
            and usr.user_id = auth.uid()
            and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin', 'front_desk')
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'event_registration_attendees'
      and policyname = 'event_registration_attendees_service_role_all'
  ) then
    create policy event_registration_attendees_service_role_all
      on public.event_registration_attendees
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;
