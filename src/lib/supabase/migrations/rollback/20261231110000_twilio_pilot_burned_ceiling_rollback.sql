-- Rollback of 20261231110000_twilio_pilot_burned_ceiling.sql: removes the trigger and its two helpers; no data was changed by the migration.
begin;
set local lock_timeout = '5s';
drop trigger if exists studio_sms_credit_reservations_pilot_burned_ceiling on public.studio_sms_credit_reservations;
drop function if exists public._tw4pbc_reservation_guard();
drop function if exists public._tw4pbc_burned(uuid);
commit;
