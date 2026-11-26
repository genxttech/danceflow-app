# Student app: registered-event access for dancers (design proposal, no SQL, no code)

2026-11-21, main `65edc13aa`. Proposal only. No SQL is written or applied; nothing hosted is touched. The owner decides the SQL slice after reading section 4.

## 1. The two gaps (both pre-existing, both seen on a disposable stack)

Evidence: `C:\dfr-out\qa-past-registrations\run1` and `run2` (seed `mobile/student/scripts/qa-smoke/seed-past-registrations.sql`, scenario `run.mjs --past-registrations`).

**Gap 1: the event of a registration comes back empty.** The Wallet reads registrations from the dancer view `my_event_registrations` with an `events(...)` embed (`mobile/student/src/lib/studentWallet.ts`). The view runs with its owner's rights, but the embedded `events` row is read as the signed-in dancer, so the **events table's own row security applies**. For an ended event with `visibility = 'private'` that the dancer registered for, the embed returned nothing: the card reads **"Event / Not set"**, status CONFIRMED, under *Upcoming*, and with no end date it can never move to *Past*. Public events (even with `public_directory_enabled = false`) resolved normally. The events table's SELECT policy text is **not in this repository** (the baseline schema is outside `src/lib/supabase/migrations`); what is stated here is the observed behaviour. The exact policy must be read from `pg_policies` on a disposable stack before any slice is built (UNVERIFIED).

**Gap 2: an unlisted registered event is a dead-end tap.** `getPublicEventDetailForMobile` (`publicDiscovery.ts`) loads the event through the public directory query, which requires `public_directory_enabled = true` and status `published` or `open`. For an event the dancer registered for that is **not** in the directory, tapping its card shows "Event unavailable / This event could not be found" (run 2, `pr-ended-detail.xml`). This is true for **upcoming** registered events too, not only ended ones.

## 2. What the screens need from an event

Today the registration cards and the history list use: `id, name, slug, start_date, start_time, end_date, end_time, timezone, venue_name, city, state`. The ended/not-ended decision needs only `start_date, start_time, end_date, end_time, timezone`. The detail screen needs more (description, ticket types, required documents) and is covered in section 5.

Fields that must **not** reach a dancer through any option: draft or unpublished content, internal notes, organizer or contact data, Stripe or pricing configuration, capacity settings, anything about other registrants.

## 3. Options for gap 1

| | A. Add event-summary columns to the existing view | B. A narrow RLS SELECT policy on `events` for registrants | C. A SECURITY DEFINER function returning an event summary by registration id |
|---|---|---|---|
| Idea | `my_event_registrations` gains a left join to `events` (owner rights) and appends `event_name, event_slug, event_start_date, event_start_time, event_end_date, event_end_time, event_timezone, event_venue_name, event_city, event_state, event_status` | Policy `using (exists (select 1 from event_registrations er where er.event_id = events.id and er.user_id = auth.uid()))` | `my_event_summaries(registration_ids uuid[])` returns those same fields |
| Exact exposure | Only the listed fields, only for events the dancer holds a registration for (the view's existing `er.user_id = auth.uid()` filter) | **Every column of the events row**, for those events (the dancer role cannot be column-restricted: dancers and staff share the `authenticated` role, the same reason the dancer views exist) | Only the listed fields, for registrations the caller owns (the function checks `auth.uid()`) |
| Tenancy and safety | Same boundary as the views already accepted for Gate 2; no new table access; no cross-studio or cross-dancer path | Widest surface; a policy that reads `event_registrations` from `events` can recurse with policies that read `events` from `event_registrations` (needs a security-definer helper to be safe); the column set is whatever the events table grows into | One new executable function (new grant surface to review); an unfiltered or mistyped input must return nothing; second round trip from the app |
| Migration | One `create or replace view` that appends columns at the end (the only change Postgres allows without dropping the view); grants are kept; `notify pgrst, 'reload schema'` | One `create policy` (+ helper function if recursion is a risk) | `create function`, revoke from public/anon, grant execute to authenticated |
| Rollback | A view cannot lose columns with `create or replace`: either leave the extra columns (harmless, unused) or drop and recreate the old view with its grants (short window with no view; the cutover rollback order is unaffected) | `drop policy` | `drop function` |
| SQL tests (disposable stack) | (1) a dancer sees the summary of their own registration to a private, a public-unlisted and a public event; (2) another dancer sees none of it; (3) anon cannot read the view; (4) no column outside the list exists (column-list assertion); (5) an event that becomes draft/cancelled after registration still returns status, not content; (6) the existing view columns and embeds are byte-for-byte unchanged | (1) registrant can read the events row; (2) non-registrant still cannot read a private event; (3) staff and organizer reads unchanged; (4) no policy recursion on events and event_registrations in either direction | (1) own registrations resolve; (2) foreign ids and null return nothing; (3) anon and public have no execute; (4) result column list |
| Web readers and old Student builds | Unaffected: new columns are appended and no existing column changes; any reader selecting named columns keeps working (a `select *` reader would gain columns: none was found in `src` on main) | Unaffected, but web staff screens now also see the policy | Unaffected |
| Gate 2 (the pending cutover drops the direct dancer policies on `event_registrations` / `event_registration_attendees`) | Independent. Apply either before or after Gate 2. SQL goes before the app that reads the new columns | Independent, but a new policy that reads `event_registrations` would have to keep working after the cutover removes the dancer policy on that table (it must not rely on it) | Independent |

## 4. Recommendation for gap 1: option A

It keeps the model already accepted for Gate 2 (a dancer reads their own rows through owner-rights, security-barrier views with an explicit column list), exposes the minimum fields, adds no policy and no executable object, and is additive for every existing reader. Option B is not recommended: it exposes the whole events row and brings the recursion risk. Option C is acceptable but adds a grant and a second request for no extra protection.

If the owner approves A, the slice is: (1) one migration appending the event-summary columns to `my_event_registrations`, with a rollback note and the SQL tests above; applied to a disposable stack first, then DEV, then PROD under the usual gates; (2) Student reads the flat columns **first** and falls back to the embed when they are absent, so the app works before and after the SQL; (3) the `--past-registrations` scenario's private probe flips from "Event / Not set under Upcoming" to a named card in Past. Approximate size: one small migration plus about half a day of Student work and tests. Not started.

Until then the gap stays as it is today (private events are rare; the card is a generic "Event" under Upcoming).

## 5. Gap 2: app-side fix (no SQL)

Proposal: the event detail for an event the dancer **holds a registration for** loads by id without requiring directory listing. Rules:

1. **When it applies:** only when the id is among the signed-in dancer's own registrations (the wallet already holds them), so a guessed id never opens an unlisted event.
2. **What it loads:** the same row fields the detail screen shows today (name, summary/description, schedule, venue) from `events` by id. Events the events-table policy already lets the dancer read (public, including unlisted-in-directory) work with no SQL; a **private** event additionally needs gap 1's summary and then shows a summary-only page (name, dates, venue, status) with the dancer's tickets link and no ticket-type or document sections.
3. **What stays hidden:** the register/checkout call to action is shown **only** when the event is actually public, in the directory, published or open, and not ended (`canRegister = directory && status in (published, open) && !ended`). A registered unlisted event therefore shows its details and the dancer's own tickets, never a register button. The checkout route still enforces everything server-side.
4. **Ticket types and required documents:** only for events that can be registered for (they are checkout inputs). For an ended or unlisted event the detail shows the dancer's own tickets (from the dancer views) instead.
5. **Ended state:** the existing "This event has ended" banner and disabled bottom action stay as they are (#700).

Tests: the loader with a registered unlisted event (loads, CTA hidden), an unregistered unlisted id (still "not found"), a registered private event with and without the summary, an ended unlisted event, the existing public paths unchanged. Device: the `--past-registrations` tap-through on an unlisted event (the seed fix `465a55520` currently makes the tapped events listed; it is UNVERIFIED and will be re-proven in the later clean run once a v2 build exists). Size: about half a day of Student work, no server change.

## 6. Decisions for the owner

1. Option A, B or C for gap 1, or accept the generic "Event" card for private events.
2. Whether registered-but-unlisted events should open a read-only detail page (section 5), and whether the register button must stay hidden for them (recommended: hidden).
3. Whether to bundle gap 1's SQL with the Gate 2 sequence or ship it separately (recommended: separately, additive, no ordering constraint with Gate 2).
4. Someone must read the events table's SELECT policies on a disposable stack before the slice is designed in detail (this repository does not contain them).
