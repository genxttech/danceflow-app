-- Rollback of 20261202150000_twilio_tw4f_panel_monthly_limits.sql. Roll the APPLICATION back first (the panel calls this function; without it the
-- panel shows the monthly limit as not available). Read-only function: no data, nothing to preserve.
begin;

set local lock_timeout = '5s';

drop function if exists public.tw4_panel_monthly_limits(uuid);

commit;
