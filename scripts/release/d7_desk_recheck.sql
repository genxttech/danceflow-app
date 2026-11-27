-- D7 pre-expiry release (desk RPC database guard): JUST-BEFORE-APPLY RECHECK (read-only). Run inside the approved window, immediately
-- before the migration, in addition to d7_desk_preflight.sql: D7_FLIGHT_PREFIX=d7_desk bash scripts/release/d7_core_flight.sh recheck <dev|prod>
with checks(seq, check_name, ok, detail) as (
  select 1, 'server is PostgreSQL 17.x', current_setting('server_version_num')::int between 170000 and 179999, current_setting('server_version')
  union all select 2, 'no transaction is idle-in-transaction or older than 30 seconds (a lock queue would starve the 5s lock_timeout)',
         not exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database()
                       and ((state like 'idle in transaction%') or (xact_start is not null and now() - xact_start > interval '30 seconds'))), null
  union all select 3, 'no prepared transactions are pending', not exists (select 1 from pg_prepared_xacts), null
  union all select 4, 'no other session is executing the desk RPC right now',
         not exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and query ilike '%record_competition_checkin_payment%'), null
  union all select 5, 'INFO live function body hash (must equal the preflight value 387aacac2effd055340e27211b8f7e4f)', true,
         (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'))
)
select seq, check_name, coalesce(ok, false) as ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(coalesce(ok, false)), false), null from checks
order by seq;
