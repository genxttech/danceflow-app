# TW-4F SMS price dual control (D4-1)

Status 2026-10-31. Git only: migration `20270204090000_twilio_price_dual_control.sql` is not applied to any hosted database. The pricing release gate stays BLOCKED until independent security review is complete (the review of PR 384 found no P0 or P1; its fixes are in the PR).

## Rule
A published SMS price changes only when one platform administrator proposes and a DIFFERENT active platform administrator approves (`tw4_price_propose` / `tw4_price_approve`). `tw4_price_set` refuses every caller. A price row can be inserted only while an approved request for exactly those amounts is being applied (an `ENABLE ALWAYS` trigger, so it also holds under `session_replication_role = replica`); retired prices are never re-activated and published prices are never edited. The request table triggers are also `ENABLE ALWAYS`: forging a decision needs visible DDL (`alter table ... disable trigger`), not a session setting. Application entry points: `pricePropose` and `priceApprove` need AAL2 plus an authenticator code from the last 15 minutes, `priceReject` needs AAL2.

## Rollback
Valid only before the first request row exists (it refuses with 55000 afterwards: requests are audit evidence). After that: forward-fix, or disable the three price actions at the application layer. A rolled-back state REOPENS the single-administrator `tw4_price_set` (its `20261122090000` body is restored byte for byte).

## Residual risk: the service-role key (accepted pending owner decision)
The price functions are executable by the service role only, and `p_actor` is supplied by that caller. The application derives the actor from the verified AAL2 session, but the database cannot tell a real session from a caller that holds the service-role key and names two administrator ids. Dual control is therefore exactly as strong as the secrecy and use discipline of the service-role key (the same property as the existing RFL dual-control functions). Nothing in this PR changes that architecture. Future hardening, if the owner wants it: bind each approval to the approver's own JWT (verified `sub` and `aal` claim read inside the function from a user-scoped call, or a signed approval token checked in the database), so a service-role-only caller cannot approve on behalf of someone.

## Operational notes
- Lock order: propose / approve / reject share-lock the parties' `profiles` rows first (id order), then the per-kind advisory lock, then the request row. Tooling that changes several platform roles in one statement or transaction should update profiles in id order, or it can deadlock with an approval (fails safe: one side rolls back, nothing is published).
- Price kinds are read from the price list check constraint with a lowercase `[a-z][a-z0-9_]*` token rule; a future kind with a digit first, an uppercase letter or a hyphen would not be proposable. The UI list `PRICE_KIND_TEXT` must gain every new kind; `localStack.pricedual` (PD-09c) compares it to the database list.
- `tw4_price_requests_list` returns the latest 100 requests; older rows stay in the table.
- Amounts are capped at 10,000,000 cents (the UI maximum). A provider cost above the customer price is allowed: negative-margin cases are modelled in the pilot docs, and `tw4_price_set` never forbade them.
- An administrator counts as active when the role is held and the auth user is neither banned nor soft-deleted (`deleted_at`).
