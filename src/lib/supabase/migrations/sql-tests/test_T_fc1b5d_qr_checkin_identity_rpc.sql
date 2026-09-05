-- FC-1B5D Phase A correction -- get_client_by_qr_token_for_checkin
-- live-RLS/RPC regression tests.
--
-- Proves, at the real Postgres level (not mocked):
--   1. a valid token + an active studio relationship (any role, incl.
--      instructor) returns exactly the approved minimal field set;
--   2. a wrong/nonexistent token returns nothing;
--   3. a valid token used with the WRONG target_studio_id (cross-studio
--      misuse) returns nothing, even for a caller who has a real role at
--      that other studio;
--   4. a caller with no active role at the target studio at all is denied
--      even with the exact correct token;
--   5. an anonymous (no auth.uid()) caller is denied;
--   6. the function cannot be used to enumerate clients -- a caller
--      cannot learn anything about whether a client exists from a wrong
--      token (always zero rows, no distinguishing error);
--   7. the returned row shape contains only the approved fields.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists. Run via `supabase db query --linked --file <this
-- file>` against DEV.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000005eXXXX (distinct from the 5c/5d blocks
-- already reserved by the P0 and earlier FC-1B5D test files).

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000005e0001', 'FC-1B5D QR Harness Studio A', 't-fc1b5d-qr-studio-a'),
  ('00000000-0000-0000-0000-0000005e0002', 'FC-1B5D QR Harness Studio B', 't-fc1b5d-qr-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005e1001', 't-fc1b5d-qr-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000005e1002', 't-fc1b5d-qr-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000005e1003', 't-fc1b5d-qr-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000005e1004', 't-fc1b5d-qr-noaccount@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000005e1001', 't-fc1b5d-qr-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000005e1002', 't-fc1b5d-qr-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000005e1003', 't-fc1b5d-qr-instructor-b@example.test'),
  ('00000000-0000-0000-0000-0000005e1004', 't-fc1b5d-qr-noaccount@example.test');

-- Instructor and front desk both have active roles at Studio A only.
-- The Studio B user has an active role at Studio B only. The
-- "noaccount" user has no active user_studio_roles row anywhere.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005e1001', '00000000-0000-0000-0000-0000005e0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005e1002', '00000000-0000-0000-0000-0000005e0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000005e1003', '00000000-0000-0000-0000-0000005e0002', 'instructor', true);

insert into public.clients (
  id, studio_id, first_name, last_name, email, phone, status, skill_level, photo_url, client_qr_token
) values
  ('00000000-0000-0000-0000-0000005e3001', '00000000-0000-0000-0000-0000005e0001', 'QrTest', 'ClientA', 'qrtest@example.test', '555-0100', 'active', 'intermediate', 'https://example.test/photo.jpg', 't-fc1b5d-qr-token-valid-aaaa'),
  ('00000000-0000-0000-0000-0000005e3002', '00000000-0000-0000-0000-0000005e0002', 'QrTest', 'ClientB', 'qrtestb@example.test', '555-0200', 'lead', 'beginner', null, 't-fc1b5d-qr-token-valid-bbbb');

-- ============================================================================
-- CASE 1: valid token + active instructor relationship at the same studio
-- -> returns exactly the approved minimal field set.
-- ============================================================================
do $$
declare
  v_row record;
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1001')::text, true);

  select count(*) into v_count
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 't-fc1b5d-qr-token-valid-aaaa');

  select * into v_row
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 't-fc1b5d-qr-token-valid-aaaa');

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-qr1: expected exactly 1 row for a valid token+relationship, got %', v_count;
  end if;

  if v_row.id is distinct from '00000000-0000-0000-0000-0000005e3001'::uuid
    or v_row.first_name is distinct from 'QrTest'
    or v_row.last_name is distinct from 'ClientA'
    or v_row.skill_level is distinct from 'intermediate'
  then
    raise exception 'FAIL T-fc1b5d-qr1: returned row does not match expected client/fields';
  end if;

  raise notice 'PASS T-fc1b5d-qr1: instructor with valid token + active relationship gets the correct minimal row';
end $$;

-- ============================================================================
-- CASE 2: front desk (a different, also-legitimate active role) also
-- succeeds -- this is a general staff capability, not instructor-specific
-- or CRM-tier-specific.
-- ============================================================================
do $$
declare
  v_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1002')::text, true);

  select exists (
    select 1 from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 't-fc1b5d-qr-token-valid-aaaa')
  ) into v_found;

  reset role;

  if not v_found then
    raise exception 'FAIL T-fc1b5d-qr2: front_desk with a valid token+relationship should succeed';
  end if;

  raise notice 'PASS T-fc1b5d-qr2: front_desk (general staff capability, not CRM-tier-restricted) succeeds';
end $$;

-- ============================================================================
-- CASE 3: wrong/nonexistent token -> zero rows.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1001')::text, true);

  select count(*) into v_count
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 'this-token-does-not-exist');

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-qr3: wrong token returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-qr3: wrong token returns nothing';
end $$;

-- ============================================================================
-- CASE 4: cross-studio misuse -- a valid token for Studio A's client,
-- called with Studio B as target_studio_id (even by a caller with a real
-- role at Studio B) -> zero rows, since the token's client does not
-- belong to Studio B.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1003')::text, true);

  select count(*) into v_count
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0002'::uuid, 't-fc1b5d-qr-token-valid-aaaa');

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-qr4: cross-studio token use returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-qr4: a Studio A client token cannot be used against Studio B, even by a real Studio B instructor';
end $$;

-- ============================================================================
-- CASE 5: correct token AND correct studio, but the caller has no active
-- role at that studio at all -> zero rows.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1004')::text, true);

  select count(*) into v_count
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 't-fc1b5d-qr-token-valid-aaaa');

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-qr5: caller with no active studio relationship returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-qr5: a valid token + correct studio is still denied without an active relationship there';
end $$;

-- ============================================================================
-- CASE 6: anonymous caller (the `anon` role) -> denied outright at the
-- grant level (EXECUTE was explicitly revoked from anon), not merely a
-- zero-row result -- a stronger guarantee than row-level denial. Even if
-- this were somehow bypassed, an authenticated-role call with no
-- auth.uid() JWT claim configured (equivalent to no session) is covered
-- by case 5's "no active relationship" logic, since a null auth.uid()
-- can never match any user_studio_roles.user_id.
-- ============================================================================
do $$
declare
  v_denied boolean := false;
begin
  set local role anon;

  begin
    perform count(*)
    from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 't-fc1b5d-qr-token-valid-aaaa');
  exception when insufficient_privilege then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5d-qr6: anon role should be denied EXECUTE outright (insufficient_privilege), not merely returned an empty result';
  end if;

  raise notice 'PASS T-fc1b5d-qr6: anon role is denied EXECUTE at the grant level';
end $$;

-- ============================================================================
-- CASE 7: enumeration resistance -- an authorized instructor probing
-- multiple wrong tokens gets uniformly zero rows with no distinguishing
-- signal between "no such client" and "client exists but token wrong"
-- (both simply return nothing; there is no separate existence check).
-- ============================================================================
do $$
declare
  v_count1 int;
  v_count2 int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005e1001')::text, true);

  select count(*) into v_count1
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 'probe-token-one');

  select count(*) into v_count2
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005e0001'::uuid, 'probe-token-two');

  reset role;

  if v_count1 <> 0 or v_count2 <> 0 then
    raise exception 'FAIL T-fc1b5d-qr7: probing with guessed tokens should never return rows';
  end if;

  raise notice 'PASS T-fc1b5d-qr7: guessed/probed tokens uniformly return nothing -- no enumeration signal';
end $$;

-- ============================================================================
-- CASE 8: output schema contains only the approved fields.
-- ============================================================================
do $$
declare
  v_returns text;
begin
  select pg_get_function_result(p.oid) into v_returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_client_by_qr_token_for_checkin';

  if v_returns is distinct from 'TABLE(id uuid, first_name text, last_name text, photo_url text, skill_level text)' then
    raise exception 'FAIL T-fc1b5d-qr8: unexpected return shape: %', v_returns;
  end if;

  if v_returns like '%email%' or v_returns like '%phone%' or v_returns like '%status%' or v_returns like '%notes%' or v_returns like '%referral%' then
    raise exception 'FAIL T-fc1b5d-qr8: return shape contains a field outside the approved check-in-safe set';
  end if;

  raise notice 'PASS T-fc1b5d-qr8: return shape contains only id/first_name/last_name/photo_url/skill_level';
end $$;

rollback;
