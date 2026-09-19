-- Rollback for 20260918050000_landmark1a_slice7_instructor_capability_revocation.sql
--
-- Restores the exact Slice 5 appointment enforcement (trigger column list,
-- trigger function body, assert-helper body with no advisory lock) and
-- drops everything Slice 7 created. Touches no data and no audit history
-- (any capability_revoked audit rows written while Slice 7 was live remain).
--
-- Order matters: the Slice 5 trigger function is restored BEFORE the
-- canonical helpers it currently references are dropped.

begin;

drop function if exists public.revoke_instructor_capability(uuid, uuid);

drop trigger if exists landmark1a_enforce_booking_request_instructor_assignability
  on public.booking_requests;
drop function if exists public._landmark1a_enforce_booking_request_instructor_assignability();

drop trigger if exists landmark1a_enforce_action_request_instructor_assignability
  on public.student_booking_action_requests;
drop function if exists public._landmark1a_enforce_action_request_instructor_assignability();

drop trigger if exists landmark1a_enforce_appointment_instructor_assignability
  on public.appointments;

-- Slice 5 trigger function body, restored verbatim.
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

create trigger landmark1a_enforce_appointment_instructor_assignability
before insert or update of instructor_id, studio_id, appointment_type
on public.appointments
for each row
execute function public._landmark1a_enforce_appointment_instructor_assignability();

-- Slice 5 assert helper body, restored verbatim (no advisory lock).
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

drop function if exists public._landmark1a_action_request_holds_instructor(text, text, timestamptz, text);
drop function if exists public._landmark1a_booking_request_holds_instructor(text, uuid, timestamptz, text);
drop function if exists public._landmark1a_appointment_holds_instructor(text, text, timestamptz);
drop function if exists public._landmark1a_is_instructional_type(text);

commit;
