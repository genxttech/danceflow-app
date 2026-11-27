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

## Owner decisions recorded: OD-21

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-21 | **Option A: preserve Studio/Custom minimum-participation and withdrawal rules** (two eligible couples for a scored callback Final; COMP_ADVANCEMENT_BELOW_MINIMUM; no finalist replacement; no single-couple scored Final this release) as DanceFlow policy (OD-15 A, OD-18 A). | 2026-11-23 | Docs only: [OD-21 record](../participation/OD-21-minimum-participation-and-withdrawal.md); register OD21-DF-0001/0002, OD21-NDCA-0001..0004, OD21-WSDC-0001/0002, OD21-SILENT-0001. | **NDCA III.D.6/III.D.8: requires_interpretation (not a source conflict). NDCA six-couple Championship rule and III.D.31 Chairman-discretion replacement: NOT IMPLEMENTED. WSDC 3.1.4 five-and-five finals minimum: NOT IMPLEMENTED, mandatory points-award condition (does not itself bar running the contest); WSDC 1.2.6 event minimums NOT IMPLEMENTED. UCWDC: NOT SPECIFIED IN PROVIDED SOURCE.** June vs July NDCA differences for III.D.6/8 UNVERIFIED. OD-01 (PR 832) preserved. |
