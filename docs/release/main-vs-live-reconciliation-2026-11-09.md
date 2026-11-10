# main vs live production: reconciliation (2026-11-09)

**Branch:** `claude/main-reconcile-live`, a real merge of the live www line into `main`, done as two merge commits.
**Status:** Git-only. Nothing is merged to `main`, deployed or applied to a hosted database.

| Ref | Commit | Meaning |
| --- | --- | --- |
| `origin/main` | `ab257f59` | first parent of the first merge (D24 proof harness work) |
| `origin/release/tw4f-monitoring-r2-cib` | `a965f477` | merged first (`f7fe1483`): the live line up to CI-B, where all the conflicts were |
| PR 441 head | `ebeef20d` | merged second (`ef75c408`): **the code www serves since 2026-11-09 21:17Z** (dpl_8MyCL3nT…), which is a965f477 plus the TW-4F micro-dollar price publication |
| merge base | `2cc05d9e` | PROD sync point of 2026-10-19 |

Live lineage: `release/pricing-p1` 81263ad8 → H1 `release/h1-aal2-candidate-v2` 42df27cd → `release/tw4f-candidate` e17db5e7 → R2 app `release/competition-r2-app` b82dba27 → TW-4F monitoring ffdf9258 → + CI-B 05660a46 = a965f477 → TW-4F pricing release (PR 441) ebeef20d.

None of the 17 files that ebeef20d changes on top of a965f477 changed on main, so the second merge was conflict-free. Its migration `20270212090000_twilio_price_micros_publication.sql` (applied on PROD 21:05–21:07Z) comes in byte-identical.

## 1. Bottom line

- **After this merge, main is a superset of live (ebeef20d):**
  - Every one of the 751 files that live changed since the merge base is present.
  - 739 of them are byte-identical to live.
  - 9 take main's newer copy, which descends from the live copy.
  - 3 were resolved by hand (section 4).
  - No live file is missing.
  - No migration that exists on live has different bytes.
  - No migration timestamp collides.
  - These figures come from `scripts/release/main-vs-live-inventory.mjs --live ebeef20d` (section 9).
- **main is still NOT promotable to PROD after this merge.** main's own newer billing code calls schema that PROD does not have (section 6). That gap existed before this merge; the merge neither creates nor closes it.

## 2. Inventory: live-only commits (29) and where main stands

Method: `git cherry` for patch equivalence, then a three-way tree comparison per file. A file counts as "same" only if main's blob equals live's blob, so equivalence is proven on content, not ancestry.

| Group | Live commits | On main already? |
| --- | --- | --- |
| WEB-2A W-0..W-6, WEB-2B (#281–#289) | 46190cdf ae43f3c2 ad94eff4 f28626e8 78273ef1 8e2c0f5b 9815c862 8fd075f5 | Yes, patch-equivalent. Every file is byte-identical, except the roadmap, where main is newer. |
| PRICING-P1 (#302, #319) | 1c8ab80f 4bc938c6 | Yes, as d5786295 and others. The 6 files both lines touched hold the live blob somewhere in main's history; main kept developing them (D7-4 protected registry, BILLING-QA). **Main kept.** |
| D7 core (#397) | a372221c | 58/63 files identical. The webhook `onConflict` fix is superseded on main by the BILLING-QA-6 RPC (section 4). The `addonUpsertConflictTarget.d7` test was missing on main and is added, adapted. |
| D7 pre-expiry (#405) | 81263ad8 | Yes (#401 92a172fe, #402 c1e16f6f). 13/14 identical; the 14th is the check-in actions file, which CI-B changed again. |
| H1 (AAL2 platform-admin support context) | c329b27b 42df27cd | Yes, all 17 files byte-identical. |
| TW-4F overlay | e17db5e7 | 537 files identical. 11 differ only because of the later live commits below. |
| TW-4F post-overlay (release-only) | aa538e27 dcea4b57 5f81e539 0a67d762 e46e40b7 f3a6288c 2ca1e97b ffdf9258 | **No.** KI-1 burned ceiling + held lift, inbound absorbed alerts, sub-cent micros pricing with carried remainder, cron registration. Brought in. |
| TW-4F pricing release (PR 441) | b76536d8 1fb31f97 3b3b2ee0 adbc665e ebeef20d | **No.** Micro-dollar price publication (migration `20270212090000` + rollback), `priceMicros.ts`, `priceChange.ts`, platform SMS price UI, pilot price manifest and docs. Brought in by the second merge. |
| Competition R2 refunds (#292 release candidate) | b82dba27 (+ 013387f7 integration merge) | **No.** 26 files missing; 2 shared (webhook, ownership fakes). Brought in. |
| CI-B desk balance | b5005911 05660a46 (+ a965f477 integration merge) | **No.** Brought in. |

Full per-file tables are in the session scratchpad, not the repo: `classify.tsv`, `proof_changed.tsv`, `proof_surface_nonlive.tsv`.

### Files main gains (46 that were missing on main, plus the hand-resolved webhook)

- **R2 code:**
  - `src/lib/payments/competitionRefunds.ts`, `competitionRefundRules.ts`, `competitionRefundSummary.ts`
  - `src/app/app/events/[id]/competition/registrations/refundActions.ts`
  - `.../registrations/[orderId]/refund/page.tsx` and the registrations page
  - the event-profitability export, accounting/Wave categories, `events/financial-summary.ts`
  - webhook routing (3 hunks)
- **R2 SQL:**
  - `20270103090000_competition_r2_entry_refunds.sql` and `20270103091000_competition_r2_refund_write_gate.sql`, with rollbacks and sql-tests
  - both are applied on PROD (S2, 2026-11-08)
- **CI-B:**
  - `src/lib/competition/checkinBalance.ts` and the check-in actions using it
  - `20270211090000_competition_checkin_balance_refund.sql`, applied on PROD 2026-11-09 04:03Z (md5 f7ff0735…)
- **TW-4F:**
  - migrations `20261231110000`, `20261231130000`, `20261231140000` and `20261231150000`, with rollbacks
  - `providerFeeLifecycle.ts`, `providerFeeAlerts/{sink,templates}.ts` and their tests
  - two cron entries in `vercel.json`: `sms-usage-reconcile` and `sms-provider-fee-lifecycle`, both dark until their env flags are on
- **Docs:** `docs/competition/r2-entry-refunds*.md`, `checkin-desk-balance.md`, `phase10c1-launch-readiness.md`

## 3. Migration checks

- **No timestamp collisions.** None of the 7 live-only timestamps exists on main.
- **No byte changes.** `git diff --name-status a965f477 HEAD -- src/lib/supabase/migrations` shows only `A` (main-only additions).
- **No object overlap.** The main-only migrations 20270201…20270209 (billing protected subscriptions, read watermark, `apply_studio_subscription_state`, D24 hosted invoices / drain / operator / intents / client invoices, price transitions) define no function, table or trigger that a live-only migration also defines.
- **CI-B body is current.** `20270211090000` re-creates `record_competition_checkin_payment` from main's newest body (`20270205100000` D7 desk gate). The only diff is the CI-B paid-sum clause, so no D7 guard is reverted.
- **Order caveat (documentation, not a defect).** PROD has 20270210090000/100000/110000, 20270211090000 and 20270212090000 applied, while 20270201090000, 0202, 0203110000, 0204 and 0206–0209 are not. PROD has no migration-history table (it is never `db push`ed), so this is harmless, but whoever applies the remaining chain must do it file by file, never with an ordering tool that assumes a prefix.

## 4. Conflict resolutions

`git merge` reported 18 conflicted files and auto-merged 5 more that both lines had changed. For each conflicted file I located the most recent live blob that also appears in main's history and used it as the true common base for a three-way merge (`git merge-file`). In every case except the webhook, exactly one side had changed since that base, so the resolution is mechanical.

| File(s) | True base | Changed since base | Resolution |
| --- | --- | --- | --- |
| `docs/billing/PRICING-P1.md`, checkout `route.ts` + `founderPriceGuard.pricingp1.test.ts`, `regularPricing.ts` | 1c8ab80f blob | main only | **main** |
| `subscriptionPlanResolution.ts` | 4bc938c6 blob | main only | **main** |
| `entitlementWriters.d7.test.ts` | — | live adds a release-only allowlist entry, commented "Drop on re-sync with main" | **main** (main's webhook no longer writes the table) |
| 11 TW-4F files (`providerFeeLifecycle.ts`, `providerFeeAlerts/sink.ts`, `templates.ts`, `TW-4F_Pilot_Readiness_Checklist.md`, 7 tests) | e17db5e7 blob | live only | **live** |
| `src/app/api/payments/webhook/route.ts` | — | both | **main + exact R2 delta** (below) |
| `addonUpsertConflictTarget.d7.test.ts` (added cleanly, would fail) | — | live-only test of a code path main removed | **adapted** (below) |
| Auto-merged: `settings/billing/page.tsx`, `founderPricing.ts`, roadmap | — | — | result = main (verified) |
| Auto-merged: `competition/checkin/actions.ts` | — | — | result = live (CI-B on top of main's D7 gates; verified) |
| Auto-merged: `payments/__tests__/ownershipFakes.ts` | — | — | main + R2 rpc-routing stub (verified) |

### Payments webhook

- **The line-level conflict was misleading.** Live still has `syncOrganizerSuiteAddonEntitlements`, which upserts `usage_addon_entitlements` directly. Main (BILLING-QA-6, #360) deleted it and writes the subscription row, the billing snapshot and the Suite entitlements atomically through the `apply_studio_subscription_state` RPC.
- **Resolution:** take main's file, then apply `git diff a372221c b82dba27` (the R2 change) unchanged.
- **Proof:** the merged file's diff against main is identical, line for line, to the R2 patch (`DELTA_IDENTICAL`). All 27 lines added by #319 are present.
- **R2 behaviour kept:**
  - `isCompetitionOrderPaymentIntent` short-circuits the pro-rata refund path.
  - `observeCompetitionRefundFromWebhook` records every competition refund object.
- **D7 #397 fix:** the change from `onConflict "studio_id,feature_key"` to `"stripe_subscription_item_id"` has no target on main. The RPC does select-by-item then update/insert, and has no `ON CONFLICT` at all, so the 42P10 failure it fixed cannot occur on main's path.

### `addonUpsertConflictTarget.d7.test.ts`

The live version sliced the webhook source at `.from("usage_addon_entitlements").upsert(`, which no longer exists on main. Rewritten to pin both paths:

- the webhook never uses `onConflict "studio_id,feature_key"`, and any direct upsert that reappears must target `stripe_subscription_item_id`;
- the RPC migration locates rows by `stripe_subscription_item_id` and contains no `ON CONFLICT`.

## 5. Verification

- **Tree proof** (all live-changed files): 729 = live, 9 = main's newer descendant, 3 hand-resolved (webhook, adapted test, ownership fakes). Live files missing: 0.
- **Surface proof (against ebeef20d):**
  - Scope: every live file under the payments webhook, refunds, check-in/desk balance, platform admin/AAL2/support context, `src/lib/sms`, twilio, tw4, `cron/sms-*`, `vercel.json` and all migrations, 1,273 files.
  - 1,270 are byte-equal to live.
  - The other 3: the webhook and the adapted test (hand-resolved, justified above), and `src/lib/payments/webhookVerification.ts`, which is main-newer (#379 live-mode/test-key refusal, a superset of live).
- **Commands:** see section 8 for tsc, eslint and vitest results.

## 6. Why main is still NOT promotable after this merge

PROD's schema lacks main's migrations `20270201090000`, `20270202090000`, `20270202100000`, `20270203110000`, `20270204090000` and `20270206090000`–`20270209090000`. Release notes (not hosted queries) record which ones PROD does have:

- the D7 pair `20270203090000`/`20270203100000` (2026-11-06);
- `20270205100000` (2026-11-06);
- `20270210090000`/`100000`/`110000` and `20270212090000` (TW-4F pricing release, 2026-11-09 21:05–21:07Z, per the CF1 coordinator).

main's runtime code that needs the missing migrations:

| Migration(s) missing on PROD | main code that needs it | Effect if promoted without it |
| --- | --- | --- |
| `20270202090000` read watermark, `20270202100000` `apply_studio_subscription_state` | webhook `upsertStudioSubscription` → `supabase.rpc("apply_studio_subscription_state")`, called on **every** studio subscription event, with no flag | **P0:** studio subscription webhooks fail (Stripe retries), and plan/status/Suite entitlement stop updating |
| `20270209090000` client invoices (`studio_billing_permission`, `studio_client_invoice_*`) | `/app/payments/invoices*`, linked from `/app/payments` for owners/admins, with no flag | broken page/actions for owners and admins |
| `20270201090000` protected subscriptions | checkout `loadProtectedRegistry` | degrades by design: it warns and falls back to the legacy-price backstop when the table is missing (`route.ts` ~L519) |
| `20270204090000` price transitions | `maybeReconcilePriceTransition` | dark unless `PRICE_TRANSITION_RECONCILE_ENABLED=true` |
| `20270203110000`, `0206`, `0207`, `0208` D24 hosted invoices | `handleHostedInvoiceEvent`, operator actions | dark unless `D24_HOSTED_INVOICE_EVENTS=on`/`defer` |
| `20270210*` SMS price dual control, `20270212090000` micros publication | TW-4F price code | applied on PROD 2026-11-09 and the code is live; not a gap |

Main-only runtime surface beyond live (312 files and ~76k lines, mostly `scripts/qa`, e2e and tests): billing checkout/portal, the price-config platform route (404 unless `BILLING_QA_PRICE_CONFIG_ENDPOINT=enabled`), client invoices UI, hosted-invoice libraries, the price-transition libraries, `protectedSubscriptions`, `subscriptionState`, and the webhook's BILLING-QA-6 path.

### Remaining gaps before main can be promoted

1. **Gate the RPC dependency.** Either apply `20270202090000` + `20270202100000` to PROD (with the preflight/postflight pattern used for D7), or put the RPC path behind a flag that falls back to the live upsert path. This is a decision.
2. **Client invoices.** Apply `20270209090000` (it depends on the D24 chain `20270203110000` → `0208`), or hide `/app/payments/invoices` behind a flag until it is applied.
3. **Rest of the chain.** Decide whether `20270201`, `0204` and `0206`–`0208` go to PROD now (additive; their code is dark or degrades) or stay held. If held, record that main carries schema-dependent dark code.
4. **Release-only work not on this live line.** If `release/cf1-hotfix-heat-schedulepush` (ebeef20d + heat-size bbadbf13 + PR 444 schedule-push) or the CF1 app candidate (draft #443) is promoted, main must take that head too. Follow the procedure in section 9.
5. **Before any promotion from main:** staged build, prod-schema compatibility check against PROD's function fingerprints (R2, gate, CI-B md5 f7ff0735…), and the usual 30-minute observation. Each step needs owner approval.

## 6a. Independent review of the merge resolutions

A separate reviewer, not shown these conclusions, inspected the merge commit `f7fe1483` against both parents and the base.

- **Verdict:** the merge is correct as a superset, with no P0 caused by the merge.
- **What the reviewer verified:**
  - no lost production behaviour;
  - no lost main behaviour;
  - no migration byte change;
  - no timestamp duplicate inside the result.
- **Findings and how each was handled:**

| Sev. | Finding | Handling |
| --- | --- | --- |
| P1 (pre-existing on main, not merge damage) | Webhook `apply_studio_subscription_state` needs `20270201`/`0202` SQL that PROD lacks | Section 6, gap 1. Blocks promotion of main. |
| P2 | main-only migrations 0201–0209 sort before PROD-applied 20270210–20270212 | Section 3 order caveat. No function overlap, so applying them late reverts nothing. Apply by manifest, never `db push`. |
| P2 (other branches) | **Forward timestamp collisions:**<br>• `20270211090000_mobile_push_token_claim.sql` (branches `claude/student-app-p0-design` and `claude/vibrant-shamir-15b692`) reuses CI-B's PROD-applied `20270211090000`<br>• `20270212090000_instructor_class_roster_names_rpc.sql` (branch `claude/instructor-class-roster-names`) reuses the PROD-applied `20270212090000_twilio_price_micros_publication.sql` | Those PRs must **renumber their migrations** before they merge onto this main. The applied ones keep their names. This merge's inventory script fails (exit 1) on a collision. |
| P2 | Two SMS crons become registered on main (`vercel.json`) | Matches production. The routes are dark until their env flags are on. No non-prod Vercel project may set those flags. |
| P3 | "Client invoices" link visible without the `20270209` SQL | Fails closed (redirects back to Payments). Covered by section 6, gap 2. |
| P3 | Checkout: main replaced production's "existing subscriber → Billing Portal" redirect with D7-3a support routing (`plan_change_requires_support`, `protected_subscription_needs_support`) | A deliberate main-side product change (D7-3a), shipped when main is promoted. The `price_mismatch` guard is kept. Owner awareness item. |
| P3 | Roadmap / PRICING-P1 docs take main's text | Expected. |

## 7. Owner decisions and authorizations needed

- **D-1:** approve merging this PR into `main`. It is Git-only and changes no deployment.
- **D-2:** choose how to close gap 1: apply the BILLING-QA-6 SQL to PROD, or add a flag/fallback in code.
- **D-3:** choose the PROD plan for the 0201–0210 chain (apply, or hold dark).
- **D-4:** after D-2/D-3, authorize a staged build from main and its promotion, which replaces the release-branch workflow.

## 8. Commands run (results)

Run on this branch, at the ebeef20d merge plus the doc/script/test commit, on 2026-11-09:

| Check | Result |
| --- | --- |
| `tsc --noEmit -p .` (`--max-old-space-size=8192`, `.next` removed) | **PASS** (exit 0). The default heap OOMs on this repo. |
| eslint on the 46 `.ts`/`.tsx`/`.mjs` files the merge adds or changes vs main, plus the new script and test | **PASS** (exit 0, no findings) |
| Targeted suites: `competitionRefunds.r2`, `competitionRefundRules`, `entryRefunds.r2`, `checkinBalance.cib`, `deskBalance.cib`, all of `api/payments/webhook/__tests__` (R2 routing, refund reconciliation wiring, package refund, D7 conflict target) and `entitlementWriters.d7` | **PASS**: 26 files, 349 tests. The first run caught the adapted D7 test matching `ON CONFLICT` inside a SQL comment; fixed by stripping comments before the assertion. |
| Full `vitest run --maxWorkers=4` | 639 files passed, 59 skipped (local-stack/DB suites), 2 files failed with 3 tests. All 3 failures are `Test timed out in 5000ms` under full-suite load, in `scripts/qa/d24-test-runner/__tests__/runner.test.ts` and `src/app/app/documents/__tests__/closeout.phase8d.test.ts`. Both files are byte-identical to main, and both pass in isolation (88/88). **Not caused by the merge.** |
| Inventory/proof script vs ebeef20d | exit 0 (section 1 numbers) |
| **Not run** | SQL sql-tests (`test_T_competition_r2_*`, `test_T_competition_checkin_balance`) and the TW-4F local-stack suites, which need a dedicated Postgres. The SQL files are byte-identical to the live line, where they were proven before the PROD apply. No `next build` and no e2e. |

## 9. Re-running when live moves

When www moves to a new head `<LIVE>` (for example `release/cf1-hotfix-heat-schedulepush`):

1. Inventory before merging:

   ```bash
   node scripts/release/main-vs-live-inventory.mjs --live <LIVE> --rec origin/main
   ```

   `mainSide` shows what main lacks. `MISSING_ON_MAIN` merges cleanly; review every `BOTH_CHANGED` file.
2. Merge `<LIVE>` into this branch, or into main once this PR lands. Because each live head contains the previous one, only the new delta conflicts. If a file conflicts, find the most recent live blob that also exists in main's history and use it as the merge base (`git merge-file`), as section 4 does.
3. Check the result:

   ```bash
   node scripts/release/main-vs-live-inventory.mjs --live <LIVE> --rec HEAD
   ```

   - Exit 0 is required: no live file missing, no migration byte drift, no timestamp collision.
   - Every `REC=MAIN` and `REC=HAND` row and every `surfaceNonLive` entry must be justified here.
4. Re-run tsc, eslint, the full vitest suite and the R2/CI-B/refund-gate suites. Update section 6 from the latest release notes on which SQL PROD has.
