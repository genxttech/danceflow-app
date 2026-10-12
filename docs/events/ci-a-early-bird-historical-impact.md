# CI-A — Historical early-bird overcharge: impact query draft (NOT EXECUTED)

Status: **draft only**. These queries have **not** been run against PROD. Running them requires separate owner
authorization, a scratch PROD workdir, and a read-only session. No refunds, credits, or order changes follow from
running them; any customer remedy is a separate owner decision.

## What went wrong, and when

| Date (UTC) | Commit | Cart checkout (`/api/events/cart/checkout`) behaviour |
|---|---|---|
| 2026-05-28 00:22 | `35a064b4` Add early bird ticket pricing | Applied the early-bird price (cutoff exclusive). |
| 2026-05-31 20:30 | `f931a295` Add documents and e-signature workflows | **Regression:** early-bird logic removed; every cart line charged `event_ticket_types.price` (regular). Public ticket cards kept showing the early-bird price. |
| CI-A release | this slice | Cart, native app, form and cards share one rule; the order item stores `metadata.pricing` evidence. |

The impact window is therefore **[first PROD deployment containing `f931a295`, first PROD deployment containing
CI-A)**. The commit time is only a lower bound. Before running anything, replace the placeholders with the actual Vercel
production deployment times of those two commits.

Paths that are **not** in scope as overcharges:
- **Native app** (`/api/student/events/[eventId]/checkout`, `metadata.source = 'student_app_event_tickets_v1'`): this
  path priced early bird itself, with an inclusive cutoff (`<=`). At worst it under-charged at the exact cutoff
  millisecond, which favours the customer.
- **Staff "sell tickets"**: sells at the regular price by design.
- **Resume after signing** (`startEventOrderPayment`): charges the stored `event_order_items.unit_price` snapshot,
  so the overcharge was fixed at cart-creation time. The order's `created_at` is the pricing instant.

## Limits of the evidence

- **Ticket definitions are mutable, and no history exists.** `event_ticket_types` has no audit or history table.
  Organizers can change `price`, `early_bird_enabled`, `early_bird_price` and `early_bird_ends_at` at any time.
  The only time evidence is `updated_at`, maintained by trigger `set_event_ticket_types_updated_at`. Confirm the trigger
  exists on PROD before relying on it.
- If `ticket.updated_at <= order.created_at`, the definition we read today is the definition that was in force at
  purchase. Otherwise the definition at purchase time is **unknown**.
- Pre-CI-A order items carry no pricing metadata. Only post-CI-A items have `metadata.pricing`.
- The DB charged amount must be corroborated by Stripe (read-only lookup by `stripe_payment_intent_id`, separately
  authorized). The DB alone is not proof of what was captured.

## Evidence standard (proposed)

| Class | Criteria (all must hold) | Use |
|---|---|---|
| **A — Confirmed overcharge** | Cart order (`event_cart_v1`) created inside the window; paid (`payment_status = 'paid'`) with a succeeded payment; ticket `updated_at <= order.created_at`; at that definition, early bird enabled, `0 <= early_bird_price < price`, `order.created_at < early_bird_ends_at`; charged `unit_price = price` (regular); Stripe captured amount equals `event_orders.total_amount`. | Eligible for the owner's remedy decision. Overcharge = `(unit_price - early_bird_price) * quantity`, net of any refund already issued. |
| **B — Probable, unverifiable** | Same as A except the ticket `updated_at > order.created_at` (definition changed after purchase), but the current definition would imply an overcharge. | Not eligible on DB evidence alone. Needs corroboration (organizer confirmation of the early-bird terms at that date, or a contemporaneous page or marketing record). |
| **C — Excluded** | Unpaid, cancelled or expired orders; fully refunded; native or staff sources; orders after the CI-A release; lines already charged at or below the early-bird price. | No action. |

The impact is reported per order (not per registration) as charged, early-bird expected, overcharge and refunded
amounts, plus the class. Nothing is aggregated into a customer-facing figure before owner review.

## Queries (read-only; run inside a read-only transaction)

```sql
-- 0. Session guard: every query below runs inside this read-only transaction, which is rolled back at the end.
begin transaction read only;
set local statement_timeout = '60s';

-- 1. Prerequisite: the updated_at trigger exists (otherwise class A cannot be established).
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.event_ticket_types'::regclass and not tgisinternal;

-- 2. Candidate lines with evidence class.
with params as (
  select timestamptz '<PROD_DEPLOY_TIME_OF_f931a295>' as window_start,
         timestamptz '<PROD_DEPLOY_TIME_OF_CI_A>'     as window_end
),
lines as (
  select o.id                   as order_id,
         o.studio_id,
         o.event_id,
         o.status               as order_status,
         o.payment_status,
         o.created_at           as priced_at,      -- cart pricing instant (resume charges this snapshot)
         o.paid_at,
         o.total_amount         as order_total,
         o.currency,
         o.stripe_payment_intent_id,
         i.id                   as item_id,
         i.ticket_type_id,
         i.quantity,
         i.unit_price           as charged_unit,
         i.total_price          as charged_line
  from public.event_orders o
  join public.event_order_items i on i.order_id = o.id
  cross join params p
  where o.metadata ->> 'source' = 'event_cart_v1'
    and o.created_at >= p.window_start
    and o.created_at <  p.window_end
    and i.ticket_type_id is not null
)
select l.*,
       t.price                                   as regular_now,
       t.early_bird_enabled,
       t.early_bird_price,
       t.early_bird_ends_at,
       t.updated_at                              as ticket_updated_at,
       (t.updated_at <= l.priced_at)             as definition_unchanged_since_purchase,
       ((l.charged_unit - t.early_bird_price) * l.quantity) as candidate_overcharge,
       case
         when l.payment_status is distinct from 'paid' then 'C_unpaid'
         when t.updated_at <= l.priced_at
              and l.charged_unit = t.price then 'A_pending_stripe_and_refund_check'
         else 'B_unverifiable_definition_changed'
       end as provisional_class
from lines l
join public.event_ticket_types t on t.id = l.ticket_type_id
where t.early_bird_enabled
  and t.early_bird_price is not null
  and t.early_bird_price >= 0
  and t.early_bird_price < t.price
  and t.early_bird_ends_at is not null
  and l.priced_at < t.early_bird_ends_at        -- exclusive cutoff
  and l.charged_unit > t.early_bird_price
order by l.studio_id, l.event_id, l.priced_at;

-- 3. Lines whose ticket changed after purchase (class B reach). Lists every in-window cart line on a ticket edited
--    afterwards, whether or not the CURRENT definition shows an early bird, because a since-removed early bird would
--    otherwise be invisible to query 2.
with params as (
  select timestamptz '<PROD_DEPLOY_TIME_OF_f931a295>' as window_start,
         timestamptz '<PROD_DEPLOY_TIME_OF_CI_A>'     as window_end
)
select o.id as order_id, o.event_id, o.created_at as priced_at, o.payment_status,
       i.ticket_type_id, i.quantity, i.unit_price as charged_unit,
       t.price as regular_now, t.early_bird_enabled, t.early_bird_price, t.early_bird_ends_at, t.updated_at
from public.event_orders o
join public.event_order_items i on i.order_id = o.id
join public.event_ticket_types t on t.id = i.ticket_type_id
cross join params p
where o.metadata ->> 'source' = 'event_cart_v1'
  and o.created_at >= p.window_start and o.created_at < p.window_end
  and o.payment_status = 'paid'
  and t.updated_at > o.created_at
order by o.event_id, o.created_at;

-- 4. Payment and refund state per candidate order (net amount actually kept). Replace the id list with the order
--    ids from query 2.
select r.order_id,
       count(distinct r.id)                          as registrations,
       sum(p.amount)                                 as paid_amount,
       sum(coalesce(p.refund_amount, 0))             as refunded_amount,
       sum(p.amount) - sum(coalesce(p.refund_amount, 0)) as net_kept,
       string_agg(distinct p.status, ',')            as payment_statuses,
       string_agg(distinct p.stripe_payment_intent_id, ',') as payment_intents,
       sum(p.platform_fee_amount)                    as platform_fee
from public.event_registrations r
left join public.event_payments p on p.registration_id = r.id
where r.order_id = any (array[<ORDER_IDS>]::uuid[])
group by r.order_id;

-- 5. Control: cart orders in the same window that WERE charged the early-bird price (expected none between
--    f931a295 and CI-A). A non-zero count means the regression window or the hypothesis is wrong; stop and re-check.
with params as (
  select timestamptz '<PROD_DEPLOY_TIME_OF_f931a295>' as window_start,
         timestamptz '<PROD_DEPLOY_TIME_OF_CI_A>'     as window_end
)
select count(*)
from public.event_orders o
join public.event_order_items i on i.order_id = o.id
join public.event_ticket_types t on t.id = i.ticket_type_id
cross join params p
where o.metadata ->> 'source' = 'event_cart_v1'
  and o.created_at >= p.window_start and o.created_at < p.window_end
  and t.updated_at <= o.created_at
  and t.early_bird_enabled and t.early_bird_price < t.price
  and o.created_at < t.early_bird_ends_at
  and i.unit_price = t.early_bird_price;

rollback;
```

## Handling

- Output contains customer purchase data. Keep it inside the scratch workdir; do not paste rows into chat, PRs or
  tickets. Report counts and per-studio totals only, until the owner decides otherwise.
- After the scan: per-order class table, Stripe corroboration (read-only, separately authorized), owner decision on
  any remedy. The refund ledger is a separate slice; no refunds or credits are issued from this work.
