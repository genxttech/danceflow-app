-- Portal / Multi-Studio Test Harness -- H2-C1: claim_client_account_invitation
-- authority migration (client_account_links, not clients.portal_user_id).
--
-- This file is the version-controlled source of truth for H2-C1's SQL
-- regression coverage (there is no other `test_T_*.sql` file committed to
-- this repo today -- every prior H1/H2-B1/H2-B2 harness file lives only on
-- the developer's own machine, per scripts/run-portal-linkage-sql-tests.sh's
-- own documented convention; this is the one exception H2-C1's review
-- explicitly asked to change, scoped to this file only). To actually run
-- it locally, copy (or keep in sync) into the directory named by
-- PORTAL_LINKAGE_SQL_DIR -- the runner script only reads from that
-- external, developer-local directory, same as it always has for every
-- other test_T_*.sql file:
--   cp src/lib/supabase/migrations/sql-tests/test_T_h2c1_claim_invitation_authority.sql "$PORTAL_LINKAGE_SQL_DIR/"
--   PORTAL_LINKAGE_SQL_DIR=/path/to/your/local-staging/dir npm run test:portal-linkage:sql
--
-- Deterministic UUID block reserved for this harness file:
-- 00000000-0000-0000-0000-0000003fXXXX. Distinct from the H1/H2-B2 harness
-- block (...3eXXXX) in test_T_portal_multi_studio_identity.sql, so both
-- files can run in the same suite without collision.
--
-- Entire script runs in one transaction and is rolled back at the end --
-- nothing persists in the local database. Run as postgres/superuser (the
-- function is SECURITY DEFINER, so RLS is bypassed regardless).

begin;

-- ============================================================================
-- Studios -- two genuinely distinct studios for the multi-studio cases.
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000003f0001', 'H2-C1 Harness Studio A', 't-h2c1-studio-a'),
  ('00000000-0000-0000-0000-0000003f0002', 'H2-C1 Harness Studio B', 't-h2c1-studio-b');

-- ============================================================================
-- Auth users / profiles for U1..U8.
-- ============================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000003f1001', 't-h2c1-u1@example.test'),
  ('00000000-0000-0000-0000-0000003f1002', 't-h2c1-u2@example.test'),
  ('00000000-0000-0000-0000-0000003f1003', 't-h2c1-u3@example.test'),
  ('00000000-0000-0000-0000-0000003f1004', 't-h2c1-u4@example.test'),
  ('00000000-0000-0000-0000-0000003f1005', 't-h2c1-u5@example.test'),
  ('00000000-0000-0000-0000-0000003f1006', 't-h2c1-u6@example.test'),
  ('00000000-0000-0000-0000-0000003f1007', 't-h2c1-u7@example.test'),
  ('00000000-0000-0000-0000-0000003f1008', 't-h2c1-u8@example.test');

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000003f1001', 't-h2c1-u1@example.test'),
  ('00000000-0000-0000-0000-0000003f1002', 't-h2c1-u2@example.test'),
  ('00000000-0000-0000-0000-0000003f1003', 't-h2c1-u3@example.test'),
  ('00000000-0000-0000-0000-0000003f1004', 't-h2c1-u4@example.test'),
  ('00000000-0000-0000-0000-0000003f1005', 't-h2c1-u5@example.test'),
  ('00000000-0000-0000-0000-0000003f1006', 't-h2c1-u6@example.test'),
  ('00000000-0000-0000-0000-0000003f1007', 't-h2c1-u7@example.test'),
  ('00000000-0000-0000-0000-0000003f1008', 't-h2c1-u8@example.test');

-- ============================================================================
-- Clients (one clients row per studio per case, mirroring the real
-- per-studio-row model) and their client_account_links rows.
-- ============================================================================

-- Case A: single-studio claim, unchanged.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2001', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseA', 't-h2c1-u1@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3001', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2001', null, 'invited', 'self', 'studio', 't-h2c1-u1@example.test', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Case B: simultaneous two-distinct-studio claim.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2002', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseB-StudioA', 't-h2c1-u2@example.test', 'active'),
  ('00000000-0000-0000-0000-0000003f2003', '00000000-0000-0000-0000-0000003f0002', 'T', 'CaseB-StudioB', 't-h2c1-u2@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3002', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2002', null, 'invited', 'self', 'studio', 't-h2c1-u2@example.test', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000003f3003', '00000000-0000-0000-0000-0000003f0002', '00000000-0000-0000-0000-0000003f2003', null, 'invited', 'self', 'studio', 't-h2c1-u2@example.test', '2026-08-01T00:00:01Z', '2026-08-01T00:00:01Z');

-- Case C: existing Studio A (already linked) + new Studio B invitation.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2004', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseC-StudioA', 't-h2c1-u3@example.test', 'active'),
  ('00000000-0000-0000-0000-0000003f2005', '00000000-0000-0000-0000-0000003f0002', 'T', 'CaseC-StudioB', 't-h2c1-u3@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, linked_at, claimed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3004', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2004', '00000000-0000-0000-0000-0000003f1003', 'linked', 'self', true, 'studio', 't-h2c1-u3@example.test', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3005', '00000000-0000-0000-0000-0000003f0002', '00000000-0000-0000-0000-0000003f2005', null, 'invited', 'self', 'studio', 't-h2c1-u3@example.test', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Case D: simple reconnect -- same row, previously disconnected fields
-- still present, re-invited (status flipped back to 'invited', user_id
-- retained), matching createOrRefreshClientInvitation's existingForUser
-- reuse path.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2006', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseD', 't-h2c1-u4@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, disconnected_at, disconnect_reason, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3006', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2006', '00000000-0000-0000-0000-0000003f1004', 'invited', 'self', 'studio', 't-h2c1-u4@example.test', '2026-07-15T00:00:00Z', 'harness fixture: prior disconnect, now re-invited', '2026-06-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Case D2: reconnect via a SEPARATE fresh invitation row -- an older
-- disconnected row (still carrying the same user_id) coexists with a new,
-- distinct 'invited' row for the same client, exactly as
-- createOrRefreshClientInvitation produces when it re-invites by email
-- alone (no explicit target user_id known in advance).
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2007', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseD2', 't-h2c1-u5@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, disconnected_at, disconnect_reason, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3007', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2007', '00000000-0000-0000-0000-0000003f1005', 'disconnected', 'self', 'studio', 't-h2c1-u5@example.test', '2026-07-15T00:00:00Z', 'harness fixture: prior disconnect', '2026-06-01T00:00:00Z', '2026-07-15T00:00:00Z');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, invite_token_hash, invite_expires_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3008', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2007', null, 'invited', 'self', 'studio', 't-h2c1-u5@example.test', 'fake-hash-h2c1-d2', '2099-01-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Case E: different-user conflict -- client already linked to U6; a
-- separate (guardian) invitation row for the same client targets U7.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2008', '00000000-0000-0000-0000-0000003f0001', 'T', 'CaseE', 't-h2c1-u6@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, linked_at, claimed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3009', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2008', '00000000-0000-0000-0000-0000003f1006', 'linked', 'self', true, 'studio', 't-h2c1-u6@example.test', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3010', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2008', null, 'invited', 'guardian', 'studio', 't-h2c1-u7@example.test', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Race-reconciliation fixtures (exception-handler audit): a genuine,
-- deterministic (no manufactured concurrency) unique_violation, reachable
-- single-session via client_account_links_one_primary_per_user_studio --
-- U9 already holds a linked+primary relationship on Client P; Client Q
-- (same user, same studio, a DIFFERENT client) has a disconnected row
-- plus a fresh invited row targeting the same user. The reconnect-merge
-- branch's relink of Q's disconnected row collides with P's row on
-- (user_id, studio_id) WHERE status='linked' AND is_primary=true -- a
-- real data-integrity condition (the same person primary on two clients
-- in one studio), not a race the handler should reconcile away.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000003f1009', 't-h2c1-u9@example.test');
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000003f1009', 't-h2c1-u9@example.test');
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2012', '00000000-0000-0000-0000-0000003f0001', 'T', 'RaceFailClosed-P', 't-h2c1-u9@example.test', 'active'),
  ('00000000-0000-0000-0000-0000003f2013', '00000000-0000-0000-0000-0000003f0001', 'T', 'RaceFailClosed-Q', 't-h2c1-u9@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, linked_at, claimed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3012', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2012', '00000000-0000-0000-0000-0000003f1009', 'linked', 'self', true, 'studio', 't-h2c1-u9@example.test', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, disconnected_at, disconnect_reason, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3013', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2013', '00000000-0000-0000-0000-0000003f1009', 'disconnected', 'self', true, 'studio', 't-h2c1-u9@example.test', '2026-07-15T00:00:00Z', 'harness fixture: prior disconnect', '2026-06-01T00:00:00Z', '2026-07-15T00:00:00Z');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3014', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2013', null, 'invited', 'self', 'studio', 't-h2c1-u9@example.test', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

-- Case I: sentinel/unrelated -- must remain fully untouched throughout.
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2009', '00000000-0000-0000-0000-0000003f0002', 'T', 'Sentinel', 't-h2c1-u8@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, is_primary, initiated_by, invited_email, linked_at, claimed_at, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3011', '00000000-0000-0000-0000-0000003f0002', '00000000-0000-0000-0000-0000003f2009', '00000000-0000-0000-0000-0000003f1008', 'linked', 'self', true, 'studio', 't-h2c1-u8@example.test', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');

-- ============================================================================
-- Capture sentinel + case-C-studio-A "before" state for later comparison.
-- ============================================================================
do $$
declare
  v_sentinel_updated_at timestamptz;
  v_caseC_a_updated_at timestamptz;
  v_caseE_linked_updated_at timestamptz;
begin
  select updated_at into v_sentinel_updated_at from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3011';
  select updated_at into v_caseC_a_updated_at from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3004';
  select updated_at into v_caseE_linked_updated_at from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3009';

  create temporary table t_h2c1_before_state (key text primary key, value timestamptz) on commit drop;
  insert into t_h2c1_before_state values
    ('sentinel', v_sentinel_updated_at),
    ('caseC_a', v_caseC_a_updated_at),
    ('caseE_linked', v_caseE_linked_updated_at);
end $$;

-- ============================================================================
-- CASE A -- single-studio claim remains unchanged.
-- ============================================================================
do $$
declare
  v_count integer;
  v_status text;
  v_user_id uuid;
begin
  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1001', 't-h2c1-u1@example.test', '00000000-0000-0000-0000-0000003f0001'
  ) t;

  if v_count <> 1 then
    raise exception 'FAIL T-h2c1-caseA-count: expected exactly 1 claimed row, got %', v_count;
  end if;

  select status, user_id into v_status, v_user_id from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3001';
  if v_status is distinct from 'linked' or v_user_id is distinct from '00000000-0000-0000-0000-0000003f1001'::uuid then
    raise exception 'FAIL T-h2c1-caseA-state: expected linked/U1, got status=%, user_id=%', v_status, v_user_id;
  end if;

  raise notice 'PASS T-h2c1-caseA: single-studio claim succeeds unchanged';
end $$;

-- ============================================================================
-- CASE B -- simultaneous two-distinct-studio claim in one RPC call
-- (p_studio_id = null, matching the general login callback). This is the
-- exact scenario that raised unique_violation under the pre-H2-C1
-- clients.portal_user_id-based implementation.
-- ============================================================================
do $$
declare
  v_count integer;
  v_status_a text;
  v_user_a uuid;
  v_status_b text;
  v_user_b uuid;
  v_portal_a uuid;
  v_portal_b uuid;
begin
  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1002', 't-h2c1-u2@example.test', null
  ) t;

  if v_count <> 2 then
    raise exception 'FAIL T-h2c1-caseB-count: expected both distinct-studio invitations claimed in one call, got %', v_count;
  end if;

  select status, user_id into v_status_a, v_user_a from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3002';
  select status, user_id into v_status_b, v_user_b from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3003';

  if v_status_a is distinct from 'linked' or v_user_a is distinct from '00000000-0000-0000-0000-0000003f1002'::uuid then
    raise exception 'FAIL T-h2c1-caseB-studioA: expected Studio A linked/U2, got status=%, user_id=%', v_status_a, v_user_a;
  end if;
  if v_status_b is distinct from 'linked' or v_user_b is distinct from '00000000-0000-0000-0000-0000003f1002'::uuid then
    raise exception 'FAIL T-h2c1-caseB-studioB: expected Studio B linked/U2, got status=%, user_id=%', v_status_b, v_user_b;
  end if;

  -- No global-mirror write occurred for either studio's client row.
  select portal_user_id into v_portal_a from public.clients where id = '00000000-0000-0000-0000-0000003f2002';
  select portal_user_id into v_portal_b from public.clients where id = '00000000-0000-0000-0000-0000003f2003';
  if v_portal_a is not null or v_portal_b is not null then
    raise exception 'FAIL T-h2c1-caseB-no-mirror-write: expected clients.portal_user_id to remain null on both studios'' client rows, got A=%, B=%', v_portal_a, v_portal_b;
  end if;

  raise notice 'PASS T-h2c1-caseB: same auth user claims two genuinely distinct studios in a single RPC call, both succeed independently, neither writes clients.portal_user_id';
end $$;

-- ============================================================================
-- CASE B (mirror-constraint proof) -- explicitly demonstrate that the OLD
-- approach's exact write (setting the same user into portal_user_id on
-- both studios' client rows) really would violate the still-present
-- GLOBAL clients_portal_user_id_unique index, and that both attempted
-- writes roll back together. Proves the new code succeeds specifically
-- BECAUSE it never performs these writes -- not because the constraint
-- was loosened.
--
-- Uses fresh INSERT statements (not UPDATE) for two new, disposable
-- client rows: clients_sync_portal_user_to_account_link only fires
-- AFTER UPDATE OF portal_user_id, so an INSERT that already sets
-- portal_user_id at row-creation time never invokes it. This
-- deliberately isolates the clients_portal_user_id_unique proof from an
-- unrelated, pre-existing defect discovered while writing this harness:
-- sync_client_portal_user_to_account_link's own
-- "insert ... on conflict (client_id, user_id) do update" does not
-- specify the matching partial-index WHERE clause
-- (client_account_links_client_user_unique is `where user_id is not
-- null`), so Postgres cannot infer it as the ON CONFLICT arbiter and
-- raises "no unique or exclusion constraint matching the ON CONFLICT
-- specification" for ANY direct UPDATE of clients.portal_user_id that
-- reaches that trigger's insert branch -- confirmed by reproduction,
-- independent of H2-C1, and out of this migration's scope (H2-C1 must
-- not alter unrelated triggers). Reported as a discovered issue, not
-- fixed here.
-- ============================================================================
do $$
declare
  v_unique_violation_raised boolean := false;
  v_still_set_count integer;
begin
  begin
    insert into public.clients (id, studio_id, first_name, last_name, email, status, portal_user_id) values
      ('00000000-0000-0000-0000-0000003f2010', '00000000-0000-0000-0000-0000003f0001', 'T', 'MirrorProofA', 't-h2c1-u2@example.test', 'active', '00000000-0000-0000-0000-0000003f1002');
    insert into public.clients (id, studio_id, first_name, last_name, email, status, portal_user_id) values
      ('00000000-0000-0000-0000-0000003f2011', '00000000-0000-0000-0000-0000003f0002', 'T', 'MirrorProofB', 't-h2c1-u2@example.test', 'active', '00000000-0000-0000-0000-0000003f1002');
  exception when unique_violation then
    v_unique_violation_raised := true;
  end;

  if not v_unique_violation_raised then
    raise exception 'FAIL T-h2c1-mirror-constraint-proof: expected unique_violation when inserting the same user into clients.portal_user_id on two different studios'' client rows -- clients_portal_user_id_unique may have been altered or dropped unexpectedly';
  end if;

  select count(*) into v_still_set_count
  from public.clients
  where id in ('00000000-0000-0000-0000-0000003f2010', '00000000-0000-0000-0000-0000003f2011')
    and portal_user_id is not null;
  if v_still_set_count <> 0 then
    raise exception 'FAIL T-h2c1-mirror-constraint-proof-rollback: expected both attempted inserts to roll back together after the unique_violation, but % row(s) exist with a non-null portal_user_id', v_still_set_count;
  end if;

  raise notice 'PASS T-h2c1-mirror-constraint-proof: clients_portal_user_id_unique is confirmed still present and GLOBAL -- the pre-H2-C1 implementation''s exact write would have failed for this identical two-studio scenario; H2-C1''s success above is because it never attempts this write, not because the constraint changed';
end $$;

-- ============================================================================
-- CASE C -- existing Studio A (already linked) + new Studio B claim.
-- Studio A's relationship must remain completely untouched.
-- ============================================================================
do $$
declare
  v_count integer;
  v_status_b text;
  v_user_b uuid;
  v_status_a_after text;
  v_user_a_after uuid;
  v_updated_a_after timestamptz;
  v_updated_a_before timestamptz;
begin
  select value into v_updated_a_before from t_h2c1_before_state where key = 'caseC_a';

  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1003', 't-h2c1-u3@example.test', null
  ) t;

  if v_count <> 1 then
    raise exception 'FAIL T-h2c1-caseC-count: expected exactly 1 newly-claimed row (Studio B only -- Studio A is already linked), got %', v_count;
  end if;

  select status, user_id into v_status_b, v_user_b from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3005';
  if v_status_b is distinct from 'linked' or v_user_b is distinct from '00000000-0000-0000-0000-0000003f1003'::uuid then
    raise exception 'FAIL T-h2c1-caseC-studioB: expected Studio B linked/U3, got status=%, user_id=%', v_status_b, v_user_b;
  end if;

  select status, user_id, updated_at into v_status_a_after, v_user_a_after, v_updated_a_after
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3004';

  if v_status_a_after is distinct from 'linked' or v_user_a_after is distinct from '00000000-0000-0000-0000-0000003f1003'::uuid then
    raise exception 'FAIL T-h2c1-caseC-studioA-state: expected Studio A to remain linked/U3, got status=%, user_id=%', v_status_a_after, v_user_a_after;
  end if;
  if v_updated_a_after is distinct from v_updated_a_before then
    raise exception 'FAIL T-h2c1-caseC-studioA-untouched: expected Studio A relationship row to be completely untouched (same updated_at), before=%, after=%', v_updated_a_before, v_updated_a_after;
  end if;

  raise notice 'PASS T-h2c1-caseC: a user already linked to Studio A claims Studio B without any write to the Studio A relationship row';
end $$;

-- ============================================================================
-- CASE D -- simple reconnect (same row reused by the invite flow).
-- ============================================================================
do $$
declare
  v_count integer;
  v_status text;
  v_user_id uuid;
  v_disconnected_at timestamptz;
  v_row_count integer;
begin
  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1004', 't-h2c1-u4@example.test', null
  ) t;

  if v_count <> 1 then
    raise exception 'FAIL T-h2c1-caseD-count: expected exactly 1 claimed row, got %', v_count;
  end if;

  select status, user_id, disconnected_at into v_status, v_user_id, v_disconnected_at
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3006';

  if v_status is distinct from 'linked' or v_user_id is distinct from '00000000-0000-0000-0000-0000003f1004'::uuid or v_disconnected_at is not null then
    raise exception 'FAIL T-h2c1-caseD-state: expected linked/U4/disconnected_at=null, got status=%, user_id=%, disconnected_at=%', v_status, v_user_id, v_disconnected_at;
  end if;

  select count(*) into v_row_count from public.client_account_links where client_id = '00000000-0000-0000-0000-0000003f2006';
  if v_row_count <> 1 then
    raise exception 'FAIL T-h2c1-caseD-no-duplicate: expected exactly 1 client_account_links row for this client after reconnect, got %', v_row_count;
  end if;

  raise notice 'PASS T-h2c1-caseD: a previously-disconnected relationship reconnects to linked via the same row, no duplicate created';
end $$;

-- ============================================================================
-- CASE D2 -- reconnect via a separate fresh invitation row (the
-- reconnect-merge precheck). Proves relinking reuses the pre-existing
-- historical row rather than colliding with client_account_links_client_
-- user_unique, and that the fresh invitation row is correctly superseded.
-- ============================================================================
do $$
declare
  v_count integer;
  v_returned_link_id uuid;
  v_old_status text;
  v_old_user_id uuid;
  v_old_disconnected_at timestamptz;
  v_new_status text;
  v_new_token_hash text;
  v_new_expires timestamptz;
  v_row_count integer;
begin
  select count(*), (array_agg(link_id))[1] into v_count, v_returned_link_id
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1005', 't-h2c1-u5@example.test', null
  ) t;

  if v_count <> 1 then
    raise exception 'FAIL T-h2c1-caseD2-count: expected exactly 1 claimed row, got %', v_count;
  end if;

  if v_returned_link_id is distinct from '00000000-0000-0000-0000-0000003f3007'::uuid then
    raise exception 'FAIL T-h2c1-caseD2-returned-id: expected the pre-existing historical row''s id to be returned (relink target), got %', v_returned_link_id;
  end if;

  select status, user_id, disconnected_at into v_old_status, v_old_user_id, v_old_disconnected_at
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3007';
  if v_old_status is distinct from 'linked' or v_old_user_id is distinct from '00000000-0000-0000-0000-0000003f1005'::uuid or v_old_disconnected_at is not null then
    raise exception 'FAIL T-h2c1-caseD2-old-row: expected the historical row relinked to U5, got status=%, user_id=%, disconnected_at=%', v_old_status, v_old_user_id, v_old_disconnected_at;
  end if;

  select status, invite_token_hash, invite_expires_at into v_new_status, v_new_token_hash, v_new_expires
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3008';
  if v_new_token_hash is not null or v_new_expires is not null then
    raise exception 'FAIL T-h2c1-caseD2-superseded-invite: expected the fresh invitation row''s invite fields cleared (superseded), got invite_token_hash=%, invite_expires_at=%', v_new_token_hash, v_new_expires;
  end if;

  select count(*) into v_row_count from public.client_account_links where client_id = '00000000-0000-0000-0000-0000003f2007';
  if v_row_count <> 2 then
    raise exception 'FAIL T-h2c1-caseD2-no-new-row: expected exactly the original 2 rows for this client (no third row created), got %', v_row_count;
  end if;

  raise notice 'PASS T-h2c1-caseD2: reconnect-merge relinks the pre-existing historical row (no client_account_links_client_user_unique violation) and supersedes the fresh invitation row''s invite fields instead of creating a duplicate';
end $$;

-- ============================================================================
-- CASE E -- different-user conflict: preserve the intended conflict
-- result, do not silently steal the relationship. The already-linked
-- owner's row must remain completely untouched.
-- ============================================================================
do $$
declare
  v_count integer;
  v_new_status text;
  v_new_user_id uuid;
  v_new_conflict_details text;
  v_owner_status_after text;
  v_owner_user_after uuid;
  v_owner_updated_after timestamptz;
  v_owner_updated_before timestamptz;
begin
  select value into v_owner_updated_before from t_h2c1_before_state where key = 'caseE_linked';

  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1007', 't-h2c1-u7@example.test', null
  ) t;

  if v_count <> 0 then
    raise exception 'FAIL T-h2c1-caseE-count: expected 0 claimed rows (this invitation must resolve to conflict, not linked), got %', v_count;
  end if;

  select status, user_id, conflict_details into v_new_status, v_new_user_id, v_new_conflict_details
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3010';
  -- user_id is deliberately NOT set to the existing owner (U6) here: doing
  -- so would collide with client_account_links_client_user_unique against
  -- U6's own already-linked row (id 3f3009) for this exact client_id --
  -- see the migration's discovered-constraint-gap note. status=conflict +
  -- conflict_details is the preserved signal.
  if v_new_status is distinct from 'conflict' or v_new_conflict_details is null then
    raise exception 'FAIL T-h2c1-caseE-conflict-state: expected status=conflict, conflict_details set; got status=%, user_id=%, conflict_details=%', v_new_status, v_new_user_id, v_new_conflict_details;
  end if;

  select status, user_id, updated_at into v_owner_status_after, v_owner_user_after, v_owner_updated_after
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3009';
  if v_owner_status_after is distinct from 'linked' or v_owner_user_after is distinct from '00000000-0000-0000-0000-0000003f1006'::uuid then
    raise exception 'FAIL T-h2c1-caseE-owner-state: expected the legitimate owner''s row to remain linked/U6, got status=%, user_id=%', v_owner_status_after, v_owner_user_after;
  end if;
  if v_owner_updated_after is distinct from v_owner_updated_before then
    raise exception 'FAIL T-h2c1-caseE-owner-untouched: expected the legitimate owner''s row to be completely untouched (same updated_at), before=%, after=%', v_owner_updated_before, v_owner_updated_after;
  end if;

  raise notice 'PASS T-h2c1-caseE: a different auth identity cannot silently steal an already-linked relationship -- the conflicting invitation is marked conflict, the legitimate owner''s row is untouched';
end $$;

-- ============================================================================
-- CASE F -- idempotency: re-processing an already-successfully-claimed
-- invitation (case A's) must not create duplicates or corrupt state.
-- ============================================================================
do $$
declare
  v_count integer;
  v_status text;
  v_user_id uuid;
  v_row_count integer;
begin
  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1001', 't-h2c1-u1@example.test', null
  ) t;

  if v_count <> 0 then
    raise exception 'FAIL T-h2c1-caseF-count: expected 0 rows re-claimed (already linked, no longer invited/claim_pending), got %', v_count;
  end if;

  select status, user_id into v_status, v_user_id from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3001';
  if v_status is distinct from 'linked' or v_user_id is distinct from '00000000-0000-0000-0000-0000003f1001'::uuid then
    raise exception 'FAIL T-h2c1-caseF-state: expected linked/U1 unchanged, got status=%, user_id=%', v_status, v_user_id;
  end if;

  select count(*) into v_row_count from public.client_account_links where client_id = '00000000-0000-0000-0000-0000003f2001';
  if v_row_count <> 1 then
    raise exception 'FAIL T-h2c1-caseF-no-duplicate: expected exactly 1 row for this client, got %', v_row_count;
  end if;

  raise notice 'PASS T-h2c1-caseF: repeated claim of an already-linked invitation is a safe no-op, no duplicate created';
end $$;

-- ============================================================================
-- RACE-RECONCILIATION -- exception handler audit (H2-C1 item 2 review).
--
-- T-h2c1-race-failclosed exercises the REAL exception handler end-to-end
-- via a deterministic, single-session unique_violation (no manufactured
-- concurrency needed -- see fixture comment above): proves an
-- unreconcilable violation is re-raised (fails closed) rather than
-- silently skipped, and that the failed relink leaves no row in a
-- corrupted intermediate state.
--
-- A genuine two-concurrent-transaction race cannot be manufactured safely
-- in one local session, so T-h2c1-race-reconcile-success-query and
-- T-h2c1-race-reconcile-conflict-query instead directly prove the two
-- reconciliation SELECT queries embedded in the handler (byte-for-byte
-- the same predicates) correctly identify each of the two states they
-- are meant to distinguish, against hand-built fixtures.
-- ============================================================================
do $$
declare
  v_error_caught boolean := false;
  v_returned_sqlstate text;
  v_p_status text;
  v_p_user_id uuid;
  v_q_old_status text;
  v_q_new_status text;
  v_q_new_token_hash text;
begin
  begin
    perform 1 from public.claim_client_account_invitation(
      '00000000-0000-0000-0000-0000003f1009', 't-h2c1-u9@example.test', null
    );
  exception when others then
    v_error_caught := true;
    get stacked diagnostics v_returned_sqlstate = returned_sqlstate;
  end;

  if not v_error_caught then
    raise exception 'FAIL T-h2c1-race-failclosed: expected the RPC call to fail closed when the same user holds a conflicting primary relationship on a different client in the same studio, but it completed without error';
  end if;

  if v_returned_sqlstate is distinct from '23505' then
    raise exception 'FAIL T-h2c1-race-failclosed-sqlstate: expected the re-raised exception to be the original unique_violation (23505), got %', v_returned_sqlstate;
  end if;

  select status, user_id into v_p_status, v_p_user_id from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3012';
  if v_p_status is distinct from 'linked' or v_p_user_id is distinct from '00000000-0000-0000-0000-0000003f1009'::uuid then
    raise exception 'FAIL T-h2c1-race-failclosed-p-untouched: expected Client P''s row to remain exactly linked/U9, got status=%, user_id=%', v_p_status, v_p_user_id;
  end if;

  select status into v_q_old_status from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3013';
  select status, invite_token_hash into v_q_new_status, v_q_new_token_hash from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3014';
  if v_q_old_status is distinct from 'disconnected' or v_q_new_status is distinct from 'invited' or v_q_new_token_hash is not null then
    raise exception 'FAIL T-h2c1-race-failclosed-q-rolled-back: expected Client Q''s rows to remain exactly as before the failed relink (old=disconnected, new=invited/no token), got old=%, new=%, token=%', v_q_old_status, v_q_new_status, v_q_new_token_hash;
  end if;

  raise notice 'PASS T-h2c1-race-failclosed: a genuine, unreconcilable unique_violation (same user primary on two clients in one studio) fails closed -- the exception propagates rather than being silently swallowed, and no row is left in a corrupted intermediate state';
end $$;

do $$
declare
  v_reconciled_linked_user uuid;
begin
  -- Byte-for-byte the same predicate shape as the handler's
  -- "idempotent success" reconciliation query, against Case A's own
  -- now-linked fixture (client 3f2001, user U1, already asserted linked
  -- above).
  select cal4.user_id
    into v_reconciled_linked_user
  from public.client_account_links cal4
  where cal4.client_id = '00000000-0000-0000-0000-0000003f2001'
    and cal4.studio_id = '00000000-0000-0000-0000-0000003f0001'
    and cal4.status = 'linked'
    and cal4.user_id = '00000000-0000-0000-0000-0000003f1001'
  limit 1;

  if v_reconciled_linked_user is distinct from '00000000-0000-0000-0000-0000003f1001'::uuid then
    raise exception 'FAIL T-h2c1-race-reconcile-success-query: expected the idempotent-success reconciliation query to find the intended user already linked, got %', v_reconciled_linked_user;
  end if;

  raise notice 'PASS T-h2c1-race-reconcile-success-query: the handler''s idempotent-success reconciliation query correctly identifies the intended user as already linked';
end $$;

do $$
declare
  v_reconciled_conflict_owner uuid;
begin
  -- Byte-for-byte the same predicate shape as the handler's
  -- "different-user conflict" reconciliation query, against Case E's own
  -- fixture (client 3f2008, owned by U6, already asserted untouched
  -- above) -- probed as if U7 (a different, non-owning user) were the
  -- intended claimant.
  select cal5.user_id
    into v_reconciled_conflict_owner
  from public.client_account_links cal5
  where cal5.client_id = '00000000-0000-0000-0000-0000003f2008'
    and cal5.studio_id = '00000000-0000-0000-0000-0000003f0001'
    and cal5.status = 'linked'
    and cal5.user_id is distinct from '00000000-0000-0000-0000-0000003f1007'::uuid
  order by cal5.is_primary desc nulls last, cal5.created_at asc
  limit 1;

  if v_reconciled_conflict_owner is distinct from '00000000-0000-0000-0000-0000003f1006'::uuid then
    raise exception 'FAIL T-h2c1-race-reconcile-conflict-query: expected the conflict reconciliation query to find U6 as the legitimate owner, got %', v_reconciled_conflict_owner;
  end if;

  raise notice 'PASS T-h2c1-race-reconcile-conflict-query: the handler''s conflict reconciliation query correctly identifies a different auth identity as the legitimate owner';
end $$;

-- ============================================================================
-- CASE I -- sentinel/unrelated relationship row must be completely
-- untouched by every case above.
-- ============================================================================
do $$
declare
  v_sentinel_status text;
  v_sentinel_user uuid;
  v_sentinel_updated_after timestamptz;
  v_sentinel_updated_before timestamptz;
begin
  select value into v_sentinel_updated_before from t_h2c1_before_state where key = 'sentinel';

  select status, user_id, updated_at into v_sentinel_status, v_sentinel_user, v_sentinel_updated_after
  from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3011';

  if v_sentinel_status is distinct from 'linked' or v_sentinel_user is distinct from '00000000-0000-0000-0000-0000003f1008'::uuid then
    raise exception 'FAIL T-h2c1-caseI-state: expected sentinel row to remain linked/U8, got status=%, user_id=%', v_sentinel_status, v_sentinel_user;
  end if;
  if v_sentinel_updated_after is distinct from v_sentinel_updated_before then
    raise exception 'FAIL T-h2c1-caseI-untouched: expected sentinel row to be completely untouched (same updated_at), before=%, after=%', v_sentinel_updated_before, v_sentinel_updated_after;
  end if;

  raise notice 'PASS T-h2c1-caseI: an unrelated relationship row is untouched by every claim/conflict/reconnect case above';
end $$;

-- ============================================================================
-- PRIVILEGE / SECURITY -- H2-C1 grant hardening (security audit:
-- GRANT HARDENING REQUIRED). anon and authenticated must have zero
-- EXECUTE on this function; service_role must retain it. Catalog checks
-- first, then real behavioral probes proving denial happens BEFORE any
-- relationship state changes (not merely that the catalog says so).
-- ============================================================================
do $$
declare
  v_anon_exec boolean;
  v_authenticated_exec boolean;
  v_service_role_exec boolean;
begin
  select has_function_privilege('anon', 'public.claim_client_account_invitation(uuid,text,uuid)', 'EXECUTE') into v_anon_exec;
  select has_function_privilege('authenticated', 'public.claim_client_account_invitation(uuid,text,uuid)', 'EXECUTE') into v_authenticated_exec;
  select has_function_privilege('service_role', 'public.claim_client_account_invitation(uuid,text,uuid)', 'EXECUTE') into v_service_role_exec;

  if v_anon_exec is distinct from false then
    raise exception 'FAIL T-h2c1-priv-anon-denied: expected anon to have NO execute privilege, got %', v_anon_exec;
  end if;
  if v_authenticated_exec is distinct from false then
    raise exception 'FAIL T-h2c1-priv-authenticated-denied: expected authenticated to have NO execute privilege, got %', v_authenticated_exec;
  end if;
  if v_service_role_exec is distinct from true then
    raise exception 'FAIL T-h2c1-priv-service-role-granted: expected service_role to have execute privilege, got %', v_service_role_exec;
  end if;

  raise notice 'PASS T-h2c1-priv-catalog: anon=denied, authenticated=denied, service_role=granted, matching the intended H2-C1 hardened contract';
end $$;

-- Anon/authenticated LIVE behavioral denial probes -- NOT included as
-- repeatable assertions in this file. While hardening this migration,
-- attempting `set local role anon;` (and separately `set local role
-- authenticated;`) followed by any invocation of this function --
-- including a bare top-level `select * from
-- claim_client_account_invitation(...)` with no PL/pgSQL wrapping at all
-- -- reliably crashes this local Postgres 17.6 instance ("server closed
-- the connection unexpectedly" / "database system was not properly shut
-- down; automatic recovery in progress" in the container logs) at the
-- exact point the engine would raise the permission-denied error for
-- this SECURITY DEFINER function under a switched role. Reproduced three
-- separate ways (inside this harness's own nested exception block,
-- inside an isolated nested exception block, and as a bare top-level
-- statement with no PL/pgSQL at all) -- all three crash identically, so
-- this is not an artifact of this file's structure. This is the same
-- class of local-environment-only SIGSEGV finding already documented
-- earlier in this project's history for a different SECURITY DEFINER
-- function (the H2-B1 portal-access helper, under `set local role
-- anon`), not a new defect and not something introduced by this
-- hardening -- it is the act of denying the call that triggers it, and
-- it is specific to this local Docker Postgres build (not expected on
-- hosted Supabase Postgres, a different build). Embedding either probe
-- as a repeatable assertion here would crash this entire suite on every
-- future run, so neither is included as automated harness coverage.
--
-- Verified instead via isolated, manual, non-committed reproduction
-- (three times, each in its own disposable begin/rollback transaction,
-- against synthetic-only fixtures, crash-recovered cleanly with zero
-- persisted state each time -- confirmed via has_function_privilege and
-- direct row inspection immediately after each recovery): the crash
-- occurs specifically when EXECUTE is absent for the calling role (i.e.
-- it is consistent with, not contrary to, the intended denial -- the
-- same call as service_role, or as anon/authenticated before this
-- hardening was applied, completes normally with no crash, per the
-- probes immediately below and the pre-hardening adversarial audit).
-- T-h2c1-priv-catalog (above) remains the durable, repeatable proof that
-- anon/authenticated hold no EXECUTE privilege at all.

-- Service-role behavioral probe: the real application's own invocation
-- shape (src/lib/auth/portal-linking.ts's admin.rpc call) must still
-- succeed normally after hardening.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000003f1014', 't-h2c1-serviceroleprobe@example.test');
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000003f1014', 't-h2c1-serviceroleprobe@example.test');
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000003f2018', '00000000-0000-0000-0000-0000003f0001', 'T', 'ServiceRoleProbe', 't-h2c1-serviceroleprobe@example.test', 'active');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by, invited_email, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000003f3019', '00000000-0000-0000-0000-0000003f0001', '00000000-0000-0000-0000-0000003f2018', null, 'invited', 'self', 'studio', 't-h2c1-serviceroleprobe@example.test', now(), now());

do $$
declare
  v_count integer;
  v_status_after text;
  v_user_after uuid;
begin
  set local role service_role;
  select count(*) into v_count
  from public.claim_client_account_invitation(
    '00000000-0000-0000-0000-0000003f1014', 't-h2c1-serviceroleprobe@example.test', null
  ) t;
  reset role;

  if v_count <> 1 then
    raise exception 'FAIL T-h2c1-service-role-probe-count: expected the legitimate service_role invocation to succeed, got % rows', v_count;
  end if;

  select status, user_id into v_status_after, v_user_after from public.client_account_links where id = '00000000-0000-0000-0000-0000003f3019';
  if v_status_after is distinct from 'linked' or v_user_after is distinct from '00000000-0000-0000-0000-0000003f1014'::uuid then
    raise exception 'FAIL T-h2c1-service-role-probe-state: expected linked/the legitimate user, got status=%, user_id=%', v_status_after, v_user_after;
  end if;

  raise notice 'PASS T-h2c1-service-role-probe: the real application''s legitimate service_role invocation shape still succeeds normally after grant hardening';
end $$;

rollback;
