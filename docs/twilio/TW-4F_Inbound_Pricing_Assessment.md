# TW-4F inbound SMS pricing: ledger impact and pricing options (assessment, 2026-10-20)

Owner direction 2026-10-20: recover ordinary inbound SMS costs from studios, but not at the outbound retail rate. Planning only: nothing here is published, applied or enabled. Prices need owner approval (`tw4_price_set`).

## 1. Verified provider costs (Twilio US long code / 10DLC)

Read from Twilio's US SMS pricing page on 2026-10-20 ("pricing current as of October 2026"). Re-verify against the Twilio invoice before publishing.

| Item | Outbound | Inbound |
|---|---|---|
| Twilio base, per segment | $0.0083 | $0.0083 |
| Carrier fee: AT&T | $0.0035 | $0.0035 (page lists it; verify on invoice) |
| Carrier fee: T-Mobile (raised Jan 29, 2026 per Twilio's notice) | $0.0045 | $0.0025 |
| Carrier fee: Verizon | $0.0050 | none listed (the row shows only outbound SMS and MMS values) |
| Carrier fee: US Cellular | $0.0050 | $0.0025 |
| Carrier fee: other carriers | $0.0042 | not shown |
| Failed-message processing | $0.0010 per failed message | n/a |

Blended per segment (assumed carrier mix Verizon 35% / T-Mobile 37% / AT&T 28%; assumption, not measured):
- **Outbound ≈ $0.0127** (range $0.0118 AT&T to $0.0133 Verizon/US Cellular).
- **Inbound ≈ $0.0102** (range $0.0083 Verizon to $0.0118 AT&T).
- Card processing on top-ups (Stripe, about 2.9% + $0.30; verify on the account) adds about 3.5% on a $50 pack: outbound ≈ $0.0131, inbound ≈ $0.0106, worst-case inbound ≈ $0.0122.

The provider cost difference between directions is only the carrier fee (about $0.0025 per segment). A "lower inbound rate" therefore has a thin floor.

## 2. Does this require ledger or reservation changes? Yes (ledger); outbound reservations stay as they are

| Area | Change needed | Why |
|---|---|---|
| Price list | Add a separate kind (`sms_inbound`) to the price list's kind check (additive) | Separate published inbound rate; `sms_usage` stays the outbound rate. |
| Charging path | A new **post-paid** path, idempotent per inbound MessageSid (`usage:in:<sid>`), that never refuses | An inbound text cannot be refused. The existing direct debit (`tw4_credit_debit_usage`) fails closed on funds and limits, so it must not be used. Reservations do not apply. |
| Separate accounting | Inbound usage table (sid, business, location, received time, segments, classification, charge, provider cost evidence) and the month's spending split into outbound vs inbound | Owner item 1, studio statements, reconciliation. |
| Monthly limit | Decision (below) | Inbound cannot be blocked, so the limit cannot bound it. |
| Month attribution | By the message's own time (`date_created` / receipt) in the business timezone, not by processing time | Delayed evidence (owner item 3). |
| Compliance traffic | STOP/START/HELP inbound and their confirmation replies are recorded and classified `compliance`, never blocked | Owner item 5. |
| Automated replies | Non-compliance automated replies go through the existing billed OUTBOUND path (reservation, fail closed); compliance replies are recorded post-paid at the outbound rate (or absorbed, decision) | Owner item 4. Today TwiML replies are sent by Twilio and are not reserved. |
| Reconciliation | Inbound evidence from the provider's Message resource (`num_segments`, `price`); a lost webhook is recovered by listing the subaccount's inbound messages; Twilio-generated messages with no attempt (Advanced Opt-Out confirmations) are discovered and classified; gap checks extended | Same evidence rules as outbound; overlaps the scheduled-reconciler work (coordinate). |
| Outbound reservation logic | **No change** to begin, marker, settle or callbacks | Inbound never reserves; outbound pricing stays per segment. |

### Financial-integrity implications (decide before implementation)
1. **Post-paid exposure.** Inbound charges post even at a zero or negative balance. The existing controls then block the studio's outbound texting until it funds (fail closed). DanceFlow carries the risk of a negative balance that is never topped up. Mitigations: an inbound rate limit per sender number, a daily inbound alert per business, and absorbing traffic from unrouted or unknown senders.
2. **Monthly limit semantics.** Recommended: inbound charges **count toward** the month's spending but are never refused. A burst of inbound replies can then use up the month and pause outbound sends, without dropping any inbound message. The alternative (inbound outside the limit) leaves inbound spending unbounded by any owner control.
3. **No double charge.** The webhook and the reconciler must use the same idempotency key (MessageSid). A charge is never re-derived after settlement.
4. **Flood cost today.** The inbound route currently auto-replies "Thanks for your message…" to **every** ordinary inbound text (`inbound/route.ts`, the final reply). Each third-party text therefore costs an inbound **and** an outbound segment, with no reservation. Recommendation: remove the generic reply, or send it at most once per number per day through the billed path, silent when unfunded.
5. **Pilot business.** Inbound for ConfiDance is charged to credit like any business; never the $150 pilot ceiling.

## 3. Lower inbound rate vs included allowance

| | A. Lower published inbound rate | B. Included inbound allowance + overage |
|---|---|---|
| What the studio sees | One per-segment inbound price, lower than outbound | N free inbound segments a month, then a per-segment price |
| Cost recovery | Linear, per use; every segment recovered | Allowance cost must be recovered elsewhere (monthly fee) or absorbed; unused allowance is margin, overuse is charged |
| Ledger / state | Post-paid charge per message only | Plus a per-business, per-month allowance counter in the business timezone, consumed under the account lock |
| Month boundaries, delayed usage | Simple: attribute by message time | Late inbound for a closed month must consume THAT month's allowance; corrections can cross months |
| Concurrency / idempotency | Idempotent per SID | Per SID AND exactly-once allowance consumption; refunds must restore allowance |
| Compliance traffic | Classify and absorb or charge | Same, plus whether it consumes allowance |
| Disclosure | Simple | Needs "included per month, does not roll over" wording |
| Risk | Low | Moderate (new state, month-boundary corrections) |

### Recommendation
**Option A, the lower published inbound rate, no allowance at launch.** It recovers ordinary inbound costs linearly, needs no new per-month state, and keeps month-boundary and delayed-usage handling identical to outbound. An allowance can be added later as a promotion once real inbound volumes are known.

Proposed rates for owner approval (per segment, carrier fees included; not published):

| | Outbound | Inbound |
|---|---|---|
| Blended cost incl. card fees | ≈ $0.0131 | ≈ $0.0106 |
| **Proposed retail** | **$0.017** (≈ 30% over blended) | **$0.013** (≈ 23% over blended; ≈ 6% over worst-case AT&T) |
| Lower bound to avoid AT&T-inbound losses | | $0.013 |
| Higher-margin alternative | $0.018 | $0.014 (≈ 32% / 15%) |

Below **$0.013**, inbound loses money on AT&T-terminated traffic once card fees are counted. If an allowance is still wanted, a modest one is cheap: 100 inbound segments a month costs DanceFlow about $1.02 (worst case $1.18). It would have to be covered by the monthly service fee.

Owner decisions:
1. Inbound rate ($0.013 proposed) and the outbound rate.
2. Compliance traffic (STOP/START/HELP and their confirmations): charge it, or absorb it. Recommendation: absorb, since it is tiny and avoids charging a studio for a client opting out. It is tracked either way.
3. The generic auto-reply: remove it, or limit and bill it.
4. The monthly-limit semantics for inbound (count but never refuse is recommended).

## 4. Implementation outline (after approval; separate PR, coordinated with the sender-provisioning and reconciliation work)

1. Migration: `sms_inbound` price kind; inbound usage table; post-paid record function (idempotent per SID, entity and studio from the verified receiving sender, segments from `NumSegments`, classification); month parts split; gap checks.
2. Inbound route: record after the existing signature, tenant and replay checks; never blocks or changes the STOP/START/HELP flow; a recording failure never drops the message (logged and reconciled later).
3. Automated replies per decision 3; compliance replies recorded post-paid.
4. Reconciler (in the scheduled-reconciler slice): inbound evidence and lost-webhook recovery.
5. Real-schema tests: duplicates, multi-segment, month boundaries in the business timezone, zero and negative balances, holds, suspension, cross-tenant senders, pilot, floods.

## 5. Coordination (2026-10-20)

- The TW-4F provider/panel session (PR 244, migration `20261130`) confirmed that it does not touch the billed-sender callers, any reconciler, the price kinds, the credit ledger, `_tw4ml_month_parts`, the reconciliation-gap functions or the inbound route, and that it has no sender-provisioning or reconciliation slice planned.
- The inbound route must keep its PR 242 behaviors: repeated form keys refused before verification; account-aware signature verification before any effect; the `webhookMayActForStudio` tenant check; the replay ledger recorded before effects and failing open (a duplicate gets empty TwiML). Any inbound charge hangs off the FIRST receipt only; STOP/START/HELP stay free and never blocked. Tests: `src/app/api/sms/twilio/__tests__/subaccountWebhooks.tw4f.test.ts`.
- No other session currently owns billed-sender provisioning or the scheduled reconciler; the owner should name where that work runs before the inbound slice hands lost-webhook recovery to it.
- **Owner scope decision (2026-10-20):** billed-sender provisioning and the scheduled reconciler are a separate later slice. The inbound slice is limited to recording: price kind, inbound usage table, the post-paid recording function, the month split, its own gap check and the inbound-route changes. Lost-webhook recovery (listing a subaccount's inbound messages, Twilio-generated replies without an attempt) is handed to the reconciler slice, which will call the inbound recording function.

## 6. Owner decisions of 2026-10-20 (authoritative) and the recording slice

- **D1 (modified to option C).** Ordinary inbound texts are charged after the fact at the published inbound per-segment price (none published; $0.013 is a draft), only down to a configurable negative-balance ceiling per legal business ($10.00 to start; `tw4_inbound_exposure_set`, platform admin, written reason, append-only, per business overrides platform). The remainder is recorded as **uncollected** (DanceFlow-absorbed). Texts are never refused. Outgoing chargeable texts keep failing closed on a negative balance, a hold or a suspension. Provider-cost estimates and platform alerts (`sms_inbound_admin_overview`: over 200 segments a day, balance at the ceiling) are kept.
- **D2.** STOP/START/HELP and their confirmations are `compliance`: never charged (a database constraint forbids it), never counted toward the monthly limit, always processed. HELP/START confirmations: at most 5 per sender per day (the check fails OPEN); a STOP confirmation is always sent.
- **D3.** No automatic reply to ordinary inbound texts. Error replies at most 1 per sender per day (the check fails CLOSED), counted per account; senders stored only as hashes.
- **D4.** Charged ordinary inbound counts toward the month (by the message's own time in the business timezone; a late reconciler record counts in its own month); it can overrun the limit, which then blocks new outgoing chargeable texts. The overview shows outbound, inbound, uncollected, absorbed and the overrun separately (data in this slice; the settings panel display follows the admin-UI branch to avoid editing its files).

**Security and recovery.** Recording runs only after the route's existing fail-closed checks (repeated keys, account-aware signature, tenant check) and the replay ledger (a duplicate returns before recording). It needs the signer to be the business's own subaccount, is idempotent per message SID for one business and studio, and runs after the message's own effects, so a recording failure can never block a text or a STOP. A failure is logged as a code; the scheduled reconciler slice will recover unrecorded texts with the same function (`p_source = 'reconciler'`, provider timestamp).

**Migration.** `20261203090000_twilio_inbound_usage_recording.sql` (+ rollback). Requires `20261201090000`; ordered after `20261202090000` (financial integrity, a parallel session), whose price-kind list it extends rather than replaces. Order `...1201 -> ...1202 -> ...1203`. The rollback removes only `sms_inbound` from the live kind list and refuses once inbound records, ceilings or an inbound price exist. App switch `SMS_INBOUND_RECORDING` (off).

## 7. Opus review of the recording slice (2026-10-20) and what changed

No P0; webhook authentication, tenant checks and the replay ledger are unchanged (PR 242's four guarantees verified). Fixed:
- **Ceiling on available funds (P1).** The ceiling is measured on balance minus reserved funds, so an outgoing text in flight or a set-aside recurring month can no longer push real exposure past the ceiling.
- **Pilot business carries no inbound debt (P1).** Its pilot-funded setup operations need a non-negative balance, so for the pilot business ordinary inbound is charged only from available credit (ceiling 0) and the rest is uncollected; the $150 pilot ceiling still never funds texting. **Owner to confirm** (it narrows D1 for the pilot only).
- One error reply per sender per day across all error kinds; HELP and START share one allowance of five confirmations.
- A fallback STOP / HELP / START on an error path gets a compliance reply (STOP always; HELP/START fail open) instead of silence.
- Recording fails fast under contention (lock timeout 2 s, statement timeout 5 s) so it cannot hold a webhook reply; the text is recovered by the reconciler slice.
- The 20261202 -> 20261203 order is enforced by a precondition; inbound ledger keys from older debits are refused at apply time; kind parsing accepts digits; the sender hash is an HMAC when `SMS_SENDER_HASH_KEY` is set; inbound records fix the business timezone like other charges.

**Owner decision raised (P2-7, not implemented).** An unknown sender can text a business's number repeatedly: each ordinary text is charged (down to the ceiling) and counts toward the monthly limit, which can then block the business's outgoing texts and hold its recurring number / monthly fees. Options: (a) accept, with the existing 200-segments-a-day alert; (b) charge at most N inbound segments per sender per day (the rest uncollected); (c) let recurring fees ignore inbound when checking the monthly limit.

**Accepted.** Refunds of inbound charges (an admin action) are netted in the total but shown under outbound usage; provider-cost estimates are empty until an inbound price is published; the reply counters have no retention purge yet.

## 8. Final owner decisions on PR 248 (2026-10-20, authoritative)

1. **ConfiDance pilot: no inbound debt.** Inbound is charged only against its separately funded, settled SMS credit (available funds). Beyond that, texts are still accepted and the rest is DanceFlow-absorbed. Its balance never goes negative from inbound; the $150 pilot setup ceiling is not messaging credit. (Implemented as a ceiling of 0 for the pilot business.)
2. **Unknown-sender drain: protect recurring fees (option c).**
   - Inbound never consumes funds reserved for authorized recurring fees: while a first month is set aside (`commit:`) or a recurring charge is in flight (`rec:`), an inbound charge may not bring the balance below those reservations. Other businesses keep the $10 negative-balance ceiling; anything beyond the permitted charge is absorbed.
   - An authorized recurring fee's monthly-limit check leaves inbound texts out (`tw4_recurring_charge`, replaced from its 20261128 definition with only that change), so inbound volume cannot hold the number or service fee. Chargeable inbound still counts toward the month for everything else, outgoing texts are still refused when the limit is used up, and overruns are displayed.
   - Kept: the 200-segments-a-day alert. Not added: per-sender caps, automatic charges, extended authorizations, any change to suspension, hold or funds checks.

**Opus review of the final decisions (2026-10-20).** No P0.
- **P1, fixed.** With an outgoing text (or a setup fee) reserved beside a set-aside month, the $10 ceiling still let inbound take the text's funds; the text then settled from the set-aside and the first month became unfunded. Rule now: **while a recurring set-aside is open, inbound uses only credit free of every reservation (no inbound debt)**; with no set-aside the $10 ceiling applies as before. Tested (text + set-aside, then settlement, then the set-aside is captured).
- **Note.** A recurring charge reserves and captures in one transaction under the account lock, so only the first-month set-aside (`commit:`) is ever open when inbound runs; `rec:` is covered for completeness.
- **P2, owner question.** After the first month, a recurring fee has no reservation. An unknown sender can push available credit to -$10, and the next month's fee is then recorded as unfunded (not charged; suspension rules apply as before). Protecting it would mean inbound keeps the next unpaid fee of every active authorization available (no inbound debt for a business with an active recurring authorization). Not implemented pending the owner's reading of "funds committed for authorized recurring fees".
- **P3, accepted.** An admin refund of an inbound charge nets into outbound usage, so the recurring fee's limit check (month minus inbound) can overstate room by the refunded amount; overruns stay visible.
