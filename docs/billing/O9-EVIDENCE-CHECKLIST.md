# O9 evidence checklist: the grandfathered $129/month Pro subscription (DanceAbel Ballroom Studio)

Status: documentation and read-only verification only. Nothing here changes Stripe, a database, a subscription, an entitlement or a registry row.
Do not paste API keys, card numbers or full payment details anywhere. IDs (`cus_`, `sub_`, `price_`, `cs_`, `in_`) are fine.

## 0. Owner pricing decision (recorded 2026-10-30)

These are the owner's stated terms. They are a **decision to implement and a target to verify**, not yet verified against Stripe or any original agreement.

1. DanceAbel Ballroom Studio's $129/month Legacy Pro price is protected for **12 paid months following its July 9, 2026 trial end**.
2. After the protected period (ending **July 9, 2027**) the subscription transitions to the **then-applicable regular Pro rate, with advance notice**.
3. This is **not** a permanent $129/month concession.
4. Existing **Organizer Suite access stays at no additional charge throughout the same protected period**. Its treatment after the period is an **open owner decision**: nothing may assume it ends, and nothing may assume it continues.
5. DanceAbel counts as **one of the 25 Founder positions**. The cap allocation is not reopened.
6. The subscriber's current billing terms are preserved until the transition is separately authorized. Nothing is changed on the subscription, price, discounts, schedule or customer.

Price protection and feature protection are **two separate protections with separate end dates and separate post-period rules**. Records, code and notices must never share one "protected until" value for both.

Not yet established (verify before specifying any transition):
- The original terms, if any, that the subscriber was given (evidence in sections 2 and 3). Where the evidence is missing the finding is "not established"; the owner decision above is then the operative term, recorded as an owner decision and not as a recovered contract.
- The actual billing-period boundaries (section 1, items 4 and 8).
- How the Organizer Suite access is actually provisioned today (section 1, item 9).

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

## 5. What to send back

Paste the section 1 and 2 answers into the chat (IDs and dates are fine, no secrets). I will return the evidence findings and a proposed classification, with duration and renewal recorded as found or "not established". The first findings go to the owner for separate review before anything is drafted for the registry.
