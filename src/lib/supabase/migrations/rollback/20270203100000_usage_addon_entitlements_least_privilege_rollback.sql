-- Rollback of 20270203100000_usage_addon_entitlements_least_privilege.sql.
-- Restores the exact previous ACL observed on PROD (2026-10-30) and the PROD-equivalent baseline (PostgreSQL 17):
--   {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--   arwdDxtm = INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (listed explicitly, not ALL).
-- Run as the table owner (postgres) so the grantor matches. RLS and policies are untouched.
begin;
set local lock_timeout = '5s';
revoke all on public.usage_addon_entitlements from public, anon, authenticated, service_role;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on public.usage_addon_entitlements to anon, authenticated, service_role;
commit;
