-- Rollback for
-- 20260911121100_p6f_membership_usage_error_resolution_scope_correction.sql
--
-- DELIBERATE NO-OP. Read this in full before running it.
--
-- P6f reasserts the already-live, already-correct body of
-- _sync_membership_usage_for_private_lesson_appointment via CREATE OR
-- REPLACE FUNCTION -- same signature, same body already installed by
-- P6d's corrective edit, no new behavior. It exists purely to give that
-- already-verified correction its own explicit, immutable, hosted
-- migration boundary (see P6f's own file header) -- it does not fix
-- anything currently broken.
--
-- Because the immediately-prior (first-applied) resolution scope was
-- confirmed defective -- it required an exact `reason_code =
-- 'historical_membership_link_missing'` match, so a legacy or free-text
-- error row never resolved even once canonical state was reached --
-- this rollback intentionally does NOT restore that narrower scope. A
-- rollback must never trade a known-correct database state for a
-- known-defective one.
--
-- PRECONDITION: this file is only meaningful as part of rolling back the
-- entire P3 feature (usage-sync writer + error infrastructure + retry),
-- via 20260911120200_p3_membership_usage_sync_errors_rollback.sql. That
-- rollback already `drop function if exists`s
-- _sync_membership_usage_for_private_lesson_appointment(uuid) by its
-- exact, unchanged signature -- neither P6d nor P6f ever altered it -- so
-- that existing rollback removes whichever body (P6d's or P6f's,
-- byte-identical either way) is currently installed, cleanly, along with
-- the rest of the feature.
--
-- Do NOT run this file while intending to keep P3's usage-sync
-- infrastructure live and functional -- there is no partial-rollback
-- path for P6f alone that does anything meaningful, because P6f changed
-- nothing that P6d hadn't already changed. If the intent is not to roll
-- back all of P3, there is nothing for this file to safely do -- so it
-- does nothing.

begin;

do $$
begin
  raise notice 'P6f rollback is a deliberate no-op -- see file header. To actually remove this function, run the full P3 rollback (20260911120200_p3_membership_usage_sync_errors_rollback.sql), which drops it by signature regardless of which body (pre-P6d, P6d-corrected, or P6f-reasserted -- all but the first are byte-identical) is currently installed.';
end $$;

commit;
