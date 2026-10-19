-- 20261122090000_twilio_tw4f3b0_prepaid_credits.sql
-- TW-4F-3b-0 (prepaid SMS credits are the billing model for every studio). DanceFlow's parent Twilio account is billed centrally; each STUDIO funds its
-- own registration, number, vetting, recurring and messaging costs through DanceFlow. Subaccount isolation is NOT billing isolation.
-- NO Twilio call and NO Stripe call is made by anything in this file. Service-role only, except the three read functions for studio managers.
--   studio_sms_price_list            published customer prices per kind (one active price per kind); authorizations must match it
--   studio_sms_credit_accounts       one per studio: settled balance, open reservations, hold, low-balance threshold (counters maintained ONLY by the functions below)
--   studio_sms_credit_ledger         append-only, per-studio sequence, idempotency key per entry; balance and reserved are the SUM of its deltas (tw4_credit_verify)
--   studio_sms_credit_reservations   a hold for ONE fee-bearing operation; captured (charged) or released; never both
--   studio_sms_credit_topups         funding payments (Stripe): pending until SETTLED; only a settled payment becomes spendable credit
--   studio_sms_provider_charges      actual Twilio charges recorded for reconciliation (variance flagged, the customer is never re-debited for a variance)
-- Replaces (create or replace) tw4_entity_create_for_studio (records the funding studio), tw4_spend_authorize (needs a published price) and
-- tw4_spend_reserve (also reserves the funding studio's credit, atomically); adds tw4_spend_settle. The spend cap and the per-operation owner
-- authorization of TW-4F-3a stay in force: credit is the means of payment, never the permission to spend.
-- Rollback: rollback/20261122090000_twilio_tw4f3b0_prepaid_credits_rollback.sql (application first; refuses once any credit evidence exists).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_spend_events') is null or to_regclass('public.studio_sms_legal_entities') is null then
    raise exception 'TW-4F-3b-0 precondition failed: TW-4F-3a is not applied';
  end if;
  if to_regclass('public.studio_sms_credit_accounts') is not null then
    raise exception 'TW-4F-3b-0 precondition failed: already applied';
  end if;
  if exists (select 1 from public.studio_sms_spend_events where status = 'reserved') then
    raise exception 'TW-4F-3b-0 precondition failed: reserved 3a spend events exist (no credit reservation to bind); resolve them first';
  end if;
end $$;

alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action in (
  'access_enabled', 'access_disabled', 'draft_created', 'ein_stored', 'ein_purged', 'submitted', 'cancelled', 'state_changed',
  'runner_step', 'runner_ein_read', 'runner_lease', 'runner_window', 'runner_submission_confirmed', 'runner_evaluation',
  'entity_created', 'location_attested', 'location_decided', 'spend_cap_set', 'spend_authorized', 'spend_reserved',
  'subaccount_confirmed', 'runner_subaccount',
  'credit_topup', 'credit_reversal', 'credit_adjustment', 'credit_hold', 'credit_reserved', 'credit_captured', 'credit_released', 'price_set'));

-- ---------------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_price_list (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage')),
  customer_price_cents int not null check (customer_price_cents > 0),
  provider_cost_cents int not null check (provider_cost_cents >= 0),  -- DanceFlow's expected Twilio cost (internal, never shown to studios)
  description text not null check (char_length(btrim(description)) between 3 and 200),
  active boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create unique index studio_sms_price_list_one_active on public.studio_sms_price_list (kind) where active;

create table public.studio_sms_credit_accounts (
  studio_id uuid primary key references public.studios(id) on delete restrict,
  balance_cents bigint not null default 0,
  reserved_cents bigint not null default 0 check (reserved_cents >= 0),
  hold boolean not null default false,
  hold_reason text null check (hold_reason is null or char_length(hold_reason) <= 300),
  low_balance_threshold_cents int not null default 0 check (low_balance_threshold_cents >= 0),
  low_balance_flagged_at timestamptz null,
  created_at timestamptz not null default now()
);

create table public.studio_sms_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  kind text not null check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage')),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'reserved' check (status in ('reserved', 'captured', 'released')),
  reservation_key text not null check (char_length(reservation_key) <= 160),
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint studio_sms_credit_reservations_closed check ((status = 'reserved') = (closed_at is null)),
  constraint studio_sms_credit_reservations_key unique (studio_id, reservation_key)
);

create table public.studio_sms_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  seq bigint not null check (seq > 0),
  kind text not null check (kind in ('topup_settled', 'topup_reversed', 'reserve', 'release', 'capture', 'usage_charge', 'usage_refund', 'adjustment')),
  balance_delta_cents bigint not null,
  reserved_delta_cents bigint not null default 0,
  idempotency_key text not null check (char_length(idempotency_key) between 3 and 200),
  reservation_id uuid null references public.studio_sms_credit_reservations(id),
  ref text null check (ref is null or char_length(ref) <= 200),
  actor uuid null,
  note text null check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  constraint studio_sms_credit_ledger_seq unique (studio_id, seq),
  constraint studio_sms_credit_ledger_key unique (studio_id, idempotency_key),
  -- each kind moves money in exactly one pattern
  constraint studio_sms_credit_ledger_shape check (
    case kind
      when 'topup_settled' then balance_delta_cents > 0 and reserved_delta_cents = 0
      when 'topup_reversed' then balance_delta_cents < 0 and reserved_delta_cents = 0
      when 'reserve' then balance_delta_cents = 0 and reserved_delta_cents > 0
      when 'release' then balance_delta_cents = 0 and reserved_delta_cents < 0
      when 'capture' then balance_delta_cents < 0 and reserved_delta_cents = balance_delta_cents
      when 'usage_charge' then balance_delta_cents < 0 and reserved_delta_cents = 0
      when 'usage_refund' then balance_delta_cents > 0 and reserved_delta_cents = 0
      else balance_delta_cents <> 0 and reserved_delta_cents = 0
    end)
);

create table public.studio_sms_credit_topups (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  provider text not null check (provider in ('stripe')),
  provider_ref text not null check (char_length(provider_ref) between 3 and 200),   -- the payment intent / checkout session the money came through
  amount_cents int not null check (amount_cents > 0),
  reversed_cents int not null default 0 check (reversed_cents >= 0),
  status text not null default 'pending' check (status in ('pending', 'settled', 'failed')),
  created_at timestamptz not null default now(),
  settled_at timestamptz null,
  constraint studio_sms_credit_topups_ref unique (provider, provider_ref),
  constraint studio_sms_credit_topups_reversal check (reversed_cents <= amount_cents),
  constraint studio_sms_credit_topups_settled check ((status = 'settled') = (settled_at is not null))
);

create table public.studio_sms_provider_charges (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  kind text not null check (kind in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage')),
  provider_ref text not null check (char_length(provider_ref) between 3 and 200),
  provider_cost_cents int not null check (provider_cost_cents >= 0),
  expected_cost_cents int null check (expected_cost_cents is null or expected_cost_cents >= 0),
  variance_cents int null,
  status text not null check (status in ('matched', 'variance')),
  created_at timestamptz not null default now(),
  constraint studio_sms_provider_charges_ref unique (kind, provider_ref)
);

revoke all on public.studio_sms_price_list, public.studio_sms_credit_accounts, public.studio_sms_credit_reservations, public.studio_sms_credit_ledger,
  public.studio_sms_credit_topups, public.studio_sms_provider_charges from public, anon, authenticated, service_role;
alter table public.studio_sms_price_list enable row level security;
alter table public.studio_sms_credit_accounts enable row level security;
alter table public.studio_sms_credit_reservations enable row level security;
alter table public.studio_sms_credit_ledger enable row level security;
alter table public.studio_sms_credit_topups enable row level security;
alter table public.studio_sms_provider_charges enable row level security;

-- the entity's funding studio (registration, campaign vetting, number and recurring fees are debited from ITS credit)
alter table public.studio_sms_legal_entities add column funding_studio_id uuid null references public.studios(id) on delete restrict;
update public.studio_sms_legal_entities e set funding_studio_id = (select es.studio_id from public.studio_sms_entity_studios es where es.legal_entity_id = e.id order by es.linked_at limit 1);

-- a spend authorization now remembers its credit reservation; 'void' is a released authorization
alter table public.studio_sms_spend_events drop constraint studio_sms_spend_events_reserved;
alter table public.studio_sms_spend_events add column credit_reservation_id uuid null references public.studio_sms_credit_reservations(id);
alter table public.studio_sms_spend_events add constraint studio_sms_spend_events_reserved check (
  (status = 'authorized' and reservation_key is null and reserved_at is null and credit_reservation_id is null)
  or (status = 'reserved' and reservation_key is not null and reserved_at is not null and credit_reservation_id is not null)
  or status = 'void');

-- ---------------------------------------------------------------------------------------------------------------
-- the append-only guards (no edit, no delete, no truncate; the price list only flips `active` off)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4c_immutable_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_table_name = 'studio_sms_price_list' and tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.kind is distinct from old.kind or new.customer_price_cents is distinct from old.customer_price_cents
       or new.provider_cost_cents is distinct from old.provider_cost_cents or new.description is distinct from old.description or new.created_at is distinct from old.created_at
       or (old.active = false and new.active = true) then
      raise exception 'a published price is never edited: retire it and publish a new one' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_reservations' and tg_op = 'UPDATE' then
    if old.status <> 'reserved' or new.studio_id is distinct from old.studio_id or new.kind is distinct from old.kind or new.amount_cents is distinct from old.amount_cents
       or new.reservation_key is distinct from old.reservation_key or new.created_at is distinct from old.created_at or new.status = 'reserved' then
      raise exception 'a closed reservation is final' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_topups' and tg_op = 'UPDATE' then
    if new.studio_id is distinct from old.studio_id or new.provider is distinct from old.provider or new.provider_ref is distinct from old.provider_ref
       or new.amount_cents is distinct from old.amount_cents or new.created_at is distinct from old.created_at
       or new.reversed_cents < old.reversed_cents or (old.status <> 'pending' and new.status is distinct from old.status) then
      raise exception 'a funding payment is not edited' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_table_name = 'studio_sms_credit_accounts' and tg_op = 'UPDATE' then
    if new.studio_id is distinct from old.studio_id or new.created_at is distinct from old.created_at then
      raise exception 'a credit account is not re-assigned' using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end $$;
create trigger studio_sms_credit_ledger_guard before update or delete on public.studio_sms_credit_ledger for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_provider_charges_guard before update or delete on public.studio_sms_provider_charges for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_credit_reservations_guard before update or delete on public.studio_sms_credit_reservations for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_credit_topups_guard before update or delete on public.studio_sms_credit_topups for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_credit_accounts_guard before update or delete on public.studio_sms_credit_accounts for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_price_list_guard before update or delete on public.studio_sms_price_list for each row execute function public._tw4c_immutable_guard();
create or replace function public._tw4c_truncate_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'credit evidence is never truncated' using errcode = '42501'; end $$;
create trigger studio_sms_credit_ledger_truncate before truncate on public.studio_sms_credit_ledger for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_credit_topups_truncate before truncate on public.studio_sms_credit_topups for each statement execute function public._tw4c_truncate_guard();
create trigger studio_sms_credit_reservations_truncate before truncate on public.studio_sms_credit_reservations for each statement execute function public._tw4c_truncate_guard();

-- the spend-event guard (3a) now also allows `reserved -> void` while a credit settlement function is running (and nothing else)
create or replace function public._tw4f3a_evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'studio_sms_entity_studios' or tg_table_name = 'studio_sms_location_requests' then
      if not exists (select 1 from public.studios s where s.id = old.studio_id) then return old; end if;
    end if;
    raise exception '% rows are not deleted', tg_table_name using errcode = '42501';
  end if;
  if tg_table_name = 'studio_sms_subaccount_confirmations' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.confirmed_by is distinct from old.confirmed_by
       or new.confirmed_at is distinct from old.confirmed_at or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at) then
      raise exception 'a subaccount confirmation can only be consumed, once' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_entity_studios' then
    raise exception 'a location link is not edited' using errcode = '42501';
  elsif tg_table_name = 'studio_sms_twilio_accounts' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.created_by is distinct from old.created_by
       or (old.twilio_account_sid is not null and new.twilio_account_sid is distinct from old.twilio_account_sid) then
      raise exception 'the subaccount sid is final' using errcode = '42501';
    end if;
  elsif tg_table_name = 'studio_sms_spend_events' then
    if new.legal_entity_id is distinct from old.legal_entity_id or new.kind is distinct from old.kind
       or new.amount_cents is distinct from old.amount_cents or new.approval_ref is distinct from old.approval_ref or new.authorized_by is distinct from old.authorized_by
       or old.status = 'void' then
      raise exception 'a spend authorization cannot be edited; a released one is final' using errcode = '42501';
    end if;
    if old.status = 'authorized' and new.status not in ('authorized', 'reserved') and not (new.status = 'void' and coalesce(current_setting('tw4.credit_settle', true), '') = 'on') then
      raise exception 'an authorization is only withdrawn by its withdraw function' using errcode = '42501';
    end if;
    if old.status = 'reserved' and (new.reservation_key is distinct from old.reservation_key or new.reserved_at is distinct from old.reserved_at
         or new.credit_reservation_id is distinct from old.credit_reservation_id
         or (new.status is distinct from old.status and not (new.status = 'void' and coalesce(current_setting('tw4.credit_settle', true), '') = 'on'))) then
      raise exception 'a reserved authorization is final (it is only released by its credit settlement)' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- internal ledger primitive: caller holds the account row lock
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public._tw4c_lock(p_studio uuid)
returns public.studio_sms_credit_accounts language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare a public.studio_sms_credit_accounts;
begin
  if p_studio is null or not exists (select 1 from public.studios s where s.id = p_studio) then
    raise exception 'unknown studio' using errcode = '22023';
  end if;
  insert into public.studio_sms_credit_accounts (studio_id) values (p_studio) on conflict (studio_id) do nothing;
  select * into a from public.studio_sms_credit_accounts x where x.studio_id = p_studio for update;
  return a;
end $$;

-- posts one entry; returns (entry id, replayed). A repeated idempotency key returns the original entry and changes nothing.
create or replace function public._tw4c_post(p_studio uuid, p_kind text, p_bdelta bigint, p_rdelta bigint, p_key text, p_reservation uuid, p_ref text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_old public.studio_sms_credit_ledger;
  v_seq bigint;
  v_id uuid;
begin
  a := public._tw4c_lock(p_studio);
  select * into v_old from public.studio_sms_credit_ledger l where l.studio_id = p_studio and l.idempotency_key = p_key;
  if v_old.id is not null then
    if v_old.kind <> p_kind or v_old.balance_delta_cents <> p_bdelta or v_old.reserved_delta_cents <> p_rdelta then
      raise exception 'idempotency key reused for a different entry' using errcode = '23505';
    end if;
    return jsonb_build_object('entry_id', v_old.id, 'replayed', true);
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.studio_sms_credit_ledger where studio_id = p_studio;
  insert into public.studio_sms_credit_ledger (studio_id, seq, kind, balance_delta_cents, reserved_delta_cents, idempotency_key, reservation_id, ref, actor, note)
  values (p_studio, v_seq, p_kind, p_bdelta, p_rdelta, p_key, p_reservation, left(p_ref, 200), p_actor, left(p_note, 300)) returning id into v_id;
  update public.studio_sms_credit_accounts
     set balance_cents = balance_cents + p_bdelta, reserved_cents = reserved_cents + p_rdelta
   where studio_id = p_studio;
  -- low-balance flag (set once per dip, cleared when the available balance recovers)
  update public.studio_sms_credit_accounts x
     set low_balance_flagged_at = case
       when x.low_balance_threshold_cents > 0 and (x.balance_cents - x.reserved_cents) < x.low_balance_threshold_cents then coalesce(x.low_balance_flagged_at, now())
       else null end
   where x.studio_id = p_studio;
  return jsonb_build_object('entry_id', v_id, 'replayed', false);
end $$;

create or replace function public._tw4c_admin(p_actor uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
end $$;

-- spendable = settled balance minus open reservations, and only while the account is not on hold and not negative
create or replace function public._tw4c_require_funds(a public.studio_sms_credit_accounts, p_cents bigint)
returns void language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if a.hold then
    raise exception 'the credit account is on hold' using errcode = 'TW007';
  end if;
  if a.balance_cents < 0 or (a.balance_cents - a.reserved_cents) < p_cents then
    raise exception 'insufficient settled credit' using errcode = 'TW007';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- prices
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_price_set(p_kind text, p_customer_cents int, p_provider_cents int, p_description text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  perform public._tw4c_admin(p_actor);
  perform pg_advisory_xact_lock(hashtext('tw4_price_set:' || coalesce(p_kind, '')));
  update public.studio_sms_price_list set active = false where kind = p_kind and active;
  insert into public.studio_sms_price_list (kind, customer_price_cents, provider_cost_cents, description, created_by)
  values (p_kind, p_customer_cents, p_provider_cents, p_description, p_actor) returning id into v_id;
  return jsonb_build_object('price_id', v_id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- funding: only a SETTLED payment becomes credit. Replays of the same provider event or payment change nothing.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_topup_pending(p_studio_id uuid, p_provider_ref text, p_amount_cents int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare t public.studio_sms_credit_topups;
begin
  perform public._tw4c_lock(p_studio_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if t.id is null then
    insert into public.studio_sms_credit_topups (studio_id, provider, provider_ref, amount_cents) values (p_studio_id, 'stripe', p_provider_ref, p_amount_cents) returning * into t;
  elsif t.studio_id <> p_studio_id or t.amount_cents <> p_amount_cents then
    raise exception 'this payment belongs to another studio or amount' using errcode = '23505';
  end if;
  return jsonb_build_object('topup_id', t.id, 'status', t.status);
end $$;

create or replace function public.tw4_credit_settle_topup(p_studio_id uuid, p_provider_ref text, p_amount_cents int, p_event_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  r jsonb;
begin
  perform public._tw4c_lock(p_studio_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref for update;
  if t.id is null then
    insert into public.studio_sms_credit_topups (studio_id, provider, provider_ref, amount_cents) values (p_studio_id, 'stripe', p_provider_ref, p_amount_cents) returning * into t;
  elsif t.studio_id <> p_studio_id or t.amount_cents <> p_amount_cents then
    raise exception 'this payment belongs to another studio or amount' using errcode = '23505';
  end if;
  r := public._tw4c_post(p_studio_id, 'topup_settled', p_amount_cents, 0, 'topup:' || p_provider_ref, null, p_provider_ref, null, 'event=' || coalesce(p_event_id, ''));
  if t.status <> 'settled' then
    update public.studio_sms_credit_topups set status = 'settled', settled_at = now() where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (p_studio_id, null, 'system', null, 'credit_topup', left('cents=' || p_amount_cents || ';ref=' || p_provider_ref, 300));
  end if;
  return r;
end $$;

-- a refund or a lost dispute takes credit back; it may push the balance negative (which blocks all spending until funded again)
create or replace function public.tw4_credit_reverse_topup(p_provider_ref text, p_amount_cents int, p_event_id text, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  r jsonb;
begin
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if p_event_id is null or char_length(btrim(p_event_id)) < 3 then
    raise exception 'a reversal needs the provider event id' using errcode = '22023';
  end if;
  if t.id is null or t.status <> 'settled' or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'no settled payment to reverse' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.studio_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  r := public._tw4c_post(t.studio_id, 'topup_reversed', -p_amount_cents, 0, 'reverse:' || p_provider_ref || ':' || p_event_id, null, p_provider_ref, null, left(coalesce(p_reason, ''), 280));
  if not (r->>'replayed')::boolean then
    if t.reversed_cents + p_amount_cents > t.amount_cents then
      raise exception 'more than the payment was reversed' using errcode = '22023';
    end if;
    update public.studio_sms_credit_topups set reversed_cents = reversed_cents + p_amount_cents where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (t.studio_id, null, 'system', null, 'credit_reversal', left('cents=' || p_amount_cents || ';ref=' || p_provider_ref, 300));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- admin adjustments, hold and threshold
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_adjust(p_studio_id uuid, p_amount_cents bigint, p_key text, p_note text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r jsonb;
begin
  perform public._tw4c_admin(p_actor);
  if p_amount_cents is null or p_amount_cents = 0 or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an adjustment needs an amount and a written reason (10+ characters)' using errcode = '22023';
  end if;
  r := public._tw4c_post(p_studio_id, 'adjustment', p_amount_cents, 0, 'adjust:' || p_key, null, null, p_actor, btrim(p_note));
  if not (r->>'replayed')::boolean then
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (p_studio_id, null, 'platform_admin', p_actor, 'credit_adjustment', left('cents=' || p_amount_cents, 300));
  end if;
  return r;
end $$;

create or replace function public.tw4_credit_set_hold(p_studio_id uuid, p_hold boolean, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4c_lock(p_studio_id);
  if p_hold and (p_reason is null or char_length(btrim(p_reason)) < 5) then
    raise exception 'a hold needs a reason' using errcode = '22023';
  end if;
  update public.studio_sms_credit_accounts set hold = p_hold, hold_reason = case when p_hold then left(btrim(p_reason), 300) else null end where studio_id = p_studio_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (p_studio_id, null, 'platform_admin', p_actor, 'credit_hold', left('hold=' || p_hold, 300));
  return jsonb_build_object('hold', p_hold);
end $$;

create or replace function public.tw4_credit_set_threshold(p_studio_id uuid, p_cents int, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_cents is null or p_cents < 0 then
    raise exception 'invalid threshold' using errcode = '22023';
  end if;
  perform public._tw4c_lock(p_studio_id);
  update public.studio_sms_credit_accounts x
     set low_balance_threshold_cents = p_cents,
         low_balance_flagged_at = case when p_cents > 0 and (x.balance_cents - x.reserved_cents) < p_cents then coalesce(x.low_balance_flagged_at, now()) else null end
   where x.studio_id = p_studio_id;
  return jsonb_build_object('threshold_cents', p_cents);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- messaging usage (no reservation: one atomic debit per message batch, idempotent per key; refunds for failed/undelivered messages)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_debit_usage(p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  r jsonb;
begin
  if p_cents is null or p_cents <= 0 then
    raise exception 'invalid usage amount' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_studio_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low
  if exists (select 1 from public.studio_sms_credit_ledger l where l.studio_id = p_studio_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4c_require_funds(a, p_cents);
  r := public._tw4c_post(p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  return r;
end $$;

create or replace function public.tw4_credit_refund_usage(p_studio_id uuid, p_cents int, p_key text, p_original_key text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_credit_ledger;
  v_done bigint;
begin
  if p_cents is null or p_cents <= 0 then
    raise exception 'invalid refund amount' using errcode = '22023';
  end if;
  perform public._tw4c_lock(p_studio_id);
  -- a refund is always for a recorded usage charge of THIS studio, and never exceeds it
  select * into o from public.studio_sms_credit_ledger l where l.studio_id = p_studio_id and l.idempotency_key = 'usage:' || p_original_key and l.kind = 'usage_charge';
  if o.id is null then
    raise exception 'no such usage charge to refund' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_credit_ledger l where l.studio_id = p_studio_id and l.idempotency_key = 'usage_refund:' || p_key) then
    return public._tw4c_post(p_studio_id, 'usage_refund', p_cents, 0, 'usage_refund:' || p_key, null, 'refund_of:' || p_original_key, null, null);
  end if;
  select coalesce(sum(l.balance_delta_cents), 0) into v_done from public.studio_sms_credit_ledger l where l.studio_id = p_studio_id and l.kind = 'usage_refund' and l.ref = 'refund_of:' || p_original_key;
  if v_done + p_cents > -o.balance_delta_cents then
    raise exception 'refunds would exceed the original usage charge' using errcode = '22023';
  end if;
  return public._tw4c_post(p_studio_id, 'usage_refund', p_cents, 0, 'usage_refund:' || p_key, null, 'refund_of:' || p_original_key, null, null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- reconciliation: an actual Twilio charge, compared with the published expected cost. The customer is never re-debited for a variance.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_record_provider_charge(p_studio_id uuid, p_kind text, p_provider_ref text, p_provider_cost_cents int, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c public.studio_sms_provider_charges;
  p public.studio_sms_price_list;
begin
  perform public._tw4c_admin(p_actor);
  select * into c from public.studio_sms_provider_charges x where x.kind = p_kind and x.provider_ref = p_provider_ref;
  if c.id is not null then
    if c.studio_id <> p_studio_id or c.provider_cost_cents <> p_provider_cost_cents then
      raise exception 'this provider charge was already recorded differently' using errcode = '23505';
    end if;
    return jsonb_build_object('charge_id', c.id, 'status', c.status, 'replayed', true);
  end if;
  select * into p from public.studio_sms_price_list x where x.kind = p_kind and x.active;
  insert into public.studio_sms_provider_charges (studio_id, kind, provider_ref, provider_cost_cents, expected_cost_cents, variance_cents, status)
  values (p_studio_id, p_kind, p_provider_ref, p_provider_cost_cents, p.provider_cost_cents,
          case when p.id is null then null else p_provider_cost_cents - p.provider_cost_cents end,
          case when p.id is not null and p_provider_cost_cents = p.provider_cost_cents then 'matched' else 'variance' end) returning * into c;
  return jsonb_build_object('charge_id', c.id, 'status', c.status, 'replayed', false);
end $$;

create or replace function public.tw4_credit_verify(p_studio_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_b bigint;
  v_r bigint;
  v_open bigint;
begin
  select * into a from public.studio_sms_credit_accounts x where x.studio_id = p_studio_id;
  select coalesce(sum(balance_delta_cents), 0), coalesce(sum(reserved_delta_cents), 0) into v_b, v_r from public.studio_sms_credit_ledger where studio_id = p_studio_id;
  select coalesce(sum(amount_cents), 0) into v_open from public.studio_sms_credit_reservations where studio_id = p_studio_id and status = 'reserved';
  return jsonb_build_object('balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0), 'ledger_balance_cents', v_b, 'ledger_reserved_cents', v_r,
    'open_reservations_cents', v_open, 'ok', coalesce(a.balance_cents, 0) = v_b and coalesce(a.reserved_cents, 0) = v_r and v_r = v_open);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- replaced 3a functions: the founding studio funds the entity; an authorization needs the published price; a reservation also holds credit
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_entity_create_for_studio(p_studio_id uuid, p_actor uuid, p_verification_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  o public.studio_sms_onboarding;
  v_id uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  if exists (select 1 from public.studio_sms_entity_studios where studio_id = p_studio_id) then
    raise exception 'this studio already belongs to a legal entity' using errcode = '23505';
  end if;
  select * into o from public.studio_sms_onboarding x where x.studio_id = p_studio_id and x.state <> 'cancelled' order by x.created_at desc limit 1;
  if o.id is null or o.legal_name is null or o.ein_last4 is null or o.attested_at is null or o.state in ('draft', 'cancelled') then
    raise exception 'the studio has no submitted onboarding with a legal name and EIN' using errcode = '22023';
  end if;
  if exists (select 1 from public.studio_sms_provisioning_steps st where st.studio_id = p_studio_id) then
    raise exception 'the studio has registration steps from before subaccounts; start a fresh setup' using errcode = '22023';
  end if;
  begin
    insert into public.studio_sms_legal_entities (legal_name, ein_last4, created_by, funding_studio_id) values (o.legal_name, o.ein_last4, p_actor, p_studio_id) returning id into v_id;
  exception when unique_violation then
    raise exception 'a legal entity with this name and EIN already exists: link this location to it instead of registering again' using errcode = '23505';
  end;
  insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, supporting_checks)
  values (p_studio_id, v_id, 'founding', p_actor, p_verification_note, jsonb_build_object('from_attested_onboarding', true));
  perform public._tw4f3a_audit(p_studio_id, p_actor, 'entity_created', 'entity=' || v_id);
  return jsonb_build_object('legal_entity_id', v_id);
end $$;

create or replace function public.tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents int, p_approval_ref text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e public.studio_sms_legal_entities;
  p public.studio_sms_price_list;
  v_id uuid;
  v_studio uuid;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = p_entity_id for update;
  if e.id is null or p_kind is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invalid authorization' using errcode = '22023';
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
  insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, approval_ref, authorized_by)
  values (e.id, p_kind, p_amount_cents, p_approval_ref, p_actor) returning id into v_id;
  select studio_id into v_studio from public.studio_sms_entity_studios where legal_entity_id = e.id order by linked_at limit 1;
  perform public._tw4f3a_audit(v_studio, p_actor, 'spend_authorized', 'entity=' || e.id || ';kind=' || p_kind || ';cents=' || p_amount_cents);
  return jsonb_build_object('spend_event_id', v_id);
end $$;

-- the cap counts authorized + reserved + captured... a released (void) authorization frees its share; a captured one stays counted
create or replace function public._tw4f3a_committed(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce(sum(amount_cents), 0) from public.studio_sms_spend_events where legal_entity_id = p_entity and status in ('authorized', 'reserved'); $$;

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
  v_funding uuid;
  v_base text;
  v_key text;
  v_n int;
  v_res uuid;
begin
  o := public._tw4_r1_lease(p_onboarding_id, p_lease_owner);
  if p_kind is null or p_kind not in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;
  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  if v_entity is null then
    raise exception 'the studio has no legal entity' using errcode = 'TW004';
  end if;
  select * into e from public.studio_sms_legal_entities x where x.id = v_entity for update;
  v_funding := coalesce(e.funding_studio_id, (select es.studio_id from public.studio_sms_entity_studios es where es.legal_entity_id = v_entity order by es.linked_at limit 1));
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  -- the newest authorization already bound to this operation: reserved = idempotent replay; void (released) = needs a fresh authorization
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is not null and s.status = 'reserved' then
    return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', s.credit_reservation_id, 'replayed', true);
  end if;
  v_n := (select count(*) from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%') + 1;
  v_key := v_base || ':' || v_n;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.kind = p_kind and x.status = 'authorized' order by x.authorized_at limit 1 for update;
  if s.id is null then
    raise exception 'no authorized spend for % within the cap', p_kind using errcode = 'TW004';
  end if;
  -- the funding studio's settled credit is held in the same transaction as the authorization is bound
  a := public._tw4c_lock(v_funding);
  perform public._tw4c_require_funds(a, s.amount_cents);
  insert into public.studio_sms_credit_reservations (studio_id, kind, amount_cents, reservation_key) values (v_funding, p_kind, s.amount_cents, v_key) returning id into v_res;
  perform public._tw4c_post(v_funding, 'reserve', 0, s.amount_cents, 'reserve:' || v_key, v_res, 'spend_event=' || s.id, null, null);
  update public.studio_sms_spend_events set status = 'reserved', reservation_key = v_key, reserved_at = now(), credit_reservation_id = v_res where id = s.id;
  perform public._tw4f3a_audit(o.studio_id, null, 'spend_reserved', 'entity=' || v_entity || ';kind=' || p_kind || ';cents=' || s.amount_cents);
  return jsonb_build_object('spend_event_id', s.id, 'amount_cents', s.amount_cents, 'credit_reservation_id', v_res, 'replayed', false);
end $$;

-- the outcome of the fee-bearing operation: 'captured' charges the reservation (the operation happened), 'released' frees it (it definitely did not).
-- An unknown outcome is neither: the reservation stays held until a human reconciles it.
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
  if p_kind is null or p_kind not in ('brand', 'campaign_vetting', 'number', 'monthly', 'sms_usage') then
    raise exception 'unknown fee kind' using errcode = '22023';
  end if;

  select legal_entity_id into v_entity from public.studio_sms_entity_studios where studio_id = o.studio_id;
  v_base := o.id || ':' || o.submission_seq || ':' || p_kind;
  select * into s from public.studio_sms_spend_events x where x.legal_entity_id = v_entity and x.reservation_key like v_base || ':%' order by x.reserved_at desc limit 1;
  if s.id is null or s.credit_reservation_id is null then
    raise exception 'no reservation for this operation' using errcode = 'TW004';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = s.credit_reservation_id;
  perform public._tw4c_lock(r.studio_id);
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
    perform public._tw4c_post(r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, p_ref, null, null);
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_captured', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  else
    perform public._tw4c_post(r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, p_ref, null, null);
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    perform set_config('tw4.credit_settle', 'on', true);
    update public.studio_sms_spend_events set status = 'void' where id = s.id;
    perform set_config('tw4.credit_settle', 'off', true);
    perform public._tw4f3a_audit(o.studio_id, null, 'credit_released', 'kind=' || p_kind || ';cents=' || r.amount_cents);
  end if;
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- human resolution: a reservation whose run can no longer settle it (another generation, a cancelled setup, a crash) is captured or released by a
-- platform admin with a written reason, in any generation. Idempotent; a closed reservation is never reopened. An unused authorization can be withdrawn.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.studio_sms_credit_reservations;
  s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_outcome not in ('captured', 'released') or p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'an outcome and a written reason (10+ characters) are required' using errcode = '22023';
  end if;
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id;
  if r.id is null then
    raise exception 'unknown reservation' using errcode = '22023';
  end if;
  perform public._tw4c_lock(r.studio_id);
  select * into r from public.studio_sms_credit_reservations x where x.id = p_reservation_id for update;
  if (r.status = 'captured' and p_outcome = 'captured') or (r.status = 'released' and p_outcome = 'released') then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if r.status <> 'reserved' then
    raise exception 'the reservation is already %', r.status using errcode = '22023';
  end if;
  if p_outcome = 'captured' then
    perform public._tw4c_post(r.studio_id, 'capture', -r.amount_cents, -r.amount_cents, 'capture:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    update public.studio_sms_credit_reservations set status = 'captured', closed_at = now() where id = r.id;
  else
    perform public._tw4c_post(r.studio_id, 'release', 0, -r.amount_cents, 'release:' || r.reservation_key, r.id, 'admin', p_actor, btrim(p_note));
    update public.studio_sms_credit_reservations set status = 'released', closed_at = now() where id = r.id;
    select * into s from public.studio_sms_spend_events x where x.credit_reservation_id = r.id;
    if s.id is not null then
      perform set_config('tw4.credit_settle', 'on', true);
      update public.studio_sms_spend_events set status = 'void' where id = s.id;
      perform set_config('tw4.credit_settle', 'off', true);
    end if;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (r.studio_id, null, 'platform_admin', p_actor, case when p_outcome = 'captured' then 'credit_captured' else 'credit_released' end, left('reservation=' || r.id || ';admin', 300));
  return jsonb_build_object('status', p_outcome, 'replayed', false);
end $$;

create or replace function public.tw4_credit_open_reservations(p_studio_id uuid, p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'amount_cents', r.amount_cents, 'created_at', r.created_at) order by r.created_at)
                     from public.studio_sms_credit_reservations r where r.studio_id = p_studio_id and r.status = 'reserved'), '[]'::jsonb);
end $$;

create or replace function public.tw4_spend_withdraw(p_spend_event_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare s public.studio_sms_spend_events;
begin
  perform public._tw4c_admin(p_actor);
  if p_note is null or char_length(btrim(p_note)) < 10 then
    raise exception 'a written reason (10+ characters) is required' using errcode = '22023';
  end if;
  select * into s from public.studio_sms_spend_events x where x.id = p_spend_event_id for update;
  if s.id is null or s.status <> 'authorized' then
    raise exception 'only an unused authorization can be withdrawn' using errcode = '22023';
  end if;
  perform set_config('tw4.credit_settle', 'on', true);
  update public.studio_sms_spend_events set status = 'void' where id = s.id;
  perform set_config('tw4.credit_settle', 'off', true);
  return jsonb_build_object('status', 'void');
end $$;

create or replace function public.tw4_credit_topup_failed(p_provider_ref text, p_event_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare t public.studio_sms_credit_topups;
begin
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref for update;
  if t.id is null or t.status = 'settled' then
    raise exception 'no pending payment to fail' using errcode = '22023';
  end if;
  if t.status = 'pending' then
    update public.studio_sms_credit_topups set status = 'failed' where id = t.id;
  end if;
  return jsonb_build_object('status', 'failed');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- what a studio's owner or administrator may see: their own balance, history and the published prices (never provider cost)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.sms_credit_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into a from public.studio_sms_credit_accounts x where x.studio_id = p_studio_id;
  return jsonb_build_object(
    'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0),
    'available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    'on_hold', coalesce(a.hold, false), 'low_balance', a.low_balance_flagged_at is not null, 'low_balance_threshold_cents', coalesce(a.low_balance_threshold_cents, 0),
    'pending_topups_cents', coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.studio_id = p_studio_id and t.status = 'pending'), 0));
end $$;

create or replace function public.sms_credit_history(p_studio_id uuid, p_limit int default 50, p_before_seq bigint default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(row_to_json(h) order by h.seq desc) from (
    select l.seq, l.created_at, l.kind, l.balance_delta_cents, l.reserved_delta_cents
      from public.studio_sms_credit_ledger l
     where l.studio_id = p_studio_id and (p_before_seq is null or l.seq < p_before_seq)
     order by l.seq desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) h), '[]'::jsonb);
end $$;

create or replace function public.sms_price_list()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.user_studio_roles r where r.user_id = auth.uid() and r.active = true and r.role in ('studio_owner', 'studio_admin')) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'customer_price_cents', p.customer_price_cents, 'description', p.description) order by p.kind)
                     from public.studio_sms_price_list p where p.active), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4c_immutable_guard(), public._tw4c_truncate_guard(), public._tw4c_lock(uuid),
  public._tw4c_post(uuid, text, bigint, bigint, text, uuid, text, uuid, text), public._tw4c_admin(uuid), public._tw4c_require_funds(public.studio_sms_credit_accounts, bigint) from public, anon, authenticated, service_role;
revoke all on function public.tw4_price_set(text, int, int, text, uuid), public.tw4_credit_topup_pending(uuid, text, int), public.tw4_credit_settle_topup(uuid, text, int, text),
  public.tw4_credit_reverse_topup(text, int, text, text), public.tw4_credit_adjust(uuid, bigint, text, text, uuid), public.tw4_credit_set_hold(uuid, boolean, text, uuid),
  public.tw4_credit_set_threshold(uuid, int, uuid), public.tw4_credit_debit_usage(uuid, int, text, text), public.tw4_credit_refund_usage(uuid, int, text, text),
  public.tw4_credit_record_provider_charge(uuid, text, text, int, uuid), public.tw4_credit_verify(uuid), public.tw4_spend_settle(uuid, text, text, text, text),
  public.tw4_credit_resolve_reservation(uuid, text, uuid, text), public.tw4_credit_open_reservations(uuid, uuid), public.tw4_spend_withdraw(uuid, uuid, text), public.tw4_credit_topup_failed(text, text) from public, anon, authenticated;
grant execute on function public.tw4_price_set(text, int, int, text, uuid), public.tw4_credit_topup_pending(uuid, text, int), public.tw4_credit_settle_topup(uuid, text, int, text),
  public.tw4_credit_reverse_topup(text, int, text, text), public.tw4_credit_adjust(uuid, bigint, text, text, uuid), public.tw4_credit_set_hold(uuid, boolean, text, uuid),
  public.tw4_credit_set_threshold(uuid, int, uuid), public.tw4_credit_debit_usage(uuid, int, text, text), public.tw4_credit_refund_usage(uuid, int, text, text),
  public.tw4_credit_record_provider_charge(uuid, text, text, int, uuid), public.tw4_credit_verify(uuid), public.tw4_spend_settle(uuid, text, text, text, text),
  public.tw4_credit_resolve_reservation(uuid, text, uuid, text), public.tw4_credit_open_reservations(uuid, uuid), public.tw4_spend_withdraw(uuid, uuid, text), public.tw4_credit_topup_failed(text, text) to service_role;
revoke all on function public.sms_credit_overview(uuid), public.sms_credit_history(uuid, int, bigint), public.sms_price_list() from public, anon;
grant execute on function public.sms_credit_overview(uuid), public.sms_credit_history(uuid, int, bigint), public.sms_price_list() to authenticated;

commit;
