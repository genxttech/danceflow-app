# OD-21: minimum participation, uncontested entries and withdrawal replacement

Owner decision **OD-21, 2026-11-23: Option A, preserve the existing Studio/Custom minimum-participation and
withdrawal rules for initial activation.** This file is documentation only: no code, SQL, engine, UI or copy change is
made or authorized. Nothing here claims NDCA, UCWDC or WSDC compliance.

## 1. What is preserved (DanceFlow policy, `OD21-DF-0001`)

Owner decisions OD-15 A and OD-18 A (2026-10-30), implemented by the CF1 advancement start guard and apply
(`20270120090000_competition_cf1_callback_final_advancement.sql`, A4/A4a/A0) and the withdrawal function
(`20270120095000_competition_cf1_a6_withdrawal.sql`):

- A callback-plus-Final program needs at least **two eligible couples** to start and to apply advancement.
- A withdrawal that would leave fewer than two is refused with `COMP_ADVANCEMENT_BELOW_MINIMUM` and changes nothing
  (SQL test "OD-15 A: a withdrawal that would leave fewer than two ..." in `test_T_competition_cf1_a6_withdrawal.sql`).
- A withdrawn finalist is **not replaced**, and apply never inserts a heat entry for a withdrawn pair.
- **No single-couple scored Final on the callback-plus-Final path in this release.**

Limits of this record: the scope is the callback-plus-Final path; other program types were not audited here for a
one-couple scored Final. No label or disclosure exists on any surface yet (see the Studio-scoring disclosure spec in
`../scoring/OD-13-studio-scoring-differences-and-disclosure.md`, which the same wording rules apply to). SQL tests were
not run for this docs-only change.

## 2. NDCA Rule Book, June 2026, Master v1 (SHA-256 `d1b73e1f...`, pinned)

All passages re-read in the pinned PDF on 2026-11-23; page numbers are the printed footers.

| Rule | What it says (short) | Register | Status |
|---|---|---|---|
| III.D.6, sentence 1 (p.20) | "At least two (2) couples must participate in any featured event for it to be accepted as a bona-fide competition." Minimum participation for **recognition as a competition**. | `OD21-NDCA-0001` | `requires_interpretation` |
| III.D.8 (p.20) | Where only one couple is entered, "they are considered the de facto winner and must receive a 1st place mark." **First-place treatment** of an uncontested entry. | `OD21-NDCA-0002` | `requires_interpretation` |
| III.D.6, sentence 2 (p.20) | "For Championship Competitions, at least six (6) couples must participate." Tracked separately. | `OD21-NDCA-0003` | `unsupported` (not implemented) |
| III.D.31 (p.23) | The chairman "may at his discretion replace" a couple that withdraws after a round and before the next with "the next eligible couple". Discretionary, Chairman-controlled. | `OD21-NDCA-0004` | `unsupported` (not implemented) |

**Why III.D.6 and III.D.8 are `requires_interpretation` and not a source conflict.** The two rules answer different
questions (is the event accepted as a competition; what mark does a lone entry get). Their scopes are worded differently
("any featured event" versus "events, single dance or multi dance") and the text does not say how they fit together
when one couple enters. That scope ambiguity is preserved as written. We do not assert that the rules contradict each
other, so nothing is added to the source-conflicts table. DanceFlow Studio's refusal of a single-couple scored Final
would not satisfy III.D.8 and must not be described as doing so.

**III.D.31 requirements for a future NDCA profile** (nothing built): the Chairman, not the manager, decides (event-level
Chairman designation: OD-06/OD-17, PR 834); the next eligible couple is verified, not guessed; historical rounds and
ballots are preserved (OD-07 versioning, PR 838); the decision is audited; withdrawal handling is coordinated with
OD-08 (PR 840, which records III.D.31 as `OD08-NDCA-0002`). Studio never replaces a withdrawn finalist.

## 3. WSDC Registry Event Rules v2026.1C (SHA-256 `140caae7...`, pinned)

| Rule | What it conditions | Register | Status |
|---|---|---|---|
| 3.1 item 4 (p.10) | Jack and Jill needs "a minimum of five (5) unique Leaders and five (5) unique Followers in finals for points to be awarded and the results to be included in the Points Registry." | `OD21-WSDC-0001` | `unsupported`; a **mandatory points-award condition**, not an advisory warning |
| 1.2 item 6 (p.5) | Each Registry Event needs at least two skill-level Jack and Jill contests and 150 competitor entries (Growth Region: 80 entries and 100 attendees). | `OD21-WSDC-0002` | `unsupported` |

What the surrounding text conditions: 3.1 item 4 conditions **points and Points Registry inclusion**. In the passages
read (1.2, 3.1, the round chart in 3.3.2) nothing says the contest itself may not run with fewer finalists; 3.1 item
7.a only lets the Event Director combine or cancel a division that misses the Tier 1 requirement at registration close.
1.2 item 6.b says an event below its minimum still has results posted and Registry Points awarded and
goes on probation for one year, and 6.c says a repeat shortfall loses Registry Event status; so the event minimum is a
status condition, not a bar on running contests. The permission to conduct a Final and the eligibility to award points
are therefore kept as separate questions. The full WSDC rules were not read end to end.

## 4. UCWDC: no minimum-participation rule found (`OD21-SILENT-0001`)

**NOT SPECIFIED IN PROVIDED SOURCE.** Files searched (SHA-256 matched to the registry): Couples, ProPro/ProAm, Teams, Line
Dance rules v1-26-2026, and the Scoring Format v16.9b. Search terms: minimum, at least (two to six), fewer than, only one
couple/contestant/entry, a single contestant, sole, insufficient, not enough, uncontested, unopposed, by default,
walkover, cancel, combine, merge.

Hits that are **not** minimums: Section L (Graduation Requirements) in the Couples, ProPro/ProAm and Line Dance rules, e.g.
"In the case of less than three (3) competitors competing for overall", which changes when a win counts toward
graduation (an eligibility-credit rule, not a rule on running a contest; also the Worlds graduation clause and the Line Dance "less than three" wins clause); Scoring Format Rule #9 item 1 uses "a single
contestant" for scoring points. Nothing is invented: any UCWDC minimum is DanceFlow or organizer policy, labelled so. The
search was by keyword, so absence is not proof.

## 5. Optional future capability (product evaluation only, `OD21-DF-0002`)

An organizer-labelled uncontested division (one couple, no scored Final) is recorded **for product evaluation only**. It
is not designed, approved or implemented, is not a rule, and must not be presented as satisfying NDCA III.D.8.

## 6. NDCA edition handling

The pinned June 2026 source stays authoritative; the July 2026 edition is **not** silently substituted. PR 840's
June-versus-July comparison says: III.D.31 is unchanged in wording; III.D.30, III.D.11, X.A and Section IV are unchanged;
differences found elsewhere are II.B.7.f, IX.A.1.f(1)(a) and IX.A.1.f(1)(c). **III.D.6 and III.D.8 are not covered by
PR 840's comparison, so any June-versus-July difference for them is UNVERIFIED.** Before any NDCA profile activation, the
edition differences relevant to III.D.6, III.D.8 and III.D.31 must be verified and the edition question settled under
OD-30. The III.D.31 statement above was read from PR 840 and not independently re-verified here.

## 7. Coordination and gates

OD-01 (PR 832) restrictions on publishing unverified body-compliant results stay. OD-06/OD-17 (PR 834) supply event-level
roles; OD-07 (PR 838) corrections; OD-08 (PR 840) withdrawals; OD-09 (PR 839) NDCA advancement; OD-24 scoring
algorithms. Gaps closed by none of this: NDCA six-couple Championship rule, III.D.6/III.D.8 interpretation, Chairman
replacement workflow, WSDC points condition and registry minimums, and the policy labelling of Studio's rules.

## 8. Not verified here

- SQL and TypeScript tests were not run (docs-only).
- Whether other program types can run a scored one-couple Final.
- WSDC and UCWDC rules beyond the cited and searched passages.
- The July 2026 edition was not retrieved by this session.
