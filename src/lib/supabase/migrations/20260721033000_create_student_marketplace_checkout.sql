-- Commerce Slice 9: student marketplace checkout and atomic fulfillment.
-- Apply after 20260721015500_fix_commerce_payment_method_enum.sql.
-- Apply before deploying the student marketplace API and Stripe webhook changes.

create or replace function public.commerce_finalize_student_digital_order(
  p_order_id uuid,
  p_stripe_payment_intent_id text,
  p_amount numeric,
  p_currency text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_item record;
  v_user_id uuid;
  v_payment_id uuid;
  v_entitlement_id uuid;
begin
  select *
  into v_order
  from public.commerce_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Commerce order was not found.';
  end if;

  if v_order.status = 'completed' and v_order.payment_status = 'paid' then
    select id into v_entitlement_id
    from public.commerce_entitlements
    where order_id = v_order.id
    order by created_at asc
    limit 1;

    return v_entitlement_id;
  end if;

  if v_order.status <> 'open' or v_order.payment_status <> 'pending' then
    raise exception 'Commerce order is not awaiting payment.';
  end if;

  if abs(v_order.total - p_amount) > 0.01 then
    raise exception 'Commerce order amount does not match the payment.';
  end if;

  if lower(v_order.currency) <> lower(coalesce(p_currency, 'usd')) then
    raise exception 'Commerce order currency does not match the payment.';
  end if;

  v_user_id := nullif(v_order.metadata ->> 'student_user_id', '')::uuid;

  if v_user_id is null then
    raise exception 'Commerce order is missing the student account.';
  end if;

  select *
  into v_item
  from public.commerce_order_items
  where order_id = v_order.id
  order by created_at asc
  limit 1;

  if not found or v_item.catalog_item_id is null then
    raise exception 'Commerce order item was not found.';
  end if;

  if exists (
    select 1
    from public.commerce_entitlements e
    where e.user_id = v_user_id
      and e.catalog_item_id = v_item.catalog_item_id
      and e.status in ('active', 'refunded_access_retained')
  ) then
    raise exception 'This student already owns this content.';
  end if;

  select id
  into v_payment_id
  from public.payments
  where stripe_payment_intent_id = p_stripe_payment_intent_id
  limit 1;

  if v_payment_id is null then
    insert into public.payments (
      studio_id,
      client_id,
      amount,
      payment_method,
      status,
      notes,
      paid_at,
      payment_type,
      source,
      payment_channel,
      currency,
      external_reference,
      external_payment_id,
      stripe_payment_intent_id,
      commerce_order_id
    )
    values (
      v_order.studio_id,
      v_order.client_id,
      v_order.total,
      'card'::public.payment_method,
      'paid',
      'Student marketplace digital purchase',
      now(),
      'digital_sale',
      'commerce',
      'online',
      lower(v_order.currency),
      p_stripe_payment_intent_id,
      p_stripe_payment_intent_id,
      p_stripe_payment_intent_id,
      v_order.id
    )
    returning id into v_payment_id;
  end if;

  update public.commerce_orders
  set
    status = 'completed',
    payment_status = 'paid',
    fulfillment_status = 'fulfilled',
    payment_id = v_payment_id,
    completed_at = now(),
    updated_at = now(),
    metadata = metadata || jsonb_build_object(
      'stripe_payment_intent_id', p_stripe_payment_intent_id,
      'fulfilled_at', now()
    )
  where id = v_order.id;

  update public.commerce_order_items
  set
    fulfillment_status = 'fulfilled',
    updated_at = now()
  where id = v_item.id;

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
    metadata
  )
  values (
    v_order.studio_id,
    v_item.catalog_item_id,
    v_order.client_id,
    v_user_id,
    v_order.id,
    v_item.id,
    'purchase',
    'active',
    now(),
    now(),
    jsonb_build_object(
      'payment_id', v_payment_id,
      'payment_method', 'card',
      'source', 'student_marketplace',
      'stripe_payment_intent_id', p_stripe_payment_intent_id
    )
  )
  returning id into v_entitlement_id;

  return v_entitlement_id;
end;
$$;

revoke all on function public.commerce_finalize_student_digital_order(
  uuid, text, numeric, text
) from public, anon, authenticated;

grant execute on function public.commerce_finalize_student_digital_order(
  uuid, text, numeric, text
) to service_role;
