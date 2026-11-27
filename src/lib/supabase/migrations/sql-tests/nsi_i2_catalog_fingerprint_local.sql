-- Deterministic fingerprint of the NSI catalog state (functions incl. source and ACLs, triggers, relations and ACLs, columns,
-- constraints, policies). Used by the lifecycle harness to prove that a rollback restores EXACTLY the previous level.
select md5(string_agg(x, '|' order by x)) as nsi_catalog_fingerprint, count(*) as parts
from (
  select 'f:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc) || ':'
         || coalesce(p.proacl::text, 'null') || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || pg_get_userbyid(p.proowner) as x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private'
  union all
  select 't:' || c.relname || ':' || pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and not t.tgisinternal
  union all
  select 'r:' || c.relname || ':' || coalesce(c.relacl::text, 'null') || ':' || c.relrowsecurity::text || ':' || pg_get_userbyid(c.relowner)
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r'
  union all
  select 'col:' || table_name || '.' || column_name || ':' || is_nullable || ':' || data_type || ':' || coalesce(column_default, '')
  from information_schema.columns where table_schema = 'public' and table_name like 'intake\_%'
  union all
  select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid::regclass::text like 'intake\_%' or conrelid::regclass::text like 'public.intake\_%'
  union all
  select 'pol:' || c.relname || ':' || pl.polname || ':' || pl.polcmd::text || ':' || coalesce(pg_get_expr(pl.polqual, pl.polrelid), '')
  from pg_policy pl join pg_class c on c.oid = pl.polrelid where c.relname like 'intake\_%'
) q;
