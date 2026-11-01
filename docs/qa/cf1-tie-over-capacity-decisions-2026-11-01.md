# CF1 SCN-11.4b: tie over Final capacity. Approved policy, implemented scope, open rules decisions

## Approved policy (owner, 2026-11-01)
When a tie exceeds the Final's advancement capacity, DanceFlow preserves valid scores and tie evidence but does not automatically advance additional couples, arbitrarily break the tie, or commit advancement. The advancement state stays **UNRESOLVED** until an authorized, auditable workflow resolves it consistent with the applicable competition rules. No universal tie-breaker is invented. U81/U82/U85 and RB1(b) are not waived; OD-17 stays disabled for live events.

This is consistent with OD-1 / D-CT-4 option D (blocked, no manager pick, no automatic over-capacity advance). It supersedes only the wording "no override control exists" / "runoff unapproved": a resolution workflow is now wanted, but only a rule-supported one, and none is selected yet.

## Reconciliation (what was inconsistent, what changes)
| Layer | Before | After this slice |
|---|---|---|
| F1 callback-tally engine (#337) | over-capacity tie **fails** (COMP_ENGINE_UNSPECIFIED_CASE tie_over_capacity): no result stored | calculation **completes**: every row `advanced = null`, per-row `tie_status`, trace `blocked_tie_over_capacity` with tied entries, cut tally, capacity |
| A0/A3 (database) | already treats any `advanced is null` row on a callback_tally version as a blocked tie: approve refused COMP_ADVANCEMENT_BLOCKED, apply refused, preview `blocked`, capacity raise refused (COMP_CAPACITY_F1_BLOCKED_TIE) | unchanged; SQL and concurrency coverage added for each 11.4b assertion |
| B (desk) | generic "Advancement is blocked", no tie evidence shown | "Advancement unresolved" panel: saved scores, couples clearly above the cut, couples tied at the cut, why nothing advanced, the supported route |
Evidence (result version rows and trace) and the authorization to advance (round_advancement rows) are separate tables; an unresolved version has evidence and no authorization.

## Resolution routes
**Supported now (no tie-breaker involved):** a judge-entry correction (reason, co-signed by a different manager or the chair, A7), judges re-file ballots, recalculate. If the corrected ballots dissolve the tie (tied count within capacity) the new version has advanced flags and approve/apply proceed. Otherwise it stays unresolved. Capacity change is **not** a route (B5 freeze; F1 raise-to-T cannot dissolve a tie of more than T).

**Not implemented, needs rules decisions (please decide before any build):**
| # | Question | Options and consequence |
|---|---|---|
| RD-1 | Which rule source governs a tie at the Prelim-to-Final cut when promoted-plus-ties exceeds the floor capacity? UCWDC R1.4 says "designated number plus ties" are promoted but is silent on over-capacity; no confirmed source covers it. | (a) adopt a stated studio/organizer rule (needs the rule text), (b) per-event published rule chosen by the director at setup, (c) none: stay unresolved and require a correction or a rescheduled/larger Final |
| RD-2 | Runoff (extra judge recall among only the tied couples) | needs a new ballot format and engine version (`callback_tally@2`), judges present, and its own acceptance; rule-supported only if RD-1 names it |
| RD-3 | Director decision to advance all tied couples anyway (Final larger than capacity) | contradicts D-CT-4; breaks the single-heat Final model (F-6) unless the Final is split; needs a rules decision plus the floor capacity change after ballots (B5 frozen) |
| RD-4 | Director decision that none of the tied advance | invented rule (penalizes every tied couple, under-fills the Final); no source |
| RD-5 | Are the couples strictly above the cut advanced provisionally while the tied couples are unresolved? | current model: no (all rows null, per design F-3, so nothing partial commits). Partial advance would need a state model change |
| RD-6 | Who may resolve and how many signatures | would follow the A7/OD-19 pattern (chair or another manager, separate from the opener, reason, audit) once RD-1 names the mechanism |
Any workflow built from these must store the decision, rule citation, reason, actors and the evidence it relied on as a new, immutable, auditable row, never as an edit of the result version.
