# OD-24 corrections to the retrospective audit wording

The audit inventory and the owner-decision list sit on unmerged audit branches
(`claude/comp-audit-2-e6859a`, `claude/comp-audit-owner-decisions`) and cannot be changed from this docs PR. Apply
these replacements where those files are next edited. Evidence: the pinned WSDC Registry Event Rules v2026.1C
(`140caae7...`), see [OD-24-scoring-source-candidates.md](OD-24-scoring-source-candidates.md) section 4.

**The inaccuracy.** Several audit lines say the WSDC "algorithm text" or "callback scoring" is missing. The pinned PDF
defines the **preliminary callback system** (Section 5, pp.22-23; 3.4.9.c, p.21). Only the **Relative Placement**
final-scoring algorithm is off-document (3.4.9.d, p.21).

| Where | Current claim | Replace with |
|---|---|---|
| OWNER-DECISIONS, OD-24 Issue | "the WSDC Relative Placement text are not in the supplied sources" | Correct as written for Relative Placement only; add: "the WSDC preliminary callback system (values, sum, Chief Judge tie-break) **is** in the pinned rules." |
| OWNER-DECISIONS, X10 (inventory table) | "Missing source text: NDCA Skating System algorithm, WSDC Relative Placement definition (website), ..." | Keep, and add: "WSDC callback scoring is defined by Section 5; the gaps there are listed in OD-24-scoring-source-candidates.md section 4." |
| Inventory S-05 | "Obtain the WSDC website rule text and pin it" | "Public WSDC Relative Placement documents were retrieved 2026-11-24 and are UNREVIEWED CANDIDATES (OD-24 doc); pinning needs independent review of applicability, completeness and authority." |
| Inventory S-10 (WSDC) | "WSDC: NOT SPECIFIED ... for finals (website)" | Unchanged for finals; callbacks: the Chief Judge raw-score tie-break is defined (Section 5), higher-wins direction is implied only. |
| Inventory comparison table, "Algorithm defined in the provided text?" (WSDC column) | already says callback values and tie-break are defined | Correct. Make the same distinction in F3, S-17, S-18W and S-20W: those rows describe a defined WSDC callback model, not a missing one. |
| Inventory S-32W | "3.4.9.c is on p.20, not p.21" row says verified compliant; fix is a page cite | Done in `scoringReference.ts` (see the separate commit of this PR). 3.4.9.d is also on p.21, same change. |
| Inventory S-32U2 | reword REF to "ties are retired with the cut (Rule #2.4); precise handling is K1-U Q1" | Done in the wording-only commit, phrased without asserting the tie outcome: Rule #2.4 says "plus ties" are retired with the designated number; how the dividing line then treats those ties is not specified. |
| Any "Obtaining body text ... is an outreach question" | the WSDC text is public | Retrieval of public pages is not outreach; outreach to bodies and directors stays prohibited. |
