-- Landmark 1A Slice 9 regression suite: capability-authority boundary.
--
-- Covers 20260918090000_landmark1a_slice9_capability_authority.sql. One
-- transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00001b9*),
-- rolled back at the end. Tenant behavior is simulated with `set local role`
-- + request.jwt.claims. Assumes the migration is applied.
--
-- ID scheme (12-hex tail): studios 00001b90NNNN, users 00001b91NNNN,
-- clients 00001b92NNNN, links 00001b93NNNN, instructors 00001b94NNNN.
--   studios: 1 (pro override), 2 (pro override), 3 (starter override, limit 1)
--   users:   1 owner1, 2 admin1, 3 front1, 5 owner2, 12 owner3

begin;

create or replace function public._s9t_id(p_kind int, p_n int) returns uuid language sql immutable as
$$ select ('00000000-0000-0000-0000-00001b9' || p_kind::text || lpad(p_n::text, 4, '0'))::uuid $$;

-- Asserts p_sql fails with an error LIKE p_like (any role context of the caller).
create or replace function public._s9t_expect(p_label text, p_sql text, p_like text)
returns void language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_like then return; end if;
    raise exception 'FAILED [%]: unexpected error: %', p_label, sqlerrm;
  end;
  raise exception 'FAILED [%]: statement unexpectedly succeeded', p_label;
end $f$;

create or replace function public._s9t_rows(p_sql text) returns int language plpgsql as $f$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $f$;

create or replace function public._s9t_jwt(p_user int) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', public._s9t_id(1, p_user), 'email', 't-s9-u' || p_user || '@example.test')::text, true);
end $f$;

-- user + profile
create or replace function public._s9t_user(p_n int) returns uuid language plpgsql as $f$
begin
  insert into auth.users (id, email) values (public._s9t_id(1, p_n), 't-s9-u' || p_n || '@example.test') on conflict do nothing;
  insert into public.profiles (id, email, full_name) values (public._s9t_id(1, p_n), 't-s9-u' || p_n || '@example.test', 'S9 U' || p_n) on conflict do nothing;
  return public._s9t_id(1, p_n);
end $f$;

-- client + linked account (relationship p_rel) for user p_n
create or replace function public._s9t_client(p_n int, p_studio int, p_rel text default 'self', p_indep boolean default true, p_link_instr int default null)
returns uuid language plpgsql as $f$
begin
  perform public._s9t_user(p_n);
  insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id)
  values (public._s9t_id(2, p_n), public._s9t_id(0, p_studio), 'C', 'N' || p_n, 'active', p_indep,
          case when p_link_instr is null then null else public._s9t_id(4, p_link_instr) end);
  if p_rel is not null then
    insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary)
    values (public._s9t_id(3, p_n), public._s9t_id(0, p_studio), public._s9t_id(2, p_n), public._s9t_id(1, p_n), 'linked', p_rel, true);
  end if;
  return public._s9t_id(2, p_n);
end $f$;

-- instructor row (key p_key) in studio p_studio for user p_user (null = unlinked)
create or replace function public._s9t_instr(p_key int, p_studio int, p_user int, p_capable boolean default false, p_active boolean default true)
returns uuid language plpgsql as $f$
begin
  if p_user is not null then perform public._s9t_user(p_user); end if;
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
  values (public._s9t_id(4, p_key), public._s9t_id(0, p_studio), case when p_user is null then null else public._s9t_id(1, p_user) end,
          'I', 'K' || p_key, p_active, p_capable);
  return public._s9t_id(4, p_key);
end $f$;

grant execute on function public._s9t_id(int, int), public._s9t_expect(text, text, text), public._s9t_rows(text),
  public._s9t_jwt(int) to authenticated, service_role;

insert into public.studios (id, name, slug) values
  (public._s9t_id(0, 1), 'S9 Studio 1', 't-s9-studio-1'),
  (public._s9t_id(0, 2), 'S9 Studio 2', 't-s9-studio-2'),
  (public._s9t_id(0, 3), 'S9 Studio 3', 't-s9-studio-3');
update public.studios set billing_plan = 'pro', billing_override_enabled = true
  where id in (public._s9t_id(0, 1), public._s9t_id(0, 2));
update public.studios set billing_plan = 'starter', billing_override_enabled = true where id = public._s9t_id(0, 3);

select public._s9t_user(n) from generate_series(1, 5) n;
select public._s9t_user(12);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (public._s9t_id(1, 1), public._s9t_id(0, 1), 'studio_owner', true),
  (public._s9t_id(1, 2), public._s9t_id(0, 1), 'studio_admin', true),
  (public._s9t_id(1, 3), public._s9t_id(0, 1), 'front_desk', true),
  (public._s9t_id(1, 5), public._s9t_id(0, 2), 'studio_owner', true),
  (public._s9t_id(1, 12), public._s9t_id(0, 3), 'studio_owner', true);

-- studio 1 instructors
select public._s9t_instr(1, 1, 20, false);   -- i_plain: linked, non-capable
select public._s9t_instr(2, 1, 21, true);    -- i_cap: capable
select public._s9t_instr(3, 1, 22, true);    -- i_cap2: capable (RPC revoke target)
select public._s9t_instr(4, 1, null, false); -- i_unl: unlinked, non-capable
select public._s9t_instr(6, 2, null, false); -- i_cross: studio 2
update public.instructors set hybrid_client_assignment_attested = true where id = public._s9t_id(4, 2);

-- ============================================================================
-- S. Static definition checks
-- ============================================================================
do $$
declare v_def text; v_sec boolean; v_n int;
begin
  select prosecdef into v_sec from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_instructors_capability_columns';
  assert v_sec = false, 'S1 FAILED: capability guard must be SECURITY INVOKER';
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'guard_instructors_capability_columns' and tgrelid = 'public.instructors'::regclass;
  assert v_def like '%BEFORE INSERT OR DELETE OR UPDATE OF can_instruct, hybrid_client_assignment_attested, user_id, studio_id ON public.instructors FOR EACH ROW%',
    format('S2 FAILED: trigger def %s', v_def);
  select prosrc into v_def from pg_proc where proname = '_guard_instructors_capability_columns';
  assert v_def ~ 'current_user in \(''anon'', ''authenticated''\)', 'S3 FAILED: must key on current_user';
  assert v_def !~* 'from\s+(public\.)?(user_studio_roles|profiles|studios)', 'S3 FAILED: must not consult tenant data to authorize';
  select count(*) into v_n from pg_policies where tablename = 'instructors' and policyname = 'studio admins manage instructors'
    and (qual like '%front_desk%' or with_check like '%front_desk%');
  assert v_n = 0, 'S4 FAILED: front_desk still in instructors write policy';
  assert exists (select 1 from pg_policies where tablename = 'instructors' and policyname = 'studio members can view instructors' and cmd = 'SELECT'), 'S4 FAILED: view policy must remain';
  assert exists (select 1 from pg_trigger where tgname = 'landmark1a_enforce_instructor_seat_gate'), 'S5 FAILED: Slice 8 seat gate missing';
  assert exists (select 1 from pg_trigger where tgname = 'guard_profiles_platform_role'), 'S5 FAILED: platform-role hotfix missing';
  assert (select count(*) from pg_trigger where tgname in ('landmark1a_payroll_profiles_same_studio', 'landmark1a_compensation_rules_same_studio', 'landmark1a_clients_linked_instructor_same_studio')) = 3, 'S6 FAILED: validators';
  assert not has_function_privilege('anon', 'public._guard_instructors_capability_columns()', 'execute')
     and not has_function_privilege('authenticated', 'public._guard_instructors_capability_columns()', 'execute')
     and not has_function_privilege('service_role', 'public._guard_instructors_capability_columns()', 'execute'), 'S7 FAILED: guard privileges';
  assert not has_function_privilege('authenticated', 'public._landmark1a_instructor_has_renter_relationship(uuid,uuid)', 'execute')
     and not has_function_privilege('service_role', 'public._landmark1a_instructor_has_renter_relationship(uuid,uuid)', 'execute')
     and not has_function_privilege('anon', 'public._landmark1a_instructor_has_renter_relationship(uuid,uuid)', 'execute'), 'S7 FAILED: renter helper privileges';
  assert not has_function_privilege('authenticated', 'public._landmark1a_assert_worker_row_same_studio()', 'execute')
     and not has_function_privilege('authenticated', 'public._landmark1a_assert_client_linked_instructor_same_studio()', 'execute'), 'S7 FAILED: validator privileges';
  assert has_function_privilege('authenticated', 'public.promote_hybrid_instructor(uuid,uuid,boolean,text)', 'execute')
     and not has_function_privilege('anon', 'public.promote_hybrid_instructor(uuid,uuid,boolean,text)', 'execute')
     and not has_function_privilege('service_role', 'public.promote_hybrid_instructor(uuid,uuid,boolean,text)', 'execute'), 'S8 FAILED: promote privileges';
  assert has_function_privilege('authenticated', 'public.grant_instructor_capability(uuid,uuid)', 'execute'), 'S8 FAILED: grant privileges';
  raise notice 'S1-S8 PASSED: invoker guard, trigger def, current_user, policy without front_desk, validators, privileges';
end $$;

-- ============================================================================
-- D. Direct tenant bypass attempts fail; ordinary edits still work
-- ============================================================================
do $$
declare v_n int;
begin
  set local role authenticated;
  perform public._s9t_jwt(2); -- admin1

  perform public._s9t_expect('D1 grant', format('update public.instructors set can_instruct = true where id = %L', public._s9t_id(4, 1)), 'Instructor capability can only be changed through the capability workflow.');
  perform public._s9t_expect('D2 revoke', format('update public.instructors set can_instruct = false where id = %L', public._s9t_id(4, 2)), 'Instructor capability can only be changed through the capability workflow.');
  perform public._s9t_expect('D3 capable insert', format('insert into public.instructors (studio_id, first_name, last_name, active, can_instruct) values (%L, ''X'', ''Y'', true, true)', public._s9t_id(0, 1)), 'Instructor capability and hybrid attestation can only be set%');
  perform public._s9t_expect('D4 attested insert', format('insert into public.instructors (studio_id, first_name, last_name, active, hybrid_client_assignment_attested) values (%L, ''X'', ''Y'', true, true)', public._s9t_id(0, 1)), 'Instructor capability and hybrid attestation can only be set%');
  perform public._s9t_expect('D5 attestation set', format('update public.instructors set hybrid_client_assignment_attested = true where id = %L', public._s9t_id(4, 1)), 'Hybrid attestation can only be changed%');
  perform public._s9t_expect('D6 attestation clear', format('update public.instructors set hybrid_client_assignment_attested = false where id = %L', public._s9t_id(4, 2)), 'Hybrid attestation can only be changed%');
  perform public._s9t_expect('D7 capable unlink', format('update public.instructors set user_id = null where id = %L', public._s9t_id(4, 2)), 'The linked account of a capable instructor cannot be changed%');
  perform public._s9t_expect('D8 capable re-point', format('update public.instructors set user_id = %L where id = %L', public._s9t_id(1, 4), public._s9t_id(4, 2)), 'The linked account of a capable instructor cannot be changed%');
  perform public._s9t_expect('D9 studio move (non-capable)', format('update public.instructors set studio_id = %L where id = %L', public._s9t_id(0, 2), public._s9t_id(4, 4)), 'An instructor cannot be moved between studios.');
  perform public._s9t_expect('D9b studio move (capable)', format('update public.instructors set studio_id = %L where id = %L', public._s9t_id(0, 2), public._s9t_id(4, 2)), 'An instructor cannot be moved between studios.');
  perform public._s9t_expect('D10 capable delete', format('delete from public.instructors where id = %L', public._s9t_id(4, 2)), 'A capable instructor cannot be deleted directly.%');
  -- mixed statement: ordinary + sensitive fails atomically
  perform public._s9t_expect('D10b mixed', format('update public.instructors set bio = ''hijack'', can_instruct = true where id = %L', public._s9t_id(4, 1)), 'Instructor capability can only be changed%');
  assert (select bio from public.instructors where id = public._s9t_id(4, 1)) is distinct from 'hijack', 'D10b FAILED: partial write';

  -- Ordinary staff edits still work (owner/admin), including on capable rows.
  v_n := public._s9t_rows(format('update public.instructors set bio = ''ok'', phone = ''555'' where id = %L', public._s9t_id(4, 2)));
  assert v_n = 1, 'D11 FAILED: admin ordinary edit on a capable row must succeed';
  v_n := public._s9t_rows(format('update public.instructors set active = false where id = %L', public._s9t_id(4, 1)));
  assert v_n = 1, 'D11b FAILED: admin deactivate (non-destructive, unchanged behavior)';
  v_n := public._s9t_rows(format('update public.instructors set active = true where id = %L', public._s9t_id(4, 1)));
  assert v_n = 1, 'D11c FAILED: admin reactivation of a non-capable row';
  -- Non-capable canonical account link lifecycle unchanged.
  v_n := public._s9t_rows(format('update public.instructors set user_id = %L where id = %L', public._s9t_id(1, 4), public._s9t_id(4, 4)));
  assert v_n = 1, 'D12 FAILED: linking a non-capable instructor must still work';
  v_n := public._s9t_rows(format('update public.instructors set user_id = null where id = %L', public._s9t_id(4, 4)));
  assert v_n = 1, 'D12b FAILED: unlinking a non-capable instructor must still work';
  -- Create + delete of a non-capable instructor still work.
  v_n := public._s9t_rows(format('insert into public.instructors (id, studio_id, first_name, last_name, active) values (%L, %L, ''N'', ''C'', true)', public._s9t_id(4, 90), public._s9t_id(0, 1)));
  assert v_n = 1, 'D13 FAILED: non-capable insert';
  v_n := public._s9t_rows(format('delete from public.instructors where id = %L', public._s9t_id(4, 90)));
  assert v_n = 1, 'D13b FAILED: non-capable delete';

  -- Owner is subject to the same guard.
  perform public._s9t_jwt(1);
  perform public._s9t_expect('D14 owner grant', format('update public.instructors set can_instruct = true where id = %L', public._s9t_id(4, 1)), 'Instructor capability can only be changed%');
  perform public._s9t_expect('D14b owner attestation', format('update public.instructors set hybrid_client_assignment_attested = true where id = %L', public._s9t_id(4, 1)), 'Hybrid attestation can only be changed%');

  -- Front desk: read works, direct instructor writes fail.
  perform public._s9t_jwt(3);
  assert (select count(*) from public.instructors where studio_id = public._s9t_id(0, 1)) >= 4, 'D15 FAILED: front desk must still read instructors';
  v_n := public._s9t_rows(format('update public.instructors set bio = ''fd'' where id = %L', public._s9t_id(4, 1)));
  assert v_n = 0, 'D15b FAILED: front desk ordinary instructor write must be denied by RLS';
  perform public._s9t_expect('D15c fd insert', format('insert into public.instructors (studio_id, first_name, last_name, active) values (%L, ''F'', ''D'', true)', public._s9t_id(0, 1)), '%row-level security%');
  v_n := public._s9t_rows(format('delete from public.instructors where id = %L', public._s9t_id(4, 1)));
  assert v_n = 0, 'D15d FAILED: front desk delete must be denied';
  reset role;

  -- Trusted contexts are not blocked (postgres, service_role).
  update public.instructors set can_instruct = false where id = public._s9t_id(4, 3);
  update public.instructors set can_instruct = true where id = public._s9t_id(4, 3);
  set local role service_role;
  update public.instructors set hybrid_client_assignment_attested = true where id = public._s9t_id(4, 3);
  update public.instructors set hybrid_client_assignment_attested = false where id = public._s9t_id(4, 3);
  reset role;
  raise notice 'D1-D15 PASSED: grant/revoke/insert/attestation/unlink/re-point/move/delete blocked; ordinary edits, non-capable link lifecycle, front-desk read kept; trusted contexts pass';
end $$;

-- ============================================================================
-- C. Cascades (auth-user deletion, studio deletion) are not blocked
-- ============================================================================
do $$
begin
  perform public._s9t_instr(30, 1, 30, true);
  -- auth-user deletion sets the capable instructor's user_id null via FK cascade
  delete from auth.users where id = public._s9t_id(1, 30);
  assert (select user_id from public.instructors where id = public._s9t_id(4, 30)) is null, 'C1 FAILED: user deletion cascade blocked';
  -- same cascade fired while the session role is not the table owner
  perform public._s9t_instr(31, 1, 31, true);
  -- (the API-role cascade proof is C3; auth.users cannot be granted to authenticated here)
  delete from auth.users where id = public._s9t_id(1, 31);
  assert (select user_id from public.instructors where id = public._s9t_id(4, 31)) is null, 'C2 FAILED: FK SET NULL cascade must run as the table owner, not the deleting role';
  -- studio deletion cascade removes a capable instructor
  insert into public.studios (id, name, slug) values (public._s9t_id(0, 40), 'S9 Cascade', 't-s9-cascade');
  perform public._s9t_instr(32, 40, null, true);
  -- a tenant-role studio delete (temporary policy, rolled back) cascades to the capable instructor
  grant delete on public.studios to authenticated;
  create policy _s9t_studio_delete on public.studios for delete to authenticated using (true);
  set local role authenticated;
  delete from public.studios where id = public._s9t_id(0, 40);
  reset role;
  drop policy _s9t_studio_delete on public.studios;
  revoke delete on public.studios from authenticated;
  assert not exists (select 1 from public.instructors where id = public._s9t_id(4, 32)), 'C3 FAILED: studio deletion cascade blocked by capable-delete guard';
  raise notice 'C1-C3 PASSED: auth-user and studio deletion cascades still work (cascade runs as table owner)';
end $$;

-- ============================================================================
-- V. Same-studio validators
-- ============================================================================
do $$
declare v_n int;
begin
  set local role authenticated;
  perform public._s9t_jwt(2); -- admin1 (studio 1)
  -- payroll profile: same-studio ok; cross-studio (studio 1 row -> studio 2 instructor) fails
  v_n := public._s9t_rows(format('insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (%L, %L, true, ''not_set'')', public._s9t_id(0, 1), public._s9t_id(4, 1)));
  assert v_n = 1, 'V1 FAILED: same-studio payroll profile';
  perform public._s9t_expect('V2', format('insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (%L, %L, true, ''employee'')', public._s9t_id(0, 1), public._s9t_id(4, 6)), 'instructor_payroll_profiles must reference an instructor of the same studio.');
  perform public._s9t_expect('V2b update', format('update public.instructor_payroll_profiles set instructor_id = %L where instructor_id = %L', public._s9t_id(4, 6), public._s9t_id(4, 1)), 'instructor_payroll_profiles must reference an instructor of the same studio.');
  v_n := public._s9t_rows(format('update public.instructor_payroll_profiles set worker_classification = ''employee'' where instructor_id = %L', public._s9t_id(4, 1)));
  assert v_n = 1, 'V2c FAILED: normal payroll edit still works';
  -- compensation rule
  v_n := public._s9t_rows(format('insert into public.instructor_compensation_rules (studio_id, instructor_id) values (%L, %L)', public._s9t_id(0, 1), public._s9t_id(4, 1)));
  assert v_n = 1, 'V3 FAILED: same-studio compensation rule';
  perform public._s9t_expect('V4', format('insert into public.instructor_compensation_rules (studio_id, instructor_id) values (%L, %L)', public._s9t_id(0, 1), public._s9t_id(4, 6)), 'instructor_compensation_rules must reference an instructor of the same studio.');
  reset role;
  perform public._s9t_expect('V4b postgres', format('insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active) values (%L, %L, true)', public._s9t_id(0, 1), public._s9t_id(4, 6)), 'instructor_payroll_profiles must reference%');

  -- clients.linked_instructor_id
  perform public._s9t_client(50, 1, null, false);
  set local role authenticated;
  perform public._s9t_jwt(3); -- front desk keeps client edits
  v_n := public._s9t_rows(format('update public.clients set is_independent_instructor = true, linked_instructor_id = %L where id = %L', public._s9t_id(4, 1), public._s9t_id(2, 50)));
  assert v_n = 1, 'V5 FAILED: same-studio client->instructor link (front desk keeps renter edits)';
  perform public._s9t_expect('V6 cross-studio link', format('update public.clients set linked_instructor_id = %L where id = %L', public._s9t_id(4, 6), public._s9t_id(2, 50)), 'clients.linked_instructor_id must reference an instructor of the same studio.');
  v_n := public._s9t_rows(format('update public.clients set linked_instructor_id = null where id = %L', public._s9t_id(2, 50)));
  assert v_n = 1, 'V7 FAILED: null link must succeed';
  perform public._s9t_expect('V8 cross-studio insert', format('insert into public.clients (studio_id, first_name, last_name, is_independent_instructor, linked_instructor_id) values (%L, ''X'', ''Y'', true, %L)', public._s9t_id(0, 1), public._s9t_id(4, 6)), 'clients.linked_instructor_id must reference an instructor of the same studio.');
  v_n := public._s9t_rows(format('update public.clients set first_name = ''Renamed'' where id = %L', public._s9t_id(2, 50)));
  assert v_n = 1, 'V9 FAILED: ordinary client edit';
  reset role;
  raise notice 'V1-V9 PASSED: same-studio validators for payroll, compensation and client instructor link';
end $$;

-- ============================================================================
-- G. Ordinary grant cannot be a renter->hybrid bypass; RPC lifecycle works
-- ============================================================================
do $$
declare v_a uuid := public._s9t_id(0, 1); v_n int;
begin
  perform public._s9t_instr(10, 1, 60, false);  -- renter via linked_instructor_id
  perform public._s9t_client(60, 1, 'self', true, 10);
  perform public._s9t_instr(11, 1, 61, false);  -- renter via self account only (linked_instructor_id null)
  perform public._s9t_client(61, 1, 'self', true, null);
  perform public._s9t_instr(12, 1, 62, false);  -- guardian relationship only
  perform public._s9t_client(62, 1, 'guardian', true, null);
  perform public._s9t_instr(13, 1, 63, false);  -- dependent relationship only
  perform public._s9t_client(63, 1, 'dependent', true, null);
  perform public._s9t_instr(14, 1, 64, false);  -- self link but NOT independent
  perform public._s9t_client(64, 1, 'self', false, null);
  perform public._s9t_instr(15, 2, 65, false);  -- renter in ANOTHER studio only
  perform public._s9t_client(65, 2, 'self', true, null);

  set local role authenticated;
  perform public._s9t_jwt(2);
  perform public._s9t_expect('G1 linked_instructor_id renter', format('select public.grant_instructor_capability(%L, %L)', v_a, public._s9t_id(4, 10)), 'This instructor has an independent/floor-rental relationship%');
  perform public._s9t_expect('G2 self-account renter', format('select public.grant_instructor_capability(%L, %L)', v_a, public._s9t_id(4, 11)), 'This instructor has an independent/floor-rental relationship%');
  perform public.grant_instructor_capability(v_a, public._s9t_id(4, 12));
  perform public.grant_instructor_capability(v_a, public._s9t_id(4, 13));
  perform public.grant_instructor_capability(v_a, public._s9t_id(4, 14));
  perform public.grant_instructor_capability(v_a, public._s9t_id(4, 1));
  reset role;
  assert (select count(*) from public.instructors where id in (public._s9t_id(4, 12), public._s9t_id(4, 13), public._s9t_id(4, 14), public._s9t_id(4, 1)) and can_instruct) = 4,
    'G3 FAILED: guardian/dependent/non-independent/plain instructors must be grantable (no false renter identity)';
  assert (select count(*) from public.instructors where id in (public._s9t_id(4, 10), public._s9t_id(4, 11)) and can_instruct) = 0, 'G1 FAILED: renters must remain non-capable';
  -- studio isolation: a renter at studio 2 does not block a grant at studio 1
  assert public._landmark1a_instructor_has_renter_relationship(public._s9t_id(0, 2), public._s9t_id(4, 15)) = true, 'G4 FAILED: helper same-studio positive';
  assert public._landmark1a_instructor_has_renter_relationship(public._s9t_id(0, 1), public._s9t_id(4, 15)) = false, 'G4 FAILED: helper must be studio-scoped';
  -- RPC revoke (Slice 7) still the revoke path
  set local role authenticated;
  perform public._s9t_jwt(2);
  perform public.revoke_instructor_capability(v_a, public._s9t_id(4, 3));
  reset role;
  assert (select can_instruct from public.instructors where id = public._s9t_id(4, 3)) = false, 'G5 FAILED: RPC revoke';
  assert exists (select 1 from public.instructor_audit_events where instructor_id = public._s9t_id(4, 3) and event_type = 'capability_revoked'), 'G5 FAILED: revoke audit';
  raise notice 'G1-G5 PASSED: renter guard covers link + self-account paths; guardian/dependent/non-independent/other-studio never false-positive; RPC revoke works';
end $$;

-- ============================================================================
-- H. Hybrid promotion
-- ============================================================================
do $$
declare
  v_a uuid := public._s9t_id(0, 1);
  v_i uuid; v_meta jsonb; v_pp public.instructor_payroll_profiles; v_n int;
begin
  -- fixtures
  perform public._s9t_client(70, 1, 'self', true, null);                       -- H1: no instructor row, no payroll
  perform public._s9t_client(71, 1, 'self', false, null);                      -- H2: not a renter
  perform public._s9t_client(72, 1, 'guardian', true, null);                   -- H3: guardian-only link
  perform public._s9t_client(73, 1, 'dependent', true, null);                  -- H4: dependent-only link
  perform public._s9t_client(74, 1, null, true, null);                         -- H5: no link at all
  perform public._s9t_client(75, 1, 'self', true, null);                       -- H10: inactive payroll, employee
  perform public._s9t_instr(20, 1, 75, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 20), false, 'employee');
  perform public._s9t_client(76, 1, 'self', true, null);                       -- H11: active employee, same classification
  perform public._s9t_instr(21, 1, 76, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 21), true, 'employee');
  perform public._s9t_client(77, 1, 'self', true, null);                       -- H12: existing employee, contractor requested
  perform public._s9t_instr(22, 1, 77, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 22), true, 'employee');
  perform public._s9t_client(78, 1, 'self', true, null);                       -- H13: existing contractor, employee requested
  perform public._s9t_instr(23, 1, 78, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 23), false, 'contractor');
  perform public._s9t_client(79, 1, 'self', true, null);                       -- H14: existing owner classification
  perform public._s9t_instr(24, 1, 79, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 24), true, 'owner');
  perform public._s9t_client(80, 1, 'self', true, null);                       -- H15: not_set existing
  perform public._s9t_instr(25, 1, 80, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 25), true, 'not_set');
  perform public._s9t_instr(26, 1, null, false);                               -- H16: client linked_instructor_id points at a different instructor
  perform public._s9t_client(81, 1, 'self', true, 26);
  perform public._s9t_instr(27, 1, 81, false);
  perform public._s9t_client(82, 3, 'self', true, null);                       -- H6: seat full (studio 3, limit 1)
  perform public._s9t_instr(28, 3, 83, true);

  set local role authenticated;
  perform public._s9t_jwt(1); -- owner1

  -- rejections (each leaves no state behind)
  perform public._s9t_expect('H2 not renter', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 71)), 'This client does not have an independent-instructor relationship%');
  perform public._s9t_expect('H3 guardian-only', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 72)), 'This independent instructor does not have a linked DanceFlow account yet.');
  perform public._s9t_expect('H4 dependent-only', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 73)), 'This independent instructor does not have a linked DanceFlow account yet.');
  perform public._s9t_expect('H5 no link', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 74)), 'This independent instructor does not have a linked DanceFlow account yet.');
  perform public._s9t_expect('H7 no attestation', format('select public.promote_hybrid_instructor(%L, %L, false, ''employee'')', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit staff attestation%');
  perform public._s9t_expect('H7b null attestation', format('select public.promote_hybrid_instructor(%L, %L, null, ''employee'')', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit staff attestation%');
  perform public._s9t_expect('H8 owner class', format('select public.promote_hybrid_instructor(%L, %L, true, ''owner'')', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit worker classification%');
  perform public._s9t_expect('H8b not_set', format('select public.promote_hybrid_instructor(%L, %L, true, ''not_set'')', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit worker classification%');
  perform public._s9t_expect('H8c null', format('select public.promote_hybrid_instructor(%L, %L, true, null)', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit worker classification%');
  perform public._s9t_expect('H12 employee->contractor', format('select public.promote_hybrid_instructor(%L, %L, true, ''contractor'')', v_a, public._s9t_id(2, 77)), 'This instructor already has an established payroll classification (employee)%');
  perform public._s9t_expect('H13 contractor->employee', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 78)), 'This instructor already has an established payroll classification (contractor)%');
  perform public._s9t_expect('H14 owner classification', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 79)), '%payroll classification is owner and cannot be replaced%');
  perform public._s9t_expect('H16 linked instructor mismatch', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 81)), 'The instructor record for this account does not match%');
  perform public._s9t_jwt(12); -- owner of studio 3
  perform public._s9t_expect('H6 seat full', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', public._s9t_id(0, 3), public._s9t_id(2, 82)), 'This studio has reached its instructor seat limit%');
  reset role;
  assert not exists (select 1 from public.instructors where user_id in (public._s9t_id(1, 70), public._s9t_id(1, 82))), 'H FAILED: a rejected promotion left an instructor row behind';
  assert (select worker_classification || payroll_active::text from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 22)) = 'employeetrue', 'H12 FAILED: classification silently rewritten';
  assert (select worker_classification || payroll_active::text from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 23)) = 'contractorfalse', 'H13 FAILED: state changed on rejection';
  assert (select worker_classification from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 24)) = 'owner', 'H14 FAILED: owner classification overwritten';
  assert (select count(*) from public.instructors where id in (public._s9t_id(4, 22), public._s9t_id(4, 23), public._s9t_id(4, 24)) and (can_instruct or hybrid_client_assignment_attested)) = 0, 'H FAILED: rejected promotion granted capability';

  -- H1: renter + self link + attestation + classification, no payroll -> created
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 70), true, 'employee');
  reset role;
  select id into v_i from public.instructors where user_id = public._s9t_id(1, 70) and studio_id = v_a;
  assert v_i is not null, 'H1 FAILED: instructor not created';
  assert (select can_instruct and hybrid_client_assignment_attested and active from public.instructors where id = v_i), 'H1 FAILED: capability/attestation';
  select * into v_pp from public.instructor_payroll_profiles where instructor_id = v_i;
  assert v_pp.payroll_active and v_pp.worker_classification = 'employee' and v_pp.studio_id = v_a, 'H1/H9 FAILED: payroll created active employee';
  select metadata into v_meta from public.instructor_audit_events where instructor_id = v_i and event_type = 'capability_granted';
  assert v_meta->>'source' = 'hybrid_promotion' and (v_meta->>'payroll_profile_created')::boolean = true
     and (v_meta->>'prior_payroll_profile_existed')::boolean = false and v_meta->>'prior_payroll_active' is null
     and v_meta->>'prior_worker_classification' is null and v_meta->>'resulting_worker_classification' = 'employee'
     and v_meta->>'payroll_profile_action' = 'created', format('H1 audit FAILED: %s', v_meta);

  -- H10: inactive payroll -> reactivated
  set local role authenticated;
  perform public._s9t_jwt(2); -- admin may also promote
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 75), true, 'employee');
  reset role;
  assert (select payroll_active from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 20)), 'H10 FAILED: inactive profile not reactivated';
  select metadata into v_meta from public.instructor_audit_events where instructor_id = public._s9t_id(4, 20) and event_type = 'capability_granted';
  assert v_meta->>'payroll_profile_action' = 'reactivated' and (v_meta->>'prior_payroll_active')::boolean = false and v_meta->>'prior_worker_classification' = 'employee'
     and (v_meta->>'prior_payroll_profile_existed')::boolean = true and (v_meta->>'payroll_profile_created')::boolean = false, format('H10 audit FAILED: %s', v_meta);

  -- H11: same classification, already active -> unchanged
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 76), true, 'employee');
  reset role;
  select metadata into v_meta from public.instructor_audit_events where instructor_id = public._s9t_id(4, 21) and event_type = 'capability_granted';
  assert v_meta->>'payroll_profile_action' = 'unchanged' and (v_meta->>'prior_payroll_active')::boolean = true, format('H11 audit FAILED: %s', v_meta);

  -- H15: not_set existing -> supplied classification established
  set local role authenticated;
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 80), true, 'contractor');
  reset role;
  assert (select worker_classification from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 25)) = 'contractor', 'H15 FAILED';
  select metadata into v_meta from public.instructor_audit_events where instructor_id = public._s9t_id(4, 25) and event_type = 'capability_granted';
  assert v_meta->>'payroll_profile_action' = 'classification_established' and v_meta->>'prior_worker_classification' = 'not_set', format('H15 audit FAILED: %s', v_meta);

  -- Idempotent re-run while capable + attested: no-op, no second audit event.
  set local role authenticated;
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 70), true, 'employee');
  reset role;
  assert (select count(*) from public.instructor_audit_events where instructor_id = v_i and event_type = 'capability_granted') = 1, 'H17 FAILED: idempotent promote wrote another audit event';

  -- Authority: front desk and another studio's owner cannot promote.
  set local role authenticated;
  perform public._s9t_jwt(3);
  perform public._s9t_expect('H18 front desk', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 70)), 'Not authorized to manage instructors for this studio.');
  perform public._s9t_jwt(5);
  perform public._s9t_expect('H18b other studio owner', format('select public.promote_hybrid_instructor(%L, %L, true, ''employee'')', v_a, public._s9t_id(2, 70)), 'Not authorized to manage instructors for this studio.');
  reset role;
  raise notice 'H1-H18 PASSED: prerequisites, self-link only, classification guardrails, payroll create/reactivate/unchanged/established, audit prior state, idempotent, authority';
end $$;

-- ============================================================================
-- L. Lifecycle: re-promotion after revoke requires fresh attestation; ordinary
--    re-grant of a renter is blocked; plain reactivation unchanged
-- ============================================================================
do $$
declare v_a uuid := public._s9t_id(0, 1); v_i uuid; v_n int;
begin
  select id into v_i from public.instructors where user_id = public._s9t_id(1, 70) and studio_id = v_a;
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public.revoke_instructor_capability(v_a, v_i);
  reset role;
  assert (select can_instruct from public.instructors where id = v_i) = false, 'L1 FAILED: revoke';
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public._s9t_expect('L2 ordinary regrant of renter', format('select public.grant_instructor_capability(%L, %L)', v_a, v_i), 'This instructor has an independent/floor-rental relationship%');
  perform public._s9t_expect('L3 no attestation', format('select public.promote_hybrid_instructor(%L, %L, false, ''employee'')', v_a, public._s9t_id(2, 70)), 'Hybrid promotion requires an explicit staff attestation%');
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 70), true, 'employee');
  reset role;
  assert (select can_instruct from public.instructors where id = v_i), 'L4 FAILED: re-promotion';
  assert (select count(*) from public.instructor_audit_events where instructor_id = v_i and event_type = 'capability_granted') = 2, 'L4 FAILED: re-promotion audit';
  -- plain reactivation of an already-capable hybrid instructor does not re-check hybrid prerequisites
  update public.instructor_payroll_profiles set payroll_active = false, worker_classification = 'contractor' where instructor_id = v_i;
  update public.instructors set active = false where id = v_i;
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public.reactivate_instructor(v_a, v_i);
  reset role;
  assert (select active and can_instruct from public.instructors where id = v_i), 'L5 FAILED: reactivation must not require hybrid prerequisites';
  raise notice 'L1-L5 PASSED: re-grant of renter blocked, fresh attestation on re-promotion, plain reactivation unchanged';
end $$;

-- ============================================================================
-- N. Existing payroll row with worker_classification IS NULL is "unestablished"
--    (column is NOT NULL in production; the constraint is dropped INSIDE this
--    rolled-back transaction only, to exercise the defensive NULL branch)
-- ============================================================================
do $$
declare v_a uuid := public._s9t_id(0, 1); v_meta jsonb;
begin
  alter table public.instructor_payroll_profiles alter column worker_classification drop not null;

  perform public._s9t_client(90, 1, 'self', true, null);
  perform public._s9t_instr(40, 1, 90, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 40), true, null);
  perform public._s9t_client(91, 1, 'self', true, null);
  perform public._s9t_instr(41, 1, 91, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 41), false, null);

  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 90), true, 'contractor');   -- NULL + active
  perform public.promote_hybrid_instructor(v_a, public._s9t_id(2, 91), true, 'employee');     -- NULL + inactive
  reset role;

  assert (select worker_classification from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 40)) = 'contractor', 'N1 FAILED: NULL not established as supplied classification';
  assert (select worker_classification || payroll_active::text from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 41)) = 'employeetrue', 'N2 FAILED: NULL+inactive';
  assert (select can_instruct and hybrid_client_assignment_attested from public.instructors where id = public._s9t_id(4, 40)), 'N1 FAILED: capability';
  select metadata into v_meta from public.instructor_audit_events where instructor_id = public._s9t_id(4, 40) and event_type = 'capability_granted';
  assert (v_meta->>'prior_payroll_profile_existed')::boolean = true and (v_meta->>'prior_payroll_active')::boolean = true
     and v_meta->'prior_worker_classification' = 'null'::jsonb and v_meta->>'resulting_worker_classification' = 'contractor'
     and v_meta->>'payroll_profile_action' = 'classification_established' and (v_meta->>'payroll_profile_created')::boolean = false,
     format('N1 audit FAILED: %s', v_meta);
  select metadata into v_meta from public.instructor_audit_events where instructor_id = public._s9t_id(4, 41) and event_type = 'capability_granted';
  assert v_meta->'prior_worker_classification' = 'null'::jsonb and (v_meta->>'prior_payroll_active')::boolean = false
     and v_meta->>'payroll_profile_action' = 'reactivated', format('N2 audit FAILED: %s', v_meta);

  -- protections still hold with the constraint relaxed: invalid supplied values fail
  perform public._s9t_client(92, 1, 'self', true, null);
  perform public._s9t_instr(42, 1, 92, false);
  insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values (v_a, public._s9t_id(4, 42), true, null);
  set local role authenticated;
  perform public._s9t_jwt(1);
  perform public._s9t_expect('N3 invalid supplied', format('select public.promote_hybrid_instructor(%L, %L, true, ''owner'')', v_a, public._s9t_id(2, 92)), 'Hybrid promotion requires an explicit worker classification%');
  perform public._s9t_expect('N3b null supplied', format('select public.promote_hybrid_instructor(%L, %L, true, null)', v_a, public._s9t_id(2, 92)), 'Hybrid promotion requires an explicit worker classification%');
  reset role;
  assert (select worker_classification from public.instructor_payroll_profiles where instructor_id = public._s9t_id(4, 42)) is null and not (select can_instruct from public.instructors where id = public._s9t_id(4, 42)), 'N3 FAILED: rejected promotion changed state';
  raise notice 'N1-N3 PASSED: NULL existing classification is established from the supplied value (active and inactive), prior NULL audited, invalid supplied values still fail';
end $$;

-- ============================================================================
-- X. Post-promotion drift is non-destructive; attestation cannot be cleared
-- ============================================================================
do $$
declare v_a uuid := public._s9t_id(0, 1); v_i uuid; v_c uuid := public._s9t_id(2, 70); v_n int; v_appt uuid; v_events int;
begin
  select id into v_i from public.instructors where user_id = public._s9t_id(1, 70) and studio_id = v_a;
  insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status)
  values (v_a, v_c, v_i, 'private_lesson', 'S9 future', now() + interval '3 days', now() + interval '3 days 1 hour', 'scheduled') returning id into v_appt;
  select count(*) into v_events from public.instructor_audit_events where instructor_id = v_i;

  set local role authenticated;
  perform public._s9t_jwt(2); -- admin edits payroll through the normal writer
  v_n := public._s9t_rows(format('update public.instructor_payroll_profiles set payroll_active = false, worker_classification = ''not_set'' where instructor_id = %L', v_i));
  assert v_n = 1, 'X1 FAILED: normal payroll edit';
  perform public._s9t_jwt(3); -- front desk removes the renter flag (allowed by D4)
  v_n := public._s9t_rows(format('update public.clients set is_independent_instructor = false where id = %L', v_c));
  assert v_n = 1, 'X2 FAILED: front desk renter edit kept';
  perform public._s9t_jwt(2);
  perform public._s9t_expect('X3 clear attestation', format('update public.instructors set hybrid_client_assignment_attested = false where id = %L', v_i), 'Hybrid attestation can only be changed%');
  reset role;

  assert (select active and can_instruct and hybrid_client_assignment_attested and user_id is not null from public.instructors where id = v_i), 'X4 FAILED: capability/active/link/attestation must remain';
  assert exists (select 1 from public.appointments where id = v_appt and status = 'scheduled' and instructor_id = v_i), 'X5 FAILED: future work must remain';
  assert (select count(*) from public.instructor_audit_events where instructor_id = v_i) = v_events, 'X6 FAILED: drift wrote an audit event';
  -- read-only mismatch audit query (report-only, no object): capable hybrid with payroll/renter drift
  assert exists (
    select 1 from public.instructors i
    where i.id = v_i and i.can_instruct and i.hybrid_client_assignment_attested
      and (not coalesce((select p.payroll_active from public.instructor_payroll_profiles p where p.instructor_id = i.id), false)
           or coalesce((select p.worker_classification from public.instructor_payroll_profiles p where p.instructor_id = i.id), 'not_set') not in ('employee', 'contractor')
           or not public._landmark1a_instructor_has_renter_relationship(i.studio_id, i.id))
  ), 'X7 FAILED: report-only mismatch query should surface the drifted hybrid';
  raise notice 'X1-X7 PASSED: payroll/renter drift leaves capability, activity, link, attestation and future work intact; attestation cannot be cleared; mismatch query reports it';
end $$;

-- ============================================================================
-- T. Slice 7 / Slice 8 integration
-- ============================================================================
do $$
declare v_a uuid := public._s9t_id(0, 1); v_i uuid; v_n int;
begin
  -- Direct tenant revoke can no longer bypass Slice 7's future-work protection.
  select id into v_i from public.instructors where user_id = public._s9t_id(1, 70) and studio_id = v_a;
  set local role authenticated;
  perform public._s9t_jwt(2);
  perform public._s9t_expect('T1 direct revoke with future work', format('update public.instructors set can_instruct = false where id = %L', v_i), 'Instructor capability can only be changed%');
  perform public._s9t_expect('T2 RPC revoke blocked by future work', format('select public.revoke_instructor_capability(%L, %L)', v_a, v_i), '%');
  reset role;
  assert (select can_instruct from public.instructors where id = v_i), 'T1 FAILED: revoke bypass';
  -- Slice 8 seat gate still protects trusted direct/system transitions (postgres path).
  perform public._s9t_instr(29, 3, 84, false);
  begin
    update public.instructors set can_instruct = true where id = public._s9t_id(4, 29);
    assert false, 'T3 FAILED: seat gate must still block a trusted direct transition at the limit';
  exception when others then
    assert sqlerrm like 'This studio has reached its instructor seat limit%', format('T3 unexpected: %s', sqlerrm);
  end;
  raise notice 'T1-T3 PASSED: direct revoke blocked, RPC revoke still protected by future work, seat gate still enforces trusted transitions';
  raise notice 'SLICE 9 CAPABILITY AUTHORITY SQL REGRESSION: ALL CASE GROUPS PASSED';
end $$;

rollback;
