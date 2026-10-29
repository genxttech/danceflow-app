# K1-U independent re-verification — spec @ 7b48abdc

Reviewer: the same independent session. Read-only: a fetch was the only git operation. Date: 2026-10-25.

Read at `7b48abdca4cc758cbe66b8f1d0c500ff6035dd5b` (= origin/competition-k1-engine-specs head):
- `docs/competition/engine-spec-ucwdc-majority-rules.md` in full;
- the diff since a4f26f1f (commits 5f8f5154 and 7b48abdc).

The repo copy of `k1u-reverification-a4f26f1f.md` is identical to my report.

## Verdict: PASS

The spec is internally consistent. Every finding from all three review rounds is resolved or correctly classified, and all fixtures recompute. One wording nit remains and does not block.

What PASS covers, and what it does not:
- It is an independent verification of the spec text and its golden fixtures.
- It is **not** verification of UCWDC compliance or panel eligibility. Both stay UNVERIFIED.
- It does not make the method available; the method stays UNAVAILABLE pending Q1–Q5.
- It does not authorize a merge, implementation, or scoring release.

## Defects from a4f26f1f

| Defect | Status |
|---|---|
| N-1 F-U-11 Finals capacity | RESOLVED, recomputed. Totals A=B=C=25.0, D 9.2, E 4.6, F 0. Capacity ≥3: designated 3 → {A,B,C} (3 ≤ 3); designated 2 + tie → {A,B,C} (3 ≤ 3). Capacity 2: 3 promoted > 2 → refusal in both cases. Capacity absent → refusal (§3.4). All as the spec states |
| N-2 "Supported" definition | RESOLVED. §16 now reads "specified by the pinned source or, where marked, by owner-approved interpretations I-1–I-3; arithmetic independently recomputed … not enabled … no claim of compliance or panel eligibility" |
| N-3 §3.3 validity list | RESOLVED. Item (5) is fewer alternates than set → incomplete, refused pending Q5 |
| N-4 gating statement | RESOLVED. Status line, §16 and §16.3 now read identically: "UNAVAILABLE pending UCWDC Q1–Q5; Q4 (panel eligibility) also gates actual scoring". §16.2's "Everything, for actual scoring, until panel eligibility is verified (Q4)" is consistent with it |
| Nit: READING (G-3) next to I-2 | RESOLVED (dropped) |
| Nit: "G-8 conversion" | RESOLVED (now I-3) |
| Nit: §3.3 carve-out | RESOLVED. W6's choice to point it to 12D Q1 is correct, because the open questions now live in 12D |
| Nit: 12C citations | RESOLVED. G-14 and D-7 now cite the owner's 2026-10-25 acceptance and disposition. G-15(a) moved to 12A as a proof from R10.1/R10.2/R8.4–R8.6, and its 12C row was removed, so it appears once |

## Full re-check

- **Fixtures:**
  - F-U-01..10 and 12–16 are unchanged since a4f26f1f, where I verified them; F-U-15(d) and F-U-16 were checked in the last two rounds.
  - F-U-11 is recomputed above.
  - My IR-01..32 keep the classifications reported at a4f26f1f:
    - IR-01 and IR-03 compute and agree, given a capacity of at least 3; IR-02 is refused under R-5;
    - Semi-Finals and multi-Prelims cases are refused;
    - IR-27 (Rule #11) is supported and agrees.
- **Classification:** each item appears in exactly one of 12A, 12B, 12C or 12D. No leftover READING labels attach to supported cases; G-6 sits under the unsupported Semi-Finals structures.
- **Scope:** the Prelims → Finals-only scope is consistent across §3.1, §3.3, §8.1, 12C, 12D, §16 and F-U-14/F-U-15(e).
- **Source pin:** v16.9b and all five sha256 values are present in full and unchanged. The March 2026 newsletter is still unpinned, and the spec says so.
- **Claims:** there are no compliance, panel-eligibility or availability claims. J=1 and J=2 are refused, every panel size is UNVERIFIED, and the questions doc is a DRAFT that has not been sent.

## Non-blocking nit

§3.3's scope note names one carve-out, "the tie at the retirement cut". 12A carves out both the Semi-Finals retirement count and its cut tie, and the points direction (G-6) sits in 12C. The classification table is correct and governs. Optionally, align the §3.3 wording.
