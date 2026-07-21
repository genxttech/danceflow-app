-- Commerce Slice 4: retail accounting source-of-truth synchronization.
-- Apply after 20260720214500_create_commerce_physical_checkout.sql.
-- Apply before deploying Slice 4.

begin;

insert into public.accounting_categories (
  key,
  label,
  entry_type,
  normal_balance,
  active,
  sort_order,
  entry_class,
  statement_section,
  normal_direction,
  allowed_external_account_types,
  blocks_auto_post_when_unmapped
)
values
  (
    'retail_revenue',
    'Retail Product Revenue',
    'revenue',
    'credit',
    true,
    145,
    'revenue',
    'income',
    'credit',
    array['INCOME', 'REVENUE']::text[],
    true
  ),
  (
    'retail_cogs',
    'Retail Cost of Goods Sold',
    'expense',
    'debit',
    true,
    445,
    'expense',
    'cost_of_sales',
    'debit',
    array['EXPENSE', 'COST_OF_GOODS_SOLD']::text[],
    true
  ),
  (
    'retail_refund',
    'Retail Product Refund',
    'refund',
    'debit',
    true,
    245,
    'refund',
    'contra_income',
    'debit',
    array['INCOME', 'REVENUE', 'EXPENSE']::text[],
    true
  )
on conflict (key) do update
set
  label = excluded.label,
  entry_type = excluded.entry_type,
  normal_balance = excluded.normal_balance,
  active = excluded.active,
  sort_order = excluded.sort_order,
  entry_class = excluded.entry_class,
  statement_section = excluded.statement_section,
  normal_direction = excluded.normal_direction,
  allowed_external_account_types = excluded.allowed_external_account_types,
  blocks_auto_post_when_unmapped = excluded.blocks_auto_post_when_unmapped;

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
      studio_id,
      organizer_id,
      entry_date,
      entry_type,
      category,
      direction,
      gross_amount,
      fee_amount,
      refund_amount,
      net_amount,
      currency,
      payment_method,
      source_table,
      source_id,
      client_id,
      event_id,
      appointment_id,
      external_reference,
      stripe_payment_intent_id,
      stripe_charge_id,
      stripe_invoice_id,
      description,
      entry_status,
      posted_at,
      metadata
    )
    values (
      new.studio_id,
      null,
      coalesce(new.completed_at, new.created_at, now())::date,
      'revenue',
      'retail_revenue',
      'credit',
      greatest(coalesce(new.subtotal, 0) - coalesce(new.discount_total, 0), 0),
      0,
      0,
      greatest(coalesce(new.total, 0), 0),
      coalesce(new.currency, 'usd'),
      v_payment_method,
      'commerce_orders',
      new.id,
      new.client_id,
      null,
      null,
      new.order_number,
      null,
      null,
      null,
      'Retail order ' || new.order_number,
      'active',
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
      posted_at = excluded.posted_at,
      metadata = excluded.metadata,
      updated_at = now();

    if v_cogs > 0 then
      insert into public.accounting_entries (
        studio_id,
        organizer_id,
        entry_date,
        entry_type,
        category,
        direction,
        gross_amount,
        fee_amount,
        refund_amount,
        net_amount,
        currency,
        payment_method,
        source_table,
        source_id,
        client_id,
        event_id,
        appointment_id,
        external_reference,
        stripe_payment_intent_id,
        stripe_charge_id,
        stripe_invoice_id,
        description,
        entry_status,
        posted_at,
        metadata
      )
      values (
        new.studio_id,
        null,
        coalesce(new.completed_at, new.created_at, now())::date,
        'expense',
        'retail_cogs',
        'debit',
        v_cogs,
        0,
        0,
        v_cogs,
        coalesce(new.currency, 'usd'),
        v_payment_method,
        'commerce_orders',
        new.id,
        new.client_id,
        null,
        null,
        new.order_number,
        null,
        null,
        null,
        'Cost of goods sold for retail order ' || new.order_number,
        'active',
        coalesce(new.completed_at, now()),
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
        posted_at = excluded.posted_at,
        metadata = excluded.metadata,
        updated_at = now();
    end if;

    if v_refund > 0 then
      insert into public.accounting_entries (
        studio_id,
        organizer_id,
        entry_date,
        entry_type,
        category,
        direction,
        gross_amount,
        fee_amount,
        refund_amount,
        net_amount,
        currency,
        payment_method,
        source_table,
        source_id,
        client_id,
        event_id,
        appointment_id,
        external_reference,
        stripe_payment_intent_id,
        stripe_charge_id,
        stripe_invoice_id,
        description,
        entry_status,
        posted_at,
        metadata
      )
      values (
        new.studio_id,
        null,
        coalesce(new.completed_at, new.created_at, now())::date,
        'refund',
        'retail_refund',
        'debit',
        0,
        0,
        v_refund,
        v_refund,
        coalesce(new.currency, 'usd'),
        v_payment_method,
        'commerce_orders',
        new.id,
        new.client_id,
        null,
        null,
        new.order_number,
        null,
        null,
        null,
        'Retail refund for order ' || new.order_number,
        'active',
        now(),
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

drop trigger if exists commerce_orders_sync_accounting
  on public.commerce_orders;

create trigger commerce_orders_sync_accounting
after insert or update of
  status,
  payment_status,
  subtotal,
  discount_total,
  tax_total,
  refund_total,
  total,
  payment_id,
  completed_at
on public.commerce_orders
for each row
execute function public.sync_commerce_order_accounting_entries();

-- Backfill with an idempotent update that invokes the trigger without
-- changing financial values.
update public.commerce_orders
set updated_at = updated_at
where status = 'completed'
  and payment_status in ('paid', 'partially_refunded', 'refunded');

revoke execute
on function public.sync_commerce_order_accounting_entries()
from public, anon, authenticated;

grant execute
on function public.sync_commerce_order_accounting_entries()
to service_role;

commit;
