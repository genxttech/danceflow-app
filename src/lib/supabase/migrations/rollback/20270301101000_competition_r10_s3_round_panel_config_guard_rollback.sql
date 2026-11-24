-- Rollback of 20270301101000_competition_r10_s3_round_panel_config_guard.sql. Drops the trigger and its function; no data is touched.
begin;
drop trigger if exists compr10_guard_round_panel_config on public.event_competition_rounds;
drop function if exists public._comp_r10_guard_round_panel_config();
commit;
