-- Phase 8C -- Documents evidence read boundary.
--
-- Before: every active studio role (including instructor / independent_instructor) could SELECT, directly through
-- the client SDK, signing evidence of its studio:
--   document_sign_envelopes  document_sign_envelopes_studio_read
--   document_sign_events     document_sign_events_studio_read      (audit trail: actor email, IP, user agent)
--   document_sign_fields     document_sign_fields_studio_read
--   document_sign_values     document_sign_values_studio_read      (field values and drawn signature images)
--   document_signatures      "Studio users can view document signatures" (legacy typed-signature evidence)
--
-- After: the same tenancy rule (an active role in the record's studio, or for legacy organizer records an active
-- organizer membership) AND a Documents-management role -- the app's existing canManageDocumentsRole boundary:
-- platform_admin, studio_owner, studio_admin, owner, admin, front_desk, organizer_owner, organizer_admin,
-- organizer_staff. Instructors keep operational STATUS visibility through document_assignments (unchanged); they
-- no longer read signatures, field values, signed evidence or the audit trail.
--
-- Unchanged: portal read policies, the signer's own legacy signature (signer_user_id = auth.uid()), every
-- document_assignments policy, and all service-role (server) access. No data change.
--
-- Fail-closed preflight: RLS must be enabled on all five tables and each replaced policy must still match its
-- reviewed predicate fingerprint (md5 of USING || '|' || CHECK), identical on DEV and PROD at Phase 8C review.

begin;

-- Pinned so deparsed predicates (and their fingerprints) do not depend on the caller search_path.
set local search_path to pg_catalog, public;

do $$
declare
  v_fp text;
  v_expected record;
begin
  if exists (
    select 1 from pg_class
    where oid in (
      'public.document_sign_envelopes'::regclass, 'public.document_sign_events'::regclass,
      'public.document_sign_fields'::regclass, 'public.document_sign_values'::regclass,
      'public.document_signatures'::regclass
    ) and not relrowsecurity
  ) then
    raise exception 'Phase 8C preflight: RLS must be enabled on every Documents evidence table';
  end if;

  for v_expected in
    select * from (values
      ('document_sign_envelopes', 'document_sign_envelopes_studio_read', '594783e0263c54a80d19dd395ab08376'),
      ('document_sign_events', 'document_sign_events_studio_read', 'e94eeabd2c55ea15839bd34ded16d8c3'),
      ('document_sign_fields', 'document_sign_fields_studio_read', 'c098afe00ed27ae72e04cb6458f17e79'),
      ('document_sign_values', 'document_sign_values_studio_read', '01f1c458f4c786be8460089f7cdcb01b'),
      ('document_signatures', 'Studio users can view document signatures', '1c20415e461be995f548c45bde2a8bc8')
    ) as e(table_name, policy_name, fingerprint)
  loop
    select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_fp
    from pg_policies
    where schemaname = 'public' and tablename = v_expected.table_name
      and policyname = v_expected.policy_name and cmd = 'SELECT';
    if v_fp is distinct from v_expected.fingerprint then
      raise exception 'Phase 8C preflight: %.% drifted or missing (fp=%)', v_expected.table_name, v_expected.policy_name, v_fp;
    end if;
  end loop;
end;
$$;

drop policy "document_sign_envelopes_studio_read" on public.document_sign_envelopes;
create policy "document_sign_envelopes_studio_read" on public.document_sign_envelopes
  for select to authenticated
  using (
    exists (
      select 1 from public.user_studio_roles su
      where su.studio_id = document_sign_envelopes.studio_id
        and su.user_id = auth.uid()
        and su.active = true
        and su.role::text = any (array['platform_admin', 'studio_owner', 'studio_admin', 'owner', 'admin', 'front_desk', 'organizer_owner', 'organizer_admin', 'organizer_staff'])
    )
  );

drop policy "document_sign_events_studio_read" on public.document_sign_events;
create policy "document_sign_events_studio_read" on public.document_sign_events
  for select to authenticated
  using (
    exists (
      select 1 from public.document_sign_envelopes e
      join public.user_studio_roles su on su.studio_id = e.studio_id
      where e.id = document_sign_events.envelope_id
        and su.user_id = auth.uid()
        and su.active = true
        and su.role::text = any (array['platform_admin', 'studio_owner', 'studio_admin', 'owner', 'admin', 'front_desk', 'organizer_owner', 'organizer_admin', 'organizer_staff'])
    )
  );

drop policy "document_sign_fields_studio_read" on public.document_sign_fields;
create policy "document_sign_fields_studio_read" on public.document_sign_fields
  for select to authenticated
  using (
    exists (
      select 1 from public.document_sign_envelopes e
      join public.user_studio_roles su on su.studio_id = e.studio_id
      where e.id = document_sign_fields.envelope_id
        and su.user_id = auth.uid()
        and su.active = true
        and su.role::text = any (array['platform_admin', 'studio_owner', 'studio_admin', 'owner', 'admin', 'front_desk', 'organizer_owner', 'organizer_admin', 'organizer_staff'])
    )
  );

drop policy "document_sign_values_studio_read" on public.document_sign_values;
create policy "document_sign_values_studio_read" on public.document_sign_values
  for select to authenticated
  using (
    exists (
      select 1 from public.document_sign_envelopes e
      join public.user_studio_roles su on su.studio_id = e.studio_id
      where e.id = document_sign_values.envelope_id
        and su.user_id = auth.uid()
        and su.active = true
        and su.role::text = any (array['platform_admin', 'studio_owner', 'studio_admin', 'owner', 'admin', 'front_desk', 'organizer_owner', 'organizer_admin', 'organizer_staff'])
    )
  );

drop policy "Studio users can view document signatures" on public.document_signatures;
create policy "Studio users can view document signatures" on public.document_signatures
  for select to authenticated
  using (
    (
      (studio_id is not null) and exists (
        select 1 from public.user_studio_roles usr
        where usr.studio_id = document_signatures.studio_id
          and usr.user_id = auth.uid()
          and coalesce(usr.active, true) = true
          and usr.role::text = any (array['platform_admin', 'studio_owner', 'studio_admin', 'owner', 'admin', 'front_desk', 'organizer_owner', 'organizer_admin', 'organizer_staff'])
      )
    )
    or (
      (organizer_id is not null) and exists (
        select 1 from public.organizer_users ou
        where ou.organizer_id = document_signatures.organizer_id
          and ou.user_id = auth.uid()
          and coalesce(ou.active, true) = true
          and ou.role = any (array['organizer_owner', 'organizer_admin', 'organizer_staff'])
      )
    )
    or (signer_user_id = auth.uid())
  );

-- Postflight: the replaced policies are now role-bound and the untouched read policies kept their fingerprints.
do $$
declare
  v_fp text;
  v_expected record;
begin
  for v_expected in
    select * from (values
      ('document_sign_envelopes', 'document_sign_envelopes_studio_read', '0fb25222ed2514a4f8a25cc9d7abb139'),
      ('document_sign_events', 'document_sign_events_studio_read', 'e8454f542e3530a7ef0791151eb562f3'),
      ('document_sign_fields', 'document_sign_fields_studio_read', '08e48277efe5fb66d2d78dc697e7fa51'),
      ('document_sign_values', 'document_sign_values_studio_read', '44f812f7096492780ba737b3772f7a8c'),
      ('document_signatures', 'Studio users can view document signatures', '824d0013ed959b6cb9404f0b0bbcf945'),
      ('document_signatures', 'Portal users can view own document signatures', 'a280e9180e0b1fa6bcda9b0c6f76d9fc'),
      ('document_assignments', 'Studio users can view document assignments', '639b8e5b8f16b1dd92bdc402836d7dde'),
      ('document_assignments', 'Portal users can view own document assignments', 'dfd2acbebc63b88252496bd4b707745a'),
      ('document_assignments', 'Studio admins can manage document assignments', '31b8929d9f80fbd9ed5542cb3bf6b80f')
    ) as e(table_name, policy_name, fingerprint)
  loop
    select md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) into v_fp
    from pg_policies
    where schemaname = 'public' and tablename = v_expected.table_name and policyname = v_expected.policy_name;
    if v_fp is distinct from v_expected.fingerprint then
      raise exception 'Phase 8C postflight: %.% unexpected definition (fp=%)', v_expected.table_name, v_expected.policy_name, v_fp;
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('document_sign_envelopes', 'document_sign_events', 'document_sign_fields', 'document_sign_values')
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'Phase 8C postflight: unexpected write policy on a Documents evidence table';
  end if;
end;
$$;

commit;
