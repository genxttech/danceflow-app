-- Rollback of 20270301131000_competition_r15_eligibility_write_guard.sql. Drops the guard; does not restore the TRIGGER privilege (the revoke is a hardening
-- the earlier posture never relied on; re-grant manually only if a client trigger is genuinely required). No data change.
begin;
drop trigger if exists r15_guard_entry_eligibility_write on public.event_competition_entries;
drop function if exists public.r15_guard_entry_eligibility_write();
commit;
