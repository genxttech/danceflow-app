-- Rollback of 20261116092000_paywh1_event_cart_settlement.sql.
--
-- Preconditions (the script refuses otherwise):
--   * the PAY-WH-1 application has already been rolled back (app first, then SQL);
--   * no order is mid-lifecycle (settlement_state 'releasing' or 'processing') -- finish or reconcile them first;
--   * every settlement exception has been reviewed (open exceptions are actionable records of real money).
--
-- Data that is NOT restored by this rollback: payment attempts (event_order_payment_attempts), settlement exceptions
-- and the lifecycle columns on event_orders are dropped. Settled orders, registrations and payment rows are kept as
-- they are. expire_event_ticket_holds() stays revoked from client roles (a security fix kept on rollback). Once real settlements exist on PROD, prefer leaving this migration in place (the pre-PAY-WH-1 application
-- runs correctly against it) over rolling it back.

begin;

do $$
begin
  if exists (select 1 from public.event_orders where settlement_state in ('releasing', 'processing')
             and status = 'pending' and payment_status = 'pending') then
    raise exception 'paywh1 rollback refused: orders are releasing/processing; reconcile them first';
  end if;
  if exists (select 1 from public.event_order_settlement_exceptions where status = 'open') then
    raise exception 'paywh1 rollback refused: open settlement exceptions must be reviewed first';
  end if;
end $$;

drop function if exists public.record_event_cart_payment_attempt(uuid, text, text, text, text, bigint, text, text, timestamptz);
drop function if exists public.extend_event_cart_order_hold(uuid, timestamptz);
drop function if exists public.settle_event_cart_order(text, text, uuid, text, text, text, bigint, text);
drop function if exists public.mark_event_cart_order_processing(text, text, uuid, text, text, text, bigint, text, timestamptz);
drop function if exists public.fail_event_cart_payment_attempt(text, text, uuid, text, text, text, boolean, text, text);
drop function if exists public.begin_event_cart_order_release(uuid, text);
drop function if exists public.finalize_event_cart_order_release(uuid, jsonb, text);
drop function if exists public.release_unattempted_event_cart_orders(uuid, text, uuid);
drop function if exists public.list_event_cart_orders_due_for_reconcile(integer);
drop function if exists public.resolve_event_order_settlement_exception(uuid, text);
drop function if exists public._paywh1_bootstrap_legacy_attempts(uuid);
drop function if exists public._paywh1_resolve_attempt(text, text, text);
drop function if exists public._paywh1_release_order(uuid, text);
drop function if exists public._paywh1_record_exception(uuid, text, text, text, text, text, bigint, text, jsonb);
drop function if exists public._paywh1_effective_state(text, text, text);

drop policy if exists event_order_settlement_exceptions_manager_select on public.event_order_settlement_exceptions;
drop table if exists public.event_order_settlement_exceptions;
drop function if exists public._paywh1_actor_can_manage_event(uuid);
drop table if exists public.event_order_payment_attempts;

drop index if exists public.event_orders_stripe_payment_intent_id_uidx;
alter table public.event_orders drop constraint if exists event_orders_settlement_state_check;
alter table public.event_orders
  drop column if exists settlement_state,
  drop column if exists settlement_state_changed_at,
  drop column if exists release_requested_at,
  drop column if exists released_at,
  drop column if exists processing_since,
  drop column if exists settled_by_event_id;

-- Restore the pre-PAY-WH-1 capacity trigger function exactly as DEV stores it (PROD must be fingerprinted the same way
-- before any PROD rollback): the 20260704 migration was
-- applied from a CRLF file, so the original function body has CRLF line endings. Rebuilding it by replacing every
-- LF with CRLF (see the replace call below) makes
-- the restored prosrc byte-identical (md5 9a994b55df9c668dbf4a9c40f5f471f9 on DEV), independent of this file's
-- own line endings.
do $rb$
begin
  execute replace($ddl$create or replace function public.enforce_event_ticket_capacity_holds()
returns trigger
language plpgsql
as $fn$
declare
  ticket_capacity integer;
  reserved_admissions integer;
  requested_admissions integer;
  admits_per_ticket integer;
begin
  if new.ticket_type_id is null then
    return new;
  end if;

  select
    ett.capacity,
    greatest(coalesce(ett.attendees_per_ticket, 1), 1)
  into
    ticket_capacity,
    admits_per_ticket
  from public.event_ticket_types ett
  where ett.id = new.ticket_type_id
  for update;

  if ticket_capacity is null then
    return new;
  end if;

  requested_admissions := greatest(coalesce(new.quantity, 1), 1) * admits_per_ticket;

  select coalesce(
    sum(
      greatest(coalesce(er.quantity, 1), 1)
      * greatest(coalesce(ett.attendees_per_ticket, 1), 1)
    ),
    0
  )
  into reserved_admissions
  from public.event_registrations er
  join public.event_ticket_types ett
    on ett.id = er.ticket_type_id
  left join public.event_orders eo
    on eo.id = er.order_id
  where er.ticket_type_id = new.ticket_type_id
    and er.id is distinct from new.id
    and (
      er.payment_status = 'paid'
      or er.status in ('confirmed', 'checked_in', 'attended')
      or (
        er.status = 'pending'
        and er.payment_status = 'pending'
        and er.order_id is not null
        and eo.status = 'pending'
        and eo.payment_status = 'pending'
        and (eo.expires_at is null or eo.expires_at > now())
      )
    );

  if reserved_admissions + requested_admissions > ticket_capacity then
    raise exception
      'Selected ticket quantity is no longer available. % admission spot(s) remain.',
      greatest(ticket_capacity - reserved_admissions, 0)
      using errcode = 'P0001';
  end if;

  return new;
end;
$fn$
$ddl$, E'\n', E'\r\n');
end
$rb$;

notify pgrst, 'reload schema';

commit;
