-- Phase 9A -- payroll integrity, live-Postgres regression suite.
--
-- Proves 20261102090000_phase9a_payroll_integrity.sql: studio-scoped,
-- fail-closed payroll RPCs (including the cross-studio approve_payroll_batch
-- defect), same-studio payroll references, the earning lock on INSERT and
-- UPDATE, explicit earning/batch/period transition graphs, payment only
-- through an approved batch by the studio owner or a platform admin,
-- re-review after an approved amount changes, and live totals.
-- Entire script runs in one transaction and is rolled back -- nothing
-- persists. Run via `supabase db query --linked --file <this file>` against
-- DEV, AFTER 20261102090000 has been applied. Run the LAUNCH-SEC-1A suite
-- (test_T_launchsec1a_payroll_authorization.sql) alongside it.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000009aXXXX

begin;

-- ============================================================================
-- HARNESS
-- ============================================================================

create temporary table t9a_passes (label text) on commit drop;

-- Runs p_sql as `authenticated` with auth.uid() = p_user; returns 'OK' or the error.
create function pg_temp.run_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_err text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    execute p_sql;
    execute 'reset role';
  exception when others then
    v_err := sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return coalesce(v_err, 'OK');
end $$;

-- Runs p_sql as the migration owner, optionally with the payroll transition
-- bypass set (simulating a canonical RPC context); returns 'OK' or the error.
create function pg_temp.run_trusted(p_sql text, p_bypass boolean default false) returns text language plpgsql as $$
declare v_err text;
begin
  begin
    if p_bypass then perform set_config('danceflow.payroll_transition_bypass', '1', true); end if;
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  perform set_config('danceflow.payroll_transition_bypass', '', true);
  return coalesce(v_err, 'OK');
end $$;

create function pg_temp.expect_ok(p_label text, p_res text) returns void language plpgsql as $$
begin
  if p_res is distinct from 'OK' then raise exception 'FAIL %: %', p_label, p_res; end if;
  insert into t9a_passes values (p_label);
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.expect_err(p_label text, p_res text, p_like text) returns void language plpgsql as $$
begin
  if p_res = 'OK' or p_res not like '%' || p_like || '%' then
    raise exception 'FAIL %: expected error like "%", got "%"', p_label, p_like, p_res;
  end if;
  insert into t9a_passes values (p_label);
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.expect(p_label text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %: %', p_label, coalesce(p_detail, 'condition false'); end if;
  insert into t9a_passes values (p_label);
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.period_status(p_id uuid) returns text language sql as $$
  select status from public.payroll_pay_periods where id = p_id $$;
create function pg_temp.batch_status(p_id uuid) returns text language sql as $$
  select status from public.payroll_batches where id = p_id $$;
create function pg_temp.earning_status(p_id uuid) returns text language sql as $$
  select status from public.instructor_earnings where id = p_id $$;

-- ============================================================================
-- FIXTURES (as the migration owner; the 9A triggers still apply)
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000009a0001', 'Phase 9A Studio A', 't-phase9a-a'),
  ('00000000-0000-0000-0000-0000009a0002', 'Phase 9A Studio B', 't-phase9a-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000009a1001', 't-phase9a-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000009a1002', 't-phase9a-admin-a@example.test'),
  ('00000000-0000-0000-0000-0000009a1003', 't-phase9a-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000009a1004', 't-phase9a-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000009a1005', 't-phase9a-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000009a1006', 't-phase9a-platform@example.test'),
  ('00000000-0000-0000-0000-0000009a1007', 't-phase9a-norole@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000009a1001', 't-phase9a-owner-a@example.test', null),
  ('00000000-0000-0000-0000-0000009a1002', 't-phase9a-admin-a@example.test', null),
  ('00000000-0000-0000-0000-0000009a1003', 't-phase9a-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-0000009a1004', 't-phase9a-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-0000009a1005', 't-phase9a-owner-b@example.test', null),
  ('00000000-0000-0000-0000-0000009a1006', 't-phase9a-platform@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000009a1007', 't-phase9a-norole@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000009a1001', '00000000-0000-0000-0000-0000009a0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000009a1002', '00000000-0000-0000-0000-0000009a0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000009a1003', '00000000-0000-0000-0000-0000009a0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000009a1004', '00000000-0000-0000-0000-0000009a0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000009a1005', '00000000-0000-0000-0000-0000009a0002', 'studio_owner', true);

insert into public.instructors (id, studio_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000009a2001', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'Alpha', true),
  ('00000000-0000-0000-0000-0000009a2003', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'Gamma', true),
  ('00000000-0000-0000-0000-0000009a2002', '00000000-0000-0000-0000-0000009a0002', 'Nine', 'Beta', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000009a3001', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'ClientA', 'active'),
  ('00000000-0000-0000-0000-0000009a3002', '00000000-0000-0000-0000-0000009a0002', 'Nine', 'ClientB', 'active');

insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000009a4001', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a3001',
   null, 'private_lesson', 'scheduled', '2026-01-05T10:00:00+00', '2026-01-05T11:00:00+00'),
  ('00000000-0000-0000-0000-0000009a4002', '00000000-0000-0000-0000-0000009a0002', '00000000-0000-0000-0000-0000009a3002',
   null, 'private_lesson', 'scheduled', '2026-01-05T10:00:00+00', '2026-01-05T11:00:00+00');

-- Studio A earnings (pending, unassigned): E1 lesson 100, E2 reimbursement 20,
-- E3 bonus 50, E4/E5 bonuses for transition tests. Studio B: EB1 lesson 80.
insert into public.instructor_earnings (id, studio_id, instructor_id, appointment_id, client_id, earning_date, source_type,
  pay_mode, earning_amount, adjustment_type, worker_classification_snapshot, accounting_category_snapshot,
  taxable_compensation_amount, reimbursement_amount, deduction_amount) values
  ('00000000-0000-0000-0000-0000009a7001', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2001',
   '00000000-0000-0000-0000-0000009a4001', '00000000-0000-0000-0000-0000009a3001', date '2026-01-05', 'appointment',
   'flat', 100, null, 'contractor', 'contract_labor_expense', 100, 0, 0),
  ('00000000-0000-0000-0000-0000009a7002', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2001',
   null, null, date '2026-01-06', 'manual_adjustment', 'manual_adjustment', 20, 'reimbursement', 'contractor', 'contract_labor_expense', 0, 20, 0),
  ('00000000-0000-0000-0000-0000009a7003', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2001',
   null, null, date '2026-01-07', 'manual_adjustment', 'manual_adjustment', 50, 'bonus', 'contractor', 'contract_labor_expense', 50, 0, 0),
  ('00000000-0000-0000-0000-0000009a7004', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2001',
   null, null, date '2026-03-02', 'manual_adjustment', 'manual_adjustment', 10, 'bonus', 'contractor', 'contract_labor_expense', 10, 0, 0),
  ('00000000-0000-0000-0000-0000009a7005', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2001',
   null, null, date '2026-03-03', 'manual_adjustment', 'manual_adjustment', 30, 'reimbursement', 'contractor', 'contract_labor_expense', 0, 30, 0),
  ('00000000-0000-0000-0000-0000009a7101', '00000000-0000-0000-0000-0000009a0002', '00000000-0000-0000-0000-0000009a2002',
   '00000000-0000-0000-0000-0000009a4002', '00000000-0000-0000-0000-0000009a3002', date '2026-01-05', 'appointment',
   'flat', 80, null, 'contractor', 'contract_labor_expense', 80, 0, 0);

-- Studio B: owner B prepares a pay period with a draft batch (in_review).
do $$
declare v text;
begin
  v := pg_temp.run_as('00000000-0000-0000-0000-0000009a1005', $q$
    select public.create_payroll_pay_period('00000000-0000-0000-0000-0000009a0002', date '2026-01-01', date '2026-01-15', null);
    select public.assign_earnings_to_pay_period('00000000-0000-0000-0000-0000009a0002',
      (select id from public.payroll_pay_periods where studio_id = '00000000-0000-0000-0000-0000009a0002'));
    update public.instructor_earnings set status = 'approved' where id = '00000000-0000-0000-0000-0000009a7101';
    select public.create_payroll_batch_from_period('00000000-0000-0000-0000-0000009a0002',
      (select id from public.payroll_pay_periods where studio_id = '00000000-0000-0000-0000-0000009a0002'), 'manual');
  $q$);
  perform pg_temp.expect_ok('T-9a-fixture-studio-b-prepared', v);
end $$;

create temporary table t9a on commit drop as
select
  (select id from public.payroll_pay_periods where studio_id = '00000000-0000-0000-0000-0000009a0002') as pb1,
  (select id from public.payroll_batches where studio_id = '00000000-0000-0000-0000-0000009a0002') as bb1,
  null::uuid as pa1, null::uuid as ba1, null::uuid as ba2, null::uuid as pa2;
grant select on t9a to authenticated;

create function pg_temp.studio_b_fingerprint() returns text language sql as $$
  select md5(
    coalesce((select string_agg(t::text, '|' order by t.id) from public.payroll_pay_periods t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0002'), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from public.payroll_batches t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0002'), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from public.instructor_earnings t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0002'), '')) $$;

-- ============================================================================
-- 1. CROSS-STUDIO RPC CALLS FAIL CLOSED WITH ZERO STUDIO B CHANGE
-- ============================================================================

do $$
declare
  v_fp text := pg_temp.studio_b_fingerprint();
  r record;
  c record;
  v_pb1 uuid := (select pb1 from t9a);
  v_bb1 uuid := (select bb1 from t9a);
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
begin
  perform pg_temp.expect('T-9a-fixture-studio-b-state',
    pg_temp.period_status(v_pb1) = 'in_review' and pg_temp.batch_status(v_bb1) = 'draft');

  for r in select * from (values
      ('00000000-0000-0000-0000-0000009a1001'::uuid, 'owner-a'),
      ('00000000-0000-0000-0000-0000009a1002'::uuid, 'admin-a')) as x(u, label)
  loop
    for c in select * from (values
        ('approve-b-batch', format('select public.approve_payroll_batch(%L, %L)', v_a, v_bb1), 'Payroll batch not found.'),
        ('assign-b-period', format('select public.assign_earnings_to_pay_period(%L, %L)', v_a, v_pb1), 'Pay period not found.'),
        ('assign-single-b-period', format('select public.assign_single_earning_to_pay_period(%L, %L, %L)', v_a, v_pb1,
          '00000000-0000-0000-0000-0000009a7001'), 'Pay period not found.'),
        ('assign-single-b-earning', format('select public.assign_single_earning_to_pay_period(%L, %L, %L)', v_a, v_pb1,
          '00000000-0000-0000-0000-0000009a7101'), 'Pay period not found.'),
        ('remove-b-earning', format('select public.remove_earning_from_pay_period(%L, %L, %L)', v_a, v_pb1,
          '00000000-0000-0000-0000-0000009a7101'), 'Pay period not found.'),
        ('batch-from-b-period', format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_a, v_pb1), 'Pay period not found.')
      ) as y(name, stmt, msg)
    loop
      perform pg_temp.expect_err(format('T-9a-cross-studio-%s/%s', r.label, c.name), pg_temp.run_as(r.u, c.stmt), c.msg);
      perform pg_temp.expect(format('T-9a-cross-studio-%s/%s-no-change', r.label, c.name), pg_temp.studio_b_fingerprint() = v_fp);
    end loop;
  end loop;

  -- Owner-only RPCs from studio A's owner against studio B rows.
  perform pg_temp.expect_err('T-9a-cross-studio-owner-a/pay-b-batch',
    pg_temp.run_as('00000000-0000-0000-0000-0000009a1001',
      format('select public.mark_payroll_batch_paid(%L, %L, ''external_payroll'', null)', v_a, v_bb1)), 'Payroll batch not found.');
  perform pg_temp.expect_err('T-9a-cross-studio-owner-a/void-b-period',
    pg_temp.run_as('00000000-0000-0000-0000-0000009a1001',
      format('select public.void_empty_payroll_pay_period(%L, %L, ''x'')', v_a, v_pb1)), 'Pay period not found.');
  -- Platform admin must name the batch's own studio.
  perform pg_temp.expect_err('T-9a-cross-studio-platform/approve-b-batch-as-a',
    pg_temp.run_as('00000000-0000-0000-0000-0000009a1006',
      format('select public.approve_payroll_batch(%L, %L)', v_a, v_bb1)), 'Payroll batch not found.');
  perform pg_temp.expect('T-9a-cross-studio-all-no-change', pg_temp.studio_b_fingerprint() = v_fp
    and pg_temp.period_status(v_pb1) = 'in_review' and pg_temp.batch_status(v_bb1) = 'draft');
end $$;

-- Unknown identifiers fail closed.
do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_x constant uuid := '00000000-0000-0000-0000-0000009a9999';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
begin
  perform pg_temp.expect_err('T-9a-unknown-approve', pg_temp.run_as(v_owner, format('select public.approve_payroll_batch(%L, %L)', v_a, v_x)), 'Payroll batch not found.');
  perform pg_temp.expect_err('T-9a-unknown-pay', pg_temp.run_as(v_owner, format('select public.mark_payroll_batch_paid(%L, %L, null, null)', v_a, v_x)), 'Payroll batch not found.');
  perform pg_temp.expect_err('T-9a-unknown-assign', pg_temp.run_as(v_owner, format('select public.assign_earnings_to_pay_period(%L, %L)', v_a, v_x)), 'Pay period not found.');
  perform pg_temp.expect_err('T-9a-unknown-batch-period', pg_temp.run_as(v_owner, format('select public.create_payroll_batch_from_period(%L, %L, null)', v_a, v_x)), 'Pay period not found.');
  perform pg_temp.expect_err('T-9a-unknown-void', pg_temp.run_as(v_owner, format('select public.void_empty_payroll_pay_period(%L, %L, null)', v_a, v_x)), 'Pay period not found.');
  perform pg_temp.expect_err('T-9a-unknown-studio-platform', pg_temp.run_as('00000000-0000-0000-0000-0000009a1006',
    format('select public.create_payroll_pay_period(%L, date ''2026-05-01'', date ''2026-05-15'', null)', v_x)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9a-null-studio', pg_temp.run_as(v_owner,
    format('select public.approve_payroll_batch(null, %L)', (select bb1 from t9a))), 'Payroll access denied.');
end $$;

-- ============================================================================
-- 2. SAME-STUDIO RELATIONSHIPS (direct writes and trusted writes)
-- ============================================================================

do $$
declare
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_pb1 uuid := (select pb1 from t9a);
  v_bb1 uuid := (select bb1 from t9a);
begin
  perform pg_temp.expect_err('T-9a-ref-earning-to-b-period', pg_temp.run_as(v_owner,
    format('update public.instructor_earnings set pay_period_id = %L where id = ''00000000-0000-0000-0000-0000009a7001''', v_pb1)),
    'pay period must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-earning-to-b-batch', pg_temp.run_as(v_owner,
    format('update public.instructor_earnings set payroll_batch_id = %L where id = ''00000000-0000-0000-0000-0000009a7001''', v_bb1)),
    'batch must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-earning-b-instructor', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set instructor_id = ''00000000-0000-0000-0000-0000009a2002'' where id = ''00000000-0000-0000-0000-0000009a7003'''),
    'instructor must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-earning-b-appointment', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set appointment_id = ''00000000-0000-0000-0000-0000009a4002'' where id = ''00000000-0000-0000-0000-0000009a7003'''),
    'appointment must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-earning-b-client', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set client_id = ''00000000-0000-0000-0000-0000009a3002'' where id = ''00000000-0000-0000-0000-0000009a7003'''),
    'client must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-insert-b-instructor', pg_temp.run_as(v_owner,
    'insert into public.instructor_earnings (studio_id, instructor_id, earning_date, source_type, earning_amount)
     values (''00000000-0000-0000-0000-0000009a0001'', ''00000000-0000-0000-0000-0000009a2002'', date ''2026-01-08'', ''manual_adjustment'', 5)'),
    'instructor must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-insert-b-appointment', pg_temp.run_as(v_owner,
    'insert into public.instructor_earnings (studio_id, instructor_id, appointment_id, earning_date, earning_amount)
     values (''00000000-0000-0000-0000-0000009a0001'', ''00000000-0000-0000-0000-0000009a2001'', ''00000000-0000-0000-0000-0000009a4002'', date ''2026-01-08'', 5)'),
    'appointment must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-move-studio-trusted', pg_temp.run_trusted(
    'update public.instructor_earnings set studio_id = ''00000000-0000-0000-0000-0000009a0002'' where id = ''00000000-0000-0000-0000-0000009a7003''', true),
    'cannot move between studios');
  -- Even a canonical (bypass) context cannot cross studios.
  perform pg_temp.expect_err('T-9a-ref-earning-to-b-period-bypass', pg_temp.run_trusted(
    format('update public.instructor_earnings set pay_period_id = %L where id = ''00000000-0000-0000-0000-0000009a7001''', v_pb1), true),
    'pay period must belong to the same studio');
  perform pg_temp.expect_err('T-9a-ref-batch-crossing-studios', pg_temp.run_trusted(
    format('insert into public.payroll_batches (studio_id, pay_period_id, status) values (''00000000-0000-0000-0000-0000009a0001'', %L, ''draft'')', v_pb1), true),
    'pay period must belong to the same studio');
  -- New earnings start pending and unassigned (no pre-approved or pre-paid inserts).
  perform pg_temp.expect_err('T-9a-insert-approved-denied', pg_temp.run_as(v_owner,
    'insert into public.instructor_earnings (studio_id, instructor_id, earning_date, earning_amount, status)
     values (''00000000-0000-0000-0000-0000009a0001'', ''00000000-0000-0000-0000-0000009a2001'', date ''2026-01-08'', 5, ''approved'')'),
    'must start pending and unassigned');
  perform pg_temp.expect_err('T-9a-insert-duplicate-appointment', pg_temp.run_trusted(
    'insert into public.instructor_earnings (studio_id, instructor_id, appointment_id, earning_date, earning_amount)
     values (''00000000-0000-0000-0000-0000009a0001'', ''00000000-0000-0000-0000-0000009a2001'', ''00000000-0000-0000-0000-0000009a4001'', date ''2026-01-05'', 5)'),
    'duplicate key');
  -- Pay periods and batches have no direct write path for API users.
  perform pg_temp.expect_err('T-9a-direct-period-insert-denied', pg_temp.run_as(v_owner,
    'insert into public.payroll_pay_periods (studio_id, period_start, period_end) values (''00000000-0000-0000-0000-0000009a0001'', date ''2026-06-01'', date ''2026-06-15'')'),
    'row-level security');
  perform pg_temp.expect_ok('T-9a-direct-batch-update-noop', pg_temp.run_as('00000000-0000-0000-0000-0000009a1005',
    format('update public.payroll_batches set status = ''paid'' where id = %L', v_bb1)));
  perform pg_temp.expect('T-9a-direct-batch-update-blocked', pg_temp.batch_status(v_bb1) = 'draft');
end $$;

-- ============================================================================
-- 3. ROLE MATRIX + CANONICAL CHAIN (owner, admin, platform admin; denied roles)
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009a1002';
  v_platform constant uuid := '00000000-0000-0000-0000-0000009a1006';
  v_pa1 uuid;
  v_ba1 uuid;
  v_res text;
  r record;
begin
  perform pg_temp.expect_ok('T-9a-owner-create-period', pg_temp.run_as(v_owner,
    format('select public.create_payroll_pay_period(%L, date ''2026-01-01'', date ''2026-01-15'', null)', v_a)));
  perform pg_temp.expect('T-9a-bypass-reset-after-success',
    coalesce(current_setting('danceflow.payroll_transition_bypass', true), '') = '');
  select id into v_pa1 from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-01-01';
  update t9a set pa1 = v_pa1;
  perform pg_temp.expect('T-9a-period-open', pg_temp.period_status(v_pa1) = 'open');

  perform pg_temp.expect_ok('T-9a-admin-assign', pg_temp.run_as(v_admin,
    format('select public.assign_earnings_to_pay_period(%L, %L)', v_a, v_pa1)));
  perform pg_temp.expect('T-9a-period-open-to-in-review', pg_temp.period_status(v_pa1) = 'in_review');
  perform pg_temp.expect('T-9a-totals-after-assign',
    (select (compensation_total, reimbursement_total, deduction_total, net_payment_total) = (150::numeric, 20::numeric, 0::numeric, 170::numeric)
     from public.payroll_pay_periods where id = v_pa1));

  -- Earning review: pending -> approved (owner and admin).
  perform pg_temp.expect_ok('T-9a-owner-approve-earning', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7001'''));
  perform pg_temp.expect_ok('T-9a-admin-approve-earning', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7002'''));
  perform pg_temp.expect('T-9a-earning-pending-to-approved',
    pg_temp.earning_status('00000000-0000-0000-0000-0000009a7001') = 'approved'
    and (select approved_at is not null and approved_by = v_owner from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7001'));

  -- Denied roles cannot approve earnings (RLS: zero rows) or run payroll RPCs.
  for r in select * from (values
      ('00000000-0000-0000-0000-0000009a1003'::uuid, 'instructor'),
      ('00000000-0000-0000-0000-0000009a1004'::uuid, 'front_desk'),
      ('00000000-0000-0000-0000-0000009a1007'::uuid, 'no-role')) as x(u, label)
  loop
    perform pg_temp.run_as(r.u, 'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7003''');
    perform pg_temp.expect(format('T-9a-%s-cannot-approve-earning', r.label),
      pg_temp.earning_status('00000000-0000-0000-0000-0000009a7003') = 'pending');
    perform pg_temp.expect_err(format('T-9a-%s-cannot-create-batch', r.label), pg_temp.run_as(r.u,
      format('select public.create_payroll_batch_from_period(%L, %L, null)', v_a, v_pa1)), 'Payroll access denied.');
  end loop;

  perform pg_temp.expect_ok('T-9a-admin-create-batch', pg_temp.run_as(v_admin,
    format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_a, v_pa1)));
  select id into v_ba1 from public.payroll_batches where studio_id = v_a and pay_period_id = v_pa1;
  update t9a set ba1 = v_ba1;
  perform pg_temp.expect('T-9a-batch-draft-with-approved-earnings',
    pg_temp.batch_status(v_ba1) = 'draft'
    and (select count(*) from public.instructor_earnings where payroll_batch_id = v_ba1 and locked_at is not null) = 2
    and (select (compensation_total, reimbursement_total, net_payment_total, earning_count) = (100::numeric, 20::numeric, 120::numeric, 2)
         from public.payroll_batches where id = v_ba1));

  for r in select * from (values
      ('00000000-0000-0000-0000-0000009a1003'::uuid, 'instructor'),
      ('00000000-0000-0000-0000-0000009a1004'::uuid, 'front_desk'),
      ('00000000-0000-0000-0000-0000009a1007'::uuid, 'no-role')) as x(u, label)
  loop
    perform pg_temp.expect_err(format('T-9a-%s-cannot-approve-batch', r.label), pg_temp.run_as(r.u,
      format('select public.approve_payroll_batch(%L, %L)', v_a, v_ba1)), 'Payroll access denied.');
  end loop;

  perform pg_temp.expect_ok('T-9a-admin-approve-batch', pg_temp.run_as(v_admin,
    format('select public.approve_payroll_batch(%L, %L)', v_a, v_ba1)));
  perform pg_temp.expect('T-9a-batch-draft-to-approved', pg_temp.batch_status(v_ba1) = 'approved');
  perform pg_temp.expect('T-9a-period-in-review-to-approved', pg_temp.period_status(v_pa1) = 'approved');

  -- Disbursement: admin, instructor, front desk, no-role denied.
  for r in select * from (values
      ('00000000-0000-0000-0000-0000009a1002'::uuid, 'admin'),
      ('00000000-0000-0000-0000-0000009a1003'::uuid, 'instructor'),
      ('00000000-0000-0000-0000-0000009a1004'::uuid, 'front_desk'),
      ('00000000-0000-0000-0000-0000009a1007'::uuid, 'no-role')) as x(u, label)
  loop
    perform pg_temp.expect_err(format('T-9a-%s-cannot-disburse', r.label), pg_temp.run_as(r.u,
      format('select public.mark_payroll_batch_paid(%L, %L, ''external_payroll'', null)', v_a, v_ba1)),
      'Only the studio owner can mark payroll paid.');
    perform pg_temp.expect(format('T-9a-%s-cannot-disburse-no-change', r.label), pg_temp.batch_status(v_ba1) = 'approved'
      and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7001') = 'approved');
  end loop;
end $$;

-- ============================================================================
-- 4. EARNING LOCK (batched into an approved batch)
-- ============================================================================

do $$
declare
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_ba1 uuid := (select ba1 from t9a);
  v_pa1 uuid := (select pa1 from t9a);
  c record;
begin
  for c in select * from (values
      ('instructor', 'instructor_id = ''00000000-0000-0000-0000-0000009a2003''', 'locked'),
      ('earning-date', 'earning_date = date ''2026-01-09''', 'locked'),
      ('amount', 'earning_amount = 999, taxable_compensation_amount = 999', 'locked'),
      ('rate', 'pay_rate_amount = 999', 'locked'),
      ('classification', 'worker_classification_snapshot = ''employee''', 'locked'),
      ('category', 'accounting_category_snapshot = ''employee_wage_expense''', 'locked'),
      ('appointment', 'appointment_id = null', 'Payroll history must keep its source'),
      ('period', 'pay_period_id = null', 'locked'),
      ('batch', 'payroll_batch_id = null', 'locked'),
      ('status-pending', 'status = ''pending''', 'locked'),
      ('status-void', 'status = ''void''', 'locked')) as x(name, assignment, msg)
  loop
    perform pg_temp.expect_err(format('T-9a-lock-%s-direct', c.name), pg_temp.run_as(v_owner,
      format('update public.instructor_earnings set %s where id = ''00000000-0000-0000-0000-0000009a7001''', c.assignment)), c.msg);
    perform pg_temp.expect_err(format('T-9a-lock-%s-bypass', c.name), pg_temp.run_trusted(
      format('update public.instructor_earnings set %s where id = ''00000000-0000-0000-0000-0000009a7001''', c.assignment), true), c.msg);
  end loop;
  perform pg_temp.expect_err('T-9a-lock-studio', pg_temp.run_trusted(
    'update public.instructor_earnings set studio_id = ''00000000-0000-0000-0000-0000009a0002'' where id = ''00000000-0000-0000-0000-0000009a7001''', true),
    'cannot move between studios');
  perform pg_temp.expect_ok('T-9a-lock-notes-mutable', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set notes = ''reviewed'' where id = ''00000000-0000-0000-0000-0000009a7001'''));

  -- No insert into, or assignment to, an approved batch.
  perform pg_temp.expect_err('T-9a-insert-into-approved-batch', pg_temp.run_trusted(format(
    'insert into public.instructor_earnings (studio_id, instructor_id, earning_date, earning_amount, status, pay_period_id, payroll_batch_id, locked_at)
     values (''00000000-0000-0000-0000-0000009a0001'', ''00000000-0000-0000-0000-0000009a2001'', date ''2026-01-10'', 7, ''approved'', %L, %L, now())',
    v_pa1, v_ba1), true), 'only be added to a draft payroll batch');
  perform pg_temp.expect_err('T-9a-assign-to-approved-batch', pg_temp.run_trusted(format(
    'update public.instructor_earnings set payroll_batch_id = %L, locked_at = now() where id = ''00000000-0000-0000-0000-0000009a7003''', v_ba1), true),
    'only be added to a draft payroll batch');

  -- Approved batch: frozen totals and no regression.
  perform pg_temp.expect_err('T-9a-approved-batch-totals-frozen', pg_temp.run_trusted(format(
    'update public.payroll_batches set net_payment_total = 1 where id = %L', v_ba1), true), 'Approved payroll batches are locked');
  perform pg_temp.expect_err('T-9a-batch-approved-to-draft-direct', pg_temp.run_trusted(format(
    'update public.payroll_batches set status = ''draft'' where id = %L', v_ba1)), 'managed by payroll operations');
  perform pg_temp.expect_err('T-9a-batch-approved-to-draft-bypass', pg_temp.run_trusted(format(
    'update public.payroll_batches set status = ''draft'' where id = %L', v_ba1), true), 'Invalid payroll batch transition');
  perform pg_temp.expect_err('T-9a-batch-paid-without-earnings', pg_temp.run_trusted(format(
    'update public.payroll_batches set status = ''paid'' where id = %L', v_ba1), true), 'paid only after its earnings are paid');
  perform pg_temp.expect_err('T-9a-earning-paid-outside-rpc-bypass', pg_temp.run_trusted(
    'update public.instructor_earnings set status = ''paid'', paid_at = now() where id = ''00000000-0000-0000-0000-0000009a7001''', false), 'locked');
  perform pg_temp.expect('T-9a-lock-state-intact', pg_temp.batch_status(v_ba1) = 'approved'
    and (select (earning_amount, instructor_id, earning_date, status) = (100::numeric, '00000000-0000-0000-0000-0000009a2001'::uuid, date '2026-01-05', 'approved')
         from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7001'));
end $$;

-- ============================================================================
-- 5. DIRECT PER-EARNING PAYMENT IS IMPOSSIBLE; OVERRIDE RE-REVIEW
-- ============================================================================

do $$
declare
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009a1002';
  v_platform constant uuid := '00000000-0000-0000-0000-0000009a1006';
  v_pa1 uuid := (select pa1 from t9a);
begin
  -- E4 pending (unassigned), E3 pending in PA1.
  perform pg_temp.expect_err('T-9a-owner-pending-to-paid', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''paid'', paid_at = now() where id = ''00000000-0000-0000-0000-0000009a7004'''),
    'paid only through an approved payroll batch');
  perform pg_temp.expect_err('T-9a-admin-pending-to-paid', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set status = ''paid'' where id = ''00000000-0000-0000-0000-0000009a7004'''),
    'paid only through an approved payroll batch');
  perform pg_temp.run_as(v_platform, 'update public.instructor_earnings set status = ''paid'' where id = ''00000000-0000-0000-0000-0000009a7004''');
  perform pg_temp.expect('T-9a-platform-direct-paid-no-effect', pg_temp.earning_status('00000000-0000-0000-0000-0000009a7004') = 'pending');
  perform pg_temp.expect_err('T-9a-trusted-pending-to-paid', pg_temp.run_trusted(
    'update public.instructor_earnings set status = ''paid'' where id = ''00000000-0000-0000-0000-0000009a7004''', true),
    'paid only through an approved payroll batch');
  perform pg_temp.expect_ok('T-9a-approve-e4', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7004'''));
  perform pg_temp.expect_err('T-9a-owner-approved-to-paid-unbatched', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''paid'' where id = ''00000000-0000-0000-0000-0000009a7004'''),
    'paid only through an approved payroll batch');
  perform pg_temp.expect_err('T-9a-owner-set-paid-stamp', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set paid_at = now() where id = ''00000000-0000-0000-0000-0000009a7004'''),
    'paid only through an approved payroll batch');

  -- approved -> pending only with an amount change.
  perform pg_temp.expect_err('T-9a-approved-to-pending-casual', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''pending'' where id = ''00000000-0000-0000-0000-0000009a7004'''),
    'return to review only when');
  perform pg_temp.expect_ok('T-9a-approved-override-returns-to-review', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set earning_amount = 12, taxable_compensation_amount = 12, pay_mode = ''manual_override'' where id = ''00000000-0000-0000-0000-0000009a7004'''));
  perform pg_temp.expect('T-9a-approved-override-is-pending',
    (select status = 'pending' and approved_at is null and approved_by is null and earning_amount = 12
     from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7004'));

  -- Reimbursement earning: changing the amount keeps the reimbursement classification.
  perform pg_temp.expect_ok('T-9a-approve-e5', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7005'''));
  perform pg_temp.expect_ok('T-9a-reimbursement-override', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set earning_amount = 35, reimbursement_amount = 35 where id = ''00000000-0000-0000-0000-0000009a7005'''));
  perform pg_temp.expect('T-9a-reimbursement-preserved-and-review',
    (select status = 'pending' and reimbursement_amount = 35 and taxable_compensation_amount = 0 and adjustment_type = 'reimbursement'
     from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7005'));

  -- Pending earning in a period stays editable; period totals follow.
  perform pg_temp.expect_ok('T-9a-pending-edit-allowed', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set earning_amount = 60, taxable_compensation_amount = 60 where id = ''00000000-0000-0000-0000-0000009a7003'''));
  perform pg_temp.expect('T-9a-totals-after-pending-edit',
    (select (compensation_total, reimbursement_total, net_payment_total) = (160::numeric, 20::numeric, 180::numeric)
     from public.payroll_pay_periods where id = v_pa1)
    and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7003') = 'pending');
  perform pg_temp.expect_err('T-9a-pending-date-outside-period', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set earning_date = date ''2026-02-20'' where id = ''00000000-0000-0000-0000-0000009a7003'''),
    'outside the pay-period dates');
  perform pg_temp.expect_err('T-9a-pending-carry-approval', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set approved_at = now() where id = ''00000000-0000-0000-0000-0000009a7003'''),
    'cannot carry an approval');
end $$;

-- ============================================================================
-- 6. CANONICAL PAYMENT (owner, then platform admin) + PERIOD COMPLETION
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009a1002';
  v_platform constant uuid := '00000000-0000-0000-0000-0000009a1006';
  v_pa1 uuid := (select pa1 from t9a);
  v_ba1 uuid := (select ba1 from t9a);
  v_ba2 uuid;
begin
  perform pg_temp.expect_ok('T-9a-owner-pays-batch', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, ''external_payroll'', ''REF-1'')', v_a, v_ba1)));
  perform pg_temp.expect('T-9a-canonical-payment',
    pg_temp.batch_status(v_ba1) = 'paid'
    and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7001') = 'paid'
    and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7002') = 'paid'
    and (select paid_by = v_owner and payment_method = 'external_payroll' from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7001'));
  -- E3 is still pending and unbatched in PA1, so the period is not paid yet.
  perform pg_temp.expect('T-9a-period-not-paid-with-open-earning', pg_temp.period_status(v_pa1) = 'approved');

  -- Paid is terminal for earnings, batches and (later) periods, for every caller.
  perform pg_temp.expect_err('T-9a-paid-earning-terminal', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set notes = ''x'' where id = ''00000000-0000-0000-0000-0000009a7001'''), 'Paid or void');
  perform pg_temp.expect_err('T-9a-paid-earning-terminal-trusted', pg_temp.run_trusted(
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7001''', true), 'Paid or void');
  perform pg_temp.expect_err('T-9a-paid-batch-terminal', pg_temp.run_trusted(format(
    'update public.payroll_batches set provider_batch_reference = ''REF-2'' where id = %L', v_ba1), true), 'Closed payroll records');
  perform pg_temp.expect_err('T-9a-paid-batch-repay', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, null, null)', v_a, v_ba1)), 'must be approved before payment');

  -- Approve E3, batch it from the approved period, platform admin approves and pays.
  perform pg_temp.expect_ok('T-9a-approve-e3', pg_temp.run_as(v_admin,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7003'''));
  perform pg_temp.expect_ok('T-9a-platform-create-batch', pg_temp.run_as(v_platform,
    format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_a, v_pa1)));
  select id into v_ba2 from public.payroll_batches where studio_id = v_a and pay_period_id = v_pa1 and id <> v_ba1;
  update t9a set ba2 = v_ba2;
  perform pg_temp.expect_ok('T-9a-platform-approve-batch', pg_temp.run_as(v_platform,
    format('select public.approve_payroll_batch(%L, %L)', v_a, v_ba2)));
  -- Defence in depth: an earning changed out of band underneath an approved
  -- batch (simulated by disabling the earning integrity trigger) leaves its
  -- frozen totals stale, and payment must refuse rather than pay a different
  -- batch. (Since 9B the approval snapshot's foreign key also keeps a batched
  -- earning from being deleted at all.)
  -- The probe (guard disable + amount change) is rolled back by the raised marker.
  declare
    v_probe text;
  begin
    begin
      alter table public.instructor_earnings disable trigger trg_enforce_instructor_earning_integrity;
      update public.instructor_earnings set taxable_compensation_amount = 1 where id = '00000000-0000-0000-0000-0000009a7003';
      v_probe := pg_temp.run_as(v_owner, format('select public.mark_payroll_batch_paid(%L, %L, null, null)', v_a, v_ba2));
      raise exception 'PROBE:%', v_probe;
    exception when others then
      v_probe := sqlerrm;
    end;
    perform pg_temp.expect_err('T-9a-pay-refuses-stale-batch-totals', v_probe, 'totals do not match');
    perform pg_temp.expect('T-9a-stale-probe-rolled-back', pg_temp.batch_status(v_ba2) = 'approved'
      and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7003') = 'approved');
  end;
  perform pg_temp.expect_ok('T-9a-platform-pays-batch', pg_temp.run_as(v_platform,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_ba2)));
  perform pg_temp.expect('T-9a-period-approved-to-paid',
    pg_temp.batch_status(v_ba2) = 'paid' and pg_temp.period_status(v_pa1) = 'paid'
    and pg_temp.earning_status('00000000-0000-0000-0000-0000009a7003') = 'paid');
  perform pg_temp.expect('T-9a-paid-period-totals',
    (select (compensation_total, reimbursement_total, net_payment_total) = (160::numeric, 20::numeric, 180::numeric)
     from public.payroll_pay_periods where id = v_pa1));
  perform pg_temp.expect_err('T-9a-paid-period-terminal', pg_temp.run_trusted(format(
    'update public.payroll_pay_periods set pay_date = date ''2026-02-01'' where id = %L', v_pa1), true), 'Closed payroll records');

  -- Period transitions outside the graph are refused even in a canonical context.
  perform pg_temp.expect_ok('T-9a-owner-create-period-2', pg_temp.run_as(v_owner,
    format('select public.create_payroll_pay_period(%L, date ''2026-03-01'', date ''2026-03-15'', null)', v_a)));
  update t9a set pa2 = (select id from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-03-01');
  perform pg_temp.expect_err('T-9a-period-approved-without-batch', pg_temp.run_trusted(format(
    'update public.payroll_pay_periods set status = ''approved'' where id = %L', (select pa2 from t9a)), true), 'approved only through an approved payroll batch');
  perform pg_temp.expect_err('T-9a-period-open-to-paid', pg_temp.run_trusted(format(
    'update public.payroll_pay_periods set status = ''paid'' where id = %L', (select pa2 from t9a)), true), 'Invalid pay period transition');
  perform pg_temp.expect_err('T-9a-period-status-direct', pg_temp.run_trusted(format(
    'update public.payroll_pay_periods set status = ''in_review'' where id = %L', (select pa2 from t9a))), 'managed by payroll operations');
  perform pg_temp.expect_err('T-9a-period-dates-immutable', pg_temp.run_trusted(format(
    'update public.payroll_pay_periods set period_end = date ''2026-03-20'' where id = %L', (select pa2 from t9a)), true), 'cannot be changed');

  -- Void: admin denied, platform admin allowed for an empty period.
  perform pg_temp.expect_err('T-9a-admin-cannot-void', pg_temp.run_as(v_admin,
    format('select public.void_empty_payroll_pay_period(%L, %L, null)', v_a, (select pa2 from t9a))), 'Only the studio owner can void a pay period.');
  perform pg_temp.expect_ok('T-9a-platform-void-empty', pg_temp.run_as(v_platform,
    format('select public.void_empty_payroll_pay_period(%L, %L, ''harness'')', v_a, (select pa2 from t9a))));
  perform pg_temp.expect('T-9a-period-voided', pg_temp.period_status((select pa2 from t9a)) = 'void');
end $$;

-- ============================================================================
-- 7. TOTALS STAY LIVE (assign, remove, void, batch, payment)
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_p uuid;
begin
  perform pg_temp.expect_ok('T-9a-totals-period-3', pg_temp.run_as(v_owner,
    format('select public.create_payroll_pay_period(%L, date ''2026-03-02'', date ''2026-03-31'', null)', v_a)));
  select id into v_p from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-03-02';
  perform pg_temp.expect_ok('T-9a-totals-assign-single', pg_temp.run_as(v_owner, format(
    'select public.assign_single_earning_to_pay_period(%L, %L, ''00000000-0000-0000-0000-0000009a7004'');
     select public.assign_single_earning_to_pay_period(%L, %L, ''00000000-0000-0000-0000-0000009a7005'')', v_a, v_p, v_a, v_p)));
  perform pg_temp.expect('T-9a-totals-after-single-assign',
    (select (compensation_total, reimbursement_total, net_payment_total) = (12::numeric, 35::numeric, 47::numeric)
     from public.payroll_pay_periods where id = v_p));
  perform pg_temp.expect_ok('T-9a-totals-void-earning', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''void'' where id = ''00000000-0000-0000-0000-0000009a7005'''));
  perform pg_temp.expect('T-9a-totals-after-void',
    (select (compensation_total, reimbursement_total, net_payment_total) = (12::numeric, 0::numeric, 12::numeric)
     from public.payroll_pay_periods where id = v_p));
  perform pg_temp.expect_ok('T-9a-totals-remove-void-earning', pg_temp.run_as(v_owner, format(
    'select public.remove_earning_from_pay_period(%L, %L, ''00000000-0000-0000-0000-0000009a7005'')', v_a, v_p)));
  perform pg_temp.expect_ok('T-9a-totals-remove-earning', pg_temp.run_as(v_owner, format(
    'select public.remove_earning_from_pay_period(%L, %L, ''00000000-0000-0000-0000-0000009a7004'')', v_a, v_p)));
  perform pg_temp.expect('T-9a-totals-after-remove',
    (select (compensation_total, reimbursement_total, net_payment_total) = (0::numeric, 0::numeric, 0::numeric)
     from public.payroll_pay_periods where id = v_p));
  perform pg_temp.expect_ok('T-9a-void-emptied-period', pg_temp.run_as(v_owner, format(
    'select public.void_empty_payroll_pay_period(%L, %L, ''harness'')', v_a, v_p)));
end $$;

-- ============================================================================
-- 7b. PAYROLL HISTORY CANNOT BE DELETED (direct, API, cascades)
-- ============================================================================

-- Section fixtures: instructor Delta with an approved (unassigned) lesson earning
-- E6 and a pending earning E7 assigned to a pay period; instructor Epsilon with
-- only a pending, unassigned lesson earning E8.
insert into public.instructors (id, studio_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000009a2004', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'Delta', true),
  ('00000000-0000-0000-0000-0000009a2005', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'Epsilon', true);
insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000009a3003', '00000000-0000-0000-0000-0000009a0001', 'Nine', 'ClientC', 'active');
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000009a4003', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a3003',
   null, 'private_lesson', 'scheduled', '2026-04-02T10:00:00+00', '2026-04-02T11:00:00+00'),
  ('00000000-0000-0000-0000-0000009a4004', '00000000-0000-0000-0000-0000009a0001', null,
   null, 'private_lesson', 'scheduled', '2026-04-03T10:00:00+00', '2026-04-03T11:00:00+00');
insert into public.instructor_earnings (id, studio_id, instructor_id, appointment_id, client_id, earning_date, source_type,
  pay_mode, earning_amount, worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount) values
  ('00000000-0000-0000-0000-0000009a7006', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2004',
   '00000000-0000-0000-0000-0000009a4003', '00000000-0000-0000-0000-0000009a3003', date '2026-04-02', 'appointment',
   'flat', 40, 'contractor', 'contract_labor_expense', 40),
  ('00000000-0000-0000-0000-0000009a7007', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2004',
   null, null, date '2026-04-05', 'manual_adjustment', 'manual_adjustment', 15, 'contractor', 'contract_labor_expense', 15),
  ('00000000-0000-0000-0000-0000009a7008', '00000000-0000-0000-0000-0000009a0001', '00000000-0000-0000-0000-0000009a2005',
   '00000000-0000-0000-0000-0000009a4004', null, date '2026-04-03', 'appointment', 'flat', 9, 'contractor', 'contract_labor_expense', 9);

create function pg_temp.studio_a_history_fingerprint() returns text language sql as $$
  select md5(
    coalesce((select string_agg(t::text, '|' order by t.id) from public.payroll_pay_periods t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0001'), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from public.payroll_batches t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0001'), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from public.instructor_earnings t
              where t.studio_id = '00000000-0000-0000-0000-0000009a0001'), '') ||
    (select count(*)::text from public.instructors where studio_id = '00000000-0000-0000-0000-0000009a0001') ||
    (select count(*)::text from public.appointments where studio_id = '00000000-0000-0000-0000-0000009a0001') ||
    (select count(*)::text from public.clients where studio_id = '00000000-0000-0000-0000-0000009a0001')) $$;

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_p4 uuid;
  v_fp text;
  c record;
begin
  perform pg_temp.expect_ok('T-9a-del-fixture-approve-e6', pg_temp.run_as(v_owner,
    'update public.instructor_earnings set status = ''approved'' where id = ''00000000-0000-0000-0000-0000009a7006'''));
  perform pg_temp.expect_ok('T-9a-del-fixture-period-e7', pg_temp.run_as(v_owner,
    format('select public.create_payroll_pay_period(%L, date ''2026-04-01'', date ''2026-04-15'', null)', v_a)));
  select id into v_p4 from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-04-01';
  perform pg_temp.expect_ok('T-9a-del-fixture-assign-e7', pg_temp.run_as(v_owner,
    format('select public.assign_single_earning_to_pay_period(%L, %L, ''00000000-0000-0000-0000-0000009a7007'')', v_a, v_p4)));

  v_fp := pg_temp.studio_a_history_fingerprint();

  -- Direct deletes of every kind of payroll history are refused, even for trusted roles.
  for c in select * from (values
      ('approved', '00000000-0000-0000-0000-0000009a7006'::uuid),
      ('assigned-to-period', '00000000-0000-0000-0000-0000009a7007'::uuid),
      ('paid', '00000000-0000-0000-0000-0000009a7001'::uuid),
      ('paid-reimbursement', '00000000-0000-0000-0000-0000009a7002'::uuid),
      ('void', '00000000-0000-0000-0000-0000009a7005'::uuid)) as x(label, id)
  loop
    perform pg_temp.expect_err(format('T-9a-del-direct-%s', c.label), pg_temp.run_trusted(
      format('delete from public.instructor_earnings where id = %L', c.id)), 'Payroll history cannot be deleted.');
  end loop;
  perform pg_temp.expect_err('T-9a-del-direct-batched-locked', pg_temp.run_trusted(
    'delete from public.instructor_earnings where id = ''00000000-0000-0000-0000-0000009a7101'''), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-direct-bypass-context', pg_temp.run_trusted(
    'delete from public.instructor_earnings where id = ''00000000-0000-0000-0000-0000009a7001''', true), 'Payroll history cannot be deleted.');
  -- API users have no delete path at all (no DELETE policy): zero rows, nothing removed.
  perform pg_temp.expect_ok('T-9a-del-api-owner-noop', pg_temp.run_as(v_owner,
    'delete from public.instructor_earnings where studio_id = ''00000000-0000-0000-0000-0000009a0001'''));
  perform pg_temp.expect('T-9a-del-direct-nothing-removed', pg_temp.studio_a_history_fingerprint() = v_fp);

  -- Parent cascades fail atomically: parent, earnings and totals all remain.
  for c in select * from (values
      ('instructor-with-paid', 'delete from public.instructors where id = ''00000000-0000-0000-0000-0000009a2001''', 'Payroll history'),
      ('instructor-with-approved', 'delete from public.instructors where id = ''00000000-0000-0000-0000-0000009a2004''', 'Payroll history'),
      ('appointment-with-paid', 'delete from public.appointments where id = ''00000000-0000-0000-0000-0000009a4001''', 'Payroll history must keep its source'),
      ('appointment-with-approved', 'delete from public.appointments where id = ''00000000-0000-0000-0000-0000009a4003''', 'Payroll history must keep its source'),
      ('client-with-paid', 'delete from public.clients where id = ''00000000-0000-0000-0000-0000009a3001''', 'Payroll history'),
      ('client-with-approved', 'delete from public.clients where id = ''00000000-0000-0000-0000-0000009a3003''', 'Payroll history'),
      ('studio', 'delete from public.studios where id = ''00000000-0000-0000-0000-0000009a0001''', 'Payroll history')) as x(label, stmt, msg)
  loop
    perform pg_temp.expect_err(format('T-9a-cascade-%s', c.label), pg_temp.run_trusted(c.stmt), c.msg);
    perform pg_temp.expect(format('T-9a-cascade-%s-atomic', c.label), pg_temp.studio_a_history_fingerprint() = v_fp);
  end loop;
  perform pg_temp.expect('T-9a-cascade-identity-kept',
    (select appointment_id = '00000000-0000-0000-0000-0000009a4001' and client_id = '00000000-0000-0000-0000-0000009a3001'
            and instructor_id = '00000000-0000-0000-0000-0000009a2001' and status = 'paid'
     from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7001')
    and (select status = 'approved' and appointment_id is not null
         from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7006'));

  -- A pending, unassigned draft keeps its existing behavior: the appointment
  -- delete nulls its link and the instructor delete removes it.
  perform pg_temp.expect_ok('T-9a-pending-draft-appointment-delete', pg_temp.run_trusted(
    'delete from public.appointments where id = ''00000000-0000-0000-0000-0000009a4004'''));
  perform pg_temp.expect('T-9a-pending-draft-link-nulled',
    (select appointment_id is null from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7008'));
  perform pg_temp.expect_ok('T-9a-pending-draft-instructor-delete', pg_temp.run_trusted(
    'delete from public.instructors where id = ''00000000-0000-0000-0000-0000009a2005'''));
  perform pg_temp.expect('T-9a-pending-draft-deleted',
    not exists (select 1 from public.instructor_earnings where id = '00000000-0000-0000-0000-0000009a7008'));
end $$;

-- Approved, paid and void pay periods / batches cannot be deleted; open / draft ones keep existing behavior.
do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009a0001';
  v_b constant uuid := '00000000-0000-0000-0000-0000009a0002';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009a1001';
  v_pb1 uuid := (select pb1 from t9a);
  v_bb1 uuid := (select bb1 from t9a);
  v_p5 uuid;
begin
  perform pg_temp.expect_ok('T-9a-del-fixture-approve-b-batch', pg_temp.run_as('00000000-0000-0000-0000-0000009a1005',
    format('select public.approve_payroll_batch(%L, %L)', v_b, v_bb1)));
  perform pg_temp.expect('T-9a-del-fixture-b-approved', pg_temp.batch_status(v_bb1) = 'approved' and pg_temp.period_status(v_pb1) = 'approved');

  perform pg_temp.expect_err('T-9a-del-paid-period', pg_temp.run_trusted(
    format('delete from public.payroll_pay_periods where id = %L', (select pa1 from t9a))), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-void-period', pg_temp.run_trusted(
    format('delete from public.payroll_pay_periods where id = %L', (select pa2 from t9a))), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-approved-period', pg_temp.run_trusted(
    format('delete from public.payroll_pay_periods where id = %L', v_pb1)), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-paid-batch', pg_temp.run_trusted(
    format('delete from public.payroll_batches where id = %L', (select ba1 from t9a))), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-approved-batch', pg_temp.run_trusted(
    format('delete from public.payroll_batches where id = %L', v_bb1)), 'Payroll history cannot be deleted.');
  perform pg_temp.expect_err('T-9a-del-studio-b-cascade', pg_temp.run_trusted(
    format('delete from public.studios where id = %L', v_b)), 'Payroll history');
  perform pg_temp.expect('T-9a-del-period-batch-history-intact',
    pg_temp.period_status((select pa1 from t9a)) = 'paid' and pg_temp.batch_status((select ba1 from t9a)) = 'paid'
    and pg_temp.batch_status(v_bb1) = 'approved' and pg_temp.period_status(v_pb1) = 'approved'
    and pg_temp.period_status((select pa2 from t9a)) = 'void');

  -- API users have no delete policy on pay periods or batches.
  perform pg_temp.expect_ok('T-9a-del-api-period-noop', pg_temp.run_as(v_owner,
    format('delete from public.payroll_pay_periods where id = %L; delete from public.payroll_batches where id = %L',
      (select pa1 from t9a), (select ba1 from t9a))));
  perform pg_temp.expect('T-9a-del-api-period-batch-remain',
    pg_temp.period_status((select pa1 from t9a)) = 'paid' and pg_temp.batch_status((select ba1 from t9a)) = 'paid');

  -- An open, empty pay period is not history and keeps its existing delete behavior.
  perform pg_temp.expect_ok('T-9a-open-period-create', pg_temp.run_as(v_owner,
    format('select public.create_payroll_pay_period(%L, date ''2026-05-01'', date ''2026-05-15'', null)', v_a)));
  select id into v_p5 from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-05-01';
  perform pg_temp.expect_ok('T-9a-open-period-deletable', pg_temp.run_trusted(
    format('delete from public.payroll_pay_periods where id = %L', v_p5)));
end $$;

-- ============================================================================
-- 8. SECURITY SURFACE
-- ============================================================================

do $$
begin
  perform pg_temp.expect('T-9a-no-direct-period-batch-write-policies', not exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename in ('payroll_pay_periods', 'payroll_batches') and cmd <> 'SELECT'));
  perform pg_temp.expect('T-9a-refresh-not-executable-by-authenticated',
    not has_function_privilege('authenticated', 'public.refresh_payroll_batch_totals(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.refresh_payroll_pay_period_totals(uuid)', 'execute'));
  perform pg_temp.expect('T-9a-rpcs-not-executable-by-anon',
    not has_function_privilege('anon', 'public.approve_payroll_batch(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.mark_payroll_batch_paid(uuid, uuid, text, text)', 'execute'));
  perform pg_temp.expect('T-9a-bypass-not-left-enabled',
    coalesce(current_setting('danceflow.payroll_transition_bypass', true), '') = '');
end $$;

select 'Phase 9A payroll integrity SQL suite: ALL CHECKS PASSED' as result, count(*) as checks, count(distinct label) as distinct_checks from t9a_passes;

rollback;
