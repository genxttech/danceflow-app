# Audit tracker

Status values: `not started`, `in progress`, `inventory merged`, `owner decisions pending`, `closed`.
Findings are counts by class: verified / inconsistent / unsupported / requires-interpretation.
Public activation stays blocked until every row is `closed`. See [README.md](README.md).

| # | Domain | Owner-listed scope | Inventory file | PR | Status | Findings (V / I / U / RI) | Blockers |
|---|---|---|---|---|---|---|---|
| 1 | Formats, disciplines, divisions | Formats/disciplines/divisions | `inventory-formats-divisions.md` | #787 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 19 / 4 / 14 / 3 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 2 | Age and eligibility | Age and eligibility calculations | `inventory-age-eligibility.md` | #787 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 9 / 2 / 12 / 3 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 3 | Classifications | Amateur/professional/Pro-Am/Pro-Pro classifications | `inventory-classifications.md` | #787 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 4 / 1 / 9 / 1 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 4 | Registration and partners | Registration and partner requirements | `inventory-registration-partners.md` | #787 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 5 / 3 / 9 / 1 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 5 | Judging | Judging qualifications/assignments/conflicts | `inventory-judging.md` | #790 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 3 / 24 / 6 / 13 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 6 | Scoring | Scoring systems/callbacks/placements/tie-breaking | `inventory-scoring-placements.md` | #790 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 10 / 15 / 10 / 12 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 7 | Scratches, withdrawals, DQ, result changes | Scratches/withdrawals/disqualifications/result changes | `inventory-withdrawals-corrections.md` | #788 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 2 / 2 / 4 / 15 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 8 | Organizer authority | Organizer authority/approvals/exceptions/appeals | `inventory-organizer-authority.md` | #788 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 1 / 2 / 5 / 9 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |
| 9 | Other rule-dependent behavior | Any other rule-dependent behavior | `inventory-other-rule-dependent.md` | #788 (draft) | in progress (inventory in unmerged draft PR; decisions consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md)) | 2 / 4 / 13 / 5 | Owner decisions OD-01..OD-32 unanswered; inventory PR unmerged |

Counts above were recounted by the consolidation (256 rows: 55 / 57 / 82 / 62). All owner decisions are consolidated in [OWNER-DECISIONS.md](OWNER-DECISIONS.md); a row moves to `owner decisions pending` when its inventory PR merges and to `closed` when its decisions are answered.

Inventory file names are suggestions; the auditing session records the actual file name and PR here when its
PR lands. Update the row in the same PR that adds the inventory file.
