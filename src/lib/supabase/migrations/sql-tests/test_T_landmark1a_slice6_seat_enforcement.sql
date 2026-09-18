-- Landmark 1A -- Slice 6: Instructor Seat Enforcement, Capability Grant,
-- Reactivation, and Hybrid Promotion -- live regression suite.
--
-- Exercises the real RPCs (grant_instructor_capability,
-- reactivate_instructor, promote_hybrid_instructor) and the real
-- _landmark1a_resolve_studio_seat_limit helper against disposable
-- synthetic fixtures, simulating authenticated callers via
-- `set local role authenticated` + `set_config('request.jwt.claims', ...)`
-- (this codebase's own established pattern, e.g.
-- test_T_landmark1a_slice2_instructor_linkage.sql). One transaction,
-- rolled back at the end -- nothing persists.
--
-- Deterministic UUID block reserved for this harness:
--   Studio row:            00000000-0000-0000-0000-00001a6{SS}000
--   Entity within studio:  00000000-0000-0000-0000-00001a6{SS}{yyy}
-- where SS is a 2-hex studio index (01-13) and yyy is a 3-hex
-- within-studio sequence. Instructor rows are offset +0x100 from their
-- paired user for easy visual association (e.g. user ...009003 pairs
-- with instructor ...009103).

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001a601000', 'Slice6 Starter Studio', 't-landmark1a-s6-starter'),
  ('00000000-0000-0000-0000-00001a602000', 'Slice6 Growth Bulk Studio', 't-landmark1a-s6-growth-bulk'),
  ('00000000-0000-0000-0000-00001a603000', 'Slice6 Pro Bulk Studio', 't-landmark1a-s6-pro-bulk'),
  ('00000000-0000-0000-0000-00001a604000', 'Slice6 Trialing Studio', 't-landmark1a-s6-trialing'),
  ('00000000-0000-0000-0000-00001a605000', 'Slice6 PastDue Studio', 't-landmark1a-s6-pastdue'),
  ('00000000-0000-0000-0000-00001a606000', 'Slice6 Cancelled Studio', 't-landmark1a-s6-cancelled'),
  ('00000000-0000-0000-0000-00001a607000', 'Slice6 Inactive Studio', 't-landmark1a-s6-inactive'),
  ('00000000-0000-0000-0000-00001a608000', 'Slice6 Organizer Studio', 't-landmark1a-s6-organizer'),
  ('00000000-0000-0000-0000-00001a609000', 'Slice6 Renter Guard Studio', 't-landmark1a-s6-renter'),
  ('00000000-0000-0000-0000-00001a60a000', 'Slice6 CrossStudio A (Renter)', 't-landmark1a-s6-cross-a'),
  ('00000000-0000-0000-0000-00001a60b000', 'Slice6 CrossStudio B (Instructor)', 't-landmark1a-s6-cross-b'),
  ('00000000-0000-0000-0000-00001a60c000', 'Slice6 Reactivation Blocks Studio', 't-landmark1a-s6-react-blocks'),
  ('00000000-0000-0000-0000-00001a60d000', 'Slice6 Reactivation Succeeds Studio', 't-landmark1a-s6-react-ok'),
  ('00000000-0000-0000-0000-00001a60e000', 'Slice6 Admin FrontDesk Studio', 't-landmark1a-s6-adminfd'),
  ('00000000-0000-0000-0000-00001a60f000', 'Slice6 Hybrid Missing Attestation', 't-landmark1a-s6-hy-noattest'),
  ('00000000-0000-0000-0000-00001a610000', 'Slice6 Hybrid Bad Classification', 't-landmark1a-s6-hy-badclass'),
  ('00000000-0000-0000-0000-00001a611000', 'Slice6 Hybrid Employee', 't-landmark1a-s6-hy-employee'),
  ('00000000-0000-0000-0000-00001a612000', 'Slice6 Hybrid Contractor Existing Payroll', 't-landmark1a-s6-hy-existing'),
  ('00000000-0000-0000-0000-00001a613000', 'Slice6 Hybrid Seat Limit Fail', 't-landmark1a-s6-hy-seatfail');

-- Tiers: sA/sM/sR/sL1 = starter (limit 1); sB/sD/sE/sF/sG/sJ/sK*/sL2/sN/sO/sP/sQ = growth (limit 5);
-- sC = pro (limit 15). sA/sM/sR/sL1/sJ/sK*/sN/sO/sP/sQ use billing_override_enabled.
update public.studios set billing_plan = 'starter', billing_override_enabled = true
  where id in ('00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a60e000',
               '00000000-0000-0000-0000-00001a60c000', '00000000-0000-0000-0000-00001a613000');
update public.studios set billing_plan = 'growth', billing_override_enabled = true
  where id in ('00000000-0000-0000-0000-00001a602000', '00000000-0000-0000-0000-00001a609000',
               '00000000-0000-0000-0000-00001a60a000', '00000000-0000-0000-0000-00001a60b000',
               '00000000-0000-0000-0000-00001a60d000', '00000000-0000-0000-0000-00001a60f000',
               '00000000-0000-0000-0000-00001a610000', '00000000-0000-0000-0000-00001a611000',
               '00000000-0000-0000-0000-00001a612000');
-- sC (pro) uses a real studio_subscriptions/subscription_plans join, not override.
update public.studios set billing_plan = 'pro', subscription_status = 'active'
  where id = '00000000-0000-0000-0000-00001a603000';
insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
  select '00000000-0000-0000-0000-00001a603000', id, 'active' from public.subscription_plans where code = 'pro';

-- sD: trialing, real subscription row, plan=growth.
update public.studios set billing_plan = 'growth', subscription_status = 'trialing'
  where id = '00000000-0000-0000-0000-00001a604000';
insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
  select '00000000-0000-0000-0000-00001a604000', id, 'trialing' from public.subscription_plans where code = 'growth';

-- sE/sF: past_due / cancelled, real subscription rows, plan=growth -- must
-- resolve to 0 new-grant allowance despite a real, otherwise-valid tier.
update public.studios set billing_plan = 'growth', subscription_status = 'past_due'
  where id = '00000000-0000-0000-0000-00001a605000';
insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
  select '00000000-0000-0000-0000-00001a605000', id, 'past_due' from public.subscription_plans where code = 'growth';

update public.studios set billing_plan = 'growth', subscription_status = 'cancelled'
  where id = '00000000-0000-0000-0000-00001a606000';
insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
  select '00000000-0000-0000-0000-00001a606000', id, 'cancelled' from public.subscription_plans where code = 'growth';

-- sG: inactive, NO subscription row at all -- exercises the fallback
-- (studios-column-only) branch, must also resolve to 0.
update public.studios set billing_plan = 'growth', subscription_status = 'inactive'
  where id = '00000000-0000-0000-0000-00001a607000';

-- sH: organizer plan code, status='active' (proves plan-code-driven
-- blocking is distinct from status-driven blocking -- status alone would
-- pass, but 'organizer' has no seat number and must resolve to 0).
update public.studios set billing_plan = 'organizer', subscription_status = 'active'
  where id = '00000000-0000-0000-0000-00001a608000';

-- --- Users/profiles -----------------------------------------------------

insert into auth.users (id, email)
select uid, 't-landmark1a-s6-' || uid::text || '@example.test' from (values
  -- sA (starter)
  ('00000000-0000-0000-0000-00001a601001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a601002'::uuid), -- owner
  ('00000000-0000-0000-0000-00001a601003'::uuid), -- instr1
  ('00000000-0000-0000-0000-00001a601004'::uuid), -- instr2
  -- sM (admin/front-desk)
  ('00000000-0000-0000-0000-00001a60e001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a60e002'::uuid), -- front_desk, no instructor row
  ('00000000-0000-0000-0000-00001a60e003'::uuid), -- front_desk, WITH capable instructor row
  ('00000000-0000-0000-0000-00001a60e004'::uuid), -- separate regular instructor, should be blocked
  -- sD trialing
  ('00000000-0000-0000-0000-00001a604001'::uuid), ('00000000-0000-0000-0000-00001a604002'::uuid),
  -- sE past_due
  ('00000000-0000-0000-0000-00001a605001'::uuid), ('00000000-0000-0000-0000-00001a605002'::uuid),
  -- sF cancelled
  ('00000000-0000-0000-0000-00001a606001'::uuid), ('00000000-0000-0000-0000-00001a606002'::uuid),
  -- sG inactive
  ('00000000-0000-0000-0000-00001a607001'::uuid), ('00000000-0000-0000-0000-00001a607002'::uuid),
  -- sH organizer
  ('00000000-0000-0000-0000-00001a608001'::uuid), ('00000000-0000-0000-0000-00001a608002'::uuid),
  -- sJ renter guard
  ('00000000-0000-0000-0000-00001a609001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a609002'::uuid), -- renter
  -- sK cross-studio (same person, renter at A, instructor at B)
  ('00000000-0000-0000-0000-00001a60a001'::uuid), -- staff_admin at A
  ('00000000-0000-0000-0000-00001a60b001'::uuid), -- staff_admin at B
  ('00000000-0000-0000-0000-00001a60a002'::uuid), -- shared person
  -- sL1 reactivation blocks
  ('00000000-0000-0000-0000-00001a60c001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a60c002'::uuid), -- already-capable-active instructor filling the 1 seat
  ('00000000-0000-0000-0000-00001a60c003'::uuid), -- inactive+capable instructor to reactivate (should block)
  -- sL2 reactivation succeeds
  ('00000000-0000-0000-0000-00001a60d001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a60d002'::uuid), -- inactive+capable instructor to reactivate (should succeed)
  ('00000000-0000-0000-0000-00001a60d003'::uuid), -- inactive+incapable instructor to reactivate (no seat check)
  -- sN hybrid missing attestation
  ('00000000-0000-0000-0000-00001a60f001'::uuid), ('00000000-0000-0000-0000-00001a60f002'::uuid),
  -- sO hybrid bad classification
  ('00000000-0000-0000-0000-00001a610001'::uuid), ('00000000-0000-0000-0000-00001a610002'::uuid),
  -- sP hybrid employee (fresh Tier-5 create)
  ('00000000-0000-0000-0000-00001a611001'::uuid), ('00000000-0000-0000-0000-00001a611002'::uuid),
  -- sQ hybrid contractor, pre-existing instructor row + payroll profile
  ('00000000-0000-0000-0000-00001a612001'::uuid), ('00000000-0000-0000-0000-00001a612002'::uuid),
  -- sR hybrid seat-limit fail
  ('00000000-0000-0000-0000-00001a613001'::uuid), -- staff_admin
  ('00000000-0000-0000-0000-00001a613002'::uuid), -- existing regular capable instructor consuming the 1 seat
  ('00000000-0000-0000-0000-00001a613003'::uuid)  -- renter attempting hybrid promotion
) as t(uid);

-- sB (growth bulk, 6 users) and sC (pro bulk, 16 users), generated.
insert into auth.users (id, email)
select
  ('00000000-0000-0000-0000-00001a602' || lpad(to_hex(16 + gs), 3, '0'))::uuid,
  't-landmark1a-s6-growthbulk-user' || gs || '@example.test'
from generate_series(1, 6) gs;

insert into auth.users (id, email)
select
  ('00000000-0000-0000-0000-00001a603' || lpad(to_hex(16 + gs), 3, '0'))::uuid,
  't-landmark1a-s6-probulk-user' || gs || '@example.test'
from generate_series(1, 16) gs;

-- sB/sC also need one staff_admin each.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001a602001', 't-landmark1a-s6-growthbulk-staff@example.test'),
  ('00000000-0000-0000-0000-00001a603001', 't-landmark1a-s6-probulk-staff@example.test');

-- ON CONFLICT DO NOTHING: this file's own auth.users rows may overlap
-- with already-committed fixture rows from other synthetic namespaces
-- sharing the same broad "t-landmark1a-s6-" email prefix (e.g. this
-- session's real-connection concurrency proofs, which use
-- t-landmark1a-s6-conc-*) -- never assume a clean slate.
insert into public.profiles (id, email, full_name)
select id, email, 'Slice6 ' || email from auth.users
where email like 't-landmark1a-s6-%'
on conflict (id) do nothing;

-- --- Memberships (staff actors, owners, front-desk) ----------------------

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00001a601001', '00000000-0000-0000-0000-00001a601000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a601002', '00000000-0000-0000-0000-00001a601000', 'studio_owner', true),
  ('00000000-0000-0000-0000-00001a602001', '00000000-0000-0000-0000-00001a602000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a603001', '00000000-0000-0000-0000-00001a603000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a604001', '00000000-0000-0000-0000-00001a604000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a605001', '00000000-0000-0000-0000-00001a605000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a606001', '00000000-0000-0000-0000-00001a606000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a607001', '00000000-0000-0000-0000-00001a607000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a608001', '00000000-0000-0000-0000-00001a608000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a609001', '00000000-0000-0000-0000-00001a609000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60a001', '00000000-0000-0000-0000-00001a60a000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60b001', '00000000-0000-0000-0000-00001a60b000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60c001', '00000000-0000-0000-0000-00001a60c000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60d001', '00000000-0000-0000-0000-00001a60d000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60e001', '00000000-0000-0000-0000-00001a60e000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a60e002', '00000000-0000-0000-0000-00001a60e000', 'front_desk', true),
  ('00000000-0000-0000-0000-00001a60e003', '00000000-0000-0000-0000-00001a60e000', 'front_desk', true),
  ('00000000-0000-0000-0000-00001a60f001', '00000000-0000-0000-0000-00001a60f000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a610001', '00000000-0000-0000-0000-00001a610000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a611001', '00000000-0000-0000-0000-00001a611000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a612001', '00000000-0000-0000-0000-00001a612000', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001a613001', '00000000-0000-0000-0000-00001a613000', 'studio_admin', true);

-- --- Instructor rows ------------------------------------------------------

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  -- sA
  ('00000000-0000-0000-0000-00001a601102', '00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601002', 'Owner', 'A', true, false),
  ('00000000-0000-0000-0000-00001a601103', '00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601003', 'Instr1', 'A', true, false),
  ('00000000-0000-0000-0000-00001a601104', '00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601004', 'Instr2', 'A', true, false),
  -- sD/sE/sF/sG/sH -- one candidate each
  ('00000000-0000-0000-0000-00001a604102', '00000000-0000-0000-0000-00001a604000', '00000000-0000-0000-0000-00001a604002', 'Trialing', 'Candidate', true, false),
  ('00000000-0000-0000-0000-00001a605102', '00000000-0000-0000-0000-00001a605000', '00000000-0000-0000-0000-00001a605002', 'PastDue', 'Candidate', true, false),
  ('00000000-0000-0000-0000-00001a606102', '00000000-0000-0000-0000-00001a606000', '00000000-0000-0000-0000-00001a606002', 'Cancelled', 'Candidate', true, false),
  ('00000000-0000-0000-0000-00001a607102', '00000000-0000-0000-0000-00001a607000', '00000000-0000-0000-0000-00001a607002', 'Inactive', 'Candidate', true, false),
  ('00000000-0000-0000-0000-00001a608102', '00000000-0000-0000-0000-00001a608000', '00000000-0000-0000-0000-00001a608002', 'Organizer', 'Candidate', true, false),
  -- sM admin/front-desk
  ('00000000-0000-0000-0000-00001a60e103', '00000000-0000-0000-0000-00001a60e000', '00000000-0000-0000-0000-00001a60e003', 'FrontDesk', 'Capable', true, false),
  ('00000000-0000-0000-0000-00001a60e104', '00000000-0000-0000-0000-00001a60e000', '00000000-0000-0000-0000-00001a60e004', 'Regular', 'Blocked', true, false),
  -- sL1 reactivation blocks: one already-capable+active (fills the seat), one inactive+capable
  ('00000000-0000-0000-0000-00001a60c102', '00000000-0000-0000-0000-00001a60c000', '00000000-0000-0000-0000-00001a60c002', 'Filling', 'Seat', true, false),
  ('00000000-0000-0000-0000-00001a60c103', '00000000-0000-0000-0000-00001a60c000', '00000000-0000-0000-0000-00001a60c003', 'Inactive', 'Capable', false, true),
  -- sL2 reactivation succeeds: one inactive+capable, one inactive+incapable
  ('00000000-0000-0000-0000-00001a60d102', '00000000-0000-0000-0000-00001a60d000', '00000000-0000-0000-0000-00001a60d002', 'Inactive', 'CapableOK', false, true),
  ('00000000-0000-0000-0000-00001a60d103', '00000000-0000-0000-0000-00001a60d000', '00000000-0000-0000-0000-00001a60d003', 'Inactive', 'Incapable', false, false),
  -- sR seat-limit fail: existing regular capable instructor consumes the 1 seat
  ('00000000-0000-0000-0000-00001a613102', '00000000-0000-0000-0000-00001a613000', '00000000-0000-0000-0000-00001a613002', 'Existing', 'Capable', true, true);

-- sB (growth bulk, 6 instructors) and sC (pro bulk, 16 instructors).
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
select
  ('00000000-0000-0000-0000-00001a602' || lpad(to_hex(48 + gs), 3, '0'))::uuid,
  '00000000-0000-0000-0000-00001a602000',
  ('00000000-0000-0000-0000-00001a602' || lpad(to_hex(16 + gs), 3, '0'))::uuid,
  'GrowthBulk', gs::text, true, false
from generate_series(1, 6) gs;

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
select
  ('00000000-0000-0000-0000-00001a603' || lpad(to_hex(48 + gs), 3, '0'))::uuid,
  '00000000-0000-0000-0000-00001a603000',
  ('00000000-0000-0000-0000-00001a603' || lpad(to_hex(16 + gs), 3, '0'))::uuid,
  'ProBulk', gs::text, true, false
from generate_series(1, 16) gs;

-- --- sK cross-studio: same person, renter at A, independent instructor at B ---
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a60a102', '00000000-0000-0000-0000-00001a60a000', '00000000-0000-0000-0000-00001a60a002', 'Shared', 'AtA', true, false),
  ('00000000-0000-0000-0000-00001a60b102', '00000000-0000-0000-0000-00001a60b000', '00000000-0000-0000-0000-00001a60a002', 'Shared', 'AtB', true, false);

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a60a301', '00000000-0000-0000-0000-00001a60a000', 'Shared', 'Renter', 'active', true, '00000000-0000-0000-0000-00001a60a102');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a60a401', '00000000-0000-0000-0000-00001a60a000', '00000000-0000-0000-0000-00001a60a301', '00000000-0000-0000-0000-00001a60a002', 'linked', 'self', true);

-- --- sJ renter guard: renter with is_independent_instructor=true, linked ---
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a609102', '00000000-0000-0000-0000-00001a609000', '00000000-0000-0000-0000-00001a609002', 'Renter', 'Guard', true, false);
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a609301', '00000000-0000-0000-0000-00001a609000', 'Renter', 'Guard', 'active', true, '00000000-0000-0000-0000-00001a609102');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a609401', '00000000-0000-0000-0000-00001a609000', '00000000-0000-0000-0000-00001a609301', '00000000-0000-0000-0000-00001a609002', 'linked', 'self', true);

-- --- sN/sO/sP: renter with linked account, no pre-existing instructor row (Tier 5 create) ---
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a60f301', '00000000-0000-0000-0000-00001a60f000', 'NoAttest', 'Renter', 'active', true, null),
  ('00000000-0000-0000-0000-00001a610301', '00000000-0000-0000-0000-00001a610000', 'BadClass', 'Renter', 'active', true, null),
  ('00000000-0000-0000-0000-00001a611301', '00000000-0000-0000-0000-00001a611000', 'Employee', 'Renter', 'active', true, null),
  ('00000000-0000-0000-0000-00001a613301', '00000000-0000-0000-0000-00001a613000', 'SeatFail', 'Renter', 'active', true, null);
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a60f401', '00000000-0000-0000-0000-00001a60f000', '00000000-0000-0000-0000-00001a60f301', '00000000-0000-0000-0000-00001a60f002', 'linked', 'self', true),
  ('00000000-0000-0000-0000-00001a610401', '00000000-0000-0000-0000-00001a610000', '00000000-0000-0000-0000-00001a610301', '00000000-0000-0000-0000-00001a610002', 'linked', 'self', true),
  ('00000000-0000-0000-0000-00001a611401', '00000000-0000-0000-0000-00001a611000', '00000000-0000-0000-0000-00001a611301', '00000000-0000-0000-0000-00001a611002', 'linked', 'self', true),
  ('00000000-0000-0000-0000-00001a613401', '00000000-0000-0000-0000-00001a613000', '00000000-0000-0000-0000-00001a613301', '00000000-0000-0000-0000-00001a613003', 'linked', 'self', true);

-- --- sQ: renter with linked account AND a pre-existing, unlinked instructor
-- row (reachable via Tier 2) AND a pre-existing payroll profile.
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-00001a612102', '00000000-0000-0000-0000-00001a612000', null, 'Existing', 'Renter', true, false);
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-00001a612301', '00000000-0000-0000-0000-00001a612000', 'Existing', 'Renter', 'active', true, '00000000-0000-0000-0000-00001a612102');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary) values
  ('00000000-0000-0000-0000-00001a612401', '00000000-0000-0000-0000-00001a612000', '00000000-0000-0000-0000-00001a612301', '00000000-0000-0000-0000-00001a612002', 'linked', 'self', true);
insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification) values
  ('00000000-0000-0000-0000-00001a612000', '00000000-0000-0000-0000-00001a612102', false, 'not_set');

-- ============================================================================
-- Direct plan/billing-status resolution assertions (no RPC, no auth needed --
-- _landmark1a_resolve_studio_seat_limit is revoked from every role, but a
-- privileged migration-applying connection is the function owner and
-- retains implicit EXECUTE regardless of the revoke).
-- ============================================================================

do $$
declare v int;
begin
  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a601000') into v;
  assert v = 1, format('Starter (override) should resolve to limit 1, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a602000') into v;
  assert v = 5, format('Growth (override) should resolve to limit 5, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a603000') into v;
  assert v = 15, format('Pro (real subscription join) should resolve to limit 15, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a604000') into v;
  assert v = 5, format('Trialing-on-growth should resolve at growth''s real tier (5), got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a605000') into v;
  assert v = 0, format('Past_due should resolve to 0 new-grant allowance regardless of tier, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a606000') into v;
  assert v = 0, format('Cancelled should resolve to 0 new-grant allowance regardless of tier, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a607000') into v;
  assert v = 0, format('Inactive (no subscription row, fallback branch) should resolve to 0, got %s', v);

  select public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001a608000') into v;
  assert v = 0, format('Organizer plan code (status=active) should resolve to 0 -- plan-code-driven, not status-driven, got %s', v);
end $$;

-- ============================================================================
-- RPC-level scenarios
-- ============================================================================

-- --- sA: owner-free, Starter first/second grant, idempotent-at-limit ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a601001', 'email', 't-landmark1a-s6-staffA@example.test')::text, true);

  -- Owner grant is free regardless of count.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601102');

  -- Starter first counted grant succeeds.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601103');

  -- Starter second counted grant blocks.
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601104');
    assert false, 'Expected Starter second grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;

  -- Idempotent re-grant of the already-capable instr1, studio now exactly
  -- at its limit -- must succeed as a no-op, not self-block.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a601000', '00000000-0000-0000-0000-00001a601103');

  reset role;
end $$;

do $$
declare
  v_owner boolean; v_instr1 boolean; v_instr2 boolean; v_audit_count int;
begin
  select can_instruct into v_owner from public.instructors where id = '00000000-0000-0000-0000-00001a601102';
  select can_instruct into v_instr1 from public.instructors where id = '00000000-0000-0000-0000-00001a601103';
  select can_instruct into v_instr2 from public.instructors where id = '00000000-0000-0000-0000-00001a601104';
  assert v_owner = true, 'Owner should be can_instruct=true';
  assert v_instr1 = true, 'Instr1 should be can_instruct=true';
  assert v_instr2 = false, 'Instr2 should remain can_instruct=false (blocked)';

  -- Exactly one capability_granted audit event for instr1 despite the
  -- idempotent re-grant call (no duplicate on no-op).
  select count(*) into v_audit_count from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a601103' and event_type = 'capability_granted';
  assert v_audit_count = 1, format('Expected exactly 1 capability_granted event for instr1, got %s', v_audit_count);

  select count(*) into v_audit_count from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a601104';
  assert v_audit_count = 0, 'Blocked instr2 should have zero audit events';
end $$;

-- --- sB: Growth 1-5 succeed, 6th blocks ---
do $$
declare
  gs int;
  v_instr_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a602001', 'email', 't-landmark1a-s6-staffB@example.test')::text, true);

  for gs in 1..5 loop
    v_instr_id := ('00000000-0000-0000-0000-00001a602' || lpad(to_hex(48 + gs), 3, '0'))::uuid;
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a602000', v_instr_id);
  end loop;

  v_instr_id := ('00000000-0000-0000-0000-00001a602' || lpad(to_hex(48 + 6), 3, '0'))::uuid;
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a602000', v_instr_id);
    assert false, 'Expected Growth 6th grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;

  reset role;
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.instructors
    where studio_id = '00000000-0000-0000-0000-00001a602000' and can_instruct = true;
  assert v_count = 5, format('Expected exactly 5 capable Growth-bulk instructors, got %s', v_count);
end $$;

-- --- sC: Pro 1-15 succeed, 16th blocks ---
do $$
declare
  gs int;
  v_instr_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a603001', 'email', 't-landmark1a-s6-staffC@example.test')::text, true);

  for gs in 1..15 loop
    v_instr_id := ('00000000-0000-0000-0000-00001a603' || lpad(to_hex(48 + gs), 3, '0'))::uuid;
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a603000', v_instr_id);
  end loop;

  v_instr_id := ('00000000-0000-0000-0000-00001a603' || lpad(to_hex(48 + 16), 3, '0'))::uuid;
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a603000', v_instr_id);
    assert false, 'Expected Pro 16th grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;

  reset role;
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.instructors
    where studio_id = '00000000-0000-0000-0000-00001a603000' and can_instruct = true;
  assert v_count = 15, format('Expected exactly 15 capable Pro-bulk instructors, got %s', v_count);
end $$;

-- --- sD/sE/sF/sG/sH: end-to-end billing-status/plan-code enforcement via the RPC ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a604001', 'email', 't-landmark1a-s6-staffD@example.test')::text, true);
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a604000', '00000000-0000-0000-0000-00001a604102');
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a605001', 'email', 't-landmark1a-s6-staffE@example.test')::text, true);
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a605000', '00000000-0000-0000-0000-00001a605102');
    assert false, 'Expected past_due studio grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a606001', 'email', 't-landmark1a-s6-staffF@example.test')::text, true);
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a606000', '00000000-0000-0000-0000-00001a606102');
    assert false, 'Expected cancelled studio grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a607001', 'email', 't-landmark1a-s6-staffG@example.test')::text, true);
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a607000', '00000000-0000-0000-0000-00001a607102');
    assert false, 'Expected inactive studio grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a608001', 'email', 't-landmark1a-s6-staffH@example.test')::text, true);
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a608000', '00000000-0000-0000-0000-00001a608102');
    assert false, 'Expected organizer-plan studio grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

-- --- sJ: renter guard rejects ordinary grant; deactivating the renter
-- relationship (via the existing client action's own effect) unblocks it ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a609001', 'email', 't-landmark1a-s6-staffJ@example.test')::text, true);
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a609000', '00000000-0000-0000-0000-00001a609102');
    assert false, 'Expected renter guard to reject ordinary grant';
  exception when others then
    assert sqlerrm like '%independent/floor-rental relationship%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

update public.clients set is_independent_instructor = false
  where id = '00000000-0000-0000-0000-00001a609301';

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a609001', 'email', 't-landmark1a-s6-staffJ@example.test')::text, true);
  -- Deactivated renter relationship no longer blocks -- current-live-state
  -- guard, not historical.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a609000', '00000000-0000-0000-0000-00001a609102');
  reset role;
end $$;

-- --- sK: same person, renter at Studio A, normal instructor at Studio B --
-- Studio B grant must succeed; the guard is same-studio scoped only.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a60b001', 'email', 't-landmark1a-s6-staffKb@example.test')::text, true);
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a60b000', '00000000-0000-0000-0000-00001a60b102');
  reset role;
end $$;

do $$
declare v boolean;
begin
  select can_instruct into v from public.instructors where id = '00000000-0000-0000-0000-00001a60b102';
  assert v = true, 'Studio B grant for the shared person should succeed (studio-scoped guard)';
end $$;

-- --- sM: admin/front-desk without capability not counted; WITH capability counted ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a60e001', 'email', 't-landmark1a-s6-staffM@example.test')::text, true);

  -- Front-desk-capable row consumes the studio's only (starter=1) seat.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a60e000', '00000000-0000-0000-0000-00001a60e103');

  -- A separate, unrelated regular instructor grant now blocks -- proving
  -- the front_desk-only user (00001a60e002, no instructors row at all)
  -- was never counted, and the front_desk-WITH-capability row (e103)
  -- correctly consumed the studio's only seat.
  begin
    perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a60e000', '00000000-0000-0000-0000-00001a60e104');
    assert false, 'Expected the second sM grant to block';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;

  reset role;
end $$;

-- --- sL1: capable reactivation blocks at limit ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a60c001', 'email', 't-landmark1a-s6-staffL1@example.test')::text, true);

  -- Fill the studio's only (starter=1) seat first.
  perform public.grant_instructor_capability('00000000-0000-0000-0000-00001a60c000', '00000000-0000-0000-0000-00001a60c102');

  -- Reactivating the inactive+capable second instructor should now block.
  begin
    perform public.reactivate_instructor('00000000-0000-0000-0000-00001a60c000', '00000000-0000-0000-0000-00001a60c103');
    assert false, 'Expected capable reactivation to block at the seat limit';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;

  reset role;
end $$;

do $$
declare v_active boolean; v_audit int;
begin
  select active into v_active from public.instructors where id = '00000000-0000-0000-0000-00001a60c103';
  assert v_active = false, 'Blocked reactivation must leave the row inactive';
  select count(*) into v_audit from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a60c103';
  assert v_audit = 0, 'Blocked reactivation must write zero audit events';
end $$;

-- --- sL2: incapable reactivation succeeds without a seat check; capable
-- reactivation succeeds under the (growth=5) limit ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a60d001', 'email', 't-landmark1a-s6-staffL2@example.test')::text, true);

  perform public.reactivate_instructor('00000000-0000-0000-0000-00001a60d000', '00000000-0000-0000-0000-00001a60d103');
  perform public.reactivate_instructor('00000000-0000-0000-0000-00001a60d000', '00000000-0000-0000-0000-00001a60d102');

  reset role;
end $$;

do $$
declare
  v_incapable_active boolean; v_capable_active boolean;
  v_incapable_audit int; v_capable_activated int; v_capable_granted int;
begin
  select active into v_incapable_active from public.instructors where id = '00000000-0000-0000-0000-00001a60d103';
  select active into v_capable_active from public.instructors where id = '00000000-0000-0000-0000-00001a60d102';
  assert v_incapable_active = true, 'Incapable reactivation should succeed';
  assert v_capable_active = true, 'Capable reactivation under the limit should succeed';

  select count(*) into v_incapable_audit from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a60d103';
  assert v_incapable_audit = 0, 'Incapable reactivation must write zero audit events';

  select count(*) into v_capable_activated from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a60d102' and event_type = 'activated';
  select count(*) into v_capable_granted from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a60d102' and event_type = 'capability_granted';
  assert v_capable_activated = 1, format('Expected exactly 1 activated event, got %s', v_capable_activated);
  assert v_capable_granted = 0, 'Capable reactivation must never write a capability_granted event';
end $$;

-- --- sN: hybrid missing attestation rejects, zero mutation ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a60f001', 'email', 't-landmark1a-s6-staffN@example.test')::text, true);
  begin
    perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a60f000', '00000000-0000-0000-0000-00001a60f301', false, 'contractor');
    assert false, 'Expected missing-attestation hybrid promotion to reject';
  exception when others then
    assert sqlerrm like '%explicit staff attestation%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.instructors where studio_id = '00000000-0000-0000-0000-00001a60f000';
  assert v_count = 0, 'Missing-attestation hybrid promotion must create zero instructor rows';
end $$;

-- --- sO: hybrid bad worker_classification ('not_set', 'owner') rejects ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a610001', 'email', 't-landmark1a-s6-staffO@example.test')::text, true);

  begin
    perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a610000', '00000000-0000-0000-0000-00001a610301', true, 'not_set');
    assert false, 'Expected not_set classification to reject';
  exception when others then
    assert sqlerrm like '%worker classification of employee or contractor%', format('Unexpected error: %s', sqlerrm);
  end;

  begin
    perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a610000', '00000000-0000-0000-0000-00001a610301', true, 'owner');
    assert false, 'Expected owner classification to reject';
  exception when others then
    assert sqlerrm like '%worker classification of employee or contractor%', format('Unexpected error: %s', sqlerrm);
  end;

  reset role;
end $$;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.instructors where studio_id = '00000000-0000-0000-0000-00001a610000';
  assert v_count = 0, 'Bad-classification hybrid promotion attempts must create zero instructor rows';
end $$;

-- --- sP: hybrid employee, fresh Tier-5 create, full success proof ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a611001', 'email', 't-landmark1a-s6-staffP@example.test')::text, true);
  perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a611000', '00000000-0000-0000-0000-00001a611301', true, 'employee');
  -- Idempotent re-call: fully idempotent no-op (both fields already true).
  perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a611000', '00000000-0000-0000-0000-00001a611301', true, 'employee');
  reset role;
end $$;

do $$
declare
  v_instructor_id uuid;
  v_can_instruct boolean; v_attested boolean; v_user_id uuid;
  v_payroll_active boolean; v_worker_classification text;
  v_granted_count int; v_linked_count int;
  v_before jsonb; v_after jsonb; v_metadata jsonb;
begin
  select id, can_instruct, hybrid_client_assignment_attested, user_id
    into v_instructor_id, v_can_instruct, v_attested, v_user_id
  from public.instructors
  where studio_id = '00000000-0000-0000-0000-00001a611000';

  assert v_instructor_id is not null, 'Hybrid promotion should have created an instructor row';
  assert v_can_instruct = true, 'can_instruct should be true';
  assert v_attested = true, 'hybrid_client_assignment_attested should be true';
  assert v_user_id = '00000000-0000-0000-0000-00001a611002', 'Instructor should be linked to the renter''s account';

  select payroll_active, worker_classification into v_payroll_active, v_worker_classification
  from public.instructor_payroll_profiles
  where studio_id = '00000000-0000-0000-0000-00001a611000' and instructor_id = v_instructor_id;
  assert v_payroll_active = true, 'Payroll profile should be active';
  assert v_worker_classification = 'employee', 'Payroll profile should show employee';

  select count(*) into v_granted_count from public.instructor_audit_events
    where instructor_id = v_instructor_id and event_type = 'capability_granted';
  assert v_granted_count = 1, format('Expected exactly 1 capability_granted event (no duplicate from the idempotent re-call), got %s', v_granted_count);

  select before_value, after_value, metadata into v_before, v_after, v_metadata
  from public.instructor_audit_events
  where instructor_id = v_instructor_id and event_type = 'capability_granted';

  assert v_before ? 'can_instruct' and v_before ? 'hybrid_client_assignment_attested',
    'before_value must contain both fields, not just can_instruct';
  assert v_after ->> 'can_instruct' = 'true' and v_after ->> 'hybrid_client_assignment_attested' = 'true',
    'after_value must show both fields true';
  assert (v_metadata ->> 'payroll_profile_created') = 'true',
    format('Expected payroll_profile_created=true for a fresh profile, got %s', v_metadata ->> 'payroll_profile_created');
  assert v_metadata ->> 'worker_classification' = 'employee', 'metadata should record the selected classification';
  assert not (v_metadata ? 'email'), 'metadata must contain no PII';

  -- The linkage helper's own account_linked event (Tier 5 create) is a
  -- separate, legitimate event -- not a duplicate capability_granted row.
  select count(*) into v_linked_count from public.instructor_audit_events
    where instructor_id = v_instructor_id and event_type = 'account_linked';
  assert v_linked_count = 1, format('Expected exactly 1 account_linked event from the Tier-5 create, got %s', v_linked_count);
end $$;

-- --- sQ: hybrid contractor, pre-existing instructor row + pre-existing
-- payroll profile -- payroll_profile_created must be false ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a612001', 'email', 't-landmark1a-s6-staffQ@example.test')::text, true);
  perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a612000', '00000000-0000-0000-0000-00001a612301', true, 'contractor');
  reset role;
end $$;

do $$
declare
  v_payroll_active boolean; v_worker_classification text; v_metadata jsonb; v_granted_count int;
begin
  select payroll_active, worker_classification into v_payroll_active, v_worker_classification
  from public.instructor_payroll_profiles
  where studio_id = '00000000-0000-0000-0000-00001a612000' and instructor_id = '00000000-0000-0000-0000-00001a612102';
  assert v_payroll_active = true, 'Existing payroll profile should now be active';
  assert v_worker_classification = 'contractor', 'Existing payroll profile should now show contractor';

  select metadata into v_metadata from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a612102' and event_type = 'capability_granted';
  assert (v_metadata ->> 'payroll_profile_created') = 'false',
    format('Expected payroll_profile_created=false for a reused profile, got %s', v_metadata ->> 'payroll_profile_created');

  select count(*) into v_granted_count from public.instructor_audit_events
    where instructor_id = '00000000-0000-0000-0000-00001a612102' and event_type = 'capability_granted';
  assert v_granted_count = 1, format('Expected exactly 1 capability_granted event, got %s', v_granted_count);
end $$;

-- --- sR: hybrid promotion fails on seat limit -- full atomic rollback ---
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001a613001', 'email', 't-landmark1a-s6-staffR@example.test')::text, true);
  begin
    perform public.promote_hybrid_instructor('00000000-0000-0000-0000-00001a613000', '00000000-0000-0000-0000-00001a613301', true, 'contractor');
    assert false, 'Expected hybrid promotion to block at the seat limit';
  exception when others then
    assert sqlerrm like '%reached its instructor seat limit%', format('Unexpected error: %s', sqlerrm);
  end;
  reset role;
end $$;

do $$
declare v_instr_count int; v_payroll_count int; v_audit_count int;
begin
  select count(*) into v_instr_count from public.instructors
    where studio_id = '00000000-0000-0000-0000-00001a613000' and user_id = '00000000-0000-0000-0000-00001a613003';
  assert v_instr_count = 0, 'Failed hybrid promotion must leave zero instructor rows for the renter (linkage rolled back)';

  select count(*) into v_payroll_count from public.instructor_payroll_profiles
    where studio_id = '00000000-0000-0000-0000-00001a613000'
      and instructor_id not in (select id from public.instructors where studio_id = '00000000-0000-0000-0000-00001a613000');
  assert v_payroll_count = 0, 'Failed hybrid promotion must leave zero orphaned payroll rows';

  select count(*) into v_audit_count from public.instructor_audit_events
    where studio_id = '00000000-0000-0000-0000-00001a613000'
      and metadata ->> 'source' = 'hybrid_promotion';
  assert v_audit_count = 0, 'Failed hybrid promotion must write zero audit events';
end $$;

rollback;
