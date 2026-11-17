# Student claim-flow device QA plan (claim_my_event_registrations)

Status: PLAN, nothing run. The device run needs the claim migration (SQL PR 604, `20270221090000`, head may still change) applied to a throwaway iso-qa stack, plus the draft app PR 603. Rows not run stay BLOCKED, not PASSED.

## What the function does (from SQL PR 604, head 169e44d5)

- `claim_my_event_registrations()` takes no arguments, returns an integer, executes for `authenticated` only.
- The user is `auth.uid()`; the email comes only from `my_verified_email()` (bound, live session, newer than the last email change). No verified email: returns 0 and changes nothing.
- It sets `event_registrations.user_id` where `user_id IS NULL` and the **registration buyer's** `attendee_email` equals the verified email (lower-cased, trimmed). It never reads guest attendee emails in `event_registration_attendees`, never takes a row that has a `user_id`, and never touches clients, links, leads, notifications, marketing, payments or orders.

## What the app does (PR 603)

Once per signed-in user per app run (shared by the Wallet tab and the tickets screen), only for a user with a confirmed email, it calls the function with no arguments. Any error, including the function missing, is silent: no message, no retry, no blocked load. If the count is above 0 the screen reloads its tickets. The call shows no text, so no wording rules apply; failures of the ticket load itself still go through `friendlyMessage`/`failureMessage`.

## Seed (`mobile/student/scripts/qa-smoke/seed-claim.sql`)

Applied after `seed.sql` and `seed-event.sql`, with `-v uid` (Dana, `dana.dancer@example.test`) and `-v uid2` (Evan, a second dancer, `evan.other@example.test`, created like Dana through the GoTrue admin API with `email_confirm: true`). `seed-event.sql`'s own registration (`QA-DANA-0001`, already owned by Dana) is the control that must not change.

| Row | Registration | Buyer email | `user_id` | Ticket code | Case |
|---|---|---|---|---|---|
| c1 | `...662` | `  Dana.Dancer@Example.TEST ` (capitals, spaces) | null | QA-CLAIM-0001 | public web cart, normalisation |
| c2 | `...663` | `dana.dancer@example.test` | null | QA-CLAIM-0002 | studio sell-tickets, "Spectator" ticket type |
| c3 | `...664` | `evan.other@example.test` (purchaser Evan) | null | QA-GIFT-0003 | GIFT: the ticket's attendee is Dana |
| c4 | `...665` | `dana.dancer@example.test` | Evan | QA-OWNED-0004 | already owned by another account |
| c5 | `...666` | `nobody@example.test` | null | QA-NOBODY-0005 | belongs to nobody |

Notes: `registration_source` is CHECK-limited to public_event_page, admin, import, organizer_portal, other, so c2 (studio-sold) uses `admin` and c5 uses `other`. The Spectator ticket type uses ticket_kind `spectator`.

## Cases and expected results

| # | Case | Steps | Expected on screen and in the database |
|---|---|---|---|
| 1 | Dana, verified email, first open of Wallet after sign-in | Sign in as Dana, open Wallet, then Wallet > event tickets | The function returns 2. Tickets list shows 3 passes: QA-DANA-0001, QA-CLAIM-0001, QA-CLAIM-0002. DB: c1 and c2 have `user_id` = Dana. No error text at any point. |
| 2 | Gift | Same session | QA-GIFT-0003 is NOT shown to Dana (the buyer is Evan; guest attendee email is ignored). c3 `user_id` still null until Evan claims. |
| 3 | Owned by another account | Same session | QA-OWNED-0004 NOT shown; c4 still Evan's. |
| 4 | Nobody's row | Same session | QA-NOBODY-0005 NOT shown; c5 `user_id` still null. |
| 5 | Evan, different email, signs in on the same stack | Sign in as Evan, open the tickets screen | Returns 1 (c3). Tickets: QA-GIFT-0003 (holder named Dana, he bought it) and QA-OWNED-0004. NONE of Dana's passes (QA-DANA-0001, QA-CLAIM-0001/0002). c3 `user_id` = Evan. |
| 6 | Once per run | After case 1 reopen Wallet, switch tabs, pull to refresh | The function is not called again in this app run (count calls in the PostgREST/Kong log: exactly 1 per user per run). A cold restart may call it again and must return 0 with no visible change. |
| 7 | Idempotence | Second call as Dana by psql after case 1 | Returns 0; no row changes. |
| 8 | Unverified or unbound email | Dana's first-ever sign-in before binding a password (first proof returns `binding_required`) or a user whose email is not confirmed | The function returns 0 (database) or is not called (app pre-check on `email_confirmed_at`); tickets screen behaves as before the change: only rows already owned. No error text. A user with an unconfirmed email cannot sign in through the app's magic link, so the unconfirmed case is proven by jest and the SQL test; on device only the unbound case is reachable. State which one was run. |
| 9 | Function missing | Run the app against a stack WITHOUT the claim migration | No error banner, no retry loop (one failed call per user per run, then none), wallet and tickets load normally with only owned rows. |
| 10 | Offline | Airplane mode, then Wallet | Wallet shows the offline state through `friendlyMessage`; the claim fails silently; nothing about claiming is shown. After reconnecting and a manual refresh the claim is NOT retried in this run (accepted: next app run). |
| 11 | Accessibility | Case 1 at font 1.0 and 2.0, light and dark | The 3 passes are named stops with the code spelled out; 0 unlabelled controls (`a11y-audit.mjs`). |

## What must NOT change (check by SQL before and after)

- `event_registrations` rows c3, c4 (owner), c5 keep their `user_id` after Dana's run; the control `66666666-...661` unchanged.
- `clients`, `client_account_links`, `leads`, `notifications`, `payments`, `event_orders`/order tables: row counts identical before and after (snapshot with `select count(*)` per table).
- `event_registration_attendees`: no row changes.
- No new text anywhere in the app that mentions claiming, linking or verifying.

## Run mechanics (when the slot is assigned)

1. Check docker, java and adb are clear (shared PC rules), one stack, `--no-daemon`.
2. `node scripts/qa/iso-qa.mjs up main --name <n> --auth`, apply the claim migration from the PR 604 head you are testing (record its SHA in the report), then run the harness with `--events`; apply `seed-claim.sql` with both user ids. `run.mjs` does not yet create Evan or apply `seed-claim.sql`: add a `--claim` flag in the same style as `--events` at the start of the run (second admin user, `-v uid2`, extra screens), and let the first run prove it.
3. Capture the Kong/PostgREST request log for the call count (case 6) and the before/after SQL snapshots.
4. Tear everything down and message the coordinator and the next session.

## Open points for the owner or web

- Gift recipients never see a gifted ticket (by design in the SQL); product to confirm that is acceptable or whether the guest attendee email should also match.
- A signed-in user whose registration email differs from their account email (typed a different address at checkout) is not covered by this flow.
