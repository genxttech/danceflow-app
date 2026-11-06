-- D7 core Organizer Suite release: JUST-BEFORE-APPLY RECHECK (read-only). Run inside the approved window, immediately before
-- the first migration, in addition to d7_core_preflight.sql. Any row with ok = false is a STOP condition.
-- Run via: bash scripts/release/d7_core_flight.sh recheck <dev|prod>
with
 ent as (select to_regclass('public.usage_addon_entitlements') as oid),
 definition as (
   -- fingerprint of everything the migrations depend on or change on the entitlements table
   select md5(coalesce(
     (select string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull::text, ',' order by attnum)
        from pg_attribute where attrelid = (select oid from ent) and attnum > 0 and not attisdropped), '') || '|' ||
     coalesce((select string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint where conrelid = (select oid from ent)), '') || '|' ||
     coalesce((select string_agg(indexname || ':' || indexdef, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'usage_addon_entitlements'), '') || '|' ||
     coalesce((select string_agg(polname || ':' || polcmd::text, ',' order by polname) from pg_policy where polrelid = (select oid from ent)), '')) as fp),
 checks(seq, check_name, ok, detail) as (
  select 1, 'server is PostgreSQL 17.x (rollback 2 has a version-dependent MAINTAIN branch)', current_setting('server_version_num')::int between 170000 and 179999, current_setting('server_version')
  union all select 2, 'no transaction is idle-in-transaction or older than 30 seconds (a lock queue would starve the 5s lock_timeout)',
         not exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database()
                       and ((state like 'idle in transaction%') or (xact_start is not null and now() - xact_start > interval '30 seconds'))),
         (select count(*)::text from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and xact_start is not null)
  union all select 3, 'no lock is held or awaited on the entitlements table by another session',
         not exists (select 1 from pg_locks l where l.relation = (select oid from ent) and l.pid <> pg_backend_pid()), null
  union all select 4, 'no prepared transactions are pending', not exists (select 1 from pg_prepared_xacts), null
  union all select 5, 'entitlements definition fingerprint (columns, constraints, indexes, policies) - compare with the saved pre-window value',
         true, (select fp from definition)
  union all select 6, 'INFO current manual grants (id status period) - must equal the saved pre-window baseline',
         true, (select coalesce(string_agg(id::text || ' ' || status || ' ' || coalesce(period_start::text,'-') || '..' || coalesce(period_end::text,'-'), '; ' order by id), 'none')
                from public.usage_addon_entitlements where source = 'manual_grant')
  union all select 7, 'INFO current project database name', true, current_database()
 )
select seq, check_name, coalesce(ok, false) as ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(coalesce(ok, false)), false), null from checks
order by seq;
