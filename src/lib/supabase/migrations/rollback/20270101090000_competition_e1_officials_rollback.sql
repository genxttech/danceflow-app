-- rollback/20270101090000_competition_e1_officials_rollback.sql
--
-- Reverts E1: drops the officials/panel tables, audit table, triggers, helpers and RPCs.
-- REFUSES (no evidence loss) if any official, panel assignment or audit row exists, and if a later slice
-- (E2 ballots, O1 day-of) still depends on an E1 object. Roll the APP back first, then dependants
-- (E2, O1), then this file. Only the round guard trigger touches a pre-existing table; it is removed here.

begin;

do $$
begin
  if to_regclass('public.event_competition_officials') is null then
    raise exception 'E1 rollback: event_competition_officials is absent (E1 not applied).';
  end if;
  if exists (select 1 from public.event_competition_officials)
     or exists (select 1 from public.event_competition_panel_assignments)
     or exists (select 1 from public.event_competition_official_events) then
    raise exception 'E1 rollback refused: officials, panel assignments or audit evidence exist.';
  end if;
  if exists (
    select 1 from pg_constraint c
    where c.confrelid in ('public.event_competition_officials'::regclass, 'public.event_competition_panel_assignments'::regclass)
      and c.conrelid <> 'public.event_competition_panel_assignments'::regclass
  ) then
    raise exception 'E1 rollback refused: another table references an E1 table (roll back E2 first).';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname not in ('competition_round_panel_ready', 'competition_round_panel_status')
      and p.prosrc ~ 'competition_round_panel_(ready|status)'
  ) then
    raise exception 'E1 rollback refused: a function (O1 start_competition_round?) still calls competition_round_panel_ready/status (roll back O1 first).';
  end if;
end $$;

drop trigger if exists guard_competition_round_panel_delete on public.event_competition_rounds;
drop function if exists public.guard_competition_round_panel_delete();

drop function if exists public.my_competition_judging_assignments();
drop function if exists public.competition_round_panel_ready(uuid);
drop function if exists public.competition_round_panel_status(uuid);
drop function if exists public.unassign_competition_panel_member(uuid, uuid, uuid);
drop function if exists public.assign_competition_panel_member(uuid, uuid, text, uuid);
drop function if exists public.clear_competition_chair(uuid, uuid);
drop function if exists public.set_competition_chair(uuid, uuid, uuid);
drop function if exists public.deactivate_competition_official(uuid, text, uuid);
drop function if exists public.add_competition_official(uuid, uuid, text, uuid);
drop function if exists public.list_competition_official_candidates(uuid);

drop table public.event_competition_panel_assignments;
drop table public.event_competition_official_events;
drop table public.event_competition_officials;

drop function if exists public.competition_is_active_official(uuid);
drop function if exists public._comp_e1_is_team_member(uuid, uuid);
drop function if exists public._comp_e1_audit(uuid, text, uuid, uuid, uuid, uuid, text, text, jsonb);
drop function if exists public._comp_e1_replay(uuid, uuid, text);
drop function if exists public._comp_e1_authorize(uuid);
drop function if exists public.guard_competition_panel_assignment();
drop function if exists public.guard_competition_official();

commit;
