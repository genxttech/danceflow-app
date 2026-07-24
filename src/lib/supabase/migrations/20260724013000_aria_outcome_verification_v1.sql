-- ARIA Outcome Verification V1
-- Run in development first. Run in production BEFORE deploying the matching code.

alter table if exists public.automation_actions
  add column if not exists outcome_status text not null default 'not_applicable',
  add column if not exists outcome_type text,
  add column if not exists outcome_expected_by timestamptz,
  add column if not exists outcome_verified_at timestamptz,
  add column if not exists outcome_related_table text,
  add column if not exists outcome_related_id uuid,
  add column if not exists outcome_evidence jsonb not null default '{}'::jsonb,
  add column if not exists outcome_last_checked_at timestamptz;

alter table public.automation_actions
  drop constraint if exists automation_actions_outcome_status_check;

alter table public.automation_actions
  add constraint automation_actions_outcome_status_check
  check (
    outcome_status in (
      'not_applicable',
      'pending',
      'verified',
      'expired',
      'manually_resolved'
    )
  );

-- Add the post-delivery holding state without removing existing review states.
alter table public.automation_actions
  drop constraint if exists automation_actions_status_check;

alter table public.automation_actions
  add constraint automation_actions_status_check
  check (
    status in (
      'suggested',
      'drafted',
      'approved',
      'queued',
      'awaiting_outcome',
      'completed',
      'dismissed',
      'skipped',
      'snoozed',
      'failed'
    )
  );

alter table public.automation_action_events
  drop constraint if exists automation_action_events_event_type_check;

alter table public.automation_action_events
  add constraint automation_action_events_event_type_check
  check (
    event_type in (
      'created',
      'approved',
      'completed',
      'dismissed',
      'skipped',
      'snoozed',
      'assigned',
      'reopened',
      'failed',
      'auto_approved',
      'execution_queued',
      'execution_skipped',
      'execution_failed',
      'delivery_sent',
      'delivery_failed',
      'delivery_requeued',
      'delivery_exhausted',
      'outcome_pending',
      'outcome_verified',
      'outcome_expired',
      'outcome_manually_resolved'
    )
  );

create index if not exists automation_actions_outcome_pending_idx
  on public.automation_actions (outcome_status, outcome_expected_by, studio_id)
  where outcome_status = 'pending';

create index if not exists automation_actions_outcome_client_idx
  on public.automation_actions (studio_id, client_id, outcome_status)
  where outcome_status = 'pending';

-- Convert already-sent executable ARIA follow-ups into outcome monitoring.
update public.automation_actions
set
  status = 'awaiting_outcome',
  outcome_status = 'pending',
  outcome_type = case rule_key
    when 'aria_low_package_balance' then 'package_renewal'
    when 'aria_stale_active_student' then 'future_appointment'
    when 'aria_intro_no_purchase' then 'intro_conversion'
    when 'aria_membership_past_due' then 'membership_good_standing'
    when 'aria_membership_canceling' then 'membership_cancellation_resolved'
    else outcome_type
  end,
  outcome_expected_by = coalesce(
    outcome_expected_by,
    execution_sent_at + case rule_key
      when 'aria_membership_past_due' then interval '3 days'
      when 'aria_membership_canceling' then interval '5 days'
      else interval '7 days'
    end
  ),
  completed_at = null,
  updated_at = now()
where execution_status = 'sent'
  and rule_key in (
    'aria_low_package_balance',
    'aria_stale_active_student',
    'aria_intro_no_purchase',
    'aria_membership_past_due',
    'aria_membership_canceling'
  )
  and outcome_status = 'not_applicable';
