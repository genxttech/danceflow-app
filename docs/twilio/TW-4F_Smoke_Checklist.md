# TW-4F smoke checklist and authorization matrix

Status 2026-10-18. Developer-owned QA for the self-service SMS onboarding (TW-4F). The browser specs `e2e/tests/sms-onboarding-wizard.spec.ts` and
`e2e/tests/sms-platform-runner.spec.ts` cover everything in sections 1 and 2 on a local stack with the fake Twilio adapter. Section 3 is the manual
production smoke that runs **only after the owner authorizes a release** (4F-6); nothing in this document authorizes it.

## 1. Authorization matrix (who can do what)

| Actor | Texting setup (`/app/settings/sms`) | Platform panel (`/platform/sms`) | Covered by |
|---|---|---|---|
| Studio owner, pilot off | redirected to settings | not reachable | wizard spec |
| Studio owner, pilot on | wizard: edit, save, submit, cancel | not reachable | wizard + runner specs |
| Front desk of the same studio | redirected to the app | not reachable | wizard spec |
| Owner of another studio | own studio's switch applies (off), never studio A's | not reachable | wizard spec |
| Platform admin (password + authenticator code) | n/a | pilot switch, runner window, run, status check, evidence, campaign package | runner spec |
| Anonymous | login | login | existing auth tests |

Database layer (real SQL, `localStack.tw4f1b.test.ts`): runner functions are service-role only, the confirmation table has no API privileges,
submissions need a fresh single-use lease-bound confirmation, evaluations need a recorded compliant verdict.

## 2. Negative cases the specs pin

- Invalid EIN refused with a message and nothing saved; submission without every attestation refused.
- No open runner window: nothing is created.
- A run stops before **each** irreversible submission (profile, trust product) even with nothing ticked, however often it is repeated.
- A ticked submission without the exact word `SUBMIT` (empty, lower case, extra words) changes nothing.
- A profile confirmation never covers the trust product; the fee confirmation never covers either.
- The status check is read-only and ignores the submission boxes.

## 3. Production smoke (after an authorized release only; one pilot studio, never a broad rollout)

1. Flags default off: no studio except the pilot studio shows the Texting page; the platform switch for the pilot studio is the only one on.
2. Cron endpoints (`/api/cron/sms-onboarding-purge`) reject a missing or wrong secret.
3. Owner completes the wizard for the pilot studio (the owner types the EIN themselves); the tracker reads "Submitted"; the EIN field is empty on reload.
4. Platform: runner window opened for a short time; **no Twilio call happens before the window is opened**; closing the window stops a run.
5. Run once with nothing ticked: it evaluates and stops before the profile submission. Read the evidence ("Compliant"), then confirm the profile
   submission with `SUBMIT` (its own run), then the trust product (its own run). Fee confirmation only at the brand step. Each stop is expected.
6. Status check after each submission; a rejected profile or trust product moves the setup to "Needs attention" and nothing is resubmitted.
7. Brand approved: the EIN is erased from the database (verify on a synthetic record first).
8. Activation is a separate manual release (decision D8); first real SMS only to a consented test recipient (STOP, START, HELP).

Each external effect above (Twilio writes, fees, number purchase, SMS) needs the owner's separate written authorization at the time.

## 4. Findings recorded while building the e2e suite

- **F-1** The default Turbopack production build passes; only `next build --webpack` rejects extra route exports (see the plan, section 12).
- **F-2** Local `supabase` stacks ship with authenticator MFA disabled, so platform-admin pages cannot be exercised until it is enabled (README).
- **F-3 (pre-existing, to verify in a production build, not changed here)** The platform MFA *setup* page enrols a factor on every render with a fixed
  friendly name. A second render before the code is verified (a refresh, or a repeated request during the redirect) is refused by the auth service
  ("a factor with the friendly name ... already exists") and the page then says setup could not be started; refreshing again does not recover. A new
  platform admin may need an existing unverified factor removed to retry. Existing admins are enrolled and unaffected. Candidate fix (own PR): reuse
  an unverified factor or generate a unique friendly name.
