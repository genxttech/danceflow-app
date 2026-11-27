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

## OD-31 negative suite (second patch)

`r15-od31-negative-c2.patch` changes one characterization, C2, in OD-31's suite (PR 856 head `056b945f`). That suite records that `authenticated` holds TRIGGER on
`event_competition_entries`; the R-15 write guard (`20270301131000`) and the S6 entry guard deliberately revoke it. The adapted expectation is: the privilege is
held exactly while neither guard is installed. The released suite stays unchanged (OD-31 keeps it as pre-R-15 evidence).

| Suite | Released blob | Adapted copy blob |
|---|---|---|
| `docs/competition/governance/audit/guarded-baseline/test_T_od31_guarded_baseline_negative.sql` | `d72eee3687648257488252f4fcb590eaf4f357b1` | `7ad6269c2c0de911e9c88ca62341b1f738a5c76e` |

Same rules as above: temporary copy only, check both blobs, originals run unpatched on the baseline, results labelled ADAPTED COPY.

## Labelled R-15 suite copies (separate files in `sql-tests/`)

**None of these is a released suite. A pass of a copy is never a pass of its source.** The sources stay unchanged and still run on a chain without R-15.
Each copy has a header listing every change and every dropped assertion, and prints `ADAPTED COPY R-15:` in front of its verdict.

| Source | Source blob | Copy | Copy blob |
|---|---|---|---|
| `test_T_competition_cf1_a5_exclusion.sql` | `bf0e2ce896b11ea7f8f96631bc7968128b59c848` | `test_T_competition_cf1_a5_exclusion_with_r15.sql` | `4dcefccfa9164edcc5c48c792b7ce63dfbf46621` |
| `test_T_competition_cf1_a5_concurrency.sh` | `287fff40ea019b72a4e7776a8b6c8a15b1dcbdcb` | `test_T_competition_cf1_a5_concurrency_with_r15.sh` | `934055616f6da84898bd398e20c8a7cfc21ae50f` |
| `test_T_competition_cf1_a5_concurrency_with_s6.sh` | `446a681269651922ee45a5227006a22764d70d00` | `test_T_competition_cf1_a5_concurrency_with_s6_with_r15.sh` | `f2df840ae3d08c6bf0a99d5195fb9c1ee9d5302c` |
| `test_T_competition_cf1_callback_final_advancement.sql` | `8b44c385cb875fc38287ca32748969e5ce3dc3d1` | `test_T_competition_cf1_callback_final_advancement_with_r15.sql` | `4deaf379aae03e8d6651f6ddac8e0c400e1c2581` |
| `test_T_competition_cf1_rb3r_reconciliation.sql` | `6ee17b31901da4f5825426d520db61388ce42ab9` | `test_T_competition_cf1_rb3r_reconciliation_with_r15.sql` | `ae1f2d907ed68c4d819fa1c36cb3ad2a23e6085c` |
| `test_T_competition_cf1_rb3r_concurrency.sh` | `9e101e805d239f9a5b1dde9bce57e204ddaeef43` | `test_T_competition_cf1_rb3r_concurrency_with_r15.sh` | `c76400984bd6e40ad997582cd9aa7b9c29b892e7` |
| `test_T_phase10a_competition_foundation.sql` | `491b091b37dc540ffe01a7e5faa9019e3f1b8ed6` | `test_T_phase10a_competition_foundation_with_r15.sql` | `0f7539860070cefaa4461f89fee181531b750831` |

Two sources are not on this branch: the S6 race script is PR 877's file, and the callback suite is the composed merge of candidate blob `412d42d008` with
PR 844's change (the content run in p1run6). Regenerate the copy if either source moves.

| Copy | Changes | Dropped |
|---|---|---|
| A5 suite and both A5 race scripts | couples are seeded as in the source, made eligible only while cleared through the real RPC and placed, then set back; one added check of that starting state | none |
| callback to Final | U11 only: an added check that the publish is refused for exactly the one ineligible couple, which is then withdrawn by an owner fixture write | none (the source publishes with that couple still placed) |
| RB3R suite and race script | seeded couples cleared through the real RPC; one added check | none |
| Phase 10A | eligibility decided through the RPC; the direct write now expects refusal; a direct `late_entry` edit keeps the direct-audit coverage; an added refusal check and clearance before publishing v1 | the two checks of a **direct eligibility write** succeeding and being audited (replaced) |

Limits of what the copies show:

- A5 suite: every couple keeps the fixture's "eligible" determination, so the source's later direct writes back to "eligible" count as cleared again. The
  organizer's path (ineligible through the RPC, then a new eligible decision) is not exercised.
- Callback: the withdrawal that follows the U11 check is not an organizer action and does not show how an organizer clears such a refusal. The fixture's state
  (a `danced` placement in a draft about to be published) is one normal use cannot reach, because a publish is refused once any heat has run.

U11 cause: the draft that event 6 publishes still holds a couple that the earlier U32 steps made ineligible. R-15 refuses such a publish on purpose, so this is
intended behaviour and not a product defect. The cause was read from the code and fixture; the added U11 check is what proves it on a database.

Running:

- All need the real S5 predicate and a disposable database. The A5, RB3R and Phase 10A `.sql` copies need `fixtures/r15_clear_entries.sql` prepended (the
  composed runner does this for every suite). The race scripts read that file themselves.
- The callback copy needs `fixtures/r15_clearance_autoseed.sql` installed: its result is ADAPTED COPY **and** AUTOSEED.
- `..._a5_concurrency_with_r15.sh` is for a chain with R-15 and **without** S6. With S6 its P1 and P2 fail by design (`COMP_ENTRY_LIFECYCLE_PLACED`); that is
  not adapted away. On such a chain the result that counts is `..._a5_concurrency_with_s6_with_r15.sh`.
- The runner picks the files up by name but does not add its own label: the run record must label them ADAPTED COPY.
- Outside these copies' scope: the Phase 10A "Competition template not found" checks fail on the baseline chain too. On the chain with the pilot restriction
  (`20270301180000`) the callback, A5 and Phase 10A suites and the A5 race scripts stop on pilot restrictions; that is not adapted here.
