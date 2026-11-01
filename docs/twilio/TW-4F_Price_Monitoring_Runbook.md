# TW-4F price-integrity monitoring and alert path (D4-2) - runbook

Status: Git only. Nothing is applied to a hosted database, nothing is deployed, the routes are NOT registered in `vercel.json`, no provider was called. Migration `20270205090000_twilio_price_monitor.sql` (rollback in `rollback/`) is local-QA proven only.

This monitor DETECTS and ALERTS. It never publishes, repairs, rolls back or overwrites a price. Preventing an unauthorized price change is D4-1's job (dual control, PR #384); this is the second line that tells the business owner when prevention failed, was bypassed, or its credentials may be compromised.

## 1. What runs

| Piece | Where | Purpose |
|---|---|---|
| Monitor | `src/lib/sms/pricing/monitor.ts` `runPriceMonitor`, route `/api/cron/sms-price-monitor` | verifier + price-list digest + security events -> findings -> evidence -> alert -> heartbeat |
| Watchdog | `runPriceWatchdog`, route `/api/cron/sms-price-monitor-watchdog` | alerts when no monitor run is recorded within `PRICE_MONITOR_MAX_AGE_MINUTES` (default 45), when the evidence chain is broken, or when alerts stay undelivered |
| Evidence | tables `studio_sms_price_monitor_evidence`, `studio_sms_price_security_events` | append-only, hash-chained run/delivery/watchdog record; security-event feed |
| Transport | `transport.ts` | webhook (HMAC-signed), dead-man heartbeat URL, dedicated-key email; fakes for tests |

Both routes answer 404 unless `SMS_PRICE_MONITOR=on`, then require `CRON_SECRET`. They answer 500 whenever anything is wrong (a finding, an undelivered alert, no destination, an evidence failure), so the scheduler also flags the run. Suggested schedule once authorized: monitor every 15 minutes, watchdog hourly, registered as two separate entries by a release owner.

Database surface (service_role, allow-listed in `db.ts`, enforced by a unit test that also scans for table access and price-mutation function names): `tw4_price_verify(p_since)` (D4-1), `tw4_price_monitor_digest()`, `tw4_price_monitor_events(p_after_seq)`, `tw4_price_monitor_evidence_list(...)`, `tw4_price_monitor_evidence_append(...)`. None can write a price table. The only write is the evidence append.

## 2. Independent alert destination

The destination is configured from environment values only (`loadMonitorConfig`). It is never read from a table, a studio / platform setting or an admin screen, so neither a platform administrator, a studio owner nor `service_role` can redirect, mute or edit it through the application or the database.

| Variable | Meaning |
|---|---|
| `PRICE_MONITOR_WEBHOOK_URL` / `PRICE_MONITOR_WEBHOOK_HMAC_SECRET` | https endpoint owned by the business owner (chat, pager, incident tool). Body is signed: hex HMAC-SHA256 in `x-df-signature`. |
| `PRICE_MONITOR_HEARTBEAT_URL` | dead-man service ping on every completed run (the service alerts the owner when pings stop) |
| `PRICE_MONITOR_RESEND_API_KEY`, `PRICE_MONITOR_EMAIL_FROM`, `PRICE_MONITOR_EMAIL_TO` | a DEDICATED Resend key (not the application's) and the owner's own mailbox |
| `PRICE_MONITOR_CHAIN_KEY` | optional HMAC key for the evidence chain (separate secret) |
| `PRICE_MONITOR_SINCE` | optional cutover timestamp passed to the verifier |
| `PRICE_MONITOR_REPEAT_MINUTES` (360), `PRICE_MONITOR_MAX_AGE_MINUTES` (45) | re-alert interval while a finding persists; watchdog staleness |
| `PRICE_MONITOR_EXPECT_HEAD` (`<seq>:<hash>`), `PRICE_MONITOR_TRUST_CHAIN_FROM_SEQ` | see sections 4 and 6 |

How to keep the destination out of reach (owner actions, none performed here):

1. Create the variables in a separate secret scope of the hosting project, production scope only (never Preview / Development), editable only by the owner account, not by approvers or platform administrators.
2. Point them at accounts the platform administrators and approvers do not control: a mailbox, webhook workspace and dead-man service registered to the business owner, with the owner's MFA.
3. Use a Resend API key created for this purpose and restricted to sending from one domain; a webhook secret used nowhere else.
4. Never log the variables. The adapters raise error codes only (`http_503`, `network`), never URLs or headers.
5. Residual: whoever can edit the hosting project's environment can change the destination. That is the owner. If that is not acceptable, move the monitor to a separate project / job runner with its own scope (D4-1 impersonation design, option G) and give it a direct Postgres login role with EXECUTE on the five functions only.
6. Recommended hardening (not implemented, needs a hosted change): replace the service-role client in the route with that dedicated read-only role. Today the monitor uses the app's service-role client restricted to the allow-list.

## 3. What each run does and records

1. Read and verify the evidence tail (200 rows). Unreadable or broken -> critical finding; the run continues and still alerts.
2. `tw4_price_verify(since)`. Any error, wrong shape, `ok` contradicting the anomaly list, stale `checked_at` (older than 5 minutes) or unknown anomaly code -> `verification_failure` (fail closed).
3. `tw4_price_monitor_digest()`: a hash of the whole price list. A change since the previous run raises `price_changed` (info when the verifier is clean) so a neutered or replaced verifier cannot hide a change.
4. `tw4_price_monitor_events(cursor)`: new security events, consumed generically (section 5).
5. Append a `run` evidence row (findings, event cursor, digest, whether an alert was required), then deliver, then append a `delivery` row for every attempt per destination (success or failure, attempt count, error code).
6. Heartbeat ping.

Alerting rules: alert on any finding not covered by the last delivered alert, and again every `PRICE_MONITOR_REPEAT_MINUTES` while a finding persists. A shrinking set stays quiet. Failed deliveries (3 attempts per destination with backoff) are recorded, shown as `alert_delivery_failed`, and every earlier undelivered alert (up to 5) is re-sent on each later run until one destination accepts it. Delivered means at least one alert-capable destination accepted it; the heartbeat URL never counts as an alert destination. No destination configured is a critical finding and a 500.

## 4. Evidence chain and tamper detection

`entry_hash = H(prev_hash | seq | run_id | kind | recorded_at_ms | payload)` where H is SHA-256, or HMAC-SHA-256 when `PRICE_MONITOR_CHAIN_KEY` is set. The database enforces linkage (`seq = head + 1`, `prev_hash = head hash`), serialization (advisory lock) and immutability (UPDATE / DELETE / TRUNCATE refused, triggers ENABLE ALWAYS, also under replica mode, no API-role table privilege). The application recomputes every hash on every run.

Every alert and heartbeat carries the chain head (`seq` + `hash`) to the independent destination. That is the anchor:

- Edited row or forged append with a wrong hash: `evidence_chain_broken` (hash / link / gap).
- Forged append with a correct plain hash by someone who can write the table: caught only if `PRICE_MONITOR_CHAIN_KEY` is set (they do not hold it).
- Tail truncation or a complete rewrite by a superuser: invisible to the database alone. Detect by comparing the head in the last alert with the database head (query below), or by setting `PRICE_MONITOR_EXPECT_HEAD` to the last published head so the next run reports `head_mismatch` / `truncated`.

```sql
-- as the owner, read only
select seq, entry_hash, recorded_at from public.studio_sms_price_monitor_evidence order by seq desc limit 3;
```

## 5. Alert types and response

Severity is critical unless stated. Never respond by editing prices, evidence or the registry to make an alert go away.

| Code | Meaning | Response |
|---|---|---|
| `unauthorized_price_change` | a published price has no applied two-person request by distinct registered approvers (or several active prices for one kind) | 1. Treat as an incident. Suspend pricing (section 7). 2. Compare the listed price ids with the price change request history and Auth audit log. 3. Rotate the service-role key and JWT secret if admin-API misuse is plausible. 4. Restore the correct price only through a documented, ticketed owner step (disable the guard for that statement, then re-enable `ENABLE ALWAYS`), then run `select public.tw4_price_verify(...)` and review every listed price. |
| `missing_approval` | a request is `approved`/`applied` with a missing, self-approved or unregistered decider, or is stuck | Inspect the request row (read only). A request stuck `approved` over a minute means the apply step failed: rerun the apply through the D4-1 workflow or reject it. Anything else: incident. |
| `verification_failure` | verifier error, bad or stale output, unknown anomaly code, or unreadable event feed | Assume the worst until proven benign. Run the verifier by hand as the owner. If the function was replaced or is missing, restore it from the migration (Git is the source). Keep pricing suspended meanwhile. |
| `credential_compromise` | a reported credential compromise | Suspend pricing, revoke the credential, rotate secrets, review recent price rows and Auth events, follow D4-1's credential replacement procedure. |
| `credential_replaced`, `approver_registry_changed` (warning) | an approver credential / MFA factor / registry entry changed | Confirm with the person out of band that it was them. If not confirmed, treat as `credential_compromise`. |
| `pricing_suspended` | emergency suspension is in force (repeats every re-alert interval) | Expected during an incident. Lift only per section 7. |
| `pricing_resumed` (warning) | suspension lifted | Confirm the owner did it. |
| `unknown_security_event` (warning) | an event kind this monitor version does not know | Read the event row; extend `EVENT_KINDS` in `types.ts` if it is legitimate. |
| `price_changed` (info) | digest moved while the verifier is clean | Expected after an approved change. If no change was approved, it is a verifier-evasion signal: treat as `unauthorized_price_change`. |
| `digest_unavailable` (warning) | digest unreadable | Check the function and grants. |
| `evidence_chain_broken` | hash, link, gap, head mismatch or truncation | Do not rewrite anything. Preserve a copy of the evidence table, compare with the last alert heads, find out who had database write access, then acknowledge (section 6). |
| `evidence_unavailable` | evidence could not be read or written | Alerts still go out. Fix the database path; runs resume the chain. |
| `alert_delivery_failed` | an earlier alert was not delivered, or no destination exists | Fix the destination (owner scope). Earlier alerts are re-sent automatically. |
| `monitor_stale` (watchdog) | no monitor run recorded within the allowed age | Check the scheduler, `SMS_PRICE_MONITOR`, `CRON_SECRET`, deployment and database. Treat a stop that nobody caused as suspicious: it is also what an attacker silencing the monitor looks like. |

Dead-man: besides the watchdog (which runs in the same application and can be silenced with it), the external dead-man service behind `PRICE_MONITOR_HEARTBEAT_URL` alerts the owner when pings stop. That is the independent backstop; configure it with a period slightly over the monitor schedule.

## 6. Recovery without a permanent bypass

- Acknowledging a chain break: after the investigation, set `PRICE_MONITOR_TRUST_CHAIN_FROM_SEQ=<seq of the last bad row>` in the owner scope. Rows up to that seq are no longer judged, the setting is named in every following `evidence_chain_broken` message and must be removed at the next review. The bad rows stay in the table (append-only). It never disables any other check.
- Restoring a price after an incident: see `unauthorized_price_change`. The guards are switched off for one statement and re-enabled `ENABLE ALWAYS`; no standing bypass exists.
- Clearing a transport problem: fix the environment value; the next run re-sends pending alerts.
- Disabling the monitor entirely is a deployment change (unset `SMS_PRICE_MONITOR` or unregister the cron). The watchdog and dead-man alert on that.

## 7. Emergency pricing suspension

Contract with D4-1: the suspension is an event in `studio_sms_price_security_events`: `pricing_suspended` begins it, `pricing_resumed` ends it (the latest of the two decides). The monitor reports the state on every re-alert interval while suspended. THE MONITOR DOES NOT ENFORCE IT. D4-1's propose / approve functions must refuse while the latest event is `pricing_suspended` (see section 9). Until D4-1 provides that, the interim suspension is: the owner empties the approver registry (an owner-level runbook step in the D4-1 document) so nobody can propose or approve (fail closed), and inserts the `pricing_suspended` event as the owner so the monitor reports it.

Lifting: the owner inserts `pricing_resumed` after the cause is closed, re-registers approvers, runs `tw4_price_verify` clean, and confirms the `pricing_resumed` alert arrived.

## 8. Detected-only versus prevented

| Prevented elsewhere (D4-1) | Detected only by this monitor |
|---|---|
| single administrator publishing a price (`tw4_price_set` closed, guards on the price list) | a price row that exists without a valid two-person request (a database writer or restore bypassed the guards) |
| non-registered or non-AAL2 callers proposing / approving | credential compromise or replacement events (as reported by D4-1), approver registry changes |
| edits or deletion of published prices and requests | changes to the guards themselves, a replaced verifier (digest), a stopped monitor (watchdog, dead-man) |
| | a forged or truncated monitor evidence history (chain, published head) |

Not detected: anything by the database owner / superuser who also controls the hosting environment (they can disable guards, the monitor and the destination); a compromised approver pair acting through genuine AAL2 sessions (the price change looks legitimate; credential events and the `price_changed` notice are the signal); the interval between a forged row and the next run (up to 15 minutes at the suggested schedule).

## 9. What the authorization workstream (D4-1, PR #384) must provide

1. `tw4_price_verify(p_since timestamptz)` returning `{ok, anomalies[], checked_at}` with codes `price_unattested`, `request_anomaly`, `several_active_prices` (as in `20270204090000`). New codes are classified as `verification_failure` until `classify.ts` learns them.
2. Event emission: SECURITY DEFINER functions (owner-owned) inserting into `studio_sms_price_security_events` (`kind`, `subject_user_id`, `detail` without secrets) for: `credential_compromise_reported`, `credential_replaced` / `mfa_factor_changed` / `approver_credential_replaced`, `approver_registry_changed` / `approver_added` / `approver_removed`, `pricing_suspended`, `pricing_resumed`. Unknown kinds alert as warnings.
3. Enforcement of the suspension: propose / approve refuse while the latest suspension event is `pricing_suspended` (read the same table).
4. A migration order of `20270204090000` then `20270205090000`; this migration has no dependency on D4-1 objects, but the QA chain and `tw4_price_verify` do.
5. Its document updates should point to this runbook for the scheduled alert (replacing "alert wiring" as not shipped).

## 10. Activation prerequisites (all need explicit owner authorization)

Apply `20270205090000` to the target database (after `20270204090000`); create the environment values in the owner scope; set `SMS_PRICE_MONITOR=on` and `CRON_SECRET`; register the two cron entries; a real end-to-end test with the owner's destination and a deliberately forged row on a non-production database; configure the dead-man service; decide on the dedicated database role.

## 11. Local proof

- Unit tests: `src/lib/sms/pricing/__tests__/monitor.d42.test.ts` (fake DB and fake transports, no network).
- Docker DB tests: `src/lib/sms/pricing/__tests__/localStack.d42monitor.test.ts` through `scripts/qa/tw4f/run-chain.mjs` (chain with D4-1 and D4-2 migrations, apply / rollback / re-apply fingerprints; monitor running as `service_role`).

## 12. Security audit of migration 20270205090000 (D4-2 follow-up)

Findings, each with a failing-first test in `localStack.d42audit.test.ts` (it failed 8 of 9 against the first version of the migration) and fixed in the migration:

| # | Hole | Fix |
|---|---|---|
| 1 | Writers chose `seq` / `occurred_at` / `recorded_at` of a security event (backdating, choosing a position). | `_tw4pricemon_event_fill` BEFORE INSERT trigger (ENABLE ALWAYS, also under replica mode) forces all three from the database clock and sequence. |
| 2 | An identity sequence is not commit ordered: a late commit with a lower `seq` would be skipped by the monitor's cursor. | `seq` = max + 1 assigned under an advisory lock held to commit (gapless, commit ordered; a rolled-back emit leaves no gap). |
| 3 | No defined writer for events, so every emitter would insert directly. | `_tw4pricemon_emit_event(kind, subject, detail)`: owner-level SECURITY DEFINER, executable by no API role, validates the kind. `service_role` and `authenticated` can neither insert, update, delete nor call it (permission denied, tested). |
| 4 | `recorded_at` of an evidence row was writer supplied; a forged future time kept the watchdog quiet. | The append function refuses a time more than 10 minutes from the database clock (`recorded_at_out_of_range`), and the watchdog and status function use the database's own `inserted_at`. |
| 5 | Guard triggers could be disabled silently; the runbook claimed this was detected. | `tw4_price_monitor_digest()` returns `guards`, `guards_bad`, `guards_ok` (evidence and event guards plus the D4-1 price guards when present); the monitor raises `guard_disabled` and, for a guard seen on an earlier run that vanished, `guard_missing`. |
| 6 | No pricing-side way to see whether monitoring is expected or down. | `tw4_price_monitor_status(max_age)` (section 14). |

Verified without change (tested): table ACLs hold no entry for anon / authenticated / service_role / PUBLIC; each function has an explicit grant list (service_role only for the six readers and the appender; the three helpers are owner-only); every function pins `search_path = pg_catalog, public, pg_temp`; UPDATE / DELETE / TRUNCATE are refused for the owner and in replica mode; the monitor's code uses five allow-listed RPCs and the test records every call across scenarios.

Residual risks (documented, not closable inside the database):
- `service_role` can append evidence rows (that is the monitor's one write). It could append a forged `delivery` row marking a real alert delivered. Mitigations: set `PRICE_MONITOR_CHAIN_KEY` (a holder of only the database role cannot forge a valid row), and compare the head in alerts with the database head.
- `service_role` could flood the evidence table with valid appends (storage / noise); detect via row growth.
- The database owner can drop or replace everything; the owner is the root of trust (D4-1 impersonation design).

### Column definitions, `studio_sms_price_security_events`

| Column | Meaning | Trust |
|---|---|---|
| `seq` | gapless, commit-ordered position | ordering only |
| `kind` | snake_case event kind | the authorization workstream and the monitor read it |
| `subject_user_id` | the user the event is about, nullable | informational |
| `detail` | JSON object, at most 8 kB, no secrets | read it |
| `occurred_at`, `recorded_at` | database clock at insert, forced by the trigger | NEVER a decision input; informational |

The authorization workstream reads only `seq`, `kind`, `subject_user_id` and `detail`. Emit only through `_tw4pricemon_emit_event`. Event kinds consumed: see `EVENT_KINDS` in `types.ts` (adds `credential_revocation_accepted` warning, `credential_recovery_used` critical, `recovery_enrollment_started` critical, `event_emit_failed` critical).

## 13. Undelivered alerts

`npm run qa:price-monitor -- list-undelivered` lists run / watchdog rows that required an alert and have no delivery accepted by a destination (read only). `-- redeliver` re-sends all of them and appends one `delivery` row per attempt; no earlier row is altered. The cron route re-sends the newest five automatically. A pricing-side event-emit failure should be recorded as the event kind `event_emit_failed` (critical alert) so it is visible here as well.

## 14. Monitoring-outage contract with the pricing side

- A monitoring outage must NEVER authorize a financial change, and the emergency freeze must NOT depend on the monitor. The pricing functions decide on their own; the monitor can only tell people.
- `tw4_price_monitor_status(p_max_age_seconds default 2700)` returns `state` = `never` (monitor not activated yet: monitoring not expected), `ok` (a run was recorded within the allowed age by the database clock) or `stale` (down), plus `monitoring_expected`, `last_run_inserted_at`, `age_seconds` and `informational_only: true`. Executable by `service_role` only; pricing SECURITY DEFINER functions (owner) can call it directly. It may be used to REFUSE or warn (for example "do not publish a price while the monitor is stale"), never to allow something that the pricing rules refuse, and never as a reason to lift a freeze.
- Nothing in this directory writes a price table; a test records every database call across all scenarios.

## 15. Alert delivery verification before production

Local proof (no external network): `e2e.d42.test.ts` runs the monitor against a real local HTTP receiver: signature check, wrong-secret rejection, retries (503 then success), outage and re-delivery, heartbeat pings and the dead-man model, and the verification ack.

Owner procedure for the real destinations (needs the owner's authorization, the production-scope environment values and a database that may receive evidence):

1. `npm run qa:price-monitor -- send` sends a SIGNED TEST message (not an alert) to every destination. The webhook receiver must answer `{"ack": hex(hmac_sha256(secret, "ack:" + nonce))[0:32]}`; the command verifies it. The email contains a confirmation token; the heartbeat URL is pinged.
2. Exit 0 = confirmed, 3 = pending out-of-band confirmation, 1 = failed.
3. For email and the dead-man page: read the token from the mailbox, then `npm run qa:price-monitor -- confirm --nonce <nonce> --token <token>` (valid 24 hours, once).
4. Each step is recorded in the evidence chain (`delivery` rows, `source: "verification"`; only a hash of the nonce is stored; they never mark a real alert delivered).
5. Do not activate the cron until step 1-3 passed for every destination, the dead-man service has seen the ping, and a deliberate non-production forged-row test produced an alert.

## 16. Guard inventory (R3-3)

`tw4_price_monitor_digest()` checks an EXPECTED list of guard triggers, each by table, trigger name, function and mode (`tgenabled = 'A'`, ENABLE ALWAYS): this migration's five; D4-1's price-list (activation, truncate), change-request and approver-registry guards; and the authorization migration's per-table guard and truncate triggers for config, credentials, challenges, credential changes, audit and emit acks, plus the approver `_emit` trigger. Result keys: `guards`, `guards_missing`, `guards_disabled`, `guards_wrong_function`, `expected_but_absent`, `groups_active`, `guards_ok` (false for any of them), and `guards_bad` (disabled or wrong function).

A group is expected when any of its tables exists (`own` always). A group with only some of its tables present is `expected_but_absent`, never silently skipped. The monitor reports immediately, with no earlier run needed: `guard_missing`, `guard_disabled` (disabled, merely enabled / replica-only, or a different function), `pricing_tables_partial` (all critical), and a digest without any guard inventory as `digest_unavailable` (critical). When a new pricing guard is added by a later migration, add it to the `exp` list in the digest function, in the same migration.
