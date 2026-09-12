-- Rollback for
-- 20260911120900_p6d_membership_usage_sync_historical_preservation.sql
--
-- DELIBERATE NO-OP (Option B). Read this in full before running it.
--
-- P6d changed the BODIES of two already-applied P3 functions
-- (_sync_membership_usage_for_private_lesson_appointment,
-- retry_membership_usage_sync_error) via CREATE OR REPLACE FUNCTION --
-- neither function's signature changed (confirmed: both keep their exact
-- P3 argument lists and return types). It also added one nullable column
-- (membership_usage_sync_errors.reason_code) and one partial unique
-- index (uq_membership_usage_sync_errors_unresolved_reason).
--
-- WHY THIS IS NOT "OPTION A" (restore the exact pre-P6d function bodies,
-- then drop the P6d-only schema): the pre-P6d body is not merely
-- non-functional the way P6b's/P6c's pre-fix bodies were (those raised a
-- clear runtime error on every call, harming nothing but availability).
-- The pre-P6d body RUNS SUCCESSFULLY and SILENTLY DESTROYS historical
-- membership-usage data whenever it encounters an appointment whose
-- current funding metadata has drifted from what was true when that
-- usage was originally recorded -- exactly the incident this migration
-- exists to close. An emergency rollback that knowingly reinstates a
-- silent-data-loss mechanism is a materially worse choice than a
-- documented no-op, and is refused here on that basis, consistent with
-- the discipline already established by P6b's and P6c's own rollbacks.
--
-- PRECONDITION: this file is only meaningful as part of rolling back the
-- entire P3 feature (usage-sync writer + error infrastructure + retry),
-- via 20260911120200_p3_membership_usage_sync_errors_rollback.sql. That
-- rollback already `drop function if exists`s
-- _sync_membership_usage_for_private_lesson_appointment(uuid) and
-- retry_membership_usage_sync_error(uuid) by their exact, unchanged
-- signatures -- P6d never altered either signature, so that existing
-- rollback drops the P6d-hardened bodies exactly as cleanly as it would
-- have dropped the original ones. It also drops the trigger and trigger
-- function (sync_membership_usage_for_private_lesson_appointment()),
-- which P6d never touched at all (no new parameter was ever needed by
-- that caller, so its body was never modified by this migration).
--
-- Full rollback ordering, proven step by step (functions first, schema
-- last -- never the reverse, so no intermediate state ever leaves a live
-- function referencing a dropped column or index):
--   1. From P3's rollback: revoke + drop retry_membership_usage_sync_error(uuid).
--   2. From P3's rollback: drop the trigger, then drop
--      sync_membership_usage_for_private_lesson_appointment().
--   3. From P3's rollback: drop
--      _sync_membership_usage_for_private_lesson_appointment(uuid) --
--      removes the P6d-hardened body along with everything else, by the
--      same untouched signature.
--   4. Only now, with no live function referencing either object, this
--      file's own addendum below is safe to run.
--
-- Do NOT run this file's addendum before steps 1-3 above have completed
-- -- doing so while the hardened functions are still installed would not
-- break them outright (they would simply stop being able to record
-- reason_code / enforce the uniqueness backstop going forward, a silent
-- correctness regression, not a crash), but it is still never the
-- intended order and is refused here by design: the DROP COLUMN/DROP
-- INDEX statements below are commented out rather than executed
-- unconditionally, so that running this file standalone (in isolation,
-- without the full P3 rollback) does nothing at all -- the safest
-- possible standalone behavior.

begin;

do $$
begin
  raise notice 'P6d rollback is a deliberate no-op -- see file header. To actually remove the hardened function bodies, run the full P3 rollback (20260911120200_p3_membership_usage_sync_errors_rollback.sql), which drops both functions by their unchanged signatures regardless of which body (pre-P6d or post-P6d) is currently installed. Only after that rollback has completed should the following be run by hand as this file''s addendum: drop index if exists public.uq_membership_usage_sync_errors_unresolved_reason; alter table public.membership_usage_sync_errors drop column if exists reason_code;';
end $$;

commit;
