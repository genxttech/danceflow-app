-- 20270103090000_competition_r2_entry_refunds.sql
--
-- COMMERCE INTEGRITY -- CI-D / Competition R2: competition entry refunds.
-- Design (owner-approved 2026-10-23; D1-D7 approved, D8 superseded by C1; C1/Q1/Q2 decided):
--   docs/competition/r2-entry-refunds.md (sections 4.0, 4.1, 7).
--
-- Sections
--   1. Preflight pins (repo bodies; confirmed equal on the local catalog).
--   2. Refund ledger: event_order_refunds (one row per Stripe Refund object or staff request) and
--      event_order_refund_allocations (one row per refund x order item; participation_outcome written once).
--   3. Exceptions: four competition_refund_* kinds on the PAY-WH-1A exception table (money_state 'operational':
--      alerted, and reopened when they recur), event_competition_refund_exception_scopes (round_id +
--      competitive_effect, read by the K0 publish precondition COMP_PUBLICATION_BLOCKED_BY_EXCEPTION), and the
--      generic PAY-WH-1A resolver refusing competition_refund_* kinds.
--   4. Accounting (C1): category competition_entry_refund; one entry per succeeded refund dated at success, one
--      offsetting entry per reversal; the competition revenue entry stays gross (a fully refunded competition
--      payment is no longer voided). Normal event payments are unchanged.
--   5. Rules + RPCs: net caps (D1/D2), participation class (Q1), request / observe / attribute / resolve.
--   6. Registration cascade (sync_competition_entries_from_registration): withdraw + scratch only unplaced/open
--      entries; never an entry in a locked/certified heat or one that has danced (Q1); record E-L / E-C for them.
--   7. Grants and postflight.
--
-- Money: no function here calls Stripe. Stripe refunds are created only by the staff server action (test mode
-- locally) after request_competition_order_refund; every Stripe-side state change enters through
-- observe_competition_stripe_refund (server action response and webhook).
--
-- Rollback: rollback/20270103090000_competition_r2_entry_refunds_rollback.sql (refuses while any refund row exists).

begin;
set local lock_timeout = '10s';

-- ===========================================================================================================
-- 1. Preflight
-- ===========================================================================================================
do $$
declare
  v_pin record;
begin
  for v_pin in
    select * from (values
      ('public.sync_competition_entries_from_registration()', 'fabd4052257f261e300ccc1f191c4cdb'),
      ('public.sync_event_payment_accounting_entry()', '7dc2d16ffb20b1a0fb472711eb86670c'),
      ('public._paywh1_exception_money_state(text)', '5bb0940bb4b22243206a59cc9e5998c9'),
      ('public.resolve_event_order_settlement_exception(uuid,text)', 'd0b3051696238b4867118e21b0ff928f'),
      ('public._paywh1_record_exception(uuid,text,text,text,text,text,bigint,text,jsonb)', 'b9f7b16d4d02729d0cbe6d3fffe825d3'),
      ('public._paywh1_actor_can_manage_event(uuid)', '6745f4aa0f842ba359f5b9cba1709df3')
    ) as p(sig, md5)
  loop
    if to_regprocedure(v_pin.sig) is null
       or (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = to_regprocedure(v_pin.sig)) is distinct from v_pin.md5 then
      raise exception 'R2 preflight: % is not the reviewed definition.', v_pin.sig;
    end if;
  end loop;
  if to_regclass('public.event_order_refunds') is not null
     or to_regclass('public.event_order_refund_allocations') is not null
     or to_regclass('public.event_competition_refund_exception_scopes') is not null then
    raise exception 'R2 preflight: refund ledger objects already exist.';
  end if;
  if exists (select 1 from public.accounting_categories where key = 'competition_entry_refund') then
    raise exception 'R2 preflight: competition_entry_refund already exists.';
  end if;
  if not exists (select 1 from public.accounting_categories where key = 'competition_entry_revenue' and active) then
    raise exception 'R2 preflight: competition_entry_revenue is missing.';
  end if;
  -- C1: never silently re-date history. A competition payment that already carries a refund (recorded by the
  -- pre-R2 pro-rata webhook path) must be reconciled by hand before this migration.
  if exists (
    select 1 from public.event_payments p
    join public.event_registrations r on r.id = p.registration_id
    join public.event_order_items oi on oi.order_id = r.order_id
    where coalesce(p.refund_amount, 0) > 0
      and public._comp10c_order_item_class(oi.item_type, oi.metadata) = 'competition_entry'
  ) then
    raise exception 'R2 preflight: competition event payments with recorded refunds exist; reconcile them first.';
  end if;
end $$;

-- ===========================================================================================================
-- 2. Refund ledger
-- ===========================================================================================================
create table public.event_order_refunds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  order_id uuid not null references public.event_orders(id) on delete restrict,
  registration_id uuid null references public.event_registrations(id) on delete restrict,
  refund_request_id uuid null unique,
  stripe_refund_id text null unique,
  stripe_account_id text not null check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  stripe_payment_intent_id text not null,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null,
  status text not null check (status in ('requested', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  source text not null check (source in ('staff', 'stripe_dashboard')),
  reason text null,
  requested_by uuid null,
  last_stripe_event_id text null,
  succeeded_at timestamptz null,
  reversed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_order_refunds_source_request check ((source = 'staff') = (refund_request_id is not null)),
  constraint event_order_refunds_dashboard_has_stripe_id check (source = 'staff' or stripe_refund_id is not null)
);
create index event_order_refunds_order_idx on public.event_order_refunds(order_id);
create index event_order_refunds_event_idx on public.event_order_refunds(event_id);
comment on table public.event_order_refunds is
  'CI-D R2: one row per Stripe Refund object (or staff request before Stripe returns one). status mirrors Stripe; only succeeded counts as refunded money; requested/pending/requires_action/succeeded hold refund cap.';

create table public.event_order_refund_allocations (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.event_order_refunds(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  order_id uuid not null references public.event_orders(id) on delete restrict,
  order_item_id uuid not null references public.event_order_items(id) on delete restrict,
  entry_id uuid null references public.event_competition_entries(id) on delete restrict,
  line_kind text not null check (line_kind in ('entry', 'fee')),
  amount_cents bigint not null check (amount_cents > 0),
  withdraw_entry boolean not null default false,
  participation_outcome text null check (participation_outcome in ('withdrawn', 'not_requested', 'exception_open', 'not_applicable')),
  participation_applied_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint event_order_refund_allocations_refund_item_key unique (refund_id, order_item_id),
  constraint event_order_refund_allocations_withdraw_entry_only check (not withdraw_entry or line_kind = 'entry'),
  constraint event_order_refund_allocations_entry_kind check ((line_kind = 'entry') = (entry_id is not null))
);
create index event_order_refund_allocations_item_idx on public.event_order_refund_allocations(order_item_id);
create index event_order_refund_allocations_entry_idx on public.event_order_refund_allocations(entry_id) where entry_id is not null;

-- Ledger rows are evidence: never deleted; identity and amounts never change. A refund changes only its Stripe
-- state; an allocation only gets its participation outcome, once.
create or replace function public._r2_protect_refund_ledger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'COMP_REFUND_LEDGER_IMMUTABLE: refund ledger rows cannot be deleted.' using errcode = '42501';
  end if;
  if tg_table_name = 'event_order_refunds' then
    if (to_jsonb(new) - array['status', 'stripe_refund_id', 'last_stripe_event_id', 'succeeded_at', 'reversed_at', 'updated_at'])
       is distinct from (to_jsonb(old) - array['status', 'stripe_refund_id', 'last_stripe_event_id', 'succeeded_at', 'reversed_at', 'updated_at'])
       or (old.stripe_refund_id is not null and new.stripe_refund_id is distinct from old.stripe_refund_id) then
      raise exception 'COMP_REFUND_LEDGER_IMMUTABLE: refund identity and amount cannot change.' using errcode = '42501';
    end if;
  else
    if (to_jsonb(new) - array['participation_outcome', 'participation_applied_at'])
       is distinct from (to_jsonb(old) - array['participation_outcome', 'participation_applied_at'])
       or (old.participation_outcome is not null and new.participation_outcome is distinct from old.participation_outcome) then
      raise exception 'COMP_REFUND_LEDGER_IMMUTABLE: allocations are immutable; the participation outcome is written once.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._r2_protect_refund_ledger() from public, anon, authenticated;
create trigger r2_protect_event_order_refunds before update or delete on public.event_order_refunds
  for each row execute function public._r2_protect_refund_ledger();
create trigger r2_protect_event_order_refund_allocations before update or delete on public.event_order_refund_allocations
  for each row execute function public._r2_protect_refund_ledger();

alter table public.event_order_refunds enable row level security;
alter table public.event_order_refund_allocations enable row level security;
create policy event_order_refunds_manager_select on public.event_order_refunds
  for select to authenticated using (public._paywh1_actor_can_manage_event(event_id));
create policy event_order_refund_allocations_manager_select on public.event_order_refund_allocations
  for select to authenticated using (public._paywh1_actor_can_manage_event(event_id));
revoke all on public.event_order_refunds, public.event_order_refund_allocations from public, anon, authenticated;
grant select on public.event_order_refunds, public.event_order_refund_allocations to authenticated;
grant select, insert, update on public.event_order_refunds, public.event_order_refund_allocations to service_role;

-- ===========================================================================================================
-- 3. Exceptions
-- ===========================================================================================================
-- All competition_refund_* kinds are 'operational': alerted through the PAY-WH-1A queue and reopened when they
-- recur after a resolution (a new refund on the same order needs attention again).
create or replace function public._paywh1_exception_money_state(p_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_kind in ('late_payment_after_release', 'duplicate_payment', 'paid_capacity_unavailable',
                    'unknown_payment_reference', 'settlement_integrity_conflict',
                    'terminal_paid_capacity_unavailable', 'terminal_payment_unfulfilled')
         or p_kind like 'mismatch\_%' and p_kind not in ('mismatch_processing', 'mismatch_failure_account') then 'captured'
    when p_kind = 'failure_after_settlement' then 'reversed'
    when p_kind in ('processing_hold_lapsed', 'mismatch_processing', 'processing_after_release') then 'in_flight'
    when p_kind in ('settlement_effect_dead', 'reconcile_stuck') then 'operational'
    when p_kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat',
                    'competition_refund_unattributed', 'competition_refund_reversed') then 'operational'
    else 'informational'
  end;
$$;

alter table public.event_order_settlement_exception_events drop constraint event_order_settlement_exception_events_action_check;
alter table public.event_order_settlement_exception_events add constraint event_order_settlement_exception_events_action_check
  check (action in ('recorded', 'recurred', 'alert_sent', 'alert_failed', 'acknowledged', 'resolved', 'scope_resolved', 'attributed'));

create table public.event_competition_refund_exception_scopes (
  id uuid primary key default gen_random_uuid(),
  exception_id uuid not null references public.event_order_settlement_exceptions(id) on delete restrict,
  kind text not null check (kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat',
                                     'competition_refund_unattributed', 'competition_refund_reversed')),
  event_id uuid not null references public.events(id) on delete restrict,
  refund_id uuid null references public.event_order_refunds(id) on delete restrict,
  entry_id uuid not null references public.event_competition_entries(id) on delete restrict,
  heat_id uuid not null references public.event_competition_heats(id) on delete restrict,
  round_id uuid null references public.event_competition_rounds(id) on delete restrict,
  competitive_effect boolean not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by uuid null,
  resolution text null check (resolution in ('withdrawn_after_unlock', 'keep_entry', 'result_stands', 'k0_correction', 'attributed')),
  resolution_note text null,
  -- one scope per (exception, entry, heat, refund); the trigger path has refund_id null
  constraint event_competition_refund_exception_scopes_key unique nulls not distinct (exception_id, entry_id, heat_id, refund_id),
  constraint event_competition_refund_exception_scopes_resolution check ((resolved_at is null) = (resolution is null))
);
create index event_competition_refund_scopes_open_round_idx
  on public.event_competition_refund_exception_scopes(round_id) where resolved_at is null and competitive_effect;
create index event_competition_refund_scopes_entry_idx on public.event_competition_refund_exception_scopes(entry_id, heat_id, kind);
comment on table public.event_competition_refund_exception_scopes is
  'CI-D R2 / owner Q2: one row per (exception, entry, heat). An unresolved row with competitive_effect blocks publication of its round only (K0 COMP_PUBLICATION_BLOCKED_BY_EXCEPTION). Append-only; the resolution stamp is written once.';

create or replace function public._r2_protect_exception_scopes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'COMP_REFUND_SCOPE_IMMUTABLE: exception scopes cannot be deleted.' using errcode = '42501';
  end if;
  if old.resolved_at is not null
     or (to_jsonb(new) - array['resolved_at', 'resolved_by', 'resolution', 'resolution_note'])
        is distinct from (to_jsonb(old) - array['resolved_at', 'resolved_by', 'resolution', 'resolution_note']) then
    raise exception 'COMP_REFUND_SCOPE_IMMUTABLE: a scope is append-only and its resolution is written once.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._r2_protect_exception_scopes() from public, anon, authenticated;
create trigger r2_protect_exception_scopes before update or delete on public.event_competition_refund_exception_scopes
  for each row execute function public._r2_protect_exception_scopes();

alter table public.event_competition_refund_exception_scopes enable row level security;
create policy event_competition_refund_exception_scopes_manager_select on public.event_competition_refund_exception_scopes
  for select to authenticated using (public._paywh1_actor_can_manage_event(event_id));
revoke all on public.event_competition_refund_exception_scopes from public, anon, authenticated;
grant select on public.event_competition_refund_exception_scopes to authenticated;
grant select, insert, update on public.event_competition_refund_exception_scopes to service_role;

-- PAY-WH-1A generic resolver: unchanged except that competition_refund_* exceptions must go through the gated
-- resolve_competition_refund_scope / resolve_competition_refund_exception.
create or replace function public.resolve_event_order_settlement_exception(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_x public.event_order_settlement_exceptions%rowtype;
begin
  select * into v_x from public.event_order_settlement_exceptions where id = p_exception_id for update;
  if not found then
    return false;
  end if;
  if not public._paywh1_actor_can_manage_exception(v_x.event_id, v_x.studio_id) then
    raise exception 'not authorized to resolve this settlement exception' using errcode = '42501';
  end if;
  if v_x.kind like 'competition\_refund\_%' then
    raise exception 'COMP_REFUND_EXCEPTION_GATED: competition refund exceptions are resolved through their scopes.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  if v_x.status not in ('open', 'acknowledged') then
    return false;
  end if;
  update public.event_order_settlement_exceptions
  set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = left(p_note, 2000),
      -- a resolved exception no longer needs its alert
      alert_status = case when alert_status in ('pending', 'failed') then 'not_required' else alert_status end,
      alert_next_at = case when alert_status in ('pending', 'failed') then null else alert_next_at end
  where id = p_exception_id;
  insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
  values (p_exception_id, 'resolved', auth.uid(), left(p_note, 2000));
  return true;
end;
$$;

-- ===========================================================================================================
-- 4. Accounting (C1)
-- ===========================================================================================================
insert into public.accounting_categories (
  key, label, entry_class, statement_section, normal_direction,
  allowed_external_account_types, blocks_auto_post_when_unmapped
) values (
  'competition_entry_refund', 'Competition Entry Refund', 'refund', 'contra_income', 'debit',
  array['INCOME', 'REVENUE', 'EXPENSE'], true
);

-- Is this event payment a competition order's payment? (Same classification as the 10C trigger.)
create or replace function public._r2_event_payment_is_competition(p_registration_id uuid, p_session text, p_payment_intent text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_orders eo
    join public.event_order_items oi on oi.order_id = eo.id
    where (eo.id = (select er.order_id from public.event_registrations er where er.id = p_registration_id)
           or (p_session is not null and eo.stripe_checkout_session_id = p_session)
           or (p_payment_intent is not null and eo.stripe_payment_intent_id = p_payment_intent))
      and public._comp10c_order_item_class(oi.item_type, oi.metadata) = 'competition_entry'
  );
$$;

-- 10C body with two C1 changes for competition payments only: a refunded competition payment keeps its gross
-- revenue entry (refunds are separate dated competition_entry_refund entries), and its revenue net no longer
-- subtracts refund_amount. Every non-competition path is byte-identical.
create or replace function public.sync_event_payment_accounting_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_studio_id uuid;
  v_organizer_id uuid;
  v_order_id uuid;
  v_fee_amount numeric;
  v_refund_amount numeric;
  v_net_amount numeric;
  v_competition boolean := false;
begin
  if tg_op = 'DELETE' then
    perform public.accounting_mark_source_voided('event_payments', old.id, 'Event payment source was deleted.');
    return old;
  end if;

  -- R2 / C1: a refunded competition payment is still revenue at gross; its refunds post separately.
  if new.status::text is distinct from 'paid'
     and not (new.status::text = 'refunded'
              and public._r2_event_payment_is_competition(new.registration_id, new.stripe_checkout_session_id, new.stripe_payment_intent_id)) then
    perform public.accounting_mark_source_voided('event_payments', new.id, 'Event payment is not paid.');
    return new;
  end if;

  -- event_payments.event_id (20260502000600) is missing on DEV (known drift); read it without
  -- binding to the column so the trigger works on both shapes.
  v_event_id := nullif(to_jsonb(new)->>'event_id', '')::uuid;

  if new.registration_id is not null then
    select er.event_id, er.studio_id, er.order_id
      into v_event_id, v_studio_id, v_order_id
    from public.event_registrations er
    where er.id = new.registration_id
    limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    select eo.studio_id, eo.organizer_id, coalesce(v_event_id, eo.event_id), coalesce(v_order_id, eo.id)
      into v_studio_id, v_organizer_id, v_event_id, v_order_id
    from public.event_orders eo
    where (new.stripe_checkout_session_id is not null and eo.stripe_checkout_session_id = new.stripe_checkout_session_id)
       or (new.stripe_payment_intent_id is not null and eo.stripe_payment_intent_id = new.stripe_payment_intent_id)
    limit 1;
  end if;

  if v_event_id is not null and v_studio_id is null and v_organizer_id is null then
    select e.studio_id, e.organizer_id into v_studio_id, v_organizer_id
    from public.events e where e.id = v_event_id limit 1;
  end if;

  if v_studio_id is null and v_organizer_id is null then
    return new;
  end if;

  -- Phase 10C: classify from the order's own (server-written, homogeneous) items, never from client input.
  if v_order_id is not null then
    v_competition := exists (
      select 1 from public.event_order_items oi
      where oi.order_id = v_order_id
        and public._comp10c_order_item_class(oi.item_type, oi.metadata) = 'competition_entry'
    );
  end if;

  v_fee_amount := coalesce(new.stripe_processing_fee_amount, 0)
    + coalesce(new.stripe_application_fee_amount, 0)
    + coalesce(new.platform_fee_amount, 0);
  -- R2 / C1: competition refunds are separate dated entries; never net them out of the revenue entry.
  v_refund_amount := case when v_competition then 0 else coalesce(new.refund_amount, 0) end;
  v_net_amount := coalesce(new.amount, 0) - v_fee_amount - v_refund_amount;

  perform public.accounting_upsert_entry(
    v_studio_id, v_organizer_id, coalesce(new.created_at::date, current_date),
    'revenue', case when v_competition then 'competition_entry_revenue' else 'event_ticket_revenue' end,
    'credit', new.amount, v_fee_amount,
    v_refund_amount, v_net_amount, new.currency::text, new.payment_method::text,
    'event_payments', new.id, null, v_event_id, null,
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id,
      new.external_reference, new.processor_reference),
    coalesce(new.stripe_payment_intent_id, new.processor_payment_intent_id),
    coalesce(new.stripe_charge_id, new.processor_charge_id), new.stripe_invoice_id,
    case when v_competition then 'Competition entry revenue' else 'Event ticket revenue' end,
    jsonb_build_object(
      'event_payment_id', new.id,
      'registration_id', new.registration_id,
      'stripe_checkout_session_id', new.stripe_checkout_session_id,
      'stripe_balance_transaction_id', new.stripe_balance_transaction_id,
      'stripe_refund_id', new.stripe_refund_id,
      'stripe_processing_fee_amount', new.stripe_processing_fee_amount,
      'stripe_application_fee_amount', new.stripe_application_fee_amount,
      'platform_fee_amount', new.platform_fee_amount,
      'processor_reference', new.processor_reference,
      'source', new.source
    ), null
  );

  return new;
end;
$$;

-- One dated entry per succeeded refund; one offsetting entry per reversal. Idempotent: accounting_upsert_entry
-- is unique on (source_table, source_id, entry_type, category) and never updates a locked entry.
create or replace function public._r2_post_refund_accounting(p_refund_id uuid, p_reversal boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r record;
  v_amount numeric;
begin
  select r.*, eo.studio_id, eo.organizer_id, p.payment_method, p.stripe_charge_id
    into v_r
  from public.event_order_refunds r
  join public.event_orders eo on eo.id = r.order_id
  left join lateral (
    select ep.payment_method::text as payment_method, ep.stripe_charge_id
    from public.event_payments ep
    join public.event_registrations er on er.id = ep.registration_id
    where er.order_id = r.order_id and ep.stripe_payment_intent_id = r.stripe_payment_intent_id
    limit 1
  ) p on true
  where r.id = p_refund_id;
  if v_r.id is null or (v_r.studio_id is null and v_r.organizer_id is null) then
    return;
  end if;
  v_amount := v_r.amount_cents::numeric / 100;
  perform public.accounting_upsert_entry(
    v_r.studio_id, v_r.organizer_id,
    case when p_reversal then coalesce(v_r.reversed_at, now())::date else coalesce(v_r.succeeded_at, now())::date end,
    'refund', 'competition_entry_refund', case when p_reversal then 'credit' else 'debit' end,
    0, 0, v_amount, v_amount, v_r.currency, coalesce(v_r.payment_method, 'card'),
    case when p_reversal then 'event_order_refund_reversals' else 'event_order_refunds' end, v_r.id,
    null, v_r.event_id, null,
    v_r.stripe_refund_id, v_r.stripe_payment_intent_id, v_r.stripe_charge_id, null,
    case when p_reversal then 'Reversal of competition entry refund' else 'Competition entry refund' end,
    jsonb_build_object('refund_id', v_r.id, 'order_id', v_r.order_id, 'stripe_refund_id', v_r.stripe_refund_id,
                       'source', v_r.source, 'reversal', p_reversal),
    null
  );
end;
$$;

-- ===========================================================================================================
-- 5. Rules and RPCs
-- ===========================================================================================================
create or replace function public._r2_order_is_competition(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.event_order_items oi
    where oi.order_id = p_order_id
      and public._comp10c_order_item_class(oi.item_type, oi.metadata) = 'competition_entry'
  );
$$;

-- D1 (b) / D2 (a): net refundable cap per refundable line. Mirrors src/lib/payments/competitionRefundRules.ts:
-- each discount (ordered by item id) is split over the lines it priced (scoped: matching entries; unscoped: every
-- entry and fee line) in proportion to their current net, largest remainder first, ties by (sort key, id).
create or replace function public._r2_order_line_caps(p_order_id uuid)
returns table (order_item_id uuid, line_kind text, entry_id uuid, gross_cents bigint, cap_cents bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_caps jsonb;
  v_d record;
  v_base bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'kind', l.kind, 'entry', l.entry_id, 'gross', l.gross, 'sort', l.sort_key, 'keys', l.keys)), '[]'::jsonb),
         coalesce(jsonb_object_agg(l.id, l.gross), '{}'::jsonb)
    into v_lines, v_caps
  from (
    select oi.id,
           case when oi.item_type = 'competition_entry' then 'entry' else 'fee' end as kind,
           e.id as entry_id,
           round(oi.total_price * 100)::bigint as gross,
           case when oi.item_type = 'competition_entry' then coalesce(e.sort_order, 0)::bigint else 1000000 end as sort_key,
           case when oi.item_type = 'competition_entry'
                then jsonb_build_array(e.program_id::text, oi.metadata->>'contest_id', e.division_id::text)
                else '[]'::jsonb end as keys
    from public.event_order_items oi
    left join public.event_competition_entries e on e.order_item_id = oi.id
    where oi.order_id = p_order_id
      and (oi.item_type = 'competition_entry'
           or (oi.item_type = 'add_on' and coalesce(oi.metadata->>'line_type', 'fee') <> 'discount'))
  ) l;

  for v_d in
    select oi.id,
           round(coalesce((oi.metadata->>'discount_amount')::numeric, 0) * 100)::bigint as amt,
           oi.metadata->'price_line'->'metadata'->'scope' as scope
    from public.event_order_items oi
    where oi.order_id = p_order_id and oi.item_type = 'add_on' and oi.metadata->>'line_type' = 'discount'
    order by oi.id::text collate "C"
  loop
    continue when v_d.amt <= 0;
    with t as (
      select l->>'id' as id, (v_caps->>(l->>'id'))::bigint as net, (l->>'sort')::bigint as sk
      from jsonb_array_elements(v_lines) l
      where (nullif(v_d.scope->>'programId', '') is null and nullif(v_d.scope->>'contestId', '') is null
             and nullif(v_d.scope->>'divisionId', '') is null)
         or (l->>'kind' = 'entry'
             and (nullif(v_d.scope->>'programId', '') is null or l->'keys' ? (v_d.scope->>'programId'))
             and (nullif(v_d.scope->>'contestId', '') is null or l->'keys' ? (v_d.scope->>'contestId'))
             and (nullif(v_d.scope->>'divisionId', '') is null or l->'keys' ? (v_d.scope->>'divisionId')))
    )
    select coalesce(sum(net), 0) into v_base from t;
    if v_d.amt > v_base then
      raise exception 'COMP_REFUND_DISCOUNT_INCONSISTENT: a discount exceeds the lines it applies to (order %).', p_order_id;
    end if;
    with t as (
      select l->>'id' as id, (v_caps->>(l->>'id'))::bigint as net, (l->>'sort')::bigint as sk
      from jsonb_array_elements(v_lines) l
      where (nullif(v_d.scope->>'programId', '') is null and nullif(v_d.scope->>'contestId', '') is null
             and nullif(v_d.scope->>'divisionId', '') is null)
         or (l->>'kind' = 'entry'
             and (nullif(v_d.scope->>'programId', '') is null or l->'keys' ? (v_d.scope->>'programId'))
             and (nullif(v_d.scope->>'contestId', '') is null or l->'keys' ? (v_d.scope->>'contestId'))
             and (nullif(v_d.scope->>'divisionId', '') is null or l->'keys' ? (v_d.scope->>'divisionId')))
    ), s as (
      select id, net, sk, (v_d.amt * net) / v_base as fl, (v_d.amt * net) % v_base as rem from t
    ), r as (
      select id, net, fl,
             row_number() over (order by rem desc, sk, id collate "C") as rn,
             v_d.amt - sum(fl) over () as lft
      from s
    )
    select v_caps || coalesce(jsonb_object_agg(id, net - fl - case when rn <= lft then 1 else 0 end), '{}'::jsonb)
      into v_caps
    from r;
  end loop;

  return query
  select (l->>'id')::uuid, l->>'kind', nullif(l->>'entry', '')::uuid, (l->>'gross')::bigint, (v_caps->>(l->>'id'))::bigint
  from jsonb_array_elements(v_lines) l;
end;
$$;

-- Q1 / section 4.1 P: the most restrictive placement wins; a danced placement counts as locked.
create or replace function public._r2_entry_participation_class(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
                 where he.entry_id = p_entry_id and h.lock_state = 'certified') then 'certified'
    when exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
                 where he.entry_id = p_entry_id and ((h.lock_state = 'locked' and he.status <> 'scratched') or he.status in ('danced', 'disqualified') or (h.status in ('active', 'complete') and he.status <> 'scratched'))) then 'locked'
    when exists (select 1 from public.event_competition_heat_entries he where he.entry_id = p_entry_id) then 'open'
    else 'unplaced'
  end;
$$;

-- Record a competition_refund_* exception and its scopes. p_entry_id null = financial-only parent (no scope).
-- A heat gets a new scope unless one of this kind is still open for the entry there, or this same refund (or, for
-- the registration trigger, the trigger path with refund_id null) already recorded one: replays and re-fired
-- triggers add nothing, while a NEW refund after an earlier resolution opens a new scope (and reopens the parent).
create or replace function public._r2_record_refund_exception(
  p_kind text, p_order_id uuid, p_event_id uuid, p_registration_id uuid, p_refund_id uuid, p_entry_id uuid,
  p_amount_cents bigint, p_currency text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pi text;
  v_account text;
  v_exception uuid;
begin
  if p_entry_id is not null then
    -- the heats that hold this entry's competitive state (E-C: certified only)
    if not exists (
      select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
      where he.entry_id = p_entry_id
        and (case when p_kind = 'competition_refund_entry_certified_heat' then h.lock_state = 'certified'
                  else (h.lock_state <> 'open' and he.status <> 'scratched') or he.status in ('danced', 'disqualified') or (h.status in ('active', 'complete') and he.status <> 'scratched') end)
        and not exists (select 1 from public.event_competition_refund_exception_scopes s
                        where s.kind = p_kind and s.entry_id = p_entry_id and s.heat_id = he.heat_id
                          and (s.resolved_at is null or s.refund_id is not distinct from p_refund_id))
    ) then
      return null;
    end if;
  end if;

  if p_order_id is not null then
    select eo.stripe_payment_intent_id into v_pi from public.event_orders eo where eo.id = p_order_id;
    select ep.stripe_account_id into v_account
    from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
    where er.order_id = p_order_id and ep.stripe_payment_intent_id = v_pi
    limit 1;
  end if;

  v_exception := public._paywh1_record_exception(
    p_order_id, p_kind, null, v_account, null, v_pi, p_amount_cents, p_currency,
    jsonb_build_object('event_id', p_event_id, 'registration_id', p_registration_id, 'refund_id', p_refund_id,
                       'entry_id', p_entry_id));

  if p_entry_id is not null then
    insert into public.event_competition_refund_exception_scopes (
      exception_id, kind, event_id, refund_id, entry_id, heat_id, round_id, competitive_effect)
    select v_exception, p_kind, h.event_id, p_refund_id, p_entry_id, h.id, h.round_id,
           -- E-L / E-C always; unattributed / reversed only because the entry is held in this heat (Q2)
           true
    from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
    where he.entry_id = p_entry_id
      and (case when p_kind = 'competition_refund_entry_certified_heat' then h.lock_state = 'certified'
                else (h.lock_state <> 'open' and he.status <> 'scratched') or he.status in ('danced', 'disqualified') or (h.status in ('active', 'complete') and he.status <> 'scratched') end)
      and not exists (select 1 from public.event_competition_refund_exception_scopes s
                      where s.kind = p_kind and s.entry_id = p_entry_id and s.heat_id = h.id
                        and (s.resolved_at is null or s.refund_id is not distinct from p_refund_id))
    on conflict on constraint event_competition_refund_exception_scopes_key do nothing;
  end if;
  return v_exception;
end;
$$;

-- Withdraw + scratch one open/unplaced entry (the change_competition_entry_lifecycle writes, audited, definer).
create or replace function public._r2_withdraw_entry(p_entry_id uuid, p_reason text, p_fee_handling text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('app.competition_entry_change_type', 'withdraw', true);
  perform set_config('app.competition_entry_change_reason', coalesce(p_reason, ''), true);
  perform set_config('app.competition_entry_fee_handling', p_fee_handling, true);
  update public.event_competition_entries
  set status = 'withdrawn', withdrawn_at = coalesce(withdrawn_at, now()),
      withdrawal_reason = coalesce(withdrawal_reason, p_reason),
      lifecycle_version = lifecycle_version + 1, updated_at = now()
  where id = p_entry_id and status not in ('withdrawn', 'disqualified', 'complete', 'scratched');
  if not found then
    return false;
  end if;
  update public.event_competition_heat_entries
  set status = 'scratched', updated_at = now()
  where entry_id = p_entry_id and status in ('scheduled', 'checked_in');
  return true;
end;
$$;

-- Participation effects (section 4.1 P) for allocations not yet applied. Called only for a succeeded refund.
create or replace function public._r2_apply_participation(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a record;
  v_class text;
  v_outcome text;
begin
  for v_a in
    select a.*, r.registration_id, r.currency, e.status as entry_status
    from public.event_order_refund_allocations a
    join public.event_order_refunds r on r.id = a.refund_id
    left join public.event_competition_entries e on e.id = a.entry_id
    where a.refund_id = p_refund_id and a.participation_outcome is null
    order by a.id
  loop
    if v_a.line_kind <> 'entry' then
      v_outcome := 'not_applicable';
    elsif not v_a.withdraw_entry then
      v_outcome := 'not_requested';
    elsif v_a.entry_status in ('withdrawn', 'disqualified', 'complete', 'scratched') then
      v_outcome := 'not_applicable';
    else
      -- Hold the entry's heats against a concurrent lock/certify while classifying and withdrawing.
      perform 1 from public.event_competition_heats h
      where h.id in (select he.heat_id from public.event_competition_heat_entries he where he.entry_id = v_a.entry_id)
      for share;
      v_class := public._r2_entry_participation_class(v_a.entry_id);
      if v_class in ('unplaced', 'open') then
        -- A concurrent scratch (SC1) or withdrawal can win the entry row after the status was read above: then nothing was withdrawn here.
        if public._r2_withdraw_entry(v_a.entry_id, 'Entry refunded.', 'refund') then
          v_outcome := 'withdrawn';
        else
          v_outcome := 'not_applicable';
        end if;
      else
        perform public._r2_record_refund_exception(
          case when v_class = 'certified' then 'competition_refund_entry_certified_heat' else 'competition_refund_entry_locked_heat' end,
          v_a.order_id, v_a.event_id, v_a.registration_id, p_refund_id, v_a.entry_id, v_a.amount_cents, v_a.currency);
        v_outcome := 'exception_open';
      end if;
    end if;
    update public.event_order_refund_allocations
    set participation_outcome = v_outcome, participation_applied_at = now()
    where id = v_a.id;
  end loop;
end;
$$;

-- Absolute recompute of the order / payment / registration financial state from succeeded refunds.
create or replace function public._r2_recompute_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_payment record;
  v_refunded bigint;
  v_captured bigint;
  v_state text;
  v_latest text;
begin
  select * into v_order from public.event_orders where id = p_order_id;
  select ep.id, ep.amount, ep.refund_amount, ep.registration_id into v_payment
  from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
  where er.order_id = p_order_id and ep.stripe_payment_intent_id = v_order.stripe_payment_intent_id
  limit 1;
  if v_payment.id is null then
    raise exception 'COMP_REFUND_PAYMENT_MISSING: order % has no Stripe payment row.', p_order_id;
  end if;
  v_captured := round(v_payment.amount * 100)::bigint;
  select coalesce(sum(amount_cents), 0) into v_refunded
  from public.event_order_refunds where order_id = p_order_id and status = 'succeeded';
  select stripe_refund_id into v_latest
  from public.event_order_refunds where order_id = p_order_id and status = 'succeeded' and stripe_refund_id is not null
  order by succeeded_at desc nulls last, id desc limit 1;
  v_state := case when v_refunded = 0 then 'paid' when v_refunded >= v_captured then 'refunded' else 'partially_refunded' end;

  update public.event_orders
  set payment_status = v_state, updated_at = now()
  where id = p_order_id and payment_status is distinct from v_state;

  update public.event_payments
  set refund_amount = v_refunded::numeric / 100,
      status = case when v_state = 'refunded' then 'refunded' else 'paid' end,
      -- REFUND-RECON-2: dated at refund progress, never moved backwards
      refunded_at = case when v_refunded::numeric / 100 > coalesce(refund_amount, 0) then greatest(refunded_at, now()) else refunded_at end,
      stripe_refund_id = coalesce(v_latest, stripe_refund_id)
  where id = v_payment.id
    and (refund_amount is distinct from v_refunded::numeric / 100
         or status is distinct from (case when v_state = 'refunded' then 'refunded' else 'paid' end)
         or stripe_refund_id is distinct from coalesce(v_latest, stripe_refund_id));

  if v_state = 'refunded' then
    update public.event_registrations
    set payment_status = 'refunded', status = 'refunded'
    where id = v_payment.registration_id and (payment_status is distinct from 'refunded' or status is distinct from 'refunded');
  else
    update public.event_registrations
    set payment_status = case when v_state = 'paid' then 'paid' else 'partial' end
    where id = v_payment.registration_id
      and payment_status is distinct from (case when v_state = 'paid' then 'paid' else 'partial' end);
  end if;
  return v_state;
end;
$$;

-- Validate requested lines against D1/D2 caps (held allocations of other refunds count) and the order cap.
create or replace function public._r2_validate_lines(p_order_id uuid, p_lines jsonb, p_amount_exact bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_line jsonb;
  v_out jsonb := '[]'::jsonb;
  v_item uuid;
  v_amount bigint;
  v_withdraw boolean;
  v_cap record;
  v_held bigint;
  v_total bigint := 0;
  v_captured bigint;
  v_order_held bigint;
  v_seen uuid[] := '{}';
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'COMP_REFUND_LINES_REQUIRED: select at least one line to refund.' using errcode = '22023';
  end if;
  for v_line in select x from jsonb_array_elements(p_lines) x loop
    begin
      v_item := (v_line->>'orderItemId')::uuid;
      v_amount := (v_line->>'amountCents')::bigint;
    exception when others then
      raise exception 'COMP_REFUND_LINE_INVALID: each line needs orderItemId and integer amountCents.' using errcode = '22023';
    end;
    v_withdraw := coalesce((v_line->>'withdrawEntry')::boolean, false);
    if v_item is null or v_amount is null or v_amount <= 0 or (v_line->>'amountCents') !~ '^[0-9]+$' then
      raise exception 'COMP_REFUND_LINE_INVALID: each line needs orderItemId and a positive integer amountCents.' using errcode = '22023';
    end if;
    if v_item = any(v_seen) then
      raise exception 'COMP_REFUND_LINE_DUPLICATE: an order item appears twice.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_item;
    select * into v_cap from public._r2_order_line_caps(p_order_id) c where c.order_item_id = v_item;
    if v_cap.order_item_id is null then
      raise exception 'COMP_REFUND_ITEM_NOT_IN_ORDER: the item is not a refundable line of this order.' using errcode = '42501';
    end if;
    if v_withdraw and v_cap.line_kind <> 'entry' then
      raise exception 'COMP_REFUND_LINE_INVALID: only entry lines can withdraw an entry.' using errcode = '22023';
    end if;
    select coalesce(sum(a.amount_cents), 0) into v_held
    from public.event_order_refund_allocations a join public.event_order_refunds r on r.id = a.refund_id
    where a.order_item_id = v_item and r.status in ('requested', 'pending', 'requires_action', 'succeeded');
    if v_amount > v_cap.cap_cents - v_held then
      raise exception 'COMP_REFUND_EXCEEDS_LINE_CAP: % cents requested, % cents refundable.', v_amount, greatest(v_cap.cap_cents - v_held, 0)
        using errcode = '22023';
    end if;
    v_total := v_total + v_amount;
    v_out := v_out || jsonb_build_object('orderItemId', v_item, 'lineKind', v_cap.line_kind, 'entryId', v_cap.entry_id,
                                         'amountCents', v_amount, 'withdrawEntry', v_withdraw);
  end loop;

  select round(ep.amount * 100)::bigint into v_captured
  from public.event_orders eo
  join public.event_registrations er on er.order_id = eo.id
  join public.event_payments ep on ep.registration_id = er.id and ep.stripe_payment_intent_id = eo.stripe_payment_intent_id
  where eo.id = p_order_id limit 1;
  select coalesce(sum(amount_cents), 0) into v_order_held
  from public.event_order_refunds where order_id = p_order_id and status in ('requested', 'pending', 'requires_action', 'succeeded');
  if p_amount_exact is null and v_total > coalesce(v_captured, 0) - v_order_held then
    raise exception 'COMP_REFUND_EXCEEDS_ORDER_CAP: % cents requested, % cents refundable on this payment.', v_total, greatest(coalesce(v_captured, 0) - v_order_held, 0)
      using errcode = '22023';
  end if;
  if p_amount_exact is not null and v_total <> p_amount_exact then
    raise exception 'COMP_REFUND_ATTRIBUTION_MISMATCH: lines total % cents; the refund is % cents.', v_total, p_amount_exact using errcode = '22023';
  end if;
  return v_out;
end;
$$;

-- Staff refund request (D5 authority). Returns what the server action needs to create the Stripe refund.
create or replace function public.request_competition_order_refund(
  p_event_id uuid, p_order_id uuid, p_request_id uuid, p_lines jsonb, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_payment record;
  v_existing public.event_order_refunds%rowtype;
  v_lines jsonb;
  v_total bigint;
  v_refund uuid;
  v_line jsonb;
begin
  if auth.uid() is null or not public._paywh1_actor_can_manage_event(p_event_id) then
    raise exception 'COMP_REFUND_NOT_AUTHORIZED: only studio or organizer owners and admins can refund.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REFUND_REQUEST_ID_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'COMP_REFUND_REASON_REQUIRED: a refund reason is required.' using errcode = '22023';
  end if;

  select * into v_order from public.event_orders where id = p_order_id for update;
  if not found or v_order.event_id is distinct from p_event_id then
    raise exception 'COMP_REFUND_ORDER_NOT_IN_EVENT: the order does not belong to this event.' using errcode = '42501';
  end if;
  if not public._r2_order_is_competition(p_order_id) then
    raise exception 'COMP_REFUND_NOT_COMPETITION_ORDER' using errcode = '22023';
  end if;

  select * into v_existing from public.event_order_refunds where refund_request_id = p_request_id;
  if found then
    if v_existing.order_id <> p_order_id
       or (select jsonb_agg(jsonb_build_object('i', order_item_id, 'a', amount_cents, 'w', withdraw_entry) order by order_item_id)
           from public.event_order_refund_allocations where refund_id = v_existing.id)
          is distinct from
          (select jsonb_agg(jsonb_build_object('i', (x->>'orderItemId')::uuid, 'a', (x->>'amountCents')::bigint,
                                               'w', coalesce((x->>'withdrawEntry')::boolean, false)) order by (x->>'orderItemId')::uuid)
           from jsonb_array_elements(p_lines) x) then
      raise exception 'COMP_REFUND_REQUEST_REPLAY_MISMATCH: this request id was already used with different lines.' using errcode = '22023';
    end if;
    return jsonb_build_object('refundId', v_existing.id, 'replay', true, 'status', v_existing.status,
      'amountCents', v_existing.amount_cents, 'currency', v_existing.currency,
      'paymentIntentId', v_existing.stripe_payment_intent_id, 'stripeAccountId', v_existing.stripe_account_id,
      'stripeRefundId', v_existing.stripe_refund_id);
  end if;

  -- "Settled" is decided from authoritative facts, NOT from settlement_state: orders finalized by
  -- finalize_competition_registration (the real competition checkout) never get a settlement_state (NULL), only cart
  -- orders settled by settle_event_cart_order do. NULL is accepted; any other non-'paid' state (pending, processing,
  -- releasing, exception ...) refuses. The money facts: paid AND confirmed order (a signing-incomplete paid order stays pending), intent, and a captured payment row.
  if v_order.payment_status not in ('paid', 'partially_refunded')
     or v_order.status is distinct from 'confirmed'
     or coalesce(v_order.settlement_state, 'paid') <> 'paid'
     or v_order.stripe_payment_intent_id is null
     or not exists (select 1 from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
                    where er.order_id = p_order_id and ep.stripe_payment_intent_id = v_order.stripe_payment_intent_id
                      and ep.status = 'paid')
     -- a refund that went through the older pro-rata webhook path (before R2) is not in the R2 ledger: caps would be wrong
     or (exists (select 1 from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
                 where er.order_id = p_order_id and coalesce(ep.refund_amount, 0) > 0)
         and not exists (select 1 from public.event_order_refunds r where r.order_id = p_order_id)) then
    raise exception 'COMP_REFUND_ORDER_NOT_PAID: only a settled, paid order can be refunded.' using errcode = '22023';
  end if;
  -- PAY-DC-2A: the stored owner is authoritative; missing or conflicting owners refuse (no proof path here).
  select min(ep.stripe_account_id) as account, count(distinct ep.stripe_account_id) as owners,
         count(*) filter (where ep.stripe_account_id is null) as unowned, min(er.id::text)::uuid as registration_id,
         max(ep.currency) as currency
    into v_payment
  from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
  where er.order_id = p_order_id and ep.stripe_payment_intent_id = v_order.stripe_payment_intent_id;
  if v_payment.account is null or v_payment.owners <> 1 or v_payment.unowned > 0 then
    raise exception 'COMP_REFUND_PAYMENT_OWNER_UNVERIFIED: the payment has no single stored Stripe account.' using errcode = '42501';
  end if;

  v_lines := public._r2_validate_lines(p_order_id, p_lines, null);
  select sum((x->>'amountCents')::bigint) into v_total from jsonb_array_elements(v_lines) x;

  insert into public.event_order_refunds (
    event_id, order_id, registration_id, refund_request_id, stripe_account_id, stripe_payment_intent_id,
    amount_cents, currency, status, source, reason, requested_by
  ) values (
    p_event_id, p_order_id, v_payment.registration_id, p_request_id, v_payment.account, v_order.stripe_payment_intent_id,
    v_total, upper(coalesce(v_payment.currency, v_order.currency, 'USD')), 'requested', 'staff', left(btrim(p_reason), 1000), auth.uid()
  ) returning id into v_refund;

  for v_line in select x from jsonb_array_elements(v_lines) x loop
    insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry)
    values (v_refund, p_event_id, p_order_id, (v_line->>'orderItemId')::uuid, nullif(v_line->>'entryId', '')::uuid,
            v_line->>'lineKind', (v_line->>'amountCents')::bigint, (v_line->>'withdrawEntry')::boolean);
  end loop;

  return jsonb_build_object('refundId', v_refund, 'replay', false, 'status', 'requested', 'amountCents', v_total,
    'currency', upper(coalesce(v_payment.currency, v_order.currency, 'USD')),
    'paymentIntentId', v_order.stripe_payment_intent_id, 'stripeAccountId', v_payment.account, 'stripeRefundId', null);
end;
$$;

-- Single writer of Stripe-side refund state (server action response and webhook). Service role only.
create or replace function public.observe_competition_stripe_refund(
  p_payment_intent_id text, p_stripe_account_id text, p_stripe_refund_id text, p_request_id uuid,
  p_amount_cents bigint, p_status text, p_stripe_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.event_orders%rowtype;
  v_payment record;
  v_ref public.event_order_refunds%rowtype;
  v_from text;
  v_allowed boolean;
begin
  if p_payment_intent_id is null then
    return jsonb_build_object('handled', false);
  end if;
  -- Classify before locking: refunds of non-competition orders never take a competition lock.
  select * into v_order from public.event_orders where stripe_payment_intent_id = p_payment_intent_id;
  if not found or not public._r2_order_is_competition(v_order.id) then
    return jsonb_build_object('handled', false);
  end if;
  select * into v_order from public.event_orders where id = v_order.id for update;
  if p_status is null or p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') then
    raise exception 'COMP_REFUND_STATUS_INVALID: %', p_status using errcode = '22023';
  end if;

  -- lock order: order -> registration -> payment -> refund (same as settlement)
  perform 1 from public.event_registrations where order_id = v_order.id for update;
  select ep.id, ep.stripe_account_id, ep.registration_id, ep.currency into v_payment
  from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
  where er.order_id = v_order.id and ep.stripe_payment_intent_id = p_payment_intent_id
  limit 1 for update of ep;
  if v_payment.id is null or v_payment.stripe_account_id is null or v_payment.stripe_account_id is distinct from p_stripe_account_id then
    -- PAY-DC-2A: a refund event from another account never changes this order.
    return jsonb_build_object('handled', true, 'outcome', 'account_mismatch');
  end if;

  if p_stripe_refund_id is not null then
    select * into v_ref from public.event_order_refunds where stripe_refund_id = p_stripe_refund_id for update;
  end if;
  if v_ref.id is null and p_request_id is not null then
    select * into v_ref from public.event_order_refunds
    where refund_request_id = p_request_id and order_id = v_order.id for update;
    if v_ref.id is null then
      raise exception 'COMP_REFUND_REQUEST_UNKNOWN: no refund request % on this order.', p_request_id using errcode = '22023';
    end if;
    if v_ref.stripe_refund_id is not null and p_stripe_refund_id is not null and v_ref.stripe_refund_id <> p_stripe_refund_id then
      raise exception 'COMP_REFUND_STRIPE_ID_CONFLICT: request % is bound to another Stripe refund.', p_request_id using errcode = '22023';
    end if;
  end if;

  if v_ref.id is not null and v_ref.order_id <> v_order.id then
    raise exception 'COMP_REFUND_ORDER_MISMATCH' using errcode = '22023';
  end if;
  if v_ref.id is not null and p_amount_cents is not null and p_amount_cents <> v_ref.amount_cents then
    raise exception 'COMP_REFUND_AMOUNT_MISMATCH: Stripe refund % cents, ledger % cents.', p_amount_cents, v_ref.amount_cents using errcode = '22023';
  end if;

  if v_ref.id is null then
    -- D6: a refund made outside DanceFlow (Stripe dashboard): recorded order-level, unattributed.
    if p_stripe_refund_id is null or p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'COMP_REFUND_OBSERVATION_INCOMPLETE' using errcode = '22023';
    end if;
    insert into public.event_order_refunds (
      event_id, order_id, registration_id, stripe_refund_id, stripe_account_id, stripe_payment_intent_id,
      amount_cents, currency, status, source, last_stripe_event_id, succeeded_at
    ) values (
      v_order.event_id, v_order.id, v_payment.registration_id, p_stripe_refund_id, v_payment.stripe_account_id,
      p_payment_intent_id, p_amount_cents, upper(coalesce(v_payment.currency, v_order.currency, 'USD')), p_status,
      'stripe_dashboard', p_stripe_event_id, case when p_status = 'succeeded' then now() end
    ) returning * into v_ref;
    v_from := null;
  else
    v_from := v_ref.status;
    v_allowed := case
      when v_from = p_status then false
      when v_from = 'requested' then true
      when v_from in ('pending', 'requires_action') then p_status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
      when v_from = 'succeeded' then p_status in ('failed', 'canceled')
      -- A request marked failed/canceled locally (never bound to a Stripe refund) that Stripe now reports: Stripe
      -- is the truth, so the money it moved is always recorded.
      when v_from in ('failed', 'canceled') and v_ref.stripe_refund_id is null and p_stripe_refund_id is not null
        then p_status in ('pending', 'requires_action', 'succeeded')
      else false
    end;
    if not v_allowed then
      if p_stripe_refund_id is not null and v_ref.stripe_refund_id is null then
        update public.event_order_refunds set stripe_refund_id = p_stripe_refund_id, updated_at = now() where id = v_ref.id;
      end if;
      return jsonb_build_object('handled', true, 'outcome', 'no_change', 'refundId', v_ref.id, 'status', v_from);
    end if;
    update public.event_order_refunds
    set status = p_status,
        stripe_refund_id = coalesce(stripe_refund_id, p_stripe_refund_id),
        last_stripe_event_id = coalesce(p_stripe_event_id, last_stripe_event_id),
        succeeded_at = case when p_status = 'succeeded' then coalesce(succeeded_at, now()) else succeeded_at end,
        reversed_at = case when v_from = 'succeeded' and p_status in ('failed', 'canceled') then now() else reversed_at end,
        updated_at = now()
    where id = v_ref.id
    returning * into v_ref;
  end if;

  if v_ref.status = 'succeeded' and v_from is distinct from 'succeeded' then
    perform public._r2_apply_participation(v_ref.id);
    perform public._r2_post_refund_accounting(v_ref.id, false);
    perform public._r2_recompute_order(v_order.id);
    if v_ref.source = 'stripe_dashboard'
       and (select payment_status from public.event_orders where id = v_order.id) <> 'refunded' then
      perform public._r2_record_unattributed(v_ref.id);
    end if;
  elsif v_from = 'succeeded' then
    perform public._r2_post_refund_accounting(v_ref.id, true);
    perform public._r2_recompute_order(v_order.id);
    perform public._r2_record_reversal(v_ref.id);
  end if;

  return jsonb_build_object('handled', true, 'outcome', 'applied', 'refundId', v_ref.id, 'status', v_ref.status, 'previousStatus', v_from);
end;
$$;

-- D6: an unattributed partial refund. Financial-only unless the order has entries held in locked/danced/certified
-- heats (then each such entry gets a competitive scope: attribution could withdraw it).
create or replace function public._r2_record_unattributed(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.event_order_refunds%rowtype;
  v_entry uuid;
begin
  select * into v_r from public.event_order_refunds where id = p_refund_id;
  perform public._r2_record_refund_exception('competition_refund_unattributed', v_r.order_id, v_r.event_id, v_r.registration_id,
                                             v_r.id, null, v_r.amount_cents, v_r.currency);
  for v_entry in
    select e.id from public.event_competition_entries e
    where e.order_id = v_r.order_id and e.status not in ('withdrawn', 'disqualified', 'complete', 'scratched')
      and public._r2_entry_participation_class(e.id) in ('locked', 'certified')
  loop
    perform public._r2_record_refund_exception('competition_refund_unattributed', v_r.order_id, v_r.event_id, v_r.registration_id,
                                               v_r.id, v_entry, v_r.amount_cents, v_r.currency);
  end loop;
end;
$$;

-- E-R: a succeeded refund was reversed. Never re-instates; competitive only for held entries it allocated.
create or replace function public._r2_record_reversal(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.event_order_refunds%rowtype;
  v_entry uuid;
begin
  select * into v_r from public.event_order_refunds where id = p_refund_id;
  perform public._r2_record_refund_exception('competition_refund_reversed', v_r.order_id, v_r.event_id, v_r.registration_id,
                                             v_r.id, null, v_r.amount_cents, v_r.currency);
  for v_entry in
    select distinct a.entry_id from public.event_order_refund_allocations a
    where a.refund_id = p_refund_id and a.entry_id is not null
      and exists (select 1 from public.event_competition_entries ce where ce.id = a.entry_id and ce.status not in ('withdrawn', 'disqualified', 'complete', 'scratched'))
      and public._r2_entry_participation_class(a.entry_id) in ('locked', 'certified')
  loop
    perform public._r2_record_refund_exception('competition_refund_reversed', v_r.order_id, v_r.event_id, v_r.registration_id,
                                               v_r.id, v_entry, v_r.amount_cents, v_r.currency);
  end loop;
end;
$$;

-- Unattributed refunds still open on an order: succeeded dashboard refunds without allocations while the order is
-- not fully refunded.
create or replace function public._r2_unattributed_open(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select payment_status from public.event_orders where id = p_order_id) <> 'refunded'
     and exists (select 1 from public.event_order_refunds r
                 where r.order_id = p_order_id and r.source = 'stripe_dashboard' and r.status = 'succeeded'
                   and not exists (select 1 from public.event_order_refund_allocations a where a.refund_id = r.id));
$$;

-- Close a parent exception when nothing it tracks is open any more.
create or replace function public._r2_maybe_resolve_parent(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_x public.event_order_settlement_exceptions%rowtype;
begin
  select * into v_x from public.event_order_settlement_exceptions where id = p_exception_id for update;
  if v_x.status not in ('open', 'acknowledged') then
    return false;
  end if;
  if exists (select 1 from public.event_competition_refund_exception_scopes where exception_id = p_exception_id and resolved_at is null) then
    return false;
  end if;
  if v_x.kind = 'competition_refund_unattributed' and public._r2_unattributed_open(v_x.order_id) then
    return false;
  end if;
  if v_x.kind = 'competition_refund_reversed' and coalesce(btrim(p_note), '') = '' then
    return false;
  end if;
  update public.event_order_settlement_exceptions
  set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = left(coalesce(p_note, 'All scopes resolved.'), 2000),
      alert_status = case when alert_status in ('pending', 'failed') then 'not_required' else alert_status end,
      alert_next_at = case when alert_status in ('pending', 'failed') then null else alert_next_at end
  where id = p_exception_id;
  insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
  values (p_exception_id, 'resolved', auth.uid(), left(coalesce(p_note, 'All scopes resolved.'), 2000));
  return true;
end;
$$;

-- D6 attribution of an unattributed dashboard refund (D1/D2 caps apply), then participation effects.
create or replace function public.attribute_competition_refund(p_refund_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.event_order_refunds%rowtype;
  v_lines jsonb;
  v_line jsonb;
  v_x uuid;
begin
  select * into v_r from public.event_order_refunds where id = p_refund_id;
  if v_r.id is null or auth.uid() is null or not public._paywh1_actor_can_manage_event(v_r.event_id) then
    raise exception 'COMP_REFUND_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  perform 1 from public.event_orders where id = v_r.order_id for update;
  select * into v_r from public.event_order_refunds where id = p_refund_id for update;
  if v_r.source <> 'stripe_dashboard' or v_r.status <> 'succeeded'
     or exists (select 1 from public.event_order_refund_allocations where refund_id = p_refund_id) then
    raise exception 'COMP_REFUND_NOT_ATTRIBUTABLE: only an unattributed, succeeded dashboard refund can be attributed.' using errcode = '22023';
  end if;
  -- this refund's own amount is already held at order level; validate per-line caps and the exact total
  v_lines := public._r2_validate_lines(v_r.order_id, p_lines, v_r.amount_cents);
  for v_line in select x from jsonb_array_elements(v_lines) x loop
    insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry)
    values (p_refund_id, v_r.event_id, v_r.order_id, (v_line->>'orderItemId')::uuid, nullif(v_line->>'entryId', '')::uuid,
            v_line->>'lineKind', (v_line->>'amountCents')::bigint, (v_line->>'withdrawEntry')::boolean);
  end loop;
  perform public._r2_apply_participation(p_refund_id);

  for v_x in
    select x.id from public.event_order_settlement_exceptions x
    where x.order_id = v_r.order_id and x.kind = 'competition_refund_unattributed' and x.status in ('open', 'acknowledged')
  loop
    if not public._r2_unattributed_open(v_r.order_id) then
      update public.event_competition_refund_exception_scopes
      set resolved_at = now(), resolved_by = auth.uid(), resolution = 'attributed', resolution_note = 'Refund attributed.'
      where exception_id = v_x and resolved_at is null;
    end if;
    insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
    values (v_x, 'attributed', auth.uid(), 'Refund ' || p_refund_id || ' attributed.');
    perform public._r2_maybe_resolve_parent(v_x, 'Unattributed refunds attributed.');
  end loop;
  return jsonb_build_object('refundId', p_refund_id, 'attributed', true);
end;
$$;

-- Section 4.1 E gate, per scope. "Authorized official" = _paywh1_actor_can_manage_exception until E1 adds roles.
create or replace function public.resolve_competition_refund_scope(p_scope_id uuid, p_resolution text, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s public.event_competition_refund_exception_scopes%rowtype;
  v_x public.event_order_settlement_exceptions%rowtype;
  v_entry_status text;
  v_k0 boolean := false;
begin
  select * into v_s from public.event_competition_refund_exception_scopes where id = p_scope_id;
  if v_s.id is null then
    return false;
  end if;
  select * into v_x from public.event_order_settlement_exceptions where id = v_s.exception_id for update;
  if auth.uid() is null or not public._paywh1_actor_can_manage_exception(v_x.event_id, v_x.studio_id) then
    raise exception 'COMP_REFUND_NOT_AUTHORIZED: only studio or organizer owners and admins can resolve.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'COMP_REFUND_REASON_REQUIRED: a resolution note is required.' using errcode = '22023';
  end if;
  select * into v_s from public.event_competition_refund_exception_scopes where id = p_scope_id for update;
  if v_s.resolved_at is not null then
    return false;
  end if;
  select status into v_entry_status from public.event_competition_entries where id = v_s.entry_id;

  if p_resolution = 'withdrawn_after_unlock' then
    if v_s.kind = 'competition_refund_entry_certified_heat' or v_entry_status is null or v_entry_status not in ('withdrawn', 'scratched') then
      raise exception 'COMP_REFUND_SCOPE_GATE: the entry must first be withdrawn or scratched (audited unlock + withdraw, or the SC1 scratch workflow).' using errcode = '22023';
    end if;
  elsif p_resolution = 'keep_entry' then
    if v_s.kind = 'competition_refund_entry_certified_heat' then
      raise exception 'COMP_REFUND_SCOPE_GATE: a certified result is resolved as result_stands or through a K0 correction.' using errcode = '22023';
    end if;
  elsif p_resolution = 'result_stands' then
    if v_s.kind <> 'competition_refund_entry_certified_heat' then
      raise exception 'COMP_REFUND_SCOPE_GATE: result_stands applies only to certified heats.' using errcode = '22023';
    end if;
  elsif p_resolution = 'k0_correction' then
    -- K0 contract (PR 291): a correction runs open_competition_round_correction -> ... and writes
    -- event_competition_result_events. R2 only checks that such a row exists for the scoped round, after this
    -- scope, referencing this exception (refs.refund_exception_id). R2 never writes K0 rows.
    if v_s.kind <> 'competition_refund_entry_certified_heat' or to_regclass('public.event_competition_result_events') is null then
      raise exception 'COMP_REFUND_K0_CORRECTION_UNAVAILABLE: no K0 correction record exists for this round.' using errcode = '22023';
    end if;
    execute 'select exists (select 1 from public.event_competition_result_events
                            where round_id = $1 and "at" > $2 and refs->>''refund_exception_id'' = $3)'
      into v_k0 using v_s.round_id, v_s.created_at, v_x.id::text;
    if not v_k0 then
      raise exception 'COMP_REFUND_K0_CORRECTION_UNAVAILABLE: no K0 correction record exists for this round.' using errcode = '22023';
    end if;
  elsif p_resolution = 'attributed' then
    if v_s.kind <> 'competition_refund_unattributed' or public._r2_unattributed_open(v_x.order_id) then
      raise exception 'COMP_REFUND_SCOPE_GATE: attribute the refund first.' using errcode = '22023';
    end if;
  else
    raise exception 'COMP_REFUND_SCOPE_GATE: unknown resolution %.', p_resolution using errcode = '22023';
  end if;

  update public.event_competition_refund_exception_scopes
  set resolved_at = now(), resolved_by = auth.uid(), resolution = p_resolution, resolution_note = left(btrim(p_note), 2000)
  where id = p_scope_id;
  insert into public.event_order_settlement_exception_events (exception_id, action, actor_user_id, note)
  values (v_x.id, 'scope_resolved', auth.uid(), left(p_resolution || ': ' || btrim(p_note), 2000));
  if v_x.kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat') then
    perform public._r2_maybe_resolve_parent(v_x.id, 'All scopes resolved.');
  end if;
  return true;
end;
$$;

-- Financial-only parents (unattributed, reversed): resolvable with a note once nothing they track is open.
create or replace function public.resolve_competition_refund_exception(p_exception_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_x public.event_order_settlement_exceptions%rowtype;
begin
  select * into v_x from public.event_order_settlement_exceptions where id = p_exception_id;
  if v_x.id is null or v_x.kind not like 'competition\_refund\_%' then
    return false;
  end if;
  if auth.uid() is null or not public._paywh1_actor_can_manage_exception(v_x.event_id, v_x.studio_id) then
    raise exception 'COMP_REFUND_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'COMP_REFUND_REASON_REQUIRED: a resolution note is required.' using errcode = '22023';
  end if;
  if exists (select 1 from public.event_competition_refund_exception_scopes where exception_id = p_exception_id and resolved_at is null) then
    raise exception 'COMP_REFUND_SCOPE_GATE: resolve every entry scope first.' using errcode = '22023';
  end if;
  if v_x.kind = 'competition_refund_unattributed' and public._r2_unattributed_open(v_x.order_id) then
    raise exception 'COMP_REFUND_SCOPE_GATE: attribute the refund first.' using errcode = '22023';
  end if;
  return public._r2_maybe_resolve_parent(p_exception_id, btrim(p_note));
end;
$$;

-- Webhook routing helper: is this PaymentIntent a competition order's?
create or replace function public.is_competition_order_payment_intent(p_payment_intent_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.event_orders eo
                 where eo.stripe_payment_intent_id = p_payment_intent_id and public._r2_order_is_competition(eo.id));
$$;

-- ===========================================================================================================
-- 6. Registration cascade (Section 1 of the earlier R2 commits, now with E-L / E-C recording)
-- ===========================================================================================================
create or replace function public.sync_competition_entries_from_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held record;
begin
  if new.status = 'cancelled' or new.payment_status in ('failed', 'refunded') then
    perform set_config('app.competition_entry_change_type', 'withdraw', true);
    perform set_config(
      'app.competition_entry_change_reason',
      case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end,
      true
    );
    perform set_config(
      'app.competition_entry_fee_handling',
      case when new.payment_status = 'refunded' then 'refund' else 'retain' end,
      true
    );
    -- R2: scratch the open placements of exactly the entries withdrawn here (none of them is in a locked or
    -- certified heat), as change_competition_entry_lifecycle does.
    with withdrawn as (
      update public.event_competition_entries
      set
        status = 'withdrawn',
        withdrawn_at = coalesce(withdrawn_at, now()),
        withdrawal_reason = coalesce(
          withdrawal_reason,
          case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end
        ),
        lifecycle_version = lifecycle_version + 1,
        updated_at = now()
      where registration_id = new.id
        and status not in ('withdrawn', 'disqualified', 'complete', 'scratched')
        and not exists (
          select 1
          from public.event_competition_heat_entries he
          join public.event_competition_heats h on h.id = he.heat_id
          where he.entry_id = event_competition_entries.id and h.lock_state in ('locked', 'certified')
        )
        -- R2 / owner Q1: once the entry has danced, it is never withdrawn automatically, even if the heat is not locked.
        -- "Danced" = a placement marked danced, or a placement (not scratched) in a heat on the floor (active /
        -- complete) -- the same rule as SC1, because nothing marks placements 'danced' yet.
        and not exists (
          select 1 from public.event_competition_heat_entries he
          join public.event_competition_heats h on h.id = he.heat_id
          where he.entry_id = event_competition_entries.id
            and (he.status in ('danced', 'disqualified') or (h.status in ('active', 'complete') and he.status <> 'scratched'))
        )
      returning id
    )
    update public.event_competition_heat_entries he
    set status = 'scratched', updated_at = now()
    from withdrawn w
    where he.entry_id = w.id and he.status in ('scheduled', 'checked_in');

    -- R2 / owner policy 3-4: entries the cascade must not touch are never skipped silently.
    for v_held in
      select e.id, public._r2_entry_participation_class(e.id) as cls
      from public.event_competition_entries e
      where e.registration_id = new.id and e.status not in ('withdrawn', 'disqualified', 'complete', 'scratched')
    loop
      if v_held.cls in ('locked', 'certified') then
        perform public._r2_record_refund_exception(
          case when v_held.cls = 'certified' then 'competition_refund_entry_certified_heat' else 'competition_refund_entry_locked_heat' end,
          new.order_id, new.event_id, new.id, null, v_held.id, null, null);
      end if;
    end loop;
    return new;
  end if;

  if new.status in ('confirmed', 'registered', 'checked_in', 'attended')
    and coalesce(new.payment_status, '') in ('paid', 'partial', 'comped', 'free', 'waived') then
    update public.event_competition_entries
    set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
    where registration_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

-- ===========================================================================================================
-- 7. Grants and postflight
-- ===========================================================================================================
revoke all on function public.sync_competition_entries_from_registration() from public;
revoke all on function public._r2_event_payment_is_competition(uuid, text, text) from public, anon, authenticated;
revoke all on function public._r2_post_refund_accounting(uuid, boolean) from public, anon, authenticated;
revoke all on function public._r2_order_is_competition(uuid) from public, anon, authenticated;
revoke all on function public._r2_order_line_caps(uuid) from public, anon, authenticated;
revoke all on function public._r2_entry_participation_class(uuid) from public, anon, authenticated;
revoke all on function public._r2_record_refund_exception(text, uuid, uuid, uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public._r2_withdraw_entry(uuid, text, text) from public, anon, authenticated;
revoke all on function public._r2_apply_participation(uuid) from public, anon, authenticated;
revoke all on function public._r2_recompute_order(uuid) from public, anon, authenticated;
revoke all on function public._r2_validate_lines(uuid, jsonb, bigint) from public, anon, authenticated;
revoke all on function public._r2_record_unattributed(uuid) from public, anon, authenticated;
revoke all on function public._r2_record_reversal(uuid) from public, anon, authenticated;
revoke all on function public._r2_unattributed_open(uuid) from public, anon, authenticated;
revoke all on function public._r2_maybe_resolve_parent(uuid, text) from public, anon, authenticated;
revoke all on function public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text) to authenticated;
revoke all on function public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text) to service_role;
revoke all on function public.is_competition_order_payment_intent(text) from public, anon, authenticated;
grant execute on function public.is_competition_order_payment_intent(text) to service_role;
revoke all on function public.attribute_competition_refund(uuid, jsonb) from public, anon;
grant execute on function public.attribute_competition_refund(uuid, jsonb) to authenticated;
revoke all on function public.resolve_competition_refund_scope(uuid, text, text) from public, anon;
grant execute on function public.resolve_competition_refund_scope(uuid, text, text) to authenticated;
revoke all on function public.resolve_competition_refund_exception(uuid, text) from public, anon;
grant execute on function public.resolve_competition_refund_exception(uuid, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'sync_competition_entries_from_registration'
                 and tgrelid = 'public.event_registrations'::regclass and not tgisinternal) then
    raise exception 'R2 postflight: the registration -> competition entry trigger is missing.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_sync_event_payment_accounting_entry'
                 and tgrelid = 'public.event_payments'::regclass and not tgisinternal) then
    raise exception 'R2 postflight: the event payment accounting trigger is missing.';
  end if;
  if has_function_privilege('anon', 'public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text)', 'EXECUTE') then
    raise exception 'R2 postflight: observe_competition_stripe_refund must be service-role only.';
  end if;
end $$;

commit;
