# R2 — CI-D: Competition entry refunds (design)

Status: **IMPLEMENTED IN GIT (draft PR #292). Not merged, not applied to any hosted database, no real refunds.**
- **D1–D7 APPROVED** and **D8 superseded by C1** (owner, 2026-10-23). C1, Q1 and Q2 are DECIDED (§4.0).
- The owner authorized a Git-only implementation (local Postgres + Stripe test mode) on 2026-10-23. Implemented:
  - the ledger and allocations;
  - the request / observe / attribute / resolve RPCs;
  - exception scopes (`round_id` + `competitive_effect`);
  - the registration trigger recording E-L/E-C;
  - the dated `competition_entry_refund` accounting entries;
  - the staff refund page and server actions;
  - the guarded webhook branch.
  §7 maps each piece.
- Evidence and open QA items: [`r2-entry-refunds-qa-matrix.md`](r2-entry-refunds-qa-matrix.md).
- Merge, hosted DEV/PROD SQL, real refunds or charges, and deployment each still need separate authorization.
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

> **Superseded by §4.2 (PKG-REFUND-2 pattern):** the ledger becomes `event_order_refunds` (one row per Stripe
> Refund object, `stripe_refund_id` unique, status mirroring Stripe) plus `event_order_refund_allocations` (one
> row per refund × order item, with a separate `participation_outcome`). The caps below are unchanged. With D1
> (b) and D2 (a), the cap for an entry item is `gross_cents − discount_share_cents − Σ(counting allocations)`,
> for a fee line it is `line_cents − Σ(counting allocations)`, and for the order it is the **Stripe captured
> amount** (C2).

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
depend on D1–D8): it pins the 10A md5 `fabd4052…` before replacing, the R2 body is md5 `5fb50278…`, and the
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

## 4. Owner decisions D1–D8 — D1–D7 APPROVED, D8 SUPERSEDED by C1 (2026-10-23)

**Owner approval (2026-10-23):** "Approve D1–D7 as recommended, D8 superseded by C1. Authorize R2 to implement
the ledger, RPCs, webhook branch and accounting entry in Git only (local Postgres + Stripe test mode). No merge,
hosted SQL, real refunds or deploy." The provisional record below is kept for history.

The owner retained the recommendations as **provisional** choices ("No specific changes are requested at this
stage") and asked R2 to confirm them against the existing payment-integrity requirements. **A provisional
decision is not permission to move money.** Real refunds, hosted SQL, and the ledger, RPC, webhook and Stripe
implementation stay unauthorized until the owner approves this document.

| # | Provisional decision | Integrity check (§4.2) |
|---|---|---|
| **D1** ✅ (b) | Per-entry cap = **net paid**: gross entry item minus the entry's share of order discounts, split by largest remainder in cents (deterministic: ties broken by entry `sort_order`, then id) | Consistent |
| **D2** ✅ (a) | Fee lines (per person / per entry / percentage) are refundable as separate lines, and only when staff select them | Consistent |
| **D3** ✅ (a) | Platform application fee kept: `refund_application_fee` off, so the connected account funds the whole refund (today's behaviour) | Consistent |
| **D4** ✅ | Refund without withdrawing, and withdraw without refunding, are both allowed | Consistent, with the §4.1 participation rules |
| **D5** ✅ | **Refund:** studio owner/admin, organizer owner/admin (and platform admin). **Withdraw:** organizer staff too, no refund | Consistent; refund authority = `_paywh1_actor_can_manage_event` |
| **D6** ✅ (a) | Dashboard refund recorded at order level, unattributed; a partial one opens a staff attribution exception | Consistent; refined by §4.1 T6 |
| **D7** ✅ (a) | Refund allowed; withdrawal refused while the entry is in a locked/certified heat | Consistent; refined by §4.1 |
| **D8** | ~~Keep the net reduction on `competition_entry_revenue`~~ **Superseded by C1 (a)**, decided below | C1 resolved the conflict |

### 4.0 Final owner decisions C1 / Q1 / Q2 (2026-10-23) — DECIDED

| # | Decision (owner's words) | Effect on R2 |
|---|---|---|
| **C1** = (a) | "Record each successful refund as a separate accounting entry dated when the refund succeeds. Do not rewrite locked accounting periods." | A new contra-income category `competition_entry_refund` (`entry_class = 'refund'`, `statement_section = 'contra_income'`, `normal_direction = 'debit'`), the competition twin of the existing `event_ticket_refund`. There is one accounting entry per succeeded Stripe refund object (`source_table = 'event_order_refunds'`, `source_id = refund id`), dated on the day the refund succeeds. The competition revenue entry stays at gross and no longer subtracts refunds. A reversal is a separate offsetting entry dated at the reversal; nothing in a locked period is ever updated. **Shared accounting-catalog impact:** one new category row, plus a change to the competition branch of the shared `sync_event_payment_accounting_entry` (§7.4). D8 is superseded, and the `competition_refund_accounting_locked` exception is dropped |
| **Q1** = locked | "Once a heat has been danced, automatic withdrawal is prohibited even if the heat has not yet been formally locked. Use an audited official-resolution process." | An entry with any `danced` placement is treated as locked: it is never withdrawn automatically and raises E-L. **Implemented** for the registration trigger: the md5 is now `5fb50278…`, and the SQL suite proves a danced entry stays `confirmed`. Recording the E-L exception from the trigger waits for implementation authorization |
| **Q2** = block, narrow | "An unresolved exception affecting competitive participation, placements, advancement or result integrity blocks publication of the affected round/results until resolved by an authorized official. Do not block unrelated rounds or results. Financial-only exceptions … do not block results publication." | Every exception scope carries `competitive_effect` and `round_id` (§4.1 E). K0 (coordinated on PR #291, not edited here) adds the publish precondition `COMP_PUBLICATION_BLOCKED_BY_EXCEPTION`, which reads only R2's scope table |

### 4.1 Resolution: refunds vs entries in locked / certified heats

Policy (owner, 2026-10-23, abbreviated):
1. a completed Stripe refund is always recorded and reconciled;
2. before heat lock, the entry may be withdrawn automatically where registration rules allow;
3. after lock, nothing is rewritten silently; an operational exception needs authorized resolution;
4. after certification, historical state is preserved, and changes go only through an audited
   correction / certification-revision workflow;
5. webhooks are idempotent;
6. financial state is kept separate from participation state;
7. there is an admin-visible exception and recovery path, so nothing stays unresolved indefinitely.

**This section is a specification for approval. Nothing in it is implemented except the pre-lock scratch
(Section 1 of the migration, reviewed in §4.3).**

**F. Financial state (money; owned by refund objects and never by participation):**

| Object | States | Transitions (only these) |
|---|---|---|
| `event_order_refunds.status` (one per Stripe Refund object) | `requested` (staff request, no Stripe id yet), `pending`, `requires_action`, `succeeded`, `failed`, `canceled` (Stripe vocabulary verbatim) | `requested → pending / succeeded / failed / canceled` (Stripe create response); `pending / requires_action → succeeded / failed / canceled`; `succeeded → failed / canceled` (reversal). Anything else is a no-op, and the replay is recorded |
| allocation `amount_cents` | counts against the cap while the refund is `requested / pending / requires_action / succeeded`; counts as **refunded** only while `succeeded` | — |
| `event_orders.payment_status` | `paid`, `partially_refunded`, `refunded` | Recomputed absolutely from Σ succeeded vs captured |
| `event_payments.refund_amount / status / refunded_at` | Cumulative Σ succeeded; `refunded` only when full; `refunded_at = greatest(refunded_at, now())` on progress | Written only by the R2 RPC for competition orders (the webhook's pro-rata path is skipped for them) |
| `event_registrations.payment_status` | `paid`, `partial`, `refunded` | Recomputed. This is the **only** coupling from finance to the registration trigger, and the trigger obeys P below |

**P. Participation state (competition; never inferred from money alone):**

| Entry situation at the moment a succeeded refund is applied | Effect (per allocated entry with `withdraw_entry`, or every entry on a full-order refund) | `participation_outcome` |
|---|---|---|
| No placement, or only placements in `open` heats with none `danced` | Entry → `withdrawn` (audit fee handling `refund` / `partial_refund`); `scheduled` / `checked_in` placements → `scratched` | `withdrawn` |
| Placements only in `open` heats, at least one `danced` | **Q1 (decided): treated as locked.** No participation change; exception **E-L** (scope heat = the danced heat) | `exception_open` |
| Any placement in a `locked` heat (none certified) | No participation change; exception **E-L** | `exception_open` |
| Any placement in a `certified` heat | No participation change, ever, from the refund path; exception **E-C** | `exception_open` |
| Refund without withdraw (D4) | No participation change | `not_requested` |
| Reversal (`succeeded → failed / canceled`) | Never re-instates a withdrawn entry automatically; exception **E-R** | unchanged |

An entry with placements in several heats takes the **most restrictive** row (certified > locked > danced > open).
`participation_outcome` is written once per (refund, entry). A replay never applies a second effect.

**E. Exception model.** This reuses `event_order_settlement_exceptions` (PAY-WH-1A): money state, ack/resolve
audit trail, and the leased alert queue (staff email + in-app notification).

| Kind | `money_state` | Raised when | Resolution paths | Resolved only when (gate) |
|---|---|---|---|---|
| `competition_refund_entry_locked_heat` (E-L) | `operational` (alerts) | P row "locked" or "danced" (Q1) | (1) **Withdraw after unlock:** an authorized manager reopens the heat with `set_competition_heat_lock_state(…, 'open', reason)` (audited lock event; refused once certified), then withdraws via `change_competition_entry_lifecycle(…, 'withdrawn', reason, 'refund')`. (2) **Keep entry, refund stands:** note required; the entry competes / remains in results | (1) the entry is no longer `confirmed`; or (2) a resolution note with `resolution = 'keep_entry'` |
| `competition_refund_entry_certified_heat` (E-C) | `operational` | P row "certified" | (1) **Result stands:** financial-only, note required (default; historical state preserved). (2) **Competitive change:** only through the K0 correction workflow (`open_competition_round_correction` → recalculate → approve → publish; every step writes `event_competition_result_events`). R2 never edits a certified heat, entry or result | (1) note; or (2) a K0 `result_events` row for that round referencing the exception id, recorded **after** it |
| `competition_refund_unattributed` (D6) | `captured` | Partial dashboard refund with no DanceFlow request | Staff attribute the amount to items (D1/D2 caps) → normal P rules per attributed entry | Σ attributed = refund amount |
| `competition_refund_reversed` (E-R) | `reversed` | A succeeded refund later failed / was canceled | Staff decide: re-instate the entry (a manual, audited action that is a separate future slice; not automatic) or keep it withdrawn | Note required |

(`competition_refund_accounting_locked` was dropped by C1 = (a): refund entries are dated at success and never
rewrite a locked period.)

**Q2 classification (`competitive_effect` per scope row):**

| Kind | `competitive_effect` | Scope rounds |
|---|---|---|
| E-L (locked or danced heat) | **true** while unresolved | the round of each locked/danced heat holding the entry's placement |
| E-C (certified heat) | **true** while unresolved | the round of each certified heat holding the entry's placement |
| `competition_refund_unattributed` (D6) | false, **unless** the order has an entry placed in a locked/danced/certified heat. Then one scope row per such entry/heat is `true` (attribution could withdraw or hold that entry) | rounds of those heats; otherwise **no scope rows** (financial-only parent, never blocks publication) |
| `competition_refund_reversed` (E-R) | false, unless the reversed refund's allocation holds an entry in a locked/danced/certified heat (then `true` for that entry's rounds) | as stated |

**Scope table (queryable by K0):** `event_competition_refund_exception_scopes` has one row per (exception,
entry, heat):

| Column | Meaning |
|---|---|
| `exception_id` | → `event_order_settlement_exceptions` |
| `event_id`, `entry_id`, `heat_id`, `round_id` | Same-event composite FKs; `round_id` is copied from the heat at raise time and is immutable |
| `competitive_effect` | boolean |
| `created_at` | — |
| `resolved_at`, `resolved_by`, `resolution`, `resolution_note` | Write-once |

It is unique on (`exception_id`, `entry_id`, `heat_id`). It is append-only except for the write-once
resolution stamp, enforced by a trigger. This replaces the `details.entry:<uuid>` idea, so the gate and K0 read
rows, not JSON.

K0's precondition: `exists (select 1 from event_competition_refund_exception_scopes s where s.round_id =
<round> and s.competitive_effect and s.resolved_at is null)` → refuse with `COMP_PUBLICATION_BLOCKED_BY_EXCEPTION`.
Other rounds, and financial-only scopes, never block. The parent exception moves to `resolved` automatically
when its last scope resolves, and the financial-only part stays visible for reconciliation.

- **"Authorized official" (Q1/Q2):** until E1 introduces official roles, this means an event manager allowed
  by `_paywh1_actor_can_manage_exception` (studio owner/admin, organizer owner/admin, platform admin). If E1
  adds a chair or official role, it can be admitted to scope resolution in E1's slot. Each resolution writes
  the scope stamp, an `event_order_settlement_exception_events` row (`action = 'scope_resolved'`), and, when it
  withdraws, the existing entry-change audit row.

- **Who resolves:** `_paywh1_actor_can_manage_exception`: studio owner/admin, organizer owner/admin, platform
  admin (the same set as D5). Organizer staff can see the entry's state but cannot resolve. Unlocking a heat
  additionally needs `can_manage_event_competition`; K0 corrections need the K0 manager role.
- **Gated resolution:** these kinds are resolved only by a new `resolve_competition_refund_exception(id,
  resolution, note)`, which checks the gate above. The generic `resolve_event_order_settlement_exception`
  (PAY-WH-1A) must **refuse** `competition_refund_*` kinds. That is a one-line change to a PAY-WH-1A function,
  called out for the PAY-WH owner.
- **Deduplication:** the existing unique key is (kind, order, PaymentIntent, session), so there is one parent
  row per kind per order (`occurrences` counts replays). Per-entry facts are scope rows (unique per exception,
  entry and heat), and a replay inserts nothing new (`on conflict do nothing`).
- **Stuck surfacing (point 7):** `operational` / `captured` / `reversed` kinds alert immediately through the
  existing queue. An open exception older than 72 h is re-alerted daily (by the same cron). Each open
  exception shows as a badge on the competition registrations page and on the readiness page.
  **Q2 (decided):** F3 publication of a round is **blocked** while any competitive-effect scope of that round is
  unresolved (K0 precondition above); other rounds and financial-only exceptions never block. **Proposed for
  C1 closeout (K0 §10):** event closeout refuses while any `competition_refund_*` exception is open. This
  includes financial-only ones, so nothing stays unresolved indefinitely. K0/C1 owns that check.

**A. Authorization per transition:**

| Transition | Check (in the RPC, not only the page) |
|---|---|
| Staff refund request (reserve) | `_paywh1_actor_can_manage_event(event)`; the order's `event_id` equals the URL event; every item belongs to the order (cross-event / cross-order refusal) |
| Stripe refund create | Server action only, after reserve, with the stored owner (`stripeAccount`) |
| Refund observation (webhook / create response) | service_role only; the account must equal the stored owner; the PaymentIntent must equal the order's |
| Participation effect (P) | Inside the same RPC transaction (definer); never callable directly by clients |
| Withdraw without refund (D4) | `can_manage_event_competition` (includes organizer staff); unchanged `change_competition_entry_lifecycle` (refuses locked/certified) |
| Heat unlock for E-L | `set_competition_heat_lock_state` (manager, reason, audited; certified never reopens) |
| Exception resolve | `_paywh1_actor_can_manage_exception` + gate |

**I. Idempotency keys:**

| Step | Key | Replay behaviour |
|---|---|---|
| Staff request | `refund_request_id` (client-generated UUID, unique) | The same lines return the existing request; different lines raise |
| Stripe create | `idempotencyKey = 'comp-refund:' + refund_request_id`; `metadata.danceflow_refund_request_id` | Stripe returns the same Refund object |
| Webhook delivery | Existing PAY-WH-1 claim/lease on the Stripe event id | A duplicate delivery is skipped before R2 |
| Refund observation | `stripe_refund_id` unique + the F transition table | Same or older status → no-op (recorded) |
| Order / payment / registration state | Absolute recompute from Σ succeeded | Converges for any order of events |
| Participation effect | (`refund id`, `entry_id`) with `participation_outcome` set once | Never two withdrawals or two exceptions |
| Exception | Existing dedupe key + `entry:<uuid>` detail key | `occurrences + 1`, no duplicate row |
| Registration trigger (full refund / cancel) | Existing `status not in ('withdrawn', …)` guard | Re-fire is a no-op (tested) |

**T. Regression tests (SQL unless marked):**
1. Pre-lock full refund: withdraw + scratch; danced kept *(implemented)*.
2. Locked heat: no participation change + exactly one E-L parent and one `competitive_effect` scope row per (entry, locked heat), with `round_id` = the heat's round.
3. Certified heat: no change to the entry, placement, heat or results + E-C.
4. Mixed order (open + locked + certified entries): each follows its own row; E-L and E-C both present.
5. Entry in an open heat and a locked heat: the locked row wins.
6. Q1: an entry with a `danced` placement in an open heat is never withdrawn (the trigger part is *implemented*) and raises E-L scoped to that round.
7. Webhook replay (same event id): nothing new.
8. Same refund via `refund.created`, then `refund.updated`, then `charge.refunded`: one refund row, one effect.
9. Out-of-order `succeeded` before `pending`: the final state is `succeeded`.
10. Reversal: financial totals drop; the entry stays withdrawn; E-R raised.
11. Concurrent staff requests cannot exceed the cap; lock order has no deadlock with settlement (concurrency script, like `paywh1_concurrency.sh`).
12. Cross-event / cross-order item refused; organizer staff refund refused; organizer staff withdraw allowed.
13. Generic PAY-WH-1A resolve refuses `competition_refund_*`; the gated resolver refuses until the gate holds.
14. E-L path (1): unlock (audited) → withdraw → resolve succeeds; certified unlock refused.
15. E-C path (2): resolve succeeds only after a K0 `result_events` row (runs when F2 exists; until then the test asserts path (2) is unavailable).
16. Stuck exception older than 72 h is re-queued for alert.
17. Stored-owner mismatch: webhook refund ignored; staff refund refused.
18. C1: one `competition_entry_refund` entry per succeeded refund, dated at success; a replay is idempotent (unique source); a reversal is a separate offsetting entry; the gross revenue entry is unchanged; a locked-period entry is never updated.
19. Registration trigger: a full dashboard refund with a locked entry raises E-L (requires the trigger to record the exception; §4.3).
20. *(unit)* Stripe call parameters (amount, idempotency key, `stripeAccount`, metadata, no `refund_application_fee`), largest-remainder math, webhook routing.

**K0 consistency (PR #291).** R2's slot `20270103` precedes F2 (`20270104`), so R2 cannot reference
`open_competition_round_correction` or `event_competition_result_events` in SQL. E-C path (2) therefore checks
for a result event **if the table exists**, or F2 adds that check to the resolver. K0 has no result-event kind
or step for removing or disqualifying a refunded entry from a certified result (`RESULT_EVENT_KINDS` covers only
ballots, results and advancement). If the owner wants that, it is a **K0 contract change** through the
Competition coordinator, not an R2 addition. Until then, E-C path (1) "result stands" is the only path
available.

### 4.2 Payment-integrity confirmation

| Requirement | What it demands | R2 conformance |
|---|---|---|
| **PAY-DC-2A** stored owner | A stored `event_payments.stripe_account_id` is authoritative. A conflict between stored owners refuses. The studio's current account is only a proof candidate when nothing is stored | R2 refunds only with the stored owner. Missing or conflicting owner → **refuse** (stricter: no proof-and-stamp path; PAY-WH-1 settlement always stores it). A webhook refund whose account differs from the stored owner is ignored and logged (`refundEventMatchesStoredOwner`), as today |
| **PAY-WH-1** settlement locks | Payment state of order-backed registrations is written only by settlement code (client roles blocked by `trg_paywh1_guard_*`). Settlement locks the order first. Webhook events are claimed/leased per Stripe event id | Every R2 write is in a `security definer` RPC, never a client write. Lock order is **order → registration → payment → entries → heat entries**, the same as settlement and the sweeper. Refunds only when `settlement_state = 'paid'`. Webhook claim/lease is unchanged; R2 adds its own `stripe_refund_id` idempotency |
| **PAY-WH-1A** | Staff refund of order-backed registrations refused. Captured-money exceptions are actionable (money state, ack/resolve audit, leased alert queue). Desk payments go through a scoped definer function | The refusal in `refundEventRegistrationAction` stays. R2 exceptions **reuse** `event_order_settlement_exceptions` and its alert queue (§4.1 E). **C2:** desk (cash/terminal) balance payments create a second `event_payments` row without a PaymentIntent. R2 refunds only the Stripe card charge, and its order cap is that charge. Desk-payment refunds stay manual (out of scope, listed in §6) |
| **PAY-WH-1B** | A legacy platform-account Session is never settled; it becomes a `mismatch_account` captured exception | Competition orders are direct charges only. R2 refuses any order whose payment owner is not a connected account |
| **REFUND-RECON-1** | Only money actually returned counts (`charge.amount_refunded` authoritative; `pending` never counts). The cumulative refund is never lowered by a stale event. A stored refund id is never erased | Financial truth = Σ of refund objects in `succeeded` (§4.1 F). `reserved` is cap reservation only, never "refunded". Recompute is absolute (Σ), not incremental, so replays and out-of-order events converge. It lowers only on a Stripe-reported reversal |
| **REFUND-RECON-2** | The refund is dated at refund progress (`refunded_at = greatest(refunded_at, now())`), not on the original payment's date | `event_payments.refunded_at` follows the same rule. **C1** below |
| **PKG-REFUND-2** pattern | One ledger row per Stripe Refund object (`stripe_refund_id` unique, status mirrors Stripe verbatim). Financial truth and entitlement truth are separate columns. Reversal detection comes from `refund.updated` failed/canceled | **Design refinement (supersedes §3.1's single table):** `event_order_refunds` = one row per Stripe Refund object (or per staff request before Stripe returns an id) + `event_order_refund_allocations` = one row per (refund × order item), with a separate `participation_outcome` column. This is the same split as `refund_status` / `reconciliation_outcome` |
| Refund authority | `refundEventRegistrationAction` used `canManageEventRegistrations` (studio owner/admin, platform admin). PAY-WH-1 money actions use `_paywh1_actor_can_manage_event` (studio owner/admin, organizer owner/admin, platform admin) | D5 = `_paywh1_actor_can_manage_event`, checked in the RPC (not only the page). Withdrawal stays on `can_manage_event_competition`, which also admits organizer staff |

**C1 — D8 vs owner point 1 and REFUND-RECON-2. RESOLVED 2026-10-23: owner selected (a) (see §4.0).** The analysis is kept for the record:
`sync_event_payment_accounting_entry` keeps one `competition_entry_revenue` row per payment, dated on the
**payment** date. A refund lowers that row's net in place, so:
(i) a refund is booked in the payment's accounting period, which REFUND-RECON-2 fixed for package payments;
(ii) `accounting_upsert_entry` updates only rows with `locked_at is null`, so once that period is locked, a
later refund is **silently not recorded** in accounting. That breaks point 1, "a completed Stripe refund must
always be accurately recorded and reconciled".
Options:
- (a) a separate refund accounting entry per succeeded Stripe refund object, dated at success. This is the 10C
  §11 item 3 `*_refund` category follow-up, pulled into R2.
- (b) keep D8, and record a `competition_refund_accounting_locked` operational exception whenever the
  upsert is skipped.
- (c) keep D8 as is, and accept the gap.

Engineering recommendation: **(a)**. It adds an accounting category (shared catalog), so it needs explicit
owner approval.

**C2 — desk payments.** These are noted above. They are not a conflict with the D-decisions, but the order
cap must use the Stripe captured amount and not `event_orders.total_amount`.

### 4.3 Review of the pushed cascade-gap fix (commit cb17b489) against points 2–7

| Point | Finding |
|---|---|
| 2 (pre-lock automatic withdraw) | Conforms. Withdraw + scratch applies only to entries with no placement in a locked/certified heat. **Q1 (decided, implemented):** an entry with any `danced` placement is no longer withdrawn automatically. |
| 3 (locked: no silent rewrite) | Partly conforms. Locked-heat entries are not rewritten (the 10A guard is kept, tested). **Gap:** the skip is silent; no exception is recorded. Closing it requires the trigger to record E-L (a definer call to `_paywh1_record_exception` with the registration's order). It belongs in the R2 implementation once §4.1 is approved |
| 4 (certified preserved) | Conforms: never touched (same guard). Same silent-skip gap → E-C |
| 5 (idempotent) | Conforms: re-fire is a no-op (tested) |
| 6 (separation) | Inherited coupling: `payment_status = refunded` → automatic withdrawal is the one finance → participation link. With §4.1 it is limited to pre-lock entries plus exceptions |
| 7 (recovery path) | Not yet: depends on E-L/E-C |

The Q1 guard was added on top (md5 `5fb50278…`). Recording the E-L/E-C scopes from the trigger is additive and waits for implementation authorization.

**Owner questions C1, Q1, Q2: all DECIDED (§4.0).** D1–D8 remain PROVISIONAL.

## 5. Tests (planned)

The authoritative regression list for refunds vs locked/certified heats is §4.1 **T** (items 1–20). The list below covers the money path.

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
accounting categories (unless C1 = (a)); refunds of free (unpaid) orders (nothing to refund — withdraw only);
refunds of competition desk (cash / terminal) payments (C2; stay manual); automatic re-instatement after a
refund reversal; removing a refunded entry from a certified result (K0 contract change); ACH.

## 7. Git-only implementation plan (waits for the owner's implementation authorization)

Nothing below is written yet, except where marked *(done)*. Each step is one commit on this branch, tested on
the isolated local Postgres (`r2-refunds-db`) and in Stripe **test mode** only. Nothing is merged, applied to
hosted databases, or used to refund real payment methods without separate authorization.

### 7.1 Migration `20270103090000` sections

| § | Content | Preflight pins |
|---|---|---|
| 1 *(done)* | Registration cascade: withdraw + scratch pre-lock entries; skip locked/certified/danced (Q1) | `sync_competition_entries_from_registration` = `fabd4052…` → `5fb50278…` |
| 2 | Tables `event_order_refunds` (one per Stripe Refund object or staff request: `id`, `event_id`, `order_id`, `refund_request_id` unique, `stripe_refund_id` unique nullable, `stripe_account_id`, `stripe_payment_intent_id`, `amount_cents`, `currency`, `status` (Stripe vocabulary + `requested`), `source` (`staff` / `stripe_dashboard`), `reason`, `requested_by`, `succeeded_at`, `reversed_at`, timestamps) and `event_order_refund_allocations` (`refund_id`, `order_item_id`, `entry_id`, `amount_cents > 0`, `withdraw_entry`, `participation_outcome` write-once; unique (`refund_id`, `order_item_id`)). Same-event composite FKs. RLS: `_paywh1_actor_can_manage_event` read only; no client writes (trigger + no grants) | `event_orders`, `event_order_items`, `event_payments` shapes; PAY-WH-1 guard functions present |
| 3 | `event_competition_refund_exception_scopes` (§4.1 E) + write-once resolution trigger; new kinds in `_paywh1_exception_money_state` (E-L/E-C → `operational`, unattributed → `captured`, reversed → `reversed`) | `_paywh1_exception_money_state`, `_paywh1_record_exception`, `resolve_event_order_settlement_exception` md5s (repo bodies, not DEV catalog) |
| 4 | Accounting (C1): category `competition_entry_refund` (contra-income, debit, like `event_ticket_refund`); competition branch of `sync_event_payment_accounting_entry` stops subtracting `refund_amount` (normal event payments unchanged); `_r2_post_refund_accounting(refund_id)` posts one entry per succeeded refund (`source_table = 'event_order_refunds'`) dated `succeeded_at::date`, and one offsetting entry (`direction = 'credit'`, `source_table = 'event_order_refund_reversals'`) for a reversal | 10C `sync_event_payment_accounting_entry` md5; category absent. **Preflight refuses** if any competition `event_payments` row already has `refund_amount > 0` (no silent re-dating of history; PROD is expected to have 0 while public registration is off) |
| 5 | RPCs (7.2) | — |
| 6 | Trigger E-L/E-C recording: §1 body + `_r2_record_participation_exception` for the entries it skips | Section 1 body md5 |
| 7 | Generic `resolve_event_order_settlement_exception` refuses `competition_refund_*` (the one-line PAY-WH-1A change, called out) | PAY-WH-1A body md5 |
| 8 | Postflight: grants, RLS, function md5s recorded for the rollback | — |

Rollback mirrors every section in reverse. It refuses if any `event_order_refunds` row exists, so refund
evidence is never dropped silently. In that case, rollback is app-first: stop the staff UI and the webhook
branch, then the SQL.

### 7.2 RPCs (`security definer`, `search_path = public, pg_temp`; `service_role`-only execute unless stated)

| RPC | Purpose | Locks (fixed order) |
|---|---|---|
| `request_competition_order_refund(p_actor, p_event_id, p_order_id, p_request_id, p_lines, p_reason)` | §4.1 A checks; D1/D2 caps by the same rules as `competitionRefundRules.ts`; inserts the `requested` refund + allocations; idempotent on `p_request_id` | order → items → existing refunds |
| `observe_competition_stripe_refund(p_payment_intent_id, p_stripe_account_id, p_stripe_refund_id, p_request_id, p_amount_cents, p_status, p_stripe_event_id)` | Single writer for the Stripe-side refund state (create response and webhook). Matches by `stripe_refund_id`, else `p_request_id`, else creates a `stripe_dashboard` refund (D6). Applies the F transitions; `succeeded` → `_r2_apply_success`; reversal → `_r2_apply_reversal` | order → registration → payment → refund → entries → heat entries (the same as settlement) |
| `_r2_apply_success(refund_id)` | Absolute recompute of order, payment and registration state; accounting entry (§4); P effects per allocation (write-once `participation_outcome`); exceptions + scopes | inside the caller's locks |
| `_r2_apply_reversal(refund_id)` | Recompute; offsetting accounting entry; E-R (+ scopes if held); never re-instates | inside |
| `attribute_competition_refund(p_actor, p_exception_id, p_lines)` | D6 attribution of an unattributed refund (caps apply) → P effects for the attributed part | exception → order → … |
| `resolve_competition_refund_scope(p_scope_id, p_resolution, p_note)` (authenticated) | §4.1 E gate per scope; auto-resolves the parent when the last scope closes | exception → scope → entry |

### 7.3 App (server only)

- `src/app/app/events/[id]/competition/registrations/refundActions.ts`: the server action runs `request_…`,
  then `stripe.refunds.create({ payment_intent, amount, metadata: { danceflow_refund_request_id } },
  { stripeAccount: storedOwner, idempotencyKey: "comp-refund:" + requestId })`. There is no
  `refund_application_fee` (D3). Then `observe_…` with the response. A Stripe error → `observe_…` with `failed`.
- `src/lib/payments/competitionRefunds.ts`: Stripe-parameter builder + RPC wrapper. Rules come from
  `competitionRefundRules.ts` *(done: pure rules + 18 unit tests)*.
- Page `competition/registrations/[orderId]/refund`: lines with net cap, already refunded and remaining; heat
  class (open / locked / danced / certified); withdraw toggle (disabled and explained unless the class is open /
  unplaced); reason. The open exceptions and scopes list has resolve actions.
- `refundEventRegistrationAction`: the `order_backed_registration_payment_locked` refusal stays. For a
  competition order, the error links to the new page.

### 7.4 Webhook (`src/app/api/payments/webhook/route.ts`), minimal and called out

In `handleStripeRefundUpdated`, before `updateEventPaymentRefundByPaymentIntent`: if the PaymentIntent belongs
to a competition order, call `observe_competition_stripe_refund` **per refund object** (Stripe's
`refund.status` and `refund.amount`, never the cumulative `amount_refunded`), and skip the pro-rata
event-payment path for that PaymentIntent. `charge.refunded` stays payment-summary-only. Package reconciliation
and its release hold are untouched. Expected diff: one guarded branch and one import.

### 7.5 Tests per step

| Step | SQL (`test_T_competition_r2_entry_refunds.sql`) | Unit / static | Concurrency |
|---|---|---|---|
| §2–§5 | §4.1 T2–T19 become runnable checks (today they are concrete `spec` cases in the suite) | Stripe params (D3, idempotency key, stored owner, metadata); webhook routing | `r2_refund_concurrency.sh`: two staff requests vs one cap; settlement sweeper vs refund (no deadlock), modelled on `paywh1_concurrency.sh` |
| §4 | C1 entry dated at success; replay idempotent; reversal offset; gross revenue unchanged; locked period untouched; preflight refuses existing competition refunds | — | — |
| §6–§7 | Trigger E-L/E-C scopes; generic resolve refuses | — | — |
| Regression | 10A / 10C / 10D / 10D.1 / PAY-WH-1 / PAY-WH-1A / REFUND-RECON suites on a clean migration-built database | full vitest + typecheck in CI | — |

### 7.6 Gates after implementation (each separately authorized)

Opus payment-integrity review → owner business acceptance on a local or preview stack in Stripe test mode →
PR merge → DEV SQL → PROD SQL (preflight: zero competition refunds) → app promotion → the CI-D hold cleared in
the roadmap.

## 8. Implementation notes (2026-10-23)

| Plan item (§7) | As built | Note |
|---|---|---|
| reserve / finalize / record-stripe RPCs | `request_competition_order_refund` (reserve); `observe_competition_stripe_refund` (finalize + record Stripe, the single writer for the server-action response and the webhook); `attribute_competition_refund`; `resolve_competition_refund_scope`; `resolve_competition_refund_exception` | Same responsibilities, fewer entry points |
| Exception money states | **All four `competition_refund_*` kinds are `operational`** | So a kind that recurs after resolution reopens and alerts again. PAY-WH-1A reopens only operational kinds |
| Refund page caps | Computed with `competitionRefundRules.ts` from rows the manager can read | Display only; the RPC re-validates. SQL/TS parity is asserted by the same scenario in both suites (2272 / 2273 / 2273 / 2273 / 909) |
| D4 | Refund-without-withdraw is honoured for partial refunds | Refunding the **entire captured amount** makes the registration `refunded`, and the existing 10A rule then withdraws every open, undanced entry. The page says so |
| Stripe failure | A definitive refusal (4xx) → `failed`, which releases the cap. A network / 5xx / 409 / 429 error leaves the request `requested` (cap held) until Stripe reports, so a refund that may exist is never forgotten | Retrying the form reuses the request id and Stripe idempotency key |
| Webhook | Two guarded insertions in `route.ts`, both marked `CI-D R2`. `handleStripeRefundUpdated` observes each refund object. `updateEventPaymentRefundByPaymentIntent` returns early for competition PaymentIntents (this covers `charge.refunded` too) | Package refund paths are untouched. Four existing webhook test fakes learned the two new RPC names (no assertion changed) |

**Follow-ups (not in R2):**
- **Disputes and chargebacks** on competition orders: today they follow the generic PAY-WH dispute handling, with no ledger entry, scope or entry effect. They need their own design (a dispute is not a refund: funds can return, and the evidence window matters).
- The K0 / F3 `publish_competition_round_result` precondition reads `event_competition_refund_exception_scopes`. This is coordinated on PR #291 and not built here.
- The C1 event closeout check (refuse while any `competition_refund_*` exception is open) belongs to the K0 / C1 slot.
- Re-instating an entry after a refund reversal: a manual, audited action (a future slice).
- Organizer-role fixtures for the SQL suite. D5 reuses `_paywh1_actor_can_manage_event`, which already admits organizer owners/admins and refuses organizer staff. That function is covered by the PAY-WH-1 suites, not re-proven here.

### 8.1 Code review (2026-10-23): independent payment-integrity pass; no P0

| # | Finding | Disposition |
|---|---|---|
| P1-1 | A request marked `failed` locally (no Stripe id) could never record a refund Stripe later reports | **Fixed.** `failed` / `canceled` with no bound Stripe id may move to pending / succeeded on a Stripe observation. SQL test D/P1-1 |
| P1-2 | A request stuck in `requested` after an unknown Stripe error held its cap forever | **Fixed in the app.** The refund page lists "Waiting for Stripe" requests with a retry that reuses the request id and Stripe idempotency key; retries are refused after 23 h (Stripe's 24 h key window), and the webhook then records whatever Stripe did. **Follow-up:** a scheduled reconciler or alert for requests still `requested` after N minutes (policy point 7 for unattended cases) |
| P1-3 | Event P&L, the profitability export and Wave did not see the new refund entries | **Fixed.** The `competition_entry_refund` catalog entry; the P&L reads `event_order_refunds` (debit) and `event_order_refund_reversals` (credit); the export selects them; Wave maps legacy embedded competition refunds to the new category. Unit test added |
| P1-4 | Every refund webhook calls the new RPCs, so the app fails if it is live without the SQL | **Release gate:** apply the SQL **before** promoting the app, and roll back **app first**. `observe` now classifies before locking, so non-competition refunds take no competition lock |
| P2-5 | A new refund on an entry whose scope was resolved recorded nothing | **Fixed.** Dedupe is per (kind, entry, heat, refund): replays and trigger re-fires add nothing; a new refund opens a scope and reopens the parent. SQL test G/P2-5 |
| P2-6 | Classification was not locked against a concurrent heat lock | **Fixed.** `_r2_apply_participation` takes `FOR SHARE` on the entry's heats first |
| P2-7 | Resolution gates looser than the design | **Fixed.** `withdrawn_after_unlock` requires `status = 'withdrawn'`; `k0_correction` requires a K0 result event whose `refs.refund_exception_id` names the exception. **K0 (PR #291) must write that ref** |
| P2-8 | All `competition_refund_*` kinds are `operational` (the design said captured / reversed) | Deliberate (§8 table): only operational kinds reopen and re-alert. **Owner sign-off requested** |
| P2-9 | After a full refund is reversed, the registration stays `status = refunded` with `payment_status` `partial` / `paid` | Deliberate: participation is never re-instated automatically (policy 6). The E-R exception carries it for an official decision |
| P2-10 | A partially refunded registration is `payment_status = partial`; the PAY-WH-1 client guard and the desk check-in may read that as money owed | **Follow-up (not verified here):** confirm that competition check-in (CI-B, PR #295) and the desk balance screen treat `partial` on an order-backed registration as paid less refunds |

### 8.2 Scratch vs refund (owner clarification, 2026-10-23)

"'Scratch' and 'withdraw' are essentially synonymous. Use Scratch as the primary competition-facing terminology. A
scratch is not inherently financial. A scratch must never automatically cause a refund."

- Competition-facing copy says **Scratch**: "Also scratch this entry", "Entry scratched after an audited heat unlock".
  DB status values (`withdrawn`, `scratched`) and RPC / column names (`withdraw_entry`, `withdrawn_after_unlock`) are
  unchanged.
- **Direction of coupling is one-way.** A refund may record a scratch (D4, the "Also scratch this entry" choice, and the
  existing 10A rule that a fully refunded registration scratches its open entries). A scratch never records, requests
  or reserves a refund: `change_competition_entry_lifecycle`, check-in and heat-entry status changes, and the
  registration cascade write no `event_order_refunds` / allocation rows and hold no refund cap. This is proven by the R2
  SQL suite, section S.
- Organizers choose the financial resolution of a scratch separately: **No refund** (default), **Future competition
  credit** (CC1, a separate future workstream), or **Refund** (R2, this design).

### 8.3 Forward contract for CC1 (future competition credit; not implemented here)

- A competition credit consumes the **same per-item net-paid cap** as refunds (D1/D2), under the **same order lock**
  (`event_orders FOR UPDATE`, taken first, as in `request_competition_order_refund`).
- The cap for an order line becomes:
  `net paid − Σ refund allocations (requested / pending / requires_action / succeeded) − Σ credit issued against that item`.
  `_r2_validate_lines` / `_r2_order_line_caps`, and their TS twin `competitionRefundRules.ts`, are where CC1 subtracts
  its issued credit, so a refund and a credit can never together exceed what was paid for a line.
- CC1 will add a `credit` value to `event_competition_entry_changes.fee_handling` (today: `retain`, `refund`,
  `partial_refund`, `waive`, `not_applicable`).
- R2 adds no credit table, column or logic.

### 8.4 Release gate found in end-to-end QA (2026-10-23)

- **Desk balance (PAY-WH-1A `record_competition_checkin_payment` and `competition/checkin/actions.ts`, already on
  main):** the balance is `order total − Σ(amount − refund_amount)`, so after an R2 partial refund the refunded
  amount appears as balance due, and the desk could collect it again. The correct balance is `total − Σ amount`
  (refunds reduce both what is owed and what is paid). This is owned by PAY-WH-1A / CI-B and **must be fixed before
  CI-D is released**.
- **Held entries:** the refund page now offers "Request scratch (official decision required)" for entries in locked,
  danced or certified heats. Requesting it raises E-L/E-C and never scratches automatically. Before this fix, the
  checkbox was disabled, so a refund there could leave no official decision.

### 8.5 Alignment with SC1 (scratch workflow, draft, migration 20270108090000), 2026-10-24

- **SC1 review P2-4 (fixed):** the registration cascade no longer touches an entry that is already `scratched`. A later
  refund or cancel of its registration leaves it `scratched` and writes no second (withdraw / refund) audit row.
  SQL test A/SC1.
- **"Danced" rule matched to SC1:** a placement counts as danced when it is marked `danced`, **or** when it is not
  scratched and its heat is on the floor (`active` / `complete`), because nothing marks placements `danced` yet. The rule
  applies in the cascade guard, `_r2_entry_participation_class`, the E-L scope selection, `competitionRefundRules.ts`
  (`hasDanced`) and the refund page (it now reads `event_competition_heats.status`). A refund on an entry in an
  on-floor heat therefore raises E-L and never withdraws it. SQL test A/SC1 and unit tests.
- **SC1 revokes `change_competition_entry_lifecycle` from API roles:** R2's code never calls it and never writes entry
  status as `authenticated` (all R2 writes are definer RPCs or the trigger). R2's **SQL suite** does call it as the
  studio owner (sections A/SC1, E "audited unlock then withdraw", S) and the §4.1 E-L resolution path names it. Once
  SC1 merges, those steps switch to SC1's definer scratch RPC. That is a test-side and doc-side change only; it doesn't
  change R2's migration.
- New pin: `sync_competition_entries_from_registration` = md5 `95e9cd2a…` (supersedes `4c8592ee…`). The rollback is
  regenerated from verbatim prior bodies.
