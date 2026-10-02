-- 20261012090000_smsa2p1_studio_sms_registrations_rollback.sql
--
-- Reviewed rollback for SMS-A2P-1. NEVER run automatically.
--
-- Drops the per-studio registration table and its trigger function. Nothing
-- else depends on them in SMS-A2P-1 (no application code reads the table for
-- routing). Roll the application back FIRST if the platform SMS registration
-- form has shipped. DESTROYS any recorded registration identifiers/status:
-- refuses to run when rows exist unless the operator first runs, in the same
-- transaction,
--   set local smsa2p1.allow_data_loss = 'yes';

begin;

do $$
declare
  v_rows bigint := 0;
begin
  if to_regclass('public.studio_sms_registrations') is not null then
    execute 'select count(*) from public.studio_sms_registrations' into v_rows;
    if v_rows > 0 and coalesce(current_setting('smsa2p1.allow_data_loss', true), '') <> 'yes' then
      raise exception 'SMS-A2P-1 rollback refused: % registration row(s) would be lost', v_rows;
    end if;
  end if;
end $$;

drop table if exists public.studio_sms_registrations;
drop function if exists public.studio_sms_registrations_integrity();

commit;
