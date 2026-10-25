-- Rollback for 20270116090000_competition_ss1_round_scoring_lock.sql
--
-- The migration only ADDS two triggers, their functions and the configure RPC (no existing object is redefined), so the exact
-- previous state is "none of them exists". Refuses (changing nothing) if the trigger is missing, so a repeat run is a visible no-op failure.
-- Roll the application back first: with the trigger gone, the SS1 configure action regains the publish race.

begin;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'guard_competition_round_scoring_lock'
                 and tgrelid = 'public.event_competition_rounds'::regclass and not tgisinternal) then
    raise exception 'SS1 rollback refused: guard_competition_round_scoring_lock is not installed.';
  end if;
end $$;

drop function public.apply_competition_scoring_setup(uuid, jsonb);
drop trigger guard_competition_round_delete on public.event_competition_rounds;
drop function public.guard_competition_round_delete();
drop trigger guard_competition_round_scoring_lock on public.event_competition_rounds;
drop function public.guard_competition_round_scoring_lock();

notify pgrst, 'reload schema';

commit;
