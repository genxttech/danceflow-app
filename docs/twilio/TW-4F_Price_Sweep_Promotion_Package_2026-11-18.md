# TW-4F price sweep: Gate C promotion package (2026-11-18)

Status: **prepared, nothing deployed, promoted, enabled or scheduled.** Every hosted step below needs its own owner approval. Production is unchanged.

## 1. What is being promoted

- Source: `release/website-embeds` head **6ba31295749eb47ab80e2a011c8ee2094c241cc6** (PR #637, squash of 5c652585, approved by the owner on that head).
- Diff against live (`447d9b8548a2ed6a376938b893b8a92e6dc89ffb`): exactly three files, +81 lines: `src/app/api/cron/sms-price-sweep/route.ts`, its unit test, one `vercel.json` cron (`/api/cron/sms-price-sweep`, `23 * * * *`). No other file differs, so Embeds, Competition dark gates, pricing, Stripe, auth and the price monitor are byte-identical to live.
- Live today (APPS, `vercel inspect www.idanceflow.com`, 2026-11-17 18:22Z): `dpl_DvJFayDdT36EqdKvKvWjQuyEKH28` (project `danceflow-app-qfem`), promoted 2026-11-14 14:47:57Z. Previous production: `dpl_FEzqXu6NEtBejTk5vQQMB8jszcEX` (c0172455).
- Database: nothing to apply. `tw4_price_sweep_expired()` is already on PROD (Gate A, 2026-11-17 08:49Z) and was run once (Gate B).

## 2. Two-step plan (keeps activation a separate decision)

Environment variables reach a deployment only at build time, so turning the sweep on after promotion needs a new deployment. The plan below promotes dark first, then activates.

### Step P: promote dark (owner approval P)
Preconditions (read-only, I repeat them immediately before):
1. Re-inspect that www still resolves to `dpl_DvJFayDd` (no one promoted in between); live commit unchanged.
2. `SMS_PRICE_SWEEP` is NOT set in Production (route answers 404). `CRON_SECRET` is set (the monitor already depends on it).
3. PROD read-only: pending requests 0, `tw4_price_verify()` ok, function present with service_role-only EXECUTE.

Mechanics (same as the Embeds Path B precedent): staged non-domain build from 6ba31295 (`vercel deploy --prod --skip-domain` or the qfem build of the branch head), then staged checks, then `vercel promote`.
Staged checks, no secrets needed: `/api/cron/sms-price-sweep` answers 404 (flag unset); `/api/cron/sms-price-monitor` and the watchdog behave as on live; `/login` headers and ordinary pages unchanged; deployment cron list has 14 entries (the live 13 plus the sweep).
Observation after promotion, 30 minutes minimum: 5xx rate, the 15-minute monitor runs keep recording clean evidence rows (`studio_sms_price_monitor_evidence`), the first hourly sweep call (minute :23) is a 404 in the logs and nothing else changes.
Rollback P: promote `dpl_DvJFayDd...` (app only; no SQL involved), then `dpl_FEzqXu6N...` if needed.

### Step A: activate (separate owner approval A, only after P is observed clean)
1. Owner sets `SMS_PRICE_SWEEP=on` in Vercel Production (value only; the agent never uses owner credentials for it).
2. Redeploy the same commit so the variable is picked up; staged check, promote.
3. Verify at the next :23: the cron answers 200 with `expired` 0 (no pending requests today); `tw4_price_verify()` ok; price-list rows 0; monitor evidence stays clean.
Rollback A: unset the variable and redeploy (or promote the Step P deployment, which is dark); the route answers 404 immediately. Requests already swept are final; the sweep only ever expires past-expiry pending proposals.

## 3. Risks and what could not be verified

- Vercel's cron list inside the live deployment was not visible from the CLI; the vercel.json at 447d9b85 has 13 crons including the monitor and watchdog (git-verified).
- The live line has no required CI check; evidence is the Vercel build, 4 new unit tests, 74 cron tests, lint, typecheck and an independent review with no security findings.
- Cron timing: minute :23 does not collide with `*/15` (monitor) or :37 (watchdog).
- After P and before A the only effect is one extra hourly 404 invocation.

## 4. Holds (unchanged)

#445, #326, pricing publication, the six provisional retail prices and SMS activation stay on hold. The sweep never publishes or changes a price.

## 5. Step P split into two owner gates (2026-11-18)

### P1: staged production-target build (build only)
Action: build commit 6ba31295749eb47ab80e2a011c8ee2094c241cc6 as a production-target, no-domain deployment of project `danceflow-app-qfem` (`vercel deploy --prod --skip-domain`, run by the party holding the Vercel CLI session, with a clean checkout of that commit). It is not assigned to www or any live domain and is not promoted; cron schedules do not run for a non-promoted deployment.
Executed by: the APPS coordinator (it holds the verified Vercel CLI session); I cannot sign in to Vercel.
Evidence returned: the exact staged deployment ID.
Verification (all read-only):
1. Source: deployment commit/tree equals 6ba31295 (file-tree comparison against git, as in the Embeds Path B record).
2. Target production, no alias or domain assigned; www still resolves to `dpl_DvJFayDdT36EqdKvKvWjQuyEKH28` before and after.
3. Production environment names via `vercel env ls production`: `SMS_PRICE_SWEEP` absent (disabled), `CRON_SECRET` present, no value printed.
4. `vercel.json` in the build: 14 crons = the live 13 plus `/api/cron/sms-price-sweep` at `23 * * * *`.
5. Rollback target stated: `dpl_DvJFayDd...`, then `dpl_FEzqXu6N...`.
Not done in P1: promotion, domain assignment, any env change, SQL, scheduling, price or SMS change. Spend: one Vercel build, no provider charges.
Abort condition: any mismatch in 1-4 stops the gate and is reported; the deployment is left unpromoted.

### P2: production promotion (separate, later)
Requested only after P1 passes, with the staged deployment ID. Never automatic. Contents as in section 2 Step P (staged route checks, `vercel promote`, 30-minute observation, rollback).

## 6. Gate C closeout (2026-11-19 00:06Z)

Live: dpl_EJ968dkDyrZ5aifYPDVbtLgmT7eq (6ba31295), promoted 2026-11-18 09:38:50Z; SMS_PRICE_SWEEP=on on the production target only. 14 scheduled sweeps 10:23Z to 23:23Z, all HTTP 200; 0 5xx; PROD requests 8 (6 expired, 2 rejected, 0 pending, 0 overdue), price list 0 rows, verifier ok, EXECUTE service_role only, 72 monitor runs with 0 findings, usage switch/attempt rows 0. Holds intact (#445, #326, pricing publication, SMS activation). Rollback: dpl_BVxHhpW5 (flag off) -> dpl_DvJFayDd -> dpl_FEzqXu6N. Gate C CLOSED; routine monitoring only.
