# TW-4F U-2: validated pricing recommendation (docs only), revision 2

Prepared 2026-10-23; revised 2026-10-24 after the owner's U-2 review decisions. Based on main `fc507ee1`. **This is a candidate recommendation, not an approved retail price list.** No price is set or published, `tw4_price_set` is not run, no schema change is implemented, and no hosted, Twilio or Stripe action was taken.

Every provider figure is a **public list price, to verify on the Twilio invoice/Console**. None is confirmed.

> **Update 2026-10-29 (owner direction): Option A is the preferred PROVISIONAL retail candidate: outbound $0.03 and inbound $0.02 per billable segment.** Not activated, not published. Section 14 re-reads the public prices, checks segment accounting and models realistic usage scenarios, including the cases where the structure loses money. Option B (sub-cent) stays documented in sections 6-7 and 9 as the alternative if pilot cost evidence argues for cost-based pricing. Unchanged controls: prepaid credit, no automatic top-ups, separate inbound/outbound tracking, STOP/START/HELP never charged or blocked.

## 0. Owner direction applied in this revision

| # | Direction | Where handled |
|---|---|---|
| 1 | Inbound must be priced more favorably than outbound | Sections 5, 8 (no equal-rate recommendation) |
| 2 | Equal 2¢/2¢ is not a final price | Withdrawn as a recommendation; kept only as a comparison row |
| 3 | Investigate a bounded sub-cent design (ledger arithmetic, reservation, reconciliation, rounding, refunds); no migration | Sections 6, 9 |
| 4 | 20% contribution margin is a provisional planning target | Used as the test everywhere, labelled provisional |
| 5 | Defer any included inbound allowance until pilot evidence | Section 8 |
| 6 | Verify ambiguous carrier fees and A2P charges with provider-specific evidence | Section 2 |
| 7 | Preserve prepaid controls, separate inbound/outbound tracking, STOP/START/HELP | Sections 6.6, 9 |
| 8 | Document sub-cent vs the 3¢ outbound / 2¢ inbound alternative | Section 7 |

## 1. What changed since revision 1

1. **The Verizon / "all other" inbound ambiguity is resolved from Twilio's own page HTML (section 2).** The inbound carrier cells are blank, i.e. no inbound carrier fee is listed. Revision 1 treated Verizon inbound as $0.005 or $0.007; that was wrong. Inbound is therefore about **$0.0025 per segment cheaper to deliver than outbound** (blended $0.0102 vs $0.0127), which is what makes a favorable inbound price viable.
2. Revision 1's recommendation of 2¢ inbound = 2¢ outbound is **withdrawn** (owner direction 2). In whole cents, 1¢ inbound loses money (-12% expected), so a whole-cent differential is 3¢ out / 2¢ in.
3. The sub-cent question is now analyzed concretely (sections 6-7, 9). Result: a per-message rounding rule collapses a sub-cent differential for the common one-segment text; only a carried-remainder accumulator preserves it, and that touches the money path (section 9).
4. The 20% margin is a provisional planning target, not a floor.

## 2. Provider list prices and verification evidence (access 2026-10-24 unless stated)

| Item | List price | Frequency | Evidence | Status |
|---|---|---|---|---|
| Outbound / inbound SMS base (long code) | $0.0083 / $0.0083 per segment | per segment | [US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us), page HTML table read directly ("Pricing current as of October 2026") | public list price, to verify on invoice |
| Same, outbound US base in Twilio's CSV | AT&T, T-Mobile, Other all $0.00830 | | [SMSPricing.csv](https://assets.cdn.prod.twilio.com/pricing-csv/SMSPricing.csv) downloaded 2026-10-24 (1,070 rows) | confirms the base outbound rate only; **the CSV carries no carrier fees and no inbound rows for the US**, so it cannot settle the carrier cells |
| Failed-message fee | $0.0010 per message ending "Failed" | | US SMS pricing page; the linked [Failed Message Processing Fees](https://help.twilio.com/articles/27502337507483-Failed-Message-Processing-Fees) article returned only a title to my tool | public list price |
| Local number | $1.15 per month | monthly | US SMS pricing page HTML | public list price |
| Standard brand incl. secondary vetting | $46.00 one time (vetting $41.50) | one time | [A2P fee article](https://support.twilio.com/hc/en-us/articles/1260803965530-Pricing-and-Fees-for-A2P-10DLC-Service) | **not directly readable (403); search extraction only; verify in Console** |
| Low Volume Standard brand | $4.50 one time (was $4.00 until 2025-08-01) | one time | same extraction; the 2022 [changelog](https://www.twilio.com/en-us/changelog/us-a2p-10dlc-low-volume-standard-brand-registration-available-in-twilio-console) (read directly) still says $4 and is stale; it gives eligibility: EIN, under 6,000 segments/day | as above |
| Campaign vetting | $15.00 per campaign | one time | same extraction; [Campaign vetting FAQ](https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ) returned a title only | as above; refundability unconfirmed |
| Campaign monthly, Low Volume Mixed / Standard | $1.50 / $10.00 | monthly | same extraction; which tier ConfiDance's MIXED campaign falls into is unconfirmed | as above |

**Carrier fees, long code SMS: ambiguity resolved from the page's own HTML.** The earlier text extraction flattened empty cells. I downloaded the page HTML and read the table cell by cell (5 value columns incl. carrier name):

| Carrier | SMS out | SMS in | MMS out | MMS in |
|---|---|---|---|---|
| AT&T | $0.0035 | $0.0035 | $0.009 | $0.009 |
| T-Mobile | $0.0045 | $0.0025 | $0.01 | $0.01 |
| **Verizon** | $0.005 | **(blank)** | $0.007 | (blank) |
| US Cellular | $0.005 | $0.0025 | $0.01 | $0.01 |
| **All other carriers** | $0.0042 | **(blank)** | $0.01 | (blank) |

Blank means **no fee is listed**, not proof of $0. Supporting evidence: the same page's RCS table prints an explicit "$0" for Verizon inbound; the toll-free and short-code tables use the same blank pattern. Treat Verizon and other-carrier inbound carrier fees as **none listed**, and confirm on the first invoice. The toll-free and short-code tables differ and are out of scope (long-code 10DLC only).

**All-in list cost per segment** (base $0.0083 + carrier): outbound AT&T $0.0118, T-Mobile $0.0128, Verizon/US Cellular $0.0133, other $0.0125; inbound AT&T $0.0118, T-Mobile and US Cellular $0.0108, Verizon and other $0.0083.

**Blended expected cost** with the record's carrier-mix assumption (AT&T 28 / T-Mobile 37 / Verizon 35, from the 2026-10-20 Inbound Pricing Assessment; assumed, not measured): **outbound $0.012695, inbound $0.010205**. Worst-carrier: outbound $0.0133 (Verizon/US Cellular), inbound $0.0118 (AT&T).

**Stripe** ([stripe.com/pricing](https://stripe.com/pricing), read directly 2026-10-23): 2.9% + $0.30 per successful domestic card payment; dispute $15 per dispute; refunds have no fee but the original fees are not returned; no minimum charge stated.

**Evidence still needed from the provider's own billing** (nothing contacted here): the first invoice lines for carrier fees by carrier and direction; the Console A2P fee table; whether carrier fees are billed on `undelivered`/`failed` messages; the ConfiDance tier and campaign monthly fee (pre-review ticket #29647095).

## 3. Stripe effect on top-ups and net credit

| Pack | Stripe fee | % of face | DanceFlow receives | Loss if refunded unused |
|---|---|---|---|---|
| $25 (minimum) | $1.025 | 4.10% | $23.975 | $1.03 |
| $50 | $1.750 | 3.50% | $48.25 | $1.75 |
| $100 | $3.200 | 3.20% | $96.80 | $3.20 |

Credit equals face value, so every credit dollar carries 3.2%-4.1% processing cost. A pack smaller than $25 would exceed 5.9%; keep $25 as the minimum. Whether to withhold the fee on a refund is an unresolved legal/policy question.

## 4. Record and planning target

3b Design (fixed published prices; DanceFlow absorbs ordinary variance), Pricing Proposal section 3 (investigate a single variance above $2.00 or a month above 5% of billed; republish at a 10% list change), Inbound Assessment (recover ordinary inbound, not at the outbound rate; $10 negative-balance ceiling; compliance traffic never charged), Usage Financials Design (per segment x frozen price; undelivered charged; failed/canceled released), roadmap D7 (no final prices until Twilio costs are verified over one pilot cycle; allowance deferred here per direction 5), tracker U-2/A-13 (publication single-admin today; dual control is a follow-up).

**Provisional planning target: 20% contribution margin** (owner direction 4), tested as:
margin = (price x (1 - Stripe - 1% compliance leakage) - cost x 1.05 variance reserve) / price. It is a test for comparing options, not an approved floor.

## 5. Per-segment options with corrected costs

Margins use blended expected cost (Stripe 3.5%) / the same at Stripe 4.1% / worst carrier at 4.1%.

**Outbound** (cost $0.012695; worst $0.0133)

| Price | Expected 3.5% | Expected 4.1% | Worst carrier 4.1% |
|---|---|---|---|
| $0.017 | 17.1% | 16.5% | 12.8% |
| $0.018 | 21.4% | 20.8% | 17.3% |
| **$0.019** | **25.3%** | **24.7%** | **21.4%** |
| 2¢ | 28.9% | 28.3% | 25.1% |
| 3¢ | 51.1% | 50.5% | 48.4% |

Price that just meets 20%: $0.0178 expected, $0.0186 worst carrier.

**Inbound** (cost $0.010205; worst AT&T $0.0118)

| Price | Expected 3.5% | Expected 4.1% | Worst carrier (AT&T) 4.1% |
|---|---|---|---|
| 1¢ | -11.7% | -12.3% | -29.0% |
| $0.013 | 13.1% | 12.5% | -0.4% |
| $0.014 | 19.0% | 18.4% | 6.4% |
| **$0.015** | **24.1%** | **23.5%** | **12.3%** |
| $0.016 | 28.5% | 27.9% | 17.5% |
| 2¢ | 41.9% | 41.3% | 33.0% |

Price that just meets 20%: $0.0143 expected, $0.0165 worst carrier. **The earlier $0.013 inbound is below target and loses money on AT&T-terminated traffic.** 1¢ loses money on every inbound segment.

**Candidate pairs**

| Pair | Out margin (exp / worst) | In margin (exp / worst) | Inbound discount | Schema |
|---|---|---|---|---|
| **A. 3¢ out / 2¢ in** | 51% / 48% | 42% / 33% | 33% | none |
| **B. $0.019 out / $0.015 in** | 25% / 21% | 24% / 12% | 21% | sub-cent (section 6) |
| B'. $0.018 out / $0.014 in | 21% / 17% | 19% / 6% | 22% | sub-cent |
| (comparison only) 2¢ / 2¢ | 29% / 25% | 42% / 33% | 0% | none |
| (not viable) 2¢ out / 1¢ in | 29% / 25% | -12% / -29% | 50% | none |

Pair A clears the 20% target by a wide margin on both directions but prices outbound at about 2.4x its cost. Pair B sits near the target in the expected case and below it for AT&T-heavy inbound (12%), which is inside the provisional-target tolerance but would need the pilot's carrier mix to confirm. I did not research competitors' prices.

**Carrier fees: bundle, do not pass through.** The recipient's carrier is unknown when the credit is reserved (the reservation is `segments x price` made before sending), and the spread is small (outbound $0.0118-$0.0133). Per-carrier prices would need a carrier lookup and a post-send variable charge outside the reservation. Disclose "carrier fees included".

## 6. Sub-cent design (investigation; nothing implemented)

### 6.1 Where the cents assumption lives today

All amounts are integer cents. The money path is a single multiplication per message: `segments x unit_price_cents`.

| Object | Column(s) | Use |
|---|---|---|
| `studio_sms_price_list` (`20261122`) | `customer_price_cents int > 0`, `provider_cost_cents int >= 0` | one active price per kind; `tw4_price_set(p_kind, p_customer_cents int, p_provider_cents int, ...)` |
| `studio_sms_credit_accounts` | `balance_cents`, `reserved_cents` (bigint) | balance and holds |
| `studio_sms_credit_ledger` | `balance_delta_cents`, `reserved_delta_cents` (bigint); shape check: `usage_charge` delta `< 0`, `usage_refund` delta `> 0` | append-only; **a 0-cent charge cannot be posted** |
| `studio_sms_credit_reservations` | `amount_cents int > 0` | holds for texts and fees |
| `studio_sms_usage_attempts` (`20261201`) | `unit_price_cents`, `unit_provider_cost_cents`, `reserved_cents`, `charged_cents`; `evidence_price_micros numeric` | outbound text lifecycle |
| `studio_sms_inbound_usage` (`20261203`) | `unit_price_cents`, `billable_cents`, `charged_cents`, `uncollected_cents`, `ceiling_cents`, `est_provider_cost_cents` | post-paid inbound |
| Redefinitions | `tw4_usage_begin` (in `20261201`, `20261204`, `20261218`), `_tw4us_charge`, `tw4_usage_settle`, `tw4_usage_resolve`, inbound record function, `tw4_credit_refund_usage`, `tw4_credit_verify`, `_tw4ml_require_room`/`_tw4ml_month_parts`, admin overview `prices` | all compute or read cents |

Existing precedent for finer precision: `evidence_price_micros` already records Twilio's per-message price in micro-dollars (1,000,000 per dollar), so the unit proposed below (micro-dollars; 1¢ = 10,000) is consistent with reconciliation.

### 6.2 Unit and arithmetic

- Per-segment kinds (`sms_usage`, `sms_inbound`) get a price and an expected cost in **micro-dollars** (integer). $0.019 = 19,000; $0.015 = 15,000. Fixed-fee kinds stay whole cents.
- Exact amount of one message: `exact_micros = segments x unit_price_micros` (an integer; no rounding).
- The ledger and balance stay **integer cents**. The sub-cent remainder lives in one new per-business signed counter, the **carry** (`usage_carry_micros`, range -9,999 to 9,999).

### 6.3 Rounding: three candidate rules

| Rule | How it works | Effect on $0.019 out / $0.015 in | Determinism | Verdict |
|---|---|---|---|---|
| **R1 per-message round** | `cents = round_half_up(exact_micros / 10000)` | 1 seg: out 2¢, in 2¢ (1.5 rounds up). 2 seg: out 4¢ (3.8), in 3¢ (3.0). 3 seg: out 6¢, in 5¢ (4.5). | each message's charge is a pure function of the message | **Destroys the differential for single-segment texts** (the common case); at an inbound price below $0.0150 a one-segment text rounds down to 1¢ and loses money |
| **R2 carried remainder (recommended sub-cent design)** | at settlement: `total = carry + exact_micros`; post `floor(total/10000)` cents; new carry = `total mod 10000` | out and in average exactly their sub-cent price; single messages post 1¢ or 2¢ | order-dependent per message, exact in total; the sum of what is posted plus the carry equals the sum of exact amounts at all times | preserves the differential; needs one new invariant |
| **R3 monthly true-up** | post `round(exact/1e4)` per message, then a monthly `usage_rounding` adjustment for the difference | exact per month | per message pure; the monthly job posts a small correction | needs a new ledger kind, a scheduled job and month-boundary handling; studio sees surprise adjustments |

### 6.4 Reservation (outbound)

At `tw4_usage_begin` the reservation is `ceil(segments x unit_price_micros / 10000)` cents, always at least what R2 can charge (a charge is at most `ceil((carry + exact)/10000)`, and carry is below one cent). The funds check, the monthly-limit check (`_tw4ml_require_room`) and the reservation row all stay in whole cents and are conservative by less than one cent. The attempt freezes `unit_price_micros` and `exact_micros` at begin; price changes never affect an open attempt (today's behavior, unchanged).

### 6.5 Settlement, reconciliation, admin resolution

- **Settle** (`_tw4us_charge`): under the existing entity-then-account lock, in the same transaction as releasing the reservation and posting the `usage_charge`: `exact = evidence_segments x frozen micros`; `total = carry + exact`; `cents = floor(total/10000)`; post `-cents` if `cents > 0` (a 0-cent result posts no ledger row and records `charged_cents = 0`, as the existing `not_charged` path already does); set carry to the remainder; record `charged_micros = exact` on the attempt. Overage over the reservation still posts (balance may go negative), as today.
- **Idempotency:** carry only changes inside the transition that moves the attempt to `settled` (attempt row locked `FOR UPDATE`; the state check and the ledger key `usage:sms:<attempt>` remain the single gate). A replay returns before touching carry.
- **Failed / canceled / released:** no charge, no carry change (reservation released), as today.
- **Admin resolve (`tw4_usage_resolve ... charged`)** runs the same function with the admin's segment count.
- **Reconciliation:** provider evidence (`price`, `num_segments`) is unchanged. Added check, per business: `sum(charged_micros of settled attempts and inbound rows) = 10000 x sum(posted usage cents) + carry + 10000 x refunded cents`. This is exact integer equality, evaluated by an extension of `tw4_credit_verify`, and it is a stronger real-time test than today's cents-only reconciliation. The existing gap checks (ledger charge without a settled attempt, etc.) compare cents and keep working because 0-cent attempts already exist.

### 6.6 Inbound (post-paid, never refused) and compliance traffic

- Ordinary inbound: `exact = segments x unit_price_micros (sms_inbound)`; `total = carry + exact`; `due = floor(total/10000)`; `charged = min(due, the existing funds/ceiling/recurring-protection limit)`; `uncollected_micros = 10000 x (due - charged)` (absorbed, recorded); new carry = `total mod 10000`. The D1 ceiling, the PR-248 protections for set-aside and recurring months, the pilot-business zero ceiling and the per-SID idempotency are unchanged, because the limit is computed in cents and applied to `due`.
- STOP/START/HELP stay `compliance`: never charged, never touch the carry, always processed (the database constraint forbidding a charge is untouched).
- Outbound and inbound remain **separately tracked**: separate price kinds, separate tables, separate `exact`/`charged_micros` columns. The carry is shared only as a rounding register; the invariant above can be evaluated per direction by summing each table separately.

### 6.7 Refunds

- Refunds of usage stay **whole cents**: `tw4_credit_refund_usage(p_cents ...)` credits cents against a recorded usage charge and cannot exceed its posted total. The carry is not changed by a refund (refunds remove cents that were really posted). The invariant accounts for it by the refunded-cents term.
- A message that posted 0 cents (carry absorbed it) has nothing to refund; the exact micros stay in the carry. This is a documented property, not a defect: the studio was never debited for it.
- Failed/undelivered messages: failed and canceled are released before any charge (no carry movement); undelivered is charged (design) and, if an admin refunds it, refunds the posted cents.
- Top-up reversals (Stripe refund/dispute) are unchanged: they move cents only.

### 6.8 Studio-facing display

The published price is shown as `$0.019 per message segment`. Statements show whole-cent charges plus a line explaining that sub-cent amounts are carried and billed in whole cents; the carry never exceeds one cent and is forgiven at account closure. Display formatting needs a micro-dollar formatter in `smsCreditView.ts` and the price admin UI.

## 7. Tradeoffs: sub-cent (pair B) vs 3¢ / 2¢ (pair A)

| Dimension | A. 3¢ out / 2¢ in (whole cents) | B. $0.019 out / $0.015 in (sub-cent, carried remainder) |
|---|---|---|
| Satisfies "inbound more favorable" | Yes (33% lower) | Yes (21% lower) |
| Margin vs 20% target | outbound 51%, inbound 42% expected (far above) | outbound 25%, inbound 24% expected (near); inbound AT&T-heavy 12% |
| Studio price vs provider cost | outbound 2.4x cost | outbound 1.5x cost |
| Competitive position | unverified; highest per-segment price of the options | closer to cost; unverified against competitors |
| Schema / money-path change | none | price list, accounts, attempts, inbound table, 8+ functions (section 9) |
| Migration risk | none | medium-high (financial redefinitions; see 9.3) |
| Verification burden | existing suites | new invariant, property and concurrency tests, Opus review |
| Rounding surprises | none | none visible in total; per-message 1¢/2¢ variation |
| Reversibility | trivial (publish a new price) | after attempts exist, forward-fix only; cheapest **before** the first hosted apply |
| Fit to pilot (D7: verify costs over one cycle) | can start now; reprice later by republishing | would delay the first hosted apply until the migration is reviewed |
| Disclosure | simple | needs the carried-remainder explanation |

Decision driver: **timing.** Nothing from `20261123` onward is applied to DEV or PROD (hosted manifest, 2026-10-23), and no price is published, so the tables hold no rows. A sub-cent migration is cheapest, and converts no data, if it lands before the first hosted apply. After the pilot has live attempts and ledger rows it becomes a live-data financial migration.

## 8. Recommendation

1. **Do not publish any price now.** D7 and direction 6 require the carrier fees and A2P charges verified from provider billing, then one pilot cycle.
2. **Fixed fees:** unchanged candidates, itemized (section 10), all provisional.
3. **Update 2026-10-29: the owner selected Option A as the preferred provisional candidate (see section 14).** Original text follows. **Per-segment pricing, two acceptable paths:** (A) **3¢ out / 2¢ in** now, no schema change, with a published intent to reprice after the pilot; or (B) **$0.019 out / $0.015 in** only if the owner accepts the section 9 change set before the first hosted apply. My recommendation: **decide between A and B before any hosted apply of `20261201`/`20261203`.** If the owner will not accept the sub-cent review effort, take A. If the owner wants cost-based pricing, authorize the design review in section 9 now.
4. **Not recommended:** 2¢/2¢ (no inbound benefit), 1¢ inbound (loses money), per-carrier pass-through lines (cannot be reserved), R1 per-message rounding (collapses the differential).
5. **Allowance:** deferred until pilot evidence (direction 5). Roadmap D7's "included allowance" wording is not met by itemized prepaid pricing; the owner should confirm that is intended.
6. Dual control for price publication should land before the first `tw4_price_set` (tracker follow-up).

## 9. Bounded implementation proposal (not authorized; no migration written)

### 9.1 Scope: one forward migration, numbered after `20261227090000`, plus app and tests

Forward-only file (no edits to the merged `20261201`/`20261203`, whose hashes are pinned in the hosted manifest). Applied in the same first hosted batch, so it converts zero rows.

| Object | Change |
|---|---|
| `studio_sms_price_list` | add `unit_price_micros int null`, `unit_cost_micros int null`; check: for `sms_usage`/`sms_inbound` both not null and positive, for fixed-fee kinds both null; keep `customer_price_cents`/`provider_cost_cents` for fixed kinds and set them to `ceil(micros/10000)` for per-segment kinds (informational) |
| `tw4_price_set` | new overload accepting micros for per-segment kinds; the cents version refuses per-segment kinds |
| `studio_sms_credit_accounts` | add `usage_carry_micros int not null default 0 check (abs(usage_carry_micros) < 10000)` |
| `studio_sms_usage_attempts` | add `unit_price_micros`, `unit_cost_micros`, `exact_micros`, `charged_micros`; guard trigger freezes the first three; constraint ties `charged_micros` to `state = 'settled'` |
| `studio_sms_inbound_usage` | add `unit_price_micros`, `billable_micros`, `uncollected_micros`; keep the cents columns as posted amounts |
| Functions redefined (latest versions only) | `tw4_usage_begin` (latest in `20261218`), `_tw4us_charge`, `tw4_usage_settle`, `tw4_usage_resolve`, the inbound record function and `_tw4in_*` ceiling helpers, `tw4_credit_verify` (new micro invariant), admin overviews that print prices and provider-cost estimates |
| Unchanged | `_tw4c_post`, ledger shape check, reservations, top-ups, packs, $500 ceiling, recurring fees, monthly limits (conservative `ceil` reservation), pilot ceiling, spend events, provider charges |
| App | micro-dollar formatter and price input in `smsCreditView.ts`, `creditStore.ts`; the numeric-price consumers `smsRecurring.ts`, `providerFeeOps.ts`, `numberStore.ts`, `provisionStore.ts`, `registrationPath.ts` read fixed-fee kinds only and should not change (verify) |
| Tests | property test: random message sequences (mixed directions, segments, refunds, replays) keep the invariant exact; concurrency on one business; month boundary; zero balance/ceiling/protected-recurring cases for inbound; replay of settle/callback; rollback test; update every suite that seeds a per-segment price |

### 9.2 Not changed (direction 7)

Prepaid controls (funds check, holds, kill switch, monthly limit, negative-balance blocking), the separate inbound and outbound tracking, compliance-critical STOP/START/HELP processing (free, never refused, never touches the carry), the no-auto-top-up rule, the $150 pilot ceiling.

### 9.3 Migration risk

| Risk | Rating | Why / mitigation |
|---|---|---|
| Redefining money-path functions that already exist in up to three versions | **High** | take the latest definition of each from the merged file, change only the arithmetic, diff against it; a stale copy silently reverts later fixes. Two prior incidents in this area: CRLF function bodies and per-version uniqueness (project memory) |
| Carry corruption under concurrency or replay | **High** | all carry writes inside the existing entity-then-account lock and the attempt's single state transition; invariant check in `tw4_credit_verify`; property and concurrency tests |
| Hosted order and idempotence | Medium | forward file must apply after `20261227090000`; refuse if per-segment prices already exist with different semantics (none today) |
| Inbound ceiling and protection arithmetic | Medium | limit computed in cents on `due`; reuse existing logic; new cases for carry at the ceiling |
| Display/consumer drift (cents shown for a micro price) | Medium | informational `ceil` cents column; app uses micros for per-segment kinds; test every price reader |
| Rollback | Low before first apply (no rows); **forward-fix only** once attempts exist | follow the existing drain procedure |
| Manifest/hashes | Low | new row in the hosted manifest; merged files untouched |

### 9.4 Required before any build

Owner decision A vs B; a dedicated design review (Opus) of sections 6.3-6.7; confirmation of the carrier-fee evidence from the first invoice; a separate authorization for the migration and its hosted apply.

## 10. Fixed fees (unchanged candidates, provisional)

Cost / (1 - 4.1% - 25%), rounded; every line itemized in the existing kinds (`brand`, `brand_low_volume`, `campaign_vetting`, `number`, `monthly`, `monthly_low_volume`).

| Item | Twilio list | Candidate | Net margin after 4.1% |
|---|---|---|---|
| Brand, Low Volume Standard | $4.50 | $7.00 | 31.6% |
| Brand, Standard | $46.00 | $65.00 | 25.1% |
| Campaign vetting | $15.00 | $21.00 | 24.5% |
| Campaign monthly, Low Volume Mixed | $1.50 | $2.25 | 29.2% |
| Campaign monthly, Standard | $10.00 | $14.00 | 24.5% |
| Number monthly | $1.15 | $1.65 | 26.2% |

Setup totals (brand + vetting + first month + number): Low Volume $31.90, Standard $101.65; recurring $3.90 / $15.65 per month. All figures depend on the A2P fee evidence in section 2.

## 11. Worst-case DanceFlow loss (per scenario, not an expectation)

| Scenario | Worst case |
|---|---|
| Per-segment loss at pair A / pair B list prices | none in expected or worst-carrier outbound; pair B inbound AT&T-heavy margin 12% (positive) |
| Twilio list cost rise | outbound break-even (before the variance reserve) at about +114% (pair A) / +36% (pair B) over worst-carrier cost; the 10% republish rule triggers first |
| Lost dispute on a spent $100 pack | about -$82 (received $96.80, Twilio cost about $63.5 incurred at 2¢-equivalent, refunded $100 + $15) unless the negative balance is recovered; five packs at the $500 ceiling about -$410 |
| Inbound drain by an unknown sender | $10 ceiling per business then absorbed; the 200 segments/day alert implies about $2.04-$2.36 per day at inbound cost, about $61-$71 per 30 days |
| Duplicate or erroneous registration absorbed | Standard path $72.15; Low Volume path $22.15 |
| Failed-message fee | $0.001 each |
| STOP/HELP confirmations | about $0.0127 per outbound confirmation, absorbed |
| Sub-cent only: carry | never above one cent per business (invariant); forgiven at closure |

## 12. Needs the Twilio invoice/Console or the accountant before publishing

**Twilio** (nothing contacted): first invoice lines by carrier/direction; Console A2P fee table and vetting refundability; ConfiDance tier and campaign monthly fee; carrier-fee billing on undelivered/failed; actual per-message price vs list; any ISV discount; any tax charged to DanceFlow.

**Stripe**: the written clarification is drafted and unsent; actual account fee.

**Accountant / counsel** (unresolved per owner direction): sales tax on setup, recurring and per-segment charges and on prepaid credit; nexus; resale treatment; prepaid-balance revenue and breakage; unclaimed property; refund and closure terms; treatment of the sub-cent carry and pilot costs.

## 13. Assumptions to replace with pilot data

85/15 outbound/inbound split and 1.3 segments per message (assumed); carrier mix 28/37/35 (record); 5% variance reserve and 1% compliance leakage (assumed); Stripe pack mix 50/30/20 (assumed); 63.5% cost/price in the dispute scenario; competitor pricing not researched.

## 14. Option A provisional candidate: verification and usage scenarios (2026-10-29)

Candidate (provisional, not activated, not published): **outbound $0.03 and inbound $0.02 per billable segment**, whole cents, carrier fees bundled, itemized fixed fees per section 10. No schema change.

### 14.1 Re-check of public prices (read 2026-10-29)

I re-read Twilio's US SMS pricing page HTML and the SMSPricing.csv. Both are **unchanged since 2026-10-24**: base $0.0083 out and in; long-code carrier fees as in section 2 (Verizon and "all other" inbound blank); number $1.15; failed-message fee $0.001; the page still says "Pricing current as of October 2026". The CSV is byte-identical to the 2026-10-24 download and carries only the $0.0083 base. These are **public list prices; "actual" costs cannot be verified without a Twilio invoice or Console**, which this work does not have. The A2P fee article (brand, vetting, campaign monthly) is still unreadable to my tool (403), so the fixed-fee costs remain search extractions.

### 14.2 Segment accounting check

- The database estimates segments at send time (`_tw4us_segments`): GSM-7 160 single / 153 concatenated (152 when extension characters are present, which count twice), UCS-2 70 / 67 with astral characters as two units; 1 to 10 segments, otherwise refused. This only sizes the **reservation**.
- **The charge is the provider's count.** Settlement bills `num_segments` from the Message resource (for `delivered`, `undelivered`, `read`, or `sent` older than 72 hours) times the price frozen at begin; a count outside 1 to 10, above the estimate plus 2, or any media sends the attempt to admin review. Revenue therefore tracks Twilio's own billed segments, so a mis-estimate cannot create a per-segment loss; it only affects how much credit is held while the text is in flight.
- Carrier fees are billed by Twilio per segment, so cost and revenue both scale with segments. A UCS-2 (emoji) message costs the studio 2-3x a GSM-7 message of the same length and DanceFlow's margin per segment is unchanged.
- Inbound segments come from the webhook's segment count (`NumSegments`); only plain SMS (`SM...`, no media) with a published inbound price is billable. STOP/START/HELP are classified `compliance` and never charged.
- **Not verifiable offline:** whether Twilio bills the carrier fee on `undelivered` and `failed` messages, and what `num_segments` it reports for UCS-2 edge cases. Both need the first invoice lines.

### 14.3 Unit economics at Option A

Per billable segment, after Stripe (3.5% expected / 4.1% worst), 1% compliance leakage and a 5% variance reserve:

| | Price | List cost (expected / worst carrier) | Net per segment (expected / worst) | Margin (expected / worst) |
|---|---|---|---|---|
| Outbound | $0.03 | $0.01269 / $0.0133 | $0.0153 / $0.0145 | 51% / 48% |
| Inbound | $0.02 | $0.01021 / $0.0118 (AT&T) | $0.0086 / $0.0068 | 43% / 34% |

Both directions are far above the provisional 20% target. Option A is therefore price-protective rather than cost-based: outbound is about 2.4x list cost.

### 14.4 Scenario model

Basis: 1,000 billable segments, 85% outbound / 15% inbound unless stated (assumed), carrier mix AT&T 28 / T-Mobile 37 / Verizon 35 (record), 5% variance reserve, opt-outs at 1% of outbound segments (each costs one inbound plus one confirmation, never charged), list prices above. "Margin" is contribution after Stripe, provider cost and the absorbed items listed.

| Scenario | Revenue | Net | Margin |
|---|---|---|---|
| S1 baseline | $28.50 | $14.37 | 50.4% |
| S2 worst carrier outbound (all Verizon/US Cellular) | $28.50 | $13.83 | 48.5% |
| S3 inbound-heavy, 50/50 | $25.00 | $11.99 | 48.0% |
| S3b inbound only, all AT&T | $20.00 | $6.91 | 34.6% |
| S4 every top-up a $25 pack (Stripe 4.1%) | $28.50 | $14.20 | 49.8% |
| S5 opt-outs at 5% of outbound segments | $28.50 | $13.59 | 47.7% |
| S5b opt-outs at 10% | $28.50 | $12.62 | 44.3% |
| S6 10% of outbound texts fail (fee, no revenue) | $28.50 | $14.29 | 50.1% |
| S7a Twilio cost +30% | $28.50 | $10.43 | 36.6% |
| S7b Twilio cost +50% | $28.50 | $7.80 | 27.4% |
| S7c Twilio cost +100% | $28.50 | $1.24 | 4.3% |
| S7d variance 20% instead of 5% | $28.50 | $12.52 | 43.9% |
| S8 5% of inbound events are photos (inbound MMS, not billable) | $28.50 | $14.20 | 49.8% |
| S10 pilot business: inbound uncollected (no inbound debt) | $25.50 | $11.48 | 45.0% |
| **S9 unknown-sender flood: 90% of inbound beyond the ceiling, uncollected** | **$7.60** | **-$3.95** | **-52.0%** |
| S11 stacked: +30% cost, Stripe 4.1%, 5% opt-outs, 10% failures | $28.50 | $9.16 | 32.1% |

**Break-even:** the whole mix breaks even only if Twilio list cost is about **2.0-2.1x** today's; at +100% the margin is 4%. The 10% republish rule triggers long before.

### 14.5 Where Option A produces negative margin

None of these come from the per-segment list prices; they are the unbilled or absorbed categories, each negative by design:

| Case | Cost per event to DanceFlow | Revenue | Why it exists |
|---|---|---|---|
| STOP/START/HELP inbound plus confirmation | about $0.023 (up to $0.025) per opt-out | none | compliance traffic is never charged (database constraint) and must work at zero balance |
| Failed outbound text | $0.001 fee | none (released) | failed and canceled are not charged |
| Inbound photo (MMS) | about $0.023 ($0.0165 + carrier; $0.0255-$0.0265 on AT&T and T-Mobile) | none | only plain SMS is billable; media is recorded unbilled |
| Inbound beyond the $10 negative-balance ceiling | $0.0083-$0.0118 per segment | none (uncollected) | the text is never refused (D1) |
| Pilot business inbound with no credit | same | none | pilot has ceiling 0, so inbound is charged only from available credit |
| Unknown or unresolved outcome | the message cost if later billed with no reservation | none until settled/admin-resolved | unknown outcomes are never charged automatically |
| Lost dispute on a spent $100 pack | about -$82 | refunded | Stripe |
| Refunded unused top-up | Stripe fee ($1.03 / $1.75 / $3.20) | refunded | Stripe keeps its fee |
| Settlement overage past the reservation | up to 2 segments x price beyond the hold | charged, but balance may go negative | the message already went out |

The unbounded one is the flood case (S9): without a cap, absorbed inbound is limited only by the $10 ceiling per business and the 200-segments-a-day alert. At the $0.0102-$0.0118 inbound cost that is about $61-$71 per business per 30 days if left unattended.

### 14.6 Hidden sensitivities

- If the blank Verizon and "all other" inbound cells actually carry the same fee as outbound, inbound cost rises to about $0.0133 and the inbound margin falls from 43% to about 26%, still positive.
- If the 1% leakage were 5%, outbound margin drops about 4 points.
- Option A margin is 2.5x the provisional target. If pilot invoices confirm the cost, the owner may prefer to reprice toward B or to a lower whole-cent pair; republishing is cheap (a new price row), whereas going to sub-cent after live rows exist is not (section 7).

### 14.7 Remaining approval gates (all still closed)

1. Verify costs against the first Twilio invoice/Console (carrier fees by direction, undelivered/failed billing, A2P fees, ConfiDance tier). Nothing is authorized to obtain them.
2. D7 pilot cycle, then owner approval of exact prices.
3. Dual-control (or documented single-admin) decision for `tw4_price_set`, then publication. No pricing activation.
4. Counsel/CPA review of credit terms, sales tax, refunds, closure and unclaimed property.
5. Stripe's written answer on closed-loop prepaid credit (request drafted, unsent).
6. Hosted migrations, live SMS, Twilio provisioning and any fee-bearing operation: each needs its own explicit authorization, none given.
