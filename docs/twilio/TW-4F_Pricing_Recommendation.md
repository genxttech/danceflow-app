# TW-4F U-2: validated pricing recommendation (docs only)

Prepared 2026-10-23 from main `fc507ee1`. **Nothing here is a price, an approval or a publication.** No price is set, `tw4_price_set` is not run, and no hosted, Twilio or Stripe action was taken. This answers the owner's U-2 decision: cost-plus-25% (`TW-4F-3b_Pricing_Proposal.md`) is not published as final or interim pricing; this document replaces it with a structure that has been checked against the live provider list prices, the ledger schema and the record.

Every provider figure below is a **public list price, to verify on the Twilio invoice/Console**. None is confirmed.

## 1. Headline findings

1. **The price columns are whole cents, so a per-segment price can only be 1¢, 2¢, 3¢...** `studio_sms_price_list.customer_price_cents` and `provider_cost_cents` are `int`, as are `unit_price_cents` on usage attempts (`20261201`) and inbound usage (`20261203`). Every earlier draft figure ($0.016, $0.017, $0.018, $0.019, $0.013) is **not expressible** without a schema change. Rounding a charge up to a whole cent per message makes a $0.017-$0.019 price behave as 2¢ for the common one-segment text anyway (section 5).
2. **At 1¢ per segment every text loses money**, in both directions (about -$0.003 to -$0.007 per segment after card fees). 1¢ is not a usable inbound price, so "inbound lower than outbound" cannot be done in whole cents above 1¢ without making inbound 2¢ = outbound.
3. **Inbound is barely cheaper to deliver than outbound.** Blended list cost is about $0.0120 inbound vs $0.0127 outbound (a $0.0007 difference); Verizon and AT&T inbound cost the same as outbound. The earlier proposed inbound price of $0.013 is **below break-even** once card fees, the variance reserve and compliance traffic are counted (about -1% expected, -12% on Verizon).
4. **Recommended structure that needs no schema change:** itemized fixed fees, **2¢ per segment outbound and 2¢ per segment inbound, carrier fees bundled**. Expected margin about 29% outbound and 33% inbound; worst-carrier margin about 25%. This conflicts with the owner's 2026-10-20 direction that inbound not be charged at the outbound retail rate; that needs an owner exception or a schema change (section 5).
5. **Two corrections to my earlier (2026-10-19) brief:** (a) I read Verizon inbound as $0.007; Twilio's flattened table does not support that (section 2). (b) I assumed credit given back for undelivered texts; the design charges `undelivered` and releases only `failed`/`canceled` (`TW-4F_Usage_Financials_Design.md` section 2), so that leakage assumption is removed.
6. **D7 not yet met.** The roadmap says no final prices until Twilio costs are verified over at least one pilot billing cycle. This document therefore proposes a candidate set to validate during the ConfiDance pilot, not a set to publish now (section 8).

## 2. Provider list prices (access date 2026-10-23)

Each row: "public list price, to verify on the Twilio invoice/Console".

| Item | List price | Frequency | Source (URL; access date; how read) |
|---|---|---|---|
| Standard brand (includes secondary vetting) | $46.00 | one time | [Pricing and Fees for A2P 10DLC Service](https://support.twilio.com/hc/en-us/articles/1260803965530-Pricing-and-Fees-for-A2P-10DLC-Service); 2026-10-23; **not read directly (page returns 403 to my tool); figure from a search-engine extraction of the page** |
| Secondary vetting (inside the $46) | $41.50 | one time | [Secondary vetting pricing](https://support.twilio.com/hc/en-us/articles/4403988619163-Understanding-A2P-10DLC-Standard-Brand-Secondary-Vetting-Pricing); 2026-10-23; extraction only |
| Low Volume Standard brand (no secondary vetting) | $4.50 (was $4.00 until 2025-08-01) | one time | same pricing article; 2026-10-23; extraction only. The [2022 changelog](https://www.twilio.com/en-us/changelog/us-a2p-10dlc-low-volume-standard-brand-registration-available-in-twilio-console) (read directly 2026-10-23) still says $4 and is stale; it gives eligibility: EIN, fewer than 6,000 segments/day |
| Campaign vetting | $15.00 per campaign | one time | same pricing article and [Campaign vetting FAQ](https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ); 2026-10-23; extraction only (FAQ returned only a title to my tool). Refundability not confirmed |
| Campaign monthly, Low Volume Mixed | $1.50 | monthly | same pricing article; 2026-10-23; extraction only |
| Campaign monthly, Standard (MIXED and most standard use cases) | $10.00 | monthly | same; extraction only. Other tiers seen: Sole Prop $2, charity $3, emergency $5. **Which tier ConfiDance's MIXED campaign falls into is unconfirmed** |
| Local phone number | $1.15 | monthly | [US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us); 2026-10-23; **read directly** ("Pricing current as of October 2026") |
| Outbound SMS base | $0.0083 | per segment | same; read directly |
| Inbound SMS base | $0.0083 | per segment | same; read directly |
| Failed-message fee | $0.0010 | per message ending "Failed" | same; read directly |
| MMS out / in (long code) | $0.022 / $0.0165 plus carrier fee | per message | same; read directly. **Not offered**: media is routed to review in settlement (`TW-4F_Usage_Financials_Design.md`) |

**Carrier fees, long code SMS** (US SMS pricing page, read directly 2026-10-23, list price, verify on invoice):

| Carrier | Outbound | Inbound | Note |
|---|---|---|---|
| AT&T | $0.0035 | $0.0035 | clear |
| T-Mobile | $0.0045 | $0.0025 | clear (record: raised 2026-01-29 per Twilio notice) |
| US Cellular | $0.0050 | $0.0025 | clear |
| Verizon | **$0.005 and $0.007 shown for four columns** | **ambiguous** | my reading: SMS $0.005 (both directions), MMS $0.007; this is **an interpretation**. The 2026-10-20 assessment read Verizon inbound as "none listed"; my 2026-10-19 brief used $0.007. Resolve from the downloadable `SMSPricing.csv` |
| All other | **$0.0042 and $0.01 shown for four columns** | **ambiguous** | my reading: SMS $0.0042 (both directions), MMS $0.01 |

All-in list cost per segment (base $0.0083 + carrier): outbound AT&T $0.0118, T-Mobile $0.0128, Verizon/US Cellular $0.0133, other $0.0125; inbound AT&T $0.0118, T-Mobile $0.0108, US Cellular $0.0108, Verizon $0.0133 (likely) or $0.0153 (if $0.007 applies). Toll-free and short-code differ and are out of scope (long-code 10DLC only).

**Blended expected cost** uses the record's carrier-mix assumption (Verizon 35 / T-Mobile 37 / AT&T 28, from the 2026-10-20 assessment; an assumption, not measured): outbound **$0.01269**, inbound **$0.01196** (Verizon at $0.007: $0.01265). Replace with ConfiDance pilot data.

**Stripe** ([stripe.com/pricing](https://stripe.com/pricing), read directly 2026-10-23): 2.9% + $0.30 per successful domestic card payment; +1.5% international cards; +1% currency conversion; dispute received $15 per dispute (counter fee $15 refunded only if won); refunds have no fee but **the original processing fee is not returned**. The page states no minimum charge amount.

## 3. Stripe effect on top-ups and net credit

| Pack | Stripe fee | Fee as % of face | DanceFlow receives | If a pack is fully refunded unused |
|---|---|---|---|---|
| $10 (not offered) | $0.590 | 5.90% | $9.41 | loses $0.59 |
| **$25** | $1.025 | **4.10%** | $23.975 | loses $1.03 |
| **$50** | $1.750 | 3.50% | $48.25 | loses $1.75 |
| **$100** | $3.200 | 3.20% | $96.80 | loses $3.20 |
| $500 (ceiling) | $14.800 | 2.96% | $485.20 | n/a |

- Credit equals face value (the studio gets $25 of credit for $25); Stripe's fee is DanceFlow's cost, so every dollar of credit carries 3.2%-4.1% of processing cost. Pricing must absorb up to 4.1% (worst case, $25 pack).
- The $25 minimum is the lowest pack in the design; smaller packs would push cost above 5.9%. Keep $25 as the minimum. The design's expected blend assumed 3.5%.
- Refunds of unused credit leave DanceFlow bearing the Stripe fee. Whether to withhold it is a legal/policy question and stays unresolved (see the 2026-10-19 owner brief, section 4).

## 4. Record: required margins and policy

| Source | What it says |
|---|---|
| 3b Design section 3, 7 (decisions 2, 7) | Published customer price and expected provider cost per kind; separately disclosed fees; fixed published prices, DanceFlow absorbs ordinary variance; actual Twilio charge recorded with variance |
| Pricing Proposal section 3 | Investigate a single variance above $2.00 or a month above 5% of billed; republish (never edit) when Twilio list price moves more than 10% |
| Pricing Proposal section 2 | Options: cost +25%, +40%, flat markup. **U-2: +25% not to be published as final or interim** |
| Inbound Assessment (2026-10-20) | Recover ordinary inbound, not at the outbound rate; floor stated as $0.013 (now shown too low, finding 3); D1 `$10` negative-balance ceiling then uncollected; compliance traffic never charged; pilot business gets no inbound debt |
| Usage Financials Design | `sms_usage` is per segment x frozen price, carrier fees bundled; undelivered charged; failed/canceled released; MMS to review |
| Roadmap D7 | Setup fee + monthly service fee + included allowance with metered overage; **no final prices until Twilio costs verified over at least one pilot billing cycle** |
| Tracker U-2 / A-13 | Exact prices and dual control for publication open; `tw4_price_set` is single-admin and immediate; "price publication with dual control" is a listed follow-up |

No explicit numeric margin floor is recorded. I use **net margin >= 20% of price after card fees, a 5% variance reserve and 1% compliance-traffic leakage** as the test (the pricing-proposal "+25% over cost" corresponds to a 20% margin before card fees). That floor is my proposal for the owner to set or change.

Margin = (price x (1 - Stripe - 1% compliance leakage) - cost x 1.05) / price.

## 5. Per-segment structure and margins

Compliance leakage is STOP/START/HELP traffic, which is never charged (database-enforced). Failed-message fees ($0.001) are DanceFlow's cost and are below 0.1% of revenue at normal failure rates.

| Option | Outbound exp. (Stripe 3.5%) | Outbound worst (Verizon, 4.1%) | Inbound exp. | Inbound worst (Verizon $0.005 reading) | Inbound worst (Verizon $0.007 reading) |
|---|---|---|---|---|---|
| 1¢ both | -38% | -45% | -30% | -45% | -66% |
| 2¢ both (**recommended**) | **28.9%** | **25.1%** | **32.7%** | **25.1%** | 14.6% |
| 3¢ out / 2¢ in | 51% | 48% | 32.7% | 25.1% | 14.6% |
| $0.019 out / $0.017 in (sub-cent) | 25.3% | 21.4% | 21.7% | 12.8% | 0.4% |
| $0.017 out / $0.013 in (earlier draft) | 17.1% | 12.8% | **-1.1%** | **-12.5%** | **-28.7%** |

Reading it:
- **2¢/2¢ clears the 20% floor in every case except the unresolved Verizon-inbound $0.007 reading (14.6%, still positive).** Price break-even sits about 43% above the worst-carrier outbound list cost, so a Twilio price move of the 10% republish threshold does not make a segment unprofitable.
- **Inbound is cheaper by only ~$0.0007 blended**, so the owner's "not at the outbound rate" intent cannot be met in whole cents: 1¢ loses money. Options: (a) 2¢ inbound = outbound (recommended; needs an owner exception to the 2026-10-20 direction); (b) 3¢ out / 2¢ in preserves a differential, with outbound at about 50% margin, which may be uncompetitive (I did not verify competitors' prices); (c) sub-cent pricing.
- **Why sub-cent buys little**: the credit ledger is integer cents (`balance_delta_cents`, reservations), and settlement posts `segments x unit_price_cents`. A $0.019 or $0.017 price needs either per-message round-up (a one-segment text becomes 2¢ regardless) or a new sub-cent accrual in the ledger, which is a financial-integrity redesign. Not recommended before the pilot.
- Multi-segment messages: segments are counted in the database (GSM-7 153 / UCS-2 67 per concatenated part); cost and price both scale per segment, so margin is unchanged; a UCS-2 message costs 2-3x a GSM-7 one of the same length.

**Carrier fees: bundle, do not pass through.** The recipient's carrier is unknown when the reservation is made (`tw4_usage_begin` reserves `segments x price` in one transaction), and carrier fees vary only ±$0.0015 around the mean. A per-carrier surcharge line would need a carrier lookup, a variable post-send charge outside the reservation, and a new kind. Bundling is what the design assumes. Disclose "carrier fees included".

## 6. Setup and recurring fees (itemized)

Cost / (1 - 4.1% Stripe worst case - 25% margin), rounded to a sensible figure. Fixed fees carry no variance reserve (Twilio's published fixed fees; the exposure is a list-price change, covered by republishing at 10%).

| Item (price kind) | Twilio list cost | Candidate price (not approved) | Net margin after 4.1% |
|---|---|---|---|
| Brand, Low Volume Standard (`brand_low_volume`) | $4.50 | $7.00 | 31.6% |
| Brand, Standard (`brand`) | $46.00 | $65.00 | 25.1% |
| Campaign vetting (`campaign_vetting`, shared) | $15.00 | $21.00 | 24.5% |
| Campaign monthly, Low Volume Mixed (`monthly_low_volume`) | $1.50 | $2.25 | 29.2% |
| Campaign monthly, Standard (`monthly`) | $10.00 | $14.00 | 24.5% |
| Number monthly (`number`) | $1.15 | $1.65 | 26.2% |

Setup (brand + vetting + first month + number): Low Volume **$31.90** (cost $22.15); Standard **$101.65** (cost $72.15). Recurring: **$3.90** / **$15.65** per month.

Itemizing is already built: each is its own kind, authorization, reservation and capture. The owner's earlier direction (itemize with a clear total) is a display matter on the onboarding review.

## 7. Worst-case DanceFlow loss

Using the recommended 2¢ structure and list costs; each line is a scenario, not an expectation.

| Scenario | Worst case | Basis |
|---|---|---|
| Per-segment loss at list prices | none (margin 25.1% worst carrier outbound; 14.6% worst inbound reading) | section 5 |
| Twilio list cost rises | break-even at about +43% over worst-carrier outbound cost; the 10% republish rule triggers well before | calc |
| Lost dispute on a spent $100 pack | about **-$82** (received $96.80, Twilio cost about $63.5 already incurred, refunded $100 + $15 dispute fee) unless the negative balance is recovered | Stripe pricing + assumed 63.5% cost/price |
| Dispute exposure ceiling | the $500 balance ceiling bounds credit at risk; five such packs is about -$410 | calc |
| Unrecovered inbound (unknown-sender flood) | D1: $10 ceiling per business, remainder absorbed; the 200 segments/day alert implies about $2.40-$3.10 per day per business if unattended, about $72-$92 per 30 days | Inbound Assessment + cost table |
| Erroneous or duplicate registration absorbed | Standard path $72.15 per business; Low Volume path $22.15 (no markup recovered) | section 2 |
| Rejected correct registration | studio-borne by owner direction 5 | brief revision 2 |
| Failed-message fees | $0.001 each; $10 per 10,000 messages if every one failed | Twilio |
| Compliance replies (STOP confirmation etc.) | about $0.0125 each, absorbed | design D2 |
| Unfunded recurring month after inbound drain | bounded by D1/option-B protection: inbound cannot take funds set aside for the next fee | Inbound Assessment section 8 |
| Refunded unused pack | Stripe fee lost: $1.03 / $1.75 / $3.20 | section 3 |
| Pilot (ConfiDance) | $150 non-spendable setup ceiling and the testing budget are DanceFlow cost by design | Design section 7 item 10 |

## 8. Recommendation (for owner decision)

1. **Do not publish prices yet.** D7 requires Twilio costs verified over one pilot cycle. Use the candidate set as the pilot's hypothesis; publish only after the Console/invoice items in section 10 close and one pilot cycle's invoice lines are reconciled to the ledger (`tw4_credit_record_provider_charge` variance report).
2. **Structure:** fixed fees itemized per section 6; **outbound 2¢ and inbound 2¢ per segment with carrier fees bundled**; no allowance at launch (the Inbound Assessment already chose Option A over an allowance, which departs from the D7 "included allowance" wording: the owner should confirm D7 is satisfied by itemized prepaid pricing).
3. **If the owner wants a lower inbound price**, decide between (b) 3¢ out / 2¢ in and (c) the sub-cent redesign; both are discussed above. A 1¢ inbound is not recommended (loss on every segment).
4. **Set the margin floor explicitly** (this document used 20% after card fees, 5% variance, 1% leakage) so later price changes are tested against the same rule.
5. **Dual control for publication** (tracker follow-up) should land before the first `tw4_price_set`, since one admin can currently publish immediately.

## 9. Can the existing price-kind model express this?

Present kinds (post `20261202`, `20261203`): `brand`, `brand_low_volume`, `campaign_vetting`, `number`, `monthly`, `monthly_low_volume`, `sms_usage` (outbound per segment), `sms_inbound` (inbound per segment). Inbound and outbound are tracked separately (usage attempts in `20261201`; inbound usage table and `sms_inbound` kind in `20261203`; spending split outbound / inbound / uncollected / absorbed). **That separation is preserved by this recommendation.**

| Need | Expressible today? |
|---|---|
| Itemized fixed fees for both tiers | **Yes** (all six kinds exist) |
| Separate outbound and inbound per-segment prices | **Yes** (`sms_usage`, `sms_inbound`) |
| Whole-cent per-segment prices (2¢/2¢ or 3¢/2¢) | **Yes, no schema change** |
| Sub-cent per-segment prices ($0.017 / $0.019) | **No.** `customer_price_cents int > 0` on the price list; `unit_price_cents int` on usage attempts and inbound usage; ledger entries are integer cents. Needs numeric/milli-cent price columns plus a rounding or accrual rule for charges |
| Expected provider cost per segment ($0.0127) | **No (internal only).** `provider_cost_cents int` can hold 1 or 2 only; margin and variance reporting for sms kinds would be coarse. The exact per-message provider price is stored separately as `evidence_price_micros numeric`, so real cost evidence is not lost |
| Per-carrier surcharges as separate prices | **No, and not recommended.** One active price per kind (unique index); reservation happens before the carrier is known; would need a carrier lookup and a post-send variable charge |
| Dual-control price publication | **No** (`tw4_price_set` single admin, immediate; tracker A-13/U-2 follow-up) |
| Included allowance with metered overage (D7 wording) | **No** (inbound assessment explicitly deferred it; needs per-month counter state) |

Minimum change for the recommended structure: **none**. Optional internal-accuracy change: a numeric expected-cost column (or milli-cent cost) on the price list.

## 10. Needs the Twilio invoice/Console or the accountant before publishing

**Twilio invoice/Console** (nothing contacted here):
1. Read the A2P fee article directly in the Console: brand, secondary vetting, campaign vetting, monthly by use case, refundability.
2. Which brand and campaign tier ConfiDance (and a typical studio) is eligible for; whether its MIXED campaign is $1.50 or $10 per month (existing pre-review ticket #29647095).
3. Download `SMSPricing.csv` and settle the ambiguous Verizon and "all other" rows (inbound SMS carrier fees).
4. Whether Twilio bills carrier fees on `undelivered` and `failed` messages, and what `price` the Message resource returns for each (affects the leakage and failed-fee assumptions).
5. Actual per-message invoice price versus list for the pilot, and the real carrier mix and segments per message from the pilot (replaces every assumption in section 2).
6. Any ISV volume discount or contract terms; any tax Twilio charges DanceFlow.
7. Whether Low Volume Mixed throughput (about 2,000 segments/day toward T-Mobile) fits a pilot studio's volume.

**Stripe** (not contacted): the written clarification request on closed-loop prepaid credit is drafted and unsent; the actual Stripe fee on the account (may differ from list if custom).

**Accountant / counsel**: sales tax on setup, recurring and per-segment charges and on prepaid credit at top-up vs consumption; nexus and registrations; resale treatment of Twilio costs; revenue and breakage treatment of prepaid balances; unclaimed property; refund and closure terms (all unresolved per owner direction 6); treatment of pilot costs and the absorbed loss reserve.

## 11. Assumptions to replace with data

85/15 outbound/inbound split and 1.3 segments per message (assumed); carrier mix 35/37/28 (record); 5% variance reserve and 1% compliance leakage (assumed); Stripe pack mix (assumed 50/30/20); 63.5% cost-to-price used in the dispute scenario; competitor pricing not researched.
