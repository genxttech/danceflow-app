-- Membership Usage-Period Alignment -- P6: atomic membership-funded
-- private-lesson CREATE/UPDATE, staff and student self-service.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections M, N, R, S, T, U
-- (Phase 1), revised by the Phase 2 "Application-Layer Cutover" plan
-- sections 1-4 (field-by-field staff/student classification).
--
-- SCHEMA CORRECTION vs. the plan's prose (not a product-decision change, a
-- factual one): the plan's student reschedule RPC references
-- studio_settings.portal_self_scheduling_cancellation_cutoff_hours. That
-- column does not exist on the live schema (confirmed via
-- information_schema.columns against DEV before writing this file). The
-- real column serving the same purpose -- a configurable minimum-notice
-- window for changing an already-scheduled appointment -- is the existing,
-- generic studio_settings.cancellation_window_hours (not null, default 24).
-- Used in its place below; behavior and intent are identical to what the
-- plan specifies, only the concrete column name differs.
--
-- Staff authorization reuses the existing, already-shipped
-- _gc1_4_has_broad_studio_authority(studio_id) helper (confirmed live: its
-- body is exactly "platform_admin OR broad studio role", byte-for-byte the
-- predicate the plan's section Q describes inline) rather than
-- re-inlining that same three-branch check by hand -- same authorization
-- model the plan specifies, expressed via the established, already-tested
-- helper instead of a hand-duplicated copy.
--
-- PHASE 2 CORRECTION (field-by-field staff/student classification): a
-- first draft of the application-layer cutover mechanically widened both
-- the staff AND the two student self-service wrappers to accept every
-- field the staff editor uses. That was wrong for the student wrappers --
-- they are directly `authenticated`-callable and were deliberately
-- hardened against adversarial direct invocation. Only the shared private
-- cores below are widened freely; the staff wrappers widen to match the
-- real staff editor; the two student wrappers stay exactly as narrow as
-- the current, real self-service product already is (`title` dropped --
-- selfServiceExecution.ts hardcodes "Self-Service Booking", never a
-- caller value; `notes`/`location_name`/`partner_client_id`/`billing_note`
-- never exposed -- none are set by the current self-service product;
-- `client_id`/`appointment_type`/`status` never caller-supplied on
-- reschedule -- always derived from the locked row or a fixed literal).
-- One correction the other direction: `p_new_instructor_id`/
-- `p_new_room_id` ARE added to the student reschedule wrapper, because
-- selfServiceExecution.ts's real reschedule payload already includes
-- `request.instructor_id`/`request.room_id` -- the current product
-- already lets a reschedule move to a different instructor/room, not
-- only a different time; omitting them would have been a regression.

begin;

-- ============================================================================
-- 1. Shared private cores (plan sections M, N; widened per Phase 2 field
--    classification). Unauthorized -- callers must validate authorization
--    and derive/restrict every field themselves before calling these; the
--    cores trust every value they're given. Reused by both the staff RPCs
--    and the two student self-service wrappers below (Option B
--    architecture, plan section R) -- deliberately richer than either
--    public wrapper, per Phase 2's "shared private core" design: the
--    staff wrapper passes authorized editable values; the student wrapper
--    derives protected values from trusted DB state and passes them
--    internally; one core performs the atomic scheduling-resource lock,
--    membership lock, capacity recheck, and mutation.
-- ============================================================================
create or replace function public._lesson_membership_reservation_core_create(
  p_studio_id uuid, p_client_id uuid, p_client_membership_id uuid,
  p_instructor_id uuid, p_room_id uuid, p_appointment_type text, p_title text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_notes text default null, p_location_name text default null,
  p_partner_client_id uuid default null, p_billing_note text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_benefit_id uuid;
  v_balance record;
  v_result uuid;
begin
  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = p_client_membership_id and cm.client_id = p_client_id and cm.studio_id = p_studio_id
  ) then
    raise exception 'This membership does not belong to this client.';
  end if;

  perform 1 from public.client_memberships where id = p_client_membership_id for update;

  select mpb.id into v_benefit_id
    from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = p_client_membership_id and mpb.benefit_type = 'included_private_lessons';
  if v_benefit_id is null then
    raise exception 'This membership has no private-lesson benefit.';
  end if;

  select * into v_balance from public._private_lesson_finite_balance(
    p_client_membership_id, v_benefit_id, p_starts_at, null
  );
  if v_balance.available <= 0 then
    raise exception 'No allowance remaining in this membership''s billing period for a private lesson.';
  end if;

  insert into public.appointments (
    studio_id, client_id, client_membership_id, instructor_id, room_id,
    appointment_type, title, starts_at, ends_at, duration_minutes, billing_type, status,
    notes, location_name, partner_client_id, billing_note
  ) values (
    p_studio_id, p_client_id, p_client_membership_id, p_instructor_id, p_room_id,
    p_appointment_type::public.appointment_type, p_title, p_starts_at, p_ends_at,
    (extract(epoch from (p_ends_at - p_starts_at)) / 60)::int, 'membership', 'scheduled',
    p_notes, p_location_name, p_partner_client_id, p_billing_note
  ) returning id into v_result;

  return v_result;
end;
$$;

revoke all on function public._lesson_membership_reservation_core_create(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text) from public, anon, authenticated, service_role;

create or replace function public._lesson_membership_reservation_core_update(
  p_appointment_id uuid,
  p_new_client_id uuid,
  p_new_appointment_type text,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_billing_type text,
  p_new_client_membership_id uuid,
  p_new_instructor_id uuid,
  p_new_room_id uuid,
  p_new_status text,
  p_new_notes text default null,
  p_new_location_name text default null,
  p_new_partner_client_id uuid default null,
  p_new_billing_note text default null,
  p_reset_confirmation boolean default true
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_old record;
  v_benefit_id uuid;
  v_balance record;
begin
  select * into v_old from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found.';
  end if;

  if p_new_billing_type = 'membership' then
    if p_new_client_membership_id is null then
      raise exception 'A membership must be specified for a membership-funded appointment.';
    end if;
    if not exists (
      select 1 from public.client_memberships cm
      where cm.id = p_new_client_membership_id and cm.client_id = p_new_client_id and cm.studio_id = v_old.studio_id
    ) then
      raise exception 'This membership does not belong to this client.';
    end if;

    perform 1 from public.client_memberships where id = p_new_client_membership_id for update;

    select mpb.id into v_benefit_id
      from public.membership_plan_benefits mpb
      join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
      where cm.id = p_new_client_membership_id and mpb.benefit_type = 'included_private_lessons';
    if v_benefit_id is null then
      raise exception 'This membership has no private-lesson benefit.';
    end if;

    select * into v_balance from public._private_lesson_finite_balance(
      p_new_client_membership_id, v_benefit_id, p_new_starts_at, p_appointment_id
    );
    if v_balance.available <= 0 then
      raise exception 'No allowance remaining in this membership''s billing period for a private lesson.';
    end if;
  end if;

  -- One atomic update -- every field the caller is authorized to set (or
  -- has derived from trusted DB state) is written in this single
  -- statement, never a core call followed by a second, separate
  -- `.update()` from the wrapper.
  update public.appointments
    set client_id = p_new_client_id,
        appointment_type = p_new_appointment_type::public.appointment_type,
        starts_at = p_new_starts_at,
        ends_at = p_new_ends_at,
        duration_minutes = (extract(epoch from (p_new_ends_at - p_new_starts_at)) / 60)::int,
        billing_type = p_new_billing_type,
        client_membership_id = p_new_client_membership_id,
        instructor_id = p_new_instructor_id,
        room_id = p_new_room_id,
        status = p_new_status::public.appointment_status,
        notes = p_new_notes,
        location_name = p_new_location_name,
        partner_client_id = p_new_partner_client_id,
        billing_note = p_new_billing_note,
        confirmed_at = case when p_reset_confirmation then null else confirmed_at end,
        confirmation_source = case when p_reset_confirmation then null else confirmation_source end,
        confirmation_actor_user_id = case when p_reset_confirmation then null else confirmation_actor_user_id end,
        updated_at = now()
    where id = p_appointment_id;
end;
$$;

revoke all on function public._lesson_membership_reservation_core_update(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text, boolean) from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. Staff-facing public wrappers (plan section M/N; widened per Phase 2
--    to preserve the full existing staff-editor shape). Authorization
--    reuses the existing role model verbatim (see header note) plus the
--    deterministic instructor/room scheduling lock (plan section X) ahead
--    of the entitlement core. Every widened parameter is a field staff
--    already has full authority over today (createAppointmentAction /
--    updateAppointmentAction, schedule/actions.ts) -- nothing new is
--    granted, only preserved.
-- ============================================================================
create or replace function public.create_private_lesson_membership_appointment(
  p_studio_id uuid, p_client_id uuid, p_client_membership_id uuid,
  p_instructor_id uuid, p_room_id uuid, p_appointment_type text, p_title text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_notes text default null, p_location_name text default null,
  p_partner_client_id uuid default null, p_billing_note text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_result uuid;
begin
  if not (
    public._gc1_4_has_broad_studio_authority(p_studio_id)
    or (p_instructor_id is not null and public.is_own_instructor_appointment(p_studio_id, p_instructor_id))
  ) then
    raise exception 'Not authorized for this appointment.';
  end if;

  if p_appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    raise exception 'This booking type is not eligible for this RPC.';
  end if;

  if not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    raise exception 'Client does not belong to this studio.';
  end if;
  if p_instructor_id is not null and not exists (
    select 1 from public.instructors i where i.id = p_instructor_id and i.studio_id = p_studio_id
  ) then
    raise exception 'Instructor does not belong to this studio.';
  end if;
  if p_room_id is not null and not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.studio_id = p_studio_id
  ) then
    raise exception 'Room does not belong to this studio.';
  end if;

  -- Deterministic scheduling-resource lock (plan section X), shared with
  -- the student RPCs -- closes the check-then-insert TOCTOU race.
  perform public._lock_and_check_scheduling_resources(
    p_studio_id, p_instructor_id, p_room_id, p_starts_at, p_ends_at, null
  );

  v_result := public._lesson_membership_reservation_core_create(
    p_studio_id, p_client_id, p_client_membership_id, p_instructor_id, p_room_id,
    p_appointment_type, p_title, p_starts_at, p_ends_at,
    p_notes, p_location_name, p_partner_client_id, p_billing_note
  );
  return v_result;
end;
$$;

revoke all on function public.create_private_lesson_membership_appointment(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text) from public, anon, service_role;
grant execute on function public.create_private_lesson_membership_appointment(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text) to authenticated;

create or replace function public.update_private_lesson_membership_appointment(
  p_appointment_id uuid, p_new_client_id uuid, p_new_appointment_type text,
  p_new_starts_at timestamptz, p_new_ends_at timestamptz,
  p_new_billing_type text, p_new_client_membership_id uuid,
  p_new_instructor_id uuid, p_new_room_id uuid, p_new_status text,
  p_notes text default null, p_location_name text default null,
  p_partner_client_id uuid default null, p_billing_note text default null
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_old record;
  v_time_changed boolean;
begin
  -- Authorization is derived from the locked existing row, never from
  -- caller-supplied parameters.
  select * into v_old from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found.';
  end if;

  if not (
    public._gc1_4_has_broad_studio_authority(v_old.studio_id)
    or (v_old.instructor_id is not null and public.is_own_instructor_appointment(v_old.studio_id, v_old.instructor_id))
  ) then
    raise exception 'Not authorized for this appointment.';
  end if;

  -- Deterministic scheduling-resource lock on the DESTINATION
  -- instructor/room, excluding this appointment's own current occupancy.
  -- p_new_instructor_id/p_new_room_id are the caller's real final values
  -- (staff always supplies the intended end state -- an explicit null
  -- means "no instructor/room", not "leave unchanged"), matching exactly
  -- what the core update below actually writes -- this lock step and the
  -- write must agree on what "destination" means, or the lock would
  -- protect a different resource than the one actually being occupied.
  perform public._lock_and_check_scheduling_resources(
    v_old.studio_id, p_new_instructor_id, p_new_room_id,
    p_new_starts_at, p_new_ends_at, p_appointment_id
  );

  -- Confirmation fields reset only when the time actually changed,
  -- matching updateAppointmentAction's existing `timeChanged ? null :
  -- undefined` rule exactly.
  v_time_changed := (v_old.starts_at is distinct from p_new_starts_at) or (v_old.ends_at is distinct from p_new_ends_at);

  perform public._lesson_membership_reservation_core_update(
    p_appointment_id, p_new_client_id, p_new_appointment_type, p_new_starts_at, p_new_ends_at,
    p_new_billing_type, p_new_client_membership_id, p_new_instructor_id, p_new_room_id, p_new_status,
    p_notes, p_location_name, p_partner_client_id, p_billing_note, v_time_changed
  );
end;
$$;

revoke all on function public.update_private_lesson_membership_appointment(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text) from public, anon, service_role;
grant execute on function public.update_private_lesson_membership_appointment(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text) to authenticated;

-- ============================================================================
-- 3. Student-facing self-service wrappers (plan sections R, S, T, U;
--    corrected per Phase 2's field classification -- narrow, matching the
--    real self-service product exactly, not the staff editor). Every
--    protected field (client_id/appointment_type/status on reschedule;
--    title/notes/location_name/partner_client_id/billing_note on both)
--    has NO corresponding parameter on these functions -- not merely
--    ignored if supplied, genuinely absent from the callable signature.
-- ============================================================================
create or replace function public.create_private_lesson_membership_appointment_self_service(
  p_studio_id uuid,
  p_client_id uuid,
  p_client_membership_id uuid,
  p_instructor_id uuid,
  p_room_id uuid,
  p_appointment_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz
) returns uuid
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_settings record;
  v_duration_minutes int;
  v_result uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if p_appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    raise exception 'This booking type is not eligible for self-service.';
  end if;

  if not exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid() and cal.client_id = p_client_id and cal.studio_id = p_studio_id
      and cal.status = 'linked' and cal.can_manage_bookings = true
  ) then
    raise exception 'Not authorized to book for this client.';
  end if;

  select * into v_settings from public.studio_settings where studio_id = p_studio_id;
  if v_settings.portal_self_scheduling_enabled is not true then
    raise exception 'Self-service booking is not enabled for this studio.';
  end if;
  if coalesce(v_settings.portal_self_scheduling_mode, 'request_only') <> 'instant' then
    raise exception 'This studio requires a request/approval workflow for new self-service bookings.';
  end if;
  if not (p_appointment_type = any (coalesce(v_settings.portal_bookable_lesson_types, array['private_lesson']))) then
    raise exception 'This lesson type is not available for self-service booking.';
  end if;

  if p_starts_at < now() + make_interval(hours => coalesce(v_settings.portal_self_scheduling_min_notice_hours, 0)) then
    raise exception 'This time does not meet the minimum advance-notice requirement.';
  end if;
  if p_starts_at > now() + make_interval(days => coalesce(v_settings.portal_self_scheduling_window_days, 14)) then
    raise exception 'This time is beyond the self-service booking window.';
  end if;

  v_duration_minutes := case
    when v_settings.portal_self_scheduling_default_duration_minutes = any (array[30, 45, 60, 75, 90, 120])
    then v_settings.portal_self_scheduling_default_duration_minutes
    else 45
  end;
  if extract(epoch from (p_ends_at - p_starts_at)) / 60 <> v_duration_minutes then
    raise exception 'Requested duration does not match this studio''s configured self-service lesson length.';
  end if;

  if p_instructor_id is not null and not exists (
    select 1 from public.instructors i where i.id = p_instructor_id and i.studio_id = p_studio_id and i.active = true
  ) then
    raise exception 'Instructor not found for this studio.';
  end if;
  if p_instructor_id is not null and v_settings.portal_bookable_instructor_ids is not null
     and array_length(v_settings.portal_bookable_instructor_ids, 1) > 0
     and not (p_instructor_id = any (v_settings.portal_bookable_instructor_ids)) then
    raise exception 'This instructor is not available for self-service booking.';
  end if;
  if p_room_id is not null and not exists (
    select 1 from public.rooms r where r.id = p_room_id and r.studio_id = p_studio_id
  ) then
    raise exception 'Room not found for this studio.';
  end if;

  if not public._self_service_slot_within_availability(
    p_studio_id, p_instructor_id, p_room_id, p_appointment_type, p_starts_at, p_ends_at
  ) then
    raise exception 'This time is outside the studio''s self-service availability.';
  end if;

  perform public._lock_and_check_scheduling_resources(
    p_studio_id, p_instructor_id, p_room_id, p_starts_at, p_ends_at, null
  );

  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = p_client_membership_id and cm.client_id = p_client_id and cm.studio_id = p_studio_id
  ) then
    raise exception 'This membership does not belong to this client.';
  end if;

  -- Title is never a caller value for self-service -- the real product
  -- hardcodes this exact literal (selfServiceExecution.ts).
  v_result := public._lesson_membership_reservation_core_create(
    p_studio_id, p_client_id, p_client_membership_id, p_instructor_id, p_room_id,
    p_appointment_type, 'Self-Service Booking', p_starts_at, p_ends_at
  );
  return v_result;
end;
$$;

revoke all on function public.create_private_lesson_membership_appointment_self_service(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz) from public, anon, service_role;
grant execute on function public.create_private_lesson_membership_appointment_self_service(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated;

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
  if not (v_old.appointment_type = any (coalesce(v_settings.portal_bookable_lesson_types, array['private_lesson']))) then
    raise exception 'This lesson type is no longer available for self-service scheduling.';
  end if;

  -- Schema correction, see file header: cancellation_window_hours is the
  -- real column; portal_self_scheduling_cancellation_cutoff_hours does not
  -- exist.
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
  -- already supports this, see file header) -- null means "keep current".
  -- The DESTINATION is what gets validated below, never the old one.
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

  if not public._self_service_slot_within_availability(
    v_old.studio_id, v_dest_instructor_id, v_dest_room_id, v_old.appointment_type, p_new_starts_at, p_new_ends_at
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
  -- this function.
  perform public._lesson_membership_reservation_core_update(
    p_appointment_id, v_old.client_id, v_old.appointment_type, p_new_starts_at, p_new_ends_at,
    'membership', p_new_client_membership_id, v_dest_instructor_id, v_dest_room_id, 'scheduled',
    v_old.notes, v_old.location_name, v_old.partner_client_id, v_old.billing_note, true
  );
end;
$$;

revoke all on function public.update_private_lesson_membership_appointment_self_service(uuid, timestamptz, timestamptz, uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.update_private_lesson_membership_appointment_self_service(uuid, timestamptz, timestamptz, uuid, uuid, uuid) to authenticated;

commit;
