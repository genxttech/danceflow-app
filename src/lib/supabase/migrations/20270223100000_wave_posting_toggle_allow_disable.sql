-- 20270223100000_wave_posting_toggle_allow_disable.sql
-- Integrations Slice 0 / W9. protect_wave_posting_toggle() rejected ANY change of posting_enabled that did not go through
-- set_studio_wave_posting_enabled(), including the app's own safety writes (needs_reauth handling and disconnect set
-- posting_enabled = false). With posting on, those writes raised "Use the controlled Wave posting toggle", so a Wave connection
-- could neither be marked needs_reauth nor disconnected. Turning posting OFF is the safe direction and is now always allowed;
-- turning it ON, or changing who/when it was enabled, still requires the controlled RPC (GUC app.wave_posting_toggle = 'allowed').
begin;

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
