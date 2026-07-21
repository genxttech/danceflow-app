-- Commerce Slice 3: physical product checkout, orders, receipts, and terminal completion.
-- Apply after:
--   20260720123000_create_commerce_foundation.sql
--   20260720211500_create_commerce_inventory.sql
-- Apply before deploying Slice 3.

alter table public.payments
  add column if not exists commerce_order_id uuid
  references public.commerce_orders(id) on delete set null;

create index if not exists payments_commerce_order_idx
  on public.payments(studio_id, commerce_order_id)
  where commerce_order_id is not null;

alter table public.commerce_order_items
  add column if not exists variant_id uuid
  references public.commerce_product_variants(id) on delete set null;

alter table public.commerce_order_items
  add column if not exists unit_cost_snapshot numeric(12,2);

alter table public.commerce_order_items
  add column if not exists cogs_total numeric(12,2) not null default 0;

alter table public.commerce_order_items
  drop constraint if exists commerce_order_items_unit_cost_snapshot_check;

alter table public.commerce_order_items
  add constraint commerce_order_items_unit_cost_snapshot_check
  check (unit_cost_snapshot is null or unit_cost_snapshot >= 0);

alter table public.commerce_order_items
  drop constraint if exists commerce_order_items_cogs_total_check;

alter table public.commerce_order_items
  add constraint commerce_order_items_cogs_total_check
  check (cogs_total >= 0);

create index if not exists commerce_order_items_variant_idx
  on public.commerce_order_items(studio_id, variant_id);

create or replace function public.commerce_get_next_order_number(
  p_studio_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_number text;
begin
  loop
    v_number :=
      'COM-' ||
      to_char(current_date, 'YYYYMMDD') ||
      '-' ||
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    exit when not exists (
      select 1
      from public.commerce_orders
      where order_number = v_number
    );
  end loop;

  return v_number;
end;
$$;

create or replace function public.commerce_complete_manual_physical_sale(
  p_studio_id uuid,
  p_variant_id uuid,
  p_quantity integer,
  p_client_id uuid default null,
  p_guest_name text default null,
  p_payment_method text default 'cash',
  p_external_reference text default null,
  p_discount_total numeric default 0,
  p_notes text default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_variant record;
  v_current integer;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_total numeric(12,2);
  v_order_id uuid;
  v_order_item_id uuid;
  v_payment_id uuid;
  v_ledger_id uuid;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000 then
    raise exception 'Quantity must be between 1 and 1000.';
  end if;

  if p_payment_method not in (
    'cash',
    'check',
    'card',
    'ach',
    'venmo',
    'zelle',
    'other'
  ) then
    raise exception 'Payment method is invalid.';
  end if;

  if p_client_id is null and nullif(trim(p_guest_name), '') is null then
    raise exception 'Choose a client or enter a walk-in name.';
  end if;

  select
    variant.id,
    variant.catalog_item_id,
    variant.name as variant_name,
    variant.sku,
    variant.unit_cost,
    variant.price_override,
    item.name as item_name,
    item.price as catalog_price,
    item.currency,
    item.taxable
  into v_variant
  from public.commerce_product_variants variant
  join public.commerce_catalog_items item
    on item.id = variant.catalog_item_id
  where variant.id = p_variant_id
    and variant.studio_id = p_studio_id
    and item.studio_id = p_studio_id
    and variant.active = true
    and item.active = true
    and item.item_type = 'physical_product'
  for update of variant;

  if not found then
    raise exception 'Physical product variant was not found.';
  end if;

  select coalesce(
    (
      select quantity_after
      from public.commerce_inventory_ledger
      where variant_id = p_variant_id
      order by created_at desc, id desc
      limit 1
    ),
    0
  )
  into v_current;

  if v_current < p_quantity then
    raise exception 'Only % unit(s) are available.', v_current;
  end if;

  v_subtotal :=
    round(
      coalesce(v_variant.price_override, v_variant.catalog_price, 0) *
      p_quantity,
      2
    );
  v_discount :=
    least(greatest(coalesce(p_discount_total, 0), 0), v_subtotal);
  v_total := round(v_subtotal - v_discount, 2);

  if p_external_reference is not null and exists (
    select 1
    from public.payments
    where studio_id = p_studio_id
      and external_reference = p_external_reference
      and payment_channel = 'manual'
  ) then
    raise exception 'That external payment reference is already recorded.';
  end if;

  insert into public.commerce_orders (
    studio_id,
    order_number,
    client_id,
    customer_type,
    guest_name,
    status,
    payment_status,
    fulfillment_status,
    subtotal,
    discount_total,
    tax_total,
    refund_total,
    total,
    currency,
    notes,
    created_by,
    updated_by,
    completed_at
  )
  values (
    p_studio_id,
    public.commerce_get_next_order_number(p_studio_id),
    p_client_id,
    case when p_client_id is null then 'walk_in' else 'client' end,
    nullif(trim(p_guest_name), ''),
    'completed',
    'paid',
    'fulfilled',
    v_subtotal,
    v_discount,
    0,
    0,
    v_total,
    coalesce(v_variant.currency, 'usd'),
    nullif(trim(p_notes), ''),
    p_actor_user_id,
    p_actor_user_id,
    now()
  )
  returning id into v_order_id;

  insert into public.commerce_order_items (
    order_id,
    studio_id,
    catalog_item_id,
    variant_id,
    item_type,
    name_snapshot,
    sku_snapshot,
    quantity,
    unit_price,
    discount_total,
    tax_total,
    line_total,
    fulfillment_status,
    unit_cost_snapshot,
    cogs_total,
    metadata
  )
  values (
    v_order_id,
    p_studio_id,
    v_variant.catalog_item_id,
    v_variant.id,
    'physical_product',
    v_variant.item_name || ' · ' || v_variant.variant_name,
    v_variant.sku,
    p_quantity,
    coalesce(v_variant.price_override, v_variant.catalog_price, 0),
    v_discount,
    0,
    v_total,
    'fulfilled',
    v_variant.unit_cost,
    round(coalesce(v_variant.unit_cost, 0) * p_quantity, 2),
    jsonb_build_object(
      'taxable', v_variant.taxable,
      'inventory_decremented', true,
      'accounting_category', 'retail_revenue',
      'cogs_category', 'retail_cogs'
    )
  )
  returning id into v_order_item_id;

  insert into public.payments (
    studio_id,
    client_id,
    amount,
    payment_method,
    status,
    notes,
    paid_at,
    created_by,
    payment_type,
    source,
    payment_channel,
    currency,
    external_reference,
    guest_name,
    commerce_order_id
  )
  values (
    p_studio_id,
    p_client_id,
    v_total,
    p_payment_method,
    'paid',
    coalesce(
      nullif(trim(p_notes), ''),
      'Retail order ' || v_order_id::text
    ),
    now(),
    p_actor_user_id,
    'retail_sale',
    'commerce',
    'manual',
    coalesce(v_variant.currency, 'usd'),
    nullif(trim(p_external_reference), ''),
    nullif(trim(p_guest_name), ''),
    v_order_id
  )
  returning id into v_payment_id;

  update public.commerce_orders
  set payment_id = v_payment_id
  where id = v_order_id;

  select public.commerce_adjust_inventory(
    p_studio_id,
    v_variant.catalog_item_id,
    v_variant.id,
    -p_quantity,
    'sale',
    'Order ' || v_order_id::text,
    p_actor_user_id,
    v_order_id,
    v_order_item_id,
    jsonb_build_object(
      'payment_id', v_payment_id,
      'payment_method', p_payment_method
    )
  )
  into v_ledger_id;

  return v_order_id;
end;
$$;

create or replace function public.commerce_create_pending_terminal_order(
  p_studio_id uuid,
  p_variant_id uuid,
  p_quantity integer,
  p_client_id uuid default null,
  p_guest_name text default null,
  p_discount_total numeric default 0,
  p_notes text default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_variant record;
  v_current integer;
  v_reserved integer;
  v_available integer;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_total numeric(12,2);
  v_order_id uuid;
  v_payment_id uuid;
begin
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000 then
    raise exception 'Quantity must be between 1 and 1000.';
  end if;

  if p_client_id is null and nullif(trim(p_guest_name), '') is null then
    raise exception 'Choose a client or enter a walk-in name.';
  end if;

  select
    variant.id,
    variant.catalog_item_id,
    variant.name as variant_name,
    variant.sku,
    variant.unit_cost,
    variant.price_override,
    item.name as item_name,
    item.price as catalog_price,
    item.currency,
    item.taxable
  into v_variant
  from public.commerce_product_variants variant
  join public.commerce_catalog_items item
    on item.id = variant.catalog_item_id
  where variant.id = p_variant_id
    and variant.studio_id = p_studio_id
    and item.studio_id = p_studio_id
    and variant.active = true
    and item.active = true
    and item.item_type = 'physical_product'
  for update of variant;

  if not found then
    raise exception 'Physical product variant was not found.';
  end if;

  select coalesce(
    (
      select quantity_after
      from public.commerce_inventory_ledger
      where variant_id = p_variant_id
      order by created_at desc, id desc
      limit 1
    ),
    0
  )
  into v_current;

  select coalesce(sum(order_item.quantity), 0)
  into v_reserved
  from public.commerce_order_items order_item
  join public.commerce_orders commerce_order
    on commerce_order.id = order_item.order_id
  where order_item.variant_id = p_variant_id
    and commerce_order.studio_id = p_studio_id
    and commerce_order.status = 'open'
    and commerce_order.payment_status = 'pending';

  v_available := v_current - v_reserved;

  if v_available < p_quantity then
    raise exception 'Only % unreserved unit(s) are available.', v_available;
  end if;

  v_subtotal :=
    round(
      coalesce(v_variant.price_override, v_variant.catalog_price, 0) *
      p_quantity,
      2
    );
  v_discount :=
    least(greatest(coalesce(p_discount_total, 0), 0), v_subtotal);
  v_total := round(v_subtotal - v_discount, 2);

  insert into public.commerce_orders (
    studio_id,
    order_number,
    client_id,
    customer_type,
    guest_name,
    status,
    payment_status,
    fulfillment_status,
    subtotal,
    discount_total,
    tax_total,
    refund_total,
    total,
    currency,
    notes,
    created_by,
    updated_by
  )
  values (
    p_studio_id,
    public.commerce_get_next_order_number(p_studio_id),
    p_client_id,
    case when p_client_id is null then 'walk_in' else 'client' end,
    nullif(trim(p_guest_name), ''),
    'open',
    'pending',
    'unfulfilled',
    v_subtotal,
    v_discount,
    0,
    0,
    v_total,
    coalesce(v_variant.currency, 'usd'),
    nullif(trim(p_notes), ''),
    p_actor_user_id,
    p_actor_user_id
  )
  returning id into v_order_id;

  insert into public.commerce_order_items (
    order_id,
    studio_id,
    catalog_item_id,
    variant_id,
    item_type,
    name_snapshot,
    sku_snapshot,
    quantity,
    unit_price,
    discount_total,
    tax_total,
    line_total,
    fulfillment_status,
    unit_cost_snapshot,
    cogs_total,
    metadata
  )
  values (
    v_order_id,
    p_studio_id,
    v_variant.catalog_item_id,
    v_variant.id,
    'physical_product',
    v_variant.item_name || ' · ' || v_variant.variant_name,
    v_variant.sku,
    p_quantity,
    coalesce(v_variant.price_override, v_variant.catalog_price, 0),
    v_discount,
    0,
    v_total,
    'unfulfilled',
    v_variant.unit_cost,
    round(coalesce(v_variant.unit_cost, 0) * p_quantity, 2),
    jsonb_build_object(
      'taxable', v_variant.taxable,
      'inventory_reserved', true,
      'accounting_category', 'retail_revenue',
      'cogs_category', 'retail_cogs'
    )
  );

  insert into public.payments (
    studio_id,
    client_id,
    amount,
    payment_method,
    status,
    notes,
    paid_at,
    created_by,
    payment_type,
    source,
    payment_channel,
    currency,
    guest_name,
    commerce_order_id
  )
  values (
    p_studio_id,
    p_client_id,
    v_total,
    'card',
    'pending',
    coalesce(
      nullif(trim(p_notes), ''),
      'Pending retail order ' || v_order_id::text
    ),
    null,
    p_actor_user_id,
    'retail_sale',
    'commerce',
    'terminal',
    coalesce(v_variant.currency, 'usd'),
    nullif(trim(p_guest_name), ''),
    v_order_id
  )
  returning id into v_payment_id;

  update public.commerce_orders
  set payment_id = v_payment_id
  where id = v_order_id;

  return v_order_id;
end;
$$;

create or replace function public.commerce_complete_terminal_order(
  p_studio_id uuid,
  p_order_id uuid,
  p_payment_id uuid,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order record;
  v_item record;
  v_current integer;
  v_ledger_id uuid;
begin
  select
    commerce_order.id,
    commerce_order.status,
    commerce_order.payment_status,
    commerce_order.payment_id
  into v_order
  from public.commerce_orders commerce_order
  where commerce_order.id = p_order_id
    and commerce_order.studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Commerce order was not found.';
  end if;

  if v_order.status = 'completed' and v_order.payment_status = 'paid' then
    return p_order_id;
  end if;

  if (
    v_order.status <> 'open' or
    v_order.payment_status <> 'pending' or
    v_order.payment_id <> p_payment_id
  ) then
    raise exception 'Commerce order is not ready for fulfillment.';
  end if;

  perform 1
  from public.payments
  where id = p_payment_id
    and studio_id = p_studio_id
    and status = 'paid';

  if not found then
    raise exception 'Payment has not been confirmed.';
  end if;

  for v_item in
    select
      order_item.id,
      order_item.catalog_item_id,
      order_item.variant_id,
      order_item.quantity
    from public.commerce_order_items order_item
    where order_item.order_id = p_order_id
    order by order_item.id
  loop
    if v_item.variant_id is null then
      raise exception 'Physical order item is missing its inventory variant.';
    end if;

    perform 1
    from public.commerce_product_variants variant
    where variant.id = v_item.variant_id
      and variant.studio_id = p_studio_id
    for update;

    select coalesce(
      (
        select quantity_after
        from public.commerce_inventory_ledger
        where variant_id = v_item.variant_id
        order by created_at desc, id desc
        limit 1
      ),
      0
    )
    into v_current;

    if v_current < v_item.quantity then
      raise exception
        'Payment succeeded, but inventory is short for one order item.';
    end if;

    select public.commerce_adjust_inventory(
      p_studio_id,
      v_item.catalog_item_id,
      v_item.variant_id,
      -v_item.quantity,
      'sale',
      'Terminal order ' || p_order_id::text,
      p_actor_user_id,
      p_order_id,
      v_item.id,
      jsonb_build_object(
        'payment_id', p_payment_id,
        'payment_channel', 'terminal'
      )
    )
    into v_ledger_id;

    update public.commerce_order_items
    set
      fulfillment_status = 'fulfilled',
      metadata = coalesce(metadata, '{}'::jsonb) ||
        jsonb_build_object(
          'inventory_decremented', true,
          'inventory_ledger_id', v_ledger_id
        ),
      updated_at = now()
    where id = v_item.id;
  end loop;

  update public.commerce_orders
  set
    status = 'completed',
    payment_status = 'paid',
    fulfillment_status = 'fulfilled',
    completed_at = now(),
    updated_by = p_actor_user_id,
    updated_at = now()
  where id = p_order_id;

  return p_order_id;
end;
$$;

grant execute
  on function public.commerce_get_next_order_number(uuid)
  to authenticated;

grant execute
  on function public.commerce_complete_manual_physical_sale(
    uuid,
    uuid,
    integer,
    uuid,
    text,
    text,
    text,
    numeric,
    text,
    uuid
  )
  to authenticated;

grant execute
  on function public.commerce_create_pending_terminal_order(
    uuid,
    uuid,
    integer,
    uuid,
    text,
    numeric,
    text,
    uuid
  )
  to authenticated;

grant execute
  on function public.commerce_complete_terminal_order(
    uuid,
    uuid,
    uuid,
    uuid
  )
  to authenticated;
