-- 20261224090000_twilio_rfl_cancel_target.sql
-- TW-4F F5: ONE new READ-ONLY function for the cancellation runner (src/lib/sms/twilioIsv/cancelRunner.ts). Design: docs/twilio/TW-4F_F5_Release_Adapters.md.
--   tw4_rfl_cancel_target(p_operation_id, p_actor) -> jsonb | null
-- returns what the runner needs to release ONE authorized resource at the provider and to check its preconditions BEFORE the claim:
--   the operation's status, the resource's kind / provider SID / subaccount SID, a campaign's Messaging Service SID, a Messaging Service's live dependents,
--   and for a PHONE NUMBER the CONSUMED cancel_number dual-control approval bound to this operation (same resource, same approval reference, consumed by the
--   authorizing administrator no later than the authorization, requested_by <> decided_by).
-- FAILS CLOSED: an unknown operation, a resource row that does not match it, or a number without such an approval returns NULL (no target), and the runner then
-- claims nothing and calls nothing. A non-administrator actor is refused (42501).
-- STABLE, security definer, search_path pinned, EXECUTE for service_role only. Writes nothing. Changes no tw4_rfl_cancel_* / tw4_rfl_dual_* / _tw4rfl_* body.
-- The SIDs it returns are for the server-side runner only: the panel never renders them and the runner never logs them.
-- Requires 20261209090000 and 20261211090000. Rollback: rollback/20261224090000_twilio_rfl_cancel_target_rollback.sql (plain DROP).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_provider_resources') is null or to_regclass('public.studio_sms_provider_cancel_ops') is null
     or to_regclass('public.studio_sms_rfl_dual_requests') is null or to_regprocedure('public._tw4c_admin(uuid)') is null then
    raise exception 'rfl-cancel-target precondition failed: 20261209090000 and 20261211090000 must be applied first';
  end if;
  if to_regprocedure('public.tw4_rfl_cancel_target(uuid,uuid)') is not null then
    raise exception 'rfl-cancel-target precondition failed: tw4_rfl_cancel_target already exists';
  end if;
end $$;

create function public.tw4_rfl_cancel_target(p_operation_id uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_provider_cancel_ops;
  r public.studio_sms_provider_resources;
  q public.studio_sms_rfl_dual_requests;
  v_service text;
  v_dependents int := 0;
begin
  perform public._tw4c_admin(p_actor);
  select * into o from public.studio_sms_provider_cancel_ops x where x.id = p_operation_id;
  if o.id is null then
    return null;
  end if;
  select * into r from public.studio_sms_provider_resources x where x.id = o.resource_id;
  if r.id is null or r.legal_entity_id <> o.legal_entity_id or r.studio_id <> o.studio_id then
    return null;
  end if;
  if r.resource_kind = 'number' then
    -- the approval this operation's authorization consumed: never a pending / approved / foreign one
    select * into q from public.studio_sms_rfl_dual_requests x
     where x.action = 'cancel_number' and x.resource_id = r.id and x.status = 'consumed' and x.approval_ref_norm = o.ref_norm
       and x.consumed_by = o.authorized_by and x.consumed_at <= o.authorized_at and x.decided_by is not null and x.decided_by <> x.requested_by
     order by x.consumed_at desc limit 1;
    if q.id is null then
      return null;
    end if;
  elsif r.resource_kind = 'campaign' then
    -- the location's live Messaging Service in the same subaccount (one live resource of each kind per location)
    select x.provider_sid into v_service from public.studio_sms_provider_resources x
     where x.studio_id = r.studio_id and x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
       and x.resource_kind = 'messaging_service' and x.provider_state = 'active';
  else
    -- deleting a Messaging Service deletes its campaign with it at the provider
    select count(*) into v_dependents from public.studio_sms_provider_resources x
     where x.studio_id = r.studio_id and x.legal_entity_id = r.legal_entity_id and x.twilio_account_sid = r.twilio_account_sid
       and x.resource_kind = 'campaign' and x.provider_state = 'active';
  end if;
  return jsonb_build_object(
    'operation_id', o.id, 'resource_id', r.id, 'operation_status', o.status, 'kind', r.resource_kind, 'provider_state', r.provider_state,
    'provider_sid', r.provider_sid, 'account_sid', r.twilio_account_sid, 'messaging_service_sid', v_service, 'live_dependents', v_dependents,
    'dual_control', case when q.id is null then null else jsonb_build_object('request_id', q.id, 'resource_id', q.resource_id, 'requested_by', q.requested_by, 'decided_by', q.decided_by, 'status', q.status) end);
end $$;

revoke all on function public.tw4_rfl_cancel_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tw4_rfl_cancel_target(uuid, uuid) to service_role;

commit;
