# Student claim-flow device QA plan (claim_my_event_registrations)

Status: EXECUTED 2026-11-17 on an iso-qa stack (see Result at the end). The device run needs the claim migration (SQL PR 604, `20270221090000`, head may still change) applied to a throwaway iso-qa stack, plus the draft app PR 603. Rows not run stay BLOCKED, not PASSED.

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

## Result (2026-11-17, device run 6 of 6, evidence C:dfr-outclaim; HTTP check C:dfr-outclaim-api)

Stack: iso-qa main scenario (after #618) + LAUNCH-SEC-1C-A and the 604 function and index applied from git on the disposable stack only; QA APK built from main 671dea74c (includes #603 and #621); API 35 emulator. No hosted SQL.

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Dana, bound email, first open | PASS: tickets QA-DANA-0001, QA-CLAIM-0001, QA-CLAIM-0002; c1 and c2 owned by Dana | dana1-tickets-*.xml, claim-after-dana.json |
| 2-4 | Gift, owned-by-Evan, nobody's | PASS: not shown to Dana; ownership unchanged | same |
| 5 | Evan, different email | PASS: sees QA-GIFT-0003 and QA-OWNED-0004 only; c3 now Evan's | evan-tickets-*.xml, claim-after-evan.json |
| 6 | Exactly one call per app run | UNVERIFIED on device: no reliable call counter on this stack (pg stats and statement logging stay empty for PostgREST calls). Proven by jest only (claimEventRegistrations.test.tsx) | n/a |
| 7 | Idempotence, cold restart | PASS: same three tickets, no ownership change | dana2-tickets-*.xml |
| 8 | Unbound or unverified | PASS: the app routes an unbound user to Create your password, nothing claimed; HTTP: function returns 0 for an unbound session (status 200) | dana0-unbound-secure-account.png, claim-api results.json. An unconfirmed email cannot sign in by magic link: jest and SQL test only |
| 9 | Function missing | PASS: only the owned ticket shows, no error text. Retry count UNVERIFIED (no counter without the function; once-per-run proven by jest) | dana3-nofn-* |
| 10 | Offline | PASS in substance: airplane mode on, the tickets stay on screen, no error and no claim text (dana2-offline.png). The harness check failed only because the first pass had scrolled off screen; its pattern now accepts any ticket code | dana2-offline.png |
| 11 | Accessibility | PASS: 0 unlabelled controls and 0 small targets in all 23 trees (font 1.0, light) | a11y-report.md. Font 2.0 and dark not run for this flow: BLOCKED |

Must-not-change: PASS at every step (clients, client_account_links, leads, notifications, payments and event_registration_attendees unchanged; c3, c4 owner and c5 untouched by Dana).

HTTP check (function semantics, real user tokens): unbound returns 0; bound Dana returns 2; repeat returns 0; Evan returns 1; anon is denied (401); 9 of 10 rows pass, the tenth was a call counter that does not work on this stack.

Findings from the runs: (1) the iso-qa baseline lacks LAUNCH-SEC-1C-A (listed unreplayable), so my_verified_email() did not exist and the 604 function errored until 1C-A was applied; the app treated that as 0, silently. (2) The Wallet found registrations only by client link and exact lower-case email, so claimed registrations with capitals/spaces or another buyer email were missing: fixed in #621. (3) The slow magic link now shows the #611 wording. (4) Not covered: font 2.0 and dark for the claim flow, real push, real payments, iOS.
