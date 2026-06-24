-- Stripe Terminal payment fulfillment V1
-- Run in development and production before deploying the matching application files.

alter table public.payments
  add column if not exists fulfillment_type text;

alter table public.payments
  drop constraint if exists payments_fulfillment_type_check;

alter table public.payments
  add constraint payments_fulfillment_type_check
  check (fulfillment_type is null or fulfillment_type in ('activate_package'));

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
         and studio_id = p_studio_id;

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

revoke all on function public.fulfill_terminal_payment(uuid, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fulfill_terminal_payment(uuid, uuid, uuid, text, timestamptz)
  to service_role;
