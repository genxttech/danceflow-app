begin;

create table if not exists public.payment_arrangements (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  package_sale_id uuid not null unique references public.package_sales(id) on delete restrict,
  client_package_id uuid not null references public.client_packages(id) on delete restrict,
  original_balance numeric(12,2) not null check (original_balance > 0),
  down_payment numeric(12,2) not null default 0 check (down_payment >= 0),
  financed_balance numeric(12,2) not null check (financed_balance > 0),
  remaining_balance numeric(12,2) not null check (remaining_balance >= 0),
  installment_count integer not null check (installment_count between 1 and 60),
  frequency text not null check (frequency in ('weekly','biweekly','monthly')),
  first_due_date date not null,
  access_policy text not null default 'immediate'
    check (access_policy in ('immediate','paid_in_full')),
  status text not null default 'active'
    check (status in ('active','completed','defaulted','void')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_installments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  arrangement_id uuid not null references public.payment_arrangements(id) on delete cascade,
  sequence_number integer not null check (sequence_number > 0),
  due_date date not null,
  amount_due numeric(12,2) not null check (amount_due > 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  status text not null default 'scheduled'
    check (status in ('scheduled','partial','paid','overdue','void')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (arrangement_id, sequence_number)
);

alter table public.payments
  add column if not exists payment_arrangement_id uuid
  references public.payment_arrangements(id) on delete set null;

alter table public.payments
  add column if not exists payment_installment_id uuid
  references public.payment_installments(id) on delete set null;

create index if not exists payment_arrangements_studio_status_idx
  on public.payment_arrangements (studio_id, status, first_due_date);

create index if not exists payment_arrangements_client_idx
  on public.payment_arrangements (client_id, status);

create index if not exists payment_installments_arrangement_due_idx
  on public.payment_installments (arrangement_id, due_date, sequence_number);

create index if not exists payments_arrangement_idx
  on public.payments (payment_arrangement_id);

alter table public.payment_arrangements enable row level security;
alter table public.payment_installments enable row level security;

drop policy if exists "payment arrangements studio staff read" on public.payment_arrangements;
create policy "payment arrangements studio staff read"
  on public.payment_arrangements
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = payment_arrangements.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin','studio_owner','studio_admin','front_desk')
    )
  );

drop policy if exists "payment installments studio staff read" on public.payment_installments;
create policy "payment installments studio staff read"
  on public.payment_installments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = payment_installments.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin','studio_owner','studio_admin','front_desk')
    )
  );

create or replace function public.create_package_sale_with_payment_arrangement(
  p_client_id uuid,
  p_package_template_id uuid,
  p_purchase_date date,
  p_account_credit numeric,
  p_tenders jsonb,
  p_installment_count integer,
  p_frequency text,
  p_first_due_date date,
  p_access_policy text,
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
  v_arrangement_id uuid;
  v_price numeric(12,2);
  v_credit numeric(12,2) := round(coalesce(p_account_credit, 0)::numeric, 2);
  v_tender_total numeric(12,2) := 0;
  v_financed numeric(12,2);
  v_available_credit numeric(12,2);
  v_expiration_date date;
  v_tender jsonb;
  v_method text;
  v_amount numeric(12,2);
  v_reference text;
  v_tender_count integer := 0;
  v_base_cents bigint;
  v_remainder_cents integer;
  v_installment_cents bigint;
  v_due_date date;
  i integer;
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
      and usr.role::text in ('platform_admin','studio_owner','studio_admin','front_desk')
  ) then
    raise exception 'You do not have permission to sell packages.';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found.';
  end if;

  if p_installment_count < 1 or p_installment_count > 60 then
    raise exception 'Installment count must be between 1 and 60.';
  end if;

  if p_frequency not in ('weekly','biweekly','monthly') then
    raise exception 'Payment frequency is invalid.';
  end if;

  if p_access_policy not in ('immediate','paid_in_full') then
    raise exception 'Package access policy is invalid.';
  end if;

  if p_first_due_date < p_purchase_date then
    raise exception 'First installment due date cannot be before the purchase date.';
  end if;

  if jsonb_typeof(coalesce(p_tenders, '[]'::jsonb)) <> 'array' then
    raise exception 'Payment methods are invalid.';
  end if;

  v_tender_count := jsonb_array_length(coalesce(p_tenders, '[]'::jsonb));
  if v_tender_count > 10 then
    raise exception 'No more than 10 payment methods may be used.';
  end if;

  if v_tender_count > 0 then
    select coalesce(round(sum((item->>'amount')::numeric), 2), 0)
      into v_tender_total
    from jsonb_array_elements(p_tenders) item;

    if exists (
      select 1
      from jsonb_array_elements(p_tenders) item
      where coalesce(item->>'method', '') not in
        ('card','cash','check','ach','venmo','zelle','other')
        or coalesce((item->>'amount')::numeric, 0) <= 0
    ) then
      raise exception 'Each payment requires a valid method and positive amount.';
    end if;
  end if;

  v_price := round(coalesce(v_template.price, 0)::numeric, 2);

  if v_credit < 0 or v_credit > v_price then
    raise exception 'Account credit amount is invalid.';
  end if;

  v_financed := round(v_price - v_credit - v_tender_total, 2);

  if v_financed <= 0 then
    raise exception 'A payment arrangement requires a remaining balance greater than zero.';
  end if;

  if v_credit > 0 then
    select coalesce(round(sum(
      case when cal.direction = 'credit' then cal.amount else -cal.amount end
    ), 2), 0)
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
      else p_purchase_date + v_template.expiration_days::integer
    end;

  insert into public.client_packages (
    studio_id, client_id, package_template_id, name_snapshot,
    price_snapshot, sold_price, purchase_date, expiration_date,
    active, created_by
  )
  values (
    v_studio_id, p_client_id, v_template.id, v_template.name,
    v_price, v_price, p_purchase_date, v_expiration_date,
    p_access_policy = 'immediate', v_user_id
  )
  returning id into v_client_package_id;

  insert into public.client_package_items (
    studio_id, client_package_id, usage_type, quantity_total,
    quantity_used, quantity_remaining, is_unlimited
  )
  select
    v_studio_id, v_client_package_id, pti.usage_type,
    case when pti.is_unlimited then null else pti.quantity end,
    0,
    case when pti.is_unlimited then null else pti.quantity end,
    pti.is_unlimited
  from public.package_template_items pti
  where pti.package_template_id = p_package_template_id
    and pti.studio_id = v_studio_id;

  if not found then
    raise exception 'This package template has no included items.';
  end if;

  insert into public.package_sales (
    studio_id, client_id, package_template_id, client_package_id,
    sale_total, account_credit_applied, tender_total, remaining_balance,
    status, purchase_date, notes, created_by
  )
  values (
    v_studio_id, p_client_id, p_package_template_id, v_client_package_id,
    v_price, v_credit, v_tender_total, v_financed,
    'pending', p_purchase_date, nullif(left(coalesce(p_notes,''),1000),''), v_user_id
  )
  returning id into v_sale_id;

  insert into public.payment_arrangements (
    studio_id, client_id, package_sale_id, client_package_id,
    original_balance, down_payment, financed_balance, remaining_balance,
    installment_count, frequency, first_due_date, access_policy,
    status, notes, created_by
  )
  values (
    v_studio_id, p_client_id, v_sale_id, v_client_package_id,
    v_price, v_credit + v_tender_total, v_financed, v_financed,
    p_installment_count, p_frequency, p_first_due_date, p_access_policy,
    'active', nullif(left(coalesce(p_notes,''),1000),''), v_user_id
  )
  returning id into v_arrangement_id;

  if v_tender_count > 0 then
    for v_tender in select value from jsonb_array_elements(p_tenders)
    loop
      v_method := v_tender->>'method';
      v_amount := round((v_tender->>'amount')::numeric, 2);
      v_reference := nullif(left(trim(coalesce(v_tender->>'reference','')),160),'');

      insert into public.payments (
        studio_id, client_id, client_package_id, package_sale_id,
        payment_arrangement_id, amount, payment_method, status, notes,
        paid_at, created_by, payment_type, accounting_category,
        source, payment_channel, currency, tender_reference
      )
      values (
        v_studio_id, p_client_id, v_client_package_id, v_sale_id,
        v_arrangement_id, v_amount, v_method::public.payment_method, 'paid',
        nullif(concat_ws(' | ',
          nullif(left(coalesce(p_notes,''),1000),''),
          case when v_reference is not null then 'Reference: ' || v_reference end,
          'Payment arrangement down payment'
        ),''),
        now(), v_user_id, 'package_sale', 'package_revenue',
        'manual', 'manual', 'usd', v_reference
      );
    end loop;
  end if;

  if v_credit > 0 then
    insert into public.client_account_ledger (
      studio_id, client_id, entry_date, entry_type, direction,
      amount, description, reference_type, reference_id, created_by
    )
    values (
      v_studio_id, p_client_id, p_purchase_date, 'credit_applied', 'debit',
      v_credit, 'Applied account credit to package payment arrangement: ' || v_template.name,
      'client_package', v_client_package_id, v_user_id
    );
  end if;

  v_base_cents := floor((v_financed * 100)::numeric / p_installment_count);
  v_remainder_cents := ((v_financed * 100)::bigint - (v_base_cents * p_installment_count))::integer;

  for i in 1..p_installment_count loop
    v_installment_cents := v_base_cents + case when i <= v_remainder_cents then 1 else 0 end;

    v_due_date :=
      case p_frequency
        when 'weekly' then p_first_due_date + ((i - 1) * 7)
        when 'biweekly' then p_first_due_date + ((i - 1) * 14)
        else (p_first_due_date + make_interval(months => i - 1))::date
      end;

    insert into public.payment_installments (
      studio_id, arrangement_id, sequence_number, due_date,
      amount_due, amount_paid, status
    )
    values (
      v_studio_id, v_arrangement_id, i, v_due_date,
      v_installment_cents::numeric / 100, 0, 'scheduled'
    );
  end loop;

  insert into public.lesson_transactions (
    studio_id, client_id, client_package_id, transaction_type,
    lessons_delta, balance_after, notes, created_by
  )
  values (
    v_studio_id, p_client_id, v_client_package_id, 'package_purchase',
    null, null,
    'Package purchased with payment arrangement: ' || v_template.name,
    v_user_id
  );

  return v_sale_id;
end;
$$;

create or replace function public.apply_manual_payment_to_arrangement(
  p_arrangement_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_date date,
  p_reference text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_arrangement public.payment_arrangements%rowtype;
  v_amount numeric(12,2) := round(coalesce(p_amount,0)::numeric,2);
  v_remaining_to_apply numeric(12,2);
  v_apply numeric(12,2);
  v_installment public.payment_installments%rowtype;
  v_payment_id uuid;
  v_new_remaining numeric(12,2);
begin
  if v_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  select *
    into v_arrangement
  from public.payment_arrangements
  where id = p_arrangement_id
  for update;

  if not found or v_arrangement.status <> 'active' then
    raise exception 'Active payment arrangement not found.';
  end if;

  if not exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = v_arrangement.studio_id
      and usr.user_id = v_user_id
      and usr.active = true
      and usr.role::text in ('platform_admin','studio_owner','studio_admin','front_desk')
  ) then
    raise exception 'You do not have permission to record this payment.';
  end if;

  if p_payment_method not in ('card','cash','check','ach','venmo','zelle','other') then
    raise exception 'Payment method is invalid.';
  end if;

  if v_amount <= 0 or v_amount > v_arrangement.remaining_balance then
    raise exception 'Payment must be greater than zero and no more than the remaining balance.';
  end if;

  insert into public.payments (
    studio_id, client_id, client_package_id, package_sale_id,
    payment_arrangement_id, amount, payment_method, status, notes,
    paid_at, created_by, payment_type, accounting_category,
    source, payment_channel, currency, tender_reference
  )
  values (
    v_arrangement.studio_id, v_arrangement.client_id,
    v_arrangement.client_package_id, v_arrangement.package_sale_id,
    v_arrangement.id, v_amount, p_payment_method::public.payment_method,
    'paid',
    nullif(concat_ws(' | ',
      nullif(left(coalesce(p_notes,''),1000),''),
      case when nullif(trim(coalesce(p_reference,'')),'') is not null
        then 'Reference: ' || left(trim(p_reference),160) end,
      'Payment arrangement installment'
    ),''),
    p_payment_date::timestamptz, v_user_id, 'package_sale',
    'package_revenue', 'manual', 'manual', 'usd',
    nullif(left(trim(coalesce(p_reference,'')),160),'')
  )
  returning id into v_payment_id;

  v_remaining_to_apply := v_amount;

  for v_installment in
    select *
    from public.payment_installments
    where arrangement_id = v_arrangement.id
      and status in ('scheduled','partial','overdue')
    order by due_date, sequence_number
    for update
  loop
    exit when v_remaining_to_apply <= 0;

    v_apply := least(
      v_remaining_to_apply,
      round(v_installment.amount_due - v_installment.amount_paid, 2)
    );

    update public.payment_installments
    set
      amount_paid = round(amount_paid + v_apply, 2),
      status = case
        when round(amount_paid + v_apply, 2) >= amount_due then 'paid'
        else 'partial'
      end,
      paid_at = case
        when round(amount_paid + v_apply, 2) >= amount_due then now()
        else paid_at
      end,
      updated_at = now()
    where id = v_installment.id;

    v_remaining_to_apply := round(v_remaining_to_apply - v_apply, 2);
  end loop;

  v_new_remaining := round(v_arrangement.remaining_balance - v_amount, 2);

  update public.payment_arrangements
  set
    remaining_balance = v_new_remaining,
    status = case when v_new_remaining = 0 then 'completed' else 'active' end,
    updated_at = now()
  where id = v_arrangement.id;

  update public.package_sales
  set
    tender_total = round(tender_total + v_amount, 2),
    remaining_balance = v_new_remaining,
    status = case when v_new_remaining = 0 then 'completed' else 'pending' end,
    updated_at = now()
  where id = v_arrangement.package_sale_id;

  if v_new_remaining = 0 and v_arrangement.access_policy = 'paid_in_full' then
    update public.client_packages
    set active = true
    where id = v_arrangement.client_package_id;
  end if;

  return v_payment_id;
end;
$$;

commit;
