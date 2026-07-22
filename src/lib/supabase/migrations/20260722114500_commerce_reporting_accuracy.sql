-- Commerce reporting accuracy and digital accounting classification.
-- Apply after 20260720223000_sync_retail_accounting.sql.
-- Apply before deploying the ARIA/reporting accuracy code.

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
    'digital_content_revenue',
    'Digital Content Revenue',
    'revenue',
    'credit',
    true,
    146,
    'revenue',
    'income',
    'credit',
    array['INCOME', 'REVENUE']::text[],
    true
  ),
  (
    'digital_content_refund',
    'Digital Content Refund',
    'refund',
    'debit',
    true,
    246,
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
  v_revenue_category text;
  v_refund_category text;
  v_is_digital boolean;
begin
  if new.status = 'completed' and new.payment_status in (
    'paid',
    'partially_refunded',
    'refunded'
  ) then
    select
      coalesce(sum(item.cogs_total), 0),
      bool_and(catalog.item_type in (
        'digital_video',
        'video_series',
        'digital_download'
      ))
    into v_cogs, v_is_digital
    from public.commerce_order_items item
    left join public.commerce_catalog_items catalog
      on catalog.id = item.catalog_item_id
    where item.order_id = new.id;

    v_is_digital := coalesce(v_is_digital, false);
    v_revenue_category := case
      when v_is_digital then 'digital_content_revenue'
      else 'retail_revenue'
    end;
    v_refund_category := case
      when v_is_digital then 'digital_content_refund'
      else 'retail_refund'
    end;

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
      v_revenue_category,
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
      case when v_is_digital then 'Digital content order ' else 'Retail order ' end || new.order_number,
      'active',
      coalesce(new.completed_at, now()),
      jsonb_build_object(
        'commerce_order_id', new.id,
        'order_number', new.order_number,
        'discount_total', coalesce(new.discount_total, 0),
        'tax_total', coalesce(new.tax_total, 0),
        'customer_type', new.customer_type,
        'commerce_revenue_class', case
          when v_is_digital then 'digital_content'
          else 'physical_retail'
        end
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

    if v_cogs > 0 and not v_is_digital then
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
        v_refund_category,
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
        case when v_is_digital then 'Digital content refund for order ' else 'Retail refund for order ' end || new.order_number,
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

-- Reclassify existing completed all-digital commerce orders.
update public.accounting_entries entry
set
  category = case
    when entry.entry_type = 'revenue' then 'digital_content_revenue'
    when entry.entry_type = 'refund' then 'digital_content_refund'
    else entry.category
  end,
  description = case
    when entry.entry_type = 'revenue'
      then 'Digital content order ' || orders.order_number
    when entry.entry_type = 'refund'
      then 'Digital content refund for order ' || orders.order_number
    else entry.description
  end,
  metadata = coalesce(entry.metadata, '{}'::jsonb) ||
    jsonb_build_object('commerce_revenue_class', 'digital_content'),
  updated_at = now()
from public.commerce_orders orders
where entry.source_table = 'commerce_orders'
  and entry.source_id = orders.id
  and entry.category in ('retail_revenue', 'retail_refund')
  and exists (
    select 1
    from public.commerce_order_items item
    join public.commerce_catalog_items catalog
      on catalog.id = item.catalog_item_id
    where item.order_id = orders.id
  )
  and not exists (
    select 1
    from public.commerce_order_items item
    left join public.commerce_catalog_items catalog
      on catalog.id = item.catalog_item_id
    where item.order_id = orders.id
      and (
        catalog.id is null
        or catalog.item_type not in (
          'digital_video',
          'video_series',
          'digital_download'
        )
      )
  );

-- Remove stale COGS rows from all-digital orders. Digital content does not use
-- physical inventory cost in the current Commerce model.
update public.accounting_entries entry
set
  entry_status = 'voided',
  voided_at = coalesce(entry.voided_at, now()),
  void_reason = coalesce(
    entry.void_reason,
    'Digital content order does not use physical retail COGS.'
  ),
  updated_at = now()
from public.commerce_orders orders
where entry.source_table = 'commerce_orders'
  and entry.source_id = orders.id
  and entry.entry_type = 'expense'
  and entry.category = 'retail_cogs'
  and entry.entry_status = 'active'
  and entry.locked_at is null
  and exists (
    select 1
    from public.commerce_order_items item
    join public.commerce_catalog_items catalog
      on catalog.id = item.catalog_item_id
    where item.order_id = orders.id
  )
  and not exists (
    select 1
    from public.commerce_order_items item
    left join public.commerce_catalog_items catalog
      on catalog.id = item.catalog_item_id
    where item.order_id = orders.id
      and (
        catalog.id is null
        or catalog.item_type not in (
          'digital_video',
          'video_series',
          'digital_download'
        )
      )
  );

-- Re-run synchronization idempotently so current completed orders have the
-- correct revenue/refund category and metadata.
update public.commerce_orders
set updated_at = updated_at
where status = 'completed'
  and payment_status in ('paid', 'partially_refunded', 'refunded');

commit;
