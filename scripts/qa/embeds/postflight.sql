-- Website Embeds migration 20270216090000: read-only post-apply verification. Run with
--   bash C:/Users/mcurt/danceflow-ops/sb.sh dev-read  scripts/qa/embeds/postflight.sql     (DEV)
--   bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read scripts/qa/embeds/postflight.sql     (PROD, after owner-authorized apply)
-- One statement, one row. Expect "all_ok": true. Before the migration is applied it errors (the functions do not exist): that is the expected "not applied" result.
with fns as (
  select p.oid, p.proname, p.prosecdef, p.proconfig
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('_embed_can_manage', 'public_studio_embed_settings', 'get_studio_embed_settings', 'set_studio_embed_settings', 'public_group_class_extras')
), checks as (
  select 'table_exists' k, to_regclass('public.studio_embed_settings') is not null v
  union all select 'rls_on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.studio_embed_settings')), false)
  union all select 'no_policies', not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'studio_embed_settings')
  union all select 'no_api_table_privileges', to_regclass('public.studio_embed_settings') is not null
    and not has_table_privilege('anon', 'public.studio_embed_settings', 'select,insert,update,delete')
    and not has_table_privilege('authenticated', 'public.studio_embed_settings', 'select,insert,update,delete')
  union all select 'five_functions', (select count(*) from fns) = 5
  union all select 'all_security_definer_with_search_path', (select bool_and(prosecdef and coalesce(proconfig::text, '') like '%search_path=public%') from fns)
  union all select 'helper_not_executable_by_api', (select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute') from fns where proname = '_embed_can_manage')
  union all select 'public_fns_anon_executable', (select bool_and(has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')) from fns where proname in ('public_studio_embed_settings', 'public_group_class_extras'))
  union all select 'manage_fns_not_anon', (select bool_and(not has_function_privilege('anon', oid, 'execute') and has_function_privilege('authenticated', oid, 'execute')) from fns where proname in ('get_studio_embed_settings', 'set_studio_embed_settings'))
  union all select 'no_function_for_public_pseudo_role', (select bool_and(not has_function_privilege('public', oid, 'execute')) from fns)
  union all select 'unknown_slug_returns_nothing', (select count(*) from public.public_studio_embed_settings('no-such-studio-slug-zz')) = 0
)
select jsonb_build_object('all_ok', bool_and(coalesce(v, false)), 'checks', jsonb_object_agg(k, coalesce(v, false))) as embeds_postflight from checks;
