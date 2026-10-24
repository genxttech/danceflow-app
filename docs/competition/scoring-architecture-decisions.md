# Competition OS — Scoring architecture decisions (K1 Stage 4)

Status: **owner decisions of 2026-10-24, recorded in principle. Docs only** (no code, no SQL). Recorded from the Competition coordinator's handoff of the owner's words. Applies to PR #293 (K1 specs). Approved architecture is separated from pending methodology below; nothing in the pending list is approved by being listed.

Related: `engine-spec-ordinal-majority.md`, `engine-spec-callback-tally.md`, `engine-spec-proficiency-rating.md`, `scoring-results-contract.md` (K0), `governing-body-source-registry.md`.

## 1. APPROVED architecture

### 1.1 Five independent dimensions (S4-1, S4-2, S4-3, S4-6)

Owner: "Sanctioning must remain independent from the scoring method. A division may use an approved ruleset for feedback, placements, advancement, or an authorized combination, regardless of event sanctioning."

| # | Dimension | Notes |
|---|---|---|
| 1 | Sanctioning | Independent of the scoring method |
| 2 | Format / division type | |
| 3 | Scoring method + version | From a versioned registry, chosen per division, with an optional round-level override (for example callback vs final) |
| 4 | Ballot format + permitted marks | |
| 5 | Result purpose | Feedback, placements, advancement, or an authorized combination |

Also approved:
- Sanctioning is **disclosed**, with **no implied sanction**.
- **Official methods are implemented only exactly**, never approximated.
- Feedback and placement are derived from **one ballot only where the method defines both**.

### 1.2 Scope of Stages 1–3
The Stage 1 (X-1…X-7), Stage 2 (D-CT-1…10) and Stage 3 (D-OM-1…5, D-OM-3b) decisions apply to the **Studio methods only**: the studio callback tally and the studio ordinal majority. They are not governing-body methods and carry no sanctioning claim.

### 1.3 S4-4 (revised)
Owner: "Do not impose a universal median-mark or majority-mark calculation on all medal feedback. The selected scoring method and version must define how feedback is derived, including panel size, ties, missing marks, and even panels. If the method does not define that behavior, refuse the calculation rather than inventing it."

### 1.4 S4-5
Owner: "Approve the registry-based approach to competitive medal placements, but keep UCWDC Majority Rules unavailable until K1-U has completely specified and independently verified the official calculations, callbacks, ties, division-specific rules and multi-dance championships against the authoritative source."

### 1.5 S4-7
Owner: "Preserve version-locking and certified-result immutability. Do not silently rewrite existing competition configurations. For unfinished draft competitions, design an explicit, audited migration or duplication workflow rather than requiring recreation by default. Any locked competition must remain fail-closed until its compatibility and permitted transitions are reviewed."

### 1.6 REJECTED
The original three-band median proposal as a **universal studio method** is rejected. The `proficiency_rating` key stays **fail-closed** and is **not deleted**. It has no approved method, so it remains `COMP_ENGINE_NOT_AVAILABLE`.

## 2. PENDING (open; not approved)

| Item | State |
|---|---|
| **K1-U**: UCWDC Majority Rules v16.9b full specification | Source: `2026-Scoring-Format-v16.9b-1.pdf`, sha `44290a06`. It already lists the 16-mark ProAm/ProPro scale, HM = 26 down to GG★ = 11. Whether a "March 2026" edition exists is **unconfirmed**. UCWDC Majority Rules stays unavailable until K1-U is complete and independently verified (S4-5) |
| Studio medal feedback or placement method | **None approved** |
| NDCA Skating System | No authoritative algorithm source |
| WSDC Relative Placement | No authoritative algorithm source |
| D-CT-4 over-capacity tie process | Open; a callback runoff is a candidate only |
| S4-2 disclosure wording | Open |
| S4-7 draft-migration / duplication workflow | Design open (audited, explicit; recreation not required by default) |
| Registry storage and its migration slot | Open; no slot assigned |

## 3. Effect on the K1 specs

- `ordinal_majority` and `callback_tally` are the approved Studio methods (Stages 1–3). Their implementation stays blocked until the spec set is complete.
- `proficiency_rating` has no approved method; its D-PR items are not decided and the key remains fail-closed (§1.6). Its spec text predates this architecture; the three-band median candidates in it are not adopted.
- No engine may approximate an official method. UCWDC Majority Rules, NDCA Skating System and WSDC Relative Placement are unavailable until their own source-verified specs are approved.
