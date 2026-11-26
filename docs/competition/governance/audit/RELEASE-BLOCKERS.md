# Competition OS release blockers (Studio/Custom)

Register of open release blockers found by the retrospective audit. A blocker closes only when its correction is independently reviewed, tested and
**applied to the authorized release environment** (a merged or drafted migration does not close it). The audit [TRACKER.md](TRACKER.md) links here;
rows are added by the PR that finds or corrects the blocker.

| ID | Severity | Finding | Correction | Status |
|---|---|---|---|---|
| RB-11.1 | Studio/Custom release blocker | `approve_competition_round_result` accepted a one-character override reason | `20270301090000_competition_r11_approval_override_scope.sql` (reuses `_cf1_reason_is_substantive`); details in [R-11-CORRECTION-MIGRATION.md](R-11-CORRECTION-MIGRATION.md) | **OPEN.** Correction drafted in a NOT-APPLIED draft PR; not yet independently reviewed to closure, not executed in a hosted environment, not applied |
| RB-11.2 | Studio/Custom release blocker | the D3 self-approval override was reachable for corrected result versions | same migration (initial vs corrected from append-only history; calculator and correction opener cannot approve a correction) | **OPEN.** Same status as RB-11.1 |

Not blockers, reported separately (need their own authorization): revoking `service_role` EXECUTE on approve and calculate (RF-11.1), a verified-email requirement
for the approving manager (RF-11.2). Evidence and reasons for leaving them out: R-11-CORRECTION-MIGRATION.md section 4.

Flip condition for the PR 859 static markers (`r11.approval.static.test.ts`, `KNOWN BLOCKER RB-11.1/RB-11.2`, `it.fails`): they read only the F2 migration text and therefore stay
"expected to fail" even after this migration is applied; after the migration is applied they must be re-pointed to the R-11 migration text and flipped to normal `it` tests.

**Open question under RB-11.2 (second review, unverified):** a never-published approved or corrected round can be cancelled (`cancel_competition_round`) and replaced by a new round, whose first approval counts as initial and so allows the self-approval override. Not run end to end; outside the function PR 865 changes; needs an owner decision before RB-11.2 is treated as closed.
