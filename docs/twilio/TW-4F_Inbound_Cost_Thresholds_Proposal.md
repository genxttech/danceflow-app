# TW-4F inbound cost thresholds: proposal, scenarios, remaining exposure, recommendation (2026-11-23)

Status: proposal for owner decision, docs only. It covers the defaults in migration `20270222190000_twilio_inbound_absorbed_cost_controls.sql` (PR #793, dark, Git-only). Nothing here publishes a price, adds a fee, funds anything or activates anything. Every price is cited to a file in this repo. Anything not in the repo is marked **ASSUMPTION**.

## 1. Cost inputs (from the repo)

| Input | Value | Source |
| --- | --- | --- |
| Inbound SMS base, long code | $0.0083 / segment | `docs/twilio/TW-4F_Pricing_Recommendation.md` section 2 (Twilio US pricing page, read 2026-10-24, re-read in section 14: unchanged) |
| Inbound carrier fee | AT&T $0.0035; T-Mobile and US Cellular $0.0025; Verizon and other: none listed | same, carrier table (blank cells = none listed, not proven $0) |
| Inbound all-in | $0.0083 to $0.0118 / segment; blended **$0.010205** | same, "All-in list cost" and "Blended expected cost" (the carrier mix 28/37/35 is itself marked assumed there) |
| Outbound all-in (what an automatic reply costs) | $0.0118 to $0.0133 / segment; blended **$0.012695**, worst $0.0133 | same |
| Failed-message fee | $0.0010 per failed message | same, section 2 |
| Outbound base in code (fixture) | `-0.00830` | `src/lib/sms/usageProvider.ts:436` (provider evidence fixture, base only) |
| Low Volume Standard brand throughput | about 2,000 T-Mobile segments / day | `docs/twilio/TW-4_ISV_SMS_Onboarding_Design.md:114`, `:634` (approximate, from Twilio guidance; not verified against the account) |
| How the code estimates absorbed cost | per text: `ceil(segments x unit_cost_micros / 10000)` cents, or `segments x provider_cost_cents` for a whole-cent row | `src/lib/supabase/migrations/20261231130000_twilio_sms_price_micros.sql` (inbound insert, `est_provider_cost_cents`; `_tw4pm_cents` rounds up) |
| What counts as absorbed | provider cost of what the studio was not charged for, plus reply cost | `20261231140000_twilio_inbound_absorbed_alert.sql`, `_tw4ia_absorbed_cents` |
| Reply sizes (ConfiDance Studio, GSM-7) | STOP 129 chars = 1 segment; HELP 179 = 2; START 163 = 2; each error reply 70 to 123 = 1 | `src/lib/sms/compliance.ts:188-206` and the route's error strings (`src/app/api/sms/twilio/inbound/route.ts:140-176`), counted at 160 / 153 per segment |

Two facts shape every threshold:

- **No inbound price is published today.** The pricing recommendation, section 14, gives only a provisional candidate ($0.02 inbound, not published). Until a price row with a cost exists, `est_provider_cost_cents` is null, every absorbed-cost figure reads $0, and only the segment thresholds can fire. DanceFlow still pays Twilio for every segment in the meantime.
- **The code's cost estimate rounds up per text.** At a blended 10,205 micros, a 1-segment text is estimated at 2 cents against a real cost of about 1.02 cents. At 8,300 micros (base only) it is 1 cent. The cent thresholds below therefore trip earlier than real spend, by up to about 2x for 1-segment texts. Which cost the published price row will carry is an **ASSUMPTION** until it is published.

## 2. Proposed defaults (the values in `_tw4ib_defaults`)

| Setting | Default | What it does | False-positive risk for a small studio |
| --- | --- | --- | --- |
| `daily_segment_alert` | 200 segments / local day | alert `sms_in_volume_high` (not for the pilot business, which keeps its own 200-segment alert) | Low: a 150-client studio's busiest normal day is about 100 segments (scenario B). Fires on a large event announcement with many replies. Consequence: one admin email. |
| `daily_absorbed_alert_cents` | $5.00 / local day | alert `sms_in_absorbed_high` | Low once a price is published. Needs about 250 to 500 absorbed compliance segments at the code's estimate. Blind while no inbound price exists. |
| `monthly_absorbed_alert_cents` | $20.00 / local month | alert `sms_in_absorbed_high` | Low. Mirrors the pilot's $20 allowance. Blind while no inbound price exists. |
| `anomaly_multiple`, `anomaly_trailing_days`, `anomaly_min_segments`, `anomaly_min_absorbed_cents` | 5x the 7-day average, floor 100 segments or $2.00 | alert `sms_in_anomaly` | **Moderate.** With a quiet baseline (about 15 segments a day), any 100-segment campaign-reply day fires (5 x 15 = 75 < 100). Consequence: one admin email. Raise the floor per business if it is noisy. |
| `cap_daily_segments`, `cap_daily_absorbed_cents` | 2,000 segments or $10.00 / local day | alert `sms_in_daily_cap` (critical). With the switch on, the only enforcement in this slice (section 3) | Very low for one studio: 20x its busiest normal day. When the switch is on, the cost of a false positive is that people hitting an error path get no error reply for the rest of the day. |
| Switch `studio_sms_inbound_reply_cap_switch_log` | **OFF** | enables the enforcement in section 3 | n/a |

## 3. Alerts versus enforcement (plain statement)

- **Alerts only inform.** Every alert in this slice (`sms_in_volume_high`, `sms_in_absorbed_high`, `sms_in_anomaly`, `sms_in_daily_cap`) is an administrator email. None of them changes anything.
- **The only enforcement** is this: while the switch is on and a business's recorded routed traffic today is at or over the daily cap, DanceFlow does not send the four error replies to texts received by that business's subaccount. The four are unavailable, could not process, unrecognized number and not routed.
- **Never blocked or changed by anything here:** inbound receive cost (Twilio bills every received text, and nothing here can stop that), inbound recording, the studio's charge for ordinary texts, STOP / START / HELP handling and their confirmations, consent changes, outbound texting, numbers and senders.
- **The cap is not a financial ceiling.** It does not limit what DanceFlow pays Twilio. It limits only one small class of outbound replies. Ordinary texts get no automatic reply at all (owner decision D3, `src/app/api/sms/twilio/inbound/route.ts:336-337`), so in a routed flood the cap has no reply to suppress and saves nothing. Spend is bounded only by the controls listed in `TW-4F_Financial_Safety_Gates_2026-11-23.md` section 1 and by provider-side throughput. Twilio offers no hard spending cap: Console usage alerts are notification only, a zero balance suspends the account but accepted messages can still push it negative, and auto-recharge refills it (gates document section 1a). The only way to stop inbound billing is a manual or DanceFlow-coded suspension of the subaccount, which is not built.

## 4. Scenarios for one studio (ConfiDance-sized)

**ASSUMPTIONS:** about 150 active clients; 1.1 segments per inbound text; inbound price published at the provisional candidate, whose cost the code estimates at 2 cents per 1-segment text; ConfiDance (the pilot business, ceiling $0) has funded credit, so its ordinary texts are charged, not absorbed. Real cost uses the blended rates from section 1.

| Scenario | Segments | Real cost to DanceFlow (provider) | Absorbed by DanceFlow (code's estimate) | What fires (defaults; switch off) |
| --- | --- | --- | --- | --- |
| A. Normal day: about 20 confirmations and questions | about 24 | 24 x $0.010205 = **$0.24** (recovered from the studio's credit) | $0 (charged) | nothing |
| B. Reminder-reply day: 150 reminders sent, 60% reply | about 100 | **about $1.02** inbound (the reminders themselves are outbound, paid by credit) | $0 (charged) | nothing at the default floor. **The anomaly alert fires** if the 7-day average is below 20 segments (a false positive; email only) |
| C. STOP/HELP wave after a 150-recipient campaign: 15 STOP, 5 HELP | 20 inbound + 25 reply segments (15 x 1 + 5 x 2) | 20 x $0.010205 + 25 x $0.012695 = **$0.52** | about 20 x 2c + replies (15 x 2c + 5 x 3c) = **$0.85** | nothing (under $5 and 200). Compliance traffic is never charged and never limited by these controls |
| D. Flood or loop: a misbehaving system or spam texts the number, 10,000 segments | 10,000 | 10,000 x $0.010205 = **$102** (worst all-AT&T $118) | ConfiDance's credit is charged first (ceiling $0), then the rest is absorbed: up to about **$200** at the 2c estimate | volume (pilot's own alert), anomaly, absorbed day and month, **cap** (critical). With the switch on, only error replies are suppressed. There are normally none on a routed flood, so the switch saves about $0 here |

A loop cannot be driven by DanceFlow's own replies to ordinary texts, because there are none (D3). HELP and START confirmations are limited to 5 per sender per day, and error replies to 1 (`src/lib/sms/inboundUsage.ts:34`, `INBOUND_REPLY_LIMITS`). A STOP is always answered once per STOP (`route.ts:131`, `:316-317`).

## 5. Remaining exposure: senders on the error-reply paths

An error reply is sent at most once per sender per subaccount per UTC day (`tw4_inbound_reply_allowed`, `20261203090000` lines 314-330; it fails closed, `inboundUsage.ts`). These texts are not recorded in `studio_sms_inbound_usage`, so the cap and the alerts do not see them (runbook section 7). The reconciler may record some later from provider evidence. Others end in `studio_sms_inbound_unresolved`.

Maximum per day for N distinct senders, one text and one 1-segment error reply each:

| N senders / day | Error replies (blended $0.012695) | Worst carrier ($0.0133) | Plus their inbound texts (blended $0.010205) | Total, worst carrier both ways ($0.0251) |
| --- | --- | --- | --- | --- |
| 100 | $1.27 | $1.33 | $1.02 | $2.51 |
| 1,000 | $12.70 | $13.30 | $10.21 | $25.10 |
| 10,000 | $126.95 | $133.00 | $102.05 | $251.00 |
| 100,000 | $1,269.50 | $1,330.00 | $1,020.50 | $2,510.00 |

Add $0.0010 per reply that fails. Extra texts from the same sender add inbound cost only (about $0.0102 each), never another reply.

What bounds N in practice:
- **N is normally near zero for a working number.** A text from any phone number to a correctly provisioned studio number is routed and gets no reply. Error paths need one of these:
  - a `From` that cannot be normalized, such as short codes or alphanumeric senders (`compliance.ts:64-78`);
  - an invalid body or MessageSid;
  - a receiving number that cannot be resolved to one studio, for example during provisioning or release, or when the `tw4_inbound_studio_for` lookup fails (`studioSender.ts:146-154`);
  - no database client. That case sends nothing: the counter cannot be checked and error replies fail closed (`inboundUsage.ts`).
- **The realistic large-N case** is a lookup failure (`lookup_failed`, answered as not routed) during a flood from many distinct numbers. Every distinct sender then gets one reply.
- **Provider throughput:** a Low Volume Standard brand is limited to about 2,000 T-Mobile segments a day (`TW-4_ISV_SMS_Onboarding_Design.md:114`). This caps T-Mobile-bound replies, but is not a guaranteed bound on cost. Above-limit sends may fail and still incur the failed-message fee. Other carriers' daily limits are not in the repo.
- **Not known (not in the repo):** Twilio's own spam filtering of inbound floods, and how many distinct numbers a real attacker controls. The number is public once published on the studio's materials and is not pinned to known senders. So N cannot be bounded from the repo alone. Its realistic range for a small studio is the owner's judgement.

## 6. Recommendation for ConfiDance

| Option | What happens | Consequences |
| --- | --- | --- |
| **(a) Monitoring only** (alerts on, switch off) | Every alert fires as in section 4. No reply is ever suppressed | No new user-visible behavior. Nothing in the flood scenario changes financially, because a routed flood gets no replies anyway. A false positive is an email only. Response to a real flood is the runbook procedure: an administrator investigates, and the owner acts at the provider. |
| (b) Monitoring plus the routed-traffic cap (switch on) | As (a), plus: after 2,000 segments or $10 absorbed in a local day, the four error replies are not sent for that business until the next local day or an admin clear | Saves at most about $0.0127 per distinct error-reply sender per day, and only on days already over the cap, so typically $0 to a few dollars. Cost of a false positive: someone texting from an unrecognized format, or during a routing problem, gets silence instead of "please contact the studio". It adds an admin clearing step to the procedure. It does not reduce the scenario D cost at all. |

**Recommendation: (a) monitoring only for ConfiDance's first pilot period.** The evidence agrees with the coordinator's lean:
- The enforcement cannot touch the dominant cost, which is inbound receive cost on routed texts.
- Its only saving falls on error replies that are already limited to one per sender per day.
- Its false-positive cost is user-facing silence.

Revisit (b) only if production shows real error-reply volume, for example from repeated `lookup_failed` or an unrecognized-sender stream. The higher-value follow-up is to count unresolved texts and error-reply cost in the alerts (runbook section 7), not to turn the switch on.

## 7. Smallest owner decision needed

Approve the defaults in section 2 as alert thresholds, with the enforcement switch left OFF for ConfiDance's first period (option a). Two items are optional and can wait:
- a per-business anomaly floor for ConfiDance, if its baseline is very quiet;
- the open question of whether the pilot business also receives the new absorbed, anomaly and cap alerts (it does today).
