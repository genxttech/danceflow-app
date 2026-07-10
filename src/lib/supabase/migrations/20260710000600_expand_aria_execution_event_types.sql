-- ARIA Execution Engine V1 event types
-- Run in dev and production before deploying ARIA execution controls.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_action_events'::regclass
      and conname = 'automation_action_events_event_type_check'
  ) then
    alter table public.automation_action_events
      drop constraint automation_action_events_event_type_check;
  end if;

  alter table public.automation_action_events
    add constraint automation_action_events_event_type_check
    check (
      event_type in (
        'approved',
        'auto_approved',
        'completed',
        'dismissed',
        'skipped',
        'snoozed',
        'assigned',
        'unassigned',
        'queued',
        'drafted',
        'failed',
        'note_added',
        'execution_queued',
        'execution_skipped',
        'execution_failed'
      )
    );
end $$;
