-- Commerce Slice 6: digital purchases and student entitlements.
-- Apply after 20260720231500_create_commerce_digital_content.sql.
-- Apply before deploying Slice 6.

create table if not exists public.commerce_entitlements (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  catalog_item_id uuid not null references public.commerce_catalog_items(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid references public.commerce_orders(id) on delete set null,
  order_item_id uuid references public.commerce_order_items(id) on delete set null,
  entitlement_type text not null default 'purchase',
  status text not null default 'active',
  granted_at timestamptz not null default now(),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_entitlements_type_check
    check (entitlement_type in ('purchase', 'manual_grant', 'promotion')),
  constraint commerce_entitlements_status_check
    check (
      status in (
        'active',
        'revoked',
        'expired',
        'refunded_access_retained'
      )
    ),
  constraint commerce_entitlements_dates_check
    check (expires_at is null or expires_at >= starts_at)
);

create unique index if not exists commerce_entitlements_active_unique
  on public.commerce_entitlements(user_id, catalog_item_id)
  where status in ('active', 'refunded_access_retained');

create index if not exists commerce_entitlements_user_idx
  on public.commerce_entitlements(user_id, status, granted_at desc);

create index if not exists commerce_entitlements_studio_idx
  on public.commerce_entitlements(studio_id, status, granted_at desc);

drop trigger if exists commerce_entitlements_set_updated_at
  on public.commerce_entitlements;

create trigger commerce_entitlements_set_updated_at
before update on public.commerce_entitlements
for each row execute function public.commerce_set_updated_at();

alter table public.commerce_entitlements enable row level security;

drop policy if exists "commerce entitlements student read"
  on public.commerce_entitlements;
create policy "commerce entitlements student read"
  on public.commerce_entitlements
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "commerce entitlements studio read"
  on public.commerce_entitlements;
create policy "commerce entitlements studio read"
  on public.commerce_entitlements
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_entitlements.studio_id
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

drop policy if exists "commerce entitlements managers write"
  on public.commerce_entitlements;
create policy "commerce entitlements managers write"
  on public.commerce_entitlements
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_entitlements.studio_id
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
      where usr.studio_id = commerce_entitlements.studio_id
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
  on public.commerce_entitlements
  to authenticated;

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
    p_payment_method,
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

grant execute
  on function public.commerce_complete_manual_digital_sale(
    uuid,
    uuid,
    uuid,
    text,
    text,
    text,
    uuid
  )
  to authenticated;
