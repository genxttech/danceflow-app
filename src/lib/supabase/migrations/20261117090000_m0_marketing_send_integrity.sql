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

-- The pre-M-0 studio page RPC (still called by the currently deployed application) now goes through the same function,
-- so it records the unsubscribe the same way and also suppresses the address's other pending campaign rows.
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
  if not exists (select 1 from public.marketing_campaign_recipients r where r.unsubscribe_token = p_token) then
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
-- such a row can never claim that: it is forced to "customized", which the dispatcher classifies as commercial
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
    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('content_origin', 'customized');
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

drop policy if exists "studio members can view marketing campaign recipients" on public.marketing_campaign_recipients;
create policy "studio members can view marketing campaign recipients" on public.marketing_campaign_recipients
  for select using (public.user_has_studio_access(studio_id));
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
create policy "studio members can view marketing unsubscribes" on public.marketing_unsubscribes
  for select using (public.user_has_studio_access(studio_id));
drop policy if exists "studio staff manage marketing unsubscribes" on public.marketing_unsubscribes;

drop policy if exists "Organizer users can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
drop policy if exists "Platform admins can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;

revoke insert, update, delete, truncate on public.marketing_unsubscribes from anon, authenticated;
revoke insert, update, delete, truncate on public.organizer_marketing_unsubscribes from anon, authenticated;

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

-- unsubscribe_marketing_recipient(text) keeps its existing anon/authenticated grants in stage 1 (old application).

commit;
