-- Portal / Multi-Studio H2-B2 -- ROLLBACK artifact.
--
-- NOT a forward migration. Lives in migrations/rollback/, a sibling
-- directory deliberately kept out of the normal forward-migration path, so
-- it is never picked up or auto-applied by any tooling that walks
-- src/lib/supabase/migrations/*.sql. Apply manually and only when H2-B2
-- itself needs to be reverted.
--
-- Restores the exact pre-B2 definitions of all 31 policies replaced by
-- 20260831100000_h2b2_portal_rls_cutover.sql, using the same ALTER POLICY
-- mechanism (never DROP+CREATE) for the same reasons the forward migration
-- used it: no policy's command ever changes, and ALTER lets each statement
-- touch only what's being restored. Source of truth for every USING/WITH
-- CHECK clause below: the exact pre-B2 catalog text captured via direct
-- pg_policies reads during H2-B2 implementation and independently
-- re-verified (including MD5 fingerprint cross-checks against a second,
-- independent computation) during the H2-B2 pre-commit review -- not
-- reconstructed from memory.
--
-- This rollback:
--   - restores all 31 policies' USING/WITH CHECK to their exact pre-B2 text
--     (clients.portal_user_id = auth.uid(), in place of
--     public.user_has_client_portal_access(...));
--   - restores the 11 policies H2-B2 narrowed from public to authenticated
--     back to `TO public` (ALTER POLICY ... TO public sets roles={public}
--     in pg_policies, identical to the original pre-B2 catalog state --
--     confirmed empirically in a rolled-back transaction during review);
--   - leaves the remaining 20 policies' role scope untouched (ALTER POLICY
--     without a TO clause does not modify the existing role list -- only
--     USING/WITH CHECK are replaced -- so they remain `authenticated`,
--     exactly matching their original pre-B2 scope);
--   - does NOT drop or modify public.user_has_client_portal_access (H2-B1's
--     helper remains installed, simply unreferenced by any policy again,
--     exactly as it was immediately after H2-B1 merged and before H2-B2);
--   - does NOT touch client_account_links or clients.portal_user_id;
--   - does NOT touch the 2 event_registration_attendees policies (never in
--     scope for either the forward migration or this rollback);
--   - does NOT perform any H2-B3/H2-C work;
--   - does NOT touch Package Refund.
--
-- Wrapped in an explicit begin/commit for the same reason as the forward
-- migration: the actual local (and, later, hosted) invocation method does
-- not provide whole-file atomicity on its own, so an explicit wrapper is
-- required for genuine all-or-nothing rollback.

begin;

-- appointments (5) -----------------------------------------------------------

-- #1: INSERT "portal instructors can create own floor rentals"
alter policy "portal instructors can create own floor rentals" on public.appointments
with check (
  appointment_type = 'floor_space_rental'
  and status = 'scheduled'
  and exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.studio_id = appointments.studio_id
      and c.portal_user_id = auth.uid()
      and coalesce(c.is_independent_instructor, false) = true
  )
  and created_by = auth.uid()
);

-- #2: UPDATE "portal instructors can update own floor rentals"
alter policy "portal instructors can update own floor rentals" on public.appointments
using (
  appointment_type = 'floor_space_rental'
  and exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.studio_id = appointments.studio_id
      and c.portal_user_id = auth.uid()
      and coalesce(c.is_independent_instructor, false) = true
  )
)
with check (
  appointment_type = 'floor_space_rental'
  and exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.studio_id = appointments.studio_id
      and c.portal_user_id = auth.uid()
      and coalesce(c.is_independent_instructor, false) = true
  )
);

-- #3: SELECT "portal instructors can view own floor rentals"
alter policy "portal instructors can view own floor rentals" on public.appointments
using (
  appointment_type = 'floor_space_rental'
  and exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.studio_id = appointments.studio_id
      and c.portal_user_id = auth.uid()
      and coalesce(c.is_independent_instructor, false) = true
  )
);

-- #4: SELECT "portal users can view own appointments"
alter policy "portal users can view own appointments" on public.appointments
using (
  exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.portal_user_id = auth.uid()
  )
);

-- #5: SELECT "portal users can view their own appointments"
alter policy "portal users can view their own appointments" on public.appointments
using (
  exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.portal_user_id = auth.uid()
  )
);

-- client_package_items (1) ---------------------------------------------------

-- #6: SELECT "student_portal_can_read_own_client_package_items"
alter policy "student_portal_can_read_own_client_package_items" on public.client_package_items
using (
  exists (
    select 1
    from public.client_packages cp
    join public.clients c on c.id = cp.client_id and c.studio_id = cp.studio_id
    where cp.id = client_package_items.client_package_id
      and c.portal_user_id = auth.uid()
  )
);

-- client_packages (1) --------------------------------------------------------

-- #7: SELECT "student_portal_can_read_own_client_packages"
alter policy "student_portal_can_read_own_client_packages" on public.client_packages
using (
  exists (
    select 1 from public.clients c
    where c.id = client_packages.client_id
      and c.studio_id = client_packages.studio_id
      and c.portal_user_id = auth.uid()
  )
);

-- client_syllabus_assignments (2) -- roles restored authenticated -> public --

-- #8: SELECT "Connected students can view their syllabus assignments"
alter policy "Connected students can view their syllabus assignments" on public.client_syllabus_assignments
to public
using (
  archived_at is null
  and exists (
    select 1 from public.clients client
    where client.id = client_syllabus_assignments.client_id
      and client.studio_id = client_syllabus_assignments.studio_id
      and client.portal_user_id = auth.uid()
  )
);

-- #9: SELECT "portal clients can read visible syllabus assignments"
alter policy "portal clients can read visible syllabus assignments" on public.client_syllabus_assignments
to public
using (
  visible_in_portal = true
  and archived_at is null
  and exists (
    select 1 from public.clients c
    where c.id = client_syllabus_assignments.client_id
      and c.studio_id = client_syllabus_assignments.studio_id
      and c.portal_user_id = auth.uid()
  )
);

-- client_syllabus_progress (2) -- roles restored authenticated -> public ----

-- #10: SELECT "Connected students can view their syllabus progress"
alter policy "Connected students can view their syllabus progress" on public.client_syllabus_progress
to public
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.id = client_syllabus_progress.assignment_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

-- #11: SELECT "portal clients can read own syllabus progress"
alter policy "portal clients can read own syllabus progress" on public.client_syllabus_progress
to public
using (
  exists (
    select 1
    from public.client_syllabus_assignments csa
    join public.clients c on c.id = csa.client_id
    where csa.id = client_syllabus_progress.assignment_id
      and csa.client_id = client_syllabus_progress.client_id
      and csa.studio_id = client_syllabus_progress.studio_id
      and csa.visible_in_portal = true
      and csa.archived_at is null
      and c.portal_user_id = auth.uid()
  )
);

-- clients (2) -----------------------------------------------------------------

-- #12: SELECT "portal users can read own student profile"
alter policy "portal users can read own student profile" on public.clients
using (
  portal_user_id = auth.uid()
);

-- #13: SELECT "portal users can view their own client record"
alter policy "portal users can view their own client record" on public.clients
using (
  portal_user_id = auth.uid()
);

-- document_assignments (2) -----------------------------------------------------

-- #14: UPDATE "Portal users can mark own document assignments signed"
alter policy "Portal users can mark own document assignments signed" on public.document_assignments
using (
  client_id is not null
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
)
with check (
  client_id is not null
  and status = any (array['pending', 'signed'])
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
);

-- #15: SELECT "Portal users can view own document assignments"
alter policy "Portal users can view own document assignments" on public.document_assignments
using (
  client_id is not null
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and c.portal_user_id = auth.uid()
  )
);

-- document_signatures (2) -------------------------------------------------------

-- #16: INSERT "Portal users can create document signatures"
alter policy "Portal users can create document signatures" on public.document_signatures
with check (
  signer_user_id = auth.uid()
  or (
    client_id is not null
    and exists (
      select 1 from public.clients c
      where c.id = document_signatures.client_id
        and c.portal_user_id = auth.uid()
    )
  )
);

-- #17: SELECT "Portal users can view own document signatures"
alter policy "Portal users can view own document signatures" on public.document_signatures
using (
  signer_user_id = auth.uid()
  or (
    client_id is not null
    and exists (
      select 1 from public.clients c
      where c.id = document_signatures.client_id
        and c.portal_user_id = auth.uid()
    )
  )
);

-- document_template_versions (1) -------------------------------------------------

-- #18: SELECT "Portal users can view assigned document versions"
alter policy "Portal users can view assigned document versions" on public.document_template_versions
using (
  exists (
    select 1
    from public.document_templates dt
    join public.clients c on c.studio_id = dt.studio_id
    where dt.id = document_template_versions.template_id
      and dt.is_active = true
      and dt.applies_to = 'all_clients'
      and c.portal_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_template_versions.template_id
      and c.portal_user_id = auth.uid()
      and da.status <> 'void'
  )
);

-- document_templates (1) -----------------------------------------------------------

-- #19: SELECT "Portal users can view assigned document templates"
alter policy "Portal users can view assigned document templates" on public.document_templates
using (
  (
    studio_id is not null
    and is_active = true
    and applies_to = 'all_clients'
    and exists (
      select 1 from public.clients c
      where c.studio_id = document_templates.studio_id
        and c.portal_user_id = auth.uid()
    )
  )
  or exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_templates.id
      and c.portal_user_id = auth.uid()
      and da.status <> 'void'
  )
);

-- group_lesson_recap_recipients (1) -- roles restored authenticated -> public ----

-- #20: SELECT "Linked students can read own group lesson recap recipients"
alter policy "Linked students can read own group lesson recap recipients" on public.group_lesson_recap_recipients
to public
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.clients c
    where c.id = group_lesson_recap_recipients.client_id
      and c.portal_user_id = auth.uid()
  )
);

-- group_lesson_recaps (1) -- roles restored authenticated -> public -------------

-- #21: SELECT "Linked students can read published group lesson recaps"
alter policy "Linked students can read published group lesson recaps" on public.group_lesson_recaps
to public
using (
  status = 'published'
  and exists (
    select 1
    from public.group_lesson_recap_recipients glrr
    left join public.clients c on c.id = glrr.client_id
    where glrr.recap_id = group_lesson_recaps.id
      and (glrr.user_id = auth.uid() or c.portal_user_id = auth.uid())
  )
);

-- lesson_recap_media (1) -------------------------------------------------------------

-- #22: SELECT "portal users can view visible lesson recap media"
alter policy "portal users can view visible lesson recap media" on public.lesson_recap_media
using (
  exists (
    select 1
    from public.lesson_recaps lr
    join public.appointments a on a.id = lr.appointment_id
    join public.clients c on c.id = a.client_id
    where lr.id = lesson_recap_media.lesson_recap_id
      and lr.visible_to_client = true
      and c.portal_user_id = auth.uid()
  )
);

-- lesson_recaps (1) --------------------------------------------------------------------

-- #23: SELECT "portal users can view visible lesson recaps"
alter policy "portal users can view visible lesson recaps" on public.lesson_recaps
using (
  visible_to_client = true
  and exists (
    select 1
    from public.appointments a
    join public.clients c on c.id = a.client_id
    where a.id = lesson_recaps.appointment_id
      and c.portal_user_id = auth.uid()
  )
);

-- payments (1) -- roles restored authenticated -> public ------------------------------

-- #24: SELECT "Portal users can view their own payments"
alter policy "Portal users can view their own payments" on public.payments
to public
using (
  exists (
    select 1 from public.clients c
    where c.id = payments.client_id
      and c.studio_id = payments.studio_id
      and c.portal_user_id = auth.uid()
  )
);

-- student_dance_goals (3) ----------------------------------------------------------------

-- #25: INSERT "Portal students can create own dance goals"
alter policy "Portal students can create own dance goals" on public.student_dance_goals
with check (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and c.portal_user_id = auth.uid()
  )
);

-- #26: UPDATE "Portal students can update own dance goals"
alter policy "Portal students can update own dance goals" on public.student_dance_goals
using (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and c.portal_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and c.portal_user_id = auth.uid()
  )
);

-- #27: SELECT "Portal students can view own dance goals"
-- Mixed policy -- only the first (portal) OR-arm is being reverted; the
-- staff user_studio_roles arm is reproduced untouched, exactly as the
-- forward migration also left it untouched.
alter policy "Portal students can view own dance goals" on public.student_dance_goals
using (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and c.portal_user_id = auth.uid()
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = student_dance_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
  )
);

-- syllabus_template_items (2) -- roles restored authenticated -> public -------------------

-- #28: SELECT "Connected students can view assigned syllabus template items"
alter policy "Connected students can view assigned syllabus template items" on public.syllabus_template_items
to public
using (
  active is not false
  and exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_template_items.template_id
      and assignment.studio_id = syllabus_template_items.studio_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

-- #29: SELECT "portal clients can read visible syllabus template items"
alter policy "portal clients can read visible syllabus template items" on public.syllabus_template_items
to public
using (
  active = true
  and exists (
    select 1
    from public.client_syllabus_assignments csa
    join public.clients c on c.id = csa.client_id
    where csa.syllabus_template_id = syllabus_template_items.template_id
      and csa.studio_id = syllabus_template_items.studio_id
      and csa.visible_in_portal = true
      and csa.archived_at is null
      and c.portal_user_id = auth.uid()
  )
);

-- syllabus_templates (2) -- roles restored authenticated -> public -----------------------

-- #30: SELECT "Connected students can view assigned syllabus templates"
alter policy "Connected students can view assigned syllabus templates" on public.syllabus_templates
to public
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_templates.id
      and assignment.studio_id = syllabus_templates.studio_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

-- #31: SELECT "portal clients can read visible syllabus templates"
alter policy "portal clients can read visible syllabus templates" on public.syllabus_templates
to public
using (
  active = true
  and exists (
    select 1
    from public.client_syllabus_assignments csa
    join public.clients c on c.id = csa.client_id
    where csa.syllabus_template_id = syllabus_templates.id
      and csa.studio_id = syllabus_templates.studio_id
      and csa.visible_in_portal = true
      and csa.archived_at is null
      and c.portal_user_id = auth.uid()
  )
);

do $$
begin
  raise notice 'H2-B2 ROLLBACK OK: all 31 policies restored to their exact pre-B2 definitions (11 role scopes restored to public, 20 unchanged)';
end $$;

commit;
