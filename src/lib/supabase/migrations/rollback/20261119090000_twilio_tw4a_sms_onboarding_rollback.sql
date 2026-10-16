-- Rollback for 20261119090000_twilio_tw4a_sms_onboarding.sql (TW-4A).
-- Drops the four onboarding tables and every TW-4A function. REFUSED once any onboarding data, pilot-access row, audit row or
-- ledger row exists: those hold attestations and history that must not vanish silently (forward-fix instead).
-- Rollback order: application first (the settings page and legal pages call these RPCs), then this script.
begin;

set local lock_timeout = '5s';

lock table public.studio_sms_onboarding_access in access exclusive mode;
lock table public.studio_sms_onboarding in access exclusive mode;
lock table public.studio_sms_provisioning_steps in access exclusive mode;
lock table public.studio_sms_onboarding_audit in access exclusive mode;

do $$
begin
  if exists (select 1 from public.studio_sms_onboarding_access)
     or exists (select 1 from public.studio_sms_onboarding)
     or exists (select 1 from public.studio_sms_provisioning_steps)
     or exists (select 1 from public.studio_sms_onboarding_audit) then
    raise exception 'TW-4A rollback refused: onboarding, pilot-access, ledger or audit rows exist; forward-fix instead'
      using errcode = '55000';
  end if;
end $$;

drop function public.set_sms_onboarding_access(uuid, boolean, text);
drop function public.list_sms_onboardings();
drop function public.get_studio_sms_status(uuid);
drop function public.get_sms_onboarding_draft(uuid);
drop function public.save_sms_onboarding_draft(uuid, jsonb);
drop function public.submit_sms_onboarding(uuid, jsonb);
drop function public.cancel_sms_onboarding(uuid);
drop function public.store_sms_onboarding_ein(uuid, uuid, text, text, text);
drop function public.purge_sms_onboarding_ein(uuid, text);
drop function public.purge_due_sms_onboarding_eins();
drop function public.get_sms_legal_context(text);
drop function public._sms_onb_missing(public.studio_sms_onboarding);

drop table public.studio_sms_provisioning_steps;
drop table public.studio_sms_onboarding_audit;
drop table public.studio_sms_onboarding;
drop table public.studio_sms_onboarding_access;

drop function public._sms_onb_audit(uuid, uuid, text, text, text, text, text);
drop function public._sms_onb_integrity();
drop function public._sms_onb_append_only();
drop function public._sms_onb_refuse_truncate();
drop function public._sms_onb_steps_guard();
drop function public._sms_onb_transition_allowed(text, text);
drop function public._sms_onb_access_enabled(uuid);
drop function public._sms_onb_studio_role(uuid);
drop function public._sms_onb_is_platform_admin();

do $$
begin
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname like 'studio\_sms\_onboarding%')
     or exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = 'studio_sms_provisioning_steps')
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and (proname like '\_sms\_onb\_%'
          or proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status', 'get_sms_onboarding_draft',
                         'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding', 'store_sms_onboarding_ein',
                         'purge_sms_onboarding_ein', 'purge_due_sms_onboarding_eins', 'get_sms_legal_context'))) then
    raise exception 'TW-4A rollback self-check failed: objects remain';
  end if;
end $$;

commit;
