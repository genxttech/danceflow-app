# D7 DEV smoke-test manual grant

**Status: prepared and tested on a disposable Postgres only. Not run against hosted DEV or PROD. Running it on hosted DEV needs the owner's approval (it writes DEV data).** Prepared 2026-11-05. Read-only queries against hosted DEV (`epdrtzcydvnoidwrepqz`, SELECT only, catalogs and ids, no personal data) were used for section 2.

Purpose: the core release smoke plan (`D7-CORE-RELEASE-RUNBOOK.md` section 5, cases S1, S3 to S8) needs an organizer-event studio with a CURRENT complimentary Organizer Suite manual grant. The runbook notes DEV has "no manual grant".

## 1. Answer

**Can existing DEV grants or disposable QA fixtures satisfy the smoke test?**

- **Existing DEV data: no.** DEV has exactly one `organizer_suite` row, a `stripe_subscription_item` row, and no `manual_grant` row. The only studio with organizer events is on the Organizer plan, which does not consult the entitlement (so it cannot exercise a grant). The studio that has the Stripe-sourced Suite row has no organizer events. Details in section 2.
- **Disposable QA fixtures: yes, and this is the cleaner route.** `e2e/helpers/stripeTestModeFixture.ts` creates exactly the needed shape in one call: a Pro studio (`billing_plan=pro`, active `studio_subscriptions` row), a `manual_grant` Organizer Suite row (`notes: "CI-A Stripe test-mode E2E fixture"`), an organizer, and organizer events (plus one studio-hosted event for S8). It needs a Stripe TEST connected-account id (`createStripeTestModeFixture(config, { connectedAccountId })`). `e2e/helpers/ticketPricingFixture.ts` also creates a Pro studio plus a manual grant but its events have `organizer_id = null`, so it exercises studio ticketing, not the organizer gate. Cleanup removes the studio (the entitlement cascades; since the D7 migrations the service role has no DELETE on the table, and the audit trigger records the cascade as a `delete` event). Both fixtures run through the E2E guard (`src/lib/e2e/guards.ts`, localhost app server; Supabase target must not be the known PROD host).
- **Therefore**: for S1 to S9 prefer the disposable fixture. Use the manual grant script below only if a persistent DEV studio is wanted (for example to click through the UI by hand); then it needs one more DEV write the script does not do: an organizer event on that studio, which is outside this script.

## 2. Findings (hosted DEV, read-only, 2026-11-05)

| Question | Result |
|---|---|
| D7 migrations applied on DEV? | No: no `usage_addon_entitlement_events` table, no `usage_addon_entitlement_is_current` function, no one-active-manual-grant index. Entitlement table ACL is the broad pre-state (anon/authenticated/service_role all privileges) |
| `usage_addon_entitlements` rows | `organizer_suite / stripe_subscription_item / active`: 1 (id `a3b1df74-0f56-44fe-a217-8f60d9fc7cc4`, studio `a25932ab-93a6-4a35-9434-1e7442135a73`, note "Dev entitlement restored after subscription-state regression", no period dates). `ai_action / stripe_subscription_item / canceled`: 2. **No `manual_grant` rows** |
| Organizers | 1 |
| Studios with organizer events (`events.organizer_id` not null) | `c920b3d1-00cc-4057-bdd5-2a5f3750abb6`: 2 organizer events, timezone `America/New_York`, `studios.billing_plan=pro`, `subscription_status=trialing`, but its `studio_subscriptions` plan is **organizer** (trialing). Plan-based fee/gate code returns the standalone Organizer fee for this plan before it looks at entitlements (`platformFee.ts`, cart checkout `getOrganizerPlatformFeePercent`), so a grant on it would not be exercised |
| Studio with the Stripe-sourced Suite row | `a25932ab-...`: Pro, active, `America/New_York`, 7 events, 0 organizer events. A manual grant here would sit beside the Stripe row and mask S2/S3 (no entitlement, lapsed grant), because the Stripe row keeps access current |
| Studios by `billing_plan` | starter 50, growth 30, pro 3, organizer 1 (84 total) |
| Migration-history table | `supabase_migrations.schema_migrations` exists on DEV (PROD has none, runbook section 3) |
| PROD marker rows present on DEV? | none (DanceAbel studio `dd6c35ce-...`, grants `095f8801-...` and `b515dc91-...` are absent) |

## 3. The scripts

- `scripts/release/d7_dev_smoke_grant.sql`: one transaction; a DO block with the DEV-only checks, then the INSERT.
- `scripts/release/d7_dev_smoke_grant_rollback.sql`: cancels the marked grant (variant A, default) with the delete variant B included commented out.
- `scripts/release/d7_dev_smoke_grant_test.sh`: disposable-Postgres test (postgres:17, the release-runbook stub, then both D7 migrations).

Use (only after approval, from `C:/Dev/studioapp`): edit `v_studio` in the DO block (a nil UUID makes the script refuse), then
`supabase db query --linked -f scripts/release/d7_dev_smoke_grant.sql -o json` (the output has a leading "Initialising login role..." line before the JSON). Do the same with the rollback file after the smoke run.

**Target studio**: must have an active/trialing Starter, Growth or Pro `studio_subscriptions` row (checked), should have no other active Organizer Suite row (a notice is raised if it does), and must host an organizer event. Today no DEV studio satisfies all three; see section 1.

### The exact INSERT

```sql
insert into public.usage_addon_entitlements
  (studio_id, workspace_type, feature_key, quantity_included, source, status, period_start, period_end, notes)
values
  (v_studio, 'studio', 'organizer_suite', 1, 'manual_grant', 'active', null, null, 'DEV D7 smoke test, remove after');
```

Open-ended (no `period_end`) so the S1 flows are allowed. For S3 (lapsed grant) set an end in the past on the same row, as a separate DEV statement after approval: `update public.usage_addon_entitlements set period_end = current_date - 1 where studio_id = '<studio>' and source = 'manual_grant' and notes = 'DEV D7 smoke test, remove after' and status = 'active';` and restore it with `set period_end = null` (an audited `period_change` once the D7 migrations are applied).

## 4. How the script knows it is not PROD, and the limits

It refuses unless all three hold (fail closed; all rolled back on refusal): (1) none of the known PROD marker rows exists: the DanceAbel studio `dd6c35ce-0765-4247-afc2-9738817e991c` and the two PROD manual grants `095f8801-7d18-4c73-8d0e-141bd93dcbca`, `b515dc91-5d28-4c19-90d8-4cd589ad57fe`; (2) the known DEV marker rows exist (DEV studio `a25932ab-...`, DEV entitlement `a3b1df74-...`); (3) `supabase_migrations.schema_migrations` exists.

Limits, stated plainly:
- It is an identity heuristic, not proof. A PROD marker row could be deleted, or DEV could be refreshed from PROD (then the PROD markers appear and the script refuses, which is the safe direction).
- If someone deletes the DEV marker rows or rebuilds DEV, the script refuses until the markers are deliberately updated.
- It cannot detect a third database (a clone) that has neither set of markers: signal (2) requires the DEV markers, so such a database is refused.
- `current_database()` is `postgres` on every Supabase project, so it carries no information. The only real protection is also running with the DEV-linked CLI (`supabase/.temp/project-ref` = `epdrtzcydvnoidwrepqz`; PROD is `hvsujyfbftfffxpfmlpb`); check that before running.

## 5. Rollback: which variant applies when

| Situation | Use |
|---|---|
| Any time (D7 migrations applied or not) | **Variant A (default): set `status = 'canceled'`** (the rollback script). The row is kept as history. Idempotent: a second run changes 0 rows |
| D7 migrations **not** applied (today's DEV) | Variant B (delete) is possible, because the service role still holds DELETE. It is commented out at the bottom of the rollback file and refuses automatically when the audit table exists |
| D7 migrations applied (`20270203090000` and `20270203100000`) | **Delete is not an application path**: the service role has no DELETE after `20270203100000`; a delete by the table owner is audited as a `delete` event that is permanent. Use variant A. A `canceled` row does not block a later grant (the unique index covers only active manual grants) |

## 6. Audit-event expectations (after the D7 migrations)

Verified by `d7_dev_smoke_grant_test.sh` on a disposable database:
1. Granting writes one `usage_addon_entitlement_events` row: `event_type=insert`, `to_status=active`, `actor=d7_dev_smoke_grant`, `reason='DEV D7 smoke test grant (scripts/release/d7_dev_smoke_grant.sql)'` (the scripts set `app.entitlement_actor` and `app.entitlement_reason` transaction-locally; before the migrations these settings are harmless).
2. Rollback writes one `status_change` event `active -> canceled` (same actor, reason naming the rollback script).
3. A second rollback is a no-op: 0 rows, no event.
4. `usage_addon_entitlement_is_current` is true for the grant and false after cancellation.
5. A second grant for the same studio is refused by the script's own check and, independently, by the unique partial index.

Before the D7 migrations there is no audit table: the only evidence is the row and its `notes` marker (and the output of the run).

## 7. Test results (disposable postgres:17, release-runbook stub)

`bash scripts/release/d7_dev_smoke_grant_test.sh` (needs Docker; uses `git show origin/claude/d7-core-release-runbook:scripts/release/d7_core_stub_prod_shape.sql`): ALL PASS. Pre-D7: refusals for the nil id, unknown studio, Organizer-plan studio, studio without a subscription, a PROD marker studio, a PROD marker entitlement, a missing migration-history table, missing DEV markers; grant inserted with the designed content; second grant refused; rollback cancels (row kept) and is idempotent; re-grant; variant B deletes. Post-D7 (both migrations applied): grant, audit event content, current-ness, duplicate refusal, rollback, event sequence `insert, status_change`, no event on repeat, variant B refuses, service role DELETE denied.
