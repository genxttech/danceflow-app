-- Landmark 1A Slice 3 -- instructor linkage/capability backfill
-- remediation, live regression tests.
--
-- Proves, at the real Postgres level (not mocked), by running the exact
-- same target-state computation the forward migration uses (Tiers 2-4,
-- then capability, evaluated against the post-linkage target identity),
-- against disposable synthetic fixtures:
--   1. Tier 2 authoritative client_account_links linkage;
--   2. Tier 3 profile_user_id linkage;
--   3. Tier 4 unique same-studio email linkage;
--   4. a same-studio user_id conflict blocks automatic linking;
--   5. the same user linked as an instructor at a different studio is
--      never treated as a conflict;
--   6. an ambiguous duplicate-email pair at one studio links neither;
--   7. capability becomes eligible only after the target identity is
--      linked earlier in the SAME pass (the snapshot-timing fix);
--   8. a pure floor-space renter never becomes capable merely from
--      identity linkage;
--   9. an admin/front-desk-only membership never automatically becomes
--      capable;
--   10-11. exactly one account_linked / one capability_granted audit
--      row per actually-changed row, never more;
--   12. an already-fully-linked, non-eligible row emits zero events.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists, real data is untouched (the target-state computation
-- runs against real + synthetic rows together, but only synthetic rows
-- are asserted on, and the whole transaction never commits).
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-00001a3XXXXX.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001a300001', 'Slice3 Tier2 Studio', 't-landmark1a-s3-tier2'),
  ('00000000-0000-0000-0000-00001a300002', 'Slice3 Tier3 Studio', 't-landmark1a-s3-tier3'),
  ('00000000-0000-0000-0000-00001a300003', 'Slice3 Tier4 Studio', 't-landmark1a-s3-tier4'),
  ('00000000-0000-0000-0000-00001a300004', 'Slice3 Conflict Studio', 't-landmark1a-s3-conflict'),
  ('00000000-0000-0000-0000-00001a300005', 'Slice3 CrossStudio Existing', 't-landmark1a-s3-cross-existing'),
  ('00000000-0000-0000-0000-00001a300006', 'Slice3 CrossStudio New', 't-landmark1a-s3-cross-new'),
  ('00000000-0000-0000-0000-00001a300007', 'Slice3 Ambiguous Email Studio', 't-landmark1a-s3-ambiguous'),
  ('00000000-0000-0000-0000-00001a300008', 'Slice3 Capability Timing Studio', 't-landmark1a-s3-cap-timing'),
  ('00000000-0000-0000-0000-00001a300009', 'Slice3 Pure Renter Studio', 't-landmark1a-s3-renter'),
  ('00000000-0000-0000-0000-00001a30000a', 'Slice3 Admin Only Studio', 't-landmark1a-s3-admin-only'),
  ('00000000-0000-0000-0000-00001a30000b', 'Slice3 Unchanged Row Studio', 't-landmark1a-s3-unchanged');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001a300101', 't-landmark1a-s3-tier2user@example.test'),
  ('00000000-0000-0000-0000-00001a300102', 't-landmark1a-s3-tier3user@example.test'),
  ('00000000-0000-0000-0000-00001a300103', 't-landmark1a-s3-tier4user@example.test'),
  ('00000000-0000-0000-0000-00001a300104', 't-landmark1a-s3-conflictuser@example.test'),
  ('00000000-0000-0000-0000-00001a300105', 't-landmark1a-s3-crossstudiouser@example.test'),
  ('00000000-0000-0000-0000-00001a300106', 't-landmark1a-s3-ambiguoususer@example.test'),
  ('00000000-0000-0000-0000-00001a300107', 't-landmark1a-s3-captiminguser@example.test'),
  ('00000000-0000-0000-0000-00001a300108', 't-landmark1a-s3-renteruser@example.test'),
  ('00000000-0000-0000-0000-00001a300109', 't-landmark1a-s3-adminuser@example.test'),
  ('00000000-0000-0000-0000-00001a30010a', 't-landmark1a-s3-unchangeduser@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00001a300101', 't-landmark1a-s3-tier2user@example.test', 'Tier2 User'),
  ('00000000-0000-0000-0000-00001a300102', 't-landmark1a-s3-tier3user@example.test', 'Tier3 User'),
  ('00000000-0000-0000-0000-00001a300103', 't-landmark1a-s3-tier4user@example.test', 'Tier4 User'),
  ('00000000-0000-0000-0000-00001a300104', 't-landmark1a-s3-conflictuser@example.test', 'Conflict User'),
  ('00000000-0000-0000-0000-00001a300105', 't-landmark1a-s3-crossstudiouser@example.test', 'CrossStudio User'),
  ('00000000-0000-0000-0000-00001a300106', 't-landmark1a-s3-ambiguoususer@example.test', 'Ambiguous User'),
  ('00000000-0000-0000-0000-00001a300107', 't-landmark1a-s3-captiminguser@example.test', 'CapTiming User'),
  ('00000000-0000-0000-0000-00001a300108', 't-landmark1a-s3-renteruser@example.test', 'Renter User'),
  ('00000000-0000-0000-0000-00001a300109', 't-landmark1a-s3-adminuser@example.test', 'Admin User'),
  ('00000000-0000-0000-0000-00001a30010a', 't-landmark1a-s3-unchangeduser@example.test', 'Unchanged User');

-- --- Scenario 1: Tier 2 (client_account_links) ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a300201', '00000000-0000-0000-0000-00001a300001', 'T2', 'Instr', true, false);
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a300301', '00000000-0000-0000-0000-00001a300001', 'T2', 'Client', 'active', true, '00000000-0000-0000-0000-00001a300201');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a300401', '00000000-0000-0000-0000-00001a300001', '00000000-0000-0000-0000-00001a300301', '00000000-0000-0000-0000-00001a300101', 'linked', 'self', true);

-- --- Scenario 2: Tier 3 (profile_user_id) ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, profile_user_id) values
  ('00000000-0000-0000-0000-00001a300202', '00000000-0000-0000-0000-00001a300002', 'T3', 'Instr', true, false, '00000000-0000-0000-0000-00001a300102');

-- --- Scenario 3: Tier 4 (unique email) ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, email) values
  ('00000000-0000-0000-0000-00001a300203', '00000000-0000-0000-0000-00001a300003', 'T4', 'Instr', true, false, 'T-Landmark1A-S3-Tier4User@Example.test');

-- --- Scenario 4: same-studio conflict (Row4a already linked to U4; Row4b targets the same U4 via profile_user_id) ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, user_id) values
  ('00000000-0000-0000-0000-00001a300204', '00000000-0000-0000-0000-00001a300004', 'Conflict', 'Existing', true, false, '00000000-0000-0000-0000-00001a300104');
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, profile_user_id) values
  ('00000000-0000-0000-0000-00001a300205', '00000000-0000-0000-0000-00001a300004', 'Conflict', 'Attempt', true, false, '00000000-0000-0000-0000-00001a300104');

-- --- Scenario 5: cross-studio allowed (U5 already an instructor at studio E; a new row at studio F targets U5 too) ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, user_id) values
  ('00000000-0000-0000-0000-00001a300206', '00000000-0000-0000-0000-00001a300005', 'Cross', 'Existing', true, false, '00000000-0000-0000-0000-00001a300105');
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, profile_user_id) values
  ('00000000-0000-0000-0000-00001a300207', '00000000-0000-0000-0000-00001a300006', 'Cross', 'New', true, false, '00000000-0000-0000-0000-00001a300105');

-- --- Scenario 6: ambiguous duplicate email, same studio, neither should link ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, email) values
  ('00000000-0000-0000-0000-00001a300208', '00000000-0000-0000-0000-00001a300007', 'Ambig', 'One', true, false, 't-landmark1a-s3-ambiguoususer@example.test'),
  ('00000000-0000-0000-0000-00001a300209', '00000000-0000-0000-0000-00001a300007', 'Ambig', 'Two', true, false, 'T-LANDMARK1A-S3-AMBIGUOUSUSER@EXAMPLE.TEST');

-- --- Scenario 7: capability eligible only after same-pass linkage ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, profile_user_id) values
  ('00000000-0000-0000-0000-00001a30020a', '00000000-0000-0000-0000-00001a300008', 'CapTiming', 'Instr', true, false, '00000000-0000-0000-0000-00001a300107');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00001a300107', '00000000-0000-0000-0000-00001a300008', 'instructor', true);

-- --- Scenario 8: pure renter, linked via Tier 2, must never become capable ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a30020b', '00000000-0000-0000-0000-00001a300009', 'Renter', 'Instr', true, false);
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a300302', '00000000-0000-0000-0000-00001a300009', 'Renter', 'Client', 'active', true, '00000000-0000-0000-0000-00001a30020b');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a300402', '00000000-0000-0000-0000-00001a300009', '00000000-0000-0000-0000-00001a300302', '00000000-0000-0000-0000-00001a300108', 'linked', 'self', true);
-- Deliberately NO user_studio_roles row for this user at this studio -- a
-- pure renter relationship alone, with no explicit instructional grant.

-- --- Scenario 9: admin-only membership, must never automatically become capable ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, profile_user_id) values
  ('00000000-0000-0000-0000-00001a30020c', '00000000-0000-0000-0000-00001a30000a', 'AdminOnly', 'Instr', true, false, '00000000-0000-0000-0000-00001a300109');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00001a300109', '00000000-0000-0000-0000-00001a30000a', 'studio_admin', true);

-- --- Scenario 12: already fully linked, non-eligible -- must emit zero events ---
insert into public.instructors (id, studio_id, first_name, last_name, active, can_instruct, user_id) values
  ('00000000-0000-0000-0000-00001a30020d', '00000000-0000-0000-0000-00001a30000b', 'Unchanged', 'Instr', true, false, '00000000-0000-0000-0000-00001a30010a');

-- ============================================================================
-- Run the exact same target-state computation the forward migration uses
-- (copied verbatim from 20260918010000_landmark1a_instructor_backfill_remediation.sql,
-- minus the migration_support snapshot -- that mechanism is proven
-- separately by the real DEV forward/rollback/re-forward cycle, not here).
-- ============================================================================

create temp table slice3_test_target_state (
  instructor_id uuid primary key,
  studio_id uuid not null,
  original_user_id uuid,
  target_user_id uuid,
  identity_matched_via text,
  original_can_instruct boolean not null,
  target_can_instruct boolean not null,
  needs_account_link_audit boolean not null default false,
  needs_capability_audit boolean not null default false
) on commit drop;

insert into slice3_test_target_state (
  instructor_id, studio_id, original_user_id, target_user_id,
  original_can_instruct, target_can_instruct
)
select id, studio_id, user_id, user_id, can_instruct, can_instruct
from public.instructors;

with tier2_pairs as (
  select distinct
    c.linked_instructor_id as instructor_id,
    c.studio_id,
    cal.user_id as candidate_user_id
  from public.clients c
  join public.client_account_links cal
    on cal.client_id = c.id and cal.studio_id = c.studio_id and cal.status = 'linked'
  where c.linked_instructor_id is not null
),
tier2_counts as (
  select instructor_id, count(*) as candidate_count
  from tier2_pairs
  group by instructor_id
),
tier2_unambiguous as (
  select p.instructor_id, p.studio_id, p.candidate_user_id
  from tier2_pairs p
  join tier2_counts c on c.instructor_id = p.instructor_id and c.candidate_count = 1
)
update slice3_test_target_state t
set target_user_id = m.candidate_user_id, identity_matched_via = 'client_account_links'
from tier2_unambiguous m
where t.instructor_id = m.instructor_id
  and t.studio_id = m.studio_id
  and t.target_user_id is null
  and not exists (select 1 from public.instructors i2 where i2.studio_id = t.studio_id and i2.user_id = m.candidate_user_id and i2.id <> t.instructor_id)
  and not exists (select 1 from slice3_test_target_state t2 where t2.studio_id = t.studio_id and t2.target_user_id = m.candidate_user_id and t2.instructor_id <> t.instructor_id);

update slice3_test_target_state t
set target_user_id = i.profile_user_id, identity_matched_via = 'profile_user_id'
from public.instructors i
where t.instructor_id = i.id
  and t.target_user_id is null
  and i.profile_user_id is not null
  and not exists (select 1 from public.instructors i2 where i2.studio_id = t.studio_id and i2.user_id = i.profile_user_id and i2.id <> t.instructor_id)
  and not exists (select 1 from slice3_test_target_state t2 where t2.studio_id = t.studio_id and t2.target_user_id = i.profile_user_id and t2.instructor_id <> t.instructor_id);

with tier4_email_groups as (
  select studio_id, lower(trim(email)) as norm_email, count(*) as unlinked_group_size
  from public.instructors
  where email is not null and trim(email) <> '' and user_id is null
  group by studio_id, lower(trim(email))
)
update slice3_test_target_state t
set target_user_id = p.id, identity_matched_via = 'email'
from public.instructors i
join tier4_email_groups g on g.studio_id = i.studio_id and g.norm_email = lower(trim(i.email))
join public.profiles p on lower(trim(p.email)) = lower(trim(i.email))
where t.instructor_id = i.id
  and t.target_user_id is null
  and i.email is not null and trim(i.email) <> ''
  and g.unlinked_group_size = 1
  and not exists (select 1 from public.instructors i2 where i2.studio_id = t.studio_id and i2.user_id = p.id and i2.id <> t.instructor_id)
  and not exists (select 1 from slice3_test_target_state t2 where t2.studio_id = t.studio_id and t2.target_user_id = p.id and t2.instructor_id <> t.instructor_id);

update slice3_test_target_state t
set target_can_instruct = true
from public.user_studio_roles usr
where usr.user_id = t.target_user_id
  and usr.studio_id = t.studio_id
  and usr.active = true
  and usr.role = 'instructor'
  and t.target_user_id is not null
  and t.target_can_instruct = false;

update slice3_test_target_state
set needs_account_link_audit = (target_user_id is distinct from original_user_id),
    needs_capability_audit = (target_can_instruct is distinct from original_can_instruct);

update public.instructors i
set user_id = t.target_user_id, can_instruct = t.target_can_instruct
from slice3_test_target_state t
where i.id = t.instructor_id
  and (t.needs_account_link_audit or t.needs_capability_audit);

insert into public.instructor_audit_events (studio_id, instructor_id, actor_user_id, event_type, before_value, after_value, metadata)
select t.studio_id, t.instructor_id, null, 'account_linked',
  jsonb_build_object('user_id', t.original_user_id), jsonb_build_object('user_id', t.target_user_id),
  jsonb_build_object('source', 'slice3_backfill_migration', 'matched_via', t.identity_matched_via)
from slice3_test_target_state t where t.needs_account_link_audit;

insert into public.instructor_audit_events (studio_id, instructor_id, actor_user_id, event_type, before_value, after_value, metadata)
select t.studio_id, t.instructor_id, null, 'capability_granted',
  jsonb_build_object('can_instruct', t.original_can_instruct), jsonb_build_object('can_instruct', t.target_can_instruct),
  jsonb_build_object('source', 'slice3_backfill_migration', 'matched_via', 'instructor_role_membership')
from slice3_test_target_state t where t.needs_capability_audit;

-- ============================================================================
-- Assertions
-- ============================================================================

do $$
declare
  v_user_id uuid;
  v_can_instruct boolean;
  v_audit_count int;
begin
  select user_id, can_instruct into v_user_id, v_can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a300201';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300101'::uuid then
    raise exception 'FAIL T-landmark1a-s3-1: Tier 2 did not link, got user_id=%', v_user_id;
  end if;
  select count(*) into v_audit_count from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a300201' and event_type = 'account_linked';
  if v_audit_count <> 1 then
    raise exception 'FAIL T-landmark1a-s3-1: expected exactly 1 account_linked audit row, got %', v_audit_count;
  end if;
  raise notice 'PASS T-landmark1a-s3-1: Tier 2 client_account_links linkage works, exactly 1 audit row';
end $$;

do $$
declare v_user_id uuid;
begin
  select user_id into v_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300202';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300102'::uuid then
    raise exception 'FAIL T-landmark1a-s3-2: Tier 3 did not link, got user_id=%', v_user_id;
  end if;
  raise notice 'PASS T-landmark1a-s3-2: Tier 3 profile_user_id linkage works';
end $$;

do $$
declare v_user_id uuid;
begin
  select user_id into v_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300203';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300103'::uuid then
    raise exception 'FAIL T-landmark1a-s3-3: Tier 4 did not link (or normalization failed), got user_id=%', v_user_id;
  end if;
  raise notice 'PASS T-landmark1a-s3-3: Tier 4 unique normalized-email linkage works';
end $$;

do $$
declare v_existing_user_id uuid; v_attempt_user_id uuid;
begin
  select user_id into v_existing_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300204';
  select user_id into v_attempt_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300205';
  if v_existing_user_id is distinct from '00000000-0000-0000-0000-00001a300104'::uuid then
    raise exception 'FAIL T-landmark1a-s3-4: pre-existing link must never be touched, got %', v_existing_user_id;
  end if;
  if v_attempt_user_id is not null then
    raise exception 'FAIL T-landmark1a-s3-4: same-studio conflicting target must remain unresolved, got %', v_attempt_user_id;
  end if;
  raise notice 'PASS T-landmark1a-s3-4: same-studio user_id conflict correctly blocks automatic linking';
end $$;

do $$
declare v_existing_user_id uuid; v_new_user_id uuid;
begin
  select user_id into v_existing_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300206';
  select user_id into v_new_user_id from public.instructors where id = '00000000-0000-0000-0000-00001a300207';
  if v_existing_user_id is distinct from '00000000-0000-0000-0000-00001a300105'::uuid then
    raise exception 'FAIL T-landmark1a-s3-5: existing cross-studio link must remain unchanged, got %', v_existing_user_id;
  end if;
  if v_new_user_id is distinct from '00000000-0000-0000-0000-00001a300105'::uuid then
    raise exception 'FAIL T-landmark1a-s3-5: same user linked at a different studio must be allowed, got %', v_new_user_id;
  end if;
  raise notice 'PASS T-landmark1a-s3-5: same user teaching at multiple studios is correctly allowed, not treated as a conflict';
end $$;

do $$
declare v_one uuid; v_two uuid;
begin
  select user_id into v_one from public.instructors where id = '00000000-0000-0000-0000-00001a300208';
  select user_id into v_two from public.instructors where id = '00000000-0000-0000-0000-00001a300209';
  if v_one is not null or v_two is not null then
    raise exception 'FAIL T-landmark1a-s3-6: ambiguous duplicate email at one studio must link neither row, got %/%', v_one, v_two;
  end if;
  raise notice 'PASS T-landmark1a-s3-6: ambiguous duplicate-email pair correctly left unresolved for both rows';
end $$;

do $$
declare v_user_id uuid; v_can_instruct boolean; v_link_audit int; v_cap_audit int;
begin
  select user_id, can_instruct into v_user_id, v_can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a30020a';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300107'::uuid then
    raise exception 'FAIL T-landmark1a-s3-7: identity must link in this pass, got user_id=%', v_user_id;
  end if;
  if v_can_instruct is distinct from true then
    raise exception 'FAIL T-landmark1a-s3-7: capability must become eligible using the POST-linkage target identity in the same pass, got can_instruct=%', v_can_instruct;
  end if;
  select count(*) into v_link_audit from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a30020a' and event_type = 'account_linked';
  select count(*) into v_cap_audit from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a30020a' and event_type = 'capability_granted';
  if v_link_audit <> 1 or v_cap_audit <> 1 then
    raise exception 'FAIL T-landmark1a-s3-7: expected exactly 1 account_linked and 1 capability_granted, got %/%', v_link_audit, v_cap_audit;
  end if;
  raise notice 'PASS T-landmark1a-s3-7: capability correctly evaluated against the same-pass post-linkage identity; exactly 1 audit row of each type';
end $$;

do $$
declare v_user_id uuid; v_can_instruct boolean;
begin
  select user_id, can_instruct into v_user_id, v_can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a30020b';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300108'::uuid then
    raise exception 'FAIL T-landmark1a-s3-8: renter identity should still link via Tier 2, got user_id=%', v_user_id;
  end if;
  if v_can_instruct is distinct from false then
    raise exception 'FAIL T-landmark1a-s3-8: pure renter must never become capable merely from identity linkage, got can_instruct=%', v_can_instruct;
  end if;
  raise notice 'PASS T-landmark1a-s3-8: pure renter links identity but never becomes capable';
end $$;

do $$
declare v_user_id uuid; v_can_instruct boolean;
begin
  select user_id, can_instruct into v_user_id, v_can_instruct from public.instructors where id = '00000000-0000-0000-0000-00001a30020c';
  if v_user_id is distinct from '00000000-0000-0000-0000-00001a300109'::uuid then
    raise exception 'FAIL T-landmark1a-s3-9: identity should still link via Tier 3, got user_id=%', v_user_id;
  end if;
  if v_can_instruct is distinct from false then
    raise exception 'FAIL T-landmark1a-s3-9: admin-only membership must never automatically become capable, got can_instruct=%', v_can_instruct;
  end if;
  raise notice 'PASS T-landmark1a-s3-9: admin/front-desk-only membership never automatically grants capability';
end $$;

do $$
declare v_event_count int;
begin
  select count(*) into v_event_count from public.instructor_audit_events where instructor_id = '00000000-0000-0000-0000-00001a30020d';
  if v_event_count <> 0 then
    raise exception 'FAIL T-landmark1a-s3-12: an already-fully-linked, non-eligible row must emit zero events, got %', v_event_count;
  end if;
  raise notice 'PASS T-landmark1a-s3-12: unchanged row emits zero audit events';
end $$;

rollback;
