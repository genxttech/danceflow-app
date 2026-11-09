# K1-U independent re-verification — spec @ a4f26f1f

Reviewer: the same independent session. Read-only: the only git operation was a fetch; nothing in the repo was changed. Date: 2026-10-25.
Read at `a4f26f1f7034530657069bf78c1fa6ec975a612c` (= origin/competition-k1-engine-specs head):
- `docs/competition/engine-spec-ucwdc-majority-rules.md` in full;
- the diff since aaffc9f5;
- `ucwdc-clarification-questions.md` (new Q5);
- `k1u-reverification-owner-disposition-aaffc9f5.md`.

The repo copy of `k1u-reverification-aaffc9f5.md` is identical to my report.

## Verdict: NOT PASS — R-1 to R-6 and the three nits are all resolved, but the revision introduces 2 new medium defects

The two medium defects follow directly from applying I-2 and the four-category split. There are also 2 low defects and 4 nits.

## 1. Previous defects

| Defect | Status @ a4f26f1f |
|---|---|
| R-1 readings under supported cases | RESOLVED. I-1, I-2 and I-3 are in 12B as owner-approved interpretations, marked "not verified UCWDC rules". §16.1 states which supported cases rest on them. I-2 capacity is a Coordinator INPUT (§3.4), with no invented number. I-3: any duplicate, gap or tie fails closed |
| R-2 F-U-14 | RESOLVED. Expects 7 only; 8 and 9 are explicit refusals |
| R-3 12A Semi-Finals tie | RESOLVED. 12A confirms only Prelims promotion plus ties, and carves out the Semi-Finals retirement count and its cut tie |
| R-4 Rule #11 status | RESOLVED. §16.1 supports Rule #11 (with re-visitation to Rule #10) only under the D-6 conditions; everything else is refused (§16.1, 12C) |
| R-5 alternate count | RESOLVED per the owner's ruling. A ballot with fewer alternates than the Coordinator set is refused as incomplete, pending the new Q5 (12C, 12D, §16.2, questions doc). No UCWDC rule invented |
| R-6 F-U-15(d) | RESOLVED. My J=7 inputs are used. W6's independent recomputation is correct: sorted [11,12,12,13,14,14,14], maj 13, size 3, sum 35, behind [11,12,12], ahead [14,14,14]; per-judge columns correct; A 6-5-3 (6.5), B 5-7-2 (8), C 5-4-5 (6.5), 14 games each → refusal |
| Nit: F-U-12 parenthetical | RESOLVED |
| Nit: §16.2 Semi-Finals wording | RESOLVED |
| Nit: §12 cross-reference | RESOLVED (§3.3) |

## 2. Fixture recomputation

- **Spec fixtures:**
  - F-U-01..10 and F-U-13 are unchanged since a750e74f; I verified them there.
  - F-U-12 changed only in its parenthetical; result still X, Y, Z, W.
  - F-U-14 = 7.
  - F-U-15(d) is recomputed above.
  - F-U-16 = IR-22, unchanged.
  - **F-U-11 now has a gap; see N-1.**
- **My IR-01..32 under the revised rules:**
  - IR-02 is now **refused** if the Coordinator set 2 alternates, because J3 marked only 1 (R-5). That is correct under the owner's ruling.
  - IR-01, 02 and 03 now also need a Finals capacity input (I-2): ≥3, ≥4 and ≥3 respectively.
  - IR-27 (Rule #11) is now explicitly supported under the D-6 conditions and agrees: R2, R3, R1.
  - All other classifications are as at aaffc9f5.

## 3. Remaining defects

**N-1 (MED): F-U-11 is missing the Finals capacity input that I-2 now requires.** I-2 promotes all contestants tied at the cutoff only if promoted plus ties ≤ the Coordinator-supplied Finals capacity, and §3.4 says inputs fail closed if absent. F-U-11 gives no capacity, so its expected outputs can't be determined. In particular, "designated number 2 → A, B, C all promoted" holds only if capacity ≥ 3.
**Fix:** state the capacity, and add the refusal sub-case:
- designated 2, capacity 2 → A, B, C tied at the cut → refusal (promoted plus ties 3 > 2);
- capacity absent → refusal.

**N-2 (MED): §16's definition of "Supported" contradicts 12B.** §16 says: "'Supported' below means fully specified in the pinned source and independently verified." The Prelims callbacks rest on I-1 and I-2, and Group-and-Rank rests on I-3. The spec itself classes these as owner-approved interpretations of silent or ambiguous text, "not source statements and not verified UCWDC rules". The owner's disposition requires keeping that separation.
**Fix:** reword along the lines of "specified by the pinned source or, where marked, by owner-approved interpretations I-1 to I-3; arithmetic independently recomputed".

**N-3 (LOW): the §3.3 validity list (1)–(4) omits the R-5 rule.** "Fewer alternates than the Coordinator set → refused as incomplete" appears only in 12C and §16.2. §3.3 is the normative validity list, so it should include it as item (5), citing Q5.

**N-4 (LOW): the gating questions are stated three different ways.**
- The status line says the method is unavailable "pending UCWDC Q1–Q5".
- §16 says unavailable "until panel eligibility is verified (UCWDC Q4)".
- §16.3 says "The method stays unavailable pending Q1–Q4".

**Fix:** use one consistent statement.

**Nits (wording only):**
- §3.2 keeps the old label "READING (G-3): 'ties' means equal callback totals" next to the new I-2 text. Fold it into I-2 so the item appears in one category only.
- §4.3 D-7 bullet still says "the G-8 conversion" → "the I-3 conversion".
- §3.3 scope note says "The Semi-Finals rules in this section stay documented as source-confirmed rules (12A)" without the 12A carve-out. The retirement plus-ties and G-6 are not source-confirmed (12C/12D).
- 12C's "Owner decision" column cites "independent review D-3(a)" (G-15(a)), "coordinator correction C-4" (G-14) and "independent review D-7". These are not owner decisions. Either cite the owner's 2026-10-25 acceptance, or move G-15(a) (a proof from the source text) to 12A.

## 4. Other checks

- **Scope (Semi-Finals / multi-Prelims):** consistent across §3.1, §3.3, §8.1, 12C, 12D, §16 and F-U-14/F-U-15(e).
- **Source pin:** v16.9b and all five sha256 values are present in full, unchanged, and match my computed hashes. The newsletter is still unpinned, and the spec says so.
- **No compliance, panel-eligibility or availability claims:**
  - every panel size is UNVERIFIED; J=1/2 are refused;
  - the method is UNAVAILABLE;
  - "not enabled" appears in §16.1;
  - the questions doc is marked DRAFT, not sent.

  The only overstatement is the definition of "Supported" (N-2).
