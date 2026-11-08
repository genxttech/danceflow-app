-- 20261202140000_twilio_tw4ml_default_tz_perf.sql
-- PERFORMANCE ONLY, same results: _tw4ml_default_tz (20261128090000) let the planner run _tw4ml_valid_tz -- a scan of pg_timezone_names, ~130 ms --
-- on EVERY studio in the database before joining to the legal business's own locations. Every monthly-limit read for a business with no recorded
-- timezone calls it several times (month key, month start/end, this and next month's timezone), so the owner's Texting card and the platform panel
-- took (studios x 130 ms) per call, and the first charge of a business paid it once under its account lock (_tw4ml_ensure_tz).
-- The rewrite selects the business's own locations first behind an optimisation fence (OFFSET 0), then checks only their timezones. Same inputs,
-- same order (linked_at), same fallback ('UTC'), same volatility, security and search_path; CREATE OR REPLACE keeps the existing privileges.
-- No table, no data, no authority changes. Rollback: rollback/20261202140000_..._rollback.sql restores the previous body (any order vs the app).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public._tw4ml_default_tz(uuid)') is null or to_regprocedure('public._tw4ml_valid_tz(text)') is null then
    raise exception 'tw4ml default timezone precondition failed: 20261128090000 is not applied';
  end if;
end $$;

create or replace function public._tw4ml_default_tz(p_entity uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  -- the founding location's timezone (the first linked location), or UTC if it is missing or not a real IANA zone; only this business's locations
  -- are checked (OFFSET 0 keeps the planner from running the timezone check on every studio before the join)
  select coalesce((select l.timezone
                     from (select s.timezone, es.linked_at from public.studio_sms_entity_studios es join public.studios s on s.id = es.studio_id
                            where es.legal_entity_id = p_entity offset 0) l
                    where public._tw4ml_valid_tz(l.timezone) order by l.linked_at limit 1), 'UTC');
$$;

commit;
