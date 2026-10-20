# TW-4F usage reconciliation — runbook

Operations for the scheduled SMS usage reconciler (design: `TW-4F_Usage_Reconciliation_Design.md`). Every step that touches hosted DEV (`epdrtzcydvnoidwrepqz`) or PROD (`hvsujyfbftfffxpfmlpb`), a schedule, an environment flag or Twilio needs the owner's explicit approval first. Nothing below has been done on any hosted environment.

## 1. Before activation (activation gates)

1. Hosted SQL in order: `20261201` → `20261202` → `20261202140000` / `20261202150000` → `20261203` → `20261204` → `20261205090000_twilio_usage_reconciliation.sql`.
   - Preflight: `select to_regclass('public.studio_sms_reconcile_runs')` is null. `select to_regclass('public.tw4_local_qa_only')` is null (the local QA marker must never exist on hosted).
   - Postflight: the three tables and the history table exist with no API-role privileges; `select public._tw4us_reconciliation_gaps() + public._tw4in_reconciliation_gaps()` = 0; `tw4_local_qa_only` is still null.
2. Deploy the application containing the route (still answers 404 by itself).
3. Environment (production only, owner approval):
   - `SMS_USAGE_RECONCILER=on` (the route answers);
   - `CRON_SECRET` set (already used by other crons);
   - `SMS_USAGE_EVIDENCE_READS=on` (read-only GETs with each subaccount's own credentials);
   - the token-read parent credentials (see sender readiness §9).
4. Register the schedule: add `{ "path": "/api/cron/sms-usage-reconcile", "schedule": "*/5 * * * *" }` to `vercel.json` in its own reviewed PR. The unit test that pins "not registered" must be updated in that PR.
5. Watch two completed runs in the panel (Platform → SMS → Usage reconciliation) before turning on `SMS_BILLED_REAL_SEND` or the database usage switch.

## 2. Reading the panel

| Signal | Meaning | Action |
|---|---|---|
| **Reconciliation is not running** | The usage switch is on and no run completed in 30 min | Check the cron logs (`sms_usage_reconcile_failed`), `CRON_SECRET`, the env flag. Consider switching billed texting off (`tw4_usage_set_switch`) until runs resume |
| Gaps ≠ 0 | Ledger and attempts disagree | Stop: switch billed texting off and investigate before anything else |
| Stale reserved > 0 after a run | Release could not run (lease lost or errors) | Look at the last run's error |
| Evidence retrying | Provider reads failing | Check Twilio status and the subaccount token. Attempts go to review on their own after 12 failures and 24 h |
| Exceptions | Attempts only an admin can close | §3 |
| Unseen keywords | A STOP/START/HELP the webhook never processed | §4 |
| Inbound checkpoint lag > 2 h | Recovery behind or a subaccount's list failing | Check the run summary (`inbound_*`, `errors`, `truncated`) |

## 3. Resolving an exception (written, audited, final)

Before resolving, establish the facts **in the Twilio Console for the attempt's own subaccount** (never the parent). Find the message by time window and destination, and note its SID, status and segments.

- **No provider message, and Twilio shows none was created** (allow at least 15 min after the marker; the database enforces it): **Release (not sent)**.
- **A provider message exists and was delivered/sent**: **Charge N segments** (the segments Twilio shows).
- **A provider message exists but is not billable** (failed MMS, carrier rejection before send): **Close without charge**.
- Write what you checked in the reason (at least 10 characters; it is stored in the audit trail). The outcome is final, so never guess. If Twilio cannot be consulted, leave the attempt open; the reservation stays held, which is the safe state.

## 4. Unseen keywords

The text was recorded as compliance (never charged), but DanceFlow did not apply the consent change. Twilio Advanced Opt-Out has already blocked or unblocked the number at the carrier.

1. Find the client (the panel shows the studio, not the number).
2. Apply the change only if no later keyword from the same number exists.

## 5. Incidents

- **Twilio outage**: nothing to do. Reads back off and reservations are held. Do not resolve attempts by hand during the outage.
- **Token rotation**: the provider re-reads once on 401. Persistent `usage_evidence_credentials_rejected` means the token-read parent cannot read the subaccount; fix the credentials, and attempts retry on their own.
- **A run crashed**: the next run closes its lease as failed (after 300 s at most) and continues. Writes from the crashed run are refused (`TW023`).
- **Duplicate or overlapping invocations**: harmless (`busy`).
- **Suspected double charge**: check `studio_sms_usage_attempt_events` for the attempt and the ledger key `usage:sms:<attempt>` (unique per attempt). The gap counters must be 0.

## 6. Rollback

- **App**: unset `SMS_USAGE_RECONCILER` (the route returns 404), or remove the cron entry. Billed sends must then stop too (`tw4_usage_set_switch` off), because nothing would settle them.
- **SQL**: `rollback/20261205090000_twilio_usage_reconciliation_rollback.sql` only succeeds while no run, checkpoint, recovery, history row or reconciliation evidence exists, which in practice means before activation. After that it refuses by design: forward-fix only. Test it only inside a transaction that is rolled back, or on a disposable database, never against shared QA.

## 7. Local QA

```bash
TW4A_LOCAL_URL=http://127.0.0.1:55321 TW4A_LOCAL_DB_CONTAINER=supabase_db_danceflow-e2e-qa TW4A_LOCAL_JWT_SECRET=<GOTRUE_JWT_SECRET of supabase_auth_danceflow-e2e-qa> npx vitest run --no-file-parallelism src/lib/sms/__tests__/localStack.tw4recon.test.ts
```

The suite needs the local-only marker `public.tw4_local_qa_only` (created by its fixtures, never by a migration). It tests the rollback only inside a transaction that is rolled back.
