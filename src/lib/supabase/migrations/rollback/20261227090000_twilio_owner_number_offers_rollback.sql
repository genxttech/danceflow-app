-- Rollback of 20261227090000 (TW-4F J3: owner number offers read). The function is read-only and holds no data, so this is safe at any time.
-- Roll the application back first (without the function the number step shows "Choosing your number is not open yet" and offers no action).
begin;
set local lock_timeout = '5s';
drop function if exists public.get_studio_sms_number_offers(uuid);
commit;
