# Engine spec — UCWDC "Majority Rules" scoring format (K1-U)

Status: **DRAFT. Fixtures independently recomputed for the supported cases (§16.1); this is not a claim of compliance, panel eligibility or availability; method UNAVAILABLE for actual scoring pending UCWDC Q1–Q5.** Evidence: coordinator verification (`k1u-verification-report.md`) and independent fixture review (`k1u-independent-fixture-review.md`, 32 fixtures, arithmetic all agreeing). Owner decisions OQ-1, OQ-2, OQ-3 (2026-10-25) and D-1, D-2, D-4, G-13, panel (2026-10-25) are recorded. Docs only (no code, no SQL, no database). K1-U deliverable under Stage 4 decision S4-5 (`scoring-architecture-decisions.md`): UCWDC Majority Rules stays `COMP_ENGINE_NOT_AVAILABLE` until the spec is completely specified, verified and approved.

Proposed registry identity (not yet registered): method `ucwdc_majority_rules`, version `v16.9b`.

## 0. Source pin and ground rules

| Item | Value |
|---|---|
| Authoritative source | `2026-Scoring-Format-v16.9b-1.pdf`, "UCWDC Scoring Format: Heating, Scoring, & Reporting Rules (v16.9b, 2026: to be used for the 2026-2028 Rules)", 8 pages |
| sha256 | `44290a06d14c308087039bce8d57258629ae103734cce08eb21f41bdb667b02f` (verified on 2026-10-24; the copy named `… (1).pdf` in the same folder is byte-identical) |
| Pinned edition | **v16.9b** |
| March 2026 evidence | The owner reviewed a UCWDC newsletter dated **11 March 2026** as supporting evidence for the expanded 16-mark scale (OQ-1). **File not yet pinned; sha256 pending** (the owner is asked to supply the file in the PR). v16.9b stays the pinned edition. No later official revision of the Scoring Format has been found; before any claim of current compliance, check for later official revisions (§4.4) |
| Division-specific sources (UCWDC Rules books dated 1-26-2026; only their judges' mark definitions and Overall-championship dance lists were used) | Couples `2026-UCWDC-Rules_Couples_v1-26-2026-1.pdf` sha256 `8a45ee58d189e65dbda142a261dd311a3404138bcf75b7a533be7b0ef8974904`; Line Dance `2026-UCWDC-Rules_Line-Dance_V_1-26-2026-1.pdf` `98e9001113108eaf9b72e4c8c530a2a3fe7d53edc4dcb12118f67dc068b97fb7`; ProPro/ProAm `2026-UCWDC-Rules_ProPro-ProAm_v1-26-2026.pdf` `d6257b65915151ab8aa50a952b60166cf5abfe6ef70cf8be292f9044e704db84`; Teams `2026-UCWDC-Rules_Teams_V_1-26-2026-1.pdf` `7e71fdce55b0eade037c9c6df2a041a3f8a8390b4fc6274a0552e09d25cdb41a` (all four verified 2026-10-25). With the Scoring Format hash above these are the five pinned hashes |
| Extraction | Text was extracted with `pdftotext -layout`. **The default encoding drops the star symbol (★)** and shows e.g. "B = 25, B+ = 24, B = 23". Re-extracting with `-enc UTF-8` restores it ("B★ = 23"). The mark order was also checked against the numeric values (§4.2), which is independent of the symbol |

Rules for this spec:
- Every rule cites its source section. Citation keys: **H1–H7** = Heating Rules 1–7; **R1.n … R11.n** = "Rule #1 … Rule #11", numbered part n; **REP** = "General Information and Requisite Reporting"; **RB-C / RB-L / RB-P / RB-T** = the Couples, Line Dance, ProPro/ProAm and Teams rule books.
- Where the source is silent the text says **NOT SPECIFIED IN PROVIDED SOURCE**. The engine fails closed in that case (X-2 style: no result, a trace entry, the manager sees the reason). No gap is filled from general knowledge.
- Where this spec states a *reading* of ambiguous source text it is labelled **READING** and listed in §12 for the verifier.
- This is a method of the UCWDC, not a DanceFlow-sanctioned or UCWDC-authorized scoring system. DanceFlow makes no such claim (S4-1/S4-2: disclosed sanctioning, no implied sanction). The source requires a UCWDC "authorized" scoring system and certified/verified personnel (preamble); that authorization is organizational and outside this spec.
- Lower numbers are better in Rules #3–#11 ("the lowest value number is considered the best score", R8.2). Callback points (R1, R2) work the other way: more points is more valued.

## 1. What the format covers

| Part | Source | In this spec |
|---|---|---|
| Heating (constructing heats) | H1–H7 | §2 (scheduling, not scoring) |
| Preliminaries and Semi-Finals callbacks | R1, R2 | §3 |
| Finals marks | R3.1–R3.3 | §4 |
| Majority mark and placement | R3.4–R3.5 | §5 |
| Single-dance tie-breakers | R4–R8 | §6 |
| Multi-dance / Overall championship | R9–R11 | §8 |
| Reporting | REP | §9 |
| Feedback | none | §10 |

Single-dance promotion at regional events is independent per dance; at the Country Dance World Championships all dances are promoted together under the prescribed Overall multi-dance format (R1.5, R2.5). The rule for promoting "all dances together" is **NOT SPECIFIED IN PROVIDED SOURCE** (see §3.5).

## 2. Heating (H1–H7)

This part constructs heats; it is not a result calculation and is not engine input. It is recorded so the heat builder (10D) can be checked against it. DanceFlow's 10D heats (default capacity 8, no randomization rule) are **not** claimed to conform.

| Rule | Content |
|---|---|
| H1 | If space, time and circumstance allow, a heat holds only contestants of one division. Each division's contestants must be **randomized by the scoring system** for fairness of floor access. Contestants staying on the floor between heats retire to the back and re-enter when the Emcee calls them from the randomized list |
| H2 | If a division needs more than one heat, the heat sizes differ by **no more than 1**. A division may be co-mingled with others if each division's co-mingled heat sizes still differ by at most 1 ("singular" logic when a division is kept together). Example: 9 ProAm contestants, one Pro with 3 students: a primary heat of 7 plus 2 outlier entries heated before or after |
| H3 | Multiple heats of one division run **contiguously** |
| H4 | Where heats of one division differ in size, the smaller precedes the larger (to let scratches be rebalanced by moving contestants up) |
| H5 | Heats may be co-mingled across divisions; balancing a division evenly across heats ("modular" logic) is recommended. Example: 9 contestants, one Pro with 3 students: 3 heats of 3, filled with other divisions |
| H6 | Where one Pro has several students in a division, unequal modules are allowed (example: 2, 4, 3 from the division with 5, 3, 4 from others). For better balance the largest number goes in the **middle** heat (15 contestants: 3, 7, 5) |
| H7 | When a division is heated in several heats, the difference in total heat sizes (including co-mingled contestants) should be at most 1, and each division's heats stay contiguous |

**NOT SPECIFIED IN PROVIDED SOURCE:** the random source or seed for the H1 randomization. K0 forbids randomness inside engines (S2); the randomized order is therefore an input produced by the heat builder and recorded with its seed, not engine behavior. Defining that seed is outside this spec.

## 3. Callback rounds (R1, R2)

### 3.1 Round structure (R1.1–R1.4, R2.1–R2.4)

- A **Preliminaries** round *promotes* contestants to the Semi-Finals, or directly to the Finals if only one Prelims round is used (R1 heading, R1.1). Not-promoted contestants may dance another Prelims round (R1.1, R1.3).
- A Prelims is deemed appropriate by the Contest Coordinator when there are more contestants than two heats of Finals can handle (Couples), or more than can be fairly judged beyond two lines (Line Dance), so that judges do not assess across three heats in a Finals (R1.1, R2.1).
- A **Semi-Finals** round (used only if two or more Prelims rounds were danced, R2 heading, R2.2) *retires* contestants, possibly across a second Semi-Finals (R2.1).
- The Contest Coordinator sets the numbers: the number of Yes/No marks, the number of alternates, the dividing line, the target number for the next round (R1.2, R1.3, R2.2, R2.3). For Worlds the Contest Director may adjust the Yes/No and Alt counts (R1.2, R2.2). A Finals field of no more than nine for one heat, up to twelve for two heats of six, is given as an example (R2.3).
- Each dance in which a contestant dances at least one Prelims or Semi-Finals round counts toward their Championship eligibility for the division (R1.4, R2.4).
- **Supported flow (owner D-4):** Prelims → Finals only. In it, "rounds removed" (R9.1) applies only to a Prelims retiree, whose multi-dance value is the number of finalists for that dance plus 1 (one round removed). Structures with two or more Prelims rounds, or with a Semi-Finals, are unavailable (Q2, Q1).

### 3.2 Prelims callback ballot (R1.2)

- Each judge marks **"Yes"** for a set number of contestants they most wish to promote, and may additionally mark up to **5 alternates** ranked Alt #1 … Alt #5 (counts are set by the Coordinator and may be adjusted).
- Point values: **Yes = 10.0; Alt#1 = 5.0; Alt#2 = 4.6; Alt#3 = 4.3; Alt#4 = 4.1; Alt#5 = 4.0.**
- "Totaling the points across this scale for each dance will be used to determine who moves on." **OWNER-APPROVED INTERPRETATION I-1 (formerly reading G-1; not an independently verified UCWDC rule, owner 2026-10-25, supported scope only):** a contestant's callback total for a dance is the sum, over all judges, of the values of the marks that judge gave them. The source does not say "sum over judges" in words.
- **G-2 RESOLVED by the owner (D-1, 2026-10-25):** "APPROVE zero callback points for an entry not selected by a judge on a valid, completed callback ballot. This does not apply to missing, incomplete or invalid ballots, which remain fail-closed." So an entry a judge did not select scores 0 from that judge on a valid, completed ballot; a missing, incomplete or invalid ballot (see the validity rules below) fails closed.
- Promotion: the "most valued" contestants, **based on a designated number determined by the Contest Coordinator plus ties, if any occur**, are promoted (R1.4). So contestants tied at the dividing line are all promoted. **READING (G-3):** "ties" means equal callback totals at the dividing line. **OWNER-APPROVED INTERPRETATION I-2 (formerly reading G-3; not a verified UCWDC rule):** all contestants tied at the promotion cutoff advance when capacity and competition structure permit; the engine takes a **Finals capacity as a Coordinator INPUT** and fails closed if the promoted contestants plus ties exceed it. No capacity number is invented; R2.3's "nine for one heat, up to twelve for two heats of six" is an example only.
- Whether one judge may give the same contestant both a Yes and an Alt, or the same Alt rank twice, is **NOT SPECIFIED IN PROVIDED SOURCE** (G-4). The engine rejects such a ballot.

### 3.3 Semi-Finals ballot (R2.2–R2.4)

- Each judge marks **"No"** for a set number of contestants they most wish to *retire*, plus up to 5 ranked alternates. **No = 10.0; Alt#1–#5 = 5.0, 4.6, 4.3, 4.1, 4.0** (same alternate values).
- The totals decide who moves on; the **least valued contestants (plus ties) are retired** until the Finals target is reached (R2.4). After the Semi-Finals the Coordinator fills the Finals field "using the last callback values" (R2.3).
- **Scope note (D-2):** Semi-Finals exist only when two or more Prelims rounds were danced (R2 heading, R2.2). The supported flow is Prelims → Finals only (owner D-4), so **no Semi-Finals calculation runs at all**. The Semi-Finals rules in this section stay documented as source-confirmed rules (12A); the tie at the retirement cut is an unanswered UCWDC question (Q1, 12D), and the meaning of alternates on a No ballot (G-5) is unresolved (12D). Any attempt to run a Semi-Finals round fails closed.
- Because points accrue to retirements, a **higher** Semi-Finals total means *more* judges want the contestant retired. **Unsupported-structure note (G-6, not used in the supported flow):** the retired set is the highest totals up to the designated number plus ties. The source says "the least valued … are retired" without stating the direction of the points; this is the only reading consistent with "No = 10.0".
- **Callback ballot validity (review D-5); each failure fails closed:** (1) the number of Yes (Prelims) or No (Semi-Finals) marks differs from the Coordinator's set number; (2) alternate ranks are not contiguous from Alt #1 (for example Alt #2 without Alt #1); (3) more than 5 alternates; (4) a missing ballot from an assigned judge.

### 3.4 Targets, dividing line

The dividing line and the target counts are Contest Coordinator inputs (R1.2, R1.3, R2.2, R2.3). The source gives no default and no formula. The engine takes them as inputs and fails closed if absent. The **Finals capacity** (interpretation I-2) is likewise a Coordinator input; the engine never supplies one.

### 3.5 Promotion across dances

Regional events promote independently per dance (R1.5, R2.5). At Worlds promotion is based on "the prescribed Overall multi-dance format for each division, where all dances are promoted together" (R1.5, R2.5). The prescribed format is **NOT SPECIFIED IN PROVIDED SOURCE** (G-7); only regional single-dance promotion is specified here.

## 4. Finals marks (R3.1–R3.3)

### 4.1 Medal thresholds (R3.1)

In the Finals each judge circles a **Medals** mark for each contestant, in ascending order of assessment: **HM** (Honorable Mention), **B** (Bronze), **S** (Silver), **G** (Gold), **GH** (Gold with Honors), **GG** (Gold Graduate). These are "thresholds" from the Judge Certification Methodology.

- **ProAm / ProPro:** after circling a threshold mark it is not necessary to rank; **ties are acceptable**. A judge may add a **plus (+)** or a **star (★)** to a medal (not to HM): plus is higher than the base, star higher than plus (R3.1).
- **Couples, Line Dance (and Teams, Spotlights, AllStars per R3.3):** if the same Medals mark is given to more than one contestant it must be **ranked within that medal** (1 = best). This is the "**Group and Rank**" process. Judges may not tie contestants (R3.1, R3.3).

### 4.2 ProAm / ProPro value scale (R3.2)

Sixteen values, lower is better. In ascending order of assessment:

| Medal | base | + | ★ |
|---|---|---|---|
| HM | 26 | — | — |
| B | 25 | 24 | 23 |
| S | 22 | 21 | 20 |
| G | 19 | 18 | 17 |
| GH | 16 | 15 | 14 |
| GG | 13 | 12 | 11 |

Check against the numbers: the values 26 down to 11 are 16 consecutive integers, one per distinct mark; every threshold except HM has three tiers (regular, +, ★), and the plain/+/★ order inside each threshold runs high-to-low in value (e.g. G = 19, G+ = 18, G★ = 17), matching "plus is higher than the base, star higher than plus". The extraction without UTF-8 lists the third value of each tier with the star missing; the numeric positions (23, 20, 17, 14, 11) identify those as the ★ marks.

Ties among contestants are allowed (R3.2).

### 4.3 Couples / Line / Teams / Spotlights / AllStars (R3.3)

- Medal values: **HM = 6, B = 5, S = 4, G = 3, GH = 2, GG = 1.**
- "Medals" marks are converted to **ranked placements**: a higher medal always defeats a lower medal; for the same medal, the judge's rank within it decides (lower number defeats higher: G1 beats G2; G5 beats G10); across standards, **G8 defeats S1**. Judges cannot tie contestants.
- **OWNER-APPROVED INTERPRETATION I-3 (formerly reading G-8; not a verified UCWDC rule; owner 2026-10-25, only where the conversion is unambiguous):** for the majority calculation (§5) each judge's marks become, per contestant, that contestant's position (1…N) in the judge's overall order (all contestants ordered by medal value ascending, then by rank within the medal). R3.4's own example uses ranks (`[3,1,2,5,4]`) for these divisions, which supports the reading, but the source does not spell out that the conversion yields a dense 1…N rank.
- **Group-and-Rank ballot validity (review D-7):** the engine fails closed on a duplicate rank within one medal, and on non-contiguous ranks within a medal (for example G1 then G3 with no G2, or ranks not starting at 1). It does not silently densify them; the G-8 conversion applies only to a valid ballot. Under I-3 any duplicate rank, gap or tie in a judge's conversion fails closed.
- The plus and star tiers and ties exist only for ProAm/ProPro divisions that use the 16-mark scale (R3.1, R3.2, R3.3).
- **ProAm AllStars and ProAm/ProPro Spotlight use this 6-medal Group-and-Rank method with no ties (owner OQ-2, approved 2026-10-25; G-20 RESOLVED)**, consistent with R3.3 naming Spotlights and AllStars. The standard ProAm/ProPro 16-mark ballot is **not** applied automatically to those categories.
- **Ballot-format mapping:** ProAm and ProPro divisions other than AllStars and Spotlight → 16-mark scale (§4.2, ties allowed); ProAm AllStars, ProAm/ProPro Spotlight, Couples, Line Dance, Teams → 6-medal Group-and-Rank (this section, no ties).

### 4.4 Division-specific mark lists in the rule books (G-9 RESOLVED by the owner, OQ-1)

Owner decision (OQ-1, approved 2026-10-25): "APPROVE the expanded 16-mark scale for applicable ProAm/ProPro divisions: HM, B, B+, B*, S, S+, S*, G, G+, G*, GH, GH+, GH*, GG, GG+, GG*. Use the official numeric assignments HM=26 through GG*=11. … Do not revert to an older nine-mark listing merely because another rules document is inconsistent. Pin v16.9b and record the March 11 newsletter as supporting evidence. Check for subsequent official revisions before claiming current compliance."

| Source | Judges' marks listed |
|---|---|
| Scoring Format R3.2 | HM, B, B+, B★, S, S+, S★, G, G+, G★, GH, GH+, GH★, GG, GG+, GG★ for ProAm/ProPro |
| RB-C, RB-L, RB-T "Judges' Marks" definition | M (Honorable mention), B, S, S+ (ProAm only), G, G+ (ProAm only), GH, GH+ (ProAm only), GG. No B+, GG+ or ★ listed |
| RB-P (ProPro/ProAm) | M, B, S, S+, G, G+, GH, GH+, GG. No B+, GG+ or ★ listed |

**Rule (replaces the earlier intersection rule):** the R3.2 16-value scale governs the marks for ProAm/ProPro divisions that use the 16-mark ballot (§4.3 lists the exceptions) and **supersedes the 1-26-2026 rule-book mark lists** where they disagree. The rule books call Honorable Mention "M"; the engine uses the Scoring Format's "HM" and treats "M" as the same mark. B+, B★, GG+, GG★ and the other ★ and + marks are valid in those divisions. A mark outside the 16 values is rejected.

**Evidence and compliance:**
- Pinned edition: v16.9b (sha256 above).
- Supporting evidence: a UCWDC newsletter of 11 March 2026 reviewed by the owner. **File not yet pinned; sha256 pending.** The owner is asked in the PR to supply the file so it can be hashed and recorded.
- **Compliance rule:** before any claim of current compliance with the UCWDC Scoring Format, check for later official revisions of the Scoring Format. No claim of current compliance is made by this draft.

## 5. Majority mark and placement (R3.4, R3.5)

Let `J` be the number of judges for the dance.

1. **Raw scores** (R3.4 Step 1): each judge's mark (ProAm/ProPro: value from §4.2; Couples etc.: rank per §4.3) in a fixed judge order, one row per contestant.
2. **Re-ordered scores** (R3.4 Step 2): each contestant's marks sorted ascending (best to worst).
3. **Majority mark:** the middle mark for an odd `J`: position `(J+1)/2`. Examples in the source: 5 judges → 3rd, 7 → 4th, 9 → 5th, 11 → 6th. For an even `J` ("contingency or emergency") the majority mark is "one mark more than half": 6 → 4th, 8 → 5th, 10 → 6th. Both cases equal position `floor(J/2) + 1`.
4. Majority marks of all contestants are sorted ascending; smallest = 1st place, next = 2nd, and so on, until all contestants are assigned a unique placement (R3.5). **Equal majority marks are tied** and go to Rule #4 (R3.5).

Worked source examples: raw `[13,11,12,15,14]` → re-ordered `[11,12,13,14,15]`, majority mark 13; ranks `[3,1,2,5,4]` → `[1,2,3,4,5]`, majority mark 3 (R3.4).

**Majority calculation vs panel eligibility (owner OQ-3, revised 2026-10-25).** The engine computes the majority exactly as the source states it, for any `J ≥ 1`: odd `J` gives the middle mark (the source's examples cover 5, 7, 9 and 11 judges); even `J` (contingency or emergency) gives the `J/2 + 1` mark (6, 8, 10 in the source). There is **no DanceFlow `J ≥ 3` guard**, and Studio Simple's three-judge, odd-panel minimum (X-3) is not reused as a UCWDC rule.

**Panel eligibility is a separate check (G-10, "panel eligibility"), status UNVERIFIED.** The source formula being able to process a panel does not mean UCWDC permits it. The pinned Scoring Format and all four 1-26-2026 rule books state **no minimum or permitted panel size** (judges appear only in graduation percentages and "decisions are final"). So no panel size is marked verified-eligible until an official judging or contest document is pinned (for example UCWDC judge-certification or event-director rules). Until then: `J = 1` or `J = 2` fails closed as **UNVERIFIED**, and the engine reports every panel size as `panel_eligibility = UNVERIFIED`; whether that blocks larger panels is a policy for the owner once a source is pinned. **Open source request for the owner:** supply the official UCWDC judging/contest document that sets the panel size. UCWDC stays unavailable in any case.

The source also does not say what happens if judges' panels differ between contestants or heats (G-11); the engine requires one panel per dance and fails closed otherwise.

## 6. Single-dance tie-breakers, in order (R4–R8)

A tie persisting after Rule #3 proceeds in order through Rule #8. Each rule is applied only among the contestants still tied, and "unique placements" are assigned within the tied group before moving on (R4.2, R5.2, R6.2, R7.2).

Let `m` be the majority position `floor(J/2) + 1`, `v` the majority mark value, `S` the contestant's sorted marks `s1 ≤ … ≤ sJ`.

| Rule | Quantity | Definition | Better |
|---|---|---|---|
| R4 | **Majority size** | number of marks to the right of position `m` whose value is strictly greater than `v` | smaller |
| R5 | **Majority sum** | sum of the marks at positions `1 … m−1` (left of the majority mark) | smaller |
| R6 | **Look-ahead** | compare the marks at positions `m+1 … J`, column by column, left to right; at the first column that differs, the smaller value places higher | smaller at first difference |
| R7 | **Look-behind** | compare the marks at positions `1 … m−1`, column by column, left to right; at the first column that differs, the smaller value places higher | smaller at first difference |
| R8 | **Head-to-head** | see §6.2 | see §6.2 |

Source examples (all with 5 judges, majority mark 3rd):
- R4.1: `[11,12,13,14,15]` has size 2; `[12,12,13,13,15]` size 1; `[13,13,13,13,13]` size 0. (Only marks strictly larger than the majority mark count, so the equal 13 in the second example is not counted.)
- R5.1: `[11,12,13,14,15]` sum 23; `[12,12,13,14,15]` 24; `[12,13,13,14,15]` 25; `[13,13,13,14,15]` 26.
- R6.1: `[11,12,13,14,14]` look-ahead `[14,14]`; `[11,12,13,14,15]` `[14,15]`; `[11,12,13,15,15]` `[15,15]`.
- R7.1: `[11,13,13,14,15]` look-behind `[11,13]`; `[12,12,13,14,15]` `[12,12]`.

**Source notation inconsistencies (G-12):** after the R6.1 examples the text says the three groups have "the same majority sum, '3'", but their sums by the R5 definition are all 23. After the R7.1 examples it says the sum is "4" and the look-ahead "4,5"; by definition the sums are 24 and the look-ahead is `[14,15]`. These drop leading digits and are treated as typographical; none changes a rule.

### 6.1 After Rule #7

R8.1: the final proof of a tie at Rule #7 is that the tied contestants have the **same identical re-ordered judges' marks**. If they do not, "a scoring error has occurred" and the previous rules must be recalculated. The engine fails closed (`COMP_ENGINE_SCORING_ERROR`, proposed) in that case instead of recalculating silently.

### 6.2 Rule #8: head-to-head with re-visitation

1. Only the tied contestants are compared. For every judge and every other tied contestant, comparing the two contestants' **raw** marks from that judge gives a win (lower value), loss (higher value) or tie (equal). The size of the numeric difference is not used (R8.2).
2. Each contestant gets a record wins-losses-ties totalled over all opponents and judges. The total games per contestant must be the same for every tied contestant; otherwise a scoring error (fail closed) (R8.2).
3. **Loss value** = losses + 0.5 × ties (each tie counts one half win and one half loss). Example: record 11-7-4 counts as 13 wins and 9 losses, loss value 9; 11-8-3 has loss value 9.5 (R8.2). The **smaller loss value** places higher. This awards **only the best record's placement** at this step.
4. Re-visitation (R8.3): if the group was two contestants, the other takes the next lower placement. If the group was larger and the top was settled, the remaining contestants are tied for the next lower placement and R8.2 is **recomputed among only the remaining contestants** (the earlier contestant's effect is removed). A group of 3 needs 1 re-visitation, 4 needs 2, 5 needs 3, and so on.
5. Contestants whose wins/losses/ties records are **exactly the same** after Rule #8 are in a **final tie** (R8.3, R8.4).
6. **Final tie placements** (R8.4): the tied contestants share the placements they actually occupy (a 2-way tie for 2nd shares 2nd and 3rd). They are all announced with the higher placement only; the shared lower placements are not announced or awarded and the next announced placement skips them (two tied for 3rd are both "3rd", then "5th").
7. **Carry-forward value** (R8.5, R8.6): each single-dance placement that counts toward the division's championship formula has a carry-forward value equal to the placement (1st = 1, 2nd = 2, …). A final tie gets the **average of the shared placements** (sum ÷ number tied): 2 tied for 3rd/4th → 3.5 each; 3 tied for 3rd/4th/5th → 12 ÷ 3 = 4; 4 tied for 3rd–6th → 18 ÷ 4 = 4.5.

**NOT SPECIFIED IN PROVIDED SOURCE (G-13):**
- When two or more contestants share the *best* loss value but their records are not exactly equal (for example 13-9-0 and 11-7-4 both have loss value 9), the source does not say whether loss value or exact record decides, nor how the *rest* of the group is then processed. The engine fails closed.
- When two or more contestants have exactly the same best record and a lower-ranked contestant remains in the group, the source says the tie is "final" for those contestants but does not describe how the remaining contestants are placed. The engine fails closed unless the whole group has the same record (all share) or a single best record is unique at each step (re-visitation).

## 7. Division-specific rules found in the rule books

The source and the rule books do not define a panel size, a number of heats of Finals, or medal lists beyond §4.4. The rule books contribute: the Overall championship dance lists (§8.3) and graduation rules based on judges' marks (a rule about eligibility, not about computing results; out of scope here).

## 8. Multi-dance / Overall championship (R9–R11)

### 8.1 Points per dance and aggregate value (R9.1, R9.2)

- All dances a contestant competed in, from their first round (Prelims, Semi-Finals or Finals) within the division, earn a points value tied to their **Finals placement** (the carry-forward value of §6.2 item 7). For a dance where the contestant did not make the Finals, the value is **one placement more than the number of finalists for that dance** if they were 1 round removed from the Finals, **2 more** if 2 rounds removed, **3 more** if 3, **4 more** if 4, and so on. These can create duplicate, thus tied, values (R9.1).
- **Supported flow (owner D-4):** in the Prelims → Finals flow only a Prelims retiree is "not in the Finals": their value for that dance is the number of finalists + 1 (one round removed). Counting with two or more Prelims rounds or a Semi-Finals is unavailable (Q2).
- Each contestant's carry-forward values from the championship's dances are **summed** into an aggregate value; each dance has the same weight (R9.2). Example: values 1, 2, 3, 4, 5 → 15; 1, 2.5, 4, 5.5, 7 → 20.
- Championship sizes named: 1-dance, 3-, 4-, 5-, 6- and 8-dance (e.g. an 8-dance ProAm or ProPro Championship). Which dances belong to each championship's "pre-designated dance groups" is **not listed in the Scoring Format** (G-14). The rule books give partial lists: Overall Couples/ProAm/ProPro competitors dance "five of eight dances" (at least Two-Step, Waltz, one Swing dance, and two of Triple Two, Polka, NightClub, Cha Cha) (RB-C, RB-P definitions; RB-C Section III.A); Line Dance requires all offered dance categories (RB-L definitions, Section III.A, with per-level counts); Showcase Masters and Showcase Crown must compete in Two-Step, Waltz and Solo Medley; Classic Masters and Classic Crown must also dance a ShowDance (RB-C III.A.3). The division-by-division group list is **NOT SPECIFIED IN PROVIDED SOURCE** (G-14), so the engine takes the qualifying dance set as an input and does not derive it.
- **Weighted ("ascension") divisions** (Showcase Masters, Showcase Crown, SuperStars, RisingStars, Line Crown): each dance value is multiplied by a weight; Waltz and Two Step (Partner Dance) and Slow (Dance A) and Fast (Dance B) (Line Dance) count 30% each and the Solo Medley counts 40%. In numbers: factor **3** for the 30% dances and factor **4** for the Solo Medley. Example: values 1 and 2 become 3 and 6; Solo Medley value 3 becomes 12; aggregate 21 (R9.2).
- Smaller aggregate = better; sort ascending and award placements; a tie after Rule #9 proceeds to Rule #10 (R9.3).

### 8.2 Tie-breakers for the championship (R10, R11)

- **Rule #10 (placements head-to-head):** among only the tied contestants, compare their **placements** in every dance they all competed in (commonly competed-in dances), including dances outside the championship formula (R10.1). For each dance and each opponent: win, loss or tie, ignoring the size of the difference (R10.2). Record, loss value (ties as half), best loss value places highest; re-visitation exactly as in Rule #8, with the commonly competed-in set recomputed for the remaining contestants because it may now contain dances the earlier contestant had not entered (R10.3). Tie persists → Rule #11.
- **Rule #11 (judges' marks head-to-head):** among only the tied contestants, compare **individual judges' marks** across all commonly competed-in dances, win/loss/tie per judge per dance, totalled into one aggregate record (R11.2). Loss value as above. Re-visitation (R11.3): unlike Rules #8 and #10, a Rule #11 re-visitation must go **back to Rule #10** and recompute there first, then Rule #11 if still tied.
- **Final tie** after Rule #11 (R11.4): the tied contestants share the championship placements they occupy and are announced with the higher placement only; the next announced placement skips the shared ones (same convention as R8.4).

**G-15(a) RESOLVED by proof (review D-3(a)):** the Rule #10 "placement" compared per dance may be read as the announced placement or the carry-forward value. Rule #10 only compares two contestants' values within one dance. Both encodings are monotone in finishing order and equal within a final-tie group, and rounds-removed values (finalist count + k) are above every finalist's value and equal at equal k. So the win/loss/tie outcome is identical under either encoding and the choice is immaterial. F-U-12 is kept.

**NOT SPECIFIED IN PROVIDED SOURCE (G-15(b)):**
- Which round's judges' marks Rule #11 uses, and whether Rule #10 counts a dance as "commonly competed-in" ("mutually danced against each other for placements", R10.1), when a tied contestant did not reach the Finals and has only a rounds-removed points value (review D-6). The engine fails closed in these cases for both Rule #10 and Rule #11.
- **Empty common set (review D-6):** Rules #10 and #11 fail closed when the set of commonly competed-in dances is empty.
- The best-loss-value ambiguity of G-13 applies equally to Rules #10 and #11.
- **Source numbering errors (G-16):** R10.3 says "executing Rule #10, part #4 once again" and R11.3 says "computing wins/losses/ties from Rule #10, part #4" although Rule #10 has parts 1–3 (R10.2's own reference to "part #3" is valid and is not an error). The prose makes clear the intended step is the head-to-head computation of part 2. The engine follows part 2; the verifier should confirm.

### 8.3 What is not ranked here

The source does not describe the mechanics of a division with no championship (a single dance), other than ranking per dance (Rules #3–#8). A single dance's placements and carry-forward values are valid results on their own.

## 9. Reporting (REP)

- The source requires a **Divisional Scoring Analysis (DSA)**, also called the "CC Report", for Contest Coordinators to review or audit a division's results. It was formalized in 1999 and updated for the 2026–2028 Rules cycle.
- The DSA must be available to: contestants (all divisions they dance at a UCWDC event), adjudicators (divisions they judge), Contest Coordinators (divisions they coordinate), the VP of Judge Certification, the VP of Rules, and the Chairman of the Scoring Committee (all DSA reports from every event).
- The **content of the DSA is not defined** in this document (G-17). The engine trace (§11) is designed to contain everything Rules #3–#11 need, but a conforming DSA layout is **NOT SPECIFIED IN PROVIDED SOURCE**.
- Awards presentation: the scoring system must produce **awards reports read to the public**, and only that report may be used for awards. Results may not be re-written into another document to announce placements; additional information must accompany the original awards report. For ProAm/ProPro awards paraphernalia (certificates, plaques, trophies) only the medal **threshold title** derived from the actual results is shown, never the plus or star.
- How a "threshold title" is derived from the results (from a majority mark, placement or other) is **NOT SPECIFIED IN PROVIDED SOURCE** (G-18); no derivation is invented.
- Scoring systems and personnel must keep contact with the UCWDC Rules Committee and Scoring Sub-Committee about adjustments, and may be tested by a UCWDC Scoring Examiner. Whether DanceFlow reaches "authorized" status is an organizational question, not an engine rule.

## 10. Feedback (S4-4)

The source defines **no feedback** and no derivation of feedback from marks. The word does not occur. Medal marks are the judges' assessment against Judge Certification thresholds; the source states how they produce a *placement* (R3–R8) and a *championship* value (R9–R11), not a feedback grade. Per S4-4 (`scoring-architecture-decisions.md`): the engine **refuses** to derive feedback from this method. Feedback and placement from one ballot are allowed only where the method defines both, and this method does not define feedback.

## 11. Engine contract (draft, for K0 alignment)

Inputs (all supplied; none invented): dance type (ProAm/ProPro vs Couples/Line/Teams/Spotlights/AllStars), round (prelims, semi-finals, finals), division ruleset edition `v16.9b`, the judge order and each judge's marks per contestant, the Coordinator's targets, dividing line and Finals capacity (callbacks), the championship's qualifying dance set and weights (multi-dance), and the heat-builder's randomization record (heating).

Outputs: per contestant per dance: majority mark, size, sum, look-ahead, look-behind, head-to-head records and loss values where used, placement, announced placement, carry-forward value, tie group; per championship: aggregate, placement.

Fixed behaviors:
- Deterministic, no randomness in the engine; fixed order of judges and contestants; the result and its trace hash are byte-identical for the same input (S2, K0 §5).
- Fail closed (`COMP_ENGINE_UNSPECIFIED_CASE`, with a reason) on every item marked NOT SPECIFIED, and on inputs outside the rules (marks outside the scale, any panel (eligibility is UNVERIFIED for every panel size, G-10; J = 1 or 2 are refused outright), differing panels, a tie group whose identical-marks proof fails, mixed best-loss-values).
- The trace records, for each tie-breaker invoked: the tied contestants, the quantity compared per contestant, the outcome.
- No Studio medal feedback method exists (S4); this method is not applied to a Studio program.

## 12. Classification: source-confirmed rules, owner-approved interpretations, decisions and unsupported structures, open UCWDC questions

Every rule and gap sits in exactly one of four categories: source-confirmed (12A), owner-approved interpretations (12B), owner-approved decisions and unsupported structures (12C), open UCWDC questions (12D). Detail sits in the section named in each row. Nothing here claims compliance with the UCWDC Scoring Format, panel eligibility, or availability of the method.

### 12A. SOURCE-CONFIRMED RULES (cited to v16.9b and the rule books)

| Item | Source | Detail |
|---|---|---|
| Heating rules H1–H7 | H1–H7 | §2 |
| Callback point values (Yes/No = 10.0; Alt#1–#5 = 5.0/4.6/4.3/4.1/4.0); structure of Prelims and Semi-Finals rounds; **Prelims promotion of the designated number plus ties** (R1.4). The Semi-Finals retirement count and the tie at its cut are not confirmed here (12D, Q1) | R1.1–R1.4, R2.1–R2.3 | §3.1, §3.2, §3.3 |
| Medal thresholds, ProAm/ProPro tiers and ties, Group-and-Rank, no ties for the 6-medal method | R3.1 | §4.1 |
| 16-value ProAm/ProPro scale HM = 26 … GG★ = 11; 6-medal scale HM = 6 … GG = 1 and its defeat order (G8 beats S1) | R3.2, R3.3 | §4.2, §4.3 |
| Majority position `floor(J/2) + 1` (odd J middle; even J "one more than half"); majority marks sorted; unique placements | R3.4, R3.5 | §5 |
| Tie-breakers: majority size, majority sum, look-ahead, look-behind | R4–R7 | §6 |
| Head-to-head mechanics (win/loss/tie by raw mark, loss value with ties halved, re-visitation, final-tie sharing and announced placement, carry-forward average) | R8.1–R8.6 | §6.2 |
| Multi-dance points per dance (rounds-removed rule as written), aggregate, weights 3/3/4 for ascension divisions, placement by smaller aggregate | R9.1–R9.3 | §8.1 |
| Championship tie-breakers by placements and by judges' marks, final tie | R10, R11 | §8.2 |
| Reporting: DSA exists, awards reports, threshold titles only on awards items | REP | §9 |
| The source defines no feedback | whole document | §10 |
| Source notation errors: R6.1/R7.1 dropped-digit sums (G-12); "part #4" in R10.3 and R11.3 (G-16; R10.2's "part #3" is valid) | R6.1, R7.1, R10.3, R11.3 | §6, §8.2 |
| Rule-book facts used: mark-list definitions (HM written "M"; fewer tiers) and Overall dance lists | RB-C/L/P/T | §4.4, §8.1 |

### 12B. OWNER-APPROVED INTERPRETATIONS (not independently verified UCWDC rules; supported scope only)

These were approved by the owner on 2026-10-25 for the explicitly supported scope. They are interpretations of silent or ambiguous source text, not source statements and not verified UCWDC rules.

| ID | Interpretation | Detail |
|---|---|---|
| I-1 (was G-1) | On complete, valid callback ballots, callback points are totalled across all eligible judges, and a contestant a judge did not select gets 0 from that judge (also D-1 / G-2). Missing, incomplete or invalid ballots fail closed | §3.2 |
| I-2 (was G-3) | All contestants tied at the promotion cutoff advance when capacity and competition structure permit. The test: the engine takes a Finals capacity INPUT from the Coordinator and fails closed if promoted contestants plus ties exceed it. No capacity number is invented (R2.3's "nine … twelve" is an example only) | §3.2, §3.4 |
| I-3 (was G-8) | Couples-style medal-and-rank marks convert to each judge's complete ordinal ranking 1…N, only where the conversion is unambiguous. Any duplicate, gap or tie fails closed (ties in with the D-7 validations) | §4.3 |

### 12C. OWNER-APPROVED DECISIONS, LIMITATIONS AND UNSUPPORTED STRUCTURES

**Owner-approved decisions and limitations:**

| Item | Owner decision | Detail |
|---|---|---|
| Callback ballots that are missing, incomplete or invalid fail closed (Yes/No count differs from the set number; Alt gaps; more than 5 alternates; fewer alternates than the Coordinator set (R-5, treated as incomplete); missing assigned-judge ballot; duplicate or overlapping marks, G-4) | D-1 with the D-5 validity rules; R-5 owner ruling 2026-10-25 | §3.3 |
| D-4: the supported flow is **Prelims → Finals only**. Rounds-removed applies only to a Prelims retiree, whose value is the number of finalists + 1 | 2026-10-25 | §3.1, §8.1, §16 |
| OQ-1 / G-9: the R3.2 16-value scale governs ProAm/ProPro and supersedes the rule-book mark lists; v16.9b pinned; compliance only after checking for later official revisions | 2026-10-25 | §4.4 |
| OQ-2 / G-20: ProAm AllStars and ProAm/ProPro Spotlight use the 6-medal Group-and-Rank method, no ties | 2026-10-25 | §4.3 |
| OQ-3: no `J ≥ 3` guard; the majority is calculated as the source states; panel eligibility is a separate check and stays UNVERIFIED | 2026-10-25 | §5 |
| G-15(a): Rule #10 "placement" meaning is immaterial (proof: both encodings give the same win/loss/tie); F-U-12 kept | independent review D-3(a) | §8.2 |
| G-14: the qualifying dance set for Rule #9 is an input; the engine never picks the best dances | coordinator correction C-4 | §8.1 |
| Group-and-Rank ballot validity: duplicate or non-contiguous ranks within a medal fail closed (D-7) | independent review D-7 | §4.3 |
| The whole method stays UNAVAILABLE for actual scoring; compliance and panel eligibility stay UNVERIFIED | 2026-10-25 | §16 |

**Unsupported structures (fail closed, unavailable):**

| Item | Detail |
|---|---|
| Multiple Prelims rounds and any rounds-removed value above 1 | §3.1, §8.1 |
| Any Semi-Finals round or ballot, including the meaning of alternates on a No ballot (G-5) and the direction of Semi-Finals points (G-6) | §3.3 |
| Promotion of all dances together at Worlds (G-7) | §3.5 |
| Different panels across contestants or heats (G-11) | §5 |
| Rules #10/#11 for dances in which a tied contestant did not reach the Finals, and an empty common-dance set (G-15(b) / D-6). Rule #11 (with re-visitation to Rule #10) is supported only when every tied contestant reached the Finals in all common dances and the common set is non-empty; every other Rule #11 case is REFUSED | §8.2, §16 |

### 12D. OPEN UCWDC QUESTIONS (each fails closed)

**Questions drafted for UCWDC (`ucwdc-clarification-questions.md`, DRAFT, not sent; the owner sends externally):**

| Q | Item | Status |
|---|---|---|
| Q1 | A tie spanning the Semi-Finals retirement cutoff (D-2) | BLOCKED. Semi-Finals exist only with two or more Prelims rounds (R2), so no Semi-Finals calculation runs in the supported flow |
| Q2 | Counting "rounds removed" when two Prelims rounds are used | UNAVAILABLE |
| Q3 | Rule #8 where a shared best record has a remainder, and where equal best loss values have unequal records (G-13; fixtures F-U-15(d), F-U-16) | BLOCKED |
| Q4 | Panel eligibility and minimum judges (G-10), for every panel size | BLOCKED, UNVERIFIED |
| Q5 | Whether the Coordinator-set count of alternates (R1.2: "may also be asked to additionally mark up to 5 alternates") is a mandatory completeness requirement (R-5) | OPEN; a ballot with fewer alternates is refused as incomplete meanwhile |

**Other open items (source silent; fail closed):**

| ID | Item |
|---|---|
| G-17 | DSA content |
| G-18 | Derivation of the medal threshold title from results |
| G-19 | Randomization seed for heating |
| G-21 | A missing Finals mark or an absent judge |

## 13. Golden fixtures (hand-computed)

Each fixture lists inputs, steps and expected output. They are written for the verifier to recompute from the source, not to be trusted.

**F-U-01 — scale ordering (R3.2).** Values in ascending assessment order: HM 26; B 25, B+ 24, B★ 23; S 22, S+ 21, S★ 20; G 19, G+ 18, G★ 17; GH 16, GH+ 15, GH★ 14; GG 13, GG+ 12, GG★ 11. Sixteen values; each of B, S, G, GH, GG has three consecutive values; GG★ = 11 is the best, HM = 26 the worst. **Expected:** a contestant marked GG★ beats one marked GG+, which beats GG, which beats GH★ (14 > 13 in value).

**F-U-02 — majority position (R3.4).** J = 5: sorted `[11,12,13,14,15]`, position 3 → 13. J = 7 → 4th, J = 9 → 5th, J = 11 → 6th. J = 6 → 4th, J = 8 → 5th, J = 10 → 6th. Raw `[13,11,12,15,14]` sorts to `[11,12,13,14,15]` → 13. Raw ranks `[3,1,2,5,4]` sorts to `[1,2,3,4,5]` → 3. **Expected:** as stated (all from R3.4).

**F-U-03 — tie-breaker quantities (R4.1, R5.1, R6.1, R7.1).** With J = 5:

| Sorted marks | Majority | Size (R4) | Sum (R5) | Look-ahead (R6) | Look-behind (R7) |
|---|---|---|---|---|---|
| `[11,12,13,14,15]` | 13 | 2 | 23 | `[14,15]` | `[11,12]` |
| `[12,12,13,13,15]` | 13 | 1 | 24 | `[13,15]` | `[12,12]` |
| `[13,13,13,13,13]` | 13 | 0 | 26 | `[13,13]` | `[13,13]` |
| `[12,13,13,14,15]` | 13 | 2 | 25 | `[14,15]` | `[12,13]` |

(Size of `[12,12,13,13,15]`: the marks right of position 3 are 13 and 15, and only 15 > 13, so 1. Sums by the R5 definition: 12+12 = 24, 13+13 = 26. The sizes 2, 1, 0 for the first three rows are the R4.1 examples; the R5.1 sums 23, 24, 25, 26 are for different arrays, so the other table cells are computed from the definitions.) **Expected:** as in the table.

**F-U-04 — ProAm single dance, five judges, four contestants (R3.2, R3.4, R3.5, R4, R5, R6).** Raw marks by judge J1..J5:

| Contestant | J1 | J2 | J3 | J4 | J5 | Sorted | Maj (3rd) | Size | Sum | Look-ahead |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 19 | 18 | 19 | 17 | 22 | 17,18,19,19,22 | 19 | 1 (22) | 35 | [19,22] |
| B | 18 | 19 | 17 | 19 | 20 | 17,18,19,19,20 | 19 | 1 (20) | 35 | [19,20] |
| C | 20 | 20 | 21 | 19 | 19 | 19,19,20,20,21 | 20 | 1 (21) | 38 | [20,21] |
| D | 22 | 21 | 22 | 20 | 23 | 20,21,22,22,23 | 22 | 1 (23) | 41 | [22,23] |

Majority marks: A 19, B 19, C 20, D 22. A and B tie at 19 (R3.5). R4: both size 1 → tie. R5: both sum 35 → tie. R6: look-ahead first column 19 vs 19 equal; second column 20 vs 22 → B smaller → B higher. **Expected placements: B 1st, A 2nd, C 3rd, D 4th.**

**F-U-05 — look-behind decides (R7).** Two contestants, 5 judges, ProAm values. X raw `[14,11,13,15,13]` sorts to `[11,13,13,14,15]`; Y raw `[12,15,13,12,14]` sorts to `[12,12,13,14,15]`. Majority both 13. Size both 2 (14, 15). Sum X 11+13 = 24, Y 12+12 = 24. Look-ahead both `[14,15]`. Look-behind X `[11,13]`, Y `[12,12]`: first column 11 < 12 → X higher. **Expected: X 1st, Y 2nd.** (Example sorted marks from R7.1.)

**F-U-06 — Group and Rank, Couples (R3.3, R3.4, R4).** Three contestants A, B, C, three judges. J1: A G1, B G2, C S1. J2: B G1, A G2, C S1. J3: C G1, A S1, B S2. Medal then rank-within-medal order: J1 A1 B2 C3; J2 B1 A2 C3; J3 C1 A2 B3 (G beats S; S1 beats S2). Raw ranks: A `[1,2,2]`, B `[2,1,3]`, C `[3,3,1]`. J = 3, majority position 2. Sorted: A `[1,2,2]` → 2; B `[1,2,3]` → 2; C `[1,3,3]` → 3. A and B tie at 2; R4 size: A right of position 2 is `[2]` → none > 2 → 0; B `[3]` → 1. A smaller. **Expected: A 1st, B 2nd, C 3rd.** (Also illustrates "G8 defeats S1": a G in any rank beats an S in any rank.)

**F-U-07 — full tie through Rule #7, head-to-head circular (R8).** Three contestants, three judges, values `{13,17,19}` per contestant: P `[13,17,19]`, Q `[17,13,19]`, R `[19,13,17]`.

All sort to `[13,17,19]`: majority 17, size 1, sum 13, look-ahead `[19]`, look-behind `[13]` → identical through Rule #7 (R8.1 confirmed). Head-to-head (lower wins), per judge:
- P vs Q: J1 13<17 P; J2 17>13 Q; J3 19=19 tie → P 1-1-1.
- P vs R: J1 13<19 P; J2 17>13 R; J3 19>17 R → P 1-2-0.
- Q vs R: J1 17<19 Q; J2 13=13 tie; J3 19>17 R → Q 1-1-1.

Records: P: wins 2, losses 3, ties 1 (2-3-1), loss value 3.5. Q: vs P 1-1-1, vs R 1-1-1 → 2-2-2, loss value 3. R: vs P 2-1-0, vs Q 1-1-1 → 3-2-1, loss value 2.5. Games each: 6. **R best (2.5) → 1st.** Re-visitation among P and Q only: P vs Q 1-1-1 each, loss value 1.5 each → exactly equal records, final tie for 2nd/3rd. **Expected: R 1st; P and Q share 2nd/3rd, both announced "2nd"; no "3rd" announced. Carry-forward R = 1; P = Q = (2+3)/2 = 2.5.**

**F-U-08 — fully circular three-way final tie (R8.4, R8.6).** Three contestants, three judges: P `[13,17,19]`, Q `[17,19,13]`, R `[19,13,17]`. All sort to `[13,17,19]`; tie through Rule #7. Head-to-head: P vs Q: J1 13<17 P; J2 17<19 P; J3 19>13 Q → P 2-1-0. P vs R: J1 13<19 P; J2 17>13 R; J3 19>17 R → P 1-2-0. Q vs R: J1 17<19 Q; J2 19>13 R; J3 13<17 Q → Q 2-1-0. Totals: P 3-3-0, Q: vs P 1-2-0, vs R 2-1-0 → 3-3-0, R: vs P 2-1-0, vs Q 1-2-0 → 3-3-0. Loss value 3 each, records exactly equal. **Expected: final three-way tie for 1st/2nd/3rd; all announced "1st"; carry-forward (1+2+3)/3 = 2 each (R8.6).**

**F-U-09 — final tie with two, announced placement (R8.4, R8.6).** Two contestants, three judges: P `[13,19,17]`, Q `[19,13,17]`. Sorted both `[13,17,19]`, tied through Rule #7. Head-to-head: J1 13<19 P; J2 19>13 Q; J3 17=17 tie → each 1-1-1, loss value 1.5. **Expected: final tie for 1st/2nd; both announced "1st"; carry-forward 1.5 each; the next contestant, if any, is announced "3rd".**

**F-U-10 — even panel (R3.4).** J = 6, sorted `[11,12,13,14,15,16]`: half of 6 is 3 (not a majority), the majority mark is position 4 → 14. Size: marks right of position 4 are 15, 16 (> 14) → 2. Sum: positions 1–3: 11+12+13 = 36. Look-ahead `[15,16]`; look-behind `[11,12,13]`. **Expected:** majority 14, size 2, sum 36.

**F-U-11 — callback points (R1.2, R1.4).** Six contestants A–F, three judges; each judge marks 2 Yes and Alt#1, Alt#2. J1: Yes A, B; Alt#1 C; Alt#2 D. J2: Yes A, C; Alt#1 B; Alt#2 E. J3: Yes B, C; Alt#1 A; Alt#2 D. Values Yes 10.0, Alt#1 5.0, Alt#2 4.6. Totals: A 10+10+5.0 = 25.0; B 10+5.0+10 = 25.0; C 5.0+10+10 = 25.0; D 4.6+4.6 = 9.2; E 4.6; F unselected by every judge, D unselected by J2, E unselected by J1 and J3; each is scored 0 by a judge who did not select them (G-2 resolved by owner D-1, valid completed ballots). **Expected:** with a designated number of 3: A, B, C promoted (all 25.0). With a designated number of 2: A, B, C all tied at the dividing line → all three promoted (plus ties, R1.4). With the owner's rule (unselected = 0) the totals are exactly those listed, F = 0. The ballots here are valid and complete (each judge has 2 Yes and Alt#1, Alt#2); the same input with a judge missing, or a judge with the wrong number of Yes marks, fails closed.

**F-U-12 — championship aggregate and Rule #10 (R9.2, R9.3, R10.2, R10.3).** Four contestants X, Y, Z, W, three dances with final carry-forward values:

| Dance | X | Y | Z | W |
|---|---|---|---|---|
| d1 | 1 | 2 | 3 | 4 |
| d2 | 4 | 1 | 2 | 3 |
| d3 | 1 | 3 | 2 | 4 |

Aggregates: X 1+4+1 = 6; Y 2+1+3 = 6; Z 3+2+2 = 7; W 4+3+4 = 11. X and Y tie at 6 for the top (R9.3); Z 3rd, W 4th. Rule #10 between X and Y over commonly competed dances d1–d3: d1 X (1) beats Y (2); d2 Y (1) beats X (4); d3 X (1) beats Y (3). X 2-1-0 (loss value 1), Y 1-2-0 (loss value 2). **Expected: X 1st, Y 2nd, Z 3rd, W 4th.** (The compared placements may be the announced placement or the carry-forward value: both give the same win/loss/tie, see G-15(a).)

**F-U-13 — weighted aggregate (R9.2).** An ascension division with Waltz 1, Two Step 2 and Solo Medley 3: 1×3 = 3, 2×3 = 6, 3×4 = 12; aggregate 21. **Expected 21** (source example).

**F-U-14 — rounds-removed points (R9.1), simple Prelims → Finals structure only (owner D-4).** A dance with 6 finalists: a Prelims retiree (one round removed) has the value 6 + 1 = 7. **Expected: 7.** Two or more rounds removed (value 8, 9, …) require a structure with two or more Prelims rounds or a Semi-Finals, which is unsupported: **explicit refusals** (Q2, Q1). Ties among contestants at the same removal level are possible (R9.1).

**F-U-15 — fail-closed cases.** Each must produce `COMP_ENGINE_UNSPECIFIED_CASE` with the stated reason: (a) a ProAm/ProPro 16-mark ballot containing a mark outside the 16 values (B+ and ★ marks are valid after OQ-1); (a2) a 16-mark ballot or tied marks submitted for ProAm AllStars or ProAm/ProPro Spotlight (6-medal Group-and-Rank, OQ-2); (a3) a missing Finals mark or absent judge (G-21); (b) `J = 1` or `J = 2` (panel eligibility UNVERIFIED, G-10); (c) two heats of one dance with different panels (G-11); (d) three tied contestants whose best loss values are equal but whose records differ (G-13 bullet 1; a 2-way tie cannot do this because its records are mirror images, review D-9). Concrete inputs from the reviewer (`k1u-reverification-aaffc9f5.md` R-6), recomputed here: J = 7, ProAm values; A `[14,14,13,12,14,12,11]`, B `[12,13,14,14,11,14,12]`, C `[14,12,13,12,11,14,14]`. All three sort to `[11,12,12,13,14,14,14]` (majority position 4 = 13, size 3, sum 11+12+12 = 35, look-ahead `[14,14,14]`, look-behind `[11,12,12]`), so they are tied through Rule #7. Judge by judge (J1…J7: A / B / C): 14/12/14, 14/13/12, 13/14/13, 12/14/12, 14/11/11, 12/14/14, 11/12/14. A vs B (lower wins): B, B, A, A, B, A, A → A 4-3-0. A vs C: tie, C, tie, tie, C, A, A → A 2-2-3. B vs C: B, C, C, C, tie, tie, B → B 2-3-2. Totals (14 games each): A 4-3-0 + 2-2-3 = 6-5-3, loss value 5 + 3/2 = 6.5; B 3-4-0 + 2-3-2 = 5-7-2, loss value 7 + 1 = 8; C 2-2-3 + 3-2-2 = 5-4-5, loss value 4 + 5/2 = 6.5. A and C share the best loss value 6.5 with different records, B is 8, so the source does not say who is first. **Expected: refusal (G-13 bullet 1, Q3).** (d2) IR-22 below (G-13 bullet 2); (e) any Semi-Finals round or ballot (the supported flow is Prelims → Finals only, so no Semi-Finals calculation runs; G-5, Q1); (f) a request to derive feedback (S4-4, §10); (g) is not an input fixture (review D-11): equal majority mark, look-ahead and look-behind imply identical sorted marks, so tied contestants whose re-ordered marks differ after Rule #7 can only come from an implementation bug. It is kept as an internal assertion (R8.1 scoring error).

**F-U-16 — shared best record with a remainder (review D-8, IR-22; G-13 bullet 2).** Five judges, three contestants: A `[12,13,13,14,15]`, B `[12,13,14,15,13]`, C `[13,13,15,12,14]`. Head-to-head per judge (lower wins): A vs B: tie, tie, A, A, B → A 2-1-2. A vs C: A, tie, A, C, C → 2-2-1. B vs C: B, tie, B, C, B → 3-1-1. Records: A 4-3-3 (loss value 4.5), B 1-2-2 + 3-1-1 = 4-3-3 (4.5), C 2-2-1 + 1-3-1 = 3-5-2 (6.0). A and B share the best record, and A beats B head-to-head 2-1-2. Two readings differ: (a) A and B share 1st/2nd (carry-forward 1.5) and C is 3rd; (b) C is 3rd and A vs B is re-visited, giving A 1st, B 2nd. **Expected: NOT SPECIFIED, fail closed.** (Taken from the independent review; the independent reviewer computed it, W6 did not.)

## 14. Verification checklist

The independent verifier should: recompute every fixture from the source; confirm each owner-approved interpretation (I-1, I-2, I-3) against the source and the owner's ruling; decide whether each NOT SPECIFIED item stays fail-closed or needs an owner decision; confirm the star ordering with `pdftotext -enc UTF-8`; confirm the rule-book mark lists (G-9); and confirm the 16-value scale against the owner's source. Until then this spec is **DRAFT** and the method stays unavailable (S4-5).

## 15. Owner questions and verification status

The independent verification report is `k1u-verification-report.md` (verdict: verified with corrections; every rule calculation matches the source and all 15 fixtures recompute identically). Corrections C-1 to C-5 are applied (C-1 after the owner approved OQ-1 on 2026-10-25). The coordinator's verification had an independence caveat (see the report); the owner asked for an **independent golden-fixture review to continue**, so the spec stays DRAFT.

| ID | Question |
|---|---|
| OQ-1 | **APPROVED 2026-10-25.** The 16-value scale governs ProAm/ProPro marks and supersedes the rule-book lists (§4.4). The 11 March 2026 newsletter is supporting evidence, file not yet pinned; a check for later official revisions is required before any compliance claim |
| OQ-2 | **APPROVED 2026-10-25.** ProAm AllStars and ProAm/ProPro Spotlight use the 6-medal Group-and-Rank method, no ties (§4.3) |
| OQ-3 | **REVISED 2026-10-25.** No `J ≥ 3` guard; the majority is calculated as the source states. Panel eligibility is a separate UNVERIFIED check; J = 1 or 2 fail closed; official panel-size source requested (§5) |

Status stays **DRAFT**. UCWDC Majority Rules stays unavailable (S4-5). No engine code.

## 16. Supported cases and explicit refusals (owner dispositions of 2026-10-25)

**The whole UCWDC Majority Rules method stays UNAVAILABLE for actual scoring until panel eligibility is verified (UCWDC Q4), even for the supported cases.** "Supported" below means fully specified in the pinned source and independently verified (coordinator verification `k1u-verification-report.md`; independent fixture review `k1u-independent-fixture-review.md`, 32 fixtures, all arithmetic agreeing). It does not mean enabled.

### 16.1 Supported cases (specified, fixtures independently recomputed; not enabled; no compliance or eligibility claim)
- Finals single-dance majority (R3.4, R3.5) and tie-breakers Rule #4 to Rule #7 for the 16-mark ProAm/ProPro scale (OQ-1) with valid ballots. **The 6-medal Group-and-Rank scale (Couples, Line, Teams, ProAm AllStars, ProAm/ProPro Spotlight; OQ-2) rests on the owner-approved interpretation I-3 (not a verified UCWDC rule)**, with valid ballots (contiguous, non-duplicated ranks).
- Rule #8 head-to-head with re-visitation where the best record is unique at each step, or the whole tied group has exactly the same record (final tie, announced higher placement, carry-forward average).
- Preliminaries callback totals (Yes 10.0; Alt#1–#5 5.0/4.6/4.3/4.1/4.0), an unselected entry scoring 0 on a **valid, completed** ballot (owner D-1), with ties at the dividing line promoted; **simple Prelims → Finals structure only** (owner D-4). **Rests on the owner-approved interpretations I-1 and I-2 (not verified UCWDC rules); Finals capacity is a Coordinator input and the engine fails closed if promoted plus ties exceed it.**
- Rule #9 aggregate for a qualifying dance set supplied as input, with a Prelims retiree one round removed (finalists + 1; simple structure) and the weighted divisions.
- Rule #10 and Rule #11 (including its re-visitation back to Rule #10), supported only under the D-6 conditions: every tied contestant reached the Finals in all common dances and the set of common dances is non-empty. Every other Rule #11 case is REFUSED (fail closed): a tied contestant who did not reach the Finals in a common dance, an empty common set, and any head-to-head where competing readings give different winners (G-13). Rule #11 is cited in IR-27 of `k1u-independent-fixture-review.md`.

### 16.2 Explicit refusals (fail closed, `COMP_ENGINE_UNSPECIFIED_CASE` or `COMP_ENGINE_NOT_AVAILABLE`)
- **Everything, for actual scoring, until panel eligibility is verified (Q4).** J = 1 or 2 are refused as UNVERIFIED; no panel size is marked verified-eligible.
- Any Semi-Finals round or ballot: no Semi-Finals calculation runs in the supported flow (§3.3). The tie at the retirement cutoff (D-2, Q1) and alternates on a No ballot (G-5) are unresolved.
- Multiple Preliminaries rounds or any Semi-Finals structure, and rounds-removed counting beyond 1 (D-4, Q2).
- Head-to-head where competing interpretations give different winners (G-13, Q3), for example F-U-16/IR-22.
- Missing, incomplete or invalid callback ballots; wrong Yes/No count; non-contiguous Alt ranks; more than 5 alternates; fewer alternates than the Coordinator set (R-5, refused as incomplete pending Q5); a missing assigned-judge ballot; promoted plus ties exceeding the Coordinator-supplied Finals capacity (I-2); any duplicate, gap or tie in a Couples-style conversion (I-3).
- Missing Finals marks or an absent judge (G-21); different panels across heats (G-11).
- Duplicate or non-contiguous ranks within a medal (Group-and-Rank); ties in Couples/Line/Teams/AllStars/Spotlight; a 16-mark ballot for AllStars/Spotlight.
- Rules #10/#11 on an empty common set or for dances where a tied contestant did not reach the Finals (D-6); G-15(b).
- Dance groups not supplied as input (G-14); DSA content (G-17); threshold-title derivation (G-18); feedback (S4-4).

### 16.3 UCWDC clarification questions
The draft questions for the UCWDC Scoring Sub-Committee are in `ucwdc-clarification-questions.md` (**DRAFT — not sent; the owner sends externally**): Q1 Semi-Finals tie at the retirement cut, Q2 rounds-removed counting with two Preliminaries rounds, Q3 Rule #8 where competing interpretations differ, Q4 panel eligibility and minimum judges, Q5 whether the Coordinator-set count of alternates is a mandatory completeness requirement. The method stays unavailable pending Q1–Q4.
