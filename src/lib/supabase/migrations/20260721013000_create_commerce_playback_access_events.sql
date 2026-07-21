-- Commerce Slice 8: entitlement-verified Mux playback access audit.
-- Apply after 20260721001500_add_mux_video_uploads.sql.
-- Apply before deploying the student playback API.

create table if not exists public.commerce_playback_access_events (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid
    references public.commerce_entitlements(id) on delete set null,
  catalog_item_id uuid
    references public.commerce_catalog_items(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  allowed boolean not null default false,
  reason text not null,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists commerce_playback_access_events_user_idx
  on public.commerce_playback_access_events(user_id, created_at desc);

create index if not exists commerce_playback_access_events_denied_idx
  on public.commerce_playback_access_events(created_at desc)
  where allowed = false;

alter table public.commerce_playback_access_events enable row level security;

revoke all
  on public.commerce_playback_access_events
  from public, anon, authenticated;

grant select, insert
  on public.commerce_playback_access_events
  to service_role;
