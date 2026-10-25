-- 20270116090000_competition_ss1_round_scoring_lock.sql
--
-- COMPETITION SS1: once a program is locked (10B profile_locked_at, the source of truth for "published"), the scoring-relevant
-- columns of its rounds can never change. REG already freezes the SELECTION columns (division scoring_method_key/version, round
-- scoring_override_key/version) and pins the effective method at lock, and E2 freezes scoring_method/target_advancement_count
-- once a round has STARTED. Neither stops a multi-write "configure" that straddles a publish from rewriting a locked round's
-- legacy scoring_method (which E2 uses to pick the ballot format) or its sequence/type/division/program.
--
-- Adds ONE new trigger function and trigger. No existing function is redefined, so there is nothing to md5-pin; the rollback
-- drops exactly these two objects.
--
-- Frozen columns once the program is locked: scoring_method, sequence_number, round_type, division_id, program_id.
-- Deliberately NOT frozen: target_advancement_count (W4 lets managers set the callback target until the round starts; E2 freezes
-- it then), status/updated_at (E2, O1, F2 lifecycle writers), name, pairing_mode, configuration (10D max_entries_per_heat).
-- Documented allowed writers for the frozen columns: NONE. Every existing writer of event_competition_rounds updates only
-- status/updated_at (E2, O1, F2) or configuration (10D), and INSERTs are untouched (REG pins a late round on insert).
-- The trigger fires for every role, including the table owner and SECURITY DEFINER code (only session_replication_role =
-- replica, used by test fixtures, bypasses it).
--
-- Race safety: the trigger takes FOR SHARE on the program row. publish_competition_program updates that row, so a configure
-- write and a publish serialize: either the round write commits first (and the publish snapshot/pin sees it) or the publish
-- commits first and the round write is refused. READ COMMITTED re-reads the locked row after the wait.

begin;

do $$
begin
  if to_regclass('public.event_competition_program_locks') is null
     or to_regclass('public.competition_scoring_methods') is null then
    raise exception 'SS1 preflight: Phase 10B and REG (20270113090000) must be applied first.';
  end if;
  if to_regprocedure('public.guard_competition_round_scoring_lock()') is not null then
    raise exception 'SS1 preflight: guard_competition_round_scoring_lock already exists.';
  end if;
end $$;

create or replace function public.guard_competition_round_scoring_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_locked timestamptz;
begin
  if new.scoring_method is not distinct from old.scoring_method
     and new.sequence_number is not distinct from old.sequence_number
     and new.round_type is not distinct from old.round_type
     and new.division_id is not distinct from old.division_id
     and new.program_id is not distinct from old.program_id then
    return new;
  end if;

  -- Serialize against publish (which updates this row) and re-read the committed lock state.
  select p.profile_locked_at into v_locked
  from public.event_competition_programs p
  where p.id = old.program_id
  for share;

  if v_locked is not null then
    raise exception 'COMP_ROUND_SCORING_LOCKED: the scoring method, order, type and division of a round in a published competition cannot change (S4-7).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_competition_round_scoring_lock() from public, anon, authenticated, service_role;

create trigger guard_competition_round_scoring_lock
  before update of scoring_method, sequence_number, round_type, division_id, program_id on public.event_competition_rounds
  for each row execute function public.guard_competition_round_scoring_lock();

comment on function public.guard_competition_round_scoring_lock() is
  'SS1: refuses changes to scoring_method, sequence_number, round_type, division_id and program_id of a round whose program is profile-locked. No allowed writers.';

notify pgrst, 'reload schema';

commit;
