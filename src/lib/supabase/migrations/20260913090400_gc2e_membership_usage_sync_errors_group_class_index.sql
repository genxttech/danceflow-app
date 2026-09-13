-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2e: group-class
-- error-dedup index.
--
-- membership_usage_sync_errors already carries an attendance_record_id
-- column, noted in this engagement's own P6d design work as "reserved for a
-- future group-class slice." This is that slice. Mirrors P6d's own
-- uq_membership_usage_sync_errors_unresolved_reason exactly, scoped to
-- attendance_record_id instead of appointment_id -- the DB-enforced
-- concurrency backstop for group-class ambiguity-error deduplication,
-- independent of any procedural check-before-insert in GC-2f's trigger
-- body.
--
-- No new column is added -- attendance_record_id already exists and has
-- never been used until now, confirmed live.

begin;

create unique index if not exists uq_membership_usage_sync_errors_unresolved_attendance_reason
  on public.membership_usage_sync_errors (attendance_record_id, reason_code)
  where resolved_at is null and attendance_record_id is not null and reason_code is not null;

commit;
