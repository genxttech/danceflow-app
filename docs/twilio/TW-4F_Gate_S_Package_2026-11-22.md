# TW-4F R+4 Gate S package (production SQL + configuration) — 2026-11-22

PREPARATION ONLY. Nothing here has been executed on production. Release commit: `e84ed0f3dcf9198ad2ef3d9ee749ffae9e3caa81` (`release/website-embeds`, #668 squash; the live line is still R+3b `96d91ea6`, dpl_CTZfSRaJgDGYVv3Jy9nE9SErrfE4).

## 1. The migration
File: `src/lib/supabase/migrations/20270215100000_twilio_pending_opt_outs.sql` at e84ed0f3 (identical to main). SHA-256 `d581e1011795b553215db084488d21a9d2a40d001338c6d016b72b86133fb1aa`, no CR characters, one self-contained transaction (begin/commit), idempotent (`if not exists`, `create or replace`).

It creates ONLY new objects: table `public.studio_sms_pending_opt_outs` (RLS on; all privileges revoked from public, anon, authenticated and service_role), partial unique index `uq_studio_sms_pending_opt_outs_open`, and four SECURITY DEFINER functions with a pinned `search_path` (`sms_pending_opt_out_record`, `_supersede`, `_apply`, `_blocks`), EXECUTE granted to `service_role` only, then `notify pgrst, 'reload schema'`. It alters no existing object. The only cross-object dependency is an FK to `public.studios(id)` (a brief lock on `studios` while the constraint is added; the preflight checks for blocking locks).

Dependencies, all verified present on PROD 2026-11-22 17:24Z: `public.studios` (with PK), `public.record_sms_inbound_opt_event(uuid,text,text)` (called by `_apply`), `gen_random_uuid()`. Order: 0217 and 0218 are already applied in PROD (2026-11-14). 0215 does not depend on them and sorts before them, so it applies out of timestamp order. That is safe because PROD keeps no migration-history table (verified: no `supabase_migrations.schema_migrations`); order is verified by object state, not history.

## 2. Preflight (read-only): `docs/twilio/ops-sql/gate_s_preflight.sql`
Run `C:/Users/mcurt/danceflow-ops/sb.sh prod-read docs/twilio/ops-sql/gate_s_preflight.sql`. Actual result 2026-11-22 17:24Z (all as expected): table and the four functions absent; studios, PK, `record_sms_inbound_opt_event`, `gen_random_uuid` present; 0217 marker and 0218 function present; 6 active price rows, 0 pending price requests; monitor last run fresh; 0 long-running transactions; 0 blocked locks on `studios`. Re-run immediately before the apply; any deviation means STOP.

## 3. Apply procedure (needs owner authorization of this exact file hash)
1. The preflight is clean.
2. `C:/Users/mcurt/danceflow-ops/sb.sh prod-apply <copy of the 0215 file from e84ed0f3 in a scratch directory> d581e1011795b553215db084488d21a9d2a40d001338c6d016b72b86133fb1aa`. The runner checks the linked project is PROD, rejects CR line endings, refuses a SHA mismatch and logs every run to `danceflow-ops/log/ops.log`.
3. Error handling: the migration is one transaction, so a failure rolls back everything (all objects absent). Re-run the preflight to confirm "absent", report, and do not retry blindly. A non-zero exit with objects present: run the postflight and report.
4. Rehearsed on DEV 2026-11-22 with the same runner and hash: apply OK, postflight ok=true, rollback script dropped all objects, re-apply OK (idempotent). DEV now has 0215 applied.

## 4. Postflight (read-only): `docs/twilio/ops-sql/gate_s_postflight.sql`
Expected `ok: true`: table exists; RLS on; 0 table grants to anon, authenticated, public or service_role; 4 functions; EXECUTE for service_role on all 4 and for anon/authenticated on none; 4 security-definer functions with pinned search_path; 1 open-unique index; `sms_pending_opt_out_blocks('00000000-0000-4000-8000-000000000000','+15550000000')` = false; 0 rows. Then confirm over PostgREST with the service role that the RPC is callable (schema cache reloaded; `PGRST202` means stale cache: wait and retry). The flag must not be set before this passes.

## 5. Flag procedure and effect on the live deployment
`SMS_PENDING_OPT_OUT_REQUIRED=1` (Production) is set ONLY after the postflight is ok and the RPC is callable. The flag is read at runtime from `process.env` in `sendSuppression.ts`, which exists only in #668. The live R+3b code (96d91ea6) contains no reference to the flag or to any `sms_pending_opt_out_*` function (verified by search), and Vercel environment changes bind to NEW deployments only. So applying the SQL and setting the variable have NO effect on the live R+3b; they take effect only in the R+4 build. The variable must exist BEFORE R+4 is built (env is frozen at build). In R+4: flag set and function missing or stale cache means "unknown", so outbound SMS fails closed; flag unset means "clear" (pre-migration behavior).

## 6. Rollback (order: flag, app, SQL)
1. Unset `SMS_PENDING_OPT_OUT_REQUIRED` (only matters for a deployment containing #668).
2. Roll the app back to R+3b `dpl_CTZfSRaJgDGYVv3Jy9nE9SErrfE4` (it does not read the flag or the table).
3. SQL: drain parked rows (`select public.sms_pending_opt_out_apply(200)` until `applied` is 0), then run `rollback/20270215100000_twilio_pending_opt_outs_rollback.sql` (SHA-256 prefix bf29262b7f68e951). The script REFUSES to drop while any open (not applied, not superseded) parked opt-out exists, so no pending STOP is lost. Applied rows are only an audit trail; the consent itself lives in the canonical opt-out record written by `record_sms_inbound_opt_event`, so dropping the table loses no opt-out. Before the first R+4 traffic the table is empty, so an immediate SQL rollback is lossless. Never roll the SQL back while a build with the flag set is still live (it would fail closed).

## 7. Isolation and compatibility
- Pricing monitor and dual control: the migration touches no price, monitor, ledger or credit object; the diff e84ed0f3 vs 96d91ea6 contains no price, monitor or embed file. Preflight and postflight record the active prices (6) and monitor freshness; the pricing check task keeps running through the gate.
- Scheduled jobs: no cron or `vercel.json` change (14 crons in both). The parked-STOP drain rides the existing `/api/notifications/send` cron (`applyPendingOptOuts`); nothing new is scheduled.
- Website Embeds: `WEBSITE_EMBEDS` is unset and untouched; no embeds file changed.
- Twilio financial-operation windows are unaffected (no provider call, no ledger write).

## 8. Gates and exact owner authorizations
- **GATE S1 (SQL):** authorize `prod-apply` of the 0215 file with SHA-256 `d581e1011795b553215db084488d21a9d2a40d001338c6d016b72b86133fb1aa` to PROD, after a clean preflight, followed by the read-only postflight.
- **GATE S2 (configuration):** authorize setting `SMS_PENDING_OPT_OUT_REQUIRED=1` in the Production environment, only after the S1 postflight is ok. Name and value only; no other variable changes.
- Then, separately: Apps stages R+4 from e84ed0f3 (rollback to R+3b), then a separate owner promotion and 30-minute observation. No SMS activation, provisioning or spend is part of this.
