-- Portal / Multi-Studio H2-B2: RLS cutover from clients.portal_user_id to
-- public.user_has_client_portal_access(uuid, uuid).
--
-- Scope: exactly 31 policies across 18 tables whose portal-identity branch is
-- `clients.portal_user_id = auth.uid()` (identified and independently
-- re-verified from a fresh pg_policies read in the H2-B2 design pass -- NOT
-- 33/19: that raw figure includes 2 unrelated policies on
-- event_registration_attendees that reference event_registrations.portal_user_id,
-- a different column on a different table belonging to the Public Event
-- Registration system. Those 2 policies are explicitly, permanently out of
-- scope and are asserted untouched by this migration's own postflight-style
-- checks in the accompanying SQL harness.
--
-- What this migration does, in order:
--   1. Reconfirms the H2-B1 helper's exact security contract (fail closed if
--      it ever drifted).
--   2. Reconfirms the exact baseline text of all 31 target policies via an
--      MD5 fingerprint of their current USING/WITH CHECK clauses (fail closed
--      on any drift -- a plain COUNT(*) would not catch a same-named policy
--      whose predicate silently changed).
--   3. Fail-closed preflight: aborts if any client has a stale
--      clients.portal_user_id with no matching linked client_account_links
--      row -- such a client would silently lose legacy-granted access on
--      cutover, which must be a human decision, not a silent migration
--      side effect.
--   4. 31 ALTER POLICY statements, one per policy, replacing only the
--      `<alias>.portal_user_id = auth.uid()` sub-expression with
--      `public.user_has_client_portal_access(<alias>.studio_id, <alias>.id)`.
--      Every other AND/OR-joined condition (staff branches, signer/direct
--      user branches, independent-instructor conditions, status/type
--      restrictions) is reproduced character-for-character from the live
--      catalog text captured during design. ALTER POLICY is used throughout
--      (never DROP+CREATE) because no policy's command ever changes, and
--      ALTER lets each statement touch only what actually changes.
--
-- Deliberate additional change beyond a pure 1:1 predicate swap: 11 of the 31
-- policies currently have no `TO <role>` clause (roles = {public}), which
-- under Postgres RLS semantics means they apply to every role including
-- anon. H2-B1 revoked EXECUTE on the helper from anon and PUBLIC; Postgres
-- checks EXECUTE privilege on every function referenced in a compiled query
-- at parse/rewrite time, before any row is evaluated -- an
-- `auth.uid() IS NOT NULL AND ...` guard does not avoid this, because
-- permission checking is not short-circuited alongside runtime boolean
-- evaluation. Leaving these 11 policies scoped to `public` while their
-- predicate calls the now-EXECUTE-restricted helper would turn today's
-- silent, correct anon denial into a hard `permission denied for function`
-- SQL error for any anon-key query touching these tables, portal-related or
-- not. These 11 policies are therefore also narrowed `TO authenticated` in
-- the same ALTER POLICY statement as their predicate change. This changes no
-- legitimate access: every one of these 11 predicates (plus, where present,
-- their OR'd `user_id = auth.uid()` branches) was already unsatisfiable by
-- anon, since anon's auth.uid() is always NULL. Re-granting EXECUTE to
-- PUBIC/anon instead was considered and rejected -- it would undo H2-B1's
-- reviewed hardening for no product benefit, since no policy in this set was
-- ever meant to be reachable by an unauthenticated caller.
--
-- Not in this migration: no helper redefinition, no data backfill, no
-- clients.portal_user_id cleanup, no application code, no H2-B3, no H2-C, no
-- change to any policy outside the 31 named below, no Package Refund change.
--
-- Transactionality: this file is wrapped in an explicit top-level
-- begin/commit. Empirical testing (independent pre-commit review) proved
-- that the actual local invocation method
-- (`docker exec -i ... psql -v ON_ERROR_STOP=1 < file`) does NOT provide
-- whole-file atomicity on its own -- `ON_ERROR_STOP=1` only stops psql from
-- running the *remaining* statements after an error; every statement that
-- already succeeded before the error remains permanently committed. Without
-- an explicit transaction wrapper, a mid-Step-4 failure would leave RLS
-- partially cut over across the 18 affected tables. The explicit begin/
-- commit below closes that gap: any failure anywhere in this file --
-- including a RAISE EXCEPTION in Steps 1-3, or a failure partway through
-- the 31 ALTER POLICY statements in Step 4 -- rolls back everything in this
-- file, leaving the schema exactly as it was before the file ran.

begin;

-- ============================================================================
-- Step 1: helper contract re-confirmation.
-- ============================================================================
do $$
declare
  v_exists boolean;
  v_security_definer boolean;
  v_stable boolean;
  v_search_path text[];
  v_signature text;
begin
  select exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'user_has_client_portal_access'
  ) into v_exists;
  if not v_exists then
    raise exception 'H2-B2 preflight FAILED: public.user_has_client_portal_access does not exist. Aborting, nothing changed.';
  end if;

  select p.prosecdef, (p.provolatile = 's'), p.proconfig,
    pg_get_function_identity_arguments(p.oid)
  into v_security_definer, v_stable, v_search_path, v_signature
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'user_has_client_portal_access';

  if not v_security_definer then
    raise exception 'H2-B2 preflight FAILED: helper is not SECURITY DEFINER. Aborting, nothing changed.';
  end if;
  if not v_stable then
    raise exception 'H2-B2 preflight FAILED: helper is not STABLE. Aborting, nothing changed.';
  end if;
  if v_search_path is null or not ('search_path=public' = any(v_search_path)) then
    raise exception 'H2-B2 preflight FAILED: helper search_path is not locked to public (got %). Aborting, nothing changed.', v_search_path;
  end if;
  if v_signature is distinct from 'target_studio_id uuid, target_client_id uuid' then
    raise exception 'H2-B2 preflight FAILED: helper signature drifted (got %). Aborting, nothing changed.', v_signature;
  end if;

  raise notice 'H2-B2 Step 1 OK: helper contract confirmed (exists, SECURITY DEFINER, STABLE, search_path=public, signature (uuid, uuid))';
end $$;

-- ============================================================================
-- Step 2: exact policy-baseline fingerprint check.
--
-- MD5 of coalesce(qual,'') || chr(30) || coalesce(with_check,'') for each of
-- the 31 target policies, captured from a fresh pg_policies read immediately
-- before writing this migration. pg_policies.qual/with_check are Postgres's
-- own canonical deparsed expression text -- semantically identical SQL
-- always deparses identically, so this check only fires on a genuine
-- predicate drift, never a cosmetic difference. chr(30) (ASCII record
-- separator) is used as the join character precisely because it cannot
-- appear in deparsed SQL text, so a qual/with_check boundary can never be
-- ambiguous with content.
-- ============================================================================
do $$
declare
  v_drifted text[] := array[]::text[];
  v_missing text[] := array[]::text[];
  rec record;
begin
  for rec in
    select * from (values
      ('appointments', 'portal instructors can create own floor rentals', '66c81da5c8020540638d3d6dbaec6920'),
      ('appointments', 'portal instructors can update own floor rentals', '2203ac891b8d9ed210f6319d0361711d'),
      ('appointments', 'portal instructors can view own floor rentals', '19ed9184654f2beb4bf1cb46cd87ff6a'),
      ('appointments', 'portal users can view own appointments', '105ce2c5ad579e3db2c1cfd93c42f238'),
      ('appointments', 'portal users can view their own appointments', '105ce2c5ad579e3db2c1cfd93c42f238'),
      ('client_package_items', 'student_portal_can_read_own_client_package_items', 'f9c65f0c24a5af4f93207487b8e88027'),
      ('client_packages', 'student_portal_can_read_own_client_packages', '9feb075966f20a4fddd608a0411f55ea'),
      ('client_syllabus_assignments', 'Connected students can view their syllabus assignments', 'd13cfb173f03b19c5b02be48bea82c80'),
      ('client_syllabus_assignments', 'portal clients can read visible syllabus assignments', 'c4db1b8f7662d6cb72e2a84033ead85b'),
      ('client_syllabus_progress', 'Connected students can view their syllabus progress', '5a1e92952dbf815509cdd8bc72c11c80'),
      ('client_syllabus_progress', 'portal clients can read own syllabus progress', 'beae804352eff68f715290d7c7b93841'),
      ('clients', 'portal users can read own student profile', '46405bd59dac2dc312bdbcbb6503c017'),
      ('clients', 'portal users can view their own client record', '46405bd59dac2dc312bdbcbb6503c017'),
      ('document_assignments', 'Portal users can mark own document assignments signed', 'b30b0738433dee35c29774b7068d0803'),
      ('document_assignments', 'Portal users can view own document assignments', '79af50682ce864e65fa5a0c9ec51283e'),
      ('document_signatures', 'Portal users can create document signatures', '3a68e2445a6feb73bb4afcd47a5bc6e0'),
      ('document_signatures', 'Portal users can view own document signatures', 'cc6b06c875802dbc30212c586f982326'),
      ('document_template_versions', 'Portal users can view assigned document versions', 'e0b93746c07bc1af710bc2e2c497d1a5'),
      ('document_templates', 'Portal users can view assigned document templates', '653c36a1515bf543ba2b4b8f3c2d9c53'),
      ('group_lesson_recap_recipients', 'Linked students can read own group lesson recap recipients', '92be241e1f0f242a95682d054911cdf6'),
      ('group_lesson_recaps', 'Linked students can read published group lesson recaps', 'b74151032f078d3491654a85cd8b34ac'),
      ('lesson_recap_media', 'portal users can view visible lesson recap media', '5e5200f2fb61a7677af484a5038a61be'),
      ('lesson_recaps', 'portal users can view visible lesson recaps', 'bdade4d110e8149f70923d9f2e198b76'),
      ('payments', 'Portal users can view their own payments', 'c59101915c4e9307b29cf1d3aec9e355'),
      ('student_dance_goals', 'Portal students can create own dance goals', '5a4d62eea1ca7319f8c8c9ae0ae5222d'),
      ('student_dance_goals', 'Portal students can update own dance goals', '42827ab32eb9eb0c940cef069db61fd0'),
      ('student_dance_goals', 'Portal students can view own dance goals', '22e16a9c10cff18895dce77f0a15dc2a'),
      ('syllabus_template_items', 'Connected students can view assigned syllabus template items', 'bfe95442a5b9eaea94735554c5484380'),
      ('syllabus_template_items', 'portal clients can read visible syllabus template items', '044caa84c0530b599f077cae128dca37'),
      ('syllabus_templates', 'Connected students can view assigned syllabus templates', '35fb83bb627d52eb7e0829302289488e'),
      ('syllabus_templates', 'portal clients can read visible syllabus templates', '775655f47e834d362cf887d5d4640343')
    ) as t(tablename, policyname, expected_hash)
  loop
    declare
      v_live_hash text;
    begin
      select md5(coalesce(p.qual::text,'') || chr(30) || coalesce(p.with_check::text,''))
      into v_live_hash
      from pg_policies p
      where p.schemaname = 'public' and p.tablename = rec.tablename and p.policyname = rec.policyname;

      if v_live_hash is null then
        v_missing := v_missing || (rec.tablename || '.' || rec.policyname);
      elsif v_live_hash <> rec.expected_hash then
        v_drifted := v_drifted || (rec.tablename || '.' || rec.policyname);
      end if;
    end;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'H2-B2 preflight FAILED: % expected policy(ies) not found: %. Aborting, nothing changed.', array_length(v_missing,1), array_to_string(v_missing, ', ');
  end if;
  if array_length(v_drifted, 1) > 0 then
    raise exception 'H2-B2 preflight FAILED: % policy(ies) have drifted from the design-time baseline: %. Aborting, nothing changed.', array_length(v_drifted,1), array_to_string(v_drifted, ', ');
  end if;

  raise notice 'H2-B2 Step 2 OK: all 31 target policies match their exact design-time baseline fingerprint';
end $$;

-- ============================================================================
-- Step 3: fail-closed legacy/modern-link preflight.
--
-- Aborts if any client currently has portal_user_id set but no matching
-- linked client_account_links row -- cutover would otherwise silently
-- revoke that client's legacy-granted access. Exact match on client id,
-- studio id, user id, and status='linked' -- this directly encodes "the new
-- helper would return true for exactly the same case the old raw column
-- comparison did," the actual safety property being protected.
-- ============================================================================
do $$
declare
  v_mismatch_count integer;
begin
  select count(*) into v_mismatch_count
  from public.clients c
  where c.portal_user_id is not null
    and not exists (
      select 1 from public.client_account_links cal
      where cal.client_id = c.id
        and cal.studio_id = c.studio_id
        and cal.user_id = c.portal_user_id
        and cal.status = 'linked'
    );

  if v_mismatch_count > 0 then
    raise exception 'H2-B2 preflight FAILED: % client(s) have portal_user_id set with no matching linked client_account_links row; cutover would silently revoke their legacy-granted access. Aborting, nothing changed.', v_mismatch_count;
  end if;

  raise notice 'H2-B2 Step 3 OK: every client with a stale portal_user_id has a matching linked client_account_links row (or has no stale portal_user_id at all)';
end $$;

-- ============================================================================
-- Step 4: the 31 policy replacements, grouped by table.
-- ============================================================================

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
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
      and coalesce(c.is_independent_instructor, false) = true
  )
)
with check (
  appointment_type = 'floor_space_rental'
  and exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and c.studio_id = appointments.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
      and coalesce(c.is_independent_instructor, false) = true
  )
);

-- #4: SELECT "portal users can view own appointments"
alter policy "portal users can view own appointments" on public.appointments
using (
  exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- #5: SELECT "portal users can view their own appointments"
alter policy "portal users can view their own appointments" on public.appointments
using (
  exists (
    select 1 from public.clients c
    where c.id = appointments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- client_syllabus_assignments (2) -- roles narrowed public -> authenticated --

-- #8: SELECT "Connected students can view their syllabus assignments"
alter policy "Connected students can view their syllabus assignments" on public.client_syllabus_assignments
to authenticated
using (
  archived_at is null
  and exists (
    select 1 from public.clients client
    where client.id = client_syllabus_assignments.client_id
      and client.studio_id = client_syllabus_assignments.studio_id
      and public.user_has_client_portal_access(client.studio_id, client.id)
  )
);

-- #9: SELECT "portal clients can read visible syllabus assignments"
alter policy "portal clients can read visible syllabus assignments" on public.client_syllabus_assignments
to authenticated
using (
  visible_in_portal = true
  and archived_at is null
  and exists (
    select 1 from public.clients c
    where c.id = client_syllabus_assignments.client_id
      and c.studio_id = client_syllabus_assignments.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- client_syllabus_progress (2) -- roles narrowed public -> authenticated -----

-- #10: SELECT "Connected students can view their syllabus progress"
alter policy "Connected students can view their syllabus progress" on public.client_syllabus_progress
to authenticated
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.id = client_syllabus_progress.assignment_id
      and assignment.archived_at is null
      and public.user_has_client_portal_access(client.studio_id, client.id)
  )
);

-- #11: SELECT "portal clients can read own syllabus progress"
alter policy "portal clients can read own syllabus progress" on public.client_syllabus_progress
to authenticated
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- clients (2) -----------------------------------------------------------------

-- #12: SELECT "portal users can read own student profile"
alter policy "portal users can read own student profile" on public.clients
using (
  public.user_has_client_portal_access(studio_id, id)
);

-- #13: SELECT "portal users can view their own client record"
alter policy "portal users can view their own client record" on public.clients
using (
  public.user_has_client_portal_access(studio_id, id)
);

-- document_assignments (2) -----------------------------------------------------

-- #14: UPDATE "Portal users can mark own document assignments signed"
alter policy "Portal users can mark own document assignments signed" on public.document_assignments
using (
  client_id is not null
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
)
with check (
  client_id is not null
  and status = any (array['pending', 'signed'])
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- #15: SELECT "Portal users can view own document assignments"
alter policy "Portal users can view own document assignments" on public.document_assignments
using (
  client_id is not null
  and exists (
    select 1 from public.clients c
    where c.id = document_assignments.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
        and public.user_has_client_portal_access(c.studio_id, c.id)
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
        and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
  or exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_template_versions.template_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
        and public.user_has_client_portal_access(c.studio_id, c.id)
    )
  )
  or exists (
    select 1
    from public.document_assignments da
    join public.clients c on c.id = da.client_id
    where da.template_id = document_templates.id
      and public.user_has_client_portal_access(c.studio_id, c.id)
      and da.status <> 'void'
  )
);

-- group_lesson_recap_recipients (1) -- roles narrowed public -> authenticated ----

-- #20: SELECT "Linked students can read own group lesson recap recipients"
alter policy "Linked students can read own group lesson recap recipients" on public.group_lesson_recap_recipients
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1 from public.clients c
    where c.id = group_lesson_recap_recipients.client_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- group_lesson_recaps (1) -- roles narrowed public -> authenticated -------------

-- #21: SELECT "Linked students can read published group lesson recaps"
alter policy "Linked students can read published group lesson recaps" on public.group_lesson_recaps
to authenticated
using (
  status = 'published'
  and exists (
    select 1
    from public.group_lesson_recap_recipients glrr
    left join public.clients c on c.id = glrr.client_id
    where glrr.recap_id = group_lesson_recaps.id
      and (glrr.user_id = auth.uid() or public.user_has_client_portal_access(c.studio_id, c.id))
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- payments (1) -- roles narrowed public -> authenticated ------------------------------

-- #24: SELECT "Portal users can view their own payments"
alter policy "Portal users can view their own payments" on public.payments
to authenticated
using (
  exists (
    select 1 from public.clients c
    where c.id = payments.client_id
      and c.studio_id = payments.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- #26: UPDATE "Portal students can update own dance goals"
alter policy "Portal students can update own dance goals" on public.student_dance_goals
using (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
)
with check (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- #27: SELECT "Portal students can view own dance goals"
-- Mixed policy -- only the first (portal) OR-arm changes; the staff
-- user_studio_roles arm is reproduced untouched.
alter policy "Portal students can view own dance goals" on public.student_dance_goals
using (
  exists (
    select 1 from public.clients c
    where c.id = student_dance_goals.client_id
      and c.studio_id = student_dance_goals.studio_id
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = student_dance_goals.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk', 'instructor']::app_role[])
  )
);

-- syllabus_template_items (2) -- roles narrowed public -> authenticated -------------------

-- #28: SELECT "Connected students can view assigned syllabus template items"
alter policy "Connected students can view assigned syllabus template items" on public.syllabus_template_items
to authenticated
using (
  active is not false
  and exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_template_items.template_id
      and assignment.studio_id = syllabus_template_items.studio_id
      and assignment.archived_at is null
      and public.user_has_client_portal_access(client.studio_id, client.id)
  )
);

-- #29: SELECT "portal clients can read visible syllabus template items"
alter policy "portal clients can read visible syllabus template items" on public.syllabus_template_items
to authenticated
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

-- syllabus_templates (2) -- roles narrowed public -> authenticated -----------------------

-- #30: SELECT "Connected students can view assigned syllabus templates"
alter policy "Connected students can view assigned syllabus templates" on public.syllabus_templates
to authenticated
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client on client.id = assignment.client_id and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_templates.id
      and assignment.studio_id = syllabus_templates.studio_id
      and assignment.archived_at is null
      and public.user_has_client_portal_access(client.studio_id, client.id)
  )
);

-- #31: SELECT "portal clients can read visible syllabus templates"
alter policy "portal clients can read visible syllabus templates" on public.syllabus_templates
to authenticated
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
      and public.user_has_client_portal_access(c.studio_id, c.id)
  )
);

do $$
begin
  raise notice 'H2-B2 Step 4 OK: all 31 policy replacements applied';
end $$;

commit;
