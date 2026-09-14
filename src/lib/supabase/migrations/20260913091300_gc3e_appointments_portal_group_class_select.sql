-- GC-3.3 (gc3e): portal visibility for publicly-discoverable group classes.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\pause-gc-3-2-packaging-perform-virtual-orbit.md,
-- section 51 (GC-3.3 implementation plan, as revised). Decision 4 (same
-- plan file, section 50): a 5th branch on appointments_select, additive
-- only, gated on group_class_enrollment_policies.publicly_discoverable --
-- deliberately NOT self_enrollment_allowed, since the two flags are
-- intentionally independent (confirmed by the recovered pre-split GC-3
-- scope note: "discoverability and enrollment eligibility are two separate
-- configuration questions, not one toggle"). A class visible under this
-- branch may still be self-enrollment-disabled; self_enroll_class_attendee
-- (gc3d) re-checks self_enrollment_allowed independently regardless of
-- what this policy makes visible.
--
-- Mechanism: drop+create, not ALTER POLICY -- appointments_select's own
-- migration history (20260908100000_fc1b5d2c0c_appointments_group_class_select_cleanup.sql,
-- its live-producing migration) already establishes drop+create as this
-- specific policy's convention; ALTER POLICY was H2-B2's convention for a
-- different, larger batch of policies. Branches 1-4 below are reproduced
-- character-for-character from that migration's own text -- no
-- improvisation, no semantic change to any existing branch.
--
-- Branch 5 queries client_account_links directly, not
-- user_has_client_portal_access -- that helper takes one specific
-- client_id and would incorrectly scope visibility to a single client
-- rather than "any linked portal relationship at this studio," which is
-- what "publicly discoverable" (Decision 5: visible only to studios where
-- the caller already has a linked relationship -- true anonymous public
-- discovery is GC-3.4, not this slice) requires. Tenant scope is derived
-- from appointments.studio_id/appointments.id (the target row) -- no
-- caller-supplied identifier is ever trusted.
--
-- IMPLEMENTATION-TIME CORRECTION (discovered by live DEV testing, not
-- anticipated by the approved plan): branch 5's original design queried
-- public.group_class_enrollment_policies directly from inside the
-- appointments_select policy body. group_class_enrollment_policies has its
-- own RLS SELECT policy (gc3b) that itself queries public.appointments (to
-- resolve the class's instructor for the instructor-read-only branch) --
-- so a direct cross-reference in both directions produces
-- "42P17: infinite recursion detected in policy for relation
-- appointments." Fix: resolve the publicly_discoverable flag through a new
-- SECURITY DEFINER helper, is_group_class_publicly_discoverable(uuid),
-- instead of a direct table reference -- identical technique already used
-- by is_own_instructor_appointment and user_has_client_portal_access
-- (both SECURITY DEFINER) for this exact class of problem: a definer
-- function owned by the table owner reads group_class_enrollment_policies
-- without RLS being (re-)evaluated for that read (the table has no FORCE
-- ROW LEVEL SECURITY, confirmed live during GC-3.2's own DEV verification),
-- so the cycle never forms. No change to what the branch actually
-- authorizes -- same predicate, same result, just no longer expressed as a
-- direct RLS-protected-table reference from within another table's policy.

begin;

-- ============================================================================
-- 0. Helper -- avoids RLS-policy recursion between appointments_select and
--    group_class_enrollment_policies_select (see note above). SECURITY
--    DEFINER + no FORCE RLS on the target table means this read bypasses
--    group_class_enrollment_policies' own RLS, exactly like every other
--    cross-table RLS helper in this codebase.
-- ============================================================================
create or replace function public.is_group_class_publicly_discoverable(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1 from public.group_class_enrollment_policies gcep
    where gcep.appointment_id = p_appointment_id
      and gcep.publicly_discoverable = true
  );
$$;

revoke all on function public.is_group_class_publicly_discoverable(uuid) from public;
revoke all on function public.is_group_class_publicly_discoverable(uuid) from anon;
grant execute on function public.is_group_class_publicly_discoverable(uuid) to authenticated;
revoke all on function public.is_group_class_publicly_discoverable(uuid) from service_role;

drop policy if exists "appointments_select" on public.appointments;

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
  -- 5. NEW (GC-3.3/gc3e) -- publicly discoverable group class, visible to
  --    any studio-linked portal identity, independent of whether
  --    self-enrollment is actually allowed for it.
  or (
    appointment_type = 'group_class'::appointment_type
    and public.is_group_class_publicly_discoverable(appointments.id)
    and exists (
      select 1 from public.client_account_links cal
      where cal.user_id = auth.uid()
        and cal.studio_id = appointments.studio_id
        and cal.status = 'linked'
    )
  )
);

commit;
