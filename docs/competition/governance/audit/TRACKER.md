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

## Judging-integrity design blockers (PR #834, design only, nothing implemented)

Design: [judging-integrity/OD-05-conflicts-design.md](../judging-integrity/OD-05-conflicts-design.md); defect: [judging-integrity/OD-16-studio-panel-minimum-defect.md](../judging-integrity/OD-16-studio-panel-minimum-defect.md). Register entries `OD05-*`, `OD06-*`, `OD15-*`, `OD16-*`, `OD17-*`, `OD29-*`.

- Studio/Custom blocker: E1 round readiness disagrees with the E2/engine panel rule (OD-16 defect document); correction recommended, not implemented.
- NDCA profile blockers (NOT IMPLEMENTED): family-definition source conflict (OD-05), panel minimums and formation non-voting chair (OD-16), credentials and Chairman/Scrutineer roles (OD-15), officials-list publication, change control and substitution (OD-17), judging devices; browser-ballot compatibility is UNVERIFIED (OD-29).
- WSDC profile blockers (NOT IMPLEMENTED): role separation designations and attestation (OD-06), panel counts per role and Trial Events (OD-16), virtual-judging declaration (OD-29); the computerized-scoring Appendix is not supplied.
- UCWDC: no conflict, substitution or device rules found; the Judge Certification Code of Conduct is an open source gap.
