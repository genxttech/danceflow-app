-- Rollback for 20261119092000_twilio_tw4_r1_brand_runner.sql (TW-4 R1).
-- Drops the runner functions, the runner-window table and the ledger `mock` column, restores the audit action vocabulary and the 4A purge
-- functions (lifted verbatim). REFUSED once any runner ledger row, runner window or runner audit row exists (they record paid-step
-- confirmations and must not vanish silently; forward-fix instead).
-- Order: application first (the platform actions call these functions), then this script.
begin;

set local lock_timeout = '5s';

lock table public.studio_sms_provisioning_steps in access exclusive mode;
lock table public.studio_sms_onboarding_audit in access exclusive mode;
lock table public.studio_sms_runner_windows in access exclusive mode;

do $$
begin
  if exists (select 1 from public.studio_sms_provisioning_steps)
     or exists (select 1 from public.studio_sms_runner_windows)
     or exists (select 1 from public.studio_sms_onboarding_audit where action in ('runner_step', 'runner_ein_read', 'runner_lease', 'runner_window')) then
    raise exception 'R1 rollback refused: runner ledger, window or audit rows exist; forward-fix instead' using errcode = '55000';
  end if;
end $$;

drop function public.tw4_runner_set_window(uuid, uuid, integer, text);
drop function public.tw4_runner_claim(uuid, uuid, text, integer, text);
drop function public.tw4_runner_release(uuid, text);
drop function public.tw4_runner_get_inputs(uuid, text);
drop function public.tw4_runner_get_ein(uuid, text, uuid);
drop function public.tw4_runner_begin_step(uuid, text, text, text, boolean, uuid, boolean);
drop function public.tw4_runner_finish_step(uuid, text, text, text, text, text, text);
drop function public.tw4_runner_transition(uuid, text, text, text, text, text);
drop function public.tw4_runner_record_brand(uuid, text, text, text);
drop function public.tw4_runner_brand_approved(uuid, text);
drop function public.tw4_runner_status(uuid, uuid);
drop function public._tw4_r1_audit(public.studio_sms_onboarding, uuid, text, text, text, text);
drop function public._tw4_r1_lease(uuid, text);
drop function public._tw4_r1_step_ok(text);
drop function public._tw4_r1_is_platform_admin(uuid);

drop table public.studio_sms_runner_windows;
alter table public.studio_sms_provisioning_steps drop column mock;

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed'));

create or replace function public.purge_sms_onboarding_ein(p_onboarding_id uuid, p_reason text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if p_reason is null or p_reason not in ('brand_approved', 'terminal_30d', 'manual', 'owner_cancel') then
    raise exception 'unsupported purge reason' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = p_onboarding_id for update;
  if o.id is null or o.ein_ciphertext is null then return false; end if;
  -- re-checked under the row lock, so a stale candidate list (or a reopened record) is never purged early
  if p_reason = 'terminal_30d' and not (o.state in ('cancelled', 'blocked') and o.terminal_at is not null
                                        and o.terminal_at < now() - interval '30 days') then
    return false;
  end if;
  if p_reason = 'owner_cancel' and o.state <> 'cancelled' then return false; end if;
  update public.studio_sms_onboarding set ein_ciphertext = null, ein_key_id = null, ein_purged_at = now() where id = o.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, action, note)
  values (o.studio_id, o.id, 'system', 'ein_purged', 'reason=' || p_reason);
  return true;
end $$;

create or replace function public.purge_due_sms_onboarding_eins()
returns integer language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from public.studio_sms_onboarding
           where ein_ciphertext is not null and state in ('cancelled', 'blocked') and terminal_at < now() - interval '30 days' loop
    if public.purge_sms_onboarding_ein(r.id, 'terminal_30d') then n := n + 1; end if;
  end loop;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'tw4_runner_%' or proname like '_tw4_r1_%')) then
    raise exception 'R1 rollback self-check failed: functions remain';
  end if;
  if position('stale_exception' in (select prosrc from pg_proc where oid = 'public.purge_sms_onboarding_ein(uuid,text)'::regprocedure)) > 0 then
    raise exception 'R1 rollback self-check failed: 4A purge function not restored';
  end if;
end $$;

commit;
