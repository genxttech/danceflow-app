-- Rollback of 20261214090000 (R2b-P2). REFUSES once any finding or event exists (evidence is never destroyed). Roll back BEFORE R2b-P1's rollback.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_num_orphans') is null then
    raise exception 'R2b-P2 rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_num_orphans) or exists (select 1 from public.studio_sms_num_orphan_events) then
    raise exception 'R2b-P2 rollback refused: orphan findings exist' using errcode = '55000';
  end if;
end $$;

do $$
begin
  -- the functions this migration installed must still be exactly its own
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4sr_ready(uuid)'::regprocedure), E'\r', '')) <> '2aa0dbec06c1a8fe4ea22c7658d6d522'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._tw4num_known(uuid)'::regprocedure), E'\r', '')) <> 'c109630a80ef75b2f9262614d249ab29'
     or md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_num_inventory_observe(uuid,text,jsonb,text,timestamptz)'::regprocedure), E'\r', '')) <> '042b2f2744d19ce92b648a7d7bfad2ee' then
    raise exception 'R2b-P2 rollback refused: a function it installed has been changed since (fingerprint)' using errcode = '55000';
  end if;
end $$;

drop function if exists public.tw4_num_orphan_escalate(integer);
drop function if exists public.tw4_num_recon_manual(uuid);
drop function if exists public._tw4num_has_resources(uuid);
drop function if exists public.tw4_num_recon_claim(uuid, text, integer);
drop function if exists public.tw4_num_recon_targets(integer, integer);
drop function if exists public.tw4_num_orphan_exposure(uuid);
drop function if exists public.tw4_num_inventory_status(uuid, uuid);
drop function if exists public.tw4_num_orphan_resolve(uuid, uuid, text, text);
drop function if exists public.tw4_num_inventory_observe(uuid, text, jsonb, text, timestamptz);

-- the R2b (20261208) bodies
create or replace function public._tw4sr_ready(p_studio_id uuid)
returns public.studio_sms_billed_senders language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  none public.studio_sms_billed_senders;
  s public.studio_sms_billed_senders;
  v_p public.studio_sms_num_operations;
  v_a public.studio_sms_num_operations;
  v_ms public.studio_sms_prov_operations;
  v_qe public.studio_sms_prov_operations;
begin
  if not exists (select 1 from public.studio_sms_num_operations o where o.studio_id = p_studio_id) and not exists (select 1 from public.studio_sms_prov_operations o where o.studio_id = p_studio_id) then
    return public._tw4sr_ready_core(p_studio_id);   -- neither R2a nor R2b touched this location: PR #249 behaviour exactly
  end if;
  -- an R2b location sends only while ACTIVE ...
  if not exists (select 1 from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state = 'active') then
    return none;
  end if;
  s := public._tw4sr_ready_core(p_studio_id);
  if s.id is null then
    return none;
  end if;
  -- ... and only from the sender its own LEDGER bought and attached (a free-form PR #249 sender row, another service or another number of the business does not send)
  select * into v_p from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_purchase' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'owned');
  select * into v_a from public.studio_sms_num_operations x where x.studio_id = p_studio_id and x.op_kind = 'number_attach' and x.status = 'succeeded' and x.superseded_at is null
     and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = x.id and r.status = 'attached');
  v_ms := public._tw4num_service(p_studio_id);
  v_qe := public._tw4num_campaign(p_studio_id);
  if v_p.id is null or v_a.id is null or v_ms.id is null or v_qe.id is null or v_a.provider_sid is distinct from v_p.provider_sid
     or s.phone_number_sid is distinct from v_p.provider_sid or s.sender_e164 is distinct from v_p.e164 or s.messaging_service_sid is distinct from v_ms.provider_sid
     or s.campaign_sid is distinct from v_qe.provider_sid or s.account_sid is distinct from v_p.twilio_account_sid then
    return none;
  end if;
  return s;
end $$;

create or replace function public._tw4num_known(p_entity uuid)
returns text[] language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(distinct k.sid), '{}'::text[]) from (
    select p.provider_sid sid from public.studio_sms_num_operations p where p.legal_entity_id = p_entity and p.provider_sid is not null and p.superseded_at is null and p.status <> 'abandoned'
    union select l.phone_number_sid from public.studio_sms_entity_studios es2 cross join lateral (select * from public.studio_sms_billed_senders b2 where b2.studio_id = es2.studio_id order by b2.seq desc limit 1) l
      where es2.legal_entity_id = p_entity and l.phone_number_sid is not null and l.status <> 'released'
    union select a.phone_number_sid from public.studio_sms_num_inventory_acks a where a.legal_entity_id = p_entity) k;
$$;

create or replace function public.tw4_num_inventory_observe(p_onboarding_id uuid, p_lease_owner text, p_sids text[], p_source text, p_listed_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
  v_account text;
  v_known text[];
  v_unknown int;
  v_missing int;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_sids is null or cardinality(p_sids) > 1000 or exists (select 1 from unnest(p_sids) x where x is null or x !~ '^PN[0-9a-fA-F]{32}$') then
    raise exception 'an inventory of number sids is required' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('provider_read', 'fake') or p_listed_at is null or p_listed_at > clock_timestamp() + interval '30 seconds' or p_listed_at < clock_timestamp() - interval '10 minutes' then
    raise exception 'invalid inventory observation' using errcode = '22023';
  end if;
  if p_source = 'fake' and not public._tw4sr_fake_allowed() then
    raise exception 'fake evidence is not accepted here' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = o.studio_id;
  v_account := public._tw4num_account(o.studio_id);
  if v_entity is null or v_account is null then
    raise exception 'this studio''s legal entity has no active Twilio subaccount' using errcode = 'TW005';
  end if;
  v_known := public._tw4num_known(v_entity);
  select count(*) into v_unknown from unnest(p_sids) x where not (x = any (v_known));
  select count(*) into v_missing from (
    select p.provider_sid sid from public.studio_sms_num_operations p
     where p.legal_entity_id = v_entity and p.op_kind = 'number_purchase' and p.status = 'succeeded' and p.superseded_at is null and p.twilio_account_sid = v_account
       and exists (select 1 from public.studio_sms_num_resources r where r.operation_id = p.id and r.status = 'owned')) l
   where not (l.sid = any (p_sids));
  insert into public.studio_sms_num_inventory_checks (onboarding_id, lease_owner, legal_entity_id, listed_count, unknown_count, missing_count, twilio_account_sid, source, listed_at, listed_sids)
  values (o.id, p_lease_owner, v_entity, cardinality(p_sids), v_unknown, v_missing, v_account, p_source, p_listed_at, p_sids);
  return jsonb_build_object('listed', cardinality(p_sids), 'unknown', v_unknown, 'missing', v_missing);
end $$;

drop trigger if exists studio_sms_num_operations_no_recon on public.studio_sms_num_operations;
drop function if exists public._tw4p2_no_recon_ops();
drop function if exists public._tw4num_health(uuid);
drop function if exists public._tw4num_send_blocked(text, text, text);
drop table public.studio_sms_num_orphan_events;
drop table public.studio_sms_num_orphans;
drop function if exists public._tw4p2_event(uuid, text, uuid, text);
drop function if exists public._tw4p2_guard();
alter table public.studio_sms_num_inventory_checks drop column mismatch_count;
alter table public.studio_sms_num_inventory_checks drop column duplicate_count;
comment on column public.studio_sms_num_inventory_checks.unknown_count is null;

revoke all on function public.tw4_num_inventory_observe(uuid, text, text[], text, timestamptz) from public, anon, authenticated;
grant execute on function public.tw4_num_inventory_observe(uuid, text, text[], text, timestamptz) to service_role;

commit;
