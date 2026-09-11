-- GC-1.4A: Shared Group Class Booking & Enrollment Write Cutover -- Expand.
--
-- Cuts group-class writes over from the legacy single-client `appointments`
-- shape to the canonical shared-class model: one `appointments` row per
-- class instance (client_id always null), one `appointment_attendees` row
-- per enrolled student. Creation and enrollment are deliberately separate
-- operations -- `create_group_class_appointment` creates only the class
-- shell (zero attendees, always); `enroll_class_attendee` is the sole
-- roster-enrollment writer, for the first attendee of a brand-new class and
-- every attendee added afterward alike. Six new functions total:
--
--   1. _gc1_4_has_broad_studio_authority   -- private helper
--   2. _gc1_4_class_enrollment_authority   -- private helper
--   3. create_group_class_appointment      -- broad staff only
--   4. enroll_class_attendee               -- broad staff, or the class's
--                                              assigned instructor
--   5. cancel_class_attendee               -- same authority as #4
--   6. cancel_group_class_appointment      -- broad staff only
--   7. check_in_own_class_attendance       -- the enrolled client only
--   8. enforce_group_class_canonical_shape -- BEFORE INSERT/UPDATE trigger
--                                              on appointments (trigger-only,
--                                              never directly callable)
--
-- (Eight functions total once the two private helpers are counted --
-- "six new functions" above refers to the six with independent product
-- purpose; the two _gc1_4_* helpers exist only to avoid duplicating the
-- same authorization logic across the callable ones, matching this
-- migration's own DRY intent.)
--
-- Plus a roster-aware `create or replace` of the two existing QR check-in
-- RPCs (get_client_appointments_for_checkin,
-- get_client_appointment_for_checkin_validation), and one controlled
-- `alter table` widening appointment_attendees.source's CHECK constraint to
-- add 'instructor' (an assigned instructor enrolling their own class's
-- student is real, distinct provenance from 'staff').
--
-- GC-1.2's class_enrollment_covers_participation(...) and its two
-- attendance_records triggers are NOT modified anywhere in this file --
-- they remain exactly as GC-1.2 shipped them, correctly serving staff
-- historical attendance correction (a post-start-cancelled enrollment stays
-- eligible for that). check_in_own_class_attendance below uses a
-- deliberately narrower, different rule: a CURRENT status='booked'
-- enrollment only -- a student who has since cancelled, even after the
-- class started, must not be able to newly self-check-in on the strength
-- of a cancellation that already happened. Two different questions
-- ("did this legitimately happen" vs "is this student currently enrolled,
-- right now"), two different, both-correct rules, living side by side.
--
-- Every callable function here embeds its own auth.uid()-based
-- authorization check -- this is the direct, deliberate lesson from
-- SEC-P0 (a SECURITY DEFINER RPC with NO caller-authorization check at
-- all, reachable by anon/authenticated). No function here trusts a
-- caller-supplied actor/provenance id: created_by/cancelled_by are always
-- auth.uid(), and enroll_class_attendee's `source` is always derived from
-- which authorization branch the caller matched, never accepted as an
-- input parameter.

begin;

-- ============================================================================
-- 0a. _gc1_4_has_broad_studio_authority -- private helper.
--
-- The exact same three-branch check already used by appointment_attendees'
-- own INSERT/UPDATE RLS (GC-1.1): platform_admin, or an active
-- studio_owner/studio_admin/front_desk row at this studio. Factored into
-- one function so every callable RPC below shares one definition rather
-- than five independently-drifting copies.
-- ============================================================================
create or replace function public._gc1_4_has_broad_studio_authority(
  target_studio_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  );
$$;

revoke all on function public._gc1_4_has_broad_studio_authority(uuid) from public;
revoke all on function public._gc1_4_has_broad_studio_authority(uuid) from anon;
revoke all on function public._gc1_4_has_broad_studio_authority(uuid) from authenticated;
revoke all on function public._gc1_4_has_broad_studio_authority(uuid) from service_role;
-- Deliberately granted to no role at all -- reachable only from inside the
-- SECURITY DEFINER functions below via owner-implicit privilege, matching
-- the established convention for internal-only helpers in this codebase
-- (_resolve_qr_checkin_client_id).

-- ============================================================================
-- 0b. _gc1_4_class_enrollment_authority -- private helper.
--
-- Resolves the caller's authority over ONE specific class's roster:
-- 'broad' (any class in the studio), 'own_instructor' (this class's
-- current assigned instructor only, reusing the existing, already-audited
-- is_own_instructor_appointment ownership helper unchanged), or null (no
-- authority -- unassigned instructor, floor-rental-only relationship, or
-- no relationship at all). Used by enroll_class_attendee and
-- cancel_class_attendee, which deliberately share this one resolution
-- rather than each re-implementing it. create_group_class_appointment and
-- cancel_group_class_appointment do NOT use this helper -- they require
-- 'broad' only, resolved directly via _gc1_4_has_broad_studio_authority.
-- ============================================================================
create or replace function public._gc1_4_class_enrollment_authority(
  target_studio_id uuid,
  target_appointment_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_instructor_id uuid;
begin
  if public._gc1_4_has_broad_studio_authority(target_studio_id) then
    return 'broad';
  end if;

  select instructor_id into v_instructor_id
    from public.appointments
    where id = target_appointment_id
      and studio_id = target_studio_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_instructor_id is not null
     and public.is_own_instructor_appointment(target_studio_id, v_instructor_id)
  then
    return 'own_instructor';
  end if;

  return null;
end;
$$;

revoke all on function public._gc1_4_class_enrollment_authority(uuid, uuid) from public;
revoke all on function public._gc1_4_class_enrollment_authority(uuid, uuid) from anon;
revoke all on function public._gc1_4_class_enrollment_authority(uuid, uuid) from authenticated;
revoke all on function public._gc1_4_class_enrollment_authority(uuid, uuid) from service_role;

-- ============================================================================
-- 1. create_group_class_appointment -- creates the class shell only.
--
-- Broad staff authority only -- deliberately does NOT reuse
-- canCreateAppointments' role set (which includes generic `instructor`).
-- That permission was designed and has only ever been exercised for an
-- instructor creating their OWN private lesson; there is no existing
-- explicit studio permission or workflow anywhere in this codebase proving
-- instructor-initiated CLASS creation (as opposed to lesson creation) was
-- ever intended, so it is not inherited here. Always inserts client_id =
-- null and zero appointment_attendees rows -- enroll_class_attendee (below)
-- is the only operation that ever writes a roster row, whether that's a
-- brand-new class's first attendee or its fiftieth.
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
begin
  if not public._gc1_4_has_broad_studio_authority(p_studio_id) then
    raise exception 'Not authorized to create a group class for this studio.';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A group class requires a valid start and end time.';
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
grant execute on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated;
-- Minimum-necessary posture, corrected during review: this RPC is only
-- ever invoked from createAppointmentAction via the cookie/session-scoped
-- client (never createAdminClient()) -- no real code path needs
-- service_role execute, so it is explicitly revoked rather than left as an
-- unused default/convenience grant.
revoke all on function public.create_group_class_appointment(uuid, uuid, uuid, text, timestamptz, timestamptz) from service_role;

-- ============================================================================
-- 2. appointment_attendees.source -- widen the CHECK constraint.
--
-- A fifth value, 'instructor', to honestly represent enroll_class_attendee's
-- new own-instructor provenance (section 3) -- distinct from 'staff', which
-- now means specifically the broad-authority branch. Purely additive: every
-- existing row's value ('staff'/'portal'/'self_service'/'booking_request')
-- remains valid; nothing is removed from the allowed set.
-- ============================================================================
alter table public.appointment_attendees
  drop constraint appointment_attendees_source_check;

alter table public.appointment_attendees
  add constraint appointment_attendees_source_check
  check (source = any (array['staff', 'portal', 'self_service', 'booking_request', 'instructor']::text[]));

-- ============================================================================
-- 3. enroll_class_attendee -- the sole roster-enrollment writer.
--
-- Authorization: broad staff (any class) or the class's currently assigned
-- instructor (this class only) -- reuses _gc1_4_class_enrollment_authority.
-- An unassigned instructor, an independent/floor-rental-only instructor, or
-- anyone with no relationship to this class is denied.
--
-- Financial minimization: for 'own_instructor' scope, every caller-supplied
-- billing parameter is IGNORED. The function instead auto-resolves the
-- client's own single unambiguous eligible billing candidate, counted
-- across BOTH categories together:
--   - an eligible package: an active client_packages row with a
--     client_package_items row for usage_type='group_class' that is
--     either is_unlimited or has quantity_remaining > 0;
--   - an eligible UNLIMITED group-class membership: a status='active'
--     client_memberships row whose plan has a membership_plan_benefits row
--     with benefit_type='unlimited_group_classes' and quantity IS NULL,
--     and applies_to null/''/'all'/'group_class'. Deliberately status=
--     'active' only, not the broader active/past_due/unpaid set
--     src/lib/memberships/entitlements.ts's validateMembershipEntitlement
--     treats as still-checkable for lesson booking (subject to studio
--     settings that may still block an unpaid one there) -- this function
--     has no access to those studio settings and no staff review step, so
--     auto-resolving a payment-lapsed membership without human review would
--     be a real financial-authority overreach for a bare instructor role;
--     restricting to 'active' is the safer, conservative choice. This also
--     means a client can never have more than one auto-resolvable
--     membership simultaneously, since uq_client_one_active_membership (a
--     partial unique index, confirmed live) already guarantees at most one
--     status='active' client_memberships row per client -- "multiple
--     eligible memberships" is schema-impossible for this function's
--     narrower rule, not merely untested (see the SQL test suite's
--     T-gc1-4a-uq-client-one-active-membership-enforced regression, which
--     proves the constraint rather than fabricating a state it forbids).
--     Note: 'trialing' -- referenced by validateMembershipEntitlement's own
--     status allow-list -- is not a valid client_memberships.status value
--     at all (confirmed against the live client_memberships_status_check
--     CHECK constraint: active/paused/cancelled/expired/pending/past_due/
--     unpaid only). Also, benefit_type='included_group_classes' (the
--     string validateMembershipEntitlement and AppointmentCreateForm.tsx's
--     benefitTypeLabel both use) can never match any real row either --
--     the live membership_plan_benefits_type_check only allows
--     'unlimited_group_classes'. Both are pre-existing latent
--     inconsistencies in already-shipped code, discovered during this
--     review, out of scope to fix here (unrelated to GC-1.4A, and fixing
--     either touches booking-time membership validation for lessons
--     broadly, not just this function) but flagged explicitly rather than
--     silently copied into new code.
--
-- Total eligible candidates = eligible packages + eligible unlimited
-- memberships. Exactly one candidate auto-resolves (whichever category it
-- came from); zero or more than one -- including one package AND one
-- membership simultaneously, since no existing precedent in this codebase
-- establishes which one should silently win -- rejects outright, directing
-- to owner/admin/front desk, rather than guessing or exposing a PAYG/
-- free-comped choice to a bare instructor role.
--
-- 'broad' scope callers retain full override capability: any of
-- p_billing_type/p_client_package_id/p_client_membership_id may be
-- supplied directly, subject to the same validation
-- enforce_appointment_attendee_integrity (GC-1.1) already re-checks at the
-- trigger layer beneath this function.
-- ============================================================================
create or replace function public.enroll_class_attendee(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text default null,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_authority text;
  v_studio_id uuid;
  v_source text;
  v_billing_type text;
  v_client_package_id uuid;
  v_client_membership_id uuid;
  v_eligible_package_count int;
  v_eligible_membership_count int;
  v_attendee_id uuid;
begin
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  v_authority := public._gc1_4_class_enrollment_authority(v_studio_id, p_appointment_id);

  if v_authority is null then
    raise exception 'Not authorized to enroll a student into this class.';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  if v_authority = 'broad' then
    v_source := 'staff';
    v_billing_type := coalesce(p_billing_type, 'package_credit');
    v_client_package_id := p_client_package_id;
    v_client_membership_id := p_client_membership_id;
  else
    -- own_instructor: ignore every caller-supplied billing parameter.
    v_source := 'instructor';

    select count(*) into v_eligible_package_count
      from public.client_package_items cpi
      join public.client_packages cp on cp.id = cpi.client_package_id
      where cp.studio_id = v_studio_id
        and cp.client_id = p_client_id
        and cp.active = true
        and cpi.usage_type = 'group_class'::package_usage_type
        and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0);

    select count(distinct cm.id) into v_eligible_membership_count
      from public.client_memberships cm
      join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
      where cm.studio_id = v_studio_id
        and cm.client_id = p_client_id
        and cm.status = 'active'
        and mpb.benefit_type = 'unlimited_group_classes'
        and mpb.quantity is null
        and (
          mpb.applies_to is null
          or mpb.applies_to = ''
          or mpb.applies_to = 'all'
          or mpb.applies_to = 'group_class'
        );

    if (v_eligible_package_count + v_eligible_membership_count) <> 1 then
      raise exception 'This enrollment needs a billing decision -- ask an owner, admin, or front desk to complete it.';
    end if;

    if v_eligible_package_count = 1 then
      select cp.id into v_client_package_id
        from public.client_package_items cpi
        join public.client_packages cp on cp.id = cpi.client_package_id
        where cp.studio_id = v_studio_id
          and cp.client_id = p_client_id
          and cp.active = true
          and cpi.usage_type = 'group_class'::package_usage_type
          and (cpi.is_unlimited = true or coalesce(cpi.quantity_remaining, 0) > 0)
        limit 1;

      v_billing_type := 'package_credit';
      v_client_membership_id := null;
    else
      select distinct cm.id into v_client_membership_id
        from public.client_memberships cm
        join public.membership_plan_benefits mpb on mpb.membership_plan_id = cm.membership_plan_id
        where cm.studio_id = v_studio_id
          and cm.client_id = p_client_id
          and cm.status = 'active'
          and mpb.benefit_type = 'unlimited_group_classes'
          and mpb.quantity is null
          and (
            mpb.applies_to is null
            or mpb.applies_to = ''
            or mpb.applies_to = 'all'
            or mpb.applies_to = 'group_class'
          )
        limit 1;

      v_billing_type := 'membership';
      v_client_package_id := null;
    end if;
  end if;

  begin
    insert into public.appointment_attendees (
      studio_id, appointment_id, client_id, status, source,
      billing_type, client_package_id, client_membership_id, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'booked', v_source,
      v_billing_type, v_client_package_id, v_client_membership_id, auth.uid()
    )
    returning id into v_attendee_id;
  exception when unique_violation then
    raise exception 'This client is already enrolled in this class.';
  end;

  return v_attendee_id;
end;
$$;

revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from public;
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from anon;
grant execute on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) to authenticated;
-- Minimum-necessary posture, corrected during review: only ever invoked
-- via the cookie/session-scoped client (enrollClassAttendeeAction) -- no
-- real code path needs service_role execute.
revoke all on function public.enroll_class_attendee(uuid, uuid, text, uuid, uuid) from service_role;

-- ============================================================================
-- 4. cancel_class_attendee -- soft-cancel one attendee.
--
-- Same relationship-aware authorization as enroll_class_attendee (shared
-- helper, not a second copy). Never a DELETE -- appointment_attendees has
-- no DELETE RLS policy at all, hard deletion is structurally unreachable
-- by design. Re-cancelling an already-cancelled row is a documented no-op.
-- ============================================================================
create or replace function public.cancel_class_attendee(
  p_attendee_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_appointment_id uuid;
  v_authority text;
begin
  select studio_id, appointment_id into v_studio_id, v_appointment_id
    from public.appointment_attendees
    where id = p_attendee_id;

  if v_studio_id is null then
    raise exception 'Enrollment not found.';
  end if;

  v_authority := public._gc1_4_class_enrollment_authority(v_studio_id, v_appointment_id);

  if v_authority is null then
    raise exception 'Not authorized to manage this class''s roster.';
  end if;

  update public.appointment_attendees
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where id = p_attendee_id
    and status <> 'cancelled';
end;
$$;

revoke all on function public.cancel_class_attendee(uuid) from public;
revoke all on function public.cancel_class_attendee(uuid) from anon;
grant execute on function public.cancel_class_attendee(uuid) to authenticated;
-- Minimum-necessary posture, corrected during review: only ever invoked
-- via the cookie/session-scoped client (cancelClassAttendeeAction) -- no
-- real code path needs service_role execute.
revoke all on function public.cancel_class_attendee(uuid) from service_role;

-- ============================================================================
-- 5. cancel_group_class_appointment -- atomic whole-class cancellation.
--
-- Broad staff authority only -- deliberately NOT extended to
-- 'own_instructor' even though enroll/cancel-one-attendee are. Cancelling
-- every currently-booked student's participation in one action is a
-- materially bigger consequence than managing one enrollment at a time, or
-- than the existing lesson-cancellation precedent (which lets an assigned
-- instructor cancel their own single 1:1 lesson -- a blast radius of one
-- person, not a whole roster).
--
-- Captures every currently-booked client_id BEFORE mutating anything, and
-- returns that list -- this is the fix for a real failure mode: GC-1.3B's
-- notification fan-out resolves recipients from currently-booked
-- attendees, so if every attendee were already cancelled by the time
-- notification code ran, it would correctly, but uselessly, find and
-- notify nobody. The caller sends notifications using the returned list,
-- resolved before the transaction committed, applied after it committed.
-- ============================================================================
create or replace function public.cancel_group_class_appointment(
  p_appointment_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_affected_client_ids uuid[];
begin
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio_id) then
    raise exception 'Not authorized to cancel this class.';
  end if;

  select coalesce(array_agg(client_id), array[]::uuid[]) into v_affected_client_ids
    from public.appointment_attendees
    where appointment_id = p_appointment_id
      and status = 'booked';

  update public.appointments
  set status = 'cancelled'::appointment_status, cancelled_at = now()
  where id = p_appointment_id;

  update public.appointment_attendees
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  where appointment_id = p_appointment_id
    and status = 'booked';

  return v_affected_client_ids;
end;
$$;

revoke all on function public.cancel_group_class_appointment(uuid) from public;
revoke all on function public.cancel_group_class_appointment(uuid) from anon;
grant execute on function public.cancel_group_class_appointment(uuid) to authenticated;
-- Minimum-necessary posture, corrected during review: only ever invoked
-- via the cookie/session-scoped client (cancelGroupClassAppointmentAction)
-- -- no real code path needs service_role execute.
revoke all on function public.cancel_group_class_appointment(uuid) from service_role;

-- ============================================================================
-- 6. check_in_own_class_attendance -- student self-check-in.
--
-- Requires a CURRENT status='booked' enrollment -- deliberately narrower
-- than class_enrollment_covers_participation (GC-1.2, unmodified), which
-- correctly still counts a post-start-cancelled enrollment as historically
-- eligible for staff attendance correction. Those are two different
-- questions; self-check-in is a brand-new student-initiated action asking
-- "is this student currently enrolled right now", not "did this legitimately
-- happen historically". GC-1.2's attendance_records_enforce_class_eligibility
-- trigger remains a second, broader DB backstop beneath this function
-- (defense in depth) -- it is not relied on alone for this narrower rule.
--
-- MUST be invoked through a client carrying the caller's own JWT so
-- auth.uid() resolves to the real caller -- never through a service-role/
-- admin client. See src/lib/auth/studentApiAuth.ts's
-- createStudentApiUserScopedClient for the corresponding application-side
-- fix (GC-1.4A implementation report).
-- ============================================================================
create or replace function public.check_in_own_class_attendance(
  p_appointment_id uuid,
  p_client_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_appointment_status text;
  v_record_id uuid;
  v_opens_at timestamptz;
  v_closes_at timestamptz;
begin
  if not exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.client_id = p_client_id
      and cal.status = 'linked'
      and cal.can_view_schedule = true
  ) then
    raise exception 'Not authorized for this client.';
  end if;

  select a.studio_id, a.starts_at, a.ends_at, a.status
    into v_studio_id, v_starts_at, v_ends_at, v_appointment_status
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Class not found.';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  if not exists (
    select 1 from public.appointment_attendees aa
    where aa.appointment_id = p_appointment_id
      and aa.client_id = p_client_id
      and aa.studio_id = v_studio_id
      and aa.status = 'booked'
  ) then
    raise exception 'Not currently enrolled in this class.';
  end if;

  v_opens_at := v_starts_at - interval '30 minutes';
  v_closes_at := coalesce(v_ends_at, v_starts_at) + interval '15 minutes';

  if v_appointment_status not in ('scheduled', 'confirmed', 'rescheduled')
     or now() < v_opens_at
     or now() > v_closes_at
  then
    raise exception 'Check-in is not open for this class right now.';
  end if;

  update public.attendance_records
  set status = 'checked_in', checked_in_at = coalesce(checked_in_at, now()), updated_at = now()
  where appointment_id = p_appointment_id
    and client_id = p_client_id
  returning id into v_record_id;

  if v_record_id is null then
    insert into public.attendance_records (
      studio_id, appointment_id, client_id, status, checked_in_at, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'checked_in', now(), auth.uid()
    );
  end if;
end;
$$;

revoke all on function public.check_in_own_class_attendance(uuid, uuid) from public;
revoke all on function public.check_in_own_class_attendance(uuid, uuid) from anon;
grant execute on function public.check_in_own_class_attendance(uuid, uuid) to authenticated;
-- Deliberately NOT granted to service_role, and explicitly revoked (not
-- merely left ungranted -- Supabase projects commonly carry a schema-level
-- default privilege granting service_role EXECUTE on every new function,
-- so an explicit revoke is required to actually enforce this, not just a
-- missing grant statement). This function's authorization contract
-- depends entirely on auth.uid() resolving to a real end user; a
-- service-role connection has no such identity, and this function must
-- never be reachable that way (the GC-1.4A implementation report fixes the
-- one route that would otherwise have tried). Even without this explicit
-- revoke, a service-role call would still be rejected by the function's
-- own auth.uid()-is-null check -- this is belt-and-suspenders, matching
-- this repo's established explicit-over-implicit convention, not the only
-- line of defense.
revoke all on function public.check_in_own_class_attendance(uuid, uuid) from service_role;

-- ============================================================================
-- 7. enforce_group_class_canonical_shape -- BEFORE INSERT/UPDATE trigger on
--    appointments. Trigger-only, never directly callable, matching the
--    established posture of enforce_appointment_attendee_integrity (GC-1.1).
--
-- Two invariants:
--   a. A group_class row can never carry client_id, partner_client_id,
--      client_package_id, client_membership_id, or price_amount -- the
--      singular-attendee/billing fields that now live exclusively on
--      appointment_attendees. billing_type/payment_status are NOT NULL
--      columns with defaults and are simply ignored for a class, not
--      forced null (would require an unrelated schema change).
--      cancelled_at is legitimately class-level (cancel_group_class_
--      appointment writes it) and is deliberately NOT restricted here.
--   b. appointment_type can never be changed to or from 'group_class' via
--      a plain UPDATE, unconditionally (not merely once attendee rows
--      exist) -- create a new appointment through the canonical creation
--      path instead of mutating an existing row into a structurally
--      different business model.
--
-- This is the DB-level bridge that makes the old-app/new-DB rollout race
-- safe: from the moment this migration lands, no app instance -- old or
-- new -- can insert or update its way into a legacy-shaped group_class row,
-- regardless of what application code attempts. A pre-GC-1.4A app trying
-- to create a group class with a populated client_id fails loudly here
-- rather than silently succeeding with a malformed row. Every non-
-- group_class, non-type-changing write (the overwhelming majority of all
-- appointments writes, including every lesson) returns NEW unmodified and
-- is completely unaffected.
-- ============================================================================
create or replace function public.enforce_group_class_canonical_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.appointment_type = 'group_class'::public.appointment_type then
    if new.client_id is not null
       or new.partner_client_id is not null
       or new.client_package_id is not null
       or new.client_membership_id is not null
       or new.price_amount is not null
    then
      raise exception 'A shared group class cannot carry a singular attendee, package, membership, or price -- use appointment_attendees.';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.appointment_type is distinct from new.appointment_type then
    if old.appointment_type = 'group_class'::public.appointment_type
       or new.appointment_type = 'group_class'::public.appointment_type
    then
      raise exception 'Appointment type cannot be changed to or from group_class -- create a new appointment through the canonical class-creation path instead.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_canonical_shape() from public;
revoke all on function public.enforce_group_class_canonical_shape() from anon;
revoke all on function public.enforce_group_class_canonical_shape() from authenticated;
revoke all on function public.enforce_group_class_canonical_shape() from service_role;
-- No grant execute statement follows: reachable only as a trigger body,
-- matching enforce_appointment_attendee_integrity's established posture.

create trigger appointments_enforce_group_class_shape
  before insert or update on public.appointments
  for each row
  execute function public.enforce_group_class_canonical_shape();

-- ============================================================================
-- 8. Roster-aware QR check-in lookups -- create or replace, same signatures
--    and return shapes as the existing FC-1B5D2 D2C-0B functions (no
--    contract change for any existing caller). Adds a second match branch
--    against appointment_attendees (booked-only -- a QR check-in is about a
--    currently enrolled student, same reasoning as GC-1.3B's notification
--    fan-out) alongside the existing appointments.client_id match. A
--    roster-shape class's enrolled students now correctly surface in the
--    staff QR scan flow; a scanned client only ever sees classes THEY are
--    booked into, never a classmate's or another studio's.
-- ============================================================================
create or replace function public.get_client_appointments_for_checkin(
  target_studio_id uuid,
  qr_token text,
  range_start timestamptz,
  range_end timestamptz
)
returns table (
  id uuid,
  title text,
  appointment_type text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  instructor_first_name text,
  instructor_last_name text,
  room_name text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.title,
    a.appointment_type,
    a.status,
    a.starts_at,
    a.ends_at,
    i.first_name as instructor_first_name,
    i.last_name as instructor_last_name,
    r.name as room_name
  from public.appointments a
  left join public.instructors i on i.id = a.instructor_id
  left join public.rooms r on r.id = a.room_id
  where a.studio_id = target_studio_id
    and a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
    and a.starts_at >= range_start
    and a.starts_at < range_end

  union

  select
    a.id,
    a.title,
    a.appointment_type,
    a.status,
    a.starts_at,
    a.ends_at,
    i.first_name as instructor_first_name,
    i.last_name as instructor_last_name,
    r.name as room_name
  from public.appointments a
  join public.appointment_attendees aa
    on aa.appointment_id = a.id
    and aa.studio_id = target_studio_id
  left join public.instructors i on i.id = a.instructor_id
  left join public.rooms r on r.id = a.room_id
  where a.studio_id = target_studio_id
    and a.appointment_type = 'group_class'::public.appointment_type
    and aa.status = 'booked'
    and aa.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
    and a.starts_at >= range_start
    and a.starts_at < range_end

  order by starts_at asc;
$$;

revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to service_role;

create or replace function public.get_client_appointment_for_checkin_validation(
  target_studio_id uuid,
  qr_token text,
  target_appointment_id uuid
)
returns table (
  id uuid,
  appointment_type text,
  status text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.appointment_type,
    a.status
  from public.appointments a
  where a.id = target_appointment_id
    and a.studio_id = target_studio_id
    and (
      a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
      or (
        a.appointment_type = 'group_class'::public.appointment_type
        and exists (
          select 1
          from public.appointment_attendees aa
          where aa.appointment_id = a.id
            and aa.studio_id = target_studio_id
            and aa.status = 'booked'
            and aa.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
        )
      )
    );
$$;

revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from public;
revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from anon;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to authenticated;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to service_role;

commit;
