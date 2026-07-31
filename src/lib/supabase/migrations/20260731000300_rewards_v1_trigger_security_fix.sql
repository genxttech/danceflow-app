-- Rewards V1 trigger-security hardening.
-- Requires:
--   20260731000100_rewards_v1_foundation.sql
--   20260731000200_rewards_v1_runtime_and_fulfillment.sql
--
-- Why this is required:
-- Rewards runtime source triggers execute when ordinary studio workflows update
-- appointments, payments, memberships, or attendance. Those source writes may be
-- performed by authorized roles that are not studio_owner/studio_admin.
--
-- Direct calls to record_reward_event remain owner/admin/service-role only.
-- Calls originating inside a database trigger are permitted because the source
-- table's own RLS/permissions have already authorized the operational write.
--
-- This also verifies that the client belongs to the supplied studio before an
-- event can be recorded.

begin;

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
  trigger_origin boolean := pg_trigger_depth() > 0;
begin
  if auth.role() <> 'service_role'
     and not trigger_origin
     and not public.can_manage_studio_rewards(target_studio_id) then
    raise exception 'Not authorized to record reward events.';
  end if;

  if not exists (
    select 1
    from public.clients c
    where c.id = target_client_id
      and c.studio_id = target_studio_id
  ) then
    raise exception 'Reward client does not belong to the supplied studio.';
  end if;

  if target_trigger_type not in (
    'referral_converted',
    'attendance_milestone',
    'membership_renewal',
    'intro_completed',
    'spend_milestone',
    'participation_milestone',
    'review_or_feedback_completed'
  ) then
    raise exception 'Unsupported reward trigger type.';
  end if;

  if target_event_value is null or target_event_value <= 0 then
    raise exception 'Reward event value must be greater than zero.';
  end if;

  if target_idempotency_key is null or length(trim(target_idempotency_key)) = 0 then
    raise exception 'Reward event idempotency key is required.';
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
    coalesce(target_occurred_at, now()),
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

commit;
