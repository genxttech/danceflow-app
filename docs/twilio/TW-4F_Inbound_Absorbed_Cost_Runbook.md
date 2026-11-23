# TW-4F inbound absorbed-cost controls: limits and response procedure

Status: Git-only, dark. Migration `20270222190000_twilio_inbound_absorbed_cost_controls.sql` (rollback in `rollback/`). Not applied to DEV or PROD. Nothing here publishes a price, adds a studio fee or changes the six published prices.

## 1. Why this exists

A received text is never refused (owner decision D1). `tw4_inbound_record` charges an ordinary inbound text down to the business's negative-balance ceiling (default -$10.00; pilot $0.00) and records the rest as uncollected. DanceFlow absorbs the provider cost of everything uncollected, of every STOP / START / HELP, and of every reply. Before this slice the only alerts were the pilot business's cumulative $20 allowance alert and its 200-segment volume alert (`20261231140000`). Both were notification-only. Any other business could be flooded with nothing raised and nothing done.

Example: a 10,000-segment flood in one day on a business with $10.00 of credit, at the suite's fixture price (2 cents to the studio, 1 cent estimated provider cost per segment). The first 1,000 texts are charged ($20.00, down to -$10.00). The next 9,000 texts are uncollected ($180.00 not collected), and DanceFlow absorbs about $90.00 of provider cost that day. The isolated QA suite reproduces this example through the real recording function.

## 2. Alerts versus enforcement

- **Alerts only inform.** All four new alert kinds are administrator emails and change nothing.
- **The only enforcement:** while the database switch is on (default OFF) and a business's recorded routed traffic today is at or over its daily cap, the four error replies are not sent for texts received by that business's subaccount.
- **Never blocked:** inbound receive cost (Twilio bills every received text), inbound recording, the studio's charge for ordinary texts, STOP / START / HELP handling and confirmations, consent, outbound texting, numbers and senders.
- **The daily cap is not a financial ceiling.** It does not limit what DanceFlow pays Twilio. Ordinary texts get no automatic reply (D3), so in a routed flood the cap has nothing to suppress and saves nothing. The exposure figures, scenarios and the ConfiDance recommendation are in `docs/twilio/TW-4F_Inbound_Cost_Thresholds_Proposal.md`.

## 3. Proposed thresholds and the cap (owner decision pending)

These are the defaults in `_tw4ib_defaults`. The cited costs, the ConfiDance scenarios and the false-positive risk of each are in the proposal note, sections 1, 2 and 4.

| Setting | Default | Fires | False-positive risk (small studio) |
| --- | --- | --- | --- |
| Daily volume alert | 200 segments | email | low (busiest normal day about 100) |
| Daily / monthly absorbed alert | $5.00 / $20.00 (the code's estimate, rounded up per text) | email | low; **blind until an inbound price with a cost is published** |
| Anomaly | 5x the 7-day average, floor 100 segments or $2.00 | email | moderate on reply-wave days when the baseline is quiet |
| Daily cap | 2,000 segments or $10.00 | critical email; with the switch on, error replies suppressed | very low; when it does happen, error-path senders get silence for the rest of the day |

Recommendation for ConfiDance's first pilot period: **monitoring only (switch off)**. See the proposal note, section 6.

## 4. What the controls do (and never do)

They never refuse, delay or charge an inbound text. They never touch STOP / START / HELP handling, consent, the ledger, balances, ceilings, reservations, senders or numbers.

Alerts are raised by the existing provider-fee lifecycle scan (`tw4_inbound_cost_controls_check`, called right after the pilot check). They go to platform administrators only, through the existing alert outbox and mail sink. They carry no amounts and are deduplicated per business per local day, or per local month for the monthly alert:

| Kind | Condition (business-local day unless stated) | Default |
| --- | --- | --- |
| `sms_in_volume_high` | inbound segments above `daily_segment_alert`. Not raised for the pilot business, which keeps its own `inbound_volume_high` alert | 200 |
| `sms_in_absorbed_high` | absorbed cost today at or above `daily_absorbed_alert_cents`. Also raised for the local month at or above `monthly_absorbed_alert_cents` | $5.00 / $20.00 |
| `sms_in_anomaly` | today's segments (or absorbed cost) above `anomaly_multiple` times the trailing daily average over `anomaly_trailing_days` full local days, and at or above the floor `anomaly_min_segments` (or `anomaly_min_absorbed_cents`). Days with no traffic count as zero | 5x, 7 days, 100 segments / $2.00 |
| `sms_in_daily_cap` (critical) | absorbed cost today at or above `cap_daily_absorbed_cents`, or segments today at or above `cap_daily_segments`. The summary says whether suppression is on | $10.00 / 2,000 segments |

Automatic response. This is off by default and controlled by the database switch `studio_sms_inbound_reply_cap_switch_log`. While the switch is on and a business has reached its daily cap, DanceFlow sends none of its non-compliance automatic replies for texts received by that business's subaccount. Today those replies are the four error replies: temporarily unavailable, could not process, could not recognize your number, and not routed. Ordinary texts already get no automatic reply (D3). The suppression lasts until the business's next local day or until a platform administrator clears it, whichever comes first. A day that has been cleared is not suppressed again.

Never suppressed:
- STOP, START and HELP confirmations, including a fallback keyword on an error path
- every carrier-required reply
- the parent account (legacy studios)

The database function answers true for these kinds before it reads anything, and the route never asks it about them. The route's check fails open: an error or a missing function sends the reply exactly as before, and the existing per-sender error limit still applies.

## 5. Configuration (platform administrators only)

- `tw4_inbound_cost_controls_set(entity_or_null, actor, settings_json, reason)` changes the platform-wide row (entity null) or one business's override. Unknown keys and out-of-range values are refused, a reason of 10 to 300 characters is required, and a JSON `null` removes an override. A business's effective configuration is resolved in order: built-in defaults (`_tw4ib_defaults`), then the platform row, then the business row. Rows are append-only.
- `tw4_inbound_reply_cap_switch_set(actor, enabled, reason)` turns the automatic response on or off for all businesses. Each change is appended to the switch log.
- `tw4_inbound_cost_controls_status(actor, entity)` shows the switch, the effective configuration, today's numbers and today's suppression state.
- Every configuration change, switch change, suppression and clearance is appended to `studio_sms_inbound_cost_control_events`.

## 6. Response procedure (when an alert arrives)

1. Open the business's status with `tw4_inbound_cost_controls_status`. Compare today's segments and absorbed cost with the trailing average.
2. Find the source in the Twilio Console for that subaccount, read-only: sender numbers, message bodies, and whether this is a loop with another automated system.
3. Decide:
   - Legitimate traffic (an event, a campaign reply wave): raise that business's thresholds with a written reason and, if it is suppressed, clear it. Tell the owner that the studio absorbs nothing extra, because uncollected inbound is DanceFlow's cost.
   - Abuse or a loop: the owner (not the agent) blocks the sender at the provider or asks Twilio support. Nothing in this slice reduces the inbound cost of a flood. DanceFlow sends no automatic reply to ordinary texts, so a loop is not fed by DanceFlow replies. The cap's suppression only stops error replies. Inbound recording and STOP / START / HELP continue.
4. Clear with `tw4_inbound_reply_suppression_clear(entity, actor, note)` only once the cause is understood. Write the note for the audit trail. Clearing lasts for the rest of that business's local day.
5. If absorbed cost becomes material, the owner decides on a per-business ceiling change (`tw4_inbound_exposure_set`) or on contacting the studio. This procedure never charges the studio more and never refuses texts.

## 7. Limits (known, by design)

- **What the cap does not cover.** The cap counts only routed traffic: texts that reached a studio of the business and were recorded in `studio_sms_inbound_usage`. It is not a financial ceiling (section 2).
  - The texts whose error replies the cap suppresses (invalid, unrecognized sender, not routed, service unavailable) are never written to `studio_sms_inbound_usage`.
  - `_tw4ib_window` also does not read `studio_sms_inbound_unresolved`.
  - So a flood of texts from senders that cannot be routed does not move the cap, the absorbed-cost alerts or the anomaly detection.
  - The outbound cost of the error replies themselves is not counted either.
  - Such a reply flood is bounded only by the existing per-sender limit: one error reply per sender per account per UTC day (`tw4_inbound_reply_allowed`, which fails closed). Many distinct senders can still each get one reply.
  - Follow-up (not built): count unresolved texts per receiving subaccount and the estimated outbound cost of error replies in `_tw4ib_window`, so the cap and the alerts also see this traffic.
- **The anomaly baseline uses today's timezone for past days.** The trailing days are measured as local days in the timezone that governs the current day. If the business's timezone changed during the trailing window, the earlier days are cut at the new zone's midnights. Their totals can then shift by a few hours of traffic. Accepted as is.
- Absorbed cost uses the recorded estimates (`_tw4ia_absorbed_cents`). Texts recorded while no inbound price was published carry no estimate and count as $0. Only the segment cap protects those days. Estimates round up per text, so the cost figure can be up to about 2x the real cost for 1-segment texts: 2 cents estimated against about 1.02 cents real at a blended 10,205-micro cost (proposal note, section 1). Cent thresholds therefore trip early.
- Numbers come from recorded texts, one per provider message SID, so replays never count twice. A text the webhook failed to record counts only once the reconciler records it.
- The scan runs only when the provider-fee lifecycle scan runs (its own switch and schedule). The reply path checks the cap live, so suppression does not wait for the scan once the switch is on.
- Days and months use the business's governing timezone (`_tw4ml_tz_for`). On the day a recorded timezone change takes effect at a month boundary, that local day follows the new month's zone.
- The `sms_in_daily_cap` alert is raised once per local day. Its wording reflects the business's state when it was raised: suppressed, cleared by an administrator that day, or switch off. A later change that day does not reword it.
- Integer settings must be whole numbers: the setter refuses values like `2000.0`. Every reader compares settings as numbers, and the scan checks each business separately, so one business with an unreadable setting is counted in the scan's `errors` and never stops the others. The lifecycle run records that as an error and keeps the alerts that were raised.
- The pilot business keeps its 20261231140000 alerts unchanged and gets no duplicate volume alert. It does receive the new absorbed, anomaly and cap alerts. With the switch on, the cap applies to it as well (owner decision, see the PR).

## 8. Release order and rollback

**Release note: the alerts are not dark.** `alerts_enabled` defaults to true. Once the SQL is applied, platform administrators get these emails whenever the existing provider-fee lifecycle scan and its delivery switches run. Only the reply suppression is dark (its switch defaults OFF). With `alerts_enabled` false for a business and the switch on, that business can be suppressed with no critical email. Only the `suppressed` row in `studio_sms_inbound_cost_control_events` records it.

Apply the SQL before, or together with, the app. The app tolerates the function's absence: the scan counts 0 and replies go out as before. Turn the switch on only after the alerts have been observed on real traffic. To roll back, roll the app back first (optional), then run the rollback. It refuses while any configuration, switch, suppression, event or new-kind alert row exists, because that history is never deleted.

## 9. Follow-ups (recorded, not built)

- The scan's `errors` count carries no business id. A business that fails persistently marks every lifecycle run as failed, and the run shows stale after 26 hours, without saying which business. Add the entity id to a per-business error record.
- The anomaly check rounds the trailing average to 2 decimals before applying the multiple. The effect is negligible.
- Count unresolved texts and the error-reply outbound cost in the cap and the alerts (section 7).

## 10. Untouched paths (verified on the PR head)

Inbound recording and STOP / START / HELP handling are unchanged. The evidence:

- **No existing database function is replaced.** The migration only uses `create function` with new names (`_tw4ib_*`, `tw4_inbound_cost_controls_*`, `tw4_inbound_auto_reply_allowed`, `tw4_inbound_reply_cap_switch_set`, `tw4_inbound_reply_suppression_clear`). It contains no `or replace` and never writes to `studio_sms_inbound_usage`, the ledger, consent or credit tables. `tw4_inbound_record`, `tw4_inbound_reply_allowed`, `tw4_rfl_inbound_allowance_check` and `record_sms_inbound_opt_event` keep their existing bodies. Asserted by the suite test "the migration replaces no existing function" in `src/lib/sms/twilioIsv/__tests__/localStack.inboundcost.test.ts`.
- **The route change is one line**, `src/app/api/sms/twilio/inbound/route.ts:135`, inside `errorReply` only.
  - A fallback STOP returns before it (`:131`).
  - HELP and START are excluded by the `asKind !== "help" && asKind !== "start"` guard on the same line.
  - Routed STOP / START / HELP never reach `errorReply`: the STOP reply is at `:316-317`, the HELP / START confirmations go through `complianceReply` at `:279`.
  - Recording is unchanged: `recordInboundUsage` at `:264` inside `finish`.
  - The ordinary-text no-reply path is unchanged (`:336-337`).
- **Tests:**
  - `src/app/api/sms/twilio/inbound/__tests__/route.costControls.test.ts`: STOP / START / HELP, both routed and unrouted, are confirmed and never consult the cap; consent still changes.
  - The existing route suites still pass: `route.tw1`, `route.a2p1`, `route.compliance.tw4f`, `route.inboundUsage`, `route.recurring` and `route.senderAccount.tw4sr` (276/276 unit tests in total).
  - DB: `localStack.inboundcost` "compliance replies are NEVER suppressed at the cap, and STOP / START / HELP are still recorded".
  - DB: `localStack.tw4inbound`, the existing recording suite, 29/29.
  - DB: `localStack.inboundalert`, the existing pilot alert suite, 15/15.
  - SQL mutation: removing the compliance early-return fails the compliance-at-cap test.
