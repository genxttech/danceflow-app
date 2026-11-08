# TW-4F SMS usage financial integration (design v2, 2026-10-20)

Owner direction 2026-10-20: atomic pre-send reservations and evidence-based post-send reconciliation for outgoing SMS, mandatory before real SMS activation (gate D5 of `TW-4F-3b_Design.md` §16). Local/synthetic only: no hosted SQL, no flag enabled, no scheduler, no real Twilio call, no real message. v2 incorporates the independent Opus architecture review (§8).

## 1. Which sends are chargeable

| Studio | Path | Rule |
|---|---|---|
| Linked to a verified legal business (`studio_sms_entity_studios`) | **billed** | Only through the business's own Twilio subaccount and its own approved sender, after a reservation. |
| Not linked (legacy per-studio registration under the parent account, TW-1..3) | legacy | Unchanged; no prepaid credit applies. |

The decision lives in ONE place on the app side: `resolveStudioSmsSender`, the only resolver for outbound texts, returns either a legacy sender or "billed". The legacy (parent-account) sender is never returned for a linked studio, so no caller can bypass billing.
- Mode function `tw4_usage_studio_mode` installed: its answer (`billed`/`legacy`); anything else refuses.
- Not installed (`PGRST202`/`42883`): the link table is read. Relation missing (`42P01`/`PGRST205`, i.e. TW-4F-3a not applied) means legacy; a linked studio is refused; any other error refuses.
- `tw4_usage_begin` re-checks the link inside its transaction.

The ConfiDance pilot business is linked, so its texts are billed from credit like any business; the $150 pilot ceiling is never used for usage.

## 2. Lifecycle of one billed message

The attempt is anchored on its SOURCE, not on a log row: `(source_kind, source_id)` is unique, where the source is the outbound delivery (`delivery`, its id) or a manual send (`manual`, a client-generated idempotency key). `tw4_usage_begin` creates the `sms_message_logs` row and the attempt together; a retry of the same source returns the existing attempt (`replay`) and never a second send, reservation or log.

```
begin ─► reserved ─(dispatch marker)─► submitting ─(SID)──────────► submitted ─(final evidence, charge table)─► settled  (release + usage_charge)
            │                             │ definite refusal                 ├─ failed/canceled ─────────────────────────► released (no charge)
            │ no marker > 10 min          │──► released                     └─ MM sid / media / segments implausible ──► review (admin)
            └─► released (never sent)     └ timeout/5xx/crash ─► unknown ─(signed callback binds SID)─► submitted
                                                                    └ else: kept reserved; admin resolves after 15 min (never automatic)
```

- **`tw4_usage_begin(source_kind, source_id, studio, client, phone, body, message_type, related, sent_by)`**, one transaction, entity row then account lock:
  database kill switch on (`tw4_usage_set_switch`, default OFF, audited) else `TW018`; studio linked; NANP destination only (`+1` and 10 digits) else `22023`; an approved billed sender for the studio (`studio_sms_billed_senders`, platform-admin managed: the subaccount's own Messaging Service, which must belong to the business's ACTIVE subaccount) else `TW015`; recurring service not `suspended` (`TW016`); active `sms_usage` price (per segment) else `TW008`;
  segments computed IN THE DATABASE from the stored body (GSM-7 with extension characters counted twice, else UCS-2 in UTF-16 units; 152/153/67 per part), 1..10 else `22023`;
  amount = segments x price; no hold, balance >= 0, available >= amount (`TW007`); `_tw4ml_require_room` (monthly limit, default $0, platform ceiling, `TW012`).
  Creates the log row, the reservation `sms:<attempt>` (kind `sms_usage`, credit only) with its `reserve` entry, and the attempt in `reserved`. Returns the attempt, the subaccount SID, the Messaging Service, the body to send and the amount.
- **Dispatch marker** `tw4_usage_dispatching(attempt)`: `reserved` -> `submitting`, written BEFORE the provider call; if it fails the app does not send. An attempt still `reserved` after 10 minutes was definitely never sent and is released by the reconciler.
- **Provider submission**: `POST /Accounts/{subaccount}/Messages.json` with parent credentials (no per-send token read), the subaccount's Messaging Service, the exact stored body, and `StatusCallback=.../status?secret=...&attempt=<attempt>`.
- **`tw4_usage_submitted(attempt, sid)`**: `submitting|unknown|released(admin, no SID)` -> `submitted`, also writes the log's `provider_message_id` in the same transaction; the SID is unique; the same SID again is a replay. A SID arriving after an admin released the attempt is still recorded and later charged without a reservation (the message really went out).
- **`tw4_usage_rejected(attempt, code)`**: from `submitting|unknown` while no SID is bound, only for a DEFINITE refusal (HTTP 4xx with a parsed Twilio error body, including 401/429; not 408 or bodiless 4xx): released.
- **`tw4_usage_uncertain(attempt, code)`**: everything else -> `unknown`; the reservation stays. The manual route answers "outcome unknown; do not resend" (a resend with the same idempotency key is a replay anyway).
- **Delivery callbacks** (`tw4_usage_record_callback(attempt, sid, signer account, status, code)`), after the route's signature, tenant and replay checks: the signer must be the attempt's subaccount; the callback binds the SID when the attempt has none (`submitting|unknown`), otherwise the SID must match; status is recorded monotonically. Callbacks never move money.
- **Evidence** is the provider's Message resource (`GET /Accounts/{subaccount}/Messages/{sid}.json`): `status`, `num_segments`, `num_media`, `price`, `price_unit`. **`tw4_usage_settle(attempt, evidence)`**, charge table on STATUS (price is provider-cost evidence only, never a gate):

| Evidence status | Result |
|---|---|
| `delivered`, `undelivered`, `read` | charge `num_segments` x frozen price |
| `sent` older than 72 h after submission | charge (many carriers never return a receipt) |
| `failed`, `canceled` | release, no charge (any provider fee is DanceFlow's cost) |
| `accepted`, `queued`, `sending`, `scheduled`, `sent` < 72 h | pending, retry later |
| anything else; `MM` SID; `num_media` > 0; `num_segments` outside 1..10 or above estimate + 2 | `review` (reservation kept, admin) |

  Settlement releases the reservation and posts one `usage_charge` (`usage:sms:<attempt>`, linked to the reservation) in one transaction; overage over the estimate is posted even if the balance goes negative. The provider's price is stored on the attempt as exact micro-dollars (numeric, absolute value).
- **Admin resolution** `tw4_usage_resolve(attempt, actor, released|charged, segments, reason)`: platform admin, written reason, audited, only for `unknown|submitting|review` attempts older than 15 minutes (beyond any in-flight request). The generic `tw4_credit_resolve_reservation` refuses `sms:` reservations.
- Attempts open longer than 7 days are listed as overdue in the admin overview.

## 3. Monthly limits and month boundaries

`_tw4ml_month_parts` counts open `sms:` reservations in the month they were made, and attributes a `usage_charge` linked to a reservation to the reservation's month. A message reserved on the 31st and settled on the 1st counts once, in the month it was sent. The limit is checked once, at begin, against the estimate; overage can exceed it by at most the difference.

## 4. Switches (all off)

1. Database kill switch (`tw4_usage_set_switch`, platform admin, audited; default off): `begin` refuses while off, in any deployment.
2. `SMS_USAGE_BILLING=on`: the app attempts billed sends at all (off: linked studios' texts are refused).
3. Real provider calls: production build + production deployment + `SMS_BILLED_REAL_SEND=on` (sending) / `SMS_USAGE_EVIDENCE_READS=on` (reconciler GETs), plus the platform SMS approval. Separate from `TW4_ISV_REAL_CALLS` (registration writes).
4. The reconciler is a library entry point; nothing schedules it. A scheduled reconciler is an ACTIVATION GATE. Since 20261205090000 it has a leased, authenticated route (`/api/cron/sms-usage-reconcile`, not registered) and identity-checked settlement: see `TW-4F_Usage_Reconciliation_Design.md`.

## 5. Not covered (owner decisions / follow-ups)

- Inbound messages, TwiML auto-replies (HELP/STOP confirmations) and carrier pass-through fees are billed by Twilio to the subaccount but not reserved here: who absorbs them is an owner decision; per-number rate limiting of auto-replies is a follow-up.
- MMS converter and link shortening must be OFF on billed Messaging Services (settlement routes MMS evidence to review).
- International destinations are refused (flat per-segment price).
- `usage_refund` rows are attributed by their own date (refunds are admin actions; follow-up: attribute to the original month).
- A subaccount must not be closed while it has open attempts (evidence becomes unreadable).

## 6. Migration and rollback

`20261201090000_twilio_sms_usage_financials.sql` (+ rollback). Requires `20261128090000`; operationally also `20261129090000` (`tw4_webhook_account`, subaccount webhooks) before any billed callback can verify. Order: `...28 -> ...29 -> ...30 -> 20261201`.
The rollback refuses once any attempt, billed sender or switch row exists. Once attempts exist the stance is forward-fix only. Drain procedure before any app rollback: switch the database kill switch off, settle or admin-resolve every open attempt, then roll the app back (an older app would send linked studios through the parent account, so `SMS_USAGE_BILLING` must stay off and linked studios must not have a legacy registration).

## 7. Tests (local, synthetic)

Real-schema suite with a fake provider: lifecycle, replays and duplicate sources, concurrent begins against funds and limits, callbacks (duplicate, wrong subaccount, parent-signed, early binding), evidence table incl. 72 h rule and review cases, admin resolution timing, late SID after release, month boundary attribution, holds, suspension, kill switch, cross-tenant access, pilot business, rollback. Unit tests for the segment estimator (parity with SQL), the provider error classification, the routes and the dispatcher.

## 8. Opus architecture review (2026-10-20): changes made in v2

P0 stuck reservations (no-receipt `sent`, null price) -> status charge table, 72 h rule, overdue listing, scheduled reconciler as activation gate. P1: attempts anchored on the source with begin creating the log; dispatch marker; SID bound by the signed attempt-id callback (no body-matching lookup); generic resolver refuses `sms:`; exact mode fallback cases; billed sender identity owned by the database and a resolver that never returns a legacy sender for a linked studio; failed/canceled always released. P2: micro-dollar provider price; MMS/segment review; segments computed in SQL; NANP only; log SID written in the submitted transaction; late SID after admin release; 401/429 with body definite; DB kill switch and billed-sender approval in begin; drain procedure. Accepted/deferred: uncovered inbound/auto-reply costs (owner), refund attribution, per-send month query cost (indexed).

## 9. Opus implementation review (2026-10-20) and what changed

No double charge, lost charge or money-moving bypass was found. Fixed:
- **Deployment order (P1).** Where TW-4F-3a is applied, its link table is not readable by the service role, so the app's fallback for a missing mode function cannot tell billed from legacy studios and fails closed for every studio. Rule: **apply `20261201090000` before deploying this application to any environment that has `20261121090000`** (PROD has neither today; DEV must get the SQL first). Where 3a is absent the app stays on the legacy path.
- A text that went out after an admin released it could not move to `review` (constraint): review reopens it; an admin can now close any sent-but-unbillable attempt with `not_charged` (reservation released, nothing charged).
- `failed`/`canceled` evidence is released before any review check (multimedia or foreign-priced failures are never charged).
- Reconciler queue: a text whose evidence cannot be read or settled is stamped (`tw4_usage_touch`) and never-read texts come first, so failing rows cannot block the rest.
- A callback after settlement is acknowledged and changes nothing (it used to be refused as if the signer were wrong).
- A replay of an attempt that never reached its dispatch marker proceeds through the (exclusive) marker with the STORED body and number, so a brief failure between begin and the marker no longer loses the text; the dispatcher keeps such a delivery queued (`sms_not_dispatched`, definitely unsent).
- The admin 15-minute guard counts from the dispatch marker; the attempt guard also freezes the sender, price and creation time; the direct usage debit refuses the `sms:` key namespace; `sms_outcome_unknown` is shown to staff as "delivery uncertain".

Accepted: the kill-switch audit row is attributed to the first linked studio (none when no studio is linked); the legacy status route can still overwrite a billed text's log status out of order (attempt status is ranked); the reconciliation-gap query is not indexed for volume.
