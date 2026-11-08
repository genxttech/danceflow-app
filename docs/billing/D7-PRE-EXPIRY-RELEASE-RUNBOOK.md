# D7 pre-expiry release (#401 application gates + #402 desk RPC database guard): runbook

**Status: PREPARED, NOT AUTHORIZED (2026-11-06).** Nothing here has been applied to any hosted database or deployed. Each step needs the owner's explicit approval at that moment. This release is NOT needed for the core Organizer Suite release already live (`dpl_DFKP5sMmJMa1XiDe2czo49hvX4wz`, `release/pricing-p1` `a372221c`); it is required before any grant is given a `period_end`.

## 1. What it contains
| Item | Change | Needs SQL? |
|---|---|---|
| #401 | `confirmEventRegistrationAction` and `bookPrivateLessonSlotOfflineAction` refuse a NEW organizer-event sale without a current Organizer Suite entitlement; confirm also gained the registration-manage role check and no longer reports success as failure | no |
| #402 | migration `20270205100000_competition_desk_suite_gate.sql`: `record_competition_checkin_payment` refuses (SQLSTATE `D7001`) a desk payment that would complete an unpaid pending organizer-event order without a current entitlement; application maps the refusal | **yes** (apply after `20270203090000`, already on DEV and PROD) |

Release branch: `release/d7-pre-expiry` = `release/pricing-p1` (`a372221c`) + the two squash commits from `main` (`92a172fe`, `c1e16f6f`), cherry-picked without conflicts. Order: **SQL first, then application** (the application mapping is inert without the SQL and the SQL guard is inert for the old application, so either order is safe; SQL first keeps the guard from being the last step).

## 2. Read-only evidence already collected (2026-11-06)
* **PROD** preflight and recheck pass: the live `record_competition_checkin_payment` body equals the repository `20261116094000` definition (`src_md5 387aacac2effd055340e27211b8f7e4f`), owner postgres, SECURITY DEFINER, `authenticated` can execute, `anon` and PUBLIC cannot, the guard helper is absent, PostgreSQL 17.6. Day-one impact on PROD: **0** pending organizer-event orders the guard could refuse a desk payment on.
* **DEV** preflight and recheck pass identically; DEV has **4** pending organizer-event orders (disposable test data).
* Disposable rehearsal `scripts/release/d7_desk_flight_dryrun.sh`: 17 checks pass (preflight passes on the repo definition, a drifted body is detected, apply, postflight, the postflight detects 4 kinds of tampering, preflight flags the applied state, rollback restores a state the preflight accepts, re-apply). The migration's own SQL suite (60 checks) and concurrency run (22 checks) passed in #402.
* No new environment variable; `vercel.json`, `package.json`, `package-lock.json`, `next.config.ts` unchanged by these PRs.

## 3. Sequence
All SQL steps use the wrapper with the desk scripts: `D7_FLIGHT_PREFIX=d7_desk bash scripts/release/d7_core_flight.sh <preflight|recheck|postflight> <dev|prod> <evidence-dir>` (set `D7_DEV_WORKDIR` / `D7_PROD_WORKDIR`; the wrapper refuses the wrong project and exits non-zero unless every check passes). Apply with `supabase db query --linked [--workdir <prod>] -f <file>` (never `db push`).

| Step | Gate | Action | Stop condition |
|---|---|---|---|
| 0 | none | `d7_core_artifact_check.sh`-style hash check of `20270205100000_competition_desk_suite_gate.sql` and its rollback (record sha256 at approval time); preflight + recheck on DEV | any failing row, especially check 3 (drift) |
| 1 | **G-A** | apply the migration to DEV; postflight DEV | postflight not all-pass |
| 2 | DEV check | optional: staged candidate on :3100 against DEV for the #401 gates (offline private-lesson booking is the only one with a UI; confirm-registration has no UI caller) using the fixture (`d7_dev_smoke_fixture.cjs`), then cleanup | unexpected refusal of an ordinary studio lesson |
| 3 | **G-B** | merge the release PR into `release/pricing-p1` (option A, as before) | CI red or tree differs from the tested branch |
| 4 | **G-C** | PROD: preflight + recheck, apply the migration, postflight | any difference from the evidence above |
| 5 | **G-D** | staged deployment (`vercel deploy --prod --skip-domain`, clean `git archive` of the merged head, cached CLI as in the core release) | not Ready |
| 6 | **G-E** | `vercel promote`, public checks on the production domain (home/login/sign-up 200, unsigned webhook 400, GET add-on checkout 405, expiry cron 404), 30-minute observation | any unexplained error |

## 4. Rollback (reverse order)
1. Application: `vercel rollback <dpl live before the promotion, i.e. dpl_DFKP5sMmJMa1XiDe2czo49hvX4wz>`.
2. SQL (only if needed): `rollback/20270205100000_competition_desk_suite_gate_rollback.sql` restores the previous definition and ACL exactly and removes the helper; the preflight accepts the result (rehearsed). Rolling back the SQL re-opens the direct-RPC gap but changes no data.

## 5. What this release does and does not close
Closes: direct API calls to the desk RPC completing an unpaid pending organizer order after a lapse; staff confirming a pending unpaid organizer registration after a lapse; offline private-lesson booking for an organizer slot after a lapse. Still open before any `period_end` is set: the paid add-on (WP-4), the advance notice (WP-5), cart/student Checkout sessions created before expiry (stay payable until their own expiry, by the "webhooks never consult the entitlement" rule), the owner decision on what a studio sees after access ends, and the CI path-filter gap (PRs touching only `src/app/app/events/**` get no typecheck job: dispatch `e2e-public-event-registration.yml` on the branch).
