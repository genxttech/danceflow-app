# P1 restricted pilot: production-build browser walkthrough (runbook)

Status: **PREPARED, NOT EXECUTED.** Written 2026-11-27 against the release line at `57c33191`. Companion to section 3 of `p1-integrated-test-plan.md` (PR 863 branch). DanceFlow Studio/Custom pilot behaviour; no governing-body claim. **Local only:** no hosted database, deploy, activation or provider call.

## Run only when all of these hold

| # | Precondition | State on 2026-11-27 |
| --- | --- | --- |
| 1 | A composed database candidate passes (base + corrections + restriction) | **not met:** the run of record does not show release readiness |
| 2 | One integration app branch holding the app parts of PRs 835, 837, 846, the eligibility wiring for 866, 925, 865 messages, 878 and restriction messages | **not built** |
| 3 | A full local stack (auth, REST, database) whose database container is named `supabase_db_cf1c-qa`, loaded with that composed chain, with a mail catcher | **not provisioned**; the harness refuses any other container name |
| 4 | The heavy lock (`C:\dfr\HEAVY_LOCK_RULES.md`): a local stack and `next build` are heavy | per run |

Use a **disposable** stack and reset it afterwards: the composed chain refuses deleting events that hold scoring evidence, so fixture cleanup can fail by design.

## Files

- `e2e/playwright.p1.config.ts` (projects `walkthrough`, `flag-off`)
- `e2e/tests/competition-p1-pilot-walkthrough.spec.ts` (P1-00 to P1-15, P1-99)
- `e2e/tests/competition-p1-flag-off-smoke.spec.ts` (P1-F1 to P1-F3)

Both specs skip unless their own variable is set, so the default Playwright run does not execute them.

## Walkthrough run (flags on, its own build)

PowerShell, from the integration checkout. Local keys only; never a hosted URL.

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="<local stack URL>"; $env:NEXT_PUBLIC_SUPABASE_ANON_KEY="<local anon key>"; $env:SUPABASE_SERVICE_ROLE_KEY="<local service key>"
$env:NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED="true"; $env:COMPETITION_FINALS_ENABLED="true"; $env:COMPETITION_PUBLIC_RESULTS_ENABLED="true"
npm run build
npx next start -p 3100
```

In a second shell:

```powershell
$env:E2E_BASE_URL="http://127.0.0.1:3100"; $env:E2E_RUN_DIR="C:\dfr\p1-browser\<timestamp>"
$env:E2E_SUPABASE_URL="<local stack URL>"; $env:E2E_SUPABASE_SERVICE_ROLE_KEY="<local service key>"; $env:E2E_SUPABASE_ANON_KEY="<local anon key>"
$env:E2E_LOCAL_DB_CONTAINER="supabase_db_cf1c-qa"; $env:E2E_P1_APP_CANDIDATE="<built commit>"; $env:E2E_P1_WALKTHROUGH="true"
npx playwright test -c e2e/playwright.p1.config.ts --project=walkthrough
```

Set `E2E_LOCAL_MAILBOX_URL` if the mail catcher is not at the helper's default.

## Flag-off smoke (separate build)

Stop the server, remove the three Competition variables, run `npm run build` and `npx next start -p 3100` again, then set `E2E_P1_FLAG_OFF="true"` and run `--project=flag-off`. The `NEXT_PUBLIC_` value is inlined at build time, so the walkthrough build cannot be reused.

## What the walkthrough checks

| Step | Must succeed | Must be refused or absent |
| --- | --- | --- |
| P1-00 | composed database parts present | otherwise BLOCKED |
| P1-01, 02 | accounts verified; $0 final-only setup; publish and open | callback setup |
| P1-03, 04 | adult registration; recorded eligibility determination | under-18 on screen and by direct request |
| P1-05, 07 | one final heat published; panel built; round starts | |
| P1-06 | whole-entry scratch before the start, audited | judge on page and by direct request |
| P1-08 | panel-breaking absence recorded only after confirmation (925) | unconfirmed record |
| P1-09, 10 | heat starts | ballot before the start; scratch links, page and direct request after it |
| P1-11, 12 | three judge ballots; lock; calculate | approval by the calculator |
| P1-13, 14 | approval by a non-calculator; public publication; phone-width results | scratched couple in results |
| P1-15, 99 | | other studio and anonymous; any console or 5xx error |

A BLOCKED step is skipped with the missing dependency named, and later steps do not run. **Report skips as BLOCKED, never as passed.** Evidence (results.json, traces, screenshots) stays in `E2E_RUN_DIR`, outside the repository.

## Not covered

Paid checkout and refunds; running-order replacement or cancellation after the start; a second round, heat or division added after judging; paper ballots; a one-couple final; an official-body-declared event (832); frozen names after publication; hosted environments. Several selectors for unmerged parts are unverified and will need adjustment on the first run. The Scratch page and its Registrations link are not behind a Competition flag, so the flag-off smoke does not assert their absence.
