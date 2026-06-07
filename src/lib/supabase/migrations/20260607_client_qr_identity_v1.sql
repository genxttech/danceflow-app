-- 20260607_client_qr_identity_v1.sql

alter table public.clients
  add column if not exists client_qr_token text;

update public.clients
set client_qr_token = gen_random_uuid()::text
where client_qr_token is null
   or trim(client_qr_token) = '';

alter table public.clients
  alter column client_qr_token set default gen_random_uuid()::text;

create unique index if not exists idx_clients_client_qr_token_unique
  on public.clients(client_qr_token)
  where client_qr_token is not null;

create index if not exists idx_clients_studio_qr_token
  on public.clients(studio_id, client_qr_token);
