-- Rollback of 20270301110000_competition_r15_eligibility_clearance_core.sql.
-- Refuses while any determination exists (dropping the table would erase clearance evidence). Roll back 20270301131000 and 20270301130000 FIRST:
-- this file drops functions the gates call.
begin;

do $$
begin
  if to_regclass('public.event_competition_eligibility_determinations') is not null
     and exists (select 1 from public.event_competition_eligibility_determinations) then
    raise exception 'R15 core rollback refused: eligibility determinations exist (clearance evidence). Nothing was changed.';
  end if;
  if exists (select 1 from pg_trigger where tgname in ('r15_guard_round_start', 'r15_guard_heat_status', 'r15_guard_heat_entry_clearance', 'r15_guard_version_publish', 'r15_guard_entry_eligibility_write') and not tgisinternal) then
    raise exception 'R15 core rollback refused: the R15 gates or write guard are still installed; roll back 20270301131000 and 20270301130000 first.';
  end if;
  if position('_r15_entry_availability_reason' in pg_get_functiondef('public.cf1_od17_guard_heat_entry()'::regprocedure)) > 0 then
    raise exception 'R15 core rollback refused: cf1_od17_guard_heat_entry still calls _r15_entry_availability_reason; roll back 20270301130000 first.';
  end if;
  if position('_r15_' in pg_get_functiondef('public._cf1_entry_unavailable_reason(uuid)'::regprocedure)) > 0 then
    raise exception 'R15 core rollback refused: predicate P is still the strict R15 body; roll back 20270301130000 first.';
  end if;
end $$;

drop function if exists public.set_competition_entry_eligibility(uuid, text, text, text[], uuid);
drop function if exists public.competition_entry_clearance_state(uuid);
drop function if exists public._r15_entry_executable_reason(uuid);
drop function if exists public._r15_entry_clearance_reason(uuid);
drop function if exists public._r15_required_criteria(uuid);
drop function if exists public._r15_entry_fingerprint(uuid);
drop function if exists public._r15_class_label_restricted(text);
drop function if exists public._r15_age_label_restricted(text);
drop function if exists public._r15_age_state(uuid);
drop function if exists public._r15_entry_availability_reason(uuid);
drop table if exists public.event_competition_eligibility_determinations;

commit;
