-- Phase 9C -- compensation rule history, authoritative validation and atomic
-- save, live-Postgres regression suite.
--
-- Proves 20261104090000_phase9c_compensation_history.sql: the canonical
-- save_instructor_compensation_rule RPC validates and normalizes, upserts the
-- rule and appends one immutable, tenant-bound history row atomically (and
-- appends nothing for a no-op save); the history is append-only for everyone,
-- readable only by owners/admins of its own studio, keeps its actor evidence
-- after profile changes/deletion; direct rule writes are closed; and rule
-- edits never change existing earnings, approval snapshots, payment evidence
-- or export evidence. Entire script runs in one transaction and is rolled
-- back. Run via `supabase db query --linked --file <this file>` against DEV,
-- AFTER 20261104090000 has been applied (with the 9A, 9B and LAUNCH-SEC-1A
-- suites).
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-0000009cXXXX

begin;

create temporary table t9c_passes (label text) on commit drop;

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

-- Runs a scalar query as the user (RLS applies) and returns its text value.
create function pg_temp.scalar_as(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v_val text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    execute p_sql into v_val;
    execute 'reset role';
  exception when others then
    v_val := 'ERR:' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v_val;
end $$;

create function pg_temp.run_trusted(p_sql text) returns text language plpgsql as $$
declare v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  return coalesce(v_err, 'OK');
end $$;

create function pg_temp.expect_ok(p_label text, p_res text) returns void language plpgsql as $$
begin
  if p_res is distinct from 'OK' then raise exception 'FAIL %: %', p_label, p_res; end if;
  insert into t9c_passes values (p_label);
end $$;

create function pg_temp.expect_err(p_label text, p_res text, p_like text) returns void language plpgsql as $$
begin
  if p_res = 'OK' or p_res not like '%' || p_like || '%' then
    raise exception 'FAIL %: expected error like "%", got "%"', p_label, p_like, p_res;
  end if;
  insert into t9c_passes values (p_label);
end $$;

create function pg_temp.expect_eq(p_label text, p_actual text, p_expected text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then raise exception 'FAIL %: expected "%", got "%"', p_label, p_expected, p_actual; end if;
  insert into t9c_passes values (p_label);
end $$;

create function pg_temp.expect(p_label text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAIL %: %', p_label, coalesce(p_detail, 'condition false'); end if;
  insert into t9c_passes values (p_label);
end $$;

-- Runs p_sql as p_user, then evaluates p_check (a scalar query, as superuser) BEFORE
-- the whole probe is rolled back. Returns '<result>##<check>'. run_as rolls the failed
-- statement back on its own, so the check shows the state a failed call leaves behind.
create function pg_temp.probe_check(p_setup text, p_user uuid, p_sql text, p_check text) returns text language plpgsql as $$
declare v_res text; v_chk text;
begin
  begin
    execute p_setup;
    v_res := pg_temp.run_as(p_user, p_sql);
    execute p_check into v_chk;
    raise exception 'PROBE:%##%', v_res, v_chk;
  exception when others then
    v_res := sqlerrm;
  end;
  return v_res;
end $$;

-- UUID shorthands.
create function pg_temp.sa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000009c0001'::uuid $$;
create function pg_temp.sb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000009c0002'::uuid $$;
create function pg_temp.u(p_k text) returns uuid language sql as $$
  select ('00000000-0000-0000-0000-0000009c' || case p_k
    when 'owner' then '1001' when 'admin' then '1002' when 'instructor' then '1003' when 'frontdesk' then '1004'
    when 'ownerb' then '1005' when 'platform' then '1006' when 'norole' then '1007' when 'admin2' then '1008' end)::uuid $$;
create function pg_temp.i(p_k text) returns uuid language sql as $$
  select ('00000000-0000-0000-0000-0000009c' || case p_k
    when 'nina' then '2001' when 'omar' then '2002' when 'bea' then '2003' when 'dana' then '2004' end)::uuid $$;

-- SQL text for one RPC call. Everything defaults to a "none" rule.
create function pg_temp.sv(p_studio uuid, p_instr uuid,
  pm text default 'none', pflat numeric default 0, ppct numeric default 0, pdur boolean default false,
  p30 numeric default 0, p45 numeric default 0, p60 numeric default 0,
  gm text default 'none', gflat numeric default 0, gpct numeric default 0, gper numeric default 0,
  p_notes text default null) returns text language sql as $$
  select format('select public.save_instructor_compensation_rule(%L::uuid, %L::uuid, %L, %L::numeric, %L::numeric, %L::boolean, %L::numeric, %L::numeric, %L::numeric, %L, %L::numeric, %L::numeric, %L::numeric, %L)',
    p_studio, p_instr, pm, pflat, ppct, pdur, p30, p45, p60, gm, gflat, gpct, gper, p_notes)
$$;

create function pg_temp.hist_count(p_instr uuid) returns bigint language sql as $$
  select count(*) from public.instructor_compensation_rule_history where instructor_id = p_instr $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000009c0001', 'Phase 9C Studio A', 't-phase9c-a'),
  ('00000000-0000-0000-0000-0000009c0002', 'Phase 9C Studio B', 't-phase9c-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000009c1001', 't-phase9c-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000009c1002', 't-phase9c-admin-a@example.test'),
  ('00000000-0000-0000-0000-0000009c1003', 't-phase9c-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000009c1004', 't-phase9c-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000009c1005', 't-phase9c-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000009c1006', 't-phase9c-platform@example.test'),
  ('00000000-0000-0000-0000-0000009c1007', 't-phase9c-norole@example.test'),
  ('00000000-0000-0000-0000-0000009c1008', 't-phase9c-admin2-a@example.test');

insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0000009c1001', 't-phase9c-owner-a@example.test', 'Olive Owner', null),
  ('00000000-0000-0000-0000-0000009c1002', 't-phase9c-admin-a@example.test', 'Ada Admin', null),
  ('00000000-0000-0000-0000-0000009c1003', 't-phase9c-instructor-a@example.test', 'Ian Instructor', null),
  ('00000000-0000-0000-0000-0000009c1004', 't-phase9c-frontdesk-a@example.test', 'Fay Desk', null),
  ('00000000-0000-0000-0000-0000009c1005', 't-phase9c-owner-b@example.test', 'Bo Owner', null),
  ('00000000-0000-0000-0000-0000009c1006', 't-phase9c-platform@example.test', 'Pat Platform', 'platform_admin'),
  ('00000000-0000-0000-0000-0000009c1007', 't-phase9c-norole@example.test', 'Nora None', null),
  ('00000000-0000-0000-0000-0000009c1008', 't-phase9c-admin2-a@example.test', 'Eve Exporter', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000009c1001', '00000000-0000-0000-0000-0000009c0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000009c1002', '00000000-0000-0000-0000-0000009c0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000009c1003', '00000000-0000-0000-0000-0000009c0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000009c1004', '00000000-0000-0000-0000-0000009c0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000009c1005', '00000000-0000-0000-0000-0000009c0002', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000009c1008', '00000000-0000-0000-0000-0000009c0001', 'studio_admin', true);

insert into public.instructors (id, studio_id, first_name, last_name, active) values
  ('00000000-0000-0000-0000-0000009c2001', '00000000-0000-0000-0000-0000009c0001', 'Nina', 'Alpha', true),
  ('00000000-0000-0000-0000-0000009c2002', '00000000-0000-0000-0000-0000009c0001', 'Omar', 'Beta', true),
  ('00000000-0000-0000-0000-0000009c2003', '00000000-0000-0000-0000-0000009c0002', 'Bea', 'Other', true),
  ('00000000-0000-0000-0000-0000009c2004', '00000000-0000-0000-0000-0000009c0001', 'Dana', 'Gamma', true);

-- ============================================================================
-- 1. VALIDATION (authoritative, in the RPC). Accept/reject probes persist nothing.
-- ============================================================================

do $$
declare
  v_o constant uuid := pg_temp.u('owner');
  v_a constant uuid := pg_temp.sa();
  v_i constant uuid := pg_temp.i('omar');
  v_res text;
begin
  -- Accepted boundaries.
  perform pg_temp.expect('T-9c-pct-0-accepted', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => 0), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect('T-9c-pct-100-accepted', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => 100), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect('T-9c-group-pct-0-and-100-accepted',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'percentage', gpct => 0), 'select 1') like 'PROBE:OK##%'
    and pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'percentage', gpct => 100), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect('T-9c-zero-flat-and-per-attendee-accepted',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 0, gm => 'per_attendee', gper => 0), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect('T-9c-none-modes-accepted',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect('T-9c-duration-rates-accepted',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 50, pdur => true, p30 => 25, p45 => 35, p60 => 50), 'select 1') like 'PROBE:OK##%');

  -- Percentages outside 0..100.
  perform pg_temp.expect_err('T-9c-pct-negative-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => -0.01), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-pct-over-100-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => 100.01), 'select 1'), 'percentages must be between 0 and 100');
  perform pg_temp.expect_err('T-9c-group-pct-over-100-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'percentage', gpct => 101), 'select 1'), 'percentages must be between 0 and 100');
  perform pg_temp.expect_err('T-9c-group-pct-negative-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'percentage', gpct => -5), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-irrelevant-pct-over-100-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 10, ppct => 150), 'select 1'), 'percentages must be between 0 and 100');

  -- Negative amounts.
  perform pg_temp.expect_err('T-9c-negative-flat-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-group-flat-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'flat', gflat => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-per-attendee-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'per_attendee', gper => -2), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-30-min-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 5, pdur => true, p30 => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-45-min-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 5, pdur => true, p45 => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-60-min-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 5, pdur => true, p60 => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-duration-with-rates-off-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 5, pdur => false, p60 => -1), 'select 1'), 'cannot be negative');
  perform pg_temp.expect_err('T-9c-negative-irrelevant-amount-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => 10, pflat => -3), 'select 1'), 'cannot be negative');

  -- Non-finite numbers.
  perform pg_temp.expect_err('T-9c-nan-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 'NaN'), 'select 1'), 'must be valid numbers');
  perform pg_temp.expect_err('T-9c-infinity-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'flat', gflat => 'Infinity'), 'select 1'), 'must be valid numbers');

  -- Unsupported / missing modes.
  perform pg_temp.expect_err('T-9c-invalid-private-mode-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'per_attendee', pflat => 5), 'select 1'), 'Unsupported private lesson pay mode');
  perform pg_temp.expect_err('T-9c-invalid-group-mode-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'hourly', gflat => 5), 'select 1'), 'Unsupported group class pay mode');
  perform pg_temp.expect_err('T-9c-null-private-mode-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => null), 'select 1'), 'Unsupported private lesson pay mode');
  perform pg_temp.expect_err('T-9c-null-group-mode-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => null), 'select 1'), 'Unsupported group class pay mode');
  perform pg_temp.expect_err('T-9c-empty-mode-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => ''), 'select 1'), 'Unsupported private lesson pay mode');

  -- Required amount for the selected mode.
  perform pg_temp.expect_err('T-9c-flat-requires-amount', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => null), 'select 1'), 'missing a required amount');
  perform pg_temp.expect_err('T-9c-percentage-requires-amount', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', ppct => null), 'select 1'), 'missing a required amount');
  perform pg_temp.expect_err('T-9c-group-flat-requires-amount', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'flat', gflat => null), 'select 1'), 'missing a required amount');
  perform pg_temp.expect_err('T-9c-group-pct-requires-amount', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'percentage', gpct => null), 'select 1'), 'missing a required amount');
  perform pg_temp.expect_err('T-9c-per-attendee-requires-amount', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'per_attendee', gper => null), 'select 1'), 'missing a required amount');
  perform pg_temp.expect('T-9c-null-irrelevant-fields-accepted',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 10, ppct => null, p30 => null, gm => 'none', gflat => null, gpct => null, gper => null), 'select 1') like 'PROBE:OK##%');
  perform pg_temp.expect_err('T-9c-notes-too-long-rejected', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, p_notes => repeat('x', 1001)), 'select 1'), 'notes are too long');

  -- Failed validation leaves nothing behind.
  perform pg_temp.expect('T-9c-validation-leaves-no-rule-or-history',
    not exists (select 1 from public.instructor_compensation_rules where instructor_id = v_i) and pg_temp.hist_count(v_i) = 0);
end $$;

-- ============================================================================
-- 2. NORMALIZATION OF MODE-IRRELEVANT FIELDS
-- ============================================================================

do $$
declare
  v_o constant uuid := pg_temp.u('owner');
  v_a constant uuid := pg_temp.sa();
  v_i constant uuid := pg_temp.i('omar');
  r record;
  v_chk text := 'select concat_ws(''/'', private_lesson_pay_mode, private_lesson_flat_amount::float8, private_lesson_percentage::float8, private_lesson_duration_rates_enabled, private_lesson_30_min_flat_amount::float8, private_lesson_45_min_flat_amount::float8, private_lesson_60_min_flat_amount::float8, group_class_pay_mode, group_class_flat_amount::float8, group_class_percentage::float8, group_class_per_attendee_amount::float8) from public.instructor_compensation_rules where instructor_id = ''00000000-0000-0000-0000-0000009c2002''';
begin
  perform pg_temp.expect_eq('T-9c-normalize-flat-clears-pct-and-buckets', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 40, ppct => 50, pdur => false, p30 => 10, p45 => 11, p60 => 12, gm => 'flat', gflat => 25, gpct => 30, gper => 7), v_chk), 'PROBE:OK##flat/40/0/f/0/0/0/flat/25/0/0');
  perform pg_temp.expect_eq('T-9c-normalize-percentage-clears-flat-and-duration', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'percentage', pflat => 40, ppct => 45, pdur => true, p30 => 10, p45 => 11, p60 => 12, gm => 'percentage', gflat => 25, gpct => 20, gper => 7), v_chk), 'PROBE:OK##percentage/0/45/f/0/0/0/percentage/0/20/0');
  perform pg_temp.expect_eq('T-9c-normalize-per-attendee-clears-flat-and-pct', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, gm => 'per_attendee', gflat => 25, gpct => 30, gper => 4), v_chk), 'PROBE:OK##none/0/0/f/0/0/0/per_attendee/0/0/4');
  perform pg_temp.expect_eq('T-9c-normalize-none-clears-everything', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'none', pflat => 40, ppct => 50, pdur => true, p30 => 1, p45 => 2, p60 => 3, gm => 'none', gflat => 5, gpct => 6, gper => 7), v_chk), 'PROBE:OK##none/0/0/f/0/0/0/none/0/0/0');
  perform pg_temp.expect_eq('T-9c-duration-buckets-kept-only-for-flat-with-duration-on', pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 50, pdur => true, p30 => 25, p45 => 35, p60 => 50), v_chk), 'PROBE:OK##flat/50/0/t/25/35/50/none/0/0/0');
  perform pg_temp.expect('T-9c-normalized-values-are-what-history-records',
    pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 40, ppct => 50, p30 => 10),
      'select new_values::text from public.instructor_compensation_rule_history where instructor_id = ''00000000-0000-0000-0000-0000009c2002''') like '%"private_lesson_percentage": 0%'
    and pg_temp.probe_check('select 1', v_o, pg_temp.sv(v_a, v_i, pm => 'flat', pflat => 40, ppct => 50, p30 => 10),
      'select new_values::text from public.instructor_compensation_rule_history where instructor_id = ''00000000-0000-0000-0000-0000009c2002''') like '%"private_lesson_30_min_flat_amount": 0%');
end $$;

-- ============================================================================
-- 3. CREATE / EDIT HISTORY (Nina)
-- ============================================================================

create temporary table t9c (k text primary key, v text) on commit drop;
grant select on t9c to authenticated;

do $$
declare
  v_o constant uuid := pg_temp.u('owner');
  v_ad constant uuid := pg_temp.u('admin');
  v_a constant uuid := pg_temp.sa();
  v_n constant uuid := pg_temp.i('nina');
  h record;
  v_rule record;
  v_updated_at timestamptz;
  v_first_md5 text;
begin
  perform pg_temp.expect('T-9c-no-rule-before-first-save', not exists (select 1 from public.instructor_compensation_rules where instructor_id = v_n));

  -- 1. Owner creates.
  perform pg_temp.expect_ok('T-9c-owner-creates-rule', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 40, gm => 'percentage', gpct => 20)));
  select * into v_rule from public.instructor_compensation_rules where instructor_id = v_n;
  perform pg_temp.expect('T-9c-created-rule-row', v_rule.studio_id = v_a and v_rule.private_lesson_pay_mode = 'flat' and v_rule.private_lesson_flat_amount = 40
    and v_rule.group_class_pay_mode = 'percentage' and v_rule.group_class_percentage = 20 and v_rule.active and v_rule.created_by = v_o);
  perform pg_temp.expect('T-9c-created-one-history-row', pg_temp.hist_count(v_n) = 1);
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq limit 1;
  perform pg_temp.expect('T-9c-created-history-fields', h.studio_id = v_a and h.rule_id = v_rule.id and h.change_type = 'created'
    and h.previous_values is null and h.new_values ->> 'private_lesson_pay_mode' = 'flat'
    and (h.new_values ->> 'private_lesson_flat_amount')::numeric = 40 and h.new_values ->> 'group_class_pay_mode' = 'percentage'
    and (h.new_values ->> 'group_class_percentage')::numeric = 20 and h.changed_at is not null);
  perform pg_temp.expect('T-9c-created-history-actor', h.changed_by = v_o and h.changed_by_name = 'Olive Owner'
    and h.changed_by_email = 't-phase9c-owner-a@example.test' and h.changed_by_role = 'studio_owner');
  select md5(x::text) into v_first_md5 from public.instructor_compensation_rule_history x where x.id = h.id;
  insert into t9c values ('first_hist_id', h.id::text), ('first_hist_md5', v_first_md5);

  -- 2. Admin edits: second row appended, first untouched, created_by preserved.
  perform pg_temp.expect_ok('T-9c-admin-edits-rule', pg_temp.run_as(v_ad, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'percentage', gpct => 20)));
  perform pg_temp.expect('T-9c-edit-appends-second-row', pg_temp.hist_count(v_n) = 2);
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-update-history-before-after', h.change_type = 'updated' and h.previous_values ->> 'private_lesson_pay_mode' = 'flat'
    and (h.previous_values ->> 'private_lesson_flat_amount')::numeric = 40 and h.new_values ->> 'private_lesson_pay_mode' = 'percentage'
    and (h.new_values ->> 'private_lesson_percentage')::numeric = 45 and (h.new_values ->> 'private_lesson_flat_amount')::numeric = 0);
  perform pg_temp.expect('T-9c-update-history-changed-fields', h.changed_fields = array['private_lesson_flat_amount', 'private_lesson_pay_mode', 'private_lesson_percentage']);
  perform pg_temp.expect('T-9c-update-history-actor-admin', h.changed_by = v_ad and h.changed_by_name = 'Ada Admin'
    and h.changed_by_email = 't-phase9c-admin-a@example.test' and h.changed_by_role = 'studio_admin');
  perform pg_temp.expect('T-9c-first-history-row-unchanged',
    (select md5(x::text) from public.instructor_compensation_rule_history x where x.id = (select v::uuid from t9c where k = 'first_hist_id')) = v_first_md5);
  select * into v_rule from public.instructor_compensation_rules where instructor_id = v_n;
  perform pg_temp.expect('T-9c-rule-matches-latest-history', v_rule.private_lesson_pay_mode = 'percentage' and v_rule.private_lesson_percentage = 45
    and v_rule.private_lesson_flat_amount = 0 and v_rule.created_by = v_o);
  perform pg_temp.expect('T-9c-one-rule-row-per-instructor', (select count(*) from public.instructor_compensation_rules where instructor_id = v_n) = 1);

  -- 3. Third edit -> third row.
  perform pg_temp.expect_ok('T-9c-owner-edits-again', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'per_attendee', gper => 4)));
  perform pg_temp.expect('T-9c-second-edit-appends-third-row', pg_temp.hist_count(v_n) = 3);
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-group-mode-change-recorded', h.previous_values ->> 'group_class_pay_mode' = 'percentage'
    and h.new_values ->> 'group_class_pay_mode' = 'per_attendee' and (h.new_values ->> 'group_class_per_attendee_amount')::numeric = 4
    and (h.new_values ->> 'group_class_percentage')::numeric = 0);

  -- 4. No-op saves append nothing and do not touch the rule.
  select updated_at into v_updated_at from public.instructor_compensation_rules where instructor_id = v_n;
  perform pg_temp.expect_ok('T-9c-noop-save-ok', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'per_attendee', gper => 4)));
  perform pg_temp.expect('T-9c-noop-save-appends-no-history', pg_temp.hist_count(v_n) = 3);
  perform pg_temp.expect('T-9c-noop-save-leaves-rule-untouched', (select updated_at from public.instructor_compensation_rules where instructor_id = v_n) = v_updated_at);
  perform pg_temp.expect_ok('T-9c-noop-with-irrelevant-fields-ok', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', pflat => 99, ppct => 45, gm => 'per_attendee', gflat => 3, gper => 4)));
  perform pg_temp.expect('T-9c-noop-after-normalization-appends-no-history', pg_temp.hist_count(v_n) = 3);
  perform pg_temp.expect_ok('T-9c-blank-notes-noop-ok', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'per_attendee', gper => 4, p_notes => '   ')));
  perform pg_temp.expect('T-9c-blank-notes-is-noop', pg_temp.hist_count(v_n) = 3);
  perform pg_temp.expect('T-9c-noop-return-flags-unchanged',
    pg_temp.scalar_as(v_o, replace(pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'per_attendee', gper => 4), 'select ', 'select (') || ')->>''changed''') = 'false');

  -- 5. Notes-only change.
  perform pg_temp.expect_ok('T-9c-notes-change-ok', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 45, gm => 'per_attendee', gper => 4, p_notes => '  Updated for spring  ')));
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-notes-change-recorded-trimmed', pg_temp.hist_count(v_n) = 4 and h.changed_fields = array['notes']
    and h.new_values ->> 'notes' = 'Updated for spring' and h.previous_values -> 'notes' = 'null'::jsonb);

  -- 6. Duration rates.
  perform pg_temp.expect_ok('T-9c-duration-rates-edit', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 50, pdur => true, p30 => 25, p45 => 35, p60 => 50, gm => 'per_attendee', gper => 4, p_notes => 'Updated for spring')));
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-duration-rates-recorded', pg_temp.hist_count(v_n) = 5 and (h.new_values ->> 'private_lesson_duration_rates_enabled')::boolean
    and (h.new_values ->> 'private_lesson_45_min_flat_amount')::numeric = 35 and not (h.previous_values ->> 'private_lesson_duration_rates_enabled')::boolean);

  -- 7. Clearing pay is typed 'cleared'; re-enabling is 'updated'.
  perform pg_temp.expect_ok('T-9c-clear-rule', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, p_notes => 'Updated for spring')));
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-clear-typed-cleared', h.change_type = 'cleared' and h.new_values ->> 'private_lesson_pay_mode' = 'none'
    and h.new_values ->> 'group_class_pay_mode' = 'none' and (h.new_values ->> 'private_lesson_30_min_flat_amount')::numeric = 0);
  perform pg_temp.expect_ok('T-9c-reenable-rule', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 60, p_notes => 'Updated for spring')));
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_n order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-reenable-typed-updated', h.change_type = 'updated' and pg_temp.hist_count(v_n) = 7);

  -- Ordering: newest first by (changed_at, change_seq).
  perform pg_temp.expect('T-9c-history-order-newest-first',
    (select array_agg(change_type order by changed_at desc, change_seq desc) from public.instructor_compensation_rule_history where instructor_id = v_n)
      = array['updated', 'cleared', 'updated', 'updated', 'updated', 'updated', 'created']);
  perform pg_temp.expect('T-9c-history-times-monotonic', (select bool_and(changed_at >= prev_at) from (
    select changed_at, lag(changed_at) over (order by change_seq) as prev_at from public.instructor_compensation_rule_history where instructor_id = v_n) q where prev_at is not null));
  perform pg_temp.expect('T-9c-first-history-row-still-unchanged',
    (select md5(x::text) from public.instructor_compensation_rule_history x where x.id = (select v::uuid from t9c where k = 'first_hist_id')) = v_first_md5);
end $$;

-- ============================================================================
-- 4. IMMUTABILITY AND DIRECT-WRITE LOCKDOWN
-- ============================================================================

do $$
declare
  v_o constant uuid := pg_temp.u('owner');
  v_a constant uuid := pg_temp.sa();
  v_n constant uuid := pg_temp.i('nina');
  v_h uuid := (select v::uuid from t9c where k = 'first_hist_id');
begin
  perform pg_temp.expect_err('T-9c-history-update-trusted', pg_temp.run_trusted(format(
    'update public.instructor_compensation_rule_history set changed_by_name = ''x'' where id = %L', v_h)), 'Compensation rule history is immutable.');
  perform pg_temp.expect_err('T-9c-history-delete-trusted', pg_temp.run_trusted(format(
    'delete from public.instructor_compensation_rule_history where id = %L', v_h)), 'Compensation rule history is immutable.');
  perform pg_temp.expect_err('T-9c-history-delete-all-trusted', pg_temp.run_trusted(
    'delete from public.instructor_compensation_rule_history'), 'Compensation rule history is immutable.');
  perform pg_temp.expect_err('T-9c-history-truncate-trusted', pg_temp.run_trusted(
    'truncate public.instructor_compensation_rule_history'), 'Compensation rule history is immutable.');
  perform pg_temp.expect_err('T-9c-history-update-api', pg_temp.run_as(v_o, format(
    'update public.instructor_compensation_rule_history set changed_by_name = ''x'' where id = %L', v_h)), 'permission denied');
  perform pg_temp.expect_err('T-9c-history-delete-api', pg_temp.run_as(v_o, format(
    'delete from public.instructor_compensation_rule_history where id = %L', v_h)), 'permission denied');
  perform pg_temp.expect_err('T-9c-history-truncate-api', pg_temp.run_as(v_o,
    'truncate public.instructor_compensation_rule_history'), 'permission denied');
  perform pg_temp.expect_err('T-9c-history-insert-api', pg_temp.run_as(v_o, format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, new_values)
     values (%L, %L, gen_random_uuid(), ''created'', ''studio_owner'', array[''notes''], ''{}''::jsonb)', v_a, v_n)), 'permission denied');
  perform pg_temp.expect('T-9c-history-intact', pg_temp.hist_count(v_n) = 7);

  -- Table shape constraints (trusted).
  perform pg_temp.expect_err('T-9c-history-bad-change-type', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, new_values)
     values (%L, %L, gen_random_uuid(), ''deleted'', ''studio_owner'', array[''notes''], ''{}''::jsonb)', v_a, v_n)), 'violates check constraint');
  perform pg_temp.expect_err('T-9c-history-created-with-previous-refused', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, previous_values, new_values)
     values (%L, %L, gen_random_uuid(), ''created'', ''studio_owner'', array[''notes''], ''{}''::jsonb, ''{}''::jsonb)', v_a, v_n)), 'values_shape');
  perform pg_temp.expect_err('T-9c-history-updated-without-previous-refused', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, new_values)
     values (%L, %L, gen_random_uuid(), ''updated'', ''studio_owner'', array[''notes''], ''{}''::jsonb)', v_a, v_n)), 'values_shape');
  perform pg_temp.expect_err('T-9c-history-platform-role-refused', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, new_values)
     values (%L, %L, gen_random_uuid(), ''created'', ''platform_admin'', array[''notes''], ''{}''::jsonb)', v_a, v_n)), 'violates check constraint');
  perform pg_temp.expect_err('T-9c-history-unknown-studio-refused', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rule_history (studio_id, instructor_id, rule_id, change_type, changed_by_role, changed_fields, new_values)
     values (gen_random_uuid(), %L, gen_random_uuid(), ''created'', ''studio_owner'', array[''notes''], ''{}''::jsonb)', v_n)), 'violates foreign key constraint');

  -- Direct rule writes are closed for API roles (the RPC is the only writer).
  perform pg_temp.expect_err('T-9c-rule-direct-insert-api', pg_temp.run_as(v_o, format(
    'insert into public.instructor_compensation_rules (studio_id, instructor_id) values (%L, %L)', v_a, pg_temp.i('omar'))), 'permission denied');
  perform pg_temp.expect_err('T-9c-rule-direct-update-api', pg_temp.run_as(v_o, format(
    'update public.instructor_compensation_rules set private_lesson_flat_amount = 999 where instructor_id = %L', v_n)), 'permission denied');
  perform pg_temp.expect_err('T-9c-rule-direct-delete-api', pg_temp.run_as(v_o, format(
    'delete from public.instructor_compensation_rules where instructor_id = %L', v_n)), 'permission denied');
  perform pg_temp.expect_err('T-9c-rule-direct-upsert-api', pg_temp.run_as(v_o, format(
    'insert into public.instructor_compensation_rules (studio_id, instructor_id, private_lesson_flat_amount) values (%L, %L, 1) on conflict (studio_id, instructor_id) do update set private_lesson_flat_amount = 1', v_a, v_n)), 'permission denied');
  perform pg_temp.expect('T-9c-rule-unchanged-after-direct-attempts', (select private_lesson_flat_amount from public.instructor_compensation_rules where instructor_id = v_n) = 60);

  -- Range checks exist as VALIDATED constraints and bite on new writes (trusted writes too).
  perform pg_temp.expect('T-9c-range-checks-present-validated', (select count(*) from pg_constraint
    where conrelid = 'public.instructor_compensation_rules'::regclass and conname in ('instructor_compensation_rules_percentages_check', 'instructor_compensation_rules_amounts_check')
      and convalidated) = 2);
  perform pg_temp.expect_err('T-9c-rule-check-pct-over-100-trusted', pg_temp.run_trusted(format(
    'update public.instructor_compensation_rules set private_lesson_percentage = 101 where instructor_id = %L', v_n)), 'instructor_compensation_rules_percentages_check');
  perform pg_temp.expect_err('T-9c-rule-check-negative-flat-trusted', pg_temp.run_trusted(format(
    'update public.instructor_compensation_rules set group_class_flat_amount = -1 where instructor_id = %L', v_n)), 'instructor_compensation_rules_amounts_check');
  perform pg_temp.expect_err('T-9c-rule-check-negative-bucket-trusted', pg_temp.run_trusted(format(
    'update public.instructor_compensation_rules set private_lesson_45_min_flat_amount = -1 where instructor_id = %L', v_n)), 'instructor_compensation_rules_amounts_check');
  perform pg_temp.expect_err('T-9c-rule-check-negative-per-attendee-trusted', pg_temp.run_trusted(format(
    'update public.instructor_compensation_rules set group_class_per_attendee_amount = -1 where instructor_id = %L', v_n)), 'instructor_compensation_rules_amounts_check');
  perform pg_temp.expect_err('T-9c-rule-same-studio-trigger-still-enforced', pg_temp.run_trusted(format(
    'insert into public.instructor_compensation_rules (studio_id, instructor_id) values (%L, %L)', v_a, pg_temp.i('bea'))), 'same studio');
end $$;

-- ============================================================================
-- 5. TENANT ISOLATION AND ROLES
-- ============================================================================

do $$
declare
  v_a constant uuid := pg_temp.sa();
  v_b constant uuid := pg_temp.sb();
  v_n constant uuid := pg_temp.i('nina');
  v_bea constant uuid := pg_temp.i('bea');
  v_ownerb constant uuid := pg_temp.u('ownerb');
  v_o constant uuid := pg_temp.u('owner');
  v_k text;
begin
  -- Cross-studio / unknown instructors fail identically and write nothing.
  perform pg_temp.expect_err('T-9c-owner-a-instructor-of-b-rejected', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_bea, pm => 'flat', pflat => 10)), 'Instructor not found for this studio.');
  perform pg_temp.expect_err('T-9c-owner-a-unknown-instructor-rejected', pg_temp.run_as(v_o, pg_temp.sv(v_a, gen_random_uuid(), pm => 'flat', pflat => 10)), 'Instructor not found for this studio.');
  perform pg_temp.expect_err('T-9c-owner-a-null-instructor-rejected', pg_temp.run_as(v_o, pg_temp.sv(v_a, null, pm => 'flat', pflat => 10)), 'Instructor not found for this studio.');
  perform pg_temp.expect_err('T-9c-owner-a-naming-studio-b-denied', pg_temp.run_as(v_o, pg_temp.sv(v_b, v_bea, pm => 'flat', pflat => 10)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-owner-a-naming-studio-b-with-a-instructor-denied', pg_temp.run_as(v_o, pg_temp.sv(v_b, v_n, pm => 'flat', pflat => 10)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-owner-a-null-studio-denied', pg_temp.run_as(v_o, pg_temp.sv(null, v_n, pm => 'flat', pflat => 10)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-owner-b-edit-studio-a-rule-denied', pg_temp.run_as(v_ownerb, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-owner-b-with-own-studio-a-instructor-rejected', pg_temp.run_as(v_ownerb, pg_temp.sv(v_b, v_n, pm => 'flat', pflat => 1)), 'Instructor not found for this studio.');
  perform pg_temp.expect('T-9c-cross-studio-attempts-wrote-nothing', pg_temp.hist_count(v_bea) = 0 and pg_temp.hist_count(v_n) = 7
    and not exists (select 1 from public.instructor_compensation_rules where instructor_id = v_bea)
    and (select private_lesson_flat_amount from public.instructor_compensation_rules where instructor_id = v_n) = 60);

  -- Role gates.
  perform pg_temp.expect_err('T-9c-front-desk-denied', pg_temp.run_as(pg_temp.u('frontdesk'), pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-instructor-role-denied', pg_temp.run_as(pg_temp.u('instructor'), pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-no-role-denied', pg_temp.run_as(pg_temp.u('norole'), pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-platform-admin-denied-unchanged-behaviour', pg_temp.run_as(pg_temp.u('platform'), pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-platform-admin-cross-studio-denied', pg_temp.run_as(pg_temp.u('platform'), pg_temp.sv(v_b, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect_err('T-9c-unauthenticated-denied', pg_temp.run_trusted(pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 1)), 'Payroll access denied.');
  perform pg_temp.expect('T-9c-anon-cannot-execute-save-rpc', not has_function_privilege('anon',
    'public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)', 'execute'));
  perform pg_temp.expect('T-9c-authenticated-can-execute-save-rpc', has_function_privilege('authenticated',
    'public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)', 'execute'));
  perform pg_temp.expect('T-9c-denied-attempts-wrote-nothing', pg_temp.hist_count(v_n) = 7);

  -- Studio B owner saves for Bea in studio B.
  perform pg_temp.expect_ok('T-9c-owner-b-creates-own-rule', pg_temp.run_as(v_ownerb, pg_temp.sv(v_b, v_bea, pm => 'percentage', ppct => 30)));
  perform pg_temp.expect('T-9c-studio-b-history-row-bound-to-b', (select count(*) from public.instructor_compensation_rule_history where studio_id = v_b and instructor_id = v_bea) = 1
    and (select changed_by from public.instructor_compensation_rule_history where instructor_id = v_bea) = v_ownerb);

  -- Read isolation (RLS).
  perform pg_temp.expect('T-9c-owner-a-reads-own-history', pg_temp.scalar_as(v_o, format('select count(*) from public.instructor_compensation_rule_history where studio_id = %L', v_a)) = '7');
  perform pg_temp.expect('T-9c-admin-a-reads-own-history', pg_temp.scalar_as(pg_temp.u('admin'), format('select count(*) from public.instructor_compensation_rule_history where studio_id = %L', v_a)) = '7');
  perform pg_temp.expect('T-9c-owner-a-cannot-read-studio-b-history', pg_temp.scalar_as(v_o, format('select count(*) from public.instructor_compensation_rule_history where studio_id = %L', v_b)) = '0');
  perform pg_temp.expect('T-9c-owner-b-cannot-read-studio-a-history', pg_temp.scalar_as(v_ownerb, format('select count(*) from public.instructor_compensation_rule_history where studio_id = %L', v_a)) = '0');
  perform pg_temp.expect('T-9c-owner-b-reads-own-history', pg_temp.scalar_as(v_ownerb, format('select count(*) from public.instructor_compensation_rule_history where studio_id = %L', v_b)) = '1');
  foreach v_k in array array['frontdesk', 'instructor', 'norole', 'platform'] loop
    perform pg_temp.expect('T-9c-' || v_k || '-cannot-read-history', pg_temp.scalar_as(pg_temp.u(v_k), 'select count(*) from public.instructor_compensation_rule_history') = '0');
  end loop;
  perform pg_temp.expect('T-9c-owner-a-cannot-read-studio-b-rule', pg_temp.scalar_as(v_o, format('select count(*) from public.instructor_compensation_rules where studio_id = %L', v_b)) = '0');
  perform pg_temp.expect('T-9c-owner-a-reads-own-rules', pg_temp.scalar_as(v_o, format('select count(*) from public.instructor_compensation_rules where studio_id = %L', v_a)) = '1');
  perform pg_temp.expect('T-9c-front-desk-cannot-read-rules', pg_temp.scalar_as(pg_temp.u('frontdesk'), 'select count(*) from public.instructor_compensation_rules') = '0');
  perform pg_temp.expect('T-9c-anon-cannot-select-history', not has_table_privilege('anon', 'public.instructor_compensation_rule_history', 'SELECT')
    and not has_table_privilege('anon', 'public.instructor_compensation_rules', 'SELECT'));
end $$;

-- ============================================================================
-- 6. ACTOR EVIDENCE SURVIVES PROFILE CHANGE / DELETION AND INSTRUCTOR DELETION
-- ============================================================================

do $$
declare
  v_a constant uuid := pg_temp.sa();
  v_o constant uuid := pg_temp.u('owner');
  v_a2 constant uuid := pg_temp.u('admin2');
  v_omar constant uuid := pg_temp.i('omar');
  v_dana constant uuid := pg_temp.i('dana');
  v_first uuid := (select v::uuid from t9c where k = 'first_hist_id');
  h record;
begin
  update public.profiles set full_name = 'Renamed Owner', email = 'renamed-owner@example.test' where id = v_o;
  select * into h from public.instructor_compensation_rule_history where id = v_first;
  perform pg_temp.expect('T-9c-actor-evidence-survives-profile-change', h.changed_by_name = 'Olive Owner' and h.changed_by_email = 't-phase9c-owner-a@example.test');
  perform pg_temp.expect_ok('T-9c-owner-edits-after-rename', pg_temp.run_as(v_o, pg_temp.sv(v_a, pg_temp.i('nina'), pm => 'flat', pflat => 61, p_notes => 'Updated for spring')));
  select * into h from public.instructor_compensation_rule_history where instructor_id = pg_temp.i('nina') order by change_seq desc limit 1;
  perform pg_temp.expect('T-9c-new-row-uses-current-profile', h.changed_by_name = 'Renamed Owner' and h.changed_by_email = 'renamed-owner@example.test');

  perform pg_temp.expect_ok('T-9c-second-admin-creates-omar-rule', pg_temp.run_as(v_a2, pg_temp.sv(v_a, v_omar, gm => 'flat', gflat => 25)));
  perform pg_temp.expect_ok('T-9c-delete-history-only-profile', pg_temp.run_trusted(format(
    'delete from public.user_studio_roles where user_id = %L; delete from public.profiles where id = %L', v_a2, v_a2)));
  select * into h from public.instructor_compensation_rule_history where instructor_id = v_omar;
  perform pg_temp.expect('T-9c-actor-evidence-survives-profile-deletion', h.changed_by = v_a2 and h.changed_by_name = 'Eve Exporter'
    and h.changed_by_email = 't-phase9c-admin2-a@example.test' and h.changed_by_role = 'studio_admin');
  perform pg_temp.expect('T-9c-rule-created-by-nulled-but-history-keeps-actor', (select created_by from public.instructor_compensation_rules where instructor_id = v_omar) is null);

  -- Actor with no profile row: evidence keeps id and role, name/email empty.
  perform pg_temp.expect('T-9c-deleted-admin-can-no-longer-save', pg_temp.run_as(v_a2, pg_temp.sv(v_a, v_omar, gm => 'flat', gflat => 26)) like '%Payroll access denied.%');

  -- Instructor deletion cascades the rule but not its history.
  perform pg_temp.expect_ok('T-9c-dana-rule-created', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_dana, pm => 'flat', pflat => 20)));
  perform pg_temp.expect_ok('T-9c-instructor-deleted', pg_temp.run_trusted(format('delete from public.instructors where id = %L', v_dana)));
  perform pg_temp.expect('T-9c-history-survives-instructor-delete', pg_temp.hist_count(v_dana) = 1
    and not exists (select 1 from public.instructor_compensation_rules where instructor_id = v_dana));
end $$;

-- ============================================================================
-- 7. ATOMICITY
-- ============================================================================

do $$
declare
  v_a constant uuid := pg_temp.sa();
  v_o constant uuid := pg_temp.u('owner');
  v_n constant uuid := pg_temp.i('nina');
  v_bea constant uuid := pg_temp.i('bea');
  v_chk_nina text := 'select (select private_lesson_flat_amount::float8 from public.instructor_compensation_rules where instructor_id = ''00000000-0000-0000-0000-0000009c2001'') || ''/'' || (select count(*) from public.instructor_compensation_rule_history where instructor_id = ''00000000-0000-0000-0000-0000009c2001'')';
  v_res text;
begin
  -- History insert fails during an EDIT: the rule update is rolled back with it.
  v_res := pg_temp.probe_check(
    'alter table public.instructor_compensation_rule_history add constraint t9c_fail_history check (changed_by_name is distinct from ''Renamed Owner'') not valid',
    v_o, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 77, p_notes => 'Updated for spring'), v_chk_nina);
  perform pg_temp.expect_err('T-9c-history-failure-errors', v_res, 't9c_fail_history');
  perform pg_temp.expect('T-9c-history-failure-rolls-back-rule-update', v_res like '%##61/8', v_res);

  -- History insert fails during a CREATE: no rule row is left behind.
  insert into public.instructors (id, studio_id, first_name, last_name, active)
    values ('00000000-0000-0000-0000-0000009c2005', v_a, 'Ezra', 'Delta', true);
  v_res := pg_temp.probe_check(
    'alter table public.instructor_compensation_rule_history add constraint t9c_fail_history check (changed_by_name is distinct from ''Renamed Owner'') not valid',
    v_o, pg_temp.sv(v_a, '00000000-0000-0000-0000-0000009c2005', pm => 'flat', pflat => 5),
    'select (select count(*) from public.instructor_compensation_rules where instructor_id = ''00000000-0000-0000-0000-0000009c2005'') || ''/'' || (select count(*) from public.instructor_compensation_rule_history where instructor_id = ''00000000-0000-0000-0000-0000009c2005'')');
  perform pg_temp.expect_err('T-9c-history-failure-on-create-errors', v_res, 't9c_fail_history');
  perform pg_temp.expect('T-9c-history-failure-rolls-back-rule-insert', v_res like '%##0/0', v_res);

  -- Rule write fails: no history row is left behind (edit and create).
  v_res := pg_temp.probe_check(
    'alter table public.instructor_compensation_rules add constraint t9c_fail_rule check (private_lesson_flat_amount <> 78) not valid',
    v_o, pg_temp.sv(v_a, v_n, pm => 'flat', pflat => 78, p_notes => 'Updated for spring'), v_chk_nina);
  perform pg_temp.expect_err('T-9c-rule-failure-errors', v_res, 't9c_fail_rule');
  perform pg_temp.expect('T-9c-rule-failure-appends-no-history', v_res like '%##61/8', v_res);
  v_res := pg_temp.probe_check(
    'alter table public.instructor_compensation_rules add constraint t9c_fail_rule check (private_lesson_flat_amount <> 78) not valid',
    v_o, pg_temp.sv(v_a, '00000000-0000-0000-0000-0000009c2005', pm => 'flat', pflat => 78),
    'select (select count(*) from public.instructor_compensation_rules where instructor_id = ''00000000-0000-0000-0000-0000009c2005'') || ''/'' || (select count(*) from public.instructor_compensation_rule_history where instructor_id = ''00000000-0000-0000-0000-0000009c2005'')');
  perform pg_temp.expect_err('T-9c-rule-create-failure-errors', v_res, 't9c_fail_rule');
  perform pg_temp.expect('T-9c-rule-create-failure-appends-no-history', v_res like '%##0/0', v_res);

  perform pg_temp.expect('T-9c-probes-rolled-back', (select private_lesson_flat_amount from public.instructor_compensation_rules where instructor_id = v_n) = 61
    and pg_temp.hist_count(v_n) = 8
    and not exists (select 1 from pg_constraint where conname in ('t9c_fail_history', 't9c_fail_rule')));
end $$;

-- ============================================================================
-- 8. RULE EDITS NEVER CHANGE EXISTING PAYROLL EVIDENCE
-- ============================================================================

insert into public.instructor_earnings (id, studio_id, instructor_id, earning_date, source_type, appointment_type, pay_mode, pay_rate_amount, earning_amount, adjustment_type,
  worker_classification_snapshot, accounting_category_snapshot, taxable_compensation_amount, reimbursement_amount, deduction_amount, notes) values
  ('00000000-0000-0000-0000-0000009c7001', '00000000-0000-0000-0000-0000009c0001', '00000000-0000-0000-0000-0000009c2001', date '2026-01-05',
   'manual_adjustment', null, 'manual_adjustment', 100, 100, 'bonus', 'contractor', 'contract_labor_expense', 100, 0, 0, 'lesson bonus'),
  ('00000000-0000-0000-0000-0000009c7002', '00000000-0000-0000-0000-0000009c0001', '00000000-0000-0000-0000-0000009c2001', date '2026-01-06',
   'manual_adjustment', null, 'manual_adjustment', 20, 20, 'reimbursement', 'contractor', 'contract_labor_expense', 0, 20, 0, 'parking'),
  ('00000000-0000-0000-0000-0000009c7003', '00000000-0000-0000-0000-0000009c0001', '00000000-0000-0000-0000-0000009c2001', date '2026-02-05',
   'manual_adjustment', null, 'manual_adjustment', 40, 40, 'bonus', 'contractor', 'contract_labor_expense', 40, 0, 0, 'pending only');

do $$
declare
  v_a constant uuid := pg_temp.sa();
  v_o constant uuid := pg_temp.u('owner');
  v_n constant uuid := pg_temp.i('nina');
  v_period uuid;
  v_batch uuid;
  e uuid;
  v_before text;
  v_after text;
  v_export_before text;
begin
  perform pg_temp.expect_ok('T-9c-fixture-period', pg_temp.run_as(v_o, format('select public.create_payroll_pay_period(%L, date ''2026-01-01'', date ''2026-01-15'', date ''2026-01-20'')', v_a)));
  select id into v_period from public.payroll_pay_periods where studio_id = v_a and period_start = date '2026-01-01';
  foreach e in array array['00000000-0000-0000-0000-0000009c7001', '00000000-0000-0000-0000-0000009c7002']::uuid[] loop
    perform pg_temp.expect_ok('T-9c-fixture-assign', pg_temp.run_as(v_o, format(
      'select public.assign_single_earning_to_pay_period(%L, %L, %L); update public.instructor_earnings set status = ''approved'' where id = %L', v_a, v_period, e, e)));
  end loop;
  perform pg_temp.expect_ok('T-9c-fixture-batch', pg_temp.run_as(v_o, format('select public.create_payroll_batch_from_period(%L, %L, ''manual'')', v_a, v_period)));
  select id into v_batch from public.payroll_batches where studio_id = v_a and pay_period_id = v_period;
  perform pg_temp.expect_ok('T-9c-fixture-approve', pg_temp.run_as(v_o, format('select public.approve_payroll_batch(%L, %L)', v_a, v_batch)));
  perform pg_temp.expect_ok('T-9c-fixture-pay', pg_temp.run_as(v_o, format('select public.mark_payroll_batch_paid(%L, %L, ''check'', ''CHK-9C'')', v_a, v_batch)));
  perform pg_temp.expect_ok('T-9c-fixture-export', pg_temp.run_as(v_o, format('select public.record_payroll_export(%L, %L, ''csv'', 2, 120)', v_a, v_batch)));

  v_before := concat_ws('#',
    (select md5(string_agg(t::text, '|' order by t.id)) from public.instructor_earnings t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_approval_snapshots t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_approval_snapshot_lines t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_payment_evidence t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_export_events t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batches t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_pay_periods t where t.studio_id = v_a));
  v_export_before := pg_temp.scalar_as(v_o, format('select md5((public.get_payroll_batch_export(%L, %L))::text)', v_a, v_batch));
  perform pg_temp.expect('T-9c-fixture-evidence-exists', (select count(*) from public.payroll_batch_approval_snapshot_lines where payroll_batch_id = v_batch) = 2
    and exists (select 1 from public.payroll_batch_payment_evidence where payroll_batch_id = v_batch)
    and exists (select 1 from public.payroll_export_events where payroll_batch_id = v_batch) and v_export_before not like 'ERR:%', v_export_before);

  -- Change Nina's rule in several ways.
  perform pg_temp.expect_ok('T-9c-regression-edit-1', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n, pm => 'percentage', ppct => 90, gm => 'per_attendee', gper => 9)));
  perform pg_temp.expect_ok('T-9c-regression-edit-2', pg_temp.run_as(v_o, pg_temp.sv(v_a, v_n)));

  v_after := concat_ws('#',
    (select md5(string_agg(t::text, '|' order by t.id)) from public.instructor_earnings t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_approval_snapshots t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_approval_snapshot_lines t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batch_payment_evidence t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_export_events t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_batches t where t.studio_id = v_a),
    (select md5(string_agg(t::text, '|' order by t.id)) from public.payroll_pay_periods t where t.studio_id = v_a));
  perform pg_temp.expect('T-9c-rule-edit-leaves-earnings-unchanged', split_part(v_before, '#', 1) = split_part(v_after, '#', 1));
  perform pg_temp.expect('T-9c-rule-edit-leaves-approval-snapshot-unchanged', split_part(v_before, '#', 2) = split_part(v_after, '#', 2));
  perform pg_temp.expect('T-9c-rule-edit-leaves-snapshot-lines-unchanged', split_part(v_before, '#', 3) = split_part(v_after, '#', 3));
  perform pg_temp.expect('T-9c-rule-edit-leaves-payment-evidence-unchanged', split_part(v_before, '#', 4) = split_part(v_after, '#', 4));
  perform pg_temp.expect('T-9c-rule-edit-leaves-export-evidence-unchanged', split_part(v_before, '#', 5) = split_part(v_after, '#', 5));
  perform pg_temp.expect('T-9c-rule-edit-leaves-batch-and-period-unchanged', split_part(v_before, '#', 6) = split_part(v_after, '#', 6)
    and split_part(v_before, '#', 7) = split_part(v_after, '#', 7));
  perform pg_temp.expect('T-9c-rule-edit-leaves-trusted-export-reader-unchanged',
    pg_temp.scalar_as(v_o, format('select md5((public.get_payroll_batch_export(%L, %L))::text)', v_a, v_batch)) = v_export_before);
  perform pg_temp.expect('T-9c-regression-edits-recorded-in-history', pg_temp.hist_count(v_n) = 10);
end $$;

-- ============================================================================
-- 9. SURFACE
-- ============================================================================

do $$
begin
  perform pg_temp.expect('T-9c-history-rls-enabled', (select relrowsecurity from pg_class where oid = 'public.instructor_compensation_rule_history'::regclass));
  perform pg_temp.expect('T-9c-history-no-write-policy', not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rule_history' and cmd <> 'SELECT'));
  perform pg_temp.expect('T-9c-history-no-write-grant',
    not has_table_privilege('authenticated', 'public.instructor_compensation_rule_history', 'INSERT')
    and not has_table_privilege('authenticated', 'public.instructor_compensation_rule_history', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.instructor_compensation_rule_history', 'DELETE')
    and not has_table_privilege('authenticated', 'public.instructor_compensation_rule_history', 'TRUNCATE'));
  perform pg_temp.expect('T-9c-history-immutability-triggers', (select count(*) from pg_trigger
    where tgrelid = 'public.instructor_compensation_rule_history'::regclass and not tgisinternal and tgenabled = 'O') = 2);
  perform pg_temp.expect('T-9c-rules-no-write-policy', not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules' and cmd <> 'SELECT')
    and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'instructor_compensation_rules' and cmd = 'SELECT'));
  perform pg_temp.expect('T-9c-rules-no-write-grant',
    not has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'INSERT')
    and not has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'DELETE')
    and has_table_privilege('authenticated', 'public.instructor_compensation_rules', 'SELECT'));
  perform pg_temp.expect('T-9c-save-rpc-security-definer', (select prosecdef from pg_proc where oid =
    'public.save_instructor_compensation_rule(uuid, uuid, text, numeric, numeric, boolean, numeric, numeric, numeric, text, numeric, numeric, numeric, text)'::regprocedure));
  perform pg_temp.expect('T-9c-history-guard-not-executable-by-api', not has_function_privilege('authenticated', 'public.prevent_compensation_rule_history_change()', 'execute'));
end $$;

select 'Phase 9C compensation history SQL suite: ALL CHECKS PASSED' as result, count(*) as checks, count(distinct label) as distinct_checks
from t9c_passes;

rollback;
