set transaction read only;
select 'intake_relations_any_schema' k, (select count(*) from pg_class where relname like 'intake\_%')::text v
union all select 'intake_relations_list', coalesce((select string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text, ' ') from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname like 'intake\_%'), '<none>')
union all select 'intake_functions_any_schema', (select count(*) from pg_proc where proname like 'intake\_%')::text
union all select 'intake_private_schema', (select count(*) from pg_namespace where nspname = 'intake_private')::text
union all select 'intake_destructive_role', (select count(*) from pg_roles where rolname = 'intake_destructive')::text
union all select 'intake_types', (select count(*) from pg_type where typname like 'intake\_%' or typname like '\_intake\_%')::text
union all select 'intake_policies', (select count(*) from pg_policies where tablename like 'intake\_%' or policyname like 'intake\_%')::text
union all select 'intake_triggers_anywhere', (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgname like 'intake\_%' or p.proname like 'intake\_%')::text
union all select 'environment_first_use_marker', case when to_regclass('public.intake_audit_events') is null then 'n/a (table absent)' else 'TABLE PRESENT' end
union all select 'leftover_probe_tables', (select count(*) from pg_class where relname like 'nsi\_zz%' or relname like 'intake\_zz%')::text;
