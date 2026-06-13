-- Public Event Multi-Ticket Cart V1
-- Allows repeat completed purchases by the same email while preserving protection against stale pending cart duplicates.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'uq_event_registrations_event_ticket_email_active'
      and conrelid = 'public.event_registrations'::regclass
  ) then
    alter table public.event_registrations
      drop constraint uq_event_registrations_event_ticket_email_active;
  end if;
end $$;

drop index if exists public.uq_event_registrations_event_ticket_email_active;

create unique index if not exists uq_event_registrations_event_ticket_email_pending_cart
on public.event_registrations (
  event_id,
  ticket_type_id,
  lower(attendee_email)
)
where status = 'pending'
  and payment_status = 'pending'
  and order_id is not null
  and ticket_type_id is not null;
