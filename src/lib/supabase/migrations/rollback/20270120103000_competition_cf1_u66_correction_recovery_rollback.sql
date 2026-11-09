-- Rollback for 20270120103000_competition_cf1_u66_correction_recovery.sql. App first (hide the recovery control), then this file.
-- Refuses once any recovery audit row exists: a cancelled correction is evidence and is rolled forward, never deleted.
begin;

do $$
begin
  if to_regprocedure('public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)') is null then
    raise exception 'CF1-U66 rollback: U66 is not installed.';
  end if;
  if exists (select 1 from public.event_competition_result_events e where e.kind = 'round_state_changed' and e.refs ->> 'u66_recovery' = 'true') then
    raise exception 'CF1-U66 rollback refused: recovery audit rows exist (evidence); roll forward instead.';
  end if;
end $$;

drop function public.competition_round_correction_recovery(uuid);
drop function public.recover_correction_for_exclusion(uuid, uuid, text, text, uuid);
drop trigger cf1_u66_block_reopen on public.event_competition_rounds;
drop function public.cf1_u66_block_reopen();
drop trigger zz_cf1_u66_clear_correction_open on public.event_competition_rounds;
drop function public.cf1_u66_clear_correction_open();
drop function public._cf1_u66_blockers(uuid);

commit;
