-- Commerce payment method enum hotfix.
-- Apply after 20260720235000_create_commerce_entitlements.sql.
-- Apply before retesting manual physical or digital sales.

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
    p_payment_method::public.payment_method,
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

create or replace function public.commerce_complete_manual_digital_sale(
  p_studio_id uuid,
  p_catalog_item_id uuid,
  p_client_id uuid,
  p_payment_method text,
  p_external_reference text default null,
  p_notes text default null,
  p_actor_user_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item record;
  v_user_id uuid;
  v_order_id uuid;
  v_order_item_id uuid;
  v_payment_id uuid;
begin
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

  select
    item.id,
    item.name,
    item.item_type,
    item.price,
    item.currency
  into v_item
  from public.commerce_catalog_items item
  join public.commerce_digital_content content
    on content.catalog_item_id = item.id
  where item.id = p_catalog_item_id
    and item.studio_id = p_studio_id
    and item.active = true
    and item.published = true
    and item.item_type in (
      'digital_video',
      'video_series',
      'digital_download'
    )
    and content.status = 'published';

  if not found then
    raise exception 'Published digital product was not found.';
  end if;

  select link.user_id
  into v_user_id
  from public.client_account_links link
  where link.client_id = p_client_id
    and link.status = 'linked'
  order by link.created_at desc
  limit 1;

  if v_user_id is null then
    raise exception 'This client does not have a linked student account.';
  end if;

  if exists (
    select 1
    from public.commerce_entitlements entitlement
    where entitlement.user_id = v_user_id
      and entitlement.catalog_item_id = p_catalog_item_id
      and entitlement.status in ('active', 'refunded_access_retained')
  ) then
    raise exception 'This student already has access to this content.';
  end if;

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
    'client',
    'completed',
    'paid',
    'fulfilled',
    v_item.price,
    0,
    0,
    0,
    v_item.price,
    coalesce(v_item.currency, 'usd'),
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
    item_type,
    name_snapshot,
    quantity,
    unit_price,
    discount_total,
    tax_total,
    line_total,
    fulfillment_status,
    cogs_total,
    metadata
  )
  values (
    v_order_id,
    p_studio_id,
    p_catalog_item_id,
    v_item.item_type,
    v_item.name,
    1,
    v_item.price,
    0,
    0,
    v_item.price,
    'fulfilled',
    0,
    jsonb_build_object(
      'fulfillment_type', 'digital_entitlement',
      'entitlement_status', 'active'
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
    commerce_order_id
  )
  values (
    p_studio_id,
    p_client_id,
    v_item.price,
    p_payment_method::public.payment_method,
    'paid',
    coalesce(
      nullif(trim(p_notes), ''),
      'Digital order ' || v_order_id::text
    ),
    now(),
    p_actor_user_id,
    'digital_sale',
    'commerce',
    'manual',
    coalesce(v_item.currency, 'usd'),
    nullif(trim(p_external_reference), ''),
    v_order_id
  )
  returning id into v_payment_id;

  update public.commerce_orders
  set payment_id = v_payment_id
  where id = v_order_id;

  insert into public.commerce_entitlements (
    studio_id,
    catalog_item_id,
    client_id,
    user_id,
    order_id,
    order_item_id,
    entitlement_type,
    status,
    granted_at,
    starts_at,
    created_by,
    updated_by,
    metadata
  )
  values (
    p_studio_id,
    p_catalog_item_id,
    p_client_id,
    v_user_id,
    v_order_id,
    v_order_item_id,
    'purchase',
    'active',
    now(),
    now(),
    p_actor_user_id,
    p_actor_user_id,
    jsonb_build_object(
      'payment_id', v_payment_id,
      'payment_method', p_payment_method
    )
  );

  return v_order_id;
end;
$$;
