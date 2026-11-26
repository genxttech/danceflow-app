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

**RB-11.2, cross-round replacement: CONFIRMED by execution for four routes, and OPEN** (local, 2026-11-26; R-11-CORRECTION-MIGRATION.md section 12a). Starting from a published never-run spare heat **installed by fixture** (superuser, replica mode; that the database planner and publication produce this state is code reading only, and the app planner does not), one manager, with the R-11 migration applied, published a self-approved replacement over the same couples: leaving the corrected round alone, cancelling it, cancelling it after independent approval, or (after cancelling) moving the spare heat to a new round by a direct write. Option D addresses only direct writes; the spare-round routes need the owner's Option B decision. RB-11.2 is not closed by PR 865.
