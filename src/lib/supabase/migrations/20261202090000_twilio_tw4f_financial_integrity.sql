-- 20261202090000_twilio_tw4f_financial_integrity.sql
-- TW-4F financial-integrity follow-up (two items). Database side; NO Twilio or Stripe call is made by anything in it. NO price is published.
--
-- 1. Approval-reference permanence.
--    Until now one written fee-approval reference authorized one OPEN operation (a partial unique index on authorized/reserved spend events): once the
--    approval was withdrawn, released or consumed the same reference could be recorded again, for the same or ANOTHER legal business. Now:
--      studio_sms_approval_refs   append-only registry, ONE row per normalized reference for the life of the system (never freed): the reference, its
--                                 legal business, location (if the approval names one), spend authorization, fee kind, amount, funding and approver.
--                                 Written by triggers in the same transaction as the authorization (any insert path), so it cannot be skipped.
--                                 Normalization: NFKC, trimmed, internal whitespace collapsed, case-folded ("Email 2026-10-20" = " email  2026-10-20 ").
--      The founder's pilot-exception reference and the monthly-limit ceiling approvals share the namespace: a ceiling or pilot approval is never
--      accepted as an operation approval (and the reverse).
--      tw4_spend_authorize        an identical retry (same business, kind, amount, funding, location, approver) of a STILL-UNUSED authorization returns
--                                 it (replayed); any other reuse is refused (TW019). Concurrent attempts serialize on the registry key.
--      tw4_approval_ref_trace     platform-admin read: the full linkage of one reference (authorization -> reservation -> operation -> ledger).
-- 2. Low-Volume Standard pricing.
--      new fee kinds   brand_low_volume     (Low-Volume Standard brand: STANDARD brand type, no automatic secondary vetting)
--                      monthly_low_volume   (Low Volume Mixed campaign monthly fee; campaign vetting stays the shared campaign_vetting kind)
--      A kind is usable only on the matching registration path, enforced in the database for every authorization naming a location and for EVERY credit
--      reservation (setup fee, recurring commitment, recurring charge): brand / monthly need Standard (or no tier chosen, the D3 default); the low-volume
--      kinds need an active onboarding on Low-Volume Standard whose latest tier decision carries the complete eligibility checklist and whose legal
--      business's EIN matches the submitted setup ("verified eligibility"). Anything else is refused (TW020). The tier cannot be switched while an open
--      approval or an active recurring authorization of the other path exists for the location.
--      Prices stay DRAFT (docs/twilio/TW-4F-3b_Pricing_Proposal.md): nothing here publishes one, and without a published price every authorization of
--      these kinds is refused (TW008) exactly as before.
--    The Standard + MIXED path is unchanged: same functions, same kinds, same checks; its only new refusals are the cross-path ones above.
--
-- Depends on 20261130090000 (tier eligibility) and 20261128090000 (monthly limits; tw4_recurring_authorize is replaced from its definition).
-- Independent of 20261201090000 (usage). Hosted order: 20261128 -> 20261129 -> 20261130 -> 20261201 -> 20261202.
-- Refuses to apply if existing evidence already reuses a reference (that needs a human reconciliation first).
-- Rollback: application first, then rollback/20261202090000_twilio_tw4f_financial_integrity_rollback.sql (refuses once a low-volume kind is used).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

-- no approval of any kind may be recorded between the duplicate check, the backfill and the triggers below (review P2-6)
lock table public.studio_sms_spend_events, public.studio_sms_pilot_exceptions, public.studio_sms_limit_ceilings in share row exclusive mode;

do $$
begin
  if to_regprocedure('public.tw4_onboarding_decide_tier(uuid,uuid,text,text,jsonb)') is null or to_regprocedure('public._tw4p_lvs_checklist_complete(jsonb)') is null then
    raise exception 'TW-4F financial integrity precondition failed: 20261130090000 is not applied';
  end if;
  if to_regclass('public.studio_sms_limit_ceilings') is null or to_regprocedure('public._tw4ml_require_room(uuid,bigint,bigint)') is null then
    raise exception 'TW-4F financial integrity precondition failed: 20261128090000 is not applied';
  end if;
  if to_regclass('public.studio_sms_approval_refs') is not null then
    raise exception 'TW-4F financial integrity precondition failed: already applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. approval references
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4fi_ref_norm(p text)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp
-- NFKC; invisible format characters removed (soft hyphen, Mongolian vowel separator, zero-width space/joiners, bidi marks, word joiner, BOM);
-- dash and quote variants folded to ASCII; every whitespace run (tabs, newlines, NBSP) collapsed and THEN trimmed; lower-cased.
-- So "Owner email 2026–10–20<TAB>" and "owner  email 2026-10-20" are the same reference.
as $$
  select lower(btrim(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(normalize(coalesce(p, ''), NFKC), '[­᠎​-‏‪-‮⁠-⁯﻿]', '', 'g'),
      '[‐-―−﹘﹣]', '-', 'g'),
      '[‘’‚‛′´]', '''', 'g'),
      '[“”„‟″]', '"', 'g'),
    '\s+', ' ', 'g')));
$$;

-- existing evidence must not already reuse a reference (otherwise the linkage is ambiguous: fail closed, reconcile by hand)
do $$
declare v_dup text;
begin
  select n into v_dup from (
    select public._tw4fi_ref_norm(approval_ref) n from public.studio_sms_spend_events
    union all select public._tw4fi_ref_norm(approval_ref) from public.studio_sms_pilot_exceptions) x
  group by n having count(*) > 1 limit 1;
  if v_dup is not null then
    raise exception 'TW-4F financial integrity: an approval reference is already used by more than one authorization; reconcile before applying';
  end if;
  if exists (select 1 from public.studio_sms_limit_ceilings c join public.studio_sms_spend_events s on public._tw4fi_ref_norm(s.approval_ref) = public._tw4fi_ref_norm(c.approval_ref))
     or exists (select 1 from public.studio_sms_limit_ceilings c join public.studio_sms_pilot_exceptions p on public._tw4fi_ref_norm(p.approval_ref) = public._tw4fi_ref_norm(c.approval_ref)) then
    raise exception 'TW-4F financial integrity: a fee approval reference is also a limit-ceiling approval; reconcile before applying';
  end if;
end $$;

create table public.studio_sms_approval_refs (
  ref_norm text primary key check (char_length(ref_norm) between 3 and 2000),
  approval_ref text not null,   -- as written
  source text not null check (source in ('spend_authorization', 'pilot_exception')),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  studio_id uuid null,   -- the location the approval names (null: a credit-funded approval for the whole legal business; the reservation then names it)
  spend_event_id uuid null unique references public.studio_sms_spend_events(id) on delete restrict,
  kind text null,
  amount_cents int null,
  funding text null,
  approved_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint studio_sms_approval_refs_shape check (
    (source = 'spend_authorization' and spend_event_id is not null and kind is not null and amount_cents is not null and funding is not null)
    or (source = 'pilot_exception' and spend_event_id is null and kind is null and amount_cents is null and funding is null and studio_id is null)),
  constraint studio_sms_approval_refs_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
revoke all on public.studio_sms_approval_refs from public, anon, authenticated, service_role;
alter table public.studio_sms_approval_refs enable row level security;

create or replace function public._tw4fi_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'approval references are permanent' using errcode = '42501'; end $$;
create trigger studio_sms_approval_refs_10_append_only before update or delete on public.studio_sms_approval_refs for each row execute function public._tw4fi_append_only();
create trigger studio_sms_approval_refs_20_no_truncate before truncate on public.studio_sms_approval_refs for each statement execute function public._tw4fi_append_only();

-- backfill (the duplicate check above guarantees one row per reference)
insert into public.studio_sms_approval_refs (ref_norm, approval_ref, source, legal_entity_id, studio_id, spend_event_id, kind, amount_cents, funding, approved_by, created_at)
select public._tw4fi_ref_norm(s.approval_ref), s.approval_ref, 'spend_authorization', s.legal_entity_id, s.studio_id, s.id, s.kind, s.amount_cents, s.funding, s.authorized_by, s.authorized_at
  from public.studio_sms_spend_events s;
insert into public.studio_sms_approval_refs (ref_norm, approval_ref, source, legal_entity_id, approved_by, created_at)
select public._tw4fi_ref_norm(p.approval_ref), p.approval_ref, 'pilot_exception', p.legal_entity_id, p.approved_by, p.created_at
  from public.studio_sms_pilot_exceptions p;

-- registers a reference (caller: the insert triggers below). A reference already registered, or used for a limit-ceiling approval, is refused: TW019.
create or replace function public._tw4fi_register(p_raw text, p_source text, p_entity uuid, p_studio uuid, p_spend uuid, p_kind text, p_cents int, p_funding text, p_actor uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_norm text := public._tw4fi_ref_norm(p_raw);
begin
  if char_length(v_norm) < 3 then
    raise exception 'an approval reference is required' using errcode = '22023';
  end if;
  -- one reference at a time across the fee, pilot and ceiling namespaces (the checks below then see every committed use of it)
  perform pg_advisory_xact_lock(hashtextextended('tw4fi_ref:' || v_norm, 0));
  if exists (select 1 from public.studio_sms_limit_ceilings c where public._tw4fi_ref_norm(c.approval_ref) = v_norm) then
    raise exception 'this approval reference was recorded for a spending-limit approval: a fee needs its own written approval' using errcode = 'TW019';
  end if;
  begin
    insert into public.studio_sms_approval_refs (ref_norm, approval_ref, source, legal_entity_id, studio_id, spend_event_id, kind, amount_cents, funding, approved_by)
    values (v_norm, btrim(p_raw), p_source, p_entity, p_studio, p_spend, p_kind, p_cents, p_funding, p_actor);
  exception when unique_violation then
    raise exception 'this approval reference was already used: one written approval authorizes one operation, once' using errcode = 'TW019';
  end;
end $$;

create or replace function public._tw4fi_spend_ref_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4fi_register(new.approval_ref, 'spend_authorization', new.legal_entity_id, new.studio_id, new.id, new.kind, new.amount_cents, new.funding, new.authorized_by);
  return null;
end $$;
create trigger studio_sms_spend_events_30_approval_ref after insert on public.studio_sms_spend_events for each row execute function public._tw4fi_spend_ref_trigger();

create or replace function public._tw4fi_pilot_ref_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4fi_register(new.approval_ref, 'pilot_exception', new.legal_entity_id, null, null, null, null, null, new.approved_by);
  return null;
end $$;
create trigger studio_sms_pilot_exceptions_30_approval_ref after insert on public.studio_sms_pilot_exceptions for each row execute function public._tw4fi_pilot_ref_trigger();

-- a ceiling approval may repeat another ceiling's reference (one written approval can cover several ceilings) but never a fee approval's
create or replace function public._tw4fi_ceiling_ref_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tw4fi_ref:' || public._tw4fi_ref_norm(new.approval_ref), 0));
  if exists (select 1 from public.studio_sms_approval_refs r where r.ref_norm = public._tw4fi_ref_norm(new.approval_ref)) then
    raise exception 'this approval reference was recorded for a fee approval: a spending-limit approval needs its own reference' using errcode = 'TW019';
  end if;
  return new;
end $$;
create trigger studio_sms_limit_ceilings_30_approval_ref before insert on public.studio_sms_limit_ceilings for each row execute function public._tw4fi_ceiling_ref_trigger();
-- the reference triggers also fire in replica mode (restores, data-fix scripts): no session setting can record an approval without its reference
alter table public.studio_sms_spend_events enable always trigger studio_sms_spend_events_30_approval_ref;
alter table public.studio_sms_pilot_exceptions enable always trigger studio_sms_pilot_exceptions_30_approval_ref;
alter table public.studio_sms_limit_ceilings enable always trigger studio_sms_limit_ceilings_30_approval_ref;

-- the partial index (open approvals only) is superseded by the registry; it stays as a second, redundant guard

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Low-Volume Standard price kinds
-- ---------------------------------------------------------------------------------------------------------------
alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check
  check (kind in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume', 'sms_usage'));
alter table public.studio_sms_credit_reservations drop constraint studio_sms_credit_reservations_kind_check;
alter table public.studio_sms_credit_reservations add constraint studio_sms_credit_reservations_kind_check
  check (kind in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume', 'sms_usage'));
alter table public.studio_sms_provider_charges drop constraint studio_sms_provider_charges_kind_check;
alter table public.studio_sms_provider_charges add constraint studio_sms_provider_charges_kind_check
  check (kind in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume', 'sms_usage'));
alter table public.studio_sms_spend_events drop constraint studio_sms_spend_events_kind_check;
alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_kind_check
  check (kind in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume'));
alter table public.studio_sms_recurring_authorizations drop constraint studio_sms_recurring_authorizations_kind_check;
alter table public.studio_sms_recurring_authorizations add constraint studio_sms_recurring_authorizations_kind_check check (kind in ('number', 'monthly', 'monthly_low_volume'));
alter table public.studio_sms_recurring_charges drop constraint studio_sms_recurring_charges_kind_check;
alter table public.studio_sms_recurring_charges add constraint studio_sms_recurring_charges_kind_check check (kind in ('number', 'monthly', 'monthly_low_volume'));

-- The registration path a location's fees must follow: 'standard' (no active onboarding, no tier chosen, or Standard chosen), 'low_volume_standard'
-- (chosen AND verified: the latest decision for the onboarding is Low-Volume Standard with the complete checklist, and the location's legal business has
-- the EIN of the submitted setup), or 'low_volume_unverified'. It takes NO lock: every fee write that reads it already holds its legal business's row lock
-- (authorize: FOR UPDATE; recurring authorize: FOR SHARE; recurring charge: FOR NO KEY UPDATE; reserve: the runner lease, which a tier decision refuses),
-- and a tier decision takes the onboarding lock and THEN that business's row FOR UPDATE, so the two serialize in the runner's lock order
-- (onboarding -> legal business -> credit account) and cannot deadlock (review P2-1).
create or replace function public._tw4fi_location_path_nolock(p_studio_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  d public.studio_sms_tier_decisions;
begin
  if p_studio_id is null then
    return 'standard';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled';
  if o.id is null or o.tier is null or o.tier = 'standard' then
    return 'standard';
  end if;
  if o.tier <> 'low_volume_standard' then
    return 'low_volume_unverified';   -- unknown value: never priced as either path
  end if;
  select * into d from public.studio_sms_tier_decisions x where x.onboarding_id = o.id order by x.decided_at desc, x.id desc limit 1;
  if d.id is null or d.tier <> 'low_volume_standard' or not public._tw4p_lvs_checklist_complete(d.eligibility) or o.ein_last4 is null
     or not exists (select 1 from public.studio_sms_entity_studios es join public.studio_sms_legal_entities e on e.id = es.legal_entity_id
                     where es.studio_id = p_studio_id and e.ein_last4 = o.ein_last4) then
    return 'low_volume_unverified';
  end if;
  return 'low_volume_standard';
end $$;

-- refuses a fee kind that does not belong to the location's registration path (kinds outside the brand / campaign-monthly families are path-neutral)
create or replace function public._tw4fi_require_path_kind(p_studio_id uuid, p_kind text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_path text;
begin
  if p_kind in ('brand_low_volume', 'monthly_low_volume') then
    if p_studio_id is null then
      raise exception 'a Low-Volume Standard fee is approved for one location' using errcode = 'TW020';
    end if;
    v_path := public._tw4fi_location_path_nolock(p_studio_id);
    if v_path <> 'low_volume_standard' then
      raise exception 'this location is not on a verified Low-Volume Standard registration path' using errcode = 'TW020';
    end if;
  elsif p_kind in ('brand', 'monthly') and p_studio_id is not null then
    v_path := public._tw4fi_location_path_nolock(p_studio_id);
    if v_path <> 'standard' then
      raise exception 'this location is on the Low-Volume Standard path: a Standard-price fee would be wrong' using errcode = 'TW020';
    end if;
  end if;
end $$;

-- every credit reservation (setup fee, recurring first-month set-aside, any future path) follows its location's registration path. A monthly charge of
-- a recurring authorization ('rec:<authorization>:<period>', tw4_recurring_charge) follows the path that was checked when the owner authorized it: the
-- authorization's kind and price are fixed, the campaign registered at Twilio does not change with a later onboarding, and re-checking would turn every
-- later month into a scheduler error instead of a charge (review P2-4). The authorization must exist, be active, and match kind, location and business.
create or replace function public._tw4fi_reservation_path_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.reservation_key ~ '^rec:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
     and exists (select 1 from public.studio_sms_recurring_authorizations ra
                  where ra.id = split_part(new.reservation_key, ':', 2)::uuid and ra.status = 'active' and ra.kind = new.kind
                    and ra.studio_id = new.studio_id and ra.legal_entity_id = new.legal_entity_id) then
    return new;
  end if;
  perform public._tw4fi_require_path_kind(new.studio_id, new.kind);
  return new;
end $$;
create trigger studio_sms_credit_reservations_30_path before insert on public.studio_sms_credit_reservations for each row execute function public._tw4fi_reservation_path_trigger();

-- ... and so does every fee authorization that names a location (a credit-funded approval for the whole business is checked when it is reserved)
create or replace function public._tw4fi_spend_path_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4fi_require_path_kind(new.studio_id, new.kind);
  return new;
end $$;
create trigger studio_sms_spend_events_20_path before insert on public.studio_sms_spend_events for each row execute function public._tw4fi_spend_path_trigger();
alter table public.studio_sms_credit_reservations enable always trigger studio_sms_credit_reservations_30_path;
alter table public.studio_sms_spend_events enable always trigger studio_sms_spend_events_20_path;

-- open approvals (unused, or reserved and still held) and active recurring authorizations of a path pin the location to it (a captured or released one is
-- spent: a captured brand also freezes the tier through its B1 step)
create or replace function public._tw4fi_open_path_commitments(p_studio_id uuid, p_kinds text[])
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (select 1 from public.studio_sms_spend_events se join public.studio_sms_entity_studios es on es.legal_entity_id = se.legal_entity_id and es.studio_id = p_studio_id
                  where se.kind = any (p_kinds) and (se.studio_id = p_studio_id or se.studio_id is null)
                    and (se.status = 'authorized' or (se.status = 'reserved' and exists (select 1 from public.studio_sms_credit_reservations cr where cr.id = se.credit_reservation_id and cr.status = 'reserved'))))
      or exists (select 1 from public.studio_sms_recurring_authorizations ra where ra.studio_id = p_studio_id and ra.kind = any (p_kinds) and ra.status = 'active' and ra.expires_at > now());
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- replaced functions
-- ---------------------------------------------------------------------------------------------------------------
-- 20261122090000 definition + approval-reference replay/refusal and the path check (by trigger). Same signature and grants.
create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid, p_funding text default 'credit', p_studio_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  p public.studio_sms_price_list;
  r public.studio_sms_approval_refs;
  s public.studio_sms_spend_events;
  v_id uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_kind is null or p_amount_cents is null or p_amount_cents <= 0 or p_funding is null or p_funding not in ('credit', 'pilot') then
    raise exception 'invalid authorization' using errcode = '22023';
  end if;
  -- a pilot-funded operation is approved for ONE location, with a written approval reference (10+ characters), and only while the exception exists
  if p_funding = 'pilot' then
    if p_studio_id is null or p_approval_ref is null or char_length(btrim(p_approval_ref)) < 10
       or not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = e.id) then
      raise exception 'a pilot-funded authorization needs the pilot exception, a location and a written approval reference' using errcode = '22023';
    end if;
  end if;
  -- the reference is permanent: an identical retry of a still-unused authorization returns it; anything else that reuses it is refused
  perform pg_advisory_xact_lock(hashtextextended('tw4fi_ref:' || public._tw4fi_ref_norm(p_approval_ref), 0));
  select * into r from public.studio_sms_approval_refs x where x.ref_norm = public._tw4fi_ref_norm(p_approval_ref);
  if r.ref_norm is not null then
    select * into s from public.studio_sms_spend_events x where x.id = r.spend_event_id;
    if r.source = 'spend_authorization' and s.id is not null and s.status = 'authorized' and s.legal_entity_id = e.id and s.kind = p_kind
       and s.amount_cents = p_amount_cents and s.funding = p_funding and s.studio_id is not distinct from p_studio_id and s.authorized_by = p_actor then
      return jsonb_build_object('spend_event_id', s.id, 'replayed', true);
    end if;
    raise exception 'this approval reference was already used: one written approval authorizes one operation, once' using errcode = 'TW019';
  end if;
  -- the authorized amount IS the published customer price: no price, no authorization; no other amount
  select * into p from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if p.id is null then
    raise exception 'no published price for %', p_kind using errcode = 'TW008';
  end if;
  if p.customer_price_cents <> p_amount_cents then
    raise exception 'the amount must equal the published price' using errcode = 'TW008';
  end if;
  if public._tw4f3a_committed(e.id) + p_amount_cents > e.spend_cap_cents then
    raise exception 'this authorization would exceed the spend cap' using errcode = 'TW004';
  end if;
  insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by, funding, studio_id)
  values (e.id, p_kind, p_amount_cents, btrim(p_approval_ref), p_actor, p_funding, p_studio_id) returning id into v_id;
  perform public._tw4f3a_audit(public._tw4c_any_location(e.id), p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents || ';funding=' || p_funding);
  return jsonb_build_object('spend_event_id', v_id, 'replayed', false);
end $$;

-- 20261122090000 definition; only the accepted kinds change (the path is enforced by the reservation trigger)
create or replace function public.tw4_spend_reserve(p_onboarding_id uuid, p_lease_owner text, p_kind text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  e public.studio_sms_legal_entities;
  s public.studio_sms_spend_events;
  a public.studio_sms_credit_accounts;
  v_entity uuid;
  v_base text;
  v_key text;
  v_n int;
  v_res uuid;
  v_funding text;
  v_pilot_used bigint;
  pe public.studio_sms_pilot_exceptions;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_kind is null or p_kind not in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = v_entity for no key update;
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  -- the newest authorization already bound to this operation: reserved = idempotent replay; void (released) = needs a fresh authorization
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is not null and s.status = 'reserved' then
    return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', s.credit_reservation_id, 'replayed', true);
  end if;
  v_n := (select count(*) from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%') + 1;
  v_key := v_base || ':' || v_n;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' and (x.studio_id is null or x.studio_id = o.studio_id) order by (x.studio_id is null), x.authorized_at limit 1 for update;
  if s.id is null then
    raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
  end if;
  a := public._tw4c_lock(v_entity);
  v_funding := s.funding;
  if v_funding = 'credit' then
    perform public._tw4c_require_funds(a, s.amount_cents);
  else
    select * into pe from public.studio_sms_pilot_exceptions y where y.legal_entity_id = v_entity;
    if pe.legal_entity_id is null or a.hold or a.balance_cents < 0 then
      raise exception 'the pilot exception cannot fund this operation' using errcode = 'TW007';
    end if;
    select coalesce(sum(r.amount_cents), 0) into v_pilot_used from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured');
    if v_pilot_used + s.amount_cents > pe.ceiling_cents then
      raise exception 'the pilot ceiling would be exceeded' using errcode = 'TW007';
    end if;
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key) values (v_entity, o.studio_id, p_kind, s.amount_cents, v_funding, v_key) returning id into v_res;
  if v_funding = 'credit' then
    perform public._tw4c_post(v_entity, o.studio_id, 'reserve', 0, s.amount_cents, 'reserve:' || v_key, v_res, 'spend_event=' || s.id, null, null);
  end if;
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now(), credit_reservation_id = v_res where id = s.id;
  perform public._tw4f3a_audit(o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents || ';funding=' || v_funding);
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', v_res, 'funding', v_funding, 'replayed', false);
end $$;

-- 20261122090000 definition; only the accepted kinds change
create or replace function public.tw4_spend_settle(p_onboarding_id uuid, p_lease_owner text, p_kind text, p_outcome text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  s public.studio_sms_spend_events;
  r public.studio_sms_credit_reservations;
  v_entity uuid;
  v_base text;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_outcome not in ('captured', 'released') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('brand', 'brand_low_volume', 'campaign_vetting', 'number', 'monthly', 'monthly_low_volume', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is null or s.credit_reservation_id is null then
    raise exception 'no reservation for this operation' using errcode = 'TW004';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id;
  perform public._tw4c_lock(r.legal_entity_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id for update;
  if r.status = 'captured' and p_outcome = 'captured' then
    return jsonb_build_object('status', 'captured', 'replayed', true);
  end if;
  if r.status = 'released' and p_outcome = 'released' then
    return jsonb_build_object('status', 'released', 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_captured', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  else
    if r.funding = 'credit' then
      perform public._tw4c_post(r.legal_entity_id, r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, p_ref, null, null);
    end if;
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    perform set_config('tw4.credit_settle', 'on', true);
    update public.studio_sms_spend_events set status = 'void' where id = s.id;
    perform set_config('tw4.credit_settle', 'off', true);
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_released', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  end if;
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- 20261130090000 definition + the reverse rule (no switch while the other path has open commitments) for BOTH directions
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
  -- then the location's legal business (the runner's lock order): every fee write for it holds this row, so a decision and a fee write serialize (P2-1)
  perform 1 from public.studio_sms_legal_entities e join public.studio_sms_entity_studios es on es.legal_entity_id = e.id where es.studio_id = p_studio_id for update of e;
  if p_tier = 'low_volume_standard' then
    if not public._tw4p_lvs_checklist_complete(p_eligibility) then
      raise exception 'Low-Volume Standard needs every eligibility check confirmed' using errcode = '22023';
    end if;
    select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
    if v_entity is null or o.ein_last4 is null
       or not exists (select 1 from public.studio_sms_legal_entities e where e.id = v_entity and e.ein_last4 = o.ein_last4) then
      raise exception 'Low-Volume Standard needs the location''s legal business on file, with an EIN matching the studio''s submitted setup' using errcode = '22023';
    end if;
  end if;
  -- an open approval (or active recurring authorization) priced for the OTHER path would be left standing at the wrong price
  if o.tier is distinct from p_tier
     and public._tw4fi_open_path_commitments(p_studio_id, case when p_tier = 'low_volume_standard' then array['brand', 'monthly'] else array['brand_low_volume', 'monthly_low_volume'] end) then
    raise exception 'an open brand fee approval or recurring authorization priced for the other registration path exists: withdraw or revoke it first' using errcode = '55000';
  end if;
  if o.lease_owner is not null and o.lease_expires_at > now() then
    raise exception 'a runner holds this onboarding' using errcode = '55P03';
  end if;
  -- re-verification: a Low-Volume Standard onboarding whose path is not verified (chosen through the old set_tier without a checklist, or a newer
  -- decision contradicts it) records the complete checklist as a NEW decision for the same tier. The tier itself does not change, so the B1 freeze
  -- does not apply (P2-4). The checklist and EIN checks above have passed.
  if o.tier = 'low_volume_standard' and p_tier = 'low_volume_standard' and public._tw4fi_location_path_nolock(p_studio_id) = 'low_volume_unverified' then
    insert into public.studio_sms_tier_decisions (onboarding_id, studio_id, tier, previous_tier, reason, decided_by, eligibility)
    values (o.id, o.studio_id, p_tier, o.tier, btrim(p_reason), p_actor, p_eligibility);
    return jsonb_build_object('tier', p_tier, 'changed', false, 'reverified', true);
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

-- 20261130090000 definition (Standard only) + the same commitment rule
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
  -- then the location's legal business (the runner's lock order): every fee write for it holds this row, so a decision and a fee write serialize (P2-1)
  perform 1 from public.studio_sms_legal_entities e join public.studio_sms_entity_studios es on es.legal_entity_id = e.id where es.studio_id = p_studio_id for update of e;
  if o.tier is distinct from p_tier and public._tw4fi_open_path_commitments(p_studio_id, array['brand_low_volume', 'monthly_low_volume']) then
    raise exception 'an open brand fee approval or recurring authorization priced for the other registration path exists: withdraw or revoke it first' using errcode = '55000';
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

-- 20261128090000 definition; accepts monthly_low_volume (same owner-visible wording as monthly). The path is enforced by the reservation trigger on the
-- first month's set-aside, inside this same transaction, before the authorization row is written.
create or replace function public.tw4_recurring_authorize(p_studio_id uuid, p_user_id uuid, p_kind text, p_acknowledged_price_cents int, p_term_months int, p_total_limit_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  v_price public.studio_sms_price_list;
  v_limit int;
  v_id uuid := gen_random_uuid();
  v_statement text;
  v_cur text;
  v_res uuid;
  v_obligations bigint;
  acct public.studio_sms_credit_accounts;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role = 'studio_owner') then
    raise exception 'only the studio owner can authorize recurring charges' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  if p_kind is null or p_kind not in ('number', 'monthly', 'monthly_low_volume') or p_term_months is null or p_term_months not between 1 and 12 then
    raise exception 'invalid recurring authorization' using errcode = '22023';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  acct := public._tw4c_lock(v_entity);
  perform public._tw4ml_ensure_tz(v_entity);
  if exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then
    raise exception 'pilot business: each recurring operation needs its own approval' using errcode = 'TW011';
  end if;
  -- the campaign fee follows the location's registration path (checked before the price so a wrong-path request never looks merely unpriced)
  perform public._tw4fi_require_path_kind(p_studio_id, p_kind);
  select * into v_price from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  if v_price.id is null then
    raise exception 'no published price for %', p_kind using errcode = 'TW008';
  end if;
  if p_acknowledged_price_cents is distinct from v_price.customer_price_cents then
    raise exception 'the price changed: review and authorize again' using errcode = 'TW008';
  end if;
  v_limit := v_price.customer_price_cents * p_term_months;
  if p_total_limit_cents is not null and p_total_limit_cents <> v_limit then
    raise exception 'the total limit must be the price times the term' using errcode = '22023';
  end if;
  -- (an ended campaign fee of EITHER path is closed here: it must not block the renewal under the other campaign kind)
  perform public._tw4rc_release_commitment(x.id) from public.studio_sms_recurring_authorizations x
   where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.status = 'active' and x.expires_at <= now()
     and (x.kind = p_kind or (p_kind in ('monthly', 'monthly_low_volume') and x.kind in ('monthly', 'monthly_low_volume')));
  with closed as (
    update public.studio_sms_recurring_authorizations x set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_user_id
     where x.legal_entity_id = v_entity and x.studio_id = p_studio_id and x.status = 'active' and x.expires_at <= now()
       and (x.kind = p_kind or (p_kind in ('monthly', 'monthly_low_volume') and x.kind in ('monthly', 'monthly_low_volume')))
    returning x.id, x.studio_id, x.kind)
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  select c.studio_id, null, 'system', p_user_id, 'recurring_revoked', left('authorization=' || c.id || ';kind=' || c.kind || ';term ended', 300) from closed c;
  -- one campaign fee per location, whichever path it was authorized on
  if exists (select 1 from public.studio_sms_recurring_authorizations a where a.legal_entity_id = v_entity and a.studio_id = p_studio_id and a.status = 'active'
              and (a.kind = p_kind or (p_kind in ('monthly', 'monthly_low_volume') and a.kind in ('monthly', 'monthly_low_volume')))) then
    raise exception 'this charge is already authorized for this location' using errcode = '23505';
  end if;
  v_cur := public._tw4ml_month_key(v_entity, now());
  select coalesce(sum(a.price_cents), 0) into v_obligations from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now();
  if v_obligations + v_price.customer_price_cents > public._tw4ml_effective_limit(v_entity, v_cur) then
    raise exception 'set a monthly spending limit that covers your recurring charges first' using errcode = 'TW012';
  end if;
  perform public._tw4ml_require_room(v_entity, v_price.customer_price_cents);
  select * into acct from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  if acct.hold or acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < v_price.customer_price_cents then
    raise exception 'not enough settled credit to set aside the first month' using errcode = 'TW007';
  end if;
  insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
  values (v_entity, p_studio_id, p_kind, v_price.customer_price_cents, 'credit', 'commit:' || v_id) returning id into v_res;
  perform public._tw4c_post(v_entity, p_studio_id, 'reserve', 0, v_price.customer_price_cents, 'reserve:commit:' || v_id, v_res, 'commitment=' || v_id, null, null);
  v_statement := 'I authorize DanceFlow to deduct ' || public._tw4rc_usd(v_price.customer_price_cents) || ' per month for '
    || case p_kind when 'number' then 'texting phone number rent' else 'monthly texting service' end
    || ' from my legal business''s prepaid texting credit, for up to ' || p_term_months || ' month' || case when p_term_months = 1 then '' else 's' end
    || ' and no more than ' || public._tw4rc_usd(v_limit) || ' in total, whichever comes first. '
    || 'The first month''s charge is set aside from my prepaid credit now. '
    || 'The charge is taken only if enough settled credit is available and it fits within my business''s monthly spending limit. No card is charged, no credit is added automatically, and I can revoke this at any time. '
    || 'Final prices and terms are pending approval.';
  insert into public.studio_sms_recurring_authorizations (id, legal_entity_id, studio_id, kind, price_cents, term_months, total_limit_cents, expires_at, authorized_by, statement, commitment_reservation_id)
  values (v_id, v_entity, p_studio_id, p_kind, v_price.customer_price_cents, p_term_months, v_limit,
          public._tw4ml_month_start(v_entity, public._tw4ml_key_add(v_cur, p_term_months)), p_user_id, v_statement, v_res);
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'system', p_user_id, 'recurring_authorized', left('authorization=' || v_id || ';kind=' || p_kind || ';cents=' || v_price.customer_price_cents || ';months=' || p_term_months || ';limit=' || v_limit, 300));
  return jsonb_build_object('authorization_id', v_id, 'price_cents', v_price.customer_price_cents, 'total_limit_cents', v_limit);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reads
-- ---------------------------------------------------------------------------------------------------------------
-- which fee kinds a location's registration path uses (the runner and the panel ask; the database still enforces it on every write)
create or replace function public.tw4_location_fee_kinds(p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_path text := public._tw4fi_location_path_nolock(p_studio_id);   -- a read never blocks on (or blocks) a tier decision
begin
  return jsonb_build_object('path', v_path,
    'brand_kind', case v_path when 'standard' then 'brand' when 'low_volume_standard' then 'brand_low_volume' end,
    'campaign_monthly_kind', case v_path when 'standard' then 'monthly' when 'low_volume_standard' then 'monthly_low_volume' end,
    'brand_price_cents', (select p.customer_price_cents from public.studio_sms_price_list p where p.active and p.kind = case v_path when 'standard' then 'brand' when 'low_volume_standard' then 'brand_low_volume' end),
    'campaign_monthly_price_cents', (select p.customer_price_cents from public.studio_sms_price_list p where p.active and p.kind = case v_path when 'standard' then 'monthly' when 'low_volume_standard' then 'monthly_low_volume' end));
end $$;

-- the same, under the runner lease (the runner asks before any Twilio write whether a paid brand of this path can be reserved at a published price)
create or replace function public.tw4_runner_fee_kinds(p_onboarding_id uuid, p_lease_owner text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare o public.studio_sms_onboarding;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  return public.tw4_location_fee_kinds(o.studio_id);
end $$;

-- the owner's settings page: which campaign monthly kind this location's recurring authorization uses (owner or administrator of the location)
create or replace function public.sms_location_fee_kinds(p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v jsonb;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v := public.tw4_location_fee_kinds(p_studio_id);
  return jsonb_build_object('path', v -> 'path', 'campaign_monthly_kind', v -> 'campaign_monthly_kind');
end $$;

-- the full linkage of one written approval reference (platform admin): reference -> authorization -> reservation -> operation -> ledger
create or replace function public.tw4_approval_ref_trace(p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_approval_refs;
  s public.studio_sms_spend_events;
  c public.studio_sms_credit_reservations;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into r from public.studio_sms_approval_refs x where x.ref_norm = public._tw4fi_ref_norm(p_approval_ref);
  if r.ref_norm is null then
    return jsonb_build_object('found', false);
  end if;
  select * into s from public.studio_sms_spend_events x where x.id = r.spend_event_id;
  select * into c from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id;
  return jsonb_build_object('found', true, 'approval_ref', r.approval_ref, 'source', r.source, 'legal_entity_id', r.legal_entity_id,
    'approved_location_id', r.studio_id, 'approved_by', r.approved_by, 'recorded_at', r.created_at,
    'spend_event', case when s.id is null then null else jsonb_build_object('id', s.id, 'kind', s.kind, 'amount_cents', s.amount_cents, 'funding', s.funding,
      'status', s.status, 'authorized_at', s.authorized_at, 'reserved_at', s.reserved_at, 'operation_key', s.reservation_key,
      'onboarding_id', case when s.reservation_key ~ '^[0-9a-f-]{36}:' then split_part(s.reservation_key, ':', 1) end) end,
    'reservation', case when c.id is null then null else jsonb_build_object('id', c.id, 'location_id', c.studio_id, 'kind', c.kind, 'amount_cents', c.amount_cents,
      'funding', c.funding, 'status', c.status, 'closed_at', c.closed_at) end,
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('seq', l.seq, 'kind', l.kind, 'balance_delta_cents', l.balance_delta_cents, 'reserved_delta_cents', l.reserved_delta_cents,
      'location_id', l.studio_id, 'ref', l.ref, 'at', l.created_at) order by l.seq) from public.studio_sms_credit_ledger l where c.id is not null and l.reservation_id = c.id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- precondition on existing evidence (review P2-5): a Low-Volume Standard location must not already carry an OPEN Standard-priced commitment (allowed
-- before this migration for recurring fees and monthly approvals). After this migration such a commitment could never be reserved or charged: refuse to
-- apply until it is withdrawn or revoked, so nothing is silently stranded.
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.studio_sms_onboarding o where o.state <> 'cancelled' and o.tier = 'low_volume_standard'
               and public._tw4fi_open_path_commitments(o.studio_id, array['brand', 'monthly'])) then
    raise exception 'TW-4F financial integrity: a Low-Volume Standard location has an open Standard-priced approval or recurring authorization; withdraw or revoke it before applying';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- grants (replaced functions keep theirs)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4fi_ref_norm(text), public._tw4fi_append_only(), public._tw4fi_register(text, text, uuid, uuid, uuid, text, int, text, uuid),
  public._tw4fi_spend_ref_trigger(), public._tw4fi_pilot_ref_trigger(), public._tw4fi_ceiling_ref_trigger(),
  public._tw4fi_location_path_nolock(uuid), public._tw4fi_require_path_kind(uuid, text), public._tw4fi_reservation_path_trigger(), public._tw4fi_spend_path_trigger(),
  public._tw4fi_open_path_commitments(uuid, text[]), public.tw4_location_fee_kinds(uuid), public.tw4_runner_fee_kinds(uuid, text),
  public.sms_location_fee_kinds(uuid), public.tw4_approval_ref_trace(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.tw4_runner_fee_kinds(uuid, text), public.tw4_location_fee_kinds(uuid), public.tw4_approval_ref_trace(text, uuid) to service_role;
grant execute on function public.sms_location_fee_kinds(uuid) to authenticated;

commit;
