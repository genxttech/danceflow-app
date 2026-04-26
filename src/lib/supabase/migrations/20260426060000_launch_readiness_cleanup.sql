-- Launch readiness cleanup
-- Captures manual DB changes made during final QA.

-- 1. Allow pending Stripe/client payment requests.
alter table payments
alter column paid_at drop not null;

create index if not exists payments_stripe_checkout_session_id_idx
on payments (stripe_checkout_session_id);

create index if not exists payments_client_pending_idx
on payments (client_id, status, source);

create index if not exists payments_studio_pending_idx
on payments (studio_id, status, source);


-- 2. Portal users can read their own payment requests/history.
alter table payments enable row level security;

drop policy if exists "Portal users can view their own payments"
on payments;

create policy "Portal users can view their own payments"
on payments
for select
using (
  exists (
    select 1
    from clients c
    where c.id = payments.client_id
      and c.studio_id = payments.studio_id
      and c.portal_user_id = auth.uid()
  )
);


-- 3. Restore recurring appointment metadata.
alter table appointments
add column if not exists recurrence_series_id uuid,
add column if not exists recurrence_frequency text,
add column if not exists recurrence_interval integer,
add column if not exists recurrence_count integer,
add column if not exists recurrence_ends_on date;

-- recurrence_series_id is used as a grouping id, not a parent appointment FK.
alter table appointments
drop constraint if exists appointments_recurrence_series_id_fkey;

create index if not exists appointments_recurrence_series_id_idx
on appointments (recurrence_series_id);

create index if not exists appointments_studio_recurrence_series_idx
on appointments (studio_id, recurrence_series_id);


-- 4. Non-blocking diagnostic table for package deduction issues.
create table if not exists appointment_package_deduction_errors (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid,
  studio_id uuid,
  client_id uuid,
  client_package_id uuid,
  appointment_type text,
  error_message text,
  created_at timestamp with time zone not null default now()
);


-- 5. Deduct package credits when an appointment becomes attended.
-- This is non-blocking: if deduction fails, attendance still saves and the error is logged.
create or replace function deduct_package_credit_when_appointment_attended()
returns trigger
language plpgsql
security definer
as $$
declare
  v_usage_type text;
  v_item record;
  v_next_used numeric;
  v_next_remaining numeric;
begin
  if coalesce(new.status::text, '') <> 'attended' then
    return new;
  end if;

  if tg_op = 'UPDATE' and coalesce(old.status::text, '') = coalesce(new.status::text, '') then
    return new;
  end if;

  begin
    if new.client_package_id is null or new.client_id is null then
      return new;
    end if;

    if exists (
      select 1
      from lesson_transactions lt
      where lt.appointment_id = new.id
        and lt.client_package_id = new.client_package_id
        and lt.transaction_type::text = 'lesson_deduction'
    ) then
      return new;
    end if;

    v_usage_type :=
      case new.appointment_type::text
        when 'private_lesson' then 'private_lesson'
        when 'intro_lesson' then 'private_lesson'
        when 'coaching' then 'private_lesson'
        when 'group_class' then 'group_class'
        when 'practice_party' then 'practice_party'
        when 'event' then 'practice_party'
        else null
      end;

    if v_usage_type is null then
      return new;
    end if;

    select
      cpi.id,
      cpi.client_package_id,
      cpi.usage_type,
      cpi.quantity_used,
      cpi.quantity_remaining,
      cpi.is_unlimited
    into v_item
    from client_package_items cpi
    join client_packages cp
      on cp.id = cpi.client_package_id
    where cpi.client_package_id = new.client_package_id
      and cpi.usage_type = v_usage_type::package_usage_type
      and cp.studio_id = new.studio_id
      and cp.client_id = new.client_id
      and cp.active = true
    limit 1
    for update;

    if not found then
      return new;
    end if;

    if coalesce(v_item.is_unlimited, false) = true then
      insert into lesson_transactions (
        studio_id,
        client_id,
        client_package_id,
        appointment_id,
        transaction_type,
        lessons_delta,
        balance_after,
        notes
      )
      values (
        new.studio_id,
        new.client_id,
        new.client_package_id,
        new.id,
        'lesson_deduction'::transaction_type,
        0,
        null,
        'Auto-recorded attended ' || replace(v_usage_type, '_', ' ') || ' from unlimited package.'
      );

      return new;
    end if;

    if coalesce(v_item.quantity_remaining, 0) <= 0 then
      return new;
    end if;

    v_next_used := coalesce(v_item.quantity_used, 0) + 1;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) - 1;

    update client_package_items
    set
      quantity_used = v_next_used,
      quantity_remaining = v_next_remaining
    where id = v_item.id;

    update client_packages
    set updated_at = now()
    where id = new.client_package_id
      and studio_id = new.studio_id;

    insert into lesson_transactions (
      studio_id,
      client_id,
      client_package_id,
      appointment_id,
      transaction_type,
      lessons_delta,
      balance_after,
      notes
    )
    values (
      new.studio_id,
      new.client_id,
      new.client_package_id,
      new.id,
      'lesson_deduction'::transaction_type,
      -1,
      v_next_remaining,
      'Auto-deducted 1 ' || replace(v_usage_type, '_', ' ') || ' credit when appointment was marked attended.'
    );

    return new;

  exception when others then
    begin
      insert into appointment_package_deduction_errors (
        appointment_id,
        studio_id,
        client_id,
        client_package_id,
        appointment_type,
        error_message
      )
      values (
        new.id,
        new.studio_id,
        new.client_id,
        new.client_package_id,
        new.appointment_type::text,
        sqlerrm
      );
    exception when others then
      null;
    end;

    return new;
  end;
end;
$$;

drop trigger if exists appointments_deduct_package_credit_attended
on appointments;

create trigger appointments_deduct_package_credit_attended
after insert or update of status
on appointments
for each row
execute function deduct_package_credit_when_appointment_attended();