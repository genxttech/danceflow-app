# O9 evidence checklist: the grandfathered $129/month Pro subscription (DanceAbel Ballroom Studio)

Status: documentation and read-only verification only. Nothing here changes Stripe, a database, a subscription, an entitlement or a registry row.
Do not paste API keys, card numbers or full payment details anywhere. IDs (`cus_`, `sub_`, `price_`, `cs_`, `in_`) are fine.

## 0. Owner-confirmed policy (recorded 2026-10-30)

**Everything in this section is OWNER-CONFIRMED policy.** It is a decision to implement and a target to verify. It is **not** a Stripe record and not a recovered agreement. Items marked UNVERIFIED below have not been matched to Stripe, the hosted databases or any document.

Pro pricing:
1. DanceAbel Ballroom Studio pays **$129/month for the first 12 paid months beginning July 9, 2026**.
2. Grandfathered pricing ends **July 9, 2027**.
3. The subscription then transitions to the **then-applicable regular Pro rate, with advance notice**. It is **not** a permanent $129/month concession.

Organizer Suite:
4. Included **at no additional charge during the grandfathered period**.
5. The complimentary entitlement **expires July 9, 2027**.
6. From July 9, 2027 Organizer Suite requires a **separately purchased paid add-on**. If it is not purchased, access **must end** when the complimentary entitlement expires.
7. **Historical Organizer Suite data is preserved**; it is never deleted when access expires.
8. The system must **not** automatically purchase the add-on, charge the studio, or silently extend complimentary access.

Founder allocation and current state:
9. DanceAbel keeps its **Founder position (1 of 25)**. The cap allocation is not reopened.
10. Nothing is changed now on the existing Stripe subscription or on any entitlement.

The pricing grandfather and the complimentary Suite entitlement **share an expiration date but are independently identifiable protections** (separate records, separate end handling, separate audit). Records, code and notices must never share one "protected until" value for both.

UNVERIFIED (what the checklist below is for):
- The original terms, if any, that the subscriber was given (sections 2 and 3). Where the evidence is missing the finding is "not established"; the owner policy above is then the operative term, recorded as a dated owner decision and not as a recovered contract.
- The actual billing-period boundaries, and whether 12 paid months end on July 9, 2027 (section 1, items 2, 4 and 8). The effective date is derived from verified periods. Any difference from the owner-stated dates is reported to the owner, not resolved by assumption.
- How the Organizer Suite access is provisioned today (Stripe item, coupon, manual grant) and whether any end date is already recorded (section 1, item 9; section 4).
- Whether the hosted `usage_addon_entitlements` table has a unique index on `(studio_id, feature_key)` (section 4). If it does, a paid add-on would overwrite the complimentary grant row instead of coexisting with it.

Known so far (owner-supplied, not independently verified): Live account `acct_1TKgL3EY0sTayNiS`, Price `price_1TdDHwEY0sTayNiSIe1nD3Lg` ($129/month).

## 1. Stripe Dashboard (Live mode, view only; never click Edit, Update, Cancel or Refund)

Record each answer. If a step has no result, write "none found" rather than skipping it.

| # | Where | What to record | Settles |
|---|---|---|---|
| 1 | Product catalog > Price `price_1TdDHwEY0sTayNiSIe1nD3Lg` > Subscriptions, status All | Every subscription on this Price: `sub_` id, customer, status, created date. Exactly one? Is it DanceAbel? | `stripe_subscription_id`, `stripe_price_id`; whether more than one exists |
| 2 | The subscription page | Metadata (`studioId`, `source`, `planCode`), discount/coupon, **subscription schedule**, **trial end (exact date and time)**, collection method, current period start/end, cancel-at-period-end | Normal self-serve record or not; any hidden discount or scheduled change; whether the trial end is July 9, 2026 |
| 3 | The customer page | `cus_` id, email, name, customer metadata, created date | `stripe_customer_id`; link to the studio |
| 4 | Customer > Invoices | Every invoice: date, period start/end, amount, discount, $0 lines, paid/unpaid. **List the first paid invoice and each following one in order.** | The rate actually billed; **which paid period each month is**; whether 12 paid periods end on July 9, 2027 or on another date (paused, failed, voided or credited periods) |
| 5 | The Checkout Session (`cs_`) that created the subscription | Session id, price shown, custom text, terms consent, metadata | Self-serve Founder checkout vs another route; what was disclosed |
| 6 | The `customer.subscription.created` event | Created through the API (key/source) or by a Dashboard user | A hint about the route only. **It does not decide the classification.** |
| 7 | Settings > Billing > Customer portal | Is "update subscription" or "cancel" enabled? Which prices are offered? | Whether this subscriber can switch or cancel on their own (Check P) |
| 8 | Subscription page > Upcoming invoice / billing cycle | The next invoice date and its period; the billing cycle anchor | Whether period boundaries fall on the 9th of the month, or on a different day |
| 9 | Subscription page > Items | Are there any **other items** (an Organizer Suite item), a coupon or a $0 price that provides the Suite? Or no Suite item at all? | **How Suite access is provisioned**: Stripe subscription item, a coupon-discounted item, or a manual grant outside Stripe |

## 2. Your own records

| # | Search | What to record |
|---|---|---|
| 10 | Mailbox, files, texts, DMs for the customer's email or studio name, and for "founder", "$129", "grandfather", "Organizer Suite", "12 months", "July 2027" | Any agreement, quote, order form or message about price, duration, renewal, cancellation, return or the Suite. Reference by date and sender. |
| 11 | Your recollection, written down and dated | How this subscriber signed up, what you told them about price duration and the Suite. Mark it as recollection, not a document. |
| 12 | Any notice already sent to the subscriber about price change or the Suite | Date, channel, wording. Expected answer: none. |

## 3. How classification works (I propose, you review)

Classification follows evidence about the terms, not how the subscription was created.

- Manual creation alone does not make it a `contractual_exception`. Origination through Checkout alone does not make it `grandfathered_founder_legacy`.
- `contractual_exception` needs evidence of terms that differ from the public offer.
- `grandfathered_founder_legacy` needs evidence that the subscriber took the public Founder offer on its terms.
- Duration and renewal are recorded as found: a stated term, a documented absence of one, or "not established".
- **Neither existing registry kind states a price-protection end date.** With the owner decision in section 0, the likely record is `grandfathered_founder_legacy` with a `terms_reference` that cites the dated owner decision and the evidence; whether to add structured end-date and feature-protection fields first is a design gap needing authorization (D7-RELEASE-READINESS, section 8).
- If the evidence conflicts with the owner decision, the conflict is reported to the owner. It is not resolved by assumption.
- Internal or test studio, or a duplicate: no protection.

Registry fields are permanent once inserted. A wrong value can only be released, not corrected. Nothing is inserted until the owner approves the exact values.

## 4. Optional production row reads (NOT run; need explicit go)

Exact-match lookups once the `sub_`/`cus_` ids are known. Nothing else would be selected.

- `studio_subscriptions` row for that subscription or customer: studio id, status, plan, dates.
- `studios` row for that studio: name, created date, whether it looks internal.
- `legal_agreement_acceptances` for that studio: Terms version accepted and when.
- `usage_addon_entitlements` rows for that studio and `organizer_suite`: `source`, `status`, `period_start`, `period_end`, `stripe_subscription_item_id`, `notes`. This shows how the Suite is provisioned and whether any end date is recorded.
- Catalog only (no row data): the indexes on `usage_addon_entitlements`, specifically whether a unique index on `(studio_id, feature_key)` exists in DEV and PROD.

## 5. Evidence still outstanding for the Suite and notice workflow

| # | Needed | From |
|---|---|---|
| S1 | How the Suite is provisioned today: Stripe item, coupon-discounted item, or `manual_grant` row (section 1 item 9; section 4) | Owner-run Dashboard read; optional row read |
| S2 | Whether any end date is already stored on the Suite entitlement (`period_end`) | Optional row read |
| S3 | Unique index on `(studio_id, feature_key)` in DEV and PROD | Optional catalog read |
| S4 | The paid Organizer Suite add-on price that would apply on and after July 9, 2027, and the regular Pro rate then in force | Owner decision at notice time |
| S5 | Minimum notice period and wording required by applicable law and the Terms; approved channel | Owner and legal |
| S6 | The exact enforcement instant for July 9, 2027 (time zone, start or end of day, relation to the billing boundary) | Owner decision |
| S7 | What the studio may see or export after Suite access ends (data is preserved) | Owner decision |
| S8 | Whether the protected studio's Suite access should survive a payment problem (`past_due`) | Owner decision |

Implementation gaps that would stop the intended transition (price and Suite) are G1 to G12 in `D7-RELEASE-READINESS.md`, section 8.6. None is built, and no Stripe, database, entitlement or notification change is authorized by this document.

## 6. What to send back

Paste the section 1 and 2 answers into the chat (IDs and dates are fine, no secrets). I will return the evidence findings and a proposed classification, with duration and renewal recorded as found or "not established". The first findings go to the owner for separate review before anything is drafted for the registry.
