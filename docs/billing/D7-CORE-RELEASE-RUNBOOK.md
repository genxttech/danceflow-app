# D7 core Organizer Suite release: runbook (DEV → staging → PROD)

**Status: plan and scripts only. Nothing in this document is authorized.** Every gate below needs the owner's explicit approval at that moment. Prepared 2026-11-01 against `origin/main` `c06222b7` and the local release candidate `local/d7-release-candidate` (based on `release/pricing-p1` `4bc938c6`).

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
| Disposable rehearsal | `scripts/release/d7_core_sql_dryrun.sh` (8 steps, all pass) |

## 2. Gates (owner approval required for each)
G1 push of the release branch / draft PR against `release/pricing-p1` · G2 DEV migration window · G3 staged (not promoted) build · G4 PROD migration window · G5 PROD promotion · G6 (later, separate) expiry activation and `period_end` update.

## 3. DEV window (G2)
1. Re-run `d7_core_preflight.sql` on DEV; all rows must pass (it checks the PRE-state ACL, that no D7 object exists, that no workspace has two active manual grants, studios.timezone, the desk RPC).
2. Apply migration 1, then migration 2, in one session (`supabase db query --linked -f <file>`; **never `supabase db push`**: DEV has a migration-history table, PROD has none, and the hosted histories are not aligned with the repository).
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
