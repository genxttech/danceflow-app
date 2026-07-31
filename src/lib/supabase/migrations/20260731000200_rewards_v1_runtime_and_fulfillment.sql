-- Rewards V1 runtime and fulfillment.
-- Requires:
--   20260731000100_rewards_v1_foundation.sql
--
-- This migration:
--   * creates an idempotent reward event ledger;
--   * converts verified operational events into reward progress;
--   * awards rewards exactly once per rule/period threshold;
--   * attaches safe triggers to attendance, payments, memberships, and event attendance;
--   * provides a studio-authorized redemption function;
--   * applies account-credit rewards to the existing client account ledger at redemption;
--   * leaves review/referral confirmation available through the same event pipeline for staff-confirmed exceptions.

begin;

create table if not exists public.reward_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  trigger_type text not null,
  event_value numeric(12,2) not null default 1,
  source_type text not null,
  source_id uuid,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  processed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint reward_events_trigger_type_check
    check (
      trigger_type in (
        'referral_converted',
        'attendance_milestone',
        'membership_renewal',
        'intro_completed',
        'spend_milestone',
        'participation_milestone',
        'review_or_feedback_completed'
      )
    ),

  constraint reward_events_value_positive_check
    check (event_value > 0),

  constraint reward_events_idempotency_not_blank
    check (length(trim(idempotency_key)) > 0),

  unique (studio_id, idempotency_key)
);

create index if not exists reward_events_client_trigger_idx
  on public.reward_events(studio_id, client_id, trigger_type, occurred_at desc);

alter table public.reward_events enable row level security;

drop policy if exists reward_events_select on public.reward_events;
drop policy if exists reward_events_insert on public.reward_events;

create policy reward_events_select
on public.reward_events
for select to authenticated
using (public.can_view_client_rewards(studio_id, client_id));

create policy reward_events_insert
on public.reward_events
for insert to authenticated
with check (public.can_manage_studio_rewards(studio_id));

-- ---------------------------------------------------------------------------
-- Period key calculation
-- ---------------------------------------------------------------------------

create or replace function public.reward_period_key(
  evaluation_window text,
  event_time timestamptz
)
returns text
language sql
immutable
as $$
  select case
    when evaluation_window = 'calendar_month'
      then to_char(event_time at time zone 'UTC', 'YYYY-MM')
    when evaluation_window = 'calendar_year'
      then to_char(event_time at time zone 'UTC', 'YYYY')
    when evaluation_window = 'membership_period'
      then to_char(event_time at time zone 'UTC', 'YYYY-MM-DD')
    else 'lifetime'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Process one event against every matching active studio rule.
-- ---------------------------------------------------------------------------

create or replace function public.process_reward_event(target_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.reward_events%rowtype;
  rule_row record;
  reward_row public.studio_rewards%rowtype;
  progress_row public.client_reward_progress%rowtype;
  next_progress numeric(12,2);
  period_key_value text;
  award_number integer;
  award_key text;
  expiration_at timestamptz;
  new_client_reward_id uuid;
  awards_created integer := 0;
begin
  select *
    into event_row
  from public.reward_events
  where id = target_event_id
  for update;

  if not found then
    return 0;
  end if;

  if event_row.processed_at is not null then
    return 0;
  end if;

  for rule_row in
    select rr.*
    from public.reward_rules rr
    where rr.studio_id = event_row.studio_id
      and rr.active = true
      and rr.trigger_type = event_row.trigger_type
      and (rr.starts_at is null or rr.starts_at <= event_row.occurred_at)
      and (rr.ends_at is null or rr.ends_at >= event_row.occurred_at)
  loop
    select *
      into reward_row
    from public.studio_rewards
    where id = rule_row.reward_id
      and studio_id = event_row.studio_id
      and active = true;

    if not found then
      continue;
    end if;

    period_key_value :=
      public.reward_period_key(rule_row.evaluation_window, event_row.occurred_at);

    insert into public.client_reward_progress (
      studio_id,
      client_id,
      rule_id,
      progress_value,
      period_key,
      last_source_type,
      last_source_id,
      last_evaluated_at
    )
    values (
      event_row.studio_id,
      event_row.client_id,
      rule_row.id,
      event_row.event_value,
      period_key_value,
      event_row.source_type,
      event_row.source_id,
      now()
    )
    on conflict (studio_id, client_id, rule_id, period_key)
    do update set
      progress_value =
        public.client_reward_progress.progress_value + excluded.progress_value,
      last_source_type = excluded.last_source_type,
      last_source_id = excluded.last_source_id,
      last_evaluated_at = excluded.last_evaluated_at,
      updated_at = now()
    returning *
      into progress_row;

    next_progress := progress_row.progress_value;

    insert into public.reward_activity_history (
      studio_id,
      client_id,
      rule_id,
      reward_id,
      activity_type,
      value_amount,
      source_type,
      source_id,
      metadata
    )
    values (
      event_row.studio_id,
      event_row.client_id,
      rule_row.id,
      reward_row.id,
      'progress_recorded',
      event_row.event_value,
      event_row.source_type,
      event_row.source_id,
      jsonb_build_object(
        'period_key', period_key_value,
        'progress_value', next_progress,
        'threshold_value', rule_row.threshold_value,
        'reward_event_id', event_row.id
      )
    );

    if next_progress < rule_row.threshold_value then
      continue;
    end if;

    -- Determine how many threshold crossings are represented by current progress.
    if rule_row.repeatable then
      award_number := floor(next_progress / rule_row.threshold_value)::integer;
    else
      award_number := 1;
    end if;

    if rule_row.max_awards_per_client is not null then
      award_number := least(award_number, rule_row.max_awards_per_client);
    end if;

    if award_number <= 0 then
      continue;
    end if;

    -- Award every missing threshold crossing. The unique idempotency index on
    -- client_rewards prevents duplicates during retries/races.
    for i in 1..award_number loop
      award_key := concat(
        'reward-rule:',
        rule_row.id,
        ':period:',
        period_key_value,
        ':award:',
        i
      );

      expiration_at :=
        case
          when reward_row.expires_after_days is null then null
          else now() + make_interval(days => reward_row.expires_after_days)
        end;

      insert into public.client_rewards (
        studio_id,
        client_id,
        rule_id,
        reward_id,
        status,
        reward_name_snapshot,
        reward_type_snapshot,
        reward_value_snapshot,
        reward_config_snapshot,
        earned_at,
        available_at,
        expires_at,
        source_type,
        source_id,
        idempotency_key
      )
      values (
        event_row.studio_id,
        event_row.client_id,
        rule_row.id,
        reward_row.id,
        'earned',
        reward_row.name,
        reward_row.reward_type,
        reward_row.reward_value,
        reward_row.reward_config,
        event_row.occurred_at,
        now(),
        expiration_at,
        event_row.source_type,
        event_row.source_id,
        award_key
      )
      on conflict do nothing
      returning id into new_client_reward_id;

      if new_client_reward_id is not null then
        awards_created := awards_created + 1;

        insert into public.reward_activity_history (
          studio_id,
          client_id,
          rule_id,
          reward_id,
          client_reward_id,
          activity_type,
          value_amount,
          source_type,
          source_id,
          metadata
        )
        values (
          event_row.studio_id,
          event_row.client_id,
          rule_row.id,
          reward_row.id,
          new_client_reward_id,
          'reward_earned',
          reward_row.reward_value,
          event_row.source_type,
          event_row.source_id,
          jsonb_build_object(
            'period_key', period_key_value,
            'award_number', i,
            'reward_event_id', event_row.id
          )
        );
      end if;

      new_client_reward_id := null;
    end loop;

    if progress_row.qualified_at is null then
      update public.client_reward_progress
      set qualified_at = now(),
          updated_at = now()
      where id = progress_row.id;

      insert into public.reward_activity_history (
        studio_id,
        client_id,
        rule_id,
        reward_id,
        activity_type,
        source_type,
        source_id,
        metadata
      )
      values (
        event_row.studio_id,
        event_row.client_id,
        rule_row.id,
        reward_row.id,
        'qualified',
        event_row.source_type,
        event_row.source_id,
        jsonb_build_object(
          'period_key', period_key_value,
          'progress_value', next_progress
        )
      );
    end if;
  end loop;

  update public.reward_events
  set processed_at = now()
  where id = target_event_id;

  return awards_created;
end;
$$;

revoke all on function public.process_reward_event(uuid) from public;
grant execute on function public.process_reward_event(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Staff/service-safe event recorder.
-- ---------------------------------------------------------------------------

create or replace function public.record_reward_event(
  target_studio_id uuid,
  target_client_id uuid,
  target_trigger_type text,
  target_event_value numeric,
  target_source_type text,
  target_source_id uuid,
  target_idempotency_key text,
  target_metadata jsonb default '{}'::jsonb,
  target_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  event_id uuid;
begin
  if auth.role() <> 'service_role'
     and not public.can_manage_studio_rewards(target_studio_id) then
    raise exception 'Not authorized to record reward events.';
  end if;

  if target_event_value is null or target_event_value <= 0 then
    raise exception 'Reward event value must be greater than zero.';
  end if;

  insert into public.reward_events (
    studio_id,
    client_id,
    trigger_type,
    event_value,
    source_type,
    source_id,
    idempotency_key,
    metadata,
    occurred_at,
    created_by
  )
  values (
    target_studio_id,
    target_client_id,
    target_trigger_type,
    target_event_value,
    target_source_type,
    target_source_id,
    target_idempotency_key,
    coalesce(target_metadata, '{}'::jsonb),
    target_occurred_at,
    auth.uid()
  )
  on conflict (studio_id, idempotency_key)
  do update set idempotency_key = excluded.idempotency_key
  returning id into event_id;

  perform public.process_reward_event(event_id);

  return event_id;
end;
$$;

revoke all on function public.record_reward_event(
  uuid, uuid, text, numeric, text, uuid, text, jsonb, timestamptz
) from public;

grant execute on function public.record_reward_event(
  uuid, uuid, text, numeric, text, uuid, text, jsonb, timestamptz
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operational source triggers.
-- These are intentionally deterministic and idempotent.
-- ---------------------------------------------------------------------------

create or replace function public.reward_on_appointment_attended()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is null then
    return new;
  end if;

  if lower(coalesce(new.status, '')) = 'attended'
     and (
       tg_op = 'INSERT'
       or lower(coalesce(old.status, '')) <> 'attended'
     ) then

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'attendance_milestone',
      1,
      'appointments',
      new.id,
      concat('appointment-attendance:', new.id),
      jsonb_build_object('appointment_type', new.appointment_type),
      coalesce(new.starts_at, now())
    );

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'participation_milestone',
      1,
      'appointments',
      new.id,
      concat('appointment-participation:', new.id),
      jsonb_build_object('appointment_type', new.appointment_type),
      coalesce(new.starts_at, now())
    );

    if new.appointment_type = 'intro_lesson' then
      perform public.record_reward_event(
        new.studio_id,
        new.client_id,
        'intro_completed',
        1,
        'appointments',
        new.id,
        concat('intro-completed:', new.id),
        '{}'::jsonb,
        coalesce(new.starts_at, now())
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reward_appointment_attended
  on public.appointments;

create trigger trg_reward_appointment_attended
after insert or update of status
on public.appointments
for each row execute function public.reward_on_appointment_attended();

create or replace function public.reward_on_paid_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is null then
    return new;
  end if;

  if lower(coalesce(new.status, '')) = 'paid'
     and (
       tg_op = 'INSERT'
       or lower(coalesce(old.status, '')) <> 'paid'
     )
     and coalesce(new.amount, 0) > 0 then

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'spend_milestone',
      new.amount,
      'payments',
      new.id,
      concat('paid-payment:', new.id),
      jsonb_build_object(
        'payment_type', new.payment_type,
        'payment_channel', new.payment_channel
      ),
      coalesce(new.created_at, now())
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reward_paid_payment
  on public.payments;

create trigger trg_reward_paid_payment
after insert or update of status
on public.payments
for each row execute function public.reward_on_paid_payment();

create or replace function public.reward_on_membership_renewal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and lower(coalesce(new.status, '')) = 'active'
     and new.current_period_start is distinct from old.current_period_start
     and old.current_period_start is not null then

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'membership_renewal',
      1,
      'client_memberships',
      new.id,
      concat(
        'membership-renewal:',
        new.id,
        ':',
        coalesce(new.current_period_start::text, 'unknown')
      ),
      jsonb_build_object(
        'membership_plan_id', new.membership_plan_id,
        'period_start', new.current_period_start,
        'period_end', new.current_period_end
      ),
      now()
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reward_membership_renewal
  on public.client_memberships;

create trigger trg_reward_membership_renewal
after update of current_period_start, status
on public.client_memberships
for each row execute function public.reward_on_membership_renewal();

create or replace function public.reward_on_event_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  registration_row record;
begin
  if lower(coalesce(new.status, '')) <> 'attended'
     or (
       tg_op = 'UPDATE'
       and lower(coalesce(old.status, '')) = 'attended'
     ) then
    return new;
  end if;

  select er.studio_id, er.client_id
    into registration_row
  from public.event_registrations er
  where er.id = new.event_registration_id;

  if registration_row.client_id is null then
    return new;
  end if;

  perform public.record_reward_event(
    registration_row.studio_id,
    registration_row.client_id,
    'participation_milestone',
    1,
    'attendance_records',
    new.id,
    concat('event-participation:', new.id),
    jsonb_build_object(
      'event_registration_id', new.event_registration_id
    ),
    coalesce(new.marked_attended_at, new.checked_in_at, now())
  );

  return new;
end;
$$;

drop trigger if exists trg_reward_event_attendance
  on public.attendance_records;

create trigger trg_reward_event_attendance
after insert or update of status
on public.attendance_records
for each row execute function public.reward_on_event_attendance();

-- ---------------------------------------------------------------------------
-- Safe redemption.
-- Account credit is applied to the existing account ledger exactly once.
-- Other reward types are marked redeemed; operational fulfillment remains
-- explicit at the front desk / sales workflow.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_client_reward(
  target_client_reward_id uuid,
  redemption_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  reward_row public.client_rewards%rowtype;
begin
  select *
    into reward_row
  from public.client_rewards
  where id = target_client_reward_id
  for update;

  if not found then
    raise exception 'Reward not found.';
  end if;

  if auth.role() <> 'service_role'
     and not public.can_manage_studio_rewards(reward_row.studio_id) then
    raise exception 'Not authorized to redeem this reward.';
  end if;

  if reward_row.status <> 'earned' then
    raise exception 'Only earned rewards can be redeemed.';
  end if;

  if reward_row.expires_at is not null and reward_row.expires_at < now() then
    update public.client_rewards
    set status = 'expired',
        updated_at = now()
    where id = reward_row.id;

    insert into public.reward_activity_history (
      studio_id,
      client_id,
      rule_id,
      reward_id,
      client_reward_id,
      activity_type,
      note
    )
    values (
      reward_row.studio_id,
      reward_row.client_id,
      reward_row.rule_id,
      reward_row.reward_id,
      reward_row.id,
      'reward_expired',
      'Reward expired before redemption.'
    );

    return false;
  end if;

  if reward_row.reward_type_snapshot = 'account_credit'
     and coalesce(reward_row.reward_value_snapshot, 0) > 0 then

    insert into public.client_account_ledger (
      studio_id,
      client_id,
      entry_date,
      entry_type,
      direction,
      amount,
      description,
      reference_type,
      reference_id
    )
    select
      reward_row.studio_id,
      reward_row.client_id,
      current_date,
      'credit_added',
      'credit',
      reward_row.reward_value_snapshot,
      concat('Rewards: ', reward_row.reward_name_snapshot),
      'client_reward',
      reward_row.id
    where not exists (
      select 1
      from public.client_account_ledger cal
      where cal.studio_id = reward_row.studio_id
        and cal.client_id = reward_row.client_id
        and cal.reference_type = 'client_reward'
        and cal.reference_id = reward_row.id
    );
  end if;

  update public.client_rewards
  set status = 'redeemed',
      redeemed_at = now(),
      updated_by = auth.uid(),
      updated_at = now()
  where id = reward_row.id;

  insert into public.reward_activity_history (
    studio_id,
    client_id,
    rule_id,
    reward_id,
    client_reward_id,
    activity_type,
    value_amount,
    actor_user_id,
    note
  )
  values (
    reward_row.studio_id,
    reward_row.client_id,
    reward_row.rule_id,
    reward_row.reward_id,
    reward_row.id,
    'reward_redeemed',
    reward_row.reward_value_snapshot,
    auth.uid(),
    nullif(trim(redemption_note), '')
  );

  return true;
end;
$$;

revoke all on function public.redeem_client_reward(uuid, text) from public;
grant execute on function public.redeem_client_reward(uuid, text)
  to authenticated, service_role;

commit;
