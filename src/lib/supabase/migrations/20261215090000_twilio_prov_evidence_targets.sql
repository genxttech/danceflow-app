-- TW-4F: evidence targets. A READ-ONLY, lease-gated getter that tells the provider-evidence recorder, for every fee-bearing campaign operation of the onboarding that still
-- matters, the provider account and the Messaging Service the OPERATION WAS REGISTERED UNDER (its own recorded params), never the studio's current service.
--
-- tw4_prov_listing_record (20261212) already refuses any listing whose scope is not that recorded scope (TW049); this getter lets the recorder ask the question first, so it
-- performs the provider read against the right service and skips (reports, reads nothing) an operation whose historical identifiers are missing, unknown, ambiguous or
-- inconsistent. It changes no state, accepts no evidence, and does not touch R2a's or R2b's functions or tables. Nothing is migrated speculatively.
--
-- Requires 20261212090000 (the evidence recorder it serves). Apply in numeric order.

do $$
begin
  if to_regprocedure('public.tw4_prov_listing_record(uuid,text,uuid,jsonb,text,text)') is null then
    raise exception 'tw4_prov_evidence_targets requires the fee-resolution evidence migration (20261212090000)';
  end if;
end $$;

create or replace function public.tw4_prov_evidence_targets(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_active text;
  v_scope text;
  v_n int;
  v_reason text;
  v_out jsonb := '[]'::jsonb;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  for r in
    select * from public.studio_sms_prov_operations x
     where x.onboarding_id = o.id and x.op_kind = 'campaign' and x.fee_bearing and x.status in ('unknown_outcome', 'in_flight', 'abandoned', 'failed')
     order by x.attempt, x.id
  loop
    v_reason := null;
    v_scope := r.params ->> 'messaging_service_sid';
    select t.twilio_account_sid into v_active from public.studio_sms_twilio_accounts t where t.legal_entity_id = r.legal_entity_id and t.status = 'active';
    if v_active is null or v_active <> r.twilio_account_sid then
      v_reason := 'account_mismatch';
    elsif v_scope is null or v_scope !~ '^MG[0-9a-fA-F]{32}$' then
      v_reason := 'scope_missing';
    else
      -- the service must be one THIS ledger created for this studio, in the same subaccount (it may since have been replaced: late evidence about the original is still evidence)
      select count(distinct x.id) into v_n from public.studio_sms_prov_operations x
       where x.studio_id = r.studio_id and x.legal_entity_id = r.legal_entity_id and x.op_kind = 'messaging_service' and x.status = 'succeeded'
         and x.twilio_account_sid = r.twilio_account_sid and x.provider_sid = v_scope;
      if v_n = 0 then
        v_reason := 'scope_unknown';
      elsif v_n > 1 then
        v_reason := 'scope_ambiguous';
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'operation_id', r.id, 'status', r.status, 'twilio_account_sid', r.twilio_account_sid,
      'scope_sid', case when v_reason is null then v_scope else null end, 'ok', v_reason is null, 'reason', v_reason));
  end loop;
  return v_out;
end $$;

revoke all on function public.tw4_prov_evidence_targets(uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_prov_evidence_targets(uuid, text) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.tw4_prov_evidence_targets(uuid,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_evidence_targets(uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_prov_evidence_targets(uuid,text)', 'EXECUTE') then
    raise exception 'tw4_prov_evidence_targets postcondition failed: unexpected privileges';
  end if;
end $$;
