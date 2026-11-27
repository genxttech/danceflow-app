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

## Mandatory release blockers (owner decisions)

| Id | Scope | Blocker | Status | Closing criteria | Document |
|---|---|---|---|---|---|
| R-10 part 3 | Studio/Custom release (separate from future governing-body profile gates) | Panel readiness (default minimum 1, no parity or scoring-method rule, absence ignored) accepts panels the ballot lock and engines refuse; no recovery except cancellation | **OPEN** (design drafted 2026-11-24; nothing implemented) | Enforcement corrected AND independently verified; negative tests pass; DEV/PROD counts re-run (2026-11-24: 0 misleading, 0 stuck); current-behavior reproduction executed (PENDING, heavy lock); recovery class A shipped and B1/B2 decided. A display-label correction alone does not close it. | [R10-studio-panel-readiness-correction.md](../judging-integrity/R10-studio-panel-readiness-correction.md); register `R10-DF-0001/0002/0003` |
