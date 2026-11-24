# Audit tracker

Status values: `not started`, `in progress`, `inventory merged`, `owner decisions pending`, `closed`.
Findings are counts by class: verified / inconsistent / unsupported / requires-interpretation.
Public activation stays blocked until every row is `closed`. See [README.md](README.md).

| # | Domain | Owner-listed scope | Inventory file | PR | Status | Findings (V / I / U / RI) | Blockers |
|---|---|---|---|---|---|---|---|
| 1 | Formats, disciplines, divisions | Formats/disciplines/divisions | `inventory-formats-disciplines-divisions.md` | — | not started | — | — |
| 2 | Age and eligibility | Age and eligibility calculations | `inventory-age-eligibility.md` | — | not started | — | — |
| 3 | Classifications | Amateur/professional/Pro-Am/Pro-Pro classifications | `inventory-classifications.md` | — | not started | — | — |
| 4 | Registration and partners | Registration and partner requirements | `inventory-registration-partners.md` | — | not started | — | — |
| 5 | Judging | Judging qualifications/assignments/conflicts | `inventory-judging.md` | — | not started | — | — |
| 6 | Scoring | Scoring systems/callbacks/placements/tie-breaking | `inventory-scoring.md` | — | not started | — | — |
| 7 | Scratches, withdrawals, DQ, result changes | Scratches/withdrawals/disqualifications/result changes | `inventory-scratches-results.md` | — | not started | — | — |
| 8 | Organizer authority | Organizer authority/approvals/exceptions/appeals | `inventory-organizer-authority.md` | — | not started | — | — |
| 9 | Other rule-dependent behavior | Any other rule-dependent behavior | `inventory-other.md` | — | not started | — | — |

Inventory file names are suggestions; the auditing session records the actual file name and PR here when its
PR lands. Update the row in the same PR that adds the inventory file.

## Owner decisions recorded: OD-26

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-26 | **Option A: controlled, audited mid-event running-order changes** (unstarted heats only; safe operational cutoff; versioned order with exact diffs; event-level scheduling authority; impact preview; notification design only) as a future Studio/Custom capability. | 2026-11-23 | Docs only: [design](../running-order/OD-26-running-order-changes-design.md) and [migration impact and test plan](../running-order/OD-26-migration-impact-and-test-plan.md); register OD26-DF-0001..0003, OD26-NDCA-0001..0005, OD26-UCWDC-0001..0005, OD26-WSDC-0001..0003, OD26-SILENT-0001..0003. | **Design draft, pending owner confirmation; resolves O1 open decision 3 at design level only. NDCA timetable (III.D.1, 30 minutes, first event, 1:00 a.m.), Chairman authority (IV.C.3/IV.C.7), UCWDC move-up and contiguity, WSDC Chief Judge authority and restarts: NOT IMPLEMENTED, profile blockers. No NDCA penalty is ever computed or charged. No SQL, migration, notification or activation authorized.** OD-01 (PR 832) preserved. |
