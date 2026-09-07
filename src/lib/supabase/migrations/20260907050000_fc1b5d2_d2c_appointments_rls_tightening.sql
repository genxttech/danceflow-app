-- FC-1B5D2 D2C: Appointment RLS Tightening.
--
-- Prerequisites D2C-0A (occupancy/conflict admin-client reads) and D2C-0B
-- (QR check-in token-bound RPCs) are merged and verified in production.
-- This migration closes the gap those prerequisites made safe to close:
-- `appointments` RLS today grants any active studio member (including an
-- ordinary instructor) broad, role-blind SELECT/INSERT/UPDATE visibility
-- via `studio members can view appointments` and `studio staff manage
-- appointments` (a FOR ALL policy whose broad role list -- including
-- `instructor` -- silently defeats the narrower `appointments_delete`
-- policy's own exclusion of instructor, since permissive RLS policies are
-- OR'd together per command). This migration removes that role-blind
-- surface and replaces it with relationship-scoped enforcement that
-- matches the already-merged FC-1B5D2 D2A application authorization model.
--
-- Entire migration runs in one explicit transaction -- the security-
-- coupled policy changes (dropping the broad policies and creating the
-- tightened replacements) must be atomic: there must never be a moment
-- where `appointments` has neither the old broad policies nor the new
-- tightened ones.
--
-- Preserved untouched by this migration (no DDL against them):
--   - "portal instructors can create own floor rentals" (INSERT)
--   - "portal instructors can update own floor rentals" (UPDATE)
--   - "portal instructors can view own floor rentals" (SELECT)
--   - "portal users can view own appointments" (SELECT) -- the surviving
--     one of two byte-identical duplicate policies; see below.
--
-- Also dropped by this migration: "portal users can view their own
-- appointments", a second policy with a USING body byte-identical to
-- "portal users can view own appointments" -- pure dead-weight
-- duplication, not a distinct capability. Removing it changes nothing
-- observable (the surviving policy already grants the exact same access).

begin;

-- ============================================================================
-- 0. is_own_instructor_appointment -- the single relationship predicate
--    every instructor-scoped branch below reuses, so the hardened logic
--    exists in exactly one place. Mirrors the app-layer identity lookup
--    already established in src/lib/auth/instructorIdentity.ts
--    (resolveViewerInstructorId), which resolves "my own instructors.id at
--    this studio" via instructors.user_id = auth.uid() -- the same column
--    this helper uses, so DB-layer and app-layer ownership determinations
--    can never silently diverge.
-- ============================================================================
create or replace function public.is_own_instructor_appointment(
  target_studio_id uuid,
  target_instructor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.instructors i
    where i.user_id = auth.uid()
      and i.studio_id = target_studio_id
      and i.id = target_instructor_id
      and i.active = true
  );
$$;

-- Supabase's default per-role grants include an explicit EXECUTE entry for
-- `anon`, not merely an inherited PUBLIC grant -- revoking from PUBLIC
-- alone does not remove it (matches the established convention used by
-- every other SECURITY DEFINER helper in this codebase, e.g.
-- 20260831090000_user_has_client_portal_access_helper.sql). No role-string
-- branching inside this function -- it answers exactly one question
-- ("does auth.uid() have an active instructors row for this exact
-- studio+instructor pair"), never "what role does this user have".
revoke all on function public.is_own_instructor_appointment(uuid, uuid) from public;
revoke all on function public.is_own_instructor_appointment(uuid, uuid) from anon;
grant execute on function public.is_own_instructor_appointment(uuid, uuid) to authenticated;
grant execute on function public.is_own_instructor_appointment(uuid, uuid) to service_role;

-- ============================================================================
-- 0b. can_preserve_existing_group_class_for_instructor -- relationship-
--     gated pre-image reader for the UPDATE type-flip guard below.
--
-- A direct self-referencing subquery against `public.appointments` inside
-- that same table's own UPDATE ... WITH CHECK clause is rejected by
-- Postgres with "infinite recursion detected in policy for relation
-- appointments" (42P17) -- referencing the table being written from within
-- its own row-security qual tree is not supported, even for a read-only
-- SELECT subquery. Wrapping the pre-image read in a SECURITY DEFINER
-- function is the standard, documented workaround: a function call is a
-- distinct, separately-planned sub-execution, so it does not fold into the
-- enclosing UPDATE's row-security qual tree the way an inlined subquery
-- does, and the recursion guard does not trigger.
--
-- CORRECTED (post-independent-review): an earlier version of this helper,
-- `_appointment_current_type_is_group_class(target_appointment_id uuid)`,
-- answered a generic question ("is THIS arbitrary known appointment id
-- currently group_class") for any `authenticated` caller regardless of
-- whether they had any relationship to that row -- a real, if narrow,
-- cross-RLS information-disclosure oracle (an authenticated user who had
-- observed an appointment id through some other channel -- a shared URL,
-- browser history, a studio they had since left -- could learn its type
-- without any appointments_select visibility into it). That version was
-- never committed; this migration replaces it in place.
--
-- This helper instead requires the caller to prove the SAME ownership
-- relationship the WITH CHECK policy branch already requires before it
-- will reveal anything: it takes the appointment id together with the
-- studio+instructor pair the caller claims as their own, verifies
-- auth.uid() genuinely owns an ACTIVE instructors row for that exact pair,
-- verifies the CURRENT stored appointment row both exists and is actually
-- assigned to that same studio+instructor relationship, and only then
-- checks whether its stored appointment_type is 'group_class'. Any caller
-- who does not own the supplied relationship -- or supplies a real
-- appointment id that is not assigned to that relationship -- receives
-- exactly the same `false` result a genuine "this row is a private lesson,
-- not group_class" answer would produce: the two cases are
-- indistinguishable from the caller's side, which is what closes the
-- oracle. A caller can never learn anything about an appointment they do
-- not already have full ownership-based visibility into via
-- appointments_select's own-teaching branch.
create or replace function public.can_preserve_existing_group_class_for_instructor(
  target_appointment_id uuid,
  target_studio_id uuid,
  target_instructor_id uuid
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
    join public.instructors i
      on i.id = target_instructor_id
     and i.studio_id = target_studio_id
     and i.user_id = auth.uid()
     and i.active = true
    where a.id = target_appointment_id
      and a.studio_id = target_studio_id
      and a.instructor_id = target_instructor_id
      and a.appointment_type = 'group_class'::appointment_type
  );
$$;

revoke all on function public.can_preserve_existing_group_class_for_instructor(uuid, uuid, uuid) from public;
revoke all on function public.can_preserve_existing_group_class_for_instructor(uuid, uuid, uuid) from anon;
grant execute on function public.can_preserve_existing_group_class_for_instructor(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_preserve_existing_group_class_for_instructor(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 1. Drop the broad/overlapping policies being replaced.
-- ============================================================================
drop policy if exists "appointments_select" on public.appointments;
drop policy if exists "appointments_insert" on public.appointments;
drop policy if exists "appointments_update" on public.appointments;
drop policy if exists "appointments_delete" on public.appointments;
drop policy if exists "studio members can view appointments" on public.appointments;
drop policy if exists "studio staff manage appointments" on public.appointments;
drop policy if exists "portal users can view their own appointments" on public.appointments;

-- ============================================================================
-- 2. appointments_select
--
-- Five OR-branches. Branch 5 (group_class) is the only one that is not a
-- direct mirror of the already-merged D2A application authorization model
-- -- it is temporary legacy compatibility for the un-hardened attendance/
-- recap surfaces (src/app/app/schedule/[id]/attendance/actions.ts,
-- recap-actions.ts), which today grant any active studio role read access
-- to any group_class appointment and have no UPDATE/INSERT/DELETE path on
-- `appointments` at all (confirmed by direct code trace during the FC-1B5D2
-- D2C reconciliation review) -- so this branch is SELECT-only and narrowed
-- to exactly the one appointment_type that surface needs, reproducing
-- today's effective breadth for that type, never exceeding it.
-- ============================================================================
create policy "appointments_select" on public.appointments
for select
to authenticated
using (
  -- 1. platform admin: broad, studio-role-independent.
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  -- 2. broad operational roles at this studio.
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  -- 3. own teaching relationship.
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
  )
  -- 4. own floor rental (independent instructor, staff-side /app surface).
  or (
    appointment_type = 'floor_space_rental'::appointment_type
    and client_id is not null
    and public.user_has_client_portal_access(studio_id, client_id)
  )
  -- 5. TEMPORARY LEGACY COMPATIBILITY -- remove/review in FC-1B5D2c.
  -- Any active studio member may SELECT a group_class row regardless of
  -- teaching assignment, matching the un-hardened attendance/recap
  -- surfaces' current effective (role-blind) visibility for this one
  -- appointment_type only. SELECT-only: no equivalent branch exists on
  -- INSERT, UPDATE, or DELETE below.
  or (
    appointment_type = 'group_class'::appointment_type
    and exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = appointments.studio_id
        and usr.active = true
    )
  )
);

-- ============================================================================
-- 3. appointments_insert
--
-- No group-class exception -- proven unnecessary: every appointment
-- (including group_class) is created today through the same main
-- createAppointmentAction, already D2A-hardened to self-lock an ordinary
-- instructor's own NEW.instructor_id; the un-hardened attendance/recap
-- surfaces never insert `appointments` rows. The independent-instructor
-- floor-rental INSERT path is untouched -- it is served entirely by the
-- separate "portal instructors can create own floor rentals" policy,
-- preserved unmodified.
-- ============================================================================
create policy "appointments_insert" on public.appointments
for insert
to authenticated
with check (
  -- 1. platform admin.
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  -- 2. broad operational roles at this studio.
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  -- 3. ordinary instructor, self-locked: the new row's instructor_id must
  -- resolve to the caller's own active instructors row at this exact
  -- studio -- an instructor cannot insert an appointment assigned to a
  -- colleague, and cannot insert one at a studio they have no instructors
  -- row at, regardless of what studio_id they submit.
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
  )
);

-- ============================================================================
-- 4. appointments_update
--
-- USING (evaluated against the existing/OLD row -- "can this row even be
-- targeted") has no group-class branch: ownership, not appointment type,
-- governs UPDATE eligibility, and the un-hardened attendance/recap
-- surfaces never call .update() on `appointments` at all.
--
-- WITH CHECK (evaluated against the proposed/NEW row) carries one addition
-- beyond a direct mirror of USING: a type-flip guard on the own-teaching
-- branch, implemented via the can_preserve_existing_group_class_for_
-- instructor helper above (a direct self-referencing subquery here is
-- rejected by Postgres as infinite policy recursion -- see that helper's
-- comment). Without this guard, an ordinary
-- instructor could relabel their own non-group-class appointment as
-- 'group_class' purely to trigger appointments_select's temporary
-- compatibility branch and thereby expose that specific row (title,
-- time, instructor) to every active studio member who would not otherwise
-- see it -- a visibility escalation of THAT row, not a self-escalation,
-- but still not something ownership of the row should be able to grant.
-- The floor-rental WITH CHECK branch needs no equivalent guard: it already
-- requires NEW.appointment_type = 'floor_space_rental', which is mutually
-- exclusive with NEW.appointment_type = 'group_class' by construction, so
-- a flip through that branch is structurally impossible, not merely
-- blocked by an added check.
-- ============================================================================
create policy "appointments_update" on public.appointments
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
  )
  or (
    appointment_type = 'floor_space_rental'::appointment_type
    and client_id is not null
    and public.user_has_client_portal_access(studio_id, client_id)
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
  or (
    instructor_id is not null
    and public.is_own_instructor_appointment(studio_id, instructor_id)
    -- Type-flip guard: block turning a previously non-group-class row
    -- into group_class. `appointments.id`/`studio_id`/`instructor_id`
    -- here are the NEW row's values (instructor_id/studio_id unchanged by
    -- any legitimate update, primary keys are immutable in this app); the
    -- helper independently re-verifies the caller owns that exact
    -- studio+instructor relationship AND that the CURRENT stored row (as
    -- of statement start) is both assigned to that relationship and
    -- already group_class before permitting the NEW row to remain/become
    -- group_class.
    and not (
      appointment_type = 'group_class'::appointment_type
      and not public.can_preserve_existing_group_class_for_instructor(appointments.id, studio_id, instructor_id)
    )
  )
  or (
    appointment_type = 'floor_space_rental'::appointment_type
    and client_id is not null
    and public.user_has_client_portal_access(studio_id, client_id)
  )
);

-- ============================================================================
-- 5. appointments_delete
--
-- platform_admin/studio_owner/studio_admin/front_desk only, uniformly
-- across every appointment_type. Instructor and independent_instructor are
-- denied -- no branch grants either role DELETE, on any row, regardless of
-- ownership. front_desk previously only had DELETE via the "studio staff
-- manage appointments" FOR ALL policy's overlap (a pre-existing bug this
-- migration also fixes elsewhere in this same statement) rather than any
-- policy that named DELETE explicitly -- it now has an explicit, intended
-- DELETE path instead of an accidental one.
-- ============================================================================
create policy "appointments_delete" on public.appointments
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointments.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

commit;
