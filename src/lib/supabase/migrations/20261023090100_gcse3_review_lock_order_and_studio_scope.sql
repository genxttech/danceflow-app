-- ============================================================================
-- GC-S1E-3 focused-review remediation (forward migration on top of 20261023090000).
--
-- 1. Lock order of the direct single-occurrence edit. The statement-level AFTER guard took its
--    instructor / room locks only at the END of the statement, after the foreign-key check of a
--    changed instructor or room had already taken a KEY SHARE lock on that row. KEY SHARE conflicts
--    with the FOR UPDATE that the P4 membership private-lesson writers take (instructor row, then room
--    row), so "edit holds KEY SHARE(room), waits for the instructor" against "P4 holds the instructor,
--    waits for the room" was a real deadlock (reproduced on DEV). A BEFORE ROW trigger now takes the
--    row's old and new instructor / room locks (instructors by id, then rooms by id) after the row
--    lock and BEFORE the foreign-key checks, so the direct edit follows the same order as S1C-5 and the
--    P4 update path: appointment row -> instructors -> rooms. The AFTER guard still re-validates the
--    final state (its own lock call is then a no-op for an already-held row).
-- 2. Studio scope of locks. Only resources that belong to the written row's own studio are locked by
--    the direct-write path; a direct write of a class with another studio's room is refused
--    (GCSE3_ROOM_INVALID). The one-time class create validates its instructor (the same assignability
--    rule the insert trigger applies, same message) and refuses another studio's room before locking.
-- Functions replaced in place (same signatures, grants restated); one function and two triggers added.
-- No table, column, index, policy or data change.
-- ============================================================================

begin;

-- ============================================================================
-- 1. Direct writes: lock the row's resources before the foreign-key checks
-- ============================================================================
create function public._gcse3_lock_direct_class_row()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_instructors uuid[];
  v_rooms uuid[];
begin
  if new.room_id is not null
     and (tg_op = 'INSERT' or new.room_id is distinct from old.room_id or new.studio_id is distinct from old.studio_id)
     and not exists (select 1 from public.rooms r where r.id = new.room_id and r.studio_id = new.studio_id)
  then
    raise exception 'GCSE3_ROOM_INVALID: That room does not belong to this studio.';
  end if;

  select array_agg(i.id) into v_instructors
    from public.instructors i
   where (i.id = new.instructor_id and i.studio_id = new.studio_id)
      or (tg_op = 'UPDATE' and i.id = old.instructor_id and i.studio_id = old.studio_id);

  select array_agg(r.id) into v_rooms
    from public.rooms r
   where (r.id = new.room_id and r.studio_id = new.studio_id)
      or (tg_op = 'UPDATE' and r.id = old.room_id and r.studio_id = old.studio_id);

  perform public._gcse3_lock_resources(v_instructors, v_rooms);
  return new;
end;
$$;

revoke all on function public._gcse3_lock_direct_class_row() from public, anon, authenticated, service_role;
-- No grant execute: reachable only as a trigger body.

-- Same gating as the statement guard (anon / authenticated statements only; SECURITY DEFINER RPCs run as
-- the owner and lock on their own), limited to active classes whose schedule or resources change.
create trigger appointments_gcse3_lock_direct_class_insert
  before insert on public.appointments
  for each row
  when (current_user in ('anon', 'authenticated')
        and new.appointment_type = 'group_class'::public.appointment_type
        and new.status in ('scheduled', 'confirmed', 'rescheduled', 'attended'))
  execute function public._gcse3_lock_direct_class_row();

create trigger appointments_gcse3_lock_direct_class_update
  before update on public.appointments
  for each row
  when (current_user in ('anon', 'authenticated')
        and new.appointment_type = 'group_class'::public.appointment_type
        and new.status in ('scheduled', 'confirmed', 'rescheduled', 'attended')
        and (new.instructor_id is distinct from old.instructor_id
             or new.room_id is distinct from old.room_id
             or new.starts_at is distinct from old.starts_at
             or new.ends_at is distinct from old.ends_at
             or new.exclusive_room_use is distinct from old.exclusive_room_use
             or new.studio_id is distinct from old.studio_id
             or old.status not in ('scheduled', 'confirmed', 'rescheduled', 'attended')))
  execute function public._gcse3_lock_direct_class_row();

-- ============================================================================
-- 2. Statement guard: lock only the row's own studio's resources (otherwise unchanged)
-- ============================================================================
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
           (select array_agg(distinct i.id) from new_rows n2 join public.instructors i on i.id = n2.instructor_id and i.studio_id = n2.studio_id
             where n2.appointment_type = 'group_class'::public.appointment_type and n2.status = any (v_active)),
           (select array_agg(distinct r.id) from new_rows n2 join public.rooms r on r.id = n2.room_id and r.studio_id = n2.studio_id
             where n2.appointment_type = 'group_class'::public.appointment_type and n2.status = any (v_active))
      into v_ids, v_instructors, v_rooms
      from new_rows n
     where n.appointment_type = 'group_class'::public.appointment_type
       and n.status = any (v_active);
  else
    with changed as (
      select n.id, n.instructor_id as new_instructor, o.instructor_id as old_instructor,
             n.room_id as new_room, o.room_id as old_room, n.studio_id as new_studio, o.studio_id as old_studio
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
           (select array_agg(distinct i.id) from changed c
              join public.instructors i on (i.id = c.new_instructor and i.studio_id = c.new_studio)
                                        or (i.id = c.old_instructor and i.studio_id = c.old_studio)),
           (select array_agg(distinct r.id) from changed c
              join public.rooms r on (r.id = c.new_room and r.studio_id = c.new_studio)
                                  or (r.id = c.old_room and r.studio_id = c.old_studio))
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

-- ============================================================================
-- 3. One-time class create: instructor / room ownership validated before locking
-- ============================================================================
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

  -- GC-S1E-3 review: only this studio's instructor and room are ever locked or checked. The instructor
  -- check is the same assignability rule the appointments trigger applies on insert (same message); a
  -- room from another studio would make every room rule silently vacuous, so it is refused.
  perform public._landmark1a_assert_assignable_instructor(p_studio_id, p_instructor_id);
  if p_room_id is not null and not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.studio_id = p_studio_id
  ) then
    raise exception 'GCSE3_ROOM_INVALID: That room does not belong to this studio.';
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
