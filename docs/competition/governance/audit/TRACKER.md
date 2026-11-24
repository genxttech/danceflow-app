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

## R-07 verification (2026-11-23)

- **R-07 (Studio scoring fail-closed controls): verification report delivered, docs and test-only.** No bypass found; SQL runtime suites NOT RUN (heavy-lock queue); register entries `R07-*` (DF-0001..0005 policy, UCWDC-0001..0002, NDCA-0001..0002, WSDC-0001 recorded NOT IMPLEMENTED); Multi-Dance disclosure is spec text only. See [R-07-VERIFICATION.md](R-07-VERIFICATION.md) and [R-07-MULTI-DANCE-DISCLOSURE-SPEC.md](R-07-MULTI-DANCE-DISCLOSURE-SPEC.md).
- **R-08 (Scratch/No-show in scoring): verification report added** ([R-08-VERIFICATION.md](R-08-VERIFICATION.md)). Policy ratified; implementation inspected, SQL suites NOT RUN. Open: Multi-Dance semantics (RF-8.1: scratch/no-show per heat entry, exclusion whole-round only, X-6 refuses multi-dance rounds). Register `R08-*`.
- **R-09 (callback structure, PV-1, A4a): verification report added** ([R-09-VERIFICATION.md](R-09-VERIFICATION.md)). Inspected; SQL suites NOT RUN; 'Semi-final' label is persisted PV-1-compared output (display-only relabel required). Register `R09-*`.
- **R-11 (approval controls): verification report added** ([R-11-VERIFICATION.md](R-11-VERIFICATION.md)). Inspected plus static tests; SQL suites NOT RUN; release findings RF-11.1..5. Register `R11-DF-0001`.
- **R-11 extension (2026-11-24): RELEASE BLOCKERS RB-11.1/RB-11.2** — D3 self-approval is reachable for corrected results and accepts a 1-character reason; see [R-11-VERIFICATION.md](R-11-VERIFICATION.md) sections 5-9. Register R11-DF-0001 (inconsistent), R11-WSDC/NDCA/UCWDC-0001.
