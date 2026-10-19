-- Rollback of 20261124090000 (TW-4F-3b-UI read functions). Read-only functions: no data is touched. Roll the application back first.
begin;
drop function if exists public.sms_credit_purchases(uuid, int), public.sms_credit_admin_overview();
commit;
