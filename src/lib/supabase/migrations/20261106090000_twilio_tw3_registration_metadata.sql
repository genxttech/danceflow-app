-- 20261106090000_twilio_tw3_registration_metadata.sql
--
-- Twilio TW-3: registration metadata / repeatability for studio_sms_registrations.
--
-- Additive. Adds the NON-SECRET provider identifiers and separate Brand/Campaign
-- states a platform admin needs to repeat the manual A2P setup per studio:
--
--   customer_profile_sid (BU...), brand_sid (BN...), phone_number_sid (PN...),
--   campaign_use_case ('mixed' only -- the single use case the product supports),
--   brand_status, campaign_status (not_started|in_review|approved|rejected|suspended).
--
-- registration_status stays the canonical app-level aggregate and the send gate.
-- Existing identifiers, constraints, indexes, trigger, RLS and grants are untouched.
-- 'approved' now additionally requires the full, consistent setup (all five SIDs,
-- sender, use case, Brand approved, Campaign approved). Contradictory component
-- states are rejected. No auth token / API secret / credential is stored here.
-- Preflight-verified: 0 rows on DEV and PROD at authoring time; the guard below
-- still fails closed if any existing 'approved' row could not satisfy the new rule.

begin;

do $$
declare
  v_bad bigint;
begin
  if to_regclass('public.studio_sms_registrations') is null then
    raise exception 'TW-3 precondition failed: studio_sms_registrations missing';
  end if;
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.studio_sms_registrations'::regclass and not attisdropped
      and attname in ('customer_profile_sid','brand_sid','phone_number_sid','campaign_use_case','brand_status','campaign_status')
  ) then
    raise exception 'TW-3 precondition failed: TW-3 columns already exist';
  end if;
  select count(*) into v_bad from public.studio_sms_registrations where registration_status = 'approved';
  if v_bad > 0 then
    raise exception 'TW-3 preflight failed: % approved row(s) predate the stricter approval rule; review manually', v_bad;
  end if;
end $$;

alter table public.studio_sms_registrations
  add column customer_profile_sid text,
  add column brand_sid text,
  add column phone_number_sid text,
  add column campaign_use_case text,
  add column brand_status text not null default 'not_started',
  add column campaign_status text not null default 'not_started';

alter table public.studio_sms_registrations
  add constraint studio_sms_registrations_customer_profile_sid_check check (
    customer_profile_sid is null or customer_profile_sid ~ '^BU[0-9a-fA-F]{32}$'
  ),
  add constraint studio_sms_registrations_brand_sid_check check (
    brand_sid is null or brand_sid ~ '^BN[0-9a-fA-F]{32}$'
  ),
  add constraint studio_sms_registrations_phone_number_sid_check check (
    phone_number_sid is null or phone_number_sid ~ '^PN[0-9a-fA-F]{32}$'
  ),
  add constraint studio_sms_registrations_campaign_use_case_check check (
    campaign_use_case is null or campaign_use_case in ('mixed')
  ),
  add constraint studio_sms_registrations_brand_status_check check (
    brand_status in ('not_started', 'in_review', 'approved', 'rejected', 'suspended')
  ),
  add constraint studio_sms_registrations_campaign_status_check check (
    campaign_status in ('not_started', 'in_review', 'approved', 'rejected', 'suspended')
  ),
  add constraint studio_sms_registrations_brand_approved_requires_sid check (
    brand_status <> 'approved' or brand_sid is not null
  ),
  add constraint studio_sms_registrations_campaign_approved_requires_sid_use_case check (
    campaign_status <> 'approved' or (campaign_sid is not null and campaign_use_case is not null)
  ),
  add constraint studio_sms_registrations_phone_sid_requires_sender check (
    phone_number_sid is null or sender_e164 is not null
  ),
  add constraint studio_sms_registrations_approved_requires_full_setup check (
    registration_status <> 'approved'
    or (
      customer_profile_sid is not null
      and brand_sid is not null
      and phone_number_sid is not null
      and campaign_use_case is not null
      and brand_status = 'approved'
      and campaign_status = 'approved'
    )
  );

create unique index uq_studio_sms_registrations_phone_number_sid
  on public.studio_sms_registrations (phone_number_sid)
  where phone_number_sid is not null;

comment on column public.studio_sms_registrations.campaign_use_case is
  'TW-3: A2P campaign use case. Constrained; only mixed (transactional appointments + staff 1:1 operational, no marketing) is supported.';
comment on column public.studio_sms_registrations.brand_status is
  'TW-3: Twilio Brand review state mirrored by a platform admin. registration_status remains the send gate.';
comment on column public.studio_sms_registrations.campaign_status is
  'TW-3: Twilio Campaign review state mirrored by a platform admin. registration_status remains the send gate.';

commit;
