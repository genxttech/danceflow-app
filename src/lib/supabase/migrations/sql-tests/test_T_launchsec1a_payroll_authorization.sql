-- LAUNCH-SEC-1A -- payroll RPC authorization, live-Postgres regression suite.
--
-- Proves that every payroll RPC hardened by
-- 20261004090000_launchsec1a_payroll_authorization_fail_closed.sql fails
-- closed at the database API boundary (direct RPC invocation as the
-- `authenticated` role) for callers with no studio role, a role in another
-- studio, the instructor role and the front_desk role -- with zero payroll
-- row changes -- while studio_owner/studio_admin keep their intended access
-- and studio_admin stays denied from the owner-only RPCs. Entire script runs
-- in one transaction and is rolled back at the end -- nothing persists. Run
-- via `supabase db query --linked --file <this file>` against DEV, AFTER
-- 20261004090000 has been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000f9XXXX

begin;

-- ============================================================================
-- FIXTURES (as the migration owner; RLS/triggers do not block fixture setup)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000f90001', 'LAUNCH-SEC-1A Studio A', 't-launchsec1a-a'),
  ('00000000-0000-0000-0000-000000f90002', 'LAUNCH-SEC-1A Studio B', 't-launchsec1a-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f91001', 't-launchsec1a-owner-a@example.test'),
  ('00000000-0000-0000-0000-000000f91002', 't-launchsec1a-admin-a@example.test'),
  ('00000000-0000-0000-0000-000000f91003', 't-launchsec1a-instructor-a@example.test'),
  ('00000000-0000-0000-0000-000000f91004', 't-launchsec1a-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-000000f91005', 't-launchsec1a-owner-b@example.test'),
  ('00000000-0000-0000-0000-000000f91006', 't-launchsec1a-norole@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f91001', 't-launchsec1a-owner-a@example.test', null),
  ('00000000-0000-0000-0000-000000f91002', 't-launchsec1a-admin-a@example.test', null),
  ('00000000-0000-0000-0000-000000f91003', 't-launchsec1a-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-000000f91004', 't-launchsec1a-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-000000f91005', 't-launchsec1a-owner-b@example.test', null),
  ('00000000-0000-0000-0000-000000f91006', 't-launchsec1a-norole@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f91001', '00000000-0000-0000-0000-000000f90001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f91002', '00000000-0000-0000-0000-000000f90001', 'studio_admin', true),
  ('00000000-0000-0000-0000-000000f91003', '00000000-0000-0000-0000-000000f90001', 'instructor', true),
  ('00000000-0000-0000-0000-000000f91004', '00000000-0000-0000-0000-000000f90001', 'front_desk', true),
  ('00000000-0000-0000-0000-000000f91005', '00000000-0000-0000-0000-000000f90002', 'studio_owner', true);

-- Studio A payroll fixtures: an open pay period with a draft batch, and an
-- empty open pay period.
insert into public.payroll_pay_periods (id, studio_id, period_start, period_end, status) values
  ('00000000-0000-0000-0000-000000f95001', '00000000-0000-0000-0000-000000f90001', date '2026-01-01', date '2026-01-15', 'open'),
  ('00000000-0000-0000-0000-000000f95002', '00000000-0000-0000-0000-000000f90001', date '2026-01-16', date '2026-01-31', 'open');

insert into public.payroll_batches (id, studio_id, pay_period_id, batch_number, status) values
  ('00000000-0000-0000-0000-000000f96001', '00000000-0000-0000-0000-000000f90001', '00000000-0000-0000-0000-000000f95001', 990001, 'draft');

-- Fingerprint of every studio A payroll row, compared after each rejected call.
create temporary table launchsec1a_snapshot on commit drop as
select
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.payroll_pay_periods t
     where t.studio_id = '00000000-0000-0000-0000-000000f90001') as periods,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.payroll_batches t
     where t.studio_id = '00000000-0000-0000-0000-000000f90001') as batches,
  (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.instructor_earnings t
     where t.studio_id = '00000000-0000-0000-0000-000000f90001') as earnings,
  (select count(*) from public.payroll_pay_periods) as period_count,
  (select count(*) from public.payroll_batches) as batch_count;
grant select on launchsec1a_snapshot to authenticated;

-- ============================================================================
-- UNAUTHORIZED CALLERS: all 8 RPCs rejected, zero payroll change
-- ============================================================================

do $$
declare
  v_caller record;
  v_call record;
  v_ok boolean;
  v_before launchsec1a_snapshot%rowtype;
  v_after record;
  v_studio constant uuid := '00000000-0000-0000-0000-000000f90001';
begin
  select * into v_before from launchsec1a_snapshot;

  for v_caller in
    select * from (values
      ('00000000-0000-0000-0000-000000f91006'::uuid, 'no-role'),
      ('00000000-0000-0000-0000-000000f91005'::uuid, 'other-studio-owner'),
      ('00000000-0000-0000-0000-000000f91003'::uuid, 'instructor'),
      ('00000000-0000-0000-0000-000000f91004'::uuid, 'front_desk')
    ) as c(user_id, label)
  loop
    for v_call in
      select * from (values
        ('create_payroll_pay_period',
         format('select public.create_payroll_pay_period(%L, date ''2026-02-01'', date ''2026-02-15'', null)', v_studio),
         'Payroll access denied.'),
        ('assign_earnings_to_pay_period',
         format('select public.assign_earnings_to_pay_period(%L, %L)', v_studio, '00000000-0000-0000-0000-000000f95001'),
         'Payroll access denied.'),
        ('assign_single_earning_to_pay_period',
         format('select public.assign_single_earning_to_pay_period(%L, %L, %L)', v_studio, '00000000-0000-0000-0000-000000f95001', '00000000-0000-0000-0000-000000f97001'),
         'Payroll access denied.'),
        ('remove_earning_from_pay_period',
         format('select public.remove_earning_from_pay_period(%L, %L, %L)', v_studio, '00000000-0000-0000-0000-000000f95001', '00000000-0000-0000-0000-000000f97001'),
         'Payroll access denied.'),
        ('create_payroll_batch_from_period',
         format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_studio, '00000000-0000-0000-0000-000000f95001'),
         'Payroll access denied.'),
        ('approve_payroll_batch',
         format('select public.approve_payroll_batch(%L, %L)', v_studio, '00000000-0000-0000-0000-000000f96001'),
         'Payroll access denied.'),
        ('mark_payroll_batch_paid',
         format('select public.mark_payroll_batch_paid(%L, %L, ''external_payroll'', null)', v_studio, '00000000-0000-0000-0000-000000f96001'),
         'Only the studio owner can mark payroll paid.'),
        ('void_empty_payroll_pay_period',
         format('select public.void_empty_payroll_pay_period(%L, %L, ''harness'')', v_studio, '00000000-0000-0000-0000-000000f95002'),
         'Only the studio owner can void a pay period.')
      ) as f(name, stmt, expected)
    loop
      v_ok := false;
      begin
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub', v_caller.user_id, 'role', 'authenticated')::text, true);
        execute v_call.stmt;
      exception when others then
        if sqlerrm = v_call.expected then
          v_ok := true;
        else
          reset role;
          raise exception 'FAIL T-launchsec1a-reject %/%: unexpected error "%"', v_caller.label, v_call.name, sqlerrm;
        end if;
      end;
      reset role;
      if not v_ok then
        raise exception 'FAIL T-launchsec1a-reject %/%: call succeeded', v_caller.label, v_call.name;
      end if;

      select
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.payroll_pay_periods t where t.studio_id = v_studio) as periods,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.payroll_batches t where t.studio_id = v_studio) as batches,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.instructor_earnings t where t.studio_id = v_studio) as earnings,
        (select count(*) from public.payroll_pay_periods) as period_count,
        (select count(*) from public.payroll_batches) as batch_count
      into v_after;
      if v_after.periods is distinct from v_before.periods
         or v_after.batches is distinct from v_before.batches
         or v_after.earnings is distinct from v_before.earnings
         or v_after.period_count <> v_before.period_count
         or v_after.batch_count <> v_before.batch_count then
        raise exception 'FAIL T-launchsec1a-reject %/%: payroll rows changed', v_caller.label, v_call.name;
      end if;
    end loop;
  end loop;

  -- The bypass setting is transaction-local and set only after the guard;
  -- a rejected call must not leave it enabled.
  if public.payroll_transition_bypass_enabled() then
    raise exception 'FAIL T-launchsec1a-bypass-not-left-enabled';
  end if;

  raise notice 'PASS T-launchsec1a-unauthorized-rejected (4 callers x 8 RPCs, 0 payroll changes)';
end $$;

-- ============================================================================
-- TRIGGER PROTECTION STILL INTACT: an unauthorized direct status write fails
-- ============================================================================

do $$
declare
  v_status text;
begin
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000f91004', 'role', 'authenticated')::text, true);
    update public.payroll_batches set status = 'paid'
      where id = '00000000-0000-0000-0000-000000f96001';
  exception when others then
    null; -- RLS or the transition trigger may reject; either is acceptable
  end;
  reset role;
  select status into v_status from public.payroll_batches where id = '00000000-0000-0000-0000-000000f96001';
  if v_status <> 'draft' then
    raise exception 'FAIL T-launchsec1a-direct-write-blocked: status=%', v_status;
  end if;
  raise notice 'PASS T-launchsec1a-direct-write-blocked';
end $$;

-- ============================================================================
-- AUTHORIZED CALLERS
-- ============================================================================

do $$
declare
  v_id uuid;
  v_status text;
  v_msg text;
  v_studio constant uuid := '00000000-0000-0000-0000-000000f90001';
  v_owner constant uuid := '00000000-0000-0000-0000-000000f91001';
  v_admin constant uuid := '00000000-0000-0000-0000-000000f91002';
begin
  -- studio_admin: owner/admin RPCs pass authorization.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_id := public.create_payroll_pay_period(v_studio, date '2026-03-01', date '2026-03-15', null);
  perform public.assign_earnings_to_pay_period(v_studio, '00000000-0000-0000-0000-000000f95002');
  perform public.approve_payroll_batch(v_studio, '00000000-0000-0000-0000-000000f96001');
  reset role;
  if v_id is null then raise exception 'FAIL T-launchsec1a-admin-create-period'; end if;
  select status into v_status from public.payroll_batches where id = '00000000-0000-0000-0000-000000f96001';
  if v_status <> 'approved' then raise exception 'FAIL T-launchsec1a-admin-approve: %', v_status; end if;

  -- studio_admin passes the guard of RPCs that need richer fixtures: the
  -- error must be a business error, never the access-denied guard.
  foreach v_msg in array array[
    format('select public.assign_single_earning_to_pay_period(%L, %L, %L)', v_studio, '00000000-0000-0000-0000-000000f95002', '00000000-0000-0000-0000-000000f97001'),
    format('select public.remove_earning_from_pay_period(%L, %L, %L)', v_studio, '00000000-0000-0000-0000-000000f95002', '00000000-0000-0000-0000-000000f97001'),
    format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_studio, '00000000-0000-0000-0000-000000f95002')
  ] loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
      execute v_msg;
      reset role;
    exception when others then
      reset role;
      if sqlerrm = 'Payroll access denied.' then
        raise exception 'FAIL T-launchsec1a-admin-guard-pass: % -> %', v_msg, sqlerrm;
      end if;
    end;
  end loop;

  -- studio_admin is still denied the owner-only RPCs.
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform public.mark_payroll_batch_paid(v_studio, '00000000-0000-0000-0000-000000f96001', 'external_payroll', null);
    raise exception 'FAIL T-launchsec1a-admin-mark-paid-denied';
  exception when others then
    if sqlerrm <> 'Only the studio owner can mark payroll paid.' then raise; end if;
  end;
  reset role;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform public.void_empty_payroll_pay_period(v_studio, v_id, 'harness');
    raise exception 'FAIL T-launchsec1a-admin-void-denied';
  exception when others then
    if sqlerrm <> 'Only the studio owner can void a pay period.' then raise; end if;
  end;
  reset role;
  select status into v_status from public.payroll_batches where id = '00000000-0000-0000-0000-000000f96001';
  if v_status <> 'approved' then raise exception 'FAIL T-launchsec1a-admin-owner-only-no-write: %', v_status; end if;

  -- studio_owner: owner-only RPCs succeed.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform public.mark_payroll_batch_paid(v_studio, '00000000-0000-0000-0000-000000f96001', 'external_payroll', null);
  perform public.void_empty_payroll_pay_period(v_studio, v_id, 'harness');
  perform public.create_payroll_pay_period(v_studio, date '2026-04-01', date '2026-04-15', null);
  reset role;
  select status into v_status from public.payroll_batches where id = '00000000-0000-0000-0000-000000f96001';
  if v_status <> 'paid' then raise exception 'FAIL T-launchsec1a-owner-mark-paid: %', v_status; end if;
  select status into v_status from public.payroll_pay_periods where id = v_id;
  if v_status <> 'void' then raise exception 'FAIL T-launchsec1a-owner-void: %', v_status; end if;

  raise notice 'PASS T-launchsec1a-authorized-behavior';
end $$;

do $$ begin raise notice 'LAUNCH-SEC-1A SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
