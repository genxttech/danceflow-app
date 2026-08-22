-- Package Refund P0, Slice 2b addendum: SQL RPC reactivation guard.
--
-- The exhaustive client_packages.active=true write-site audit for Slice 2b found two
-- raw-SQL reactivation paths outside the application-code guards added elsewhere in this
-- slice: apply_manual_payment_to_arrangement (actively called from
-- src/app/app/payments/actions.ts whenever staff record a manual installment payment) and
-- fulfill_terminal_payment (no current in-repo caller -- superseded by the TS-side
-- fulfillTerminalPayment -- but still a service_role-invokable security definer function,
-- guarded here as defense-in-depth). Both unconditionally reactivated client_packages.active
-- with no refund_status awareness.
--
-- Both effective definitions were confirmed via pg_get_functiondef against the local isolated
-- Supabase schema to match their source migrations byte-for-byte in body content
-- (20260715_payment_arrangements_v1.sql, 20260624000100_terminal_payment_fulfillment_v1.sql)
-- before this patch was written -- no drift.
--
-- The only behavioral change in either function is the addition of
-- "and refund_status is distinct from 'full'" (NULL-safe: never-refunded/NULL and 'partial'
-- packages are unaffected; only refund_status='full' blocks the write) to the existing
-- client_packages.active = true update. Every other line, and every function attribute
-- (signature, parameter defaults, return type, security definer, search_path, exception
-- handling, side effects including the fulfill_terminal_payment lesson_transactions insert),
-- is preserved exactly. CREATE OR REPLACE FUNCTION preserves existing ownership/grants, so
-- fulfill_terminal_payment's original revoke/grant statements are not repeated here.
--
-- Both replacements are wrapped in the same transaction so the protection is atomic: either
-- both functions receive the guard, or neither replacement commits.

begin;

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
    where id = v_arrangement.client_package_id
      and refund_status is distinct from 'full';
  end if;

  return v_payment_id;
end;
$$;

create or replace function public.fulfill_terminal_payment(
  p_studio_id uuid,
  p_payment_id uuid,
  p_session_id uuid,
  p_payment_intent_id text,
  p_paid_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_transitioned boolean := false;
begin
  select *
    into v_payment
    from public.payments
   where id = p_payment_id
     and studio_id = p_studio_id
   for update;

  if not found then
    raise exception 'Terminal payment was not found.';
  end if;

  perform 1
    from public.terminal_payment_sessions s
   where s.id = p_session_id
     and s.studio_id = p_studio_id
     and s.payment_id = p_payment_id
     and s.stripe_payment_intent_id = p_payment_intent_id
     and s.amount_cents = round(v_payment.amount * 100)::integer
     and lower(s.currency) = lower(coalesce(v_payment.currency, 'usd'));

  if not found then
    raise exception 'Terminal session does not match the payment.';
  end if;

  if v_payment.status is distinct from 'paid' then
    update public.payments
       set status = 'paid',
           paid_at = p_paid_at,
           payment_method = 'card',
           source = 'stripe',
           payment_channel = 'terminal',
           terminal_payment_session_id = p_session_id,
           stripe_payment_intent_id = p_payment_intent_id,
           updated_at = p_paid_at
     where id = p_payment_id
       and studio_id = p_studio_id;

    v_transitioned := true;

    if v_payment.client_package_id is not null
       and v_payment.fulfillment_type = 'activate_package' then
      update public.client_packages
         set active = true,
             updated_at = p_paid_at
       where id = v_payment.client_package_id
         and studio_id = p_studio_id
         and refund_status is distinct from 'full';

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
      select
        p_studio_id,
        v_payment.client_id,
        v_payment.client_package_id,
        'package_purchase',
        null,
        null,
        'Package purchased: ' || coalesce(cp.name_snapshot, 'Package'),
        v_payment.created_by
      from public.client_packages cp
      where cp.id = v_payment.client_package_id
        and cp.studio_id = p_studio_id;
    end if;

    if v_payment.payment_type = 'pay_as_you_go_lesson'
       and nullif(v_payment.external_reference, '') is not null then
      update public.appointments
         set payment_status = 'paid',
             updated_at = p_paid_at
       where id::text = v_payment.external_reference
         and studio_id = p_studio_id;
    end if;
  end if;

  update public.terminal_payment_sessions
     set status = 'succeeded',
         error_message = null,
         completed_at = coalesce(completed_at, p_paid_at),
         updated_at = p_paid_at
   where id = p_session_id
     and studio_id = p_studio_id
     and payment_id = p_payment_id;

  return v_transitioned;
end;
$$;

commit;
