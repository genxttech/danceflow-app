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
It is set with `marketing_set_send_freeze(frozen, reason)`. **Stage 1 lands frozen.** While frozen, in either application
version:
- campaign claims return `frozen`, and the M-0 batch stops with `marketing_paused`;
- test sends are refused by the M-0 application. The **pre-M-0 application's test send is not gated**: it calls the
  provider directly, sending one message to whatever address staff type, so it is not frozen (pre-existing C10);
- client roles cannot see pending recipients or write recipients. The pre-M-0 send finds nothing and redirects; its
  regenerate fails closed instead of duplicating rows;
- the dispatcher claim (`claim_outbound_deliveries`, shared by both versions) **holds** commercial ARIA / automation email
  queued. It is not dropped. `_mkt_is_commercial_outbound` is the SQL mirror of the TS classifier, kept in step by a parity
  test.

Operational, transactional and SMS deliveries continue, and unsubscribe is never frozen. A missing control row reads as
frozen. The campaign pages show a "paused for maintenance" notice while frozen.

### Recipient privacy (B)

Studio recipient and unsubscribe rows (addresses, names, unsubscribe tokens) are readable only by the roles that may
manage campaigns. That is the same set as `canViewCommunications`: platform admin (by studio role or by
`profiles.platform_role`), studio owner, studio admin and front desk. Instructors and any client-role account read nothing
(FC-1B5D). Organizer policies already match the organizer campaign roles (owner / admin / staff); this is verified, not
changed.

Stage 1 cannot broaden an unknown database. Before it changes anything it requires:
- every existing policy on the two tables to be a known pre-M-0 policy, by exact definition hash, or an M-0 policy;
- a visibility policy to exist;
- the dispatcher claim function to be the PAY-WH-1 version.

Otherwise the whole migration aborts, changing nothing. This is proven by `sql-tests/m0_precondition_tests.sh`.

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
refuses while stage 2 is applied), and the application rolls back to the **rollback-compat build**, never to the plain
pre-M-0 build.

## 2. QA matrix (developer-owned)

**Environment:** the isolated local QA stack (`supabase_db_danceflow-e2e-qa`, 127.0.0.1:55321). The app runs on :3100 with
`RESEND_BASE_URL` pointed at a local mock provider, or a dead local endpoint for the Stripe test-mode runs. No real email was
sent. All results are for the final committed files, including the final-audit remediation (A–D).

### Database

| Area | Evidence | Result |
|---|---|---|
| SQL suite, stage 1 (`test_T_m0_marketing_send_integrity.sql`) | Lifecycle, generation, unsubscribe (all token kinds), C1, platform suppression, test sends, guards and RLS, privileges, old-app compatibility, plus remediation: freeze (claims, test sends, client-role visibility and writes, dispatcher hold and release, control row), B (owner, front desk, instructor, client role, other studio, platform admin, organizer, anon), C (legacy organizer page, legacy studio RPC tokens), D (appointment / automation / forbidden keys, tenant isolation, re-routing, helper oracles) | **PASS 216/216** on QA and on DEV (rolled back) |
| SQL suite, stage 2 (`test_T_m0_recipient_write_lockdown.sql`) | No client-role recipient or outbound write by any path; reads kept; legacy RPC revoked; service pipeline and service-role outbound writes work | **PASS 54/54** on QA. Negative control: the suite fails at stage 1, as expected |
| Preconditions (`m0_precondition_tests.sh`) | Unknown policy, altered policy definition, missing visibility policy and unexpected dispatcher function each make stage 1 refuse, changing nothing. The pre-M-0 fingerprint is unchanged, and the control applies. The stage-1 rollback refuses while stage 2 is applied, changing nothing | **PASS 15/15** |
| Concurrency (`m0_concurrency.sh`) | Previous races, plus the legacy organizer page racing an M-0 one-click for the same address (one record, both requests counted) | **PASS 25/25** |
| SQL mutation testing | 70 mutants (including payload rebuild, recipient binding, reply-to, cross-tenant action, anon grants, helper role scope, notes): 69 caught by the suite, and email-lock removal caught by the concurrency harness. Separately, 4 precondition mutants are all caught; the unmutated control passes | **70/70 + 4/4** |
| Migration cycles (QA) | Two cycles of pre → s1 → s2 → rb2 → rb1. Re-applying each stage is idempotent. The full rollback equals the original DEV pre-state under the original fingerprint (`9493285f…`/191) | **PASS**, deterministic: pre `50857fc3…`/201 → s1 `dbe60d28…`/338 → s2 `ef211b24…`/333 |
| PROD preflights (read-only, validated on QA) | At pre-M-0, A4–A9 show the documented baseline. The C1 repair preflight was validated with fixtures for every class | **PASS** (not run on PROD) |
| DEV (`epdrtzcydvnoidwrepqz`) | It was stage 1 v1 (`ae4e6f28…`/307, identical to QA). The revised stage 1 (including review round 2) has been applied (LF), giving `dbe60d28…`/338, identical to QA. It is **frozen**. The suite passes 216/216 with no residue, and existing rows are unchanged. **Stage 2 is not applied** | **PASS (stage 1)** |

### Application

| Area | Evidence | Result |
|---|---|---|
| Vitest (full) | Includes the new freeze, parity, producer-guard and appointment-producer tests | **PASS**: 384 files / 6068 tests |
| TS mutation testing | Adds freeze handling, refusal codes, pause notice, and the appointment producer on the session client | **39/39 caught** |
| Typecheck / lint / build | `tsc` clean; eslint on changed files gives 0 errors and no new warnings vs main; `next build` succeeds | **PASS** |
| Browser: M-0 application, S2 and S3 | `marketing-m0-compliance.spec.ts` (6, including the freeze UI) and `marketing-m0-unsubscribe-survival.spec.ts` (`m0`, 8) | **PASS 14/14**, twice in each state, plus once more on the round-2 SQL (1 old-app-only scenario skipped by design) |
| Browser: rollback-compat build, S1 | Survival spec as `compat`: one-click for studio, organizer and message tokens; GET does not mutate; every footer page; the frozen pre-M-0 campaign send sends nothing, even when forced | **PASS 9/9** (also on the round-2 SQL) |
| Browser: plain pre-M-0 build, S1 | Survival spec as `pre_m0`: footers work through C, but **one-click returns 404**. This is why it is not a rollback target | **PASS 9/9** (gap documented) |
| Browser regression, Stripe test mode, S3 | Registration, waivers, cancellation, signing continuation, early-bird pricing, and others | **PASS 33**, 27 skipped by env gates, 0 failed. No Resend traffic and no outbound permission errors |
| Rollback-compat build | Typecheck and lint clean; endpoint tests 10/10 | **PASS** |

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
  exploitable without DBA access. **Tracked.**
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
  - the PAY-WH-1 claim function hash;
  - no unknown recipient/unsubscribe policy;
  - the visibility policies present, and no freeze table yet;
  - the `outbound_deliveries` write policies.

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
| S1 | pre-M-0 | stage 1 | **yes, while frozen** | Stage 1 lands frozen. While frozen, the pre-M-0 app cannot send campaigns, held commercial ARIA / automation email waits, the old organizer page's opt-outs persist (C), and its studio page accepts per-message tokens (C). Its direct test send (one message to a staff-typed address) is not DB-gated (pre-existing C10). Unfrozen it would behave like S0 for marketing, so it is never unfrozen |
| S2 | M-0 | stage 1 | **yes** | Full M-0 behavior. Client roles can still insert constrained recipient rows and constrained appointment / automation deliveries (old-app compatibility): appointment payloads are rebuilt from the database, and automation recipients are bound to their action. In a release, S2 is passed through **frozen** (stage 2 is applied before the freeze is released) |
| S3 | M-0 | stages 1 + 2 | **yes** | Final state: no client-role recipient or outbound writes |
| X | pre-M-0 | stage 2 | **NEVER** | The old send's provider-accepted messages cannot be recorded (silent duplicates), and the old studio unsubscribe page fails (legacy RPC revoked) |

The marketing freeze (`marketing_send_controls`, service role only) is DB-enforced in every state that has stage 1: campaign
claims return `frozen`, test sends are refused, client roles cannot see pending recipients or write recipients, and the
dispatcher claim holds commercial ARIA / automation email (queued, not dropped). Unsubscribe is never frozen.

### Release (S0 → S1 → S2 → S3)

Each step needs its own owner authorization. PROD is only ever accessed from a fresh scratch workdir.

1. **Prepare.**
   - Push branch `m0-rollback-compat` (`docs/marketing/rollback/m0-rollback-compat.patch`, local commit `b4289d30`).
   - Have a production-target build of it ready as the rollback target. It must contain the one-click endpoint, and it is
     never the plain pre-M-0 build.
   - Record the current production deployment id.
2. **Read-only preflights** (`sql-tests/m0_prod_preflight_readonly.sql`, then
   `sql-tests/m0_c1_repair_preflight_readonly.sql`). Stop on any of:
   - A3 / A7 / A8 not matching the documented pre-M-0 hashes (stage 1 would refuse anyway);
   - B8 / B9 / B10 not zero;
   - B5 campaigns stuck in `sending`.
3. **Quiet window.**
   - Confirm B6 shows no partially sent campaign in progress and E3 no queued commercial email (optional).
   - Stage 1's own freeze covers marketing from the moment it commits. Pre-M-0 campaign sends already running finish
     within their action (≤ 1 batch).
4. **Stage 1 SQL** (`20261117090000`).
   - It refuses on unknown policies or an unexpected dispatcher function, changing nothing.
   - Verify that the fingerprint equals the QA value (`dbe60d28…`/338) and that `marketing_send_frozen()` is true.
   - State is now **S1**.
5. **Promote the M-0 application.** State is now **S2**, still frozen.
6. **Public smoke** (no authentication; it changes nothing):
   - one-click POST with a random UUID returns 200, with no redirect;
   - GET returns 303 to the confirmation page;
   - both confirmation pages render.
7. **C1 historical repair** (separately authorized; class A only), before organizer campaigns resume.
8. **Stage 2 SQL** (`20261117091000`), **while still frozen**. State is now **S3**. Verify the fingerprint
   (`ef211b24…`/333). The M-0 application needs no client-role writes, so this costs nothing. It removes every client
   write to recipients and `outbound_deliveries` before any marketing flows again.
9. **Release the freeze:** `select public.marketing_set_send_freeze(false, '<operator>: M-0 verified')`. Every change is
   logged in `marketing_send_control_events`.
10. **Observe**, for example for 24 h: dispatch errors, `marketing_suppression_unavailable`, unsubscribe 503s, held queue
    size.

### Rollback

**Rule 1.** Stage 2 is always reverted before any application rollback. A successful SQL rollback alone does not make an
application rollback safe; the steps below are all required.

**Rule 2.** The application rollback target is the prepared **rollback-compat build**, never the plain pre-M-0 build. The
plain build has no one-click endpoint, so emails M-0 already sent would get 404s on RFC 8058 POSTs (proven by
`marketing-m0-unsubscribe-survival.spec.ts` as `pre_m0`).

From S3 / S2:

1. Freeze: `select public.marketing_set_send_freeze(true, '<operator>: rollback')`.
2. If in S3, run `rollback/20261117091000_…`. The state is now S2. This is safe with the M-0 application still live, and
   the fingerprint returns to `dbe60d28…`/338.
3. Promote the rollback-compat build. The state is now S1, frozen.
4. **Keep the freeze on** for as long as the pre-M-0 application is live. Marketing stays paused, and held commercial
   email stays queued. Transactional and operational email continue.
5. Keep stage 1. Its rollback (`rollback/20261117090000_…`) is only for removing M-0 entirely. It refuses while M-0 data
   exists and would remove the freeze and the legacy compatibility.

Unsubscribe-link survival in S1 with the compat build, for emails M-0 sent (all proven in the browser):

| Link | Path |
|---|---|
| One-click, every token kind | The compat endpoint |
| Studio footer link | Old page → legacy RPC |
| Per-message (commercial) footer link | Old page → legacy RPC, which resolves studio message tokens (C) |
| Organizer footer link | Old page → the stage-1 trigger persists the opt-out (C) |

Roll forward from S1: promote the M-0 application (S2), verify, release the freeze, then re-apply stage 2.
