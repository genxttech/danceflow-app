-- LAUNCH-SEC-1C-A -- verified email proof + credential binding, live-Postgres
-- regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261008090000_launchsec1ca_verified_email_proof.sql. Whole script is one
-- transaction and is rolled back. Synthetic auth.users / auth.sessions /
-- auth.mfa_amr_claims rows only. now() is constant inside the transaction, so
-- "fresh" = now() and "stale" / "pre-bound" use explicit offsets.
--
-- Deterministic UUID block: 00000000-0000-0000-0000-000000caXXXX

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ca0001', 'Ca-U1@Example.Test '),
  ('00000000-0000-0000-0000-000000ca0002', 'ca-u2@example.test'),
  ('00000000-0000-0000-0000-000000ca0003', 'ca-u3@example.test');

-- U1 sessions
insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('00000000-0000-0000-0000-000000ca1001', '00000000-0000-0000-0000-000000ca0001', now() - interval '2 minutes', now(), null),  -- password
  ('00000000-0000-0000-0000-000000ca1002', '00000000-0000-0000-0000-000000ca0001', now() - interval '20 minutes', now(), null), -- stale otp
  ('00000000-0000-0000-0000-000000ca1003', '00000000-0000-0000-0000-000000ca0001', now() - interval '1 minute', now(), null),  -- fresh otp (first proof)
  ('00000000-0000-0000-0000-000000ca1004', '00000000-0000-0000-0000-000000ca0001', now() - interval '1 minute', now(), null),  -- fresh otp (retry proof)
  ('00000000-0000-0000-0000-000000ca1005', '00000000-0000-0000-0000-000000ca0001', now() - interval '1 minute', now(), now() - interval '1 second'), -- expired not_after
  ('00000000-0000-0000-0000-000000ca1006', '00000000-0000-0000-0000-000000ca0001', now() - interval '1 minute', now(), null),  -- unvalidated method
  ('00000000-0000-0000-0000-000000ca1007', '00000000-0000-0000-0000-000000ca0001', now(), now(), null),                         -- post-bound (created_at = bound_at)
  ('00000000-0000-0000-0000-000000ca2001', '00000000-0000-0000-0000-000000ca0002', now() - interval '1 minute', now(), null),  -- U2 fresh otp
  ('00000000-0000-0000-0000-000000ca3001', '00000000-0000-0000-0000-000000ca0003', now() - interval '1 minute', now(), null);  -- U3 fresh otp

insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1001', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1002', now() - interval '11 minutes', now() - interval '11 minutes', 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1003', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1004', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1005', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1006', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1006', now(), now(), 'magiclink'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1007', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca2001', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000ca3001', now(), now(), 'otp');

-- ============================================================================
-- SHAPE: table, grants, RLS, functions
-- ============================================================================

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.verified_email_identities'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.auth_email_change_markers'::regclass) then
    raise exception 'FAIL T-launchsec1ca-rls-enabled';
  end if;
  if exists (select 1 from pg_policy where polrelid in ('public.verified_email_identities'::regclass, 'public.auth_email_change_markers'::regclass)) then
    raise exception 'FAIL T-launchsec1ca-no-policies';
  end if;
  if has_table_privilege('anon', 'public.verified_email_identities', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.verified_email_identities', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.auth_email_change_markers', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.auth_email_change_markers', 'select,insert,update,delete') then
    raise exception 'FAIL T-launchsec1ca-table-grants';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('track_auth_email_change', '_launchsec1ca_live_session_id', '_launchsec1ca_mailbox_auth_at',
        '_launchsec1ca_current_email', '_record_email_proof', 'record_email_proof_web', 'record_email_proof_mobile',
        'my_verified_email', 'email_binding_status', 'complete_email_binding')
      and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres' or p.proconfig is distinct from array['search_path=""'])
  ) then
    raise exception 'FAIL T-launchsec1ca-function-definer-owner-search-path';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('record_email_proof_web', 'record_email_proof_mobile', 'my_verified_email', 'email_binding_status', 'complete_email_binding')
      and pronargs = case when p.proname = 'complete_email_binding' then 2 else 0 end) <> 5 then
    raise exception 'FAIL T-launchsec1ca-no-caller-inputs';
  end if;
  if has_function_privilege('anon', 'public.record_email_proof_web()', 'execute')
     or has_function_privilege('anon', 'public.my_verified_email()', 'execute')
     or has_function_privilege('anon', 'public.email_binding_status()', 'execute')
     or not has_function_privilege('authenticated', 'public.record_email_proof_web()', 'execute')
     or not has_function_privilege('authenticated', 'public.record_email_proof_mobile()', 'execute')
     or not has_function_privilege('authenticated', 'public.my_verified_email()', 'execute')
     or not has_function_privilege('authenticated', 'public.email_binding_status()', 'execute')
     or has_function_privilege('authenticated', 'public._record_email_proof(text)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_email_binding(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.complete_email_binding(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.complete_email_binding(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._launchsec1ca_live_session_id()', 'execute')
     or has_function_privilege('authenticated', 'public.track_auth_email_change()', 'execute') then
    raise exception 'FAIL T-launchsec1ca-execute-grants';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'launchsec1ca_track_email_change' and tgenabled = 'O') then
    raise exception 'FAIL T-launchsec1ca-email-change-trigger';
  end if;
  raise notice 'PASS T-launchsec1ca-shape-grants-rls';
end $$;

-- ============================================================================
-- DIRECT WRITES DENIED
-- ============================================================================

do $$
declare v_denied int := 0;
begin
  set local role anon;
  begin
    insert into public.verified_email_identities (user_id, email, method, source, credential_status, bound_at)
    values ('00000000-0000-0000-0000-000000ca0001', 'ca-u1@example.test', 'otp', 'web_callback', 'bound', now());
  exception when insufficient_privilege then v_denied := v_denied + 1;
  end;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000ca0001', 'role', 'authenticated', 'session_id', '00000000-0000-0000-0000-000000ca1003')::text, true);
  begin
    insert into public.verified_email_identities (user_id, email, method, source, credential_status, bound_at)
    values ('00000000-0000-0000-0000-000000ca0001', 'ca-u1@example.test', 'otp', 'web_callback', 'bound', now());
  exception when insufficient_privilege then v_denied := v_denied + 1;
  end;
  begin
    perform public._record_email_proof('web_callback');
  exception when insufficient_privilege then v_denied := v_denied + 1;
  end;
  begin
    perform public.complete_email_binding('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1003');
  exception when insufficient_privilege then v_denied := v_denied + 1;
  end;
  begin
    delete from public.auth_email_change_markers;
  exception when insufficient_privilege then v_denied := v_denied + 1;
  end;
  reset role;

  if v_denied <> 5 then
    raise exception 'FAIL T-launchsec1ca-direct-writes-denied: % of 5 denied', v_denied;
  end if;
  raise notice 'PASS T-launchsec1ca-direct-writes-denied';
end $$;

-- ============================================================================
-- PROOF CREATION RULES
-- ============================================================================

create function pg_temp.as_user(p_sub text, p_sid text, p_email text default null) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_sid, 'email', p_email)::text, true);
end $$;

do $$
declare r text; v_rows int;
begin
  set local role authenticated;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1001');
  r := public.record_email_proof_web();
  if r <> 'no_fresh_mailbox_auth' then raise exception 'FAIL T-launchsec1ca-password-amr-no-proof: %', r; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1002');
  r := public.record_email_proof_web();
  if r <> 'no_fresh_mailbox_auth' then raise exception 'FAIL T-launchsec1ca-stale-otp-no-proof: %', r; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1005');
  r := public.record_email_proof_web();
  if r <> 'no_live_session' then raise exception 'FAIL T-launchsec1ca-expired-session-no-proof: %', r; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca9999');
  r := public.record_email_proof_web();
  if r <> 'no_live_session' then raise exception 'FAIL T-launchsec1ca-missing-session-no-proof: %', r; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', 'not-a-uuid');
  r := public.record_email_proof_web();
  if r <> 'no_live_session' then raise exception 'FAIL T-launchsec1ca-malformed-session-no-proof: %', r; end if;

  -- U1 presenting U2's live fresh-otp session id: session does not belong to caller.
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca2001');
  r := public.record_email_proof_web();
  if r <> 'no_live_session' then raise exception 'FAIL T-launchsec1ca-wrong-session-no-proof: %', r; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1006');
  r := public.record_email_proof_web();
  if r <> 'no_fresh_mailbox_auth' then raise exception 'FAIL T-launchsec1ca-unvalidated-method-fails-closed: %', r; end if;

  reset role;
  select count(*) into v_rows from public.verified_email_identities;
  if v_rows <> 0 then raise exception 'FAIL T-launchsec1ca-rejected-proofs-wrote-rows: %', v_rows; end if;
  raise notice 'PASS T-launchsec1ca-proof-rejections (password, stale, expired, missing, malformed, wrong-session, unvalidated-method)';
end $$;

-- First proof -> binding_required with normalized current email, JWT email ignored.
do $$
declare r text; v record;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1003', 'ca-u2@example.test');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-helper-null-before-proof'; end if;
  if public.email_binding_status() <> 'unproven' then raise exception 'FAIL T-launchsec1ca-status-unproven'; end if;
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FAIL T-launchsec1ca-first-proof: %', r; end if;
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-helper-null-while-binding-required'; end if;
  if public.email_binding_status() <> 'binding_ready' then raise exception 'FAIL T-launchsec1ca-status-binding-ready'; end if;
  reset role;

  select * into v from public.verified_email_identities where user_id = '00000000-0000-0000-0000-000000ca0001';
  if v.email <> 'ca-u1@example.test' or v.credential_status <> 'binding_required'
     or v.binding_session_id <> '00000000-0000-0000-0000-000000ca1003' or v.method <> 'otp'
     or v.source <> 'web_callback' or v.bound_at is not null or v.first_verified_at is null then
    raise exception 'FAIL T-launchsec1ca-first-proof-row';
  end if;
  if exists (select 1 from public.verified_email_identities where email = 'ca-u2@example.test') then
    raise exception 'FAIL T-launchsec1ca-jwt-email-ignored';
  end if;
  raise notice 'PASS T-launchsec1ca-first-proof-binding-required';
end $$;

-- Another session of the same user (not the proof session) cannot bind.
do $$
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1001');
  if public.email_binding_status() <> 'binding_required' then raise exception 'FAIL T-launchsec1ca-other-session-not-binding-ready'; end if;
  reset role;
  raise notice 'PASS T-launchsec1ca-password-session-cannot-bind';
end $$;

-- Retry proof while binding_required moves binding to the new session.
do $$
declare r text; v record;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1004');
  r := public.record_email_proof_mobile();
  if r <> 'binding_required' then raise exception 'FAIL T-launchsec1ca-retry-proof: %', r; end if;
  if public.email_binding_status() <> 'binding_ready' then raise exception 'FAIL T-launchsec1ca-retry-binding-ready'; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1003');
  if public.email_binding_status() <> 'binding_required' then raise exception 'FAIL T-launchsec1ca-old-proof-session-superseded'; end if;
  reset role;
  select * into v from public.verified_email_identities where user_id = '00000000-0000-0000-0000-000000ca0001';
  if v.binding_session_id <> '00000000-0000-0000-0000-000000ca1004' or v.source <> 'mobile_app' then
    raise exception 'FAIL T-launchsec1ca-retry-row';
  end if;
  raise notice 'PASS T-launchsec1ca-retry-updates-binding-session';
end $$;

-- ============================================================================
-- BINDING COMPLETION
-- ============================================================================

do $$
begin
  if public.complete_email_binding('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1003') then
    raise exception 'FAIL T-launchsec1ca-complete-wrong-session';
  end if;
  if public.complete_email_binding('00000000-0000-0000-0000-000000ca0002', '00000000-0000-0000-0000-000000ca1004') then
    raise exception 'FAIL T-launchsec1ca-complete-wrong-user';
  end if;
  if not public.complete_email_binding('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1004') then
    raise exception 'FAIL T-launchsec1ca-complete-binding';
  end if;
  if public.complete_email_binding('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1004') then
    raise exception 'FAIL T-launchsec1ca-complete-binding-idempotent';
  end if;
  raise notice 'PASS T-launchsec1ca-complete-binding-exact-session';
end $$;

-- After binding: pre-bound sessions are not eligible, post-bound session is.
do $$
declare v text;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1001');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-helper-null-pre-bound-session'; end if;
  if public.email_binding_status() <> 'bound' then raise exception 'FAIL T-launchsec1ca-status-bound'; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1007', 'someone-else@example.test');
  v := public.my_verified_email();
  if v is distinct from 'ca-u1@example.test' then raise exception 'FAIL T-launchsec1ca-helper-bound-eligible: %', v; end if;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca8888');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-helper-null-missing-session'; end if;

  -- another user cannot obtain U1's verified email, even with U1's session id.
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0002', '00000000-0000-0000-0000-000000ca1007', 'ca-u1@example.test');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-no-cross-user'; end if;
  reset role;
  raise notice 'PASS T-launchsec1ca-helper-bound-session-gating';
end $$;

-- Repeat proof after bound does not downgrade.
do $$
declare r text; v record;
begin
  insert into auth.sessions (id, user_id, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000ca1008', '00000000-0000-0000-0000-000000ca0001', now(), now());
  insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
    (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1008', now(), now(), 'otp');
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1008');
  r := public.record_email_proof_web();
  if r <> 'bound' then raise exception 'FAIL T-launchsec1ca-repeat-proof-bound: %', r; end if;
  reset role;
  select * into v from public.verified_email_identities where user_id = '00000000-0000-0000-0000-000000ca0001';
  if v.credential_status <> 'bound' or v.bound_at is null then raise exception 'FAIL T-launchsec1ca-no-downgrade'; end if;
  raise notice 'PASS T-launchsec1ca-repeat-proof-no-downgrade';
end $$;

-- Revoked session (row deleted) loses eligibility immediately.
do $$
begin
  delete from auth.sessions where id = '00000000-0000-0000-0000-000000ca1007';
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1007');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-helper-null-revoked-session'; end if;
  reset role;
  raise notice 'PASS T-launchsec1ca-revoked-session-not-eligible';
end $$;

-- ============================================================================
-- EMAIL CHANGE
-- ============================================================================

do $$
declare r text;
begin
  -- U1 changes email: old bound proof cannot authorize the new email; the
  -- (pre-change) fresh otp session cannot create proof for the new email.
  update auth.users set email = 'ca-u1-new@example.test' where id = '00000000-0000-0000-0000-000000ca0001';
  if not exists (select 1 from public.auth_email_change_markers where user_id = '00000000-0000-0000-0000-000000ca0001') then
    raise exception 'FAIL T-launchsec1ca-marker-written';
  end if;
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1008', 'ca-u1@example.test');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-old-email-proof-no-authority'; end if;
  if public.email_binding_status() <> 'unproven' then raise exception 'FAIL T-launchsec1ca-new-email-unproven'; end if;
  r := public.record_email_proof_web();
  if r <> 'no_fresh_mailbox_auth' then raise exception 'FAIL T-launchsec1ca-pre-change-session-no-proof: %', r; end if;
  reset role;
  if not exists (select 1 from public.verified_email_identities where user_id = '00000000-0000-0000-0000-000000ca0001' and email = 'ca-u1@example.test' and credential_status = 'bound') then
    raise exception 'FAIL T-launchsec1ca-historical-proof-kept';
  end if;

  -- Changing back to the old email: the old bound row is stale (bound before
  -- the change) and cannot authorize; a post-change proof restarts binding.
  update auth.users set email = 'ca-u1@example.test' where id = '00000000-0000-0000-0000-000000ca0001';
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1008');
  if public.my_verified_email() is not null then raise exception 'FAIL T-launchsec1ca-stale-bound-after-change'; end if;
  reset role;
  insert into auth.sessions (id, user_id, created_at, updated_at) values
    ('00000000-0000-0000-0000-000000ca1009', '00000000-0000-0000-0000-000000ca0001', now(), now());
  insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
    (gen_random_uuid(), '00000000-0000-0000-0000-000000ca1009', now() + interval '40 seconds', now() + interval '40 seconds', 'otp');
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0001', '00000000-0000-0000-0000-000000ca1009');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FAIL T-launchsec1ca-post-change-proof-restarts-binding: %', r; end if;
  reset role;

  -- U3: email change completed by the confirmation session itself (otp at the
  -- change instant) cannot create proof for the new address.
  update auth.users set email = 'ca-u3-new@example.test' where id = '00000000-0000-0000-0000-000000ca0003';
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000ca0003', '00000000-0000-0000-0000-000000ca3001');
  r := public.record_email_proof_web();
  if r <> 'no_fresh_mailbox_auth' then raise exception 'FAIL T-launchsec1ca-email-change-session-no-proof: %', r; end if;
  reset role;
  raise notice 'PASS T-launchsec1ca-email-change-requires-fresh-proof';
end $$;

-- ============================================================================
-- 1C-0 / LEDGER UNCHANGED
-- ============================================================================

do $$
begin
  if (select string_agg(x::text, ',' order by x::text) from pg_proc p, unnest(p.proacl) x
      where p.oid = 'public.link_portal_client_by_email(uuid, text)'::regprocedure)
     <> 'postgres=X/postgres,service_role=X/postgres' then
    raise exception 'FAIL T-launchsec1ca-1c0-link-acl';
  end if;
  if (select string_agg(x::text, ',' order by x::text) from pg_proc p, unnest(p.proacl) x
      where p.oid = 'public.accept_pending_team_invitations(text)'::regprocedure)
     <> 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres' then
    raise exception 'FAIL T-launchsec1ca-1c0-team-acl';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger') <> 4
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger'
                    and policyname = 'Linked portal users can read their account ledger'
                    and qual ilike '%user_has_client_portal_access(studio_id, client_id)%')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_account_ledger'
                and (qual ilike '%email%' or coalesce(with_check, '') ilike '%email%')) then
    raise exception 'FAIL T-launchsec1ca-ledger-unchanged';
  end if;
  raise notice 'PASS T-launchsec1ca-1c0-and-ledger-unchanged';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec1ca TESTS PASSED';
end $$;

rollback;
