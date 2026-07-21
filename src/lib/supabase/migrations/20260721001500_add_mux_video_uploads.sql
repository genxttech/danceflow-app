-- Commerce Slice 7: Mux direct uploads and webhook processing.
-- Apply after 20260720235000_create_commerce_entitlements.sql.
-- Apply before deploying the Mux upload code.

alter table public.commerce_digital_content
  add column if not exists mux_upload_id text,
  add column if not exists mux_upload_status text,
  add column if not exists mux_asset_id text,
  add column if not exists mux_asset_status text,
  add column if not exists mux_playback_id text,
  add column if not exists mux_error_message text,
  add column if not exists mux_aspect_ratio text;

create unique index if not exists commerce_digital_content_mux_upload_unique
  on public.commerce_digital_content(mux_upload_id)
  where mux_upload_id is not null;

create unique index if not exists commerce_digital_content_mux_asset_unique
  on public.commerce_digital_content(mux_asset_id)
  where mux_asset_id is not null;

create index if not exists commerce_digital_content_mux_status_idx
  on public.commerce_digital_content(studio_id, mux_upload_status)
  where content_kind = 'video';

alter table public.commerce_digital_content
  drop constraint if exists commerce_digital_content_mux_upload_status_check;

alter table public.commerce_digital_content
  add constraint commerce_digital_content_mux_upload_status_check
  check (
    mux_upload_status is null or
    mux_upload_status in (
      'waiting',
      'uploading',
      'asset_created',
      'processing',
      'ready',
      'errored',
      'cancelled',
      'timed_out',
      'deleted'
    )
  );

create table if not exists public.commerce_mux_webhook_events (
  id uuid primary key default gen_random_uuid(),
  mux_event_id text not null,
  event_type text not null,
  digital_content_id uuid
    references public.commerce_digital_content(id) on delete set null,
  processing_status text not null default 'processing',
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint commerce_mux_webhook_events_event_unique unique (mux_event_id),
  constraint commerce_mux_webhook_events_status_check
    check (processing_status in ('processing', 'processed', 'failed'))
);

create index if not exists commerce_mux_webhook_events_content_idx
  on public.commerce_mux_webhook_events(
    digital_content_id,
    received_at desc
  );

create index if not exists commerce_mux_webhook_events_failed_idx
  on public.commerce_mux_webhook_events(received_at desc)
  where processing_status = 'failed';

alter table public.commerce_mux_webhook_events enable row level security;

revoke all
  on public.commerce_mux_webhook_events
  from public, anon, authenticated;

grant select, insert, update
  on public.commerce_mux_webhook_events
  to service_role;
