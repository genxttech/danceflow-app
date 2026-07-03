-- Partner Search safety and anti-advertising controls.
-- Run in dev and production before enabling Partner Search publishing.

alter table public.dancer_partner_profiles
  add column if not exists listing_intent text not null default 'practice',
  add column if not exists moderation_status text not null default 'pending',
  add column if not exists moderation_reason text,
  add column if not exists reported_count integer not null default 0,
  add column if not exists last_reported_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists allow_studio_badge boolean not null default false,
  add column if not exists terms_accepted_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'dancer_partner_profiles_listing_intent_check'
  ) then
    alter table public.dancer_partner_profiles
      add constraint dancer_partner_profiles_listing_intent_check
      check (listing_intent in ('practice', 'social', 'showcase', 'competition'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'dancer_partner_profiles_moderation_status_check'
  ) then
    alter table public.dancer_partner_profiles
      add constraint dancer_partner_profiles_moderation_status_check
      check (moderation_status in ('pending', 'approved', 'flagged', 'hidden'));
  end if;
end $$;

create table if not exists public.partner_connection_requests (
  id uuid primary key default gen_random_uuid(),
  partner_profile_id uuid not null references public.dancer_partner_profiles(id) on delete cascade,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  message text not null,
  status text not null default 'pending',
  decline_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint partner_connection_requests_status_check
    check (status in ('pending', 'accepted', 'declined', 'blocked', 'cancelled'))
);

create unique index if not exists partner_connection_requests_one_pending_idx
on public.partner_connection_requests (partner_profile_id, requester_user_id)
where status = 'pending';

create index if not exists partner_connection_requests_recipient_idx
on public.partner_connection_requests (recipient_user_id, status, created_at);

alter table public.partner_connection_requests enable row level security;

drop policy if exists "Partner profile owners can view requests" on public.partner_connection_requests;
create policy "Partner profile owners can view requests"
on public.partner_connection_requests
for select
to authenticated
using (
  auth.uid() = requester_user_id
  or auth.uid() = recipient_user_id
  or exists (
    select 1
    from public.dancer_partner_profiles profile
    where profile.id = partner_connection_requests.partner_profile_id
      and profile.user_id = auth.uid()
  )
);

drop policy if exists "Authenticated dancers can create partner connection requests" on public.partner_connection_requests;
create policy "Authenticated dancers can create partner connection requests"
on public.partner_connection_requests
for insert
to authenticated
with check (auth.uid() = requester_user_id);

drop policy if exists "Request participants can update partner connection requests" on public.partner_connection_requests;
create policy "Request participants can update partner connection requests"
on public.partner_connection_requests
for update
to authenticated
using (
  auth.uid() = requester_user_id
  or auth.uid() = recipient_user_id
  or exists (
    select 1
    from public.dancer_partner_profiles profile
    where profile.id = partner_connection_requests.partner_profile_id
      and profile.user_id = auth.uid()
  )
)
with check (
  auth.uid() = requester_user_id
  or auth.uid() = recipient_user_id
  or exists (
    select 1
    from public.dancer_partner_profiles profile
    where profile.id = partner_connection_requests.partner_profile_id
      and profile.user_id = auth.uid()
  )
);

drop policy if exists "Public can view published partner profiles" on public.dancer_partner_profiles;
create policy "Public can view published partner profiles"
on public.dancer_partner_profiles
for select
using (
  visibility = 'published'
  and moderation_status = 'approved'
  and (expires_at is null or expires_at >= now())
);
