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

## Owner decisions recorded: OD-11

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-11 | **Option A, judge-confirmed ballot corrections.** Any alteration of a judge's actual marks needs the original adjudicator's authenticated confirmation bound to the exact replacement version; scorers and managers only propose; the chair may authorize the workflow but never confirm; an unavailable judge means HOLD with no override; scoring/tabulation errors go to OD-07 without changing the ballot; evidence immutable; baseline for all events. Design: [OD-11-ballot-corrections-design.md](../corrections/OD-11-ballot-corrections-design.md). | 2026-11-23 | Docs only (draft PR): register `OD11-NDCA-0001`..`0003`, `OD11-WSDC-0001`, `OD11-WSDC-0002`, `OD11-UCWDC-0001`, `OD11-DF-0001`. No code, SQL or migration. | **Design only; implementation NOT started.** Open owner questions Q1-Q8 (notably Q2: a judge who can never confirm). Depends on OD-04, OD-05/06, OD-10, OD-12. |
