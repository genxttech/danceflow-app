# TW-4F PR #668 release preparation (2026-11-22)

Status (updated 2026-11-22): SUPERSEDED BY EXECUTION. R+3b was promoted 10:40 EST (dpl_CTZfSRaJgDGYVv3Jy9nE9SErrfE4, 96d91ea6) and observed clean; #668 was owner-approved and squash-merged into `release/website-embeds` as e84ed0f3 (the release base is `release/website-embeds`, not the r3b source branch). Gate S is in `TW-4F_Gate_S_Package_2026-11-22.md`. Original text follows. Status: PREPARATION ONLY. #668 merge is on an owner sequencing hold (not a rejection) until Apps confirms the R+3b release branch is available. No production SQL, merge into the active release candidate, deployment, flag, provisioning, SMS activation or provider spend is authorized by this document.

## What #668 is

PR #668 (draft, base `release/website-embeds`, head `7549376dc5cbe2a6178942bd309a89053f550734`): ports the TW-4F consent and accounting hardening already on main to the live line. 45 files; Git-only; dark.

| Layer | Content | PROD state (read-only probe 2026-11-22) |
| --- | --- | --- |
| `20270215100000_twilio_pending_opt_outs.sql` | table `studio_sms_pending_opt_outs` + 4 service-role-only functions | NOT applied (table and `sms_pending_opt_out_blocks` absent) |
| `20270217090000_twilio_ucs2_surrogate_segments.sql` | UCS-2 segment counting (`_tw4us_segments`) | applied 2026-11-14 (marker `v_starters` present) |
| `20270218090000_twilio_inbound_start_order.sql` | START/STOP ordering | applied 2026-11-14 |

All three migration files are byte-identical to main (sha256 prefixes d581e101…, 1129f251…, 3d1823b0…). Dependencies of 0215 exist in PROD: `studios`, `record_sms_inbound_opt_event(uuid,text,text)`.

App changes: `sendSuppression.ts` (pending-opt-out gate on every outbound path), `pendingOptOuts.ts`, inbound/status webhooks, `notifications/dispatch.ts`, `notifications/send/route.ts`, `sms/send/route.ts`, `segments.ts`, `usageReconciler.ts`, `usageBilling.ts`, `twilio.ts`.

## Compatibility

- Release base (corrected: `release/website-embeds`, not the r3b branch): `release/r3b-reminder-delete-backport` (2d28d3405) has a tree identical to `release/website-embeds` tip 96d91ea6 (diff empty). R+3b changes only `src/app/app/schedule/actions.ts` and its test; #668 touches nothing in `src/app/app/schedule`. `git merge-tree` of #668 onto the R+3b branch: clean, no conflicts.
- No `vercel.json` change, no new cron (parked-STOP drain rides the existing 15-minute notifications sender).
- Only new runtime flag: `SMS_PENDING_OPT_OUT_REQUIRED` (read at runtime in `sendSuppression.ts`, takes effect on the next deployment). Other env reads in touched files are pre-existing.

## Fail-closed behavior

- Flag unset: pending-opt-out check reports "clear" (pre-migration behavior).
- Flag `1` and function missing or stale PostgREST schema cache (PGRST202 / 42883): result "unknown", sends are suppressed (fail closed). The migration ends with `notify pgrst, 'reload schema'`.
- Webhook claims a STOP in the replay ledger only after it is applied or parked; a later START supersedes a parked STOP.

## Exact release sequence (each step is its own owner gate)

0. Pre: owner sequencing hold lifted by Apps confirmation that the R+3b base is available; Apps confirms no staged build is in flight.
1. **Gate M (merge):** owner CODEOWNERS approval on the exact #668 head, retargeted/rebased onto the confirmed R+3b base if it moved; CI green; squash merge into the release branch. Nothing deploys.
2. **Gate S (PROD SQL):** apply `20270215100000` via `danceflow-ops/sb.sh prod-apply`, with the preflight below, then immediately set `SMS_PENDING_OPT_OUT_REQUIRED=1` (Production env) BEFORE the staged build. Postflight: table exists; service-role-only grants; `select public.sms_pending_opt_out_blocks('00000000-0000-4000-8000-000000000000','+15550000000')` returns false; confirm via REST that the function is callable (cache reloaded).
3. **Gate D (staged deployment):** Apps runs `vercel deploy --prod --skip-domain`; checks: build ok, no new crons, env name present, one dark smoke (webhook 200/403 path, no SMS).
4. **Gate P (promotion):** Apps promotes; 30-minute observation (5xx on `/api/sms/*`, `/api/notifications/send`, inbound webhook; pricing monitor; no `PGRST202`).
5. Activation of messaging, studio provisioning and spend remain separate later gates (not part of #668).

Preflight (read-only, before Gate S): table absent; `sms_pending_opt_out_*` functions absent; `record_sms_inbound_opt_event(uuid,text,text)` present; 0217/0218 markers present; monitor fresh with 0 findings; price rows unchanged (six active).

## Rollback (order: flag off, app, SQL)

1. Unset `SMS_PENDING_OPT_OUT_REQUIRED` (or set to anything but `1`).
2. Roll the app back to the previous production deployment (id to be re-confirmed with Apps; earlier ids predate the live line moving).
3. SQL: first drain parked rows with `select public.sms_pending_opt_out_apply(200)` until `applied` is 0, then run `rollback/20270215100000_twilio_pending_opt_outs_rollback.sql` (refuses while open rows exist; re-runnable). The 0217/0218 rollbacks are NOT part of this release (already in PROD).

## Evidence

See "QA evidence" appended below by the verification run.

### QA evidence at head 7549376d (2026-11-22)

- Unit suites (`src/lib/sms`, `src/app/api/sms`, `src/lib/notifications`, `src/app/api/notifications`): all pass except `welcomeEmail.br3c.test.ts`, which times out at the 5 s default under a cold directory-wide run (2 tests); it passes alone (10/10) and fails identically on `release/website-embeds` (96d91ea6) without #668, so it is a pre-existing, unrelated flake. `tsc --noEmit` clean.
- Isolated database suites (disposable stack, scenario `numeric`, migrations from origin/main incl. 0215/0217/0218, tests from #668 head), one fresh database per suite: `localStack.tw4recon` 38/38, `localStack.f3recon` 13/13, `localStack.tw4inbound` 29/29. Evidence: `danceflow-iso-qa/runs/2026-11-22T12-21-38…numeric-44484`, `…12-29-08…numeric-43032`, `…12-35-44…numeric-24408`. (A first attempt running all three in one stack was OOM-killed by the 1.5 GB limit: infrastructure, not a result; discarded.)
- Static: `pendingOptOutsMigration.tw4f.test.ts`, `sendSuppression.tw4f.test.ts`, route and dispatch pending-opt-out tests pass.

### Unresolved coverage

- No hosted (DEV) rehearsal of 0215 beyond isolated stacks; DEV rehearsal is read/apply on DEV only and can be done under standing DEV authorization if wanted.
- Stale PostgREST cache after apply fails closed when the flag is set; covered by the post-SQL callable check, not by an automated test.
- Staged-build smoke steps are manual (Apps).
- Rollback app deployment id must be re-confirmed with Apps at gate time.
