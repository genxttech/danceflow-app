-- Client Profile Enrichment V1
-- Adds birthday and mailing address fields used for birthday card lists, mailed notices, and client CRM context.

alter table public.clients
  add column if not exists birthday date,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text;

create index if not exists idx_clients_studio_birthday
  on public.clients (studio_id, birthday)
  where birthday is not null;

comment on column public.clients.birthday is 'Client birthday used for reminders, birthday card lists, and CRM personalization.';
comment on column public.clients.address_line1 is 'Client mailing address line 1.';
comment on column public.clients.address_line2 is 'Client mailing address line 2.';
comment on column public.clients.city is 'Client mailing city.';
comment on column public.clients.state is 'Client mailing state/region.';
comment on column public.clients.postal_code is 'Client mailing ZIP/postal code.';
comment on column public.clients.country is 'Client mailing country.';
