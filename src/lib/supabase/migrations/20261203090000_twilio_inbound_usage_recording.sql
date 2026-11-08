-- 20261203090000_twilio_inbound_usage_recording.sql
-- Inbound SMS usage RECORDING (owner decisions D1-D4 of 2026-10-20; docs/twilio/TW-4F_Inbound_Pricing_Assessment.md). No price is published by this file.
--   * Every verified inbound text received by a studio of a verified legal business is recorded once, keyed by its Twilio message SID, for that legal business
--     only (the signer must be the business's own active subaccount).
--   * D1: an ORDINARY inbound text is charged after the fact at the published inbound per-segment price ('sms_inbound', none published yet), but only within a
--     configurable negative-balance ceiling per legal business ($10 to start). Beyond it the remainder is recorded as uncollected (DanceFlow-absorbed); a
--     received text is never refused. Outgoing chargeable texts keep failing closed on a negative balance, a hold or a suspension (unchanged).
--     Final owner decisions (PR 248): the pilot business carries no inbound debt; inbound never uses funds reserved for recurring fees, and one month of
--     every recurring fee that can still be charged stays available (no inbound debt while such a fee or a set-aside exists); an authorized recurring
--     fee's monthly-limit check leaves inbound out (tw4_recurring_charge, otherwise unchanged from 20261128).
--   * D2: STOP / START / HELP (and their confirmations) are classified 'compliance': never charged, never counted toward the monthly limit, always processed.
--   * D3: error replies are counted per sender per day (the route sends at most one); provider costs are estimated and tracked as DanceFlow's.
--   * D4: charged ordinary inbound counts toward the month's spending (attributed by the message's own time in the business's timezone); it may overrun
--     the limit, which then blocks new outgoing chargeable texts.
--   * Lost-webhook recovery is NOT here: the reconciler slice will call tw4_inbound_record with the provider's own evidence (source 'reconciler').
-- Requires 20261201090000 (usage). Ordered after 20261202090000 (financial integrity), whose price-kind list it EXTENDS rather than replaces.
-- Rollback: rollback/20261203090000_twilio_inbound_usage_recording_rollback.sql (refuses once any inbound record, ceiling or published inbound price exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_usage_attempts') is null or to_regprocedure('public._tw4us_segments(text)') is null then
    raise exception 'inbound-recording precondition failed: usage financials (20261201090000) is not applied';
  end if;
  -- 20261202 rewrites the price-kind list with a fixed list: it must come first, or it would silently drop 'sms_inbound' (order enforced, not just documented)
  if to_regclass('public.studio_sms_approval_refs') is null then
    raise exception 'inbound-recording precondition failed: financial integrity (20261202090000) is not applied';
  end if;
  if to_regclass('public.studio_sms_inbound_usage') is not null then
    raise exception 'inbound-recording precondition failed: already applied';
  end if;
  if exists (select 1 from public.studio_sms_credit_ledger l where l.idempotency_key like 'usage:in:%') then
    raise exception 'inbound-recording precondition failed: ledger entries already use the inbound key namespace (reconcile them first)';
  end if;
end $$;

-- the inbound price kind, added to WHATEVER kinds the live constraint allows (other migrations own the rest of that list)
do $$
declare
  v_def text;
  v_kinds text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_price_list'::regclass and c.conname = 'studio_sms_price_list_kind_check';
  if v_def is null then
    raise exception 'inbound-recording precondition failed: studio_sms_price_list_kind_check not found';
  end if;
  -- the identifiers inside ANY (...), whichever form Postgres prints (ARRAY['a'::text, ...] or '{a,b}'::text[]), minus the type name
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m where m[1] <> 'text';
  if v_kinds is null or cardinality(v_kinds) < 2 then
    raise exception 'could not read the price kinds from %', v_def;
  end if;
  if not ('sms_inbound' = any (v_kinds)) then
    v_kinds := v_kinds || 'sms_inbound'::text;
  end if;
  alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
  execute format('alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check check (kind = any (%L::text[]))', v_kinds);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables (no API-role privileges)
-- ---------------------------------------------------------------------------------------------------------------
-- D1: the negative-balance exposure allowed for ordinary inbound charges. Append-only; per business overrides the platform value; none = $10.00.
create table public.studio_sms_inbound_exposure_ceilings (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('platform', 'entity')),
  legal_entity_id uuid null references public.studio_sms_legal_entities(id),
  ceiling_cents int not null check (ceiling_cents between 0 and 10000),
  set_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  created_at timestamptz not null default now(),
  constraint studio_sms_inbound_exposure_ceilings_scope check ((scope = 'platform') = (legal_entity_id is null))
);
create index studio_sms_inbound_exposure_ceilings_lookup on public.studio_sms_inbound_exposure_ceilings (scope, legal_entity_id, created_at desc);

-- one row per inbound text, final when written
create table public.studio_sms_inbound_usage (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id),
  studio_id uuid not null,
  provider_sid text not null unique check (provider_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  source text not null check (source in ('webhook', 'reconciler')),
  classification text not null check (classification in ('ordinary', 'compliance')),
  segments int not null check (segments between 1 and 20),
  media int not null default 0 check (media between 0 and 10),
  price_list_id uuid null references public.studio_sms_price_list(id),
  unit_price_cents int null check (unit_price_cents is null or unit_price_cents > 0),
  billable_cents int not null check (billable_cents >= 0),
  charged_cents int not null check (charged_cents >= 0),
  uncollected_cents int not null check (uncollected_cents >= 0),
  ceiling_cents int not null check (ceiling_cents >= 0),
  est_provider_cost_cents int null check (est_provider_cost_cents is null or est_provider_cost_cents >= 0),
  reply_segments int null check (reply_segments is null or reply_segments between 0 and 20),
  est_reply_cost_cents int null check (est_reply_cost_cents is null or est_reply_cost_cents >= 0),
  received_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint studio_sms_inbound_usage_split check (charged_cents + uncollected_cents = billable_cents),
  constraint studio_sms_inbound_usage_compliance_free check (classification = 'ordinary' or billable_cents = 0),
  constraint studio_sms_inbound_usage_location foreign key (studio_id, legal_entity_id) references public.studio_sms_entity_studios (studio_id, legal_entity_id)
);
create index studio_sms_inbound_usage_entity_time on public.studio_sms_inbound_usage (legal_entity_id, received_at);

-- D3 / D2: replies counted per sender per UTC day (rate limits); the sender is stored only as a hash
create table public.sms_inbound_reply_counters (
  account_key text not null check (account_key = 'parent' or account_key ~ '^AC[0-9a-fA-F]{32}$'),
  sender_hash text not null check (sender_hash ~ '^[0-9a-f]{64}$'),
  -- one bucket per sender for ALL error replies (D3: at most one a day), one for compliance confirmations (D2)
  kind text not null check (kind in ('error', 'confirm')),
  day date not null,
  sent int not null check (sent >= 0),
  primary key (account_key, sender_hash, kind, day)
);

revoke all on public.studio_sms_inbound_exposure_ceilings, public.studio_sms_inbound_usage, public.sms_inbound_reply_counters from public, anon, authenticated, service_role;
alter table public.studio_sms_inbound_exposure_ceilings enable row level security;
alter table public.studio_sms_inbound_usage enable row level security;
alter table public.sms_inbound_reply_counters enable row level security;

create trigger studio_sms_inbound_exposure_ceilings_guard before update or delete on public.studio_sms_inbound_exposure_ceilings for each row execute function public._tw4us_append_only();
create trigger studio_sms_inbound_usage_guard before update or delete on public.studio_sms_inbound_usage for each row execute function public._tw4us_append_only();
create trigger studio_sms_inbound_exposure_ceilings_truncate before truncate on public.studio_sms_inbound_exposure_ceilings for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_inbound_usage_truncate before truncate on public.studio_sms_inbound_usage for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4in_ceiling(p_entity uuid)
returns int language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    (select c.ceiling_cents from public.studio_sms_inbound_exposure_ceilings c where c.scope = 'entity' and c.legal_entity_id = p_entity order by c.created_at desc, c.id desc limit 1),
    (select c.ceiling_cents from public.studio_sms_inbound_exposure_ceilings c where c.scope = 'platform' order by c.created_at desc, c.id desc limit 1),
    1000);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- month spending: outbound usage, inbound charges (by the message's own time), recurring fees, open reservations; uncollected and absorbed shown apart
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4ml_month_parts(p_entity uuid, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s timestamptz := public._tw4ml_month_start(p_entity, p_key);
  e timestamptz := public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1));
  v_usage bigint;
  v_inbound bigint;
  v_uncollected bigint;
  v_absorbed bigint;
  v_recurring bigint;
  v_reserved bigint;
begin
  -- outbound usage (and direct debits); inbound charges are counted from their own records below, never twice
  select coalesce(sum(-l.balance_delta_cents), 0) into v_usage from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind in ('usage_charge', 'usage_refund') and l.idempotency_key not like 'usage:in:%'
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(u.charged_cents), 0), coalesce(sum(u.uncollected_cents), 0),
         coalesce(sum(case when u.classification = 'compliance' then coalesce(u.est_provider_cost_cents, 0) else 0 end + coalesce(u.est_reply_cost_cents, 0)), 0)
    into v_inbound, v_uncollected, v_absorbed
    from public.studio_sms_inbound_usage u where u.legal_entity_id = p_entity and u.received_at >= s and u.received_at < e;
  -- a captured recurring fee belongs to the month its funds were reserved in (a set-aside captured by a later month's charge is NOT counted a second time there)
  select coalesce(sum(-l.balance_delta_cents), 0) into v_recurring from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(r.amount_cents), 0) into v_reserved from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.status = 'reserved' and (r.reservation_key like 'rec:%' or r.reservation_key like 'commit:%' or r.reservation_key like 'sms:%')
     and r.created_at >= s and r.created_at < e;
  return jsonb_build_object('usage_cents', v_usage, 'inbound_cents', v_inbound, 'recurring_cents', v_recurring, 'reserved_cents', v_reserved,
                            'total_cents', v_usage + v_inbound + v_recurring + v_reserved,
                            'inbound_uncollected_cents', v_uncollected, 'absorbed_cost_cents', v_absorbed,
                            'starts_at', s, 'ends_at', e);
end $$;

-- the direct usage debit (no reservation) can never write into the billed-text or inbound key namespaces
create or replace function public.tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if p_cents is null or p_cents <= 0 or p_studio_id is null then
    raise exception 'invalid usage amount or location' using errcode = '22023';
  end if;
  if p_key is null or p_key like 'sms:%' or p_key like 'in:%' then
    raise exception 'this key namespace belongs to billed texts' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low or the month's limit is used up
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4ml_ensure_tz(p_entity_id);
  perform public._tw4c_require_funds(a, p_cents);
  perform public._tw4ml_require_room(p_entity_id, p_cents);   -- fail closed: funds AND the month's limit
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- recording
-- ---------------------------------------------------------------------------------------------------------------
-- Records one verified inbound text (called after the route's signature, tenant and replay checks, or later by the reconciler with provider evidence).
-- Never refuses a text for money: an ordinary text is charged within the negative-balance ceiling and the remainder is recorded as uncollected.
-- Returns {recorded:false, reason:'legacy'} for a studio that is not billed. Idempotent per message SID (a repeat returns the first record).
create or replace function public.tw4_inbound_record(
  p_studio_id uuid, p_signer_account text, p_provider_sid text, p_segments int, p_media int, p_classification text, p_reply_body text,
  p_received_at timestamptz, p_source text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
-- called on the webhook's response path: under contention it fails fast (the route logs it; the reconciler records the text later), never holding a reply
set lock_timeout = '2s'
set statement_timeout = '5s'
as $$
declare
  u public.studio_sms_inbound_usage;
  acct public.studio_sms_credit_accounts;
  v_entity uuid;
  v_account text;
  v_price public.studio_sms_price_list;
  v_out_price public.studio_sms_price_list;
  v_received timestamptz := coalesce(p_received_at, now());
  v_billable int := 0;
  v_charged int := 0;
  v_ceiling int;
  v_protected bigint;
  v_upcoming bigint;
  v_cur text;
  v_reply int;
begin
  if p_studio_id is null or p_provider_sid is null or p_provider_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$'
     or p_classification not in ('ordinary', 'compliance') or p_source not in ('webhook', 'reconciler')
     or p_segments is null or p_segments not between 1 and 20 or coalesce(p_media, 0) not between 0 and 10
     or v_received > now() + interval '5 minutes' or v_received < now() - interval '400 days'
     or (p_source = 'webhook' and p_received_at is not null) then
    raise exception 'invalid inbound record' using errcode = '22023';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('recorded', false, 'reason', 'legacy');
  end if;
  select t.twilio_account_sid into v_account from public.studio_sms_twilio_accounts t where t.legal_entity_id = v_entity and t.status in ('active', 'suspended');
  if v_account is null or p_signer_account is null or p_signer_account <> v_account then
    raise exception 'the text was not received by this business''s own subaccount' using errcode = '42501';
  end if;
  perform 1 from public.studio_sms_legal_entities le where le.id = v_entity for share;
  acct := public._tw4c_lock(v_entity);
  select * into u from public.studio_sms_inbound_usage x where x.provider_sid = p_provider_sid;
  if u.id is not null then
    if u.legal_entity_id <> v_entity or u.studio_id <> p_studio_id then
      raise exception 'this message was recorded for another studio' using errcode = '42501';
    end if;
    return jsonb_build_object('recorded', true, 'replayed', true, 'classification', u.classification, 'charged_cents', u.charged_cents, 'uncollected_cents', u.uncollected_cents);
  end if;

  select * into v_price from public.studio_sms_price_list p where p.kind = 'sms_inbound' and p.active;
  select * into v_out_price from public.studio_sms_price_list p where p.kind = 'sms_usage' and p.active;
  -- only an ordinary SMS (not multimedia) with a published inbound price is billable
  if p_classification = 'ordinary' and p_provider_sid like 'SM%' and coalesce(p_media, 0) = 0 and v_price.id is not null then
    v_billable := p_segments * v_price.customer_price_cents;
  end if;
  perform public._tw4ml_ensure_tz(v_entity);   -- the month this text counts in must not move later
  -- the pilot business carries NO inbound debt: its pilot-funded setup operations require a non-negative balance (and the pilot ceiling never funds texting)
  v_ceiling := case when exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = v_entity) then 0 else public._tw4in_ceiling(v_entity) end;
  -- D1: charge only down to the negative-balance ceiling, measured on AVAILABLE funds (reserved funds are already promised to an outgoing text or a set-aside
  -- month and will be spent); the rest is uncollected (absorbed); the text is never refused.
  -- Owner decision (PR 248): inbound never consumes funds reserved for authorized recurring fees (the first month set aside, a recurring charge in flight):
  -- the balance after the charge must still cover them. The pilot business additionally never goes below zero (its ceiling is 0).
  select coalesce(sum(r.amount_cents), 0) into v_protected from public.studio_sms_credit_reservations r
   where r.legal_entity_id = v_entity and r.status = 'reserved' and r.funding = 'credit' and (r.reservation_key like 'commit:%' or r.reservation_key like 'rec:%');
  -- Owner decision (PR 248, option B): one month of every ACTIVE recurring fee (not revoked, not expired) stays available, at its authorized price. A fee whose
  -- first month is still set aside is already covered by that reservation (counted in reserved_cents), so it is not counted twice. Nothing is reserved or
  -- charged by this: it only limits what an inbound text may charge.
  -- Only a fee that can still be charged is protected (the same refusals tw4_recurring_charge applies): within its total limit, at its published price, not a
  -- pilot business, and with a chargeable month left (this month not yet charged or refused, or a next month inside the term).
  v_cur := public._tw4ml_month_key(v_entity, now());
  select coalesce(sum(a.price_cents), 0) into v_upcoming from public.studio_sms_recurring_authorizations a
   where a.legal_entity_id = v_entity and a.status = 'active' and a.expires_at > now()
     and not exists (select 1 from public.studio_sms_credit_reservations r where r.id = a.commitment_reservation_id and r.status = 'reserved')
     and not exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id)
     and exists (select 1 from public.studio_sms_price_list p where p.kind = a.kind and p.active and p.customer_price_cents = a.price_cents)
     and coalesce((select sum(c.amount_cents) from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.status = 'charged'), 0) + a.price_cents <= a.total_limit_cents
     and ((public._tw4ml_month_start(v_entity, v_cur) < a.expires_at
           and not exists (select 1 from public.studio_sms_recurring_charges c where c.authorization_id = a.id and c.period_key = v_cur and c.status in ('charged', 'refused')))
          or public._tw4ml_month_start(v_entity, public._tw4ml_key_add(v_cur, 1)) < a.expires_at);
  v_charged := least(v_billable,
                     greatest(0, acct.balance_cents - acct.reserved_cents + v_ceiling),
                     -- while any recurring fee is active or set aside there is NO inbound debt: only credit free of every reservation AND of one month of
                     -- each active fee may be used (other reservations - an outgoing text, a setup fee - settle without a funds check and would otherwise
                     -- be paid from the protected amount)
                     case when v_protected > 0 or v_upcoming > 0 then greatest(0, acct.balance_cents - acct.reserved_cents - v_upcoming) else v_billable end)::int;
  if v_charged > 0 then
    perform public._tw4c_post(v_entity, p_studio_id, 'usage_charge', -v_charged, 0, 'usage:in:' || p_provider_sid, null, 'inbound', null, null);
  end if;
  v_reply := case when p_reply_body is null or char_length(p_reply_body) = 0 then null else public._tw4us_segments(p_reply_body) end;
  insert into public.studio_sms_inbound_usage (legal_entity_id, studio_id, provider_sid, account_sid, source, classification, segments, media, price_list_id,
                                               unit_price_cents, billable_cents, charged_cents, uncollected_cents, ceiling_cents, est_provider_cost_cents,
                                               reply_segments, est_reply_cost_cents, received_at)
  values (v_entity, p_studio_id, p_provider_sid, v_account, p_source, p_classification, p_segments, coalesce(p_media, 0), v_price.id,
          v_price.customer_price_cents, v_billable, v_charged, v_billable - v_charged, v_ceiling,
          case when v_price.id is null then null else p_segments * v_price.provider_cost_cents end,
          v_reply, case when v_reply is null or v_out_price.id is null then null else v_reply * v_out_price.provider_cost_cents end, v_received)
  returning * into u;
  return jsonb_build_object('recorded', true, 'replayed', false, 'classification', u.classification, 'charged_cents', u.charged_cents, 'uncollected_cents', u.uncollected_cents);
end $$;

-- D3 / D2: may this reply be sent? Counts it (per account, hashed sender, kind, UTC day) and answers whether it is within the limit.
create or replace function public.tw4_inbound_reply_allowed(p_account_sid text, p_sender_hash text, p_kind text, p_limit int)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_sent int;
begin
  if p_sender_hash is null or p_sender_hash !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 20
     or p_kind not in ('error_unavailable', 'error_invalid', 'error_unrecognized', 'error_unrouted', 'help', 'start')
     or (p_account_sid is not null and p_account_sid !~ '^AC[0-9a-fA-F]{32}$') then
    raise exception 'invalid reply check' using errcode = '22023';
  end if;
  insert into public.sms_inbound_reply_counters as c (account_key, sender_hash, kind, day, sent)
  values (coalesce(p_account_sid, 'parent'), p_sender_hash, case when p_kind like 'error_%' then 'error' else 'confirm' end, (now() at time zone 'UTC')::date, 1)
  on conflict (account_key, sender_hash, kind, day) do update set sent = c.sent + 1
  returning c.sent into v_sent;
  return v_sent <= p_limit;
end $$;

-- D1: the negative-balance ceiling, per business (p_entity_id) or platform-wide (null). Platform admin, written reason; the table is the audit trail.
create or replace function public.tw4_inbound_exposure_set(p_entity_id uuid, p_actor uuid, p_cents int, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_cents is null or p_cents not between 0 and 10000 or p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'a ceiling of $0 to $100 and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  if p_entity_id is not null then
    perform 1 from public.studio_sms_legal_entities le where le.id = p_entity_id for share;
    if not found then
      raise exception 'unknown legal entity' using errcode = '22023';
    end if;
    perform public._tw4c_lock(p_entity_id);   -- serialized with charges
  end if;
  insert into public.studio_sms_inbound_exposure_ceilings (scope, legal_entity_id, ceiling_cents, set_by, reason, created_at)
  values (case when p_entity_id is null then 'platform' else 'entity' end, p_entity_id, p_cents, p_actor, btrim(p_reason), clock_timestamp());
  return jsonb_build_object('ceiling_cents', p_cents, 'scope', case when p_entity_id is null then 'platform' else 'entity' end);
end $$;

-- every inbound charge must agree with the ledger: counts the exceptions (0 = reconciled)
create or replace function public._tw4in_reconciliation_gaps()
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    (select count(*) from public.studio_sms_inbound_usage u
      where u.charged_cents > 0 and not exists (
        select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = u.legal_entity_id and l.idempotency_key = 'usage:in:' || u.provider_sid
           and l.kind = 'usage_charge' and l.balance_delta_cents = -u.charged_cents and l.studio_id = u.studio_id))
    + (select count(*) from public.studio_sms_credit_ledger l
        where l.idempotency_key like 'usage:in:%' and not exists (
          select 1 from public.studio_sms_inbound_usage u where 'usage:in:' || u.provider_sid = l.idempotency_key and u.legal_entity_id = l.legal_entity_id and u.charged_cents = -l.balance_delta_cents));
$$;

-- platform view: per business, today's inbound volume and the month's money; flags the alert conditions (D1). Counts and amounts only.
create or replace function public.sms_inbound_admin_overview(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return jsonb_build_object(
    'platform_ceiling_cents', (select coalesce((select c.ceiling_cents from public.studio_sms_inbound_exposure_ceilings c where c.scope = 'platform' order by c.created_at desc, c.id desc limit 1), 1000)),
    'reconciliation_gaps', public._tw4in_reconciliation_gaps(),
    'error_replies_today', (select coalesce(sum(c.sent), 0) from public.sms_inbound_reply_counters c where c.day = (now() at time zone 'UTC')::date and c.kind like 'error_%'),
    'businesses', coalesce((select jsonb_agg(jsonb_build_object(
        'legal_entity_id', b.id, 'legal_name', b.legal_name,
        'segments_today', b.segments_today, 'charged_month_cents', b.charged, 'uncollected_month_cents', b.uncollected,
        'balance_cents', b.balance, 'ceiling_cents', b.ceiling,
        'alert_volume', b.segments_today > 200, 'alert_ceiling', b.balance <= -b.ceiling) order by b.legal_name)
      from (select le.id, le.legal_name,
                   (select coalesce(sum(u.segments), 0) from public.studio_sms_inbound_usage u where u.legal_entity_id = le.id and u.received_at >= now() - interval '1 day') segments_today,
                   (select coalesce(sum(u.charged_cents), 0) from public.studio_sms_inbound_usage u where u.legal_entity_id = le.id and u.received_at >= date_trunc('month', now())) charged,
                   (select coalesce(sum(u.uncollected_cents), 0) from public.studio_sms_inbound_usage u where u.legal_entity_id = le.id and u.received_at >= date_trunc('month', now())) uncollected,
                   coalesce((select a.balance_cents from public.studio_sms_credit_accounts a where a.legal_entity_id = le.id), 0) balance,
                   public._tw4in_ceiling(le.id) ceiling
              from public.studio_sms_legal_entities le
             where exists (select 1 from public.studio_sms_inbound_usage u where u.legal_entity_id = le.id)) b), '[]'::jsonb));
end $$;

-- the month's spending without inbound texts (what an authorized recurring fee is checked against)
create or replace function public._tw4in_spend_without_inbound(p_entity uuid, p_key text)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select ((x->>'total_cents')::bigint - coalesce((x->>'inbound_cents')::bigint, 0)) from (select public._tw4ml_month_parts(p_entity, p_key) x) q;
$$;

-- as of 20261128090000, with ONE change: its monthly-limit check leaves inbound texts out (see the comment at that check)
create or replace function public.tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_recurring_authorizations;
  acct public.studio_sms_credit_accounts;
  p public.studio_sms_price_list;
  c public.studio_sms_recurring_charges;
  cr public.studio_sms_credit_reservations;
  v_cur text;
  v_spent bigint;
  v_status text;
  v_reason text;
  v_res uuid;
  v_key text;
begin
  if p_period_key is null or p_period_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id;
  if a.id is null then
    raise exception 'unknown authorization' using errcode = '22023';
  end if;
  -- entity row first (the order tw4_spend_reserve / tw4_spend_authorize use), then the account row
  perform 1 from public.studio_sms_legal_entities le where le.id = a.legal_entity_id for no key update;
  acct := public._tw4c_lock(a.legal_entity_id);   -- the one lock every credit mutation takes: charges, top-ups, holds, limit changes and revocations are serialized
  -- a scheduler run is fenced by its lease and by the kill switch, checked AFTER the locks
  if p_run_id is not null and not exists (select 1 from public.studio_sms_recurring_runs r where r.id = p_run_id and r.status = 'running' and r.lease_expires_at > clock_timestamp()) then
    raise exception 'the scheduler run is not active' using errcode = '22023';
  end if;
  if p_run_id is not null and not coalesce((select l.enabled from public.studio_sms_recurring_switch_log l order by l.changed_at desc, l.id desc limit 1), false) then
    raise exception 'the scheduler is switched off' using errcode = '22023';
  end if;
  perform public._tw4ml_ensure_tz(a.legal_entity_id);
  v_cur := public._tw4ml_month_key(a.legal_entity_id, now());
  -- only the current or the previous service month (in the business's timezone) can be charged: never the future, never ancient history
  if p_period_key <> v_cur and p_period_key <> public._tw4ml_key_add(v_cur, -1) then
    raise exception 'this period cannot be charged now' using errcode = '22023';
  end if;
  select * into a from public.studio_sms_recurring_authorizations x where x.id = p_authorization_id for update;
  select * into c from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.period_key = p_period_key for update;
  if c.id is not null and c.status = 'charged' then
    return jsonb_build_object('outcome', 'charged', 'replayed', true);
  end if;

  v_status := null;
  select coalesce(sum(x.amount_cents), 0) into v_spent from public.studio_sms_recurring_charges x where x.authorization_id = a.id and x.status = 'charged';
  select * into p from public.studio_sms_price_list x where x.kind = a.kind and x.active;
  -- the first month's set-aside funds, if still held, are what this charge captures (no second reservation); they are already counted in the month they were set aside in, so capturing them needs no new room
  if a.commitment_reservation_id is not null then
    select * into cr from public.studio_sms_credit_reservations x where x.id = a.commitment_reservation_id for update;
    if cr.id is not null and cr.status = 'reserved' then
    else
      cr := null;
    end if;
  end if;
  if a.status <> 'active' then
    v_status := 'refused'; v_reason := 'revoked';
  elsif a.expires_at <= now() or public._tw4ml_month_start(a.legal_entity_id, p_period_key) >= a.expires_at or p_period_key < public._tw4ml_month_key(a.legal_entity_id, a.starts_at) then
    v_status := 'refused'; v_reason := 'outside the authorized term';
  elsif p.id is null or p.customer_price_cents <> a.price_cents then
    v_status := 'refused'; v_reason := 'price changed: the owner must authorize again';
  elsif exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = a.legal_entity_id) then
    v_status := 'refused'; v_reason := 'pilot business: each recurring operation needs its own approval';   -- the pilot ceiling is never consumed by a schedule
  elsif exists (select 1 from public.studio_sms_recurring_charges x where x.legal_entity_id = a.legal_entity_id and x.studio_id = a.studio_id and x.kind = a.kind and x.period_key = p_period_key and x.status = 'charged' and x.authorization_id <> a.id) then
    v_status := 'refused'; v_reason := 'this period was already charged under another authorization';   -- revoke + authorize again never charges one period twice
  elsif v_spent + a.price_cents > a.total_limit_cents then
    v_status := 'refused'; v_reason := 'authorized spending limit reached';
  -- owner decision (PR 248): an authorized recurring fee is checked against the month's spending WITHOUT inbound texts, so inbound volume (which can
  -- never be refused) cannot hold the business's phone number or messaging service; inbound still counts for everything else
  elsif cr.id is null and public._tw4in_spend_without_inbound(a.legal_entity_id, v_cur) + a.price_cents > public._tw4ml_effective_limit(a.legal_entity_id, v_cur) then
    v_status := 'held'; v_reason := 'monthly spending limit reached';   -- retried: next month, or when the owner raises the limit
  elsif acct.hold then
    v_status := 'held'; v_reason := 'the credit account is on hold';
  elsif (cr.id is null and (acct.balance_cents < 0 or (acct.balance_cents - acct.reserved_cents) < a.price_cents))
     or (cr.id is not null and (acct.balance_cents < 0 or acct.balance_cents < cr.amount_cents)) then
    v_status := 'unfunded'; v_reason := 'insufficient settled credit';   -- settled credit only: a refunded or reversed top-up can leave a set-aside with nothing behind it; there is no fallback funding of any kind
  end if;

  if v_status is not null then
    if c.id is null then
      insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reason, run_id)
      values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, v_status, v_reason, p_run_id);
    else
      update public.studio_sms_recurring_charges set status = v_status, reason = v_reason, attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
    end if;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (a.studio_id, null, 'system', null, 'recurring_' || v_status, left('authorization=' || a.id || ';period=' || p_period_key || ';' || v_reason, 300));
    return jsonb_build_object('outcome', v_status, 'reason', v_reason, 'replayed', false);
  end if;

  if cr.id is not null then
    -- capture the funds that were set aside when the owner authorized
    v_res := cr.id;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -cr.amount_cents, -cr.amount_cents, 'capture:' || cr.reservation_key, cr.id, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = cr.id;
  else
    -- funded and within the authorization: reserve and capture in one transaction (no reservation is ever left open by a charge)
    v_key := 'rec:' || a.id || ':' || p_period_key;
    insert into public.studio_sms_credit_reservations (legal_entity_id, studio_id, kind, amount_cents, funding, reservation_key)
    values (a.legal_entity_id, a.studio_id, a.kind, a.price_cents, 'credit', v_key) returning id into v_res;
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'reserve', 0, a.price_cents, 'reserve:' || v_key, v_res, 'recurring=' || a.id, null, null);
    perform public._tw4c_post(a.legal_entity_id, a.studio_id, 'capture', -a.price_cents, -a.price_cents, 'capture:' || v_key, v_res, 'recurring=' || a.id || ';period=' || p_period_key, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = v_res;
  end if;
  if c.id is null then
    insert into public.studio_sms_recurring_charges (authorization_id, legal_entity_id, studio_id, kind, period_key, amount_cents, status, reservation_id, charged_at, run_id)
    values (a.id, a.legal_entity_id, a.studio_id, a.kind, p_period_key, a.price_cents, 'charged', v_res, clock_timestamp(), p_run_id);
  else
    update public.studio_sms_recurring_charges set status = 'charged', reason = null, reservation_id = v_res, charged_at = clock_timestamp(), attempts = attempts + 1, attempted_at = clock_timestamp(), run_id = p_run_id where id = c.id;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (a.studio_id, null, 'system', null, 'recurring_charged', left('authorization=' || a.id || ';period=' || p_period_key || ';cents=' || a.price_cents, 300));
  return jsonb_build_object('outcome', 'charged', 'replayed', false, 'amount_cents', a.price_cents);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4in_ceiling(uuid), public._tw4in_reconciliation_gaps(), public._tw4in_spend_without_inbound(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text), public.tw4_inbound_reply_allowed(text, text, text, int),
  public.tw4_inbound_exposure_set(uuid, uuid, int, text), public.sms_inbound_admin_overview(uuid) from public, anon, authenticated;
grant execute on function public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text), public.tw4_inbound_reply_allowed(text, text, text, int),
  public.tw4_inbound_exposure_set(uuid, uuid, int, text), public.sms_inbound_admin_overview(uuid) to service_role;

commit;
