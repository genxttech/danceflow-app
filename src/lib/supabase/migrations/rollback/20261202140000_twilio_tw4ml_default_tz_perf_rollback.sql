-- Rollback of 20261202140000_twilio_tw4ml_default_tz_perf.sql: restores the 20261128090000 body of _tw4ml_default_tz (same results, slower plan).
-- Independent of the application; CREATE OR REPLACE keeps the existing privileges.
begin;

set local lock_timeout = '5s';

create or replace function public._tw4ml_default_tz(p_entity uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((select s.timezone from public.studio_sms_entity_studios es join public.studios s on s.id = es.studio_id
                    where es.legal_entity_id = p_entity and public._tw4ml_valid_tz(s.timezone) order by es.linked_at limit 1), 'UTC');
$$;

commit;
