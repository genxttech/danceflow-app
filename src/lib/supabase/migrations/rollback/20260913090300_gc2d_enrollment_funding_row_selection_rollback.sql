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
-- membership" limitation, not fix or protect anything. A full rollback of
-- this slice should remove GC-2c's trigger and GC-2b's function first (see
-- their own rollback files), at which point this function's finite-membership
-- branch becomes unreachable dead code (no capacity enforcement exists to
-- support it) but remains harmless to leave in place -- reverting the
-- function body itself is not required for a safe rollback of this slice.
--
-- Not executed automatically by this file.

begin;

do $$
begin
  raise notice 'GC-2d rollback is a deliberate no-op -- see file header. Removing GC-2b/GC-2c first (in that order) is sufficient for a safe rollback of this slice; reverting enroll_class_attendee''s body is not required.';
end $$;

commit;
