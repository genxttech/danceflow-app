-- Rollback of 20261222090000 (TW-4F J2: owner texting status read). The function is read-only and holds no data, so this is safe at any time.
-- Roll the application back first (it falls back to "not available yet" for number, sender and compliance when the function is missing).
begin;
set local lock_timeout = '5s';
drop function if exists public.get_studio_sms_texting_status(uuid);
commit;
