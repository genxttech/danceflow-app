-- Competition Generation and Operations Foundation V1
-- Save in: src/lib/supabase/migrations/20260620_competition_generation_operations_v1.sql

begin;

alter table public.event_competition_entries
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawal_reason text,
  add column if not exists late_entry boolean not null default false,
  add column if not exists late_entry_at timestamptz,
  add column if not exists lifecycle_version integer not null default 1;

alter table public.event_competition_entries
  drop constraint if exists event_competition_entries_status_check;
alter table public.event_competition_entries
  add constraint event_competition_entries_status_check
  check (status in ('pending', 'confirmed', 'waitlisted', 'scratched', 'withdrawn', 'disqualified', 'complete'));

create table if not exists public.event_competition_entry_changes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  entry_id uuid references public.event_competition_entries(id) on delete set null,
  change_type text not null,
  reason text,
  fee_handling text not null default 'not_applicable',
  previous_state jsonb,
  resulting_state jsonb,
  performed_by uuid references auth.users(id) on delete set null,
  performed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint event_competition_entry_changes_type_check
    check (change_type in ('scratch', 'withdraw', 'delete_error', 'late_entry', 'move_entry', 'status_change', 'eligibility_change', 'edit', 'restore')),
  constraint event_competition_entry_changes_fee_check
    check (fee_handling in ('retain', 'refund', 'partial_refund', 'waive', 'not_applicable'))
);

create index if not exists event_competition_entry_changes_entry_idx
  on public.event_competition_entry_changes(entry_id, performed_at desc);
create index if not exists event_competition_entry_changes_event_idx
  on public.event_competition_entry_changes(event_id, performed_at desc);

create table if not exists public.event_competition_generation_runs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  schedule_version_id uuid not null,
  run_number integer not null,
  status text not null default 'draft',
  scope text not null default 'full_schedule',
  scope_id uuid,
  engine_version text not null,
  randomization_seed text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  input_checksum text,
  summary jsonb not null default '{}'::jsonb,
  initiated_by uuid references auth.users(id) on delete set null,
  initiated_at timestamptz not null default now(),
  completed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  applied_at timestamptz,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_generation_runs_schedule_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete cascade,
  constraint event_competition_generation_runs_number_check check (run_number > 0),
  constraint event_competition_generation_runs_status_check
    check (status in ('draft', 'queued', 'running', 'proposed', 'reviewed', 'applied', 'rejected', 'failed', 'cancelled')),
  constraint event_competition_generation_runs_scope_check
    check (scope in ('full_schedule', 'unscheduled_contests', 'block', 'contest', 'future_heats', 'selected_heats')),
  unique (event_id, run_number),
  unique (id, event_id),
  unique (id, schedule_version_id, event_id)
);

create index if not exists event_competition_generation_runs_schedule_idx
  on public.event_competition_generation_runs(schedule_version_id, run_number desc);

create table if not exists public.event_competition_generation_constraints (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  schedule_version_id uuid,
  name text not null,
  constraint_type text not null,
  enforcement text not null default 'hard',
  scope_type text not null default 'event',
  scope_id uuid,
  configuration jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_generation_constraints_schedule_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete cascade,
  constraint event_competition_generation_constraints_name_check check (length(btrim(name)) between 1 and 180),
  constraint event_competition_generation_constraints_type_check
    check (constraint_type in ('floor_capacity', 'dancer_conflict', 'instructor_conflict', 'partner_conflict', 'judge_availability', 'time_window', 'minimum_gap', 'keep_together', 'keep_separate', 'round_requirement', 'estimated_duration', 'floor_assignment', 'custom')),
  constraint event_competition_generation_constraints_enforcement_check
    check (enforcement in ('hard', 'soft', 'informational')),
  constraint event_competition_generation_constraints_scope_check
    check (scope_type in ('event', 'schedule', 'session', 'block', 'program', 'contest', 'division', 'round', 'entry', 'participant', 'judge', 'floor', 'custom')),
  unique (id, event_id)
);

create index if not exists event_competition_generation_constraints_event_idx
  on public.event_competition_generation_constraints(event_id, active, constraint_type);
create index if not exists event_competition_generation_constraints_schedule_idx
  on public.event_competition_generation_constraints(schedule_version_id, active)
  where schedule_version_id is not null;

create table if not exists public.event_competition_generation_conflicts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  generation_run_id uuid not null,
  conflict_type text not null,
  severity text not null,
  status text not null default 'open',
  title text not null,
  details text,
  subjects jsonb not null default '[]'::jsonb,
  proposed_resolution jsonb,
  resolution_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_generation_conflicts_run_fk
    foreign key (generation_run_id, event_id)
    references public.event_competition_generation_runs(id, event_id) on delete cascade,
  constraint event_competition_generation_conflicts_type_check
    check (conflict_type in ('capacity', 'dancer', 'instructor', 'partner', 'judge', 'floor', 'time_window', 'minimum_gap', 'round', 'unassigned', 'locked_heat', 'custom')),
  constraint event_competition_generation_conflicts_severity_check
    check (severity in ('blocker', 'warning', 'information')),
  constraint event_competition_generation_conflicts_status_check
    check (status in ('open', 'accepted', 'resolved', 'dismissed')),
  constraint event_competition_generation_conflicts_title_check check (length(btrim(title)) between 1 and 240)
);

create index if not exists event_competition_generation_conflicts_run_idx
  on public.event_competition_generation_conflicts(generation_run_id, status, severity);

create table if not exists public.event_competition_generation_proposals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  schedule_version_id uuid not null,
  generation_run_id uuid not null,
  action_type text not null,
  entity_type text not null,
  entity_id uuid,
  current_state jsonb,
  proposed_state jsonb not null,
  review_status text not null default 'proposed',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  applied_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_generation_proposals_run_fk
    foreign key (generation_run_id, schedule_version_id, event_id)
    references public.event_competition_generation_runs(id, schedule_version_id, event_id) on delete cascade,
  constraint event_competition_generation_proposals_action_check
    check (action_type in ('create', 'update', 'move', 'remove', 'unchanged')),
  constraint event_competition_generation_proposals_entity_check
    check (entity_type in ('round', 'heat', 'heat_entry', 'block', 'contest_assignment')),
  constraint event_competition_generation_proposals_review_check
    check (review_status in ('proposed', 'accepted', 'rejected', 'applied'))
);

create index if not exists event_competition_generation_proposals_run_idx
  on public.event_competition_generation_proposals(generation_run_id, review_status, sort_order);

create table if not exists public.event_competition_schedule_publications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  schedule_version_id uuid not null,
  publication_number integer not null,
  snapshot jsonb not null,
  snapshot_checksum text not null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  constraint event_competition_schedule_publications_version_fk
    foreign key (schedule_version_id, event_id)
    references public.event_competition_schedule_versions(id, event_id) on delete restrict,
  unique (event_id, publication_number),
  unique (schedule_version_id)
);

alter table public.event_competition_heats
  add column if not exists lock_state text not null default 'open',
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by uuid references auth.users(id) on delete set null,
  add column if not exists certified_at timestamptz,
  add column if not exists certified_by uuid references auth.users(id) on delete set null;

alter table public.event_competition_heats
  drop constraint if exists event_competition_heats_lock_state_check;
alter table public.event_competition_heats
  add constraint event_competition_heats_lock_state_check
  check (lock_state in ('open', 'locked', 'certified'));

create or replace function public.protect_locked_competition_heat()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.lock_state in ('locked', 'certified')
    and current_setting('app.competition_heat_override', true) is distinct from 'on' then
    raise exception 'Locked or certified heats require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_locked_competition_heat on public.event_competition_heats;
create trigger protect_locked_competition_heat
before update or delete on public.event_competition_heats
for each row execute function public.protect_locked_competition_heat();

create or replace function public.set_competition_heat_lock_state(
  selected_heat_id uuid,
  selected_state text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  heat_event_id uuid;
  current_state text;
begin
  if selected_state not in ('open', 'locked', 'certified') then
    raise exception 'Invalid heat lock state.';
  end if;

  select event_id, lock_state into heat_event_id, current_state
  from public.event_competition_heats where id = selected_heat_id;
  if heat_event_id is null or not public.can_manage_event_competition(heat_event_id) then
    raise exception 'Heat was not found or cannot be managed.';
  end if;
  if current_state = 'certified' and selected_state <> 'certified' then
    raise exception 'Certified heats require a formal correction workflow and cannot be reopened directly.';
  end if;

  perform set_config('app.competition_heat_override', 'on', true);
  update public.event_competition_heats
  set
    lock_state = selected_state,
    locked_at = case when selected_state in ('locked', 'certified') then coalesce(locked_at, now()) else null end,
    locked_by = case when selected_state in ('locked', 'certified') then coalesce(locked_by, auth.uid()) else null end,
    certified_at = case when selected_state = 'certified' then now() else null end,
    certified_by = case when selected_state = 'certified' then auth.uid() else null end,
    updated_at = now()
  where id = selected_heat_id;
end;
$$;

create or replace function public.audit_competition_entry_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_type text;
  selected_reason text;
  selected_fee_handling text;
begin
  selected_reason := nullif(current_setting('app.competition_entry_change_reason', true), '');
  selected_fee_handling := coalesce(nullif(current_setting('app.competition_entry_fee_handling', true), ''), 'not_applicable');

  if tg_op = 'DELETE' then
    selected_type := coalesce(nullif(current_setting('app.competition_entry_change_type', true), ''), 'delete_error');
    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling, previous_state, performed_by
    ) values (
      old.event_id, old.id, selected_type, selected_reason, selected_fee_handling, to_jsonb(old), auth.uid()
    );
    return old;
  end if;

  if new.status is distinct from old.status
    or new.division_id is distinct from old.division_id
    or new.program_id is distinct from old.program_id
    or new.eligibility_status is distinct from old.eligibility_status
    or new.late_entry is distinct from old.late_entry then
    selected_type := nullif(current_setting('app.competition_entry_change_type', true), '');
    if selected_type is null then
      selected_type := case
        when new.status = 'scratched' then 'scratch'
        when new.status = 'withdrawn' then 'withdraw'
        when new.division_id is distinct from old.division_id or new.program_id is distinct from old.program_id then 'move_entry'
        when new.eligibility_status is distinct from old.eligibility_status then 'eligibility_change'
        when new.late_entry and not old.late_entry then 'late_entry'
        else 'status_change'
      end;
    end if;

    insert into public.event_competition_entry_changes (
      event_id, entry_id, change_type, reason, fee_handling,
      previous_state, resulting_state, performed_by
    ) values (
      new.event_id, new.id, selected_type, selected_reason, selected_fee_handling,
      to_jsonb(old), to_jsonb(new), auth.uid()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_competition_entry_change on public.event_competition_entries;
create trigger audit_competition_entry_change
after update or delete on public.event_competition_entries
for each row execute function public.audit_competition_entry_change();

create or replace function public.change_competition_entry_lifecycle(
  selected_entry_id uuid,
  selected_status text,
  selected_reason text,
  selected_fee_handling text default 'retain'
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare entry_event_id uuid;
begin
  if selected_status not in ('scratched', 'withdrawn') then
    raise exception 'Lifecycle action must be scratch or withdraw.';
  end if;
  if selected_fee_handling not in ('retain', 'refund', 'partial_refund', 'waive', 'not_applicable') then
    raise exception 'Invalid fee handling.';
  end if;

  select event_id into entry_event_id from public.event_competition_entries where id = selected_entry_id;
  if entry_event_id is null or not public.can_manage_event_competition(entry_event_id) then
    raise exception 'Entry was not found or cannot be managed.';
  end if;
  if exists (
    select 1
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id
    where he.entry_id = selected_entry_id and h.lock_state in ('locked', 'certified')
  ) then
    raise exception 'This entry is in a locked or certified heat and requires the correction workflow.';
  end if;

  perform set_config('app.competition_entry_change_type', case when selected_status = 'scratched' then 'scratch' else 'withdraw' end, true);
  perform set_config('app.competition_entry_change_reason', coalesce(selected_reason, ''), true);
  perform set_config('app.competition_entry_fee_handling', selected_fee_handling, true);
  update public.event_competition_entries
  set
    status = selected_status,
    scratched_at = case when selected_status = 'scratched' then now() else scratched_at end,
    scratch_reason = case when selected_status = 'scratched' then selected_reason else scratch_reason end,
    withdrawn_at = case when selected_status = 'withdrawn' then now() else withdrawn_at end,
    withdrawal_reason = case when selected_status = 'withdrawn' then selected_reason else withdrawal_reason end,
    lifecycle_version = lifecycle_version + 1,
    updated_at = now()
  where id = selected_entry_id;

  update public.event_competition_heat_entries
  set status = 'scratched', updated_at = now()
  where entry_id = selected_entry_id and status in ('scheduled', 'checked_in');
end;
$$;

create or replace function public.mark_competition_entry_late(
  selected_entry_id uuid,
  selected_reason text default null
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare entry_event_id uuid;
begin
  select event_id into entry_event_id from public.event_competition_entries where id = selected_entry_id;
  if entry_event_id is null or not public.can_manage_event_competition(entry_event_id) then
    raise exception 'Entry was not found or cannot be managed.';
  end if;
  perform set_config('app.competition_entry_change_type', 'late_entry', true);
  perform set_config('app.competition_entry_change_reason', coalesce(selected_reason, ''), true);
  update public.event_competition_entries
  set late_entry = true, late_entry_at = coalesce(late_entry_at, now()), lifecycle_version = lifecycle_version + 1, updated_at = now()
  where id = selected_entry_id and not late_entry;
end;
$$;

create or replace function public.sync_competition_entries_from_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' or new.payment_status in ('failed', 'refunded') then
    perform set_config('app.competition_entry_change_type', 'withdraw', true);
    perform set_config(
      'app.competition_entry_change_reason',
      case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end,
      true
    );
    perform set_config(
      'app.competition_entry_fee_handling',
      case when new.payment_status = 'refunded' then 'refund' else 'retain' end,
      true
    );
    update public.event_competition_entries
    set
      status = 'withdrawn',
      withdrawn_at = coalesce(withdrawn_at, now()),
      withdrawal_reason = coalesce(
        withdrawal_reason,
        case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end
      ),
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
    where registration_id = new.id
      and status not in ('withdrawn', 'disqualified', 'complete')
      and not exists (
        select 1
        from public.event_competition_heat_entries he
        join public.event_competition_heats h on h.id = he.heat_id
        where he.entry_id = event_competition_entries.id and h.lock_state in ('locked', 'certified')
      );
    return new;
  end if;

  if new.status in ('confirmed', 'registered', 'checked_in', 'attended')
    and coalesce(new.payment_status, '') in ('paid', 'partial', 'comped', 'free', 'waived') then
    update public.event_competition_entries
    set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
    where registration_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

revoke all on function public.sync_competition_entries_from_registration() from public;

create or replace function public.protect_competition_generation_input()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.event_id is distinct from old.event_id
    or new.schedule_version_id is distinct from old.schedule_version_id
    or new.run_number is distinct from old.run_number
    or new.engine_version is distinct from old.engine_version
    or new.randomization_seed is distinct from old.randomization_seed
    or new.input_snapshot is distinct from old.input_snapshot
    or new.input_checksum is distinct from old.input_checksum then
    raise exception 'Generation inputs are immutable. Create a new generation run.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_competition_generation_input on public.event_competition_generation_runs;
create trigger protect_competition_generation_input
before update on public.event_competition_generation_runs
for each row execute function public.protect_competition_generation_input();

create or replace function public.create_competition_generation_run(
  selected_event_id uuid,
  selected_schedule_version_id uuid,
  selected_scope text default 'full_schedule',
  selected_scope_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  next_number integer;
  new_run_id uuid;
  snapshot jsonb;
begin
  if not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Not authorized to generate this competition.';
  end if;

  if not exists (
    select 1 from public.event_competition_schedule_versions
    where id = selected_schedule_version_id and event_id = selected_event_id and status = 'draft'
  ) then
    raise exception 'Generation requires an editable draft schedule.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text || ':generation'));
  select coalesce(max(run_number), 0) + 1 into next_number
  from public.event_competition_generation_runs where event_id = selected_event_id;

  snapshot := jsonb_build_object(
    'captured_at', now(),
    'schedule_version_id', selected_schedule_version_id,
    'confirmed_eligible_entries', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'division_id', division_id, 'program_id', program_id) order by id), '[]'::jsonb)
      from public.event_competition_entries
      where event_id = selected_event_id and status = 'confirmed' and eligibility_status in ('eligible', 'waived')
    ),
    'blocks', (
      select coalesce(jsonb_agg(to_jsonb(b) order by b.starts_at, b.id), '[]'::jsonb)
      from public.event_competition_schedule_blocks b
      where b.schedule_version_id = selected_schedule_version_id
    ),
    'constraints', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.constraint_type, c.id), '[]'::jsonb)
      from public.event_competition_generation_constraints c
      where c.event_id = selected_event_id and c.active
        and (c.schedule_version_id is null or c.schedule_version_id = selected_schedule_version_id)
    )
  );

  insert into public.event_competition_generation_runs (
    event_id, schedule_version_id, run_number, scope, scope_id, engine_version,
    randomization_seed, input_snapshot, input_checksum, initiated_by
  ) values (
    selected_event_id, selected_schedule_version_id, next_number, selected_scope, selected_scope_id,
    'foundation-no-generator', gen_random_uuid()::text, snapshot,
    encode(digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex'), auth.uid()
  ) returning id into new_run_id;

  return new_run_id;
end;
$$;

create or replace function public.build_competition_schedule_snapshot(selected_version_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', jsonb_build_object(
      'id', v.id,
      'event_id', v.event_id,
      'version_number', v.version_number,
      'name', v.name
    ),
    'sessions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'name', s.name,
          'session_date', s.session_date,
          'starts_at', s.starts_at,
          'ends_at', s.ends_at,
          'blocks', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', b.id,
                'name', b.name,
                'block_type', b.block_type,
                'starts_at', b.starts_at,
                'ends_at', b.ends_at,
                'floor_name', b.floor_name_snapshot,
                'floor_capacity', b.floor_capacity_snapshot,
                'contests', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'contest_id', a.contest_id,
                      'contest_name', c.name,
                      'planned_round_type', a.planned_round_type,
                      'sort_order', a.sort_order
                    ) order by a.sort_order, c.name
                  )
                  from public.event_competition_schedule_block_contests a
                  join public.event_competition_contests c on c.id = a.contest_id
                  where a.block_id = b.id
                ), '[]'::jsonb)
              ) order by b.starts_at, b.sort_order, b.id
            )
            from public.event_competition_schedule_blocks b
            where b.session_id = s.id
          ), '[]'::jsonb)
        ) order by s.starts_at, s.sort_order, s.id
      )
      from public.event_competition_schedule_sessions s
      where s.schedule_version_id = v.id
    ), '[]'::jsonb)
  )
  from public.event_competition_schedule_versions v
  where v.id = selected_version_id;
$$;

create or replace function public.publish_competition_schedule_version(selected_version_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  selected_event_id uuid;
  next_publication_number integer;
  publication_snapshot jsonb;
begin
  select event_id into selected_event_id
  from public.event_competition_schedule_versions
  where id = selected_version_id and status in ('draft', 'review');

  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Schedule version was not found or cannot be published.';
  end if;
  if not exists (select 1 from public.event_competition_schedule_sessions where schedule_version_id = selected_version_id) then
    raise exception 'Add at least one session before publishing.';
  end if;
  if exists (
    select 1
    from public.event_competition_schedule_blocks a
    join public.event_competition_schedule_blocks b
      on b.schedule_version_id = a.schedule_version_id and b.id > a.id
     and a.floor_id is not null and b.floor_id = a.floor_id
     and b.starts_at < a.ends_at and b.ends_at > a.starts_at
    where a.schedule_version_id = selected_version_id
  ) then
    raise exception 'Resolve overlapping blocks on the same floor before publishing.';
  end if;
  if exists (
    select 1 from public.event_competition_schedule_blocks b
    where b.schedule_version_id = selected_version_id and b.block_type = 'competition'
      and not exists (select 1 from public.event_competition_schedule_block_contests a where a.block_id = b.id)
  ) then
    raise exception 'Every competition block must include at least one competition event.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text || ':publication'));
  select coalesce(max(publication_number), 0) + 1 into next_publication_number
  from public.event_competition_schedule_publications where event_id = selected_event_id;
  publication_snapshot := public.build_competition_schedule_snapshot(selected_version_id);

  update public.event_competition_schedule_versions
  set status = 'superseded', updated_at = now()
  where event_id = selected_event_id and status in ('published', 'live');

  update public.event_competition_schedule_versions
  set status = 'published', published_at = now(), published_by = auth.uid(), updated_at = now()
  where id = selected_version_id;

  insert into public.event_competition_schedule_publications (
    event_id, schedule_version_id, publication_number, snapshot, snapshot_checksum, published_by
  ) values (
    selected_event_id, selected_version_id, next_publication_number, publication_snapshot,
    encode(digest(convert_to(publication_snapshot::text, 'UTF8'), 'sha256'), 'hex'), auth.uid()
  );
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_generation_runs',
    'event_competition_generation_constraints',
    'event_competition_generation_conflicts',
    'event_competition_generation_proposals'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists competition_manage on public.%I', table_name);
    execute format('create policy competition_manage on public.%I for all to authenticated using (public.can_manage_event_competition(event_id)) with check (public.can_manage_event_competition(event_id))', table_name);
  end loop;
end $$;

alter table public.event_competition_entry_changes enable row level security;
drop policy if exists competition_history_read on public.event_competition_entry_changes;
create policy competition_history_read on public.event_competition_entry_changes
  for select to authenticated using (public.can_manage_event_competition(event_id));
drop policy if exists competition_history_insert on public.event_competition_entry_changes;
create policy competition_history_insert on public.event_competition_entry_changes
  for insert to authenticated with check (public.can_manage_event_competition(event_id));

alter table public.event_competition_schedule_publications enable row level security;
drop policy if exists competition_publications_read on public.event_competition_schedule_publications;
create policy competition_publications_read on public.event_competition_schedule_publications
  for select to authenticated using (public.can_manage_event_competition(event_id));
drop policy if exists competition_publications_insert on public.event_competition_schedule_publications;
create policy competition_publications_insert on public.event_competition_schedule_publications
  for insert to authenticated with check (public.can_manage_event_competition(event_id));

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'event_competition_generation_runs',
    'event_competition_generation_constraints',
    'event_competition_generation_conflicts',
    'event_competition_generation_proposals'
  ] loop
    execute format('drop trigger if exists set_event_competition_updated_at on public.%I', table_name);
    execute format('create trigger set_event_competition_updated_at before update on public.%I for each row execute function public.set_event_competition_updated_at()', table_name);
  end loop;
end $$;

comment on table public.event_competition_generation_runs is
  'Immutable generation inputs and reviewable output batches. V1 intentionally does not generate heats.';
comment on table public.event_competition_generation_proposals is
  'Proposed changes reviewed before application; generation never directly rewrites live competition data.';
comment on table public.event_competition_entry_changes is
  'Attributed history distinguishing scratch, withdrawal, erroneous deletion, late entry, and movement.';

notify pgrst, 'reload schema';
commit;
