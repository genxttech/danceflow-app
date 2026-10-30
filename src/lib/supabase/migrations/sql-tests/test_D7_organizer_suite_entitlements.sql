-- SQL tests for 20270203090000_organizer_suite_entitlement_integrity.sql and 20270203100000_usage_addon_entitlements_least_privilege.sql.
-- Disposable, isolated PROD-equivalent Postgres ONLY (scripts/qa/iso-qa.mjs baseline). Never run against a hosted database.
-- Stack: baseline (cutoff 20261119092100) + origin/main 20270202090000 + 20270202100000 (#360, apply_studio_subscription_state),
-- WITHOUT the two D7 migrations (this script applies, rolls back and re-applies them itself). Section L exercises the #360 RPC.
-- Expects the four files copied into the container as:
--   /tmp/m1_up.sql /tmp/m1_down.sql /tmp/m2_up.sql /tmp/m2_down.sql
-- Run: psql -U postgres -d postgres -f /tmp/test_D7_organizer_suite_entitlements.sql
-- Uses psql \! to open a second session (concurrency test) inside the same container.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

-- ---------- harness ----------
create function public.t_expect_fail(p_role text, p_sql text, p_like text) returns void language plpgsql as $f$
declare v_failed boolean := false; v_msg text;
begin
  begin
    execute 'set local role ' || quote_ident(p_role);
    execute p_sql;
  exception when others then v_failed := true; v_msg := sqlerrm;
  end;
  execute 'reset role';
  if not v_failed then raise exception 'FAIL (no error): [%] %', p_role, p_sql; end if;
  if v_msg not like p_like then raise exception 'FAIL (wrong error "%" not like "%"): %', v_msg, p_like, p_sql; end if;
  raise notice 'PASS fail-expected [%] %', p_role, v_msg;
end $f$;

create function public.t_expect_ok(p_role text, p_sql text) returns void language plpgsql as $f$
begin
  execute 'set local role ' || quote_ident(p_role);
  execute p_sql;
  execute 'reset role';
  raise notice 'PASS ok [%] %', p_role, left(p_sql, 90);
end $f$;

create function public.t_assert(p_cond boolean, p_label text) returns void language plpgsql as $f$
begin
  if p_cond is not true then raise exception 'FAIL assert: %', p_label; end if;
  raise notice 'PASS assert: %', p_label;
end $f$;

-- Row count visible to p_role (optionally as JWT user p_uid) for a SELECT.
create function public.t_count_as(p_role text, p_uid text, p_sql text) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'set local role ' || quote_ident(p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute 'select count(*) from (' || p_sql || ') x' into v;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $f$;

-- Rows affected by a DML statement run as p_role (optionally as JWT user p_uid).
create function public.t_rows_as(p_role text, p_uid text, p_sql text) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'set local role ' || quote_ident(p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute p_sql;
  get diagnostics v = row_count;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return v;
end $f$;

-- Calls the expiry function as service_role and returns how many rows it expired.
create function public.t_expire(p_as_of timestamptz, p_feature text default 'organizer_suite') returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'set local role service_role';
  select count(*) into v from public.expire_due_usage_addon_entitlements(p_as_of, p_feature);
  execute 'reset role';
  return v;
end $f$;

create function public.t_ev(p_ent uuid, p_type text) returns bigint language plpgsql as $f$
begin
  return (select count(*) from public.usage_addon_entitlement_events where entitlement_id = p_ent and (p_type is null or event_type = p_type));
end $f$;

-- Calls the #360 SECURITY DEFINER RPC as service_role (same subscription id every time).
create function public.t_apply(p_studio uuid, p_read timestamptz, p_status text, p_addon jsonb) returns text language plpgsql as $f$
declare v text;
begin
  execute 'set local role service_role';
  v := public.apply_studio_subscription_state(p_studio,
    jsonb_build_object('stripe_subscription_id', 'sub_d7_rpc', 'status', p_status, 'billing_interval', 'month', 'cancel_at_period_end', false),
    p_read,
    jsonb_build_object('stripe_customer_id', 'cus_d7_rpc', 'stripe_subscription_id', 'sub_d7_rpc', 'subscription_status', p_status),
    p_addon);
  execute 'reset role';
  return v;
end $f$;

create function public.t_acl() returns text language sql as $f$
  select relacl::text from pg_class where oid = 'public.usage_addon_entitlements'::regclass;
$f$;

-- ---------- seed: PROD-like state ----------
\echo === 0: seed PROD-like state (2 active manual_grant organizer_suite rows, two studios, no stripe item, no period_end)
insert into auth.users (id) values ('a7000000-0000-0000-0000-00000000000a'), ('b7000000-0000-0000-0000-00000000000b');
insert into public.profiles (id) values ('a7000000-0000-0000-0000-00000000000a'), ('b7000000-0000-0000-0000-00000000000b');
insert into public.studios (id, name, slug, timezone) values
  ('d7000000-0000-0000-0000-000000000001', 'd7 s1 new york', 'd7-s1', 'America/New_York'),
  ('d7000000-0000-0000-0000-000000000002', 'd7 s2 blank tz', 'd7-s2', ''),
  ('d7000000-0000-0000-0000-000000000003', 'd7 s3 bad tz', 'd7-s3', 'Not/AZone'),
  ('d7000000-0000-0000-0000-000000000004', 'd7 s4 utc', 'd7-s4', 'UTC'),
  ('d7000000-0000-0000-0000-000000000005', 'd7 s5 stripe', 'd7-s5', 'UTC'),
  ('d7000000-0000-0000-0000-000000000006', 'd7 s6 auckland', 'd7-s6', 'Pacific/Auckland'),
  ('d7000000-0000-0000-0000-000000000007', 'd7 s7 delete', 'd7-s7', 'UTC'),
  ('d7000000-0000-0000-0000-000000000008', 'd7 s8 rpc', 'd7-s8', 'America/New_York'),
  ('d7000000-0000-0000-0000-000000000009', 'd7 s9 svc delete', 'd7-s9', 'UTC');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('a7000000-0000-0000-0000-00000000000a', 'd7000000-0000-0000-0000-000000000001', 'studio_owner', true);
insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values
  ('e7000000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000001', 'studio', 'organizer_suite', 1, 'manual_grant', 'active'),
  ('e7000000-0000-0000-0000-000000000002', 'd7000000-0000-0000-0000-000000000002', 'studio', 'organizer_suite', 1, 'manual_grant', 'active');
create table public.t_prod_like_snapshot as select * from public.usage_addon_entitlements;
select t_acl() as acl_before \gset
\echo prior ACL: :acl_before
select public.t_assert(:'acl_before' = '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}', 'baseline ACL is the PROD ACL (full privileges for anon/authenticated/service_role)');

-- ---------- P: precondition guard refuses duplicate active manual grants ----------
\echo === P: precondition guard (a duplicate active manual_grant blocks the migration)
insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values
  ('e7000000-0000-0000-0000-0000000000ff', 'd7000000-0000-0000-0000-000000000001', 'studio', 'organizer_suite', 1, 'manual_grant', 'active');
\echo EXPECTED ERROR follows (precondition)
\set ON_ERROR_STOP off
\i /tmp/m1_up.sql
\set ON_ERROR_STOP on
rollback;
select public.t_assert(to_regclass('public.usage_addon_entitlement_events') is null and to_regclass('public.usage_addon_entitlements_one_active_manual_grant_studio') is null, 'precondition failure applied nothing');
delete from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-0000000000ff';

-- ---------- A: apply from PROD-like state ----------
\echo === A: apply migration 1 from the PROD-like state
\i /tmp/m1_up.sql
select public.t_assert(to_regclass('public.usage_addon_entitlement_events') is not null, 'events table exists');
select public.t_assert(to_regclass('public.usage_addon_entitlements_one_active_manual_grant_studio') is not null and to_regclass('public.usage_addon_entitlements_one_active_manual_grant_organizer') is not null, 'both partial unique indexes exist');
select public.t_assert(not exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'public.usage_addon_entitlements'::regclass and i.indisunique and i.indpred is null and pg_get_indexdef(i.indexrelid) like '%(studio_id, feature_key)%'), 'no plain unique index on (studio_id, feature_key)');
select public.t_assert((select relrowsecurity from pg_class where oid = 'public.usage_addon_entitlement_events'::regclass), 'events RLS enabled');
select public.t_assert(not exists (select 1 from pg_policies where tablename = 'usage_addon_entitlement_events'), 'events has no policies');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = 0, 'migration wrote no events (no backfill)');
select public.t_assert((select count(*) from public.usage_addon_entitlements) = 2 and not exists (select * from public.t_prod_like_snapshot except select * from public.usage_addon_entitlements), 'PROD-like rows unchanged by the migration');
select public.t_assert(not exists (select 1 from pg_constraint where conrelid = 'public.usage_addon_entitlement_events'::regclass and contype = 'f'), 'events table has no FK (evidence survives deletes)');
select public.t_assert((select prosecdef from pg_proc where oid = 'public.usage_addon_entitlements_audit()'::regprocedure) = false, 'audit trigger function is SECURITY INVOKER');
select public.t_assert((select prosecdef from pg_proc where oid = 'public.expire_due_usage_addon_entitlements(timestamptz,text)'::regprocedure) = false, 'expire function is SECURITY INVOKER');
select public.t_assert((select proconfig::text from pg_proc where oid = 'public.usage_addon_entitlements_audit()'::regprocedure) like '%search_path=pg_catalog, public, pg_temp%', 'audit trigger function has a fixed search_path');
-- (d) object owners after apply
select public.t_assert((select pg_get_userbyid(relowner) from pg_class where oid = 'public.usage_addon_entitlement_events'::regclass) = 'postgres', 'events table owner is postgres');
select public.t_assert((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('usage_addon_entitlements_audit', 'usage_addon_entitlement_events_guard', 'usage_addon_entitlement_safe_timezone', 'usage_addon_entitlement_end_instant', 'usage_addon_entitlement_start_instant', 'usage_addon_entitlement_is_current', 'expire_due_usage_addon_entitlements') and pg_get_userbyid(proowner) = 'postgres') = 7, 'all 7 migration-1 functions owned by postgres');
select public.t_assert((select count(*) from pg_class where relname in ('usage_addon_entitlements_one_active_manual_grant_studio', 'usage_addon_entitlements_one_active_manual_grant_organizer', 'usage_addon_entitlement_events_entitlement_idx', 'usage_addon_entitlement_events_studio_idx') and pg_get_userbyid(relowner) = 'postgres') = 4, 'all 4 migration-1 indexes owned by postgres');
select public.t_assert((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.apply_studio_subscription_state(uuid,jsonb,timestamptz,jsonb,jsonb)'::regprocedure) = 'postgres' and (select prosecdef from pg_proc where oid = 'public.apply_studio_subscription_state(uuid,jsonb,timestamptz,jsonb,jsonb)'::regprocedure), '#360 RPC present: SECURITY DEFINER owned by postgres (unchanged by D7)');

\echo === B: idempotent re-apply of migration 1
\i /tmp/m1_up.sql
select public.t_assert((select count(*) from pg_trigger where tgrelid = 'public.usage_addon_entitlements'::regclass and tgname = 'usage_addon_entitlements_audit_trg') = 1, 'single audit trigger after re-apply');

\echo === C: full forward/rollback/forward cycle while no events exist
\i /tmp/m2_up.sql
\i /tmp/m2_down.sql
select public.t_assert(t_acl() = :'acl_before', 'privilege rollback restores the prior ACL exactly');
select public.t_assert(current_setting('server_version_num')::int >= 170000 and has_table_privilege('service_role', 'public.usage_addon_entitlements', 'maintain'), 'PG17+: privilege rollback re-granted MAINTAIN (version-gated branch taken)');
\i /tmp/m1_down.sql
select public.t_assert(to_regclass('public.usage_addon_entitlement_events') is null and to_regprocedure('public.expire_due_usage_addon_entitlements(timestamptz,text)') is null and to_regprocedure('public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)') is null and to_regprocedure('public.usage_addon_entitlements_audit()') is null and to_regprocedure('public.usage_addon_entitlement_end_instant(date,text)') is null and to_regclass('public.usage_addon_entitlements_one_active_manual_grant_studio') is null, 'rollback (empty) removed all migration-1 objects');
select public.t_assert(not exists (select 1 from pg_trigger where tgrelid = 'public.usage_addon_entitlements'::regclass and not tgisinternal), 'no user trigger left on entitlements');
select public.t_assert((select count(*) from public.usage_addon_entitlements) = 2, 'rollback kept entitlement rows');
\i /tmp/m1_down.sql
select public.t_assert(true, 'rollback of migration 1 is re-runnable when already rolled back');
\i /tmp/m1_up.sql
\i /tmp/m2_up.sql
\i /tmp/m2_up.sql
select public.t_assert(t_acl() = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arw/postgres}', 'least-privilege ACL exact after forward (and idempotent re-apply)');
\i /tmp/m2_down.sql
select public.t_assert(t_acl() = :'acl_before', 'second privilege rollback restores the prior ACL exactly');

-- ---------- D: RLS behaviour before migration 2 (only RLS stops authenticated writes) ----------
\echo === D: authenticated writes before migration 2 are stopped by RLS
select public.t_expect_fail('authenticated', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included, source) values ('d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'manual_grant')$$, '%row-level security%');
select public.t_assert(t_rows_as('authenticated', 'a7000000-0000-0000-0000-00000000000a', $$update public.usage_addon_entitlements set status = 'expired'$$) = 0, 'authenticated update touches 0 rows (no update policy)');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = 0, 'no events from RLS-blocked writes');
\i /tmp/m2_up.sql

-- ---------- E: coexistence ----------
\echo === E: coexistence of a manual grant and Stripe rows
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('e7000000-0000-0000-0000-000000000011','d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'stripe_subscription_item','si_d7_s1','active')$$);
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('e7000000-0000-0000-0000-000000000012','d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'stripe_subscription_item','si_d7_s1b','canceled')$$);
select public.t_assert((select count(*) from public.usage_addon_entitlements where studio_id = 'd7000000-0000-0000-0000-000000000001' and feature_key = 'organizer_suite') = 3, 'manual grant + two Stripe rows coexist for the same studio and feature');
select public.t_expect_fail('service_role', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included, source, status) values ('d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'manual_grant','active')$$, '%usage_addon_entitlements_one_active_manual_grant_studio%');
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values ('e7000000-0000-0000-0000-000000000013','d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'manual_grant','canceled')$$);
select public.t_assert(true, 'historical (canceled) manual grant allowed next to the active one');
select public.t_expect_fail('service_role', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('d7000000-0000-0000-0000-000000000005','studio','organizer_suite',1,'stripe_subscription_item','si_d7_s1','active')$$, '%duplicate key%');
select public.t_expect_fail('service_role', $$update public.usage_addon_entitlements set status = 'active' where id = 'e7000000-0000-0000-0000-000000000013'$$, '%one_active_manual_grant_studio%');
insert into public.organizers (id, studio_id, name, slug) values ('0d700000-0000-0000-0000-000000000001', 'd7000000-0000-0000-0000-000000000004', 'd7 org', 'd7-org');
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, organizer_id, workspace_type, feature_key, quantity_included, source, status) values ('e7000000-0000-0000-0000-000000000031','0d700000-0000-0000-0000-000000000001','organizer','organizer_suite',1,'manual_grant','active')$$);
select public.t_expect_fail('service_role', $$insert into public.usage_addon_entitlements (organizer_id, workspace_type, feature_key, quantity_included, source, status) values ('0d700000-0000-0000-0000-000000000001','organizer','organizer_suite',1,'manual_grant','active')$$, '%one_active_manual_grant_organizer%');
select public.t_expect_fail('service_role', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('d7000000-0000-0000-0000-000000000005','studio','organizer_suite',1,'stripe_subscription_item','si_new','active') on conflict (studio_id, feature_key) do nothing$$, '%no unique or exclusion constraint matching%');
select public.t_assert(true, 'upsert onConflict (studio_id, feature_key) still has no matching constraint (app must use stripe_subscription_item_id)');
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('d7000000-0000-0000-0000-000000000001','studio','organizer_suite',1,'stripe_subscription_item','si_d7_s1','active') on conflict (stripe_subscription_item_id) do update set status = excluded.status$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000011', null) = 1, 'retried Stripe upsert on stripe_subscription_item_id with no change writes no extra event');

-- ---------- F: audit ----------
\echo === F: audit trigger
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000011', 'insert') = 1, 'insert event written');
select public.t_assert((select actor = 'service_role' and reason is null and to_status = 'active' and to_source = 'stripe_subscription_item' and to_stripe_subscription_item_id = 'si_d7_s1' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000011'), 'insert event snapshot correct; actor defaults to current_user');
begin;
set local role service_role;
select set_config('app.entitlement_reason', 'owner approved DanceAbel complimentary end date', true);
select set_config('app.entitlement_actor', 'owner:test', true);
update public.usage_addon_entitlements set period_end = '2027-07-09' where id = 'e7000000-0000-0000-0000-000000000001';
commit;
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000001', 'period_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000001', null) = 1, 'period_end change wrote exactly one period_change event');
select public.t_assert((select from_period_end is null and to_period_end = '2027-07-09' and reason = 'owner approved DanceAbel complimentary end date' and actor = 'owner:test' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000001'), 'reason and actor taken from transaction-local settings');
select public.t_assert(current_setting('app.entitlement_reason', true) is null or current_setting('app.entitlement_reason', true) = '', 'reason setting did not leak past the transaction');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set status = status, period_end = period_end, source = source where id = 'e7000000-0000-0000-0000-000000000001'$$);
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set notes = 'note only', updated_at = now() where id = 'e7000000-0000-0000-0000-000000000001'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000001', null) = 1, 'no-op and notes/updated_at-only updates write no event');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set status = 'canceled', period_end = '2027-08-01' where id = 'e7000000-0000-0000-0000-000000000012'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000012', 'status_change') = 0 and public.t_ev('e7000000-0000-0000-0000-000000000012', 'period_change') = 1, 'unchanged status not audited; period change audited');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set status = 'expired', quantity_included = 2, stripe_subscription_item_id = 'si_d7_s1c', source = 'stripe_subscription_item_x' where id = 'e7000000-0000-0000-0000-000000000012'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000012', 'status_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000012', 'quantity_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000012', 'stripe_item_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000012', 'source_change') = 1, 'one event per changed column group (status, quantity, stripe item, source)');
select public.t_assert((select from_status = 'canceled' and to_status = 'expired' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000012' and event_type = 'status_change'), 'status_change from/to correct');
-- delete evidence: the owner (postgres) can still delete a row (service_role cannot, see H); the event survives.
insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values
  ('e7000000-0000-0000-0000-000000000071', 'd7000000-0000-0000-0000-000000000007', 'studio', 'organizer_suite', 1, 'manual_grant', 'active');
delete from public.studios where id = 'd7000000-0000-0000-0000-000000000007';
select public.t_assert(not exists (select 1 from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000071') and public.t_ev('e7000000-0000-0000-0000-000000000071', 'insert') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000071', 'delete') = 1, 'studio cascade delete recorded as a delete event; evidence survives without FK');
select public.t_assert((select actor = 'postgres' and reason is null from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000071' and event_type = 'delete'), 'owner-session cascade delete: actor postgres, no default reason (same role)');
-- identity changes (studio_id, organizer_id, workspace_type, feature_key)
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values ('e7000000-0000-0000-0000-000000000081','d7000000-0000-0000-0000-000000000004','studio','identity_test',1,'manual_grant','canceled')$$);
select public.t_assert((select to_workspace_type = 'studio' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000081' and event_type = 'insert'), 'insert event records workspace_type');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set studio_id = 'd7000000-0000-0000-0000-000000000005' where id = 'e7000000-0000-0000-0000-000000000081'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000081', 'identity_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000081', null) = 2, 'studio_id move wrote exactly one identity_change event');
select public.t_assert((select from_studio_id = 'd7000000-0000-0000-0000-000000000004' and to_studio_id = 'd7000000-0000-0000-0000-000000000005' and studio_id = 'd7000000-0000-0000-0000-000000000005' and from_feature_key = 'identity_test' and to_feature_key = 'identity_test' and actor = 'service_role' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000081' and event_type = 'identity_change'), 'identity_change from/to studio correct; snapshot holds the new studio');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set studio_id = null, organizer_id = '0d700000-0000-0000-0000-000000000001', workspace_type = 'organizer' where id = 'e7000000-0000-0000-0000-000000000081'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000081', 'identity_change') = 2 and public.t_ev('e7000000-0000-0000-0000-000000000081', null) = 3, 'studio->organizer workspace move wrote exactly one more identity_change event');
select public.t_assert((select from_studio_id = 'd7000000-0000-0000-0000-000000000005' and to_studio_id is null and from_organizer_id is null and to_organizer_id = '0d700000-0000-0000-0000-000000000001' and from_workspace_type = 'studio' and to_workspace_type = 'organizer' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000081' and event_type = 'identity_change' and to_workspace_type = 'organizer'), 'organizer/workspace_type from/to correct');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set feature_key = 'identity_test_2', status = 'expired' where id = 'e7000000-0000-0000-0000-000000000081'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000081', 'identity_change') = 3 and public.t_ev('e7000000-0000-0000-0000-000000000081', 'status_change') = 1 and public.t_ev('e7000000-0000-0000-0000-000000000081', null) = 5, 'feature_key + status change: one identity_change and one status_change');
select public.t_assert((select from_feature_key = 'identity_test' and to_feature_key = 'identity_test_2' and feature_key = 'identity_test_2' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000081' and event_type = 'identity_change' and to_feature_key = 'identity_test_2'), 'feature_key from/to correct');
select public.t_expect_ok('service_role', $$update public.usage_addon_entitlements set studio_id = studio_id, organizer_id = organizer_id, workspace_type = workspace_type, feature_key = feature_key where id = 'e7000000-0000-0000-0000-000000000081'$$);
select public.t_assert(public.t_ev('e7000000-0000-0000-0000-000000000081', null) = 5, 'no-op identity update writes no event');
-- append-only
select public.t_expect_fail('postgres', $$update public.usage_addon_entitlement_events set reason = 'x'$$, '%append-only%');
select public.t_expect_fail('postgres', $$delete from public.usage_addon_entitlement_events$$, '%append-only%');
select public.t_expect_fail('postgres', $$truncate public.usage_addon_entitlement_events$$, '%append-only%');
select public.t_expect_fail('service_role', $$update public.usage_addon_entitlement_events set reason = 'x'$$, 'permission denied%');
select public.t_expect_fail('service_role', $$delete from public.usage_addon_entitlement_events$$, 'permission denied%');
select public.t_expect_fail('service_role', $$truncate public.usage_addon_entitlement_events$$, 'permission denied%');
select public.t_expect_fail('authenticated', $$select * from public.usage_addon_entitlement_events$$, 'permission denied%');
select public.t_expect_fail('anon', $$select * from public.usage_addon_entitlement_events$$, 'permission denied%');
select public.t_expect_fail('authenticated', $$insert into public.usage_addon_entitlement_events (entitlement_id, feature_key, event_type, actor) values (gen_random_uuid(), 'organizer_suite', 'insert', 'forged')$$, 'permission denied%');
select public.t_assert(public.t_count_as('service_role', null, 'select * from public.usage_addon_entitlement_events') > 0, 'service_role can read events');
select public.t_assert(has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'select') and has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'insert') and not has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'update') and not has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'delete') and not has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'truncate') and not has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'trigger') and not has_table_privilege('service_role', 'public.usage_addon_entitlement_events', 'references'), 'events: service_role select+insert only');
select public.t_assert(not has_table_privilege('anon', 'public.usage_addon_entitlement_events', 'select,insert,update,delete,truncate,references,trigger') and not has_table_privilege('authenticated', 'public.usage_addon_entitlement_events', 'select,insert,update,delete,truncate,references,trigger'), 'events: no anon/authenticated privilege');

-- ---------- G: is_current truth table ----------
\echo === G: is_current / boundary truth table
select public.t_assert(public.usage_addon_entitlement_is_current('active', null, null, 'UTC', '2030-01-01 00:00+00'), 'active, no dates: current');
select public.t_assert(not public.usage_addon_entitlement_is_current('expired', null, null, 'UTC', now()), 'expired: not current');
select public.t_assert(not public.usage_addon_entitlement_is_current('canceled', null, null, 'UTC', now()), 'canceled: not current');
select public.t_assert(not public.usage_addon_entitlement_is_current(null, null, null, 'UTC', now()), 'null status: not current');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, null, 'UTC', null), 'null instant: not current');
select public.t_assert(public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'UTC', '2027-07-08 23:59:59.999999+00'), 'UTC: last microsecond of 2027-07-08 still current');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'UTC', '2027-07-09 00:00:00+00'), 'UTC: exclusive end at 2027-07-09 00:00Z');
select public.t_assert(public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'America/New_York', '2027-07-09 03:59:59+00'), 'New York: 2027-07-08 23:59:59 EDT still current');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'America/New_York', '2027-07-09 04:00:00+00'), 'New York: ends 2027-07-09 00:00 EDT (04:00Z)');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'Pacific/Auckland', '2027-07-08 12:00:00+00'), 'Auckland: ends 2027-07-08 12:00Z (NZST +12)');
select public.t_assert(public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'Pacific/Auckland', '2027-07-08 11:59:59+00'), 'Auckland: current until 11:59:59Z');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, '2027-07-09', null, '2027-07-09 00:00:00+00') and public.usage_addon_entitlement_is_current('active', null, '2027-07-09', null, '2027-07-08 23:59:59+00'), 'NULL timezone falls back to UTC');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'Not/AZone', '2027-07-09 00:00:00+00') and public.usage_addon_entitlement_is_current('active', null, '2027-07-09', 'Not/AZone', '2027-07-08 23:59:59+00'), 'invalid timezone falls back to UTC (no error)');
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-07-09', '') = '2027-07-09 00:00+00' and public.usage_addon_entitlement_end_instant('2027-07-09', '+05') = '2027-07-09 00:00+00' and public.usage_addon_entitlement_end_instant('2027-07-09', 'EST5EDT; drop table x') = '2027-07-09 00:00+00', 'blank, POSIX offset and junk timezone strings fall back to UTC');
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-07-09', 'america/new_york') = '2027-07-09 04:00+00', 'timezone name matched case-insensitively');
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-01-09', 'America/New_York') = '2027-01-09 05:00+00', 'New York winter (EST) end instant 05:00Z');
select public.t_assert(public.usage_addon_entitlement_end_instant(null, 'UTC') is null, 'null period_end: no end instant');
-- (c) DST transitions AT local midnight (the day's 00:00 does not exist, or occurs twice)
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-03-14', 'America/Havana') = '2027-03-14 05:00+00', 'Havana 2027-03-14 (spring-forward gap at 00:00): end instant 05:00Z');
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-11-07', 'America/Havana') = '2027-11-07 05:00+00', 'Havana 2027-11-07 (fall-back, 00:00 occurs twice): end instant 05:00Z');
select public.t_assert(public.usage_addon_entitlement_end_instant('2027-09-05', 'America/Santiago') = '2027-09-05 04:00+00', 'Santiago 2027-09-05 (spring-forward gap at 00:00): end instant 04:00Z');
select public.t_assert(public.usage_addon_entitlement_is_current('active', null, '2027-03-14', 'America/Havana', '2027-03-14 04:59:59+00') and not public.usage_addon_entitlement_is_current('active', null, '2027-03-14', 'America/Havana', '2027-03-14 05:00:00+00'), 'Havana gap: current until 04:59:59Z, ended at 05:00Z');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', '2027-01-01', null, 'UTC', '2026-12-31 23:59:59+00') and public.usage_addon_entitlement_is_current('active', '2027-01-01', null, 'UTC', '2027-01-01 00:00:00+00'), 'period_start inclusive from the start of its day');
select public.t_assert(not public.usage_addon_entitlement_is_current('active', '2027-07-09', '2027-07-09', 'UTC', '2027-07-09 00:00:00+00'), 'start = end: empty window');
select public.t_assert(not has_function_privilege('anon', 'public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)', 'execute') and has_function_privilege('authenticated', 'public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)', 'execute') and has_function_privilege('service_role', 'public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)', 'execute'), 'is_current EXECUTE: authenticated + service_role, not anon');

-- ---------- H: expiry ----------
\echo === H: expire_due_usage_addon_entitlements
-- E1 (New York, period_end 2027-07-09, set in F), E2 (blank tz), E3 (invalid tz), E4 (UTC, NULL period_end), E6 (Auckland), E5 (Stripe, past period_end)
begin;
set local role service_role;
select set_config('app.entitlement_reason', 'test setup: owner-approved end dates', true);
update public.usage_addon_entitlements set period_end = '2027-07-09' where id = 'e7000000-0000-0000-0000-000000000002';
insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status, period_start, period_end) values
  ('e7000000-0000-0000-0000-000000000003', 'd7000000-0000-0000-0000-000000000003', 'studio', 'organizer_suite', 1, 'manual_grant', 'active', '2026-07-09', '2027-07-09'),
  ('e7000000-0000-0000-0000-000000000004', 'd7000000-0000-0000-0000-000000000004', 'studio', 'organizer_suite', 1, 'manual_grant', 'active', null, null),
  ('e7000000-0000-0000-0000-000000000006', 'd7000000-0000-0000-0000-000000000006', 'studio', 'organizer_suite', 1, 'manual_grant', 'active', null, '2027-07-09'),
  ('e7000000-0000-0000-0000-000000000005', 'd7000000-0000-0000-0000-000000000005', 'studio', 'organizer_suite', 1, 'stripe_subscription_item', 'active', '2026-01-01', '2027-01-01'),
  ('e7000000-0000-0000-0000-000000000051', 'd7000000-0000-0000-0000-000000000005', 'studio', 'ai_action', 100, 'manual_grant', 'active', null, '2027-01-01');
commit;
create table public.t_pre_expiry as select * from public.usage_addon_entitlements;
select count(*) as ev_before from public.usage_addon_entitlement_events \gset
select public.t_assert(public.t_expire('2027-07-08 11:59:59+00') = 0, 'before any boundary: nothing expires');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = :ev_before, 'no-op call wrote no event');
-- (each expiry call and its status check are separate statements: a statement's subqueries use the snapshot taken before the call)
select public.t_assert(public.t_expire('2027-07-08 12:00:00+00') = 1, 'Auckland boundary 2027-07-08 12:00Z: exactly one row expired');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000006') = 'expired', 'the expired row is the Auckland grant');
select public.t_assert(public.t_expire('2027-07-08 23:59:59+00') = 0, 'nothing else due before 2027-07-09 00:00Z');
select public.t_assert(public.t_expire('2027-07-09 00:00:00+00') = 2, '2027-07-09 00:00Z: exactly two rows expired');
select public.t_assert((select count(*) from public.usage_addon_entitlements where id in ('e7000000-0000-0000-0000-000000000002','e7000000-0000-0000-0000-000000000003') and status = 'expired') = 2, 'they are the blank-tz and invalid-tz grants (UTC fallback, exclusive end)');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000001') = 'active', 'New York grant still active at 00:00Z');
select public.t_assert(public.t_expire('2027-07-09 03:59:59+00') = 0, 'New York grant not due at 03:59:59Z');
select public.t_assert(public.t_expire('2027-07-09 04:00:00+00') = 1, '2027-07-09 04:00Z: exactly one row expired');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000001') = 'expired', 'it is the New York (DanceAbel-like) grant: ends 2027-07-09 00:00 EDT');
select public.t_assert(public.t_expire('2027-07-09 04:00:00+00') = 0 and public.t_expire('2099-01-01 00:00:00+00') = 0, 'second and later calls are no-ops');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000004') = 'active', 'NULL period_end grant untouched');
select public.t_assert(not exists (select * from public.t_pre_expiry where id = 'e7000000-0000-0000-0000-000000000005' except select * from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000005'), 'Stripe-sourced row with past period_end completely untouched');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000051') = 'active', 'other feature (ai_action) not touched by organizer_suite expiry');
select public.t_assert((select status from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000031') = 'active', 'organizer-workspace grant without period_end untouched');
select public.t_assert((select count(*) from public.usage_addon_entitlements) = (select count(*) from public.t_pre_expiry), 'no rows deleted or created by expiry');
select public.t_assert(not exists (
  select id, studio_id, organizer_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, period_start, period_end, notes, created_at from public.t_pre_expiry
  except
  select id, studio_id, organizer_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, period_start, period_end, notes, created_at from public.usage_addon_entitlements), 'all non-status columns preserved by expiry');
select public.t_assert((select count(*) from public.usage_addon_entitlements e join public.t_pre_expiry p using (id) where e.status is distinct from p.status) = 4, 'exactly 4 statuses changed in total');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events where event_type = 'status_change' and to_status = 'expired' and from_status = 'active' and actor = 'system:expire_due_usage_addon_entitlements' and reason like 'complimentary grant reached period_end%') = 4, 'each expiry audited once with system actor and reason');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = :ev_before + 4, 'expiry wrote exactly 4 events in total');
begin;
select set_config('app.entitlement_reason', 'caller reason', true);
select public.t_expire('2099-01-01 00:00:00+00', 'organizer_suite');
select public.t_assert(current_setting('app.entitlement_reason', true) = 'caller reason', 'expire restores the caller''s reason setting');
commit;
select public.t_expect_fail('authenticated', $$select * from public.expire_due_usage_addon_entitlements('2099-01-01')$$, 'permission denied for function%');
select public.t_expect_fail('anon', $$select * from public.expire_due_usage_addon_entitlements('2099-01-01')$$, 'permission denied for function%');
select public.t_expect_fail('service_role', $$select * from public.expire_due_usage_addon_entitlements(null)$$, '%are required%');
select public.t_expect_fail('service_role', $$select * from public.expire_due_usage_addon_entitlements(now(), null)$$, '%are required%');
select public.t_assert(not has_function_privilege('authenticated', 'public.usage_addon_entitlements_audit()', 'execute') and not has_function_privilege('anon', 'public.usage_addon_entitlements_audit()', 'execute'), 'audit trigger function not executable by anon/authenticated');
-- an expired grant can be followed by a new active grant only through an explicit owner action (coexistence index allows it)
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status) values ('e7000000-0000-0000-0000-000000000099','d7000000-0000-0000-0000-000000000002','studio','organizer_suite',1,'stripe_subscription_item','si_d7_s2_paid','active')$$);
select public.t_assert((select count(*) from public.usage_addon_entitlements where studio_id = 'd7000000-0000-0000-0000-000000000002') = 2, 'after expiry a paid Stripe row coexists with the preserved expired grant');

-- ---------- I: concurrency (two real sessions) ----------
\echo === I: concurrency: session A holds the due rows, session B (separate psql process) runs concurrently
insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status, period_end) values
  ('e7000000-0000-0000-0000-0000000000c1', 'd7000000-0000-0000-0000-000000000001', 'studio', 'conc_test', 1, 'manual_grant', 'active', '2027-01-01'),
  ('e7000000-0000-0000-0000-0000000000c2', 'd7000000-0000-0000-0000-000000000002', 'studio', 'conc_test', 1, 'manual_grant', 'active', '2027-01-01'),
  ('e7000000-0000-0000-0000-0000000000c3', 'd7000000-0000-0000-0000-000000000003', 'studio', 'conc_test', 1, 'manual_grant', 'active', '2027-01-01');
begin;
set local role service_role;
select count(*) as a_count from public.expire_due_usage_addon_entitlements('2030-01-01', 'conc_test') \gset
\! psql -X -q -At -U postgres -d postgres -c "set role service_role; select count(*) from public.expire_due_usage_addon_entitlements('2030-01-01', 'conc_test');" > /tmp/d7_b_count.txt 2>&1
\! psql -X -q -At -U postgres -d postgres -c "select count(*) from public.usage_addon_entitlements where feature_key = 'conc_test' and status = 'active';" > /tmp/d7_b_seen.txt 2>&1
commit;
\set b_count `cat /tmp/d7_b_count.txt`
\set b_seen `cat /tmp/d7_b_seen.txt`
\echo session A expired :a_count, concurrent session B expired :b_count, B saw :b_seen still active (A uncommitted)
select public.t_assert(:a_count = 3, 'session A expired the 3 due rows');
select public.t_assert(:'b_count' = '0', 'concurrent session B expired nothing (rows locked by A are skipped, no double expiry, no wait)');
select public.t_assert(:'b_seen' = '3', 'B saw the rows still active while A was uncommitted');
\! psql -X -q -At -U postgres -d postgres -c "set role service_role; select count(*) from public.expire_due_usage_addon_entitlements('2030-01-01', 'conc_test');" > /tmp/d7_c_count.txt 2>&1
\set c_count `cat /tmp/d7_c_count.txt`
select public.t_assert(:'c_count' = '0', 'call after A committed changes nothing');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events where feature_key = 'conc_test' and event_type = 'status_change') = 3, 'exactly one status_change event per row across concurrent calls');

-- ---------- J: privilege matrix after migration 2 ----------
\echo === J: privilege matrix and RLS after migration 2
select public.t_assert(t_acl() = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arw/postgres}', 'ACL exact: authenticated r, service_role arw, anon nothing');
select public.t_assert(not has_table_privilege('anon', 'public.usage_addon_entitlements', 'select') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'insert') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'update') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'delete') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'truncate') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'trigger') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'references') and not has_table_privilege('anon', 'public.usage_addon_entitlements', 'maintain'), 'anon: no privilege');
select public.t_assert(has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'select') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'insert') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'update') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'delete') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'truncate') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'trigger') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'references') and not has_table_privilege('authenticated', 'public.usage_addon_entitlements', 'maintain'), 'authenticated: select only');
select public.t_assert(has_table_privilege('service_role', 'public.usage_addon_entitlements', 'select') and has_table_privilege('service_role', 'public.usage_addon_entitlements', 'insert') and has_table_privilege('service_role', 'public.usage_addon_entitlements', 'update') and not has_table_privilege('service_role', 'public.usage_addon_entitlements', 'delete') and not has_table_privilege('service_role', 'public.usage_addon_entitlements', 'truncate') and not has_table_privilege('service_role', 'public.usage_addon_entitlements', 'trigger') and not has_table_privilege('service_role', 'public.usage_addon_entitlements', 'references') and not has_table_privilege('service_role', 'public.usage_addon_entitlements', 'maintain'), 'service_role: select, insert, update only');
select public.t_expect_fail('anon', 'select * from public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('anon', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included) values ('d7000000-0000-0000-0000-000000000001','studio','x',1)$$, 'permission denied%');
select public.t_expect_fail('anon', $$update public.usage_addon_entitlements set notes = 'x'$$, 'permission denied%');
select public.t_expect_fail('anon', 'delete from public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('anon', 'truncate public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('authenticated', $$insert into public.usage_addon_entitlements (studio_id, workspace_type, feature_key, quantity_included) values ('d7000000-0000-0000-0000-000000000001','studio','x',1)$$, 'permission denied%');
select public.t_expect_fail('authenticated', $$update public.usage_addon_entitlements set status = 'active'$$, 'permission denied%');
select public.t_expect_fail('authenticated', 'delete from public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('authenticated', 'truncate public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('service_role', 'delete from public.usage_addon_entitlements', 'permission denied%');
select public.t_expect_fail('service_role', 'truncate public.usage_addon_entitlements', 'permission denied%');
select public.t_assert(public.t_rows_as('service_role', null, $$update public.usage_addon_entitlements set notes = 'svc ok' where id = 'e7000000-0000-0000-0000-000000000004'$$) = 1, 'service_role update allowed');
select public.t_assert(public.t_count_as('service_role', null, 'select * from public.usage_addon_entitlements') = (select count(*) from public.usage_addon_entitlements), 'service_role reads all rows');
select public.t_assert(public.t_count_as('authenticated', 'a7000000-0000-0000-0000-00000000000a', 'select * from public.usage_addon_entitlements') = (select count(*) from public.usage_addon_entitlements where studio_id = 'd7000000-0000-0000-0000-000000000001'), 'studio owner reads exactly own studio rows (RLS)');
select public.t_assert(public.t_count_as('authenticated', 'a7000000-0000-0000-0000-00000000000a', $$select * from public.usage_addon_entitlements where studio_id <> 'd7000000-0000-0000-0000-000000000001'$$) = 0, 'studio owner cannot read other studios');
select public.t_assert(public.t_count_as('authenticated', 'b7000000-0000-0000-0000-00000000000b', 'select * from public.usage_addon_entitlements') = 0, 'user without a role reads nothing');
select public.t_assert((select count(*) from pg_policies where tablename = 'usage_addon_entitlements' and cmd = 'SELECT') = 2 and (select count(*) from pg_policies where tablename = 'usage_addon_entitlements') = 2, 'RLS policies unchanged (2 SELECT)');

-- ---------- L: #360 RPC and service_role cascade under the trigger and least-privilege grants ----------
\echo === L: apply_studio_subscription_state (SECURITY DEFINER) and service_role studio delete
select public.t_assert(t_acl() = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arw/postgres}', 'L runs under the least-privilege ACL');
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status, period_end) values ('e7000000-0000-0000-0000-000000000082','d7000000-0000-0000-0000-000000000008','studio','organizer_suite',1,'manual_grant','active','2027-07-09')$$);
create table public.t_pre_rpc as select * from public.usage_addon_entitlements where source = 'manual_grant';
select count(*) as ev_pre_rpc, clock_timestamp() as t_rpc_start from public.usage_addon_entitlement_events \gset
select public.t_assert(public.t_apply('d7000000-0000-0000-0000-000000000008', '2027-01-01 00:00+00', 'active', '{"active": true, "item_ids": ["si_d7_rpc"]}') = 'applied', 'RPC (service_role) applied a Suite item');
select public.t_assert((select count(*) from public.usage_addon_entitlements where stripe_subscription_item_id = 'si_d7_rpc' and studio_id = 'd7000000-0000-0000-0000-000000000008' and status = 'active' and source = 'stripe_subscription_item') = 1, 'RPC created one active Stripe Suite row next to the manual grant');
select id as rpc_ent from public.usage_addon_entitlements where stripe_subscription_item_id = 'si_d7_rpc' \gset
select public.t_assert(public.t_ev(:'rpc_ent', 'insert') = 1 and public.t_ev(:'rpc_ent', null) = 1, 'RPC insert audited exactly once');
select public.t_assert((select actor = 'postgres' and reason = 'no app.entitlement_reason set; written as postgres on behalf of role service_role (SECURITY DEFINER context)' from public.usage_addon_entitlement_events where entitlement_id = :'rpc_ent' and event_type = 'insert'), 'definer write: actor is the owner role, default reason names the invoking role service_role');
select public.t_assert(public.t_apply('d7000000-0000-0000-0000-000000000008', '2027-01-02 00:00+00', 'cancelled', '{"active": false, "item_ids": ["si_d7_rpc"]}') = 'applied', 'RPC applied the cancellation');
select public.t_assert((select status from public.usage_addon_entitlements where id = :'rpc_ent') = 'canceled', 'Stripe Suite row canceled by the RPC');
select public.t_assert(public.t_ev(:'rpc_ent', 'status_change') = 1 and public.t_ev(:'rpc_ent', null) = 2 and (select from_status = 'active' and to_status = 'canceled' and actor = 'postgres' and reason like '%on behalf of role service_role%' from public.usage_addon_entitlement_events where entitlement_id = :'rpc_ent' and event_type = 'status_change'), 'cancellation audited once (active -> canceled, owner actor, service_role named)');
select public.t_assert(public.t_apply('d7000000-0000-0000-0000-000000000008', '2027-01-03 00:00+00', 'cancelled', '{"active": false, "item_ids": ["si_d7_rpc"]}') = 'applied' and public.t_ev(:'rpc_ent', null) = 2, 'repeat RPC with the same state writes no event (no-op update)');
begin;
select set_config('app.entitlement_reason', 'stripe webhook evt_d7', true);
select set_config('app.entitlement_actor', 'webhook:stripe', true);
select public.t_apply('d7000000-0000-0000-0000-000000000008', '2027-01-04 00:00+00', 'active', '{"active": true, "item_ids": ["si_d7_rpc"]}');
commit;
select public.t_assert((select reason = 'stripe webhook evt_d7' and actor = 'webhook:stripe' from public.usage_addon_entitlement_events where entitlement_id = :'rpc_ent' and event_type = 'status_change' and to_status = 'active'), 'caller-set reason/actor carried through the definer RPC');
select public.t_assert(not exists (select * from public.t_pre_rpc except select * from public.usage_addon_entitlements where source = 'manual_grant') and (select count(*) from public.usage_addon_entitlements where source = 'manual_grant') = (select count(*) from public.t_pre_rpc), 'RPC touched no manual_grant row');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events e where e.created_at > :'t_rpc_start'::timestamptz and e.entitlement_id in (select id from public.t_pre_rpc)) = 0, 'no event written for any manual_grant row during the RPC calls');
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = :ev_pre_rpc + 3, 'RPC calls wrote exactly 3 events (insert, cancel, reactivate)');
-- (b) studio delete as service_role (no DELETE on entitlements): the FK cascade still removes the row and is audited
select public.t_expect_ok('service_role', $$insert into public.usage_addon_entitlements (id, studio_id, workspace_type, feature_key, quantity_included, source, status) values ('e7000000-0000-0000-0000-000000000091','d7000000-0000-0000-0000-000000000009','studio','organizer_suite',1,'manual_grant','active')$$);
select public.t_expect_fail('service_role', $$delete from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000091'$$, 'permission denied%');
select public.t_assert(public.t_rows_as('service_role', null, $$delete from public.studios where id = 'd7000000-0000-0000-0000-000000000009'$$) = 1, 'service_role deleted the studio');
select public.t_assert(not exists (select 1 from public.usage_addon_entitlements where id = 'e7000000-0000-0000-0000-000000000091') and public.t_ev('e7000000-0000-0000-0000-000000000091', 'delete') = 1, 'service_role studio delete cascaded and the delete event was recorded');
select public.t_assert((select actor = 'service_role' and reason is null and from_status = 'active' and from_source = 'manual_grant' and studio_id = 'd7000000-0000-0000-0000-000000000009' from public.usage_addon_entitlement_events where entitlement_id = 'e7000000-0000-0000-0000-000000000091' and event_type = 'delete'), 'cascade delete event attributed to the deleting role service_role (AFTER trigger fires in caller identity), snapshot kept');

-- ---------- K: rollbacks with data ----------
\echo === K: rollbacks with data
\i /tmp/m2_down.sql
select public.t_assert(t_acl() = :'acl_before', 'privilege rollback with data restores the prior ACL exactly');
\i /tmp/m2_up.sql
select public.t_assert(t_acl() = '{postgres=arwdDxtm/postgres,authenticated=r/postgres,service_role=arw/postgres}', 'privilege forward again');
select count(*) as ev_keep from public.usage_addon_entitlement_events \gset
\echo EXPECTED ERROR follows (rollback refused)
\set ON_ERROR_STOP off
\i /tmp/m1_down.sql
\set ON_ERROR_STOP on
rollback;
select public.t_assert(to_regclass('public.usage_addon_entitlement_events') is not null and (select count(*) from public.usage_addon_entitlement_events) = :ev_keep and to_regprocedure('public.expire_due_usage_addon_entitlements(timestamptz,text)') is not null and exists (select 1 from pg_trigger where tgname = 'usage_addon_entitlements_audit_trg') and to_regclass('public.usage_addon_entitlements_one_active_manual_grant_studio') is not null, 'rollback refused while events exist: every object and event intact');
\i /tmp/m1_up.sql
select public.t_assert((select count(*) from public.usage_addon_entitlement_events) = :ev_keep, 're-apply over live data keeps events');

\echo === ALL CHECKS DONE
