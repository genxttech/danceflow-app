# TW-4F scheduled SMS usage reconciliation and financial integrity (design, 2026-10-20)

Owner handoff "DanceFlow TW-4F — Scheduled SMS Reconciliation & Financial Integrity" (2026-10-20). This slice connects the pieces that already exist (20261201 usage financials, 20261203 inbound recording, 20261204 sender readiness) into one scheduled, leased, observable reconciliation. It does **not** create a second ledger: every money movement still goes through the existing functions and `studio_sms_credit_ledger`.

It is local and synthetic only. No hosted SQL, no live scheduler, no real Twilio call, no SMS. Migration `20261205090000_twilio_usage_reconciliation.sql` (after `20261204090000`), rollback in `rollback/`. Operations are in `TW-4F_Usage_Reconciliation_Runbook.md`.

## 1. Outcome of every outbound text

Each billed attempt ends as exactly one of four outcomes. A timeout is never evidence that Twilio did not receive a message.

| Situation | Evidence | Outcome |
|---|---|---|
| Still `reserved` (no dispatch marker) 10+ min after begin, incl. a transient `credentials_unavailable` never retried | Definitive no-dispatch: the marker is written before any provider call, and the marker and the release are exclusive under the attempt row lock | **released** (`tw4_usage_release_stale`, bounded, run-fenced) |
| `submitting` / `unknown` with no SID (crash, timeout, 5xx) | None. The message may exist | **retained**. Escalated after 15 min (`escalated_at`). Never released by a timer. A late SID or signed callback still binds. Closed only by the **written admin resolution** (`tw4_usage_resolve`) |
| `submitted`, final status in the Message resource, identity proven | Verified evidence | **settled** (charge, or release on `failed`/`canceled`) |
| `submitted`, status pending (`queued`/`sending`/`sent` < 72 h) | Not final yet | **retained**, read again after 10 min |
| `submitted`, still pending after 7 days | Ambiguous | **review**, then admin |
| Evidence identity/time mismatch, MMS, foreign currency, implausible segments or price | Not provably this text | **review**, then admin |
| Evidence unreadable: transient (timeout, 5xx, 429, credentials) | Temporary absence | **retained** with backoff (5 min doubling, at most 6 h). **review** after 12 failures **and** 24 h |
| Evidence unreadable: definite (404 on the attempt's own subaccount, mismatch) | The provider says it is not ours/there | **review** at once |

## 2. Evidence validation (`tw4_usage_settle`, replaced)

The checks below run before the 20261201 status table. An identity mismatch goes to review even when the status is `failed`.

- SID and account equal the attempt's. Otherwise `42501` and nothing is written; the reconciler records this as a definite failure, which sends the attempt to review.
- The attempt's frozen account is (or was) **its own legal business's** subaccount (`_tw4ur_account_of`). `tw4_usage_due` never lists any other, and `tw4_usage_escalate` reviews it.
- Direction `outbound-api`, Messaging Service = the attempt's, `to` = the log's destination, `from` = the attempt's `sender_e164`. A null `from` is accepted only while the status is pending.
- `date_created` (ISO, converted from Twilio's RFC 2822 by the seam) inside [marker − 5 min, SID binding + 5 min] and not in the future.
- The price is cost evidence only. Above 5× the expected provider cost per segment it goes to review. A null price (not finalized) never blocks settlement.
- The existing rules still hold: segments 1..10 and ≤ estimate + 2, `failed`/`canceled` released, MMS to review, `sent` charged after 72 h.

`tw4_usage_evidence_failed(attempt, code, definite)` records read failures (count, code, next retry). It never releases or charges. `tw4_usage_due` honours the retry time.

## 3. Runs, overlap and checkpoints

- `studio_sms_reconcile_runs`: one `running` row per job (`usage_reconcile`; `sender_reverify` reserved for the 24 h re-verify). `tw4_reconcile_run_begin` closes an expired lease as failed and takes a new one. An overlapping call gets `busy`. A finished run is final.
- Every write only a run makes (stale release, escalation, inbound recovery, checkpoint) is **fenced** by a live lease (`TW023`, not `40001`, because PostgREST retries those). Settlement itself is idempotent per attempt, so a concurrent worker that bypasses the lease still charges once (tested).
- The scheduled run (`runScheduledUsageReconciliation`): lease 300 s, budget 45 s, at most 200 releases / 100 evidence reads / 50 subaccounts × 10 pages per run. It records counts in the run row. Errors are fixed strings, never provider or database text.

## 4. Inbound recovery

- Targets: every `active` / `suspended` subaccount of a business with a linked location (`tw4_inbound_scan_targets`), least recently scanned first.
- Window: [checkpoint − 1 h overlap, min(now − 30 min grace, checkpoint + 24 h)]. The grace period lets a late webhook, which knows `OptOutType`, win. The provider list is read with the subaccount's own credentials (`DateSent>=` / `DateSent<=` with a day of margin, next pages only under the same account's Messages path) and filtered to inbound inside the window.
- `tw4_inbound_recover(run, account, evidence)` routes by `tw4_inbound_studio_for` (the number decides, on the signing account), the same as the webhook. It then records through **`tw4_inbound_record(..., 'reconciler')`**, so the $10 negative-balance ceiling, pilot no-debt, the recurring set-aside and one-month protection, compliance exclusions and month attribution by received time are exactly the webhook's rules. A text the webhook already recorded is a replay (`already_recorded`), never a second charge or a reclassification.
- **Fail-safe classification.** The app classifies the body in memory. The body is never sent to the database, stored or logged. A fallback keyword is compliance. A missing or empty body, or a single short word (possibly a custom Advanced Opt-Out keyword), is uncertain. Missing segments, media or time count as incomplete. Anything not provably ordinary is recorded as **compliance (never charged)**, and the basis is kept in `studio_sms_inbound_recoveries`.
- **Consent fails closed (merge-readiness correction, see §10).** A recovered opt-out applies the canonical STOP; a recovered START is never applied. Every recovered keyword is listed in the panel.
- An unroutable text (no sender row for that number) is counted, never attributed.
- The checkpoint (`tw4_inbound_scan_advance`) moves forward only after a complete scan of the window with no errors. A failed list, a failed record or a truncated listing leaves it alone, and the window is re-read (idempotent per SID).

## 5. History and monitoring

- `studio_sms_usage_attempt_events` is an append-only trigger log of every attempt state change, evidence write, failure count, escalation, SID binding and callback rank. It holds money facts only, never a body or a client number.
- `tw4_usage_reconcile_overview(actor)` (platform admin) shows: the switch; the last completed run and a **stale** alert (switch on, no completed run for 30 min); the running lease and last 10 runs with counts; open attempts by state; stale reserved; evidence retrying; escalated; open reserved cents; usage and inbound reconciliation gaps; the exceptions list; inbound checkpoints with lag, unscanned accounts, recoveries by basis and unseen keywords.
- The platform SMS page shows this as "Usage reconciliation", next to the prepaid credit panel. Each exception has the written resolution form (`tw4_usage_resolve`: platform admin from the session, 10–300 character reason, 15-minute guard, audited in `studio_sms_onboarding_audit`, rate limited).

## 6. Scheduler

`/api/cron/sms-usage-reconcile` (GET/POST). It returns 404 unless `SMS_USAGE_RECONCILER=on`, then requires `CRON_SECRET`. Evidence and inbound reads only happen where `usageEvidenceProviderFromEnv` allows them: production build + deployment + `SMS_USAGE_EVIDENCE_READS=on`, or local fake mode. Without them the run still releases never-sent reservations and escalates, and reads nothing, so a misconfiguration can never be counted as evidence failures. The route is **not registered** in `vercel.json` (a test pins this); the suggested schedule is every 5 minutes.

## 7. Migration and rollback

The migration is additive: three tables, one history table, five nullable or defaulted attempt columns, one partial index, and replaced `tw4_usage_settle` / `tw4_usage_due`. Its preconditions check that those two are still the 20261201 bodies. It is safe on existing PROD data (no attempts exist there; billed texting is off).

The rollback restores the 20261201 bodies and drops everything new. It **refuses** once any run, checkpoint, recovery, history row or attempt reconciliation evidence exists. From then on the stance is forward-fix only. Apply order on hosted: 20261201 → 20261202 → 20261202140000/150000 → 20261203 → 20261204 → **20261205**, SQL before the app enables the route.

## 8. Not covered / limitations

- Recovered keyword consent effects are not applied automatically (see §4); they are surfaced for a person.
- The provider list is filtered by UTC day. Very high inbound volume on one subaccount (> 10 pages × 200 per day window) stalls that checkpoint until an operator raises `maxPages`; the panel shows the lag.
- A subaccount closed while attempts are open has its evidence read with its own (refused) credentials; those attempts go to review after the transient bound (no parent fallback).
- Unrecognised inbound numbers are not attributed to any business.

## 9. Independent Opus review (2026-10-20): what changed

The review found no P0. Everything below is authoritative where it differs from §2–§8.

- **P1, inbound recovery could stall and starve other businesses.** Each location number is now listed separately (`To=`, from `tw4_inbound_scan_targets.numbers`), with second-precision `DateSent>=` / `DateSent<=` bounds and a page deadline. Texts the webhook already recorded are filtered with one call per 500 (`tw4_inbound_unrecorded`). The rest are processed oldest first, and the checkpoint advances to just before the first text that could not be processed (budget or a transient error), not only after a complete window. A listing too long for the 24 h window is retried once for 1 h. Still too long counts as `stalled`, and the panel and run summary report it. Targets are shuffled, and each subaccount gets at most 15 s per run.
- **P2, review of a text sent after an admin release violated `closed_at`.** `tw4_usage_evidence_failed` and `tw4_usage_escalate` now clear `closed_at` when they review (tested).
- **P2, a permanently refused text blocked its checkpoint.**
  - `tw4_inbound_recover` returns `already_recorded` for any recorded SID before routing, so a number that moved between locations does not matter.
  - A 22023 / 42501 refusal is kept in `studio_sms_inbound_unresolved` (`tw4_inbound_note_unresolved`) and the scan continues.
  - Unroutable texts are kept there too.
  - Nothing is charged for either.
- **P2, keyword-like bodies were charged.**
  - Punctuation and emoji are ignored, so "Stop!!", "STOP 🛑" and "stop all" are compliance.
  - These are uncertain, which means never charged: three words or fewer, any keyword word, or a sender number the webhook would not recognize.
- **P2, the identity checks are only proven against the fake.** A 404 within 15 min of the send is transient, not definite. **Before live SMS**, capture real DEV-subaccount Message JSON for a Messaging Service + `From` send in the `queued`, `delivered` and `failed` states, add it as fixtures, and confirm `direction`, `messaging_service_sid` and `from`. Until then a field difference sends texts to review (reservation kept, admin resolves). It never charges or releases wrongly.
- **P3, fixed:**
  - stale release and escalation lock business by business;
  - the lease is 120 s (twice the route's maxDuration);
  - a repeated read that learns nothing adds no history row;
  - the rollback locks its tables before checking for evidence;
  - every recovered keyword is listed, with whether the webhook saw it.
- **P3, accepted:**
  - the budget is checked between items (one provider call may overrun it by up to 10 s);
  - the SQL and the app must ship together. SQL first only sends texts to review, which is safe.

## 10. Merge-readiness correction (2026-10-20): recovered opt-outs fail closed

The review found that a STOP the webhook missed left the number sendable on DanceFlow's side until a person acted. Twilio Advanced Opt-Out still blocked it at the carrier.

- `tw4_inbound_recover` now applies the canonical `record_sms_inbound_opt_event(studio, phone, 'stop')` in the same transaction as the recovery, for a body the app classifies as an opt-out keyword. This is exactly what the webhook does.
  - It covers the exact fallback list, the same words with punctuation or emoji ("Stop!!", "STOP 🛑"), and short texts made only of keywords ("stop all"). An opt-out wins over any other keyword in the text.
  - The resulting studio+phone `twilio_inbound_stop` block is honoured by every send path (`resolveEffectiveSmsConsent` → `blocked_by_text_stop`: notifications dispatch and manual send). Billed sends go through those paths.
  - Twilio Advanced Opt-Out is unchanged.
- The texter's number is sent to the database **only** for an opt-out, and only into the consent tables, as the webhook does. Recovery rows, the panel and run summaries still hold no number (tested).
- A recovered **START is never applied**, so consent is never restored by recovery. The person texts START again.
- An opt-out with no usable sender number is recorded with `consent_applied = false` and listed on the panel for a person.
- **Ordering (final merge gate), by Twilio's own message times.** Recovery never orders by when it runs, and never by DanceFlow's database clock. For each recovered STOP the reconciler reads the same texter's later messages to the same number from the provider (read-only, the subaccount's credentials, `To` + `From` filters, at most 3 pages). The latest later STOP/START keyword decides. This also covers a START that changed nothing in DanceFlow and left no history row: the common case, since a missed STOP means DanceFlow never blocked the number. The outcome is stored in `consent_note`, constrained to agree with `consent_applied`, and shown on the panel:

| Situation | Result |
|---|---|
| A later START from that texter in the provider's record (strict START/YES/UNSTOP, as the webhook fallback honours it), **or** in DanceFlow's own record of a contact-originated START (an `inbound_start` consent-history row or an inbound `start` message logged by the webhook, which also catches custom Advanced Opt-Out opt-in keywords) more than 2 min after the STOP's own time | **not applied**: the person's newer choice stands (`not_applied_newer_start`) |
| No later keyword, or a later STOP | **applied** (`applied`) |
| Unproven: the lookup failed or was incomplete, there was no receiving number, a keyword in the same second or a tie, a DanceFlow START within ±2 min, or the STOP's own time missing, implausible (future, older than 400 days) or not ISO | **applied, fails closed**, listed (`applied_order_unverified`) |
| No usable sender number | not applied, listed (`not_applied_no_number`) |

  - Staff and public opt-ins are **not** consulted. Under TW-2 only the contact can resubscribe, and a web form never reverses an opt-out. Had the webhook processed the STOP, those opt-ins would have been refused, so recovery gives the same answer.
  - Opt-outs are read loosely (fail closed) and opt-ins strictly. "Yes!" or "start please" is not a later START.
  - The lookup reads up to the moment it runs, not the run's start.
  - The run summary counts `inbound_opt_outs_applied` and `inbound_opt_outs_unverified` separately.
  - Remaining, fails closed: a custom opt-in keyword that changed nothing in DanceFlow and was not logged as a contact message, because the texter had no client or contact record. The STOP is then applied and listed as `applied`, and the person texts START again.
  - Remaining (rare): DanceFlow's own START signal carries the time the webhook processed it. A START sent before the STOP but delivered more than 2 minutes after it would suppress the STOP. Twilio's own lookup orders by message time, and the panel lists every keyword recovery.
  - The asymmetry is deliberate. Wrongly blocking costs one START text from the person. Wrongly sending after a STOP is a compliance violation. Where the order cannot be proven, the STOP wins and a person is told.
- **The webhook records usage only after a successful consent change.** If its STOP/START update fails, nothing is recorded, so the reconciler recovers the text after the grace period and applies the STOP. A refused opt-out recovery is kept as unresolved evidence with code `<errcode>_stop`.
- A text that only mentions an opt-out word ("please stop texting") is not applied, because the webhook would not apply it either. It is compliance (never charged) and listed on the panel as a possible opt-out.
- The consent history row a recovery writes looks like a webhook STOP. Its time is the recovery's, not the message's: the canonical function is unchanged. The recovery row in `studio_sms_inbound_recoveries` carries the message's time and the link.
- Not covered: a single-word opt-out configured only in Advanced Opt-Out and not in the fallback list (e.g. a non-English keyword). It is recorded as uncertain, so never charged, but it is not applied as a STOP. Twilio still blocks the number at the carrier, and a DanceFlow send to it is refused by Twilio as a definite refusal, which releases the reservation with no charge.
