# Marketing M-0 — Email Compliance and Suppression Integrity

Status: implementation candidate (M-0A–M-0C) plus the final-audit remediation (A–D). The revised stage-1 SQL is applied to DEV (landing frozen); stage 2 and the application are not merged or released.
Scope comes from the owner decisions D1–D4 and implementation safeguards 1–10 (M-0 authorization, 2026-10-13).
M-0D (provider event ingestion) is planned below and is **not** part of this change.

## 1. What changed

### Send-attempt lifecycle (safeguards 2, 3, 4, 7)

Recipient rows (`marketing_campaign_recipients`, `organizer_marketing_campaign_recipients`) move through:

```
pending ──claim──▶ sending ──▶ sent | failed
                     │  └────▶ released (back to pending: provider said "not sent", e.g. rate limit / quota)
                     └─ uncertain: stays sending; the lease (600 s) expires; retried with the SAME idempotency key
possibly-delivered attempt (first_attempt_at set) > 23 h ago ──▶ delivery_unknown (never re-sent; counted as consumed for ENT-1)
```

- `marketing_claim_campaign_recipient` is the final eligibility check. It runs under a per-email advisory lock, which
  `marketing_unsubscribe_by_token` also takes, plus a row lock. Inside that check it re-reads the studio/organizer
  unsubscribe record, the platform suppression and the organizer contact status. Outcomes: `claimed`, `unsubscribed`,
  `suppressed`, `invalid`, `in_flight`, `delivery_unknown`, `not_claimable`, `not_found`.
- A suppression lookup or claim that errors stops the batch (fail closed). Nothing is sent without a successful claim.
- `marketing_complete_campaign_recipient` records the outcome only for the current claim id. A stale worker gets `stale`.
- Provider outcomes (`src/lib/marketing/compliance/provider.ts`):
  - `rejected` (validation) → failed.
  - `not_sent` (rate limit, quota, credentials, sender) → released, and the batch stops.
  - Anything else (5xx, network, idempotency conflict, unknown) → uncertain, retried with the same key `mkt-{kind}-{recipientId}`.
- **Exactly-once external delivery is not claimed.** Within Resend's idempotency window, a retry is de-duplicated by the provider. After 23 h the row becomes `delivery_unknown` and is never retried.
- `first_attempt_at` is cleared when a first attempt is definitively not sent (released). A set value therefore means an
  earlier attempt may have been delivered. Such a row keeps the 23-hour rule even after a later retry is released back to
  `pending`, and neither regenerate nor a tenant can delete it (independent review P2-1).
- ENT-1 usage is settled on `sent + delivery_unknown`, because an unknown outcome may have been delivered.
- A crash or function timeout (no `finally`) can leave a campaign in `sending`. It can be resumed through the normal Send
  action once it was last touched more than 15 minutes ago and no recipient holds a live claim
  (`isAbandonedSendingCampaign`). Every recipient still goes through the claim. Redirects inside the studio actions'
  `try` blocks are no longer swallowed as `send_failed` (C13).

### Recipient list generation (safeguard 2, C2)

`marketing_sync_campaign_recipients` replaces the client-side delete-and-reinsert:
- It deletes only never-mailed rows: pending, unsubscribed, skipped or suppressed, with no possibly-delivered attempt.
- It keeps sent, failed, sending and delivery_unknown rows, along with their unsubscribe tokens and evidence.
- It never re-adds an address that is already in the campaign.
- It refuses while any recipient is in flight, and refuses for locked (sending, sent, cancelled) campaigns.
- Suppression is decided in SQL.

### Unsubscribe (safeguards 1, 5, 6, C1)

- One endpoint for every token kind: `POST /api/email/unsubscribe/{token}`. It serves RFC 8058 one-click (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) and the confirmation-page form. `GET` only redirects to the confirmation page and never changes anything.
- The response is the same whether or not the token exists. It is rate-limited (30/min/IP) and returns 503 when the write fails, so mailbox providers retry.
- `marketing_unsubscribe_by_token` upserts by `(studio_id, lower(email))` / `(organizer_id, lower(email))`. That fixes the expression-index conflict that silently dropped organizer unsubscribes (C1).
- It keeps the first `unsubscribed_at`, counts repeat requests, and marks every pending row for that address in the scope. For organizers it also marks the contact unsubscribed.
- Studio staff and organizer users can no longer update or delete unsubscribe records. The RLS policies were dropped, the privileges revoked, and a guard trigger blocks the change even if a future grant reopens the table.
- They also cannot move an unsubscribed contact back to active (guard trigger).
- Per-message tokens for commercial ARIA/automation email live in `marketing_message_unsubscribe_tokens`.
- A client-role recipient insert always gets a fresh random token, so a copied token from another scope cannot capture
  that scope's unsubscribes (P2-3). Tokens are unique per table, and the resolver matches the canonical lowercase form
  through those indexes.
- A client role cannot delete a campaign that has mailed recipients. The cascade would remove the tokens in delivered
  emails and the ENT-1 evidence (P2-2).

### Platform suppression (D2)

`marketing_email_suppressions` holds platform-wide marketing suppressions (hard bounce, complaint). It is checked by every
claim and by the commercial dispatch path. It does not affect transactional email. It is populated manually for now, and by M-0D
once provider events are ingested.

### Test sends (D3)

`marketing_authorize_test_send` allows a test send only to a recipient that meets all of these:
- the address belongs to an `auth.users` account with a confirmed email;
- for studios, the account has an active non-client staff role in that studio;
- for organizers, the account is an organizer member, or an owner/admin/front desk of a linked studio.

Test sends are limited to 10 per workspace (studio or organizer) per hour (advisory-locked count) and recorded in `marketing_test_sends`. Arbitrary addresses are refused.

### ARIA / legacy automation classification (D1, safeguards 8, 9, 10)

`src/lib/marketing/compliance/messageClassification.ts` classifies by template key and content origin, not by
automation name:
- Commercial (re-engagement, retention, renewal, conversion): `aria_low_package_balance`, `aria_stale_active_student`,
  `aria_intro_no_purchase`, `aria_membership_canceling`, and automation `low_package_balance`, `no_upcoming_lesson`,
  `first_lesson_follow_up`.
- Operational: `aria_membership_past_due`, automation `unsigned_document`, `pending_booking_request`. These count as
  operational **only** while `payload.content_origin = "system_default"`; studio-customized content is treated as commercial.
- Any other key in the `aria_execution_` / `automation_` families fails closed to commercial. Keys outside those
  families keep their existing transactional handling.

Commercial messages pass through `prepareCommercialOutboundEmail` at the dispatch boundary (`src/lib/notifications/dispatch.ts`):
- the suppression check fails closed;
- the message goes out from the marketing sender, never the transactional one;
- the studio postal address is required (otherwise the message is skipped);
- a per-message unsubscribe link and RFC 8058 headers are added;
- the compliance footer is inserted inside the branded shell, before the legal line.

Skipped commercial messages update the ARIA action (`execution_skipped`).

A stage-1 trigger forces `content_origin = "studio_customized"` on any client-role write of an `aria_execution_*` /
`automation_*` row, so a forged `system_default` cannot route promotional content through the transactional path (D1,
safeguard 10). Every queue producer now writes with the service role (see §1 "Outbound deliveries (D)").

The unreferenced legacy `src/app/app/marketing/campaigns/[id]/actions.ts`, a dormant non-compliant send path, was
deleted.

### Marketing send freeze (A)

`marketing_send_controls` is a service-role-only singleton, and every change is logged in `marketing_send_control_events`.
It is set with `marketing_set_send_freeze(frozen, reason)`. **Stage 1 lands frozen**, and re-applying it never changes
the current setting. No migration and no rollback script sets it to false; only an explicit, separately authorized
`marketing_set_send_freeze(false, …)` does. The one exception is the stage-1 rollback, which removes the freeze
mechanism itself and therefore counts as releasing it (§6 "Stage-1 rollback"). While frozen, **enforced by the database in either application
version**:
- **campaigns are hidden from signed-in users** (a restrictive `m0 freeze hides campaigns` select policy on
  `marketing_campaigns` and `organizer_marketing_campaigns`). Every pre-M-0 campaign action (send, **test send**,
  regenerate, draft edit) reads the campaign through the session client first, so it stops at "not found" before any
  provider call. This closes the pre-M-0 direct test send (pre-existing C10) for the freeze window;
- campaign claims return `frozen`, and the M-0 batch stops with `marketing_paused`;
- the M-0 application checks the freeze first in every campaign action and answers `campaign_error=marketing_paused`.
  Its campaign pages show a **"Marketing maintenance"** state (campaigns temporarily hidden, nothing deleted) instead of
  a 404, and the campaign lists show a "paused for maintenance" status banner;
- client roles cannot see pending recipients or write recipients. The pre-M-0 send finds nothing and redirects; its
  regenerate fails closed instead of duplicating rows;
- the dispatcher claim (`claim_outbound_deliveries`, shared by both versions) **holds** commercial ARIA / automation email
  queued. It is not dropped. `_mkt_is_commercial_outbound` is the SQL mirror of the TS classifier, kept in step by a parity
  test.

Not affected (checked in code and by the regressions in §2): transactional and operational email, SMS, event settlement,
scheduling / appointment notifications, unsubscribe processing (never frozen) and background jobs, which run with the
service role and are not subject to RLS. Readers of the campaign tables outside marketing (ARIA draft suggestions,
communications and reports) simply see no campaigns while frozen. A missing control row reads as frozen.

### Recipient privacy (B)

Studio recipient and unsubscribe rows (addresses, names, unsubscribe tokens) are readable only by the roles that may
manage campaigns. That is the same set as `canViewCommunications`: platform admin (by studio role or by
`profiles.platform_role`), studio owner, studio admin and front desk. Instructors and any client-role account read nothing
(FC-1B5D). Organizer policies already match the organizer campaign roles (owner / admin / staff); this is verified, not
changed.

Stage 1 cannot broaden or silently replace an unknown database. Before it changes anything it checks the **complete
authorization state** of all seven affected tables (studio and organizer recipients, studio and organizer unsubscribes,
studio and organizer campaigns, `outbound_deliveries`). Per table, a signature covers:
- RLS enabled **and** forced;
- every policy other than this migration's own (excluded by exact name only): name, command, permissive or restrictive,
  the **effective roles**, and the exact `using` and `with check` expressions;
- the table privileges of `anon`, `authenticated` and `PUBLIC`.

A first apply requires every signature to equal the known pre-M-0 state exactly; a re-apply requires the known stage-1
state. Any drift, in either direction (an extra, altered, re-roled or missing policy, RLS toggled, a privilege added or
revoked), aborts the whole migration and changes nothing. Because this migration's own policy names are excluded from the
signature, their placement is checked separately: on a first apply none of them may exist on any of the seven tables, and
on a re-apply each may exist only on the table this migration puts it on. No unknown production policy is ever dropped or
replaced. It
also requires the dispatcher claim function to be the PAY-WH-1 version (or the stage-1 version on re-apply). This is
proven by `sql-tests/m0_precondition_tests.sh`, and the read-only PROD preflight (§3, A8) computes the identical signature
(enforced by `preflightParity.m0.test.ts`).

### Legacy unsubscribe compatibility (C)

- The pre-M-0 organizer page marks a recipient row with the service role, but its organizer-level upsert fails (C1). A
  stage-1 trigger on that page's exact signature records the opt-out through `marketing_unsubscribe_by_token`. The
  record is idempotent and token-scoped: the organizer record is written, other pending rows are suppressed and the
  contact is marked, and another tenant is never affected.
- The pre-M-0 studio page RPC also resolves studio-scoped per-message tokens, so footer links of commercial ARIA /
  automation email keep working after an application rollback. Organizer tokens, unknown tokens and malformed tokens
  are refused.

### Outbound deliveries (D)

The dispatcher sends a queued row as stored. Before M-0, any studio staff role (including instructors) could insert rows
directly through RLS, which allowed three abuses:
- forging operational or DanceFlow notifications;
- sending arbitrary content through the transactional sender, without suppression or unsubscribe;
- reaching arbitrary addresses.

Fixed in two steps:

- **Application.** Every producer writes with the service role. The only one that used the signed-in client
  (appointment notifications in `schedule/actions.ts`) now uses its admin client. A source guard test
  (`outboundProducers.m0.test.ts`) fails if any producer writes through a session client.
- **Stage 1** (old-app compatible). Client-role inserts are limited to what the pre-M-0 application produces:
  - appointment notifications for an appointment of the row's studio, addressed to that appointment's client or partner.
    Subject, body, HTML and reply-to are cleared, and **the payload is rebuilt from the database**: appointment, title or
    type label, times, participants, instructor, room and studio time zone (no notes). No client-supplied text, sender display
    name or SMS consent subject survives; `recipientClientId` is the matched participant;
  - legacy automation emails for one of the studio's own automation actions, **addressed only to that action's client**
    (or its booking request's customer), with reply-to cleared, and forced to `studio_customized` so they are commercial.

  Everything else is refused, including DanceFlow/platform keys, ARIA executions, booking, portal and event keys, and
  unknown keys. Client updates (platform admins) cannot re-route a row.
- **Stage 2** removes every client-role write to `outbound_deliveries`: both policies are dropped and the privileges
  revoked.

### Staged migrations

| Stage | File | Compatible with the pre-M-0 app | Apply |
|---|---|---|---|
| 1 | `20261117090000_m0_marketing_send_integrity.sql` | Yes. It lands frozen, so while frozen the old app cannot send marketing; its unsubscribe pages keep working (C) | before the app |
| 2 | `20261117091000_m0_recipient_write_lockdown.sql` | **No, never.** Provider-accepted old-app sends would go unrecorded (duplicates), and the old studio unsubscribe page would fail | after the M-0 app is live |

Rollback order and the rollback build: see §6. Stage 2 is reverted before any application rollback (the stage-1 rollback
refuses while stage 2 is applied), and the application rolls back to the **verified rollback-compat build**, never to the
plain pre-M-0 build. Stage 1 itself is not routinely reversible once M-0 has been used (§6 "Stage-1 rollback").

## 2. QA matrix (developer-owned)

**Environment:** the isolated local QA stack (`supabase_db_danceflow-e2e-qa`, 127.0.0.1:55321). The app runs on :3100 with
`RESEND_BASE_URL` pointed at a local mock provider, or a dead local endpoint for the Stripe test-mode runs. No real email was
sent. All results are for the final committed files, including the final bounded hardening (complete authorization
preconditions, rollback-build gate, release order, DB-enforced campaign hiding while frozen, hardened stage-1 rollback).

### Database

| Area | Evidence | Result |
|---|---|---|
| SQL suite, stage 1 (`test_T_m0_marketing_send_integrity.sql`) | Lifecycle, generation, unsubscribe (all token kinds), C1, platform suppression, test sends, guards and RLS, privileges, old-app compatibility; freeze (claims, test sends, client-role visibility and writes, **campaigns hidden from signed-in users and visible again on release, service role unaffected**, dispatcher hold and release, control row); B role probes: owner, studio admin, front desk, instructor, client role, other studio, platform admin (studio role and profile), organizer, anon; C; D, including appointment-payload helper role probes (owner, studio admin, front desk, platform admin allowed; client role denied) | **PASS 226/226** on QA (both cycles) and on DEV (rolled back) |
| SQL suite, stage 2 (`test_T_m0_recipient_write_lockdown.sql`) | No client-role recipient or outbound write by any path; reads kept; legacy RPC revoked; service pipeline and service-role outbound writes work | **PASS 54/54** on QA (both cycles). Negative control: the suite fails at stage 1, as expected |
| Preconditions and rollback guards (`m0_precondition_tests.sh`) | Stage 1 refuses, changing nothing, on: an unknown policy; an altered policy definition; a missing visibility policy; an unexpected dispatcher function; RLS disabled (organizer unsubscribes); RLS forced (`outbound_deliveries`); an unknown policy on organizer campaigns; changed policy roles (`outbound_deliveries`); an unknown policy with an M-0-like name; an M-0 policy name on a table M-0 does not put it on; an M-0 policy name already present before a first apply; a **narrower** privilege (studio campaigns). The control applies and lands frozen. The stage-1 rollback refuses, changing nothing, while stage 2 is applied, while unfrozen, after a recipient was handed to the provider (also with the removed override set) and with an issued per-message token | **PASS 38/38** |
| Concurrency (`m0_concurrency.sh`) | Previous races, plus the legacy organizer page racing an M-0 one-click for the same address (one record, both requests counted) | **PASS 25/25** (both cycles) |
| SQL mutation testing | 72 mutants, adding campaign hiding removed (studio, organizer): 71 caught by the suite, and email-lock removal caught by the concurrency harness (23/25). **Precondition mutants** (signature re-hashed with the mutated expression, so each is a genuinely weaker check): result ignored; `outbound_deliveries`, organizer unsubscribes or campaign tables skipped; first apply accepting the stage-1 state; claim function unchecked; roles, RLS forced flag, RLS flags, expressions, policy set or privileges not compared; any `m0 %` name excluded; M-0 name placement unchecked; placement checked on re-apply only. Each was caught by its matching tamper case; the unmutated control passes | **72/72 + 15/15** |
| Migration cycles (QA) | Starting at S3: the stage-1 rollback refuses (stage 2 first). Then two cycles of pre → s1 → s1 re-apply → s2 → s2 re-apply → rb2 → rb1, plus the final s1. Re-applying each stage is idempotent and keeps the freeze; rb2 leaves marketing frozen. The full rollback (unused M-0 only) equals the original DEV pre-state under the original fingerprint (`9493285f…`/191) | **PASS**, deterministic: pre `50857fc3…`/201 → s1 `5b377ef5…`/340 → s2 `56d4369d…`/335 |
| PROD preflights (read-only, validated on QA) | At pre-M-0: A4–A7 show the documented baseline, **A8 shows `MATCH-PRE` for all seven tables**, A8b shows no M-0-named policy, A9 lists the details, and A9b shows no freeze table. Signature parity with the migration is enforced by `preflightParity.m0.test.ts`. The C1 repair preflight runs (11/11 rows) | **PASS** (not run on PROD) |
| DEV (`epdrtzcydvnoidwrepqz`) | It was at stage 1 `dbe60d28…`/338 (frozen). The final stage 1 (including the review fix F1) was re-applied (LF) through the re-apply precondition: `5b377ef5…`/340, identical to QA. It is **frozen**. The suite passes 226/226 with no residue (no fixtures, no control events), and existing rows are unchanged (9 sent). **Stage 2 is not applied** | **PASS (stage 1)** |

### Application

| Area | Evidence | Result |
|---|---|---|
| Vitest (full) | Adds the frozen-campaign action tests (studio send, test send, list preparation; organizer send, test send, list preparation, draft edit) and the precondition / preflight parity tests | **PASS**: 385 files / 6074 tests |
| TS mutation testing | Adds the freeze-first guard of each of the 7 studio and organizer campaign actions, removed one at a time | **46/46 caught** |
| Typecheck / lint / build | `tsc` clean; eslint on changed and new files: 0 new errors or warnings versus the previous head (pre-existing ones unchanged); `next build` succeeds | **PASS** |
| Browser: M-0 application, S2 and S3 | `marketing-m0-compliance.spec.ts` (6, including the freeze: a test send from a form loaded before the freeze answers `marketing_paused` and mails nothing, the campaign page shows **Marketing maintenance**, the list shows the status banner, and everything is available again after release) and `marketing-m0-unsubscribe-survival.spec.ts` (`m0`) | **PASS 14/14** at S2 and at S3 (2 old-app-only scenarios skipped by design) |
| Browser: rollback-compat build, S1 (old app + stage 1) | Survival spec as `compat`: one-click for studio, organizer and message tokens; GET does not mutate; every footer page; while frozen, a forced campaign send from a page loaded before the freeze and **studio and organizer test sends** each stop with `campaign_error` and mail nothing | **PASS 10/10** |
| Browser: plain pre-M-0 build, S1 (old app + stage 1) | Survival spec as `pre_m0`: the same freeze scenarios pass (campaign send and both test sends blocked); footers work through C, but **one-click returns 404**. This is why it is not a rollback target | **PASS 10/10** (gap documented) |
| Browser regression, Stripe test mode, S3 (frozen) | Registration, waivers, cancellation, signing continuation, early-bird pricing, and others | **PASS 33**, 28 skipped by env gates, 0 failed. No Resend traffic, no outbound or campaign permission errors |
| Rollback build smoke (`scripts/m0-rollback-build-smoke.mjs`) | Against the compat build and the M-0 application: one-click POST 200 with no redirect, GET 303, both confirmation pages render. Against the plain pre-M-0 build: rejected (one-click 404, exit 1). Compat build: typecheck and lint clean; endpoint tests 10/10 | **PASS** (compat and M-0 `VERIFIED`; plain pre-M-0 `NOT A VALID ROLLBACK TARGET`) |

Live Resend, DNS and webhooks were not exercised. That is by design and still requires separate authorization.

### Independent review, round 1 (read-only reviewer, C1–C7 + safeguards)

**Verdict: GO for PR.** C1–C7, C8, C9, C10, S1 and S3 are fixed. C13 was partial in the review and is now fixed. Every finding raised was addressed in this branch:

- **P2-1:** an uncertain attempt, then a released retry, then a resume after 24 h could re-send outside the idempotency window.
  - Fixed as described in §1.
  - Covered by SQL tests and 3 mutants.
- **P2-2:** a tenant could delete a mailed campaign, which removed the tokens in delivered emails and the delivery evidence.
  - Fixed with a guard trigger.
  - Covered by a SQL test and a mutant.
- **P2-3:** during the stage-1 window, a client could insert a recipient with a token of its choosing.
  - Fixed: a fresh random token is forced on every client insert.
  - Covered by a SQL test and a mutant.
- **P2-4 (C13):** a campaign abandoned in `sending` could not be recovered.
  - Fixed with the resume rule and by rethrowing redirects.
  - Covered by unit and action tests and 6 mutants.
- **P3:**
  - The unindexed `lower(token)` fallback was removed.
  - The dead `[id]/actions.ts` was deleted.
  - The `outbound_deliveries` client-write gap was confirmed on DEV and closed by the D1 guard.

Follow-ups recorded but not in this PR:
- Studio campaigns have no content lock once a send starts. Organizer campaigns do, and a retry's outcome stays fail-safe.
- ENT-1 can possibly overcount when a settle fails and is later reconciled. The error is in the conservative direction.
- The TS preview list is unpaginated, so preview counts can be off (cosmetic).

### Independent review, round 2 (final remediation, read-only reviewer)

**Verdict: GO for merge.** A, B and C pass. D was **PARTIAL**, with two stage-1-window gaps, both fixed in this PR:
- **P2-1:** client-role appointment rows kept their payload. That allowed a forged From display name, free text, and the
  SMS consent subject. **Fixed:** the guard rebuilds the payload from the database (§1 D).
- **P2-2:** client-role automation rows could reach any recipient with any Reply-To. **Fixed:** the recipient is bound
  to the action's client or booking-request customer, and reply-to is cleared. The runbook also now applies stage 2
  **before** the freeze is released.

The P3 findings:
- **P3-1:** the doc overstated the freeze for the pre-M-0 test send. **Corrected.**
- **P3-2:** the stage-1 rollback now refuses while stage 2 is applied. **Tested.**
- **P3-4:** the campaign-lookup helpers are no longer executable by anon. **Tested.**
- **P3-3** (precondition hardening: `roles` and RLS-enabled are not fingerprinted; any `m0 %` name is accepted): not
  exploitable without DBA access. **Fixed in the final hardening:** the precondition now covers all seven tables, with
  roles, RLS enabled and forced, expressions and privileges, and excludes only its own policies by exact name (§1 B).
- **P3-5** (organizer staff can make the legacy trigger record an opt-out for their own recipient): tenant-scoped,
  errs toward suppression, and stage 2 removes it. **Tracked.**
- **P3-6** (suspected: after a rollback, the old organizer page can overwrite a row M-0 left `sending`): rare; the
  opt-out is still persisted. **Tracked.**

Re-review of the round-2 fixes: all **FIXED**, and **GO for merge**. New P3 findings:
- **P3-7:** the payload helper could return appointment notes and details to any studio role, including client-role
  accounts. **Fixed:** notes are not included, and both helpers admit only the outbound insert-policy roles. Covered by
  tests and 3 mutants.
- **P3-8:** in S1, a participant phone with fewer than 10 digits makes the pre-M-0 batch insert fail, losing that
  appointment's email too. This is edge data; the dispatcher would skip such an SMS anyway. **Tracked.**
- **P3-9:** the SQL label uses `initcap`, and instructor names come from `instructors` (the FK target), whereas the old
  producer queries a missing `staff` table and gets no names. This is cosmetic, S1 client-role rows only. **Tracked.**

### Independent review, final hardening (read-only reviewer, `d4d6957d`)

**Verdict: GO for merge** (no P0 or P1). Items 2 (rollback build), 4 (DB campaign freeze) and 5 (stage-1 rollback refusals)
pass. Items 1 and 3 were partial, with two P2 findings, both fixed in this PR:
- **F1:** this migration's own policy names were excluded from the signature on every table and in both modes, so a
  look-alike policy with an M-0 name on another table, or before a first apply, would go unnoticed. **Fixed:** their
  placement is checked separately (§1 B), shown read-only as preflight A8b, and covered by two tamper cases and two
  mutants.
- **F2:** the stage-1 rollback removes the freeze mechanism, but the docs said no rollback releases the freeze. **Fixed
  (documentation):** it is described as returning to S0 and equivalent to releasing the freeze, needing the same separate
  authorization, with the application already below M-0 (§6 "Stage-1 rollback").

Tracked P3 findings (not blocking):
- **F3:** freezing during a running M-0 batch leaves the campaign in `sending`, because the final status update goes through
  the session client. It is recoverable by the existing abandoned-send resume.
- **F4:** creating a campaign is not freeze-guarded. The studio draft is created but hidden; organizer create shows a
  generic error. There is no send risk.
- **F5:** the smoke script cannot bind a URL to the recorded deployment; the runbook procedure does.
- **F6:** column-level grants, policy helper bodies, triggers and views are outside the signature (mostly fail-closed).
- **F7:** small gaps. Not every stage-1 rollback blocker has its own test, and the rollback drops the freeze audit table.

## 3. Production preflight (read-only, prepared; NOT run)

`sql-tests/m0_prod_preflight_readonly.sql` runs in a single `begin transaction read only … rollback`. It returns aggregate counts
and schema hashes only: no addresses, names, tokens or content. It covers:
- **A:** the indexes, constraints, policies, legacy RPC body hash and triggers the migrations depend on;
- **B:** campaign and recipient states, including:
  - campaigns stuck in `sending` and partially sent campaigns;
  - rows that would violate the stage-1 constraints;
  - recipient-token uniqueness and casing (stage 1 ensures the unique indexes);
  - mailed campaigns;
  - the `outbound_deliveries` client write policies;
- **C:** campaigns whose ENT-1 usage exceeds their current sent rows, which is evidence of past C2 regenerate damage;
- **D:** organizer unsubscribes that were never stored (C1);
- **E:** commercial automation-family email exposure;
- **A7–A10:** the stage-1 preconditions, checked read-only:
  - **A7:** the PAY-WH-1 claim function hash;
  - **A8:** for each of the seven tables, the authorization signature stage 1 requires, printed as `MATCH-PRE` or
    `MISMATCH` with the computed and expected values. Any `MISMATCH` is a stop: stage 1 would refuse;
  - **A9:** the details behind A8 for review (RLS flags, every policy with command, permissive flag, roles and expression
    hashes, and the anon / authenticated / PUBLIC grants). Metadata only;
  - **A8b:** no policy with one of this migration's own names exists yet (expect `none`); anything else is a stop;
  - **A9b:** no freeze table yet;
  - **A10:** the `outbound_deliveries` write policies.

`sql-tests/m0_c1_repair_preflight_readonly.sql` sizes the historical organizer repair (§4). It also returns counts only.

Run both only with explicit authorization, from a fresh scratch workdir linked to PROD.

## 4. Historical repair (C1): affected-row criteria and plan (NOT run)

**Evidence signature.** On main `858e74eb`, the only writer of the following is the pre-M-0 organizer page:

```sql
status = 'unsubscribed' AND error_message = 'Recipient unsubscribed from organizer marketing'
```

That page ran on a plain GET of the unsubscribe link, with the service role, and set only those two fields. It kept
`sent_at` and `provider_message_id`. The table had no `updated_at`, so the request time was never recorded. Rows marked
`unsubscribed` for other reasons carry different messages and are excluded:
- `Suppressed by organizer unsubscribe list` (generation);
- `Unsubscribed before send` (M-0, which always stores its record).

Event registrations never change a contact's `status`.

**Classes.** A row is "missing" only when no `organizer_marketing_unsubscribes` record exists for `(organizer_id, lower(email))`.
- **Class A:** the signature, plus `sent_at` and `provider_message_id` set. The email was delivered, then the
  unsubscribe URL was requested, and the person was told they were unsubscribed. Whether a human or a mail-security link
  scanner made the request cannot be determined from stored data. Honoring it errs toward not mailing.
- **Class B:** the signature without delivery evidence. These are reviewed only and never repaired automatically.

**Preflight.** `sql-tests/m0_c1_repair_preflight_readonly.sql` returns counts only:
- rows and addresses by class;
- affected organizers;
- contact state;
- an upper bound of later sends that may have gone out after the opt-out;
- addresses with pending rows now;
- the evidence age range.

It was validated on QA with fixtures for every class.

**Repair** (separately authorized; run right after the M-0 application is promoted, before organizer campaigns resume,
because until then M-0 would still mail class-A addresses that have pending rows):
1. Class A only: one `organizer_marketing_unsubscribes` record per distinct `(organizer_id, lower(email))`, using
   `INSERT … ON CONFLICT (organizer_id, lower(email)) DO NOTHING`. Existing records are never overwritten.
2. `source = 'm0_c1_repair'`. The reason states the evidence: the request was acknowledged by the pre-M-0 page, the
   record was never stored, and the request time is unknown but after the delivery of a named campaign.
   `unsubscribed_at` is the time of repair; the true request time is unknown and is not fabricated. `campaign_id` /
   `recipient_id` link the evidence.
3. `organizer_contacts` and recipient rows are **not** modified: consent state is not overwritten, and the stored record
   alone suppresses at every M-0 claim.
4. Verify that the inserted count equals R5 and that a re-run of the preflight shows R3 = 0.
5. Rollback: `DELETE FROM organizer_marketing_unsubscribes WHERE source = 'm0_c1_repair'` (service role).

R9, the possible post-opt-out sends, cannot be recalled. Report it to the owner for any disclosure decision.

## 5. M-0D — provider event ingestion (planned; separate authorization for live configuration)

Goal: populate `marketing_email_suppressions` from Resend events (`email.bounced` with permanent bounce type, and `email.complained`), and mark campaign rows
`delivered`/`bounced` evidence.

Safeguards:

1. **Endpoint.** `POST /api/webhooks/resend` verifies the Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) against
   `RESEND_WEBHOOK_SECRET`, checking the raw body and a timestamp tolerance of 5 min. Unsigned or stale events get 400 and are not stored.
2. **Event inbox.** `resend_webhook_events` (unique `svix_id`) stores the event type, email id, a recipient hash and minimal
   metadata. Processing is idempotent and replay-safe, and out-of-order events are tolerated.
3. **Suppression rules.**
   - A hard bounce or complaint adds a platform suppression, scoped to marketing only.
   - Soft or transient bounces never suppress.
   - Transactional delivery is unaffected (D2).
4. **Tenant attribution.** Events are matched to recipients only via the stored provider message id (`provider_message_id`), never by
   address alone.
5. **No live change in this PR.** Creating the webhook in Resend, setting the secret in Vercel, and any domain or DNS change each need separate
   owner authorization.
6. **QA.** Signed fixtures, replay and duplicate handling, bad signatures, unknown types, and concurrency with a claim.

## 6. Release and rollback runbook (operator-safe)

### States

| State | Application | Schema | Safe? | Notes |
|---|---|---|---|---|
| S0 | pre-M-0 | pre-M-0 | today's production | C1–C7 open (the reason for M-0) |
| S1 | pre-M-0 (rollback-compat build) | stage 1 | **yes, only while frozen** | Stage 1 lands frozen. While frozen, the database hides campaigns from signed-in users, so the pre-M-0 app can neither send nor **test-send** campaigns; held commercial ARIA / automation email waits; the old organizer page's opt-outs persist (C); its studio page accepts per-message tokens (C); the compat build's one-click endpoint serves every M-0 token. Unfrozen it would behave like S0 for marketing, so it is never unfrozen |
| S2 | M-0 | stage 1 | **yes** | Full M-0 behavior. Client roles can still insert constrained recipient rows and constrained appointment / automation deliveries (old-app compatibility): appointment payloads are rebuilt from the database, and automation recipients are bound to their action. In a release or roll-forward, S2 is passed through **frozen** |
| S3 | M-0 | stages 1 + 2 | **yes** | Final state: no client-role recipient or outbound writes |
| X | pre-M-0 | stage 2 | **NEVER** | The old send's provider-accepted messages cannot be recorded (silent duplicates), and the old studio unsubscribe page fails (legacy RPC revoked) |

The marketing freeze (`marketing_send_controls`, service role only) is DB-enforced in every state that has stage 1: campaigns
are hidden from signed-in users, campaign claims return `frozen`, test sends are refused, client roles cannot see pending
recipients or write recipients, and the dispatcher claim holds commercial ARIA / automation email (queued, not dropped).
Unsubscribe is never frozen.

**Freeze rule.** No release, rollback or roll-forward step releases the freeze implicitly. Migrations and rollback scripts
never set it to false (re-applying stage 1 keeps the current setting). The **stage-1 rollback** is the one script that
removes the freeze (it drops the mechanism and returns to S0), so it needs the same separate authorization as releasing
the freeze (§6 "Stage-1 rollback"). Otherwise the freeze is released only by the final,
**separately authorized** step of a release or roll-forward.

### Rollback build verification gate (required before PROD stage 1)

The application rollback target is the **rollback-compat build** (pre-M-0 application plus the RFC 8058 one-click endpoint;
branch `m0-rollback-compat`, `docs/marketing/rollback/m0-rollback-compat.patch`). It must be built and verified **before**
PROD stage 1 is applied:

1. Push `m0-rollback-compat` (separately authorized) and record its **exact source SHA**.
2. Build a **production-target** deployment of that SHA. Record its **deployment id**. Do not promote it.
3. Build a **DEV-backed preview** of the same SHA (DEV has stage 1, which the endpoint needs) and run:
   `node scripts/m0-rollback-build-smoke.mjs <preview-url>`. It must print `ROLLBACK TARGET VERIFIED`:
   - the one-click POST answers **200 with no redirect** (no `Location`);
   - GET answers 303 to the confirmation page and never unsubscribes;
   - the **studio** confirmation page renders;
   - the **organizer** confirmation page renders.

   The script uses a random token, records nothing and needs no credentials.
4. Run the same script against the current production deployment (the plain pre-M-0 build). It must print
   `NOT A VALID ROLLBACK TARGET` (one-click 404). This confirms the script rejects a plain pre-M-0 build; such a build is
   never selected as the rollback target.
5. Record in the release log: the compat SHA, the production-target deployment id, both smoke outputs, and the current
   production deployment id (for reference only; it is **not** a rollback target once stage 1 is applied).

Without a recorded, verified rollback deployment id, PROD stage 1 does not start.

### Release (S0 → S1 → S2 → S3)

Each step needs its own owner authorization. PROD is only ever accessed from a fresh scratch workdir.

1. **Rollback build verification gate** (above).
2. **Read-only preflights** (`sql-tests/m0_prod_preflight_readonly.sql`, then
   `sql-tests/m0_c1_repair_preflight_readonly.sql`). Stop on any of:
   - A7 not the PAY-WH-1 hash, or **any A8 `MISMATCH`** (stage 1 would refuse; review A9 and stop, never "fix" a policy
     to make it match without separate review);
   - B8 / B9 / B10 not zero;
   - B5 campaigns stuck in `sending`.
3. **Quiet window.** Confirm B6 shows no partially sent campaign in progress and E3 no queued commercial email (optional).
   Pre-M-0 campaign sends already running finish within their action (≤ 1 batch).
4. **Freeze enabled: stage 1 SQL** (`20261117090000`). It lands frozen.
   - It refuses on any authorization drift or an unexpected dispatcher function, changing nothing.
   - Verify that the fingerprint equals the QA value (`5b377ef5…`/340) and that `marketing_send_frozen()` is true.
   - State is now **S1** (frozen).
   - Re-run the rollback smoke against the recorded production-target compat deployment (now backed by PROD stage 1). It
     must print `ROLLBACK TARGET VERIFIED`; otherwise stop and stay in S1.
5. **Verify app/schema compatibility, then promote the M-0 application.** State is now **S2**, **still frozen**.
   Public smoke (no authentication; changes nothing): `node scripts/m0-rollback-build-smoke.mjs <production-url>` prints
   `ROLLBACK TARGET VERIFIED` for the M-0 application too (same endpoint contract); the campaign pages show the
   maintenance state.
6. **Apply and verify stage 2** (`20261117091000`), **while still frozen**. State is now **S3**. Verify the fingerprint
   (`56d4369d…`/335). The M-0 application needs no client-role writes, so this costs nothing. It removes every client
   write to recipients and `outbound_deliveries` before any marketing flows again.
7. **Historical unsubscribe repair (C1)**, only if separately authorized (class A only, §4), while still frozen.
8. **Release the freeze, only after separate authorization:**
   `select public.marketing_set_send_freeze(false, '<operator>: M-0 verified')`. Every change is logged in
   `marketing_send_control_events`.
9. **Observe**, for example for 24 h: dispatch errors, `marketing_suppression_unavailable`, unsubscribe 503s, held queue
   size.

### Application rollback (S3 / S2 → S1)

**Rule 1.** Stage 2 is always reverted before any application rollback. A successful SQL rollback alone does not make an
application rollback safe; all the steps below are required.

**Rule 2.** The application rollback target is the **recorded, verified rollback-compat deployment**, never the plain
pre-M-0 build and never a deployment that has not passed the rollback smoke. The plain build has no one-click endpoint,
so emails M-0 already sent would get 404s on RFC 8058 POSTs (proven by `marketing-m0-unsubscribe-survival.spec.ts` as
`pre_m0` and by the smoke script).

1. **Enable or retain the freeze:** `select public.marketing_set_send_freeze(true, '<operator>: rollback')` (a no-op if
   already frozen).
2. If in S3, run `rollback/20261117091000_…`. The state is now S2 (frozen). This is safe with the M-0 application still
   live; verify the fingerprint returns to `5b377ef5…`/340.
3. Re-run `node scripts/m0-rollback-build-smoke.mjs <recorded compat deployment url>`; it must print
   `ROLLBACK TARGET VERIFIED`. Then promote that deployment. The state is now S1, frozen.
4. **Keep the freeze on** for as long as the pre-M-0 application is live. Marketing stays paused (campaign pages answer
   not found in the old application), and held commercial email stays queued. Transactional, operational, SMS,
   settlement, scheduling and unsubscribe traffic continue.
5. **Keep stage 1.** Issued unsubscribe links depend on it (see the survival table below and "Stage-1 rollback").

Unsubscribe-link survival in S1 with the compat build, for emails M-0 sent (all proven in the browser):

| Link | Path |
|---|---|
| One-click, every token kind | The compat endpoint |
| Studio footer link | Old page → legacy RPC |
| Per-message (commercial) footer link | Old page → legacy RPC, which resolves studio message tokens (C) |
| Organizer footer link | Old page → the stage-1 trigger persists the opt-out (C) |

### Roll forward from S1

1. **Enable or retain the freeze** (it must already be on in S1).
2. **Verify app/schema compatibility:** promote the M-0 application (S2, frozen) and run the public smoke.
3. **Apply and verify stage 2** (S3, fingerprint `56d4369d…`/335).
4. Complete any **separately authorized** historical unsubscribe repair.
5. **Release the freeze only after separate authorization.**

### Stage-1 rollback (`rollback/20261117090000_…`)

This is **not** a routine rollback step, and there is no override. It exists only to remove M-0 from a database where M-0
was never used, for example an aborted release immediately after stage 1.

**It returns the database to S0 and is equivalent to releasing the freeze.** It drops the freeze, the campaign hiding,
the dispatcher hold and the legacy unsubscribe compatibility, so marketing becomes sendable by the pre-M-0 application,
commercial email held during S1 is dispatched, and C1–C7 are open again (as in today's production). Therefore:
- it needs the **same separate owner authorization as releasing the freeze**, never just a rollback authorization;
- the application must already be **below M-0** (the verified compat build or the pre-M-0 build). The M-0 application
  must not be live, because it needs stage 1;
- afterwards, the compat build's one-click endpoint answers 503 (stage 1 is gone). That is harmless only because the
  refusals below guarantee that no M-0 token was ever issued.

It refuses, changing nothing, when:
- stage 2 is still applied (roll back `20261117091000` first);
- marketing is not frozen, or the freeze is missing;
- any studio or organizer recipient was ever handed to the provider (an attempt was recorded, or it is `sending`,
  `suppressed` or `delivery_unknown`);
- any platform suppression, per-message unsubscribe token, test send or unsubscribe audit record exists (issued links
  or recorded opt-outs depend on M-0 objects).

All refusals are tested (`m0_precondition_tests.sh` case 6, including an attempt to use the old override setting, which is
ignored). Once M-0 has mailed anything, stage 1 stays: the supported rollback is the application rollback above (S1).

**Exceptional teardown (separately authorized recovery procedure; not a script in this PR).** If stage 1 must ever be
removed after M-0 was used, it is handled as a recovery incident, not a rollback:
1. Owner authorization naming the reason. The freeze stays on throughout.
2. A read-only inventory and a full backup of every M-0 table (recipient tokens, per-message tokens, platform
   suppressions, unsubscribe and audit records).
3. A purpose-written, reviewed migration that first **materializes every M-0 opt-out** into the pre-M-0 unsubscribe tables
   and keeps **every issued token resolvable** (the token tables and the resolution path the compat endpoint and old pages
   use), so no unsubscribe link M-0 issued stops working.
4. Proven on a QA copy with the same shape: every token kind unsubscribes through the compat build and the old pages, and
   no opt-out is lost.
5. Only then are the remaining M-0 objects removed, with the result verified before the freeze is reconsidered.

### What the rollbacks guarantee

- The stage-2 rollback restores the stage-1 state exactly (fingerprint `5b377ef5…`/340) and is safe with either application.
- The application rollback keeps every unsubscribe link M-0 issued working, provided the target is the verified compat
  build and stage 1 stays applied.
- The stage-1 rollback restores the pre-M-0 state exactly (fingerprint `50857fc3…`/201), **but only** on a database where
  M-0 was never used; otherwise it refuses. It is not a way back from a release in which marketing was sent.
- No rollback step releases the freeze, except the stage-1 rollback, which removes it with stage 1 (returning to S0) and
  is authorized as a freeze release.
