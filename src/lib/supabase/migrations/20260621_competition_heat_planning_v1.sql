-- Competition Heat Planning V1
-- Adds schedule-aware heat placement and ordered dance segments.
-- Save in: src/lib/supabase/migrations/20260621_competition_heat_planning_v1.sql

begin;

alter table public.event_competition_heats
  add column if not exists contest_id uuid,
  add column if not exists schedule_version_id uuid,
  add column if not exists schedule_block_id uuid,
  add column if not exists generation_run_id uuid,
  add column if not exists floor_id uuid,
  add column if not exists estimated_ends_at timestamptz,
  add column if not exists duration_seconds integer,
  add column if not exists schedule_sequence integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'event_competition_heats_contest_fk') then
    alter table public.event_competition_heats
      add constraint event_competition_heats_contest_fk
      foreign key (contest_id, event_id)
      references public.event_competition_contests(id, event_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_competition_heats_schedule_fk') then
    alter table public.event_competition_heats
      add constraint event_competition_heats_schedule_fk
      foreign key (schedule_version_id, event_id)
      references public.event_competition_schedule_versions(id, event_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_competition_heats_block_fk') then
    alter table public.event_competition_heats
      add constraint event_competition_heats_block_fk
      foreign key (schedule_block_id, schedule_version_id, event_id)
      references public.event_competition_schedule_blocks(id, schedule_version_id, event_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_competition_heats_generation_run_fk') then
    alter table public.event_competition_heats
      add constraint event_competition_heats_generation_run_fk
      foreign key (generation_run_id, schedule_version_id, event_id)
      references public.event_competition_generation_runs(id, schedule_version_id, event_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_competition_heats_floor_fk') then
    alter table public.event_competition_heats
      add constraint event_competition_heats_floor_fk
      foreign key (floor_id, event_id)
      references public.event_competition_schedule_floors(id, event_id) on delete restrict;
  end if;
end $$;

alter table public.event_competition_heats
  drop constraint if exists event_competition_heats_duration_check;
alter table public.event_competition_heats
  add constraint event_competition_heats_duration_check
  check (duration_seconds is null or duration_seconds > 0);

alter table public.event_competition_heats
  drop constraint if exists event_competition_heats_schedule_sequence_check;
alter table public.event_competition_heats
  add constraint event_competition_heats_schedule_sequence_check
  check (schedule_sequence is null or schedule_sequence > 0);

alter table public.event_competition_heats
  drop constraint if exists event_competition_heats_schedule_time_check;
alter table public.event_competition_heats
  add constraint event_competition_heats_schedule_time_check
  check (
    estimated_ends_at is null
    or (scheduled_at is not null and estimated_ends_at > scheduled_at)
  );

create index if not exists event_competition_heats_schedule_version_idx
  on public.event_competition_heats(schedule_version_id, scheduled_at, schedule_sequence)
  where schedule_version_id is not null;
create index if not exists event_competition_heats_block_idx
  on public.event_competition_heats(schedule_block_id, scheduled_at, schedule_sequence)
  where schedule_block_id is not null;
create index if not exists event_competition_heats_contest_idx
  on public.event_competition_heats(contest_id, scheduled_at)
  where contest_id is not null;
create unique index if not exists event_competition_heats_schedule_sequence_uidx
  on public.event_competition_heats(schedule_version_id, schedule_sequence)
  where schedule_version_id is not null and schedule_sequence is not null and status <> 'cancelled';

create table if not exists public.event_competition_heat_dances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  heat_id uuid not null,
  dance_id uuid,
  dance_key text not null,
  dance_label text not null,
  sequence_number integer not null,
  duration_seconds integer,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_heat_dances_heat_fk
    foreign key (heat_id, event_id)
    references public.event_competition_heats(id, event_id) on delete cascade,
  constraint event_competition_heat_dances_dance_fk
    foreign key (dance_id, event_id)
    references public.event_competition_dances(id, event_id) on delete restrict,
  constraint event_competition_heat_dances_key_check check (length(btrim(dance_key)) between 1 and 100),
  constraint event_competition_heat_dances_label_check check (length(btrim(dance_label)) between 1 and 160),
  constraint event_competition_heat_dances_sequence_check check (sequence_number > 0),
  constraint event_competition_heat_dances_duration_check check (duration_seconds is null or duration_seconds > 0),
  constraint event_competition_heat_dances_status_check
    check (status in ('scheduled', 'active', 'complete', 'cancelled')),
  unique (heat_id, sequence_number),
  unique (heat_id, dance_key)
);

create index if not exists event_competition_heat_dances_heat_idx
  on public.event_competition_heat_dances(heat_id, sequence_number);

drop trigger if exists set_event_competition_updated_at on public.event_competition_heat_dances;
create trigger set_event_competition_updated_at
before update on public.event_competition_heat_dances
for each row execute function public.set_event_competition_updated_at();

alter table public.event_competition_heat_dances enable row level security;
drop policy if exists competition_manage on public.event_competition_heat_dances;
create policy competition_manage on public.event_competition_heat_dances
  for all to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

create or replace function public.validate_competition_heat_schedule_placement()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  version_status text;
  block_start timestamptz;
  block_end timestamptz;
  block_floor_id uuid;
  division_contest_id uuid;
begin
  if new.schedule_version_id is null then
    return new;
  end if;

  select status into version_status
  from public.event_competition_schedule_versions
  where id = new.schedule_version_id and event_id = new.event_id;
  if version_status is distinct from 'draft' then
    raise exception 'Heats may only be placed into an editable draft schedule.';
  end if;

  select starts_at, ends_at, floor_id into block_start, block_end, block_floor_id
  from public.event_competition_schedule_blocks
  where id = new.schedule_block_id
    and schedule_version_id = new.schedule_version_id
    and event_id = new.event_id;
  if block_start is null then
    raise exception 'A valid schedule block is required.';
  end if;
  if new.scheduled_at is null or new.estimated_ends_at is null
    or new.scheduled_at < block_start or new.estimated_ends_at > block_end then
    raise exception 'Heat timing must be contained within its schedule block.';
  end if;
  if new.floor_id is distinct from block_floor_id then
    raise exception 'Heat floor must match its schedule block.';
  end if;

  select contest_id into division_contest_id
  from public.event_competition_divisions
  where id = new.division_id and event_id = new.event_id;
  if new.contest_id is distinct from division_contest_id then
    raise exception 'Heat contest must match the division competition event.';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_competition_heat_schedule_placement on public.event_competition_heats;
create trigger validate_competition_heat_schedule_placement
before insert or update of event_id, division_id, contest_id, schedule_version_id,
  schedule_block_id, floor_id, scheduled_at, estimated_ends_at
on public.event_competition_heats
for each row execute function public.validate_competition_heat_schedule_placement();

create or replace function public.protect_locked_competition_heat_children()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_heat_id uuid;
  selected_lock_state text;
begin
  selected_heat_id := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  select lock_state into selected_lock_state
  from public.event_competition_heats where id = selected_heat_id;
  if selected_lock_state in ('locked', 'certified')
    and current_setting('app.competition_heat_override', true) is distinct from 'on' then
    raise exception 'Locked or certified heat details require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_locked_competition_heat_dance on public.event_competition_heat_dances;
create trigger protect_locked_competition_heat_dance
before insert or update or delete on public.event_competition_heat_dances
for each row execute function public.protect_locked_competition_heat_children();

drop trigger if exists protect_locked_competition_heat_entry on public.event_competition_heat_entries;
create trigger protect_locked_competition_heat_entry
before insert or update or delete on public.event_competition_heat_entries
for each row execute function public.protect_locked_competition_heat_children();

alter table public.event_competition_generation_proposals
  drop constraint if exists event_competition_generation_proposals_entity_check;
alter table public.event_competition_generation_proposals
  add constraint event_competition_generation_proposals_entity_check
  check (entity_type in ('round', 'heat', 'heat_dance', 'heat_entry', 'block', 'contest_assignment'));

drop policy if exists competition_manage on public.event_competition_generation_runs;
drop policy if exists competition_generation_runs_read on public.event_competition_generation_runs;
create policy competition_generation_runs_read on public.event_competition_generation_runs
  for select to authenticated using (public.can_manage_event_competition(event_id));
drop policy if exists competition_generation_runs_insert on public.event_competition_generation_runs;
create policy competition_generation_runs_insert on public.event_competition_generation_runs
  for insert to authenticated with check (public.can_manage_event_competition(event_id));
drop policy if exists competition_generation_runs_update on public.event_competition_generation_runs;
create policy competition_generation_runs_update on public.event_competition_generation_runs
  for update to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

comment on table public.event_competition_heat_dances is
  'Ordered dances or styles performed within one heat. Single-dance heats have one row; multi-dance heats have multiple rows.';
comment on column public.event_competition_heats.schedule_block_id is
  'Organizer-defined contest block containing this heat in a specific draft schedule version.';

notify pgrst, 'reload schema';
commit;
