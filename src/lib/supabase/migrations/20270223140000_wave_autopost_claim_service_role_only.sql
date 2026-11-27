-- Wave autopost claim: service role only.
-- claim_next_wave_sync_line_for_autopost is SECURITY DEFINER and has no caller check (it is meant for the cron runner, which uses the service role).
-- The original migration did REVOKE ... FROM PUBLIC and GRANT TO service_role, but Supabase default privileges had already granted EXECUTE to anon and
-- authenticated, so both could still call it (confirmed by read-only checks on DEV and PROD, 2026-11-23). A caller who knew a run id could move a line to
-- 'posting' and the run to 'posting', parking the run until someone resolves it. Revoke the direct grants.
begin;
revoke execute on function public.claim_next_wave_sync_line_for_autopost(uuid) from anon, authenticated;
commit;
