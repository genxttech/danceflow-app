# TW-4F inbound absorbed-cost controls: limits and response procedure

Status: Git-only, dark. Migration `20270222190000_twilio_inbound_absorbed_cost_controls.sql` (rollback in `rollback/`). Not applied to DEV or PROD. Nothing here publishes a price, adds a studio fee or changes the six published prices.

## 1. Why this exists

A received text is never refused (owner decision D1). `tw4_inbound_record` charges an ordinary inbound text down to the business's negative-balance ceiling (default -$10.00; pilot $0.00) and records the rest as uncollected. DanceFlow absorbs the provider cost of everything uncollected, of every STOP / START / HELP, and of every reply. Before this slice the only alerts were the pilot business's cumulative $20 allowance alert and its 200-segment volume alert (`20261231140000`). Both were notification-only. Any other business could be flooded with nothing raised and nothing done.

Example: a 10,000-segment flood in one day on a business with $10.00 of credit, at the suite's fixture price (2 cents to the studio, 1 cent estimated provider cost per segment). The first 1,000 texts are charged ($20.00, down to -$10.00). The next 9,000 texts are uncollected ($180.00 not collected), and DanceFlow absorbs about $90.00 of provider cost that day. The isolated QA suite reproduces this example through the real recording function.

## 2. What the controls do (and never do)

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

## 3. Configuration (platform administrators only)

- `tw4_inbound_cost_controls_set(entity_or_null, actor, settings_json, reason)` changes the platform-wide row (entity null) or one business's override. Unknown keys and out-of-range values are refused, a reason of 10 to 300 characters is required, and a JSON `null` removes an override. A business's effective configuration is resolved in order: built-in defaults (`_tw4ib_defaults`), then the platform row, then the business row. Rows are append-only.
- `tw4_inbound_reply_cap_switch_set(actor, enabled, reason)` turns the automatic response on or off for all businesses. Each change is appended to the switch log.
- `tw4_inbound_cost_controls_status(actor, entity)` shows the switch, the effective configuration, today's numbers and today's suppression state.
- Every configuration change, switch change, suppression and clearance is appended to `studio_sms_inbound_cost_control_events`.

## 4. Response procedure (when an alert arrives)

1. Open the business's status with `tw4_inbound_cost_controls_status`. Compare today's segments and absorbed cost with the trailing average.
2. Find the source in the Twilio Console for that subaccount, read-only: sender numbers, message bodies, and whether this is a loop with another automated system.
3. Decide:
   - Legitimate traffic (an event, a campaign reply wave): raise that business's thresholds with a written reason and, if it is suppressed, clear it. Tell the owner that the studio absorbs nothing extra, because uncollected inbound is DanceFlow's cost.
   - Abuse or a loop: the owner (not the agent) blocks the sender at the provider or asks Twilio support. The cap's suppression stops DanceFlow from replying into the loop. Inbound recording and STOP / START / HELP continue.
4. Clear with `tw4_inbound_reply_suppression_clear(entity, actor, note)` only once the cause is understood. Write the note for the audit trail. Clearing lasts for the rest of that business's local day.
5. If absorbed cost becomes material, the owner decides on a per-business ceiling change (`tw4_inbound_exposure_set`) or on contacting the studio. This procedure never charges the studio more and never refuses texts.

## 5. Limits (known, by design)

- Absorbed cost uses the recorded estimates (`_tw4ia_absorbed_cents`). Texts recorded while no inbound price was published carry no estimate and count as $0. Only the segment cap protects those days. Estimates round up per text, so the cost figure is slightly pessimistic.
- Numbers come from recorded texts, one per provider message SID, so replays never count twice. A text the webhook failed to record counts only once the reconciler records it.
- The scan runs only when the provider-fee lifecycle scan runs (its own switch and schedule). The reply path checks the cap live, so suppression does not wait for the scan once the switch is on.
- Days and months use the business's governing timezone (`_tw4ml_tz_for`). On the day a recorded timezone change takes effect at a month boundary, that local day follows the new month's zone.
- The `sms_in_daily_cap` alert is raised once per local day. If the switch is turned on after it was raised, the summary still says "switched off" for that day.
- The pilot business keeps its 20261231140000 alerts unchanged and gets no duplicate volume alert. It does receive the new absorbed, anomaly and cap alerts. With the switch on, the cap applies to it as well (owner decision, see the PR).

## 6. Release order and rollback

Apply the SQL before, or together with, the app. The app tolerates the function's absence: the scan counts 0 and replies go out as before. Turn the switch on only after the alerts have been observed on real traffic. To roll back, roll the app back first (optional), then run the rollback. It refuses while any configuration, switch, suppression, event or new-kind alert row exists, because that history is never deleted.
