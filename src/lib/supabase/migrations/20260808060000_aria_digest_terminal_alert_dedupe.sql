-- Database-enforced deduplication for ARIA digest terminal-failure alerts.
--
-- recordTerminalAriaDigestFailure (src/lib/aria/digest-observability.ts) writes
-- one platform_error_logs row per permanently-failed ARIA digest run, keyed by
-- a deterministic dedupe_key ("aria_digest_terminal:<run_id>") stored in the
-- jsonb `details` column. The application previously did a select-then-insert
-- check for an existing row before inserting, which is race-prone under
-- concurrent cron/dispatch workers.
--
-- This adds a partial unique index scoped narrowly to source = 'aria_digest'
-- rows, so it has no effect on any other platform_error_logs writer. It is
-- intentionally NOT conditioned on resolved_at: a resolved alert must not
-- free up its dedupe_key, so a later cron pass over the same exhausted run
-- can never insert a second alert for it.
--
-- Application code now inserts directly and treats a 23505 (unique
-- violation) on this index as a successful dedup rather than an error.

create unique index if not exists platform_error_logs_aria_digest_dedupe_idx
on platform_error_logs ((details ->> 'dedupe_key'))
where source = 'aria_digest';
