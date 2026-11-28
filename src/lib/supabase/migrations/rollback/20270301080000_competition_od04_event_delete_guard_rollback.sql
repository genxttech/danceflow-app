-- Rollback for 20270301080000_competition_od04_event_delete_guard.sql
--
-- STATUS: GIT-ONLY. Not applied anywhere. Running this on PROD or DEV needs the same separate owner approval as the migration.
--
-- Removes the OD-04 guard triggers and the five helper functions. It touches no table and no data, so it can never lose evidence; it is safe
-- to run whether or not scoring evidence exists. After it runs, `delete from public.events` again cascades through every Competition OS table
-- (the pre-OD-04 behavior), so run it only on purpose. Idempotent.
--
-- Order: triggers first (they reference the functions), then the functions. Re-applying the forward migration afterwards is supported.

begin;

drop trigger if exists a00_compod04_events_delete_guard on public.events;
drop trigger if exists a00_compod04_events_truncate_guard on public.events;

drop function if exists public.compod04_guard_event_delete();
drop function if exists public.compod04_guard_event_truncate();
drop function if exists public._compod04_event_evidence(uuid);
drop function if exists public._compod04_any_evidence();
drop function if exists public._compod04_evidence_tables();

commit;
