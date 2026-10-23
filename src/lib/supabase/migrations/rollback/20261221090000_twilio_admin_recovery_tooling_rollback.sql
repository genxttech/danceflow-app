-- Rollback of 20261221090000_twilio_admin_recovery_tooling.sql: restores tw4_prov_observe (20261207) and tw4_num_registration_retry (20261217) exactly as they are on main and
-- drops the new functions. Data written while the migration was live stays valid and is kept (registrations, retirements and audit rows are ordinary lifecycle and ledger
-- rows); the audit vocabulary keeps 'rfl_registration_retry' while any audit row uses it. The restored bodies are verified against their main fingerprints and the
-- transaction aborts if either differs.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public._tw4prov_register_verified(uuid)') is null then
    raise exception 'recovery-tooling rollback precondition failed: the migration is not applied';
  end if;
  if position('20261221' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'::regprocedure)) = 0
     or position('_tw4f4_retry' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_registration_retry(uuid,uuid)'::regprocedure)) = 0 then
    raise exception 'recovery-tooling rollback precondition failed: a replaced function was changed after this migration (roll back the later migration first)';
  end if;
end $$;

create or replace function public.tw4_prov_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_expected_inbound text,
                                                   p_source text, p_digest text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  r public.studio_sms_prov_operations;
  v_ms public.studio_sms_prov_operations;
  v_prev public.studio_sms_prov_resources;
  v_status text;
  v_code text := null;
  v_provider_status text := null;
  v_reasons text := null;
  v_brand text;
  v_path text;
  v_parent text := null;
  v_use text := null;
  v_from_state text;
  v_kind text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_source is null or p_source not in ('provider_read', 'fake') or p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or pg_column_size(p_facts) > 8192 then
    raise exception 'invalid observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id and x.onboarding_id = o.id for update;
  if r.id is null or r.status <> 'succeeded' or r.superseded_at is not null then
    raise exception 'only a live, succeeded operation can be observed' using errcode = '22023';
  end if;
  v_from_state := o.state;
  select * into v_prev from public.studio_sms_prov_resources x where x.operation_id = r.id;

  if (p_facts ->> 'sid') is distinct from r.provider_sid then
    v_status := 'mismatch'; v_code := 'sid_mismatch';
  elsif (p_facts ->> 'account_sid') is distinct from r.twilio_account_sid then
    v_status := 'mismatch'; v_code := 'account_mismatch';
  elsif r.op_kind = 'messaging_service' then
    if p_expected_inbound is null or p_expected_inbound !~ '^https://[^\s]+/api/sms/twilio/inbound$' then
      raise exception 'the expected inbound route is required' using errcode = '22023';
    end if;
    if (p_facts ->> 'use_inbound_webhook_on_number') is distinct from 'false' or (p_facts ->> 'inbound_request_url') is distinct from p_expected_inbound then
      v_status := 'mismatch'; v_code := 'inbound_route';
    else
      v_status := 'ready';
    end if;
  else
    select * into v_ms from public.studio_sms_prov_operations x where x.studio_id = r.studio_id and x.op_kind = 'messaging_service' and x.status = 'succeeded' and x.superseded_at is null;
    v_brand := public._tw4prov_brand(r.studio_id);
    v_path := public.tw4_location_fee_kinds(r.studio_id) ->> 'path';
    v_parent := p_facts ->> 'messaging_service_sid';
    v_use := p_facts ->> 'us_app_to_person_usecase';
    v_provider_status := left(upper(coalesce(p_facts ->> 'campaign_status', '')), 40);
    if v_ms.id is null or v_parent is distinct from v_ms.provider_sid then
      v_status := 'mismatch'; v_code := 'service_mismatch';
    elsif v_brand is null or (p_facts ->> 'brand_registration_sid') is distinct from v_brand then
      v_status := 'mismatch'; v_code := 'brand_mismatch';
    elsif v_use is null or v_use not in ('MIXED', 'LOW_VOLUME') or v_use is distinct from (r.params ->> 'use_case') or v_use is distinct from public._tw4prov_use_case(v_path) then
      v_status := 'mismatch'; v_code := 'use_case_mismatch';
    elsif (p_facts ->> 'mock') is distinct from 'false' then
      v_status := 'mismatch'; v_code := 'mock_or_unknown';
    elsif v_provider_status = 'VERIFIED' then
      v_status := 'verified';
    elsif v_provider_status = 'FAILED' then
      v_status := 'failed';
      v_reasons := left(regexp_replace(coalesce(p_facts ->> 'errors', ''), '[^[:print:]]', ' ', 'g'), 500);
    elsif v_provider_status = 'IN_PROGRESS' then
      v_status := 'pending';
    else
      v_status := 'pending'; v_code := 'status_unrecognized';
    end if;
  end if;

  if v_prev.id is null then
    insert into public.studio_sms_prov_resources (operation_id, legal_entity_id, studio_id, twilio_account_sid, resource_kind, provider_sid, parent_sid, brand_sid, use_case, status,
                                                 mismatch_code, provider_status, failure_reasons, source, evidence_digest, verified_at)
    values (r.id, r.legal_entity_id, r.studio_id, r.twilio_account_sid, r.op_kind, r.provider_sid, v_parent, case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end,
            v_use, v_status, v_code, v_provider_status, v_reasons, p_source, p_digest, case when v_status = 'verified' then clock_timestamp() end);
  else
    update public.studio_sms_prov_resources set status = v_status, mismatch_code = v_code, provider_status = v_provider_status, failure_reasons = v_reasons, source = p_source,
      evidence_digest = p_digest, observed_at = clock_timestamp(), parent_sid = coalesce(v_parent, parent_sid), use_case = coalesce(v_use, use_case),
      brand_sid = coalesce(case when r.op_kind = 'campaign' then p_facts ->> 'brand_registration_sid' end, brand_sid),
      verified_at = case when v_status = 'verified' then coalesce(verified_at, clock_timestamp()) else null end
    where id = v_prev.id;
  end if;

  -- fees follow provider evidence: the vetting fee is captured once the provider holds the campaign; the first month on approval, released on rejection
  if r.fee_bearing and r.op_kind = 'campaign' and v_status in ('pending', 'verified', 'failed') then
    foreach v_kind in array r.fee_kinds loop
      if exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || v_kind and cr.status = 'reserved') then
        if v_kind = 'campaign_vetting' or v_status = 'verified' then
          perform public._tw4prov_settle(r.id, v_kind, 'captured', r.provider_sid);
        elsif v_status = 'failed' then
          perform public._tw4prov_settle(r.id, v_kind, 'released', 'campaign_rejected');
        end if;
      end if;
    end loop;
  end if;
  -- a provider rejection (or a later failure of a campaign that was approved) sends the onboarding to a human; it is never retried or paid again automatically
  if r.op_kind = 'campaign' and v_status = 'failed' and public._sms_onb_transition_allowed(o.state, 'exception') then
    update public.studio_sms_onboarding set state = 'exception', step = 'C1', last_error_code = 'campaign_rejected', last_error_field = null where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, null, 'state_changed', v_from_state, 'exception', 'campaign rejected by the provider');
  elsif r.op_kind = 'campaign' and v_status = 'verified' and o.state = 'campaign_pending' then
    update public.studio_sms_onboarding set step = 'N1', last_error_code = null where id = o.id returning * into o;
  end if;
  perform public._tw4_r1_audit(o, null, 'prov_observed', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';status=' || v_status || coalesce(';code=' || v_code, '') || ';src=' || p_source);
  return jsonb_build_object('status', v_status, 'code', v_code, 'state', o.state);
end $$;

create or replace function public.tw4_num_registration_retry(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_op uuid;
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4rfl_lock(public._tw4sr_lock(p_studio_id));
  select x.id into v_op from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null;
  if v_op is null then
    raise exception 'there is no live number purchase to register' using errcode = 'TW032';
  end if;
  return public._tw4num_register_owned(v_op);
end $$;

drop function public.tw4_admin_prov_proof(uuid, uuid);
drop function public.tw4_admin_exposure(uuid, uuid);
drop function public.tw4_admin_deferred_retire(uuid, text, uuid, text);
drop function public.tw4_admin_deferred_retirements(uuid);
drop function public._tw4f4_sender_status(uuid, text);
drop function public.tw4_admin_registration_gaps(uuid);
drop function public.tw4_admin_registration_retry(uuid, uuid, text, text);
drop function public._tw4f4_retry(uuid, text);
drop function public._tw4f4_retry_target(uuid, text);
drop function public._tw4prov_register_verified(uuid);
drop function public._tw4prov_ledger_reservation(uuid);

-- the audit vocabulary loses the new action only when no audit row uses it (audit rows are never deleted)
do $$
declare
  v_def text;
  v_actions text[];
begin
  if exists (select 1 from public.studio_sms_onboarding_audit a where a.action = 'rfl_registration_retry') then
    return;
  end if;
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text' and m[1] <> 'rfl_registration_retry';
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)'::regprocedure), chr(13), '')), 8) <> '08dcccbe'
     or left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_registration_retry(uuid,uuid)'::regprocedure), chr(13), '')), 8) <> 'b7f281b3' then
    raise exception 'recovery-tooling rollback postcondition failed: a restored body differs from its main definition';
  end if;
  if not has_function_privilege('service_role', 'public.tw4_num_registration_retry(uuid,uuid)', 'EXECUTE') or not has_function_privilege('service_role', 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_num_registration_retry(uuid,uuid)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_observe(uuid,text,uuid,jsonb,text,text,text)', 'EXECUTE') then
    raise exception 'recovery-tooling rollback postcondition failed: unexpected privileges on a restored function';
  end if;
end $$;

commit;
