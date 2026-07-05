-- Event Ticket Capacity Holds V2
-- Treats pending registrations tied to unexpired event_orders as ticket holds.
-- The trigger locks the ticket type row before counting so concurrent checkouts
-- cannot oversell the same limited-capacity ticket.

begin;

create index if not exists idx_event_registrations_ticket_capacity_active
on public.event_registrations (ticket_type_id, status, payment_status, order_id)
where ticket_type_id is not null;

create index if not exists idx_event_orders_capacity_hold_status
on public.event_orders (id, expires_at, status, payment_status);

create or replace function public.enforce_event_ticket_capacity_holds()
returns trigger
language plpgsql
as $$
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
$$;

drop trigger if exists trg_enforce_event_ticket_capacity_holds
on public.event_registrations;

create trigger trg_enforce_event_ticket_capacity_holds
before insert or update of ticket_type_id, quantity, status, payment_status, order_id
on public.event_registrations
for each row
execute function public.enforce_event_ticket_capacity_holds();

create or replace function public.expire_event_ticket_holds()
returns table(expired_orders integer, expired_registrations integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  expired_order_ids uuid[];
  registration_count integer := 0;
  order_count integer := 0;
begin
  select coalesce(array_agg(id), '{}'::uuid[])
  into expired_order_ids
  from public.event_orders
  where status = 'pending'
    and payment_status = 'pending'
    and expires_at is not null
    and expires_at <= now();

  if array_length(expired_order_ids, 1) is null then
    return query select 0, 0;
    return;
  end if;

  update public.event_registrations
  set
    status = 'cancelled',
    payment_status = 'failed',
    cancelled_at = coalesce(cancelled_at, now())
  where order_id = any(expired_order_ids)
    and status = 'pending'
    and payment_status = 'pending';

  get diagnostics registration_count = row_count;

  update public.event_orders
  set
    status = 'expired',
    payment_status = 'failed',
    cancelled_at = coalesce(cancelled_at, now())
  where id = any(expired_order_ids)
    and status = 'pending'
    and payment_status = 'pending';

  get diagnostics order_count = row_count;

  return query select order_count, registration_count;
end;
$$;

notify pgrst, 'reload schema';

commit;
