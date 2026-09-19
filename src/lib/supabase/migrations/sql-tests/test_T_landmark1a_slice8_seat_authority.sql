-- Landmark 1A -- Slice 8 -- Migration B regression suite: counted-seat authority.
--
-- Covers 20260918080000_landmark1a_slice8_seat_authority.sql: canonical helpers,
-- the refactored Slice 6 authorization, the instructors seat-gate trigger, the
-- ownership seat-gate trigger, and get_instructor_seat_status. One
-- transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00001b8*),
-- rolled back at the end. Tenant behavior is simulated with `set local role` +
-- request.jwt.claims. Assumes both Slice 8 migrations are applied.
--
-- Studios: A (limit tests) B (move destination) O (owner tests) Z (limit 0)
-- Users:   00000000-0000-0000-0000-00001b8b{NNNN}  (N = 1..40)

begin;

create function pg_temp.uid(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-00001b8b' || lpad(n::text, 4, '0'))::uuid $$;
create function pg_temp.iid(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-00001b8c' || lpad(n::text, 4, '0'))::uuid $$;
create function pg_temp.fails(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
create function pg_temp.plan(p_studio uuid, p_plan text, p_override boolean default true) returns void language sql as $$
  update public.studios set billing_plan = p_plan::public.billing_plan, billing_override_enabled = p_override,
    billing_override_expires_at = null where id = p_studio $$;
create function pg_temp.usage(p_studio uuid) returns int language sql as $$
  select public._landmark1a_count_counted_seats(p_studio, null) $$;

-- Fixtures ------------------------------------------------------------------

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001b8a1000', 'S8 Seat A', 't-s8-seat-a'),
  ('00000000-0000-0000-0000-00001b8a2000', 'S8 Seat B', 't-s8-seat-b'),
  ('00000000-0000-0000-0000-00001b8a3000', 'S8 Seat O', 't-s8-seat-o'),
  ('00000000-0000-0000-0000-00001b8a4000', 'S8 Seat Z', 't-s8-seat-z'),
  ('00000000-0000-0000-0000-00001b8a5000', 'S8 Seat C (third)', 't-s8-seat-c');

insert into auth.users (id, email) select pg_temp.uid(n), 't-s8-seat-u' || n || '@example.test' from generate_series(1, 40) n;
insert into public.profiles (id, email, full_name)
  select id, email, 'S8 ' || email from auth.users where email like 't-s8-seat-u%' on conflict (id) do nothing;

-- Studio A roles: u1 admin, u2 front_desk, u3 instructor(role), u4 owner
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.uid(1), '00000000-0000-0000-0000-00001b8a1000', 'studio_admin', true),
  (pg_temp.uid(2), '00000000-0000-0000-0000-00001b8a1000', 'front_desk', true),
  (pg_temp.uid(3), '00000000-0000-0000-0000-00001b8a1000', 'instructor', true),
  (pg_temp.uid(4), '00000000-0000-0000-0000-00001b8a1000', 'studio_owner', true),
  (pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000', 'studio_owner', true),
  (pg_temp.uid(21), '00000000-0000-0000-0000-00001b8a3000', 'studio_admin', true),
  (pg_temp.uid(30), '00000000-0000-0000-0000-00001b8a2000', 'studio_admin', true);

select pg_temp.plan('00000000-0000-0000-0000-00001b8a1000', 'pro');
select pg_temp.plan('00000000-0000-0000-0000-00001b8a2000', 'starter');
select pg_temp.plan('00000000-0000-0000-0000-00001b8a3000', 'starter');
select pg_temp.plan('00000000-0000-0000-0000-00001b8a5000', 'pro');

-- Studio A instructors (all start NOT capable, inserted by postgres):
--  5,6,7 -> made capable below;  8 candidate;  9 inactive+capable;  10 incapable;  11 unlinked+capable;  4 = owner's row
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  (pg_temp.iid(4),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(4),  'Owner', 'S8', true, false),
  (pg_temp.iid(5),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(5),  'I5', 'S8', true, false),
  (pg_temp.iid(6),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(6),  'I6', 'S8', true, false),
  (pg_temp.iid(7),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(7),  'I7', 'S8', true, false),
  (pg_temp.iid(8),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(8),  'I8', 'S8', true, false),
  (pg_temp.iid(9),  '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(9),  'I9', 'S8', false, false),
  (pg_temp.iid(10), '00000000-0000-0000-0000-00001b8a1000', pg_temp.uid(10), 'I10', 'S8', true, false),
  (pg_temp.iid(11), '00000000-0000-0000-0000-00001b8a1000', null,            'I11', 'S8', true, false);

-- ============================================================================
-- H. Static checks
-- ============================================================================
do $$
declare v_def text; v_n int;
begin
  assert (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in
    ('_landmark1a_seat_counted','_landmark1a_is_studio_owner','_landmark1a_count_counted_seats','_landmark1a_assert_seat_available',
     '_landmark1a_enforce_instructor_seat_gate','_landmark1a_enforce_owner_seat_gate','get_instructor_seat_status')) = 7, 'H1 FAILED: expected 7 Slice 8 functions';

  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'landmark1a_enforce_instructor_seat_gate';
  assert v_def like '%BEFORE INSERT OR UPDATE OF active, can_instruct, user_id, studio_id ON public.instructors FOR EACH ROW%', format('H2 FAILED: %s', v_def);
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'landmark1a_enforce_owner_seat_gate';
  assert v_def like '%BEFORE DELETE OR UPDATE ON public.user_studio_roles FOR EACH ROW%', format('H3 FAILED: %s', v_def);

  -- Private helpers/triggers unreachable; only the status RPC is executable by authenticated.
  foreach v_def in array array['_landmark1a_seat_counted(boolean,boolean,uuid,boolean)','_landmark1a_is_studio_owner(uuid,uuid)','_landmark1a_count_counted_seats(uuid,uuid)','_landmark1a_assert_seat_available(uuid,uuid)','_landmark1a_enforce_instructor_seat_gate()','_landmark1a_enforce_owner_seat_gate()'] loop
    assert not has_function_privilege('authenticated', 'public.' || v_def, 'execute'), format('H4 FAILED: %s executable by authenticated', v_def);
    assert not has_function_privilege('anon', 'public.' || v_def, 'execute'), format('H4 FAILED: %s executable by anon', v_def);
    assert not has_function_privilege('service_role', 'public.' || v_def, 'execute'), format('H4 FAILED: %s executable by service_role', v_def);
  end loop;
  assert has_function_privilege('authenticated', 'public.get_instructor_seat_status(uuid)', 'execute'), 'H5 FAILED';
  assert not has_function_privilege('anon', 'public.get_instructor_seat_status(uuid)', 'execute'), 'H5 FAILED: anon';
  assert not has_function_privilege('service_role', 'public.get_instructor_seat_status(uuid)', 'execute'), 'H5 FAILED: service_role';

  -- One counted predicate / one owner source: no other function repeats them.
  select string_agg(proname, ',') into v_def from pg_proc
   where pronamespace = 'public'::regnamespace and proname like '\_landmark1a\_%'
     and proname not in ('_landmark1a_seat_counted', '_landmark1a_is_studio_owner')
     and (prosrc ~* 'usr\.role\s*=\s*''studio_owner''' and proname <> '_landmark1a_resolve_studio_seat_limit');
  assert v_def is null, format('H6 FAILED: owner predicate duplicated in %s', v_def);

  -- Slice 6 RPCs still delegate to the (refactored) authorize helper.
  assert (select prosrc ~ '_landmark1a_authorize_counted_transition' from pg_proc where proname = 'grant_instructor_capability'), 'H7 FAILED: grant';
  assert (select prosrc ~ '_landmark1a_authorize_counted_transition' from pg_proc where proname = 'reactivate_instructor'), 'H7 FAILED: reactivate';
  assert (select prosrc ~ '_landmark1a_authorize_counted_transition' from pg_proc where proname = 'promote_hybrid_instructor'), 'H7 FAILED: promote_hybrid';
  assert (select prosrc ~ '_landmark1a_assert_seat_available' from pg_proc where proname = '_landmark1a_authorize_counted_transition'), 'H7 FAILED: authorize does not use canonical helper';

  -- Lock hygiene: seat gate helpers/triggers never write the Slice 7 work tables.
  select count(*) into v_n from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('_landmark1a_assert_seat_available','_landmark1a_count_counted_seats','_landmark1a_enforce_instructor_seat_gate','_landmark1a_enforce_owner_seat_gate','get_instructor_seat_status')
    and prosrc ~* '(insert\s+into|update|delete\s+from)\s+public\.(appointments|booking_requests|student_booking_action_requests)';
  assert v_n = 0, 'H8 FAILED: seat gate writes a work table (lock-inversion risk)';

  assert exists (select 1 from pg_trigger where tgname = 'guard_profiles_platform_role'), 'H9 FAILED: hotfix guard';
  assert exists (select 1 from pg_trigger where tgname = 'guard_studios_entitlement_columns'), 'H9 FAILED: entitlement guard';
  raise notice 'H1-H9 PASSED: objects, trigger defs, privileges, single predicate, RPC delegation, lock hygiene, hotfix intact';
end $$;

-- ============================================================================
-- P. Parity: canonical count == the exact pre-Slice-8 Slice 6 count, for EVERY studio
-- ============================================================================
do $$
declare v_bad int; v_old int; v_new int; r record;
begin
  select count(*) into v_bad from public.studios s
  where public._landmark1a_count_counted_seats(s.id, null) is distinct from (
    select count(*)::int from public.instructors i
    where i.studio_id = s.id and i.active = true and i.can_instruct = true and i.user_id is not null
      and not exists (select 1 from public.user_studio_roles usr
        where usr.user_id = i.user_id and usr.studio_id = s.id and usr.role = 'studio_owner' and usr.active = true));
  assert v_bad = 0, format('P1 FAILED: canonical count differs from the Slice 6 predicate in %s studios', v_bad);

  -- exclusion parity for each instructor of studio A
  for r in select id from public.instructors where studio_id = '00000000-0000-0000-0000-00001b8a1000' loop
    v_old := (select count(*)::int from public.instructors i where i.studio_id = '00000000-0000-0000-0000-00001b8a1000'
      and i.id <> r.id and i.active and i.can_instruct and i.user_id is not null
      and not exists (select 1 from public.user_studio_roles usr where usr.user_id = i.user_id and usr.studio_id = i.studio_id and usr.role = 'studio_owner' and usr.active));
    v_new := public._landmark1a_count_counted_seats('00000000-0000-0000-0000-00001b8a1000', r.id);
    assert v_old = v_new, 'P2 FAILED: exclusion parity';
  end loop;
  raise notice 'P1-P2 PASSED: canonical counted usage is identical to the Slice 6 predicate (all studios, with/without exclusion)';
end $$;

-- ============================================================================
-- L. Limits and DIRECT-writer enforcement (postgres, service_role, authenticated)
-- ============================================================================
do $$
declare v_err text; v_n int;
begin
  -- Pro override: limit 15 in studio A. Build usage 3 via direct updates (gate authorizes each).
  update public.instructors set can_instruct = true where id in (pg_temp.iid(5), pg_temp.iid(6), pg_temp.iid(7));
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 3, 'L1 FAILED: usage should be 3';
  -- Owner-instructor is FREE (owner exclusion exists exactly once through canonical semantics).
  update public.instructors set can_instruct = true where id = pg_temp.iid(4);
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 3, 'L2 FAILED: owner-instructor must not be counted';

  -- Studio B (starter: limit 1): below / at / one over.
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
    (pg_temp.iid(31), '00000000-0000-0000-0000-00001b8a2000', pg_temp.uid(31), 'B31', 'S8', true, false),
    (pg_temp.iid(32), '00000000-0000-0000-0000-00001b8a2000', pg_temp.uid(32), 'B32', 'S8', true, false);
  update public.instructors set can_instruct = true where id = pg_temp.iid(31);        -- 0 -> 1 (exactly at limit): allowed
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a2000') = 1, 'L3 FAILED';
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(32)));
  assert v_err like '%reached its instructor seat limit%', format('L3 FAILED: at-limit transition not rejected: %s', v_err);

  -- Direct INSERT of an already-counted row is gated too.
  v_err := pg_temp.fails(format('insert into public.instructors (studio_id, user_id, first_name, last_name, active, can_instruct) values (%L, %L, ''N'', ''S8'', true, true)', '00000000-0000-0000-0000-00001b8a2000', pg_temp.uid(33)));
  assert v_err like '%reached its instructor seat limit%', format('L4 FAILED: counted INSERT not rejected: %s', v_err);

  -- Every kind of transition INTO the counted set is rejected at the limit (studio B usage=1, limit=1):
  update public.instructors set active = false, can_instruct = true where id = pg_temp.iid(32);                   -- inactive+capable (not counted)
  v_err := pg_temp.fails(format('update public.instructors set active = true where id = %L', pg_temp.iid(32)));
  assert v_err like '%reached its instructor seat limit%', format('L5a FAILED inactive->active: %s', v_err);
  update public.instructors set active = true, can_instruct = false where id = pg_temp.iid(32);
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(32)));
  assert v_err like '%reached its instructor seat limit%', format('L5b FAILED incapable->capable: %s', v_err);
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
    (pg_temp.iid(34), '00000000-0000-0000-0000-00001b8a2000', null, 'B34', 'S8', true, true);                  -- unlinked+capable: not counted, allowed
  v_err := pg_temp.fails(format('update public.instructors set user_id = %L where id = %L', pg_temp.uid(34), pg_temp.iid(34)));
  assert v_err like '%reached its instructor seat limit%', format('L5c FAILED unlinked->linked: %s', v_err);

  -- Studio move: a counted instructor from studio C (pro) moved into full studio B is rejected.
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
    (pg_temp.iid(35), '00000000-0000-0000-0000-00001b8a5000', pg_temp.uid(35), 'C35', 'S8', true, false);
  update public.instructors set can_instruct = true where id = pg_temp.iid(35);
  v_err := pg_temp.fails(format('update public.instructors set studio_id = %L where id = %L', '00000000-0000-0000-0000-00001b8a2000', pg_temp.iid(35)));
  assert v_err like '%reached its instructor seat limit%', format('L5d FAILED studio move: %s', v_err);

  -- Direct service-role write: gated. Direct authenticated (front desk via RLS): gated.
  set local role service_role;
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(32)));
  reset role;
  assert v_err like '%reached its instructor seat limit%', format('L6 FAILED service_role bypass: %s', v_err);
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(30), 'email', 't-s8-seat-u30@example.test')::text, true);
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(32)));
  reset role;
  assert v_err like '%reached its instructor seat limit%', format('L7 FAILED authenticated staff bypass: %s', v_err);

  -- Non-increasing / neutral edits still allowed at the limit.
  update public.instructors set first_name = 'Renamed' where id = pg_temp.iid(31);                 -- metadata
  update public.instructors set active = active, can_instruct = can_instruct, user_id = user_id where id = pg_temp.iid(31); -- UPDATE OF listed cols, no change
  update public.instructors set can_instruct = false where id = pg_temp.iid(31);                   -- reduction
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a2000') = 0, 'L8 FAILED: reduction';
  update public.instructors set can_instruct = true where id = pg_temp.iid(32);                     -- 0 -> 1 now fits
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a2000') = 1, 'L8 FAILED: fits after reduction';
  raise notice 'L1-L8 PASSED: at-limit rejections for every transition kind incl. INSERT, studio move, service_role and authenticated writers; neutral/reduction edits allowed';
end $$;

-- ============================================================================
-- D. Downgrade -> over limit (derived); frozen expansion; remediation; strict rule
-- ============================================================================
do $$
declare v_err text; r record;
begin
  -- Studio A: usage 3. Downgrade to Starter (limit 1) => over limit by 2. Nothing is auto-changed.
  perform pg_temp.plan('00000000-0000-0000-0000-00001b8a1000', 'starter');
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a1000') = 1, 'D1 FAILED: limit';
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 3, 'D1 FAILED: downgrade must not change usage';
  assert (select count(*) from public.instructors where studio_id = '00000000-0000-0000-0000-00001b8a1000' and active and can_instruct) = 4, 'D1 FAILED: downgrade must not deactivate/revoke anyone (incl. free owner row)';

  -- Status RPC as studio admin (u1): (1, 3, true). Derived live, no persisted flag.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  select * into r from public.get_instructor_seat_status('00000000-0000-0000-0000-00001b8a1000');
  reset role;
  assert r.seat_limit = 1 and r.counted_usage = 3 and r.over_limit = true, format('D2 FAILED: status %s/%s/%s', r.seat_limit, r.counted_usage, r.over_limit);

  -- While over limit: existing instructors keep working (assignable), metadata edits ok.
  perform public._landmark1a_assert_assignable_instructor('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(5));
  update public.instructors set first_name = 'StillWorks' where id = pg_temp.iid(5);
  update public.instructors set active = active where id = pg_temp.iid(5);  -- counted row, same studio: no increase

  -- Expansion frozen: RPC grant / reactivate rejected (admin u1).
  update public.instructors set active = false, can_instruct = true where id = pg_temp.iid(9);  -- inactive+capable (not counted) -- allowed: not a counted transition
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  begin perform public.grant_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(8)); assert false, 'D3 FAILED: grant while over limit';
  exception when others then assert sqlerrm like '%reached its instructor seat limit%', format('D3 unexpected: %s', sqlerrm); end;
  begin perform public.reactivate_instructor('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(9)); assert false, 'D4 FAILED: reactivation while over limit';
  exception when others then assert sqlerrm like '%reached its instructor seat limit%', format('D4 unexpected: %s', sqlerrm); end;
  reset role;
  v_err := pg_temp.fails(format('update public.instructors set active = true where id = %L', pg_temp.iid(9)));
  assert v_err like '%reached its instructor seat limit%', 'D4b FAILED: direct reactivation while over limit';

  -- Remediation: deactivate (usage 3 -> 2), revoke via Slice 7 RPC (2 -> 1). Both allowed while over limit.
  update public.instructors set active = false where id = pg_temp.iid(5);
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 2, 'D5 FAILED: deactivation';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  perform public.revoke_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(6));
  reset role;
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 1, 'D5 FAILED: revocation';

  -- STRICT rule: usage == limit (1). A grant would make it 2 > 1 -> still rejected (NOT merely "no increase while over").
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  begin perform public.grant_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(8)); assert false, 'D6 FAILED: grant at exactly the limit';
  exception when others then assert sqlerrm like '%reached its instructor seat limit%', format('D6 unexpected: %s', sqlerrm); end;
  -- A seat-neutral "swap" as separate ops cannot happen until the grant result fits: revoke the last one first.
  perform public.revoke_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(7));
  reset role;
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 0, 'D7 FAILED';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(8));  -- result 1 <= 1: allowed
  begin perform public.grant_instructor_capability('00000000-0000-0000-0000-00001b8a1000', pg_temp.iid(10)); assert false, 'D8 FAILED: second grant';
  exception when others then assert sqlerrm like '%reached its instructor seat limit%', format('D8 unexpected: %s', sqlerrm); end;
  reset role;
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 1, 'D8 FAILED: final usage';
  raise notice 'D1-D8 PASSED: downgrade leaves usage intact; expansion frozen; deactivate/revoke allowed; strict rule (result must fit); grant works once it fits';
end $$;

-- ============================================================================
-- V. Overrides and fail-closed limits
-- ============================================================================
do $$
declare v_err text;
begin
  -- Higher override raises the limit -> previously refused grant now works.
  perform pg_temp.plan('00000000-0000-0000-0000-00001b8a1000', 'growth');
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a1000') = 5, 'V1 FAILED';
  update public.instructors set can_instruct = true where id = pg_temp.iid(10);
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') = 2, 'V1 FAILED: grant under raised limit';

  -- Override removal can create over-limit (falls back to studio plan/status: starter/trialing => limit 1).
  update public.studios set billing_override_enabled = false, billing_plan = 'starter' where id = '00000000-0000-0000-0000-00001b8a1000';
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a1000') = 1, 'V2 FAILED: fallback limit';
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a1000') > public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a1000'), 'V2 FAILED: should now be over limit';
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(11)));
  assert v_err is null, 'V2 sanity: unlinked row is not counted so enabling capability on it is not a counted transition';

  -- Unknown / non-instructor plan fails closed (organizer => 0); inactive subscription => 0.
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
    (pg_temp.iid(36), '00000000-0000-0000-0000-00001b8a4000', pg_temp.uid(36), 'Z36', 'S8', true, false);
  perform pg_temp.plan('00000000-0000-0000-0000-00001b8a4000', 'organizer');
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a4000') = 0, 'V3 FAILED: organizer must resolve 0';
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(36)));
  assert v_err like '%reached its instructor seat limit%', 'V3 FAILED: limit 0 must reject';
  update public.studios set billing_override_enabled = false, billing_plan = 'pro', subscription_status = 'cancelled' where id = '00000000-0000-0000-0000-00001b8a4000';
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b8a4000') = 0, 'V4 FAILED: cancelled => 0';
  v_err := pg_temp.fails(format('update public.instructors set can_instruct = true where id = %L', pg_temp.iid(36)));
  assert v_err like '%reached its instructor seat limit%', 'V4 FAILED: inactive subscription must reject';
  raise notice 'V1-V4 PASSED: raised override admits; removal creates over-limit; unknown plan and inactive status fail closed';
end $$;

-- ============================================================================
-- O. Ownership transitions
-- ============================================================================
do $$
declare v_err text; v_n int;
begin
  -- Studio O (starter, limit 1). Owner u20 is a capable instructor (free). Instructor row for owner + candidate X.
  insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
    (pg_temp.iid(20), '00000000-0000-0000-0000-00001b8a3000', pg_temp.uid(20), 'OwnerO', 'S8', true, false),
    (pg_temp.iid(22), '00000000-0000-0000-0000-00001b8a3000', pg_temp.uid(22), 'X22', 'S8', true, false),
    (pg_temp.iid(23), '00000000-0000-0000-0000-00001b8a3000', pg_temp.uid(23), 'X23', 'S8', true, false);
  update public.instructors set can_instruct = true where id = pg_temp.iid(20);          -- owner: free
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 0, 'O1 FAILED: owner counted';

  -- O2. Below limit (usage 0): owner -> non-owner succeeds (result 1 <= 1). Then restore owner.
  update public.user_studio_roles set role = 'studio_admin' where user_id = pg_temp.uid(20) and studio_id = '00000000-0000-0000-0000-00001b8a3000';
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 1, 'O2 FAILED: former owner should now be counted';
  update public.user_studio_roles set role = 'studio_owner' where user_id = pg_temp.uid(20) and studio_id = '00000000-0000-0000-0000-00001b8a3000'; -- becoming owner: always allowed
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 0, 'O2 FAILED: becoming owner reduces usage';

  -- O3. At limit (usage 1): every way of losing owner status is rejected.
  update public.instructors set can_instruct = true where id = pg_temp.iid(22);
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 1, 'O3 setup';
  v_err := pg_temp.fails(format('update public.user_studio_roles set role = ''studio_admin'' where user_id = %L and studio_id = %L', pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O3 FAILED role change: %s', v_err);
  v_err := pg_temp.fails(format('update public.user_studio_roles set role = ''instructor'' where user_id = %L and studio_id = %L', pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O3 FAILED role->instructor: %s', v_err);
  v_err := pg_temp.fails(format('update public.user_studio_roles set active = false where user_id = %L and studio_id = %L', pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O3 FAILED deactivate: %s', v_err);
  v_err := pg_temp.fails(format('delete from public.user_studio_roles where user_id = %L and studio_id = %L', pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O3 FAILED delete: %s', v_err);
  v_err := pg_temp.fails(format('update public.user_studio_roles set studio_id = %L where user_id = %L and studio_id = %L', '00000000-0000-0000-0000-00001b8a2000', pg_temp.uid(20), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O3 FAILED role move: %s', v_err);
  assert (select role::text from public.user_studio_roles where user_id = pg_temp.uid(20) and studio_id = '00000000-0000-0000-0000-00001b8a3000') = 'studio_owner', 'O3 FAILED: owner row changed';

  -- O4. A non-instructor owner/admin role change is never gated (no instructor row): admin u21 -> front_desk ok.
  update public.user_studio_roles set role = 'front_desk' where user_id = pg_temp.uid(21) and studio_id = '00000000-0000-0000-0000-00001b8a3000';

  -- O5. Transfer between two instructors: promote X22 (counted) to owner FIRST (reduces usage), then demoting A fits.
  insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.uid(22), '00000000-0000-0000-0000-00001b8a3000', 'instructor', true);
  update public.user_studio_roles set role = 'studio_owner' where user_id = pg_temp.uid(22) and studio_id = '00000000-0000-0000-0000-00001b8a3000';
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 0, 'O5 FAILED: counted instructor -> owner must reduce usage';
  update public.user_studio_roles set role = 'studio_admin' where user_id = pg_temp.uid(20) and studio_id = '00000000-0000-0000-0000-00001b8a3000';
  assert pg_temp.usage('00000000-0000-0000-0000-00001b8a3000') = 1, 'O5 FAILED: transfer result should fit (1 <= 1)';
  -- ...and while already over/at limit a further demotion of the NEW owner (also a capable instructor) is rejected.
  v_err := pg_temp.fails(format('update public.user_studio_roles set role = ''studio_admin'' where user_id = %L and studio_id = %L', pg_temp.uid(22), '00000000-0000-0000-0000-00001b8a3000'));
  assert v_err like '%reached its instructor seat limit%', format('O5 FAILED over-limit transfer: %s', v_err);

  -- O6. Tenants cannot manipulate role rows directly (RLS has no write policies).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(21), 'email', 't-s8-seat-u21@example.test')::text, true);
  update public.user_studio_roles set role = 'studio_owner' where user_id = pg_temp.uid(21) and studio_id = '00000000-0000-0000-0000-00001b8a3000';
  get diagnostics v_n = row_count;
  reset role;
  assert v_n = 0, 'O6 FAILED: tenant updated a role row';

  -- O7. Account-deletion cascade is never blocked by the gate: delete user 22 (owner with a
  -- capable instructor row) while the studio is at its limit.
  delete from auth.users where id = pg_temp.uid(22);
  assert not exists (select 1 from public.user_studio_roles where user_id = pg_temp.uid(22)), 'O7 FAILED: role not cascaded';
  assert (select user_id from public.instructors where id = pg_temp.iid(22)) is null, 'O7 FAILED: instructor row should be unlinked by the FK';
  raise notice 'O1-O7 PASSED: owner free; demotion/deactivate/delete/move gated at limit; becoming owner ok; transfer order; RLS blocks tenants; user-deletion cascade unblocked';
end $$;

-- Studio deletion cascade is not blocked either.
do $$
begin
  delete from public.studios where id = '00000000-0000-0000-0000-00001b8a3000';
  assert not exists (select 1 from public.studios where id = '00000000-0000-0000-0000-00001b8a3000'), 'O8 FAILED: studio delete blocked';
  raise notice 'O8 PASSED: studio deletion cascade unblocked';
end $$;

-- ============================================================================
-- S. Seat-status RPC authorization and shape
-- ============================================================================
do $$
declare r record; v_cols text;
begin
  -- Owner-role staff, front desk, and platform admin can read; plain instructor role / other studio / unauthenticated cannot.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(2), 'email', 't-s8-seat-u2@example.test')::text, true);
  select * into r from public.get_instructor_seat_status('00000000-0000-0000-0000-00001b8a1000');
  assert r.seat_limit is not null, 'S1 FAILED: front desk should read status';

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(3), 'email', 't-s8-seat-u3@example.test')::text, true);
  begin perform * from public.get_instructor_seat_status('00000000-0000-0000-0000-00001b8a1000'); assert false, 'S2 FAILED: instructor role read status';
  exception when others then assert sqlerrm like 'Not authorized%', format('S2 unexpected: %s', sqlerrm); end;

  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(1), 'email', 't-s8-seat-u1@example.test')::text, true);
  begin perform * from public.get_instructor_seat_status('00000000-0000-0000-0000-00001b8a2000'); assert false, 'S3 FAILED: cross-studio read';
  exception when others then assert sqlerrm like 'Not authorized%', format('S3 unexpected: %s', sqlerrm); end;

  perform set_config('request.jwt.claims', '{}', true);
  begin perform * from public.get_instructor_seat_status('00000000-0000-0000-0000-00001b8a1000'); assert false, 'S4 FAILED: unauthenticated';
  exception when others then assert sqlerrm = 'Not authenticated.', format('S4 unexpected: %s', sqlerrm); end;
  reset role;

  -- Shape: exactly (seat_limit, counted_usage, over_limit) -- no PII/billing identifiers.
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
  from pg_proc p, unnest(p.proargnames) with ordinality n(attname, attnum) join pg_attribute a on false
  where false;
  assert (select pg_get_function_result(oid) from pg_proc where proname = 'get_instructor_seat_status') = 'TABLE(seat_limit integer, counted_usage integer, over_limit boolean)', 'S5 FAILED: result shape';
  raise notice 'S1-S5 PASSED: status RPC authorization, cross-studio, unauthenticated, exact non-PII shape';
  raise notice 'LANDMARK 1A SLICE 8 SEAT AUTHORITY SQL REGRESSION: ALL CASE GROUPS PASSED';
end $$;

rollback;
