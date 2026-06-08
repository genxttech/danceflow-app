-- Automation Action Drafting / Sending Workflow V1
-- Adds a reviewable draft status to outbound deliveries so automations can prepare
-- email drafts without sending them automatically.

alter table public.outbound_deliveries
  alter column status set default 'queued';

do $$
declare
  constraint_name text;
begin
  select conname
  into constraint_name
  from pg_constraint
  where conrelid = 'public.outbound_deliveries'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%'
  limit 1;

  if constraint_name is not null then
    execute format('alter table public.outbound_deliveries drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.outbound_deliveries
  add constraint outbound_deliveries_status_check
  check (status = any (array['draft'::text, 'queued'::text, 'sent'::text, 'failed'::text, 'skipped'::text]));

create index if not exists idx_outbound_deliveries_automation_drafts
  on public.outbound_deliveries (studio_id, related_table, related_id, status)
  where related_table = 'automation_actions';
