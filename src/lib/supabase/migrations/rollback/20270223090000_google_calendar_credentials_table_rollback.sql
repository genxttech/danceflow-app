-- Rollback of 20270223090000. Legacy columns are never cleared by the expand phase; if the new app wrote tokens only to the
-- credentials table after the migration, copy them back first so a reconnect is not forced.
begin;
update public.studio_google_calendar_connections c
set encrypted_access_token = k.encrypted_access_token,
    encrypted_refresh_token = coalesce(k.encrypted_refresh_token, c.encrypted_refresh_token),
    token_expires_at = k.token_expires_at
from public.studio_google_calendar_credentials k
where k.connection_id = c.id and c.status <> 'disconnected'
  and (c.encrypted_access_token is distinct from k.encrypted_access_token or c.encrypted_refresh_token is distinct from coalesce(k.encrypted_refresh_token, c.encrypted_refresh_token));
drop table if exists public.studio_google_calendar_credentials;
drop function if exists public.set_studio_google_calendar_credentials_updated_at();
commit;
