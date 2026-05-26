-- Event Digital Tickets / Check-In Codes V1
-- Adds unique human-entered ticket codes to event registration attendees.
-- V1 supports manual code lookup at check-in. QR rendering/scanning can build on ticket_token later.

create extension if not exists pgcrypto;

alter table public.event_registration_attendees
  add column if not exists ticket_code text,
  add column if not exists ticket_token text,
  add column if not exists ticket_issued_at timestamptz;

create unique index if not exists uq_event_registration_attendees_ticket_code
  on public.event_registration_attendees (ticket_code)
  where ticket_code is not null;

create unique index if not exists uq_event_registration_attendees_ticket_token
  on public.event_registration_attendees (ticket_token)
  where ticket_token is not null;

create or replace function public.generate_event_ticket_code()
returns text
language plpgsql
as $$
declare
  candidate text;
begin
  loop
    candidate := 'DF-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));
    exit when not exists (
      select 1
      from public.event_registration_attendees era
      where era.ticket_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function public.set_event_attendee_ticket_code()
returns trigger
language plpgsql
as $$
begin
  if new.ticket_code is null or btrim(new.ticket_code) = '' then
    new.ticket_code := public.generate_event_ticket_code();
  else
    new.ticket_code := upper(regexp_replace(btrim(new.ticket_code), '\s+', '', 'g'));
  end if;

  if new.ticket_token is null or btrim(new.ticket_token) = '' then
    new.ticket_token := encode(gen_random_bytes(24), 'hex');
  end if;

  if new.ticket_issued_at is null then
    new.ticket_issued_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_event_attendee_ticket_code on public.event_registration_attendees;

create trigger trg_set_event_attendee_ticket_code
before insert on public.event_registration_attendees
for each row
execute function public.set_event_attendee_ticket_code();

-- Backfill existing attendees in a safe row-by-row loop so each attendee gets a distinct code.
do $$
declare
  attendee record;
begin
  for attendee in
    select id
    from public.event_registration_attendees
    where ticket_code is null
       or ticket_token is null
       or ticket_issued_at is null
    order by created_at asc, id asc
  loop
    update public.event_registration_attendees
    set
      ticket_code = coalesce(ticket_code, public.generate_event_ticket_code()),
      ticket_token = coalesce(ticket_token, encode(gen_random_bytes(24), 'hex')),
      ticket_issued_at = coalesce(ticket_issued_at, now()),
      updated_at = coalesce(updated_at, now())
    where id = attendee.id;
  end loop;
end;
$$;
