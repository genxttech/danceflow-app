# Chain C (with the P1 restriction): dispositions for items assigned to this PR

From composed runs p1run6 (877 `98ae57a29`, 919 `beecf8681`) and p1run7 (919 `6ef4e4e9f`) of the PR 863 session. Reasons are from reading the run's logs and scripts; nothing here was executed by this PR's author. A released suite or script that fails stays reported as failing.

| Item | Observed | Disposition |
|---|---|---|
| `o1_concurrency` (C only) | Round-start and heat-call races PASS. The last race first creates `race v2` as a **copy of the running order** (`create_competition_schedule_version(event, 'race v2', v1)`, script line 111) after a heat has been staged; the version id read back is empty | **Unreachable in the pilot:** a copy inserts heats (`20261111090000:1140-1141` calls `_comp10d_copy_floor_plan`) and `zz_compp1_heats` refuses any heat insert once the event has started (`COMP_P1_ORDER_FROZEN`). The run did not keep the script's `o1_v2.out`, so the code is not observed there. Checkable form: P1 suite check `H-D3c` asserts exactly this refusal with unchanged state (added after p1run7, **unexecuted**). That race stays untested on C; it passes on B |
| `od31_guarded_baseline_negative` (B) | Three checks fail: C1 and C1b (finding F1) and C3 (finding F3). An earlier version of this table named only C1 and C3; that was wrong | **Expected on any chain with PR 877:** C1 and C3 assert that a defect still exists, and 877 closes both (`COMP_S6_ENTRY_STATUS_WRITER`); C1b checks the audit row of the write that is now refused. The suite's other checks reported no failure. The released suite is never counted as a pass; labelled copy `test_T_od31_guarded_baseline_negative_with_s6.sql` on the PR 877 branch asserts the refusals (30 checks, **unexecuted**) |
| `cf1_od17_enforcement` (C) | Without seeding it stops on `COMP_R15_ENTRY_NOT_CLEARED` on chains B and C. With seeding (p1run7) it passes on B (59 checks) and fails on C only checks S09 and M3d | **Unreachable in the pilot:** both checks probe an insert into `event_competition_round_advancements`, which this restriction refuses for every writer, replica mode included (`zz_compp1_advancement`, advancement is off). The log shows no code because the probe reports only success or failure; the cause is from reading the suite and the trigger. The refund gate on advancement is proven on B only |
| `s6_entry_status_guard` (C) | Setup stops on `COMP_P1_FINAL_ONLY` | Its behaviour (scratch, withdrawal, direct writes, deletion) **is reachable in the pilot**, so a P1-legal labelled copy is required, not a waiver: `sql-tests/test_T_competition_s6_entry_status_guard_with_p1.sql` |

## The status guard copy

| Blob | Id |
|---|---|
| Released suite (this branch) | `7274d5e0aa85f72f13262f9481967d428843e927` |
| Source of the copy: the PR 863 run's clearance-hooked version | `fe325e180704e8970f84fb6a81b57e6d54793594` |
| Copy | `5fb9cde4e84f8329f0c20a704f479a98223039ac` |

127 checks before and expected after; none dropped and no assertion name changed. Fixtures differ (a final-only round, an active-heat scenario inside a rolled-back subtransaction, the second heat in a superseded order); the header lists each change. Adapted by reading and compared with its source, not independently reviewed. First executed in the PR 863 session's composed run p1run7 (`6ef4e4e9f`): PASS, 127 checks. It does not count as a pass of the released suite.
