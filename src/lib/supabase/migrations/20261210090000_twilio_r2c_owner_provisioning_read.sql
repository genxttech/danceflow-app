-- 20261210090000_twilio_r2c_owner_provisioning_read.sql
-- TW-4F R2c-I2: owner-safe, session-bound read of the studio's Messaging Service and campaign provisioning status.
--   * public.get_studio_sms_provisioning(p_studio_id): derives the caller from auth.uid(), never from an argument. Allowed: an ACTIVE studio_owner or studio_admin
--     of THAT studio, or a platform admin (read-only support view). Front desk, another studio's staff, anyone unauthenticated and the service role are refused (42501).
--   * Returns ONLY coarse enums: messaging_service {not_started|in_progress|ready|attention} and campaign {not_started|preparing|pending|approved|rejected|attention},
--     a bounded, redacted rejection summary (only when the provider read says FAILED; identifiers, links, addresses, digit runs and JSON structure removed, so no error-code values) and the time of the last provider read.
--   * Never returns a Twilio SID, an operation id, an error code value or detail, fee data, an account, or anything about another studio.
--   * Status follows PROVIDER EVIDENCE (studio_sms_prov_resources, written only by tw4_prov_observe from provider reads), never a submission response or an admin's typed claim:
--     'pending' needs a provider-read resource row; 'approved' needs the database's own VERIFIED verdict; an operation with an unknown outcome is 'preparing', not 'submitted'.
--   * Read-only: no table is written, nothing calls Twilio.
-- Requires 20261207090000 (R2a). Independent of 20261206 (#251), 20261208 (R2b) and 20261209 (recurring fee lifecycle): adds one function only.
-- Rollback: rollback/20261210090000_twilio_r2c_owner_provisioning_read_rollback.sql
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_prov_operations') is null or to_regclass('public.studio_sms_prov_resources') is null then
    raise exception 'R2c-I2 precondition failed: 20261207090000 (R2a) is not applied';
  end if;
  if to_regprocedure('public._sms_onb_studio_role(uuid)') is null or to_regprocedure('public._sms_onb_is_platform_admin()') is null
     or to_regprocedure('public._sms_onb_access_enabled(uuid)') is null then
    raise exception 'R2c-I2 precondition failed: the TW-4A onboarding helpers are missing';
  end if;
end $$;

create or replace function public.get_studio_sms_provisioning(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_role text := public._sms_onb_studio_role(p_studio_id);
  v_admin boolean := public._sms_onb_is_platform_admin();
  o public.studio_sms_onboarding;
  ms record;
  cp record;
  v_ms text;
  v_cp text;
  v_reason text;
begin
  if auth.uid() is null or (v_role is null and not v_admin) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_role is not null and v_role not in ('studio_owner', 'studio_admin') and not v_admin then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- the pilot switch: with it off, the page does not exist for the studio
  if not public._sms_onb_access_enabled(p_studio_id) then
    return jsonb_build_object('available', false);
  end if;

  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null then
    return jsonb_build_object('available', true, 'messaging_service', jsonb_build_object('status', 'not_started'),
                              'campaign', jsonb_build_object('status', 'not_started', 'rejection_summary', null, 'checked_at', null));
  end if;

  -- the newest live (not superseded) attempt of each kind FOR THIS onboarding, with the provider-read verdict beside it
  select p.status as op_status, r.status as res_status, r.observed_at, r.failure_reasons into ms
    from public.studio_sms_prov_operations p left join public.studio_sms_prov_resources r on r.operation_id = p.id
   where p.studio_id = p_studio_id and p.onboarding_id = o.id and p.op_kind = 'messaging_service' and p.superseded_at is null
   order by p.attempt desc limit 1;
  v_ms := case
    when not found then 'not_started'
    when ms.op_status in ('in_flight', 'unknown_outcome') then 'in_progress'
    when ms.op_status = 'succeeded' and ms.res_status in ('ready', 'verified') then 'ready'
    when ms.op_status = 'succeeded' and (ms.res_status is null or ms.res_status = 'pending') then 'in_progress'
    else 'attention'
  end;

  select p.status as op_status, r.status as res_status, r.observed_at, r.failure_reasons into cp
    from public.studio_sms_prov_operations p left join public.studio_sms_prov_resources r on r.operation_id = p.id
   where p.studio_id = p_studio_id and p.onboarding_id = o.id and p.op_kind = 'campaign' and p.superseded_at is null
   order by p.attempt desc limit 1;
  v_cp := case
    when not found then 'not_started'
    when cp.op_status in ('in_flight', 'unknown_outcome') then 'preparing'
    when cp.op_status = 'succeeded' and cp.res_status = 'verified' then 'approved'
    when cp.op_status = 'succeeded' and cp.res_status = 'failed' then 'rejected'
    when cp.op_status = 'succeeded' and cp.res_status in ('pending', 'ready') then 'pending'
    -- succeeded without a provider read (for example resolved by an admin) is not evidence of a submission: still being prepared
    when cp.op_status = 'succeeded' and cp.res_status is null then 'preparing'
    else 'attention'
  end;

  if v_cp = 'rejected' then
    -- bounded and redacted: provider text can carry identifiers, links, addresses, error codes and phone numbers. Order matters: printable only; any long
    -- alphanumeric token (a SID, even next to an underscore, or a fragment of one) -> [id]; links; addresses; every run of 3+ digits (error codes, phone
    -- numbers) -> [number]; the structural characters of the provider's JSON are removed.
    v_reason := nullif(btrim(left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(cp.failure_reasons, ''),
      '[^\x20-\x7e]', '', 'g'),
      '[A-Za-z0-9]{24,}', '(id)', 'g'),
      'https?://\S+', '(link)', 'g'),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '(email)', 'g'),
      '[0-9]{3,}', '(number)', 'g'),
      '[{}\[\]"]', '', 'g'), 200)), '');
  end if;

  return jsonb_build_object(
    'available', true,
    'messaging_service', jsonb_build_object('status', v_ms),
    'campaign', jsonb_build_object('status', v_cp, 'rejection_summary', v_reason,
                                   'checked_at', case when v_cp in ('pending', 'approved', 'rejected') then cp.observed_at else null end));
end $$;

revoke all on function public.get_studio_sms_provisioning(uuid) from public, anon, service_role;
grant execute on function public.get_studio_sms_provisioning(uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.get_studio_sms_provisioning(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.get_studio_sms_provisioning(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_studio_sms_provisioning(uuid)', 'EXECUTE') then
    raise exception 'R2c-I2 postcondition failed: unexpected privileges on get_studio_sms_provisioning';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.get_studio_sms_provisioning(uuid)'::regprocedure and p.prosecdef) then
    raise exception 'R2c-I2 postcondition failed: get_studio_sms_provisioning is not security definer';
  end if;
end $$;

commit;
