-- G-01b -- the studio is told about a COMMITTED marketplace purchase (and only that).
--
-- Stacked on G-01 (20270220090000: marketplace buyers are guests; no lead, no link). Before G-01 the studio indirectly
-- "saw" a buyer as a new lead; now it needs an explicit signal. This migration:
--   1. extends notifications_type_check in place with 'marketplace_purchase' (same pattern as PAY-WH-1A's
--      'payment_exception': the live definition is kept verbatim and saved for the rollback);
--   2. replaces commerce_finalize_student_digital_order with its 20260721033000 body PLUS one in-transaction insert of a
--      deduplicated studio notification, made at the single point where settlement is committed. Every integrity check,
--      the entitlement insert and the idempotent replay branch are unchanged. The notification insert runs in a
--      sub-transaction: if it were ever to fail, fulfilment (entitlement + payment record) still commits and a WARNING is
--      raised -- a notice can never take a paid purchase down.
--
-- Emitted exactly once per order: the dedupe_key 'marketplace_purchase:<order id>' is unique; the replay branch (a
-- re-delivered webhook / confirm call for an already-completed order) returns before reaching the insert; amount,
-- currency, status and ownership failures raise before it. Nothing is emitted for pending, failed, cancelled, expired,
-- abandoned or preview orders (those never reach settlement). Tenant: studio_id is the ORDER's studio.
-- Content is minimal and matches the event notices: buyer display name, item, amount, order number (no email, no
-- payment identifiers).
--
-- No client, lead or link is created. Hosted SQL is NOT applied by this change; apply in order after 20270220090000.
-- Rollback: rollback/20270220100000_g01b_marketplace_purchase_notice_rollback.sql

begin;

create table if not exists public._paywh1a_saved_constraints (
  table_name text not null,
  constraint_name text not null,
  definition text not null,
  saved_at timestamptz not null default now(),
  primary key (table_name, constraint_name)
);
revoke all on public._paywh1a_saved_constraints from public, anon, authenticated;

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
  where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  if v_def is null then
    raise exception 'g01b: notifications_type_check not found';
  end if;
  if position('marketplace_purchase' in v_def) > 0 then
    return; -- already extended
  end if;
  -- Save the pre-G-01b definition under its own key (never overwrite another change's saved definition).
  insert into public._paywh1a_saved_constraints (table_name, constraint_name, definition)
  values ('notifications', 'notifications_type_check:g01b', v_def)
  on conflict (table_name, constraint_name) do nothing;
  execute 'alter table public.notifications drop constraint notifications_type_check';
  execute format('alter table public.notifications add constraint notifications_type_check check ((%s) or type = %L)',
                 regexp_replace(v_def, '^CHECK \((.*)\)$', '\1'), 'marketplace_purchase');
end $$;

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
  v_buyer text;
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


  -- G-01b: tell the studio, once, that a purchase is committed. Same transaction as the settlement above.
  v_buyer := null;
  if v_order.client_id is not null then
    select nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') into v_buyer
    from public.clients c where c.id = v_order.client_id and c.studio_id = v_order.studio_id;
  end if;
  begin
    insert into public.notifications (studio_id, client_id, type, category, priority, title, body, dedupe_key)
    values (
      v_order.studio_id,
      v_order.client_id,
      'marketplace_purchase',
      'payment',
      'normal',
      'New marketplace purchase',
      format('%s bought "%s" for %s %s (order %s).',
             coalesce(v_buyer, nullif(btrim(coalesce(v_order.guest_name, '')), ''), 'A DanceFlow student'),
             coalesce(nullif(btrim(coalesce(v_item.name_snapshot, '')), ''), 'digital content'),
             to_char(v_order.total, 'FM999999990.00'),
             upper(coalesce(v_order.currency, 'usd')),
             coalesce(v_order.order_number, v_order.id::text)),
      'marketplace_purchase:' || v_order.id::text
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  exception when others then
    raise warning 'g01b: marketplace purchase notice not recorded for order %: %', v_order.id, sqlerrm;
  end;

  return v_entitlement_id;
end;
$$;

revoke all on function public.commerce_finalize_student_digital_order(
  uuid, text, numeric, text
) from public, anon, authenticated;

grant execute on function public.commerce_finalize_student_digital_order(
  uuid, text, numeric, text
) to service_role;

notify pgrst, 'reload schema';

commit;
