-- DanceFlow Marketing Campaigns V1 foundation
-- Run in Supabase SQL editor.

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  subject text not null,
  preview_text text,
  body_html text,
  body_text text,
  cta_label text,
  cta_url text,
  audience_type text not null default 'manual',
  status text not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaigns_status_check
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  constraint marketing_campaigns_audience_type_check
    check (audience_type in (
      'manual',
      'all_active_clients',
      'new_leads',
      'inactive_clients',
      'event_attendees'
    ))
);

create table if not exists public.marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaigns(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  email text not null,
  name text,
  status text not null default 'pending',
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint marketing_campaign_recipients_status_check
    check (status in ('pending', 'sent', 'failed', 'skipped', 'unsubscribed'))
);

create table if not exists public.marketing_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  email text not null,
  reason text,
  unsubscribed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists marketing_unsubscribes_studio_email_unique
on public.marketing_unsubscribes (studio_id, lower(email));

create index if not exists marketing_campaigns_studio_status_idx
on public.marketing_campaigns (studio_id, status, created_at desc);

create index if not exists marketing_campaign_recipients_campaign_idx
on public.marketing_campaign_recipients (campaign_id, status);

create index if not exists marketing_campaign_recipients_studio_email_idx
on public.marketing_campaign_recipients (studio_id, lower(email));

alter table public.marketing_campaigns enable row level security;
alter table public.marketing_campaign_recipients enable row level security;
alter table public.marketing_unsubscribes enable row level security;

-- RLS policies should be aligned to your existing studio membership helper/pattern.
-- Add those after we confirm the project's current RLS function names.
