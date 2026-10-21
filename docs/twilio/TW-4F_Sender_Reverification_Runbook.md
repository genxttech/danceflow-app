# TW-4F sender re-verification — runbook

Operations for the scheduled sender re-check (design: `TW-4F_Sender_Reverification_Design.md`). Every hosted step (SQL, flags, schedule) needs the owner's explicit approval. None has been done.

## 1. Activation

1. Hosted SQL after `20261205090000`: apply `20261206090000_twilio_sender_reverification.sql`.
   - Preflight: `to_regprocedure('public.tw4_sender_reverify_run(uuid,uuid,uuid,jsonb,text)')` is null, and `public.tw4_local_qa_only` does not exist.
   - Postflight: `tw4_sender_reverify_run` and `tw4_sender_health` are service-role only, and the marker table is still absent.
2. Production environment:
   - `SMS_SENDER_REVERIFY=on` (the route answers);
   - `CRON_SECRET`;
   - `SMS_SENDER_VERIFY_READS=on` (read-only GETs);
   - the token-read parent credentials;
   - `NEXT_PUBLIC_APP_URL` (the expected inbound route).
3. Register `{ "path": "/api/cron/sms-sender-reverify", "schedule": "*/15 * * * *" }` in `vercel.json` in its own reviewed PR, and update the test that pins "not registered".
   - Every 15 minutes, each sender is re-read soon after 20 hours, with several retries before its 24-hour deadline.
   - Do not change the usage-reconciliation schedule.
4. Watch two completed runs on the panel (Platform → SMS → subaccount panel, scheduler line) before billed sending is switched on.

## 2. Reading the panel

| Signal | Meaning | Action |
|---|---|---|
| Red "Sender re-checks are not running" | An approved sender exists and no run completed in 2 h | Check the cron logs (`sms_sender_reverify_failed`), `CRON_SECRET` and the flags. Senders stop sending 24 h after their last success |
| Expiring | Under 4 h of trust left | Normally the next hourly run renews it. "Re-check now" if certainty is needed |
| Expired, last attempt inconclusive | Twilio could not be read (outage, rate limit) | Nothing is sent meanwhile. Wait for the retries, or "Re-check now" once Twilio is reachable |
| Credentials unavailable | The subaccount's token cannot be obtained (closed or suspended subaccount, token-read setup) | Investigate. It does not fix itself |
| Lapsed days ago | Trust lapsed more than 48 h ago; the scheduler no longer restores it | Verify it again, with the attestation |
| Failed: provider codes (campaign not verified, number not in service, number not ready, account not active, inbound not routed, 30034) | Twilio's resources changed | Fix it in the Twilio Console for that subaccount, then Verify (attest Advanced Opt-Out) |
| Failed: ownership codes (service or campaign on another account, brand not the business, mock, use case, read not found or forbidden) | Possible reassignment or wrong subaccount | Investigate before verifying. Never re-verify what you cannot explain |
| Blocked | Verified, but the subaccount is no longer active or the location's path changed | Resolve the subaccount or path, then Verify |

## 3. Incidents

- **Twilio outage or rate limit**: nothing to do. Senders keep their last success until 24 h, then stop sending until a check succeeds.
- **A run crashed**: the next run closes its lease (after at most 120 s) and continues. Writes from the crashed run are refused (`TW023`).
- **Suspected wrongful revocation**: read the sender's verification rows (`failure_code`, `evidence`, `source`). Restore only with an admin verification after the cause is understood.

## 4. Rollback

- **App**: unset `SMS_SENDER_REVERIFY` (the route returns 404).
- **SQL**: the rollback succeeds only before any re-verify run or inconclusive audit row exists. After that it refuses, and the stance is forward-fix only. Test it only inside a transaction that is rolled back.
