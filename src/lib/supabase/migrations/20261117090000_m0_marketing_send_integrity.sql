-- Marketing M-0 (stage 1 of 2) -- email marketing send-time eligibility, unsubscribe integrity and suppression.
--
-- Closes the M-0 audit findings at the database layer for studio campaigns (marketing_campaign_*), organizer campaigns
-- (organizer_marketing_*) and commercial ARIA / automation messages (outbound_deliveries, through the dispatcher):
--   C1  organizer unsubscribes were never persisted (ON CONFLICT did not match the (organizer_id, lower(email)) index)
--       -> one unsubscribe function for every token kind, using the expression index explicitly.
--   C2  regenerating a partially sent list deleted sent rows, re-mailed people and broke delivered unsubscribe links
--       -> marketing_sync_campaign_recipients: atomic, preserves every row that was ever handed to the provider.
--   C3  no eligibility re-check at send time / C4 fail-open suppression lookups
--       -> marketing_claim_campaign_recipient: the final eligibility check happens in the same transaction that claims
--          the recipient, under a per-email lock shared with unsubscribe; any error stops the send.
--   C8  tenant writes could clear unsubscribes or resurrect suppressed recipients -> client-role guards + RLS.
--   D2  platform-wide marketing suppression for confirmed hard bounces and complaints (marketing_email_suppressions;
--       filled by the M-0D provider integration, empty until then).
--   D3  campaign test sends only to verified workspace staff, rate limited and recorded (marketing_test_sends).
--
-- Send-attempt lifecycle (per recipient): pending -> sending (claimed; lease) -> sent | failed
--   provider outcome uncertain -> stays 'sending' (lease expired) and is re-claimed later with the SAME provider
--   idempotency key; the provider de-duplicates a repeat within its retention window. A recipient whose first attempt is
--   older than 23 hours (inside the provider's 24 hour idempotency window) is never re-sent: it becomes
--   'delivery_unknown' for review. Exactly-once external delivery is NOT claimed.
--
-- Compatibility: additive. The currently deployed application keeps working: its direct recipient writes are still
-- allowed for never-mailed rows (stage 2, 20261117091000, removes them after the new application is live). What the old
-- application can no longer do is exactly the unsafe part: delete sent rows, overwrite an unsubscribed row as sent, or
-- change/clear an unsubscribe record.
--
-- Rollback: rollback/20261117090000_m0_marketing_send_integrity_rollback.sql (refuses while sends are in flight).

begin;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Recipient lifecycle columns and statuses
-- ---------------------------------------------------------------------------------------------------------------

alter table public.marketing_campaign_recipients
  add column if not exists claim_id uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists first_attempt_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_error text,
  add column if not exists status_changed_at timestamptz;

alter table public.organizer_marketing_campaign_recipients
  add column if not exists claim_id uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists first_attempt_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_error text,
  add column if not exists status_changed_at timestamptz;

alter table public.marketing_campaign_recipients
  drop constraint if exists marketing_campaign_recipients_status_check;
alter table public.marketing_campaign_recipients
  add constraint marketing_campaign_recipients_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'unsubscribed', 'suppressed', 'delivery_unknown'));

alter table public.organizer_marketing_campaign_recipients
  drop constraint if exists organizer_marketing_campaign_recipients_status_check;
alter table public.organizer_marketing_campaign_recipients
  add constraint organizer_marketing_campaign_recipients_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped', 'unsubscribed', 'suppressed', 'delivery_unknown'));

alter table public.marketing_campaign_recipients
  drop constraint if exists marketing_campaign_recipients_claim_shape;
alter table public.marketing_campaign_recipients
  add constraint marketing_campaign_recipients_claim_shape
  check (status <> 'sending' or (claim_id is not null and claimed_at is not null and claim_expires_at is not null and first_attempt_at is not null));

alter table public.organizer_marketing_campaign_recipients
  drop constraint if exists organizer_marketing_campaign_recipients_claim_shape;
alter table public.organizer_marketing_campaign_recipients
  add constraint organizer_marketing_campaign_recipients_claim_shape
  check (status <> 'sending' or (claim_id is not null and claimed_at is not null and claim_expires_at is not null and first_attempt_at is not null));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Unsubscribe audit columns (the first unsubscribe is never overwritten; repeats are counted)
-- ---------------------------------------------------------------------------------------------------------------

alter table public.marketing_unsubscribes
  add column if not exists source text,
  add column if not exists last_source text,
  add column if not exists last_requested_at timestamptz,
  add column if not exists request_count integer not null default 1,
  add column if not exists campaign_id uuid,
  add column if not exists recipient_id uuid;

alter table public.organizer_marketing_unsubscribes
  add column if not exists source text,
  add column if not exists last_source text,
  add column if not exists last_requested_at timestamptz,
  add column if not exists request_count integer not null default 1,
  add column if not exists campaign_id uuid,
  add column if not exists recipient_id uuid;

-- The suppression lookups rely on these expression indexes (they already exist in DEV; created here when missing).
create unique index if not exists marketing_unsubscribes_studio_email_unique
  on public.marketing_unsubscribes (studio_id, lower(email));
create unique index if not exists uq_organizer_marketing_unsubscribes_email
  on public.organizer_marketing_unsubscribes (organizer_id, lower(email));

-- ---------------------------------------------------------------------------------------------------------------
-- 3. New tables: platform suppressions, per-message unsubscribe tokens, test-send ledger (service role only)
-- ---------------------------------------------------------------------------------------------------------------

create table if not exists public.marketing_email_suppressions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  reason text not null,
  source text not null default 'manual',
  active boolean not null default true,
  first_recorded_at timestamptz not null default now(),
  last_recorded_at timestamptz not null default now(),
  event_count integer not null default 1,
  last_provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_email_suppressions_email_normalized check (email = lower(btrim(email)) and position('@' in email) > 1),
  constraint marketing_email_suppressions_reason_check check (reason in ('hard_bounce', 'complaint', 'platform_manual'))
);
-- Recipient tokens are unique per table (these indexes exist in the live databases; codified here, never dropped).
create unique index if not exists marketing_campaign_recipients_unsubscribe_token_unique
  on public.marketing_campaign_recipients (unsubscribe_token) where unsubscribe_token is not null;
create unique index if not exists uq_organizer_marketing_campaign_recipients_unsubscribe_token
  on public.organizer_marketing_campaign_recipients (unsubscribe_token) where unsubscribe_token is not null;
create unique index if not exists marketing_email_suppressions_email_unique on public.marketing_email_suppressions (email);

create table if not exists public.marketing_message_unsubscribe_tokens (
  token uuid primary key default gen_random_uuid(),
  scope_kind text not null,
  studio_id uuid references public.studios (id) on delete cascade,
  organizer_id uuid references public.organizers (id) on delete cascade,
  email text not null,
  source_table text not null,
  source_id uuid not null,
  created_at timestamptz not null default now(),
  constraint marketing_message_unsubscribe_tokens_scope check (
    (scope_kind = 'studio' and studio_id is not null and organizer_id is null)
    or (scope_kind = 'organizer' and organizer_id is not null and studio_id is null)
  ),
  constraint marketing_message_unsubscribe_tokens_email_normalized check (email = lower(btrim(email))),
  constraint marketing_message_unsubscribe_tokens_source_unique unique (source_table, source_id)
);

create table if not exists public.marketing_test_sends (
  id uuid primary key default gen_random_uuid(),
  scope_kind text not null check (scope_kind in ('studio', 'organizer')),
  scope_id uuid not null,
  campaign_id uuid not null,
  requested_by uuid,
  recipient_email text not null,
  created_at timestamptz not null default now()
);
create index if not exists marketing_test_sends_scope_recent on public.marketing_test_sends (scope_kind, scope_id, created_at desc);

alter table public.marketing_email_suppressions enable row level security;
alter table public.marketing_message_unsubscribe_tokens enable row level security;
alter table public.marketing_test_sends enable row level security;
revoke all on public.marketing_email_suppressions from public, anon, authenticated;
revoke all on public.marketing_message_unsubscribe_tokens from public, anon, authenticated;
revoke all on public.marketing_test_sends from public, anon, authenticated;
grant all on public.marketing_email_suppressions, public.marketing_message_unsubscribe_tokens, public.marketing_test_sends to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public._mkt_norm_email(p_email text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(lower(btrim(coalesce(p_email, ''))), '');
$$;

-- One lock per address, shared by claim, unsubscribe and suppression writers: an unsubscribe that commits before the
-- claim is always seen by it; a claim that commits first is followed by at most the one in-flight provider call.
create or replace function public._mkt_lock_email(p_email text)
returns void
language sql
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('danceflow.marketing.email:' || coalesce(public._mkt_norm_email(p_email), ''), 0));
$$;

-- 'eligible' | 'unsubscribed' (scope opt-out) | 'suppressed' (platform hard bounce / complaint) | 'invalid'.
-- Raises on an unknown scope: callers treat any error as "do not send".
create or replace function public._mkt_suppression_status(p_scope_kind text, p_scope_id uuid, p_email text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := public._mkt_norm_email(p_email);
begin
  if p_scope_kind not in ('studio', 'organizer') or p_scope_id is null then
    raise exception 'marketing scope is invalid' using errcode = '22023';
  end if;
  if v_email is null or position('@' in v_email) < 2 then
    return 'invalid';
  end if;
  if exists (select 1 from public.marketing_email_suppressions s where s.email = v_email and s.active) then
    return 'suppressed';
  end if;
  if p_scope_kind = 'studio' then
    if exists (select 1 from public.marketing_unsubscribes u where u.studio_id = p_scope_id and lower(u.email) = v_email) then
      return 'unsubscribed';
    end if;
  else
    if exists (select 1 from public.organizer_marketing_unsubscribes u where u.organizer_id = p_scope_id and lower(u.email) = v_email)
       or exists (select 1 from public.organizer_contacts c where c.organizer_id = p_scope_id and lower(c.email) = v_email and c.status = 'unsubscribed') then
      return 'unsubscribed';
    end if;
  end if;
  return 'eligible';
end;
$$;

-- Read-only eligibility for message paths that have no recipient row (commercial ARIA / automation messages).
create or replace function public.marketing_suppression_status(p_scope_kind text, p_scope_id uuid, p_email text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._mkt_suppression_status(p_scope_kind, p_scope_id, p_email);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4b. Marketing send freeze (release / rollback transitions)
-- ---------------------------------------------------------------------------------------------------------------
-- While frozen no marketing message is dispatched by either application version:
--  * new application: campaign claims return 'frozen' (the batch stops) and campaign test sends are refused;
--  * pre-M-0 application: client roles cannot see 'pending' recipients (its send finds nothing and redirects
--    'no_pending_recipients') and cannot write recipients (its regenerate fails closed instead of duplicating rows);
--  * both: the outbound dispatcher's claim (claim_outbound_deliveries) leaves commercial ARIA / automation email
--    queued (held, not dropped); operational and transactional email is unaffected.
-- Unsubscribe is never frozen. The first application of this migration lands FROZEN, so marketing stays paused through
-- the schema/application transition until an operator verifies the M-0 application and releases it:
--   select public.marketing_set_send_freeze(false, '<who / why>');   -- service role only
create table if not exists public.marketing_send_controls (
  id boolean primary key default true constraint marketing_send_controls_singleton check (id),
  frozen boolean not null,
  reason text not null,
  changed_at timestamptz not null default now()
);
create table if not exists public.marketing_send_control_events (
  id bigint generated always as identity primary key,
  frozen boolean not null,
  reason text not null,
  changed_at timestamptz not null default now()
);
alter table public.marketing_send_controls enable row level security;
alter table public.marketing_send_control_events enable row level security;
revoke all on table public.marketing_send_controls from public, anon, authenticated;
revoke all on table public.marketing_send_control_events from public, anon, authenticated;
grant all on table public.marketing_send_controls to service_role;
grant all on table public.marketing_send_control_events to service_role;

insert into public.marketing_send_controls (id, frozen, reason)
values (true, true, 'M-0 stage 1 applied: frozen until the M-0 application is verified and an operator releases it')
on conflict (id) do nothing;

-- Missing control row = frozen (fail closed).
create or replace function public.marketing_send_frozen()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select c.frozen from public.marketing_send_controls c where c.id), true)
$$;

create or replace function public.marketing_set_send_freeze(p_frozen boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
begin
  if p_frozen is null or v_reason is null then
    raise exception 'marketing_set_send_freeze: frozen and a reason are required' using errcode = '22023';
  end if;
  insert into public.marketing_send_controls (id, frozen, reason, changed_at)
  values (true, p_frozen, v_reason, now())
  on conflict (id) do update set frozen = excluded.frozen, reason = excluded.reason, changed_at = excluded.changed_at;
  insert into public.marketing_send_control_events (frozen, reason) values (p_frozen, v_reason);
  return jsonb_build_object('frozen', p_frozen);
end;
$$;

-- SQL mirror of src/lib/marketing/compliance/messageClassification.ts (classifyOutboundEmail) for the dispatcher claim.
-- A parity test keeps the two in step: automation-family email is commercial unless it is one of the operational keys
-- AND carries the producer's system_default stamp.
create or replace function public._mkt_is_commercial_outbound(p_channel text, p_template_key text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_channel, '') = 'email'
     and (starts_with(coalesce(p_template_key, ''), 'aria_execution_') or starts_with(coalesce(p_template_key, ''), 'automation_'))
     and not (p_template_key in ('aria_execution_aria_membership_past_due', 'automation_unsigned_document', 'automation_pending_booking_request')
              and coalesce(p_payload ->> 'content_origin', '') = 'system_default')
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Atomic, history-preserving recipient generation
-- ---------------------------------------------------------------------------------------------------------------

-- Replaces the campaign's never-mailed rows (pending / unsubscribed / skipped / suppressed: their tokens were never
-- delivered) with the freshly computed audience. Rows that were ever handed to the provider (sent, failed, sending,
-- delivery_unknown) are preserved with their tokens and provider ids, and their addresses are never re-added.
-- Eligibility is decided here, authoritatively, not by the caller.
create or replace function public.marketing_sync_campaign_recipients(
  p_scope_kind text,
  p_scope_id uuid,
  p_campaign_id uuid,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_status text;
  v_count integer;
  v_preserved integer;
  v_pending integer;
  v_unsub integer;
  v_supp integer;
  v_skipped integer;
begin
  if p_scope_kind not in ('studio', 'organizer') or p_scope_id is null or p_campaign_id is null then
    raise exception 'marketing scope is invalid' using errcode = '22023';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' then
    raise exception 'recipients must be a json array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_recipients);
  if v_count > 20000 then
    return jsonb_build_object('outcome', 'too_many_recipients', 'count', v_count);
  end if;

  if p_scope_kind = 'studio' then
    select c.status into v_campaign_status
    from public.marketing_campaigns c
    where c.id = p_campaign_id and c.studio_id = p_scope_id
    for update;
  else
    select c.status into v_campaign_status
    from public.organizer_marketing_campaigns c
    where c.id = p_campaign_id and c.organizer_id = p_scope_id
    for update;
  end if;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_campaign_status in ('sending', 'sent', 'cancelled') then
    return jsonb_build_object('outcome', 'campaign_locked', 'campaign_status', v_campaign_status);
  end if;

  if p_scope_kind = 'studio' then
    if exists (select 1 from public.marketing_campaign_recipients r where r.campaign_id = p_campaign_id and r.status = 'sending') then
      return jsonb_build_object('outcome', 'delivery_in_progress');
    end if;

    delete from public.marketing_campaign_recipients r
    where r.campaign_id = p_campaign_id and r.studio_id = p_scope_id
      and r.status in ('pending', 'unsubscribed', 'skipped', 'suppressed')
      and r.first_attempt_at is null;

    select count(*) into v_preserved from public.marketing_campaign_recipients r where r.campaign_id = p_campaign_id;

    with input as (
      select distinct on (public._mkt_norm_email(x ->> 'email'))
        public._mkt_norm_email(x ->> 'email') as email,
        nullif(btrim(coalesce(x ->> 'name', '')), '') as name,
        case when coalesce(x ->> 'ref_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then (x ->> 'ref_id')::uuid end as ref_id
      from jsonb_array_elements(p_recipients) as x
      where public._mkt_norm_email(x ->> 'email') is not null
        and position('@' in public._mkt_norm_email(x ->> 'email')) > 1
      order by public._mkt_norm_email(x ->> 'email')
    )
    insert into public.marketing_campaign_recipients
      (campaign_id, studio_id, client_id, email, name, status, unsubscribe_token, error_message, status_changed_at)
    select p_campaign_id, p_scope_id,
           (select cl.id from public.clients cl where cl.id = i.ref_id and cl.studio_id = p_scope_id),
           i.email, i.name,
           case s.st when 'eligible' then 'pending' when 'unsubscribed' then 'unsubscribed'
                     when 'suppressed' then 'suppressed' else 'skipped' end,
           gen_random_uuid()::text,
           case s.st when 'eligible' then null when 'unsubscribed' then 'Suppressed by unsubscribe list'
                     when 'suppressed' then 'Suppressed by platform email suppression' else 'Invalid email address' end,
           now()
    from input i
    cross join lateral (select public._mkt_suppression_status('studio', p_scope_id, i.email) as st) s
    where not exists (
      select 1 from public.marketing_campaign_recipients r
      where r.campaign_id = p_campaign_id and lower(r.email) = i.email
    );

    select count(*) filter (where status = 'pending'), count(*) filter (where status = 'unsubscribed'),
           count(*) filter (where status = 'suppressed'), count(*) filter (where status = 'skipped')
      into v_pending, v_unsub, v_supp, v_skipped
    from public.marketing_campaign_recipients where campaign_id = p_campaign_id;
  else
    if exists (select 1 from public.organizer_marketing_campaign_recipients r where r.campaign_id = p_campaign_id and r.status = 'sending') then
      return jsonb_build_object('outcome', 'delivery_in_progress');
    end if;

    delete from public.organizer_marketing_campaign_recipients r
    where r.campaign_id = p_campaign_id and r.organizer_id = p_scope_id
      and r.status in ('pending', 'unsubscribed', 'skipped', 'suppressed')
      and r.first_attempt_at is null;

    select count(*) into v_preserved from public.organizer_marketing_campaign_recipients r where r.campaign_id = p_campaign_id;

    with input as (
      select distinct on (public._mkt_norm_email(x ->> 'email'))
        public._mkt_norm_email(x ->> 'email') as email,
        nullif(btrim(coalesce(x ->> 'name', '')), '') as name,
        case when coalesce(x ->> 'ref_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then (x ->> 'ref_id')::uuid end as ref_id
      from jsonb_array_elements(p_recipients) as x
      where public._mkt_norm_email(x ->> 'email') is not null
        and position('@' in public._mkt_norm_email(x ->> 'email')) > 1
      order by public._mkt_norm_email(x ->> 'email')
    )
    insert into public.organizer_marketing_campaign_recipients
      (campaign_id, organizer_id, organizer_contact_id, email, name, status, unsubscribe_token, error_message, status_changed_at)
    select p_campaign_id, p_scope_id,
           (select oc.id from public.organizer_contacts oc where oc.id = i.ref_id and oc.organizer_id = p_scope_id),
           i.email, i.name,
           case s.st when 'eligible' then 'pending' when 'unsubscribed' then 'unsubscribed'
                     when 'suppressed' then 'suppressed' else 'skipped' end,
           gen_random_uuid(),
           case s.st when 'eligible' then null when 'unsubscribed' then 'Suppressed by organizer unsubscribe list'
                     when 'suppressed' then 'Suppressed by platform email suppression' else 'Invalid email address' end,
           now()
    from input i
    cross join lateral (select public._mkt_suppression_status('organizer', p_scope_id, i.email) as st) s
    where not exists (
      select 1 from public.organizer_marketing_campaign_recipients r
      where r.campaign_id = p_campaign_id and lower(r.email) = i.email
    );

    select count(*) filter (where status = 'pending'), count(*) filter (where status = 'unsubscribed'),
           count(*) filter (where status = 'suppressed'), count(*) filter (where status = 'skipped')
      into v_pending, v_unsub, v_supp, v_skipped
    from public.organizer_marketing_campaign_recipients where campaign_id = p_campaign_id;
  end if;

  return jsonb_build_object(
    'outcome', 'synced',
    'preserved', v_preserved,
    'pending', v_pending,
    'unsubscribed', v_unsub,
    'suppressed', v_supp,
    'skipped', v_skipped
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Send-time claim and completion
-- ---------------------------------------------------------------------------------------------------------------

-- Final eligibility check + claim, in one transaction, under the per-email lock (taken before the row lock, the same
-- order the unsubscribe function uses). Outcomes:
--   claimed           -> send now with the returned idempotency key; complete with the returned claim id
--   unsubscribed / suppressed / invalid -> marked, never sent
--   in_flight         -> another worker holds an unexpired claim; skip
--   delivery_unknown  -> an uncertain attempt is older than the provider idempotency window; never re-sent
--   not_claimable / not_found -> already terminal or not in this campaign/scope
create or replace function public.marketing_claim_campaign_recipient(
  p_scope_kind text,
  p_scope_id uuid,
  p_campaign_id uuid,
  p_recipient_id uuid,
  p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_status text;
  v_expires timestamptz;
  v_first timestamptz;
  v_attempts integer;
  v_token text;
  v_campaign_status text;
  v_st text;
  v_claim uuid := gen_random_uuid();
  v_lease interval := make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 3600)));
begin
  if p_scope_kind not in ('studio', 'organizer') or p_scope_id is null or p_campaign_id is null or p_recipient_id is null then
    raise exception 'marketing scope is invalid' using errcode = '22023';
  end if;
  if public.marketing_send_frozen() then
    return jsonb_build_object('outcome', 'frozen');
  end if;

  if p_scope_kind = 'studio' then
    select r.email into v_email from public.marketing_campaign_recipients r
    where r.id = p_recipient_id and r.campaign_id = p_campaign_id and r.studio_id = p_scope_id;
  else
    select r.email into v_email from public.organizer_marketing_campaign_recipients r
    where r.id = p_recipient_id and r.campaign_id = p_campaign_id and r.organizer_id = p_scope_id;
  end if;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  perform public._mkt_lock_email(v_email);

  if p_scope_kind = 'studio' then
    select c.status into v_campaign_status from public.marketing_campaigns c
    where c.id = p_campaign_id and c.studio_id = p_scope_id;
    select r.status, r.claim_expires_at, r.first_attempt_at, r.attempt_count, r.unsubscribe_token, r.email
      into v_status, v_expires, v_first, v_attempts, v_token, v_email
    from public.marketing_campaign_recipients r
    where r.id = p_recipient_id and r.campaign_id = p_campaign_id and r.studio_id = p_scope_id
    for update;
  else
    select c.status into v_campaign_status from public.organizer_marketing_campaigns c
    where c.id = p_campaign_id and c.organizer_id = p_scope_id;
    select r.status, r.claim_expires_at, r.first_attempt_at, r.attempt_count, r.unsubscribe_token::text, r.email
      into v_status, v_expires, v_first, v_attempts, v_token, v_email
    from public.organizer_marketing_campaign_recipients r
    where r.id = p_recipient_id and r.campaign_id = p_campaign_id and r.organizer_id = p_scope_id
    for update;
  end if;

  if v_status is null or v_campaign_status is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_campaign_status = 'cancelled' then
    return jsonb_build_object('outcome', 'not_claimable', 'status', v_status, 'campaign_status', v_campaign_status);
  end if;

  if v_status not in ('sending', 'pending') then
    return jsonb_build_object('outcome', 'not_claimable', 'status', v_status);
  end if;
  if v_status = 'sending' and v_expires > now() then
    return jsonb_build_object('outcome', 'in_flight');
  end if;
  -- first_attempt_at survives only an attempt that may have been delivered (uncertain outcome or a crash): a definitive
  -- "not sent" release of a first attempt clears it. Such a row, pending again or still sending, is never re-sent once
  -- the provider idempotency window may have passed.
  if v_first is not null then
    if v_first < now() - interval '23 hours' then
      if p_scope_kind = 'studio' then
        update public.marketing_campaign_recipients
        set status = 'delivery_unknown', claim_id = null, claimed_at = null, claim_expires_at = null,
            error_message = 'Delivery outcome unknown; not re-sent (review required)', status_changed_at = now()
        where id = p_recipient_id;
      else
        update public.organizer_marketing_campaign_recipients
        set status = 'delivery_unknown', claim_id = null, claimed_at = null, claim_expires_at = null,
            error_message = 'Delivery outcome unknown; not re-sent (review required)', status_changed_at = now()
        where id = p_recipient_id;
      end if;
      return jsonb_build_object('outcome', 'delivery_unknown');
    end if;
  end if;

  v_st := public._mkt_suppression_status(p_scope_kind, p_scope_id, v_email);

  if v_st <> 'eligible' then
    -- A re-claim of an uncertain attempt is never re-sent once the address is suppressed; the earlier attempt may have
    -- been delivered, so it is recorded as unknown rather than as never sent.
    if p_scope_kind = 'studio' then
      update public.marketing_campaign_recipients
      set status = case when v_first is not null then 'delivery_unknown'
                        when v_st = 'unsubscribed' then 'unsubscribed'
                        when v_st = 'suppressed' then 'suppressed' else 'skipped' end,
          claim_id = null, claimed_at = null, claim_expires_at = null,
          error_message = case v_st when 'unsubscribed' then 'Unsubscribed before send'
                                    when 'suppressed' then 'Suppressed by platform email suppression'
                                    else 'Invalid email address' end,
          status_changed_at = now()
      where id = p_recipient_id;
    else
      update public.organizer_marketing_campaign_recipients
      set status = case when v_first is not null then 'delivery_unknown'
                        when v_st = 'unsubscribed' then 'unsubscribed'
                        when v_st = 'suppressed' then 'suppressed' else 'skipped' end,
          claim_id = null, claimed_at = null, claim_expires_at = null,
          error_message = case v_st when 'unsubscribed' then 'Unsubscribed before send'
                                    when 'suppressed' then 'Suppressed by platform email suppression'
                                    else 'Invalid email address' end,
          status_changed_at = now()
      where id = p_recipient_id;
    end if;
    return jsonb_build_object('outcome', case when v_first is not null then 'delivery_unknown' else v_st end);
  end if;

  if p_scope_kind = 'studio' then
    update public.marketing_campaign_recipients
    set status = 'sending', claim_id = v_claim, claimed_at = now(), claim_expires_at = now() + v_lease,
        first_attempt_at = coalesce(first_attempt_at, now()), attempt_count = attempt_count + 1,
        status_changed_at = now()
    where id = p_recipient_id;
  else
    update public.organizer_marketing_campaign_recipients
    set status = 'sending', claim_id = v_claim, claimed_at = now(), claim_expires_at = now() + v_lease,
        first_attempt_at = coalesce(first_attempt_at, now()), attempt_count = attempt_count + 1,
        status_changed_at = now()
    where id = p_recipient_id;
  end if;

  return jsonb_build_object(
    'outcome', 'claimed',
    'claim_id', v_claim,
    'retry', v_first is not null,
    'attempt', coalesce(v_attempts, 0) + 1,
    'email', lower(btrim(v_email)),
    'unsubscribe_token', v_token,
    'idempotency_key', 'mkt-' || p_scope_kind || '-' || p_recipient_id::text
  );
end;
$$;

-- p_outcome: 'sent' (provider accepted) | 'failed' (provider definitively rejected this recipient) |
-- 'released' (provider definitively did not accept: rate limit / configuration; safe to send later) |
-- 'uncertain' (no definitive answer: stays claimed-but-expired for a later re-claim with the same idempotency key).
-- Only the holder of the current claim can complete it.
create or replace function public.marketing_complete_campaign_recipient(
  p_scope_kind text,
  p_scope_id uuid,
  p_recipient_id uuid,
  p_claim_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_claim uuid;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
begin
  if p_scope_kind not in ('studio', 'organizer') or p_outcome not in ('sent', 'failed', 'released', 'uncertain') then
    raise exception 'invalid completion' using errcode = '22023';
  end if;

  if p_scope_kind = 'studio' then
    select status, claim_id into v_status, v_claim from public.marketing_campaign_recipients
    where id = p_recipient_id and studio_id = p_scope_id for update;
  else
    select status, claim_id into v_status, v_claim from public.organizer_marketing_campaign_recipients
    where id = p_recipient_id and organizer_id = p_scope_id for update;
  end if;

  if v_status is distinct from 'sending' or v_claim is distinct from p_claim_id then
    return jsonb_build_object('outcome', 'stale', 'status', v_status);
  end if;

  if p_scope_kind = 'studio' then
    update public.marketing_campaign_recipients
    set status = case p_outcome when 'sent' then 'sent' when 'failed' then 'failed'
                                when 'released' then 'pending' else 'sending' end,
        provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else provider_message_id end,
        sent_at = case when p_outcome = 'sent' then now() else sent_at end,
        error_message = case p_outcome when 'sent' then null when 'failed' then coalesce(v_error, 'Send failed')
                                       else error_message end,
        last_attempt_error = case when p_outcome = 'sent' then last_attempt_error else coalesce(v_error, last_attempt_error) end,
        claim_id = case when p_outcome = 'uncertain' then claim_id else null end,
        claimed_at = case when p_outcome = 'uncertain' then claimed_at else null end,
        claim_expires_at = case when p_outcome = 'uncertain' then now() else null end,
        attempt_count = case when p_outcome = 'released' then greatest(attempt_count - 1, 0) else attempt_count end,
        first_attempt_at = case when p_outcome = 'released' and attempt_count <= 1 then null else first_attempt_at end,
        status_changed_at = case when p_outcome = 'uncertain' then status_changed_at else now() end
    where id = p_recipient_id;
  else
    update public.organizer_marketing_campaign_recipients
    set status = case p_outcome when 'sent' then 'sent' when 'failed' then 'failed'
                                when 'released' then 'pending' else 'sending' end,
        provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else provider_message_id end,
        sent_at = case when p_outcome = 'sent' then now() else sent_at end,
        error_message = case p_outcome when 'sent' then null when 'failed' then coalesce(v_error, 'Send failed')
                                       else error_message end,
        last_attempt_error = case when p_outcome = 'sent' then last_attempt_error else coalesce(v_error, last_attempt_error) end,
        claim_id = case when p_outcome = 'uncertain' then claim_id else null end,
        claimed_at = case when p_outcome = 'uncertain' then claimed_at else null end,
        claim_expires_at = case when p_outcome = 'uncertain' then now() else null end,
        attempt_count = case when p_outcome = 'released' then greatest(attempt_count - 1, 0) else attempt_count end,
        first_attempt_at = case when p_outcome = 'released' and attempt_count <= 1 then null else first_attempt_at end,
        status_changed_at = case when p_outcome = 'uncertain' then status_changed_at else now() end
    where id = p_recipient_id;
  end if;

  return jsonb_build_object('outcome', p_outcome);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Unsubscribe (one function for every token kind) and per-message tokens
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.marketing_issue_message_unsubscribe_token(
  p_scope_kind text,
  p_scope_id uuid,
  p_email text,
  p_source_table text,
  p_source_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := public._mkt_norm_email(p_email);
  v_token uuid;
  v_kind text;
  v_scope uuid;
  v_existing_email text;
begin
  if p_scope_kind not in ('studio', 'organizer') or p_scope_id is null or v_email is null
     or coalesce(btrim(p_source_table), '') = '' or p_source_id is null then
    raise exception 'invalid unsubscribe token request' using errcode = '22023';
  end if;

  insert into public.marketing_message_unsubscribe_tokens (scope_kind, studio_id, organizer_id, email, source_table, source_id)
  values (p_scope_kind,
          case when p_scope_kind = 'studio' then p_scope_id end,
          case when p_scope_kind = 'organizer' then p_scope_id end,
          v_email, p_source_table, p_source_id)
  on conflict (source_table, source_id) do nothing;

  select t.token, t.scope_kind, coalesce(t.studio_id, t.organizer_id), t.email
    into v_token, v_kind, v_scope, v_existing_email
  from public.marketing_message_unsubscribe_tokens t
  where t.source_table = p_source_table and t.source_id = p_source_id;

  if v_kind <> p_scope_kind or v_scope <> p_scope_id or v_existing_email <> v_email then
    raise exception 'unsubscribe token source belongs to another recipient' using errcode = '23514';
  end if;

  return v_token;
end;
$$;

-- p_method: 'one_click' (RFC 8058 POST) | 'page_form' (confirmation page) | 'legacy_page' (pre-M-0 studio page RPC).
-- Idempotent. Records the scope unsubscribe (first occurrence kept; repeats counted), marks every never-mailed pending
-- row of that scope+address unsubscribed, and (organizer) marks the organizer contact unsubscribed.
-- Returns only {ok, scope_kind}: no email address or workspace name is disclosed to the token holder.
create or replace function public.marketing_unsubscribe_by_token(p_token text, p_method text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
  v_uuid uuid;
  v_kind text;
  v_scope uuid;
  v_email text;
  v_campaign uuid;
  v_recipient uuid;
begin
  if p_method not in ('one_click', 'page_form', 'legacy_page') then
    raise exception 'invalid unsubscribe method' using errcode = '22023';
  end if;
  if v_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_uuid := v_token::uuid;

  select 'studio', r.studio_id, r.email, r.campaign_id, r.id into v_kind, v_scope, v_email, v_campaign, v_recipient
  from public.marketing_campaign_recipients r where r.unsubscribe_token = v_uuid::text limit 1;  -- canonical lowercase form, unique-indexed

  if v_kind is null then
    select 'organizer', r.organizer_id, r.email, r.campaign_id, r.id into v_kind, v_scope, v_email, v_campaign, v_recipient
    from public.organizer_marketing_campaign_recipients r where r.unsubscribe_token = v_uuid limit 1;
  end if;

  if v_kind is null then
    select t.scope_kind, coalesce(t.studio_id, t.organizer_id), t.email, null::uuid, null::uuid
      into v_kind, v_scope, v_email, v_campaign, v_recipient
    from public.marketing_message_unsubscribe_tokens t where t.token = v_uuid;
  end if;

  if v_kind is null or v_scope is null or public._mkt_norm_email(v_email) is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_email := public._mkt_norm_email(v_email);
  perform public._mkt_lock_email(v_email);

  if v_kind = 'studio' then
    insert into public.marketing_unsubscribes
      (studio_id, email, reason, unsubscribed_at, created_at, source, last_source, last_requested_at, request_count, campaign_id, recipient_id)
    values (v_scope, v_email, 'recipient_unsubscribe_link', now(), now(), p_method, p_method, now(), 1, v_campaign, v_recipient)
    on conflict (studio_id, lower(email)) do update
      set last_source = excluded.last_source,
          last_requested_at = excluded.last_requested_at,
          request_count = public.marketing_unsubscribes.request_count + 1,
          source = coalesce(public.marketing_unsubscribes.source, excluded.source),
          campaign_id = coalesce(public.marketing_unsubscribes.campaign_id, excluded.campaign_id),
          recipient_id = coalesce(public.marketing_unsubscribes.recipient_id, excluded.recipient_id);

    update public.marketing_campaign_recipients
    set status = 'unsubscribed', error_message = 'Unsubscribed before send', status_changed_at = now()
    where studio_id = v_scope and lower(email) = v_email and status = 'pending';
  else
    insert into public.organizer_marketing_unsubscribes
      (organizer_id, email, reason, unsubscribed_at, created_at, source, last_source, last_requested_at, request_count, campaign_id, recipient_id)
    values (v_scope, v_email, 'recipient_unsubscribe_link', now(), now(), p_method, p_method, now(), 1, v_campaign, v_recipient)
    on conflict (organizer_id, lower(email)) do update
      set last_source = excluded.last_source,
          last_requested_at = excluded.last_requested_at,
          request_count = public.organizer_marketing_unsubscribes.request_count + 1,
          source = coalesce(public.organizer_marketing_unsubscribes.source, excluded.source),
          campaign_id = coalesce(public.organizer_marketing_unsubscribes.campaign_id, excluded.campaign_id),
          recipient_id = coalesce(public.organizer_marketing_unsubscribes.recipient_id, excluded.recipient_id);

    update public.organizer_marketing_campaign_recipients
    set status = 'unsubscribed', error_message = 'Unsubscribed before send', status_changed_at = now()
    where organizer_id = v_scope and lower(email) = v_email and status = 'pending';

    update public.organizer_contacts
    set status = 'unsubscribed', updated_at = now()
    where organizer_id = v_scope and lower(email) = v_email and status = 'active';
  end if;

  return jsonb_build_object('ok', true, 'scope_kind', v_kind);
end;
$$;

-- The pre-M-0 studio page RPC (still called by the pre-M-0 application) now goes through the same function, so it
-- records the unsubscribe the same way and also suppresses the address's other pending campaign rows. It resolves studio
-- campaign tokens and studio-scoped per-message tokens (commercial ARIA / automation email links point at the same
-- page), so those links keep working if the application is ever rolled back. Organizer tokens are not resolved here.
-- Signature, result shape and grants are unchanged until stage 2 revokes the client grants.
create or replace function public.unsubscribe_marketing_recipient(p_token text)
returns table (
  success boolean,
  studio_name text,
  email text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not exists (select 1 from public.marketing_campaign_recipients r where r.unsubscribe_token = p_token)
     and not exists (select 1 from public.marketing_message_unsubscribe_tokens t
                     where t.scope_kind = 'studio' and t.token::text = lower(btrim(coalesce(p_token, '')))) then
    return query select false, null::text, null::text;
    return;
  end if;
  v_result := public.marketing_unsubscribe_by_token(p_token, 'legacy_page');
  return query select coalesce((v_result ->> 'ok')::boolean, false), null::text, null::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Campaign test sends: verified workspace staff only, rate limited, recorded
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.marketing_authorize_test_send(
  p_scope_kind text,
  p_scope_id uuid,
  p_campaign_id uuid,
  p_requested_by uuid,
  p_email text,
  p_max_per_hour integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := public._mkt_norm_email(p_email);
  v_recent integer;
  v_limit integer := greatest(1, least(coalesce(p_max_per_hour, 10), 100));
begin
  if p_scope_kind not in ('studio', 'organizer') or p_scope_id is null or p_campaign_id is null then
    raise exception 'marketing scope is invalid' using errcode = '22023';
  end if;

  if public.marketing_send_frozen() then
    return jsonb_build_object('allowed', false, 'reason', 'frozen');
  end if;

  if p_scope_kind = 'studio' then
    if not exists (select 1 from public.marketing_campaigns c where c.id = p_campaign_id and c.studio_id = p_scope_id) then
      return jsonb_build_object('allowed', false, 'reason', 'not_found');
    end if;
  else
    if not exists (select 1 from public.organizer_marketing_campaigns c where c.id = p_campaign_id and c.organizer_id = p_scope_id) then
      return jsonb_build_object('allowed', false, 'reason', 'not_found');
    end if;
  end if;

  if v_email is null or not exists (
    select 1
    from auth.users u
    where lower(u.email) = v_email
      and u.email_confirmed_at is not null
      and (
        (p_scope_kind = 'studio' and exists (
          select 1 from public.user_studio_roles usr
          where usr.user_id = u.id and usr.studio_id = p_scope_id and usr.active
            and usr.role::text in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor', 'platform_admin')))
        or (p_scope_kind = 'organizer' and (
          exists (
            select 1 from public.organizer_users ou
            where ou.user_id = u.id and ou.organizer_id = p_scope_id and ou.active)
          or exists (
            select 1 from public.organizers o
            join public.user_studio_roles usr on usr.studio_id = o.studio_id
            where o.id = p_scope_id and usr.user_id = u.id and usr.active
              and usr.role::text in ('studio_owner', 'studio_admin', 'front_desk'))))
      )
  ) then
    return jsonb_build_object('allowed', false, 'reason', 'recipient_not_verified_staff');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('danceflow.marketing.test:' || p_scope_kind || ':' || p_scope_id::text, 0));

  select count(*) into v_recent from public.marketing_test_sends t
  where t.scope_kind = p_scope_kind and t.scope_id = p_scope_id and t.created_at > now() - interval '1 hour';

  if v_recent >= v_limit then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited');
  end if;

  insert into public.marketing_test_sends (scope_kind, scope_id, campaign_id, requested_by, recipient_email)
  values (p_scope_kind, p_scope_id, p_campaign_id, p_requested_by, v_email);

  return jsonb_build_object('allowed', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 9. Client-role guards (anon / authenticated). Server code (service_role) and definer functions are unaffected.
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public._mkt_guard_unsubscribe_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  raise exception 'Marketing unsubscribe records can only be changed by the recipient''s unsubscribe request.'
    using errcode = '42501';
end;
$$;

create or replace function public._mkt_campaign_exists(p_table text, p_campaign_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_table = 'marketing_campaign_recipients' then
    return exists (select 1 from public.marketing_campaigns where id = p_campaign_id);
  end if;
  return exists (select 1 from public.organizer_marketing_campaigns where id = p_campaign_id);
end;
$$;

create or replace function public._mkt_guard_recipient_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'unsubscribed', 'skipped')
       or new.claim_id is not null or coalesce(new.attempt_count, 0) <> 0 or new.first_attempt_at is not null then
      raise exception 'Campaign recipients can only be added as not yet sent.' using errcode = '42501';
    end if;
    -- The token is the recipient's unsubscribe credential: a client never chooses it (a copied token from another
    -- scope would capture that scope's unsubscribes). The pre-M-0 app reads it back from the row before sending.
    new.unsubscribe_token := gen_random_uuid();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if (old.status in ('pending', 'unsubscribed', 'skipped', 'suppressed') and old.first_attempt_at is null)
       or not public._mkt_campaign_exists(tg_table_name, old.campaign_id) then
      return old;
    end if;
    raise exception 'A campaign recipient that was handed to the email provider cannot be deleted.' using errcode = '42501';
  end if;

  -- UPDATE
  if new.campaign_id is distinct from old.campaign_id
     or new.email is distinct from old.email
     or new.unsubscribe_token is distinct from old.unsubscribe_token
     or new.claim_id is distinct from old.claim_id
     or new.claimed_at is distinct from old.claimed_at
     or new.claim_expires_at is distinct from old.claim_expires_at
     or new.first_attempt_at is distinct from old.first_attempt_at
     or new.attempt_count is distinct from old.attempt_count then
    raise exception 'Campaign recipient identity and delivery-attempt fields are managed by the send pipeline.' using errcode = '42501';
  end if;
  -- Nested IFs: a record field that does not exist on this table must never be referenced.
  if tg_table_name = 'marketing_campaign_recipients' then
    if new.studio_id is distinct from old.studio_id then
      raise exception 'Campaign recipient scope cannot change.' using errcode = '42501';
    end if;
  else
    if new.organizer_id is distinct from old.organizer_id then
      raise exception 'Campaign recipient scope cannot change.' using errcode = '42501';
    end if;
  end if;
  if old.status not in ('pending') and new.status is distinct from old.status then
    raise exception 'A % campaign recipient cannot change status.', old.status using errcode = '42501';
  end if;
  if old.status in ('sent', 'sending', 'delivery_unknown', 'unsubscribed', 'suppressed')
     and (new.provider_message_id is distinct from old.provider_message_id or new.sent_at is distinct from old.sent_at) then
    raise exception 'Campaign recipient delivery evidence cannot be changed.' using errcode = '42501';
  end if;
  if new.status in ('sending', 'suppressed', 'delivery_unknown') and new.status is distinct from old.status then
    raise exception 'Campaign recipient status % is set only by the send pipeline.', new.status using errcode = '42501';
  end if;
  return new;
end;
$$;

-- True when any recipient of the campaign was handed to the email provider (its token may be in a delivered email).
create or replace function public._mkt_campaign_has_mailed(p_table text, p_campaign_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_table = 'marketing_campaigns' then
    return exists (select 1 from public.marketing_campaign_recipients r where r.campaign_id = p_campaign_id
                   and (r.first_attempt_at is not null or r.status in ('sent', 'failed', 'sending', 'delivery_unknown')));
  end if;
  return exists (select 1 from public.organizer_marketing_campaign_recipients r where r.campaign_id = p_campaign_id
                 and (r.first_attempt_at is not null or r.status in ('sent', 'failed', 'sending', 'delivery_unknown')));
end;
$$;

-- A mailed campaign cannot be deleted by a client role: the cascade would remove the recipient rows whose unsubscribe
-- tokens are in delivered emails (the links would stop working) and the ENT-1 delivery evidence.
create or replace function public._mkt_guard_campaign_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return old;
  end if;
  if public._mkt_campaign_has_mailed(tg_table_name, old.id) then
    raise exception 'A campaign that has been sent cannot be deleted.' using errcode = '42501';
  end if;
  return old;
end;
$$;

-- D1: automation-family email (aria_execution_* / automation_*) is treated as operational only when the server marked it
-- as unmodified system content. Studio users can insert outbound deliveries directly (RLS), so a client-role write of
-- such a row can never claim that: it is forced to "studio_customized", which the dispatcher classifies as commercial
-- (marketing sender, suppression, postal address, unsubscribe). Server producers write with the service role.
create or replace function public._mkt_guard_outbound_content_origin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if starts_with(new.template_key, 'aria_execution_') or starts_with(new.template_key, 'automation_') then
    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('content_origin', 'studio_customized');
  end if;
  return new;
end;
$$;

create or replace function public._mkt_guard_contact_unsubscribe()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if old.status = 'unsubscribed' and new.status is distinct from 'unsubscribed' then
    raise exception 'An unsubscribed contact can only be resubscribed by the contact.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists marketing_unsubscribes_00_m0_guard on public.marketing_unsubscribes;
create trigger marketing_unsubscribes_00_m0_guard
  before update or delete on public.marketing_unsubscribes
  for each row execute function public._mkt_guard_unsubscribe_writes();

drop trigger if exists organizer_marketing_unsubscribes_00_m0_guard on public.organizer_marketing_unsubscribes;
create trigger organizer_marketing_unsubscribes_00_m0_guard
  before update or delete on public.organizer_marketing_unsubscribes
  for each row execute function public._mkt_guard_unsubscribe_writes();

drop trigger if exists marketing_campaign_recipients_00_m0_guard on public.marketing_campaign_recipients;
create trigger marketing_campaign_recipients_00_m0_guard
  before insert or update or delete on public.marketing_campaign_recipients
  for each row execute function public._mkt_guard_recipient_writes();

drop trigger if exists organizer_marketing_campaign_recipients_00_m0_guard on public.organizer_marketing_campaign_recipients;
create trigger organizer_marketing_campaign_recipients_00_m0_guard
  before insert or update or delete on public.organizer_marketing_campaign_recipients
  for each row execute function public._mkt_guard_recipient_writes();

drop trigger if exists marketing_campaigns_00_m0_delete_guard on public.marketing_campaigns;
create trigger marketing_campaigns_00_m0_delete_guard
  before delete on public.marketing_campaigns
  for each row execute function public._mkt_guard_campaign_delete();

drop trigger if exists organizer_marketing_campaigns_00_m0_delete_guard on public.organizer_marketing_campaigns;
create trigger organizer_marketing_campaigns_00_m0_delete_guard
  before delete on public.organizer_marketing_campaigns
  for each row execute function public._mkt_guard_campaign_delete();

drop trigger if exists outbound_deliveries_00_m0_content_origin_guard on public.outbound_deliveries;
create trigger outbound_deliveries_00_m0_content_origin_guard
  before insert or update on public.outbound_deliveries
  for each row execute function public._mkt_guard_outbound_content_origin();

drop trigger if exists organizer_contacts_00_m0_unsubscribe_guard on public.organizer_contacts;
create trigger organizer_contacts_00_m0_unsubscribe_guard
  before update on public.organizer_contacts
  for each row execute function public._mkt_guard_contact_unsubscribe();

-- ---------------------------------------------------------------------------------------------------------------
-- 10a. Preconditions (fail closed): this migration only ever narrows recipient / unsubscribe visibility and only
--      replaces the dispatcher claim function it knows. Any other state aborts the whole migration for review.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._mkt_can_view_studio_marketing(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid() and usr.studio_id = p_studio_id and usr.active = true
      and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
  )
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
$$;

do $$
declare
  v_unknown text;
  v_view_recipients integer;
  v_view_unsubscribes integer;
  v_claim text;
begin
  -- Every existing policy on the two studio tables must be a known pre-M-0 policy (exact definition) or an M-0 policy.
  select string_agg(p.tablename || '.' || p.policyname, ', ') into v_unknown
  from pg_policies p
  where p.schemaname = 'public' and p.tablename in ('marketing_campaign_recipients', 'marketing_unsubscribes')
    and p.policyname not like 'm0 %'
    and (p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || md5(coalesce(p.qual, '')) || '|' || md5(coalesce(p.with_check, ''))) not in (
      'marketing_campaign_recipients|studio members can view marketing campaign recipients|SELECT|PERMISSIVE|f50ff73df5a6762543cf9fd384c8a549|d41d8cd98f00b204e9800998ecf8427e',
      'marketing_campaign_recipients|studio staff manage marketing campaign recipients|ALL|PERMISSIVE|10f040ae00f1673e9695bfd71f92d962|10f040ae00f1673e9695bfd71f92d962',
      'marketing_unsubscribes|studio members can view marketing unsubscribes|SELECT|PERMISSIVE|f50ff73df5a6762543cf9fd384c8a549|d41d8cd98f00b204e9800998ecf8427e',
      'marketing_unsubscribes|studio staff manage marketing unsubscribes|ALL|PERMISSIVE|e98c38e5f4794f0e03401202a506ce73|e98c38e5f4794f0e03401202a506ce73'
    );
  if v_unknown is not null then
    raise exception 'M-0 precondition failed: unexpected marketing policies (%); review before applying', v_unknown
      using errcode = '55000';
  end if;

  -- A visibility policy must already exist (pre-M-0 or M-0): creating one where none existed would grant new access.
  select count(*) into v_view_recipients from pg_policies
  where schemaname = 'public' and tablename = 'marketing_campaign_recipients'
    and policyname in ('studio members can view marketing campaign recipients', 'm0 marketing managers can view campaign recipients');
  select count(*) into v_view_unsubscribes from pg_policies
  where schemaname = 'public' and tablename = 'marketing_unsubscribes'
    and policyname in ('studio members can view marketing unsubscribes', 'm0 marketing managers can view unsubscribes');
  if v_view_recipients = 0 or v_view_unsubscribes = 0 then
    raise exception 'M-0 precondition failed: missing recipient/unsubscribe visibility policy; review before applying'
      using errcode = '55000';
  end if;

  -- The dispatcher claim function must be the PAY-WH-1 version (or this migration's own version on a re-apply).
  select replace(prosrc, E'\r\n', E'\n') into v_claim
  from pg_proc where oid = to_regprocedure('public.claim_outbound_deliveries(uuid,integer,integer)');
  if v_claim is null or (md5(v_claim) <> 'd3179a2f46f603111b1bad5293ae6857' and position('marketing_send_frozen' in v_claim) = 0) then
    raise exception 'M-0 precondition failed: claim_outbound_deliveries is missing or not the expected version; review before applying'
      using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 10. Row-level security
-- ---------------------------------------------------------------------------------------------------------------

-- Studio marketing policies existed only in the database (the foundation migration created none). They are captured
-- here with their live definitions so the repository is the source of truth; the unsubscribe "manage" policy is not
-- recreated: unsubscribe records are written only by marketing_unsubscribe_by_token.
drop policy if exists "studio members can view marketing campaigns" on public.marketing_campaigns;
create policy "studio members can view marketing campaigns" on public.marketing_campaigns
  for select using (public.user_has_studio_access(studio_id));
drop policy if exists "studio staff manage marketing campaigns" on public.marketing_campaigns;
create policy "studio staff manage marketing campaigns" on public.marketing_campaigns
  for all
  using (exists (select 1 from public.user_studio_roles usr
                 where usr.user_id = auth.uid() and usr.studio_id = marketing_campaigns.studio_id
                   and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                   and usr.active = true))
  with check (exists (select 1 from public.user_studio_roles usr
                      where usr.user_id = auth.uid() and usr.studio_id = marketing_campaigns.studio_id
                        and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                        and usr.active = true));

-- B (recipient privacy): recipient and unsubscribe rows (addresses, names, unsubscribe tokens) are visible only to the
-- roles that may manage campaigns -- the same set as canViewCommunications (platform admin, studio owner, studio admin,
-- front desk). Instructors and any client-role account are excluded (FC-1B5D). See section 10a for the precondition
-- that guarantees this migration never broadens what an existing database allows.
drop policy if exists "studio members can view marketing campaign recipients" on public.marketing_campaign_recipients;
drop policy if exists "m0 marketing managers can view campaign recipients" on public.marketing_campaign_recipients;
create policy "m0 marketing managers can view campaign recipients" on public.marketing_campaign_recipients
  for select to authenticated using (public._mkt_can_view_studio_marketing(studio_id));
drop policy if exists "studio staff manage marketing campaign recipients" on public.marketing_campaign_recipients;
create policy "studio staff manage marketing campaign recipients" on public.marketing_campaign_recipients
  for all
  using (exists (select 1 from public.user_studio_roles usr
                 where usr.user_id = auth.uid() and usr.studio_id = marketing_campaign_recipients.studio_id
                   and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                   and usr.active = true))
  with check (exists (select 1 from public.user_studio_roles usr
                      where usr.user_id = auth.uid() and usr.studio_id = marketing_campaign_recipients.studio_id
                        and usr.role = any (array['platform_admin'::app_role, 'studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
                        and usr.active = true));

drop policy if exists "studio members can view marketing unsubscribes" on public.marketing_unsubscribes;
drop policy if exists "m0 marketing managers can view unsubscribes" on public.marketing_unsubscribes;
create policy "m0 marketing managers can view unsubscribes" on public.marketing_unsubscribes
  for select to authenticated using (public._mkt_can_view_studio_marketing(studio_id));
drop policy if exists "studio staff manage marketing unsubscribes" on public.marketing_unsubscribes;

drop policy if exists "Organizer users can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
drop policy if exists "Platform admins can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;

revoke insert, update, delete, truncate on public.marketing_unsubscribes from anon, authenticated;
revoke insert, update, delete, truncate on public.organizer_marketing_unsubscribes from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 12. Freeze enforcement for the pre-M-0 application and for the outbound dispatcher (section 4b)
-- ---------------------------------------------------------------------------------------------------------------
-- Restrictive policies: while frozen, client roles cannot see pending recipients nor write any recipient row.
do $$
declare
  t text;
begin
  foreach t in array array['marketing_campaign_recipients', 'organizer_marketing_campaign_recipients'] loop
    execute format('drop policy if exists "m0 freeze hides pending recipients" on public.%I', t);
    execute format('create policy "m0 freeze hides pending recipients" on public.%I as restrictive for select to anon, authenticated '
                   'using (not public.marketing_send_frozen() or status <> %L)', t, 'pending');
    execute format('drop policy if exists "m0 freeze blocks recipient inserts" on public.%I', t);
    execute format('create policy "m0 freeze blocks recipient inserts" on public.%I as restrictive for insert to anon, authenticated '
                   'with check (not public.marketing_send_frozen())', t);
    execute format('drop policy if exists "m0 freeze blocks recipient updates" on public.%I', t);
    execute format('create policy "m0 freeze blocks recipient updates" on public.%I as restrictive for update to anon, authenticated '
                   'using (not public.marketing_send_frozen()) with check (not public.marketing_send_frozen())', t);
    execute format('drop policy if exists "m0 freeze blocks recipient deletes" on public.%I', t);
    execute format('create policy "m0 freeze blocks recipient deletes" on public.%I as restrictive for delete to anon, authenticated '
                   'using (not public.marketing_send_frozen())', t);
  end loop;
end;
$$;

-- The PAY-WH-1 dispatcher claim, unchanged except that commercial ARIA / automation email stays queued while frozen
-- (both application versions dispatch through this function).
create or replace function public.claim_outbound_deliveries(
  p_owner uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns setof public.outbound_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_owner is null then
    raise exception 'claim_outbound_deliveries: owner is required' using errcode = '22023';
  end if;

  return query
  with due as (
    select d.id
    from public.outbound_deliveries d
    where d.status = 'queued'
      and (d.claim_owner is null or d.claim_expires_at <= now())
      -- Marketing M-0: commercial email is held (not dropped) while marketing sends are frozen.
      and not (public.marketing_send_frozen() and public._mkt_is_commercial_outbound(d.channel, d.template_key, d.payload))
    order by d.created_at
    limit least(greatest(coalesce(p_limit, 25), 1), 200)
    for update skip locked
  )
  update public.outbound_deliveries d
  set claim_owner = p_owner,
      claim_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 1800))
  from due
  where d.id = due.id
  returning d.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 13. Legacy organizer unsubscribe page compatibility (C1 while the pre-M-0 application is live, and after rollback)
-- ---------------------------------------------------------------------------------------------------------------
-- The pre-M-0 organizer page marks the recipient row (service role) but its organizer-level upsert fails. This trigger
-- records the opt-out through the same idempotent, token-scoped function the M-0 endpoint uses. It fires only for that
-- page's exact signature; the token resolves to this row's own organizer, so it cannot affect another tenant.
create or replace function public._mkt_persist_legacy_organizer_unsubscribe()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.unsubscribe_token is not null then
    perform public.marketing_unsubscribe_by_token(new.unsubscribe_token::text, 'legacy_page');
  end if;
  return new;
end;
$$;

drop trigger if exists organizer_marketing_campaign_recipients_10_m0_legacy_unsubscribe on public.organizer_marketing_campaign_recipients;
create trigger organizer_marketing_campaign_recipients_10_m0_legacy_unsubscribe
  after update of status, error_message on public.organizer_marketing_campaign_recipients
  for each row
  when (new.status = 'unsubscribed' and new.error_message = 'Recipient unsubscribed from organizer marketing')
  execute function public._mkt_persist_legacy_organizer_unsubscribe();

-- ---------------------------------------------------------------------------------------------------------------
-- 14. Outbound deliveries written by client roles (D)
-- ---------------------------------------------------------------------------------------------------------------
-- The dispatcher sends a queued row as stored (subject/body when present), so a signed-in user who can insert rows could
-- forge operational or DanceFlow notifications, send arbitrary content through the transactional sender, or reach
-- arbitrary addresses. The M-0 application writes every delivery with the service role. Until stage 2 removes client
-- inserts entirely, client-role inserts are limited to what the pre-M-0 application legitimately produces:
--  * appointment notifications (appointment_confirmed / _rescheduled / _cancelled) for an appointment of the row's
--    studio, addressed to that appointment's client or partner; subject/body/reply-to are cleared so the dispatcher
--    renders the fixed appointment template;
--  * legacy automation emails (automation_*) for an automation action of the row's studio; their content origin is
--    forced to studio_customized (section 9) so the M-0 dispatcher applies every marketing control.
-- Anything else (DanceFlow/platform keys, ARIA executions, digests, booking/portal/event keys, unknown keys) is refused.
-- Updates by client roles (platform admins, by RLS) cannot re-route a row.
create or replace function public._mkt_outbound_appointment_recipient_ok(
  p_studio_id uuid,
  p_appointment_id uuid,
  p_channel text,
  p_email text,
  p_phone text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.appointments a
    join public.clients c on c.id in (a.client_id, a.partner_client_id) and c.studio_id = a.studio_id
    where a.id = p_appointment_id and a.studio_id = p_studio_id
      and (
        (p_channel = 'email' and p_email is not null and lower(btrim(c.email)) = lower(btrim(p_email)))
        or (p_channel = 'sms' and length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
            and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
      )
  )
  and (
    exists (select 1 from public.user_studio_roles usr where usr.user_id = auth.uid() and usr.studio_id = p_studio_id and usr.active = true)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
  )
$$;

create or replace function public._mkt_outbound_automation_action_ok(p_studio_id uuid, p_action_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.automation_actions aa where aa.id = p_action_id and aa.studio_id = p_studio_id)
  and (
    exists (select 1 from public.user_studio_roles usr where usr.user_id = auth.uid() and usr.studio_id = p_studio_id and usr.active = true)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin')
  )
$$;

create or replace function public._mkt_guard_outbound_client_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.studio_id is distinct from old.studio_id or new.channel is distinct from old.channel
       or new.template_key is distinct from old.template_key or new.recipient_email is distinct from old.recipient_email
       or new.recipient_phone is distinct from old.recipient_phone or new.related_table is distinct from old.related_table
       or new.related_id is distinct from old.related_id then
      raise exception 'A queued notification cannot be re-routed.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.template_key in ('appointment_confirmed', 'appointment_rescheduled', 'appointment_cancelled') then
    if new.channel not in ('email', 'sms') or new.related_table is distinct from 'appointments' or new.related_id is null
       or not public._mkt_outbound_appointment_recipient_ok(new.studio_id, new.related_id, new.channel, new.recipient_email, new.recipient_phone) then
      raise exception 'Appointment notifications can only be sent to that appointment''s participants.' using errcode = '42501';
    end if;
    new.subject := null;
    new.body_text := null;
    new.body_html := null;
    new.reply_to_email := null;
    return new;
  end if;

  if starts_with(coalesce(new.template_key, ''), 'automation_') and new.channel = 'email'
     and new.related_table = 'automation_actions' and new.related_id is not null
     and public._mkt_outbound_automation_action_ok(new.studio_id, new.related_id) then
    return new;
  end if;

  raise exception 'This notification type cannot be created by a signed-in user.' using errcode = '42501';
end;
$$;

drop trigger if exists outbound_deliveries_01_m0_client_write_guard on public.outbound_deliveries;
create trigger outbound_deliveries_01_m0_client_write_guard
  before insert or update on public.outbound_deliveries
  for each row execute function public._mkt_guard_outbound_client_writes();

-- ---------------------------------------------------------------------------------------------------------------
-- 11. Function privileges: service role only (the unsubscribe endpoint and the send pipeline run server-side)
-- ---------------------------------------------------------------------------------------------------------------

-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated, so every revoke names them.
revoke all on function public._mkt_norm_email(text) from public, anon, authenticated;
revoke all on function public._mkt_lock_email(text) from public, anon, authenticated;
revoke all on function public._mkt_guard_unsubscribe_writes() from public, anon, authenticated;
revoke all on function public._mkt_guard_recipient_writes() from public, anon, authenticated;
revoke all on function public._mkt_guard_contact_unsubscribe() from public, anon, authenticated;
revoke all on function public._mkt_suppression_status(text, uuid, text) from public, anon, authenticated;
revoke all on function public._mkt_campaign_exists(text, uuid) from public, anon, authenticated;
revoke all on function public._mkt_campaign_has_mailed(text, uuid) from public, anon, authenticated;
revoke all on function public._mkt_guard_campaign_delete() from public, anon, authenticated;
revoke all on function public._mkt_guard_outbound_content_origin() from public, anon, authenticated;
revoke all on function public.marketing_suppression_status(text, uuid, text) from public, anon, authenticated;
revoke all on function public.marketing_sync_campaign_recipients(text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.marketing_claim_campaign_recipient(text, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.marketing_complete_campaign_recipient(text, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.marketing_issue_message_unsubscribe_token(text, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.marketing_unsubscribe_by_token(text, text) from public, anon, authenticated;
revoke all on function public.marketing_authorize_test_send(text, uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.marketing_send_frozen() from public, anon, authenticated;
revoke all on function public.marketing_set_send_freeze(boolean, text) from public, anon, authenticated;
revoke all on function public._mkt_is_commercial_outbound(text, text, jsonb) from public, anon, authenticated;
revoke all on function public._mkt_can_view_studio_marketing(uuid) from public, anon, authenticated;
revoke all on function public._mkt_persist_legacy_organizer_unsubscribe() from public, anon, authenticated;
revoke all on function public._mkt_outbound_appointment_recipient_ok(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public._mkt_outbound_automation_action_ok(uuid, uuid) from public, anon, authenticated;
revoke all on function public._mkt_guard_outbound_client_writes() from public, anon, authenticated;

grant execute on function public._mkt_norm_email(text) to service_role;
-- The recipient guard runs as the calling client role (that is how it recognises one) and needs this lookup; it reveals
-- only whether a campaign id exists.
grant execute on function public._mkt_campaign_exists(text, uuid) to anon, authenticated;
-- Same for the campaign delete guard; it reveals only whether a campaign the caller is deleting was mailed.
grant execute on function public._mkt_campaign_has_mailed(text, uuid) to anon, authenticated;
grant execute on function public.marketing_suppression_status(text, uuid, text) to service_role;
grant execute on function public.marketing_sync_campaign_recipients(text, uuid, uuid, jsonb) to service_role;
grant execute on function public.marketing_claim_campaign_recipient(text, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.marketing_complete_campaign_recipient(text, uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.marketing_issue_message_unsubscribe_token(text, uuid, text, text, uuid) to service_role;
grant execute on function public.marketing_unsubscribe_by_token(text, text) to service_role;
grant execute on function public.marketing_authorize_test_send(text, uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.marketing_set_send_freeze(boolean, text) to service_role;
grant execute on function public._mkt_is_commercial_outbound(text, text, jsonb) to service_role;
-- Evaluated inside client-role RLS policies / invoker triggers; each reveals only a boolean about the caller's own access
-- (freeze state, own marketing visibility, own appointment/automation rows).
grant execute on function public.marketing_send_frozen() to anon, authenticated, service_role;
grant execute on function public._mkt_can_view_studio_marketing(uuid) to authenticated;
grant execute on function public._mkt_outbound_appointment_recipient_ok(uuid, uuid, text, text, text) to authenticated;
grant execute on function public._mkt_outbound_automation_action_ok(uuid, uuid) to authenticated;

-- unsubscribe_marketing_recipient(text) keeps its existing anon/authenticated grants in stage 1 (old application).

commit;
