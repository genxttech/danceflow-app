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

## OD-19 follow-ups (Studio/Custom relabel)

OD-19 decided 2026-11-23 (Option C now, Option A for future body profiles). Draft PR: relabel of the wizard/review
copy, see [od19-custom-format-relabel.md](../../od19-custom-format-relabel.md). Audit rows CL-09, FD-30, RP-04, FD-11,
FD-29 stay open for the future body profiles: register entries `OD19-*` record role enforcement as NOT IMPLEMENTED and
a BLOCKER for those profiles. Open: persisted contest names for new setups still carry the legacy label (needs an
owner decision on a migration or render-time mapping).

## OD-20 follow-ups (organizer exclusion only)

OD-20 decided 2026-11-23 (Option A, organizer exclusion only for initial activation); see [od20-organizer-exclusion-wording.md](../../od20-organizer-exclusion-wording.md). Register entries `OD20-*` record UCWDC missed-call disqualification, UCWDC exclusion and Judge Review Board, NDCA D rule and eligibility-dispute routing as NOT IMPLEMENTED blockers for future body profiles. Open: the `disqualified` heat-entry status is directly writable by a manager on release/website-embeds (U18 guard not on this line; needs a separately approved SQL change).

## OD-28 follow-ups (team offerings)

OD-28 decided 2026-11-23 (Option B); see [od28-team-offerings-relabel.md](../../od28-team-offerings-relabel.md). `OD28-*` entries record NDCA Formation/Team Match and UCWDC Teams/ShowTime rules as NOT IMPLEMENTED; XII.D vs II.A.7.a (CL-11) stays unresolved. Open: team offerings can be chosen whose scoring fails closed (Country Medal Marks, Studio Ratings); per-member age enforcement has a table-API gap for roster changes (needs a separately approved SQL guard).

## R-03 / R-04 / R-05 / R-09 follow-ups

See [r03-r09-wording.md](../../r03-r09-wording.md). Open: team roster changes and staff-created entries have no database-level under-18 guard (release blocker, separate SQL approval); organizer-configurable age ranges are a separate design (thresholds, validation, audit history, compatibility review); non-Studio schemes still list under-18 age divisions; the DanceFlow role note is not yet shown in the public builder.

## R-14 follow-ups (operational obligations)

See [r14-operational-obligations-audit.md](../../r14-operational-obligations-audit.md). Open: the WSDC surcharge field on the advanced page creates a competitor-facing per-entry fee rule (review separately); no venue, meeting, timetable-window or reporting-deadline checks exist; the UCWDC personal-data requirements need a privacy-design review.
