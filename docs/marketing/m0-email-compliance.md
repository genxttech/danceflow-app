# Marketing M-0 — Email Compliance and Suppression Integrity

Status: implementation candidate (M-0A–M-0C). Stage-1 SQL is applied to DEV; stage 2 and the application are not merged or released.
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

Studio staff can insert `outbound_deliveries` rows directly (existing RLS). A stage-1 trigger therefore forces
`content_origin = "customized"` on any client-role write of an `aria_execution_*` / `automation_*` row, so a forged
`system_default` cannot route promotional content through the transactional path (D1, safeguard 10). The two legacy
automation producers that used the signed-in client now write with the service role, with `studio_id` taken from the
verified studio context.

The unreferenced legacy `src/app/app/marketing/campaigns/[id]/actions.ts`, a dormant non-compliant send path, was
deleted.

### Staged migrations

| Stage | File | Compatible with the pre-M-0 app | Apply |
|---|---|---|---|
| 1 | `20261117090000_m0_marketing_send_integrity.sql` | Yes, with one difference: the old app's regenerate after a partial send now fails closed, and the old send path still works | before the app |
| 2 | `20261117091000_m0_recipient_write_lockdown.sql` | No: the old app can no longer write recipients, so its sends fail closed (no mail) | after the M-0 app is live |

Rollback is app first. Then `rollback/20261117091000_…` restores tenant writes and the legacy RPC grants. Then, only if needed,
`rollback/20261117090000_…`, which refuses while M-0 data exists unless the operator sets `m0.allow_data_loss = 'yes'` in the
same transaction. Stage 1 can safely stay in place under the old app.

## 2. QA matrix (developer-owned)

**Environment:** the isolated local QA stack (`supabase_db_danceflow-e2e-qa`, 127.0.0.1:55321), with the app on :3100 and
`RESEND_BASE_URL` pointed at a local mock provider. No real email was sent. All results are for the final code, including the
fixes from the independent review.

| Area | Evidence | Result |
|---|---|---|
| SQL suite, stage 1 (`sql-tests/test_T_m0_marketing_send_integrity.sql`) | Generation preservation; claim/complete lifecycle (uncertain, 23-hour window, retry after release); unsubscribe for every token kind, including upper-case tokens; organizer persistence (C1); platform suppression; test-send authorization; guards and RLS, with defense-in-depth probe grants; mailed-campaign delete guard; forced recipient tokens; outbound content-origin guard; privileges; old-app compatibility | **PASS 139/139** (QA and DEV) |
| SQL suite, stage 2 (`sql-tests/test_T_m0_recipient_write_lockdown.sql`) | Tenants cannot write recipients by any path; read access is kept; legacy RPC revoked; service pipeline works; drafts stay editable | **PASS 41/41** (QA). Negative control: at stage 1 the suite fails, as expected |
| Concurrency (`sql-tests/m0_concurrency.sh`, separate sessions) | Unsubscribe vs claim in both orders, plus the window between writing the record and updating the rows; double claim; sync vs claim; concurrent organizer unsubscribes; concurrent test sends at the hourly limit; stale completion | **PASS 23/23** (QA only: the harness commits its fixtures and refuses to run on databases with real accounts) |
| SQL mutation testing (32 mutants) | 27 caught by a suite FAIL. 4 caught because they abort the suite; the unmutated control run passes in the same harness. Removing the email lock is caught by the concurrency harness (2 checks fail) | **32/32 caught** |
| TS mutation testing (31 mutants) | Delivery, provider classification, endpoint, classification, dispatch, test send, organizer lock, ENT-1, abandoned-send resume, redirect handling | **31/31 caught** |
| Migration cycles (QA) | pre `9493285f…`/191 → s1 `00500265…`/295 → s2 `5df2d790…`/292 → rb2 → rb1 → pre, twice. Re-applying each stage is idempotent, and the rollback refuses while M-0 data exists | **PASS** (deterministic) |
| DEV (`epdrtzcydvnoidwrepqz`) | Pre-state equals the QA pre-state (`9493285f…`/191). Data is compatible: no `sending` rows, no duplicates. **Stage 1 applied**; fingerprint `00500265…`/295, identical to QA. The stage-1 suite passes on DEV inside a rolled-back transaction, leaving no fixture residue and existing rows unchanged. **Stage 2 is not applied to DEV**; it goes on after the M-0 app is deployed | **PASS (stage 1)** |
| Vitest (full) | 383 files / 6058 tests, including 6 new M-0 files | **PASS** |
| Typecheck / lint / build | `tsc --noEmit` is clean; eslint on changed files gives 0 errors and no new warnings vs main; `next build` succeeds | **PASS** |
| Browser E2E (`e2e/tests/marketing-m0-compliance.spec.ts`) | Test send goes to staff only; the send list is decided in the DB; a one-click unsubscribe between prepare and send is honored; each recipient gets its own link, RFC 8058 headers and idempotency key; GET does not unsubscribe; the page form records the unsubscribe; an organizer unsubscribe persists and suppresses the next campaign; commercial automation email is suppressed or given its footer; operational email is unaffected | **PASS 5/5**, twice, at stage 2 |
| Browser E2E regression (non-Stripe specs) | 9 passed, 20 skipped by spec env gates, 4 did not run. 6 registration/checkout specs time out because the isolated M-0 app runs without `STRIPE_SECRET_KEY` (log: `Missing STRIPE_SECRET_KEY`). M-0 changes no registration or payment code | **BLOCKED (environment)** for those 6 specs; not counted as passed |

Live Resend, DNS and webhooks were not exercised. That is by design and still requires separate authorization.

### Independent review (read-only reviewer, C1–C7 + safeguards)

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
- Recipient and unsubscribe SELECT policies don't check the user's role. This is pre-existing, and instructors can read recipient emails and tokens.
- Studio campaigns have no content lock once a send starts. Organizer campaigns do, and a retry's outcome stays fail-safe.
- ENT-1 can possibly overcount when a settle fails and is later reconciled. The error is in the conservative direction.
- The TS preview list is unpaginated, so preview counts can be off (cosmetic).
- Staff-authored `outbound_deliveries` rows outside the automation families (1:1 messages) keep their existing handling.

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
- **E:** commercial automation-family email exposure.

Run it only with explicit authorization, from a fresh scratch workdir linked to PROD.

## 4. Historical repair (C1): affected-row criteria and plan (NOT run)

**Affected rows.** These are organizer recipients that the old confirmation page marked unsubscribed, where the organizer-level upsert then
failed on the expression index:

```sql
organizer_marketing_campaign_recipients r
where r.status = 'unsubscribed'
  and r.error_message = 'Recipient unsubscribed from organizer marketing'
  and not exists (select 1 from organizer_marketing_unsubscribes u
                  where u.organizer_id = r.organizer_id and lower(u.email) = lower(r.email))
```

**Plan** (separate authorization; after stage 1 is live):

1. Run preflight D1/D2 to get counts only.
2. In one transaction, insert one `organizer_marketing_unsubscribes` row per distinct `(organizer_id, lower(email))`, with these values:
   - `unsubscribed_at` = the earliest matching recipient's `updated_at` (or `created_at`);
   - `source = 'm0_repair'`;
   - `reason = 'Restored from campaign unsubscribe (M-0 repair)'`.

   Use `on conflict (organizer_id, lower(email)) do nothing`. Then mark the matching `organizer_contacts` unsubscribed.
3. Verify that D1 returns 0 and the inserted count equals the distinct count. No recipient rows change, and the operation is idempotent.
4. Rollback: delete only the rows where `source = 'm0_repair'`. This restores the exact pre-repair state; the contact status changes are recorded first for reversal.

D2 counts later sends to these addresses (an upper bound). They cannot be recalled. Report them to the owner for any disclosure decision.

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
