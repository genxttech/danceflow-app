-- LAUNCH-SEC-1C-B -- verified-email enforcement, live-Postgres regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261008090000 (1C-A) and 20261009090000 (1C-B). One transaction, rolled
-- back. Synthetic rows only. Bound identities are produced through the real
-- 1C-A functions (record_email_proof_web + complete_email_binding), never by
-- inserting proof rows. now() is constant inside the transaction.
--
-- Deterministic UUID block: 00000000-0000-0000-0000-000000cbXXXX

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000cb0001', 'LAUNCH-SEC-1C-B Studio', 't-launchsec1cb-a');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000cb1001', 'cb-v@example.test'),      -- verified + bound
  ('00000000-0000-0000-0000-000000cb1002', 'cb-u@example.test'),      -- no proof
  ('00000000-0000-0000-0000-000000cb1003', 'cb-b@example.test'),      -- binding_required only
  ('00000000-0000-0000-0000-000000cb1004', 'cb-dis@example.test'),    -- verified + bound, disconnected client
  ('00000000-0000-0000-0000-000000cb1005', 'cb-other@example.test'),  -- existing linked relationship
  ('00000000-0000-0000-0000-000000cb1006', 'cb-inviter@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-000000cb1001', 'cb-v@example.test', 'CB Verified'),
  ('00000000-0000-0000-0000-000000cb1002', 'cb-u@example.test', 'CB Unverified'),
  ('00000000-0000-0000-0000-000000cb1003', 'cb-b@example.test', 'CB Binding'),
  ('00000000-0000-0000-0000-000000cb1006', 'cb-inviter@example.test', 'CB Inviter')
on conflict (id) do nothing;

-- sessions: *a = proof session (created before binding), *b = post-bound session
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000cba01a', '00000000-0000-0000-0000-000000cb1001', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-000000cba01b', '00000000-0000-0000-0000-000000cb1001', now(), now()),
  ('00000000-0000-0000-0000-000000cba02b', '00000000-0000-0000-0000-000000cb1002', now(), now()),
  ('00000000-0000-0000-0000-000000cba03a', '00000000-0000-0000-0000-000000cb1003', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-000000cba04a', '00000000-0000-0000-0000-000000cb1004', now() - interval '1 minute', now());

insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  (gen_random_uuid(), '00000000-0000-0000-0000-000000cba01a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000cba01b', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000cba02b', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000cba03a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000cba04a', now(), now(), 'otp');

create function pg_temp.as_user(p_sub text, p_sid text, p_email text default null) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_sid, 'email', p_email)::text, true);
end $$;

-- Produce proofs through the real 1C-A path, then bind cb-v and cb-dis.
do $$
declare r text;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1001', '00000000-0000-0000-0000-000000cba01a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE cb-v proof: %', r; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1003', '00000000-0000-0000-0000-000000cba03a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE cb-b proof: %', r; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1004', '00000000-0000-0000-0000-000000cba04a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE cb-dis proof: %', r; end if;
  reset role;
  if not public.complete_email_binding('00000000-0000-0000-0000-000000cb1001', '00000000-0000-0000-0000-000000cba01a')
     or not public.complete_email_binding('00000000-0000-0000-0000-000000cb1004', '00000000-0000-0000-0000-000000cba04a') then
    raise exception 'FIXTURE binding failed';
  end if;
end $$;

insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-000000cb2001', '00000000-0000-0000-0000-000000cb0001', 'T', 'Verified', 'cb-v@example.test', 'active'),
  ('00000000-0000-0000-0000-000000cb2002', '00000000-0000-0000-0000-000000cb0001', 'T', 'Unverified', 'cb-u@example.test', 'active'),
  ('00000000-0000-0000-0000-000000cb2004', '00000000-0000-0000-0000-000000cb0001', 'T', 'Disconnected', 'cb-dis@example.test', 'active'),
  ('00000000-0000-0000-0000-000000cb2005', '00000000-0000-0000-0000-000000cb0001', 'T', 'Other', 'cb-other@example.test', 'active');

insert into public.client_account_links
  (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email,
   linked_at, claimed_at, disconnected_at, invite_expires_at, created_at, updated_at) values
  -- staff invitations awaiting claim
  ('00000000-0000-0000-0000-000000cb3001', '00000000-0000-0000-0000-000000cb0001', '00000000-0000-0000-0000-000000cb2001',
   null, 'invited', 'self', true, 'studio', 'cb-v@example.test', null, null, null, now() + interval '7 days', now(), now()),
  ('00000000-0000-0000-0000-000000cb3002', '00000000-0000-0000-0000-000000cb0001', '00000000-0000-0000-0000-000000cb2002',
   null, 'invited', 'self', true, 'studio', 'cb-u@example.test', null, null, null, now() + interval '7 days', now(), now()),
  -- disconnected relationship, no fresh invitation
  ('00000000-0000-0000-0000-000000cb3004', '00000000-0000-0000-0000-000000cb0001', '00000000-0000-0000-0000-000000cb2004',
   '00000000-0000-0000-0000-000000cb1004', 'disconnected', 'self', false, 'studio', 'cb-dis@example.test',
   now() - interval '30 days', now() - interval '30 days', now() - interval '1 day', null, now() - interval '30 days', now()),
  -- existing linked relationship (must keep working)
  ('00000000-0000-0000-0000-000000cb3005', '00000000-0000-0000-0000-000000cb0001', '00000000-0000-0000-0000-000000cb2005',
   '00000000-0000-0000-0000-000000cb1005', 'linked', 'self', true, 'studio', 'cb-other@example.test',
   now() - interval '30 days', now() - interval '30 days', null, null, now() - interval '30 days', now());

insert into public.team_invitations (id, studio_id, email, role, invited_by, expires_at) values
  ('00000000-0000-0000-0000-000000cb4001', '00000000-0000-0000-0000-000000cb0001', 'cb-v@example.test', 'front_desk', '00000000-0000-0000-0000-000000cb1006', now() + interval '14 days'),
  ('00000000-0000-0000-0000-000000cb4002', '00000000-0000-0000-0000-000000cb0001', 'cb-u@example.test', 'front_desk', '00000000-0000-0000-0000-000000cb1006', now() + interval '14 days'),
  ('00000000-0000-0000-0000-000000cb4003', '00000000-0000-0000-0000-000000cb0001', 'cb-b@example.test', 'front_desk', '00000000-0000-0000-0000-000000cb1006', now() + interval '14 days');

-- ============================================================================
-- SHAPE
-- ============================================================================

do $$
begin
  if to_regprocedure('public.link_portal_client_by_email(uuid, text)') is not null then
    raise exception 'FAIL T-launchsec1cb-legacy-link-rpc-dropped';
  end if;
  if has_function_privilege('authenticated', 'public.verified_email_for_user(uuid)', 'execute')
     or has_function_privilege('anon', 'public.verified_email_for_user(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.verified_email_for_user(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_client_account_invitation(uuid, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.claim_client_account_invitation(uuid, text, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_client_account_invitation(uuid, text, uuid)', 'execute')
     or has_function_privilege('service_role', 'public._claim_client_account_invitation_unverified(uuid, text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._claim_client_account_invitation_unverified(uuid, text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.accept_pending_team_invitations(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.accept_pending_team_invitations(text)', 'execute') then
    raise exception 'FAIL T-launchsec1cb-execute-grants';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.accept_pending_team_invitations(text)'::regprocedure
                 and prosrc like '%public.my_verified_email()%' and prosrc not like '%auth.jwt()%') then
    raise exception 'FAIL T-launchsec1cb-team-rpc-uses-verified-email';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('verified_email_for_user', 'claim_client_account_invitation', '_claim_client_account_invitation_unverified')
      and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres')
  ) then
    raise exception 'FAIL T-launchsec1cb-definer-owner';
  end if;
  raise notice 'PASS T-launchsec1cb-shape-and-grants';
end $$;

-- ============================================================================
-- VERIFIED EMAIL FOR USER (service-role helper)
-- ============================================================================

do $$
begin
  if public.verified_email_for_user('00000000-0000-0000-0000-000000cb1001') is distinct from 'cb-v@example.test' then
    raise exception 'FAIL T-launchsec1cb-helper-bound';
  end if;
  if public.verified_email_for_user('00000000-0000-0000-0000-000000cb1002') is not null
     or public.verified_email_for_user('00000000-0000-0000-0000-000000cb1003') is not null
     or public.verified_email_for_user('00000000-0000-0000-0000-000000cb9999') is not null then
    raise exception 'FAIL T-launchsec1cb-helper-null-unproven-or-unbound';
  end if;
  raise notice 'PASS T-launchsec1cb-verified-email-for-user';
end $$;

-- ============================================================================
-- TEAM INVITATIONS
-- ============================================================================

do $$
declare v int; v_roles int;
begin
  set local role authenticated;
  -- unverified user, even with a JWT email claim naming the verified invitee
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1002', '00000000-0000-0000-0000-000000cba02b', 'cb-v@example.test');
  v := public.accept_pending_team_invitations('cb-v@example.test');
  if v <> 0 then raise exception 'FAIL T-launchsec1cb-team-jwt-email-not-proof: %', v; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1002', '00000000-0000-0000-0000-000000cba02b', 'cb-u@example.test');
  v := public.accept_pending_team_invitations('cb-u@example.test');
  if v <> 0 then raise exception 'FAIL T-launchsec1cb-team-unverified-denied: %', v; end if;
  -- binding_required only
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1003', '00000000-0000-0000-0000-000000cba03a', 'cb-b@example.test');
  v := public.accept_pending_team_invitations('cb-b@example.test');
  if v <> 0 then raise exception 'FAIL T-launchsec1cb-team-binding-required-denied: %', v; end if;
  -- verified user on a PRE-bound session (revoked by binding in real life)
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1001', '00000000-0000-0000-0000-000000cba01a', 'cb-v@example.test');
  v := public.accept_pending_team_invitations('cb-v@example.test');
  if v <> 0 then raise exception 'FAIL T-launchsec1cb-team-pre-bound-session-denied: %', v; end if;
  -- verified user on a post-bound live session
  perform pg_temp.as_user('00000000-0000-0000-0000-000000cb1001', '00000000-0000-0000-0000-000000cba01b', 'cb-v@example.test');
  v := public.accept_pending_team_invitations('ignored@example.test');
  if v <> 1 then raise exception 'FAIL T-launchsec1cb-team-verified-accepts: %', v; end if;
  reset role;

  select count(*) into v_roles from public.user_studio_roles where studio_id = '00000000-0000-0000-0000-000000cb0001';
  if v_roles <> 1 or not exists (select 1 from public.user_studio_roles where studio_id = '00000000-0000-0000-0000-000000cb0001'
                                  and user_id = '00000000-0000-0000-0000-000000cb1001' and role = 'front_desk' and active) then
    raise exception 'FAIL T-launchsec1cb-team-role-grant-exact: %', v_roles;
  end if;
  if exists (select 1 from public.team_invitations where id in ('00000000-0000-0000-0000-000000cb4002', '00000000-0000-0000-0000-000000cb4003') and accepted_at is not null) then
    raise exception 'FAIL T-launchsec1cb-team-unverified-invites-still-pending';
  end if;
  raise notice 'PASS T-launchsec1cb-team-invitations';
end $$;

-- ============================================================================
-- CLIENT ACCOUNT CLAIMS
-- ============================================================================

do $$
declare v int;
begin
  select count(*) into v from public.claim_client_account_invitation('00000000-0000-0000-0000-000000cb1002', 'cb-u@example.test', null);
  if v <> 0 or exists (select 1 from public.client_account_links where id = '00000000-0000-0000-0000-000000cb3002' and status <> 'invited') then
    raise exception 'FAIL T-launchsec1cb-claim-unverified-denied';
  end if;

  select count(*) into v from public.claim_client_account_invitation('00000000-0000-0000-0000-000000cb1001', 'cb-u@example.test', null);
  if v <> 0 then raise exception 'FAIL T-launchsec1cb-claim-other-email-denied'; end if;

  select count(*) into v from public.claim_client_account_invitation('00000000-0000-0000-0000-000000cb1001', ' CB-V@Example.test ', null);
  if v <> 1 or not exists (select 1 from public.client_account_links where id = '00000000-0000-0000-0000-000000cb3001'
                            and status = 'linked' and user_id = '00000000-0000-0000-0000-000000cb1001') then
    raise exception 'FAIL T-launchsec1cb-claim-verified-links';
  end if;

  -- disconnected relationship is NOT revived by a verified email match alone
  select count(*) into v from public.claim_client_account_invitation('00000000-0000-0000-0000-000000cb1004', 'cb-dis@example.test', null);
  if v <> 0 or not exists (select 1 from public.client_account_links where id = '00000000-0000-0000-0000-000000cb3004' and status = 'disconnected') then
    raise exception 'FAIL T-launchsec1cb-disconnected-not-revived';
  end if;

  -- a fresh staff invitation is the explicit restore artifact
  insert into public.client_account_links
    (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, invite_expires_at, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000cb3006', '00000000-0000-0000-0000-000000cb0001', '00000000-0000-0000-0000-000000cb2004',
          null, 'invited', 'guardian', false, 'studio', 'cb-dis@example.test', now() + interval '7 days', now(), now());
  select count(*) into v from public.claim_client_account_invitation('00000000-0000-0000-0000-000000cb1004', 'cb-dis@example.test', null);
  if v <> 1 or not exists (select 1 from public.client_account_links where client_id = '00000000-0000-0000-0000-000000cb2004'
                            and user_id = '00000000-0000-0000-0000-000000cb1004' and status = 'linked') then
    raise exception 'FAIL T-launchsec1cb-staff-invite-restores';
  end if;

  -- existing linked relationship untouched
  if not exists (select 1 from public.client_account_links where id = '00000000-0000-0000-0000-000000cb3005' and status = 'linked'
                 and user_id = '00000000-0000-0000-0000-000000cb1005') then
    raise exception 'FAIL T-launchsec1cb-existing-link-unchanged';
  end if;
  raise notice 'PASS T-launchsec1cb-client-claims';
end $$;

-- ============================================================================
-- EMAIL CHANGE INVALIDATES THE SERVICE-ROLE HELPER
-- ============================================================================

do $$
begin
  update auth.users set email = 'cb-v-new@example.test' where id = '00000000-0000-0000-0000-000000cb1001';
  if public.verified_email_for_user('00000000-0000-0000-0000-000000cb1001') is not null then
    raise exception 'FAIL T-launchsec1cb-helper-null-after-email-change';
  end if;
  update auth.users set email = 'cb-v@example.test' where id = '00000000-0000-0000-0000-000000cb1001';
  if public.verified_email_for_user('00000000-0000-0000-0000-000000cb1001') is not null then
    raise exception 'FAIL T-launchsec1cb-helper-null-after-change-back';
  end if;
  raise notice 'PASS T-launchsec1cb-email-change-invalidates';
end $$;

-- ============================================================================
-- 1C-0 LEDGER UNCHANGED
-- ============================================================================

do $$
begin
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger') <> 4
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger'
                    and policyname = 'Linked portal users can read their account ledger'
                    and qual ilike '%user_has_client_portal_access(studio_id, client_id)%')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger'
                and (qual ilike '%email%' or coalesce(with_check, '') ilike '%email%')) then
    raise exception 'FAIL T-launchsec1cb-ledger-unchanged';
  end if;
  raise notice 'PASS T-launchsec1cb-ledger-unchanged';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec1cb TESTS PASSED';
end $$;

rollback;
