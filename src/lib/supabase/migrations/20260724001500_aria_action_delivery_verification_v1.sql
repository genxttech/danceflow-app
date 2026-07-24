-- ARIA Action Delivery Verification V1
-- Run in development first. Run in production BEFORE deploying the matching code.

alter table if exists public.automation_actions
  add column if not exists execution_delivery_id uuid references public.outbound_deliveries(id) on delete set null,
  add column if not exists execution_status text not null default 'not_started',
  add column if not exists execution_attempt_count integer not null default 0,
  add column if not exists execution_last_attempt_at timestamptz,
  add column if not exists execution_next_attempt_at timestamptz,
  add column if not exists execution_error_message text,
  add column if not exists execution_sent_at timestamptz;

alter table public.automation_actions
  drop constraint if exists automation_actions_execution_status_check;

alter table public.automation_actions
  add constraint automation_actions_execution_status_check
  check (
    execution_status in (
      'not_started',
      'queued',
      'sent',
      'failed',
      'retrying',
      'exhausted',
      'skipped'
    )
  );

-- Replace the older event check so all currently emitted and new delivery events persist.
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
      'delivery_exhausted'
    )
  );

create index if not exists automation_actions_execution_exception_idx
  on public.automation_actions (
    studio_id,
    execution_status,
    execution_next_attempt_at
  )
  where execution_status in ('failed', 'retrying', 'exhausted');

create index if not exists automation_actions_execution_delivery_idx
  on public.automation_actions (execution_delivery_id)
  where execution_delivery_id is not null;

-- Backfill currently queued ARIA execution actions from their related delivery.
update public.automation_actions aa
set
  execution_delivery_id = od.id,
  execution_status = case od.status
    when 'sent' then 'sent'
    when 'failed' then 'failed'
    when 'skipped' then 'skipped'
    else 'queued'
  end,
  execution_attempt_count = case when od.status in ('sent', 'failed') then 1 else 0 end,
  execution_last_attempt_at = case when od.status in ('sent', 'failed') then od.updated_at else null end,
  execution_error_message = od.error_message,
  execution_sent_at = od.sent_at,
  completed_at = case when od.status = 'sent' then coalesce(aa.completed_at, od.sent_at, od.updated_at) else aa.completed_at end,
  status = case when od.status = 'sent' then 'completed' else aa.status end,
  updated_at = now()
from public.outbound_deliveries od
where od.related_table = 'automation_actions'
  and od.related_id = aa.id
  and od.template_key like 'aria_execution_%'
  and aa.execution_delivery_id is null;
