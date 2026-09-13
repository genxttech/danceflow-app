-- Rollback for 20260913090100_gc2b_group_class_finite_balance_engine.sql
--
-- Genuinely new object, no defective-body concern (P6e's rollback
-- precedent). This DROP itself is a safe, standalone Postgres operation --
-- but it is only safe to actually RUN once nothing still calls this
-- function.
--
-- CORRECTION (PR #70 review): two live callers reference this function --
-- GC-2c's trigger (enforce_group_class_membership_capacity) and GC-2d's
-- own_instructor branch of enroll_class_attendee (which calls it
-- unconditionally, not merely when GC-2c's trigger exists). Drop this
-- function only AFTER GC-2c's trigger has been rolled back (see its own
-- rollback file) AND enroll_class_attendee's body has been reverted away
-- from its GC-2d definition (GC-2d's own rollback is a deliberate no-op
-- and does NOT do this -- see that file's header for why, and what a full
-- rollback of this slice actually requires). Dropping this function while
-- either caller is still live will make that caller's next invocation fail
-- with "function _group_class_finite_balance(...) does not exist," not
-- merely disable a portion of it.

begin;

drop function if exists public._group_class_finite_balance(uuid, uuid, timestamptz, uuid);

commit;
