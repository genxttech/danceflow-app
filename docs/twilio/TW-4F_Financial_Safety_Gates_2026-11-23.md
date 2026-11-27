# TW-4F financial safety: exposure model and release gates (2026-11-23)

Status: governance document. Verified against origin/main (read-only audit, spot-checked). Nothing here authorizes spending, activation, price changes or new studio fees.

## 1. The $150 setup ceiling is not the provider-billing exposure

| | What it is | What it counts | What it does NOT count or stop |
| --- | --- | --- | --- |
| **ConfiDance $150 setup ceiling** | DanceFlow application limit on pilot setup reservations (`spend_cap_cents`; the pilot ceiling trigger) | pilot reservations in state reserved, captured or burned, at customer prices (brand, vetting, number, campaign monthly as approved) | outbound texting (needs credit), inbound cost DanceFlow absorbs, recurring fees beyond approved periods, Twilio's own charges to the parent account, disputes. Twilio does not enforce it. |
| **Overall provider-billing exposure** | everything Twilio bills DanceFlow's parent account for all subaccounts | setup fees, monthly number and campaign fees, outbound and inbound segments, carrier surcharges, resubmission vetting | bounded only by: studio credit for outbound; the inbound ceiling (default -$10 per business, pilot $0); recurring-fee authorizations and monthly spending limits; reconciler readiness; DanceFlow's own monitoring and suspension actions. Twilio itself offers NO hard spending cap (section 1a). |

Rule: the ceiling is a limit, never an authorization, and never a statement about total spend.

## 1a. What the providers actually enforce (verified from official documentation 2026-11-23; engineering has not inspected the live accounts)

Sources are in the research fact sheet; items marked "not verified" could not be confirmed on an official page.

**Twilio (parent account with per-studio subaccounts, all usage billed to the parent)**
* **No native hard spending cap** exists on an account or subaccount. Usage Triggers and balance emails are notification only; a trigger is checked about once a minute, usage data can lag, and each fires once per period. A balance email defaults to $5.
* **Enforced by Twilio:** at a zero balance the project is suspended, but messages already accepted still complete, so the balance can go negative. Auto-recharge refills the balance (up to $2,000 at a time), so it removes the zero-balance stop; it does not cap spend. How invoiced or postpaid accounts behave at zero is not verified.
* **The only cap is DanceFlow's own code:** a main-account credential can suspend (or permanently close) a subaccount through the API. Suspension stops sending and receiving for that subaccount; numbers continue to be billed monthly. Whether inbound attempts and campaign/brand monthly fees keep billing while suspended is not verified; assume they do. DanceFlow has no automatic trigger-to-suspend wired today; that is an unbuilt control and a remaining exposure.
* **Remaining exposure** with every control above in place: unrouted or flood inbound that Twilio bills before any DanceFlow code runs, fees that continue while suspended, usage-data lag, and a parent balance that auto-recharge keeps refilling.

**Stripe (credit top-ups)**
* Dispute liability depends on the charge model: platform charges and destination charges leave the disputed amount and fees with the platform; direct charges debit the connected account, with fees per its fee-payer setting. The US dispute fee is $15 when received and not refunded, plus a separate $15 fee when evidence is submitted (disputes opened after 2025-06-17), returned only on a full win. So one dispute can cost $30 in fees, not $15. Whether fees return on a withdrawn dispute is not verified.
* How a dispute fee is allocated between DanceFlow and a studio is a contract question, separate from who Stripe charges. No allocation is approved, and nothing debits a studio for it.

## 2. Safeguards required at each stage (an unchecked row is a blocker for that stage)

| Safeguard | Before the FIRST fee-bearing action (brand, vetting, number, campaign) | Before the FIRST test message | Before general studio availability |
| --- | --- | --- | --- |
| Spend cap set per legal entity; every fee has a dated written approval (U-4) | required | required | required |
| Reserve then capture exactly once; release on definite refusal; unknown outcome stays held (`tw4_spend_*`) | required (proven) | required | required |
| Owner records the parent account's balance, auto-recharge and low-balance notification settings, and DanceFlow's own suspension procedure (section 1a), understanding none of them is a hard cap | required | required | required |
| Fee-lifecycle scan on (exposure and upcoming-charge alerts) with a monitored alert recipient | required | required | required |
| Pricing check GO; six prices unchanged | required | required | required |
| Sender re-verification cron on and one clean cycle (readiness cannot lapse) | not needed | required | required |
| Inventory reconcile cron on and one clean cycle | not needed | required | required |
| Usage reconciler on, ready (TW024) and fresh | not needed | required | required |
| Controlled test credit funded (bounded by a per-business budget, written authorization for budget and grant as two separate acts, audited) | not needed | required | not applicable |
| STOP/START/HELP verified live; opt-out hardening live (R+4 done) | not needed | required | required |
| Absorbed-inbound alert and volume alert (pilot) | not needed | required | required |
| Recurring-charge cron on with the database switch, proven on a credit studio | not needed | not needed (pilot refused by design) | required |
| Funding-exposure scan (unfunded numbers and resources) alerting platform admins | recommended | recommended | required |
| Inbound absorbed alert and hold or daily cap for ALL businesses | not needed | not needed | required |
| Stripe dispute: automatic hold, admin alert, dispute fee estimate recorded, allocation undecided | not needed | not needed | required (before studios pay by Stripe) |
| Negative-balance hold and alert | not needed | required | required |
| Twilio bill ingestion or a scheduled manual invoice reconciliation | not needed | not needed | required |
| DB financial suites in CI against a dedicated Postgres | not needed | not needed | required |

Compliance rule for every row: STOP/START/HELP handling never needs credit and is never charged; no control above may block it.

## 3. Status of each gap (this release set)
1. Unscheduled maintenance crons: PR "TW-4F financial safety P1: register reverify, inventory and recurring crons (dark)" (release line). Flags stay off until their release gates.
2. Controlled test credit, exposure scan, inbound absorbed controls, dispute and negative-balance holds: tracked as separate slices; each needs an isolated-QA run and independent review before merge, and nothing ships to production without its release approval.
3. Inbound absorbed controls for all businesses (slice C, PR #793, migration 20270222190000; dark, Git-only):
   - What it adds: per-business alerts for volume, absorbed cost, anomaly and the daily cap, plus a switch-gated suppression of non-compliance automatic replies at the cap. It never refuses a text and never affects STOP/START/HELP.
   - Against the section 2 row "Inbound absorbed alert and hold or daily cap for ALL businesses": the alerts are delivered. The "daily cap" here is **not a hold and not a financial ceiling**. Its only enforcement is suppressing the four error replies, and it cannot reduce inbound receive cost, which Twilio bills for every received text. Whether alerts alone satisfy that row for general availability is an owner decision. Figures, scenarios and the ConfiDance recommendation are in `docs/twilio/TW-4F_Inbound_Cost_Thresholds_Proposal.md`.
   - Limit: the cap counts only **routed** traffic, meaning texts recorded in `studio_sms_inbound_usage`. Texts that receive error replies (unrouted, unrecognized sender, invalid) are not recorded there, and `studio_sms_inbound_unresolved` is not read. So a flood of unrouted-sender texts, and the outbound cost of the error replies to it, are bounded only by the existing per-sender error-reply limit (one per sender per account per UTC day).
   - Follow-up: count unresolved texts and the error-reply outbound cost in the cap and the alerts.
   - Runbook: `docs/twilio/TW-4F_Inbound_Absorbed_Cost_Runbook.md`.
