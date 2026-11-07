# Real-Next.js browser acceptance of the TW-4F single-owner pricing authorization

`next-e2e.mjs` replaces the PostgREST-bridge harness (`webauthn-e2e.mjs`, which is neither the Next app nor GoTrue) with the real stack:

```
Chromium (Playwright, CDP virtual authenticators)  ->  real Next.js app (next build + next start, real server actions)
   -> real local GoTrue + Kong + PostgREST  ->  Postgres (df-isoqa/base:20261119092100 + the repo migration chain)
```

LOCAL AND DISPOSABLE ONLY. No hosted DB / Supabase / Vercel, no Twilio / Stripe / Resend call (the app gets dummy provider env; every SMS and pricing switch is left at its default), no real credential. Test users are synthetic (`@example.test`, random password, TOTP secret chosen by the local GoTrue). Containers are labelled `df.d4nxe=1` and named `df-nxe-*` (network `df-nxe-net`, Kong on 127.0.0.1:56900-56949); `down` only ever removes those.

WebAuthn is real in the browser: `navigator.credentials.create/get` run against a Chromium virtual authenticator with RP ID `localhost` and origin `http://localhost:3417` (the DB's `rp_id` / `rp_origins` are bootstrapped to exactly that). The hardware-key panel, the proposal form, the authorize/sign flow, revocation, recovery, freeze/thaw are all driven through the pages. Login and the TOTP step-up go through `/login` and `/platform-mfa/challenge`.

## Run

Needs Docker, the image `df-isoqa/base:20261119092100`, the supabase postgrest/gotrue/kong images already used by `run-chain.mjs`, a `node_modules` in this worktree (copy it; never junction it), and Playwright's Chromium. Run on an idle host (the Turbopack build wants ~4 GB).

```bash
node scripts/qa/tw4f/browser/next-e2e.mjs all                  # up + build + start + run + report + down  (~25 min incl. build)
# or in steps, to iterate:
node scripts/qa/tw4f/browser/next-e2e.mjs up                   # DB chain (+ monitor migration 20270208110000) + PostgREST + GoTrue + Kong
node scripts/qa/tw4f/browser/next-e2e.mjs build                # next build with this stack's URLs/keys inlined (NEXT_PUBLIC_*)
node scripts/qa/tw4f/browser/next-e2e.mjs start                # next start -p 3417 (production mode)
node scripts/qa/tw4f/browser/next-e2e.mjs run [--scenarios 2,3]
node scripts/qa/tw4f/browser/next-e2e.mjs down
```

Options: `--port` (app, default 3417; it is the WebAuthn origin), `--dev` (`next dev --webpack`, skips build; the bundle scan is then BLOCKED), `--skip-build`, `--keep` (leave the stack up after `all`), `--no-monitor` (skip migration 20270208110000; it is read from `origin/claude/d4-2-price-monitoring` when it is not in the tree), `--scenarios`, `--out`. Environment: `D4NXE_HOME` (state/log dir, default `%TEMP%/df-nxe`), `D4NXE_PG_IMAGE`.

Results: `scripts/qa/tw4f/results/d4-1/next-e2e-run.md` and `.json` (per-scenario PASS/FAIL/BLOCKED counts, every check, every UI message seen).

## What is driven (scenario numbers as in the run report)

0. Setup: two admin sessions (two GoTrue sessions of one platform administrator) through login + TOTP.
1. Enrolment: UI refusal with no key; first primary = owner bootstrap (there is no UI path by design, reported as BLOCKED, not PASSED); spare and recovery keys through the UI with the pending delay (Apply early refused; the DB clock is aged by owner DDL on the disposable database only, as in the old harness).
2. Propose -> 24 h cooling-off -> approval from a separate session with the WebAuthn assertion bound to the exact proposal; proposer session refused; recovery key not offered; captured server-action request replayed (refused); a signature held in the browser while the proposal is revised (v2, cooling-off restarts) is refused.
3. aal1 session redirected; captured server actions replayed from an aal1 context return nothing; deleted (revoked) and expired GoTrue sessions refused.
4. Revocation through the UI is immediate and final (no cancel path in UI or DB); a pending enrolment authorized by a key that is then revoked dies; a revoked key's real signature on a challenge issued earlier is rejected.
5. Freeze and thaw through the UI; freeze with the recovery key; ordinary thaw refused during the recovery hold; ordinary key cannot revoke the recovery key; recovery enrolment (long delay), cancel only by the recovery key, completion replaces the whole set; the recovered primary authorizes a price.
6. Concurrency with two browser contexts: same revoke, same apply, enrol-vs-revoke of the signer, competing proposals.
7. Authenticator profiles: default (UP+UV, BE/BS clear), backup-eligible (BE+BS) refused by default and accepted with `allow_backup_eligible=true` (and refused again when the flag is turned back), authenticator that does not verify the user.
8. `monitoring_expected=true` with the events table unavailable (renamed by owner DDL; also with the emitter function missing): propose / enrol / revoke / apply refused, freeze works from the UI.
9. Built client bundle scanned for the run's secrets (service-role JWT, JWT secret, dummy provider keys, TOTP secret); security headers/CSP; cookie attributes; no CSP violation in any console; every user-visible message is a plain sentence.

Old harness (`webauthn-e2e.mjs`) stays for DB-level checks that need no Next app.


## Findings

Final run: base `origin/claude/d4-2-price-owner-authz` 7acdeac7 (harness only on top), 142 PASS / 0 FAIL / 1 BLOCKED (`results/d4-1/next-e2e-run.md`). Scenario 10 (stolen ordinary keys) and the signed-out-session checks in scenario 3 were added for the hardening round; the bootstrap installs the recovery key owner-level (`_tw4price_bootstrap_with_recovery`) and the three-credential set is primary + recovery (owner-level) + spare (UI, delayed).

* Found by the first run on cafba9fd (both already re-applied by the implementer in 7acdeac7, so the harness has no src changes): (1) 8 `update public.studio_sms_price_auth_config set ...` without WHERE fail under `pg_safeupdate` (the `authenticator` role), which broke freeze, thaw, compromise report, recovery freeze, retiring the recovery key and cancelling a recovery enrolment from the real app; evidence of the unfixed behaviour is `results/d4-1/next-e2e-run-unfixed-probe.md` (run on cafba9fd). (2) `credState()` dropped `recovery_enroll` pending changes so a recovery could be neither completed nor cancelled from the panel.
* The Log Out button signs the user out GLOBALLY (all of that user's sessions): the signed-out check therefore uses a second administrator.
* An ordinary key can lift an ORDINARY freeze (scenario 10 records it); only a recovery freeze (hold) is beyond ordinary keys. A stolen primary can therefore undo an owner's ordinary freeze; the owner's answer is the recovery freeze.
* Unmapped database errors (TW046 monitoring outage, the 3-credential cap, "no key yet") surface as the generic sentence "The action failed. Nothing changed; ...".
* The function owner of `_tw4price_session_actor` (`postgres`, not a superuser in the local image) can read `auth.sessions` (checked in scenario 3); confirm the same privilege on the hosted project before applying.

## Policy round (base #392 8f07c09c)

Scenario expectations were updated for the new policy: a primary or spare key can only retire itself ("Retire this key", touch that key); evicting another ordinary key needs the recovery key ("Evict with the recovery key", ceremony `revoke_other`); the recovery row offers only "Retire the recovery key"; pricing ceremonies need a TOTP verification at most 10 minutes old (the harness renews through `/platform-mfa/challenge?stepup=1` before it gets stale, and scenario 11 forges an 11-minute-old `amr` timestamp: ceremonies are refused by the database and bounced to the step-up page by the app, then succeed after a real step-up; freeze / report-compromise stay plain aal2; the panel's credential LIST read is plain aal2 as well). Scenario 11 and the "policy" checks in scenarios 1, 4 and 10 are new.

IMPORTANT LIMIT: every WebAuthn result here comes from Chromium CDP VIRTUAL authenticators. It shows the browser/app/database protocol, flags (UP/UV/BE/BS), RP ID and origin handling and counters work end to end; it says nothing about compatibility with real hardware security keys or platform authenticators (CTAP transports, attestation formats, real counter behaviour, UV prompts, vendor quirks). Hardware compatibility must be tested separately.

## Base 5d9cb51d (migrations 20270210090000/100000, monitor 20270210110000)

New in this round: the last-credential rule (a bootstrapped or installed key has no enrolment proof until the owner-level attest step: the real authenticator signs `_tw4price_attest_begin`, `_tw4price_attest_finish` stamps it; until then it does not count as a verified replacement, scenario 1; scenario 12 retires the only signing credential only after a replacement was enrolled through the UI and applied) and the freeze form action replayed on a stale-MFA session through the real Next action (scenario 11, no longer database-only). Observation: the refusal of the last credential surfaces as the generic 22023 sentence ("check the kind, the amounts, the lengths...") which does not describe the cause. Virtual authenticators only: no hardware-compatibility claim.
