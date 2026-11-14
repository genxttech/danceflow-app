-- 20270203100000_usage_addon_entitlements_least_privilege.sql
-- D7: least privilege on public.usage_addon_entitlements.
--   Before (PROD read-only check 2026-10-30, and the PROD-equivalent baseline, PostgreSQL 17):
--     relacl = {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--     (owner postgres; no column-level grants). RLS on with two SELECT policies only (studio owners/admins, organizer owners/admins).
--   After:
--     anon           : nothing
--     authenticated  : SELECT only (the two existing SELECT policies still decide which rows)
--     service_role   : SELECT, INSERT, UPDATE (no DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN)
--     owner postgres : unchanged (owner)
--   Every app writer uses the service role (insert/upsert/update only; no app code deletes rows). User-session code only reads.
--   RLS policies are not changed. No other table's grants are touched.
-- Rollback: rollback/20270203100000_usage_addon_entitlements_least_privilege_rollback.sql (restores the exact previous ACL, i.e. the
--   WEAKER permissions: see the warning in that file).
-- Release window: apply this file together with 20270203090000_organizer_suite_entitlement_integrity.sql in ONE controlled window, in
--   that order. Between them, anon/authenticated could still TRUNCATE the table (TRUNCATE skips RLS and the row-level audit trigger).
--   Rollback order is the reverse: 20270203100000 first, then 20270203090000 (which refuses once audit events exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.usage_addon_entitlements') is null then
    raise exception 'entitlements least-privilege precondition failed: public.usage_addon_entitlements is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.usage_addon_entitlements'::regclass) then
    raise exception 'entitlements least-privilege precondition failed: RLS is not enabled on public.usage_addon_entitlements';
  end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.usage_addon_entitlements'::regclass and attacl is not null) then
    raise exception 'entitlements least-privilege precondition failed: unexpected column-level grants exist; review them first';
  end if;
end $$;

revoke all on public.usage_addon_entitlements from public, anon, authenticated, service_role;
grant select on public.usage_addon_entitlements to authenticated;
grant select, insert, update on public.usage_addon_entitlements to service_role;

commit;
