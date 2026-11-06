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

## Findings of the first full run (branch head cafba9fd + two src fixes)

* DEFECT 1 (fixed in the same branch): 8 `update public.studio_sms_price_auth_config set ...` statements in migration 20270208100000 had no WHERE clause. The Supabase `authenticator` role preloads `pg_safeupdate`, so under PostgREST every one of them fails with `UPDATE requires a WHERE clause`: freeze, thaw, compromise report, recovery freeze, retiring the recovery key and cancelling a recovery enrolment all failed from the real app (the superuser-psql based tests cannot see it). Fix: `where singleton` on each statement. Evidence of the unfixed behaviour: `results/d4-1/next-e2e-run-unfixed-probe.md` (scenarios 1 and 5 against the unmodified migration). The function bodies changed, so the hosted manifest / probe fingerprints for 20270208100000 must be regenerated.
* DEFECT 2 (fixed in the same branch): `PriceChangeStore.credState()` dropped pending changes whose kind is `recovery_enroll`, so the key panel never showed a pending recovery enrolment and offered no Apply / Cancel for it (a recovery could neither complete nor be cancelled from the UI). Fix: accept `recovery_enroll` in `src/lib/sms/priceChange.ts`.
* Observation (not changed): the panel text after "Start recovery" says a primary or spare key can cancel it; the database allows only the recovery key (scenario 5 shows a primary key is not even offered).
* Observation (not changed): database errors without a mapped SQLSTATE (TW046 monitoring outage, "no key yet", the 3-credential cap) surface as the generic sentence "The action failed. Nothing changed; ..." (scenarios 1 and 8).
* Observation: the database caps active credentials at 3, and the recovery key can be retired only by itself; a completed recovery replaces the whole set (no recovery key remains afterwards).
* Result files: `results/d4-1/next-e2e-run.md/.json` (final run, with both fixes: 114 PASS / 0 FAIL / 1 BLOCKED) and `next-e2e-run-unfixed-probe.*`.
