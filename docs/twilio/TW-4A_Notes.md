# TW-4A — Self-service SMS onboarding foundation (local build)

Status 2026-10-15: built and validated locally in worktree `C:\Dev\studioapp-tw4a`, branch `twilio-tw4a-onboarding-foundation` (base `81e023bc`). Uncommitted. Not applied to DEV or PROD. Nothing deployed. No Twilio call, SMS, email or registration submission exists in this slice.

## Scope
Database-only onboarding foundation plus the studio-owner wizard, status tracker, public per-studio SMS legal pages, platform pilot switch and an unscheduled EIN-purge route. Everything is behind a per-studio pilot flag stored in the database (default OFF).

## Files
- SQL `20261119090000_twilio_tw4a_sms_onboarding.sql` (sha256 `f792c351933e…`), rollback (`b0f9d5c52234…`, refuses if any onboarding/access/ledger/audit rows exist), suite `test_T_twilio_tw4a_sms_onboarding.sql` (`208cf978480b…`; runs only with `set tw4a.test_local = 'on'`; 79 checks).
- Libs `src/lib/sms/onboarding/` (fields, ein, stateMachine, campaignTemplate, legalPages, client).
- App: `app/settings/sms/*`, `studios/[studioSlug]/{SmsLegalPage,sms-terms,sms-privacy}`, `platform/sms/{SmsOnboardingPilot,actions,page}`, `api/cron/sms-onboarding-purge`, Texting link in `app/settings/page.tsx` (only when status `available`).

## Security properties
SECURITY DEFINER RPCs with pinned `search_path`; no API privileges on the tables; owner-only submit/cancel; EIN encrypted app-side (AES-256-GCM, studio-id AAD, env key) and never returned to any client, only last-4 and an "on file" flag; DB state-graph trigger mirrored by `stateMachine.ts`; append-only audit; platform-admin-only pilot switch; legal pages 404 unless the pilot flag is on.

## Validation (local)
- Disposable PG17.6: 79 SQL checks pass; 6 original + 17 review-fix mutation probes each make the suite fail. Rollback then re-apply runs clean.
- Full `npx vitest run`: 398 files / 6282 tests pass. `tsc --noEmit`: 0 errors. ESLint on new paths: 0 errors (only pre-existing warnings in touched legacy files).
- Source scan test proves the new files contain no network, Twilio, SMS or email calls, and that sending/consent/inbound/status paths do not reference the slice.

## Release order (when separately authorized)
1. SQL to DEV (needs explicit authorization), DEV-safe suite, then PROD SQL later.
2. App deploy. Set `SMS_EIN_ENCRYPTION_KEY` and `SMS_EIN_ENCRYPTION_KEY_ID` first; without them the wizard refuses to store an EIN.
3. Flip pilot flag for ConfiDance only via the platform panel.
Rollback: app first, then SQL rollback (valid only while no onboarding data exists).

## Not done / deferred
Orchestrator and Twilio adapter (4B/4C), Event Streams, registration-table extensions, emails, billing, brand-approved EIN purge trigger, Q3 domain hold. The purge cron route is registered in `vercel.json` (daily 03:17 UTC, GET) as of the release PR. Owner decisions D1–D7 and Twilio answers Q1–Q5 still gate 4B.

## Independent security review (2026-10-15, Opus, read-only) and fixes
Verdict: no P0/P1. Fixed locally in the same migration (not yet applied anywhere):
- P2-1 check violations no longer echo the failing row (DETAIL could carry ~64 chars of the ciphertext): save and EIN store re-raise 23514 with the constraint name only.
- P2-2 resubmission is audited from the real prior state. P2-3 `terminal_at` restarts on each entry into cancelled/blocked and clears on leaving blocked; `terminal_30d` purge re-checks state and age under its row lock.
- P2-4 (partial) owner cancel now purges the EIN immediately (matches the wizard copy). Still open: cron not registered in vercel.json (register at release), no TTL for exception/needs_info/submitted_for_checks until the 4C brand-approved purge.
- P2-5 owner cancel and the public legal context work after the pilot switch is turned off once a setup exists (editing still needs the switch).
- P2-6 the table trigger freezes attestation, submitted_at, submission_seq (stay or +1) and the EIN columns (purge shape only) after submission. P2-7 ledger: identity fields immutable, a succeeded step cannot regress, delete only by cascade, TRUNCATE refused.
- P2-8 attestation requires JSON true (strings/1 refused); the access reason is copied into the audit note; EIN store requires ciphertext, key id and last4; U01 truncate check is no longer vacuous.
Not changed (policy/notes): studio_admin can read the representative's details and EIN last4; legal context ignores studio subscription status; no concurrent save/submit/cancel test (relies on the per-studio advisory lock + FOR UPDATE; no two-session harness for 4A); the owner UI hides the tracker when the switch is off, so cancel-after-disable is reachable by the API/support only.

## 2026-10-15 integration pass (TW-4A.1 + end-to-end validation)
Scope: finish the application integration and prepare registration readiness. No Twilio contact, no registration, no PROD, no commit.

**New migration (not applied to DEV or PROD): `20261119091000_twilio_tw4a1_paused_status_and_legal_continuity.sql`** (sha256 `9ca53d4d3221…`), rollback `a6144565c3fd…` (restores the two TW-4A function bodies verbatim). Function bodies only; privileges unchanged (self-check in the migration).
- `get_studio_sms_status`: switch OFF after a setup started → `available` true, `paused` true, editing off; the owner gets `can_cancel`. Switch off and nothing started → unchanged `{available:false}`. New keys `paused`, `can_cancel`; `can_edit`/`can_cancel` are never null.
- `get_sms_legal_context`: also served for studios with an existing registration (in_review/approved/suspended), besides pilot-on and submitted setups.
- Release order: TW-4A (done on DEV) → TW-4A.1 → app. The new app tolerates an old database (missing keys parse as paused=false, canCancel=false) but then loses the paused/cancel UX. Rollback: app first, then the 4A.1 rollback, then (only while empty) the 4A rollback.

**Application changes** (TW-4A paths only): paused banner + status + cancel when the pilot is switched off after submission; the cancel control (`SmsCancelSetup`) moved out of the wizard so it works after submission, not only while editing; a rejected save keeps what was typed (never the EIN) and keeps dropdown choices; the wizard jumps to the first step with an error and marks steps with a dot; `noValidate` on the save form; partial posts write only the fields posted; the "Saved." confirmation no longer disappears; a submitted setup's read-only form is collapsed behind "View the information on file"; the platform panel shows "Off (setup paused)" and "Needs attention" for needs_info/blocked/exception/suspended.

**Bugs found only by running the real app in a browser against the local stack (fixed and covered):** (1) a malformed email on a hidden wizard step made the browser block the save silently (HTML5 validation on an unfocusable field); (2) after a rejected save every dropdown reset to blank (React resets uncontrolled fields; a select keeps its original default); (3) "Saved." vanished because the form remounted on each save.

**Validation:** SQL suite 89 checks pass on disposable PG17.6 (T01–T09 new); 6 mutation probes for 4A.1 each fail the suite; rollback then re-apply is clean. Full `npx vitest run`: 400 files pass, 1 skipped (the opt-in local-stack test); `tsc --noEmit` 0 errors; ESLint 0 errors. **Real-schema end-to-end:** `localStack.tw4a.test.ts` runs the real server actions, RPC wrappers and EIN encryption against the local QA Supabase stack (DEV public schema + 4A + 4A.1) through PostgREST with real JWTs: 14 tests pass (owner/admin/front desk/instructor/outsider/other-studio matrix, pilot off by default, draft save/resume, EIN encrypted + last4 only, rejection leaks nothing, submit/lock, all states, paused→cancel→EIN erased, recovery, legal-page continuity, oversight list, no EIN/ciphertext in any response or log). A browser pass on the local app covered the wizard, error jump, submit, paused view, cancel and the legal pages.
- Run it: `TW4A_LOCAL_URL=http://127.0.0.1:55321 TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa TW4A_LOCAL_JWT_SECRET=<stack secret> npx vitest run src/lib/sms/onboarding/__tests__/localStack.tw4a.test.ts` (loopback only; skipped otherwise; fixtures are synthetic and removed afterwards).
- Not validated against real DEV data: no pilot grant and no onboarding record was created on DEV (not authorized). DEV schema vs application: the 4A function contract matches; the new `paused`/`can_cancel` keys exist only after 4A.1.

**Known gaps / not done:** no two-session concurrency test (advisory lock + FOR UPDATE only); no right-side detail panel (progressive disclosure via the collapsed summary instead); the EIN purge cron is registered in vercel.json by the release PR (it was POST-only before, which Vercel Cron cannot call); exception/needs_info/submitted EINs have no TTL until the 4C brand-approved purge; submission itself (TW-4B/4C) is not built. See TW-4A_Registration_Readiness.md for the Twilio message, the ConfiDance package and the checklist.
