-- Rollback of 20270224100000_twilio_emergency_subaccount_suspension.sql. NOT APPLIED anywhere; Git only.
-- FORWARD-FIX ONLY once evidence exists: this script refuses when any audit row, hold event or attempt exists (append-only evidence is never discarded),
-- or while any location is on a traffic hold. Roll the APPLICATION back first (no code may call the functions below), then run this.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.studio_sms_suspension_audit') is null then
    raise exception 'TW4SUSP_ROLLBACK: 20270224100000 is not applied';
  end if;
  if exists (select 1 from public.studio_sms_suspension_audit) or exists (select 1 from public.studio_sms_traffic_hold_events)
     or exists (select 1 from public.studio_sms_suspension_attempts) or exists (select 1 from public.studio_sms_optout_reconciliations) then
    raise exception 'TW4SUSP_ROLLBACK: evidence rows exist; this migration is forward-fix only from now on';
  end if;
  if (select enabled from public.studio_sms_suspension_switch where singleton) then
    raise exception 'TW4SUSP_ROLLBACK: the suspension switch is on; turn it off (audited) and forward-fix instead';
  end if;
end $$;

drop trigger if exists studio_sms_usage_attempts_traffic_hold on public.studio_sms_usage_attempts;

drop function if exists public.tw4susp_attempt_abandon(uuid, uuid, text, text);
drop function if exists public.tw4susp_reconciliation_attest(uuid, uuid, text, text);
drop function if exists public.tw4_traffic_hold_release(uuid, text);
drop function if exists public._tw4susp_release_blocker(uuid);
drop function if exists public._tw4susp_needs_reconciliation(uuid);
drop function if exists public.tw4susp_overview(uuid);
drop function if exists public.tw4susp_record(uuid, text, text, text, text, text, text, text);
drop function if exists public.tw4susp_verify_begin(uuid, text);
drop function if exists public.tw4susp_begin(uuid, text, text, text, int, text, text, text);
drop function if exists public.tw4susp_switch_state();
drop function if exists public.tw4susp_switch_set(boolean, uuid, text);
drop function if exists public.tw4_traffic_hold_for_account(text);
drop function if exists public.tw4_traffic_hold_state(uuid);
drop function if exists public.tw4_traffic_hold_set(uuid, boolean, uuid, text);
drop function if exists public._tw4susp_usage_hold_guard();

-- the tables are empty (checked above); their triggers go with them
drop table public.studio_sms_optout_reconciliations;
drop table public.studio_sms_suspension_audit;
drop table public.studio_sms_suspension_attempts;
drop table public.studio_sms_suspension_switch;
drop table public.studio_sms_traffic_hold_events;

drop function if exists public._tw4susp_switch_on();
drop function if exists public._tw4susp_state_ok(text);
drop function if exists public._tw4susp_audit(uuid, text, text, uuid, uuid, uuid, text, text, text, text, text, text, text, text, text);
drop function if exists public._tw4susp_text_ok(text, int, int);
drop function if exists public._tw4susp_tail(text);
drop function if exists public._tw4susp_held(uuid);
drop function if exists public._tw4susp_state_guard();
drop function if exists public._tw4susp_append_only();

do $$ begin
  if to_regclass('public.studio_sms_suspension_audit') is not null or to_regprocedure('public.tw4susp_begin(uuid, text, text, text, int, text, text, text)') is not null or to_regclass('public.studio_sms_optout_reconciliations') is not null
     or exists (select 1 from pg_trigger where tgname = 'studio_sms_usage_attempts_traffic_hold') then
    raise exception 'TW4SUSP_ROLLBACK_POSTCONDITION: objects remain';
  end if;
end $$;

commit;
