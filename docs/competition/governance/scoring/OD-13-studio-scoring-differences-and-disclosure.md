# OD-13: Studio scoring differences and disclosure specification

Owner decision **OD-13, 2026-11-23: Option A, preserve DanceFlow Studio scoring.** The Studio ordinal-majority
tie chain stays as DanceFlow policy. It is **not** UCWDC, NDCA or WSDC compliance. `ordinal_rank@1` and historical
behavior are preserved, and the Studio engine is never edited to chase a body's rules. This file is documentation
only: no code, copy, export, SQL or engine change is made or authorized by it.

## 1. What is preserved (DanceFlow policy)

Owner decisions D-OM-1..3 (2026-10-24), adopted "as DanceFlow Studio rules" with no compliance claim
([engine spec](../../engine-spec-ordinal-majority.md) sections 5-6; register `OD13-DF-0001`, `OD13-DF-0002`).
Implementation: `src/lib/competition/results/engines/studioOrdinalMajority.ts`; ballot format `ordinal_rank@1`
(`src/lib/competition/ballots/formats.ts`); database recompute `_comppv1_ordinal` in
`20270215090000_competition_pv1_result_recompute.sql`.

Exact Studio steps for one final (single heat, full 1..N ranking per judge, no equal marks):

1. `m = floor(J/2) + 1` (strict majority of `J` judges).
2. For each place `p`, among unplaced entries find the smallest cutoff `c >= p` at which some unplaced entry has at
   least `m` judges ranking it at or below `c`. Entries that qualify at that cutoff are the qualifiers.
3. One qualifier takes place `p`. Several qualifiers are ordered by: (1) more judges at or below `c`; (2) lower sum
   of those ordinals that are at or below `c`; (3) still tied, they share the placement.
4. A shared placement is numbered 2, 2, 4 (the next number skips the places used).
5. A multi-heat round fails closed (no combination across heats is specified).

## 2. Documented differences from UCWDC Scoring Format v16.9b

Source: `2026-Scoring-Format-v16.9b-1.pdf` (SHA-256 `44290a06...`, registry-pinned), re-read on 2026-11-23.

| Topic | UCWDC Scoring Format | DanceFlow Studio | Register |
|---|---|---|---|
| Majority mark | Rule #3: re-order each contestant's marks; middle mark (odd panel) is the majority mark | Cutoff-count formulation (OM-A); equivalence to Rule #3 is not claimed | `OD13-UCWDC-0001` |
| First and second tiebreakers | Rule #4 majority size, Rule #5 majority sum (marks left of the majority mark) | Chain (1) judges at or below cutoff, (2) sum of ordinals at or below cutoff; different quantities | `OD13-UCWDC-0002` |
| Third and fourth tiebreakers | Rule #6 look-ahead (marks right of the majority mark, smaller value ranks higher), Rule #7 look-behind (marks left) | None: Studio stops and shares the place | `OD13-UCWDC-0003` |
| Last resort | Rule #8 head-to-head win/loss/tie records with re-visitation; final tie shares the tied placements (announced as the higher one); carry-forward is the average of shared placements | Shares the place after two steps; numbering skips; no head-to-head, no carry-forward average | `OD13-UCWDC-0004` |
| Tied marks | Rule #3.2: ProAm/ProPro judges may tie contestants; Couple and Line Dance may not | Full 1..N ranking, no ties (check V9) | `OD13-UCWDC-0005` |
| Heats | Finals may be danced as two heats (Rule #1 and Rule #2 round sizing) | One heat per run; multi-heat fails closed (check V11) | `OD13-UCWDC-0006` |

### Worked example: F-OM-09

Fixture `F-OM-09` in [engine-spec-ordinal-majority.md](../../engine-spec-ordinal-majority.md) and the test
`F-OM-09 shared placement skips the number` in
`src/lib/competition/results/engines/__tests__/studioOrdinalMajority.f1.test.ts`. Three judges, ranks
(J1, J2, J3): entry 11 = 1, 2, 4; entry 12 = 2, 1, 3; entry 13 = 3, 3, 1; entry 14 = 4, 4, 2.

- **Studio:** 11 and 12 tie at cutoff 2 (two judges each), their sums at or below the cutoff are both 3, so they
  **share first place** (11 to 1, 12 to 1, 13 to 3, 14 to 4).
- **UCWDC (hand-worked from Rules #3-#6, not a tested implementation):** re-ordered marks are 11 = [1,2,4] and
  12 = [1,2,3]. Both have majority mark 2, majority size 1 (one larger mark to the right) and majority sum 1
  (one mark to the left), so Rules #3-#5 do not separate them. Rule #6 look-ahead compares 4 against 3: the
  smaller value ranks higher, so **entry 12 would place first**.

This difference is the reason the Studio method must never be labelled as UCWDC scoring (section 4).

## 3. NDCA and WSDC

The NDCA rule book requires the Skating System but the algorithm is **NOT SPECIFIED IN PROVIDED SOURCE**
(`OD13-SILENT-0001`). WSDC Relative Placement is referred to the WSDC website and is **NOT SPECIFIED IN PROVIDED
SOURCE** (`OD13-SILENT-0002`). Both stay unresolved under OD-24. Nothing here defines or approximates them.

## 4. Scoring-disclosure specification (text only; no code change authorized)

Purpose: nobody reading a Competition OS surface may conclude that Studio scoring is certified by, or compliant
with, UCWDC, NDCA, WSDC or any other body.

**Rules for wording**

- Name the method as DanceFlow's: "DanceFlow Studio scoring" (ordinal ranking with a majority rule).
- Say what it is not, once, plainly: "DanceFlow Studio scoring is a DanceFlow method. It is not UCWDC, NDCA or WSDC
  scoring and has not been certified or verified by any governing body."
- Never use "official", "sanctioned", "certified", "compliant", "UCWDC-style", "Skating System" or "Relative
  Placement" for Studio output. Never imply that a body's tiebreak rules were applied.
- Where an event declares a governing body (OD-01), do not publish Studio-scored results as body-compliant; the
  OD-01 restriction (PR 832) still decides what may be approved or published.
- Tie text: "Entries with equal results share a placement; the next placement number is skipped."
  Do not describe the tie handling as a body procedure.
- Keep labels short; use one standard sentence everywhere so the claim cannot drift by surface.

**Suggested standard sentences (owner to approve before any use)**

- Short label: "DanceFlow Studio scoring (not a governing-body method)".
- Full note: the "is a DanceFlow method" sentence above plus the tie sentence.

**Surface checklist: each to be labelled LATER, after separate owner approval of the code change**

| Surface | Label to add | Status |
|---|---|---|
| Competition setup wizard, scoring step | Short label + full note where a Studio profile/method is chosen | not done |
| Wizard review / summary step | Short label | not done |
| Event and program settings showing the active profile | Short label | not done |
| Scorer / results page (internal view) | Full note near the placements | not done |
| Results preview before approval | Full note, shown before the approver confirms | not done |
| Public results page and share/embed views | Short label + link to full note | not done |
| Printable results / PDF | Full note in the footer | not done |
| CSV / spreadsheet export | A header row or metadata column carrying the short label | not done |
| Certificates, announcements, emails showing placements | Short label where placements are quoted | not done |
| Help-center and marketing copy that mentions scoring | Review wording against the rules above | not done |

Each row needs the exact string, the file, and a test when it is proposed. No `src/` copy is changed by this PR.

## 5. Future UCWDC support (blocker)

UCWDC tiebreaking (Rules #3-#8, ProAm/ProPro ties, two-heat finals) is **NOT IMPLEMENTED** and is a **blocker to
activating any future UCWDC scoring profile**. A future UCWDC engine must be independently verified, separately
versioned (never by editing `ordinal_rank@1` or `studio_ordinal_majority@1`) and evaluated under OD-24.

## 6. Not verified here

- The UCWDC hand computation above was done by reading; no UCWDC engine or independent test exists.
- Page numbers for UCWDC citations follow the printed footers; the Rule #1.1 and #2.3 references follow the owner list.
- The SQL recompute test was not run; the TypeScript tests were not run in this docs-only change.

## 7. OD-14: over-capacity callback ties (owner decision 2026-11-23, Option A)

**Preserved as DanceFlow Studio policy** (owner decisions D-CT-4, 2026-10-24, and OD-1 option D, 2026-10-30; register
`OD14-DF-0001`): when tied couples at the callback cut exceed the Final's capacity, the engine outcome
`blocked_tie_over_capacity` (`studioCallbackTally.ts`) leaves every row undecided and the trigger
`cf1_guard_advancement_approval` (`20270120090000_competition_cf1_callback_final_advancement.sql`) refuses approval with
`COMP_ADVANCEMENT_BLOCKED`. No arbitrary manager selection, no runoff, no automatic advance of all tied competitors.
This is not UCWDC, NDCA or WSDC behavior.

| Body | What the pinned source says about ties at the cut | Status | Register |
|---|---|---|---|
| UCWDC v16.9b | Rule #1, item 4 (p.2): promote the designated number "plus ties, if any occur"; Rule #2, item 4 says the same for Semi-Finals. No capacity exception is stated | Advance-plus-ties **NOT IMPLEMENTED**; blocker for a future UCWDC profile | `OD14-UCWDC-0001` |
| NDCA June 2026 | IV.C.1.f ("except in the case of a tie") versus IV.C.2 (no more than eight in a Final) | **UNRESOLVED source conflict**; no cap or exception enforced or invented | `OD14-NDCA-0001`, `OD09-NDCA-0004` (PR 839) |
| WSDC 2026.1C | Section 5 (printed p.23): the Chief Judge's scores break a callback tie, after the original calculation. No "advance all tied" rule was found in the provided text | **CONFIRMED** tie-break text; "advance all tied" and over-capacity behavior **NOT CONFIRMED** (website detail not provided); not implemented | `OD14-WSDC-0001` |

**Citation reconciliation.** The UCWDC promotion rule is **Rule #1, item 4 (p.2)**, i.e. "Rule #1.4" as the audit
inventory calls it. It is not "Rule #4": the standalone Rule #4 (p.3) is the majority-size tiebreaker.

**Correction made in this PR.** `docs/competition/callback-to-final-advancement-design.md` section 0.2 previously said, for
a tie at the cut-off when promoted plus ties exceed capacity: "**Silent.** Q1 in the UCWDC spec concerns the Semi-Finals
retirement cut only; no Prelims → Finals over-capacity tie rule is confirmed." That row now states that UCWDC does speak
to ties (promote plus ties) while stating no capacity exception, and that the Studio block is DanceFlow policy.

**Disclosure surfaces (later, separately approved).** The section 4 checklist also covers: the unresolved-tie
message on the results page and approval screen, and the approver-facing explanation of `COMP_ADVANCEMENT_BLOCKED`.
Use wording such as "DanceFlow Studio policy: a tie that exceeds the Final's capacity blocks advancement until it is
resolved by an approved process." Do not imply a body requires this block.

**Coordination.** OD-09 (PR 839): NDCA recall and Final-size prerequisites; OD-13: Studio scoring labels; OD-24:
missing NDCA and WSDC algorithm text; OD-01 (PR 832): unverified body-compliant results are not published.
