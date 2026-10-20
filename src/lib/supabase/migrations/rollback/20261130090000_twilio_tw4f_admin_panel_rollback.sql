-- Rollback of 20261130090000_twilio_tw4f_admin_panel.sql. Roll the APPLICATION back first (the panel calls these functions).
-- Refuses once a panel request key or a recorded eligibility checklist exists (evidence).
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_panel_requests') is null then
    raise exception 'rollback refused: 20261130090000 is not applied';
  end if;
  if exists (select 1 from public.studio_sms_panel_requests) or exists (select 1 from public.studio_sms_tier_decisions where eligibility is not null) then
    raise exception 'rollback refused: panel requests or eligibility records exist (evidence)';
  end if;
end $$;

drop function public.tw4_panel_overview(uuid);
drop function public.tw4_onboarding_decide_tier(uuid, uuid, text, text, jsonb);
drop function public._tw4p_lvs_checklist_complete(jsonb);
drop function public.tw4_panel_subaccount_confirm(uuid, uuid, uuid);
drop table public.studio_sms_panel_requests;
alter table public.studio_sms_tier_decisions drop column eligibility;

-- tw4_onboarding_set_tier: back to the 20261129090000 definition
create or replace function public.tw4_onboarding_set_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_tier is null or p_tier not in ('standard', 'low_volume_standard') then
    raise exception 'unknown tier' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception 'a reason (3-300 characters) is required' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'no active onboarding' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a runner holds this onboarding' using errcode = '55P03';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.step_key = 'B1') then
    raise exception 'the tier is frozen once a brand attempt exists' using errcode = '55000';
  end if;
  if o.tier is not distinct from p_tier then
    return jsonb_build_object('tier', o.tier, 'changed', false);
  end if;
  insert into public.studio_sms_tier_decisions (onboarding_id, studio_id, tier, previous_tier, reason, decided_by)
  values (o.id, o.studio_id, p_tier, o.tier, btrim(p_reason), p_actor);
  update public.studio_sms_onboarding set tier = p_tier where id = o.id;
  return jsonb_build_object('tier', p_tier, 'changed', true);
end $$;
revoke all on function public.tw4_onboarding_set_tier(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.tw4_onboarding_set_tier(uuid, uuid, text, text) to service_role;

commit;
