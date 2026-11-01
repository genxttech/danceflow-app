-- Rollback of 20270205090000_twilio_price_monitor.sql. REFUSES while evidence or security-event rows exist (they are permanent evidence): export them first.
-- Roll the application back first (the monitor routes), then run this.
begin;
set local lock_timeout = '5s';
lock table public.studio_sms_price_monitor_evidence, public.studio_sms_price_security_events in access exclusive mode;
do $$
begin
  if exists (select 1 from public.studio_sms_price_monitor_evidence) or exists (select 1 from public.studio_sms_price_security_events) then
    raise exception 'price monitor rollback refused: rows exist; export them as evidence first';
  end if;
end $$;
drop function if exists public.tw4_price_monitor_digest();
drop function if exists public.tw4_price_monitor_events(bigint);
drop function if exists public.tw4_price_monitor_evidence_list(integer, bigint);
drop function if exists public.tw4_price_monitor_evidence_append(bigint, text, text, uuid, text, timestamptz, text);
drop table public.studio_sms_price_security_events;
drop table public.studio_sms_price_monitor_evidence;
drop function if exists public._tw4pricemon_immutable();
commit;
