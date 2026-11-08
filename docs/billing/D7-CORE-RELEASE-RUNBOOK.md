# D7 core Organizer Suite release: runbook (DEV → staging → PROD)

**Status: plan and scripts only. Nothing in this document is authorized.** Every gate below needs the owner's explicit approval at that moment. Prepared 2026-11-01 against `origin/main` `c06222b7` and the local release candidate `release/d7-core-organizer-suite` (PR #397) (based on `release/pricing-p1` `4bc938c6`).

## 0. Scope: what "core" means and what it is not
**In the core release:** the entitlement boundary for organizer-event purchases (cart, student checkout, private lessons, competition registration incl. free), in-person and Terminal sales, staff mark-paid, the competition registration-desk application gate, the audit trail, least-privilege grants, the dark expiry job, and protection of the existing complimentary grants.
**Not in the core release (separate milestones):** WP-3 regular-price transition (merged to `main`, needs the protected-subscription registry and the newer webhook route; dark); WP-4 paid add-on purchase; WP-5 advance notices; any expiry activation; setting `period_end` on DanceAbel's grant (a later, separate change).

**Day-one impact (PROD read-only, 2026-11-01):** 0 organizers, 0 organizer events, 0 organizer orders in 90 days. The new gate applies only to events with an organizer, so deploying it changes no live customer flow. The only entitlement rows are the 2 active, open-ended manual grants; they remain current after the migration (rehearsed, step 5 of the dry run).

## 1. Release artefacts
| Artefact | Where |
|---|---|
| Release candidate (application) | branch cut from `release/pricing-p1` with `#362 #363 #380 #381 #382` cherry-picked + the baseline writer-allowlist correction (`d410911e`) + the mark-paid hardening (section 6) |
| Migrations (apply in this order) | `20270203090000_organizer_suite_entitlement_integrity.sql`, then `20270203100000_usage_addon_entitlements_least_privilege.sql` |
| Rollbacks (reverse order) | `rollback/20270203100000_..._rollback.sql`, then `rollback/20270203090000_..._rollback.sql` (refuses once audit events exist) |
| Preflight / postflight (read-only) | `scripts/release/d7_core_preflight.sql`, `scripts/release/d7_core_postflight.sql` |
| Disposable rehearsal | `scripts/release/d7_core_sql_dryrun.sh` (9 steps plus tamper-detection and unapplied-target checks, all pass) |

## 2. Gates (owner approval required for each)
G1 push of the release branch / draft PR against `release/pricing-p1` · G2 DEV migration window · G3 staged (not promoted) build · G4 PROD migration window · G5 PROD promotion · G6 (later, separate) expiry activation and `period_end` update.

## 3. DEV window (G2)
1. Re-run `d7_core_preflight.sql` on DEV; all rows must pass (it checks the PRE-state ACL, that no D7 object exists, that no workspace has two active manual grants, studios.timezone, the desk RPC).
2. Apply migration 1, then migration 2, back to back (each call is its own session; run migration 2 only after migration 1 succeeded) (`supabase db query --linked -f <file>`; **never `supabase db push`**: DEV has a migration-history table, PROD has none, and the hosted histories are not aligned with the repository).
3. Run `d7_core_postflight.sql`; all rows must pass. Save both outputs.
4. DEV has 1 organizer, 2 organizer events and a Stripe-sourced Suite row but **no manual grant**: to smoke-test the grant path, create one manual grant in DEV only (separate approval; DEV data), then run section 5.
5. Rollback drill on DEV only if the owner wants it (reverse order; migration 1 rollback refuses once audit events exist, by design).

## 4. Staging (G3)
Build the release branch on Vercel as a **non-promoted** deployment (production domain untouched; rollback target stays the current production deployment of `release/pricing-p1`). Branch previews share the PROD Supabase project: **do not exercise authenticated flows on a preview that points at PROD data**; run the smoke plan against a DEV-pointing deployment/environment only.

## 5. Critical workflow smoke plan (DEV-pointing deployment; Stripe TEST mode)
| # | Flow | Expected |
|---|---|---|
| S1 | Organizer event, studio with a current grant: cart checkout, student checkout, free competition registration | allowed; platform fee tier unchanged (Pro add-on 3%) |
| S2 | Same flows with no entitlement | refused before anything is created; message "not accepting registrations" |
| S3 | Grant with `period_end` in the past | refused; paid/confirmed bookings and replay of a completed order still return their result |
| S4 | Private lesson with organizer set | gate applied before the slot is held |
| S5 | In-person sale (cash/check/comp/external card) and Terminal start | gated; existing Terminal fees unchanged |
| S6 | Staff mark-paid on an unpaid registration (twice, quickly) | exactly one payment row; second click is a no-op; cancelled/refunded registrations refused |
| S7 | Competition desk payment on an unpaid pending order with a lapsed grant | refused by the application gate (database enforcement is a pre-expiry gate, section 8) |
| S8 | Ordinary studio event (no organizer) | unaffected with no entitlement |
| S9 | Webhook replay of a completed order after expiry | still processes (webhooks never consult the entitlement) |

Playwright/E2E for these flows has not run for any D7 PR (environment not configured): S1-S9 are the browser-level evidence the release needs. Record results with screenshots/IDs, no customer data.

## 6. Release-blocking fix included: staff mark-paid
`markEventRegistrationPaidAction` was non-atomic: two concurrent requests both saw "unpaid" and both inserted a payment row, and a refunded/cancelled registration could be re-marked paid. Fixed on `claude/d7-markpaid-atomic` (conditional claim; only the winner records the payment; failed payment insert rolls the claim back; refunded/cancelled refused) and cherry-picked into the release candidate. Application-only; no migration.

## 7. PROD window (G4, G5)
1. Re-run `d7_core_preflight.sql` on PROD **immediately before** (catalog drift check). Expected: ACL = the PRE-state, no D7 objects, 2 active open-ended manual grants, 0 organizer events.
2. Apply migration 1, then migration 2 (same method as DEV). Run `d7_core_postflight.sql`; save outputs. **SQL before application.**
3. Promote the staged deployment (G5). Observe: error rate, `/api/events/*` and webhook logs for 30 minutes; confirm the 2 grants still read as current (postflight row 13/15) and that no `usage_addon_entitlement_events` rows were written by the deploy.
4. PROD has no migration-history table: record the applied versions and checksums in the release evidence instead.

## 8. Gates that are NOT part of the deployment but must be closed before expiry is ever activated
* **Database enforcement for the competition desk** (`record_competition_checkin_payment` can still be called directly by an authorized staff member after a grant lapses). Moot until a grant has a `period_end` in the past; must be shipped (migration + SQL tests; PROD function-fingerprint check first) **before** any `period_end` is set on a PROD grant.
* Approved notice workflow (WP-5) and the paid add-on purchase path (WP-4) must exist and be tested; the owner decision on what a studio may see after access ends; past-due handling of Stripe-sourced Suite rows.
* DanceAbel `period_end` update (grant `095f8801-7d18-4c73-8d0e-141bd93dcbca` → `2027-07-09`, instant 2027-07-09T04:00:00Z): separate authorization; **do not do it with the core release**.

## 9. Expiry-job operational safety
The job route answers 404 unless `ORGANIZER_SUITE_EXPIRY_ENABLED` is exactly `true`, is not in `vercel.json`, and only flips `manual_grant` rows already past their end instant (readers apply the same rule at request time, so enforcement does not depend on the job). With no `period_end` set anywhere in PROD it would change nothing even if enabled. Keep it dark. Activation later: set the variable, run once with `?dry_run=1`, review the dry-run list, then register an hourly cron (`7 * * * *`) in a deliberate release. Never enable it while any grant has a past `period_end` without the notice and purchase path in place.

## 10. Rollback and recovery (reverse dependency order)
1. **Application first:** promote the previous production deployment (`release/pricing-p1` build in service before G5). The old app tolerates the new schema (additive; the least-privilege change only affects `anon`/`authenticated` writes, which no app code uses).
2. **Then SQL, only if needed:** migration 2 rollback (restores the broad ACL: a security regression, so prefer leaving it), then migration 1 rollback (refuses while audit events exist; events are evidence and are never deleted).
3. If a migration fails mid-way: both run in one transaction each with a 5 s lock timeout; a failure leaves the database in the pre-state. Re-run the preflight to confirm.
4. Data recovery: entitlement rows are never deleted by D7; status changes are audited in `usage_addon_entitlement_events`.

## 11. Independent security review of the candidate (2026-11-01): verdict GO for deployment, no P1
* **Day-one:** every new gate is conditioned on `organizer_id`; PROD has none. The request-path gate is TypeScript and does not depend on the migrations, so SQL-first or app-first order both work; SQL first remains the rule.
* **Fixed in the candidate after the review (P2, pre-existing in production):** the webhook sync of an Organizer Suite subscription item upserted on `studio_id,feature_key`, for which production has no unique constraint (Postgres 42P10). A studio that bought the add-on would have failed its own subscription webhook. Candidate commit `12b78a23` targets `stripe_subscription_item_id`; proven against a PROD-shaped table (dry run step 9) and pinned by a test. `main` already replaced this path with the BILLING-QA-6 RPC.
* **Must be closed before any grant is given a `period_end` (not a deployment blocker):** (1) database enforcement for `record_competition_checkin_payment`; (2) `confirmEventRegistrationAction` can confirm an unpaid pending organizer registration with no gate; (3) `bookPrivateLessonSlotOfflineAction` has no entitlement check; (4) cart and student Checkout sessions created before expiry stay payable until their own expiry (competition sessions are actively expired), which matches "webhooks never consult the entitlement" but should be an explicit owner-accepted behaviour.
* **P3 follow-ups on the mark-paid claim** (not blockers): if row-level security silently blocks the update the action reports success without recording a payment (re-read and verify); a refund landing between the read and the claim could be re-marked paid (add the status filters to the claim); an orphan payment row if the optional Stripe-identity copy fails after the insert.
* **Before the release window:** confirm the two PROD grants are on different studios (the preflight's duplicate check already proves no workspace holds two) and that DanceAbel's `studios.timezone` is `America/New_York` (a NULL timezone falls back to UTC and would end the grant at 00:00Z instead of 04:00Z).

## 12. G2 window mechanics (after the independent G2 review, 2026-11-05: GO-with-fixes, no P1; fixes applied here)
**Review result:** the migrations, scripts and SQL-first order are sound for DEV. Findings fixed in this revision: the postflight now compares exact ACLs as sorted sets, checks `tgenabled`/table of every trigger, every D7 function's EXECUTE grants, index validity/partiality, and anon's REFERENCES/TRIGGER/MAINTAIN; it reports failing rows instead of erroring on an unapplied target; a wrapper now asserts the result programmatically; the dry run proves the postflight detects 8 kinds of tampering. Runbook text drift corrected (9-step rehearsal; candidate branch is `release/d7-core-organizer-suite`).

**Exact sequence for an approved window (DEV; PROD is identical with `prod`):**
```
export D7_DEV_WORKDIR=<checkout linked to DEV>   # and for PROD: export D7_PROD_WORKDIR=<scratch dir linked to PROD>
bash scripts/release/d7_core_artifact_check.sh                     # reviewed file hashes + release/pricing-p1 unchanged
bash scripts/release/d7_core_flight.sh preflight dev  evidence/    # must exit 0
bash scripts/release/d7_core_flight.sh recheck   dev  evidence/    # must exit 0; save fingerprint + grant baseline
supabase db query --linked -f <migration 1>                        # one transaction per file; a failure leaves the pre-state
supabase db query --linked -f <migration 2>                        # run only after migration 1 succeeded
bash scripts/release/d7_core_flight.sh postflight dev evidence/    # must exit 0
```
The wrapper refuses to send anything unless the linked project ref is the expected one (DEV `epdrtzcydvnoidwrepqz`, PROD `hvsujyfbftfffxpfmlpb`), saves the raw rows with a sha256, and exits non-zero unless the final row says every check passed. **Never `supabase db push`**: DEV's migration history holds 1 row against 441 repository files and PROD has no history table, so the history is not a source of truth; record the applied versions and file sha256 in the evidence instead. `db query -f` sends each file as one statement batch, so the file's own `begin/commit` is the transaction (verified: a failing precondition leaves no partial state and no session residue). The two files are separate calls (separate sessions); run migration 2 only after migration 1 succeeded.

**Stop conditions (any one aborts the window):** artifact check fails; preflight or recheck exits non-zero; the recheck shows another session in a transaction or holding a lock on `usage_addon_entitlements`; the server is not PostgreSQL 17.x; the manual-grant baseline or definition fingerprint differs from the values saved at preflight; the linked project ref is not the intended one.

**Evidence to capture:** raw preflight/recheck/postflight rows + sha256, the sha256 of each applied file, timestamps, the manual-grant baseline (id/status/period; the audit trail starts empty because the migration backfills nothing, so this is the known starting state), and an export of any audit events before any rollback attempt.

**Rollback reality (do not discover this during an incident):**
* After promotion the first real entitlement write creates an audit event, and migration 1's rollback **refuses once any event exists**. SQL rollback of migration 1 is therefore effectively one-way after go-live. The recovery order is: roll back the **application first** (promote the previous deployment) and **leave the SQL in place**; the old app tolerates the new schema.
* If migration 1 must be removed after events exist, the emergency path is to drop only `usage_addon_entitlements_audit_trg` (stops new audit writes while keeping the evidence table and its history), record the unaudited window, and fix forward. Never delete audit events.
* Rolling back migration 2 re-grants `anon`/`authenticated` full privileges on the entitlements table (the pre-state), including TRUNCATE. Prefer leaving migration 2 applied.

## 13. PROD window (G4 SQL, G4b staged build, G5 promotion): PREPARED, NOT AUTHORIZED (2026-11-06)
**Status:** nothing in this section has been run against PROD. Every step needs the owner's explicit approval at that moment. DEV evidence this section relies on: both migrations applied to DEV 2026-11-06 with all 16 postflight checks passing; staged candidate smoke 5/5 (free flows, lapse/restore) and 10/10 (paid flow on a Stripe TEST connected account); fixture cleaned (no `d7-smoke` rows remain; 17 audit events kept by design).

**PROD facts (read-only, 2026-11-06, evidence in the scratchpad `g4-prep-evidence`):** preflight and recheck pass; ACL is the exact pre-state; 2 active, open-ended manual grants (`095f8801-7d18-4c73-8d0e-141bd93dcbca`, `b515dc91-5d28-4c19-90d8-4cd589ad57fe`), both on `America/New_York` studios; 0 organizers / organizer events / organizer orders; entitlements definition fingerprint `eb924d51a569321aaa4c678562aa0090`, identical to DEV's pre-apply value; no migration-history table; PostgreSQL 17.6. Production serves `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (`release/pricing-p1` `4bc938c6`); rollback target for the application is that same deployment.

**What the candidate changes vs the production line (63 files):** application code and the two migrations only. No new environment variable is required (the expiry job's flags are dark by default), and `vercel.json`, `package.json`, `package-lock.json` and `next.config.ts` are unchanged: no cron, dependency or build-config change. Deploying changes no live customer flow (no organizer events exist).

### 13.1 Decisions needed before the window (owner)
1. **How the production line is updated.** (A, recommended) merge PR #397 into `release/pricing-p1` so the production branch head equals the deployed commit (traceable, rollback anchor stays `4bc938c6`); or (B) stage directly from the unmerged branch head `release/d7-core-organizer-suite` (nothing changes on `release/pricing-p1`; weaker traceability). Either way, PRs #396 and #403 should reach `main` so `main` does not lose the fixes.
2. **Accepted gaps** (not exercised on DEV): Terminal / in-person sales (S5), staff mark-paid UI (no UI caller exists; covered by unit tests), real Stripe-delivered webhooks, a pending paid order that lapses mid-flight. None is reachable in PROD today (0 organizers).
3. **Observation owner.** Who checks Stripe webhook deliveries and app errors for 30 minutes after promotion.

### 13.2 Sequence
| Step | Gate | Action | Evidence / stop condition |
|---|---|---|---|
| 0 | none (read-only) | within 24h of the window: `d7_core_artifact_check.sh`, `d7_core_flight.sh preflight prod`, `recheck prod` | all exit 0; record the grant baseline and fingerprint; STOP on any difference from the values above |
| 1 | **G4** | `d7_core_flight.sh preflight prod` + `recheck prod` again immediately before; apply migration 1, then migration 2 (`supabase db query --linked --workdir <PROD workdir> -f <file>`); `d7_core_flight.sh postflight prod` | postflight exit 0; STOP and do not continue if migration 1 fails (nothing to undo); if migration 2 fails after 1, re-run it (idempotent) after diagnosing |
| 2 | **G4b** | stage the application: from a clean `git archive` of the exact commit in a scratch directory, `vercel deploy --prod --skip-domain` with the cached CLI (`%LOCALAPPDATA%\npm-cache\_npx\69f9afb961c37556\node_modules\.bin\vercel.cmd`, env `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` for `danceflow-app-qfem`, `--scope dance-flow --non-interactive`, never `--yes`) | deployment `Ready`, **not promoted**; `www` still serves `dpl_HEvyvNbH…` |
| 3 | none (public, read-only) | anonymous checks on the staged URL / after promotion: unsigned `POST /api/payments/webhook` returns 400; `GET /api/billing/addons/organizer-suite/checkout` returns 405; `GET /api/cron/organizer-suite-entitlement-expiry` returns 404; public pages render; asset `dpl=` markers | STOP on any mismatch. **No authenticated production flows** (owner policy: no production test accounts; record the owner-specified security note about omitted authenticated production smoke, with DEV staged-candidate evidence instead) |
| 4 | **G5** | `vercel promote <staged dpl_id> --scope dance-flow`; confirm `vercel inspect www.idanceflow.com` resolves to it | domains `www.idanceflow.com` and `idanceflow.com` |
| 5 | none | 30-minute observation: owner confirms Stripe webhook deliveries stay 200 and the app logs show no new error class; run `d7_core_flight.sh postflight prod` and `recheck prod` again: the 2 grants unchanged, `usage_addon_entitlement_events` still 0 (the deploy itself writes no entitlement) | any unexplained error => rollback |

### 13.3 Rollback (reverse dependency order)
1. `vercel rollback dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (previous production; stays Ready). Verify `www` resolves to it.
2. **Leave the SQL in place.** The previous application runs against the new schema (additive; only anon/authenticated writes were removed, which no application code used). Rolling back migration 2 reintroduces anon TRUNCATE; rolling back migration 1 is refused once any audit event exists (before any entitlement write it is still possible: rollback 2 first, then rollback 1).
3. Environment variables were not changed by this release, so there is no environment rollback.

### 13.4 After promotion (separate, later; do not do these in the window)
Expiry activation, DanceAbel `period_end`, and every commercial step stay blocked until: PR #402 (desk RPC database enforcement, applied after migration 1) and PR #401 (confirm / offline-booking gates) are released; the paid add-on (WP-4) and the advance notice (WP-5) exist and are tested; an owner decision on what a studio sees after access ends.

### 13.5 Approval request text (copy for the owner)
"Approve G4: apply `20270203090000` then `20270203100000` to PROD `hvsujyfbftfffxpfmlpb` under `docs/billing/D7-CORE-RELEASE-RUNBOOK.md` section 13, with the artifact check, preflight, recheck and postflight evidence saved; no application change in this step; rollback is the application only; the two existing complimentary grants remain active and open-ended."

### 13.6 Execution record (2026-11-06)
* **G4 (SQL) executed** 01:56-01:57Z: both migrations applied to PROD; postflight 16/16; grants unchanged; audit events 0.
* **Option A executed:** PR #397 squash-merged into `release/pricing-p1` at 02:12Z; the head is `a372221c` and its tree (`2beaeee3f858`) is identical to the tested candidate `4af19181`; no attribution lines.
* **G4b executed** 02:16Z: staged deployment `dpl_DFKP5sMmJMa1XiDe2czo49hvX4wz` (`danceflow-app-qfem-eh0bcin43-dance-flow.vercel.app`), target production, Ready, built with `vercel deploy --prod --skip-domain` from a clean `git archive` of `a372221c`. **Not promoted:** `www.idanceflow.com` and `idanceflow.com` still serve `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`. The staged URL is SSO-protected (302 to anonymous requests), so the public checks of step 3 run on the production domain immediately after promotion (or via a project automation-bypass secret, which must then be revoked; not created).
* **Rollback target unchanged:** `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`.
* **G5 executed 2026-11-06 02:30:41-02:30:56Z:** `dpl_DFKP5sMmJMa1XiDe2czo49hvX4wz` promoted; `www.idanceflow.com` and `idanceflow.com` resolve to it (98 `dpl=` markers in the live HTML). Public checks: home/login/studio sign-up 200, `/events` 307, unsigned webhook POST 400, GET on the add-on checkout and AI remove routes 405 (POST-only fix live), expiry cron 404 (dark). PROD postflight after promotion: all checks pass, both grants unchanged, 0 audit events. Rollback target remains `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`; leave the SQL in place.
