-- Rollback for 20270118090000_competition_ss1_advancement_freeze.sql
--
-- The migration only ADDS one trigger and its function (no existing object is redefined), so the exact previous state is
-- "neither exists". Refuses (changing nothing) if the trigger is missing, so a repeat run is a visible failure.

begin;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_competition_program_advancement_frozen'
                 and tgrelid = 'public.event_competition_programs'::regclass and not tgisinternal) then
    raise exception 'SS1 advancement freeze rollback refused: guard_competition_program_advancement_frozen is not installed.';
  end if;
end $$;

drop trigger guard_competition_program_advancement_frozen on public.event_competition_programs;
drop function public.guard_competition_program_advancement_frozen();

notify pgrst, 'reload schema';

commit;
