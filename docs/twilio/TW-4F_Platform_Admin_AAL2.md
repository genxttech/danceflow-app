# TW-4F: platform-admin session assurance (AAL2 step-up)

Status: implemented in Git only (one migration written, NOT applied anywhere; nothing deployed). Owner-approved bounded remediation, 2026-10-24.
Code: `src/lib/auth/platform-assurance.ts` (the one guard), applied in `src/app/platform/sms/*Actions.ts`, challenge page `src/app/(auth)/platform-mfa/challenge/page.tsx`.
Tests: `src/lib/auth/__tests__/platformAssurance.test.ts`, `src/app/platform/sms/__tests__/platformActionAssurance.aal2.test.ts`.

## 1. Finding

`src/app/platform/layout.tsx` calls `requirePlatformAdmin()` then `requirePlatformMfa()` (verified TOTP factor + `aal2`), so a PAGE render of the panel already demands MFA. Server actions are not covered by that: a Next.js server action is a POST endpoint that runs without rendering the layout, and every TW-4F action called only `requirePlatformAdmin()` (role). A platform-admin session at aal1 (password only, or a stolen/old session cookie) could therefore invoke fee-bearing and irreversible steps. The dual-admin approvals, typed confirmations and the database actor checks all still applied, but none of them proves the session was MFA-verified.

## 2. Scope: every platform-admin entry point reachable from the TW-4F panel

Classes: **R** read-only; **C** config / state change without money or provider effect; **F** sensitive-financial (ledger, spend, exposure, approvals); **P** provider-billable (can create or pay for a Twilio resource); **I** irreversible provider step (cancel/release/activate). Required assurance: **A2** = `aal2` session; **A2+R** = `aal2` AND TOTP verified within 15 minutes ("recent"). All actions also keep the existing `requirePlatformAdmin()` role check (now run inside the guard), their rate limits, typed confirmations, dual-admin controls and the database actor re-checks. Nothing was weakened.

### 2.1 Server actions (all in `src/app/platform/sms/`)

| File | Action | Class | Current check (before) | Required now |
|---|---|---|---|---|
| actions.ts | saveStudioSmsRegistrationAction | C | role | A2 |
| actions.ts | setSmsOnboardingAccessAction (pilot access) | C | role | A2 |
| actions.ts | runSmsOnboardingAction (brand submission runner) | P | role + runner window | A2+R |
| actions.ts | setSmsRunnerWindowAction (opens the provider-call window) | P | role | A2+R |
| panelActions.ts | panelCreateEntityAction | C | role | A2 |
| panelActions.ts | panelDecideLinkAction (legal-entity link) | C | role | A2 |
| panelActions.ts | panelDecideTierAction | C | role | A2 |
| panelActions.ts | panelSetSpendCapAction | F | role | A2+R |
| panelActions.ts | panelAuthorizeFeeAction | F/P | role | A2+R |
| panelActions.ts | panelWithdrawFeeAction (reduces exposure) | C | role | A2 |
| panelActions.ts | panelCreatePilotExceptionAction | F | role | A2+R |
| panelActions.ts | panelCreateSubaccountAction (G-SUB, creates a Twilio subaccount) | P/I | role | A2+R |
| provisioningRunActions.ts | runProvisioningStepAction (service, fee-bearing campaign) | P | role | A2+R |
| provisioningRunActions.ts | runNumberStepAction (offer, fee-bearing acquire) | P | role | A2+R |
| provisioningActions.ts | resolveProvisioningOperationAction | F | role | A2+R |
| provisioningActions.ts | reopenProvisioningAction | F/P | role | A2+R |
| provisioningActions.ts | recordProviderListingAction (evidence; GET-only provider read) | C | role | A2 |
| recoveryActions.ts | retryRegistrationAction | P | role | A2+R |
| recoveryActions.ts | retireDeferredAction | C | role | A2 |
| activationActions.ts | recordActivationSenderAction, attestOptOutAction, runComplianceAction (provider read), verifyActivationSenderAction (provider read) | C | role | A2 |
| activationActions.ts | markReadyAction, activateAction (pilot approval and manual release) | F/I | role | A2+R |
| activationActions.ts | suspendAction (emergency stop) | C | role | A2 (deliberately not "recent") |
| senderActions.ts | recordSenderAction, verifySenderAction, revokeSenderAction | C | role | A2 |
| usageReconcileActions.ts | resolveUsageAttemptAction (usage/ledger settlement) | F | role | A2+R |
| recurringFeeActions.ts | rflSetSwitchAction (scheduler switches) | F | role | A2+R |
| recurringFeeActions.ts | rflDualRequestAction, rflDualApproveAction | F/I | role + dual | A2+R |
| recurringFeeActions.ts | rflDisposeExposureAction, rflPilotCoverAction (per-period written approval) | F | role | A2+R |
| recurringFeeActions.ts | rflCancelAuthorizeAction, Begin, Finish, Resolve, ReleaseAction (provider release) | I | role + dual | A2+R |
| recurringFeeActions.ts | rflVarianceAckAction, rflDualRejectAction, rflCancelWithdrawAction | C | role | A2 |
| recurringFeeActions.ts | rflSuspendAction (stops DanceFlow sending) | C | role | A2 (deliberately not "recent") |

Why the safety stops (`suspendAction`, `rflSuspendAction`, `revokeSenderAction`, the withdraw/reject actions) are A2 and not A2+R: they only reduce exposure, and an incident responder must not be blocked by an expired 15-minute window. They still require a verified MFA session.

### 2.2 Credit and ledger adjustments

There is no platform-panel action that adjusts a credit balance or writes a ledger entry directly. Credit purchases settle through the Stripe webhook (`tw4_credit_settle_topup`, service role, secret-authenticated) and the owner flow; the platform pages (`SmsCreditAdmin.tsx`, ledgers) are read-only. Usage settlement is `resolveUsageAttemptAction` (above). If a manual credit adjustment is ever added it must call `requirePlatformStepUp("recent")` and be added to the coverage test registry (an unclassified exported action fails the test).

### 2.3 Route handlers

No route under `src/app/api/**` acts as a platform admin for TW-4F (about 20 billing and Stripe Terminal routes accept a platform-admin session in studio context; none is TW-4F). Cron/webhook routes authenticate by shared secret or provider signature (`/api/sms/twilio/*`, scheduler routes), not by an admin session, so session assurance does not apply. `src/app/api/mobile-push/test/route.ts` is also an admin-session route (not TW-4F; out of scope).

### 2.4 SQL `tw4_*` service-role entrypoints (migrations `202611*`-`202612*`, about 200 functions)

The platform-admin `tw4_*` functions follow one pattern: `security definer`, `revoke all ... from public, anon, authenticated` and `grant execute ... to service_role` (confirmed in the admin-panel, RFL and provisioning migrations; the grant lines are multi-line, so this was spot-checked and grep-checked for `to authenticated`, not proven by a catalog query. Verifying it against the isolated QA database catalog is a cheap follow-up). They are reachable only with the service-role key (held by the Next.js server). They check `p_actor` against `profiles.platform_role` but see no end-user JWT, so they cannot verify `aal`. The only `tw4_*` functions granted to `authenticated` are the studio-owner ones (`tw4_num_select_as_owner`, `tw4_num_withdraw_as_owner`, and the owner read functions), which are not platform-admin paths.

**Direct database paths that carry the admin's OWN token (found in independent review).** `saveStudioSmsRegistrationAction` and `setSmsOnboardingAccessAction` use the user-scoped client: `studio_sms_registrations` is writable by `authenticated` under RLS policies that check only the role, and `set_sms_onboarding_access` / `list_sms_onboardings` / `sms_credit_admin_overview` / `sms_recurring_admin_overview` are granted to `authenticated` and gated by `_sms_onb_is_platform_admin()` (uid + role). An aal1 token could call PostgREST directly and skip the server-action guard. Because `auth.jwt()` IS the admin's verified token on these paths, a SQL check works here: migration `20261231090000_twilio_platform_admin_aal2.sql` (rollback in `migrations/rollback/`) adds `aal = 'aal2'` to `_sms_onb_is_platform_admin()` and the three registration policies. **Written, not applied; not exercised against a database in this change** (static tests only). It also makes those admin reads aal2-only. See section 4 for why the service-role functions need no SQL change.

### 2.5 Read-only views

All `/platform/sms` pages and panels (`page.tsx`, `ActivationPanel`, `RecurringFeesPanel`, ledgers, `UsageReconciliation` data) are class R. They are gated by the layout (`requirePlatformMfa`) for page renders. The browser-reachable admin read functions and the registrations select policy are additionally gated by the migration above. The service-role reads behind the page add no MFA of their own: they move no money and call no provider, and the layout already enforces aal2 on render. Residual: Next renders layout and page concurrently, so a page's data fetch may run before the layout redirect is sent; the response to an aal1 browser is still a redirect, so nothing is displayed. A read-level hardening (calling `requirePlatformMfa()` inside the SMS page too) is a cheap follow-up if the owner wants it.

### 2.6 Adjacent platform actions NOT changed (out of TW-4F scope, listed for the owner)

`src/app/platform/actions.ts` (`createPlatformAdminAction` records an audit note in `platform_admin_actions` (it does not grant the role; a guard trigger protects `platform_role`); `setStudioWorkspaceActiveAction`; credential approve/reject/reset; `repairStudioPortalLinksAction`; broadcast alerts), `expenses/`, `invites/`, `ops-review/`, `sales/`, `success/`, `wave/` actions also check role only. Inline actions in `platform/alerts/page.tsx` are role-only too. A follow-up can guard them with `requirePlatformStepUp`; the guard is generic. Separate ticket: `repairStudioPortalLinksAction` upserts `profiles.platform_role = null` for auth users whose email matches a studio client, which could demote a platform admin sharing such an email.

## 3. Design

### 3.1 What is checked, server side

`requirePlatformStepUp(tier, returnTo = "/platform/sms")`:

1. `requirePlatformAdmin()` first (unchanged; a non-admin never reaches the assurance code and no claims are read).
2. `supabase.auth.getClaims()`: the JWT is **verified** (signature against the project's signing keys, or by the Auth server for a symmetric secret). We never trust the cookie contents, and we do not use `getAuthenticatorAssuranceLevel()` for the decision because it decodes the token without verifying it.
3. `evaluateAssurance` (pure, unit-tested): `sub` equals the admin id from step 1; `exp` is a number in the future; `aal === "aal2"` exactly; `amr` contains a `totp` entry. For tier `recent`, the **newest** `totp` entry must have a numeric `timestamp` no older than `STEP_UP_WINDOW_SECONDS` (900 s) and no more than 60 s in the future. A string-format `amr` cannot prove recency, so it passes `aal2` but fails `recent`.
4. Anything else (claims error, thrown error, missing/unknown/malformed field) is a refusal. Fail closed; there is no fallback to the role alone.

The window uses the `amr` TOTP timestamp, which Supabase sets when `mfa.challengeAndVerify` succeeds and preserves across token refresh. A password re-login does not renew it. Replay: a stolen aal2 cookie is usable for `A2` actions until the session ends, and for `A2+R` actions only within 15 minutes of the last authenticator code; after that the thief needs a fresh code. (Whether GoTrue rejects reuse of a TOTP code inside its validity window was not verified; do not rely on it.)

### 3.2 Failure experience (never silent)

A refusal `redirect`s (it throws; the action does not run) to `/platform-mfa/challenge?stepup=1&reason=<code>&next=<path>`. The challenge page shows an amber notice: "...It was not performed. Enter a code to continue, then repeat the action." (`stepUpMessage`). On a good code it returns to `next`, restricted to a plain `/platform...` path (`safePlatformReturnPath`: no scheme, host, backslash, traversal, query or encoding; anything else falls back to `/platform/sms`). An already-aal2 session is allowed onto the challenge page when `stepup=1` (before, it was bounced to `/platform`), which is how the 15-minute window is renewed. With no verified factor the page redirects to the existing enrolment page. The action is not replayed automatically: the admin repeats it, so a typed confirmation is always a fresh, deliberate act.

### 3.3 Enrolment today

Platform admins already have TOTP enrolment: `/platform-mfa/setup` (enrol + verify) and `/platform-mfa/challenge`, used by the layout gate. Nothing new is needed for enrolment. Gaps that remain and are not fixed here: only TOTP (no WebAuthn/recovery codes), a single factor, no admin-visible "last verified" indicator. Every platform admin who will use these actions must enrol before the pilot; an admin without a factor is sent to setup.

### 3.4 Tiers

`aal2` for configuration and protective actions; `recent` for money, provider-billable, irreversible and activation actions. 15 minutes balances an operator doing a multi-step run (create subaccount, then authorize fee, then run step) against a stolen-session window. Not environment-configurable, so a mis-set variable cannot widen it.

## 4. SQL layer decision

A SQL aal check would read `auth.jwt() ->> 'aal'`. These functions are called with the service-role key, so `auth.jwt()` is the service role's, not the admin's. The only alternative is an app-supplied parameter (`p_aal`, `p_verified_at`), which the app (the same holder of the service key) can set to anything, so it adds no security against a compromised app or key and widens ~60 function signatures plus their grants and rollbacks. Defence in depth that is real: (a) the functions are service-role only (no browser or `authenticated` path to call them), (b) they re-check the platform-admin actor, (c) dual-admin and typed-approval rules live in SQL. A true SQL-verified aal would need the actions to call the RPCs with the admin's own JWT (user-scoped client) and the functions granted to `authenticated`; that is a larger redesign (it also exposes them to direct browser calls) and is **not recommended**. So the service-role `tw4_*` functions are unchanged. The migration in section 2.4 covers only the paths where the admin's own token reaches the database, which is where a SQL check is meaningful. Number 20261231090000 is the slot reserved for this change (20261230090000 belongs to the merged RFL pilot-spend-evidence migration).

## 5. Tests

- `platformAssurance.test.ts`: pure decision (aal1, missing/unknown aal, null claims, no totp, expired and exp-less, wrong subject, stale step-up, boundary, newest-entry rule, password timestamp does not renew, missing/NaN/string/future timestamps, string `amr`); the guard (non-admin refused before claims read, role before claims, aal1 redirect, stale redirect for `recent` only, claims error/missing/throw fail closed, different-user claims); return-path safety; messages.
- `platformActionAssurance.aal2.test.ts` (mutation guard): completeness of the classified registry (a new unclassified exported action fails); source order and tier of each guard call and absence of the role-only import (removing or downgrading a guard fails); behaviour per action with the guard refusing: no database client, provider runtime or network touched, and the tier passed equals the registry.
- Existing suites that exercise actions keep their own role-refusal tests through `src/lib/auth/__tests__/stepUpDouble.ts` (it forwards to the suite's mocked `requirePlatformAdmin`); dual-admin and typed-confirmation tests are unchanged.

## 6. Residual risks and follow-ups

1. Adjacent non-TW-4F platform actions (section 2.6, notably `createPlatformAdminAction`) are role-only.
2. Service-role page reads rely on the layout gate (section 2.5).
2a. The migration is unapplied and untested against a database (the Docker QA harness was not run for this change); any local-stack suite that acts as a platform admin through the `authenticated` role will need `"aal":"aal2"` in its JWT claims once the migration is part of the harness schema; until applied, the direct-PostgREST bypass in section 2.4 remains open.
2a-ii. **Pre-apply gate (found in re-review):** local-stack and SQL regression suites that act as a platform admin build claims without `aal` and will fail once this migration is in their chain: `sms/onboarding/__tests__/localStack.tw4a.test.ts`, `billing/__tests__/localStack.tw4f3bui.test.ts`, `localStack.tw4recurring.test.ts`, `sms/provisioning/__tests__/localStack.r2ci2.test.ts`, `sql-tests/test_T_twilio_tw4a_sms_onboarding.sql`, `test_T_smsa2p1_studio_sms_registrations.sql`, possibly `scripts/hosted/tw4f/validate_local.fixture.sql`. Before the migration is applied anywhere: add `aal: "aal2"` to those admin claims, add an aal1-admin negative case, run them on the isolated Docker harness, and re-run `gen_manifest_data.mjs --sync-probes` / update the hosted apply manifest (the helper's body fingerprint changes). Not done here (the harness was not run; editing them blind was judged riskier than listing them).
2b. An admin who has never enrolled TOTP is protected by password only: they can enrol their own factor from `/platform-mfa/setup` and then pass every tier. Enrol every platform admin before the pilot.
3. A stolen aal2 cookie can perform `A2` (config/protective) actions until the session ends.
4. TOTP only; no recovery path or second factor type. Losing the authenticator device locks an admin out of these actions (by design; recovery is a Supabase-side operation).
5. `getClaims()` for a symmetric-secret project calls the Auth server (one extra round trip per guarded action). Acceptable at admin volumes.
6. The check relies on Supabase `amr` timestamps; if the Auth configuration ever stopped emitting them, `recent` actions would be refused (fail closed) until fixed.

## 7. Owner approvals needed

Before merge: approve the tier assignment (section 2.1, especially which actions are `recent`) and the 15-minute window. Before pilot activation: every platform admin who operates the panel enrols TOTP and is told that fee-bearing steps ask for a code again after 15 minutes. Applying the migration to DEV then PROD (SQL before app is not required; it is independent and its rollback is a file) needs separate owner approval. No hosted DEV/PROD change or deploy is part of this change; deploying it is a normal app release needing the usual promotion approval.
