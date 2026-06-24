-- Competition Apply Heat Plan V1
-- Applies an approved proposal to an unchanged draft schedule.
-- Save in: src/lib/supabase/migrations/20260621_competition_apply_heat_plan_v1.sql

begin;

create or replace function public.apply_competition_heat_plan(selected_run_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  selected_event_id uuid;
  selected_schedule_version_id uuid;
  run_started_at timestamptz;
  run_seed text;
  proposal record;
  new_heat_id uuid;
  applied_count integer := 0;
begin
  select event_id, schedule_version_id, initiated_at, randomization_seed
  into selected_event_id, selected_schedule_version_id, run_started_at, run_seed
  from public.event_competition_generation_runs
  where id = selected_run_id and status = 'reviewed';

  if selected_event_id is null or not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Approved plan was not found or cannot be applied.';
  end if;
  if not exists (
    select 1 from public.event_competition_schedule_versions
    where id = selected_schedule_version_id and event_id = selected_event_id and status = 'draft'
  ) then
    raise exception 'The target schedule is no longer an editable draft.';
  end if;
  if exists (
    select 1 from public.event_competition_generation_conflicts
    where generation_run_id = selected_run_id and severity = 'blocker' and status = 'open'
  ) then
    raise exception 'The plan still contains blocking conflicts.';
  end if;
  if exists (
    select 1 from public.event_competition_generation_proposals
    where generation_run_id = selected_run_id and review_status <> 'accepted'
  ) then
    raise exception 'Every proposal must be accepted before application.';
  end if;
  if not exists (
    select 1 from public.event_competition_generation_proposals
    where generation_run_id = selected_run_id and entity_type = 'heat'
  ) then
    raise exception 'The approved plan contains no heats.';
  end if;
  if exists (
    select 1 from public.event_competition_heats
    where schedule_version_id = selected_schedule_version_id and status <> 'cancelled'
  ) then
    raise exception 'This draft already contains operational heats. Create a new schedule version before regenerating.';
  end if;

  if exists (
    select 1 from public.event_competition_entries
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_entry_dances
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_entry_participants
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_programs
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_contests
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_divisions
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_rounds
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_dances
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_division_dances
    where event_id = selected_event_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_schedule_blocks
    where schedule_version_id = selected_schedule_version_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_schedule_block_contests
    where schedule_version_id = selected_schedule_version_id and (updated_at > run_started_at or created_at > run_started_at)
  ) or exists (
    select 1 from public.event_competition_generation_constraints
    where event_id = selected_event_id
      and (schedule_version_id is null or schedule_version_id = selected_schedule_version_id)
      and (updated_at > run_started_at or created_at > run_started_at)
  ) then
    raise exception 'Competition inputs changed after this plan was generated. Generate and review a new plan.';
  end if;

  if exists (
    select 1
    from public.event_competition_generation_proposals p
    cross join lateral jsonb_array_elements_text(coalesce(p.proposed_state->'entry_ids', '[]'::jsonb)) proposed_entry(id)
    left join public.event_competition_entries e on e.id = proposed_entry.id::uuid
    where p.generation_run_id = selected_run_id
      and (
        e.id is null
        or e.status <> 'confirmed'
        or e.eligibility_status not in ('eligible', 'waived')
        or e.division_id is distinct from (p.proposed_state->>'division_id')::uuid
      )
  ) then
    raise exception 'One or more proposed entries are no longer confirmed and eligible in the planned division.';
  end if;

  for proposal in
    select id, proposed_state, sort_order
    from public.event_competition_generation_proposals
    where generation_run_id = selected_run_id
      and entity_type = 'heat'
      and action_type = 'create'
      and review_status = 'accepted'
    order by sort_order, id
  loop
    insert into public.event_competition_heats (
      event_id, division_id, round_id, contest_id, schedule_version_id,
      schedule_block_id, generation_run_id, floor_id, heat_number, name,
      scheduled_at, estimated_ends_at, duration_seconds, schedule_sequence,
      floor_label, status, randomization_seed, configuration
    ) values (
      selected_event_id,
      (proposal.proposed_state->>'division_id')::uuid,
      (proposal.proposed_state->>'round_id')::uuid,
      (proposal.proposed_state->>'contest_id')::uuid,
      selected_schedule_version_id,
      (proposal.proposed_state->>'schedule_block_id')::uuid,
      selected_run_id,
      nullif(proposal.proposed_state->>'floor_id', '')::uuid,
      (proposal.proposed_state->>'heat_number')::integer,
      proposal.proposed_state->>'name',
      (proposal.proposed_state->>'scheduled_at')::timestamptz,
      (proposal.proposed_state->>'estimated_ends_at')::timestamptz,
      (proposal.proposed_state->>'duration_seconds')::integer,
      (proposal.proposed_state->>'schedule_sequence')::integer,
      proposal.proposed_state->>'floor_name',
      'scheduled',
      run_seed,
      jsonb_build_object(
        'proposal_id', proposal.id,
        'proposal_key', proposal.proposed_state->>'proposal_key',
        'expected_entry_count', (proposal.proposed_state->>'expected_entry_count')::integer
      )
    ) returning id into new_heat_id;

    insert into public.event_competition_heat_dances (
      event_id, heat_id, dance_id, dance_key, dance_label,
      sequence_number, duration_seconds
    )
    select
      selected_event_id,
      new_heat_id,
      (dance->>'dance_id')::uuid,
      dance->>'dance_key',
      dance->>'dance_label',
      (dance->>'sequence_number')::integer,
      (dance->>'duration_seconds')::integer
    from jsonb_array_elements(coalesce(proposal.proposed_state->'dances', '[]'::jsonb)) dance;

    insert into public.event_competition_heat_entries (
      event_id, division_id, heat_id, entry_id, floor_order, status
    )
    select
      selected_event_id,
      (proposal.proposed_state->>'division_id')::uuid,
      new_heat_id,
      entry_id::uuid,
      entry_order::integer,
      'scheduled'
    from jsonb_array_elements_text(coalesce(proposal.proposed_state->'entry_ids', '[]'::jsonb))
      with ordinality entries(entry_id, entry_order);

    update public.event_competition_generation_proposals
    set review_status = 'applied', applied_at = now(), updated_at = now()
    where id = proposal.id;
    applied_count := applied_count + 1;
  end loop;

  update public.event_competition_generation_runs
  set status = 'applied', applied_at = now(), updated_at = now()
  where id = selected_run_id;

  return applied_count;
end;
$$;

create or replace function public.build_competition_schedule_snapshot(selected_version_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', jsonb_build_object('id', v.id, 'event_id', v.event_id, 'version_number', v.version_number, 'name', v.name),
    'sessions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id, 'name', s.name, 'session_date', s.session_date,
          'starts_at', s.starts_at, 'ends_at', s.ends_at,
          'blocks', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', b.id, 'name', b.name, 'block_type', b.block_type,
                'starts_at', b.starts_at, 'ends_at', b.ends_at,
                'floor_name', b.floor_name_snapshot, 'floor_capacity', b.floor_capacity_snapshot,
                'contests', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'contest_id', a.contest_id, 'contest_name', c.name,
                    'planned_round_type', a.planned_round_type, 'sort_order', a.sort_order
                  ) order by a.sort_order, c.name)
                  from public.event_competition_schedule_block_contests a
                  join public.event_competition_contests c on c.id = a.contest_id
                  where a.block_id = b.id
                ), '[]'::jsonb)
              ) order by b.starts_at, b.sort_order, b.id
            ) from public.event_competition_schedule_blocks b where b.session_id = s.id
          ), '[]'::jsonb)
        ) order by s.starts_at, s.sort_order, s.id
      ) from public.event_competition_schedule_sessions s where s.schedule_version_id = v.id
    ), '[]'::jsonb),
    'heats', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', h.id, 'contest_id', h.contest_id, 'division_id', h.division_id,
          'round_id', h.round_id, 'block_id', h.schedule_block_id,
          'heat_number', h.heat_number, 'name', h.name,
          'scheduled_at', h.scheduled_at, 'estimated_ends_at', h.estimated_ends_at,
          'duration_seconds', h.duration_seconds, 'schedule_sequence', h.schedule_sequence,
          'floor_id', h.floor_id, 'floor_label', h.floor_label, 'status', h.status,
          'lock_state', h.lock_state,
          'dances', coalesce((
            select jsonb_agg(jsonb_build_object(
              'dance_id', d.dance_id, 'dance_key', d.dance_key, 'dance_label', d.dance_label,
              'sequence_number', d.sequence_number, 'duration_seconds', d.duration_seconds
            ) order by d.sequence_number)
            from public.event_competition_heat_dances d where d.heat_id = h.id and d.status <> 'cancelled'
          ), '[]'::jsonb),
          'entries', coalesce((
            select jsonb_agg(jsonb_build_object(
              'entry_id', he.entry_id, 'floor_order', he.floor_order, 'status', he.status
            ) order by he.floor_order, he.entry_id)
            from public.event_competition_heat_entries he where he.heat_id = h.id
          ), '[]'::jsonb)
        ) order by h.scheduled_at, h.schedule_sequence, h.id
      ) from public.event_competition_heats h
      where h.schedule_version_id = v.id and h.status <> 'cancelled'
    ), '[]'::jsonb)
  )
  from public.event_competition_schedule_versions v
  where v.id = selected_version_id;
$$;

comment on function public.apply_competition_heat_plan(uuid) is
  'Applies an approved proposal only when its draft and planning inputs remain unchanged.';
comment on function public.build_competition_schedule_snapshot(uuid) is
  'Builds the immutable published Schedule of Events and detailed heat program snapshot.';

notify pgrst, 'reload schema';
commit;
