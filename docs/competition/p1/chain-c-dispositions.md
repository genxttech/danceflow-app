# Chain C (with the P1 restriction): dispositions for items assigned to this PR

From composed runs p1run6 (877 `98ae57a29`, 919 `beecf8681`) and p1run7 (919 `6ef4e4e9f`) of the PR 863 session. Reasons are from reading the run's logs and scripts; nothing here was executed by this PR's author. A released suite or script that fails stays reported as failing.

| Item | Observed | Disposition |
|---|---|---|
| `o1_concurrency` (C only) | Round-start and heat-call races PASS. The last race needs a second running order created **after** a heat has been staged; that creation yields no version id on C | **Unreachable in the pilot:** the restriction refuses new heats, and so a replacement order, once the event has started. The refusal text was written to the script's own output file, which the run did not keep, so the exact code is inferred. That one race stays untested on C; it passes on B |
| `od31_guarded_baseline_negative` (B) | Only the two characterization checks fail: C1 (finding F1) and C3 (finding F3) | **Expected on any chain with PR 877:** both assert that a defect still exists, and 877 closes them (`COMP_S6_ENTRY_STATUS_WRITER`). The suite's other checks reported no failure. Never counted as a pass |
| `cf1_od17_enforcement` (C) | Without seeding it stops on `COMP_R15_ENTRY_NOT_CLEARED` on chains B and C. With seeding (p1run7) it passes on B (59 checks) and fails on C only checks S09 and M3d | **Unreachable in the pilot:** both checks probe an insert into `event_competition_round_advancements`, which this restriction refuses for every writer, replica mode included (`zz_compp1_advancement`, advancement is off). The log shows no code because the probe reports only success or failure; the cause is from reading the suite and the trigger. The refund gate on advancement is proven on B only |
| `s6_entry_status_guard` (C) | Setup stops on `COMP_P1_FINAL_ONLY` | Its behaviour (scratch, withdrawal, direct writes, deletion) **is reachable in the pilot**, so a P1-legal labelled copy is required, not a waiver: `sql-tests/test_T_competition_s6_entry_status_guard_with_p1.sql` |

## The status guard copy

| Blob | Id |
|---|---|
| Released suite (this branch) | `7274d5e0aa85f72f13262f9481967d428843e927` |
| Source of the copy: the PR 863 run's clearance-hooked version | `fe325e180704e8970f84fb6a81b57e6d54793594` |
| Copy | `5fb9cde4e84f8329f0c20a704f479a98223039ac` |

127 checks before and expected after; none dropped and no assertion name changed. Fixtures differ (a final-only round, an active-heat scenario inside a rolled-back subtransaction, the second heat in a superseded order); the header lists each change. Adapted by reading and compared with its source, not independently reviewed. First executed in the PR 863 session's composed run p1run7 (`6ef4e4e9f`): PASS, 127 checks. It does not count as a pass of the released suite.
