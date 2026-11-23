-- Rollback of 20270223130000. Drops the audit trail (history is lost); export first if it matters.
begin;
drop table if exists public.integration_audit_events;
drop function if exists public.protect_integration_audit_event();
commit;
