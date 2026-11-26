# TW-4F controlled SMS pilot: release-readiness assessment (2026-11-18)

Status: assessment only. Nothing activated, published, spent, configured or applied. The $150 pilot cap is a ceiling, not authorization to spend. Gate C (price sweep) is closed and not revisited.

## 1. Production-ready today (live line 6ba31295, PROD SQL through 20270219)
- Schema: full TW-4F chain on PROD (credit ledger, usage, sender/number readiness, provisioning, pilot controls, price dual control). All tables empty: no subaccount, brand, campaign, number, credit account, price row or usage.
- Price control: dual control, sole approver, Windows Hello credential, monitor + watchdog + sweep running clean (761 monitor runs, 14 sweeps, 0 findings). 0 published prices.
- Reconciler/fee-lifecycle crons registered on the live line (dark behind flags); KI-1 double capture fixed and applied; month-two funding bug fixed (1219/1225/1228).
- Base consent (TW-1/2) live.

## 2. Hard blockers for the first pilot (mandatory)
| # | Blocker | Who acts |
|---|---|---|
| 1 | Published prices: 0 rows. Six provisional prices ($0.017 out, $0.013 in, $7.00 brand, $21.00 vetting, $2.25 campaign/mo, $1.65 number/mo) need new proposals, the 24h cooling-off and a Windows Hello signature. | Owner |
| 2 | Twilio facts still open: inbound carrier fee (ticket says none, public page lists AT&T/T-Mobile fees), brand fee $4 vs $4.50, campaign tier name, ConfiDance eligibility by name. Follow-up is drafted (docs/twilio/TW-4F_Ticket_30376594_Pricing_Evidence_2026-11-16.md); whether sent is unknown. | Owner sends; Twilio answers |
| 3 | Provisioning: no subaccount/brand/campaign/number. Brand and campaign approval is the external lead time (days to weeks) and starts only at submission. Each fee step needs its own written approval. | Owner + platform admin; Twilio |
| 4 | Real-provider validation: adapters never exercised against real Twilio; fixture capture on owner hold (about $1.30, cap $5). Documented as an activation gate. | Owner |
| 5 | Flags and schedulers: reconciler/evidence-read/fee-lifecycle flags and the inventory/re-verify jobs must be on and proven; billed sends are refused without a ready reconciler. | Engineering; owner enables flags |
| 6 | Pilot controls: named daily checker (unknown), stop action defined, Advanced Opt-Out verified after the subaccount exists, sole-admin PROD keeps two-admin actions fail-closed. | Owner |
| 7 | Test-message budget separate from the $150 setup ceiling (decision package: $10 DanceFlow-funded credit; amount/method not shown approved). | Owner |

## 3. Can follow launch (not blockers)
F2 legacy-sender gate, funding-exposure monitor, out-of-band escalation, cancellation UI, kill-switch policy, quiet hours, automatic inbound hold and per-sender STOP limit, repricing, KI-2/KI-3, TW-4F DB suites in CI, provider bill ingestion, final retail price after the first invoice, Stripe clarification and counsel/CPA review (only matter if studios top up by Stripe), platform-admin AAL2 hardening.

## 4. Judgment calls to confirm
- Consent hardening (STOP parking, START ordering, status-callback ordering, SQL 20270215) is main-only and not on the live line or PROD. For a single-studio pilot with consented test numbers and Twilio's own opt-out handling it is not first-message blocking, but it should land before the pilot widens. It is an engineering port (Git-only draft, then an owner release gate).
- Real fixture capture (blocker 4) is the one item that tests assumptions with the provider; it is cheap and should precede any fee step.

## 5. Minimum pilot scope and completion criteria
Scope: one studio (ConfiDance Studio, legal entity ConfiDance Unlimited, LLC; never GenX), one subaccount, Low Volume Standard brand and campaign, one number, a small named set of consenting test recipients, owner-activated manually. $150 ceiling for setup and absorbed inbound; messaging on the separate test budget.
Done when all hold: (1) subaccount, brand, campaign approved and number active; (2) one consented test SMS delivered end to end with the usage row, ledger debit and reconciler evidence agreeing; (3) STOP and START round trip on the test number behaves; (4) reconciler and monitors clean for 7 days; (5) spend at or under the approved ceiling with evidence; (6) first Twilio invoice reconciles to the ledger.

## 6. Shortest safe path (order)
1. Owner: send the Twilio follow-up (inbound fee, brand fee, tier name, eligibility). Cheap, starts the answer clock.
2. Owner: approve the six provisional prices; engineering proposes them (24h cooling-off starts), owner signs.
3. Owner: authorize real-provider fixture validation (about $1.30, cap $5).
4. Engineering (autonomous, Git-only, no hosted change): port the consent hardening to the live line as a draft PR; prove reconciler and scheduler readiness in iso-qa.
5. Owner: stepwise written approvals for G-SUB, G2 submit, brand fee, number, campaign fee; then manual activation and the first consented test SMS.

## 7. Next owner decision
Approve step 1 and 2 together: send the Twilio follow-up and approve the six provisional prices (or amend them) so the 24h cooling-off and Twilio's answer clock run in parallel. Nothing else is on the critical path until they finish.

## Stale items found in the notes
Support inquiry "awaiting reply" (answers recorded 2026-10-19); tracker "no cron / PROD <=1119"; Pilot Readiness Checklist $0.03/$0.02 pricing and "dual control open"; 3b brief $0.019. main's vercel.json lacks the sweep cron and the live line lacks 346 main commits, so ports must be cut from the live line.

## 8. Owner approval received 2026-11-18: "Approve both" (follow-up + provisional prices)
Both actions run through the owner's own sessions, which engineering cannot use: Twilio support is a portal the owner is signed in to; a price proposal calls `tw4_price_propose`/`tw4_price_propose_micros`, which need the owner's recent signed-in app session (`_tw4price_session_actor('recent')`), and publication needs the owner's Windows Hello signature after the 24h cooling-off. No hosted write was made by engineering.
- Twilio follow-up: send the text in docs/twilio/TW-4F_Ticket_30376594_Pricing_Evidence_2026-11-16.md section 5 on ticket #30376594 (three questions: inbound carrier fees, campaign tier name, brand fee / resubmission vetting).
- Price proposals, platform admin SMS page, one per kind, values as provisional: outbound $0.017 (cost $0.012695 expected), inbound $0.013 (inbound only AFTER Twilio answers question 1 if the owner wants it settled; $0.013 is acceptable to propose now and can be re-proposed), brand $7.00 (cost $4.00), vetting $21.00 ($15.00), campaign monthly $2.25 ($1.50), number monthly $1.65 ($1.15). After 24h, sign each with the key. The sweep expires an unsigned proposal after its expiry window (proposal lifetime is the dual-control expiry); sign promptly.

## 9. Twilio status reclassified (2026-11-18, owner: no more routine Twilio escalation)
The Twilio follow-up in section 8 is WITHDRAWN. No Twilio contact is planned without explicit owner approval.

Answered by Twilio (record): ticket #29647095, 2026-10-19 (TW-4F_Provider_Integration.md section 1): Primary profile assignable to a subaccount Secondary (yes); subaccount-scoped credentials; subaccount Auth Token signs webhooks; parent can fetch the token on demand; no rotation overlap; EIN studios can use Low-Volume Standard brands and Low Volume Mixed campaigns if eligible and after review. Ticket #30376594, 2026-11-16 (relayed): eligible EIN dance studios can use Low Volume Standard in their own subaccounts under our approved ISV Primary profile; brand $4 one-time; vetting $15 one-time; campaign $1.50/month; no inbound 10DLC carrier surcharge, base inbound rate only.

Internal assumptions replace the three informational conflicts (no question to Twilio):
- Brand fee $4 vs $4.50: assume $4.50 cost. Retail $7.00 still clears 31.6%.
- Campaign tier name: cost is $1.50/month in every reading; the actual tier appears at submission. Retail $2.25.
- Inbound carrier fee: Twilio's written answer is none; public page suggests AT&T $0.0035, T-Mobile/US Cellular $0.0025. Conservative reading: provisional $0.013 gives 17% blended and 5% on AT&T-heavy traffic; pilot volume is tiny and absorbed inbound is already bounded ($20/day allowance, 200 segments/day alert). Keep $0.013 provisional (unpublished, repriceable after the first invoice) or file $0.0155 (20% on the worst carrier). Owner picks at proposal time; either is safe for the pilot.
- Resubmission vetting after a rejection: assume a repeat $15 (cost exposure up to $37.15 per studio); bounded by the $150 ceiling, which counts customer prices.

Not Twilio questions, proven in the supervised pilot run instead: Advanced Opt-Out per Messaging Service (manual Console step V-6), Event Streams sink placement, duplicate-entity check after the deleted Stage B draft, real request shapes (fixture capture, owner hold).

Actual provider blockers: NONE that require asking Twilio. The only provider gates are Twilio's own review of the brand and campaign (a process outcome, started at submission) and ConfiDance's eligibility as decided in that review.

## 10. Shortest path to a controlled pilot (supersedes section 6)
1. Owner, signed in: file the six provisional price proposals on the platform admin SMS page (values in section 8; inbound $0.013 or $0.0155), sign after 24h, keep them unpublished until separately authorized. Engineering cannot act in the owner's session.
2. Engineering, now, Git-only: port consent hardening from the live line; prove scheduler/reconciler readiness in iso-qa; prepare the activation checklist and the two-admin/daily-checker items.
3. Owner approvals, one at a time: fixture capture (about $1.30, cap $5); publish prices; G0 pilot access and runner window; G-SUB; G1/G1b attestations; G2 submit; G3 brand fee; G4 number; G5 campaign fee; G6 manual activation; G7 first consented test SMS.
Gates preserved: spending, price publication, SMS activation, #445, #326.

## 11. Owner decision 2026-11-18: inbound proposal at $0.0155
Owner chose "File $0.0155". The six proposals to file in the owner's signed-in session (unpublished until separately authorized): outbound $0.017 (cost $0.012695); inbound **$0.0155** (cost field $0.010205 expected blend as in the manifest; 19.8% net margin on the worst carrier at $0.0118; see TW-4F_Final_Price_Reconciliation_2026-11-18.md, which supersedes the cost figures in section 8); brand $7.00 (cost $4.50 conservative); vetting $21.00 ($15.00); campaign monthly $2.25 ($1.50); number monthly $1.65 ($1.15). Engineering cannot file them (owner session required); filing starts the 24h cooling-off, then the owner signs each with the key.

## Corrections (2026-11-23, from the financial-safety verification of origin/main 11c80dda)
- Section 9 says absorbed inbound is "already bounded ($20/day allowance, 200 segments/day alert)". In migration 20261231140000 the $20 is CUMULATIVE since the pilot exception was created, and both it and the 200-segment alert are NOTIFICATION ONLY: nothing blocks. Neither applies to non-pilot businesses.
- Section 5 says "$150 ceiling for setup and absorbed inbound". The ceiling trigger counts only pilot setup reservations (reserved, captured, burned) at customer prices. Absorbed inbound is never counted against it, and neither is outbound texting, recurring fees after the first month, or anything Twilio bills the parent account. See `TW-4F_Financial_Safety_Gates_2026-11-23.md`.
