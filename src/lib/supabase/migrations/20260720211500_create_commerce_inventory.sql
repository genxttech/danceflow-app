-- Commerce Slice 2: physical product variants and auditable inventory.
-- Apply after 20260720123000_create_commerce_foundation.sql and before deploying Slice 2.

create table if not exists public.commerce_product_variants (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  name text not null,
  sku text,
  barcode text,
  size text,
  color text,
  unit_cost numeric(12,2),
  price_override numeric(12,2),
  reorder_threshold integer not null default 0,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_product_variants_unit_cost_check
    check (unit_cost is null or unit_cost >= 0),
  constraint commerce_product_variants_price_override_check
    check (price_override is null or price_override >= 0),
  constraint commerce_product_variants_reorder_threshold_check
    check (reorder_threshold >= 0)
);

create unique index if not exists commerce_product_variants_studio_sku_unique
  on public.commerce_product_variants(studio_id, lower(sku))
  where sku is not null and length(trim(sku)) > 0;

create unique index if not exists commerce_product_variants_studio_barcode_unique
  on public.commerce_product_variants(studio_id, barcode)
  where barcode is not null and length(trim(barcode)) > 0;

create index if not exists commerce_product_variants_catalog_idx
  on public.commerce_product_variants(catalog_item_id, active, name);

create table if not exists public.commerce_inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  variant_id uuid not null references public.commerce_product_variants(id) on delete cascade,
  quantity_delta integer not null,
  quantity_before integer not null,
  quantity_after integer not null,
  reason text not null,
  notes text,
  order_id uuid references public.commerce_orders(id) on delete set null,
  order_item_id uuid references public.commerce_order_items(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint commerce_inventory_ledger_delta_check check (quantity_delta <> 0),
  constraint commerce_inventory_ledger_nonnegative_check
    check (quantity_before >= 0 and quantity_after >= 0),
  constraint commerce_inventory_ledger_reason_check check (
    reason in (
      'received',
      'sale',
      'return',
      'exchange',
      'damaged',
      'lost',
      'correction',
      'opening_balance'
    )
  )
);

create index if not exists commerce_inventory_ledger_variant_idx
  on public.commerce_inventory_ledger(variant_id, created_at desc);

create index if not exists commerce_inventory_ledger_item_idx
  on public.commerce_inventory_ledger(catalog_item_id, created_at desc);

create index if not exists commerce_inventory_ledger_studio_idx
  on public.commerce_inventory_ledger(studio_id, created_at desc);

drop trigger if exists commerce_product_variants_set_updated_at
  on public.commerce_product_variants;
create trigger commerce_product_variants_set_updated_at
before update on public.commerce_product_variants
for each row execute function public.commerce_set_updated_at();

create or replace view public.commerce_product_variant_inventory
with (security_invoker = true)
as
select
  variant.id,
  variant.studio_id,
  variant.catalog_item_id,
  variant.name,
  variant.sku,
  variant.barcode,
  variant.size,
  variant.color,
  variant.unit_cost,
  variant.price_override,
  variant.reorder_threshold,
  variant.active,
  variant.metadata,
  variant.created_at,
  variant.updated_at,
  coalesce(
    (
      select ledger.quantity_after
      from public.commerce_inventory_ledger ledger
      where ledger.variant_id = variant.id
      order by ledger.created_at desc, ledger.id desc
      limit 1
    ),
    0
  )::integer as quantity_on_hand
from public.commerce_product_variants variant;

create or replace function public.commerce_adjust_inventory(
  p_studio_id uuid,
  p_catalog_item_id uuid,
  p_variant_id uuid,
  p_quantity_delta integer,
  p_reason text,
  p_notes text default null,
  p_actor_user_id uuid default null,
  p_order_id uuid default null,
  p_order_item_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current integer;
  v_after integer;
  v_ledger_id uuid;
begin
  if p_quantity_delta = 0 then
    raise exception 'Inventory adjustment cannot be zero.';
  end if;

  if p_reason not in (
    'received',
    'sale',
    'return',
    'exchange',
    'damaged',
    'lost',
    'correction',
    'opening_balance'
  ) then
    raise exception 'Invalid inventory adjustment reason.';
  end if;

  perform 1
  from public.commerce_product_variants variant
  join public.commerce_catalog_items item
    on item.id = variant.catalog_item_id
  where variant.id = p_variant_id
    and variant.catalog_item_id = p_catalog_item_id
    and variant.studio_id = p_studio_id
    and item.studio_id = p_studio_id
    and item.item_type = 'physical_product'
  for update of variant;

  if not found then
    raise exception 'Physical product variant was not found.';
  end if;

  select coalesce(
    (
      select ledger.quantity_after
      from public.commerce_inventory_ledger ledger
      where ledger.variant_id = p_variant_id
      order by ledger.created_at desc, ledger.id desc
      limit 1
    ),
    0
  )
  into v_current;

  v_after := v_current + p_quantity_delta;

  if v_after < 0 then
    raise exception 'Inventory cannot be reduced below zero.';
  end if;

  insert into public.commerce_inventory_ledger (
    studio_id,
    catalog_item_id,
    variant_id,
    quantity_delta,
    quantity_before,
    quantity_after,
    reason,
    notes,
    order_id,
    order_item_id,
    actor_user_id,
    metadata
  )
  values (
    p_studio_id,
    p_catalog_item_id,
    p_variant_id,
    p_quantity_delta,
    v_current,
    v_after,
    p_reason,
    nullif(trim(p_notes), ''),
    p_order_id,
    p_order_item_id,
    p_actor_user_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

alter table public.commerce_product_variants enable row level security;
alter table public.commerce_inventory_ledger enable row level security;

drop policy if exists "commerce variants workspace read"
  on public.commerce_product_variants;
create policy "commerce variants workspace read"
  on public.commerce_product_variants
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_product_variants.studio_id
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

drop policy if exists "commerce variants managers write"
  on public.commerce_product_variants;
create policy "commerce variants managers write"
  on public.commerce_product_variants
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_product_variants.studio_id
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
      where usr.studio_id = commerce_product_variants.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

drop policy if exists "commerce inventory workspace read"
  on public.commerce_inventory_ledger;
create policy "commerce inventory workspace read"
  on public.commerce_inventory_ledger
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_inventory_ledger.studio_id
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

drop policy if exists "commerce inventory managers insert"
  on public.commerce_inventory_ledger;
create policy "commerce inventory managers insert"
  on public.commerce_inventory_ledger
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_inventory_ledger.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

grant select, insert, update, delete
  on public.commerce_product_variants
  to authenticated;

grant select, insert
  on public.commerce_inventory_ledger
  to authenticated;

grant select
  on public.commerce_product_variant_inventory
  to authenticated;

grant execute
  on function public.commerce_adjust_inventory(
    uuid,
    uuid,
    uuid,
    integer,
    text,
    text,
    uuid,
    uuid,
    uuid,
    jsonb
  )
  to authenticated;
