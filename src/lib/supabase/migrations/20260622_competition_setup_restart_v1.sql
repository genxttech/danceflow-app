-- Competition Setup Restart V1
-- Save in: src/lib/supabase/migrations/20260622_competition_setup_restart_v1.sql

create table if not exists public.event_competition_setup_resets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  performed_by uuid references auth.users(id) on delete set null,
  deleted_programs integer not null default 0,
  deleted_schedule_versions integer not null default 0,
  deleted_floors integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists event_competition_setup_resets_event_idx
  on public.event_competition_setup_resets(event_id, created_at desc);

alter table public.event_competition_setup_resets enable row level security;

drop policy if exists event_competition_setup_resets_manage on public.event_competition_setup_resets;
create policy event_competition_setup_resets_manage
  on public.event_competition_setup_resets
  for select
  to authenticated
  using (public.can_manage_event_competition(event_id));

create or replace function public.restart_event_competition_setup(
  target_event_id uuid,
  confirmation_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  deleted_program_count integer := 0;
  deleted_schedule_count integer := 0;
  deleted_floor_count integer := 0;
begin
  if target_event_id is null then
    raise exception 'Event is required.';
  end if;

  if confirmation_text is distinct from 'RESTART COMPETITION' then
    raise exception 'Confirmation text does not match.';
  end if;

  if actor_id is null or not public.can_manage_event_competition(target_event_id) then
    raise exception 'You do not have permission to restart this competition.';
  end if;

  perform 1 from public.events where id = target_event_id for update;
  if not found then
    raise exception 'Event not found.';
  end if;

  if exists (select 1 from public.event_competition_entries where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after entries exist.';
  end if;
  if exists (select 1 from public.event_competition_entry_changes where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after entry history exists.';
  end if;
  if exists (select 1 from public.event_competition_registration_carts where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after a registration cart exists.';
  end if;
  if exists (select 1 from public.event_competition_checkin_sessions where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after check-in has begun.';
  end if;
  if exists (select 1 from public.event_competition_credentials where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after credentials exist.';
  end if;
  if exists (select 1 from public.event_competition_heats where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after heats exist.';
  end if;
  if exists (select 1 from public.event_competition_schedule_publications where event_id = target_event_id) then
    raise exception 'Competition setup cannot be restarted after a schedule has been published.';
  end if;
  if exists (
    select 1
    from public.event_competition_schedule_versions
    where event_id = target_event_id
      and status <> 'draft'
  ) then
    raise exception 'Competition setup can only be restarted while every schedule version is still a draft.';
  end if;

  select count(*)::integer into deleted_program_count
  from public.event_competition_programs where event_id = target_event_id;
  select count(*)::integer into deleted_schedule_count
  from public.event_competition_schedule_versions where event_id = target_event_id;
  select count(*)::integer into deleted_floor_count
  from public.event_competition_schedule_floors where event_id = target_event_id;

  delete from public.event_competition_schedule_versions where event_id = target_event_id;
  delete from public.event_competition_schedule_floors where event_id = target_event_id;
  delete from public.event_competition_programs where event_id = target_event_id;

  insert into public.event_competition_setup_resets (
    event_id,
    performed_by,
    deleted_programs,
    deleted_schedule_versions,
    deleted_floors
  ) values (
    target_event_id,
    actor_id,
    deleted_program_count,
    deleted_schedule_count,
    deleted_floor_count
  );

  return jsonb_build_object(
    'event_id', target_event_id,
    'deleted_programs', deleted_program_count,
    'deleted_schedule_versions', deleted_schedule_count,
    'deleted_floors', deleted_floor_count
  );
end;
$$;

revoke all on function public.restart_event_competition_setup(uuid, text) from public;
grant execute on function public.restart_event_competition_setup(uuid, text) to authenticated;

comment on function public.restart_event_competition_setup(uuid, text) is
  'Deletes draft competition configuration only when no registration, heat, check-in, publication, credential, or entry-history data exists.';
