-- 20261130090000_twilio_tw4f_admin_panel.sql
-- TW-4F platform-admin subaccount onboarding panel (supervised pilot). Database side only; NO Twilio call is made by anything in it.
--   tw4_panel_overview(actor)              one read-only snapshot for the panel: legal businesses, their locations, setup budget, owner-approved fee
--                                           authorizations, pilot ceiling, subaccount, location requests, onboardings, tier decisions and recent evidence.
--   studio_sms_panel_requests / tw4_panel_subaccount_confirm   a one-time request key for the "Create subaccount" confirmation, so a double click or
--                                           a replayed form never leaves a second, unconsumed confirmation behind.
--   tier eligibility                        studio_sms_tier_decisions.eligibility + tw4_onboarding_decide_tier: Low-Volume Standard needs a complete,
--                                           recorded eligibility checklist; the old tw4_onboarding_set_tier now refuses Low-Volume Standard.
-- NON-FINANCIAL by design: no price, spend, credit, pilot, monthly-limit or audit-vocabulary object is created or replaced. Fee authorizations stay
-- in tw4_spend_authorize (one approval reference = one operation, enforced by its unique index); this file only READS those tables.
-- Depends on 20261129090000 (provider integration) and 20261122090000 (prepaid credits). Independent of 20261128090000 (monthly limits).
-- Rollback order: application first, then rollback/20261130090000_twilio_tw4f_admin_panel_rollback.sql (refuses once a panel request or an
-- eligibility record exists: that is evidence).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_tier_decisions') is null or to_regprocedure('public.tw4_onboarding_set_tier(uuid,uuid,text,text)') is null then
    raise exception 'TW-4F admin panel precondition failed: 20261129090000 is not applied';
  end if;
  if to_regclass('public.studio_sms_pilot_exceptions') is null or to_regclass('public.studio_sms_credit_accounts') is null then
    raise exception 'TW-4F admin panel precondition failed: 20261122090000 is not applied';
  end if;
  if to_regclass('public.studio_sms_panel_requests') is not null then
    raise exception 'TW-4F admin panel precondition failed: already applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- one-time request keys (Create subaccount confirmation)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_panel_requests (
  request_key uuid primary key,
  action text not null check (action in ('subaccount_confirm')),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  actor uuid not null,
  created_at timestamptz not null default now()
);
revoke all on public.studio_sms_panel_requests from public, anon, authenticated, service_role;
alter table public.studio_sms_panel_requests enable row level security;
create trigger studio_sms_panel_requests_10_append_only before update or delete on public.studio_sms_panel_requests
  for each row execute function public._sms_webhook_receipts_guard();
create trigger studio_sms_panel_requests_20_no_truncate before truncate on public.studio_sms_panel_requests
  for each statement execute function public._sms_webhook_receipts_guard();

-- Records the platform admin's typed confirmation to create ONE subaccount, at most once per request key. A replay of the same key (double click,
-- browser resubmit) is a no-op: {replayed: true}. A key used for another entity or by another admin is refused. Nothing is recorded for an entity
-- whose subaccount is already active, suspended or being created (nothing would consume it).
create or replace function public.tw4_panel_subaccount_confirm(p_request_key uuid, p_entity_id uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_panel_requests;
  a public.studio_sms_twilio_accounts;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_request_key is null or p_entity_id is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_panel_requests x where x.request_key = p_request_key;
  if r.request_key is not null then
    if r.legal_entity_id <> p_entity_id or r.actor <> p_actor or r.action <> 'subaccount_confirm' then
      raise exception 'this request key belongs to another action' using errcode = '22023';
    end if;
    return jsonb_build_object('replayed', true);
  end if;
  perform 1 from public.studio_sms_legal_entities e where e.id = p_entity_id for update;
  if not found then
    raise exception 'unknown legal entity' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_twilio_accounts x where x.legal_entity_id = p_entity_id;
  if a.status in ('active', 'suspended', 'creating') then
    raise exception 'the subaccount is % ; nothing to confirm', a.status using errcode = '55000';
  end if;
  insert into public.studio_sms_panel_requests (request_key, action, legal_entity_id, actor) values (p_request_key, 'subaccount_confirm', p_entity_id, p_actor);
  perform public.tw4_subaccount_confirm(p_entity_id, p_actor);
  return jsonb_build_object('replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- registration tier eligibility (Twilio ticket #29647095, answer 6: eligible EIN-registered studios, subject to Twilio review)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_tier_decisions add column eligibility jsonb null check (eligibility is null or jsonb_typeof(eligibility) = 'object');

create or replace function public._tw4p_lvs_checklist_complete(p jsonb)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p is not null and jsonb_typeof(p) = 'object'
    and coalesce((p ->> 'ein_registered')::boolean, false)
    and coalesce((p ->> 'not_sole_proprietor')::boolean, false)
    and coalesce((p ->> 'low_volume_expected')::boolean, false)
    and coalesce((p ->> 'owner_informed_limits')::boolean, false)
    and coalesce((p ->> 'owner_informed_review')::boolean, false);
$$;

-- The tier decision with its evidence. Low-Volume Standard needs the complete checklist AND a legal business on file with an EIN (the location's
-- entity); Standard needs only the reason. Same freeze rules as tw4_onboarding_set_tier (no runner lease, no brand attempt yet). The choice is a
-- DanceFlow review judgement; Twilio still reviews the brand and decides.
create or replace function public.tw4_onboarding_decide_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text, p_eligibility jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_entity uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if p_tier is null or p_tier not in ('standard', 'low_volume_standard') then
    raise exception 'unknown tier' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'a documented reason (10-300 characters) is required' using errcode = '22023';
  end if;
  if p_eligibility is not null and (jsonb_typeof(p_eligibility) <> 'object' or char_length(p_eligibility::text) > 1000) then
    raise exception 'invalid eligibility record' using errcode = '22023';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' for update;
  if o.id is null then
    raise exception 'no active onboarding' using errcode = '22023';
  end if;
  if p_tier = 'low_volume_standard' then
    if not public._tw4p_lvs_checklist_complete(p_eligibility) then
      raise exception 'Low-Volume Standard needs every eligibility check confirmed' using errcode = '22023';
    end if;
    select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
    if v_entity is null or not exists (select 1 from public.studio_sms_legal_entities e where e.id = v_entity and e.ein_last4 ~ '^[0-9]{4}$') then
      raise exception 'Low-Volume Standard needs the location''s legal business (with its EIN) on file first' using errcode = '22023';
    end if;
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
  insert into public.studio_sms_tier_decisions (onboarding_id, studio_id, tier, previous_tier, reason, decided_by, eligibility)
  values (o.id, o.studio_id, p_tier, o.tier, btrim(p_reason), p_actor, case when p_tier = 'low_volume_standard' then p_eligibility end);
  update public.studio_sms_onboarding set tier = p_tier where id = o.id;
  return jsonb_build_object('tier', p_tier, 'changed', true);
end $$;

-- The 20261129 entry point, unchanged except that it now refuses Low-Volume Standard (that needs the checklist above).
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
  if p_tier = 'low_volume_standard' then
    raise exception 'Low-Volume Standard needs the eligibility checklist (tw4_onboarding_decide_tier)' using errcode = '22023';
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


-- ---------------------------------------------------------------------------------------------------------------
-- the panel's read model (platform admin only; ids, names, amounts and states; never an EIN beyond its last four, never a token)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_panel_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'legal_name', e.legal_name, 'ein_last4', e.ein_last4, 'spend_cap_cents', e.spend_cap_cents,
        'committed_cents', public._tw4f3a_committed(e.id), 'created_at', e.created_at,
        'account', (select jsonb_build_object('status', a.status, 'account_sid', a.twilio_account_sid, 'friendly_name', a.friendly_name, 'updated_at', a.updated_at)
                    from public.studio_sms_twilio_accounts a where a.legal_entity_id = e.id),
        'open_confirmation', exists (select 1 from public.studio_sms_subaccount_confirmations c where c.legal_entity_id = e.id and c.consumed_at is null),
        'pilot', (select jsonb_build_object('ceiling_cents', pe.ceiling_cents, 'created_at', pe.created_at,
                    'used_cents', (select coalesce(sum(r.amount_cents), 0) from public.studio_sms_credit_reservations r
                                   where r.legal_entity_id = e.id and r.funding = 'pilot' and r.status in ('reserved', 'captured')),
                    'authorized_cents', (select coalesce(sum(s.amount_cents), 0) from public.studio_sms_spend_events s
                                         where s.legal_entity_id = e.id and s.funding = 'pilot' and s.status = 'authorized'))
                  from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = e.id),
        'credit', (select jsonb_build_object('balance_cents', ca.balance_cents, 'reserved_cents', ca.reserved_cents, 'hold', ca.hold)
                   from public.studio_sms_credit_accounts ca where ca.legal_entity_id = e.id),
        'studios', coalesce((select jsonb_agg(jsonb_build_object('studio_id', es.studio_id, 'name', st.name, 'link_kind', es.link_kind, 'linked_at', es.linked_at,
                      'verification_note', es.verification_note, 'supporting_checks', es.supporting_checks) order by es.linked_at)
                    from public.studio_sms_entity_studios es join public.studios st on st.id = es.studio_id where es.legal_entity_id = e.id), '[]'::jsonb),
        'spend', coalesce((select jsonb_agg(x order by (x ->> 'authorized_at') desc) from (
                    select jsonb_build_object('id', s.id, 'kind', s.kind, 'amount_cents', s.amount_cents, 'status', s.status, 'funding', s.funding,
                      'studio_id', s.studio_id, 'approval_ref', s.approval_ref, 'authorized_at', s.authorized_at, 'reserved_at', s.reserved_at,
                      'reservation_status', (select r.status from public.studio_sms_credit_reservations r where r.id = s.credit_reservation_id)) x
                    from public.studio_sms_spend_events s where s.legal_entity_id = e.id order by s.authorized_at desc limit 20) q), '[]'::jsonb)
      ) order by e.created_at)
      from public.studio_sms_legal_entities e), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(x order by (x ->> 'attested_at') desc) from (
        select jsonb_build_object('id', r.id, 'studio_id', r.studio_id, 'studio_name', st.name, 'claimed_legal_name', r.claimed_legal_name,
          'claimed_ein_last4', r.claimed_ein_last4, 'status', r.status, 'attested_at', r.attested_at, 'decided_at', r.decided_at,
          'decision_note', r.decision_note, 'legal_entity_id', r.legal_entity_id,
          -- the entity the claim points at (name key + EIN last four), as a SUGGESTION; the decision function re-checks everything
          'candidate_entity_id', (select e.id from public.studio_sms_legal_entities e
                                  where e.legal_name_key = public._tw4f3a_name_key(r.claimed_legal_name) and e.ein_last4 = r.claimed_ein_last4)) x
        from public.studio_sms_location_requests r join public.studios st on st.id = r.studio_id
        where r.status = 'pending' or r.decided_at > now() - interval '30 days'
        order by r.attested_at desc limit 50) q), '[]'::jsonb),
    'onboardings', coalesce((
      select jsonb_agg(jsonb_build_object('studio_id', o.studio_id, 'studio_name', st.name, 'onboarding_id', o.id, 'state', o.state, 'tier', o.tier,
        'legal_name', o.legal_name, 'ein_last4', o.ein_last4, 'submitted_at', o.submitted_at, 'submission_seq', o.submission_seq,
        'legal_entity_id', (select es.legal_entity_id from public.studio_sms_entity_studios es where es.studio_id = o.studio_id),
        'b1_status', (select s.status from public.studio_sms_provisioning_steps s where s.onboarding_id = o.id and s.step_key = 'B1' order by s.submission_seq desc limit 1),
        'brand_status', (select g.brand_status from public.studio_sms_registrations g where g.studio_id = o.studio_id),
        'registration_status', (select g.registration_status from public.studio_sms_registrations g where g.studio_id = o.studio_id),
        'tier_decisions', coalesce((select jsonb_agg(jsonb_build_object('tier', d.tier, 'previous_tier', d.previous_tier, 'reason', d.reason,
                              'eligibility', d.eligibility, 'decided_by', d.decided_by, 'decided_at', d.decided_at) order by d.decided_at desc)
                            from public.studio_sms_tier_decisions d where d.onboarding_id = o.id), '[]'::jsonb)) order by st.name)
      from public.studio_sms_onboarding o join public.studios st on st.id = o.studio_id
      where o.state <> 'cancelled'), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(x order by (x ->> 'at') desc) from (
        select jsonb_build_object('studio_id', au.studio_id, 'action', au.action, 'note', au.note, 'at', au.created_at, 'actor_type', au.actor_type) x
        from public.studio_sms_onboarding_audit au
        where au.action in ('entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved', 'spend_withdrawn',
                            'subaccount_confirmed', 'runner_subaccount', 'credit_pilot_exception', 'credit_reserved', 'credit_captured', 'credit_released')
        order by au.created_at desc limit 100) q), '[]'::jsonb),
    'prices', coalesce((select jsonb_object_agg(p.kind, p.customer_price_cents) from public.studio_sms_price_list p where p.active), '{}'::jsonb)
  );
end $$;

revoke all on function public.tw4_panel_subaccount_confirm(uuid, uuid, uuid), public.tw4_onboarding_decide_tier(uuid, uuid, text, text, jsonb),
  public.tw4_onboarding_set_tier(uuid, uuid, text, text), public.tw4_panel_overview(uuid), public._tw4p_lvs_checklist_complete(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.tw4_panel_subaccount_confirm(uuid, uuid, uuid), public.tw4_onboarding_decide_tier(uuid, uuid, text, text, jsonb),
  public.tw4_onboarding_set_tier(uuid, uuid, text, text), public.tw4_panel_overview(uuid)
  to service_role;

commit;
