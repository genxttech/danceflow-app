# Proposal: column-restricted read of a dancer's own event registrations (Rule 3)

Status: **PROPOSAL ONLY. No migration, no code.** 2026-11-17. Follows PR #604 (claim function) and its verification note: a claimed studio-sold row
exposes **every column** to its owner on a direct query, including studio-internal `notes` and `client_id`.

## 1. The problem [V = verified in code or read-only on PROD]
- `event_registrations_self_select` is `(user_id = auth.uid())` for role `public` [V on PROD and DEV]. It is row-level: the owner may `select *`.
- Studio-sold tickets (`registration_source = 'admin'`, written only by `src/app/app/events/sell-tickets/actions.ts:596`) carry studio-internal text in `notes`
  (the code writes "Manual ticket sale created from workspace by user <staff user id>. Payment method: ..." and staff may add free text) and a `client_id` [V code]. Public-cart and
  Student-app rows carry the buyer's own `buyerNotes` and `client_id = null` [V code], so the exposure concerns admin-sold rows.
- PROD today: 37 registrations, **0 owned**, 11 admin-sold [V]. So nothing is exposed yet and a decision now costs no history.
- The shipped readers select explicit, non-sensitive columns (Student `registrationSelect()`: id, studio_id, event_id, status, payment_status, quantity, totals, joined event/ticket
  columns; web `/account`: id, event_id, status, created_at) [V code]. The exposure is only to someone who queries PostgREST directly with their own JWT. It is the same for tickets
  a person bought in the Student app today.
- Constraint: the attendee read policy is derived from the registration (`er.user_id = auth.uid() or er.portal_user_id = auth.uid()`, via a subquery on `event_registrations`, which is
  itself subject to RLS) [V `20260423_security_rls_lockdown.sql:411`]. Dropping `self_select` would silently remove attendee/ticket-code access.

## 2. Options

### (a) Explicit-column read for dancers (the real fix)
Add `public.my_event_registrations()` (SECURITY DEFINER, no params, `search_path=''`, `where user_id = auth.uid()`, returns only dancer-safe columns plus joined event/ticket fields), or an equivalent
view, then move web `/account`, the Student wallet and the student order endpoints to it, then in a later slice drop `event_registrations_self_select` and rewrite the attendee
policy to not depend on it.
- Note: a plain `security_invoker` view does **not** restrict columns on its own: it still runs under the base table's `self_select`, and a direct `select *` on the base table stays open. Column-level
  REVOKE on the base table is not usable either (staff reach the same table as the same `authenticated` role). Only a definer function/view **plus removing the base self policy** closes it.
- Work: migration(s) in the protected block `src/lib/supabase/migrations/` (CODEOWNERS: owner approval on the exact head), edits in `src/app/account`, `mobile/student/src/lib/studentWallet.ts`
  (Student session), student order endpoints, account export/deletion, and a policy rewrite for attendees with its own regression suite (ticket codes). Also `/events/[slug]` readers that use the self policy.
- Pros: closes the exposure for every channel including app-bought rows. Cons: largest slice; touches RLS on a hot table; needs a coordinated app change.

### (b) Interim: the claim excludes studio-sold rows
Change the claim predicate to also require `registration_source <> 'admin'` (or `is distinct from 'admin'`). Ship as a replacement of `claim_my_event_registrations()`.
Since **no hosted database has the function yet** (PROD/DEV preflight: absent) the owner may choose to (i) amend the function in a new migration `20270221092000...` applied after the
original (three files to apply, history stays append-only; recommended) or (ii) edit the merged file before its first hosted apply (needs a new sha and re-approval).
- Pros: tiny, reversible, removes the exposure at the source before any row is owned; PROD cost of waiting is zero (0 owned rows).
- Cons: studio-sold tickets (11 of 37 on PROD) never show in the dancer's wallet until (a) ships; guest-bought tickets are unaffected. A row already claimed stays claimed (none on PROD).

### (c) Accept the exposure and ship
Row-level policy as is. Cons: studio-internal notes/client link visible to the ticket owner on direct queries; it conflicts with the product rule that buyers see only buyer-safe data.

## 3. Recommendation
Do **(b) now** (before the first PROD apply) and **(a) as the follow-up slice**; when (a) ships, lift the (b) filter so studio-sold tickets appear. Tests for (b): SQL suite adds an admin-sold row for a
verified user and proves it stays unowned while a public-cart row is claimed; vitest pins the predicate; rollback restores the original body.

## 4. Release / governance notes
- All SQL goes in the protected migrations path: PR needs the owner's approval on the head; apply order SQL first; Git-only until authorized (see `event-registration-claim-release-package.md`).
- Migration block: next free after `20270221091000` is `20270221092000` (verify against main at PR time). (a) needs several files; keep rollbacks and a disposable-stack suite.
- Student changes (a) are a separate session/PR (`mobile/student`); web changes here.

## 5. The one decision for the owner
**Should studio-sold (admin) tickets be left out of the claim until a column-restricted read exists? (recommended: yes, option (b) now, option (a) next).**
