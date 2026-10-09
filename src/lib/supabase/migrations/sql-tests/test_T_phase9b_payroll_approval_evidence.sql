-- Phase 9B -- immutable payroll approval snapshot, payment evidence and
-- export (finalization) evidence, live-Postgres regression suite.
--
-- Proves 20261103090000_phase9b_payroll_approval_evidence.sql: approval
-- freezes exactly one snapshot atomically with the approval; the snapshot,
-- its lines, payment evidence and export events are append-only and tenant
-- bound; actor evidence survives profile changes and deletion; payment
-- verifies the snapshot and records evidence; exports append evidence; and
-- batches approved before activation keep an explicit legacy path. Entire
-- script runs in one transaction and is rolled back. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER
-- 20261103090000 has been applied (with the 9A and LAUNCH-SEC-1A suites).
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000009bXXXX

begin;

create temporary table t9b_passes (label text) on commit drop;
create temporary table t9b_info (note text) on commit drop;

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
  insert into t9b_passes values (p_label);
end $$;

create function pg_temp.expect_err(p_label text, p_res text, p_like text) returns void language plpgsql as $$
begin
  if p_res = 'OK' or p_res not like '%' || p_like || '%' then
    raise exception 'FAIL %: expected error like "%", got "%"', p_label, p_like, p_res;
  end if;
  insert into t9b_passes values (p_label);
end $$;

create function pg_temp.expect(p_label text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %: %', p_label, coalesce(p_detail, 'condition false'); end if;
  insert into t9b_passes values (p_label);
end $$;

-- Runs p_sql as p_user inside a subtransaction that is always rolled back; returns its result.
create function pg_temp.probe(p_setup text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_res text;
begin
  begin
    execute p_setup;
    v_res := pg_temp.run_as(p_user, p_sql);
    raise exception 'PROBE:%', v_res;
  exception when others then
    v_res := sqlerrm;
  end;
  return v_res;
end $$;

create function pg_temp.batch_status(p_id uuid) returns text language sql as $$ select status from public.payroll_batches where id = p_id $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000009b0001', 'Phase 9B Studio A', 't-phase9b-a'),
  ('00000000-0000-0000-0000-0000009b0002', 'Phase 9B Studio B', 't-phase9b-b');
update public.studios set public_name = 'Studio A Dance', public_logo_url = 'https://cdn.test/9b-a.png'
where id = '00000000-0000-0000-0000-0000009b0001';
update public.studios set public_name = 'Studio B Dance', public_logo_url = 'https://cdn.test/9b-b.png'
where id = '00000000-0000-0000-0000-0000009b0002';

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000009b1001', 't-phase9b-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000009b1002', 't-phase9b-admin-a@example.test'),
  ('00000000-0000-0000-0000-0000009b1003', 't-phase9b-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000009b1004', 't-phase9b-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000009b1005', 't-phase9b-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000009b1006', 't-phase9b-platform@example.test'),
  ('00000000-0000-0000-0000-0000009b1007', 't-phase9b-norole@example.test'),
  ('00000000-0000-0000-0000-0000009b1008', 't-phase9b-exporter-a@example.test');

insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0000009b1001', 't-phase9b-owner-a@example.test', 'Olive Owner', null),
  ('00000000-0000-0000-0000-0000009b1002', 't-phase9b-admin-a@example.test', 'Ada Admin', null),
  ('00000000-0000-0000-0000-0000009b1003', 't-phase9b-instructor-a@example.test', 'Ian Instructor', null),
  ('00000000-0000-0000-0000-0000009b1004', 't-phase9b-frontdesk-a@example.test', 'Fay Desk', null),
  ('00000000-0000-0000-0000-0000009b1005', 't-phase9b-owner-b@example.test', 'Bo Owner', null),
  ('00000000-0000-0000-0000-0000009b1006', 't-phase9b-platform@example.test', 'Pat Platform', 'platform_admin'),
  ('00000000-0000-0000-0000-0000009b1007', 't-phase9b-norole@example.test', 'Nora None', null),
  ('00000000-0000-0000-0000-0000009b1008', 't-phase9b-exporter-a@example.test', 'Eve Exporter', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000009b1001', '00000000-0000-0000-0000-0000009b0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000009b1002', '00000000-0000-0000-0000-0000009b0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000009b1003', '00000000-0000-0000-0000-0000009b0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000009b1004', '00000000-0000-0000-0000-0000009b0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000009b1005', '00000000-0000-0000-0000-0000009b0002', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000009b1008', '00000000-0000-0000-0000-0000009b0001', 'studio_admin', true);

insert into public.instructors (id, studio_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000009b2001', '00000000-0000-0000-0000-0000009b0001', 'Nina', 'Alpha', true),
  ('00000000-0000-0000-0000-0000009b2002', '00000000-0000-0000-0000-0000009b0001', 'Omar', 'Beta', true),
  ('00000000-0000-0000-0000-0000009b2003', '00000000-0000-0000-0000-0000009b0002', 'Bea', 'Other', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000009b3001', '00000000-0000-0000-0000-0000009b0001', 'Cara', 'Client', 'active');

insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, status, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000009b4001', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b3001',
   null, 'private_lesson', 'scheduled', '2026-01-05T10:00:00+00', '2026-01-05T11:00:00+00');

-- Studio A earnings. Batch 1 (Jan 1-15): E1 lesson 100 (Nina, client Cara,
-- note "lesson note"), E2 reimbursement 20 (Nina), E3 bonus 50 (Omar).
-- Batch 2 (Jan 16-31): E4 bonus 30 (Omar). Batch 3 (Feb): E5 bonus 40.
-- Legacy (Dec): EL1 bonus 25, EX1 bonus 15. Studio B: EB1 bonus 70.
insert into public.instructor_earnings (id, studio_id, instructor_id, appointment_id, client_id, earning_date, source_type,
  appointment_type, pay_mode, pay_rate_amount, earning_amount, adjustment_type, worker_classification_snapshot,
  accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount, deduction_amount, notes) values
  ('00000000-0000-0000-0000-0000009b7001', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2001',
   '00000000-0000-0000-0000-0000009b4001', '00000000-0000-0000-0000-0000009b3001', date '2026-01-05', 'appointment',
   'private_lesson', 'flat', 100, 100, null, 'contractor', 'contract_labor_expense', 100, 0, 0, 'lesson note'),
  ('00000000-0000-0000-0000-0000009b7002', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2001',
   null, null, date '2026-01-06', 'manual_adjustment', null, 'manual_adjustment', 20, 20, 'reimbursement', 'contractor', 'contract_labor_expense', 0, 20, 0, 'parking'),
  ('00000000-0000-0000-0000-0000009b7003', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2002',
   null, null, date '2026-01-07', 'manual_adjustment', null, 'manual_adjustment', 50, 50, 'bonus', 'employee', 'employee_wage_expense', 50, 0, 0, null),
  ('00000000-0000-0000-0000-0000009b7004', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2002',
   null, null, date '2026-01-20', 'manual_adjustment', null, 'manual_adjustment', 30, 30, 'bonus', 'employee', 'employee_wage_expense', 30, 0, 0, null),
  ('00000000-0000-0000-0000-0000009b7005', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2002',
   null, null, date '2026-02-03', 'manual_adjustment', null, 'manual_adjustment', 40, 40, 'bonus', 'employee', 'employee_wage_expense', 40, 0, 0, null),
  ('00000000-0000-0000-0000-0000009b7006', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2001',
   null, null, date '2025-12-05', 'manual_adjustment', null, 'manual_adjustment', 25, 25, 'bonus', 'contractor', 'contract_labor_expense', 25, 0, 0, null),
  ('00000000-0000-0000-0000-0000009b7007', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b2001',
   null, null, date '2025-11-05', 'manual_adjustment', null, 'manual_adjustment', 15, 15, 'bonus', 'contractor', 'contract_labor_expense', 15, 0, 0, null),
  ('00000000-0000-0000-0000-0000009b7101', '00000000-0000-0000-0000-0000009b0002', '00000000-0000-0000-0000-0000009b2003',
   null, null, date '2026-01-05', 'manual_adjustment', null, 'manual_adjustment', 70, 70, 'bonus', 'contractor', 'contract_labor_expense', 70, 0, 0, null);

create temporary table t9b (k text primary key, id uuid) on commit drop;
grant select on t9b to authenticated;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from t9b where k = p_k $$;

-- Prepare a draft batch for (studio, owner, period dates, earnings) through the canonical RPCs.
create function pg_temp.prepare_batch(p_key text, p_studio uuid, p_owner uuid, p_start date, p_end date, p_earnings uuid[])
returns void language plpgsql as $$
declare
  v_period uuid;
  v_batch uuid;
  e uuid;
begin
  perform pg_temp.expect_ok('T-9b-fixture-period-' || p_key, pg_temp.run_as(p_owner,
    format('select public.create_payroll_pay_period(%L, %L, %L, %L)', p_studio, p_start, p_end, p_end + 5)));
  select id into v_period from public.payroll_pay_periods where studio_id = p_studio and period_start = p_start;
  foreach e in array p_earnings loop
    perform pg_temp.expect_ok('T-9b-fixture-assign-' || p_key, pg_temp.run_as(p_owner, format(
      'select public.assign_single_earning_to_pay_period(%L, %L, %L); update public.instructor_earnings set status = ''approved'' where id = %L',
      p_studio, v_period, e, e)));
  end loop;
  perform pg_temp.expect_ok('T-9b-fixture-batch-' || p_key, pg_temp.run_as(p_owner,
    format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', p_studio, v_period)));
  select id into v_batch from public.payroll_batches where studio_id = p_studio and pay_period_id = v_period;
  insert into t9b values ('period_' || p_key, v_period), ('batch_' || p_key, v_batch);
end $$;

select pg_temp.prepare_batch('a1', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b1001',
  date '2026-01-01', date '2026-01-15', array['00000000-0000-0000-0000-0000009b7001', '00000000-0000-0000-0000-0000009b7002', '00000000-0000-0000-0000-0000009b7003']::uuid[]);
select pg_temp.prepare_batch('a2', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b1001',
  date '2026-01-16', date '2026-01-31', array['00000000-0000-0000-0000-0000009b7004']::uuid[]);
select pg_temp.prepare_batch('a3', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b1001',
  date '2026-02-01', date '2026-02-15', array['00000000-0000-0000-0000-0000009b7005']::uuid[]);
select pg_temp.prepare_batch('legacy', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b1001',
  date '2025-12-01', date '2025-12-15', array['00000000-0000-0000-0000-0000009b7006']::uuid[]);
select pg_temp.prepare_batch('unsnapshotted', '00000000-0000-0000-0000-0000009b0001', '00000000-0000-0000-0000-0000009b1001',
  date '2025-11-01', date '2025-11-15', array['00000000-0000-0000-0000-0000009b7007']::uuid[]);
select pg_temp.prepare_batch('b1', '00000000-0000-0000-0000-0000009b0002', '00000000-0000-0000-0000-0000009b1005',
  date '2026-01-01', date '2026-01-15', array['00000000-0000-0000-0000-0000009b7101']::uuid[]);

-- Simulate batches approved without a snapshot (the triggers are bypassed only
-- for this fixture): "legacy" was approved before activation, "unsnapshotted"
-- after it (which the 9B lifecycle can never produce).
alter table public.payroll_batches disable trigger trg_enforce_payroll_batch_integrity;
alter table public.payroll_pay_periods disable trigger trg_enforce_payroll_pay_period_integrity;
update public.payroll_batches set status = 'approved', locked_at = now(),
  approved_at = (select activated_at from public.payroll_evidence_activation) - interval '30 days'
where id = pg_temp.id('batch_legacy');
update public.payroll_batches set status = 'approved', locked_at = now(), approved_at = now()
where id = pg_temp.id('batch_unsnapshotted');
update public.payroll_pay_periods set status = 'approved' where id in (pg_temp.id('period_legacy'), pg_temp.id('period_unsnapshotted'));
alter table public.payroll_batches enable trigger trg_enforce_payroll_batch_integrity;
alter table public.payroll_pay_periods enable trigger trg_enforce_payroll_pay_period_integrity;

-- ============================================================================
-- 1. APPROVAL CREATES EXACTLY ONE COMPLETE SNAPSHOT, ATOMICALLY
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009b0001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009b1002';
  v_batch uuid := pg_temp.id('batch_a1');
  v_snap record;
  v_res text;
begin
  -- Partial snapshot failure: a line that cannot be written aborts the whole approval.
  v_res := pg_temp.probe(
    'alter table public.payroll_batch_approval_snapshot_lines add constraint t9b_fail_line check (notes is distinct from ''lesson note'')',
    v_admin, format('select public.approve_payroll_batch(%L, %L)', v_a, v_batch));
  perform pg_temp.expect_err('T-9b-partial-snapshot-failure-aborts', v_res, 't9b_fail_line');
  perform pg_temp.expect('T-9b-partial-snapshot-failure-not-approved', pg_temp.batch_status(v_batch) = 'draft'
    and not exists (select 1 from public.payroll_batch_approval_snapshots where payroll_batch_id = v_batch));

  perform pg_temp.expect_ok('T-9b-admin-approves', pg_temp.run_as(v_admin, format('select public.approve_payroll_batch(%L, %L)', v_a, v_batch)));
  perform pg_temp.expect('T-9b-one-snapshot', (select count(*) from public.payroll_batch_approval_snapshots where payroll_batch_id = v_batch) = 1
    and pg_temp.batch_status(v_batch) = 'approved');

  select s.* into v_snap from public.payroll_batch_approval_snapshots s where s.payroll_batch_id = v_batch;
  insert into t9b values ('snap_a1', v_snap.id);
  perform pg_temp.expect('T-9b-snapshot-line-count', (select count(*) from public.payroll_batch_approval_snapshot_lines where snapshot_id = v_snap.id) = 3
    and v_snap.earning_count = 3 and v_snap.worker_count = 2);
  perform pg_temp.expect('T-9b-snapshot-totals-match-batch',
    (select (b.compensation_total, b.reimbursement_total, b.deduction_total, b.net_payment_total, b.earning_count)
       = (v_snap.compensation_total, v_snap.reimbursement_total, v_snap.deduction_total, v_snap.net_payment_total, v_snap.earning_count)
     from public.payroll_batches b where b.id = v_batch)
    and v_snap.compensation_total = 150 and v_snap.reimbursement_total = 20 and v_snap.net_payment_total = 170);
  perform pg_temp.expect('T-9b-snapshot-actor-captured', v_snap.approved_by = v_admin and v_snap.approved_by_name = 'Ada Admin'
    and v_snap.approved_by_email = 't-phase9b-admin-a@example.test' and v_snap.approved_by_role = 'studio_admin'
    and v_snap.approved_at = (select approved_at from public.payroll_batches where id = v_batch));
  perform pg_temp.expect('T-9b-snapshot-period-context', v_snap.period_start = date '2026-01-01' and v_snap.period_end = date '2026-01-15'
    and v_snap.pay_date = date '2026-01-20' and v_snap.pay_period_id = pg_temp.id('period_a1'));
  perform pg_temp.expect('T-9b-snapshot-header-identity', v_snap.studio_id = v_a and v_snap.provider = 'manual'
    and v_snap.batch_number = (select batch_number from public.payroll_batches where id = v_batch));
  perform pg_temp.expect('T-9b-snapshot-fingerprint', v_snap.fingerprint = public.payroll_approval_snapshot_fingerprint(v_snap.id));
  -- Every exported field is frozen on the line.
  perform pg_temp.expect('T-9b-snapshot-line-fields', exists (
    select 1 from public.payroll_batch_approval_snapshot_lines l
    where l.snapshot_id = v_snap.id and l.earning_id = '00000000-0000-0000-0000-0000009b7001'
      and l.line_number = 1 and l.instructor_id = '00000000-0000-0000-0000-0000009b2001' and l.instructor_name = 'Nina Alpha'
      and l.client_name = 'Cara Client' and l.appointment_id = '00000000-0000-0000-0000-0000009b4001'
      and l.appointment_type = 'private_lesson' and l.source_type = 'appointment' and l.earning_date = date '2026-01-05'
      and l.pay_mode = 'flat' and l.pay_rate_amount = 100 and l.earning_amount = 100
      and l.worker_classification_snapshot = 'contractor' and l.accounting_category_snapshot = 'contract_labor_expense'
      and l.taxable_compensation_amount = 100 and l.reimbursement_amount = 0 and l.net_amount = 100 and l.notes = 'lesson note'));
  perform pg_temp.expect('T-9b-snapshot-reimbursement-line', exists (
    select 1 from public.payroll_batch_approval_snapshot_lines l
    where l.snapshot_id = v_snap.id and l.earning_id = '00000000-0000-0000-0000-0000009b7002'
      and l.adjustment_type = 'reimbursement' and l.reimbursement_amount = 20 and l.taxable_compensation_amount = 0 and l.net_amount = 20));

  -- No second snapshot, no re-approval.
  perform pg_temp.expect_err('T-9b-reapprove-refused', pg_temp.run_as(v_admin, format('select public.approve_payroll_batch(%L, %L)', v_a, v_batch)),
    'Only draft or in-review batches can be approved.');
  perform pg_temp.expect_err('T-9b-duplicate-snapshot-refused', pg_temp.run_trusted(format(
    'insert into public.payroll_batch_approval_snapshots (studio_id, payroll_batch_id, pay_period_id, batch_number, provider, period_start, period_end, approved_at, approved_by_role, worker_count, earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total, fingerprint)
     select studio_id, payroll_batch_id, pay_period_id, batch_number, provider, period_start, period_end, approved_at, approved_by_role, worker_count, earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total, fingerprint
     from public.payroll_batch_approval_snapshots where id = %L', v_snap.id)), 'duplicate key');
  perform pg_temp.expect('T-9b-still-one-snapshot', (select count(*) from public.payroll_batch_approval_snapshots where payroll_batch_id = v_batch) = 1);

  -- A batch cannot be approved without its snapshot, even in a canonical context.
  perform pg_temp.expect_err('T-9b-approval-requires-snapshot', pg_temp.run_trusted(format(
    'update public.payroll_batches set status = ''approved'', approved_at = now() where id = %L', pg_temp.id('batch_a2')), true),
    'approved only together with its approval snapshot');
end $$;

-- ============================================================================
-- 2. IMMUTABILITY AND TENANT BINDING
-- ============================================================================

do $$
declare
  v_owner constant uuid := '00000000-0000-0000-0000-0000009b1001';
  v_snap uuid := pg_temp.id('snap_a1');
begin
  perform pg_temp.expect_err('T-9b-snapshot-update-trusted', pg_temp.run_trusted(format(
    'update public.payroll_batch_approval_snapshots set net_payment_total = 1 where id = %L', v_snap)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-snapshot-line-update-trusted', pg_temp.run_trusted(format(
    'update public.payroll_batch_approval_snapshot_lines set net_amount = 1, taxable_compensation_amount = 1 where snapshot_id = %L', v_snap)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-snapshot-delete-trusted', pg_temp.run_trusted(format(
    'delete from public.payroll_batch_approval_snapshots where id = %L', v_snap)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-snapshot-line-delete-trusted', pg_temp.run_trusted(format(
    'delete from public.payroll_batch_approval_snapshot_lines where snapshot_id = %L', v_snap)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-snapshot-truncate', pg_temp.run_trusted(
    'truncate public.payroll_batch_approval_snapshot_lines'), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-snapshot-update-api', pg_temp.run_as(v_owner, format(
    'update public.payroll_batch_approval_snapshots set net_payment_total = 1 where id = %L', v_snap)), 'permission denied');
  perform pg_temp.expect_err('T-9b-snapshot-delete-api', pg_temp.run_as(v_owner, format(
    'delete from public.payroll_batch_approval_snapshots where id = %L', v_snap)), 'permission denied');
  perform pg_temp.expect_err('T-9b-snapshot-insert-api', pg_temp.run_as(v_owner, format(
    'insert into public.payroll_batch_approval_snapshot_lines (snapshot_id) values (%L)', v_snap)), 'permission denied');
  perform pg_temp.expect_err('T-9b-activation-update', pg_temp.run_trusted(
    'update public.payroll_evidence_activation set activated_at = now() - interval ''1 year'''), 'Payroll evidence is immutable.');

  -- Structural tenant binding (composite foreign keys), even for trusted writes.
  perform pg_temp.expect_err('T-9b-line-cross-studio', pg_temp.run_trusted(format(
    'alter table public.payroll_batch_approval_snapshot_lines disable trigger trg_payroll_batch_approval_snapshot_lines_immutable;
     insert into public.payroll_batch_approval_snapshot_lines (snapshot_id, studio_id, payroll_batch_id, line_number, earning_id, instructor_id, source_type, earning_date, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, taxable_compensation_amount, reimbursement_amount, deduction_amount, net_amount)
     values (%L, ''00000000-0000-0000-0000-0000009b0002'', %L, 99, ''00000000-0000-0000-0000-0000009b7101'', ''00000000-0000-0000-0000-0000009b2003'', ''manual_adjustment'', date ''2026-01-05'', 0, ''x'', 0, 0, 0, 70, 70, 0, 0, 70)',
    v_snap, pg_temp.id('batch_a1'))), 'violates foreign key constraint');
  perform pg_temp.expect_err('T-9b-line-foreign-earning', pg_temp.run_trusted(format(
    'insert into public.payroll_batch_approval_snapshot_lines (snapshot_id, studio_id, payroll_batch_id, line_number, earning_id, instructor_id, source_type, earning_date, gross_revenue_basis, pay_mode, pay_rate_amount, pay_percentage, attendance_count, earning_amount, taxable_compensation_amount, reimbursement_amount, deduction_amount, net_amount)
     values (%L, ''00000000-0000-0000-0000-0000009b0001'', %L, 99, ''00000000-0000-0000-0000-0000009b7004'', ''00000000-0000-0000-0000-0000009b2002'', ''manual_adjustment'', date ''2026-01-20'', 0, ''x'', 0, 0, 0, 30, 30, 0, 0, 30)',
    v_snap, pg_temp.id('batch_a1'))), 'violates foreign key constraint');
  perform pg_temp.expect_err('T-9b-snapshot-cross-studio-batch', pg_temp.run_trusted(format(
    'insert into public.payroll_batch_approval_snapshots (studio_id, payroll_batch_id, pay_period_id, batch_number, provider, period_start, period_end, approved_at, approved_by_role, worker_count, earning_count, compensation_total, reimbursement_total, deduction_total, net_payment_total, fingerprint)
     values (''00000000-0000-0000-0000-0000009b0001'', %L, %L, 1, ''manual'', date ''2026-01-01'', date ''2026-01-15'', now(), ''studio_owner'', 1, 1, 70, 0, 0, 70, md5(''x''))',
    pg_temp.id('batch_b1'), pg_temp.id('period_b1'))), 'violates foreign key constraint');

  -- Reads are studio-scoped: studio B's owner and studio A's front desk see nothing.
  perform pg_temp.expect_ok('T-9b-rls-owner-a-reads', pg_temp.run_as(v_owner, format(
    'do $x$ begin if (select count(*) from public.payroll_batch_approval_snapshot_lines where snapshot_id = %L) <> 3 then raise exception ''owner cannot read''; end if; end $x$', v_snap)));
  perform pg_temp.expect_ok('T-9b-rls-owner-b-blind', pg_temp.run_as('00000000-0000-0000-0000-0000009b1005', format(
    'do $x$ begin if (select count(*) from public.payroll_batch_approval_snapshots where id = %L) <> 0 then raise exception ''cross-studio read''; end if; end $x$', v_snap)));
  perform pg_temp.expect_ok('T-9b-rls-front-desk-blind', pg_temp.run_as('00000000-0000-0000-0000-0000009b1004', format(
    'do $x$ begin if (select count(*) from public.payroll_batch_approval_snapshot_lines where snapshot_id = %L) <> 0 then raise exception ''front desk read''; end if; end $x$', v_snap)));
end $$;

-- ============================================================================
-- 3. LIVE CHANGES AND PROFILE CHANGES DO NOT TOUCH THE SNAPSHOT
-- ============================================================================

do $$
declare
  v_snap uuid := pg_temp.id('snap_a1');
  v_before text;
  v_header_before text;
begin
  select md5(string_agg(l::text, '|' order by l.line_number)) into v_before
  from public.payroll_batch_approval_snapshot_lines l where l.snapshot_id = v_snap;
  select md5(s::text) into v_header_before from public.payroll_batch_approval_snapshots s where s.id = v_snap;

  -- Mutable live data that the snapshot represents (9A still allows these).
  perform pg_temp.expect_ok('T-9b-live-note-change', pg_temp.run_as('00000000-0000-0000-0000-0000009b1001',
    'update public.instructor_earnings set notes = ''edited later'' where id = ''00000000-0000-0000-0000-0000009b7001'''));
  update public.instructors set first_name = 'Renamed' where id = '00000000-0000-0000-0000-0000009b2001';
  update public.clients set first_name = 'Changed' where id = '00000000-0000-0000-0000-0000009b3001';
  update public.profiles set full_name = 'Someone Else', email = 'changed@example.test' where id = '00000000-0000-0000-0000-0000009b1002';

  perform pg_temp.expect('T-9b-snapshot-lines-unchanged-after-live-edits',
    (select md5(string_agg(l::text, '|' order by l.line_number)) from public.payroll_batch_approval_snapshot_lines l where l.snapshot_id = v_snap) = v_before
    and exists (select 1 from public.payroll_batch_approval_snapshot_lines where snapshot_id = v_snap and notes = 'lesson note' and instructor_name = 'Nina Alpha' and client_name = 'Cara Client'));
  perform pg_temp.expect('T-9b-snapshot-header-unchanged-after-profile-edit',
    (select md5(s::text) from public.payroll_batch_approval_snapshots s where s.id = v_snap) = v_header_before
    and (select approved_by_name = 'Ada Admin' and approved_by_email = 't-phase9b-admin-a@example.test' from public.payroll_batch_approval_snapshots where id = v_snap));
  perform pg_temp.expect('T-9b-fingerprint-stable-after-live-edits',
    (select fingerprint = public.payroll_approval_snapshot_fingerprint(id) from public.payroll_batch_approval_snapshots where id = v_snap));
end $$;

-- ============================================================================
-- 4. PAYMENT EVIDENCE
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009b0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009b1001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009b1002';
  v_platform constant uuid := '00000000-0000-0000-0000-0000009b1006';
  v_batch uuid := pg_temp.id('batch_a1');
  v_ev record;
  v_res text;
begin
  -- Denied and failed payments leave no evidence.
  perform pg_temp.expect_err('T-9b-admin-pay-denied', pg_temp.run_as(v_admin,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch)), 'Only the studio owner can mark payroll paid.');
  perform pg_temp.expect_err('T-9b-front-desk-pay-denied', pg_temp.run_as('00000000-0000-0000-0000-0000009b1004',
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch)), 'Only the studio owner can mark payroll paid.');
  perform pg_temp.expect_err('T-9b-draft-pay-fails', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, pg_temp.id('batch_a2'))), 'must be approved before payment');
  perform pg_temp.expect('T-9b-no-evidence-after-failures', not exists (
    select 1 from public.payroll_batch_payment_evidence where payroll_batch_id in (v_batch, pg_temp.id('batch_a2'))));

  -- Tampered snapshot (simulated by disabling the guard) blocks payment, and the probe is rolled back.
  v_res := pg_temp.probe(
    'alter table public.payroll_batch_approval_snapshot_lines disable trigger trg_payroll_batch_approval_snapshot_lines_immutable;
     update public.payroll_batch_approval_snapshot_lines set notes = ''tampered'' where earning_id = ''00000000-0000-0000-0000-0000009b7001''',
    v_owner, format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch));
  perform pg_temp.expect_err('T-9b-pay-refuses-tampered-snapshot', v_res, 'failed verification');
  v_res := pg_temp.probe(
    'alter table public.payroll_batch_approval_snapshot_lines disable trigger trg_payroll_batch_approval_snapshot_lines_immutable;
     delete from public.payroll_batch_approval_snapshot_lines where earning_id = ''00000000-0000-0000-0000-0000009b7003''',
    v_owner, format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch));
  perform pg_temp.expect_err('T-9b-pay-refuses-incomplete-snapshot', v_res, 'does not match the batch');
  v_res := pg_temp.probe(format(
    'alter table public.payroll_batch_approval_snapshot_lines disable trigger trg_payroll_batch_approval_snapshot_lines_immutable;
     alter table public.payroll_batch_approval_snapshots disable trigger trg_payroll_batch_approval_snapshots_immutable;
     delete from public.payroll_batch_approval_snapshot_lines where snapshot_id = %L;
     delete from public.payroll_batch_approval_snapshots where id = %L', pg_temp.id('snap_a1'), pg_temp.id('snap_a1')),
    v_owner, format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch));
  perform pg_temp.expect_err('T-9b-pay-requires-snapshot-for-new-batch', v_res, 'missing its approval snapshot');
  perform pg_temp.expect('T-9b-probes-rolled-back', pg_temp.batch_status(v_batch) = 'approved'
    and (select count(*) from public.payroll_batch_approval_snapshot_lines where snapshot_id = pg_temp.id('snap_a1')) = 3
    and not exists (select 1 from public.payroll_batch_payment_evidence where payroll_batch_id = v_batch));

  -- A batch cannot become paid without its evidence, even in a canonical context.
  perform pg_temp.expect_err('T-9b-paid-requires-evidence', pg_temp.run_trusted(format(
    'update public.instructor_earnings set status = ''paid'', paid_at = now() where payroll_batch_id = %L;
     update public.payroll_batches set status = ''paid'', paid_at = now() where id = %L', v_batch, v_batch), true),
    'paid only together with its payment evidence');

  -- Owner pays: evidence created with frozen identity.
  perform pg_temp.expect_ok('T-9b-owner-pays', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', ''CHK-1'')', v_a, v_batch)));
  select * into v_ev from public.payroll_batch_payment_evidence where payroll_batch_id = v_batch;
  perform pg_temp.expect('T-9b-owner-payment-evidence', (select count(*) from public.payroll_batch_payment_evidence where payroll_batch_id = v_batch) = 1
    and v_ev.paid_by = v_owner and v_ev.paid_by_name = 'Olive Owner' and v_ev.paid_by_email = 't-phase9b-owner-a@example.test'
    and v_ev.paid_by_role = 'studio_owner' and v_ev.payment_method = 'check' and v_ev.provider_batch_reference = 'CHK-1'
    and v_ev.snapshot_id = pg_temp.id('snap_a1') and not v_ev.legacy_without_snapshot
    and v_ev.snapshot_fingerprint = (select fingerprint from public.payroll_batch_approval_snapshots where id = pg_temp.id('snap_a1'))
    and v_ev.net_payment_total = 170 and v_ev.earning_count = 3
    and v_ev.paid_at = (select paid_at from public.payroll_batches where id = v_batch)
    and pg_temp.batch_status(v_batch) = 'paid');
  perform pg_temp.expect_err('T-9b-duplicate-payment-refused', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_batch)), 'must be approved before payment');
  perform pg_temp.expect('T-9b-no-duplicate-evidence', (select count(*) from public.payroll_batch_payment_evidence where payroll_batch_id = v_batch) = 1);
  perform pg_temp.expect_err('T-9b-payment-evidence-immutable', pg_temp.run_trusted(format(
    'update public.payroll_batch_payment_evidence set paid_by_name = ''x'' where payroll_batch_id = %L', v_batch)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-payment-evidence-undeletable', pg_temp.run_trusted(format(
    'delete from public.payroll_batch_payment_evidence where payroll_batch_id = %L', v_batch)), 'Payroll evidence is immutable.');

  -- Platform admin approves and pays batch a2: evidence records the platform role truthfully.
  perform pg_temp.expect_ok('T-9b-platform-approves', pg_temp.run_as(v_platform,
    format('select public.approve_payroll_batch(%L, %L)', v_a, pg_temp.id('batch_a2'))));
  perform pg_temp.expect_ok('T-9b-platform-pays', pg_temp.run_as(v_platform,
    format('select public.mark_payroll_batch_paid(%L, %L, null, null)', v_a, pg_temp.id('batch_a2'))));
  perform pg_temp.expect('T-9b-platform-evidence', exists (
    select 1 from public.payroll_batch_payment_evidence e
    join public.payroll_batch_approval_snapshots s on s.id = e.snapshot_id
    where e.payroll_batch_id = pg_temp.id('batch_a2') and e.paid_by_role = 'platform_admin' and e.paid_by_name = 'Pat Platform'
      and s.approved_by_role = 'platform_admin' and s.approved_by_name = 'Pat Platform' and e.payment_method = 'external_payroll'));
end $$;

-- ============================================================================
-- 5. EXPORT (FINALIZATION) EVIDENCE
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009b0001';
  v_b constant uuid := '00000000-0000-0000-0000-0000009b0002';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009b1001';
  v_exporter constant uuid := '00000000-0000-0000-0000-0000009b1008';
  v_batch uuid := pg_temp.id('batch_a1');
  r record;
begin
  perform pg_temp.expect_ok('T-9b-export-csv', pg_temp.run_as(v_owner,
    format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch)));
  perform pg_temp.expect_ok('T-9b-export-pdf', pg_temp.run_as(v_exporter,
    format('select public.record_payroll_export(%L, %L, ''pdf'', 3, 170.00)', v_a, v_batch)));
  perform pg_temp.expect_ok('T-9b-export-csv-again', pg_temp.run_as(v_owner,
    format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch)));
  perform pg_temp.expect('T-9b-export-events-appended', (select count(*) from public.payroll_export_events where payroll_batch_id = v_batch) = 3
    and (select count(*) from public.payroll_export_events where payroll_batch_id = v_batch and export_type = 'csv') = 2);
  perform pg_temp.expect('T-9b-export-event-content', exists (
    select 1 from public.payroll_export_events e
    where e.payroll_batch_id = v_batch and e.export_type = 'pdf' and e.export_source = 'approval_snapshot'
      and e.snapshot_id = pg_temp.id('snap_a1') and e.snapshot_fingerprint = (select fingerprint from public.payroll_batch_approval_snapshots where id = pg_temp.id('snap_a1'))
      and e.exported_by = v_exporter and e.exported_by_name = 'Eve Exporter' and e.exported_by_role = 'studio_admin'
      and e.line_count = 3 and e.net_payment_total = 170 and e.format_version = 1 and e.exported_at is not null));

  -- Denied, cross-studio, mismatched and unsupported exports record nothing.
  for r in select * from (values
      ('front-desk', '00000000-0000-0000-0000-0000009b1004'::uuid, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch), 'Payroll access denied.'),
      ('instructor', '00000000-0000-0000-0000-0000009b1003'::uuid, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch), 'Payroll access denied.'),
      ('no-role', '00000000-0000-0000-0000-0000009b1007'::uuid, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch), 'Payroll access denied.'),
      ('owner-b-own-studio', '00000000-0000-0000-0000-0000009b1005'::uuid, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_b, v_batch), 'Payroll batch not found.'),
      ('owner-b-studio-a', '00000000-0000-0000-0000-0000009b1005'::uuid, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch), 'Payroll access denied.'),
      ('mismatched-lines', v_owner, format('select public.record_payroll_export(%L, %L, ''csv'', 2, 170)', v_a, v_batch), 'does not match the approval snapshot'),
      ('mismatched-total', v_owner, format('select public.record_payroll_export(%L, %L, ''pdf'', 3, 171)', v_a, v_batch), 'does not match the approval snapshot'),
      ('unsupported-type', v_owner, format('select public.record_payroll_export(%L, %L, ''xlsx'', 3, 170)', v_a, v_batch), 'Unsupported payroll export type.'),
      ('draft-batch', v_owner, format('select public.record_payroll_export(%L, %L, ''csv'', 1, 40)', v_a, pg_temp.id('batch_a3')), 'Only approved payroll batches have export evidence.')
    ) as x(label, u, stmt, msg)
  loop
    perform pg_temp.expect_err('T-9b-export-refused-' || r.label, pg_temp.run_as(r.u, r.stmt), r.msg);
  end loop;
  perform pg_temp.expect('T-9b-refused-exports-recorded-nothing',
    (select count(*) from public.payroll_export_events where payroll_batch_id in (v_batch, pg_temp.id('batch_a3'))) = 3);
  perform pg_temp.expect_err('T-9b-export-event-immutable', pg_temp.run_trusted(format(
    'update public.payroll_export_events set line_count = 0 where payroll_batch_id = %L', v_batch)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-export-event-undeletable', pg_temp.run_trusted(format(
    'delete from public.payroll_export_events where payroll_batch_id = %L', v_batch)), 'Payroll evidence is immutable.');
  perform pg_temp.expect_err('T-9b-export-event-insert-api', pg_temp.run_as(v_owner, format(
    'insert into public.payroll_export_events (studio_id, payroll_batch_id, pay_period_id, export_source, export_type, line_count, net_payment_total, exported_by_role)
     values (%L, %L, %L, ''legacy_live'', ''csv'', 0, 0, ''studio_owner'')', v_a, v_batch, pg_temp.id('period_a1'))), 'permission denied');
end $$;

-- ============================================================================
-- 5b. TRUSTED EXPORT READER: explicit studio, no broad platform-admin reads
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009b0001';
  v_b constant uuid := '00000000-0000-0000-0000-0000009b0002';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009b1001';
  v_admin constant uuid := '00000000-0000-0000-0000-0000009b1002';
  v_platform constant uuid := '00000000-0000-0000-0000-0000009b1006';
  v_batch uuid := pg_temp.id('batch_a1');
  v_check text;
  r record;
begin
  -- The reader returns the snapshot (not live earnings) for an approved batch of the named studio.
  v_check := format($q$do $x$ declare v jsonb := public.get_payroll_batch_export(%L, %L); begin
      if v->'snapshot'->>'id' is distinct from %L or jsonb_array_length(v->'lines') <> 3
         or jsonb_array_length(v->'earnings') <> 0 or v->'batch'->>'id' is distinct from %L
         or (v->'lines'->0->>'notes') is distinct from 'lesson note' or v->'payment' is null
         or v->'studio'->>'name' is distinct from 'Phase 9B Studio A'
         or v->'studio'->>'public_name' is distinct from 'Studio A Dance'
         or v->'studio'->>'public_logo_url' is distinct from 'https://cdn.test/9b-a.png'
         or (select array_agg(k order by k) from jsonb_object_keys(v->'studio') k) is distinct from array['name', 'public_logo_url', 'public_name']
      then raise exception 'reader payload wrong: %%', v; end if; end $x$ $q$, v_a, v_batch, pg_temp.id('snap_a1'), v_batch);
  for r in select * from (values ('owner', v_owner), ('admin', v_admin), ('platform-admin', v_platform)) as x(label, u) loop
    perform pg_temp.expect_ok('T-9b-reader-' || r.label, pg_temp.run_as(r.u, v_check));
  end loop;

  -- Platform admin has no direct table read; the reader is the only path.
  perform pg_temp.expect_ok('T-9b-platform-no-direct-read', pg_temp.run_as(v_platform,
    'do $x$ begin if (select count(*) from public.payroll_batch_approval_snapshots) <> 0
       or (select count(*) from public.payroll_batches) <> 0
       or (select count(*) from public.payroll_export_events) <> 0 then raise exception ''platform admin can read payroll tables''; end if; end $x$'));

  -- The explicit studio binds the batch for every role, platform admin included.
  for r in select * from (values
      ('platform-admin-wrong-studio', v_platform, format('select public.get_payroll_batch_export(%L, %L)', v_b, v_batch), 'Payroll batch not found.'),
      ('platform-admin-unknown-studio', v_platform, format('select public.get_payroll_batch_export(%L, %L)', '00000000-0000-0000-0000-0000009b9999', v_batch), 'Payroll access denied.'),
      ('owner-b-own-studio', '00000000-0000-0000-0000-0000009b1005'::uuid, format('select public.get_payroll_batch_export(%L, %L)', v_b, v_batch), 'Payroll batch not found.'),
      ('owner-a-names-studio-b', v_owner, format('select public.get_payroll_batch_export(%L, %L)', v_b, pg_temp.id('batch_b1')), 'Payroll access denied.'),
      ('front-desk', '00000000-0000-0000-0000-0000009b1004'::uuid, format('select public.get_payroll_batch_export(%L, %L)', v_a, v_batch), 'Payroll access denied.'),
      ('instructor', '00000000-0000-0000-0000-0000009b1003'::uuid, format('select public.get_payroll_batch_export(%L, %L)', v_a, v_batch), 'Payroll access denied.'),
      ('no-role', '00000000-0000-0000-0000-0000009b1007'::uuid, format('select public.get_payroll_batch_export(%L, %L)', v_a, v_batch), 'Payroll access denied.'),
      ('platform-admin-export-wrong-studio', v_platform, format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_b, v_batch), 'Payroll batch not found.')
    ) as x(label, u, stmt, msg)
  loop
    perform pg_temp.expect_err('T-9b-reader-refused-' || r.label, pg_temp.run_as(r.u, r.stmt), r.msg);
  end loop;
  -- Branding always belongs to the named studio: studio B's own batch, named as B, returns B only.
  for r in select * from (values ('owner-b', '00000000-0000-0000-0000-0000009b1005'::uuid), ('platform-admin', v_platform)) as x(label, u) loop
    perform pg_temp.expect_ok('T-9b-reader-branding-studio-b-' || r.label, pg_temp.run_as(r.u, format(
      $q$do $x$ declare v jsonb := public.get_payroll_batch_export(%L, %L); begin
         if v->'studio'->>'name' is distinct from 'Phase 9B Studio B' or v->'studio'->>'public_logo_url' is distinct from 'https://cdn.test/9b-b.png'
         then raise exception 'branding wrong: %%', v->'studio'; end if; end $x$ $q$, v_b, pg_temp.id('batch_b1'))));
  end loop;
  perform pg_temp.expect('T-9b-reader-anon-no-execute', not has_function_privilege('anon', 'public.get_payroll_batch_export(uuid, uuid)', 'execute'));

  -- Platform admin export evidence: target studio and platform role recorded truthfully.
  perform pg_temp.expect_ok('T-9b-platform-admin-export-csv', pg_temp.run_as(v_platform,
    format('select public.record_payroll_export(%L, %L, ''csv'', 3, 170)', v_a, v_batch)));
  perform pg_temp.expect_ok('T-9b-platform-admin-export-pdf', pg_temp.run_as(v_platform,
    format('select public.record_payroll_export(%L, %L, ''pdf'', 3, 170)', v_a, v_batch)));
  perform pg_temp.expect('T-9b-platform-admin-export-evidence',
    (select count(*) from public.payroll_export_events
     where payroll_batch_id = v_batch and studio_id = v_a and exported_by = v_platform
       and exported_by_role = 'platform_admin' and exported_by_name = 'Pat Platform'
       and export_source = 'approval_snapshot' and snapshot_id = pg_temp.id('snap_a1')) = 2
    and not exists (select 1 from public.payroll_export_events where studio_id = v_b));

  -- A batch without a snapshot returns its current records instead.
  perform pg_temp.expect_ok('T-9b-reader-legacy-current-records', pg_temp.run_as(v_platform, format(
    $q$do $x$ declare v jsonb := public.get_payroll_batch_export(%L, %L); begin
       if v->'snapshot' <> 'null'::jsonb or jsonb_array_length(v->'earnings') <> 1 or v->'period' is null
       then raise exception 'legacy payload wrong: %%', v; end if; end $x$ $q$, v_a, pg_temp.id('batch_legacy'))));
end $$;

-- ============================================================================
-- 6. ACTOR EVIDENCE SURVIVES PROFILE DELETION
-- ============================================================================

do $$
declare
  v_exporter constant uuid := '00000000-0000-0000-0000-0000009b1008';
  v_res text;
begin
  -- The exporter has no live payroll stamps, so the profile can be deleted outright.
  perform pg_temp.expect_ok('T-9b-exporter-profile-deleted', pg_temp.run_trusted(format(
    'delete from public.user_studio_roles where user_id = %L; delete from public.profiles where id = %L', v_exporter, v_exporter)));
  perform pg_temp.expect('T-9b-export-evidence-survives-profile-deletion',
    not exists (select 1 from public.profiles where id = v_exporter)
    and exists (select 1 from public.payroll_export_events where exported_by = v_exporter and exported_by_name = 'Eve Exporter'
                and exported_by_email = 't-phase9b-exporter-a@example.test'));

  -- The approver / disburser profiles still anchor live 9A payroll stamps; whatever
  -- a deletion attempt does there, the frozen evidence is unchanged.
  v_res := pg_temp.run_trusted(
    'delete from public.user_studio_roles where user_id = ''00000000-0000-0000-0000-0000009b1001'';
     delete from public.profiles where id = ''00000000-0000-0000-0000-0000009b1001''');
  insert into t9b_info values ('approver/disburser profile delete attempt: ' || v_res);
  perform pg_temp.expect('T-9b-disburser-evidence-survives-profile-deletion-attempt',
    exists (select 1 from public.payroll_batch_payment_evidence where paid_by = '00000000-0000-0000-0000-0000009b1001'
            and paid_by_name = 'Olive Owner' and paid_by_email = 't-phase9b-owner-a@example.test' and paid_by_role = 'studio_owner'),
    'deletion attempt result: ' || v_res);
  perform pg_temp.expect('T-9b-approver-evidence-survives',
    exists (select 1 from public.payroll_batch_approval_snapshots where id = pg_temp.id('snap_a1')
            and approved_by = '00000000-0000-0000-0000-0000009b1002' and approved_by_name = 'Ada Admin'));
end $$;

-- ============================================================================
-- 7. LEGACY (PRE-9B) BATCHES: EXPLICIT COMPATIBILITY PATH
-- ============================================================================

do $$
declare
  v_a constant uuid := '00000000-0000-0000-0000-0000009b0001';
  v_owner constant uuid := '00000000-0000-0000-0000-0000009b1006';
  v_legacy uuid := pg_temp.id('batch_legacy');
  v_unsnap uuid := pg_temp.id('batch_unsnapshotted');
begin
  perform pg_temp.expect('T-9b-legacy-has-no-snapshot', not exists (
    select 1 from public.payroll_batch_approval_snapshots where payroll_batch_id in (v_legacy, v_unsnap)));
  perform pg_temp.expect_ok('T-9b-legacy-export', pg_temp.run_as(v_owner,
    format('select public.record_payroll_export(%L, %L, ''csv'', 1, 25)', v_a, v_legacy)));
  perform pg_temp.expect('T-9b-legacy-export-labelled', exists (
    select 1 from public.payroll_export_events where payroll_batch_id = v_legacy and export_source = 'legacy_live'
      and snapshot_id is null and snapshot_fingerprint is null));
  perform pg_temp.expect_err('T-9b-legacy-export-mismatch', pg_temp.run_as(v_owner,
    format('select public.record_payroll_export(%L, %L, ''csv'', 1, 26)', v_a, v_legacy)), 'does not match the approved batch');
  perform pg_temp.expect_ok('T-9b-legacy-pay', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, ''check'', null)', v_a, v_legacy)));
  perform pg_temp.expect('T-9b-legacy-payment-evidence', exists (
    select 1 from public.payroll_batch_payment_evidence where payroll_batch_id = v_legacy and legacy_without_snapshot
      and snapshot_id is null and paid_by_role = 'platform_admin' and net_payment_total = 25)
    and pg_temp.batch_status(v_legacy) = 'paid');
  perform pg_temp.expect('T-9b-no-retroactive-snapshot', not exists (
    select 1 from public.payroll_batch_approval_snapshots where payroll_batch_id = v_legacy));

  -- Approved after activation without a snapshot: refused, never treated as legacy.
  perform pg_temp.expect_err('T-9b-unsnapshotted-export-refused', pg_temp.run_as(v_owner,
    format('select public.record_payroll_export(%L, %L, ''csv'', 1, 15)', v_a, v_unsnap)), 'missing its approval snapshot');
  perform pg_temp.expect_err('T-9b-unsnapshotted-pay-refused', pg_temp.run_as(v_owner,
    format('select public.mark_payroll_batch_paid(%L, %L, null, null)', v_a, v_unsnap)), 'missing its approval snapshot');
  perform pg_temp.expect('T-9b-unsnapshotted-unchanged', pg_temp.batch_status(v_unsnap) = 'approved'
    and not exists (select 1 from public.payroll_batch_payment_evidence where payroll_batch_id = v_unsnap));
end $$;

-- ============================================================================
-- 8. SURFACE
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['payroll_batch_approval_snapshots', 'payroll_batch_approval_snapshot_lines',
    'payroll_batch_payment_evidence', 'payroll_export_events', 'payroll_evidence_activation'] loop
    perform pg_temp.expect('T-9b-no-write-policy-' || t, not exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT'));
    perform pg_temp.expect('T-9b-no-write-grant-' || t,
      not has_table_privilege('authenticated', 'public.' || t, 'INSERT')
      and not has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
      and not has_table_privilege('authenticated', 'public.' || t, 'DELETE'));
  end loop;
  perform pg_temp.expect('T-9b-activation-not-readable', not has_table_privilege('authenticated', 'public.payroll_evidence_activation', 'SELECT'));
  perform pg_temp.expect('T-9b-bypass-not-left-enabled', coalesce(current_setting('danceflow.payroll_transition_bypass', true), '') = '');
end $$;

select 'Phase 9B payroll approval evidence SQL suite: ALL CHECKS PASSED' as result, count(*) as checks, count(distinct label) as distinct_checks,
  (select string_agg(note, '; ') from t9b_info) as info
from t9b_passes;

rollback;
