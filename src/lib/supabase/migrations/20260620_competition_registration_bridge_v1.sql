-- Competition Registration Bridge V1
-- Connects competition entries to the existing event order, registration, and attendee flow.
-- Save in: src/lib/supabase/migrations/20260620_competition_registration_bridge_v1.sql

begin;

alter table public.event_competition_entries
  add column if not exists order_id uuid references public.event_orders(id) on delete set null,
  add column if not exists registration_channel text not null default 'staff_manual',
  add column if not exists registering_studio_id uuid references public.studios(id) on delete set null,
  add column if not exists submitted_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists scratched_at timestamptz,
  add column if not exists scratch_reason text;

alter table public.event_competition_entries
  drop constraint if exists event_competition_entries_registration_channel_check;
alter table public.event_competition_entries
  add constraint event_competition_entries_registration_channel_check
  check (registration_channel in ('student_self', 'studio', 'staff_manual', 'import'));

create index if not exists event_competition_entries_order_idx
  on public.event_competition_entries(order_id)
  where order_id is not null;
create index if not exists event_competition_entries_registration_idx
  on public.event_competition_entries(registration_id)
  where registration_id is not null;
create index if not exists event_competition_entries_ready_for_heats_idx
  on public.event_competition_entries(event_id, division_id, status, eligibility_status);

create table if not exists public.event_competition_entry_dances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  entry_id uuid not null,
  dance_key text not null,
  dance_label text not null,
  fee_amount numeric(10, 2) not null default 0,
  currency text not null default 'USD',
  status text not null default 'registered',
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_competition_entry_dances_entry_fk
    foreign key (entry_id, event_id)
    references public.event_competition_entries(id, event_id)
    on delete cascade,
  constraint event_competition_entry_dances_key_check
    check (length(btrim(dance_key)) between 1 and 100),
  constraint event_competition_entry_dances_label_check
    check (length(btrim(dance_label)) between 1 and 160),
  constraint event_competition_entry_dances_fee_check
    check (fee_amount >= 0),
  constraint event_competition_entry_dances_status_check
    check (status in ('registered', 'confirmed', 'scratched', 'advanced', 'complete')),
  unique (entry_id, dance_key)
);

create index if not exists event_competition_entry_dances_event_idx
  on public.event_competition_entry_dances(event_id, dance_key, status);

drop trigger if exists set_event_competition_updated_at
  on public.event_competition_entry_dances;
create trigger set_event_competition_updated_at
before update on public.event_competition_entry_dances
for each row execute function public.set_event_competition_updated_at();

alter table public.event_competition_entry_dances enable row level security;
drop policy if exists competition_manage on public.event_competition_entry_dances;
create policy competition_manage
  on public.event_competition_entry_dances
  for all
  to authenticated
  using (public.can_manage_event_competition(event_id))
  with check (public.can_manage_event_competition(event_id));

alter table public.event_order_items
  drop constraint if exists event_order_items_item_type_check;
alter table public.event_order_items
  add constraint event_order_items_item_type_check
  check (item_type in ('ticket', 'coach_slot', 'competition_entry', 'add_on'));

create or replace function public.validate_competition_entry_registration_links()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_registration_event_id uuid;
  linked_registration_order_id uuid;
  linked_order_event_id uuid;
begin
  if new.registration_id is not null then
    select er.event_id, er.order_id
    into linked_registration_event_id, linked_registration_order_id
    from public.event_registrations er
    where er.id = new.registration_id;

    if linked_registration_event_id is distinct from new.event_id then
      raise exception 'Competition entry registration belongs to a different event.';
    end if;
  end if;

  if new.order_id is not null then
    select eo.event_id
    into linked_order_event_id
    from public.event_orders eo
    where eo.id = new.order_id;

    if linked_order_event_id is distinct from new.event_id then
      raise exception 'Competition entry order belongs to a different event.';
    end if;
  end if;

  if new.registration_id is not null
    and new.order_id is not null
    and linked_registration_order_id is distinct from new.order_id then
    raise exception 'Competition entry registration does not belong to the selected order.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_competition_entry_registration_links
  on public.event_competition_entries;
create trigger validate_competition_entry_registration_links
before insert or update of event_id, registration_id, order_id
on public.event_competition_entries
for each row execute function public.validate_competition_entry_registration_links();

create or replace function public.validate_competition_participant_attendee_link()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_attendee_event_id uuid;
begin
  if new.registration_attendee_id is null then
    return new;
  end if;

  select era.event_id
  into linked_attendee_event_id
  from public.event_registration_attendees era
  where era.id = new.registration_attendee_id;

  if linked_attendee_event_id is distinct from new.event_id then
    raise exception 'Competition participant attendee belongs to a different event.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_competition_participant_attendee_link
  on public.event_competition_entry_participants;
create trigger validate_competition_participant_attendee_link
before insert or update of event_id, registration_attendee_id
on public.event_competition_entry_participants
for each row execute function public.validate_competition_participant_attendee_link();

create or replace function public.sync_competition_entries_from_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled'
    or new.payment_status in ('failed', 'refunded') then
    update public.event_competition_entries
    set
      status = 'withdrawn',
      scratched_at = coalesce(scratched_at, now()),
      scratch_reason = coalesce(scratch_reason, 'Source registration was cancelled or refunded.'),
      updated_at = now()
    where registration_id = new.id
      and status not in ('withdrawn', 'disqualified', 'complete');

    return new;
  end if;

  if new.status in ('confirmed', 'registered', 'checked_in', 'attended')
    and coalesce(new.payment_status, '') in ('paid', 'partial', 'comped', 'free', 'waived') then
    update public.event_competition_entries
    set
      status = 'confirmed',
      confirmed_at = coalesce(confirmed_at, now()),
      updated_at = now()
    where registration_id = new.id
      and status = 'pending';
  end if;

  return new;
end;
$$;

revoke all on function public.sync_competition_entries_from_registration() from public;

drop trigger if exists sync_competition_entries_from_registration
  on public.event_registrations;
create trigger sync_competition_entries_from_registration
after update of status, payment_status
on public.event_registrations
for each row execute function public.sync_competition_entries_from_registration();

comment on column public.event_competition_entries.registration_channel is
  'How the registration was submitted: student self-service, studio, staff-assisted, or import.';
comment on table public.event_competition_entry_dances is
  'Dance/style selections purchased or requested for one competition entry.';

notify pgrst, 'reload schema';

commit;
