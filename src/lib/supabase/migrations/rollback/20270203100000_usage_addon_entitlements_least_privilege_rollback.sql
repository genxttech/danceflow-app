-- Rollback of 20270203100000_usage_addon_entitlements_least_privilege.sql.
-- Restores the exact previous ACL observed on PROD (2026-10-30) and the PROD-equivalent baseline (PostgreSQL 17):
--   {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
--   arwdDxtm = INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (listed explicitly, not ALL).
-- MAINTAIN (the 'm') exists only on PostgreSQL 17+. It is granted only when server_version_num >= 170000, so this file also runs
-- on an older server (where the previous ACL could not have held MAINTAIN either: arwdDxt there).
-- Run as the table owner (postgres) so the grantor matches. RLS and policies are untouched.
-- WARNING: this rollback RESTORES THE WEAKER PERMISSIONS. After it runs, anon and authenticated again hold INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER (and MAINTAIN on PG17) on public.usage_addon_entitlements; only RLS (two SELECT policies, no write
-- policy) keeps rows from being written through the API, and TRUNCATE bypasses RLS. Use it only to back out a failed release, and
-- re-apply 20270203100000 as soon as the cause is fixed. Do not leave the system in the rolled-back state.
begin;
set local lock_timeout = '5s';
revoke all on public.usage_addon_entitlements from public, anon, authenticated, service_role;
grant select, insert, update, delete, truncate, references, trigger
  on public.usage_addon_entitlements to anon, authenticated, service_role;
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'grant maintain on public.usage_addon_entitlements to anon, authenticated, service_role';
  end if;
end $$;
commit;
