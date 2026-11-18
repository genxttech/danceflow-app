-- READ-ONLY postflight for 20270221090000 (claim function) + 20270222090000 (exclusion) + 20270222091000 (plain index) + 20270222092000 (dancer views) + 20270222093000 (policy cutover). Counts and catalog facts only; no emails.
-- Run with: bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read <this file>   (one jsonb result row)
-- Compare unclaimed_counts with the preflight: an apply of the migrations alone must change NOTHING (the function is not called by SQL).
select jsonb_build_object(
  'function', (select to_jsonb(t) from (select
      p.proname, p.pronargs as nargs, (position('registration_source in (''public_event_page'')' in pg_get_functiondef(p.oid)) > 0) as has_source_allowlist, p.prorettype::regtype::text as returns, p.prosecdef as security_definer,
      pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
      (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_grants,
      (select coalesce(jsonb_agg(distinct pg_get_userbyid(a.grantee)), '[]'::jsonb) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> 0) as grantees
      from pg_proc p where p.oid = to_regprocedure('public.claim_my_event_registrations()')) t),
  'index', (select to_jsonb(t) from (select c.relname, i.indisvalid as valid, i.indisready as ready, pg_get_indexdef(i.indexrelid) as definition
      from pg_index i join pg_class c on c.oid = i.indexrelid where c.oid = to_regclass('public.event_registrations_unclaimed_email_idx')) t),
  'source_distribution', (select coalesce(jsonb_agg(jsonb_build_object('source', registration_source, 'total', n, 'owned', o) order by registration_source), '[]'::jsonb) from (select registration_source, count(*) n, count(*) filter (where user_id is not null) o from public.event_registrations group by 1) x),
  'dancer_read', (select jsonb_build_object(
      'views', (select coalesce(jsonb_object_agg(c.relname, (select jsonb_agg(a.attname order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)), '{}'::jsonb)
                        from pg_class c where c.oid in (to_regclass('public.my_event_registrations'), to_regclass('public.my_event_registration_attendees'))),
      'view_grants', jsonb_build_object(
        'authenticated_select_regs', case when to_regclass('public.my_event_registrations') is null then null else has_table_privilege('authenticated', 'public.my_event_registrations', 'select') end,
        'anon_select_regs', case when to_regclass('public.my_event_registrations') is null then null else has_table_privilege('anon', 'public.my_event_registrations', 'select') end,
        'authenticated_write_regs', case when to_regclass('public.my_event_registrations') is null then null else (has_table_privilege('authenticated', 'public.my_event_registrations', 'insert') or has_table_privilege('authenticated', 'public.my_event_registrations', 'update') or has_table_privilege('authenticated', 'public.my_event_registrations', 'delete')) end),
      'dancer_self_policies', (select coalesce(jsonb_agg(tablename || '.' || policyname order by tablename, policyname), '[]'::jsonb) from pg_policies where schemaname = 'public' and policyname in ('event_registrations_self_select', 'event_registration_attendees_self_select', 'event_registration_attendees_self_insert')),
      'table_level_select_grants', (select coalesce(jsonb_agg(table_name || ':' || grantee order by table_name, grantee), '[]'::jsonb) from information_schema.table_privileges where table_schema = 'public' and table_name in ('event_registrations', 'event_registration_attendees', 'event_orders') and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT'),
      'policy_count_event_registrations', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_registrations'),
      'policy_count_event_registration_attendees', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_registration_attendees'))),
  'invalid_indexes_on_table', (select count(*) from pg_index i where i.indrelid = 'public.event_registrations'::regclass and not i.indisvalid),
  'unclaimed_counts', (select to_jsonb(t) from (select
      count(*) as total_registrations,
      count(*) filter (where user_id is null) as unclaimed,
      count(*) filter (where user_id is not null) as owned,
      max(updated_at) as max_updated_at
      from public.event_registrations) t)
) as postflight;
