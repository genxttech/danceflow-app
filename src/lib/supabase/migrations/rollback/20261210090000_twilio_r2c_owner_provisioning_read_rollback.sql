-- Rollback of 20261210090000 (TW-4F R2c-I2: owner-safe provisioning read). The function is read-only and holds no data, so this is safe at any time.
-- Roll the application back first (it falls back to the placeholder when the function is missing).
begin;
set local lock_timeout = '5s';
drop function if exists public.get_studio_sms_provisioning(uuid);
commit;
