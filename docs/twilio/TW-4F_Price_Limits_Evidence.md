# TW-4F price limits: evidence package for the owner (D4-3, documents only)

Prepared 2026-10-31 from `origin/main` 3d3fefe8. **NOTHING IN THIS DOCUMENT IS ADOPTED, APPROVED OR ENFORCED, AND NO SPEND IS AUTHORIZED.** It changes no code, SQL, price, flag or setting. It makes no hosted DEV/PROD access and no Twilio, Stripe or provider API call. The only external access was reading two public Twilio pages (section 1). The provisional direction of **$0.03 outbound and $0.02 inbound per billable segment stays exactly as it is** (Pricing Recommendation section 14; not published, not activated) until separately approved. The ConfiDance pilot's cumulative $150 cap and its individual fee-bearing approvals are unchanged.

Companion document (read-only here): `docs/twilio/TW-4F_Price_Limits_Proposal.md` on `origin/claude/d4-1-price-dual-control` (D4-1 proposal, "the proposal" below). Repo sources used: `TW-4F_Pricing_Recommendation.md` (rev 2 plus section 14), `TW-4F-3b_Pricing_Proposal.md`, `TW-4F_Inbound_Pricing_Assessment.md`, `TW-4F_Pilot_Readiness_Checklist.md`, `TW-4F_Usage_Financials_Design.md`, `TW-4F_RFL_Pilot_Approval_Evidence.md`, `TW-4F_Prov_Fee_Resolution_Evidence.md`, migrations `20261122090000` and `20261202090000`.

## 0. Facts from the repo that bound everything below

| Fact | Source |
|---|---|
| No migration seeds a price. The price list is empty until `tw4_price_set` publishes a row, so "currently configured" is **none** for all eight kinds. Numbers named "current" below are the documented candidates, not configuration. | `20261122090000` (only insert is inside `tw4_price_set`); Proposal |
| The price table stores **integer cents**: `customer_price_cents int > 0`, `provider_cost_cents int >= 0`. A true cost of 1.27 cents (outbound) or 1.02 cents (inbound) cannot be stored; it must be written as 1 or 2. | `20261122090000` line 59-60; Pricing Recommendation 6.1 |
| Every Twilio figure in the repo is a **public list price to verify on the invoice. None is confirmed.** There is no Twilio invoice or Console evidence yet (open items V-1, V-2, V-5). | Pricing Recommendation section 2 and 14.1; Pilot Readiness B |
| Undelivered texts are charged to the studio; failed and canceled are released (no charge) and any provider fee is DanceFlow's cost. | Usage Financials Design section 2 |
| Pilot: cumulative $150 (15,000 cents) ceiling, hard-coded in `tw4_pilot_exception_*` (`> 15000` refused); every fee-bearing pilot cover needs its own written approval reference; a cover amount must EQUAL the active published price (`TW008` otherwise). Owner allocation 2026-10-30: $130 setup fees plus $20 absorbed inbound, procedural only, not enforced in code. | `20261122090000` lines 132, 259, 559-562; `20261230090000`; `TW-4F_RFL_Pilot_Approval_Evidence.md`; Pilot Readiness B-2 |
| Usage reconciler refuses to auto-settle when provider price > `greatest(unit_provider_cost_cents,1) x 10000 x segments x 5` micro-dollars, i.e. 5 times the recorded cost in cents. The recorded cost is therefore a control input. | Proposal "Why the provider-cost bound matters"; Pricing Recommendation 6 |

## 1. External evidence (public Twilio pages only; retrieved 2026-10-31)

| Item | Figure | Source | Retrieved | Status |
|---|---|---|---|---|
| US SMS base, outbound and inbound, long code | $0.0083 per segment each way | https://www.twilio.com/en-us/sms/pricing/us ("Pricing current as of October 2026") | 2026-10-31 | public list price; matches repo; not invoice-verified |
| Carrier fees, outbound | AT&T $0.0035, T-Mobile $0.0045, Verizon $0.0050, US Cellular $0.0050, other $0.0042 | same page | 2026-10-31 | matches repo; not invoice-verified |
| Carrier fees, inbound | AT&T $0.0035, T-Mobile $0.0025, US Cellular $0.0025; Verizon and "other" **ambiguous** | same page | 2026-10-31 | My extraction tool again flattened the table (it returned $0.007 for Verizon inbound with a "column unclear" note). The repo read the raw HTML on 2026-10-24 and found those two cells blank (no fee listed). I did not re-resolve this; see sensitivity in section 5. |
| Failed-message processing fee | $0.001 per message, "only to messages that terminate in a Failed status" | same page | 2026-10-31 | public list price |
| Whether carrier fees or base price apply to Failed or Undelivered messages | **Not stated on the page** | same page | 2026-10-31 | UNVERIFIED (repo item V-2) |
| Local number, Twilio-leased | $1.15 per month (bring-your-own number $0.50 per month, new to this document) | same page | 2026-10-31 | public list price |
| Failed Message Processing Fees help article | returned only a title to the tool | https://help.twilio.com/articles/27502337507483-Failed-Message-Processing-Fees | 2026-10-31 | not readable |
| A2P 10DLC fees: brand $46 (incl. $41.50 secondary vetting), Low Volume Standard brand $4.50, campaign vetting $15 (non-refundable per 3b), campaign monthly $10 standard / $1.50 low volume | per repo | https://support.twilio.com/hc/en-us/articles/1260803965530-Pricing-and-Fees-for-A2P-10DLC-Service | HTTP 403 on 2026-10-31; repo had search extraction only | **UNVERIFIED** (no direct read by me or by the repo) |

Costs I treat below as "list cost": outbound blended $0.012695 per segment (worst carrier $0.0133), inbound blended $0.010205 (worst $0.0118), both from the repo's carrier-mix assumption AT&T 28 / T-Mobile 37 / Verizon 35 (assumed, not measured).

## 2. Per-kind tabulation

Columns: "Candidate" is the documented candidate retail price (Pricing Recommendation section 10 and 14), not a configured value. Margin is gross (price minus list cost over price) unless marked net. "Proposal" = D4-1 proposal values. Cost verification status applies to the list cost column.

| Kind | Configured / seeded | Candidate retail | Twilio list cost (status) | Gross margin at candidate | Proposal retail ceiling | Proposal provider ceiling | Gross margin at retail ceiling (cost at list) | Margin at candidate if cost rises to the proposal provider ceiling | Proposal step |
|---|---|---|---|---|---|---|---|---|---|
| `brand` | none | 6,500 ($65.00) | 4,600 ($46.00) UNVERIFIED (A2P article 403) | 29.2% | 10,000 | 6,000 | 54.0% | 7.7% | 50% |
| `brand_low_volume` | none | 700 ($7.00) | 450 ($4.50) UNVERIFIED | 35.7% | 2,000 | 1,000 | 77.5% | -42.9% (loss) | 50% |
| `campaign_vetting` | none | 2,100 ($21.00) | 1,500 ($15.00) UNVERIFIED, refundability unconfirmed | 28.6% | 3,500 | 2,500 | 57.1% | -19.0% (loss) | 50% |
| `number` | none | 165 ($1.65) | 115 ($1.15) public page read directly 2026-10-31 | 30.3% | 500 | 300 | 77.0% | -81.8% (loss) | 50% |
| `monthly` | none | 1,400 ($14.00) | 1,000 ($10.00) UNVERIFIED; tier for ConfiDance MIXED unconfirmed ($1.50 vs $10) | 28.6% | 2,500 | 1,500 | 60.0% | -7.1% (loss) | 50% |
| `monthly_low_volume` | none | 225 ($2.25) | 150 ($1.50) UNVERIFIED | 33.3% | 600 | 400 | 75.0% | -77.8% (loss) | 50% |
| `sms_usage` (per segment) | none | **3** (provisional, preserved) | 1.2695 blended / 1.33 worst (public list, not invoice-verified; stored only as 1 or 2) | 57.7% (net of Stripe, leakage, 5% reserve: 51%, per section 14.3) | 6 | 3 | 78.8% | 0.0% gross, **-9.5% net** | 50% |
| `sms_inbound` (per segment) | none | **2** (provisional, preserved) | 1.0205 blended / 1.18 worst (AT&T) (public list; Verizon/other inbound cells ambiguous) | 49.0% (net 43%) | 4 | 3 | 74.5% | **-50%** (cost 3 against price 2) | 100% |

Net-margin formula used for the last two rows is the repo's planning test: `(p x (1 - 3.5% Stripe - 1% leakage) - cost x 1.05) / p`; a 20% result needs cost <= 71.9% of price. This is a provisional planning target, not an approved floor.

## 3. Worst-case exposure

Volume assumptions (mine; labelled assumed): one studio onboarding once (one brand, one campaign, one number); 1,000 billable segments per studio-month split 85% outbound / 15% inbound (repo's own assumption); stress case 10,000 segments. "At ceiling cost" means Twilio's real cost has risen to the proposal's provider-cost ceiling while the studio price stays at the candidate (the case a provider ceiling is meant to bound).

**Per unit and per studio (one time setup, Standard path)**

| Quantity | List cost | At proposal provider ceilings | Candidate retail | At proposal retail ceilings |
|---|---|---|---|---|
| Standard setup (brand + vetting + first month + number) | $72.15 | $103.00 | $101.65 | $165.00 |
| Low Volume setup | $22.15 | $42.00 | $31.90 | $66.00 |
| Recurring per studio-month, Standard (monthly + number) | $11.15 | $18.00 | $15.65 | $30.00 |
| Recurring per studio-month, Low Volume | $2.65 | $7.00 | $3.90 | $11.00 |

Per-unit absorbed loss (cost minus candidate price, ceilings case) is in the "margin if cost rises" column above; DanceFlow absorbs any duplicate or erroneous registration at full cost ($72.15 Standard, $22.15 Low Volume per Pricing Recommendation section 11).

**Per studio-month, messaging (850 outbound / 150 inbound segments)**

| Case | Outbound cost | Inbound cost | Revenue at 3 / 2 | Result |
|---|---|---|---|---|
| List cost (blended) | $10.79 | $1.53 | $25.50 + $3.00 = $28.50 | +$16.18 gross |
| Proposal provider ceiling (3 and 3) | $25.50 | $4.50 | $28.50 | -$1.50 gross (before Stripe and reserve; about -$4.1 net) |
| Same, stress 10,000 segments | $255.00 | $45.00 | $285.00 | -$15.00 gross |
| Retail at proposal ceiling (6 / 4) with list cost | $10.79 | $1.53 | $51.00 + $6.00 | +$45 gross (the ceiling never creates loss; it is a limit on over-charging studios) |

**Exposure that no per-unit price limit touches** (repo section 14.5): STOP/START/HELP about $0.023 per opt-out, never charged; inbound MMS about $0.023, unbilled; inbound past the $10 customer ceiling and all pilot-business inbound beyond credit, absorbed with no cap (200 segments/day is about $2.04 to $2.36 per day at inbound cost, an illustration not a limit); failed texts $0.001 each; lost dispute about -$82 on a spent $100 pack.

**Pilot interaction.** Setup at the proposal's retail ceilings ($165.00 Standard) exceeds the $150 cap and the $130 setup allocation; at the candidates ($101.65) it fits. A cover amount must equal the published price, so a price near its ceiling would make the pilot's cover refuse (`TW007`, fail-safe) rather than overspend. At the proposal's provider ceilings ($103.00) it still fits.

## 4. Where a universal "provider cost <= customer price" rule is wrong or harmful

The proposal sets `max_provider_pct_of_customer = 100` for every kind. As a blanket rule it is wrong or harmful in these ways.

1. **Pilot exceptions are bounded losses by design.** The ConfiDance pilot funds setup fees from the cumulative $150 cap (customer pays nothing; individually approved, dated written approvals; owner allocation $130 setup plus $20 absorbed inbound). If the rule were applied at authorization or spend time (cost versus what the studio pays) it would block every pilot fee. As written the rule applies only to price-list rows, so it does not block the pilot, but it must be stated as **price-list-only** and never extended to pilot covers, pilot exceptions or absorbed spend. The pilot ceiling is the correct bound for those, and the owner keeps it unchanged.
2. **Integer cents make the test false-precise.** True per-segment costs (1.27 and 1.02 cents) are not representable. At price 2 an inbound cost recorded as 2 (rounded up) passes "<= 100%" with zero real margin; recorded as 1 (rounded down) it understates cost by up to 15%. A 100% rule passes any equal-cents pair, i.e. it permits a zero-margin or (after Stripe) negative-net price.
3. **It does not mean "profitable".** 100% passes break-even, but the repo's own test (20% net after Stripe 3.5-4.1%, 1% leakage, 5% reserve) needs cost <= about 72% of price. Outbound 3 against a recorded 3 passes and loses 9.5% net.
4. **It pushes administrators to record a falsified cost.** If Twilio's real cost rises above the customer price (carrier fee changes are routine: T-Mobile raised its fee 2026-01-29; Low Volume brand moved $4.00 to $4.50 on 2025-08-01), the rule forbids recording the true cost until the retail price is raised first, and the 50% step limit can slow that. The easy way past it is to under-record `provider_cost_cents`, which silently weakens the reconciler's 5x anomaly threshold. A control that rewards falsifying its own input is harmful. Rule violations should surface as an alert, not as a reason to misreport.
5. **Carrier pass-through variability.** Outbound cost ranges $0.0118 to $0.0133 and inbound $0.0083 to $0.0118 (or $0.0133 if the blank Verizon cells turn out to carry a fee). A ratio on a blended single number hides worst-carrier losses (inbound on AT&T) and also hides upside. Carrier fees are bundled in one price by design because the carrier is unknown when credit is reserved.
6. **Undelivered and failed messages.** Undelivered texts are charged (revenue and cost both present, so the rule is neutral). Failed texts carry cost with no revenue: at least $0.001 each, and up to a full segment cost if Twilio also bills base and carrier fees on failed or undelivered traffic, which is UNVERIFIED (V-2; at 1.37 cents a 10% failure rate changes the section 14.4 scenario S6 only modestly, but a failure storm is uncapped by any price rule).
7. **Unbilled categories are where the real negative margin is.** Compliance traffic, inbound MMS, inbound uncollected remainder and pilot-business inbound are negative by design. A per-unit price rule cannot see them; only volume or absorbed-cost limits can.
8. **Recurring fees.** An authorization is tied to the published price; a price change ends its protection and its charge (`p_acknowledged_price_cents`, "at its published price"). Step limits matter more here than the cost ratio, because a step triggers re-authorization by every studio.
9. **Deliberate loss-leaders.** The proposal already allows relaxing the value per kind in data. That is acceptable but should require an owner note and a time bound.

## 5. Findings that contradict or qualify the proposal table

1. **Provider ceiling 3 for `sms_usage` permits a loss.** At 3 cents price it is zero gross and -9.5% net; the repo's 20% target needs the recorded cost at or below 2 (2.157 maximum). It also makes the reconciler threshold 15 cents per segment (11.8x list) instead of 5 or 10.
2. **`sms_inbound` ceilings conflict with owner direction 1.** Inbound retail ceiling 4 and step 100% allow inbound above the 3-cent outbound, contradicting "inbound must be priced more favorably than outbound". The provider ceiling 3 exceeds the 2-cent provisional price; only the 100% ratio rule saves it, which is not independent protection.
3. **Retail ceilings are not compatible with the pilot cap.** Sum of Standard setup ceilings is $165, above $150 (and the $130 allocation).
4. **Provider ceilings exceed the candidate retail for five of six fixed kinds** (brand_low_volume 1,000 vs 700; vetting 2,500 vs 2,100; number 300 vs 165; monthly 1,500 vs 1,400; monthly_low_volume 400 vs 225), so those provider ceilings are unreachable under the 100% ratio at candidate prices, i.e. the ratio, not the ceiling, is the binding control; stating them as separate "ceilings" overstates protection.
5. **Cost ceiling basis is not stated and cannot be.** The proposal calls the per-segment cost "about 1 to 2" and "1.3 cents all-in"; the database can store only 1 or 2. No list cost is invoice-verified, and the A2P fixed fees have no direct read at all.

## 6. Options the owner can approve (trade-offs; none recommended as a decision)

A limit has four parts: retail ceiling, provider-cost ceiling, a provider-to-price ratio, and a step cap. A ceiling alone cannot stop a price set too LOW; the ratio is the floor.

**Option P (the D4-1 proposal as drafted).** Retail: 10,000 / 2,000 / 3,500 / 500 / 2,500 / 600 / 6 / 4. Provider: 6,000 / 1,000 / 2,500 / 300 / 1,500 / 400 / 3 / 3. Ratio 100%. Steps 50% (inbound 100%). Pro: preserves 3/2 with headroom; generous so little friction. Con: findings 1-4; ratio permits zero margin; retail ceilings are not cap-compatible.

**Option T (tight, cost-anchored).** For fixed kinds: provider ceiling about 1.3x list cost (6,000 / 600 / 2,000 / 150 / 1,300 / 200), retail ceiling about 1.3x candidate (8,500 / 1,000 / 2,800 / 250 / 1,800 / 350), ratio 72% (the repo's 20% test; every candidate passes at 64% to 71.4%), step 25% (observed Twilio moves were 4.5% and 12.5%). Per segment: `sms_usage` retail ceiling 4, provider ceiling 2, ratio 72%, step 34% (3 to 4); `sms_inbound` retail ceiling 2, provider ceiling 1, ratio 60%, step 50%. Standard setup at all retail ceilings = $133.50, near the $130 allocation, under the $150 cap. Pro: closes findings 1-4; keeps 3/2 valid (3 <= 4; 2 <= 2; outbound cost recorded 1 or 2 passes; inbound cost must be recorded 1). Con: inbound has no room to rise without a new approval (intended); recording inbound cost as 1 understates a true 1.02-1.18 (and 1.33 if the blank Verizon cells carry a fee) and a recorded 2 would be refused; any real cost rise above the ceiling forces a deliberate owner update first; tighter limits mean more owner touches.

**Option M (minimal).** Keep only the blanket cap, add the ratio at 72% for per-segment kinds only and nothing else. Pro: least friction, no pilot-cap issue. Con: price steps and provider-cost inputs unbounded for fixed kinds; reconciler threshold control remains weak.

**Orthogonal choices**
- **Alert, not block, on cost drift:** raise an alert when recorded provider cost exceeds the ratio (instead of refusing to record true cost), to remove the incentive in section 4 point 4.
- **Absorbed-cost limits** (not a price limit): a volume/dollar threshold on uncollected inbound, MMS and failed fees; today procedural only ($20 inbound allowance for ConfiDance).
- **Sub-cent provider cost** (micro-dollars) to store true cost: a separate migration decision (Pricing Recommendation sections 6 and 9); not proposed here.
- **Re-verify** all rows against the first Twilio invoice/Console before any approval is final; nothing here is authorized to obtain it.

## 7. Decision table (answer line by line)

| # | Decision | Options | Needed before |
|---|---|---|---|
| 1 | Adopt any limits now, or wait for invoice evidence (V-1, V-2) | Now / after first invoice / never (blanket cap only) | any `approved = true` |
| 2 | Which option | P / T / M / other | rows |
| 3 | Ratio rule scope | Price-list rows only (never pilot covers, exceptions, absorbed spend) / also elsewhere | ratio value |
| 4 | Ratio value | 100% / 72% (20% net target) / other, per kind | rows |
| 5 | Treat ratio breach as refusal or as alert | Refuse / alert only | design |
| 6 | `sms_usage` provider-cost ceiling | 2 / 3 / other | row |
| 7 | `sms_inbound` retail ceiling (keeps inbound below outbound?) | 2 / 3 / 4 | row |
| 8 | `sms_inbound` provider-cost ceiling | 1 / 2 / 3 (note integer-cent understatement) | row |
| 9 | Fixed-kind retail ceilings sum compatible with the $150 pilot cap / $130 allocation | Yes (Option T) / no (Option P) | rows |
| 10 | Step caps | 25% fixed, 34-50% per segment / 50% (inbound 100%) / other | rows |
| 11 | Loss-leader exceptions allowed | None / by owner note with end date | rule |
| 12 | Absorbed-cost limit (inbound, MMS, failed) | Procedural only (today) / build a limit later | pilot start |
| 13 | Record sub-cent provider cost | No (integer cents) / yes, separate migration | cost inputs |
| 14 | Confirm $0.03 out / $0.02 in unchanged | Yes (this document assumes yes) | nothing |

**Nothing is adopted. No spend is authorized. The provisional $0.03 / $0.02, the $150 cumulative ConfiDance cap and the individual fee-bearing approvals are unchanged.**
