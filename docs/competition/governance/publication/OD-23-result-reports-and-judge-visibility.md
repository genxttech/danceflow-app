# OD-23: result reports, scoring analyses and judge visibility

Owner decision **OD-23, 2026-11-23: Option B for initial Studio/Custom; Option A required for future body profiles.**
Documentation only: no code, SQL, report generation, UI or copy change is made or authorized. Nothing here claims
NDCA, UCWDC or WSDC compliance.

## 1. Preserved Studio/Custom behavior (`OD23-DF-0001`)

Placement-only publication with these defaults (K0 contract rows O3, P5, P10; F3 migration
`20270122090000_competition_f3_publication.sql`):

- Visibility defaults to `entrants`; `public` only by explicit organizer choice at publication
  (`publish_competition_round_result`).
- Entrants read their own results through `competition_my_results`; the public reads through
  `competition_round_results_public` and `competition_event_results_public`; client parsing is in
  `src/lib/competition/results/viewer.ts` and `publication.ts`; the reader matrix is `RESULT_READER_MATRIX` in
  `src/lib/competition/results/contract.ts`.
- Public results hide judge names and letters (owner decision O3, 2026-10-24; the sources do not specify it for Studio).
- Unpublished results are readable only by result managers (P5); published results always reach entrants' portals (P10).

## 2. Disclosure text specification (`OD23-DF-0002`, text only, NOT IMPLEMENTED)

Studio/Custom result reports must say, in plain words, that they **do not provide governing-body-certified scoring
analyses, scrutineer sheets or official awards reports**. Suggested sentence (owner to approve before any use):

> "These results come from DanceFlow Studio scoring. They are not a governing-body scoring analysis, scrutineer sheet or
> official awards report and have not been certified by any governing body."

Apply the wording rules of the OD-13 disclosure spec (no "official", "certified" or "compliant" for Studio output). Surfaces
to label later, after separate owner approval of the code change: entrant results page, public results page, printable
results, CSV/spreadsheet export, share/embed views, announcements or certificates quoting placements. None is changed here.

## 3. Per-body report requirements (all NOT IMPLEMENTED; each a profile-activation blocker)

| Body | Requirement (short phrases; printed pages) | Register |
|---|---|---|
| NDCA June 2026, III.D.17 (p.21) | Digital scrutineer sheets "shall be made publicly accessible", uploaded after each day, only for events "completed and results announced" | `OD22-NDCA-0001` |
| NDCA III.D.16 (p.21) | Only the Chairman and Scrutineer have "direct access to the original copies of the judges' marking sheets until the end of the competition" | `OD23-NDCA-0001` |
| UCWDC Scoring Format v16.9b, DSA paragraph (p.8) | The Divisional Scoring Analysis "must be available" to contestants (divisions they dance), adjudicators (divisions they judge), Contest Coordinators (divisions they coordinate), and named UCWDC officers for all events | `OD23-UCWDC-0001` |
| UCWDC Rule #3 item 4 (p.3) | The raw-score order includes "each judge's name so revealed" | `OD23-UCWDC-0002` |
| UCWDC awards paragraph (p.8) | The hired Scoring System "must produce awards reports to be read to the public" and "only this report can be used for Awards" | `OD23-UCWDC-0003` |
| WSDC v2026.1C, 3.1 item 9 (p.12) | Results include "contest rounds (e.g., prelims, semis, finals), placements and score reports"; judges "may be listed anonymously" at the Event Director / Owner / Chief Judge's discretion | `OD23-WSDC-0001`, `OD22-WSDC-0001` |

### NDCA: scrutineer sheets versus original marking sheets

The text treats "original copies of the judges' marking sheets" (III.D.16) and "digital copies of the scrutineer sheets"
(III.D.17) as different items, and Studio treats ballots as the original marks and a published report as tabulated
results. The rule book does **not** define "scrutineer sheets": Section IV also refers to "the scrutineers' marking sheet"
(where disqualifications are noted) and to "blank scrutineer sheets". UNRESOLVED: what a scrutineer sheet contains, whether
it shows per-judge marks, how its upload relates to finalization and corrections, and whether posting it would breach
III.D.16 until the end of the competition. Register `OD23-NDCA-0001` is `requires_interpretation` for this reason.

## 4. No global judge-identity policy

Bodies disagree, so there is **no single cross-body visibility or report-access policy**:

| Body / profile | Judge identity on reports | Who may set it |
|---|---|---|
| Studio/Custom | hidden on public results (O3); ballots restricted | DanceFlow default; organizer chooses entrants or public visibility only |
| UCWDC | judge names revealed in raw-score columns (Rule #3 item 4) | fixed by the rule; who sees the columns is not fully stated |
| WSDC | may be anonymous (Judge 1, Judge 2, ...) | an event-level choice by the Event Director, Owner or Chief Judge (roles per OD-06, PR 834) |
| NDCA | scrutineer-sheet content unresolved | not specified |

Each future body profile carries its own setting and records who chose it and when.

## 5. Report generation and ballots

Original ballots stay **separate** from published scoring reports. Future reports are generated by a controlled function from
authorized scoring records (result versions and their evidence), never by reading restricted ballots; access respects OD-10
(PR 842) confidentiality and read auditing. Corrected and superseded versions keep their history (OD-22, PR 838) and the WSDC
results-access duties (`OD22-WSDC-0001`).

## 6. External reports are not a compliance bypass

A manually produced external report (for example from a body-approved scoring system) is **not** an automatic compliance
bypass. Any future external-report workflow needs separate, documented verification and authorization, and must still respect
OD-01 (PR 832) on publishing unverified body-compliant results.

## 7. Coordination, placeholder and not verified

OD-22 (publication and corrections), OD-10 (PR 842), OD-01 (PR 832). **OD-24 placeholder:** scoring-profile architecture and the
missing NDCA and WSDC algorithm text are decided separately and are not assumed here.

Not verified: tests (docs only); the full NDCA, UCWDC and WSDC rules beyond the cited passages; the format of the UCWDC DSA
(not provided); the OD-10 design was not re-read for this record.
