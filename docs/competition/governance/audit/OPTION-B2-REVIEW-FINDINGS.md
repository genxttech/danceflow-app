# B2 independent review of `1ea7220a4` and of the owner question list: findings recorded, NOT applied

**Status: B2 work is PAUSED** (owner priority on a constrained Studio/Custom MVP, PR 795 section 20, `125ae45de`). The design and the question list are preserved as they were reviewed. The findings below are the reviewer's, by reading only; the author has **not verified or applied** them. Behavioral consequences are inferences. R-11 and B2 remain blocked.

## Design

| ID | Severity | Finding | Suggested correction |
|---|---|---|---|
| D1 | BLOCKER | The Q14 hold is narrower than the "affected" rule: rule 3 affects every result of a division with an unbound sibling (for example a callback-shaped Final entering by publication), but holds cover only the changed round's slots or advancement chain, and the entry and offering filter excludes rounds the rule counts. An affected, unqualified published result can stay visible (against section 19) | hold exactly the published results an authorized change newly makes affected; validate the actor and change, or align the rule |
| D2 | SHOULD-FIX | Readers: no visibility gating stated for the placeholder (R-16); withdrawing or correcting a held publication drops it silently from the event and "my results" lists; the current viewer code would render a row-less payload as an empty table; other app consumers (`actions.ts`, `viewer.ts`, `publication.ts`) are not named | specify each and the precedence |
| D3 | SHOULD-FIX | Division-wide opener and canceller bar: cancelling even an unpublished dance-less round makes it unbound and bars the canceller division-wide, which can strand a one-manager studio, while deleting does not; a later cancellation by an approver blocks condition (b) with no hold; the staffing text and tests I7 and I10 are stale; section 16 speaks of relevant lineage | state the cost and reconcile |
| D4 | SHOULD-FIX | Duplicate dance rows are "not refused" in one place and refused or "dedupe hygiene" in others | make consistent |
| D5 | SHOULD-FIX | Display: disagreeing labels refuse publication permanently; legacy and exempt labels are unvalidated user text; the hold notice shows a dance although the display step is called independent | define recovery or fallback and the dependency |
| D6 | SHOULD-FIX | The placement-only heat swap is listed open in the residuals but missing from the section 6B open list | add it |
| D7 | NOTE | "Amended" is per round while condition (b) applies to multi, so the rule 5 wording is unclear; rule 5 penalizes schedules published in stages; advancement lock order unverified | |

No further bypass was found by reading in the advancement condition or the newly-entering dance check.

## Owner question list (`owner-package/b2-questions.md`, outside the repository)

| ID | Severity | Finding |
|---|---|---|
| Q-1 | BLOCKER | Q17 does not close what it asks about: OD-12 excludes digital `judge_web` ballots, so a spare in the first order with digital ballots stays self-approvable under options 1-3. R-11 stays blocked after option 1 unless the residual is separately adjudicated; a "keep blocked / further design" option is missing. The author's earlier statement that OD-12 would stop one-person creation of ballot content covers typed ballots only |
| Q-2 | BLOCKER | Missing decisions: "another event" (section 13 requires closing or stating it) and the placement-only heat swap. The running-order ban is listed as already answered but is undecided |
| Q-3 | BLOCKER | The compact reply format allows incompatible or ambiguous approvals (no activation accepted or blocked field; multi-part questions without sub-answers; unlisted exclusions such as Q10(a) with Q11(i) and Q22(i), Q10(b) with Q12 and Q13, Q19(i) with Q10(a); Q2 and Q3 recommendations assume Q17 option 1) |
| Q-4 | SHOULD-FIX | Q10(a) conflicts with decided OD-07's independent designated reviewer (R-11(4)) and with section 16's separate authorized scorer or official; Q10(b) allows roles the OD-07 design advises against |
| Q-5 | SHOULD-FIX | Q12 cites a non-existent "Q10 chair only" option; Q19(i) "no permanently hidden result" is wrong; Q7 is labelled EXECUTED but is a hosted read; Q11 does not say its recommendation is broader than section 16's relevant lineage |
| Q-6 | SHOULD-FIX | Section 19 item 5 is not met for several questions (security, operations, unverified assumptions); the #856 / #908 ballot-integrity questions must be merged before presentation |
| Q-7 | NOTE | B2-E1 cites a requirement that grants no slot authority (section 11 assigned slots); B2-E4's citations do not support the exemption; Q20 is broader than the design; Q21(i) and Q15(ii) should state further tensions (17 req 1; R-11(2)) |

Spot-checked code citations supported their claims; catalog, ballot-actor, absence-recorder lines and PR 854 were not checked.
