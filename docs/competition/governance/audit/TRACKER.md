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

## Owner decisions recorded: OD-22

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-22 | **Option B for initial Studio/Custom:** a published result may be temporarily hidden during an authorized correction (K0 wording confirmed; never deletion; completed rounds need OD-07 controlled correction; corrected result = new linked version). **Option A for future WSDC support;** UCWDC correction-authority restrictions. | 2026-11-23 | Docs only: [OD-22 record](../publication/OD-22-published-result-visibility-and-corrections.md); register OD22-*; K0 section 4 wording updated. | **"Under review" entrant presentation: design only, NOT IMPLEMENTED.** WSDC 3.1.9 30-day access and corrected-result posting NOT IMPLEMENTED (interim removal not addressed by the text; needs independent verification). NDCA III.D.17 scrutineer-sheet publication NOT IMPLEMENTED. UCWDC II.N.1/II.N.3: manager reversal of official decisions to be prohibited; NOT IMPLEMENTED. Each is a profile-activation blocker. OD-01 (PR 832) preserved. |
