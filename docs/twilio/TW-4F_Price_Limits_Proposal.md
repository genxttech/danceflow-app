# TW-4F price limits: PROPOSAL for owner approval (D4-1, F2)

Status 2026-10-31. **Nothing here is approved or enforced.** The numbers are proposals; the migration ships them as rows of `studio_sms_price_limits` with `approved = false`, which the price functions ignore. The only enforced bound today is the blanket 10,000,000-cent CHECK on the request table (the UI can enter at most 9,999,999). The owner approves values by an owner-level update (`approved = true`, `approved_by_note`, `approved_at`); a row then bounds every later proposal for the kind: customer price, provider cost, provider cost as a percentage of the customer price, and the step change against the active price. No financial limit is selected or activated by this document or by the PR.

## Inventory (sources: `20261122090000` price kinds and defaults, `TW-4F_Pricing_Recommendation.md` revision 2 and section 14, `TW-4F-3b_Pricing_Proposal.md`, `TW-4F_Pilot_Readiness_Checklist.md`, the localStack fixtures)
The price list accepts exactly eight kinds (check constraint after `20261202`/`20261203`): `brand`, `brand_low_volume`, `campaign_vetting`, `number`, `monthly`, `monthly_low_volume`, `sms_usage`, `sms_inbound`. No migration seeds a price (the list is empty until published). Provider costs are Twilio list prices to verify on the first invoice. The provisional retail direction is **$0.03 outbound and $0.02 inbound per billable segment** (Pricing Recommendation section 14, preserved below; not published). Cents are integers; sub-cent prices do not exist in the ledger.

| Kind | Observed / candidate range (customer; provider cost) | Fixture values (tests only) | Proposed customer ceiling | Proposed provider-cost ceiling | Proposed max step per approval | Rationale |
|---|---|---|---|---|---|---|
| `brand` | $46.00 cost; candidates $56 to $65 ($5,600 to $6,500 cents); provider 4,600 | 1000/700, 4600/4600, 100/50 | 10,000 ($100) | 6,000 ($60) | 50% | about 1.5x the highest candidate; a Standard brand costs $46 |
| `brand_low_volume` | $4.50 cost; candidates 600 to 1,450 | 700/450 | 2,000 ($20) | 1,000 ($10) | 50% | LVS brand fee is $4.50; the highest candidate is $14.50 |
| `campaign_vetting` | $15 cost; candidates 1,900 to 2,100 | 1500/1500, 1500/1000 | 3,500 ($35) | 2,500 ($25) | 50% | about 1.7x candidate; vetting is $15 and non-refundable |
| `number` (monthly rent) | $1.15 cost; candidates 150 to 165 | 200/115, 500/400, 14500/100 (a test at the $150 cap) | 500 ($5) | 300 ($3) | 50% | monthly rent for one local number; 14,500 appears only as a test of the entity cap |
| `monthly` (campaign monthly, standard) | $10 cost; candidates 1,200 to 1,400 | 1000/150, 1500/1400, 1800/1000 | 2,500 ($25) | 1,500 ($15) | 50% | standard MIXED is $10; low-volume is separate |
| `monthly_low_volume` | $1.50 cost; candidates 200 to 250 | 250/150 | 600 ($6) | 400 ($4) | 50% | LVS campaign fee is $1.50 |
| `sms_usage` (outbound per segment) | provisional **3** (about 2.4x list cost 1.27); provider about 1 to 2 | 3/1, 1000/400, 9/1 | 6 | 3 | 50% (3 to 4 ok, 3 to 5 not) | stays on the $0.03 direction with room for the 4 to 5 cent alternative; cost 1.3 cents all-in |
| `sms_inbound` (per segment) | provisional **2** (cost about 1.0 to 1.3) | 3/1 | 4 | 3 | 100% | the $0.02 direction; 2 to 4 is the widest sane move |

Provider/customer bound: `max_provider_pct_of_customer = 100` for every kind in the proposal, i.e. a price may not be set below its expected cost. Pricing Recommendation section 14.5 models negative-margin SCENARIOS (multi-segment, failed-message fees), not a negative-margin price list; if the owner wants to allow a deliberate loss-leader, relax the value for that kind in the data, not in code.

## Why the provider-cost bound matters (reconciler)
The usage reconciler (`20261205090000`, about line 393) refuses to auto-settle a provider price when `provider price > greatest(unit_provider_cost_cents, 1) x 10000 x segments x 5`. `provider_cost_cents` is therefore a CONTROL INPUT: if two administrators publish an inflated provider cost (the blanket cap would allow 10,000,000 against a 1-cent customer price), the anomaly check is silently disabled for every later attempt. Bounding `max_provider_cents` per kind (for example 3 cents for `sms_usage`) and `max_provider_pct_of_customer` keeps the threshold within a range the owner has approved.

## Regression tests (written so the numbers are DATA)
`localStack.pricedual` PD-28: the shipped rows are eight kinds, none approved, and enforce nothing; an owner-approved row bounds customer price, provider cost, the ratio and the step; removing the row lifts the bound; no API role can write the table. PD-09b: the blanket 10,000,000 cap and the allowance of provider above customer when no approved row exists. Changing a value is a data change plus no code change.

## Decision needed from the owner
Approve, change or reject each row (or approve none and keep the blanket cap). Until approved, the blanket cap is the only bound.
