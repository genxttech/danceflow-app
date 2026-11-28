# TW-4F: final six-price reconciliation (2026-11-18)

Evidence only: the repo price manifest `docs/twilio/pricing/*_pilot_price_manifest.json`, `TW-4F_Pricing_Recommendation.md` sections 2 and 10, `TW-4F_Ticket_B_Pricing_Evidence_2026-11-16.md`, the implemented kinds in `src/lib/sms/priceChange.ts` and `priceMicros.ts`. No Twilio contact. Nothing published or filed.

## 1. The "$20 / $15 / $40" figures

I cannot find campaign "LVC $20", campaign "MNO $15" or "vetting $40" in the repo, the pricing recommendation, the price manifest, the ticket evidence or my notes. The six proposals have been the same since the 2026-10-24 recommendation: brand LV $7.00, vetting $21.00, campaign monthly LV $2.25, number monthly $1.65, plus the two per-segment prices. No figure ever "became" another; nothing was changed between the recommendation, the manifest and now except the inbound price you chose today ($0.013 to $0.0155).

The nearest real Twilio figures, so you can map your numbers:
- "MNO $15": the one-time campaign vetting fee, $15.00 per campaign (non-refundable as far as is known). That is our `campaign_vetting` COST; the retail price is $21.00.
- "Vetting $40": the Standard-brand secondary vetting ($41.50 inside the $46.00 Standard brand registration). It applies to the Standard path only. Low Volume Standard sets SkipAutomaticSecVet, so no secondary vetting is paid on our path. We do not price it in this pilot.
- "Campaign LVC $20": no matching Twilio list figure found. The Low Volume campaign is $1.50 per month (cost) per the ticket and public secondary sources.
If $20/$15/$40 came from a Twilio Console fee screen you have seen, send me that figure and its label (no ticket needed) and I will map it line by line; until then nothing in the recommendation depends on them.

## 2. The six prices (one final recommendation, no unexplained change)

All kinds exist in the implemented schema (`PRICE_KIND_TEXT`: brand, brand_low_volume, campaign_vetting, number, monthly, monthly_low_volume, sms_usage, sms_inbound). The pilot uses six. Margin = 95.9% (after Stripe 4.1% worst case) minus cost/price, the method in the recommendation section 10.

| # | Kind | Charge | Retail | Provider cost | Net margin | Basis |
|---|---|---|---|---|---|---|
| 1 | sms_usage | per segment | $0.017 | $0.012695 | 21.2% | Owner provisional rate; expected carrier mix 28/37/35 (worst carrier 17.7%) |
| 2 | sms_inbound | per segment | $0.0155 | $0.010205 (expected blend) | 30.1% expected; 19.8% worst carrier (AT&T $0.0118) | Owner decision today; was $0.013 (17.4% blended, 5.1% on AT&T). Twilio's written answer says no inbound carrier fee; the public page lists $0.0035 AT&T and $0.0025 T-Mobile/US Cellular. Priced for the public reading. |
| 3 | brand_low_volume | one time | $7.00 | $4.50 (ticket says $4.00) | 31.6% (38.8% if $4.00) | Pass-through plus margin; conservative cost |
| 4 | campaign_vetting | one time, non-refundable | $21.00 | $15.00 | 24.5% | Pass-through plus margin; a rejection costs another $15 |
| 5 | monthly_low_volume | monthly | $2.25 | $1.50 | 29.2% | Low Volume Mixed tier |
| 6 | number | monthly | $1.65 | $1.15 | 26.2% | Local number list price |

Setup bundle at retail (brand + vetting + first month + number): $31.90; provider cost $22.15 (conservative); recurring $3.90 per month at retail, $2.65 cost. Rejected-campaign exposure: another $15 cost. The [PILOT-CAP] ceiling counts customer prices and is not authorization to spend.

Studio billing behavior (kinds and flags as implemented; each flag is off today): one-time kinds (brand, vetting) are itemized once at their gate; monthly kinds (campaign, number) repeat through the recurring/fee-lifecycle path, which is gated off; per-segment kinds are debited from the studio's prepaid ledger by the usage reconciler when usage billing is enabled; sub-cent amounts are kept as micro-dollars with a carry. I have not re-verified every billing path in this pass; the activation checklist re-proves them in isolated QA before any switch.

## 3. What to file
Entries 1, 3, 4, 5, 6 exactly as in the manifest. Entry 2: price $0.0155 (15500 micros); keep the manifest's cost $0.010205 (10205 micros) for consistency with entry 1; the worst-carrier case is explained here, not in the cost field. Only the manifest's inbound price line changes, by the owner's decision; I do not edit the signed-off manifest file.
