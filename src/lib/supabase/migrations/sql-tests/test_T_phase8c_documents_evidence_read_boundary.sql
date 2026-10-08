-- Phase 8C -- Documents evidence read boundary: live-Postgres regression suite.
--
-- After 20261031090000_documents_evidence_read_boundary.sql:
--   A. instructor / independent_instructor (and an inactive document role) cannot read signing evidence: envelopes,
--      audit events, fields, field values (signature images) or legacy typed signatures;
--   B. owner / admin / front desk / organizer admin of the studio still read all of it;
--   C. a Documents role of ANOTHER studio reads none of it;
--   D. the portal signer still reads their own legacy signature and their own assignments, but no envelope evidence;
--   E. operational status survives: the instructor still reads document_assignments (status), unchanged.
--
-- One transaction, rolled back. Run against DEV: supabase db query --linked --file <this file>
-- Before the migration, check A fails (that is the regression this suite pins).
-- Deterministic UUID block: 00000000-0000-0000-0000-00008c0XXXXX

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00008c000001', 'Phase 8C Harness Studio A', 't-phase8c-studio-a'),
  ('00000000-0000-0000-0000-00008c000002', 'Phase 8C Harness Studio B', 't-phase8c-studio-b');

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00008c000101', 't-phase8c-owner@example.test', now()),
  ('00000000-0000-0000-0000-00008c000102', 't-phase8c-admin@example.test', now()),
  ('00000000-0000-0000-0000-00008c000103', 't-phase8c-frontdesk@example.test', now()),
  ('00000000-0000-0000-0000-00008c000104', 't-phase8c-instructor@example.test', now()),
  ('00000000-0000-0000-0000-00008c000105', 't-phase8c-indep@example.test', now()),
  ('00000000-0000-0000-0000-00008c000106', 't-phase8c-orgadmin@example.test', now()),
  ('00000000-0000-0000-0000-00008c000107', 't-phase8c-inactive@example.test', now()),
  ('00000000-0000-0000-0000-00008c000108', 't-phase8c-owner-b@example.test', now()),
  ('00000000-0000-0000-0000-00008c000109', 't-phase8c-portal@example.test', now());

insert into public.profiles (id, email)
select id, email from auth.users where id::text like '00000000-0000-0000-0000-00008c0001%'
on conflict (id) do nothing;

insert into public.user_studio_roles (studio_id, user_id, role, active) values
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000101', 'studio_owner', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000102', 'studio_admin', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000103', 'front_desk', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000104', 'instructor', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000105', 'independent_instructor', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000106', 'organizer_admin', true),
  ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000107', 'front_desk', false),
  ('00000000-0000-0000-0000-00008c000002', '00000000-0000-0000-0000-00008c000108', 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email) values
  ('00000000-0000-0000-0000-00008c000201', '00000000-0000-0000-0000-00008c000001', 'Portal', 'Signer', 't-phase8c-portal@example.test');

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_sign_documents)
values ('00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000201', '00000000-0000-0000-0000-00008c000109', 'linked', 'self', true);

insert into public.document_templates (id, scope, studio_id, title, body) values
  ('00000000-0000-0000-0000-00008c000301', 'studio', '00000000-0000-0000-0000-00008c000001', 'Harness Waiver', 'Harness body');

insert into public.document_sign_envelopes (id, studio_id, client_id, title, signer_name, signer_email, status, source_path, source_sha256, page_count, expires_at)
values ('00000000-0000-0000-0000-00008c000501', '00000000-0000-0000-0000-00008c000001', '00000000-0000-0000-0000-00008c000201',
        'Harness Waiver', 'Portal Signer', 't-phase8c-portal@example.test', 'completed', 'harness/source.pdf', 'harness-sha', 1, now() + interval '7 days');

insert into public.document_assignments (id, template_id, studio_id, client_id, status, sign_envelope_id) values
  ('00000000-0000-0000-0000-00008c000401', '00000000-0000-0000-0000-00008c000301', '00000000-0000-0000-0000-00008c000001',
   '00000000-0000-0000-0000-00008c000201', 'signed', '00000000-0000-0000-0000-00008c000501');

insert into public.document_sign_fields (id, envelope_id, field_type, page_number, x, y, width, height, label, required, sort_order)
values ('00000000-0000-0000-0000-00008c000601', '00000000-0000-0000-0000-00008c000501', 'signature', 1, 0.1, 0.1, 0.2, 0.05, 'Signature', true, 10);

insert into public.document_sign_values (envelope_id, field_id, value_text, signature_method)
values ('00000000-0000-0000-0000-00008c000501', '00000000-0000-0000-0000-00008c000601', 'Portal Signer', 'typed');

insert into public.document_sign_events (envelope_id, event_type, actor_email, summary)
values ('00000000-0000-0000-0000-00008c000501', 'completed', 't-phase8c-portal@example.test', 'Harness completion');

insert into public.document_signatures (id, template_id, studio_id, client_id, signer_user_id, signer_name, signed_body, signature_text, consent_text)
values ('00000000-0000-0000-0000-00008c000701', '00000000-0000-0000-0000-00008c000301', '00000000-0000-0000-0000-00008c000001',
        '00000000-0000-0000-0000-00008c000201', '00000000-0000-0000-0000-00008c000109', 'Portal Signer', 'body', 'Portal Signer', 'consent');

create or replace function pg_temp.as_user(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end;
$$;

-- Visible evidence rows (envelopes, events, fields, values, legacy signatures) for the current persona.
create or replace function pg_temp.evidence_seen() returns text language sql as $$
  select
    (select count(*) from public.document_sign_envelopes where id = '00000000-0000-0000-0000-00008c000501') || '/' ||
    (select count(*) from public.document_sign_events where envelope_id = '00000000-0000-0000-0000-00008c000501') || '/' ||
    (select count(*) from public.document_sign_fields where envelope_id = '00000000-0000-0000-0000-00008c000501') || '/' ||
    (select count(*) from public.document_sign_values where envelope_id = '00000000-0000-0000-0000-00008c000501') || '/' ||
    (select count(*) from public.document_signatures where id = '00000000-0000-0000-0000-00008c000701')
$$;

grant execute on function pg_temp.evidence_seen() to authenticated;
grant execute on function pg_temp.as_user(uuid) to authenticated;

do $$
declare
  v_seen text;
  v_assignments int;
  v_persona record;
begin
  -- A. no evidence for instructor roles or an inactive document role
  for v_persona in select * from (values
      ('A1 instructor', '00000000-0000-0000-0000-00008c000104'::uuid),
      ('A2 independent_instructor', '00000000-0000-0000-0000-00008c000105'::uuid),
      ('A3 inactive front_desk', '00000000-0000-0000-0000-00008c000107'::uuid)
    ) as p(label, sub)
  loop
    perform pg_temp.as_user(v_persona.sub);
    set local role authenticated;
    v_seen := pg_temp.evidence_seen();
    reset role;
    if v_seen <> '0/0/0/0/0' then
      raise exception 'FAIL % saw evidence %', v_persona.label, v_seen;
    end if;
  end loop;

  -- B. Documents-management roles keep full evidence access
  for v_persona in select * from (values
      ('B1 studio_owner', '00000000-0000-0000-0000-00008c000101'::uuid),
      ('B2 studio_admin', '00000000-0000-0000-0000-00008c000102'::uuid),
      ('B3 front_desk', '00000000-0000-0000-0000-00008c000103'::uuid),
      ('B4 organizer_admin', '00000000-0000-0000-0000-00008c000106'::uuid)
    ) as p(label, sub)
  loop
    perform pg_temp.as_user(v_persona.sub);
    set local role authenticated;
    v_seen := pg_temp.evidence_seen();
    reset role;
    if v_seen <> '1/1/1/1/1' then
      raise exception 'FAIL % lost evidence access %', v_persona.label, v_seen;
    end if;
  end loop;

  -- C. another studio's owner sees nothing
  perform pg_temp.as_user('00000000-0000-0000-0000-00008c000108');
  set local role authenticated;
  v_seen := pg_temp.evidence_seen();
  reset role;
  if v_seen <> '0/0/0/0/0' then
    raise exception 'FAIL C cross-studio owner saw evidence %', v_seen;
  end if;

  -- D. the portal signer keeps their own legacy signature + own assignment, and no envelope evidence
  perform pg_temp.as_user('00000000-0000-0000-0000-00008c000109');
  set local role authenticated;
  v_seen := pg_temp.evidence_seen();
  select count(*) into v_assignments from public.document_assignments where id = '00000000-0000-0000-0000-00008c000401';
  reset role;
  if v_seen <> '0/0/0/0/1' or v_assignments <> 1 then
    raise exception 'FAIL D portal signer saw % with % own assignment(s)', v_seen, v_assignments;
  end if;

  -- E. the instructor keeps operational status (assignment row + status)
  perform pg_temp.as_user('00000000-0000-0000-0000-00008c000104');
  set local role authenticated;
  select count(*) into v_assignments from public.document_assignments
  where id = '00000000-0000-0000-0000-00008c000401' and status = 'signed';
  reset role;
  if v_assignments <> 1 then
    raise exception 'FAIL E instructor lost assignment status visibility';
  end if;
end;
$$;

select 'PASS T-phase8c documents evidence read boundary (A1 A2 A3 B1 B2 B3 B4 C D E)' as result;

rollback;
