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

## Owner decisions recorded: OD-13

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-13 | **Option A: preserve DanceFlow Studio scoring** as DanceFlow policy, not UCWDC/NDCA/WSDC compliance; ordinal_rank@1 and historical behavior unchanged; differences documented; scoring disclosure specified (labels in code are a later, separately approved change). OD-01 publication restriction (PR 832) preserved. | 2026-11-23 | Docs only: [OD-13 differences and disclosure](../scoring/OD-13-studio-scoring-differences-and-disclosure.md); register OD13-DF-0001/0002, OD13-UCWDC-0001..0006, OD13-SILENT-0001/0002. No code, SQL or engine. | **UCWDC tiebreaking (Rules #3-#8, ProAm/ProPro ties, two-heat finals) NOT IMPLEMENTED; BLOCKER to any UCWDC profile activation.** A future UCWDC engine must be independently verified, separately versioned and evaluated under OD-24. NDCA Skating System and WSDC Relative Placement remain NOT SPECIFIED IN PROVIDED SOURCE. |
