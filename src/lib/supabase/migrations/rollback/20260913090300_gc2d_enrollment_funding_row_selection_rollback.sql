-- Rollback for 20260913090300_gc2d_enrollment_funding_row_selection.sql
--
-- DELIBERATE NO-OP, same discipline as P6b/P6c/P6d/P6f: this is a
-- CREATE OR REPLACE of a pre-existing, already-relied-upon function
-- (enroll_class_attendee). Reverting to the pre-GC-2d body would remove the
-- finite-membership auto-resolution branch, but any enrollment already
-- created against a finite included_group_classes membership via the
-- own_instructor path remains a real, valid appointment_attendees row
-- either way -- narrowing the function back does not undo that data, and
-- would only reintroduce the "instructor cannot auto-resolve a finite
-- membership" limitation, not fix or protect anything.
--
-- CORRECTION (PR #70 review): an earlier version of this comment claimed
-- that removing GC-2c's trigger and GC-2b's function first would leave
-- this function's finite-membership branch as "unreachable dead code,
-- harmless to leave in place." That was wrong and has been retracted --
-- verified false by reading the function body directly. The
-- own_instructor branch's finite-candidate query
-- (`cross join lateral public._group_class_finite_balance(...)`) executes
-- UNCONDITIONALLY on every own_instructor enrollment call -- it is not
-- gated by GC-2c's trigger existing at all, so dropping
-- `_group_class_finite_balance` (GC-2b) while this function's GC-2d body
-- is still installed does NOT leave harmless dead code -- it makes EVERY
-- instructor-initiated group-class enrollment attempt fail at runtime with
-- a raw "function _group_class_finite_balance(...) does not exist" error,
-- not just the finite-membership path.
--
-- Correct rollback ordering for this slice, given the above:
--   * GC-2c (trigger), GC-2e (index), GC-2f (trigger), GC-2g (trigger), and
--     GC-2h (RLS policies) are each independent of this function and of
--     each other -- any of them may be rolled back on their own, in any
--     order, without touching enroll_class_attendee at all.
--   * GC-2b (`_group_class_finite_balance`) must NOT be dropped while this
--     GC-2d body is still the live definition of enroll_class_attendee --
--     doing so breaks the own_instructor enrollment path entirely, not
--     merely its finite-membership branch.
--   * A full, working rollback of this slice therefore requires this
--     function's body to actually be reverted (removing its call to GC-2b)
--     before GC-2b itself is dropped -- which this file does NOT do, by
--     design, matching the P6b/P6c/P6d/P6f precedent of never silently
--     reinstating an older body as an "emergency" action. If a full
--     rollback is ever genuinely needed, author a new, explicit
--     `CREATE OR REPLACE FUNCTION public.enroll_class_attendee(...)`
--     migration that restores the pre-GC-2d (GC-1.4A) body first, then
--     roll back GC-2b/GC-2c.
--
-- Not executed automatically by this file.

begin;

do $$
begin
  raise notice 'GC-2d rollback is a deliberate no-op -- see file header. GC-2b (_group_class_finite_balance) must not be dropped while this GC-2d body is still live, since its own_instructor branch calls GC-2b unconditionally; a full rollback of this slice requires a separate forward migration to first restore the pre-GC-2d function body.';
end $$;

commit;
