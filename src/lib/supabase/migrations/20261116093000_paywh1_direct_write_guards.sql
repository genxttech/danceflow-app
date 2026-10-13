-- PAY-WH-1 M4 -- Database guards: client roles cannot forge or bypass Stripe-controlled settlement of order-backed
-- registrations.
--
-- Order-backed registrations (event_registrations.order_id is not null) are created, held, paid and released only
-- by the server through the locked lifecycle functions (20261116092000). Before this migration the RLS policies let
-- studio staff and organizers (client roles via PostgREST) change payment_status, confirm unpaid holds (the attendance
-- action did this), write payment rows, and add ticket attendees beyond what was paid.
--
-- Guards apply only to the client roles (anon / authenticated), exactly like the existing Stripe identity guards
-- (20260929090000). Server code (service_role) and security-definer functions are unaffected. Orderless box-office
-- sales, comps and manual registrations (order_id is null) keep their existing behaviour.
--
-- Rollback: rollback/20261116093000_paywh1_direct_write_guards_rollback.sql (re-opens the bypass; see its header).

begin;

-- The guards run as the caller (that is how they recognise client roles), so their lookups go through this definer
-- helper: RLS must not be able to hide an order-backed registration from its own guard.
create or replace function public._paywh1_registration_order_facts(p_registration_id uuid)
returns table (order_backed boolean, payment_status text, status text, entitlement integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select er.order_id is not null, er.payment_status, er.status,
         greatest(coalesce(er.quantity, 1), 1) * greatest(coalesce(ett.attendees_per_ticket, 1), 1)
  from public.event_registrations er
  left join public.event_ticket_types ett on ett.id = er.ticket_type_id
  where er.id = p_registration_id;
$$;

create or replace function public._paywh1_registration_attendee_count(p_registration_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.event_registration_attendees where registration_id = p_registration_id;
$$;

create or replace function public._paywh1_guard_order_registration_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    if new.order_id is not null then
      raise exception 'Order-backed event registrations are created only by checkout.' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.order_id is not null then
      raise exception 'Order-backed event registrations cannot be deleted directly.' using errcode = '42501';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.order_id is null and new.order_id is null then
    return new;
  end if;
  if new.order_id is distinct from old.order_id then
    raise exception 'The order of an event registration cannot be changed.' using errcode = '42501';
  end if;
  if new.payment_status is distinct from old.payment_status then
    raise exception 'Payment status of an order-backed registration is set only by payment settlement.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if new.status in ('confirmed', 'checked_in', 'attended') and new.payment_status <> 'paid' then
      raise exception 'An unpaid order-backed registration cannot be confirmed.' using errcode = '42501';
    end if;
    if new.status = 'pending' then
      raise exception 'An order-backed registration cannot be returned to a pending hold.' using errcode = '42501';
    end if;
    if old.status in ('cancelled', 'refunded') then
      raise exception 'A cancelled order-backed registration cannot be reinstated directly.' using errcode = '42501';
    end if;
  end if;
  if new.quantity is distinct from old.quantity
     or new.ticket_type_id is distinct from old.ticket_type_id
     or new.unit_price is distinct from old.unit_price
     or new.total_price is distinct from old.total_price
     or new.total_amount is distinct from old.total_amount then
    raise exception 'Quantity, ticket type and price of an order-backed registration are fixed at checkout.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_paywh1_guard_order_registration_writes on public.event_registrations;
create trigger trg_paywh1_guard_order_registration_writes
  before insert or update or delete on public.event_registrations
  for each row execute function public._paywh1_guard_order_registration_writes();

create or replace function public._paywh1_guard_order_payment_rows()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  if (tg_op in ('INSERT', 'UPDATE') and exists (
        select 1 from public._paywh1_registration_order_facts(new.registration_id) f where f.order_backed))
     or (tg_op in ('UPDATE', 'DELETE') and exists (
        select 1 from public._paywh1_registration_order_facts(old.registration_id) f where f.order_backed)) then
    raise exception 'Payment records of order-backed registrations are written only by payment settlement.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_paywh1_guard_order_payment_rows on public.event_payments;
create trigger trg_paywh1_guard_order_payment_rows
  before insert or update or delete on public.event_payments
  for each row execute function public._paywh1_guard_order_payment_rows();

-- Ticket entitlements: staff may backfill missing attendee tickets of a PAID order-backed registration up to what was
-- paid for, and may edit names / check-in fields; they cannot add tickets to unpaid holds, exceed the paid
-- entitlement, or move tickets between registrations.
create or replace function public._paywh1_guard_order_attendee_writes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_reg record;
  v_existing integer;
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    if new.registration_id is distinct from old.registration_id then
      raise exception 'A ticket cannot be moved to another registration.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select f.order_backed, f.payment_status, f.status, f.entitlement into v_reg
  from public._paywh1_registration_order_facts(new.registration_id) f;

  if not found or not v_reg.order_backed then
    return new;
  end if;
  if v_reg.payment_status <> 'paid' or v_reg.status in ('cancelled', 'refunded') then
    raise exception 'Tickets cannot be added to an unpaid or cancelled order-backed registration.' using errcode = '42501';
  end if;
  v_existing := public._paywh1_registration_attendee_count(new.registration_id);
  if v_existing + 1 > v_reg.entitlement then
    raise exception 'This registration already has every ticket it paid for.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_paywh1_guard_order_attendee_writes on public.event_registration_attendees;
create trigger trg_paywh1_guard_order_attendee_writes
  before insert or update or delete on public.event_registration_attendees
  for each row execute function public._paywh1_guard_order_attendee_writes();

-- The helpers must be callable by the client roles from inside the guard triggers; they expose only whether it is order-backed,
-- payment status and entitlement count of a registration id the caller already supplied in its own write.
revoke all on function public._paywh1_registration_order_facts(uuid) from public;
revoke all on function public._paywh1_registration_attendee_count(uuid) from public;
grant execute on function public._paywh1_registration_order_facts(uuid) to anon, authenticated, service_role;
grant execute on function public._paywh1_registration_attendee_count(uuid) to anon, authenticated, service_role;
revoke all on function public._paywh1_guard_order_registration_writes() from public, anon, authenticated;
revoke all on function public._paywh1_guard_order_payment_rows() from public, anon, authenticated;
revoke all on function public._paywh1_guard_order_attendee_writes() from public, anon, authenticated;

commit;
