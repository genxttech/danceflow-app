# TW-4F-3b: SMS pricing proposal (DRAFT for owner approval)

Status 2026-10-19. **Nothing here is approved or published.** Owner decision 2 asked for a cost-plus proposal with current provider costs, margins and separately disclosed registration, campaign, number, recurring and messaging fees. The price list in the database is empty until the owner approves exact prices (`tw4_price_set`, platform admin); nothing can be authorized without a published price. Amounts are US dollars; Twilio amounts were read from Twilio's public pages on 2026-10-19 and **must be re-verified against the Twilio invoice/Console before any price is published** (fees changed on 2025-08-01 and Twilio states prices may change without notice).

## 1. Provider costs (Twilio, what DanceFlow pays)

| Item | Cost | Frequency | Source / confidence |
|---|---|---|---|
| Standard brand registration (includes secondary vetting of $41.50) | $46.00 | one time | Twilio pricing and fees help article ([support.twilio.com](https://support.twilio.com/hc/en-us/articles/1260803965530-Pricing-and-Fees-for-A2P-10DLC-Service)); an older marketing page shows $44, so treat $46 as current. Confirm on the invoice. |
| Low-Volume Standard brand registration (no automatic secondary vetting) | $4.50 (to verify) | one time | Brand registration fee without the $41.50 secondary vetting (Twilio pricing article above; Low-Volume Standard brands skip automatic secondary vetting, ticket #29647095 answer 6). **Must be confirmed on the Twilio invoice before pricing.** |
| Campaign vetting | $15.00 | one time per campaign, non-refundable | Campaign vetting FAQ ([help.twilio.com](https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ)) |
| Campaign monthly fee, MIXED, low-volume | $1.50 | monthly, billed at approval then each month | same pricing article |
| Campaign monthly fee, MIXED, standard | $10.00 | monthly | same article. **Which tier a Standard-brand MIXED campaign falls into must be confirmed with Twilio before pricing**; the table below uses $10 (conservative). The FAQ gives a $1.50 to $10 range by use case. |
| Local phone number | $1.15 | monthly | Twilio US SMS pricing page ([twilio.com](https://www.twilio.com/en-us/sms/pricing/us)) |
| Outbound SMS | $0.0083 | per segment | same page |
| Carrier fee, outbound | $0.0035 AT&T, $0.0045 T-Mobile, $0.0050 Verizon, $0.0042 other / US Cellular $0.0050 | per segment | same page (a layout caveat on the Verizon/other rows; verify) |
| Inbound SMS (replies, STOP, HELP) | $0.0083 + carrier fee | per segment | same page |
| Failed-message processing | $0.0010 | per failed message | same page |

Planning blend for outbound: about $0.0083 + about $0.0042 = **$0.0125 per segment** (carrier mix dependent). Stripe fees on the top-up (cards) are DanceFlow's cost too: about 2.9% + $0.30, i.e. roughly $1.03 on a $25 pack (4.1%), $1.75 on $50 (3.5%), $3.20 on $100 (3.2%) (verify against the Stripe account).

## 2. Candidate price lists (customer prices, rounded up)

Every fee is shown to the studio as its own line (decision 2). The margin column is over Twilio cost only; the Stripe processing cost on top-ups is a separate decision (absorb, or build into the per-segment price).

| Item | Cost | Option A: cost + 25% | Option B: cost + 40% | Option C: flat per-item markup |
|---|---|---|---|---|
| Brand registration (one time) | $46.00 | $58.00 | $65.00 | $56.00 (+$10) |
| Brand registration, Low-Volume Standard (one time, if confirmed) | $4.50 | $6.00 | $6.50 | $14.50 (+$10) |
| Campaign vetting (one time) | $15.00 | $19.00 | $21.00 | $19.00 (+$4) |
| Campaign, monthly (standard MIXED, if confirmed) | $10.00 | $12.50 | $14.00 | $12.00 |
| Campaign, monthly (low-volume MIXED, if confirmed) | $1.50 | $2.00 | $2.25 | $2.50 |
| Phone number, monthly | $1.15 | $1.50 | $1.65 | $1.65 |
| Outbound SMS per segment (all-in, carrier fees included) | about $0.0125 | $0.016 | $0.018 | $0.017 |
| Inbound SMS per segment (all-in) | about $0.0125+ | $0.016 | $0.018 | $0.017 |

Notes for the decision:
- Setup total for a studio under Option A with a standard campaign: $58 + $19 + first month $12.50 + number $1.50 = **$91.00** (cost $72.15). Option B: $101.65 (cost $72.15).
- The ConfiDance founder pilot ($150 cumulative cap) covers Option A setup ($91.00) and leaves about $59 for messaging (roughly 3,700 segments at $0.016); each fee-bearing action still needs its own explicit authorization.
- Per-segment pricing should be quoted per *segment* (160 GSM-7 characters; fewer with emoji or accents); the studio-facing page needs a plain explanation.
- Taxes: whether prepaid communications credit is taxable, and in which states, is a question for the owner's accountant before launch (not decided here).
- Fixed published prices mean the studio is never re-charged for a Twilio price change mid-flight (decision 7); DanceFlow absorbs ordinary variances, with a review threshold (section 3).

## 3. Variance and risk limits (decision 7)

DanceFlow absorbs ordinary provider-cost variances against the published price. Safeguards: every actual Twilio charge is recorded once (`tw4_credit_record_provider_charge`) with its variance; proposed limits for owner approval: investigate any single variance above $2.00 or any month where total variance exceeds 5% of billed amounts; re-publish prices (never edit) when Twilio's list price changes by more than 10%; a negative-balance exposure report per legal business. Prices already published stay fixed for operations already authorized.

## 4. What the owner must approve before anything is published

1. Pick an option (or give a margin) per row; confirm campaign tier with Twilio (standard $10 vs low-volume $1.50) and whether to offer both.
2. Per-segment price and whether Stripe processing is built into it.
3. Fee presentation: separate lines (recommended by decision 2) and the wording for each.
4. Tax treatment (accountant).

## 5. Price-list kinds (20261202090000, DRAFT: nothing published)

Each registration path has its own price-list kind, so a Low-Volume Standard studio is never reserved or charged the Standard (secondary-vetted) price. All rows above stay DRAFT until the owner approves exact prices; the migration publishes none.

| Row above | Price-list kind | Path |
|---|---|---|
| Brand registration | `brand` | Standard |
| Brand registration, Low-Volume Standard | `brand_low_volume` | Low-Volume Standard (verified) |
| Campaign vetting | `campaign_vetting` | both (one vetting fee per campaign) |
| Campaign, monthly (standard MIXED) | `monthly` | Standard |
| Campaign, monthly (low-volume MIXED) | `monthly_low_volume` | Low-Volume Standard (verified) |
| Phone number, monthly | `number` | both |
| SMS per segment | `sms_usage` | both |

Publishing a low-volume price is a separate owner approval (`tw4_price_set`, platform admin). Without it, every low-volume authorization is refused (TW008) and a paid Low-Volume Standard run stops before any Twilio write (`tier_unpriced`).
