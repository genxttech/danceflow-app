# BILLING-QA — engineering closeout and production-release readiness

Status: **PLAN ONLY. Nothing here has been executed against a hosted system or authorized.** Prepared 2026-10-30 on `main` `75c4b28b`.
Companion to `BILLING-QA-3-RELEASE-PLAN.md` (the release mechanics) and issue #354 (the residual register).

## 1. Engineering closeout (Git-only work, complete)

| PR | Slice | State |
|---|---|---|
| #332 | BILLING-QA-1 price verifier + PASS/FAIL/BLOCKED report | merged |
| #336 | BILLING-QA-4 read-only, platform-admin price-config endpoint (dark) | merged |
| #340 | BILLING-QA-5 owner no-payment smoke kit + session read-back | merged |
| #334 | BILLING-QA-2 test-mode subscription lifecycle Playwright spec | merged |
| #335 | BILLING-QA-3 webhook plan sync / ordering / unlabelled handling (squash `75c4b28b`) | merged |

`main` is never deployed; none of this is live. Production serves `release/pricing-p1` (`4bc938c6`, `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`).
Open trackers (not reopened): #348 (BILLING-QA-4 N1-N3, F1-F3), #352 (BILLING-QA-5 N3-N5, F1-F4; **F1: the restricted `rk_test_` dry run is BLOCKED on an owner-created key**; a no-payment smoke does not exercise the webhook change, so it is not a prerequisite for this release), #354 (release gates below).

## 2. Release-blocker matrix

| ID | Blocker | Kind | Owner | Needs authorization | Status |
|---|---|---|---|---|---|
| B1 | Multiple live subscriptions per customer (R-A) | read-only Stripe check | Owner runs (Claude supplies checklist, section 4) | none for a Dashboard read; a restricted `rk_` key read script would need the key | OPEN |
| B2 | Cross-event race (R-B) | owner decision + code | Claude proposes (section 3); owner decides | decision; any migration = hosted-DB authorization | OPEN |
| B3 | Webhook endpoint API version baseline | Dashboard read | Owner | none | OPEN |
| B4 | DB yearly Price IDs empty (R-G M4) | select-only hosted DB read | Claude with owner-approved read, or owner SQL editor | hosted read approval | OPEN |
| B5 | Dashboard-created unlabelled subscriptions fail loudly | owner acceptance | Owner | decision (recommendation: accept, section 5) | OPEN |
| B6 | Dry run on merged `main` `75c4b28b` | local | Claude | none | **DONE 2026-10-30** (section 6) |
| B7 | Portal plan switching (R-G M6) | Dashboard read | Owner | none | OPEN, not a code blocker |
| - | R-C/R-D/R-E/R-F | pre-existing or display-only | later PRs | none | tracked in #354, not release gates |

## 3. B2: cross-event race — bounded remediation proposal

**Defect.** Two deliveries for the same subscription each (1) re-read the subscription from Stripe, then (2) write. A real state change between the two reads, with the writes landing in inverted order, leaves the older read in the row. Worst case: a cancelled subscription shows `active` (no further event follows a cancellation). Needs a genuine transition inside the milliseconds between two reads, so it is rare, but it is not fail-closed.

Three options, smallest first:

**Option 1 (recommended): verify-after-write, no migration.** After `upsertStudioSubscription` writes, re-read the subscription once more; if its `status`, price, `cancel_at_period_end` or period differ from what this call wrote, apply the newer read (bounded to 2 extra passes, then log `subscription_event_unconverged` and return 500 so Stripe retries). Every writer verifies after its own write, so the last writer always ends on Stripe's latest state; a change after the final verify read emits its own event. Cost: one extra Stripe read per platform subscription event. Git-only, same release, no hosted DB step.

**Option 2: watermark migration (DB-enforced ordering).** Additive, nullable, no backfill:

```sql
-- 2027xxxx_studio_subscriptions_read_watermark.sql  (DRAFT, not applied, slot to be assigned at PR time)
alter table public.studio_subscriptions
  add column if not exists stripe_state_read_at timestamptz;
comment on column public.studio_subscriptions.stripe_state_read_at is
  'Wall-clock instant the webhook started the Stripe read whose state this row holds; older reads never overwrite newer ones.';
-- rollback: alter table public.studio_subscriptions drop column if exists stripe_state_read_at;
```

App change: capture `readStartedAt = new Date()` immediately before `stripe.subscriptions.retrieve`, carry it to the writer, and make the update conditional: `update ... where id = :id and (stripe_state_read_at is null or stripe_state_read_at <= :readStartedAt)`; zero rows updated => log `subscription_event_stale_read` and return 200 (a newer state is already stored). Residual: ordering is by request start, so a state change inside one Stripe request's latency can still invert (narrower than today, not eliminated); clock skew between instances is milliseconds. Needs SQL applied **before** the app (the column must exist), hosted-DB authorization, and a rollback note (app first, then column drop).

**Option 3: accept with monitoring.** Keep as-is; add the read-only reconciliation (Stripe subscription state vs `studio_subscriptions`) to the observation window and weekly. Cheapest, leaves the window open.

**Recommendation:** Option 1 for this release (closes the same window with no database change; Option 2 can follow if a DB-level guarantee is wanted). The owner decision to record in #354: Option 1 / 2 / 3.

**Tests (all unit/POST-level in the existing `studioSubscriptionPlan.billingqa3.test.ts` harness, no new infrastructure):**
- Option 1: (a) the second read differs => the writer re-applies and the final row equals the second read; (b) both reads equal => exactly one extra read, no extra write; (c) third read still differs after 2 passes => 500, ledger `failed`; (d) inversion simulation: deliveries A (reads active) and B (reads canceled) with A's write delayed after B's => final row `canceled`; (e) comped studio and superseded-subscription paths unchanged.
- Option 2 adds: stale `readStartedAt` => zero rows, 200, row unchanged; equal timestamp => applies; null watermark (pre-migration rows) => applies; migration up/down on the local QA database.
- Both: re-run the 12-case lifecycle spec on the result; release-branch dry run.

## 4. B1: read-only checklist — customers with more than one live subscription

Live = `trialing`, `active`, `past_due` (the app's `LIVE_STUDIO_SUBSCRIPTION_STATUSES`); also glance at `unpaid`/`paused`.
1. Stripe Dashboard (**Live mode**) -> Billing -> Subscriptions. Filter Status: Active, then Trialing, then Past due (or "All" and sort by Customer). Export CSV (Customer ID, Subscription ID, Status, Price).
2. Group by Customer ID; expected: **no customer has more than one live subscription**. Expected prices: only the three Founder Prices plus the one grandfathered legacy Pro Price ($129).
3. Record: count of live subscriptions, count of distinct customers, any customer with two or more (list IDs only, no PII in the issue).
4. Optional database cross-check (select-only; hosted read needs approval): studios with a `stripe_subscription_id` whose Stripe state is not live, and `studio_subscriptions` rows whose `stripe_subscription_id` is not among the live subscriptions from step 1.
5. Any hit => stop, do not release; the owner decides whether to cancel the extra subscription in Stripe (a subscription mutation: separate authorization).
No key is needed for the Dashboard path. A scripted equivalent (restricted read-only `rk_live_` with `Subscriptions: Read` only) is possible but needs an owner-created key and live-mode approval; not proposed for this release.

## 5. B3/B4/B5

**B3: webhook endpoint API version (owner, Dashboard, Live mode).** Developers -> Webhooks -> the endpoint `https://www.idanceflow.com/api/payments/webhook` -> note: Status Enabled, **API version**, subscribed events, recent delivery success rate. Also Developers -> Workbench/Overview -> account default API version. Record both in #354. The code accepts the billing period on the subscription or its items, so either version works; the SDK is pinned `2026-03-25.dahlia` and the endpoint's version governs the payload shape (and the unit tests cover both shapes). Do **not** change the version.

**B4: yearly Price IDs empty (select-only):**
```sql
select code, stripe_price_id_monthly, stripe_price_id_yearly
from subscription_plans
where stripe_price_id_yearly is not null;
```
Expected: **0 rows**. Any row => yearly checkout is reachable and ungated: stop and re-plan. Needs hosted-read approval (or the owner runs it in the Supabase SQL editor).

**B5: fail-loud for unlabelled subscriptions — recommendation: accept at release.** Behaviour: an unlabelled platform subscription (no DanceFlow metadata) is acknowledged with no write if the customer is unknown, and fails (500, `subscription_event_unlabelled_known_customer`) only if the customer is already billed by DanceFlow. Why acceptable: it never grants or removes entitlement, only that delivery is retried (Stripe retries over days and does not disable the endpoint for one failing event), it affects only subscriptions created by hand in the Dashboard for an existing studio customer (not a normal flow), and the alternative (silently writing a studio's billing from an unlabelled object) is worse. Operating rule to record: **create subscriptions for existing studios only through the app, or add `source=studio_subscription` and `studioId` metadata in the Dashboard**; check failed deliveries during the observation window.

## 6. B6: release dry run on `main` `75c4b28b` (procedure and result)

Procedure (local only, nothing pushed):
1. `git fetch origin`; confirm `origin/release/pricing-p1` is still `4bc938c6` (else re-plan).
2. `git worktree add --detach C:\Dev\studioapp-dryrun origin/release/pricing-p1`; link `node_modules` to an existing install (never `npm ci` through a junction).
3. `git diff 75c4b28b^ 75c4b28b -- src/app/api/payments/webhook/route.ts src/lib/payments/__tests__/ownershipFakes.ts src/app/api/payments/webhook/__tests__/studioSubscriptionPlan.billingqa3.test.ts > patch`, then `git apply --3way patch` in the worktree. Expect a clean apply, no conflict markers.
4. `npx vitest run src/app/api src/lib/payments src/lib/billing`, `rm -rf .next/dev/types`, `npx tsc --noEmit`.
5. Remove the junction, then the worktree.

Result (2026-10-30, release branch `4bc938c6`): patch applied cleanly (3 files, no conflicts); `tsc` exit 0; the webhook suites pass 15/15 files, 185/185 tests. Two full runs of `src/app/api src/lib/payments src/lib/billing` each had exactly one failure, a **different** unrelated test each time (student check-in `route.gc1_4a`, then competition checkout `phase10c`), the second a 5000 ms timeout under load; both pass in isolation, and the first also passes in isolation on the unpatched branch. Treat as load-sensitive timeouts (not weakened or retimed), not patch effects: 877/878 both times.

## 7. Proposed execution order

1. Owner: B3 (Dashboard read, 5 minutes) and B1 (Dashboard export), record in #354.
2. Owner: decide B2 option and B5 acceptance, record in #354.
3. Claude: if Option 1 or 2 chosen, implement + tests in a new Git-only draft PR on `main` (Option 2 adds the migration, still unapplied); lifecycle spec re-run; independent review.
4. Owner: approve B4 hosted read (or run it); record result.
5. Claude: re-run the dry run on the final `main` commit (section 6).
6. Only then: the #353 sequence (cut `release/pricing-p1-webhook`, staged build, promotion gate, observation window), each hosted step with its own authorization. If Option 2 was chosen, the migration step precedes the app promotion.

## 8. Authorization boundaries

This document authorizes nothing: no merge of #353, deployment, hosted migration, Stripe configuration change, subscription creation or mutation, live smoke test or fee-bearing operation.
