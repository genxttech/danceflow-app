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

## Owner decisions recorded

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-01 | **BLOCK (Option C).** Block approval and publication of Studio-scored results where a declared governing body's mandatory scoring requirements are not implemented and verified. Non-scoring operations preserved; organizer acknowledgement never overrides mandatory body scoring rules; the WSDC non-WSDC-contest opt-out (3.4.9.f) is handled separately with contest-level identification and published disclosure and never applies to WSDC Jack and Jill contests; Studio/Custom (`none`) unchanged; `other` unblocked but never implies verified sanctioning compliance. | 2026-11-23 | Draft PR (app layer, no SQL): `sanctionGuard.ts`, approve/publish server actions, results page, publication controls, advanced-page copy. Register: OD01-UCWDC-0001, OD01-NDCA-0001, OD01-WSDC-0001, OD01-WSDC-0002 (all `unsupported`, i.e. blocked, not compliant). | implemented-unverified (unit tests only; no QA run, not merged) |

Unresolved after OD-01 (never claimed compliant): NDCA Skating System algorithm; WSDC Relative Placement definition; UCWDC authorized-system designation; WSDC contest-level opt-out data model and disclosure record (needs SQL); database-level enforcement of the guard (RPCs do not read the declaration).
