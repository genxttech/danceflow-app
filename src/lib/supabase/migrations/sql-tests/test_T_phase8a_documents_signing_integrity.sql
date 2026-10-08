-- Phase 8A -- Documents signing integrity: live-Postgres regression suite.
--
-- Proves at the real Postgres/RLS level (not mocked) that, after 20261029090000_documents_signing_integrity.sql:
--   A. an arbitrary signed-in user cannot forge a document_signatures row (even with signer_user_id = their own id);
--   B. a linked portal user cannot directly set their own assignment to signed (or change any assignment column);
--   C. a portal user cannot modify another client's assignment;
--   D. staff of another studio cannot write this studio's assignments;
--   E. the legitimate server paths still work: staff management policy, service-role signature insert, and the
--      envelope-completion trigger (pending -> signed);
--   F. portal READ access is preserved (portal display keeps working);
--   G. the completion trigger never turns a waived / void assignment into signed.
--
-- The whole script runs in one transaction and is rolled back -- nothing persists. Run against DEV with
--   supabase db query --linked --file <this file>
-- AFTER the forward migration. Before the migration, checks A and B fail (that is the regression this suite pins).
--
-- Deterministic UUID block: 00000000-0000-0000-0000-00008a0XXXXX

begin;

-- ============================================================================ fixtures (as the migration owner)
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00008a000001', 'Phase 8A Harness Studio A', 't-phase8a-studio-a'),
  ('00000000-0000-0000-0000-00008a000002', 'Phase 8A Harness Studio B', 't-phase8a-studio-b');

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-00008a000101', 't-phase8a-owner-a@example.test', now()),
  ('00000000-0000-0000-0000-00008a000102', 't-phase8a-owner-b@example.test', now()),
  ('00000000-0000-0000-0000-00008a000103', 't-phase8a-portal@example.test', now()),
  ('00000000-0000-0000-0000-00008a000104', 't-phase8a-stranger@example.test', now());

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-00008a000101', 't-phase8a-owner-a@example.test'),
  ('00000000-0000-0000-0000-00008a000102', 't-phase8a-owner-b@example.test'),
  ('00000000-0000-0000-0000-00008a000103', 't-phase8a-portal@example.test'),
  ('00000000-0000-0000-0000-00008a000104', 't-phase8a-stranger@example.test')
on conflict (id) do nothing;

insert into public.user_studio_roles (studio_id, user_id, role, active) values
  ('00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000101', 'studio_owner', true),
  ('00000000-0000-0000-0000-00008a000002', '00000000-0000-0000-0000-00008a000102', 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email) values
  ('00000000-0000-0000-0000-00008a000201', '00000000-0000-0000-0000-00008a000001', 'Portal', 'Client', 't-phase8a-portal@example.test'),
  ('00000000-0000-0000-0000-00008a000202', '00000000-0000-0000-0000-00008a000001', 'Other', 'Client', 't-phase8a-other@example.test');

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_sign_documents)
values ('00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201', '00000000-0000-0000-0000-00008a000103', 'linked', 'self', true);

insert into public.document_templates (id, scope, studio_id, title, body) values
  ('00000000-0000-0000-0000-00008a000301', 'studio', '00000000-0000-0000-0000-00008a000001', 'Harness Waiver', 'Harness body');

insert into public.document_assignments (id, template_id, studio_id, client_id, status) values
  ('00000000-0000-0000-0000-00008a000401', '00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201', 'pending'),
  ('00000000-0000-0000-0000-00008a000402', '00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000202', 'pending'),
  ('00000000-0000-0000-0000-00008a000403', '00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201', 'waived'),
  ('00000000-0000-0000-0000-00008a000404', '00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201', 'void'),
  ('00000000-0000-0000-0000-00008a000405', '00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201', 'pending');

create or replace function pg_temp.as_user(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end;
$$;

-- ============================================================================ A. no forged signatures
do $$
declare
  v_denied boolean;
begin
  -- A1: an unrelated signed-in user, own id as signer, another studio's client
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000104');
  set local role authenticated;
  v_denied := false;
  begin
    insert into public.document_signatures (template_id, studio_id, client_id, signer_user_id, signer_name, signed_body, signature_text, consent_text)
    values ('00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000202',
            '00000000-0000-0000-0000-00008a000104', 'Forger', 'forged body', 'Forger', 'forged consent');
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  if not v_denied then raise exception 'FAIL T-8A-A1 arbitrary user forged a document_signatures row'; end if;

  -- A2: even the linked portal user cannot insert a signature row directly for their own client
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000103');
  set local role authenticated;
  v_denied := false;
  begin
    insert into public.document_signatures (template_id, assignment_id, studio_id, client_id, signer_user_id, signer_name, signed_body, signature_text, consent_text)
    values ('00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000401', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201',
            '00000000-0000-0000-0000-00008a000103', 'Portal Client', 'body', 'Portal Client', 'consent');
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  if not v_denied then raise exception 'FAIL T-8A-A2 portal user inserted a signature row directly'; end if;
end;
$$;

-- ============================================================================ B/C/D. no direct assignment writes
do $$
declare
  v_rows integer;
begin
  -- B: linked portal user cannot set their own assignment signed, nor rewrite other columns
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000103');
  set local role authenticated;
  update public.document_assignments set status = 'signed', signed_at = now() where id = '00000000-0000-0000-0000-00008a000401';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then reset role; raise exception 'FAIL T-8A-B1 portal user set own assignment signed (% rows)', v_rows; end if;
  update public.document_assignments set due_at = now() + interval '30 days', sign_envelope_id = null where id = '00000000-0000-0000-0000-00008a000401';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then reset role; raise exception 'FAIL T-8A-B2 portal user rewrote assignment columns (% rows)', v_rows; end if;
  update public.document_assignments set status = 'pending' where id = '00000000-0000-0000-0000-00008a000403';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then reset role; raise exception 'FAIL T-8A-B3 portal user reopened a waived assignment'; end if;

  -- C: nor another client's assignment in the same studio
  update public.document_assignments set status = 'signed' where id = '00000000-0000-0000-0000-00008a000402';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then reset role; raise exception 'FAIL T-8A-C1 portal user modified another client''s assignment'; end if;
  reset role;

  -- D: staff of another studio cannot write studio A assignments
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000102');
  set local role authenticated;
  update public.document_assignments set status = 'void' where id = '00000000-0000-0000-0000-00008a000402';
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows <> 0 then raise exception 'FAIL T-8A-D1 cross-studio staff wrote an assignment'; end if;

  if (select status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000401') <> 'pending'
     or (select status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000402') <> 'pending'
     or (select status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000403') <> 'waived' then
    raise exception 'FAIL T-8A-BCD assignment state changed by a denied write';
  end if;
end;
$$;

-- ============================================================================ F. portal reads preserved
do $$
declare
  v_count integer;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000103');
  set local role authenticated;
  select count(*) into v_count from public.document_assignments where client_id = '00000000-0000-0000-0000-00008a000201';
  reset role;
  if v_count <> 4 then raise exception 'FAIL T-8A-F1 portal user sees % of own 4 assignments', v_count; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000103');
  set local role authenticated;
  select count(*) into v_count from public.document_assignments where client_id = '00000000-0000-0000-0000-00008a000202';
  reset role;
  if v_count <> 0 then raise exception 'FAIL T-8A-F2 portal user sees another client''s assignments'; end if;
end;
$$;

-- ============================================================================ E. legitimate server paths still work
do $$
declare
  v_rows integer;
  v_status text;
begin
  -- E1: studio staff management policy is unchanged
  perform pg_temp.as_user('00000000-0000-0000-0000-00008a000101');
  set local role authenticated;
  update public.document_assignments set due_at = now() + interval '3 days' where id = '00000000-0000-0000-0000-00008a000402';
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows <> 1 then raise exception 'FAIL T-8A-E1 studio owner can no longer manage assignments'; end if;

  -- E2: the service-role (server-mediated) path can still record a legacy typed signature
  insert into public.document_signatures (template_id, assignment_id, studio_id, client_id, signer_user_id, signer_name, signed_body, signature_text, consent_text)
  values ('00000000-0000-0000-0000-00008a000301', '00000000-0000-0000-0000-00008a000405', '00000000-0000-0000-0000-00008a000001', '00000000-0000-0000-0000-00008a000201',
          '00000000-0000-0000-0000-00008a000103', 'Portal Client', 'Harness body', 'Portal Client', 'consent');

  -- E3: an envelope completion signs its pending assignment through the sync trigger
  insert into public.document_sign_envelopes (id, studio_id, title, signer_name, signer_email, status, source_path, source_sha256, page_count, expires_at, assignment_id, client_id)
  values ('00000000-0000-0000-0000-00008a000501', '00000000-0000-0000-0000-00008a000001', 'Harness', 'Portal Client', 't-phase8a-portal@example.test',
          'sent', 'harness/source.pdf', repeat('a', 64), 1, now() + interval '7 days', '00000000-0000-0000-0000-00008a000401', '00000000-0000-0000-0000-00008a000201');
  update public.document_sign_envelopes set status = 'completed', completed_at = now() where id = '00000000-0000-0000-0000-00008a000501';
  select status into v_status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000401';
  if v_status <> 'signed' then raise exception 'FAIL T-8A-E3 completed envelope did not sign its pending assignment (status %)', v_status; end if;
end;
$$;

-- ============================================================================ G. trigger never revives waived / void
do $$
begin
  insert into public.document_sign_envelopes (id, studio_id, title, signer_name, signer_email, status, source_path, source_sha256, page_count, expires_at, assignment_id, client_id)
  values
    ('00000000-0000-0000-0000-00008a000502', '00000000-0000-0000-0000-00008a000001', 'Harness', 'Portal Client', 't-phase8a-portal@example.test',
     'sent', 'harness/source2.pdf', repeat('b', 64), 1, now() + interval '7 days', '00000000-0000-0000-0000-00008a000403', '00000000-0000-0000-0000-00008a000201'),
    ('00000000-0000-0000-0000-00008a000503', '00000000-0000-0000-0000-00008a000001', 'Harness', 'Portal Client', 't-phase8a-portal@example.test',
     'sent', 'harness/source3.pdf', repeat('c', 64), 1, now() + interval '7 days', '00000000-0000-0000-0000-00008a000404', '00000000-0000-0000-0000-00008a000201');
  update public.document_sign_envelopes set status = 'completed', completed_at = now()
  where id in ('00000000-0000-0000-0000-00008a000502', '00000000-0000-0000-0000-00008a000503');

  if (select status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000403') <> 'waived'
     or (select status from public.document_assignments where id = '00000000-0000-0000-0000-00008a000404') <> 'void' then
    raise exception 'FAIL T-8A-G1 envelope completion revived a waived/void assignment';
  end if;
end;
$$;

select 'PASS T-phase8a documents signing integrity (A1 A2 B1 B2 B3 C1 D1 E1 E2 E3 F1 F2 G1)' as result;

rollback;
