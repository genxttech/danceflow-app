-- 20270118090000_competition_ss1_advancement_freeze.sql
--
-- COMPETITION SS1: freeze event_competition_programs.advancement_method once the program is profile-locked (published).
--
-- Why: F2 reads the program's advancement_method for every round it calculates (competition_round_calculation_input ->
-- round.advancementMethod), and the callback-tally engine accepts a round only when that value is "promote_callback". The 10B lock
-- (protect_competition_program_profile) freezes only the profile key/version, the lock time and the draft transition, so a manager
-- could still edit advancement_method after publish and change which calculation F2 accepts for already-pinned rounds.
--
-- Adds ONE trigger function and ONE trigger. No existing function is redefined (10B's protect_competition_program_profile is
-- untouched), so there is nothing to md5-pin; the rollback drops exactly these two objects. The trigger is narrow: only
-- advancement_method, only when the program is locked (profile_locked_at is not null), only when the value actually changes.
-- It fires for every role, including the table owner and SECURITY DEFINER code; there is no allowed writer (no existing writer
-- updates this column: the 10B/10C/10C.5 functions update status/lock/registration columns only).
-- Draft, unlocked programs are unaffected, so the SS1 configure action (which sets promote_callback on a DRAFT) keeps working.
-- Programs already locked get the freeze from now on; no existing row is rewritten.
--
-- Race: an UPDATE of advancement_method and publish's UPDATE of profile_locked_at touch the same program row, so they serialize on
-- the row lock; the BEFORE trigger then sees the committed, locked version of the row (READ COMMITTED re-reads it).

begin;

do $$
begin
  if to_regclass('public.event_competition_programs') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'event_competition_programs' and column_name = 'profile_locked_at') then
    raise exception 'SS1 advancement freeze preflight: Phase 10B (profile_locked_at) must be applied first.';
  end if;
  if to_regprocedure('public.guard_competition_program_advancement_frozen()') is not null then
    raise exception 'SS1 advancement freeze preflight: guard_competition_program_advancement_frozen already exists.';
  end if;
end $$;

create or replace function public.guard_competition_program_advancement_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.advancement_method is distinct from old.advancement_method and old.profile_locked_at is not null then
    raise exception 'COMP_PROGRAM_ADVANCEMENT_FROZEN: the advancement method of a published competition cannot change (S4-7).'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_competition_program_advancement_frozen() from public, anon, authenticated, service_role;

create trigger guard_competition_program_advancement_frozen
  before update of advancement_method on public.event_competition_programs
  for each row execute function public.guard_competition_program_advancement_frozen();

comment on function public.guard_competition_program_advancement_frozen() is
  'SS1: refuses changing advancement_method of a profile-locked program. No allowed writers. F2 calculates against this value.';

notify pgrst, 'reload schema';

commit;
