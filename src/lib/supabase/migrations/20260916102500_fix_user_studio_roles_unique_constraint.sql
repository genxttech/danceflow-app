-- Landmark 1A-I -- Team Role Write-Path Integrity Fix.
--
-- DEFECT (confirmed via EXPLAIN against both DEV and PROD, zero rows
-- touched, during the Landmark 1A-I audit): public.user_studio_roles'
-- only unique constraint is 3-column (user_id, studio_id, role), but the
-- two live write paths that grant/change a team member's role --
-- upsertTeamMemberRoleAction (src/app/app/settings/team/actions.ts) and
-- accept_pending_team_invitations's first-time-join branch
-- (src/lib/supabase/migrations/20260423_accept_team_invitations.sql) --
-- both use `on conflict (studio_id, user_id)`, a 2-column target with no
-- matching constraint. Postgres validates the ON CONFLICT arbiter target
-- at planning time, unconditionally, so both statements fail with
-- `42P10: there is no unique or exclusion constraint matching the ON
-- CONFLICT specification` on every execution -- not just when a real
-- duplicate exists. Traced impact: any user with a pending first-time
-- team invitation is redirected to a login-failure error page instead of
-- being signed in (src/app/(auth)/callback/route.ts's
-- callback-sync-failed catch), and direct role assignment/reassignment
-- via the team settings UI fails on every attempt.
--
-- INTENDED CARDINALITY (determined from code/UI evidence, independent of
-- any architecture recommendation -- see the Landmark 1A-I audit):
-- exactly one role per (user_id, studio_id) is the current product's
-- consistent intent -- the shared read helper `getExistingMembership`
-- uses `.maybeSingle()` with no role filter across 3 call sites, the
-- invite-acceptance RPC's own existing-role lookup uses `LIMIT 1` with no
-- role filter, `deactivateTeamMemberAction`'s UPDATE has no role filter,
-- and the team-settings UI models `role` as a single scalar field with
-- one badge per member. The existing 3-column constraint is therefore
-- the actual defect -- it is under-constraining relative to that intent.
--
-- FIX: replace the 3-column unique constraint with a 2-column
-- (studio_id, user_id) constraint, matching what both write paths already
-- assume and require. A read-only duplicate preflight against both DEV
-- (8 rows, 0 duplicate (studio_id,user_id) groups) and PROD (6 rows, 0
-- duplicate groups) confirmed this constraint can be added safely on
-- both environments before this migration was authored.
--
-- Scope: exactly this one constraint swap. No row/data is modified, no
-- capability column is added, no RLS/policy is touched, no billing/
-- entitlement logic is touched, no application code needs to change --
-- both `on conflict (studio_id, user_id)` clauses already match this
-- constraint's exact column set and order.

begin;

alter table public.user_studio_roles
  drop constraint user_studio_roles_user_id_studio_id_role_key;

alter table public.user_studio_roles
  add constraint user_studio_roles_studio_id_user_id_key
  unique (studio_id, user_id);

commit;
