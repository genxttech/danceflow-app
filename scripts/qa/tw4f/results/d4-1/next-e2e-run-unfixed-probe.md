# D4-2 real Next.js browser acceptance run

- when 2026-11-06T02:11:02.449Z; branch claude/d4-2-price-next-e2e @ cafba9fd (src dirty); node v24.14.1; Chromium 151.0.7922.34
- stack: df-isoqa/base:20261119092100 + 56 repo migrations (last 20270208110000_twilio_price_monitor.sql), PostgREST, GoTrue, Kong (local, disposable); app: next build + next start (Turbopack) at http://localhost:3417
- **totals: 14 PASS, 6 FAIL, 1 BLOCKED**

| scenario | PASS | FAIL | BLOCKED |
|---|---|---|---|
| 1 | 7 | 0 | 1 |
| 5 | 2 | 6 | 0 |
| 0 setup | 5 | 0 | 0 |

## Checks

- PASS [0 setup] login + TOTP challenge through the real pages (session 1) :: http://localhost:3417/platform/sms
- PASS [0 setup] login + TOTP challenge through the real pages (session 2, separate session) :: http://localhost:3417/platform/sms
- PASS [0 setup] two distinct GoTrue sessions exist :: 3 sessions
- PASS [0 setup] config defaults: single_owner, 24 h cooling-off, backup-eligible refused, monitoring not expected :: single_owner
- PASS [0 setup] the keys panel is rendered by the Next page (no credentials yet)
- PASS [1] UI before any key exists: enrol is refused with a clear sentence and creates nothing :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [1] owner bootstrap registers the first primary (RP localhost, origin of the Next host)
- BLOCKED [1] first primary enrolment THROUGH THE UI :: by design there is no UI path: Request a new key needs an existing key to sign (priceCredBegin/priceCredEnroll); the first key is the owner runbook bootstrap (_tw4price_bootstrap). Verified above that the UI refuses cleanly with no key.
- PASS [1] spare request via UI is PENDING (not active) :: Requested. The new key becomes usable only after the delay; you can cancel it until then.
- PASS [1] Apply before the delay is refused with a clear sentence and the key stays pending :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [1] spare applied through the UI after the aged database clock :: Done: applied.
- PASS [1] recovery key enrolled through the UI (third credential) :: Done: applied.
- PASS [1] the audit holds the credential_change_pending and credential_change_applied events :: 2
- FAIL [5] freeze through the UI (aal2 session) :: The action failed. Nothing changed; reload and check the current state before trying again.
- FAIL [5] propose while frozen is refused with a clear message :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- FAIL [5] the page shows the suspension banner and the primary key lifts it :: This is not allowed in the proposal's current state (another proposal for this price is still open, or this one is already decided). Nothing changed.
- FAIL [5] freeze with the RECOVERY key through the UI :: The action failed. Nothing changed; reload and check the current state before trying again.
- FAIL [5] ordinary thaw is refused during a recovery freeze/hold :: This is not allowed in the proposal's current state (another proposal for this price is still open, or this one is already decided). Nothing changed. (recovery_hold=false)
- PASS [5] an ordinary key cannot revoke the recovery key (stays active) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [5] recovery enrolment through the UI is pending and suspends publication :: Recovery requested. It completes only after the long delay, raises high-severity alerts, and a primary or spare key can cancel it. (suspended=true)
- FAIL [5] scenario 5 aborted by a harness/page error :: TimeoutError: locator.click: Timeout 30000ms exceeded.
