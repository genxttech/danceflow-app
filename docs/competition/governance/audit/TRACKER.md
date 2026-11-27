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

## OD-10 ballot visibility (design)

| Id | Decision | Date | Design | Status |
|---|---|---|---|---|
| OD-10 | **Options A + C with audit logging for all Competition OS events.** NDCA-declared events: pre-end-of-competition ballot content only for explicitly designated Chairman of Adjudicators and Scrutineer (NDCA III.D.16, original copies; electronic-ballot confidentiality is DanceFlow policy). Least-privilege baseline for Studio/Custom, WSDC, UCWDC (WSDC and UCWDC rules silent). Managers get aggregates only. Every authorized ballot retrieval audited, no contents in the ledger. | 2026-11-23 | Draft design PR (docs only): `docs/competition/governance/ballot-visibility/OD-10-ballot-visibility-design.md`; register OD10-NDCA-0001..0003, OD10-WSDC-0001/0002, OD10-UCWDC-0001/0002, OD10-DF-0001..0003 (none `verified_compliant`). | design drafted, independent security review recorded in the design; nothing implemented, applied or merged |
