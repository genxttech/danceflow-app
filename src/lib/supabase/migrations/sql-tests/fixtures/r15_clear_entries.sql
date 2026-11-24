-- Test-only fixture helper (never part of a migration). After 20270301111000 predicate P requires eligibility CLEARANCE, so every existing Competition suite that
-- seeds `eligible`/`waived` entries directly must also seed their clearance. Load this AFTER the fixture rows exist and call it before the first gated step:
--
--   cat sql-tests/fixtures/r15_clear_entries.sql sql-tests/<suite>.sql | psql ...      -- the suite then runs  select pg_temp.r15_clear_entries();
--
-- It (a) installs a STAND-IN for the S5 age predicate when S5 is not applied (every competitor 'allowed'; a competitor whose first_name is 'Minor' or
-- 'Unknown' keeps blocked_under_18 / unknown_age, so age probes still work) and (b) inserts, as the owner role, one determination per eligible/waived entry
-- that has none: criteria = the entry's required criteria, waiver category 'waiver_event_policy_scheduling' for waived entries. It changes NO entry status.
create or replace function pg_temp.r15_clear_entries(p_event uuid default null) returns integer
language plpgsql as $$
declare
  v_n integer;
begin
  if to_regprocedure('public._comp_participant_age_clearance(uuid)') is null then
    execute $f$create function public._comp_participant_age_clearance(p_competitor_id uuid) returns text language sql stable as $b$
      select coalesce((select case c.first_name when 'Minor' then 'blocked_under_18' when 'Unknown' then 'unknown_age' else 'allowed' end
                       from public.event_competition_competitors c where c.id = p_competitor_id), 'unknown_age') $b$ $f$;
  end if;
  insert into public.event_competition_eligibility_determinations (event_id, entry_id, outcome, reason_code, waiver_category, criteria, fingerprint, decided_by, decided_role, request_id)
  select e.event_id, e.id, e.eligibility_status,
         case e.eligibility_status when 'eligible' then 'criteria_verified_by_organizer' else 'waiver_event_policy_scheduling' end,
         case e.eligibility_status when 'waived' then 'waiver_event_policy_scheduling' end,
         case e.eligibility_status when 'eligible' then public._r15_required_criteria(e.id) else '{}'::text[] end,
         public._r15_entry_fingerprint(e.id), '00000000-0000-0000-0000-000000000001'::uuid, 'fixture', gen_random_uuid()
  from public.event_competition_entries e
  where e.eligibility_status in ('eligible', 'waived') and (p_event is null or e.event_id = p_event)
    and not exists (select 1 from public.event_competition_eligibility_determinations d where d.entry_id = e.id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
