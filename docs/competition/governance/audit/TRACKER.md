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

## Studio/Custom release blockers

Blockers stay `OPEN` until the closing evidence listed for each is independently verified. Policy ratified and implementation verified are tracked separately.

| Blocker | Source | Register entry | Design | Policy | Implementation verified | Status | Closing criteria |
|---|---|---|---|---|---|---|---|
| Eligibility-status enforcement inconsistency (`unverified`/`needs_review` can be scheduled, called, scored and published; only `ineligible` is blocked) | Owner decision R-15 (2026-11-24); audit row AE-21 | `DFPOL-R15-ELIGIBILITY-ENFORCEMENT` (inconsistent) | [r15-eligibility-enforcement-design.md](../../r15-eligibility-enforcement-design.md) (slice S4, design only) | ratified | no | OPEN | S4 implemented and applied via the approved path; negative and regression suite executed green on an integrated release candidate (with JC1, U18, U18-S, S5, OD-02/03/18); end-to-end acceptance run; independent security review; owner acceptance |
