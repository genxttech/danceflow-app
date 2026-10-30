# Competition acceptance on qa-sut-6 as a PRODUCTION build — 2026-10-30 (QA-A, run 6)

**Composition `qa-sut-6` `d7fcde04`, run as a production build (`next build` + `next start`)**, in contrast to the dev server
(`next dev`) used in all earlier reports. The earlier dev-server evidence stands unchanged
(`competition-qa-sut6-acceptance-2026-10-30.md` is the same composition on the dev server).
Spec: `e2e/tests/competition-scoring-results-acceptance.spec.ts` (PR #341). Machine-readable twin:
`competition-qa-sut6-prod-acceptance-2026-10-30.json`. Independent review has not happened yet.

## Summary

| Half | Runs | Result |
|---|---|---|
| Ordinal "Final only" (full chain incl. HL1 early lock, reopen, results, certification) | 2 complete runs back to back (3 min each), identical | 16 scenarios PASS + 1 setup, 1 NOT IMPLEMENTED (SCN-13.1), 0 FAIL |
| Callback "Callbacks + Final" | 1 complete run (2 min) | 5 scenarios PASS + 1 setup, 2 NOT RUN (SCN-11.4, 11.5), 0 FAIL |

Scenario logic and results are identical to the dev-server run of the same composition. **No behaviour difference was found
between the dev server and the production build.** The only differences are operational: runs are about half as long, the
server's working set is 451 MB instead of 2–3.4 GB, and the first-request 404s of a freshly started dev server did not occur.
A first filtered run (`SCN-0c|SCN-12.1|SCN-15|SCN-6.3|SCN-12.2|SCN-12.3`) failed only at SCN-12.2, which expects three ranked
entries; that filter leaves out the no-show scenario (SCN-10.1) that removes the fourth, so four entries were ranked. This is a
filter artefact, not a product difference, and the full-chain runs above pass.

## 1. Build and environment

- Composition: `qa-sut-6` `d7fcde04` (`qa-sut-2` + HL1 `ca6c0b8d` + `171fe7cb`), working tree clean; `next build` rewrote the
  generated `next-env.d.ts`, which I restored with `git checkout`.
- **Build:** `next build` with `NODE_OPTIONS=--max-old-space-size=6144`, with no Supabase stack and no browsers running, exit
  0. During the build (55 samples at 5 s) system memory in use peaked at **29,247 MB** and free memory bottomed at **3,034 MB**
  (the build was set to stop below 2,048 MB free; it did not).
- **Baked public env:** `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:57921` (`qa-acc4`), the local demo anon key (checked equal to
  the key the stack reports), `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_SITE_URL=http://localhost:3100`,
  `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true`. No Stripe key went into the build; the Stripe TEST key was supplied to
  `next start` and Playwright through the process environment only (run folders, the build log and these files were scanned: no
  key strings).
- Runtime: `next start -p 3100` with `NODE_OPTIONS=--max-old-space-size=2048`; own `stripe listen`; Supabase services
  excluded: studio, imgproxy, postgres-meta, logflare, vector, supavisor, edge-runtime; Playwright headless, one worker,
  retries 0. Database: `qa-acc4` with migrations 0101–0119 (0118 and 0119 applied incrementally on 2026-10-29).
- **Memory during the runs** (31 samples at 20 s): peak system memory in use 25,865 MB, minimum free 6,416 MB, peak server
  working set 451 MB. No threshold was hit.

## 2. Ordinal half — two identical runs

All scenarios as listed in the dev-server report for `qa-sut-6` PASS: SCN-12.1; SCN-15.1 (early lock, with the exact confirm text,
the not-danced blocker and the floor refusing the heat); SCN-6.3 (official scratch in the locked, not-yet-danced heat: reason
required, audit path `official_locked`, heat stays locked); SCN-15.2 (reopen with a reason); SCN-15.3 (no Lock heat on a heat on the
floor; direct call refused with COMP_HL1_LOCK_ACTIVE); SCN-10.1, 10.5, 12.2; SCN-12.3 (not locked yet while on the floor, then
Lock heat and Lock ballots); SCN-15.4 (reopen refused after the lock); SCN-10.4; SCN-14.1 (calculate, calculator-only approval
refused); SCN-14.2 (correction, judge banner, corrected ballot); SCN-14.2b (stale result); SCN-14.3 (recalculate, second manager
approves, heat certified, certified scratch refused); SCN-14.4 (who can see results). SCN-13.1 publication is NOT IMPLEMENTED (F3).

## 3. Callback half — one run

SCN-0c, SCN-1.3, SCN-11.1, SCN-11.2, SCN-11.3a and SCN-11.3 PASS (exactly T=2 couples advance). SCN-11.4 and SCN-11.5 are NOT RUN.

## 4. Shutdown and cleanup

`next start`, `stripe listen` and the sampler were stopped (PIDs verified); `supabase stop --backup` on `qa-acc4`. Nothing deleted.
After the last run `qa-acc4` had 0 e2e studios, events and users (the runs' own checked teardown). Hosted DEV/PROD, deploys and
live providers were not touched.
