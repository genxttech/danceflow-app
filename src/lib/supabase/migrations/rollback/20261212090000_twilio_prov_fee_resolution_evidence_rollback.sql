-- Rollback of 20261212090000 (TW-4F evidence-backed provisioning fee resolution).
-- REFUSES once any listing, disposition or orphan exists: provider and financial evidence is never destroyed (forward recovery is a new migration).
-- Restores R2a's tw4_prov_resolve / tw4_prov_settle_admin exactly as 20261207090000 defines them. The audit vocabulary extension is left in place (harmless).
-- Roll the application back first. Never run this on a shared database that has recorded evidence; use an isolated database or a transaction you ROLLBACK.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_prov_listings') is null then
    raise exception 'fee-resolution evidence rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_prov_listings) or exists (select 1 from public.studio_sms_prov_orphans) or exists (select 1 from public.studio_sms_prov_dispositions) then
    raise exception 'fee-resolution evidence rollback refused: evidence exists' using errcode = '55000';
  end if;
end $$;

drop trigger if exists studio_sms_prov_operations_orphan_block on public.studio_sms_prov_operations;
drop trigger if exists studio_sms_num_operations_orphan_block on public.studio_sms_num_operations;
drop trigger if exists studio_sms_prov_operations_refusal_disposition on public.studio_sms_prov_operations;

drop function if exists public.tw4_prov_evidence(uuid, uuid);
drop function if exists public.tw4_prov_orphan_close(uuid, uuid, text);
drop function if exists public.tw4_prov_orphan_register(uuid, uuid);
drop function if exists public.tw4_prov_listing_record(uuid, text, uuid, jsonb, text, text);

create or replace function public.tw4_prov_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
  v_kind text;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ case r.op_kind when 'messaging_service' then '^MG[0-9a-fA-F]{32}$' else '^QE[0-9a-fA-F]{32}$' end) then
    raise exception 'the resource sid found at the provider is required' using errcode = '22023';
  end if;
  update public.studio_sms_prov_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account and service confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'not_created' then
    foreach v_kind in array r.fee_kinds loop
      perform public._tw4prov_settle(r.id, v_kind, 'released', 'not_created');
    end loop;
  end if;
  if p_resolution = 'created' and r.op_kind = 'campaign' and o.state = 'service_setup' then
    update public.studio_sms_onboarding set state = 'campaign_pending', step = 'C1' where id = o.id returning * into o;
    perform public._tw4_r1_audit(o, p_actor, 'state_changed', 'service_setup', 'campaign_pending', 'campaign confirmed by an admin');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

create or replace function public.tw4_prov_settle_admin(p_operation_id uuid, p_actor uuid, p_kind text, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_prov_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_prov_operations x where x.id = p_operation_id;
  if r.id is null or p_kind is null or not (p_kind = any (r.fee_kinds)) then
    raise exception 'unknown operation or fee kind' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_prov_resolve' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':' || p_kind and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation and fee' using errcode = '22023';
  end if;
  perform public._tw4prov_settle(r.id, p_kind, p_outcome, 'admin');
  perform public._tw4_r1_audit(o, p_actor, 'prov_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || p_kind || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

drop function if exists public._tw4prov2_refusal_disposition();
drop function if exists public._tw4prov2_orphan_block();
drop function if exists public._tw4prov2_proof(uuid);
drop function if exists public._tw4prov2_is_pilot(uuid);
drop table public.studio_sms_prov_dispositions;
drop table public.studio_sms_prov_orphans;
drop table public.studio_sms_prov_listings;
drop function if exists public._tw4prov2_guard();

commit;
