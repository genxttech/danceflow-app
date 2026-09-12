-- Rollback for 20260911120100_p2_membership_entitlement_window_engine.sql

begin;

drop function if exists public._private_lesson_finite_balance(uuid, uuid, timestamptz, uuid);
drop function if exists public._ensure_membership_period_for_date(uuid, date);
drop function if exists public._membership_benefit_period_window(uuid, text, date);
drop function if exists public._membership_period_add_months_clamped(date, int);
drop function if exists public._membership_period_add_months_rollover(date, int);

commit;
