begin;

create table if not exists public.package_sales (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  package_template_id uuid not null references public.package_templates(id) on delete restrict,
  client_package_id uuid references public.client_packages(id) on delete set null,
  sale_total numeric(12,2) not null check (sale_total >= 0),
  account_credit_applied numeric(12,2) not null default 0 check (account_credit_applied >= 0),
  tender_total numeric(12,2) not null default 0 check (tender_total >= 0),
  remaining_balance numeric(12,2) not null default 0 check (remaining_balance >= 0),
  status text not null default 'completed'
    check (status in ('draft','pending','completed','void','refunded')),
  purchase_date date not null,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists package_sales_studio_created_idx
  on public.package_sales (studio_id, created_at desc);

create index if not exists package_sales_client_created_idx
  on public.package_sales (client_id, created_at desc);

alter table public.payments
  add column if not exists package_sale_id uuid
  references public.package_sales(id) on delete set null;

alter table public.payments
  add column if not exists tender_reference text;

create index if not exists payments_package_sale_idx
  on public.payments (package_sale_id);

alter table public.package_sales enable row level security;

drop policy if exists "package sales studio staff read" on public.package_sales;
create policy "package sales studio staff read"
  on public.package_sales
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = package_sales.studio_id
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

create or replace function public.create_package_sale_with_split_payments(
  p_client_id uuid,
  p_package_template_id uuid,
  p_purchase_date date,
  p_account_credit numeric,
  p_tenders jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_studio_id uuid;
  v_template public.package_templates%rowtype;
  v_client_package_id uuid;
  v_sale_id uuid;
  v_price numeric(12,2);
  v_credit numeric(12,2) := round(coalesce(p_account_credit, 0)::numeric, 2);
  v_tender_total numeric(12,2);
  v_available_credit numeric(12,2);
  v_expiration_date date;
  v_tender jsonb;
  v_method text;
  v_amount numeric(12,2);
  v_reference text;
  v_tender_count integer;
  v_summary text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  select pt.*
    into v_template
  from public.package_templates pt
  where pt.id = p_package_template_id
    and pt.active = true;

  if not found then
    raise exception 'Package template not found or inactive.';
  end if;

  v_studio_id := v_template.studio_id;

  if not exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = v_studio_id
      and usr.user_id = v_user_id
      and usr.active = true
      and usr.role::text in (
        'platform_admin',
        'studio_owner',
        'studio_admin',
        'front_desk'
      )
  ) then
    raise exception 'You do not have permission to sell packages.';
  end if;

  if not exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found.';
  end if;

  if not exists (
    select 1
    from public.package_template_items pti
    where pti.package_template_id = p_package_template_id
      and pti.studio_id = v_studio_id
  ) then
    raise exception 'This package template has no included items.';
  end if;

  if jsonb_typeof(p_tenders) <> 'array' then
    raise exception 'Payment methods are invalid.';
  end if;

  v_tender_count := jsonb_array_length(p_tenders);
  if v_tender_count < 1 or v_tender_count > 10 then
    raise exception 'Add between 1 and 10 payment methods.';
  end if;

  select coalesce(round(sum((item->>'amount')::numeric), 2), 0)
    into v_tender_total
  from jsonb_array_elements(p_tenders) item;

  if exists (
    select 1
    from jsonb_array_elements(p_tenders) item
    where coalesce(item->>'method', '') not in (
      'card','cash','check','ach','venmo','zelle','other'
    )
      or coalesce((item->>'amount')::numeric, 0) <= 0
  ) then
    raise exception 'Each payment requires a valid method and positive amount.';
  end if;

  v_price := round(coalesce(v_template.price, 0)::numeric, 2);

  if v_credit < 0 or v_credit > v_price then
    raise exception 'Account credit amount is invalid.';
  end if;

  if round(v_credit + v_tender_total, 2) <> v_price then
    raise exception 'Payments plus account credit must equal the package price.';
  end if;

  if v_credit > 0 then
    select coalesce(
      round(
        sum(
          case
            when cal.direction = 'credit' then cal.amount
            else -cal.amount
          end
        ),
        2
      ),
      0
    )
      into v_available_credit
    from public.client_account_ledger cal
    where cal.studio_id = v_studio_id
      and cal.client_id = p_client_id;

    if v_credit > v_available_credit then
      raise exception 'Account credit exceeds the available balance.';
    end if;
  end if;

  v_expiration_date :=
    case
      when v_template.expiration_days is null then null
      else p_purchase_date + v_template.expiration_days
    end;

  insert into public.client_packages (
    studio_id,
    client_id,
    package_template_id,
    name_snapshot,
    price_snapshot,
    sold_price,
    purchase_date,
    expiration_date,
    active,
    created_by
  )
  values (
    v_studio_id,
    p_client_id,
    v_template.id,
    v_template.name,
    v_price,
    v_price,
    p_purchase_date,
    v_expiration_date,
    true,
    v_user_id
  )
  returning id into v_client_package_id;

  insert into public.client_package_items (
    studio_id,
    client_package_id,
    usage_type,
    quantity_total,
    quantity_used,
    quantity_remaining,
    is_unlimited
  )
  select
    v_studio_id,
    v_client_package_id,
    pti.usage_type,
    case when pti.is_unlimited then null else pti.quantity end,
    0,
    case when pti.is_unlimited then null else pti.quantity end,
    pti.is_unlimited
  from public.package_template_items pti
  where pti.package_template_id = p_package_template_id
    and pti.studio_id = v_studio_id;

  insert into public.package_sales (
    studio_id,
    client_id,
    package_template_id,
    client_package_id,
    sale_total,
    account_credit_applied,
    tender_total,
    remaining_balance,
    status,
    purchase_date,
    notes,
    created_by
  )
  values (
    v_studio_id,
    p_client_id,
    p_package_template_id,
    v_client_package_id,
    v_price,
    v_credit,
    v_tender_total,
    0,
    'completed',
    p_purchase_date,
    nullif(left(coalesce(p_notes, ''), 1000), ''),
    v_user_id
  )
  returning id into v_sale_id;

  for v_tender in
    select value from jsonb_array_elements(p_tenders)
  loop
    v_method := v_tender->>'method';
    v_amount := round((v_tender->>'amount')::numeric, 2);
    v_reference := nullif(left(trim(coalesce(v_tender->>'reference', '')), 160), '');

    insert into public.payments (
      studio_id,
      client_id,
      client_package_id,
      package_sale_id,
      amount,
      payment_method,
      status,
      notes,
      paid_at,
      created_by,
      payment_type,
      accounting_category,
      source,
      payment_channel,
      currency,
      tender_reference
    )
    values (
      v_studio_id,
      p_client_id,
      v_client_package_id,
      v_sale_id,
      v_amount,
      v_method,
      'paid',
      nullif(
        concat_ws(
          ' | ',
          nullif(left(coalesce(p_notes, ''), 1000), ''),
          case when v_reference is not null then 'Reference: ' || v_reference end,
          case when v_tender_count > 1 then 'Split payment' end
        ),
        ''
      ),
      now(),
      v_user_id,
      'package_sale',
      'package_revenue',
      'manual',
      'manual',
      'usd',
      v_reference
    );
  end loop;

  if v_credit > 0 then
    insert into public.client_account_ledger (
      studio_id,
      client_id,
      entry_date,
      entry_type,
      direction,
      amount,
      description,
      reference_type,
      reference_id,
      created_by
    )
    values (
      v_studio_id,
      p_client_id,
      p_purchase_date,
      'credit_applied',
      'debit',
      v_credit,
      'Applied account credit to package purchase: ' || v_template.name,
      'client_package',
      v_client_package_id,
      v_user_id
    );
  end if;

  select string_agg(
    case
      when pti.is_unlimited then
        case
          when pti.usage_type = 'private_lesson' then 'Private: Unlimited'
          when pti.usage_type = 'group_class' then 'Group: Unlimited'
          else 'Practice: Unlimited'
        end
      else
        case
          when pti.usage_type = 'private_lesson' then 'Private: ' || pti.quantity
          when pti.usage_type = 'group_class' then 'Group: ' || pti.quantity
          else 'Practice: ' || pti.quantity
        end
    end,
    ' | '
  )
    into v_summary
  from public.package_template_items pti
  where pti.package_template_id = p_package_template_id
    and pti.studio_id = v_studio_id;

  insert into public.lesson_transactions (
    studio_id,
    client_id,
    client_package_id,
    transaction_type,
    lessons_delta,
    balance_after,
    notes,
    created_by
  )
  values (
    v_studio_id,
    p_client_id,
    v_client_package_id,
    'package_purchase',
    null,
    null,
    'Package purchased: ' || v_template.name || ' (' || coalesce(v_summary, '') || ')',
    v_user_id
  );

  return v_sale_id;
end;
$$;

revoke all on function public.create_package_sale_with_split_payments(
  uuid,
  uuid,
  date,
  numeric,
  jsonb,
  text
) from public;

grant execute on function public.create_package_sale_with_split_payments(
  uuid,
  uuid,
  date,
  numeric,
  jsonb,
  text
) to authenticated;

commit;
