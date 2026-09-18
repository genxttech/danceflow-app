-- Landmark 1A -- Slice 5: Instructor Assignability Validation
--
-- Adds database-level enforcement that only a currently valid, assignable
-- instructor (same studio, active, can_instruct, account-linked) can be
-- persisted onto an instructional appointment's instructor_id -- closing
-- the gap where every RPC (create_group_class_appointment,
-- update_private_lesson_membership_appointment, and others) and every raw
-- .insert()/.update() against public.appointments trusted a submitted
-- instructor_id with zero eligibility check.
--
-- Implemented as one narrowly-scoped, non-directly-callable SQL helper
-- plus one BEFORE INSERT OR UPDATE trigger directly on public.appointments
-- -- not by modifying any existing RPC body. The trigger covers every
-- write path (RPC-mediated or raw) uniformly, since it fires on the
-- actual row mutation regardless of which code called it, with a smaller
-- migration surface and zero risk of drifting from any one RPC's own
-- validation logic.
--
-- Revalidates whenever the instructional-assignment relationship itself
-- changes -- instructor_id, studio_id, or appointment_type -- never on an
-- unrelated edit (notes, room, price, status, time) that leaves all three
-- unchanged, so a historical/already-scheduled appointment is never
-- retroactively invalidated merely because its instructor later becomes
-- inactive/incapable/unlinked. Scoped only to genuinely instructional
-- appointment types (private_lesson, group_class, intro_lesson, coaching,
-- practice_party, event) -- floor_space_rental (where instructor_id
-- represents the renter's own identity, not a teaching assignment) and
-- room_unavailable are explicitly excluded.

begin;

create or replace function public._landmark1a_assert_assignable_instructor(
  p_studio_id uuid,
  p_instructor_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if p_instructor_id is null then
    return;
  end if;

  if not exists (
    select 1
    from public.instructors
    where id = p_instructor_id
      and studio_id = p_studio_id
      and active = true
      and can_instruct = true
      and user_id is not null
  ) then
    raise exception 'This instructor is no longer available for assignment.';
  end if;
end;
$$;

revoke all on function public._landmark1a_assert_assignable_instructor(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_enforce_appointment_instructor_assignability()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.instructor_id is not null
     and new.appointment_type in (
       'private_lesson', 'group_class', 'intro_lesson',
       'coaching', 'practice_party', 'event'
     )
     and (
       tg_op = 'INSERT'
       or new.instructor_id is distinct from old.instructor_id
       or new.studio_id is distinct from old.studio_id
       or new.appointment_type is distinct from old.appointment_type
     )
  then
    perform public._landmark1a_assert_assignable_instructor(new.studio_id, new.instructor_id);
  end if;

  return new;
end;
$$;

drop trigger if exists landmark1a_enforce_appointment_instructor_assignability
  on public.appointments;

create trigger landmark1a_enforce_appointment_instructor_assignability
before insert or update of instructor_id, studio_id, appointment_type
on public.appointments
for each row
execute function public._landmark1a_enforce_appointment_instructor_assignability();

commit;
