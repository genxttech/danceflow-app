-- Competition Foundation V1
-- Save in: src/lib/supabase/migrations/20260620_competition_foundation_v1.sql

begin;

create extension if not exists pgcrypto;

create table if not exists public.event_competition_programs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  organizer_id uuid references public.organizers(id) on delete set null,
  name text not null,
  discipline_family text not null,
  competition_mode text not null,
  scoring_method text not null,
  advancement_method text not null default 'none',
  feedback_policy text not null default 'none',
  rules_edition text,
  status text not null default 'draft',
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_programs_name_check
    check (length(btrim(name)) between 1 and 160),
  constraint event_competition_programs_discipline_check
    check (discipline_family in ('showcase', 'ballroom', 'country', 'collegiate_amateur', 'custom')),
  constraint event_competition_programs_mode_check
    check (competition_mode in ('relative', 'proficiency', 'feedback_only', 'exhibition')),
  constraint event_competition_programs_scoring_check
    check (scoring_method in ('skating', 'majority_rules', 'proficiency', 'cumulative_points', 'feedback_only', 'custom', 'none')),
  constraint event_competition_programs_advancement_check
    check (advancement_method in ('promote_callback', 'retire_callback', 'recall_count', 'custom', 'none')),
  constraint event_competition_programs_feedback_check
    check (feedback_policy in ('none', 'optional', 'required')),
  constraint event_competition_programs_status_check
    check (status in ('draft', 'configured', 'active', 'complete', 'archived')),
  unique (id, event_id)
);

create table if not exists public.event_competition_divisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  name text not null,
  code text,
  age_label text,
  skill_label text,
  role_label text,
  status text not null default 'draft',
  sort_order integer not null default 0,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_divisions_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_divisions_name_check
    check (length(btrim(name)) between 1 and 200),
  constraint event_competition_divisions_status_check
    check (status in ('draft', 'open', 'closed', 'active', 'complete', 'cancelled')),
  unique (id, event_id),
  unique (id, program_id, event_id)
);

create table if not exists public.event_competition_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  division_id uuid not null,
  name text not null,
  round_type text not null,
  sequence_number integer not null default 1,
  target_advancement_count integer,
  status text not null default 'draft',
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_rounds_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_rounds_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id)
    on delete cascade,
  constraint event_competition_rounds_name_check
    check (length(btrim(name)) between 1 and 160),
  constraint event_competition_rounds_type_check
    check (round_type in ('qualifying', 'preliminary', 'quarterfinal', 'semifinal', 'final', 'proficiency', 'feedback', 'exhibition', 'custom')),
  constraint event_competition_rounds_sequence_check
    check (sequence_number > 0),
  constraint event_competition_rounds_target_check
    check (target_advancement_count is null or target_advancement_count > 0),
  constraint event_competition_rounds_status_check
    check (status in ('draft', 'scheduled', 'active', 'ballots_locked', 'calculated', 'approved', 'published', 'complete', 'cancelled')),
  unique (id, event_id),
  unique (id, division_id, event_id),
  unique (division_id, sequence_number)
);

create table if not exists public.event_competition_heats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  division_id uuid not null,
  round_id uuid not null,
  heat_number integer not null,
  name text,
  scheduled_at timestamptz,
  floor_label text,
  status text not null default 'draft',
  randomization_seed text,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_heats_division_fk
    foreign key (division_id, event_id)
    references public.event_competition_divisions(id, event_id)
    on delete cascade,
  constraint event_competition_heats_round_fk
    foreign key (round_id, division_id, event_id)
    references public.event_competition_rounds(id, division_id, event_id)
    on delete cascade,
  constraint event_competition_heats_number_check
    check (heat_number > 0),
  constraint event_competition_heats_status_check
    check (status in ('draft', 'scheduled', 'staging', 'active', 'complete', 'cancelled')),
  unique (id, event_id),
  unique (id, division_id, event_id),
  unique (round_id, heat_number)
);

create table if not exists public.event_competition_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  program_id uuid not null,
  division_id uuid not null,
  registration_id uuid references public.event_registrations(id) on delete set null,
  entry_number text,
  display_name text not null,
  represented_studio_name text,
  status text not null default 'pending',
  eligibility_status text not null default 'unverified',
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_entries_program_fk
    foreign key (program_id, event_id)
    references public.event_competition_programs(id, event_id)
    on delete cascade,
  constraint event_competition_entries_division_fk
    foreign key (division_id, program_id, event_id)
    references public.event_competition_divisions(id, program_id, event_id)
    on delete cascade,
  constraint event_competition_entries_name_check
    check (length(btrim(display_name)) between 1 and 240),
  constraint event_competition_entries_status_check
    check (status in ('pending', 'confirmed', 'waitlisted', 'withdrawn', 'disqualified', 'complete')),
  constraint event_competition_entries_eligibility_check
    check (eligibility_status in ('unverified', 'eligible', 'needs_review', 'ineligible', 'waived')),
  unique (id, event_id),
  unique (id, division_id, event_id)
);

create table if not exists public.event_competition_entry_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  entry_id uuid not null,
  client_id uuid references public.clients(id) on delete set null,
  instructor_id uuid references public.instructors(id) on delete set null,
  registration_attendee_id uuid references public.event_registration_attendees(id) on delete set null,
  participant_role text not null,
  display_name text not null,
  portal_delivery_enabled boolean not null default true,
  instructor_delivery_enabled boolean not null default true,
  studio_delivery_enabled boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_entry_participants_entry_fk
    foreign key (entry_id, event_id)
    references public.event_competition_entries(id, event_id)
    on delete cascade,
  constraint event_competition_entry_participants_role_check
    check (participant_role in ('dancer', 'leader', 'follower', 'student', 'professional', 'instructor', 'team_member', 'alternate', 'other')),
  constraint event_competition_entry_participants_name_check
    check (length(btrim(display_name)) between 1 and 200),
  constraint event_competition_entry_participants_identity_check
    check (
      client_id is not null
      or instructor_id is not null
      or registration_attendee_id is not null
      or length(btrim(display_name)) > 0
    ),
  unique (id, event_id)
);

create table if not exists public.event_competition_heat_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  division_id uuid not null,
  heat_id uuid not null,
  entry_id uuid not null,
  floor_order integer not null default 0,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_heat_entries_heat_fk
    foreign key (heat_id, division_id, event_id)
    references public.event_competition_heats(id, division_id, event_id)
    on delete cascade,
  constraint event_competition_heat_entries_entry_fk
    foreign key (entry_id, division_id, event_id)
    references public.event_competition_entries(id, division_id, event_id)
    on delete cascade,
  constraint event_competition_heat_entries_status_check
    check (status in ('scheduled', 'checked_in', 'scratched', 'danced', 'disqualified')),
  unique (heat_id, entry_id)
);

create index if not exists event_competition_programs_event_sort_idx
  on public.event_competition_programs(event_id, sort_order, created_at);
create index if not exists event_competition_divisions_program_sort_idx
  on public.event_competition_divisions(program_id, sort_order, created_at);
create index if not exists event_competition_rounds_division_sequence_idx
  on public.event_competition_rounds(division_id, sequence_number);
create index if not exists event_competition_heats_round_number_idx
  on public.event_competition_heats(round_id, heat_number);
create index if not exists event_competition_heats_schedule_idx
  on public.event_competition_heats(event_id, scheduled_at);
create index if not exists event_competition_entries_division_sort_idx
  on public.event_competition_entries(division_id, sort_order, created_at);
create unique index if not exists event_competition_entries_number_uidx
  on public.event_competition_entries(event_id, entry_number)
  where entry_number is not null;
create index if not exists event_competition_entry_participants_entry_sort_idx
  on public.event_competition_entry_participants(entry_id, sort_order, created_at);
create index if not exists event_competition_entry_participants_client_idx
  on public.event_competition_entry_participants(client_id)
  where client_id is not null;
create index if not exists event_competition_heat_entries_heat_order_idx
  on public.event_competition_heat_entries(heat_id, floor_order, created_at);
create index if not exists event_competition_heat_entries_entry_idx
  on public.event_competition_heat_entries(entry_id);

create or replace function public.set_event_competition_program_tenant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select e.studio_id, e.organizer_id
  into new.studio_id, new.organizer_id
  from public.events e
  where e.id = new.event_id;

  if not found then
    raise exception 'Competition program event does not exist.';
  end if;

  return new;
end;
$$;

drop trigger if exists set_event_competition_program_tenant
  on public.event_competition_programs;
create trigger set_event_competition_program_tenant
before insert or update of event_id, studio_id, organizer_id
on public.event_competition_programs
for each row execute function public.set_event_competition_program_tenant();

create or replace function public.set_event_competition_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_competition_programs',
    'event_competition_divisions',
    'event_competition_rounds',
    'event_competition_heats',
    'event_competition_entries',
    'event_competition_entry_participants',
    'event_competition_heat_entries'
  ] loop
    execute format('drop trigger if exists set_event_competition_updated_at on public.%I', table_name);
    execute format(
      'create trigger set_event_competition_updated_at before update on public.%I for each row execute function public.set_event_competition_updated_at()',
      table_name
    );
  end loop;
end $$;

create or replace function public.can_manage_event_competition(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.platform_role = 'platform_admin'
        )
        or e.created_by = auth.uid()
        or exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = e.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
            and usr.role in ('studio_owner', 'studio_admin')
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.organizer_id = e.organizer_id
            and ou.user_id = auth.uid()
            and ou.active = true
            and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
        )
      )
  );
$$;

revoke all on function public.can_manage_event_competition(uuid) from public;
grant execute on function public.can_manage_event_competition(uuid) to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_competition_programs',
    'event_competition_divisions',
    'event_competition_rounds',
    'event_competition_heats',
    'event_competition_entries',
    'event_competition_entry_participants',
    'event_competition_heat_entries'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists competition_manage on public.%I', table_name);
    execute format(
      'create policy competition_manage on public.%I for all to authenticated using (public.can_manage_event_competition(event_id)) with check (public.can_manage_event_competition(event_id))',
      table_name
    );
  end loop;
end $$;

comment on table public.event_competition_programs is
  'Rules-aware programs within an event. Public labels remain organization-neutral.';
comment on column public.event_competition_programs.configuration is
  'Versioned program settings; authoritative scoring implementation versions are added in a later phase.';

commit;
