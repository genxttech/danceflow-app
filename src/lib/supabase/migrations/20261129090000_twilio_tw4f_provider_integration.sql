-- 20261129090000_twilio_tw4f_provider_integration.sql
-- TW-4F provider integration (Twilio ticket #29647095 answers, 2026-10-19). Database side only; NO Twilio call is made by anything in it.
--   tw4_webhook_account(account_sid)     which legal business (and which studios) a subaccount-signed webhook belongs to. SID and status only, never a token.
--   sms_webhook_receipts                 replay ledger: one row per processed webhook event (MessageSid, MessageSid+status). Append-only.
--   sms_webhook_receipt_seen / _record   service-role check and record of a processed event.
--   studio_sms_tier_decisions            append-only evidence of the platform admin's registration-tier choice (Standard or Low-Volume Standard).
--   tw4_onboarding_set_tier / tw4_runner_tier  set (platform admin, before any brand attempt) and read (under the runner lease) that tier.
-- NON-FINANCIAL by design: no price, spend, credit, monthly-limit or audit-vocabulary object is created or replaced here (those belong to the
-- spending-limit work). A PAID Low-Volume Standard brand stays blocked in the application until a tier-specific brand price exists.
-- Depends on TW-4F-3a (20261121090000). Independent of 20261128090000 (monthly limits): either order applies cleanly.
-- Rollback order: application first, then rollback/20261129090000_twilio_tw4f_provider_integration_rollback.sql (refuses once any receipt or tier
-- decision exists: that is evidence).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_twilio_accounts') is null or to_regclass('public.studio_sms_entity_studios') is null then
    raise exception 'TW-4F provider integration precondition failed: TW-4F-3a is not applied';
  end if;
  if to_regclass('public.sms_webhook_receipts') is not null then
    raise exception 'TW-4F provider integration precondition failed: already applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- webhook account resolution (Twilio: subaccount webhooks are signed with the SUBACCOUNT auth token)
-- ---------------------------------------------------------------------------------------------------------------
-- The caller has only an UNVERIFIED AccountSid from the request body. This answers "is it one of our subaccounts, and whose?" so the caller can
-- fetch that subaccount's token and verify the signature. Only active or suspended accounts verify (suspended: callbacks for messages already sent
-- still arrive). Unknown, closed, failed or never-created accounts return found=false.
create or replace function public.tw4_webhook_account(p_account_sid text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_twilio_accounts;
begin
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into a from public.studio_sms_twilio_accounts x where x.twilio_account_sid = p_account_sid and x.status in ('active', 'suspended');
  if a.legal_entity_id is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'legal_entity_id', a.legal_entity_id,
    'status', a.status,
    'studio_ids', coalesce((select jsonb_agg(es.studio_id order by es.studio_id) from public.studio_sms_entity_studios es where es.legal_entity_id = a.legal_entity_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- replay ledger
-- ---------------------------------------------------------------------------------------------------------------
create table public.sms_webhook_receipts (
  kind text not null check (kind in ('inbound', 'status')),
  event_key text not null check (char_length(event_key) between 3 and 160),
  account_sid text null check (account_sid is null or account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  received_at timestamptz not null default now(),
  primary key (kind, event_key)
);
revoke all on public.sms_webhook_receipts from public, anon, authenticated, service_role;
alter table public.sms_webhook_receipts enable row level security;

create or replace function public._sms_webhook_receipts_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'sms_webhook_receipts rows are append-only' using errcode = '42501';
end $$;
create trigger sms_webhook_receipts_10_append_only before update or delete on public.sms_webhook_receipts
  for each row execute function public._sms_webhook_receipts_guard();
create trigger sms_webhook_receipts_20_no_truncate before truncate on public.sms_webhook_receipts
  for each statement execute function public._sms_webhook_receipts_guard();

create or replace function public.sms_webhook_receipt_seen(p_kind text, p_event_key text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.sms_webhook_receipts r where r.kind = p_kind and r.event_key = p_event_key);
$$;

-- Records a processed event. Returns true for the FIRST record, false when it was already recorded (a concurrent duplicate). The account is the
-- VERIFIED signing account (null = the parent account).
create or replace function public.sms_webhook_receipt_record(p_kind text, p_event_key text, p_account_sid text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_rows int;
begin
  if p_kind is null or p_kind not in ('inbound', 'status') or p_event_key is null or char_length(p_event_key) not between 3 and 160 then
    raise exception 'invalid webhook receipt' using errcode = '22023';
  end if;
  insert into public.sms_webhook_receipts (kind, event_key, account_sid) values (p_kind, p_event_key, p_account_sid) on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- registration tier (Twilio: eligible EIN-registered studios may use Low-Volume Standard brands and Low Volume Mixed campaigns, subject to review)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_tier_decisions (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.studio_sms_onboarding(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  tier text not null check (tier in ('standard', 'low_volume_standard')),
  previous_tier text null check (previous_tier is null or previous_tier in ('standard', 'low_volume_standard')),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  decided_by uuid not null,
  decided_at timestamptz not null default now()
);
create index studio_sms_tier_decisions_onboarding on public.studio_sms_tier_decisions (onboarding_id, decided_at);
revoke all on public.studio_sms_tier_decisions from public, anon, authenticated, service_role;
alter table public.studio_sms_tier_decisions enable row level security;
create trigger studio_sms_tier_decisions_10_append_only before update or delete on public.studio_sms_tier_decisions
  for each row execute function public._sms_onb_append_only();
create trigger studio_sms_tier_decisions_20_no_truncate before truncate on public.studio_sms_tier_decisions
  for each statement execute function public._sms_onb_refuse_truncate();

-- The tier is chosen by a platform admin (eligibility is a review judgement: EIN-registered, low expected volume) and is frozen as soon as ANY brand
-- attempt exists for the onboarding (a brand's type cannot change after creation; a second paid brand is never bought).
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

-- The tier a run uses. NULL (never chosen) means Standard: the owner's D3 decision for the pilot.
create or replace function public.tw4_runner_tier(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  return jsonb_build_object('tier', coalesce(o.tier, 'standard'), 'chosen', o.tier is not null);
end $$;

revoke all on function public.tw4_webhook_account(text), public.sms_webhook_receipt_seen(text, text), public.sms_webhook_receipt_record(text, text, text),
  public.tw4_onboarding_set_tier(uuid, uuid, text, text), public.tw4_runner_tier(uuid, text), public._sms_webhook_receipts_guard()
  from public, anon, authenticated, service_role;
grant execute on function public.tw4_webhook_account(text), public.sms_webhook_receipt_seen(text, text), public.sms_webhook_receipt_record(text, text, text),
  public.tw4_onboarding_set_tier(uuid, uuid, text, text), public.tw4_runner_tier(uuid, text)
  to service_role;

commit;
