-- rollback/20261111090000_phase10d_heats_floor_schedule_rollback.sql
--
-- Reverts 10D: restores the four schedule functions verbatim, the original placement trigger column list
-- and the per-round heat-number uniqueness; drops floor heats, their triggers, helpers and RPCs.
-- REFUSES (no data loss) if any floor heat or floor-heat placement exists, or if restoring the per-round
-- heat-number uniqueness would collide. Roll the APP back first.

begin;

do $$
begin
  if to_regclass('public.event_competition_floor_heats') is null then
    raise exception '10D rollback: event_competition_floor_heats is absent (10D not applied).';
  end if;
  if exists (select 1 from public.event_competition_floor_heats)
     or exists (select 1 from public.event_competition_heats where floor_heat_id is not null) then
    raise exception '10D rollback refused: numbered floor heats exist; the pre-10D model cannot hold them.';
  end if;
  if exists (select 1 from public.event_competition_heats group by round_id, heat_number having count(*) > 1) then
    raise exception '10D rollback refused: scoring-heat numbers repeat across schedule versions.';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.publish_competition_schedule_version(selected_version_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.build_competition_schedule_snapshot(selected_version_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_competition_schedule_version(selected_event_id uuid, selected_name text DEFAULT NULL::text, source_version_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  next_number integer;
  new_version_id uuid;
  source_session record;
  source_block record;
  new_session_id uuid;
  new_block_id uuid;
begin
  if not public.can_manage_event_competition(selected_event_id) then
    raise exception 'Not authorized to manage this competition.';
  end if;

  perform pg_advisory_xact_lock(hashtext(selected_event_id::text));
  select coalesce(max(version_number), 0) + 1 into next_number
  from public.event_competition_schedule_versions where event_id = selected_event_id;

  if source_version_id is not null and not exists (
    select 1 from public.event_competition_schedule_versions
    where id = source_version_id and event_id = selected_event_id
  ) then
    raise exception 'Source schedule version does not belong to this event.';
  end if;

  insert into public.event_competition_schedule_versions (
    event_id, version_number, name, based_on_version_id, created_by
  ) values (
    selected_event_id,
    next_number,
    coalesce(nullif(btrim(selected_name), ''), 'Schedule v' || next_number),
    source_version_id,
    auth.uid()
  ) returning id into new_version_id;

  if source_version_id is not null then
    for source_session in
      select * from public.event_competition_schedule_sessions
      where schedule_version_id = source_version_id order by starts_at, sort_order
    loop
      insert into public.event_competition_schedule_sessions (
        event_id, schedule_version_id, name, session_date, starts_at, ends_at, sort_order, notes
      ) values (
        selected_event_id, new_version_id, source_session.name, source_session.session_date,
        source_session.starts_at, source_session.ends_at, source_session.sort_order, source_session.notes
      ) returning id into new_session_id;

      for source_block in
        select * from public.event_competition_schedule_blocks
        where session_id = source_session.id order by starts_at, sort_order
      loop
        insert into public.event_competition_schedule_blocks (
          event_id, schedule_version_id, session_id, floor_id, name, block_type,
          starts_at, ends_at, sort_order, configuration
        ) values (
          selected_event_id, new_version_id, new_session_id, source_block.floor_id,
          source_block.name, source_block.block_type, source_block.starts_at, source_block.ends_at,
          source_block.sort_order, source_block.configuration
        ) returning id into new_block_id;

        insert into public.event_competition_schedule_block_contests (
          event_id, schedule_version_id, block_id, contest_id, planned_round_type, sort_order, constraints
        )
        select selected_event_id, new_version_id, new_block_id, contest_id,
          planned_round_type, sort_order, constraints
        from public.event_competition_schedule_block_contests
        where block_id = source_block.id;
      end loop;
    end loop;
  end if;

  return new_version_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_competition_heat_schedule_placement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

drop trigger validate_competition_heat_schedule_placement on public.event_competition_heats;
create trigger validate_competition_heat_schedule_placement
before insert or update of event_id, division_id, contest_id, schedule_version_id,
  schedule_block_id, floor_id, scheduled_at, estimated_ends_at
on public.event_competition_heats
for each row execute function public.validate_competition_heat_schedule_placement();

drop trigger comp10d_heat_floor_integrity on public.event_competition_heats;
drop trigger comp10d_heat_entry_floor_integrity on public.event_competition_heat_entries;
drop trigger comp10d_heat_dance_floor_integrity on public.event_competition_heat_dances;
drop trigger comp10d_guard_heat_entry on public.event_competition_heat_entries;
drop trigger comp10d_guard_heat_dance on public.event_competition_heat_dances;
drop trigger comp10d_guard_heat_delete on public.event_competition_heats;

drop function public.apply_competition_floor_plan(uuid, jsonb);
drop function public.clear_competition_floor_plan(uuid);
drop function public.move_competition_scoring_heat_to_new_floor_heat(uuid, integer);
drop function public.move_competition_scoring_heat(uuid, uuid);
drop function public.move_competition_floor_heat(uuid, integer);
drop function public.insert_competition_floor_heat(uuid, integer);
drop function public.delete_competition_floor_heat(uuid);
drop function public.set_competition_round_heat_capacity(uuid, integer);
drop function public._comp10d_copy_floor_plan(uuid, uuid);
drop function public._comp10d_require_draft(uuid);
drop function public.competition_floor_schedule_problems(uuid);
drop function public._comp10d_check_floor_heat_integrity();
drop function public._comp10d_guard_heat_child();
drop function public._comp10d_guard_heat_delete();

drop index public.event_competition_heats_round_version_number_uidx;
alter table public.event_competition_heats add constraint event_competition_heats_round_id_heat_number_key unique (round_id, heat_number);
alter table public.event_competition_heats drop constraint event_competition_heats_floor_heat_fk;
drop index if exists public.event_competition_heats_floor_heat_idx;
alter table public.event_competition_heats drop column floor_heat_id;
drop table public.event_competition_floor_heats;

drop function public._comp10d_guard_floor_heat();
drop function public._comp10d_floor_heat_problems(uuid);
drop function public._comp10d_scoring_heat_duplicate(uuid);
drop function public._comp10d_heat_music_key(uuid);
drop function public._comp10d_version_editable(uuid, uuid);

do $$
begin
  if md5(pg_get_functiondef('public.validate_competition_heat_schedule_placement()'::regprocedure)) <> 'ffa24e9295dad872ffb45c26329bd876'
     or md5(pg_get_functiondef('public.publish_competition_schedule_version(uuid)'::regprocedure)) <> '3a1fa54d6a9d8517cc14248239ae5274'
     or md5(pg_get_functiondef('public.build_competition_schedule_snapshot(uuid)'::regprocedure)) <> 'dd39df81a653ae9fead035ef00042d97'
     or md5(pg_get_functiondef('public.create_competition_schedule_version(uuid,text,uuid)'::regprocedure)) <> '3487229452fbf2dcb7a913933f940e27' then
    raise exception '10D rollback postflight: schedule functions were not restored exactly.';
  end if;
end $$;

commit;
