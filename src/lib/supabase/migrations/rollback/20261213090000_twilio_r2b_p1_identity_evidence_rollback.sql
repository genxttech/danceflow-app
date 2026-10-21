-- Rollback of 20261213090000 (R2b-P1). REFUSES once provider identity evidence exists (evidence is never destroyed). Roll back BEFORE R2b's own rollback.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_num_identity_reads') is null then
    raise exception 'R2b-P1 rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_num_identity_reads) or exists (select 1 from public.studio_sms_onboarding_audit where action in ('num_identity_read', 'num_acknowledged')) then
    raise exception 'R2b-P1 rollback refused: provider identity evidence exists' using errcode = '55000';
  end if;
end $$;

drop function if exists public.tw4_num_identity_observe(uuid, text, jsonb, text, text);
drop function if exists public.tw4_num_inventory_ack(uuid, uuid, text, text);
drop function if exists public._tw4num_absence_evidence(public.studio_sms_num_operations);
drop table public.studio_sms_num_identity_reads;
drop function if exists public._tw4p1_guard();

-- the R2b (20261208) bodies
create or replace function public.tw4_num_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_resolution is null or p_resolution not in ('created', 'not_created') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a resolution and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null then
    raise exception 'unknown operation' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id for update;
  if r.status not in ('unknown_outcome', 'in_flight') or (r.status = 'in_flight' and r.started_at > clock_timestamp() - interval '20 minutes') then
    raise exception 'only an unresolved operation can be resolved (an attempt still in flight needs 20 minutes to be considered abandoned)' using errcode = '22023';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease; resolve after it finishes' using errcode = '55P03';
  end if;
  if r.fee_bearing and p_resolution = 'not_created' and r.started_at > clock_timestamp() - interval '20 minutes' then
    raise exception 'a fee operation cannot be declared not created within 20 minutes of its attempt' using errcode = '22023';
  end if;
  if p_resolution = 'created' and (p_provider_sid is null or p_provider_sid !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'the number sid found at the provider is required' using errcode = '22023';
  end if;
  if p_resolution = 'not_created' and r.fee_bearing and exists (select 1 from public.studio_sms_num_inventory_acks a where a.legal_entity_id = r.legal_entity_id and a.created_at >= r.started_at) then
    raise exception 'a number was acknowledged after this attempt started: investigate it before declaring the purchase not created' using errcode = 'TW034';
  end if;
  update public.studio_sms_num_operations set status = case when p_resolution = 'created' then 'succeeded' else 'abandoned' end,
    provider_sid = case when p_resolution = 'created' then p_provider_sid else provider_sid end, finished_at = clock_timestamp(),
    resolved_by = p_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note), error_code = coalesce(error_code, 'resolved') where id = r.id;
  -- 'created' captures nothing here: the typed SID is only a claim until a provider read of THIS account confirms it (observe captures)
  if r.fee_bearing and p_resolution = 'not_created' then
    perform public._tw4num_settle_if_held(r.id, 'released', 'not_created');
    perform public._tw4num_free_selection(r.selection_id, p_actor, 'resolved: not created');
  end if;
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';kind=' || r.op_kind || ';resolution=' || p_resolution);
  return jsonb_build_object('status', case when p_resolution = 'created' then 'succeeded' else 'abandoned' end);
end $$;

create or replace function public.tw4_num_settle_admin(p_operation_id uuid, p_actor uuid, p_outcome text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_num_operations;
  o public.studio_sms_onboarding;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'an outcome and a written reason (10-500 characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_num_operations x where x.id = p_operation_id;
  if r.id is null or not r.fee_bearing then
    raise exception 'unknown operation or no fee' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.id = r.onboarding_id for update;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a run holds the lease' using errcode = '55P03';
  end if;
  if r.status not in ('succeeded', 'abandoned') then
    raise exception 'an unresolved operation is closed through tw4_num_resolve' using errcode = '22023';
  end if;
  if p_outcome = 'released' and exists (select 1 from public.studio_sms_num_resources x where x.operation_id = r.id and x.status = 'owned') then
    raise exception 'the provider confirmed this number as owned: its fee cannot be released' using errcode = '22023';
  end if;
  if r.status = 'abandoned' and p_outcome = 'captured' then
    raise exception 'an operation declared not created cannot capture a fee' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = r.legal_entity_id for no key update;
  if not exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_credit_reservations cr on cr.id = se.credit_reservation_id
                  where se.reservation_key = 'prov:' || r.id::text || ':number' and cr.status = 'reserved') then
    raise exception 'no reservation is held for this operation' using errcode = '22023';
  end if;
  perform public._tw4prov_settle(r.id, 'number', p_outcome, 'admin');
  perform public._tw4_r1_audit(o, p_actor, 'num_resolved', o.state, o.state, 'op=' || r.id || ';settled=' || p_outcome || ';' || left(btrim(p_note), 150));
  return jsonb_build_object('status', p_outcome);
end $$;

create or replace function public.tw4_num_inventory_ack(p_studio_id uuid, p_actor uuid, p_phone_number_sid text, p_e164 text, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_account text;
begin
  perform public._tw4c_admin(p_actor);
  if p_phone_number_sid is null or p_phone_number_sid !~ '^PN[0-9a-fA-F]{32}$' or p_note is null or char_length(btrim(p_note)) not between 10 and 300
     or (p_e164 is not null and p_e164 !~ '^\+1[2-9][0-9]{9}$') then
    raise exception 'a number sid and a written reason (10-300 characters) are required' using errcode = '22023';
  end if;
  v_entity := public._tw4sr_lock(p_studio_id);
  v_account := public._tw4num_account(p_studio_id);
  if v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  -- a number that a purchase declared "not created" turned up: that is a paid number the ledger got wrong, not a foreign one. It is investigated, never acknowledged away.
  -- Fail closed: the database cannot tell WHICH number a lost purchase produced (an abandoned operation has no provider sid, and the e164 typed here is the caller's word), so while the
  -- business has ANY purchase declared not created, nothing is acknowledged for it: the late-found number must be investigated first. A number tied to a failed or retired purchase
  -- (by sid or e164) is refused as well.
  if exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and x.status in ('abandoned', 'in_flight', 'unknown_outcome'))
     or exists (select 1 from public.studio_sms_num_operations x where x.legal_entity_id = v_entity and x.op_kind = 'number_purchase' and (x.status = 'failed' or x.superseded_at is not null)
                  and (x.e164 = p_e164 or x.provider_sid = p_phone_number_sid)) then
    raise exception 'this business has a purchase declared not created, or this number belongs to a failed or retired purchase: investigate it, do not acknowledge it' using errcode = 'TW034';
  end if;
  insert into public.studio_sms_num_inventory_acks (legal_entity_id, twilio_account_sid, phone_number_sid, e164, acked_by, note)
  values (v_entity, v_account, p_phone_number_sid, p_e164, p_actor, btrim(p_note)) on conflict (twilio_account_sid, phone_number_sid) do nothing;
  return jsonb_build_object('acknowledged', p_phone_number_sid);
end $$;

revoke all on function public.tw4_num_inventory_ack(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.tw4_num_inventory_ack(uuid, uuid, text, text, text) to service_role;

do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'num_identity_read', 'num_acknowledged');
  if v_actions is null or cardinality(v_actions) < 10 then
    raise exception 'could not read the audit actions from %', v_def;
  end if;
  alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
  execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
end $$;

commit;
