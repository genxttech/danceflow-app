-- Rollback of 20261116093000_paywh1_direct_write_guards.sql.
--
-- WARNING: this re-opens the direct-write bypass (client roles could again forge payment status, confirm unpaid
-- holds, write payment rows and add unpaid tickets for order-backed registrations). Roll back only together with the
-- application, and only when the guards themselves are the cause of an incident.

begin;

drop trigger if exists trg_paywh1_guard_order_registration_writes on public.event_registrations;
drop trigger if exists trg_paywh1_guard_order_payment_rows on public.event_payments;
drop trigger if exists trg_paywh1_guard_order_attendee_writes on public.event_registration_attendees;

drop function if exists public._paywh1_guard_order_registration_writes();
drop function if exists public._paywh1_guard_order_payment_rows();
drop function if exists public._paywh1_guard_order_attendee_writes();
drop function if exists public._paywh1_registration_order_facts(uuid);
drop function if exists public._paywh1_registration_attendee_count(uuid);

commit;
