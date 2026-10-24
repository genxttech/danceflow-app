-- rollback/20270103090000_competition_r2_entry_refunds_rollback.sql
--
-- Reverts 20270103090000_competition_r2_entry_refunds.sql. Generated from the verbatim prior repo definitions:
--   sync_competition_entries_from_registration  <- 20261107090000 (10A, md5 fabd4052...)
--   sync_event_payment_accounting_entry         <- 20261109090000 (10C, md5 7dc2d16f...)
--   _paywh1_exception_money_state               <- 20261116094000 (PAY-WH-1A, md5 5bb0940b...)
--   resolve_event_order_settlement_exception    <- 20261116094000 (PAY-WH-1A, md5 d0b30516...)
--
-- Refuses, changing nothing, when any refund ledger row, competition_refund_* exception or competition_entry_refund
-- accounting entry exists: refund evidence is never dropped silently. In that case roll back the APPLICATION first
-- (stop the staff refund UI and the webhook branch) and keep the SQL; reconcile by hand before any SQL rollback.
-- Also refuses unless every redefined function is still the R2 body (never overwrites a later redefinition).
-- Data written while R2 was live (withdrawn entries, scratched placements) is not reverted.

begin;
set local lock_timeout = '10s';

do $$
declare
  v_pin record;
begin
  for v_pin in
    select * from (values
      ('public.sync_competition_entries_from_registration()', '3a19d4b44ecf7d78e74bee5527caf512'),
      ('public.sync_event_payment_accounting_entry()', '4577dc12f2193f7beb63dd47f5e798e9'),
      ('public._paywh1_exception_money_state(text)', '5469516fd431fe5bdbf6b8c5c0a6859e'),
      ('public.resolve_event_order_settlement_exception(uuid,text)', 'dd85d688d2423eb26aa1873d18852100')
    ) as p(sig, md5)
  loop
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = to_regprocedure(v_pin.sig)) is distinct from v_pin.md5 then
      raise exception 'R2 rollback preflight: % is not the R2 definition.', v_pin.sig;
    end if;
  end loop;
  if to_regclass('public.event_competition_scratches') is not null then
    raise exception 'R2 rollback refused: SC1 (scratch workflow) is still applied; roll SC1 back first (the 10A cascade this rollback restores does not know scratched entries).';
  end if;
  if exists (select 1 from public.event_order_refunds) then
    raise exception 'R2 rollback refused: refund ledger rows exist (roll back the application first; keep the SQL).';
  end if;
  if exists (select 1 from public.event_order_settlement_exceptions where kind like 'competition\_refund\_%') then
    raise exception 'R2 rollback refused: competition refund exceptions exist.';
  end if;
  if exists (select 1 from public.accounting_entries where category = 'competition_entry_refund') then
    raise exception 'R2 rollback refused: competition_entry_refund accounting entries exist.';
  end if;
end $$;

-- Functions and tables created by R2
drop function public.resolve_competition_refund_exception(uuid, text);
drop function public.resolve_competition_refund_scope(uuid, text, text);
drop function public.attribute_competition_refund(uuid, jsonb);
drop function public.observe_competition_stripe_refund(text, text, text, uuid, bigint, text, text);
drop function public.request_competition_order_refund(uuid, uuid, uuid, jsonb, text);
drop function public.is_competition_order_payment_intent(text);
drop function public._r2_maybe_resolve_parent(uuid, text);
drop function public._r2_unattributed_open(uuid);
drop function public._r2_record_reversal(uuid);
drop function public._r2_record_unattributed(uuid);
drop function public._r2_validate_lines(uuid, jsonb, bigint);
drop function public._r2_recompute_order(uuid);
drop function public._r2_apply_participation(uuid);
drop function public._r2_withdraw_entry(uuid, text, text);
drop function public._r2_post_refund_accounting(uuid, boolean);

-- Prior bodies (verbatim). The registration trigger and the accounting trigger stop calling R2 helpers first.
create or replace function public.sync_competition_entries_from_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
      and status not in ('withdrawn', 'disqualified', 'complete')
      and not exists (
        select 1
        from public.event_competition_heat_entries he
        join public.event_competition_heats h on h.id = he.heat_id
        where he.entry_id = event_competition_entries.id and h.lock_state in ('locked', 'certified')
      );
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

revoke all on function public.sync_competition_entries_from_registration() from public;

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

  if new.status::text is distinct from 'paid' then
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
  v_refund_amount := coalesce(new.refund_amount, 0);
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
    else 'informational'
  end;
$$;

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

drop function public._r2_record_refund_exception(text, uuid, uuid, uuid, uuid, uuid, bigint, text);
drop function public._r2_entry_participation_class(uuid);
drop function public._r2_order_line_caps(uuid);
drop function public._r2_order_is_competition(uuid);
drop function public._r2_event_payment_is_competition(uuid, text, text);

drop table public.event_competition_refund_exception_scopes;
drop function public._r2_protect_exception_scopes();
drop table public.event_order_refund_allocations;
drop table public.event_order_refunds;
drop function public._r2_protect_refund_ledger();

delete from public.accounting_categories where key = 'competition_entry_refund';

alter table public.event_order_settlement_exception_events drop constraint event_order_settlement_exception_events_action_check;
alter table public.event_order_settlement_exception_events add constraint event_order_settlement_exception_events_action_check
  check (action in ('recorded', 'recurred', 'alert_sent', 'alert_failed', 'acknowledged', 'resolved'));

do $$
declare
  v_pin record;
begin
  for v_pin in
    select * from (values
      ('public.sync_competition_entries_from_registration()', 'fabd4052257f261e300ccc1f191c4cdb'),
      ('public.sync_event_payment_accounting_entry()', '7dc2d16ffb20b1a0fb472711eb86670c'),
      ('public._paywh1_exception_money_state(text)', '5bb0940bb4b22243206a59cc9e5998c9'),
      ('public.resolve_event_order_settlement_exception(uuid,text)', 'd0b3051696238b4867118e21b0ff928f')
    ) as p(sig, md5)
  loop
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = to_regprocedure(v_pin.sig)) is distinct from v_pin.md5 then
      raise exception 'R2 rollback postflight: % was not restored.', v_pin.sig;
    end if;
  end loop;
end $$;

commit;
