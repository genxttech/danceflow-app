begin;

create table if not exists public.organizer_contacts (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  phone text,
  status text not null default 'active',
  source text not null default 'event_registration',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_event_id uuid references public.events(id) on delete set null,
  last_registration_id uuid references public.event_registrations(id) on delete set null,
  total_registrations integer not null default 0,
  total_paid_registrations integer not null default 0,
  total_spend numeric not null default 0,
  currency text not null default 'USD',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizer_contacts_status_check check (status in ('active', 'unsubscribed', 'archived')),
  constraint organizer_contacts_email_not_blank check (length(trim(email)) > 0)
);

create unique index if not exists uq_organizer_contacts_organizer_email
on public.organizer_contacts(organizer_id, lower(email));

create index if not exists idx_organizer_contacts_organizer_last_seen
on public.organizer_contacts(organizer_id, last_seen_at desc);

create index if not exists idx_organizer_contacts_email
on public.organizer_contacts(lower(email));

create table if not exists public.organizer_contact_registrations (
  id uuid primary key default gen_random_uuid(),
  organizer_contact_id uuid not null references public.organizer_contacts(id) on delete cascade,
  organizer_id uuid not null references public.organizers(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  registration_id uuid not null references public.event_registrations(id) on delete cascade,
  order_id uuid references public.event_orders(id) on delete set null,
  ticket_type_id uuid references public.event_ticket_types(id) on delete set null,
  status text,
  payment_status text,
  total_amount numeric not null default 0,
  currency text not null default 'USD',
  checked_in_at timestamptz,
  registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_organizer_contact_registrations_registration
on public.organizer_contact_registrations(registration_id);

create index if not exists idx_organizer_contact_registrations_contact
on public.organizer_contact_registrations(organizer_contact_id, registered_at desc);

create index if not exists idx_organizer_contact_registrations_organizer
on public.organizer_contact_registrations(organizer_id, registered_at desc);

alter table public.event_registrations
add column if not exists organizer_contact_id uuid references public.organizer_contacts(id) on delete set null;

create index if not exists idx_event_registrations_organizer_contact
on public.event_registrations(organizer_contact_id)
where organizer_contact_id is not null;

alter table public.organizer_contacts enable row level security;
alter table public.organizer_contact_registrations enable row level security;

drop policy if exists "Organizer users can read organizer contacts" on public.organizer_contacts;
drop policy if exists "Organizer users can manage organizer contacts" on public.organizer_contacts;
drop policy if exists "Platform admins can read organizer contacts" on public.organizer_contacts;
drop policy if exists "Platform admins can manage organizer contacts" on public.organizer_contacts;

drop policy if exists "Organizer users can read organizer contact registrations" on public.organizer_contact_registrations;
drop policy if exists "Organizer users can manage organizer contact registrations" on public.organizer_contact_registrations;
drop policy if exists "Platform admins can read organizer contact registrations" on public.organizer_contact_registrations;
drop policy if exists "Platform admins can manage organizer contact registrations" on public.organizer_contact_registrations;

create policy "Organizer users can read organizer contacts"
on public.organizer_contacts
for select
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contacts.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
  )
);

create policy "Organizer users can manage organizer contacts"
on public.organizer_contacts
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contacts.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contacts.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

create policy "Platform admins can read organizer contacts"
on public.organizer_contacts
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create policy "Platform admins can manage organizer contacts"
on public.organizer_contacts
for all
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create policy "Organizer users can read organizer contact registrations"
on public.organizer_contact_registrations
for select
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contact_registrations.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
  )
);

create policy "Organizer users can manage organizer contact registrations"
on public.organizer_contact_registrations
for all
to authenticated
using (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contact_registrations.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
)
with check (
  exists (
    select 1
    from public.organizer_users ou
    where ou.organizer_id = organizer_contact_registrations.organizer_id
      and ou.user_id = auth.uid()
      and ou.active = true
      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff')
  )
);

create policy "Platform admins can read organizer contact registrations"
on public.organizer_contact_registrations
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create policy "Platform admins can manage organizer contact registrations"
on public.organizer_contact_registrations
for all
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

notify pgrst, 'reload schema';

commit;
