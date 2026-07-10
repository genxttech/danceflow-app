-- Expand automation_action_events.event_type values for ARIA Operations lifecycle events.
-- Run in dev and production before deploying ARIA auto-approval / assignment policies.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
    INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE rel.relname = 'automation_action_events'
    AND nsp.nspname = 'public'
    AND con.conname = 'automation_action_events_event_type_check';

  IF constraint_name IS NOT NULL THEN
    ALTER TABLE public.automation_action_events
      DROP CONSTRAINT automation_action_events_event_type_check;
  END IF;

  ALTER TABLE public.automation_action_events
    ADD CONSTRAINT automation_action_events_event_type_check
    CHECK (
      event_type IN (
        'created',
        'updated',
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
        'note_added'
      )
    );
END $$;
