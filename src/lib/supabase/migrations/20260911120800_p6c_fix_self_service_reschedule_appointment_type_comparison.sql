-- Membership Usage-Period Alignment -- P6c: fix an enum/text type-boundary
-- defect in the already-applied P6 migration's student self-service
-- reschedule wrapper.
--
-- DEFECT (confirmed live on DEV before writing this file): calling
-- public.update_private_lesson_membership_appointment_self_service failed
-- with
--   ERROR 42883: operator does not exist: appointment_type = text
--   not (v_old.appointment_type = any (coalesce(v_settings.
--   portal_bookable_lesson_types, array['private_lesson'])))
-- because v_old.appointment_type is read from public.appointments as the
-- concrete USER-DEFINED enum type public.appointment_type (confirmed live
-- via information_schema.columns), while studio_settings.
-- portal_bookable_lesson_types is a concrete text[] (confirmed live,
-- udt_name = _text). Postgres has no `=` operator between an enum type
-- and text, and confirmed via pg_cast that no implicit or assignment cast
-- exists for public.appointment_type in either direction -- so no
-- automatic coercion bridges the two.
--
-- LIVE TYPE AUDIT (read-only, before editing):
--   appointments.appointment_type          -> USER-DEFINED / appointment_type (enum)
--   studio_settings.portal_bookable_lesson_types -> ARRAY / _text (text[])
--   pg_cast entries for appointment_type   -> none (no implicit/assignment cast)
--
-- REPOSITORY-WIDE SIMILAR-COMPARISON AUDIT (grepped every appointment_type
-- reference across P1-P6b before editing). Classified:
--   SAFE (untyped string literals, not a concrete text/text[] value --
--   Postgres resolves literal type against the enum column, no mismatch):
--     P2 :379, P3 :84, P3c :33/34, P6 :243, :372, :494 (all `IN (...)`/
--     `NOT IN (...)` against literal lists).
--   SAFE (enum compared to enum, or text compared to text/text[] with no
--   enum involved): P3c :43/73 (`IS [NOT] DISTINCT FROM` between two
--   appointment_type-typed values); P6 :391 (self-service CREATE's
--   equivalent lesson-type check -- p_appointment_type there is the
--   wrapper's own `text` parameter, never the enum column, so `= any
--   (text[])` is already correct and is NOT touched by this migration).
--   DEFECTIVE -- all three confirmed empirically (a scratch function-call
--   test against DEV reproduced the identical 42883 error for a bare
--   enum-to-text function argument, not just the `=` operator), and all
--   three are inside the ONE function this migration replaces:
--     1. line ~508 (as shipped in P6): the `= any (text[])` predicate
--        above.
--     2. line ~558: `v_old.appointment_type` passed as the 4th argument
--        to public._self_service_slot_within_availability(uuid, uuid,
--        uuid, text, timestamptz, timestamptz) -- that parameter is
--        `text`, confirmed via its own revoke statement's signature.
--     3. line ~581: `v_old.appointment_type` passed as the
--        p_new_appointment_type argument (`text`) to
--        public._lesson_membership_reservation_core_update -- same
--        parameter, corrected already by P6b for duration_minutes, but
--        p_new_appointment_type there was always `text` and is unchanged.
--   No other P1-P6b/P6b function performs an enum-vs-text or
--   text-vs-enum comparison or argument pass involving appointment_type.
--   This migration touches nothing outside
--   update_private_lesson_membership_appointment_self_service.
--
-- FIX: cast the enum to text at each of the three call sites above --
-- `v_old.appointment_type::text` -- exactly at the configuration/
-- argument boundary where a concrete text or text[] value is required.
-- The appointments.appointment_type column keeps its enum type; studio_
-- settings.portal_bookable_lesson_types keeps its text[] type; the
-- default `array['private_lesson']` is preserved verbatim; the allow-list
-- semantics are unchanged -- this removes an invalid type comparison, it
-- does not change which lesson types are allowed or add any new implicit
-- casting of arbitrary configuration values (the cast is applied only to
-- the one already-typed enum value being read out of the locked row, not
-- to any user-supplied or configuration-supplied value).
--
-- SCOPE: CREATE OR REPLACE of exactly one function --
-- update_private_lesson_membership_appointment_self_service. Signature,
-- SECURITY DEFINER, search_path, ACLs, auth.uid() authorization,
-- client_account_links/can_manage_bookings check, studio/client/
-- membership ownership checks, self-service enabled/mode validation,
-- reschedule cutoff, status validation, instructor/room allow-list
-- checks, the availability predicate call, scheduling-resource locking,
-- membership capacity (delegated to the core, unchanged), protected-field
-- derivation from v_old, the fixed 'scheduled' status, and confirmation
-- reset are all byte-for-byte identical to the P6 migration this
-- replaces -- only the three enum/text boundary points are corrected.
--
-- This is a FUNCTIONAL CHANGE that preserves the intended, already-
-- reviewed P6 product behavior -- it fixes an implementation
-- incompatibility with the live enum/text type boundary, not a design
-- change.
--
-- P6 (20260911120600_...) and P6b (20260911120700_...) are preserved
-- as-is and NOT edited in place -- both are already-applied migration
-- artifacts on DEV. This file is a new, separate forward migration so the
-- repository preserves the exact sequence DEV experienced, and so PROD
-- can later execute the identical sequence (P6, then P6b, then P6c).

begin;

create or replace function public.update_private_lesson_membership_appointment_self_service(
  p_appointment_id uuid,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_client_membership_id uuid,
  p_new_instructor_id uuid default null,
  p_new_room_id uuid default null
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_old record;
  v_settings record;
  v_duration_minutes int;
  v_dest_instructor_id uuid;
  v_dest_room_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  select * into v_old from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found.';
  end if;

  if not exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid() and cal.client_id = v_old.client_id and cal.studio_id = v_old.studio_id
      and cal.status = 'linked' and cal.can_manage_bookings = true
  ) then
    raise exception 'Not authorized for this appointment.';
  end if;

  if v_old.appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    raise exception 'This booking type is not eligible for self-service.';
  end if;
  if v_old.status not in ('scheduled', 'rescheduled') then
    raise exception 'Only upcoming scheduled appointments can be changed.';
  end if;

  select * into v_settings from public.studio_settings where studio_id = v_old.studio_id;
  if v_settings.portal_self_scheduling_enabled is not true then
    raise exception 'Self-service scheduling is not enabled for this studio.';
  end if;
  if coalesce(v_settings.portal_self_scheduling_reschedule_mode, 'request_only') <> 'instant' then
    raise exception 'This studio requires a request/approval workflow for self-service reschedules.';
  end if;
  -- P6c fix: cast the enum to text at this configuration-boundary
  -- comparison -- portal_bookable_lesson_types is text[]; the appointment
  -- row's own column type is unchanged.
  if not (v_old.appointment_type::text = any (coalesce(v_settings.portal_bookable_lesson_types, array['private_lesson']))) then
    raise exception 'This lesson type is no longer available for self-service scheduling.';
  end if;

  -- Schema correction, see P6's file header: cancellation_window_hours is
  -- the real column; portal_self_scheduling_cancellation_cutoff_hours
  -- does not exist.
  if v_old.starts_at < now() + make_interval(hours => coalesce(v_settings.cancellation_window_hours, 24)) then
    raise exception 'Changes require at least %s hours notice.', coalesce(v_settings.cancellation_window_hours, 24);
  end if;

  v_duration_minutes := case
    when v_settings.portal_self_scheduling_default_duration_minutes = any (array[30, 45, 60, 75, 90, 120])
    then v_settings.portal_self_scheduling_default_duration_minutes
    else 45
  end;
  if extract(epoch from (p_new_ends_at - p_new_starts_at)) / 60 <> v_duration_minutes then
    raise exception 'Requested duration does not match this studio''s configured self-service lesson length.';
  end if;
  if p_new_starts_at < now() + make_interval(hours => coalesce(v_settings.portal_self_scheduling_min_notice_hours, 0)) then
    raise exception 'This time does not meet the minimum advance-notice requirement.';
  end if;
  if p_new_starts_at > now() + make_interval(days => coalesce(v_settings.portal_self_scheduling_window_days, 14)) then
    raise exception 'This time is beyond the self-service booking window.';
  end if;

  -- Destination instructor/room: caller may move to a different
  -- instructor/room during a reschedule (the real self-service product
  -- already supports this, see P6's file header) -- null means "keep
  -- current". The DESTINATION is what gets validated below, never the
  -- old one.
  v_dest_instructor_id := coalesce(p_new_instructor_id, v_old.instructor_id);
  v_dest_room_id := coalesce(p_new_room_id, v_old.room_id);

  if v_dest_instructor_id is not null and not exists (
    select 1 from public.instructors i where i.id = v_dest_instructor_id and i.studio_id = v_old.studio_id and i.active = true
  ) then
    raise exception 'Instructor not found for this studio.';
  end if;
  if v_dest_instructor_id is not null and v_settings.portal_bookable_instructor_ids is not null
     and array_length(v_settings.portal_bookable_instructor_ids, 1) > 0
     and not (v_dest_instructor_id = any (v_settings.portal_bookable_instructor_ids)) then
    raise exception 'This instructor is not available for self-service scheduling.';
  end if;
  if v_dest_room_id is not null and not exists (
    select 1 from public.rooms r where r.id = v_dest_room_id and r.studio_id = v_old.studio_id
  ) then
    raise exception 'Room not found for this studio.';
  end if;

  -- P6c fix: cast the enum to text -- _self_service_slot_within_
  -- availability's appointment-type parameter is declared `text`.
  if not public._self_service_slot_within_availability(
    v_old.studio_id, v_dest_instructor_id, v_dest_room_id, v_old.appointment_type::text, p_new_starts_at, p_new_ends_at
  ) then
    raise exception 'This time is outside the studio''s self-service availability.';
  end if;

  perform public._lock_and_check_scheduling_resources(
    v_old.studio_id, v_dest_instructor_id, v_dest_room_id, p_new_starts_at, p_new_ends_at, p_appointment_id
  );

  if p_new_client_membership_id is null then
    raise exception 'A membership must be specified for a membership-funded reschedule.';
  end if;
  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = p_new_client_membership_id and cm.client_id = v_old.client_id and cm.studio_id = v_old.studio_id
  ) then
    raise exception 'This membership does not belong to this client.';
  end if;

  -- Every protected field is read from the locked v_old row, never from a
  -- caller-supplied parameter -- there is no parameter for any of them on
  -- this function. P6c fix: cast the enum to text -- the core's
  -- p_new_appointment_type parameter is declared `text`.
  perform public._lesson_membership_reservation_core_update(
    p_appointment_id, v_old.client_id, v_old.appointment_type::text, p_new_starts_at, p_new_ends_at,
    'membership', p_new_client_membership_id, v_dest_instructor_id, v_dest_room_id, 'scheduled',
    v_old.notes, v_old.location_name, v_old.partner_client_id, v_old.billing_note, true
  );
end;
$$;

revoke all on function public.update_private_lesson_membership_appointment_self_service(uuid, timestamptz, timestamptz, uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.update_private_lesson_membership_appointment_self_service(uuid, timestamptz, timestamptz, uuid, uuid, uuid) to authenticated;

commit;
