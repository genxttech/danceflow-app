-- FC-1B5D Phase B -- public.clients RLS tightening live-Postgres tests.
--
-- Proves, against the real post-migration DEV catalog (not mocked):
--   1. CRM roles (studio_owner, studio_admin, front_desk) retain full
--      direct SELECT/INSERT/UPDATE/DELETE on clients at their own studio;
--   2. platform_admin (with no ordinary studio role at all) retains full
--      access via the standalone platform-admin OR-clause;
--   3. an active instructor can no longer see, insert, update, or delete
--      clients directly, but can still reach the three Phase A controlled
--      interfaces (teaching RPC, booking-search RPC, QR RPC);
--   4. an active independent_instructor gets no general host-studio
--      roster/direct-mutation access, but their own linked portal-self
--      client row remains readable, and unrelated host clients stay
--      denied;
--   5. a hybrid person (ordinary instructor teaching relationship at one
--      studio + a separate independent_instructor identity at another)
--      only ever sees the host client they actually teach, never an
--      unrelated host client, and their floor-rental identity grants no
--      general CRM access;
--   6. portal/self access is unaffected: a linked client user reads their
--      own row, is denied a different client at the same studio, and is
--      denied a client at a different studio entirely;
--   7. the policy inventory itself matches the intended final state.
--
-- PostgreSQL RLS semantics deliberately exercised precisely, not assumed:
--   - a denied direct SELECT returns zero rows, it does not raise;
--   - a denied UPDATE/DELETE silently affects zero rows (USING filters
--     which existing rows are even visible to the statement -- there is
--     nothing left to update/delete, so no error is raised);
--   - a denied INSERT DOES raise (42501 insufficient_privilege / "new row
--     violates row-level security policy"), because WITH CHECK is
--     evaluated against the brand-new row being created, which has no
--     "invisible, so skip it" fallback the way an existing row does.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists on DEV.
--
-- Deterministic UUID block reserved for this harness (disjoint from the
-- 5c/5d/5e blocks already used by prior FC-1B5D test files):
-- 00000000-0000-0000-0000-0000005fXXXX.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000005f0001', 'FC-1B5D Phase B Studio A (host)', 't-fc1b5d-pb-studio-a'),
  ('00000000-0000-0000-0000-0000005f0002', 'FC-1B5D Phase B Studio B (independent)', 't-fc1b5d-pb-studio-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000005f1001', 't-fc1b5d-pb-owner@example.test'),
  ('00000000-0000-0000-0000-0000005f1002', 't-fc1b5d-pb-admin@example.test'),
  ('00000000-0000-0000-0000-0000005f1003', 't-fc1b5d-pb-frontdesk@example.test'),
  ('00000000-0000-0000-0000-0000005f1004', 't-fc1b5d-pb-platformadmin@example.test'),
  ('00000000-0000-0000-0000-0000005f1005', 't-fc1b5d-pb-instructor@example.test'),
  ('00000000-0000-0000-0000-0000005f1006', 't-fc1b5d-pb-independent@example.test'),
  ('00000000-0000-0000-0000-0000005f1007', 't-fc1b5d-pb-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000005f1008', 't-fc1b5d-pb-portaluser@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000005f1001', 't-fc1b5d-pb-owner@example.test', null),
  ('00000000-0000-0000-0000-0000005f1002', 't-fc1b5d-pb-admin@example.test', null),
  ('00000000-0000-0000-0000-0000005f1003', 't-fc1b5d-pb-frontdesk@example.test', null),
  ('00000000-0000-0000-0000-0000005f1004', 't-fc1b5d-pb-platformadmin@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000005f1005', 't-fc1b5d-pb-instructor@example.test', null),
  ('00000000-0000-0000-0000-0000005f1006', 't-fc1b5d-pb-independent@example.test', null),
  ('00000000-0000-0000-0000-0000005f1007', 't-fc1b5d-pb-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000005f1008', 't-fc1b5d-pb-portaluser@example.test', null);

-- Note: platform_admin_user intentionally gets NO user_studio_roles row at
-- all -- their access must come solely from the platform-admin OR-clause.
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000005f1001', '00000000-0000-0000-0000-0000005f0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000005f1002', '00000000-0000-0000-0000-0000005f0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000005f1003', '00000000-0000-0000-0000-0000005f0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000005f1005', '00000000-0000-0000-0000-0000005f0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005f1006', '00000000-0000-0000-0000-0000005f0002', 'independent_instructor', true),
  ('00000000-0000-0000-0000-0000005f1007', '00000000-0000-0000-0000-0000005f0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000005f1007', '00000000-0000-0000-0000-0000005f0002', 'independent_instructor', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000005f2001', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f1005', 'PhaseB', 'InstructorOne', true),
  ('00000000-0000-0000-0000-0000005f2002', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f1007', 'PhaseB', 'HybridOne', true);

insert into public.clients (
  id, studio_id, first_name, last_name, email, phone, status, skill_level, photo_url, client_qr_token
) values
  ('00000000-0000-0000-0000-0000005f3001', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'CrmClientOne', 'pb-crm1@example.test', '555-0001', 'active', 'intermediate', null, null),
  ('00000000-0000-0000-0000-0000005f3002', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'TeachingClient', 'pb-teach@example.test', '555-0002', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3004', '00000000-0000-0000-0000-0000005f0001', 'Zephyrine', 'Wildwood', 'pb-firstbook@example.test', '555-0004', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3005', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'QrClient', 'pb-qr@example.test', '555-0005', 'active', 'advanced', 'https://example.test/pb-qr.jpg', 't-fc1b5d-pb-qr-token-aaaa'),
  ('00000000-0000-0000-0000-0000005f3006', '00000000-0000-0000-0000-0000005f0002', 'PhaseB', 'IndependentOwnClient', 'pb-indep@example.test', '555-0006', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3012', '00000000-0000-0000-0000-0000005f0002', 'PhaseB', 'IndependentUnrelatedClient', 'pb-indep-unrelated@example.test', '555-0012', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3007', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'HybridTeachingClient', 'pb-hybteach@example.test', '555-0007', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3008', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'UnrelatedHostClient', 'pb-unrelated@example.test', '555-0008', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3009', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'PortalSelfClient', 'pb-portal@example.test', '555-0009', 'active', 'beginner', null, null),
  ('00000000-0000-0000-0000-0000005f3010', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'OtherSameStudioClient', 'pb-othersame@example.test', '555-0010', 'active', 'beginner', null, null);

insert into public.client_account_links (user_id, studio_id, client_id, status) values
  ('00000000-0000-0000-0000-0000005f1006', '00000000-0000-0000-0000-0000005f0002', '00000000-0000-0000-0000-0000005f3006', 'linked'),
  ('00000000-0000-0000-0000-0000005f1008', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3009', 'linked');

insert into public.appointments (
  id, studio_id, client_id, instructor_id, appointment_type, title, status, starts_at, ends_at
) values
  ('00000000-0000-0000-0000-0000005f4001', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3002', '00000000-0000-0000-0000-0000005f2001', 'private_lesson', 'PhaseB teaching test', 'scheduled', now() + interval '1 day', now() + interval '1 day' + interval '1 hour'),
  ('00000000-0000-0000-0000-0000005f4002', '00000000-0000-0000-0000-0000005f0001', '00000000-0000-0000-0000-0000005f3007', '00000000-0000-0000-0000-0000005f2002', 'private_lesson', 'PhaseB hybrid teaching test', 'scheduled', now() + interval '1 day', now() + interval '1 day' + interval '1 hour');

-- ============================================================================
-- CASE pb1-pb3: CRM roles retain full direct SELECT/INSERT/UPDATE/DELETE.
-- ============================================================================
do $$
declare
  v_count int;
  v_rows int;
begin
  -- studio_owner
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1001')::text, true);

  select count(*) into v_count from public.clients where studio_id = '00000000-0000-0000-0000-0000005f0001';
  if v_count < 1 then
    raise exception 'FAIL T-fc1b5d-pb1: studio_owner direct SELECT returned % rows, expected at least 1', v_count;
  end if;

  insert into public.clients (id, studio_id, first_name, last_name, status)
    values ('00000000-0000-0000-0000-0000005f3101', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'InsertByOwner', 'active');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb1: studio_owner INSERT should succeed';
  end if;

  update public.clients set first_name = 'PhaseBUpdated' where id = '00000000-0000-0000-0000-0000005f3101';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb1: studio_owner UPDATE should affect 1 row, affected %', v_rows;
  end if;

  delete from public.clients where id = '00000000-0000-0000-0000-0000005f3101';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb1: studio_owner DELETE should affect 1 row, affected %', v_rows;
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d-pb1: studio_owner retains full SELECT/INSERT/UPDATE/DELETE';
end $$;

do $$
declare
  v_count int;
  v_rows int;
begin
  -- studio_admin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1002')::text, true);

  select count(*) into v_count from public.clients where studio_id = '00000000-0000-0000-0000-0000005f0001';
  if v_count < 1 then
    raise exception 'FAIL T-fc1b5d-pb2: studio_admin direct SELECT returned % rows, expected at least 1', v_count;
  end if;

  insert into public.clients (id, studio_id, first_name, last_name, status)
    values ('00000000-0000-0000-0000-0000005f3102', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'InsertByAdmin', 'active');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb2: studio_admin INSERT should succeed';
  end if;

  update public.clients set first_name = 'PhaseBUpdated' where id = '00000000-0000-0000-0000-0000005f3102';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb2: studio_admin UPDATE should affect 1 row, affected %', v_rows;
  end if;

  delete from public.clients where id = '00000000-0000-0000-0000-0000005f3102';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb2: studio_admin DELETE should affect 1 row, affected %', v_rows;
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d-pb2: studio_admin retains full SELECT/INSERT/UPDATE/DELETE';
end $$;

do $$
declare
  v_count int;
  v_rows int;
begin
  -- front_desk
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1003')::text, true);

  select count(*) into v_count from public.clients where studio_id = '00000000-0000-0000-0000-0000005f0001';
  if v_count < 1 then
    raise exception 'FAIL T-fc1b5d-pb3: front_desk direct SELECT returned % rows, expected at least 1', v_count;
  end if;

  insert into public.clients (id, studio_id, first_name, last_name, status)
    values ('00000000-0000-0000-0000-0000005f3103', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'InsertByFrontDesk', 'active');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb3: front_desk INSERT should succeed';
  end if;

  update public.clients set first_name = 'PhaseBUpdated' where id = '00000000-0000-0000-0000-0000005f3103';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb3: front_desk UPDATE should affect 1 row, affected %', v_rows;
  end if;

  delete from public.clients where id = '00000000-0000-0000-0000-0000005f3103';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb3: front_desk DELETE should affect 1 row, affected %', v_rows;
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d-pb3: front_desk retains full SELECT/INSERT/UPDATE/DELETE';
end $$;

-- ============================================================================
-- CASE pb4: platform_admin (no ordinary studio role at all) retains full
-- access via the standalone platform-admin OR-clause.
-- ============================================================================
do $$
declare
  v_count int;
  v_rows int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1004')::text, true);

  select count(*) into v_count from public.clients where studio_id = '00000000-0000-0000-0000-0000005f0001';
  if v_count < 1 then
    raise exception 'FAIL T-fc1b5d-pb4: platform_admin direct SELECT returned % rows, expected at least 1', v_count;
  end if;

  insert into public.clients (id, studio_id, first_name, last_name, status)
    values ('00000000-0000-0000-0000-0000005f3104', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'InsertByPlatformAdmin', 'active');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb4: platform_admin INSERT should succeed';
  end if;

  delete from public.clients where id = '00000000-0000-0000-0000-0000005f3104';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'FAIL T-fc1b5d-pb4: platform_admin DELETE should affect 1 row, affected %', v_rows;
  end if;

  reset role;
  raise notice 'PASS T-fc1b5d-pb4: platform_admin retains full access with no ordinary studio role at all';
end $$;

-- ============================================================================
-- CASE pb5-pb8: active instructor direct table access is fully denied.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  select count(*) into v_count from public.clients where studio_id = '00000000-0000-0000-0000-0000005f0001';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb5: instructor direct SELECT returned % rows, expected 0', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb5: instructor direct SELECT returns zero rows (denied, not merely filtered)';
end $$;

do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  begin
    insert into public.clients (id, studio_id, first_name, last_name, status)
      values ('00000000-0000-0000-0000-0000005f3105', '00000000-0000-0000-0000-0000005f0001', 'PhaseB', 'InsertByInstructor', 'active');
  exception when insufficient_privilege then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5d-pb6: instructor INSERT should have been denied by RLS (WITH CHECK violation)';
  end if;

  raise notice 'PASS T-fc1b5d-pb6: instructor INSERT denied with insufficient_privilege (new row violates row-level security policy)';
end $$;

do $$
declare
  v_rows int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  update public.clients set first_name = 'ShouldNotChange' where id = '00000000-0000-0000-0000-0000005f3001';
  get diagnostics v_rows = row_count;

  reset role;

  if v_rows <> 0 then
    raise exception 'FAIL T-fc1b5d-pb7: instructor UPDATE should silently affect 0 rows (USING filters the row out), affected %', v_rows;
  end if;

  raise notice 'PASS T-fc1b5d-pb7: instructor UPDATE affects zero rows (no exception, USING excludes the row entirely)';
end $$;

do $$
declare
  v_rows int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  delete from public.clients where id = '00000000-0000-0000-0000-0000005f3001';
  get diagnostics v_rows = row_count;

  reset role;

  if v_rows <> 0 then
    raise exception 'FAIL T-fc1b5d-pb8: instructor DELETE should silently affect 0 rows, affected %', v_rows;
  end if;

  raise notice 'PASS T-fc1b5d-pb8: instructor DELETE affects zero rows (no exception, USING excludes the row entirely)';
end $$;

-- ============================================================================
-- CASE pb9-pb11: instructor replacement capabilities still work.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  select count(*) into v_count
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005f0001'::uuid, null);

  select * into v_row
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005f0001'::uuid, '00000000-0000-0000-0000-0000005f3002'::uuid);

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb9: instructor teaching RPC returned % rows, expected exactly 1', v_count;
  end if;

  if v_row.id is distinct from '00000000-0000-0000-0000-0000005f3002'::uuid then
    raise exception 'FAIL T-fc1b5d-pb9: teaching RPC did not return the expected assigned client';
  end if;

  raise notice 'PASS T-fc1b5d-pb9: get_teaching_clients_for_instructor still works post-Phase-B';
end $$;

do $$
declare
  v_found boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  select exists (
    select 1 from public.search_bookable_clients_for_instructor('00000000-0000-0000-0000-0000005f0001'::uuid, 'Zephyr', 20)
    where id = '00000000-0000-0000-0000-0000005f3004'::uuid
  ) into v_found;

  reset role;

  if not v_found then
    raise exception 'FAIL T-fc1b5d-pb10: instructor booking-search RPC did not find the first-time client';
  end if;

  raise notice 'PASS T-fc1b5d-pb10: search_bookable_clients_for_instructor still works post-Phase-B';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1005')::text, true);

  select count(*) into v_count
  from public.get_client_by_qr_token_for_checkin('00000000-0000-0000-0000-0000005f0001'::uuid, 't-fc1b5d-pb-qr-token-aaaa');

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb11: instructor QR RPC returned % rows for a valid token, expected exactly 1', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb11: get_client_by_qr_token_for_checkin still works post-Phase-B';
end $$;

-- ============================================================================
-- CASE pb12-pb16: independent_instructor -- general roster denied while
-- their exact portal-linked self row remains readable (proven as two
-- separate, positive assertions rather than a single ambiguous count),
-- direct mutation denied, and an unrelated cross-studio host client denied.
--
-- Fixture note: 00000000...5f3006 (IndependentOwnClient) is deliberately
-- linked to this same user via client_account_links(status='linked') --
-- that is a legitimate, intentional grant via the portal-self policy, not
-- a leak of the ALL/broad-access policy being tested here. A first version
-- of this test asserted a raw "count of clients at studio_b = 0" for this
-- user, which is wrong: it collided with the portal-self row and produced
-- a false failure. This version seeds a SECOND, unrelated client at the
-- same studio_b (00000000...5f3012, IndependentUnrelatedClient, no
-- client_account_links row at all) so both sides of the intended behavior
-- can be proven independently: the linked row is visible, the unrelated
-- row is not, and the total visible set at that studio is exactly the
-- portal-self row count (1), never the full roster and never zero.
-- ============================================================================
do $$
declare
  v_total_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1006')::text, true);

  select count(*) into v_total_count
  from public.clients
  where studio_id = '00000000-0000-0000-0000-0000005f0002';

  reset role;

  if v_total_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb12: independent_instructor should see exactly 1 client at studio_b (their one portal-linked row, not the full roster and not zero), got %', v_total_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb12: independent_instructor sees exactly the portal-self row count at their studio, not the full roster';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1006')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3006';

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb13: independent_instructor should still read their own linked portal-self client row, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb13: independent_instructor linked portal-self client row remains readable';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1006')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3012';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb14: independent_instructor should be denied an unrelated (unlinked) client at their OWN studio, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb14: independent_instructor denied an unrelated, unlinked client at their own studio -- no general roster access';
end $$;

do $$
declare
  v_denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1006')::text, true);

  begin
    insert into public.clients (id, studio_id, first_name, last_name, status)
      values ('00000000-0000-0000-0000-0000005f3106', '00000000-0000-0000-0000-0000005f0002', 'PhaseB', 'InsertByIndependent', 'active');
  exception when insufficient_privilege then
    v_denied := true;
  end;

  reset role;

  if not v_denied then
    raise exception 'FAIL T-fc1b5d-pb15: independent_instructor INSERT should have been denied by RLS';
  end if;

  raise notice 'PASS T-fc1b5d-pb15: independent_instructor INSERT denied';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1006')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3001';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb16: independent_instructor should be denied an unrelated host (Studio A) client, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb16: independent_instructor denied an unrelated host client';
end $$;

-- ============================================================================
-- CASE pb17-pb19: hybrid (instructor teaching relationship at Studio A +
-- separate independent_instructor identity at Studio B). Note: hybrid_user
-- has no client_account_links row at studio_b at all, so pb19's count=0
-- assertion has no fixture-overlap risk analogous to the independent-
-- instructor case above.
-- ============================================================================
do $$
declare
  v_count int;
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1007')::text, true);

  select count(*) into v_count
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005f0001'::uuid, null);

  select * into v_row
  from public.get_teaching_clients_for_instructor('00000000-0000-0000-0000-0000005f0001'::uuid, '00000000-0000-0000-0000-0000005f3007'::uuid);

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb17: hybrid teaching RPC returned % rows, expected exactly 1 (only the host-assigned client)', v_count;
  end if;

  if v_row.id is distinct from '00000000-0000-0000-0000-0000005f3007'::uuid then
    raise exception 'FAIL T-fc1b5d-pb17: hybrid teaching RPC did not return the expected host-assigned client';
  end if;

  raise notice 'PASS T-fc1b5d-pb17: hybrid person sees exactly their host-assigned teaching client via the RPC';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1007')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3008';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb18: hybrid person should be denied direct SELECT of an unrelated host client, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb18: hybrid person denied direct SELECT of an unrelated host client';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1007')::text, true);

  select count(*) into v_count
  from public.clients
  where studio_id = '00000000-0000-0000-0000-0000005f0002';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb19: hybrid person''s floor-rental/independent_instructor identity should not grant general CRM access, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb19: hybrid person''s independent_instructor identity grants no general CRM access';
end $$;

-- ============================================================================
-- CASE pb20-pb22: portal/self access unaffected.
-- ============================================================================
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1008')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3009';

  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-fc1b5d-pb20: linked portal user should read their own client row, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb20: linked portal user reads their own client row';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1008')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3010';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb21: portal user should be denied a different client at the SAME studio, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb21: portal user denied a different client at the same studio';
end $$;

do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000005f1008')::text, true);

  select count(*) into v_count
  from public.clients
  where id = '00000000-0000-0000-0000-0000005f3006';

  reset role;

  if v_count <> 0 then
    raise exception 'FAIL T-fc1b5d-pb22: portal user should be denied a client at a DIFFERENT studio, got % rows', v_count;
  end if;

  raise notice 'PASS T-fc1b5d-pb22: portal user denied a client at a different studio';
end $$;

-- ============================================================================
-- CASE pb23: policy inventory matches the intended final state.
-- ============================================================================
do $$
declare
  v_dropped_exists boolean;
  v_all_policy_def text;
  v_portal1_exists boolean;
  v_portal2_exists boolean;
begin
  select exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where c.relname = 'clients' and p.polname = 'studio members can view clients'
  ) into v_dropped_exists;

  if v_dropped_exists then
    raise exception 'FAIL T-fc1b5d-pb23: "studio members can view clients" should no longer exist';
  end if;

  select pg_get_expr(p.polqual, p.polrelid) into v_all_policy_def
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where c.relname = 'clients' and p.polname = 'studio staff manage clients';

  if v_all_policy_def is null then
    raise exception 'FAIL T-fc1b5d-pb23: "studio staff manage clients" should still exist';
  end if;

  if v_all_policy_def like '%instructor%' then
    raise exception 'FAIL T-fc1b5d-pb23: "studio staff manage clients" definition still references instructor: %', v_all_policy_def;
  end if;

  select exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where c.relname = 'clients' and p.polname = 'portal users can read own student profile'
  ) into v_portal1_exists;

  select exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where c.relname = 'clients' and p.polname = 'portal users can view their own client record'
  ) into v_portal2_exists;

  if not (v_portal1_exists and v_portal2_exists) then
    raise exception 'FAIL T-fc1b5d-pb23: both portal-self policies must still exist';
  end if;

  raise notice 'PASS T-fc1b5d-pb23: policy inventory matches the intended final Phase B state';
end $$;

rollback;
