-- ============================================================================
-- ROLLBACK for 20261023090100_gcse3_review_lock_order_and_studio_scope.sql (GC-S1E-3 review remediation).
--
-- Returns to the state of 20261023090000 alone: drops the two BEFORE ROW lock triggers and their function and
-- restores the 20261023090000 definitions of _gcse3_guard_direct_class_schedule and
-- create_group_class_appointment verbatim. To roll back GC-S1E-3 entirely, run this file and then
-- 20261023090000_gcse3_group_class_conflict_authority_rollback.sql (which also tolerates this file not having run).
-- ============================================================================

begin;

drop trigger if exists appointments_gcse3_lock_direct_class_insert on public.appointments;
drop trigger if exists appointments_gcse3_lock_direct_class_update on public.appointments;
drop function if exists public._gcse3_lock_direct_class_row();

create or replace function public._gcse3_guard_direct_class_schedule()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_active public.appointment_status[] := array[
    'scheduled', 'confirmed', 'rescheduled', 'attended'
  ]::public.appointment_status[];
  v_ids uuid[];
  v_instructors uuid[];
  v_rooms uuid[];
  v_id uuid;
  v_row record;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    select array_agg(n.id order by n.id),
           array_agg(distinct n.instructor_id) filter (where n.instructor_id is not null),
           array_agg(distinct n.room_id) filter (where n.room_id is not null)
      into v_ids, v_instructors, v_rooms
      from new_rows n
     where n.appointment_type = 'group_class'::public.appointment_type
       and n.status = any (v_active);
  else
    with changed as (
      select n.id, n.instructor_id as new_instructor, o.instructor_id as old_instructor,
             n.room_id as new_room, o.room_id as old_room
      from new_rows n
      join old_rows o on o.id = n.id
      where n.appointment_type = 'group_class'::public.appointment_type
        and n.status = any (v_active)
        and (n.instructor_id is distinct from o.instructor_id
             or n.room_id is distinct from o.room_id
             or n.starts_at is distinct from o.starts_at
             or n.ends_at is distinct from o.ends_at
             or n.exclusive_room_use is distinct from o.exclusive_room_use
             or n.studio_id is distinct from o.studio_id
             or not (o.status = any (v_active)))
    )
    select (select array_agg(c.id order by c.id) from changed c),
           (select array_agg(distinct x) from changed c, unnest(array[c.new_instructor, c.old_instructor]) x where x is not null),
           (select array_agg(distinct x) from changed c, unnest(array[c.new_room, c.old_room]) x where x is not null)
      into v_ids, v_instructors, v_rooms;
  end if;

  if v_ids is null then
    return null;
  end if;

  perform public._gcse3_lock_resources(v_instructors, v_rooms);

  foreach v_id in array v_ids loop
    select a.studio_id, a.instructor_id, a.room_id, a.starts_at, a.ends_at, a.exclusive_room_use
      into v_row
      from public.appointments a
     where a.id = v_id
       and a.appointment_type = 'group_class'::public.appointment_type
       and a.status = any (v_active);
    continue when not found;

    v_reason := public._gcse3_schedule_conflict(
      v_row.studio_id, v_id, v_row.instructor_id, v_row.room_id, v_row.starts_at, v_row.ends_at, v_row.exclusive_room_use
    );
    if v_reason is not null then
      raise exception 'GCSE3_CONFLICT: reason=%', v_reason;
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function public._gcse3_guard_direct_class_schedule() from public, anon, authenticated, service_role;

create or replace function public.create_group_class_appointment(
  p_studio_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_appointment_id uuid;
  v_reason text;
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'Not authorized to create a group class for this studio.';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A group class requires a valid start and end time.';
  end if;

  -- GC-S1E-3: lock the class's resources, then refuse a conflicting class before writing it.
  perform public._gcse3_lock_resources(array[p_instructor_id], array[p_room_id]);
  v_reason := public._gcse3_schedule_conflict(p_studio_id, null, p_instructor_id, p_room_id, p_starts_at, p_ends_at, false);
  if v_reason is not null then
    raise exception 'GCSE3_CONFLICT: reason=%', v_reason;
  end if;

  insert into public.appointments (
    studio_id, instructor_id, room_id, appointment_type, title,
    starts_at, ends_at, client_id, status, created_by
  )
  values (
    p_studio_id, p_instructor_id, p_room_id, 'group_class'::public.appointment_type, p_title,
    p_starts_at, p_ends_at, null, 'scheduled'::appointment_status, auth.uid()
  )
  returning id into v_appointment_id;

  return v_appointment_id;
end;
$$;

revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from anon;
revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from service_role;
grant execute on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated;

commit;
