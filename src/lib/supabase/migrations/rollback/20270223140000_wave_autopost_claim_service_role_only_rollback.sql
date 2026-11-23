-- Rollback of 20270223140000: restores the earlier (unintended) default grants.
begin;
grant execute on function public.claim_next_wave_sync_line_for_autopost(uuid) to anon, authenticated;
commit;
