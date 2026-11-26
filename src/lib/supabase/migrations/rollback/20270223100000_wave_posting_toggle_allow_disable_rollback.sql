-- Rollback of 20270223100000: restores the original strict trigger function (20260622_wave_production_controls_v2_5.sql).
begin;
-- Rows already in needs_reauth must be moved to the old equivalent before the stricter constraint returns.
update public.studio_wave_connections set status = 'reauthorization_required' where status = 'needs_reauth';
alter table public.studio_wave_connections drop constraint if exists studio_wave_connections_status_check;
alter table public.studio_wave_connections add constraint studio_wave_connections_status_check
  check (status in ('connected', 'reauthorization_required', 'error', 'disconnected'));
create or replace function public.protect_wave_posting_toggle()
returns trigger language plpgsql as $$
begin
  if (
       new.posting_enabled is distinct from old.posting_enabled
       or new.posting_enabled_by is distinct from old.posting_enabled_by
       or new.posting_enabled_at is distinct from old.posting_enabled_at
       or new.posting_disabled_at is distinct from old.posting_disabled_at
     )
     and coalesce(current_setting('app.wave_posting_toggle', true), '') <> 'allowed'
  then raise exception 'Use the controlled Wave posting toggle'; end if;
  return new;
end;
$$;
commit;
