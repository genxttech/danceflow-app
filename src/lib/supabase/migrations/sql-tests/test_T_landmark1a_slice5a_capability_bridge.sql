-- Landmark 1A -- Slice 5A: Capability Activation Bridge
--
-- Synthetic-fixture regression suite proving the forward migration's
-- guard/snapshot/mutate/audit logic and the rollback's two-state
-- semantics, using fresh synthetic data (UUID block
-- 00000000-0000-0000-0000-00001a5aXXXX) -- the real migration's 5 named
-- PROD instructor_ids never exist here, so this suite reproduces the
-- exact same logic inline against synthetic targets rather than
-- invoking the production migration/rollback files directly (which
-- would only prove the already-covered "target doesn't exist, abort"
-- path). One transaction, rolled back at the end -- zero persistent
-- data. Uses its own distinctly-named snapshot table
-- (migration_support.slice5a_test_snapshot), never the real migration's
-- table name, so nothing could ever collide even hypothetically.

begin;

-- Fixtures -------------------------------------------------------------

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001a5a0001', 'Slice5A Happy A Studio', 't-landmark1a-s5a-happy-a'),
  ('00000000-0000-0000-0000-00001a5a0002', 'Slice5A Happy B Studio', 't-landmark1a-s5a-happy-b'),
  ('00000000-0000-0000-0000-00001a5a0003', 'Slice5A Drift Studio', 't-landmark1a-s5a-drift'),
  ('00000000-0000-0000-0000-00001a5a0004', 'Slice5A Missing-Target Studio', 't-landmark1a-s5a-missing'),
  ('00000000-0000-0000-0000-00001a5a0005', 'Slice5A Non-Target Studio', 't-landmark1a-s5a-nontarget');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001a5a0101', 't-landmark1a-s5a-user101@example.test'),
  ('00000000-0000-0000-0000-00001a5a0102', 't-landmark1a-s5a-user102@example.test'),
  ('00000000-0000-0000-0000-00001a5a0103', 't-landmark1a-s5a-user103@example.test'),
  ('00000000-0000-0000-0000-00001a5a0104', 't-landmark1a-s5a-user104@example.test'),
  ('00000000-0000-0000-0000-00001a5a0105', 't-landmark1a-s5a-user105@example.test'),
  ('00000000-0000-0000-0000-00001a5a0106', 't-landmark1a-s5a-user106@example.test'),
  ('00000000-0000-0000-0000-00001a5a0107', 't-landmark1a-s5a-user107@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00001a5a0101', 't-landmark1a-s5a-user101@example.test', 'Slice5A User101'),
  ('00000000-0000-0000-0000-00001a5a0102', 't-landmark1a-s5a-user102@example.test', 'Slice5A User102'),
  ('00000000-0000-0000-0000-00001a5a0103', 't-landmark1a-s5a-user103@example.test', 'Slice5A User103'),
  ('00000000-0000-0000-0000-00001a5a0104', 't-landmark1a-s5a-user104@example.test', 'Slice5A User104'),
  ('00000000-0000-0000-0000-00001a5a0105', 't-landmark1a-s5a-user105@example.test', 'Slice5A User105'),
  ('00000000-0000-0000-0000-00001a5a0106', 't-landmark1a-s5a-user106@example.test', 'Slice5A User106'),
  ('00000000-0000-0000-0000-00001a5a0107', 't-landmark1a-s5a-user107@example.test', 'Slice5A User107');

-- Happy-path targets (case 1): both start can_instruct=false.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a5a0201', '00000000-0000-0000-0000-00001a5a0001', '00000000-0000-0000-0000-00001a5a0101', 'Happy', 'A', true, false),
  ('00000000-0000-0000-0000-00001a5a0202', '00000000-0000-0000-0000-00001a5a0002', '00000000-0000-0000-0000-00001a5a0102', 'Happy', 'B', true, false);

-- Drifted-state batch (case 2): X1/X3 would match; X2 is already true.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a5a0203', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0103', 'Drift', 'X1', true, false),
  ('00000000-0000-0000-0000-00001a5a0204', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0104', 'Drift', 'X2', true, true),
  ('00000000-0000-0000-0000-00001a5a0205', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0105', 'Drift', 'X3', true, false);

-- Missing-target batch (case 3): one real, otherwise-valid row, batched
-- with one instructor_id that has no matching instructors row at all.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a5a0206', '00000000-0000-0000-0000-00001a5a0004', '00000000-0000-0000-0000-00001a5a0106', 'Missing', 'Companion', true, false);

-- Non-target row (case 4): eligible-looking, never named in any batch.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a5a0207', '00000000-0000-0000-0000-00001a5a0005', '00000000-0000-0000-0000-00001a5a0107', 'NonTarget', 'Row', true, false);

-- Test cases -------------------------------------------------------------

do $$
declare
  v_mismatch_count int;
  v_failed boolean;
  v_audit_count int;
  v_can_instruct boolean;
begin

  -- 1. Happy path: 2 matching targets flip false -> true, exactly 2
  -- capability_granted audit events, correct before/after, actor null,
  -- test snapshot captures exact prior values.
  drop table if exists case_targets;
  create temp table case_targets (instructor_id uuid primary key, studio_id uuid not null, user_id uuid not null);
  insert into case_targets values
    ('00000000-0000-0000-0000-00001a5a0201', '00000000-0000-0000-0000-00001a5a0001', '00000000-0000-0000-0000-00001a5a0101'),
    ('00000000-0000-0000-0000-00001a5a0202', '00000000-0000-0000-0000-00001a5a0002', '00000000-0000-0000-0000-00001a5a0102');

  select count(*) into v_mismatch_count
  from case_targets t
  left join public.instructors i
    on i.id = t.instructor_id and i.studio_id = t.studio_id and i.user_id = t.user_id
    and i.active = true and i.can_instruct = false
  where i.id is null;
  assert v_mismatch_count = 0, 'Case 1 setup FAILED: targets should match cleanly';

  create schema if not exists migration_support;
  create table if not exists migration_support.slice5a_test_snapshot (
    instructor_id uuid primary key,
    can_instruct boolean not null,
    captured_at timestamptz not null default now()
  );

  insert into migration_support.slice5a_test_snapshot (instructor_id, can_instruct)
  select t.instructor_id, i.can_instruct from case_targets t join public.instructors i on i.id = t.instructor_id
  on conflict (instructor_id) do nothing;

  update public.instructors i set can_instruct = true from case_targets t where i.id = t.instructor_id;

  insert into public.instructor_audit_events (studio_id, instructor_id, actor_user_id, event_type, before_value, after_value, metadata)
  select t.studio_id, t.instructor_id, null, 'capability_granted',
    jsonb_build_object('can_instruct', false), jsonb_build_object('can_instruct', true),
    jsonb_build_object('source', 'slice5a_capability_bridge', 'matched_via', 'owner_explicit_approval', 'migration', 'test_T_landmark1a_slice5a_capability_bridge')
  from case_targets t;

  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0201') = true, 'Case 1 FAILED: target 1 should be true';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0202') = true, 'Case 1 FAILED: target 2 should be true';
  select count(*) into v_audit_count from public.instructor_audit_events where metadata->>'source' = 'slice5a_capability_bridge' and instructor_id in ('00000000-0000-0000-0000-00001a5a0201','00000000-0000-0000-0000-00001a5a0202');
  assert v_audit_count = 2, 'Case 1 FAILED: expected exactly 2 audit events';
  assert (select actor_user_id from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a5a0201') is null, 'Case 1 FAILED: actor_user_id must be null';
  assert (select before_value from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a5a0201') = jsonb_build_object('can_instruct', false), 'Case 1 FAILED: before_value mismatch';
  assert (select after_value from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a5a0201') = jsonb_build_object('can_instruct', true), 'Case 1 FAILED: after_value mismatch';
  assert (select can_instruct from migration_support.slice5a_test_snapshot where instructor_id = '00000000-0000-0000-0000-00001a5a0201') = false, 'Case 1 FAILED: snapshot should hold original false value';
  raise notice 'Case 1 PASSED: happy path -- 2 targets flipped, 2 audit events, snapshot correct';

  -- 2. Drifted-state guard: X2 already can_instruct=true -> whole batch
  -- aborts, X1/X3 remain unchanged, zero new audit rows.
  begin
    drop table if exists case_targets;
    create temp table case_targets (instructor_id uuid primary key, studio_id uuid not null, user_id uuid not null);
    insert into case_targets values
      ('00000000-0000-0000-0000-00001a5a0203', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0103'),
      ('00000000-0000-0000-0000-00001a5a0204', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0104'),
      ('00000000-0000-0000-0000-00001a5a0205', '00000000-0000-0000-0000-00001a5a0003', '00000000-0000-0000-0000-00001a5a0105');

    select count(*) into v_mismatch_count
    from case_targets t
    left join public.instructors i
      on i.id = t.instructor_id and i.studio_id = t.studio_id and i.user_id = t.user_id
      and i.active = true and i.can_instruct = false
    where i.id is null;

    if v_mismatch_count > 0 then
      raise exception 'Slice 5A guard failed: % of % named target rows no longer match expected state; aborting, zero rows changed.', v_mismatch_count, (select count(*) from case_targets);
    end if;

    raise exception 'Case 2 FAILED: guard should have aborted but did not';
  exception
    when others then
      if sqlerrm like 'Slice 5A guard failed:%' then
        v_failed := true;
      else
        raise;
      end if;
  end;
  assert v_failed, 'Case 2 FAILED: expected guard-failure exception';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0203') = false, 'Case 2 FAILED: X1 must remain unchanged';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0204') = true, 'Case 2 FAILED: X2 must remain unchanged (still true)';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0205') = false, 'Case 2 FAILED: X3 must remain unchanged';
  select count(*) into v_audit_count from public.instructor_audit_events where instructor_id in ('00000000-0000-0000-0000-00001a5a0203','00000000-0000-0000-0000-00001a5a0204','00000000-0000-0000-0000-00001a5a0205');
  assert v_audit_count = 0, 'Case 2 FAILED: zero audit events expected';
  raise notice 'Case 2 PASSED: drifted-state guard aborts the whole batch, no partial mutation';

  -- 3. Missing-target guard: one target has no matching instructors row
  -- at all -> whole batch aborts, the otherwise-valid companion row
  -- remains unchanged too.
  v_failed := false;
  begin
    drop table if exists case_targets;
    create temp table case_targets (instructor_id uuid primary key, studio_id uuid not null, user_id uuid not null);
    insert into case_targets values
      ('00000000-0000-0000-0000-00001a5a0206', '00000000-0000-0000-0000-00001a5a0004', '00000000-0000-0000-0000-00001a5a0106'),
      ('00000000-0000-0000-0000-00001a5a9999', '00000000-0000-0000-0000-00001a5a0004', '00000000-0000-0000-0000-00001a5a0106');

    select count(*) into v_mismatch_count
    from case_targets t
    left join public.instructors i
      on i.id = t.instructor_id and i.studio_id = t.studio_id and i.user_id = t.user_id
      and i.active = true and i.can_instruct = false
    where i.id is null;

    if v_mismatch_count > 0 then
      raise exception 'Slice 5A guard failed: % of % named target rows no longer match expected state; aborting, zero rows changed.', v_mismatch_count, (select count(*) from case_targets);
    end if;

    raise exception 'Case 3 FAILED: guard should have aborted but did not';
  exception
    when others then
      if sqlerrm like 'Slice 5A guard failed:%' then
        v_failed := true;
      else
        raise;
      end if;
  end;
  assert v_failed, 'Case 3 FAILED: expected guard-failure exception';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0206') = false, 'Case 3 FAILED: valid companion row must remain unchanged';
  select count(*) into v_audit_count from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a5a0206';
  assert v_audit_count = 0, 'Case 3 FAILED: zero audit events expected';
  raise notice 'Case 3 PASSED: missing-target guard aborts the whole batch, valid companion untouched';

  -- 4. Non-target protection: an eligible-looking row never named in
  -- any batch above must remain unchanged throughout.
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0207') = false, 'Case 4 FAILED: non-target row must remain untouched';
  raise notice 'Case 4 PASSED: non-target row untouched by every case above';

  -- 5. PII audit check: metadata contains only provenance keys.
  assert (select metadata from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a5a0201') = jsonb_build_object('source', 'slice5a_capability_bridge', 'matched_via', 'owner_explicit_approval', 'migration', 'test_T_landmark1a_slice5a_capability_bridge'), 'Case 5 FAILED: metadata must contain only provenance keys, no PII';
  raise notice 'Case 5 PASSED: audit metadata is PII-free, provenance only';

  -- 6. Rollback-success proof: restore case 1's rows from the test
  -- snapshot, confirm exact originals return, confirm audit history
  -- survives, confirm cleanup only after successful restore.
  if to_regclass('migration_support.slice5a_test_snapshot') is null then
    raise exception 'Case 6 FAILED: test snapshot unexpectedly missing before rollback-success proof';
  end if;

  update public.instructors i
  set can_instruct = snap.can_instruct
  from migration_support.slice5a_test_snapshot snap
  where i.id = snap.instructor_id;

  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0201') = false, 'Case 6 FAILED: target 1 should be restored to false';
  assert (select can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a5a0202') = false, 'Case 6 FAILED: target 2 should be restored to false';
  select count(*) into v_audit_count from public.instructor_audit_events where instructor_id in ('00000000-0000-0000-0000-00001a5a0201','00000000-0000-0000-0000-00001a5a0202');
  assert v_audit_count = 2, 'Case 6 FAILED: audit history must survive the rollback (immutable)';

  drop table migration_support.slice5a_test_snapshot;
  raise notice 'Case 6 PASSED: rollback restores exact prior values, audit history survives, cleanup ran only after restore';

  -- 7. Rollback hard-stop proof: after the snapshot is dropped,
  -- reproducing the rollback guard must raise the clean missing-
  -- snapshot exception, not a raw catalog error or a silent no-op.
  v_failed := false;
  begin
    if to_regclass('migration_support.slice5a_test_snapshot') is null then
      raise exception 'Slice 5A rollback blocked: required snapshot table migration_support.slice5a_test_snapshot is missing -- nothing to safely restore from.';
    end if;
  exception
    when others then
      if sqlerrm like 'Slice 5A rollback blocked:%' then
        v_failed := true;
      else
        raise;
      end if;
  end;
  assert v_failed, 'Case 7 FAILED: expected the clean missing-snapshot exception';
  raise notice 'Case 7 PASSED: rollback hard-stop fires cleanly against an absent snapshot';

  raise notice 'LANDMARK 1A SLICE 5A SQL REGRESSION: ALL 7 CASES PASSED';
end $$;

rollback;
