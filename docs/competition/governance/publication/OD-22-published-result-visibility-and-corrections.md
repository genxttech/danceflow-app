# OD-22: published results, temporary hiding and corrections

Owner decision **OD-22, 2026-11-23: Option B for initial Studio/Custom; Option A for future WSDC support, with UCWDC
correction-authority restrictions.** Documentation only: no code, SQL, engine, UI or copy change is made or authorized.
Nothing here claims NDCA, UCWDC or WSDC compliance.

## 1. Confirmed Studio/Custom policy (`OD22-DF-0001`)

A published result may be **temporarily hidden** from entrant-facing and public results while an authorized correction is
open, or after an explicit manager withdrawal with a reason. The owner confirmed this on 2026-11-23, which settles the
K0 wording that had been flagged for owner confirmation (section 4 of
[scoring-results-contract.md](../../scoring-results-contract.md), updated in this PR).

How it works today (F3, `20270122090000_competition_f3_publication.sql`): `withdraw_competition_round_result` hides a current
publication from every non-manager reader and stamps who, when and why; `_compf3_live()` makes all three readers require a
current publication on a published or complete round with no open correction and the latest approved version. A
withdrawn publication is never restored; recovery is correction, recalculate, approve, publish.

**Hiding is never deletion or destructive replacement.** All original result versions, ballots, scoring evidence, audit
records and publication rows are preserved, and the result is never edited (OD-04, PR 844). Completed rounds need
OD-07's controlled correction authorization (PR 838); the corrected result is published as a **new linked version** (the
supersede link and `publication_version + 1`), not by overwriting.

## 2. Design requirement: "Under review" for entrants (`OD22-DF-0002`, NOT IMPLEMENTED)

What exists: the round-level public reader returns `{published: false, under_review: true}` as a generic notice (K0 O4: never
the reason). The entrant reader `competition_my_results` simply omits a non-live publication, so an entrant sees the result
disappear with no explanation. Where practical, entrants of Studio/Custom events should see an "Under review" status instead.

Proposed states for the entrant view of one division's result:

| State | When | What the entrant sees |
|---|---|---|
| Published | current live publication | the placement as today |
| Under review | a previously published result is hidden by an open correction or a withdrawal | the division stays listed with "Under review"; no placement, no reason, no corrected values |
| Republished | the corrected result is published as a new version | the corrected placement; optionally "Updated" with the date |
| Never published | no publication ever existed | nothing (unchanged) |

Wording must follow the disclosure rules in the OD-13 record (a DanceFlow method, no body certification implied), must not
reveal why the result is under review, and must reveal nothing about unpublished values. The status itself needs a
reader that can tell "previously published, now hidden" from "never published" without exposing the reason: unimplemented
scope, not designed in detail here.

## 3. Future WSDC profile: results access and corrections (`OD22-WSDC-0001`)

WSDC Registry Event Rules v2026.1C, 3.1 item 9 (printed p.12), re-read in the pinned PDF: results must be posted at the
event and "open to all competitors for a minimum of 30 days"; they include "contest rounds (e.g., prelims, semis, finals),
placements and score reports"; and if results are inaccurate, "corrected results must be posted".

What the text **does not say**: anything about temporarily removing a posted result while it is investigated; who decides a
result is inaccurate; a deadline for corrected results; whether a hidden-then-corrected result satisfies the 30 days. So the
Studio hiding behavior must **not** be assumed to be WSDC-permitted. A WSDC profile needs a clearly marked under-review
presentation that keeps the required access in place (for example the original score report stays visible but flagged)
until a corrected result replaces it. This **requires independent verification before WSDC profile activation** and is a
profile-activation blocker, NOT IMPLEMENTED.

## 4. NDCA scrutineer sheets (`OD22-NDCA-0001`)

NDCA Rule Book June 2026, III.D.17 (printed p.21): digital copies of the scrutineer sheets "shall be made publicly
accessible", uploaded "following the conclusion of each day of competition at a minimum", and posted "only for events that
been completed and results announced" (the source's own wording). NOT IMPLEMENTED; a profile-activation blocker. The
distinction from original marking sheets (III.D.16) is in the OD-23 record. The text does not address a correction after
posting.

## 5. UCWDC: finality and challenges (`OD22-UCWDC-0001..0003`)

- **Couples rules II.N.1 (p.13):** "All decisions of the contest judges, the Contest Coordinator, and Event Director are
  final." A future UCWDC profile must **prohibit unilateral manager reversal** of published official judging decisions.
- **II.N.3 (p.13):** a complaint or challenge to a panel or its results "must be done post-event and will go to the Judge
  Review Board", outside DanceFlow. The referenced Judge Certification Code of Conduct is not provided.
- **Scoring Format Rule #8, item 1 (p.4):** "a scoring error has occurred, and the previous rules must be re-calculated" is
  an internal check inside the tie-break algorithm, **not** a post-publication correction procedure and not correction
  authority.

DanceFlow must distinguish clerical or computational corrections (mis-tabulated recorded marks) from challenges to judging
decisions (Judge Review Board). No correction authority is invented where the sources are silent; any would be labelled
DanceFlow or organizer policy.

## 6. Coordination, gates and what is not verified

Preserved: OD-04 (PR 844) no destructive deletion; OD-07 (PR 838) controlled corrections; OD-10 (PR 842) confidentiality;
OD-01 (PR 832) publication restriction. Blockers: every body requirement above is unimplemented and blocks activation of
that body's profile.

Not verified: SQL and TypeScript tests were not run (docs only); the OD-07, OD-04 and OD-10 designs were not re-read for
this record; WSDC and UCWDC rules beyond the cited passages were not re-read.
