# TW-4F financial safety: exposure model and release gates (2026-11-23)

Status: governance document. Verified against origin/main (read-only audit, spot-checked). Nothing here authorizes spending, activation, price changes or new studio fees.

## 1. The $150 setup ceiling is not the provider-billing exposure

| | What it is | What it counts | What it does NOT count or stop |
| --- | --- | --- | --- |
| **ConfiDance $150 setup ceiling** | DanceFlow application limit on pilot setup reservations (`spend_cap_cents`; the pilot ceiling trigger) | pilot reservations in state reserved, captured or burned, at customer prices (brand, vetting, number, campaign monthly as approved) | outbound texting (needs credit), inbound cost DanceFlow absorbs, recurring fees beyond approved periods, Twilio's own charges to the parent account, disputes. Twilio does not enforce it. |
| **Overall provider-billing exposure** | everything Twilio bills DanceFlow's parent account for all subaccounts | setup fees, monthly number and campaign fees, outbound and inbound segments, carrier surcharges, resubmission vetting | bounded only by: studio credit for outbound; the inbound ceiling (default -$10 per business, pilot $0); recurring-fee authorizations and monthly spending limits; reconciler readiness; the owner's Twilio Console balance, auto-recharge and alert settings. |

Rule: the ceiling is a limit, never an authorization, and never a statement about total spend.

## 2. Safeguards required at each stage (an unchecked row is a blocker for that stage)

| Safeguard | Before the FIRST fee-bearing action (brand, vetting, number, campaign) | Before the FIRST test message | Before general studio availability |
| --- | --- | --- | --- |
| Spend cap set per legal entity; every fee has a dated written approval (U-4) | required | required | required |
| Reserve then capture exactly once; release on definite refusal; unknown outcome stays held (`tw4_spend_*`) | required (proven) | required | required |
| Owner verifies Twilio parent balance, auto-recharge and usage alerts in the Console | required | required | required |
| Fee-lifecycle scan on (exposure and upcoming-charge alerts) with a monitored alert recipient | required | required | required |
| Pricing check GO; six prices unchanged | required | required | required |
| Sender re-verification cron on and one clean cycle (readiness cannot lapse) | not needed | required | required |
| Inventory reconcile cron on and one clean cycle | not needed | required | required |
| Usage reconciler on, ready (TW024) and fresh | not needed | required | required |
| Controlled test credit funded (bounded, audited, dual control) | not needed | required | not applicable |
| STOP/START/HELP verified live; opt-out hardening live (R+4 done) | not needed | required | required |
| Absorbed-inbound alert and volume alert (pilot) | not needed | required | required |
| Recurring-charge cron on with the database switch, proven on a credit studio | not needed | not needed (pilot refused by design) | required |
| Funding-exposure scan (unfunded numbers and resources) alerting platform admins | recommended | recommended | required |
| Inbound absorbed alert and hold or daily cap for ALL businesses | not needed | not needed | required |
| Stripe dispute: automatic hold, admin alert, dispute fee recorded as DanceFlow-borne | not needed | not needed | required (before studios pay by Stripe) |
| Negative-balance hold and alert | not needed | required | required |
| Twilio bill ingestion or a scheduled manual invoice reconciliation | not needed | not needed | required |
| DB financial suites in CI against a dedicated Postgres | not needed | not needed | required |

Compliance rule for every row: STOP/START/HELP handling never needs credit and is never charged; no control above may block it.

## 3. Status of each gap (this release set)
1. Unscheduled maintenance crons: PR "TW-4F financial safety P1: register reverify, inventory and recurring crons (dark)" (release line). Flags stay off until their release gates.
2. Controlled test credit, exposure scan, inbound absorbed controls, dispute and negative-balance holds: tracked as separate slices; each needs an isolated-QA run and independent review before merge, and nothing ships to production without its release approval.
3. Inbound absorbed controls for all businesses (slice C, PR #793, migration 20270222190000; dark, Git-only):
   - What it adds: per-business alerts for volume, absorbed cost, anomaly and the daily cap, plus a switch-gated suppression of non-compliance automatic replies at the cap. It never refuses a text and never affects STOP/START/HELP.
   - Limit: the cap protects only against overage from **routed** traffic, meaning texts recorded in `studio_sms_inbound_usage`. Texts that receive error replies (unrouted, unrecognized sender, invalid) are not recorded there, and `studio_sms_inbound_unresolved` is not read. So a flood of unrouted-sender texts, and the outbound cost of the error replies to it, are bounded only by the existing per-sender error-reply limit (one per sender per account per UTC day).
   - Follow-up: count unresolved texts and the error-reply outbound cost in the cap and the alerts.
   - Runbook: `docs/twilio/TW-4F_Inbound_Absorbed_Cost_Runbook.md`.
