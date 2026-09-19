-- Landmark 1A -- Slice 7: Instructor Capability Revocation & Future-Work
-- Protection.
--
-- Adds the canonical revoke_instructor_capability RPC and closes every
-- route by which new future instructional work could be attached to an
-- instructor after (or concurrently with) revocation.
--
-- Invariant: once revocation commits, no instructional work can newly
-- hold an incapable instructor. "Holds" is defined once, in SQL, by three
-- predicate helpers (appointments, booking_requests, action requests) that
-- are used by BOTH the revocation blocker counts and the write-side
-- triggers, so the two can never diverge.
--
-- Concurrency: writers (appointment / request triggers) take the
-- Slice-6 studio-wide seat advisory lock in SHARED mode inside
-- _landmark1a_assert_assignable_instructor; revoke_instructor_capability
-- (like every Slice 6 seat RPC) holds it EXCLUSIVE. Writers never block
-- each other; a writer and a revocation always serialize, and each
-- outcome is one of: writer commits first -> revocation sees the blocker
-- and fails; revocation commits first -> writer re-checks assignability
-- and fails. Lock order (linkage lock -> seat lock) is unchanged: the
-- shared seat lock is a leaf, nothing acquires a linkage lock after it,
-- and no Slice 6/7 RPC writes appointments or requests.
--
-- Created (9): _landmark1a_is_instructional_type,
--   _landmark1a_appointment_holds_instructor,
--   _landmark1a_booking_request_holds_instructor,
--   _landmark1a_action_request_holds_instructor,
--   _landmark1a_enforce_booking_request_instructor_assignability (+ trigger),
--   _landmark1a_enforce_action_request_instructor_assignability (+ trigger),
--   revoke_instructor_capability.
-- Replaced (3): _landmark1a_assert_assignable_instructor,
--   _landmark1a_enforce_appointment_instructor_assignability, and its
--   trigger landmark1a_enforce_appointment_instructor_assignability
--   (column list widened to add status, ends_at).
--
-- No table, column, constraint, index, or data change.

begin;

-- 1. Canonical helpers ----------------------------------------------------------

-- The ONLY SQL copy of the instructional appointment-type list. NULL fails
-- closed (treated as instructional). floor_space_rental (instructor_id is
-- the renter's own identity) and room_unavailable are deliberately excluded.
create or replace function public._landmark1a_is_instructional_type(p_type text)
returns boolean
language sql
immutable
security definer
set search_path = 'public'
as $$
  select p_type is null
      or p_type in (
        'private_lesson', 'group_class', 'intro_lesson',
        'coaching', 'practice_party', 'event'
      );
$$;

revoke all on function public._landmark1a_is_instructional_type(text)
  from public, anon, authenticated, service_role;

-- Does this appointment currently constitute instructional work that holds
-- its instructor? Instructional type, not yet ended, and not terminal.
-- NULL / unknown status fails closed (holds).
create or replace function public._landmark1a_appointment_holds_instructor(
  p_type text,
  p_status text,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select public._landmark1a_is_instructional_type(p_type)
     and coalesce(p_ends_at > now(), true)
     and (p_status is null or p_status not in ('attended', 'cancelled', 'no_show'));
$$;

revoke all on function public._landmark1a_appointment_holds_instructor(text, text, timestamptz)
  from public, anon, authenticated, service_role;

-- Live, future, not-yet-materialized booking_requests row.
create or replace function public._landmark1a_booking_request_holds_instructor(
  p_status text,
  p_appointment_id uuid,
  p_starts_at timestamptz,
  p_type text
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(p_status in ('pending', 'approved'), false)
     and p_appointment_id is null
     and coalesce(p_starts_at > now(), false)
     and public._landmark1a_is_instructional_type(p_type);
$$;

revoke all on function public._landmark1a_booking_request_holds_instructor(text, uuid, timestamptz, text)
  from public, anon, authenticated, service_role;

-- Live, future student action request that will create/move an
-- appointment. No appointment_id condition: a reschedule carries the
-- existing appointment's id from creation; status alone says whether it
-- has been materialized (execution sets 'executed').
create or replace function public._landmark1a_action_request_holds_instructor(
  p_status text,
  p_action_type text,
  p_starts_at timestamptz,
  p_lesson_type text
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(p_status in ('pending', 'approved'), false)
     and coalesce(p_action_type in ('book', 'reschedule'), false)
     and coalesce(p_starts_at > now(), false)
     and public._landmark1a_is_instructional_type(p_lesson_type);
$$;

revoke all on function public._landmark1a_action_request_holds_instructor(text, text, timestamptz, text)
  from public, anon, authenticated, service_role;

-- 2. Writer-side shared seat lock -----------------------------------------------

-- Slice 5 body, plus a SHARED transaction-scoped advisory lock on the
-- Slice-6 studio seat key, taken after the null guard and before the live
-- check. Under READ COMMITTED the check below runs on a fresh snapshot
-- after the lock is granted, so it sees any revocation that committed
-- while this writer waited.
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

  perform pg_advisory_xact_lock_shared(hashtext(p_studio_id::text || ':instructor_seat'));

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

-- 3. Appointment enforcement ----------------------------------------------------

-- Slice 5 behavior preserved: INSERT of an instructional row, and any
-- change of instructor / studio / appointment_type on an instructional
-- row, validate. New: an UPDATE that moves the row from NOT holding its
-- instructor to holding it (terminal -> live, past -> future,
-- non-instructional -> instructional) validates even if the instructor
-- itself did not change. Transitions out of holding (cancel, complete,
-- move to the past), continuously-live edits, and metadata edits never
-- validate. starts_at is deliberately not a trigger column: hold state
-- depends only on ends_at (ends_at > starts_at is a table CHECK).
create or replace function public._landmark1a_enforce_appointment_instructor_assignability()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_validate boolean := false;
begin
  if new.instructor_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_validate := public._landmark1a_is_instructional_type(new.appointment_type::text);
  else
    v_validate :=
      public._landmark1a_is_instructional_type(new.appointment_type::text)
      and (
        new.instructor_id is distinct from old.instructor_id
        or new.studio_id is distinct from old.studio_id
        or new.appointment_type is distinct from old.appointment_type
      );

    if not v_validate then
      v_validate :=
        public._landmark1a_appointment_holds_instructor(
          new.appointment_type::text, new.status::text, new.ends_at
        )
        and not public._landmark1a_appointment_holds_instructor(
          old.appointment_type::text, old.status::text, old.ends_at
        );
    end if;
  end if;

  if v_validate then
    perform public._landmark1a_assert_assignable_instructor(new.studio_id, new.instructor_id);
  end if;

  return new;
end;
$$;

drop trigger if exists landmark1a_enforce_appointment_instructor_assignability
  on public.appointments;

create trigger landmark1a_enforce_appointment_instructor_assignability
before insert or update of instructor_id, studio_id, appointment_type, status, ends_at
on public.appointments
for each row
execute function public._landmark1a_enforce_appointment_instructor_assignability();

-- 4. Request-table enforcement --------------------------------------------------

create or replace function public._landmark1a_enforce_booking_request_instructor_assignability()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_validate boolean := false;
begin
  if new.instructor_id is null then
    return new;
  end if;

  if not public._landmark1a_booking_request_holds_instructor(
    new.status, new.appointment_id, new.requested_starts_at, new.appointment_type
  ) then
    return new; -- terminal / materialized / past: cleanup is never gated
  end if;

  if tg_op = 'INSERT' then
    v_validate := true;
  else
    v_validate :=
      not public._landmark1a_booking_request_holds_instructor(
        old.status, old.appointment_id, old.requested_starts_at, old.appointment_type
      )
      or new.instructor_id is distinct from old.instructor_id
      or new.studio_id is distinct from old.studio_id;
  end if;

  if v_validate then
    perform public._landmark1a_assert_assignable_instructor(new.studio_id, new.instructor_id);
  end if;

  return new;
end;
$$;

revoke all on function public._landmark1a_enforce_booking_request_instructor_assignability()
  from public, anon, authenticated, service_role;

create trigger landmark1a_enforce_booking_request_instructor_assignability
before insert or update of instructor_id, studio_id, status, appointment_id, requested_starts_at, appointment_type
on public.booking_requests
for each row
execute function public._landmark1a_enforce_booking_request_instructor_assignability();

create or replace function public._landmark1a_enforce_action_request_instructor_assignability()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_validate boolean := false;
begin
  if new.instructor_id is null then
    return new;
  end if;

  if not public._landmark1a_action_request_holds_instructor(
    new.status, new.action_type, new.requested_starts_at, new.lesson_type
  ) then
    return new; -- cancel actions, terminal states, past starts: never gated
  end if;

  if tg_op = 'INSERT' then
    v_validate := true;
  else
    v_validate :=
      not public._landmark1a_action_request_holds_instructor(
        old.status, old.action_type, old.requested_starts_at, old.lesson_type
      )
      or new.instructor_id is distinct from old.instructor_id
      or new.studio_id is distinct from old.studio_id;
  end if;

  if v_validate then
    perform public._landmark1a_assert_assignable_instructor(new.studio_id, new.instructor_id);
  end if;

  return new;
end;
$$;

revoke all on function public._landmark1a_enforce_action_request_instructor_assignability()
  from public, anon, authenticated, service_role;

create trigger landmark1a_enforce_action_request_instructor_assignability
before insert or update of instructor_id, studio_id, status, action_type, requested_starts_at, lesson_type
on public.student_booking_action_requests
for each row
execute function public._landmark1a_enforce_action_request_instructor_assignability();

-- 5. Revocation RPC -------------------------------------------------------------

create or replace function public.revoke_instructor_capability(
  p_studio_id uuid,
  p_instructor_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_instructor public.instructors;
  v_appointments int;
  v_booking_requests int;
  v_action_requests int;
begin
  if v_caller is null then
    raise exception 'Not authenticated.';
  end if;

  if not public._landmark1a_can_manage_instructors(p_studio_id) then
    raise exception 'Not authorized to manage instructors for this studio.';
  end if;

  -- Exclusive studio seat lock + row lock + fresh read. Every blocker
  -- count below runs after this lock is granted, so it sees every writer
  -- that committed while holding the shared lock.
  v_instructor := public._landmark1a_lock_instructor_for_transition(p_studio_id, p_instructor_id);

  if v_instructor.can_instruct = false then
    return; -- idempotent no-op: no mutation, no audit
  end if;

  select count(*) into v_appointments
  from public.appointments a
  where a.studio_id = p_studio_id
    and a.instructor_id = p_instructor_id
    and public._landmark1a_appointment_holds_instructor(
      a.appointment_type::text, a.status::text, a.ends_at
    );

  select count(*) into v_booking_requests
  from public.booking_requests r
  where r.studio_id = p_studio_id
    and r.instructor_id = p_instructor_id
    and public._landmark1a_booking_request_holds_instructor(
      r.status, r.appointment_id, r.requested_starts_at, r.appointment_type
    );

  select count(*) into v_action_requests
  from public.student_booking_action_requests r
  where r.studio_id = p_studio_id
    and r.instructor_id = p_instructor_id
    and public._landmark1a_action_request_holds_instructor(
      r.status, r.action_type, r.requested_starts_at, r.lesson_type
    );

  if v_appointments + v_booking_requests + v_action_requests > 0 then
    raise exception 'Instructional capability cannot be removed while this instructor still has future work: % upcoming appointment(s), % booking request(s), % self-service action request(s). Reassign, cancel, or resolve them first.',
      v_appointments, v_booking_requests, v_action_requests;
  end if;

  update public.instructors
  set can_instruct = false
  where id = p_instructor_id;

  insert into public.instructor_audit_events (
    studio_id, instructor_id, actor_user_id, event_type,
    before_value, after_value, metadata
  ) values (
    p_studio_id, p_instructor_id, v_caller, 'capability_revoked',
    jsonb_build_object('can_instruct', true),
    jsonb_build_object('can_instruct', false),
    jsonb_build_object('source', 'revoke_instructor_capability')
  );
end;
$$;

revoke all on function public.revoke_instructor_capability(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.revoke_instructor_capability(uuid, uuid) to authenticated;

commit;
