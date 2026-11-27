# D7 WP-5: advance-notice workflow, discovery and plan

**Status: plan and a draft template only. Nothing is approved, built or sent. No email was sent, no notice row was written, no hosted database was written.** Prepared 2026-11-05 against `origin/main` `c06222b7`. Labels: **EVIDENCE** (repo, with references), **APPROVED** (owner policy already recorded in `D7-RELEASE-READINESS.md`), **PROPOSAL, UNAPPROVED**, **NEEDS OWNER INPUT**.

Policy (APPROVED, `D7-RELEASE-READINESS.md` 8.1, 8.5.C, 10.2, and the owner's 2026-11-05 instruction): a **minimum of 60 days** before the effective date of the regular-price transition; one combined notice also tells the studio that complimentary Organizer Suite access ends unless the paid add-on is purchased; nothing is bought, charged or extended automatically; completed bookings and data are preserved. Reminders at 30 and 7 days and an "access has ended" notice are **placeholders needing owner approval** (the recorded text is "placeholders for review", section 8.5.C.3).

---

## 1. Existing infrastructure (EVIDENCE)

| Need | What exists | Reference |
|---|---|---|
| Notice records for the price change | `price_transition_notices`: studio, protected subscription, `effective_at`, `new_stripe_price_id`, `new_unit_amount_cents`, `currency`, `billing_interval`, `wording_reference` (required), `approved_by/approved_at`, and delivery evidence `sent_at`, `recipient`, `message_id`, `delivery_status` (`pending`, `delivered`, `bounced`, `failed`). A guard trigger makes the disclosed terms immutable, makes `delivered` evidence write-once, forbids a future `sent_at`, and forbids delete/truncate. A `delivered` row requires sent_at, recipient, message_id, approval, and `approved_at <= sent_at <= effective_at` | `migrations/20270204090000_billing_price_transitions.sql` |
| The 60-day rule | enforced in TypeScript only: `DEFAULT_MIN_NOTICE_DAYS = 60`; blockers `notice_missing`, `notice_not_approved`, `notice_not_delivered`, `notice_too_late` (`effective_at - sent_at < 60 days`), `target_price_mismatch`, `boundary_not_notice_date`. **The database does not enforce the 60 days** | `src/lib/billing/priceTransition.ts:18,136-151` |
| What the notice does not hold | no notice type, no channel, no reminder rows, no Suite fields (grant end instant, add-on price), no rendered text hash, no bounce timestamp; one row per price change, no notion of a combined or repeated notice. The table requires a protected subscription and a Stripe Price id, so it cannot by itself record a Suite-only notice | same migration |
| Email transport | queue `outbound_deliveries` (`queueOutboundDelivery`, `src/lib/notifications/outbound.ts`: studio, channel, `template_key`, recipient, subject, text/html body, `related_table`/`related_id`, unique `dedupe_key`, status `queued`) and the reliability-hardened dispatcher (`src/lib/notifications/dispatch.ts`, T2: leases, idempotent retry with the same provider idempotency key, bounded retry window, `provider_message_id` and `sent_at` recorded; `deliveryOutcome.ts`) over Resend | files cited |
| System sender | `templateKey` prefixes `platform_`/`danceflow_` are system templates: From `DanceFlow <notify@idanceflow.com>`, no studio Reply-To (`isDanceFlowSystemTemplate`, `src/lib/email/sender.ts`) | |
| Recipients | `getStudioStaffNotificationEmails` (active owners/admins, at most 5, falling back to the studio contact email), service-role only, scoped to one studio (`studioStaffRecipients.ts`) | |
| Rendering | `renderDanceFlowSystemEmail` (`src/lib/notifications/email-branding.ts`) | |
| Scheduling | Vercel cron routes under `src/app/api/cron/*`; the Suite expiry job is the pattern for a dark job (`ORGANIZER_SUITE_EXPIRY_ENABLED`, `?dry_run=1`, not in `vercel.json`) | `docs/billing/ORGANIZER-SUITE-EXPIRY-JOB.md` |
| In-app banner | `studioBanner` slot in `src/app/app/layout.tsx` (around line 1110) and the billing page | |
| Marketing compliance | commercial classification and suppression for marketing mail (M-0); billing notices are transactional and must not go through the marketing path | `src/lib/marketing/compliance/*` |
| **Bounce/delivery webhooks** | **none.** No Resend (Svix) webhook route exists; the repo only sees the API acceptance result. `delivered` in `price_transition_notices` can therefore only mean "the provider accepted the message" unless a webhook is built. A later hard bounce is invisible to the app | repo search: no `svix` / `email.bounced` handling |
| Exact grant end instant | `entitlementEndInstant(period_end, timezone)` (TS) and `usage_addon_entitlement_end_instant` (SQL): for DanceAbel `period_end = 2027-07-09`, `America/New_York` -> `2027-07-09T04:00:00Z` | `organizerSuiteEntitlement.ts`, `D7-RELEASE-READINESS.md` 10.2 |

## 2. Notice content (PROPOSAL, UNAPPROVED; wording needs owner and legal approval)

Template: `docs/billing/notices/COMBINED-NOTICE-TEMPLATE.md`. Every number, date and name is a `{{placeholder}}` filled from a record; nothing is defaulted. The notice contains, in plain words:

1. **Regular-price change**: the new monthly price (exact, from the notice record), the effective date (the verified billing-period boundary), the current price it replaces, that the change was previously described as time-limited.
2. **Complimentary Suite access ending**: the exact end instant (rendered in the studio's time zone and in UTC from `entitlementEndInstant`), that Suite access ends then unless the paid add-on is active.
3. **How to keep Suite access**: buy the add-on at `{{addon_price}}`/month on the billing page (unapproved until the owner fills it), no purchase happens by itself.
4. **What the studio keeps**: data, completed bookings, paid orders and registrations stay; what it can view after access ends is `{{post_expiry_visibility}}` (open decision G11).
5. **What ends**: new ticketing, in-person and Terminal sales, mark-paid, registrations and the other gated organizer functions for events with an organizer.
6. **Nothing automatic**: no purchase, charge or extension without the studio's own action.
7. **Contact route** and **billing terms** reference (Terms section 5 allows prospective price changes "after providing notice"; the repo defines no period, which is why 60 days is the recorded minimum).

## 3. Delivery and audit workflow (PROPOSAL, UNAPPROVED)

### 3.1 Approval and generation
1. **Wording approval**: the owner (and legal) approve the template text once (`wording_reference` = repo path + git blob hash of the approved template).
2. **Records are the source of truth.** A notice is rendered from (a) the `price_transition_notices` row (new price, interval, currency, `effective_at`), (b) the studio's manual-grant entitlement (`period_end`, timezone -> end instant via the shared helper), and (c) one approved add-on price record (WP-4; stays "unapproved" until approved). The same `effective_at` the WP-3 planner later compares with (`boundary_not_notice_date`) is the date in the text; the planner's `target_price_mismatch` check already ties the amount to the notice.
3. The renderer **fails closed**: any unresolved placeholder, null value or mismatch between records aborts the render. It stores `rendered_sha256` of the exact subject and body.
4. **The owner approves the rendered bytes** (hash), not just the template. The approval is write-once (`approved_by`, `approved_at`) like the existing notice approval. Any change of price, date or wording creates a new notice (disclosed terms are immutable); a new first notice restarts the 60 days.

### 3.2 Schedule (relative to the price effective date `E`)
| Notice | When | Status |
|---|---|---|
| N0 initial combined notice | **at least 60 days before `E`**; recommended target `E - 90 days` to leave room for a bounce and a re-send (a notice found undeliverable after `E - 60 days` cannot honor the date; the transition must move to a later boundary) | 60 days **APPROVED minimum**; 90 days **PROPOSAL, NEEDS OWNER INPUT** |
| N1 reminder | `E - 30 days` | placeholder, NEEDS OWNER APPROVAL |
| N2 reminder | `E - 7 days` | placeholder, NEEDS OWNER APPROVAL |
| N3 "Suite access has ended" | after the grant end instant, only if no current paid row | placeholder, NEEDS OWNER APPROVAL |
| N4 "price now in effect" confirmation | after the verified price change | optional, NEEDS OWNER INPUT |

For the DanceAbel dates in the owner's policy (`E` = `2027-07-09T04:00:00Z`, subject to the verified billing boundary): 60 days = 2027-05-10T04:00Z latest first send; 30 days = 2027-06-09T04:00Z; 7 days = 2027-07-02T04:00Z. Dates are computed from the records at run time; these are illustrations, not inputs.

### 3.3 Channel and recipients
- **Email** to the owner of record: active `studio_owner` users of the studio (not every admin), with the studio contact email as the fallback already used elsewhere; the recipient actually used is stored. Which addresses count as "owner of record" for DanceAbel is NEEDS OWNER INPUT (verify in the notice dry run).
- **In-app banner** on the billing page and the app layout from the day N0 is sent until `E` (and after, until acknowledged or purchased), showing the same dates and prices from the same record. The banner is not evidence of delivery.
- Sent through `outbound_deliveries` with a **system template key** (`danceflow_account_notice_*`), no marketing path, no unsubscribe footer for a contractual notice (wording per legal).

### 3.4 Delivery evidence and bounce handling
Per notice delivery: `scheduled_for`, `approved_by/at`, `rendered_sha256`, `outbound_delivery_id`, `recipient`, `sent_at`, `message_id` (`provider_message_id`), `status`, `bounced_at`, `failure_code`, `suppressed_reason`.
- Provider rejection (terminal dispatcher outcome) -> `failed`; notice N0 stays not `delivered`; **the existing planner blocker `notice_not_delivered` already stops the transition**; the operator is alerted (daily report/owner email).
- **A hard bounce or complaint after acceptance needs an inbound provider webhook that does not exist.** Until it is built, delivery of N0 is confirmed by the operator (provider dashboard check recorded as evidence) before `delivery_status` is set to `delivered`; no transition may be scheduled on "accepted" alone. NEEDS OWNER DECISION: build the webhook (WP-5.5) or accept the manual confirmation step.
- A bounce, a missing record, a changed price or date, or a changed recipient **stops the transition and alerts the owner**; nothing proceeds on a guess (8.5.C.6).

### 3.5 Suppression after purchase
At send time (not at schedule time) the job re-reads the studio's entitlements. If a **current paid row** (`source = stripe_subscription_item`, active, covering the period after the grant end) exists, the Suite-ending reminders N1-N3 are suppressed and logged as `suppressed` with the reason and the entitlement id; the price-change content is still sent (a studio that bought the add-on is still subject to the price change). A purchase never suppresses N0. A canceled paid row before the end instant un-suppresses the remaining reminders.

### 3.6 Idempotency
Unique key `(notice_id, notice_kind)` on the delivery table, `dedupe_key = acctnotice:{notice_id}:{kind}` on `outbound_deliveries` (unique, duplicate -> skipped), the dispatcher's provider idempotency key on retry, a row lock/lease while sending, and a state check (`approved` and not yet queued) before queueing. A crashed run re-runs to the same final state.

### 3.7 Dry run and safeguards
- **Dry run (default)**: a script/route mode that loads the records read-only, renders every due notice to files (text and HTML plus the hash and the placeholder values), prints what would be queued and suppressed, and **sends and writes nothing**. Dry run is the only mode when the kill switch is off.
- **Nothing sends without explicit owner approval**, enforced in code by all of: (1) env kill switch `ACCOUNT_NOTICES_ENABLED=true` (404/disabled otherwise, like the expiry job); (2) the notice row has `approved_by/at`; (3) the rendered hash equals the approved hash; (4) a per-notice `send_authorized_at` set by an owner action (not by the job); (5) N0 is refused when `E - now < 60 days`; (6) `effective_at` and prices re-read and compared with the approved snapshot; (7) a run cap (messages per run) and, outside production, a recipient allowlist.
- No sending code is part of this plan's PR.

## 4. Gap list (what must be built)

| # | Gap | Smallest recommended build |
|---|---|---|
| W1 | No place for the Suite terms, notice type, schedule, hash or suppression | One additive migration: table `account_notices` (immutable disclosed terms: studio, optional `price_transition_notice_id`, optional `entitlement_id`, `suite_ends_at`, `addon_price_cents`/`addon_stripe_price_id` (nullable until approved), `wording_reference`, `rendered_sha256`, approval pair) and `account_notice_deliveries` (one row per kind: schedule, status, recipient, message id, bounce, suppression, `outbound_delivery_id`), both service-role only, no delete/truncate, guard triggers modelled on `price_transition_notices_guard`. Keep `price_transition_notices` unchanged: it remains the price-change record the planner reads |
| W2 | 60 days not enforced by the database | A trigger/CHECK on N0 delivery evidence (`sent_at <= effective_at - interval '60 days'`) in the new table; optionally the same on `price_transition_notices` in a guarded migration (changing the released shape of WP-3 needs its own review) |
| W3 | No renderer | Pure function `renderAccountNotice(records) -> {subject, text, html, sha256}` with fail-closed placeholders, using `entitlementEndInstant` and the studio timezone; a dry-run script `scripts/billing/render_account_notice.ts` writing files only |
| W4 | No sender job | Dark route `/api/cron/account-notices` (kill switch, `?dry_run=1` default, approval and hash checks, suppression, run cap), queueing through `queueOutboundDelivery`; not registered in `vercel.json` until approved |
| W5 | No bounce intake | Resend/Svix webhook route verifying the signature and mapping `email.bounced`/`email.complained` to the delivery rows; or the documented manual confirmation step |
| W6 | No in-app banner | Component reading the same record, rendered in `layout.tsx` and the billing page |
| W7 | No owner approval/send UI | Platform-admin page or script to approve the rendered hash and authorize the send, with audit |
| W8 | Alerting | Daily operator report item: notices due in 14 days, unapproved, undelivered, bounced |
| W9 | WP-3/WP-4 coupling | Notice `kind` for "add-on price" depends on WP-4 price approval; planner reads only the price notice |

## 5. Work-package breakdown with file ownership (PROPOSAL)

| WP | Scope | Writes (single owner per file) |
|---|---|---|
| WP-5.0 | Owner decisions: wording, legal review, reminder cadence, N0 lead time, owner-of-record addresses, post-expiry visibility, add-on price (from WP-4) | docs only |
| WP-5.1 | Migration `account_notices` + `account_notice_deliveries` + guards + rollback; SQL tests on a disposable Postgres | `src/lib/supabase/migrations/2027xxxx_account_notices.sql`, `.../rollback/...`, `.../sql-tests/...` |
| WP-5.2 | Renderer, template loader, dry-run script, unit tests | `src/lib/billing/accountNotices/render.ts`, `scripts/billing/render_account_notice.ts`, `__tests__` |
| WP-5.3 | Sender job (dark) + suppression + idempotency + approvals | `src/app/api/cron/account-notices/route.ts`, `src/lib/billing/accountNotices/dispatch.ts` |
| WP-5.4 | In-app banner + billing page notice state | `src/app/app/layout.tsx` (banner slot only), `src/app/app/settings/billing/page.tsx` |
| WP-5.5 | Provider bounce webhook (optional) | `src/app/api/webhooks/resend/route.ts` |
| WP-5.6 | Owner approval/send action and operator report | platform admin page/script |

**Recommended smallest first slice: WP-5.1 + WP-5.2 only** (records, renderer, dry run). It produces the exact text and hash for owner review without any sender. Sending (WP-5.3) is a later, separately authorized slice.

## 6. Test plan
- Renderer: every placeholder required; null or mismatched records abort; hash stable; times correct across DST (`America/New_York`, 2027-07-09 -> 04:00:00Z) and for a NULL/invalid timezone fallback (UTC, with a visible flag); amounts formatted from cents; the add-on price absent -> the add-on paragraph aborts rather than inventing.
- 60-day rule: sent at `E - 60d` allowed, `E - 60d + 1s` refused; planner `notice_too_late` parity; DB trigger parity test.
- Approval: unapproved/hash-mismatch/edited-after-approval blocks; kill switch off -> dry run only.
- Idempotency: double run, concurrent runs, crash after queue before evidence write; duplicate `dedupe_key` skipped.
- Suppression: paid row active -> N1-N3 suppressed with reason; paid row canceled -> not suppressed; N0 never suppressed.
- Bounce/failure: terminal provider outcome -> `failed`, planner `notice_not_delivered`; webhook bounce after accepted -> `bounced`, transition blocked; manual confirmation path.
- Recipients: only the studio's own owner addresses; no cross-studio leakage; missing address -> stop and alert.
- Dry run: writes only files, no DB writes, no queue rows (assert with a fake client).
- SQL tests on a disposable Postgres: immutability of disclosed terms, write-once evidence, no delete/truncate, 60-day check.
- End-to-end rehearsal on DEV with a disposable studio and a recipient allowlist before any production use.

## 7. Open items needing owner decisions
Wording and legal review; N0 lead time (60 minimum, 90 proposed); reminder cadence and the "ended" notice; owner-of-record addressing for DanceAbel; manual versus webhook delivery confirmation; what the studio can see after access ends; the add-on price and the then-regular Pro price to print in the notice; whether the in-app banner stays after purchase.
