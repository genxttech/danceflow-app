-- Event Cart / Single Checkout V1 foundation
-- Creates event_orders and event_order_items for one-checkout event commerce.
-- Adds order links/hold fields to registrations and private lesson slots.

create extension if not exists pgcrypto;

create table if not exists public.event_orders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  organizer_id uuid null references public.organizers(id) on delete set null,

  buyer_name text not null,
  buyer_email text not null,
  buyer_phone text null,
  buyer_notes text null,

  subtotal_amount numeric(10, 2) not null default 0,
  discount_amount numeric(10, 2) not null default 0,
  tax_amount numeric(10, 2) not null default 0,
  total_amount numeric(10, 2) not null default 0,
  currency text not null default 'USD',

  status text not null default 'pending',
  payment_status text not null default 'unpaid',

  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,

  expires_at timestamptz null,
  paid_at timestamptz null,
  cancelled_at timestamptz null,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_orders_status_check check (
    status in ('draft', 'pending', 'confirmed', 'cancelled', 'expired')
  ),
  constraint event_orders_payment_status_check check (
    payment_status in ('unpaid', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded')
  ),
  constraint event_orders_amounts_nonnegative check (
    subtotal_amount >= 0 and discount_amount >= 0 and tax_amount >= 0 and total_amount >= 0
  )
);

create index if not exists event_orders_event_id_idx on public.event_orders(event_id);
create index if not exists event_orders_studio_id_idx on public.event_orders(studio_id);
create index if not exists event_orders_buyer_email_idx on public.event_orders(lower(buyer_email));
create unique index if not exists event_orders_stripe_checkout_session_id_uidx
  on public.event_orders(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create table if not exists public.event_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.event_orders(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,

  item_type text not null,
  reference_id uuid null,

  ticket_type_id uuid null references public.event_ticket_types(id) on delete set null,
  coach_slot_id uuid null references public.event_private_lesson_slots(id) on delete set null,

  description text not null,
  quantity integer not null default 1,
  unit_price numeric(10, 2) not null default 0,
  total_price numeric(10, 2) not null default 0,
  currency text not null default 'USD',

  attendee_names jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint event_order_items_item_type_check check (
    item_type in ('ticket', 'coach_slot', 'add_on')
  ),
  constraint event_order_items_quantity_positive check (quantity > 0),
  constraint event_order_items_amounts_nonnegative check (unit_price >= 0 and total_price >= 0)
);

create index if not exists event_order_items_order_id_idx on public.event_order_items(order_id);
create index if not exists event_order_items_event_id_idx on public.event_order_items(event_id);
create index if not exists event_order_items_ticket_type_id_idx on public.event_order_items(ticket_type_id);
create index if not exists event_order_items_coach_slot_id_idx on public.event_order_items(coach_slot_id);

alter table public.event_registrations
  add column if not exists order_id uuid null references public.event_orders(id) on delete set null;

create index if not exists event_registrations_order_id_idx
  on public.event_registrations(order_id);

alter table public.event_private_lesson_slots
  add column if not exists order_id uuid null references public.event_orders(id) on delete set null,
  add column if not exists held_until timestamptz null,
  add column if not exists hold_token uuid null;

create index if not exists event_private_lesson_slots_order_id_idx
  on public.event_private_lesson_slots(order_id);

create index if not exists event_private_lesson_slots_hold_idx
  on public.event_private_lesson_slots(status, payment_status, held_until)
  where status = 'held';

-- Keeps updated_at current when event_orders are edited.
create or replace function public.set_event_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_event_orders_updated_at on public.event_orders;

create trigger set_event_orders_updated_at
before update on public.event_orders
for each row
execute function public.set_event_orders_updated_at();

alter table public.event_orders enable row level security;
alter table public.event_order_items enable row level security;

-- Admin/studio users can read orders for their studios.
drop policy if exists "Studio members can read event orders" on public.event_orders;
create policy "Studio members can read event orders"
on public.event_orders
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = event_orders.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor')
  )
);

drop policy if exists "Studio members can read event order items" on public.event_order_items;
create policy "Studio members can read event order items"
on public.event_order_items
for select
to authenticated
using (
  exists (
    select 1
    from public.event_orders eo
    join public.user_studio_roles usr
      on usr.studio_id = eo.studio_id
    where eo.id = event_order_items.order_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor')
  )
);

-- Public checkout writes should be done by server routes using the service role key.
-- Do not add anonymous insert/update policies for event_orders or event_order_items.
