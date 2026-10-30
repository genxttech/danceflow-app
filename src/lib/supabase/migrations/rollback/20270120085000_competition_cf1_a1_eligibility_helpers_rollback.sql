-- Rollback for 20270120085000_competition_cf1_a1_eligibility_helpers.sql.
-- ROLL-FORWARD ONLY once an exclusion row exists: those rows are the audit of why couples were taken out of a ranking.
-- Order: this is the LAST CF1 rollback (A6, A5, A3, A2, A4a, A0 first); CF1 as a whole rolls back before HL1.
-- It also refuses while any other function still calls an A1 helper (a later package was not rolled back first).

begin;

do $$
declare
  v_names constant text[] := array[
    '_cf1_entry_unavailable_reason', '_cf1_entry_unavailable', '_cf1_round_roster_problems', '_cf1_is_callback_final',
    '_cf1_count_available_entries', '_cf1_eligible_roster_count', '_cf1_final_minimum_ok', '_cf1_heat_entry_is_excluded',
    '_cf1_excluded_entries', '_cf1_error_codes', '_cf1_require_roster_eligible'];
  v_user text;
begin
  if exists (select 1 from public.event_competition_round_exclusions) then
    raise exception 'CF1-A1 rollback refused: exclusion rows exist (event_competition_round_exclusions is append-only audit); roll forward.';
  end if;
  select string_agg(distinct p.oid::regprocedure::text, ', ') into v_user
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where p.proname <> all (v_names)
    and (exists (select 1 from unnest(v_names) f where p.prosrc like '%' || f || '%')
         or p.prosrc like '%event_competition_round_exclusions%');
  if v_user is not null then
    raise exception 'CF1-A1 rollback refused: still referenced by % (roll back the later CF1 packages first).', v_user;
  end if;
  if exists (select 1 from pg_constraint c
             where c.confrelid = 'public.event_competition_round_exclusions'::regclass and c.conrelid <> c.confrelid) then
    raise exception 'CF1-A1 rollback refused: another table references event_competition_round_exclusions.';
  end if;
end $$;

drop function public._cf1_require_roster_eligible(uuid, text);
drop function public._cf1_error_codes();
drop function public._cf1_excluded_entries(uuid);
drop function public._cf1_heat_entry_is_excluded(uuid);
drop function public._cf1_final_minimum_ok(uuid);
drop function public._cf1_eligible_roster_count(uuid);
drop function public._cf1_count_available_entries(uuid[]);
drop function public._cf1_is_callback_final(uuid);
drop function public._cf1_round_roster_problems(uuid);
drop function public._cf1_entry_unavailable(uuid);
drop function public._cf1_entry_unavailable_reason(uuid);
drop table public.event_competition_round_exclusions;

commit;
