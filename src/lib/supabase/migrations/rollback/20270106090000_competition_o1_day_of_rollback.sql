-- Rollback for 20270106090000_competition_o1_day_of.sql.
-- Refuses while transition evidence exists: the audit rows are the record that day-of work happened, and
-- removing the guards while rounds/heats carry O1 statuses would let them be rewritten unaudited.
do $$
begin
  if to_regclass('public.event_competition_round_transition_events') is not null
     and exists (select 1 from public.event_competition_round_transition_events) then
    raise exception 'O1 rollback refused: event_competition_round_transition_events holds evidence.';
  end if;
  if exists (select 1 from public.event_competition_heats where status in ('staging', 'active', 'complete')) then
    raise exception 'O1 rollback refused: heats are in a day-of status.';
  end if;
end $$;

drop trigger if exists compo1_guard_publish_during_run on public.event_competition_schedule_versions;
drop trigger if exists compo1_guard_heat_status on public.event_competition_heats;
drop trigger if exists compo1_guard_round_status on public.event_competition_rounds;
drop function if exists public._compo1_guard_publish_during_run();
drop function if exists public._compo1_guard_heat_status();
drop function if exists public._compo1_guard_round_status();
drop function if exists public.advance_competition_floor_heat(uuid, text, uuid);
drop function if exists public.cancel_competition_round(uuid, text, uuid);
drop function if exists public.start_competition_round(uuid, uuid);
drop function if exists public.schedule_competition_round(uuid, uuid);
drop function if exists public._compo1_record(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb);
drop function if exists public._compo1_lock_event(uuid);
drop function if exists public._compo1_round_heat_state(uuid);
drop function if exists public._compo1_live_version(uuid);
drop table if exists public.event_competition_round_transition_events;
