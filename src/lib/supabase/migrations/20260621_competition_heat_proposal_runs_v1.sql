-- Competition Heat Proposal Runs V1
-- Transactional persistence for proposal-only heat planning.
-- Save in: src/lib/supabase/migrations/20260621_competition_heat_proposal_runs_v1.sql

begin;

create or replace function public.create_competition_heat_plan_run(
  selected_event_id uuid,
  selected_schedule_version_id uuid,
  selected_engine_version text,
  selected_randomization_seed text,
  selected_input_snapshot jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  next_number integer;
  new_run_id uuid;
begin
  if not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Not authorized to plan heats for this competition.';
  end if;
  if not exists (
    select 1 from public.event_competition_schedule_versions
    where id = selected_schedule_version_id
      and event_id = selected_event_id
      and status = 'draft'
  ) then
    raise exception 'Heat planning requires an editable draft schedule.';
  end if;
  if selected_input_snapshot is null or jsonb_typeof(selected_input_snapshot) <> 'object' then
    raise exception 'A complete planning snapshot is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text || ':generation'));
  select coalesce(max(run_number), 0) + 1 into next_number
  from public.event_competition_generation_runs where event_id = selected_event_id;

  insert into public.event_competition_generation_runs (
    event_id, schedule_version_id, run_number, status, scope, engine_version,
    randomization_seed, input_snapshot, input_checksum, initiated_by
  ) values (
    selected_event_id, selected_schedule_version_id, next_number, 'running', 'full_schedule',
    selected_engine_version, selected_randomization_seed, selected_input_snapshot,
    encode(digest(convert_to(selected_input_snapshot::text, 'UTF8'), 'sha256'), 'hex'), auth.uid()
  ) returning id into new_run_id;

  return new_run_id;
end;
$$;

create or replace function public.save_competition_heat_plan(
  selected_run_id uuid,
  selected_proposals jsonb,
  selected_conflicts jsonb,
  selected_summary jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  selected_event_id uuid;
  selected_schedule_version_id uuid;
begin
  select event_id, schedule_version_id
  into selected_event_id, selected_schedule_version_id
  from public.event_competition_generation_runs
  where id = selected_run_id and status = 'running';

  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Planning run was not found or cannot be saved.';
  end if;
  if jsonb_typeof(coalesce(selected_proposals, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(selected_conflicts, '[]'::jsonb)) <> 'array' then
    raise exception 'Planner output must be arrays.';
  end if;

  insert into public.event_competition_generation_proposals (
    event_id, schedule_version_id, generation_run_id, action_type,
    entity_type, entity_id, current_state, proposed_state, sort_order
  )
  select
    selected_event_id,
    selected_schedule_version_id,
    selected_run_id,
    coalesce(nullif(item->>'action_type', ''), 'create'),
    coalesce(nullif(item->>'entity_type', ''), 'heat'),
    nullif(item->>'entity_id', '')::uuid,
    item->'current_state',
    coalesce(item->'proposed_state', '{}'::jsonb),
    coalesce((item->>'sort_order')::integer, 0)
  from jsonb_array_elements(coalesce(selected_proposals, '[]'::jsonb)) item;

  insert into public.event_competition_generation_conflicts (
    event_id, generation_run_id, conflict_type, severity, title,
    details, subjects, proposed_resolution
  )
  select
    selected_event_id,
    selected_run_id,
    coalesce(nullif(item->>'conflict_type', ''), 'custom'),
    coalesce(nullif(item->>'severity', ''), 'warning'),
    coalesce(nullif(item->>'title', ''), 'Schedule conflict'),
    nullif(item->>'details', ''),
    coalesce(item->'subjects', '[]'::jsonb),
    item->'proposed_resolution'
  from jsonb_array_elements(coalesce(selected_conflicts, '[]'::jsonb)) item;

  update public.event_competition_generation_runs
  set
    status = 'proposed',
    summary = coalesce(selected_summary, '{}'::jsonb),
    completed_at = now(),
    updated_at = now()
  where id = selected_run_id;
end;
$$;

create or replace function public.fail_competition_heat_plan_run(
  selected_run_id uuid,
  selected_failure_message text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare selected_event_id uuid;
begin
  select event_id into selected_event_id
  from public.event_competition_generation_runs where id = selected_run_id;
  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Planning run was not found or cannot be updated.';
  end if;
  update public.event_competition_generation_runs
  set status = 'failed', failure_message = left(selected_failure_message, 1000), completed_at = now(), updated_at = now()
  where id = selected_run_id and status in ('draft', 'queued', 'running');
end;
$$;

create or replace function public.acknowledge_competition_heat_plan_conflict(
  selected_conflict_id uuid,
  selected_note text default null
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  selected_event_id uuid;
  selected_severity text;
begin
  select event_id, severity into selected_event_id, selected_severity
  from public.event_competition_generation_conflicts where id = selected_conflict_id and status = 'open';
  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Conflict was not found or cannot be managed.';
  end if;
  if selected_severity = 'blocker' then
    raise exception 'Blocking conflicts must be corrected in configuration and regenerated.';
  end if;
  update public.event_competition_generation_conflicts
  set status = 'accepted', resolution_note = selected_note, resolved_by = auth.uid(), resolved_at = now(), updated_at = now()
  where id = selected_conflict_id;
end;
$$;

create or replace function public.review_competition_heat_plan(
  selected_run_id uuid,
  selected_decision text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare selected_event_id uuid;
begin
  select event_id into selected_event_id
  from public.event_competition_generation_runs
  where id = selected_run_id and status = 'proposed';
  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Proposed plan was not found or cannot be reviewed.';
  end if;
  if selected_decision not in ('reviewed', 'rejected') then
    raise exception 'Decision must be reviewed or rejected.';
  end if;
  if selected_decision = 'reviewed' and exists (
    select 1 from public.event_competition_generation_conflicts
    where generation_run_id = selected_run_id and severity = 'blocker' and status = 'open'
  ) then
    raise exception 'Resolve configuration blockers and generate a new plan before approval.';
  end if;

  update public.event_competition_generation_proposals
  set
    review_status = case when selected_decision = 'reviewed' then 'accepted' else 'rejected' end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where generation_run_id = selected_run_id and review_status = 'proposed';

  update public.event_competition_generation_runs
  set status = selected_decision, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = selected_run_id;
end;
$$;

comment on function public.create_competition_heat_plan_run(uuid, uuid, text, text, jsonb) is
  'Creates an immutable, reproducible input snapshot before the proposal-only planner runs.';
comment on function public.save_competition_heat_plan(uuid, jsonb, jsonb, jsonb) is
  'Atomically stores proposed heats and detected conflicts without writing operational heat records.';

notify pgrst, 'reload schema';
commit;
