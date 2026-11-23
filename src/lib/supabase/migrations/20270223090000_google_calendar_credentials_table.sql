-- 20270223090000_google_calendar_credentials_table.sql
-- Integrations Slice 0 / S0-a (expand phase). Moves Google Calendar OAuth token ciphertext out of the
-- studio_google_calendar_connections row (readable by studio admins and the linked instructor under RLS)
-- into a dedicated credentials table with RLS enabled and NO policy, the same pattern as studio_wave_credentials.
-- Expand only: legacy columns on the connections table are kept and backfilled, never dropped or nulled here,
-- so the previously deployed app keeps working. The contract step (null/drop legacy columns) is a later migration,
-- applied only after the app that reads the new table is live everywhere.
begin;

create table if not exists public.studio_google_calendar_credentials (
  connection_id uuid primary key references public.studio_google_calendar_connections(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_google_calendar_credentials enable row level security;
-- Intentionally no policy for authenticated/anon: only the service role (which bypasses RLS) may read or write tokens.
revoke all on public.studio_google_calendar_credentials from public, anon, authenticated;

create or replace function public.set_studio_google_calendar_credentials_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_studio_google_calendar_credentials_updated_at on public.studio_google_calendar_credentials;
create trigger set_studio_google_calendar_credentials_updated_at
before update on public.studio_google_calendar_credentials
for each row execute function public.set_studio_google_calendar_credentials_updated_at();

-- Idempotent backfill: copy legacy token columns for every connection that still has an access token.
-- Never overwrites an existing credentials row.
insert into public.studio_google_calendar_credentials (connection_id, encrypted_access_token, encrypted_refresh_token, token_expires_at)
select c.id, c.encrypted_access_token, c.encrypted_refresh_token, c.token_expires_at
from public.studio_google_calendar_connections c
where c.encrypted_access_token is not null
on conflict (connection_id) do nothing;

commit;
