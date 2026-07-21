-- Commerce Slice 1: shared catalog and order foundation.
-- Apply before deploying /app/sell, /app/catalog, or /app/orders.

create extension if not exists pgcrypto;

create table if not exists public.commerce_catalog_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  description text,
  item_type text not null,
  sku text,
  price numeric(12,2) not null default 0 check (price >= 0),
  currency text not null default 'usd',
  taxable boolean not null default false,
  active boolean not null default true,
  published boolean not null default false,
  marketplace_visible boolean not null default false,
  image_url text,
  linked_package_template_id uuid references public.package_templates(id) on delete set null,
  linked_membership_plan_id uuid references public.membership_plans(id) on delete set null,
  linked_event_id uuid references public.events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_catalog_items_type_check check (
    item_type in (
      'physical_product',
      'digital_video',
      'video_series',
      'digital_download',
      'service',
      'linked_package',
      'linked_membership',
      'linked_event_offer'
    )
  ),
  constraint commerce_catalog_items_currency_check check (
    currency ~ '^[A-Za-z]{3}$'
  )
);

create unique index if not exists commerce_catalog_items_studio_sku_unique
  on public.commerce_catalog_items(studio_id, lower(sku))
  where sku is not null and length(trim(sku)) > 0;

create index if not exists commerce_catalog_items_studio_active_idx
  on public.commerce_catalog_items(studio_id, active, item_type);

create index if not exists commerce_catalog_items_marketplace_idx
  on public.commerce_catalog_items(studio_id, published, marketplace_visible)
  where active = true;

create table if not exists public.commerce_orders (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  order_number text not null default (
    'COM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  client_id uuid references public.clients(id) on delete set null,
  customer_type text not null default 'client',
  guest_name text,
  guest_email text,
  status text not null default 'draft',
  payment_status text not null default 'unpaid',
  fulfillment_status text not null default 'unfulfilled',
  subtotal numeric(12,2) not null default 0,
  discount_total numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  refund_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  currency text not null default 'usd',
  payment_id uuid references public.payments(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_orders_order_number_unique unique (order_number),
  constraint commerce_orders_customer_type_check check (
    customer_type in ('client', 'walk_in', 'guest')
  ),
  constraint commerce_orders_status_check check (
    status in ('draft', 'open', 'completed', 'cancelled', 'refunded')
  ),
  constraint commerce_orders_payment_status_check check (
    payment_status in (
      'unpaid',
      'pending',
      'paid',
      'partially_refunded',
      'refunded',
      'failed'
    )
  ),
  constraint commerce_orders_fulfillment_status_check check (
    fulfillment_status in (
      'unfulfilled',
      'partially_fulfilled',
      'fulfilled',
      'not_required',
      'cancelled'
    )
  ),
  constraint commerce_orders_amounts_check check (
    subtotal >= 0 and
    discount_total >= 0 and
    tax_total >= 0 and
    refund_total >= 0 and
    total >= 0
  )
);

create index if not exists commerce_orders_studio_created_idx
  on public.commerce_orders(studio_id, created_at desc);

create index if not exists commerce_orders_client_idx
  on public.commerce_orders(studio_id, client_id, created_at desc);

create index if not exists commerce_orders_status_idx
  on public.commerce_orders(studio_id, status, payment_status);

create table if not exists public.commerce_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.commerce_orders(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid references public.commerce_catalog_items(id) on delete set null,
  item_type text not null,
  name_snapshot text not null,
  sku_snapshot text,
  quantity integer not null default 1 check (quantity > 0 and quantity <= 10000),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  discount_total numeric(12,2) not null default 0 check (discount_total >= 0),
  tax_total numeric(12,2) not null default 0 check (tax_total >= 0),
  line_total numeric(12,2) not null default 0 check (line_total >= 0),
  fulfillment_status text not null default 'unfulfilled',
  linked_package_template_id uuid references public.package_templates(id) on delete set null,
  linked_membership_plan_id uuid references public.membership_plans(id) on delete set null,
  linked_event_id uuid references public.events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_order_items_fulfillment_status_check check (
    fulfillment_status in (
      'unfulfilled',
      'partially_fulfilled',
      'fulfilled',
      'not_required',
      'cancelled'
    )
  )
);

create index if not exists commerce_order_items_order_idx
  on public.commerce_order_items(order_id);

create index if not exists commerce_order_items_catalog_idx
  on public.commerce_order_items(studio_id, catalog_item_id);

create or replace function public.commerce_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists commerce_catalog_items_set_updated_at
  on public.commerce_catalog_items;
create trigger commerce_catalog_items_set_updated_at
before update on public.commerce_catalog_items
for each row execute function public.commerce_set_updated_at();

drop trigger if exists commerce_orders_set_updated_at
  on public.commerce_orders;
create trigger commerce_orders_set_updated_at
before update on public.commerce_orders
for each row execute function public.commerce_set_updated_at();

drop trigger if exists commerce_order_items_set_updated_at
  on public.commerce_order_items;
create trigger commerce_order_items_set_updated_at
before update on public.commerce_order_items
for each row execute function public.commerce_set_updated_at();

alter table public.commerce_catalog_items enable row level security;
alter table public.commerce_orders enable row level security;
alter table public.commerce_order_items enable row level security;

drop policy if exists "commerce catalog workspace read"
  on public.commerce_catalog_items;
create policy "commerce catalog workspace read"
  on public.commerce_catalog_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "commerce catalog managers write"
  on public.commerce_catalog_items;
create policy "commerce catalog managers write"
  on public.commerce_catalog_items
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

drop policy if exists "commerce orders workspace read"
  on public.commerce_orders;
create policy "commerce orders workspace read"
  on public.commerce_orders
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_orders.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

drop policy if exists "commerce orders sellers write"
  on public.commerce_orders;
create policy "commerce orders sellers write"
  on public.commerce_orders
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_orders.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_orders.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

drop policy if exists "commerce order items workspace read"
  on public.commerce_order_items;
create policy "commerce order items workspace read"
  on public.commerce_order_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_order_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

drop policy if exists "commerce order items sellers write"
  on public.commerce_order_items;
create policy "commerce order items sellers write"
  on public.commerce_order_items
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_order_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_order_items.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin',
          'front_desk'
        )
    )
  );

grant select, insert, update, delete
  on public.commerce_catalog_items
  to authenticated;

grant select, insert, update, delete
  on public.commerce_orders
  to authenticated;

grant select, insert, update, delete
  on public.commerce_order_items
  to authenticated;
