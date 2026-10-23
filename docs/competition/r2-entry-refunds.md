# R2 — CI-D: Competition entry refunds (design)

Status: **DESIGN — awaiting owner review of decisions D1–D8 and note §4.1 (§4).** Only the money-independent cascade-gap fix (§3.4) is implemented; the ledger, RPCs, webhook and Stripe calls are not written.
Branch `competition-r2-entry-refunds` from main `973f36da`. Migration slot reserved:
`20270103090000_competition_r2_entry_refunds.sql` (+ rollback, + `sql-tests/test_T_competition_r2_entry_refunds.sql`).
Nothing here is applied to hosted DEV/PROD; Stripe is test mode only.

## 1. Problem (as the code stands on main)

| Area | Today | Source |
|---|---|---|
| Staff refund | `refundEventRegistrationAction` refunds the **whole PaymentIntent** (no `amount`) and, since PAY-WH-1A, **refuses** any order-backed registration (`order_backed_registration_payment_locked`). Every competition registration is order-backed, so **there is no staff refund path for competition orders at all.** | `src/app/app/events/[id]/registrations/actions.ts` ~2193–2225 |
| Stripe-dashboard refund | Webhook `updateEventPaymentRefundByPaymentIntent` spreads the cumulative refund pro-rata across every `event_payments` row on the PaymentIntent. A competition order has one registration → one row, so a partial refund sets the registration `payment_status = 'partial'` and no entry changes; a full refund sets `refunded`, and `sync_competition_entries_from_registration` withdraws every entry. | `src/app/api/payments/webhook/route.ts` ~1667–1745 |
| Cascade gap | The registration trigger withdraws entries but **does not scratch their heat placements**; only `change_competition_entry_lifecycle` does both. A fully refunded order can therefore leave `scheduled` heat entries for withdrawn entries. | `20261107090000_phase10a…` §sync; `20260620_competition_generation_operations_v1.sql` |
| Order state | `event_orders.payment_status` already allows `refunded` / `partially_refunded`; nothing writes them for competition orders. | `20260520000100_event_cart_v1_foundation.sql` |
| Accounting | One `event_payments` row per order → one `competition_entry_revenue` entry whose `net = amount − fees − refund_amount`. Refunds reduce net on the same entry (no `*_refund` category). | `sync_event_payment_accounting_entry` (10C) |

**Doc-vs-code conflict.** `docs/competition/phase10c1-launch-readiness.md` says "A staff refund of a
competition registration refunds the entire purchase and withdraws all of its entries." That is false on
main: PAY-WH-1A removed that path. The truthful statement today is "staff cannot refund a competition
order in DanceFlow; a Stripe-dashboard refund is recorded order-wide (full refund withdraws all entries,
partial refund changes no entry)." R2 corrects the doc in the same PR, and replaces the statement with the
per-entry behaviour once R2 ships.

## 2. Order shape that refunds must respect

`start_competition_registration` (10C) writes, per order:

- exactly **one** `event_registrations` row and, at settlement, **one** `event_payments` row (Stripe direct
  charge on the studio's connected account, with `application_fee_amount` for the platform);
- one `event_order_items` row per entry: `item_type = 'competition_entry'`, `reference_id = entry.id`,
  `total_price` = that entry's base + per-dance lines (gross, **before** discounts), and
  `event_competition_entries.order_item_id` pointing back to it;
- zero or more cart-level `add_on` rows (`revenue_class = competition_entry`): **fee** lines
  (flat per person / per entry / per dance, percentage) at their price, and **discount** lines stored with
  `total_price = 0` and the discount in `metadata.discount_amount`;
- `event_orders.total_amount = subtotal − discount` = the amount charged.

So `Σ entry items + Σ fee add_ons − Σ discounts = captured amount`. An entry's `total_price` is therefore
**not** what the buyer paid for that entry whenever the order had a discount.

## 3. Proposed design

### 3.1 Ledger — `event_order_item_refunds` (new)

One row per (refund request × order item). Columns (cents as `bigint`, matching 10C quote math):

`id`, `event_id`, `order_id`, `order_item_id`, `entry_id` (nullable; set for `competition_entry` items),
`refund_request_id` (groups the lines of one staff action / one Stripe refund), `amount_cents > 0`,
`currency`, `status ∈ {reserved, succeeded, failed, canceled}`, `source ∈ {staff, stripe_dashboard}`,
`stripe_refund_id` (unique per item when set), `stripe_account_id`, `reason`, `withdraw_entry boolean`,
`requested_by`, timestamps. Append-only except the `status` / `stripe_refund_id` transitions done by the
RPCs (trigger-protected, same pattern as the competition history tables). RLS: event managers read;
no direct writes for any role (all writes through `security definer` RPCs granted to `service_role`).

**Invariant (checked under `FOR UPDATE` on the order):** for each item,
`Σ amount_cents where status in (reserved, succeeded) ≤ refundable_cap(item)` (cap defined by D1/D2), and
for the order, `Σ ≤ captured amount`. Reserved rows count against the cap so two concurrent staff refunds
cannot both pass.

### 3.2 RPCs

1. `reserve_competition_order_refund(p_actor, p_event_id, p_order_id, p_lines jsonb, p_reason, p_request_id)`
   — locks the order, verifies the actor can manage the event, the order belongs to the event
   (**cross-event rejection**), the order is `paid`/`partially_refunded` with a PaymentIntent and stored
   `stripe_account_id`, every line's item belongs to the order, amounts are positive integers within the
   remaining cap; inserts `reserved` rows. **Idempotent on `p_request_id`**: replaying the same request
   returns the existing rows; replaying with different lines raises.
2. `finalize_competition_order_refund(p_request_id, p_stripe_refund_id, p_status)` — moves `reserved` →
   `succeeded` / `failed` / `canceled`; on `succeeded`, applies the cascade (3.4) and recomputes order and
   payment state (3.5). Idempotent: same terminal status is a no-op; a terminal→different-terminal change is
   only allowed `succeeded → failed/canceled` (Stripe refund reversal), which releases the cap but does
   **not** un-withdraw entries (re-entry is a staff decision).
3. `record_competition_stripe_refund(p_payment_intent_id, p_stripe_account_id, p_stripe_refund_id, p_amount_cents, p_status)`
   — webhook entry point. If a ledger row already carries `p_stripe_refund_id` (or the refund's
   `metadata.danceflow_refund_request_id` matches), it delegates to `finalize`. Otherwise the refund was made
   outside DanceFlow → handled per **D6**.

### 3.3 Staff flow (`/app/events/[id]/competition/registrations`)

Per order: entries with item amount, already-refunded, remaining refundable, heat lock state; fee lines;
a form to pick entries/fee lines and amounts (default = remaining cap), a reason, and "also withdraw the
entry" (default on for full-entry refunds). Server action:
reserve (RPC) → `stripe.refunds.create({ payment_intent, amount, metadata: { danceflow_refund_request_id } },
{ stripeAccount: <stored owner>, idempotencyKey: 'comp-refund:' + request_id })` → finalize with the
returned refund's status (`pending` stays `reserved` until the webhook). Stripe error → finalize `failed`
(releases the cap). Ownership uses the same stored-owner rule as PAY-DC-2A; no proof-and-stamp path is
needed because PAY-WH-1 settlement always stores `stripe_account_id` (missing → refuse).

`refundEventRegistrationAction` keeps refusing order-backed registrations; its error now points staff to
the competition order refund screen for competition orders. Non-competition event-cart orders stay out of
scope (follow-up "shared normal-event refund cleanup", 10C §11 item 5).

### 3.4 Withdraw / scratch cascade

On a `succeeded` line with `withdraw_entry`: the entry → `withdrawn` with
`app.competition_entry_fee_handling = 'refund'|'partial_refund'` (existing audit trigger records it) and its
`scheduled`/`checked_in` heat entries → `scratched` — the same two writes as
`change_competition_entry_lifecycle`, but executed inside the RPC (that function is `security invoker` and
re-checks `can_manage_event_competition`, which the service-role webhook path cannot satisfy).
**Locked/certified heats:** an entry placed in a `locked`/`certified` heat is never rewritten — see **D7**.

R2 also fixes the cascade gap in §1: when the registration trigger withdraws entries on a full refund /
cancel / payment failure, it scratches the `scheduled` / `checked_in` placements of exactly those entries
(`danced` placements are floor history and stay). **Implemented** (Section 1 of the migration; does not
depend on D1–D8): it pins the 10A md5 `fabd4052…` before replacing, the R2 body is md5 `36577701…`, and the
rollback restores the exact 10A body (refusing unless the R2 body is live). Placements scratched while R2 was
live stay scratched after a rollback.

### 3.5 Order / payment / registration state

After every finalize: `refunded_cents = Σ succeeded` for the order.
- `event_orders.payment_status`: `paid` → `partially_refunded` → `refunded` (= captured amount).
- `event_payments.refund_amount` = order `refunded_cents` (cumulative, never lowered except on reversal);
  `status = 'refunded'` only when full. The existing accounting trigger then reduces
  `competition_entry_revenue` net — no new category (see D8).
- `event_registrations.payment_status`: `partial` while partially refunded, `refunded` when full (the
  existing trigger then withdraws any remaining entries).

### 3.6 Webhook (`src/app/api/payments/webhook/route.ts`) — minimal, called out

One guarded branch in `handleStripeRefundUpdated`: if the PaymentIntent belongs to a competition order
(`event_orders` with competition items), call `record_competition_stripe_refund` **per refund object** and
skip `updateEventPaymentRefundByPaymentIntent` for that PaymentIntent (the RPC owns `event_payments` for
competition orders). No other webhook paths change; package and non-competition event behaviour is
untouched. Shared with PAY-WH / Twilio owners — the diff will be isolated to that branch + one import.

## 4. Decisions needed from the owner (money movement)

Recommendation first; each is a one-word answer.

| # | Question | Options | Recommendation |
|---|---|---|---|
| **D1** | Per-entry refund cap when the order had a discount | (a) entry's gross `total_price`; (b) **net paid** = gross minus the entry's pro-rata share of order discounts (largest-remainder in cents, deterministic) | **(b)**. (a) lets staff refund an entry for more than the buyer paid for it; the order-level cap still prevents over-refunding the charge, but entry-level accounting would be wrong. |
| **D2** | Cart-level fee lines (per-person, per-entry, percentage service fees) | (a) separately refundable lines staff pick explicitly; (b) auto-refund a share when an entry is refunded; (c) never refundable in DanceFlow | **(a)**. Nothing refunded automatically; per-person fees in particular don't map to one entry. |
| **D3** | Platform application fee on refunds (direct charges on the connected account) | (a) keep it — `refund_application_fee` off; studio's balance funds the whole refund (today's behaviour for every other event refund); (b) return it pro-rata | **(a)**, unchanged from today, unless you want competition refunds to cost the platform its fee. Stripe never returns its own processing fee either way. |
| **D4** | Refund without withdrawing (goodwill / price adjustment), and withdraw without refund | allow both / require refund ⇒ withdraw | **Allow both.** Withdraw-without-refund already exists (`change_competition_entry_lifecycle`, fee handling `retain`). |
| **D5** | Who may refund | event managers (studio owner/admin, organizer owner/admin/staff — same as entry management) / owners+admins only | **Owners + admins only** (studio owner/admin, organizer owner/admin); organizer *staff* can withdraw but not move money. |
| **D6** | Refund made in the Stripe dashboard (no DanceFlow request) | (a) record order-level, unattributed; full refund withdraws all entries (today), partial changes no entry and opens a staff exception to attribute it; (b) auto-allocate pro-rata across entries | **(a)**. Auto-allocation guesses which entry the organizer meant. |
| **D7** | Entry in a locked/certified heat | (a) refund money allowed, withdrawal refused (correction workflow); (b) refuse the refund too | **(a)**. Money and results are separate; the entry stays in the certified heat. |
| **D8** | Accounting | keep net-reduction on `competition_entry_revenue` / add a `competition_entry_refund` category | **Keep** for R2 (accounting categories are shared with normal events; separate refund categories stay the 10C §11 item 3 follow-up). |

### 4.1 Design note for owner review (not resolved): full refund vs entries in locked/certified heats

Today, when a registration becomes `refunded` (including a full Stripe-dashboard refund through the webhook),
`sync_competition_entries_from_registration` withdraws its entries **except** those placed in a `locked` or
`certified` heat. Its `NOT EXISTS (… lock_state in ('locked','certified'))` guard skips them, and R2 keeps that
guard. So the trigger does **not** contradict D7(a) "withdrawal refused in locked heats". What it leaves is a
silent inconsistency:

- the money is fully returned, and the registration and payment show `refunded`;
- the entry stays `confirmed` in the locked/certified heat, with its placement `scheduled`, and nothing tells
  staff about it (no exception, no audit row: the skip leaves no trace).

Options for the owner (no recommendation is implemented yet):
(a) keep the entry, but record a staff exception ("refunded entry still in a locked/certified heat, needs
the correction workflow") when the trigger skips it;
(b) the same exception, and also block or flag dashboard full refunds in the staff UI while any entry is
in a locked or certified heat (Stripe-side refunds cannot be blocked);
(c) leave as is (results stand; finance is reconciled outside DanceFlow).

This interacts with D6 and D7. Whatever is chosen, the trigger change stays limited to the exception
write; certified heats are never rewritten.

If D1 = (b) and D2 = (a) are accepted, the cap for an entry item is
`gross_cents − discount_share_cents − Σ(reserved+succeeded)` and for a fee line
`line_cents − Σ(reserved+succeeded)`; the order cap is the captured amount.

## 5. Tests (planned)

SQL (`test_T_competition_r2_entry_refunds.sql`, local Postgres only; Section 1 cases run now, the rest are recorded as pending-decision): refund ≤ item cap; refund ≤ order
captured amount across items; concurrent reservations cannot exceed the cap; idempotent replay of
`p_request_id` and of `finalize`; cross-event / cross-order item rejection; non-manager rejection; failed
refund releases the cap; reversal releases the cap without un-withdrawing; cascade withdraws the entry and
scratches unlocked heat entries only; locked/certified heat → refund succeeds, withdrawal refused; full
refund → order `refunded`, registration `refunded`, accounting net = 0; dashboard-refund path per D6;
registration trigger now scratches heat placements.

Unit: refund line validation + cents math (discount share, largest remainder), Stripe call parameters
(amount, idempotency key, `stripeAccount` = stored owner, metadata), error mapping, webhook branch routing.

QA matrix (developer-owned, Stripe test mode on a local stack): single-entry full refund, one-of-three
partial, fee-line refund, discounted order, double-submit, Stripe failure, dashboard partial / full refund,
locked heat, wrong-event URL tampering. Payment-integrity review notes go in the PR.

## 6. Out of scope

Non-competition event-cart per-ticket refunds; buyer self-service refunds/withdrawals; `*_refund`
accounting categories; refunds of free (unpaid) orders (nothing to refund — withdraw only); ACH.
