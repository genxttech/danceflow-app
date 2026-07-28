-- DanceFlow Source-Specific Migration Support
-- Slice 1: Square commerce schema and mapping foundation v1
--
-- Adds durable Square source identity, first-class catalog categories,
-- a historical accounting-sync guard, system mapping templates, and
-- supported Square retail migration stages.
--
-- Apply after:
--   20260727000300_migration_center_mapping_reconciliation_v1.sql
--   20260720223000_sync_retail_accounting.sql

create extension if not exists pgcrypto;

-- Durable source identity for repeatable, idempotent commerce imports.
alter table public.commerce_catalog_items
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.commerce_product_variants
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz;

alter table public.commerce_orders
  add column if not exists source_system text,
  add column if not exists source_external_id text,
  add column if not exists imported_at timestamptz,
  add column if not exists accounting_sync_mode text not null default 'active',
  add column if not exists accounting_sync_suppressed_at timestamptz;

alter table public.commerce_orders
  drop constraint if exists commerce_orders_accounting_sync_mode_check;

alter table public.commerce_orders
  add constraint commerce_orders_accounting_sync_mode_check
  check (accounting_sync_mode in ('active', 'deferred', 'suppressed'));

create unique index if not exists commerce_catalog_items_source_identity_unique
  on public.commerce_catalog_items(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists commerce_product_variants_source_identity_unique
  on public.commerce_product_variants(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists commerce_orders_source_identity_unique
  on public.commerce_orders(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create index if not exists commerce_catalog_items_import_source_idx
  on public.commerce_catalog_items(studio_id, source_system, imported_at desc);

create index if not exists commerce_product_variants_import_source_idx
  on public.commerce_product_variants(studio_id, source_system, imported_at desc);

create index if not exists commerce_orders_import_source_idx
  on public.commerce_orders(studio_id, source_system, imported_at desc);

-- First-class categories preserve Square catalog organization and support
-- future catalog/marketplace filtering without storing category data only
-- inside item metadata.
create table if not exists public.commerce_catalog_categories (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  parent_category_id uuid references public.commerce_catalog_categories(id) on delete set null,
  name text not null,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  source_system text,
  source_external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_catalog_categories_name_check
    check (length(trim(name)) > 0),
  constraint commerce_catalog_categories_sort_order_check
    check (sort_order >= 0)
);

create unique index if not exists commerce_catalog_categories_source_identity_unique
  on public.commerce_catalog_categories(studio_id, source_system, source_external_id)
  where source_system is not null
    and length(trim(source_system)) > 0
    and source_external_id is not null
    and length(trim(source_external_id)) > 0;

create unique index if not exists commerce_catalog_categories_studio_name_unique
  on public.commerce_catalog_categories(studio_id, lower(name))
  where active = true;

create index if not exists commerce_catalog_categories_parent_idx
  on public.commerce_catalog_categories(studio_id, parent_category_id, sort_order, name);

create table if not exists public.commerce_catalog_item_categories (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  category_id uuid not null references public.commerce_catalog_categories(id) on delete cascade,
  is_primary boolean not null default false,
  source_system text,
  source_external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint commerce_catalog_item_categories_item_category_unique
    unique (catalog_item_id, category_id)
);

create unique index if not exists commerce_catalog_item_categories_primary_unique
  on public.commerce_catalog_item_categories(catalog_item_id)
  where is_primary = true;

create index if not exists commerce_catalog_item_categories_category_idx
  on public.commerce_catalog_item_categories(studio_id, category_id, catalog_item_id);

-- Reuse the commerce timestamp trigger function already present in production.
drop trigger if exists commerce_catalog_categories_set_updated_at
  on public.commerce_catalog_categories;
create trigger commerce_catalog_categories_set_updated_at
before update on public.commerce_catalog_categories
for each row execute function public.commerce_set_updated_at();

alter table public.commerce_catalog_categories enable row level security;
alter table public.commerce_catalog_item_categories enable row level security;

drop policy if exists "commerce catalog categories workspace read"
  on public.commerce_catalog_categories;
create policy "commerce catalog categories workspace read"
  on public.commerce_catalog_categories
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_categories.studio_id
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

drop policy if exists "commerce catalog categories managers write"
  on public.commerce_catalog_categories;
create policy "commerce catalog categories managers write"
  on public.commerce_catalog_categories
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_categories.studio_id
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
      where usr.studio_id = commerce_catalog_categories.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in (
          'platform_admin',
          'studio_owner',
          'studio_admin'
        )
    )
  );

drop policy if exists "commerce catalog item categories workspace read"
  on public.commerce_catalog_item_categories;
create policy "commerce catalog item categories workspace read"
  on public.commerce_catalog_item_categories
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_item_categories.studio_id
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

drop policy if exists "commerce catalog item categories managers write"
  on public.commerce_catalog_item_categories;
create policy "commerce catalog item categories managers write"
  on public.commerce_catalog_item_categories
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_catalog_item_categories.studio_id
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
      where usr.studio_id = commerce_catalog_item_categories.studio_id
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
  on public.commerce_catalog_categories,
     public.commerce_catalog_item_categories
  to authenticated;

-- Historical imported orders are deferred by default and must not create
-- current accounting entries until reconciliation explicitly activates them.
create or replace function public.sync_commerce_order_accounting_entries()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cogs numeric(12,2);
  v_refund numeric(12,2);
  v_payment_method text;
begin
  if coalesce(new.accounting_sync_mode, 'active') <> 'active' then
    update public.accounting_entries
    set
      entry_status = 'voided',
      voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(
        void_reason,
        'Retail accounting synchronization is deferred or suppressed.'
      ),
      updated_at = now()
    where source_table = 'commerce_orders'
      and source_id = new.id
      and entry_status = 'active'
      and locked_at is null;

    return new;
  end if;

  if new.status = 'completed' and new.payment_status in (
    'paid',
    'partially_refunded',
    'refunded'
  ) then
    select coalesce(sum(item.cogs_total), 0)
    into v_cogs
    from public.commerce_order_items item
    where item.order_id = new.id;

    select payment.payment_method
    into v_payment_method
    from public.payments payment
    where payment.id = new.payment_id;

    v_refund := greatest(coalesce(new.refund_total, 0), 0);

    insert into public.accounting_entries (
      studio_id, organizer_id, entry_date, entry_type, category, direction,
      gross_amount, fee_amount, refund_amount, net_amount, currency,
      payment_method, source_table, source_id, client_id, event_id,
      appointment_id, external_reference, stripe_payment_intent_id,
      stripe_charge_id, stripe_invoice_id, description, entry_status,
      posted_at, metadata
    )
    values (
      new.studio_id, null,
      coalesce(new.completed_at, new.created_at, now())::date,
      'revenue', 'retail_revenue', 'credit',
      greatest(coalesce(new.subtotal, 0) - coalesce(new.discount_total, 0), 0),
      0, 0, greatest(coalesce(new.total, 0), 0),
      coalesce(new.currency, 'usd'), v_payment_method,
      'commerce_orders', new.id, new.client_id, null, null,
      new.order_number, null, null, null,
      'Retail order ' || new.order_number, 'active',
      coalesce(new.completed_at, now()),
      jsonb_build_object(
        'commerce_order_id', new.id,
        'order_number', new.order_number,
        'discount_total', coalesce(new.discount_total, 0),
        'tax_total', coalesce(new.tax_total, 0),
        'customer_type', new.customer_type
      )
    )
    on conflict (source_table, source_id, entry_type, category)
    do update set
      entry_date = excluded.entry_date,
      gross_amount = excluded.gross_amount,
      net_amount = excluded.net_amount,
      payment_method = excluded.payment_method,
      description = excluded.description,
      entry_status = 'active',
      voided_at = null,
      void_reason = null,
      posted_at = excluded.posted_at,
      metadata = excluded.metadata,
      updated_at = now();

    if v_cogs > 0 then
      insert into public.accounting_entries (
        studio_id, organizer_id, entry_date, entry_type, category, direction,
        gross_amount, fee_amount, refund_amount, net_amount, currency,
        payment_method, source_table, source_id, client_id, event_id,
        appointment_id, external_reference, stripe_payment_intent_id,
        stripe_charge_id, stripe_invoice_id, description, entry_status,
        posted_at, metadata
      )
      values (
        new.studio_id, null,
        coalesce(new.completed_at, new.created_at, now())::date,
        'expense', 'retail_cogs', 'debit',
        v_cogs, 0, 0, v_cogs,
        coalesce(new.currency, 'usd'), v_payment_method,
        'commerce_orders', new.id, new.client_id, null, null,
        new.order_number, null, null, null,
        'Cost of goods sold for retail order ' || new.order_number,
        'active', coalesce(new.completed_at, now()),
        jsonb_build_object(
          'commerce_order_id', new.id,
          'order_number', new.order_number
        )
      )
      on conflict (source_table, source_id, entry_type, category)
      do update set
        entry_date = excluded.entry_date,
        gross_amount = excluded.gross_amount,
        net_amount = excluded.net_amount,
        payment_method = excluded.payment_method,
        description = excluded.description,
        entry_status = 'active',
        voided_at = null,
        void_reason = null,
        posted_at = excluded.posted_at,
        metadata = excluded.metadata,
        updated_at = now();
    end if;

    if v_refund > 0 then
      insert into public.accounting_entries (
        studio_id, organizer_id, entry_date, entry_type, category, direction,
        gross_amount, fee_amount, refund_amount, net_amount, currency,
        payment_method, source_table, source_id, client_id, event_id,
        appointment_id, external_reference, stripe_payment_intent_id,
        stripe_charge_id, stripe_invoice_id, description, entry_status,
        posted_at, metadata
      )
      values (
        new.studio_id, null,
        coalesce(new.completed_at, new.created_at, now())::date,
        'refund', 'retail_refund', 'debit',
        0, 0, v_refund, v_refund,
        coalesce(new.currency, 'usd'), v_payment_method,
        'commerce_orders', new.id, new.client_id, null, null,
        new.order_number, null, null, null,
        'Retail refund for order ' || new.order_number,
        'active', now(),
        jsonb_build_object(
          'commerce_order_id', new.id,
          'order_number', new.order_number
        )
      )
      on conflict (source_table, source_id, entry_type, category)
      do update set
        refund_amount = excluded.refund_amount,
        net_amount = excluded.net_amount,
        entry_status = 'active',
        voided_at = null,
        void_reason = null,
        posted_at = excluded.posted_at,
        metadata = excluded.metadata,
        updated_at = now();
    else
      update public.accounting_entries
      set
        entry_status = 'voided',
        voided_at = coalesce(voided_at, now()),
        void_reason = coalesce(
          void_reason,
          'Retail order no longer has a refund balance.'
        ),
        updated_at = now()
      where source_table = 'commerce_orders'
        and source_id = new.id
        and entry_type = 'refund'
        and category = 'retail_refund'
        and entry_status = 'active'
        and locked_at is null;
    end if;
  else
    update public.accounting_entries
    set
      entry_status = 'voided',
      voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(
        void_reason,
        'Retail order is not completed and paid.'
      ),
      updated_at = now()
    where source_table = 'commerce_orders'
      and source_id = new.id
      and entry_status = 'active'
      and locked_at is null;
  end if;

  return new;
end;
$$;

-- Canonical Square system mappings. These reserve the mapping contract used
-- by the execution slices without exposing unsupported live execution yet.
insert into public.import_mapping_templates (
  studio_id,
  source_system,
  import_type,
  name,
  version,
  status,
  is_system_template,
  field_mappings,
  normalization_rules
)
values
  (
    null,
    'square',
    'products',
    'Square Catalog and Variations',
    1,
    'active',
    true,
    jsonb_build_object(
      'category', jsonb_build_object(
        'id', 'category_id',
        'name', 'category_name'
      ),
      'catalog_item', jsonb_build_object(
        'source_external_id', 'item_id',
        'name', 'item_name',
        'description', 'description',
        'sku', 'item_sku',
        'image_url', 'image_url',
        'active', 'active'
      ),
      'variant', jsonb_build_object(
        'source_external_id', 'variation_id',
        'name', 'variation_name',
        'sku', 'sku',
        'barcode', 'barcode',
        'price_override', 'price',
        'unit_cost', 'unit_cost',
        'size', 'size',
        'color', 'color',
        'active', 'active'
      )
    ),
    jsonb_build_object(
      'source_system', 'square',
      'item_type', 'physical_product',
      'currency', 'usd',
      'match_precedence', jsonb_build_array(
        'source_external_id',
        'sku',
        'barcode',
        'manual_decision'
      ),
      'never_match_by', jsonb_build_array('name'),
      'missing_variation', 'create_default_variant',
      'duplicate_identity', 'exception'
    )
  ),
  (
    null,
    'square',
    'inventory',
    'Square Inventory Counts',
    1,
    'active',
    true,
    jsonb_build_object(
      'variation_source_external_id', 'variation_id',
      'location_source_external_id', 'location_id',
      'quantity', 'quantity',
      'calculated_at', 'calculated_at'
    ),
    jsonb_build_object(
      'first_live_import_reason', 'opening_balance',
      'repeat_live_import_reason', 'correction',
      'negative_quantity', 'exception',
      'multiple_locations', 'owner_decision',
      'zero_delta', 'skip'
    )
  ),
  (
    null,
    'square',
    'retail_orders',
    'Square Orders, Payments, and Refunds',
    1,
    'active',
    true,
    jsonb_build_object(
      'order_source_external_id', 'order_id',
      'customer_source_external_id', 'customer_id',
      'order_number', 'reference_id',
      'status', 'state',
      'subtotal', 'subtotal',
      'discount_total', 'discount_total',
      'tax_total', 'tax_total',
      'refund_total', 'refund_total',
      'total', 'total',
      'currency', 'currency',
      'completed_at', 'closed_at',
      'line_item_source_external_id', 'line_item_id',
      'catalog_item_source_external_id', 'catalog_object_id',
      'variant_source_external_id', 'variation_id',
      'quantity', 'quantity',
      'unit_price', 'unit_price',
      'line_total', 'line_total',
      'payment_source_external_id', 'payment_id'
    ),
    jsonb_build_object(
      'source_system', 'square',
      'accounting_sync_mode', 'deferred',
      'refund_representation', 'refund_total_and_payment_activity',
      'negative_order_totals', 'exception',
      'unmatched_customer', 'exception',
      'unmatched_product', 'exception',
      'amount_mismatch', 'exception'
    )
  )
on conflict (studio_id, source_system, import_type, name, version)
do update set
  status = excluded.status,
  is_system_template = excluded.is_system_template,
  field_mappings = excluded.field_mappings,
  normalization_rules = excluded.normalization_rules,
  updated_at = now();

-- Square retail stages now have verified destination schemas and mapping
-- contracts. Live execution is added in subsequent slices.
update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'Square catalog categories, products, variants, SKUs, prices, and active status. Live execution is delivered by the Square catalog slice.',
  updated_at = now()
where stage_key = 'products';

update public.migration_stage_definitions
set
  execution_status = 'supported',
  description = 'Square variant inventory counts imported through auditable opening-balance and correction ledger entries.',
  updated_at = now()
where stage_key = 'inventory';

update public.migration_stage_definitions
set
  execution_status = 'assisted',
  description = 'Square historical orders, line items, payments, and refunds with deferred accounting reconciliation.',
  updated_at = now()
where stage_key = 'retail_orders';

comment on column public.commerce_orders.accounting_sync_mode is
  'Controls retail accounting synchronization. Imported historical orders default to deferred until reconciliation activates them.';

comment on table public.commerce_catalog_categories is
  'Studio-scoped retail catalog categories, including durable external source identity for Square and future import sources.';

comment on table public.commerce_catalog_item_categories is
  'Many-to-many relationships between commerce catalog items and retail categories.';
