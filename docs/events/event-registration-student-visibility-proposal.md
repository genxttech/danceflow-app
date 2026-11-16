# Proposal: make a buyer's own event registrations and tickets visible to them (guest, studio-created, spectator/vendor/other)

Status: **PROPOSAL ONLY. Read-only investigation; no code, migration or policy change in this PR.** 2026-11-16.
Question from the APPS coordinator: the Student app reads Event/Ticket data by `attendee_email` and `client_id`, but RLS only lets a
buyer read a registration when `event_registrations.user_id = auth.uid()`. Which registrations never satisfy that, why, and what is
the smallest safe fix?

Verified against `main` 9448fabb8 and the live tree `C:\dwr` @ 447d9b854 (read-only). Facts below are from code and migrations; the
RLS policy list for `event_registrations` itself is **not defined in any repo migration** (it comes from the pre-repo baseline), so it
is taken from the coordinator's throwaway-stack device run and from `docs/mobile/Student_App_P0_Release.md` ("only staff/organizer
policies plus `event_registrations_self_select` (`user_id = auth.uid()`). No public or guest read", same on DEV and PROD). The
attendee policy text is in `20260423_security_rls_lockdown.sql:411`.

---------------------------------------------------------------------------------------------------------------------

## 1. Where `user_id` is (and is not) set

| Creation path | File | `user_id` | `client_id` | Buyer sees it? |
|---|---|---|---|---|
| Student app checkout (signed-in app user) | `src/app/api/student/events/[eventId]/checkout/route.ts:847` | `user.id` | not set | **Yes** |
| Public web cart checkout (anonymous **or** signed in) | `src/app/api/events/cart/checkout/route.ts:956` | hard-coded `null` | `null` | **No** |
| Studio "sell tickets" / terminal sale | `src/app/app/events/sell-tickets/actions.ts:584` | hard-coded `null` | the chosen client or `null` | **No** |
| Competition registration RPCs (10C/10C.4/10C.5) | `20261109090000…`, `20261110090000…`, `20261115090000…` | `p_actor_user_id` | actor's client | Yes |
| Synthetic/test data | `src/lib/synthetic/suites/events.ts` | n/a | | n/a |

- Live (`C:\dwr`) is identical on all three call sites (cart `:956 null`, student `:847 user.id`, sell-tickets `:584 null`).
- `event_registration_attendees` has **no** `portal_user_id`. The coordinator's note about an "attendee row's `portal_user_id`" is really the
  attendee policy's second branch `er.portal_user_id = auth.uid()` on **`event_registrations.portal_user_id`**, a legacy column. **No code
  in main or live writes it** (only the RLS text and the H2-B2 migration comment mention it), so in practice only `user_id` ever grants
  access. The attendee `self_select` policy is derived from the registration (`er.user_id = auth.uid() or er.portal_user_id = auth.uid()`),
  so tickets follow the registration row.
- Other readers use the same key: `src/app/account/page.tsx:747-749` (`.eq("user_id", user.id)`), account export/deletion
  (`student-identity/account-data.ts`), the order endpoint `…/events/orders/[orderId]/route.ts`.

## 2. Is a guest registration ever linked later? **No.**

- Nothing in main or live ever **sets** `event_registrations.user_id` after creation. The only later write is
  `student-identity/account-controls.ts:205`, which **nulls** it on account deletion (history preservation).
- The verified-email machinery (LAUNCH-SEC-1C-A/B: `my_verified_email()`, `verified_email_for_user()`, `claim_client_account_invitation`,
  `getMyVerifiedEmail`) is used to link a **client** to an account via `client_account_links` (studio invitation / email match), never
  registrations. And even a fully linked client does **not** unlock the client's registrations: there is no client-link policy on
  `event_registrations` (H2-B2 converted only the `clients.portal_user_id` policies).
- Result, for the Student app: `loadRegistrationsByClient` (client_id + studio) and `loadRegistrationsByEmail` (attendee_email) are both
  filtered by RLS down to rows with `user_id = me`, i.e. **only tickets the user bought inside the app**. Invisible: web cart purchases
  made as a guest or while signed in (the cart route ignores the session), studio-sold tickets (even for the linked client), spectator /
  vendor / staff / table / pass / other tickets bought as a guest, and anything bought before the account existed. This also affects the
  web `/account` page. It is independent of G-02 (a lead is not required to own a ticket).
- Secondary finding: `…/events/orders/[orderId]/route.ts` authorises with `sameStudentEmail(user, buyerEmail)`, a plain **unverified**
  auth-email comparison, not `my_verified_email()`. Out of scope here, but anything new must not copy that pattern.

---------------------------------------------------------------------------------------------------------------------

## 3. Fix options

### Option A -- verified-email claim that sets `user_id` (recommended)
A `SECURITY DEFINER` function the signed-in user calls on their own session, e.g. `public.claim_my_event_registrations()`:
- derives the email **only** from `public.my_verified_email()` (bound proof, live session, newer than the last email change; null => returns 0);
- `update public.event_registrations set user_id = auth.uid() where user_id is null and lower(btrim(attendee_email)) = <verified email>`
  (optionally only `payment_status in ('paid','pending')` and any status the app lists; cancelled/refunded rows may be claimed too so history
  is consistent -- decision D3);
- takes **no user id or email parameter** (no IDOR/spoofing), `grant execute to authenticated`, `revoke from public, anon`;
- idempotent; returns the number claimed; never touches `clients`, `client_account_links`, leads, notifications or marketing data.
Callers: Student app wallet load and web `/account` (best effort, once per session/launch); optionally the sign-in/verification step.
Why smallest/safe: no RLS change (existing `self_select` then applies, tickets follow via the attendee policy), no new read surface, uses the
1C proof exactly as the invitation claim does, tenant isolation unchanged (a user only ever gains rows carrying **their own verified
email**, whichever studio sold them), fully reversible, and trivially testable.
- Migration: the function (Git-only, SQL before app) + a partial index
  `event_registrations (lower(btrim(attendee_email))) where user_id is null` (separate `CONCURRENTLY` migration per repo convention; today
  there is no `attendee_email` index, so even the Student app's current by-email query seq-scans).
- Edge cases: mixed-case/whitespace emails (normalised in the predicate; stored values are already lower-cased by cart/sell-tickets/student
  paths); a user whose email changes (only the **current verified** email claims; earlier claimed rows stay); two accounts cannot share an email;
  account deletion nulls `user_id`, a later re-signup can re-claim (history preserved, consistent with deletion intent -- decision D6);
  guest attendees (index > 0 have no email) are **not** claimable and stay with the buyer; organizer-hosted event registrations are claimable too
  (the buyer's own ticket); the PAY-WH-1 direct-write guards apply to client roles only and a definer function is unaffected (to be proven in
  the SQL suite); a shared/family mailbox claims every ticket sent to it (inherent to email identity, same as the invitation claim).
- App changes (small, after SQL): call the RPC then reload the wallet; no query rewrites.

### Option B -- RLS self policy keyed to the verified email
`create policy event_registrations_verified_email_select … using (lower(attendee_email) = public.my_verified_email())` (+ the attendee twin).
- No data mutation and covers rows created later automatically.
- Cons: `my_verified_email()` joins `auth.sessions`/proof tables and would run in the policy for **every** `event_registrations` read by any
  authenticated role (permissive policies are OR-ed; evaluation order is not guaranteed), on a large, hot table; the H2-B2 migration documents
  the extra care needed for functions referenced by policies (EXECUTE for every role the policy is evaluated for, incl. anon); it widens the
  read surface from "rows I own" to "rows that mention my email" with no claim event, harder to audit/roll back; `user_id`-based features
  (account export/deletion, order endpoint) still would not see the rows. Not recommended as the first step.

### Option C -- client-link policy for studio-linked students
`event_registrations_client_link_select using (client_id is not null and public.user_has_client_portal_access(studio_id, client_id))` and the
attendee twin, following the H2-B2 pattern. Covers **studio-created registrations for a client the student is linked to** (the studio-vouched
relationship, no email involved) and is tenant-bound by `studio_id` + `client_id`. Does nothing for guests with no client. Reasonable as a
**second slice**, if the owner wants studio-sold tickets to appear before/without email claiming; needs the same performance care as Option B
(helper per row) and a check that `user_has_client_portal_access` grants only the intended link states.

### Option D -- set `user_id` at checkout when the session is verified (prospective only)
Public cart checkout: if the request carries a session whose `my_verified_email()` equals `buyerEmail`, write `user_id` instead of `null`;
studio sell-tickets: leave null. Prevents *new* orphans for signed-in web buyers but does not fix existing/guest ones. Complement to A.

### Recommendation
**Option A now** (verified-email claim, called by the apps), **D as a small follow-up**, **C only if the owner wants studio-sold tickets for
linked clients without email claiming**. B is not recommended.

## 4. Interactions
- **G-02 / Rule 1**: independent. Non-lead buyers (spectator, vendor, staff, ... or unflagged general admission) have no client; Option A keys
  on the verified email, never on a client/lead, so their tickets appear without creating leads, links or marketing consent. The claim must
  never write `clients`, `client_account_links` or any audience/consent table (a test pins this). Part B (marketing audiences) is unaffected:
  claiming does not make anyone a campaign recipient.
- **G-01 / G-01b**: marketplace entitlements already belong to `user_id` (a signed-in purchase), so nothing to claim there; guest marketplace
  orders have `client_id` NULL by design. The studio's purchase notification and entitlement flow are untouched.
- **PAY-WH-1 / settlement**: no change to settlement, outbox, payment rows; `user_id` is not part of any settlement guard.
- **Live (`release/website-embeds`)**: the 1C-A/1C-B functions the claim depends on exist on live; the claim function and the app calls need a
  backport. Apply SQL before app; an app calling a missing RPC must treat the error as "nothing claimed".

## 5. Tests (for the implementation PR)
SQL (disposable stack): verified vs unverified/unbound/expired-session user (0 rows); case/whitespace match; only `user_id IS NULL` rows;
never takes another user's `user_id`; other email untouched; two users, one email impossible; replay idempotent; claim then RLS read of
registration + attendees/ticket codes via the user's own session; no write to `clients`, `client_account_links`, `notifications`,
marketing tables; PAY-WH-1 guard unaffected; privileges (`anon` denied, `authenticated` allowed, no parameters); account-deletion null +
re-claim; rollback. Vitest: app wrapper treats RPC errors as zero; wallet reloads after a positive claim; no email/user id is ever
passed from the client. Device: Student wallet shows a guest-purchased spectator ticket after sign-in with the same verified email.

## 6. Decisions the owner must make
1. Adopt Option A (verified-email claim) as the fix? (recommended yes)
2. Also Option C (studio-linked clients see studio-sold registrations)? (recommended: later, only if wanted)
3. Which registrations may be claimed: all non-cancelled, or also cancelled/refunded history? (recommend all, so history is complete; the app filters status)
4. Claim only the registration buyer's email (recommended), never guest attendee names.
5. Where to trigger: Student wallet load + web `/account` (recommended) and/or at verification time.
6. After account deletion and re-signup with the same email: may old tickets be re-claimed? (recommend yes; they are the person's own)
7. Also do Option D (stamp `user_id` at web checkout when the session is verified)?
8. Release: SQL first, then app; backport to `release/website-embeds`.
