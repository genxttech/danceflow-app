# Additional qualified-approver role (separate design; not authorized)

**Status: DESIGN ONLY, unexecuted.** DanceFlow Studio/Custom policy. Requirement 10 of the B2 Q1 decision (PR 795 section 17) and Q8 (section 16). Open: **Q10**. Companion: [OPTION-B2-DESIGN.md](OPTION-B2-DESIGN.md).

## Today

Only a competition manager can approve (`20270114090000:1040`). Approval also certifies each locked heat through `set_competition_heat_lock_state`, which requires `can_manage_event_competition`. So no other person can approve, and a role added only to the approval gate would **abort at certification**.

## Proposed role

**Explicit authorization**
* Append-only grant and revocation rows: event, user, official row, basis, granted by, time, reason. Written only by a definer function. No API write privilege.
* Holder: active official row, verified email. Conflict-of-interest screening depends on OD-05 (unbuilt); until then it is not claimed.
* Q10: which official roles qualify (chair, scorer, other verified official); who may grant (any manager, or only one not barred for the result); whether the grant must predate the correction or the extra round (recommended: yes, as OD-07 proposes; a studio that granted nobody then cannot fix that mid-event).
* One concept and table shared with OD-07's designated reviewer. Body-declared events stay fail closed until OD-06 roles exist.

**Least privilege**
* Allows only: approve or revalidate a result of that event, and read what is needed to review it (result rows, evidence, eligibility).
* Does not allow: ballot entry or correction, calculation, opening corrections, cancelling rounds, changing the running order or heats, publication, granting roles.
* Heat certification happens inside the approval function through a dedicated internal step, not by widening the lock-state function to the role.
* Needs its own read functions, grants and screen; none exist.

**Audit**
* Grant, revoke, approval and revalidation each record actor, basis and time; the approval records the basis used.
* Independence items 1-4 apply to the holder exactly as to a manager, judged by user id for the life of the history, whatever role the person holds later.
* Authority is judged at the time of the act; revocation does not undo it. A later disqualifying act stops it qualifying.

## Sequencing and tests

Never admit the role before the independence predicate and rule (B2-6) are enforced: with PR 865 alone a holder who entered ballots would pass. Slot `20270301166000` reserved.

Tests (to be written): grant and revoke by non-managers and by API writes refused; revoked, inactive or ungranted person refused; holder refused every other competition write; holder approves end to end including certification; each barred item refuses a holder; revocation between approval and publication; role changes.

Not verified: everything above; the full list of functions a holder would need.
