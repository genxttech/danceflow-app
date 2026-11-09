# K1-U verification report: UCWDC Majority Rules draft spec

- **Draft verified:** `docs/competition/engine-spec-ucwdc-majority-rules.md` at `c9386777` (PR #293).
- **Verifier:** the Competition OS coordinator session (Opus), 2026-10-25.
- **Independence caveat:** I was not fully independent. Before W6 wrote the draft I had read Rules 3–6 and briefed W6 on them. To limit this, I read the whole Scoring Format, and the rule-book sections listed below, before opening the draft. The owner may still want a second, fresh verifier.

## Sources

All hashes match `governing-body-source-registry.md`.

| File | sha256 prefix |
|---|---|
| 2026-Scoring-Format-v16.9b-1.pdf | 44290a06d14c3080 |
| UCWDC Rules, Couples (1-26-2026) | 8a45ee58d189e65d |
| UCWDC Rules, ProPro/ProAm (1-26-2026) | d6257b65915151ab |
| UCWDC Rules, Line Dance (1-26-2026) | 98e9001113108eaf |
| UCWDC Rules, Teams (1-26-2026) | 7e71fdce55b0eade |

I confirmed the star tiers with `pdftotext -enc UTF-8`: "B★ = 23 … GG★ = 11".

## Verdict

**VERIFIED WITH CORRECTIONS.**

- Every calculation rule in the draft matches the source text: callbacks, the medal scales, the majority mark, Rules 4–8, multi-dance Rules 9–11, and reporting.
- No rule is invented.
- All 15 fixtures recompute to the same result.
- Five corrections are needed before owner approval. One of them conflicts directly with the owner's 16-mark directive (C-1).

## Rule-by-rule findings

| Rule | Draft § | Source | Finding |
|---|---|---|---|
| Heating H1–H7 | §2 | Heating Rules 1–7 | Matches. Correctly kept out of the engine; randomization seed flagged (G-19). |
| Prelims callbacks: Yes = 10, Alt 1–5 = 5.0/4.6/4.3/4.1/4.0, CC-set counts, "plus ties" | §3.2 | R1.2, R1.4 | Matches. G-1 (sum over judges) and G-3 (ties = equal totals) are reasonable readings. G-2 (unmarked = ?) is correctly fail-closed. |
| Semi-finals "No" ballots, retire least valued plus ties | §3.3 | R2.2–R2.4 | Matches. G-6 (highest No-total retired) is the only consistent reading. G-5 (alternates on a No ballot) is correctly fail-closed. |
| Worlds "all dances promoted together" | §3.5 | R1.5, R2.5 | Matches. The format is undefined, so fail-closed (G-7). |
| ProAm/ProPro 16 values (HM 26 … GG★ 11), ties allowed | §4.2 | R3.1, R3.2 | Matches. |
| 6 medals HM 6 … GG 1, Group-and-Rank, no ties | §4.3 | R3.1, R3.3 | Matches. G-8 (dense 1…N rank) is supported by R3.4's rank example. |
| Rule-book mark lists vs the 16-value scale | §4.4 | RB-P def. 10 lists M, B, S, S+, G, G+, GH, GH+, GG (9 marks). Couples, Line and Teams lists are the same. | The draft reports the conflict correctly, but its resolution contradicts the owner. See C-1. |
| Majority mark: odd panel = middle, even panel = J/2 + 1 | §5 | R3.4 | Matches. `floor(J/2)+1` is correct. |
| Placement by ascending majority mark | §5 | R3.5 | Matches. |
| R4 majority size: count of strictly larger marks to the right | §6 | R4.1–4.2 | Matches, including the [12,12,13,13,15] → 1 example. |
| R5 majority sum: marks to the left, excluding the majority mark | §6 | R5.1–5.2 | Matches all four source examples. |
| R6 look-ahead, R7 look-behind, column by column | §6 | R6, R7 | Matches. G-12 (the source quotes example sums on the rank scale: "3", "4", "4,5") is correctly treated as notation only; it doesn't change any ordering. |
| R8.1 identical-marks proof, else scoring error | §6.1 | R8.1 | Matches. Failing closed instead of silently recalculating is correct. |
| R8 head-to-head: loss value = L + 0.5T; award only the best; re-visitation; final tie shares placements announced at the higher one; carry-forward = average | §6.2 | R8.2–R8.6 | Matches. G-13 (equal best loss value with unequal records, and the remainder after a shared best) is correctly fail-closed. |
| R9 points: finals placement / finalists + rounds removed; equal weights; ascension weights ×3 / ×4 | §8.1 | R9.1–R9.3 | Matches all source examples (15, 20, 21). |
| R10 placements head-to-head over commonly competed dances; re-visitation recomputes the dance set | §8.2 | R10.1–R10.3 | Matches. G-15 (announced vs carry-forward placement) is correctly open. |
| R11 judges' marks head-to-head; re-visitation returns to R10; final tie | §8.2 | R11.1–R11.4 | Matches. |
| Part-number errors | §8.2 G-16 | R10.3 and R11.3 cite "Rule #10, part #4", which doesn't exist | Correct, but the draft also lists R10.2's "part #3" as an error. That reference is valid (part 3 exists). See C-5. |
| DSA availability; awards report; ProAm awards show threshold title only, without + or ★ | §9 | REP | Matches. G-17 (DSA content) and G-18 (how the threshold title is derived) are correctly fail-closed. |
| Feedback | §10 | none | Correct. The source defines no feedback, so it is refused under S4-4. (The rule books use judges' mark percentages for graduation. That is an eligibility rule, not feedback, and is correctly out of scope.) |
| Overall dance requirements | §8.1 G-14 | RB-C / RB-P def. 14 and III.A: "at least" Two-Step, Waltz, 1 Swing and 2 of 4 alternates ("five of eight") | Matches. The ambiguity is under-stated: see C-4. |

## Fixture recomputation

| Fixture | Draft result | My result | Match |
|---|---|---|---|
| F-U-01 scale order | GG★ 11 best … HM 26 worst | same (UTF-8 extraction confirms ★) | ✅ |
| F-U-02 majority position | 5→3rd, 7→4th, 6→4th, 8→5th … | same | ✅ |
| F-U-03 quantity table | sizes 2/1/0/2; sums 23/24/26/25; look-ahead and look-behind as listed | same | ✅ |
| F-U-04 ProAm 5 judges | B, A, C, D (R6 col 2: 20 < 22) | same | ✅, but uses ★ and + values (see C-1) |
| F-U-05 look-behind | X 1st (11 < 12) | same | ✅, but uses GG★/GH★ (see C-1) |
| F-U-06 Group-and-Rank | A, B, C (R4: 0 vs 1) | same | ✅ |
| F-U-07 head-to-head | R 1st (loss value 2.5); P/Q final tie, both "2nd", carry-forward 2.5 | P 2-3-1 = 3.5, Q 2-2-2 = 3, R 3-2-1 = 2.5; revisit P/Q 1-1-1 each → same | ✅, but 17 = G★ (see C-1) |
| F-U-08 circular | 3-way final tie, all "1st", carry-forward 2 | all 3-3-0 → same | ✅ (17 = G★) |
| F-U-09 two-way final tie | both "1st", carry-forward 1.5, next is "3rd" | same | ✅ (17 = G★) |
| F-U-10 even panel J=6 | majority 14, size 2, sum 36 | same | ✅ |
| F-U-11 callbacks | A, B, C = 25.0; D 9.2; E 4.6; target 2 or 3 → A, B, C promoted | same | ✅ |
| F-U-12 championship + R10 | X 1st (2-1-0), Y, Z, W | aggregates 6/6/7/11, then same | ✅ |
| F-U-13 weighted aggregate | 21 | 21 | ✅ |
| F-U-14 rounds removed | 7 / 8 / 9 | same | ✅ |
| F-U-15 fail-closed cases (a)–(g) | each refused | consistent with the spec; (a) depends on C-1 | ✅ / C-1 |

## Required corrections

- **C-1 (blocking; conflicts with the owner's directive).**
  - The problem:
    - §4.4 resolves G-9 by allowing only marks that appear both in the rule-book list and in the R3.2 scale, which rejects B+, GG+ and every ★ mark.
    - That removes 7 of the 16 values the owner told us to preserve: "preserve the March 2026 expanded 16-mark ProAm/ProPro medal scale".
    - It is also inconsistent with the draft's own fixtures. F-U-04/05/07/08/09 use G★ (17), G+ (18), S★ (20), B★ (23), GG★ (11) and GH★ (14), which the intersection rule would reject.
  - The likely explanation: the 1-26-2026 rule books predate the expanded Scoring Format v16.9b scale.
  - Fix: record that the R3.2 16-value scale governs ProAm/ProPro marks, superseding the rule-book definition lists. This needs owner confirmation (OQ-1), and the "March 2026" edition question stays open.
- **C-2 (missing conflict).**
  - R3.3 gives the 6-medal Group-and-Rank scale to "Spotlights and AllStars".
  - The ProPro/ProAm rule book lists AllStars and Spotlight as ProAm divisions, and Spotlight as a ProPro division too.
  - R3.2 gives ProAm/ProPro the 16-value scale with ties.
  - So the source conflicts on which scale applies to ProAm AllStars and ProAm/ProPro Spotlight. Add it as G-20, fail-closed until the owner or UCWDC resolves it (OQ-2).
- **C-3 (missing fail-closed case).** Add an explicit item, G-21: a missing Finals mark (a judge left a contestant unmarked) or an absent judge mid-round is NOT SPECIFIED IN PROVIDED SOURCE, so it fails closed. S4-4 explicitly asks every method to define missing marks.
- **C-4 (sharpen G-14).**
  - The rule books say Overall competitors must dance "at least" the five required dances, but they may dance more.
  - Neither source says which of a contestant's extra dances count in the Rule #9 aggregate. Examples: dancing both swings, or 3–4 alternates.
  - State this explicitly. The qualifying-dance set must be an input, and the engine refuses rather than picking the best dances.
- **C-5 (wording).** In G-16, remove R10.2's "part #3", which is valid. The errors are only in R10.3 and R11.3 ("part #4").

## Owner decisions surfaced

- **OQ-1.** Confirm that the Scoring Format's 16-value ProAm/ProPro scale (HM 26 … GG★ 11) governs, even though the 1-26-2026 rule books list only 9 marks. Also confirm whether a later "March 2026" document exists that should be pinned.
- **OQ-2.** Which scale applies to ProAm AllStars and ProAm/ProPro Spotlight: the 16-value scale (R3.2) or the 6-medal Group-and-Rank scale (R3.3)?
- **OQ-3.** The draft's `J ≥ 3` guard. The source's own formula gives a majority position for J = 1 (the middle mark) and J = 2 (half + 1 = the 2nd mark). The guard makes the official method stricter than the source. It fails closed, so it doesn't approximate anything, but whether to keep it is an owner choice.
- The remaining NOT SPECIFIED items (G-2, G-5, G-7, G-13, G-15, G-17, G-18, G-19) stay fail-closed. Each one blocks only the feature it covers:
  - G-5: Semi-Finals with alternates;
  - G-7: Worlds-style promotion;
  - G-15: some championship tie-breaks;
  - G-18: the awards threshold title.

  The engine can be built for the specified core: single-dance finals, regional callbacks, the 1–5-dance aggregate given an input dance set, and Rules 8, 10 and 11 where unambiguous.

## Status

Until C-1 to C-5 are applied and OQ-1/OQ-2 are answered, the spec stays DRAFT and UCWDC Majority Rules stays unavailable (S4-5). No engine code is authorized.

---

## Addendum (added by W6, 2026-10-25; the report above is unchanged)

- **Independence caveat:** the verification above was done by the Competition OS coordinator, who had read Rules 3-6 and briefed the drafter before the draft was written (see the caveat at the top). It is therefore not a fully independent review.
- The owner has asked for an **independent golden-fixture review to continue**. The spec stays DRAFT until that review and the owner's approval.
- Corrections C-1 to C-5 are applied in the spec. C-1 was applied after the owner approved OQ-1 on 2026-10-25 (the 16-value scale governs; the rule-book lists no longer restrict marks). OQ-2 (AllStars/Spotlight use the 6-medal method) and OQ-3 (revised: no `J >= 3` guard; separate UNVERIFIED panel-eligibility check) are recorded in `engine-spec-ucwdc-majority-rules.md` section 15.
- Fixtures F-U-04, F-U-05, F-U-07, F-U-08 and F-U-09 use 16-scale values and are consistent with the OQ-1 decision. F-U-15 cases were updated to the new rules; an independent reviewer should recompute them.
