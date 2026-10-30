# TW-4F pricing and pilot readiness checklist (docs only, 2026-10-30)

Option A ($0.03 outbound / $0.02 inbound per billable segment) stays **provisional pilot pricing only**: not approved, not published, not activated. Final retail-price approval requires the first actual Twilio invoice/Console evidence (item V-1). Nothing here authorizes a merge, Console deletion, hosted migration, live SMS, provisioning, Stripe operation or any fee-bearing action. STOP/START/HELP must keep working at any prepaid balance, including zero or negative; no item below may change that.

## 1. Inbound protections reviewed (code on main, read 2026-10-30)

| Protection | Where | Effect | Limit |
|---|---|---|---|
| Signature, tenant and replay checks before any effect; per-IP limiter on rejected requests (30 per 10 min) | inbound `route.ts` | forged traffic does not reach billing or consent | does not limit genuine Twilio-delivered texts |
| Each text recorded once per message SID | `tw4_inbound_record` (20261203) | no double charge | none |
| Ordinary text charged only down to the negative-balance ceiling ($10 default, 0 for the pilot business); remainder `uncollected` | same | caps customer debt | **does not cap DanceFlow's absorbed cost**; texts are never refused (D1) |
| STOP/START/HELP classified `compliance`: never charged, always processed | same, DB constraint | compliance independent of balance (requirement preserved) | costs inbound + confirmation, absorbed |
| No auto-reply to ordinary texts (D3); error replies at most one per sender per day, none if the check fails | `tw4_inbound_reply_allowed` | removes the reply-amplification cost | none |
| HELP/START confirmations limited to 5 per sender per day, fail open; STOP always answered | route + counters | keyword never meets silence | a STOP from one sender is answered every time (no limit); unverified whether Twilio Advanced Opt-Out already answers and blocks, in which case the app sends nothing (TW-1) |
| 200 segments/day flag and ceiling-reached flag per business | platform inbound view | operator visibility | flag only; no automatic hold, block or notification found in the code reviewed |
| Inbound MMS recorded, not billed | `tw4_inbound_record` | no charge for media | costs about $0.023 each, absorbed |

Not found in the code reviewed: any automatic per-number or per-sender inbound cap, any automatic alert delivery, any spend cap on absorbed inbound.

## 2. Modeled negative-margin cases against those protections

| Case (PR 304 section 14.5) | Mitigated? |
|---|---|
| Compliance traffic (STOP/START/HELP) | By design absorbed; bounded per sender for HELP/START, **not for repeated STOP** (unless Twilio handles it) |
| Failed texts ($0.001) | Bounded by the sender's own send volume (prepaid reservation) |
| Inbound photos | Not mitigated; small per event |
| Inbound past the ceiling / unknown-sender flood | **Not mitigated** except by operator watching the flag |
| Pilot business inbound without credit | Not charged by design; **absorbed without a cap** |
| Lost dispute, refunded top-up | Out of scope of inbound; Stripe terms; no pilot top-up planned |

**Correction recorded:** my earlier figure of about $61-$71 per 30 days is an extrapolation of the 200/day flag, not a cap (corrected in PR 304 section 14.5).

## 3. Genuine pilot-blocking cost exposure not already mitigated

1. **Uncapped absorbed inbound for the ConfiDance pilot business** (ceiling 0, no inbound debt). It is not a pricing defect and not a blocker for the code review; it is a **budget gap**: the $150 pilot ceiling "never funds texting", and the messaging test budget is a separate owner approval. Exposure is small in realistic use (about $0.01 per received segment; a 5,000-segment flood is about $50-$60) but has no automatic ceiling. Smallest mitigation that needs no new code: the messaging test budget approval (E-1) must state an explicit absorbed-inbound allowance and a named person who checks the inbound flag daily during the pilot. Closing it in code (automatic hold or alert) is optional and belongs to the hardening owner, not this PR.
2. No other uncovered pilot-blocking exposure found. Pilot spend (fees) is already covered by Blocker 9 hardening (PR 330).

## 4. Pilot-readiness checklist

### A. Confirmed blockers (decisions or actions, none done by this PR)

| # | Item | Owner | State |
|---|---|---|---|
| B-1 | Stage B draft handled (U-10, tracker blocker 4): verify, preserve evidence, written deletion authorization, owner Console deletion | owner; tracker/coordinator tracks it | runbook written (`TW-4F_StageB_Draft_Cleanup_Runbook.md`); **nothing deleted; nothing authorized**; coordinator confirmation pending (see section 5) |
| B-2 | Absorbed-inbound allowance and pilot preconditions (section 6) | owner | allowance decided (relayed by the coordinator, 2026-10-30): $20 carved out of the $150 cap; preconditions below open; any other messaging test budget still needs its own approval |
| B-3 | Final retail price approval after D7 pilot cycle and invoice evidence (V-1) | owner | closed |
| B-4 | Stripe written answer on closed-loop prepaid credit | owner submits drafted request | unsent |
| B-5 | Counsel/CPA review (credit terms, tax, refunds, closure, unclaimed property) | owner | not started |
| B-6 | Decision on dual control vs documented single admin for `tw4_price_set` | owner | open |
| B-7 | Hosted migrations, live SMS, provisioning, fee-bearing steps | owner, each separately | none authorized |

### B. Unverified costs (need the first invoice or Console; nothing here is obtained)

| # | Item |
|---|---|
| V-1 | Actual Twilio invoice lines: carrier fees by direction (Verizon and "all other" inbound blank on the public page) |
| V-2 | Whether carrier fees and the $0.001 fee apply to undelivered/failed texts |
| V-3 | A2P brand, vetting and campaign fees (Twilio article unreadable to my tool; search extractions only) |
| V-4 | ConfiDance brand/campaign tier eligibility (Low Volume vs Standard), confirmed with Twilio before registration |
| V-5 | `num_segments` reporting for UCS-2 edge cases |
| V-6 | Whether Twilio Advanced Opt-Out answers and blocks repeated STOP so the app never answers them |

### C. Optional enhancements (not blockers, not started, not for this PR)

| # | Item |
|---|---|
| E-1 | Automatic inbound hold/alert when daily segments or absorbed cents pass a threshold (hardening owner) |
| E-2 | Per-sender limit on STOP confirmations if V-6 shows the app does send them |
| E-3 | Repricing to a lower whole-cent pair or sub-cent design if invoices show Option A is well above target (cheaper before live rows exist) |
| E-4 | Dual control for price publication |

## 5. U-10 ownership and coordination

The tracker keeps U-10 / blocker 4 as an owner-authorized action; the coordinator session ("TW-4F pilot readiness coordination") owns the tracker rows. Ownership proposed: the **owner performs** verification and Console deletion; the **coordinator** records pass/fail and updates blocker 4, U-10 and Q-dup; this PR only supplies the runbook and does not edit the tracker. The hand-off was sent to the coordinator session on 2026-10-30 asking it to confirm; no reply is recorded here. Nothing was deleted or authorized.

## 6. ConfiDance absorbed-inbound allowance and pilot preconditions (owner decision relayed by the TW-4F coordinator, 2026-10-30)

**Allowance:** $20 for absorbed inbound, carved out of the existing $150 cumulative pilot cap; it is not an additional budget. Procedurally the pilot exception's setup-fee ceiling becomes **$130**, with $20 held for absorbed inbound. **Not enforced in code today:** pilot usage sums count only setup kinds, so nothing stops absorbed inbound or setup fees from passing these figures. This is a procedural limit only.

**Pilot preconditions (all open; none done by this PR):**
1. A named person checks `sms_inbound_admin_overview` and Twilio usage daily.
2. Pre-agreed stop action: release the number (accepting that STOP handling stops with it).
3. `SMS_INBOUND_RECORDING=on` with an inbound price published (publishing needs its own owner approval; Option A stays provisional).
4. Advanced Opt-Out verified (V-6).
5. U-10 closed (B-1).

**Gaps that make any broader rollout NO-GO:**
- No scheduled reconciler.
- No alert delivery.
- `alert_ceiling` never fires for the pilot business (it compares against the $10 default, not its ceiling of 0).
- No enforceable absorbed-cost limit.

No implementation work is proposed or started here.
