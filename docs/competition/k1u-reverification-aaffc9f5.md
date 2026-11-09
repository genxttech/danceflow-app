# K1-U independent re-verification — spec @ aaffc9f5

Reviewer: the independent fixture-review session (read-only; the fetch was the only git operation; no repo writes). Date: 2026-10-25.
Read: `docs/competition/engine-spec-ucwdc-majority-rules.md` @ aaffc9f5fce8abdea3dbf357b525466336e46c5e (= origin/competition-k1-engine-specs head), plus `ucwdc-clarification-questions.md` and `k1u-independent-fixture-review.md` at the same commit. The repo copy of my review is byte-identical to mine (CRLF-normalised diff is empty).

## Verdict: NOT PASS — 6 defects remain (1 high, 3 medium, 2 low) plus 3 nits

The arithmetic is clean. The remaining problems are classification and fixture-scope consistency.

## 1. Findings D-1..D-11

| Finding | Status @ aaffc9f5 |
|---|---|
| D-1 unmarked callback | RESOLVED: §3.2 zero on a valid completed ballot (owner text quoted); missing/incomplete/invalid fail closed |
| D-2 Semi-Finals retire-cut tie | CLASSIFIED: Q1 in 12C, no Semi-Finals run (§3.3 scope note, F-U-15(e)). But see R-3 (12A also lists it) |
| D-3(a) G-15(a) vs §11 blanket fail-closed | RESOLVED by proof (§8.2), 12B |
| D-3(b) G-5 scope | RESOLVED: any Semi-Finals fails closed (§3.3, F-U-15(e)) |
| D-4 rounds-removed / multi-Prelims | RESOLVED in §3.1/§8.1/§16. But F-U-14 still expects the refused values (R-2) |
| D-5 callback ballot validity | RESOLVED (§3.3 list (1)–(4) + G-4). But "completed" for alternates is undefined (R-5) |
| D-6 R10/R11 non-finalists, empty common set | RESOLVED: fail closed (§8.2 G-15(b), §16.2). See R-4 for Rule #11's supported status |
| D-7 G&R duplicate/skipped ranks | RESOLVED (§4.3, §16.2) |
| D-8 shared best (IR-22) | RESOLVED: F-U-16 matches IR-22 exactly; Q3 |
| D-9 F-U-15(d) | RESOLVED in wording (≥3 tied), but still has no inputs (R-6) |
| D-10 F-U-11 note | RESOLVED |
| D-11 F-U-15(g) | RESOLVED (internal assertion) |

## 2. Fixture recomputation

- **Spec fixtures:** F-U-01..10, 12, 13 are unchanged since a750e74f, where I recomputed them all; they still agree. F-U-11 agrees: A=B=C=25.0, D 9.2, E 4.6, F 0 → A,B,C promoted for N=3 and for N=2. F-U-16 agrees: A 4-3-3 (4.5), B 4-3-3 (4.5), C 3-5-2 (6.0), fail closed. F-U-14: the 7 is correct; the 8 and 9 conflict with the scope (R-2). F-U-15 is consistent, except that (d) has no inputs.
- **My IR-01..32 under the revised rules:**
  - Computable and agreeing: IR-01, 03, 07–10, 12–21, 23, 24, 26.
  - IR-02 agrees, unless a judge marking fewer alternates counts as "incomplete" (R-5). J3 marked 1 alternate where the others marked 2.
  - IR-27 agrees (R2, R3, R1), but its supported status is unclear (R-4).
  - Correctly refused: IR-04/05/06 (Semi-Finals), IR-25 (multi-Prelims/Semi structure), IR-11, IR-22, IR-28–32. The spec's §16.2 covers each of these.

## 3. Remaining defects

**R-1 (HIGH): supported cases depend on readings the spec itself lists as unresolved.** §12C (last paragraph) lists G-1 (callback total is the sum over judges), G-3 (ties at the dividing line = equal totals, all promoted) and G-8 (Group-and-Rank converts to a dense 1…N rank) as "awaiting owner/UCWDC confirmation (not source statements, not owner-approved)". §16.1 marks Prelims callbacks (G-1, G-3) and Group-and-Rank finals for Couples, Line, Teams, AllStars and Spotlight (G-8) as supported. That breaks the requirement that no supported case depends on an unresolved rule. **Fix:** either the owner approves G-1/G-3/G-8 (move them to 12B), or §16.1 drops those cases. Reviewer opinion only: all three are strongly supported by the text (R1.2 "Totaling the points"; R1.4 "plus ties"; R3.3 "converted to ranked placements" together with R3.4's `[3,1,2,5,4]` rank example). The decision is the owner's.

**R-2 (MED): F-U-14 contradicts the supported scope.** The heading says "simple Prelims → Finals structure only (owner D-4)", but the fixture still expects "2 rounds removed → 8; 3 → 9". In that structure only 1 round removed exists, and §8.1 and §16.2 refuse "rounds-removed counting beyond 1". **Fix:** expect 7 only, and make 8 and 9 refusal cases (or mark them source arithmetic, not supported).

**R-3 (MED): §12A lists "promotion/retirement of the designated number plus ties" as SOURCE-CONFIRMED.** §12C Q1 lists the retirement-cut tie as unanswered, and §12 says every item sits in exactly one part. **Fix:** in 12A, confirm only Prelims promotion plus ties (and the Semi-Finals point values). Leave Semi-Finals retirement plus ties in 12C (Q1), as §3.3's scope note already says.

**R-4 (MED): Rule #11 has no status in §16.** §16.1 lists Rule #10 (non-empty common set, all tied contestants finalists) as supported. Rule #11 is neither supported nor refused, apart from the D-6 conditions. **Fix:** say explicitly whether Rule #11 is supported under the same conditions, with re-visitation back to Rule #10 and the G-13 refusals. IR-27 and the R11.3 mechanics depend on this.

**R-5 (LOW–MED): "valid, completed ballot" is undefined for alternates.** Validity rules (1)–(4) cover the Yes/No count, gaps from Alt #1, more than 5 alternates, and a missing ballot. They do not cover a judge who marks fewer alternates than the number the Coordinator set (R1.2: the Coordinator "may adjust the number of … 'Alt' ranks"). D-1 says incomplete ballots fail closed, so the spec must say whether fewer alternates (contiguous from Alt #1) is valid or incomplete. IR-02 hits this case.

**R-6 (LOW): F-U-15(d) still has no concrete inputs** ("still to be constructed"). Here is one, hand-checked, in case W6 wants to use it. J=7, ProAm values. Every contestant has the same marks, so they are tied through Rule #7.
- A [14,14,13,12,14,12,11]
- B [12,13,14,14,11,14,12]
- C [14,12,13,12,11,14,14]

Head-to-head:
- A vs B: B,B,A,A,B,A,A → A 4-3-0.
- A vs C: T,C,T,T,C,A,A → A 2-2-3.
- B vs C: B,C,C,C,T,T,B → B 2-3-2.

Records:
- A 6-5-3 (loss value 5+1.5 = 6.5).
- B 3-4-0 + 2-3-2 = 5-7-2 (8).
- C 2-2-3 + 3-2-2 = 5-4-5 (4+2.5 = 6.5).

A and C share the best loss value 6.5 with different records (A has more wins; C has fewer losses and more ties) → G-13 bullet 1 → fail closed. This needs only J=7, not 11.

**Nits (no outcome change):**
- F-U-12's closing parenthetical still says "G-15 notes the source does not define which"; G-15(a) is now resolved by proof.
- §16.2 says "any Semi-Finals ballot with alternates (G-5)", narrower than §3.3's "no Semi-Finals at all". The next bullet covers the rest, so it is harmless, but the wording could match.
- §12B points to §3.2 for the D-5 validity rules, which live in §3.3.

## 4. Other checks

- **Scope (Semi-Finals / multi-Prelims):** consistent in §3.1, §3.3, §8.1, §12, §16 and F-U-15(e). The exception is F-U-14 (R-2).
- **Source pin:** v16.9b and all five sha256 values are pinned in full in §0. They match the hashes I computed on 2026-10-24 (Scoring 44290a06…b02f, Couples 8a45ee58…4904, Line 98e90011…7fb7, ProPro/ProAm d6257b65…db84, Teams 7e71fdce…a41a). The newsletter is still unpinned, and the spec says so.
- **No compliance, eligibility or availability claims:**
  - The status line, §4.4, §5, §12 header and §16 all disclaim.
  - Every panel size is UNVERIFIED; J=1/2 are refused; the method stays UNAVAILABLE pending Q1–Q4.
  - "Supported" is defined as "not enabled".
  - `ucwdc-clarification-questions.md` is marked DRAFT, not sent.
  - Wording note: the status line says "Fixtures independently recomputed for the supported cases (§16.1)". That is true for the arithmetic, but given R-1 it should not read as approval of the readings.
