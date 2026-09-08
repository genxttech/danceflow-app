-- FC-1B5D2c-0B: Attendance & Group Recap RLS Tightening.
--
-- FC-1B5D2c-0A (merged) closed the app-layer gap on
-- src/app/app/schedule/[id]/attendance/actions.ts and recap-actions.ts:
-- attendance mutations and group-recap authoring now require a real
-- relationship to the appointment (broad operational role, or the
-- caller's own assigned-instructor relationship), not merely "any active
-- studio_roles row." This migration closes the matching DATABASE-layer
-- gap the FC-1B5D2c preflight identified: attendance_records,
-- group_lesson_recaps, group_lesson_recap_recipients, and
-- group_lesson_recap_syllabus_steps all currently grant ANY active studio
-- member (any role, including an unassigned instructor or an independent
-- instructor whose only relationship is floor-rental/portal) full
-- read/write access, entirely independent of whatever the app layer now
-- enforces -- a direct query against these tables bypasses the D2c-0A
-- fix completely.
--
-- ============================================================================
-- DISCOVERY (materially expands this migration's design, does not expand
-- its scope): all four tables are NOT exclusive to schedule/group-class
-- appointments. Every one of them also backs the unrelated ticketed-EVENTS
-- check-in/recap feature (src/app/app/events/[id]/registrations/actions.ts,
-- src/app/app/events/[id]/check-in/recap-actions.ts) via a second, mutually
-- exclusive set of nullable columns (event_id / event_session_id /
-- event_registration_id / event_registration_attendee_id) alongside
-- appointment_id. Confirmed by direct code trace and live DEV data (the 3
-- existing attendance_records rows in DEV are ALL event-linked,
-- appointment_id null, zero schedule-linked rows exist yet). The events
-- feature's own authorization model is a DIFFERENT role set entirely
-- (canManageEventTickets: platform_admin/studio_owner/studio_admin/
-- organizer_owner/organizer_admin -- no front_desk, no instructor) and, for
-- group-recap authoring specifically, currently has NO role gate at all
-- app-side (requireEventSessionAccess only checks event/session existence,
-- confirmed by direct read of that file) -- i.e. it relies entirely on
-- today's role-blind DB policies, unlike the FC-1B5D2c-0A-hardened schedule
-- surface.
--
-- Tightening these tables' RLS naively (relationship-only) would silently
-- break the events feature for every persona it currently and legitimately
-- serves (no live app-code path exists to fix that in this slice, and doing
-- so is out of scope -- D2c-0B is scoped to the four tables' RLS only, per
-- the objective). This migration therefore partitions every policy by
-- `appointment_id IS NOT NULL` (schedule-appointment-linked rows: NEW,
-- tightened, matches merged D2c-0A behavior) vs `appointment_id IS NULL`
-- (event-linked rows: OLD role-blind "any active studio member" behavior
-- PRESERVED EXACTLY, byte-for-byte equivalent access, zero regression). No
-- app code changes were required or made to achieve this -- the partition
-- lives entirely in the RLS policy bodies below. Broad operational roles
-- (platform_admin/studio_owner/studio_admin, plus front_desk for
-- attendance) retain full access to BOTH row kinds, matching their existing
-- broad authority elsewhere and today's status quo for events.
-- ============================================================================
--
-- Entire migration runs in one explicit transaction -- there must never be
-- a moment where a table has neither the old broad policies nor the new
-- tightened ones.
--
-- SECURITY LIMITATION / FOLLOW-UP -- D2c-0D Group Class Roster Data Model
-- Repair: attendance_records.client_id is NOT cross-validated against any
-- roster/registration relationship for the target appointment, at either
-- the app layer (confirmed in the FC-1B5D2c preflight and the D2c-0A
-- review) or here. The reason is structural, not an oversight: the
-- `appointment_attendees` table the app's roster UI already queries for
-- this purpose does not exist in DEV or PROD (confirmed via
-- information_schema.tables in the FC-1B5D2c preflight). Inventing a fake
-- membership relationship against a nonexistent table would be worse than
-- the current gap, not a fix. This migration narrows WHO can reach an
-- attendance_records write (from "any active studio member" to "broad role
-- or the appointment's assigned instructor, for schedule-linked rows"),
-- which is a large reduction in blast radius, but a caller who does pass
-- that gate can still write an attendance_records row for an arbitrary
-- client_id within their own studio for the appointment they are
-- authorized on. Closing that fully requires the roster data model repair
-- itself, tracked separately.
--
-- Preserved untouched by this migration (no DDL against them):
--   - "Linked students can read published group lesson recaps"
--     (group_lesson_recaps, portal/self SELECT)
--   - "Linked students can read own group lesson recap recipients"
--     (group_lesson_recap_recipients, portal/self SELECT)
-- Traced first (FC-1B5D2c-0B step 7): both read via a normal authenticated
-- client (not the admin/service-role client), so both remain fully subject
-- to RLS and both are left byte-for-byte unmodified. A third portal path
-- (src/app/portal/[studioSlug]/journey/actions.ts, the Lumi journey page)
-- reads group_lesson_recap_recipients/group_lesson_recaps via
-- createAdminClient() (service role), which bypasses RLS entirely and is
-- therefore unaffected by anything in this migration regardless.
-- group_lesson_recap_syllabus_steps has no portal read path at all
-- (confirmed: zero references anywhere under src/app/portal) -- no
-- portal/self branch is added for it.
--
-- CORRECTED (post-independent-review, pre-commit hardening pass): two gaps
-- found by direct empirical testing against DEV, in the same spirit as the
-- D2C appointments migration's own corrections:
--
-- 1. group_lesson_recap_is_event_linked originally performed no internal
--    auth.uid() check at all -- since it is SECURITY DEFINER and granted to
--    authenticated, it was directly callable via RPC by ANY authenticated
--    user (no studio membership required) for ANY studio/recap id pair,
--    revealing a binary event-linked classification. Structurally the same
--    anti-pattern as the original _appointment_current_type_is_group_class
--    (see the D2C appointments migration's own commentary) -- this
--    codebase has already treated that shape of gap as blocking once
--    before. Fixed by requiring the caller to independently hold a real
--    active user_studio_roles row at target_studio_id before the function
--    will reveal anything -- an unrelated caller now gets false regardless
--    of whether the target recap exists, is event-linked, or belongs to a
--    studio they have no relationship to. No platform_admin bypass is
--    added inside the helper: platform_admin's actual access through every
--    policy that calls this helper is already granted by that policy's own
--    separate, earlier profiles.platform_role branch, independent of this
--    helper's result -- adding one here would broaden nothing real while
--    needlessly widening the helper's own reach.
--
-- 2. Confirmed, live-reproduced bypass: an assigned instructor could UPDATE
--    their own schedule-linked row (attendance_records, group_lesson_recaps,
--    or group_lesson_recap_recipients -- any of the three tables that store
--    appointment_id directly) to set appointment_id = NULL, which moved
--    that row into the "event-preserved, any active studio member" WITH
--    CHECK branch (the own-instructor branch's WITH CHECK naturally
--    excludes appointment_id IS NULL, but the event-preserved branch's
--    WITH CHECK, prior to this correction, only checked the NEW row's
--    appointment_id -- never whether the row was genuinely event-linked
--    BEFORE this update). After the null-out, an unrelated instructor at
--    the same studio -- zero relationship to the class -- could read (and,
--    by the same branch structure, write) it. Retargeting appointment_id
--    to a DIFFERENT, colleague-owned appointment was already correctly
--    blocked (neither branch can pass for that NEW value); only the
--    null-out direction was open.
--
--    Fixed using the same pre-image-read pattern already established for
--    appointments' own type-flip guard (can_preserve_existing_group_class_
--    for_instructor): a direct self-referencing subquery inside an UPDATE
--    policy's own WITH CHECK is rejected by Postgres as infinite policy
--    recursion (42P17), so the pre-image check is wrapped in a separate
--    SECURITY DEFINER function call instead, which Postgres evaluates
--    against the statement's snapshot (the OLD/pre-update row state), not
--    the row being written. The three tables' UPDATE policies' event-
--    preserved WITH CHECK branch now additionally requires that the target
--    row, as it stood BEFORE this update, was already appointment_id IS
--    NULL -- a genuinely event-linked row continuing to be updated by an
--    event-side actor still passes (its pre-image was already null); a
--    schedule-linked row being converted now fails WITH CHECK entirely
--    (42501), exactly like the already-blocked retarget-to-a-colleague
--    case. INSERT's WITH CHECK is deliberately untouched -- a brand-new
--    row has no pre-image to check against, and the events feature's own
--    row-creation flow (event_id/event_session_id set, appointment_id
--    always null from the moment of creation) must remain unaffected.
--    group_lesson_recaps reuses the now-fixed group_lesson_recap_is_event_
--    linked helper directly for its own pre-image check (its "recap id" is
--    its own id column); attendance_records and group_lesson_recap_
--    recipients each get one small, dedicated, identically-shaped helper,
--    since neither table has a reason to reference the other for this
--    purpose. group_lesson_recap_syllabus_steps was not affected by this
--    bypass class in the first place (its FK to group_lesson_recap_id is
--    NOT NULL -- there is no column on that table it could be nulled to)
--    and needs no equivalent guard.
--
--    Both new dedicated helpers follow the identical safety shape as the
--    corrected group_lesson_recap_is_event_linked: SECURITY DEFINER,
--    STABLE, search_path=public, minimal grants (authenticated/
--    service_role only), and an internal active-role gate so neither
--    becomes a new direct-RPC oracle of its own.

begin;

-- ============================================================================
-- 0. New helpers. Each is the smallest possible boolean, self-contained on
--    auth.uid(), SECURITY DEFINER (so it does not depend on -- or get
--    entangled with -- the RLS of whatever table it looks through, matching
--    this codebase's established convention: is_own_instructor_appointment,
--    user_has_client_portal_access, and can_preserve_existing_group_class_
--    for_instructor are all SECURITY DEFINER for exactly this reason), and
--    reveals nothing beyond a yes/no answer about the caller's OWN
--    relationship to the one specific row they already supplied an id for
--    -- never a generic "resolve/see arbitrary appointment or recap" oracle.
-- ============================================================================

-- 0a. is_own_instructor_for_appointment -- resolves ownership for any of
-- the three tables that store appointment_id directly (attendance_records,
-- group_lesson_recaps, group_lesson_recap_recipients). Delegates the actual
-- ownership predicate to the existing, already-reviewed
-- is_own_instructor_appointment helper (reused exactly as the task
-- requires, not reimplemented) once the appointment's instructor_id is
-- resolved.
create or replace function public.is_own_instructor_for_appointment(
  target_studio_id uuid,
  target_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.appointments a
    where a.id = target_appointment_id
      and a.studio_id = target_studio_id
      and a.instructor_id is not null
      and public.is_own_instructor_appointment(a.studio_id, a.instructor_id)
  );
$$;

revoke all on function public.is_own_instructor_for_appointment(uuid, uuid) from public;
revoke all on function public.is_own_instructor_for_appointment(uuid, uuid) from anon;
grant execute on function public.is_own_instructor_for_appointment(uuid, uuid) to authenticated;
grant execute on function public.is_own_instructor_for_appointment(uuid, uuid) to service_role;

-- 0b. is_own_instructor_for_group_recap -- group_lesson_recap_syllabus_steps
-- has no appointment_id (or event_id) column of its own, only
-- group_lesson_recap_id -- this resolves ownership one hop through the
-- parent group_lesson_recaps row's appointment_id, reusing 0a rather than
-- duplicating its logic.
create or replace function public.is_own_instructor_for_group_recap(
  target_studio_id uuid,
  target_recap_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.group_lesson_recaps r
    where r.id = target_recap_id
      and r.studio_id = target_studio_id
      and r.appointment_id is not null
      and public.is_own_instructor_for_appointment(r.studio_id, r.appointment_id)
  );
$$;

revoke all on function public.is_own_instructor_for_group_recap(uuid, uuid) from public;
revoke all on function public.is_own_instructor_for_group_recap(uuid, uuid) from anon;
grant execute on function public.is_own_instructor_for_group_recap(uuid, uuid) to authenticated;
grant execute on function public.is_own_instructor_for_group_recap(uuid, uuid) to service_role;

-- 0c. group_lesson_recap_is_event_linked -- a binary classification (does
-- this recap belong to an event session rather than a schedule appointment)
-- used two ways below: (a) so group_lesson_recap_syllabus_steps' legacy
-- "any active studio member" branch can be scoped to event-linked rows
-- only, and (b) as group_lesson_recaps' own UPDATE pre-image guard (see the
-- CORRECTED header note above). Reveals nothing about WHICH appointment/
-- event, WHO teaches it, or any other row -- only whether the one specific
-- recap id supplied is event-linked or not, and ONLY to a caller who
-- independently holds a real active user_studio_roles row at
-- target_studio_id -- an unrelated caller gets false unconditionally,
-- indistinguishable from "this recap is schedule-linked", "this recap
-- doesn't exist", or "this studio doesn't exist". Without that internal
-- gate this function -- SECURITY DEFINER, granted to authenticated -- would
-- be directly callable via RPC by any authenticated user for any studio/
-- recap pair regardless of relationship, exactly the
-- _appointment_current_type_is_group_class anti-pattern this codebase has
-- already eliminated once (see the D2C appointments migration). No
-- platform_admin bypass is added here: every policy that calls this helper
-- already grants platform_admin access through its own separate, earlier
-- branch, independent of this helper's result.
create or replace function public.group_lesson_recap_is_event_linked(
  target_studio_id uuid,
  target_recap_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.group_lesson_recaps r
    where r.id = target_recap_id
      and r.studio_id = target_studio_id
      and r.appointment_id is null
  )
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
  );
$$;

revoke all on function public.group_lesson_recap_is_event_linked(uuid, uuid) from public;
revoke all on function public.group_lesson_recap_is_event_linked(uuid, uuid) from anon;
grant execute on function public.group_lesson_recap_is_event_linked(uuid, uuid) to authenticated;
grant execute on function public.group_lesson_recap_is_event_linked(uuid, uuid) to service_role;

-- 0d. attendance_record_is_event_linked -- the same pre-image-guard shape
-- as 0c above, dedicated to attendance_records (which has no reason to
-- reference group_lesson_recaps or vice versa). Used exclusively as the
-- UPDATE pre-image guard on attendance_records_update below: a row that
-- was already event-linked (appointment_id IS NULL) before this statement
-- continues to be reachable via the legacy any-active-role branch; a
-- schedule-linked row cannot be converted into one by nulling
-- appointment_id mid-UPDATE. Same active-role gate as 0c, for the same
-- reason -- otherwise this would itself become a new direct-RPC oracle
-- while fixing the other one.
create or replace function public.attendance_record_is_event_linked(
  target_studio_id uuid,
  target_attendance_record_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.attendance_records ar
    where ar.id = target_attendance_record_id
      and ar.studio_id = target_studio_id
      and ar.appointment_id is null
  )
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
  );
$$;

revoke all on function public.attendance_record_is_event_linked(uuid, uuid) from public;
revoke all on function public.attendance_record_is_event_linked(uuid, uuid) from anon;
grant execute on function public.attendance_record_is_event_linked(uuid, uuid) to authenticated;
grant execute on function public.attendance_record_is_event_linked(uuid, uuid) to service_role;

-- 0e. group_lesson_recap_recipient_is_event_linked -- same shape again,
-- dedicated to group_lesson_recap_recipients, used exclusively as the
-- UPDATE pre-image guard on group_lesson_recap_recipients_update below.
create or replace function public.group_lesson_recap_recipient_is_event_linked(
  target_studio_id uuid,
  target_recipient_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.group_lesson_recap_recipients gr
    where gr.id = target_recipient_id
      and gr.studio_id = target_studio_id
      and gr.appointment_id is null
  )
  and exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
  );
$$;

revoke all on function public.group_lesson_recap_recipient_is_event_linked(uuid, uuid) from public;
revoke all on function public.group_lesson_recap_recipient_is_event_linked(uuid, uuid) from anon;
grant execute on function public.group_lesson_recap_recipient_is_event_linked(uuid, uuid) to authenticated;
grant execute on function public.group_lesson_recap_recipient_is_event_linked(uuid, uuid) to service_role;

-- ============================================================================
-- 1. attendance_records
--
-- Allow (schedule-linked rows, appointment_id is not null): platform_admin,
-- studio_owner, studio_admin, front_desk, assigned instructor.
-- Deny (schedule-linked rows): unassigned instructor, independent
-- instructor/floor-rental-only, unrelated studio user.
-- Preserved unchanged (event-linked rows, appointment_id is null): any
-- active studio member -- identical to today, zero behavior change.
-- No portal/self SELECT existed for this table (confirmed: zero references
-- under src/app/portal) -- none added.
-- ============================================================================

drop policy if exists "attendance_records_staff_select" on public.attendance_records;
drop policy if exists "attendance_records_staff_insert" on public.attendance_records;
drop policy if exists "attendance_records_staff_update" on public.attendance_records;
drop policy if exists "attendance_records_staff_delete" on public.attendance_records;

create policy "attendance_records_select" on public.attendance_records
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = attendance_records.studio_id
        and usr.active = true
    )
  )
);

create policy "attendance_records_insert" on public.attendance_records
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = attendance_records.studio_id
        and usr.active = true
    )
  )
);

create policy "attendance_records_update" on public.attendance_records
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = attendance_records.studio_id
        and usr.active = true
    )
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    -- Pre-image guard (CORRECTED): the NEW row's appointment_id being null
    -- is not enough on its own -- the row, as it stood BEFORE this UPDATE,
    -- must have already been event-linked. Blocks a schedule-linked row
    -- from being converted into the legacy any-active-role bucket by
    -- nulling its own appointment_id; a genuinely event-linked row being
    -- updated by an event-side actor is unaffected (its pre-image was
    -- already null).
    appointment_id is null
    and public.attendance_record_is_event_linked(studio_id, id)
  )
);

create policy "attendance_records_delete" on public.attendance_records
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = attendance_records.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = attendance_records.studio_id
        and usr.active = true
    )
  )
);

-- ============================================================================
-- 2. group_lesson_recaps
--
-- SELECT allow (schedule-linked): platform_admin, studio_owner,
-- studio_admin, front_desk (read-only), assigned instructor.
-- WRITE allow (schedule-linked): platform_admin, studio_owner,
-- studio_admin, assigned instructor -- front_desk explicitly excluded,
-- matching the merged D2c-0A app-layer narrowing exactly.
-- Preserved unchanged (event-linked): any active studio member, both
-- SELECT and write -- identical to today.
-- Portal policy "Linked students can read published group lesson recaps"
-- left untouched.
-- ============================================================================

drop policy if exists "Studio staff can manage group lesson recaps" on public.group_lesson_recaps;

create policy "group_lesson_recaps_select" on public.group_lesson_recaps
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recaps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recaps.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recaps_insert" on public.group_lesson_recaps
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recaps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recaps.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recaps_update" on public.group_lesson_recaps
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recaps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recaps.studio_id
        and usr.active = true
    )
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recaps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    -- Pre-image guard (CORRECTED): see attendance_records_update's WITH
    -- CHECK for the full rationale. Reuses group_lesson_recap_is_event_
    -- linked directly (this table's own "recap id" is its own id column)
    -- rather than a dedicated helper.
    appointment_id is null
    and public.group_lesson_recap_is_event_linked(studio_id, id)
  )
);

create policy "group_lesson_recaps_delete" on public.group_lesson_recaps
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recaps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recaps.studio_id
        and usr.active = true
    )
  )
);

-- ============================================================================
-- 3. group_lesson_recap_recipients
--
-- Same shape as group_lesson_recaps (this table also stores appointment_id
-- directly). PII on this table (guest_email, guest_name) is exactly why
-- front_desk is read-only here too, and why there is no broad
-- "any studio member" SELECT for schedule-linked rows.
-- Portal policy "Linked students can read own group lesson recap
-- recipients" left untouched.
-- ============================================================================

drop policy if exists "Studio staff can manage group lesson recap recipients" on public.group_lesson_recap_recipients;

create policy "group_lesson_recap_recipients_select" on public.group_lesson_recap_recipients
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recap_recipients_insert" on public.group_lesson_recap_recipients
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recap_recipients_update" on public.group_lesson_recap_recipients
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.active = true
    )
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    -- Pre-image guard (CORRECTED): see attendance_records_update's WITH
    -- CHECK for the full rationale.
    appointment_id is null
    and public.group_lesson_recap_recipient_is_event_linked(studio_id, id)
  )
);

create policy "group_lesson_recap_recipients_delete" on public.group_lesson_recap_recipients
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_recipients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or (
    appointment_id is not null
    and public.is_own_instructor_for_appointment(studio_id, appointment_id)
  )
  or (
    appointment_id is null
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.active = true
    )
  )
);

-- ============================================================================
-- 4. group_lesson_recap_syllabus_steps
--
-- Removes the erroneous independent_instructor entry from the old FOR ALL
-- role list for schedule-linked rows (NO_FUNCTIONAL_CHANGE -- matches the
-- codebase's own already-stated design intent that independent instructors
-- are never host-studio staff, per the FC-1B5D2c preflight's finding).
-- No direct appointment_id column -- ownership and event-linkage are both
-- resolved one hop through group_lesson_recap_id via the two dedicated
-- helpers above (0b, 0c), never a raw subquery against group_lesson_recaps
-- (which would entangle this table's policy behavior with that table's own
-- RLS for the querying role).
-- No portal/self SELECT branch: confirmed zero portal code references this
-- table at all.
-- ============================================================================

drop policy if exists "Studio members can manage group recap syllabus steps" on public.group_lesson_recap_syllabus_steps;
drop policy if exists "Studio members can view group recap syllabus steps" on public.group_lesson_recap_syllabus_steps;

create policy "group_lesson_recap_syllabus_steps_select" on public.group_lesson_recap_syllabus_steps
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or public.is_own_instructor_for_group_recap(studio_id, group_lesson_recap_id)
  or (
    public.group_lesson_recap_is_event_linked(studio_id, group_lesson_recap_id)
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recap_syllabus_steps_insert" on public.group_lesson_recap_syllabus_steps
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or public.is_own_instructor_for_group_recap(studio_id, group_lesson_recap_id)
  or (
    public.group_lesson_recap_is_event_linked(studio_id, group_lesson_recap_id)
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recap_syllabus_steps_update" on public.group_lesson_recap_syllabus_steps
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or public.is_own_instructor_for_group_recap(studio_id, group_lesson_recap_id)
  or (
    public.group_lesson_recap_is_event_linked(studio_id, group_lesson_recap_id)
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
        and usr.active = true
    )
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or public.is_own_instructor_for_group_recap(studio_id, group_lesson_recap_id)
  or (
    public.group_lesson_recap_is_event_linked(studio_id, group_lesson_recap_id)
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
        and usr.active = true
    )
  )
);

create policy "group_lesson_recap_syllabus_steps_delete" on public.group_lesson_recap_syllabus_steps
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
  or public.is_own_instructor_for_group_recap(studio_id, group_lesson_recap_id)
  or (
    public.group_lesson_recap_is_event_linked(studio_id, group_lesson_recap_id)
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = group_lesson_recap_syllabus_steps.studio_id
        and usr.active = true
    )
  )
);

commit;
