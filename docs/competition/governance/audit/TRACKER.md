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

## Owner decisions recorded: OD-30

| Id | Decision | Date | Implementation | Status |
|---|---|---|---|---|
| OD-30 | **Option A:** versioned rulebook editions, effective-date tracking and body-specific `age_basis` rules; platform owner admits editions, organizers select, no automatic upgrade, controlled amendment after registrations begin, no ordinary switching after competition activity. Foundational prerequisite for any body profile. | 2026-11-23 | Docs only: [design](editions/OD-30-rulebook-editions-design.md), [edition-difference method and promotion gate](editions/edition-difference-method.md), [age-basis source notes](editions/age-basis-source-notes.md); register `OD30-*`. | **Design only, NOT IMPLEMENTED.** Every pinned edition's effective date is UNKNOWN; July 2026 NDCA stays an UNREVIEWED CANDIDATE (II.B.7.f changed). ProAm/Couples whose-age (AE-16) UNRESOLVED. Register cannot express an unknown date (finding F-1). No scoring engine or certification implied. OD-02 absolute. |
