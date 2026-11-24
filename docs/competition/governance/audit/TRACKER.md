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

## Owner decisions recorded: OD-25

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-25 | **Option B now:** preserve Studio/Custom heat planning (configurable capacity, default 8 as a DanceFlow product default, not a sanctioning rule; deterministic first-fit floor planner); no seeded randomization this release. **Option A for future body profiles.** | 2026-11-23 | Docs only: [OD-25 record](../heating/OD-25-heat-planning-and-body-heating-rules.md); register OD25-*. | **FINDING (open): the readiness heat planner already uses a recorded random seed (OD25-DF-0002); needs owner/coordinator decision.** NDCA III.D.34 Pro/Am floor limits NOT IMPLEMENTED (not the Final cap). UCWDC Heating Rules: randomization and contiguous order mandatory and NOT IMPLEMENTED (blockers); size, smaller-first and balancing advisory (tracked, not hard blockers). WSDC 3.4.8 random partner/music selection NOT IMPLEMENTED; WSDC heat size/randomization NOT SPECIFIED IN PROVIDED SOURCE. OD-26 placeholder. OD-01 (PR 832) preserved. |
