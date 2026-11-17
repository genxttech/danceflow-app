# Student change proposal: read tickets through a restricted dancer-facing shape

Status: **PROPOSAL, not implemented, not for merge.** 2026-11-17. Student side only; the database side belongs to the owner decision on studio-sold internal columns and to a SQL PR by whoever owns that domain.

## Why

The Student app reads `event_registrations` directly under the buyer's own row policy (`user_id = auth.uid()`, plus rows linked by `claim_my_event_registrations()`). A buyer can therefore read every column of their own registration, including columns written by studio staff for internal use. Once studio-sold registrations (source `admin`) become visible to the buyer, the question is which of those columns a dancer may see. The cleanest answer is that the app never selects them, and that the database does not return them either.

## What the Student app reads today (from code, main c47e3ae17)

`event_registrations`, via `registrationSelect()` in `src/lib/studentWallet.ts:381`, used by three queries (by client link `:434`, by user id `:459`, by exact email `:479`):

| Column | Used for |
|---|---|
| `id`, `studio_id`, `event_id` | identity, studio name lookup, event link |
| `status`, `payment_status` | ticket state and payment wording |
| `quantity` | admits count |
| `total_amount`, `total_price` | amount shown (falls back from one to the other) |
| `ticket_type_id` through `event_ticket_types ( attendees_per_ticket )` | admits per ticket |
| `events ( id, name, slug, start_date, start_time, venue_name, city, state )` | event card |

Filters and ordering the queries also rely on: `client_id` (in the client-link query), `attendee_email` (in the email query), `user_id`, `status in (...)`, `created_at desc`, `limit 20`.

`event_registration_attendees` (`src/lib/studentWallet.ts:758`): `id, registration_id, event_id, first_name, last_name, email, sort_order, checked_in_at, waiver_signed_at, ticket_code, ticket_issued_at`.

Also in the app: `src/lib/publicDiscovery.ts:387-392` reads `event_registrations` (`ticket_type_id, quantity`, joined `event_ticket_types` and `event_orders!inner`) to count admissions for capacity. That is a different need (aggregate counts, any buyer) and should not be served by the dancer-facing shape; it should become a count function, see "Out of scope".

## Columns the app never selects and a dancer should not receive

From the studio sell-tickets insert (`src/app/app/events/sell-tickets/actions.ts:577`): `notes` (staff text, contains the staff user id and payment method), `registration_source` and `source`, `unit_price` and `currency` (staff pricing; the app uses totals), `attendee_phone`, `terminal_hold_until`, `stripe_checkout_session_id`, `stripe_payment_intent_id`, `client_id` as a value (the app filters on it but does not display it), and any staff or organizer-only columns added later.

## Proposed shape

A database view or function that returns exactly the columns in the first table (plus `created_at` for ordering), restricted to rows the caller owns (`user_id = auth.uid()`), for example `public.student_my_event_registrations()` (security invoker or definer with an `auth.uid()` filter, authenticated only) and the same for attendees (`student_my_event_registration_attendees(registration_ids)`), with direct table `select` left to staff policies only. The by-client and by-email lookups disappear once the claim function links the rows (email) and the client link flow sets `user_id`; the client-link query stays only if the owner wants studio-sold rows visible before an email match (Option C in `docs/events/event-registration-student-visibility-proposal.md`).

## Student change (small, once the database shape exists)

1. `src/lib/studentWallet.ts`: replace the three `from("event_registrations")` reads with one `rpc("student_my_event_registrations")`, mapping the same fields; keep `registrationToWallet` unchanged (it already reads only the columns in the table). Replace the attendees read the same way.
2. Tests: keep `walletTicketsByUser.test.ts` semantics (rows found by user id, deduped); add a test that the mapped object carries none of the internal columns and that the select/rpc argument list equals the table above.
3. Harness: `scripts/qa-smoke` scenario `--claim` already seeds studio-sold (`admin`) rows and asserts what the dancer sees; add an assertion that a direct `select notes` on the table, as Dana, is refused once the SQL lands (`--api-check`).
4. Deploy order: SQL first, then the app (a Student build that calls a missing function must degrade to the old read; keep the old read as a fallback for one release if the SQL may lag).

## Decisions needed from the owner

1. Is `notes` ever meant to be shown to the dancer (for example a studio message with the ticket)? Proposed: no, never.
2. Do studio-sold tickets appear only after email claim, or also by client link (Option C)?
3. Is `total_amount` the single amount field going forward (drops the `total_price` fallback)?

## Out of scope here

The capacity counts in `publicDiscovery.ts` (needs a count function over all buyers, not the dancer-facing shape), any web change, and any SQL. Nothing in this proposal is applied or merged.
