-- 20270223100000_wave_posting_toggle_allow_disable.sql
-- Integrations Slice 0 / W9. protect_wave_posting_toggle() rejected ANY change of posting_enabled that did not go through
-- set_studio_wave_posting_enabled(), including the app's own safety writes (needs_reauth handling and disconnect set
-- posting_enabled = false). With posting on, those writes raised "Use the controlled Wave posting toggle", so a Wave connection
-- could neither be marked needs_reauth nor disconnected. Turning posting OFF is the safe direction and is now always allowed;
-- turning it ON, or changing who/when it was enabled, still requires the controlled RPC (GUC app.wave_posting_toggle = 'allowed').
-- W10 (found by the suite for this migration): studio_wave_connections.status only allows connected / reauthorization_required / error /
-- disconnected (20260622_wave_integration_v0.sql), but every app path (token refresh, UI banners, platform page) writes and reads 'needs_reauth'.
-- The needs_reauth write therefore violated the check constraint and its error was ignored, so a failed refresh never parked the connection.
-- The constraint now also allows needs_reauth (the old value stays allowed; no existing row changes).
begin;

alter table public.studio_wave_connections drop constraint if exists studio_wave_connections_status_check;
alter table public.studio_wave_connections add constraint studio_wave_connections_status_check
  check (status in ('connected', 'needs_reauth', 'reauthorization_required', 'error', 'disconnected'));

create or replace function public.protect_wave_posting_toggle()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('app.wave_posting_toggle', true), '') = 'allowed' then
    return new;
  end if;
  -- Disabling (or staying disabled) with the enable audit columns untouched: always allowed. posting_disabled_at may change.
  if new.posting_enabled is false
     and new.posting_enabled_by is not distinct from old.posting_enabled_by
     and new.posting_enabled_at is not distinct from old.posting_enabled_at
  then
    return new;
  end if;
  if new.posting_enabled is distinct from old.posting_enabled
     or new.posting_enabled_by is distinct from old.posting_enabled_by
     or new.posting_enabled_at is distinct from old.posting_enabled_at
     or new.posting_disabled_at is distinct from old.posting_disabled_at
  then
    raise exception 'Use the controlled Wave posting toggle';
  end if;
  return new;
end;
$$;

commit;
