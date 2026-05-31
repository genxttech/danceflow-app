begin;

create table if not exists public.organizer_marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  name text not null,
  subject text not null,
  preview_text text,
  body_text text not null,
  cta_label text,
  cta_url text,
  audience_type text not null default 'all_organizer_contacts',
  audience_event_id uuid references public.events(id) on delete set null,
  status text not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizer_marketing_campaigns_status_check
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  constraint organizer_marketing_campaigns_audience_type_check
    check (audience_type in (
      'all_organizer_contacts',
      'specific_event_registrants',
      'specific_event_ticket_buyers',
      'specific_event_checked_in',
      'specific_event_no_shows',
      'paid_registration_contacts'
    ))
);

create table if not exists public.organizer_marketing_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.organizer_marketing_campaigns(id) on delete cascade,
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  organizer_contact_id uuid references public.organizer_contacts(id) on delete set null,
  email text not null,
  name text,
  status text not null default 'pending',
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint organizer_marketing_campaign_recipients_status_check
    check (status in ('pending', 'sent', 'failed', 'skipped', 'unsubscribed'))
);

create table if not exists public.organizer_marketing_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  email text not null,
  reason text,
  unsubscribed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_organizer_marketing_unsubscribes_email
on public.organizer_marketing_unsubscribes(organizer_id, lower(email));

create index if not exists idx_organizer_marketing_campaigns_organizer_status
on public.organizer_marketing_campaigns(organizer_id, status, created_at desc);

create index if not exists idx_organizer_marketing_campaign_recipients_campaign
on public.organizer_marketing_campaign_recipients(campaign_id, status);

create index if not exists idx_organizer_marketing_campaign_recipients_email
on public.organizer_marketing_campaign_recipients(organizer_id, lower(email));

alter table public.organizer_marketing_campaigns enable row level security;
alter table public.organizer_marketing_campaign_recipients enable row level security;
alter table public.organizer_marketing_unsubscribes enable row level security;

drop policy if exists "Organizer users can read organizer marketing campaigns" on public.organizer_marketing_campaigns;
drop policy if exists "Organizer users can manage organizer marketing campaigns" on public.organizer_marketing_campaigns;
drop policy if exists "Platform admins can read organizer marketing campaigns" on public.organizer_marketing_campaigns;
drop policy if exists "Platform admins can manage organizer marketing campaigns" on public.organizer_marketing_campaigns;

create policy "Organizer users can read organizer marketing campaigns"
on public.organizer_marketing_campaigns
for select
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaigns.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
  )
);

create policy "Organizer users can manage organizer marketing campaigns"
on public.organizer_marketing_campaigns
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaigns.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaigns.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

create policy "Platform admins can read organizer marketing campaigns"
on public.organizer_marketing_campaigns
for select
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

create policy "Platform admins can manage organizer marketing campaigns"
on public.organizer_marketing_campaigns
for all
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

drop policy if exists "Organizer users can read organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
drop policy if exists "Organizer users can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
drop policy if exists "Platform admins can read organizer marketing recipients" on public.organizer_marketing_campaign_recipients;
drop policy if exists "Platform admins can manage organizer marketing recipients" on public.organizer_marketing_campaign_recipients;

create policy "Organizer users can read organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for select
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaign_recipients.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
  )
);

create policy "Organizer users can manage organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaign_recipients.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_campaign_recipients.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

create policy "Platform admins can read organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for select
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

create policy "Platform admins can manage organizer marketing recipients"
on public.organizer_marketing_campaign_recipients
for all
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

drop policy if exists "Organizer users can read organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
drop policy if exists "Organizer users can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
drop policy if exists "Platform admins can read organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;
drop policy if exists "Platform admins can manage organizer marketing unsubscribes" on public.organizer_marketing_unsubscribes;

create policy "Organizer users can read organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for select
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_unsubscribes.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
  )
);

create policy "Organizer users can manage organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_unsubscribes.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_marketing_unsubscribes.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

create policy "Platform admins can read organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for select
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

create policy "Platform admins can manage organizer marketing unsubscribes"
on public.organizer_marketing_unsubscribes
for all
to authenticated
using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

notify pgrst, 'reload schema';

commit;
