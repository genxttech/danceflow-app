# PRICING-P1 — Studio subscription pricing (Git-only)

Status: draft for review. Nothing here is deployed or applied to Stripe/DB/env.

## Pricing matrix

| Plan | Before (Founder / "regular" in code) | Approved Founder (now in code) | Provisional regular (config only, gated) |
|---|---|---|---|
| Starter | $49 / $59 | **$59** | $89 |
| Growth | $79 / $99 | **$99** | $149 |
| Pro | $129 / $159 | **$159** | $249 |
| Organizer Suite | $12 / $19 | unchanged | unchanged |

Provisional regular prices live in `plans.ts` as `provisionalRegularAmountMonthlyCents`. They are read only
when `REGULAR_PRICING_ACTIVATED=true` (exact string; anything else is OFF). Not approved for customers.

## Behavior

- `FOUNDER_PRICING_ACTIVE` (existing) still controls Founder vs. non-Founder.
- Monthly studio checkout (`/api/billing/checkout`) is **fail-closed**: Founder → `STRIPE_PRICE_STUDIO_<PLAN>_FOUNDER`
  only; non-Founder → `..._STANDARD` only, and only when regular pricing is activated. No fallback chain, no
  database-price fallback. Before creating a Checkout Session the route retrieves the Stripe Price (read-only) and
  requires active, USD, monthly, and `unit_amount` equal to the configured amount; otherwise `price_mismatch`.
- Existing subscribers (managed subscription) are routed to the Stripe billing portal exactly as before; no price
  lookup or re-pricing. Stripe subscriptions keep their existing Price objects.
- Yearly and Organizer Suite checkout are unchanged (no approved annual amounts; organizer out of scope).
- "Founder price · regularly $X/mo" on `/get-started/studio` shows the regular price only after activation.

## Stripe dependency (requires separate owner authorization — NOT done)

1. Create new monthly USD Prices: Starter 5900, Growth 9900, Pro 15900 (new objects; never edit the old Prices).
2. Set `STRIPE_PRICE_STUDIO_{STARTER,GROWTH,PRO}_FOUNDER` to those IDs in DEV, verify, then PROD.
3. Deploy this code **after** step 2 in the target environment. Deploying first makes studio checkout return
   `price_mismatch` (safe refusal) because the existing env Prices carry $49/$79/$129.
4. Later, for regular pricing: create 8900/14900/24900 Prices, set `..._STANDARD` envs, then set
   `REGULAR_PRICING_ACTIVATED=true` and (to end Founder) `FOUNDER_PRICING_ACTIVE=false`.

Rollback: revert the app deployment; envs may stay (old code ignores new behaviour but would again select Price IDs
without an amount check — set envs back to the prior Price IDs if reverting the code).

## Known gaps / decisions

- Existing copy says Founder pricing "lasts for 12 months after your free trial". This predates PRICING-P1 and is
  unchanged; the duration, eligibility and what happens after month 12 are not defined in code. Owner to confirm.
- Platform MRR views (`/platform/accounting`, `/platform/analytics`) estimate revenue as plan list price; legacy
  $49/$79/$129 subscribers will now be estimated at $59/$99/$159 (estimate only, no billing effect).
- Entitlement caps in the approved matrix (instructor limits Owner+1/5/15, locations 1/3/10) and the Payroll Prep
  Growth+ gate are not implemented in `plans.ts`/`access.ts` (roadmap: Payroll gate pending). Not changed here.
- Organizer checkout keeps its legacy env→DB fallback chain (out of scope).
- Knowledgebase impact: none (no help article quotes plan prices).
