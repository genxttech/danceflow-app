-- rollback/20270102090000_competition_e2_ballots_rollback.sql
--
-- Reverts E2: drops the ballots / marks / attendance / audit tables, triggers, helpers and RPCs.
-- REFUSES (no evidence loss) if any ballot, mark, attendance or audit row exists, or if a later slice (F2/F3) references an
-- E2 table. Roll the APP back first, then dependants (F2/F3), then this file. If a round is currently `ballots_locked`
-- it is NOT moved here: reopen it first (a locked round with no E2 writer would be stranded).

begin;

do $$
begin
  if to_regclass('public.event_competition_ballots') is null then
    raise exception 'E2 rollback: event_competition_ballots is absent (E2 not applied).';
  end if;
  if exists (select 1 from public.event_competition_ballots)
     or exists (select 1 from public.event_competition_marks)
     or exists (select 1 from public.event_competition_judge_attendance)
     or exists (select 1 from public.event_competition_ballot_events)
     or exists (select 1 from public.event_competition_ballot_drafts) then
    raise exception 'E2 rollback refused: ballots, marks, attendance or audit evidence exist.';
  end if;
  if exists (
    select 1 from pg_constraint c
    where c.confrelid in ('public.event_competition_ballots'::regclass, 'public.event_competition_marks'::regclass,
                          'public.event_competition_judge_attendance'::regclass, 'public.event_competition_ballot_events'::regclass)
      and c.conrelid not in ('public.event_competition_ballots'::regclass, 'public.event_competition_marks'::regclass)
  ) then
    raise exception 'E2 rollback refused: another table references an E2 table (roll back F2/F3 first).';
  end if;
  if exists (select 1 from public.event_competition_rounds r where r.status = 'ballots_locked') then
    raise exception 'E2 rollback refused: a round is ballots_locked; reopen it first.';
  end if;
end $$;

drop trigger if exists compe2_guard_round_config on public.event_competition_rounds;
drop function if exists public._compe2_guard_round_config();
drop trigger if exists compe2_guard_round_lock_edges on public.event_competition_rounds;
drop function if exists public._compe2_guard_round_lock_edges();

drop function if exists public.save_competition_callback_draft(uuid, uuid[]);
drop function if exists public.competition_judge_ballot_sheet(uuid);
drop function if exists public.competition_round_ballot_status(uuid);
drop function if exists public.reopen_competition_round_ballots(uuid, text, uuid);
drop function if exists public.lock_competition_round_ballots(uuid, uuid);
drop function if exists public.record_competition_judge_attendance(uuid, uuid, text, text, uuid);
drop function if exists public.enter_competition_paper_ballot(uuid, uuid, uuid, jsonb, uuid, text);
drop function if exists public.submit_competition_ballot(uuid, uuid, jsonb, uuid, text);

drop table public.event_competition_marks;
drop table public.event_competition_ballots;
drop table public.event_competition_judge_attendance;
drop table public.event_competition_ballot_events;
drop table public.event_competition_ballot_drafts;

drop function if exists public.competition_is_round_scorer(uuid);
drop function if exists public._compe2_insert_ballot(uuid, uuid, uuid, uuid, text, uuid, jsonb, text, uuid);
drop function if exists public._compe2_round_blockers(uuid);
drop function if exists public._compe2_round_role(uuid);
drop function if exists public._compe2_lock_pair(uuid, uuid);
drop function if exists public._compe2_audit(uuid, uuid, uuid, text, uuid, uuid, uuid, text, text, uuid, text, jsonb);
drop function if exists public._compe2_validate_marks(text, uuid[], jsonb);
drop function if exists public._compe2_is_absent(uuid, uuid);
drop function if exists public._compe2_panel_rule(text);
drop function if exists public._compe2_format_scope(text);
drop function if exists public._compe2_format_approved(text, integer);
drop function if exists public._compe2_format_for_scoring(text);
drop function if exists public._compe2_validate_callback(integer, uuid[], jsonb);
drop function if exists public._compe2_round_entries(uuid);
drop function if exists public._compe2_round_judges(uuid);
drop function if exists public._compe2_heat_entries(uuid);
drop function if exists public._compe2_round_heats(uuid);
drop function if exists public._compe2_guard_mark_insert();
drop function if exists public._compe2_guard_ballot_insert();

commit;
