# ADAPTED test copies for R-15 (S4): U18, U18-S, JC1

**These are not the released suites.** The U18, U18-S and JC1 suites stay byte-identical to their released pins (carried by PR 867); nobody edits them in place. After the
R-15 gates (`20270301130000`) their fixtures cannot place couples that have no organizer eligibility determination, so on a chain **with R-15** they are run as
temporary adapted copies made at composition time. Coordinator decision of 2026-11-26.

`r15-u18-u18s-jc1-clearance-hook.patch` adds four copies of one block that obtains clearance through `set_competition_entry_eligibility`
(`fixtures/r15_clear_entries.sql`). It removes and changes no line, and the block does nothing on a database without R-15.

| Suite | Released blob (PR 867 `6dc6b2d4`, same as candidate `92a8c17c6`) | Adapted copy blob |
|---|---|---|
| `test_T_competition_u18_heat_entry_status_guard.sql` | `0c0893de2061e9ddab1f4c1b8032abebae5a5b89` | `7be49b5b8f6451c508604abf212af288e18154b3` |
| `test_T_competition_u18s_heat_entry_scratch_audit.sql` | `46a301b846be586940a07aa5d77b273c9859dbb7` | `a1416c3ede10760551bfd8c223506277801ea879` |
| `test_T_competition_jc1_inactive_judge_absent.sql` | `980acbbd9b47d19142c913467873156a7a655c11` | `c42c14e48d12c5a42281d7c1d382a9c30ea5efce` |

Rules for the runner:

1. Apply to **temporary copies only**, from the composition folder that holds `src/lib/supabase/migrations/sql-tests/`:
   `git -c core.autocrlf=false apply -p1 <this patch>`.
2. Check the released blob before applying and the adapted blob after (`git hash-object`); stop on a mismatch.
3. Run the **byte-exact originals** on the chain they were written for (the baseline phase), unpatched.
4. The run record labels every result obtained from an adapted copy as such. A pass of an adapted copy is not a pass of the released suite.
5. Prepend `fixtures/r15_clear_entries.sql`; it requires the real S5 predicate.

A suite for another PR's later edit of these files (PR 877 edits U18-S) needs this patch regenerated against that blob.
