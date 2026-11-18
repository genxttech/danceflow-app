# Student app and the column-restricted dancer read (PR 647 / 648) — compatibility note

Status: DRAFT, Git only. Nothing is applied anywhere. The Student change below must NOT be merged until the SQL views are applied on PROD (see "Order").

## What the Student app changes (this draft PR)
- `studentWallet.ts` reads event registrations from `my_event_registrations` and tickets from `my_event_registration_attendees` (were the base tables). The select lists already use only columns the views expose; a jest test pins that (no `client_id`, `notes`, Stripe ids, `registration_source`, `ticket_token`, `checked_in_by`), that the embeds `events(...)` and `event_ticket_types(...)` are still requested, and that the base tables are never read.
- The wallet's registrations-by-`client_id` read is removed. `client_id` is not a view column, and the read could only ever return the account's own rows anyway (the only dancer policy was `user_id = auth.uid()`), so it is covered by the by-user read. The by-email read stays (the views expose `attendee_email`); on the views it can only return the account's own rows.
- QA harness: `--claim` now applies the plain index `20270222091000` (replaces the retired CONCURRENTLY file) and the views `20270222092000` from the PR 647 ref; `--cutover` also applies `20270222093000`. NOT RUN yet: validating the new stack steps and the embeds through the views over HTTP/device waits for a slot and for 647 on main (BLOCKED, not passed).

## Installed builds that still read the base tables
When the cutover (Gate 2: `20270222093000`) is applied, an installed Student build that still reads `event_registrations` / `event_registration_attendees` directly gets **zero rows from both** (RLS with no dancer policy returns an empty result, not an error):
- Wallet: event tickets and the event registrations list disappear (the by-user, by-email and by-client reads all return empty; the wallet itself, memberships, packages, payments, rewards, digital purchases are unaffected). The by-client read, which still filters `client_id`, also returns empty rather than failing on the base table.
- Tickets screen (`wallet/event-tickets`, ticket QR) shows no tickets. The claim function still runs and still links rows, but the dancer cannot read them back.
- Event capacity counts (`publicDiscovery.ts`) are already own-rows-only today and become empty (see below).
- Nothing crashes, there is no error banner: the tickets are simply missing. A dancer at the door could not show a ticket from an old build.
- Gate 1 (the views, additive) breaks nothing: old builds keep reading the base tables through the existing dancer policy.

## Safest order
1. Gate 1: the claim function, exclusion, plain index and the views (additive, nothing removed).
2. Release the readers: web (PR 648) and a new Student build that reads the views. Confirm the build is in users' hands (or confirm the old build was never distributed) and has been seen reading the views.
3. Only then Gate 2, the cutover. Roll back with the cutover rollback first.
4. Merge of this Student PR happens after step 1 is applied on PROD, never before (a build made from main earlier would read views that do not exist yet and show no tickets).

## `publicDiscovery.ts` ticket capacity counts: options (behavior unchanged for now)
`loadTicketAdmissionCounts` reads ALL registrations per ticket type as the signed-in user. With the dancer policy `user_id = auth.uid()` it only ever counted the dancer's own rows, so "N spots left" has been over-stated for everyone (and "Sold out" can never show). After the cutover it counts nothing. The server still enforces capacity in the checkout route, so nothing oversells; the screen only mis-states availability. I could not confirm whether any other policy exposes public counts (no hosted access); the web event page uses the same user-scoped client.
Options:
- (A) Web API aggregate: `GET /api/student/events/[eventId]/availability` computing admission counts with the service role (same rule the checkout route applies), called through `danceflowApiFetch`. No SQL, no migration gate; needs a web deploy before the Student build that uses it. Recommended.
- (B) A SECURITY DEFINER aggregate RPC `public_event_ticket_admission_counts(ticket_type_ids)` returning counts only. Needs a migration (protected path, owner gate).
- (C) Stop showing the count and let checkout say "Only N spots remain" (already returned by the checkout route). No server change; loses the pre-checkout hint and "Sold out".
DECIDED 2026-11-18: option A. The route GET /api/student/events/{eventId}/availability is on main (PR 650) and publicDiscovery uses it (PR 651, merged c32e4f340): no count, never a guess, on no session/401/404/429/500/offline/malformed. Independent of the views cutover.
