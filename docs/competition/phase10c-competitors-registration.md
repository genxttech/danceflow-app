# Phase 10C — Competitors + Transactional Registration

Status: implementation candidate (DEV only). Roadmap v2.21, Competition OS v1 loop **REGISTER → PAY**.
Public flag `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED` stays **off**; enabling it is a separate launch gate.

Migration `20261109090000_phase10c_competitor_registration.sql`, rollback in `rollback/`, suites
`sql-tests/test_T_phase10c_competitor_registration.sql` and the generated
`sql-tests/test_T_phase10c_pricing_parity.sql`.

## 1. Identity model — PERSON ≠ COMPETITOR ≠ ENTRY

| Concept | Where | Notes |
|---|---|---|
| PERSON | `auth.users` / `dancer_profiles`, `clients`, `instructors`, or a guest | unchanged; no new person system |
| COMPETITOR | `event_competition_competitors` | one human at one event |
| ENTRY | `event_competition_entries` + `event_competition_entry_participants` | one competitor or a set of competitors in one division |

**Competitor row:** `event_id`, `studio_id` (copied from the event by trigger), optional anchors
`user_id`, `client_id`, `instructor_id`, the guest minimum (`first_name`, `last_name`, optional contact
`email`, optional `date_of_birth`, `primary_role`, `external_ids` such as `wsdc_competitor_id`),
`bib_number` (unique per event; managers may edit it), `created_via`, `created_order_id`.
`unique (id, event_id)` backs composite event-scoped FKs.

**Anchors and deduplication** (`_comp10c_resolve_competitor`):
- Each anchor is unique per event (partial unique indexes), so an anchored human is exactly one competitor
  per event, across any number of orders and entries. Resolution is serialized per event with an advisory
  lock, so concurrent registrations converge; anchors that point at two different rows are refused.
- Anchors can be **completed** by trusted code but never **changed** once set (`COMP10C_ANCHOR_IMMUTABLE`).
- `client_id` / `instructor_id` must belong to the event's studio (`COMP10C_ANCHOR_CROSS_STUDIO`).
- Guests (no anchor) are always new rows. Names and emails are never used to merge people.

**Who can set anchors:**
- *"This is me"* (`isSelf`): the server-verified session user, only with a LAUNCH-SEC-1C verified email
  (`verified_email_for_user`); the competitor gets `user_id`, the user's **linked self** client at the
  event studio (`client_account_links.status = 'linked'`), and the user's active instructor row at the
  studio. Unverified accounts are refused (`COMP10C_IDENTITY_UNVERIFIED`); anonymous buyers cannot use it.
- Studio-side anchoring of other people (`anchorClientId` / `anchorInstructorId`): event managers only
  (`_comp10c_actor_can_manage`, same roles as `can_manage_event_competition`), own-studio records only.
- Legacy / staff participant inserts without a `competitor_id` are resolved by a BEFORE trigger:
  client/instructor anchor → canonical competitor; otherwise a new guest competitor. The participant's
  `client_id`/`instructor_id` always mirror the competitor's anchors.

**Entry participants:** `competitor_id` is NOT NULL with FK `(competitor_id, event_id)`; one competitor
appears at most once per entry. Roles are the existing set and are validated per entry format
(`_comp10c_allowed_roles`, mirrored in TypeScript):

| Format | Roles |
|---|---|
| `pro_am` | `student`, `professional` |
| `pro_pro` | `professional` |
| `couple`, `mixed_amateur`, `professional` | `leader`, `follower` |
| `random_partner` (Jack & Jill) | exactly one participant, `leader` or `follower`; no partner assigned in 10C |
| `team` | `team_member`; a team name is required (stored as the entry display name and `metadata.team_name`) |
| `solo`, `custom` | any non-team role |

ProAm: the professional is one competitor referenced by every entry they dance (required for 10D
conflict detection). Couples and partnerships are entry-local; there is no global partnership entity.

**Backfill:** existing participants were resolved conservatively by the trigger (anchored rows deduplicate
through their anchor; anchor-less rows become separate guest competitors). DEV had 0 participants; PROD's
10B release preflight recorded 0 competition operational rows — reconfirm in the 10C PROD preflight.

## 2. Registration lifecycle gate

- `event_competition_programs.registration_status` (`closed` | `open`) with `registration_opened_at` /
  `registration_closed_at`, written only by `open_competition_registration` / `close_competition_registration`
  (managers; column privileges deny direct writes). All programs start **closed**: publishing in 10B no
  longer makes anything public.
- Opening requires a published program (configured/active, profile locked when profiled) and an event that
  requires registration. It opens draft categories that have a division, their draft divisions and their rules.
- Public visibility predicate `competition_registration_program_open(event, program)`: event published,
  public/unlisted, registration required, inside the event registration window, program configured/active,
  registration open, profile locked. Row predicates `competition_contest_registrable`,
  `competition_division_registrable`, `competition_offering_registrable` add the row's own open/active state.
  Fee rules are visible only inside their own window. All seven public catalog policies use these
  SECURITY DEFINER predicates (no policy recursion), and **`_comp10c_quote` uses the same predicates**, so the
  anonymous catalog and the server-authoritative catalog are the same set by construction (SQL check
  "catalog parity").
- Workspace Overview: Open registration → Close registration → (reopen) as lifecycle stages / primary action.

## 3. Transactional registration (START → PREPARE → ATTACH → FINALIZE / RELEASE)

All five functions are SECURITY DEFINER, `service_role` only. The public route only gates (flag, rate limit),
reads the server-verified session user, and sequences calls; it writes no registration rows.

| Step | Function | Guarantees |
|---|---|---|
| START | `start_competition_registration(event, client_request_id, draft, actor)` | advisory lock per (event, request); replay returns the stored result; different payload or actor → `COMP10C_IDEMPOTENCY_CONFLICT`; validates lifecycle, window, catalog, participants, roles, identity anchors; prices at DB `now()`; creates the whole graph in ONE transaction or nothing |
| PREPARE | `prepare_competition_registration_payment(order)` | order pending, unexpired, signing complete if required; re-opens a ≥31-minute payment window when no session is bound |
| ATTACH | `attach_competition_registration_checkout(order, account, session, expires)` | account must be the event studio's ready connected account; session unique across orders; expiry inside the hold; re-attaching the same session is a no-op |
| FINALIZE | `finalize_competition_registration(order, account, session, pi, amount_cents, currency)` | session/account must be the bound ones; amount must equal the snapshot; payment row inserted exactly once; activates order, registration, entries, entry dances, checkpoint exactly once; late payment after release or payment without completed signing is recorded as evidence with `needs_review` and does **not** activate |
| RELEASE | `release_competition_registration(order, reason, session?, account?)` | expired / failed / abandoned / attach_failed / signing_expired; never touches a paid order; idempotent; provider-originated releases must name the bound session/account |

Stripe: direct charge on the studio's connected account, `mode=payment`, **card only** (no delayed methods),
one line of the snapshot total, `application_fee_amount` from the canonical platform-fee helper, deterministic
idempotency key `comp10c:<order>:checkout-session:<expires_at>`. A session is only shown after ATTACH succeeds;
any failure expires it. Cancel URL expires the open session and releases. The status page shows server state
only (`?success` is never evidence); before the webhook it shows "Payment processing".

Webhook (Connect events): `checkout.session.completed` / `async_payment_succeeded` → FINALIZE (paid only);
`checkout.session.expired` → RELEASE expired; `checkout.session.async_payment_failed` → RELEASE failed.
`payment_intent.payment_failed` is intentionally not a release trigger (Checkout lets the buyer retry).
Competition sessions are dispatched before the generic event-cart handler, which never sees them.

## 4. Commerce mapping (one purchase)

```
event_order (1, metadata.source = competition_registration, client_request_id = comp10c:<key>, price_snapshot)
 ├─ event_order_items: one competition_entry item per entry (reference_id = entry id, price lines)
 │                     + add_on items for cart-level fees/discounts (revenue_class = competition_entry)
 └─ event_registration (1, buyer; user_id / linked client_id when signed in)
     ├─ event_registration_items (mirror of the order items, receipt)
     ├─ event_registration_attendees (one per competitor, attendee_role = competitor; admission QR)
     ├─ event_payments (1 per provider payment)
     └─ event_competition_entries (order_id, registration_id, order_item_id UNIQUE)
          ├─ event_competition_entry_participants → event_competition_competitors
          └─ event_competition_entry_dances (real offering key/label/fee via trigger)
event_competition_registration_carts (+ people / entries / entry_people / entry_dances / price_lines) = immutable draft + price snapshot
```

`entry.order_item_id` is the per-entry refund handle for the follow-up. Admission (attendee QR) stays separate
from competitor identity (competitor + bib).

## 5. Pricing

`_comp10c_quote` is authoritative; `registrationPricing.ts` mirrors it for display only. Integer cents;
percentages half-up; fee rules filtered by `registration_mode` and window at the quote instant and applied in
`(priority, name, id)` byte order. A START replay returns its original snapshot even after windows move; a new
request is priced at the database's current time. The snapshot (lines incl. fee-rule id, calculation type,
amount/percentage and window) is stored on the order (`metadata.price_snapshot`), the cart (`price_snapshot`,
price lines) and the order items, so history never depends on mutable rules. Parity: 10 hand-computed
scenarios run against both implementations (vitest + generated SQL suite; vitest fails if the committed SQL
drifts from the generator).

## 6. Signing

Required event documents use the Phase 8 `event_signing_checkpoints` workflow: START marks the order
`requires_signing`, the route begins the checkpoint (buyer signs; checkpoint bound to the order and its
registration) and payment opens only when every required document has a signed assignment backed by a
**completed envelope** of that checkpoint (`_comp10c_signing_complete`). The old direct writes of
`document_assignments(status=signed)` / `document_signatures` are gone. Per-competitor waivers (each dancer
signs) are a carry-forward.

## 7. Accounting

`competition_entry_revenue` is a new category on the existing event-payment ledger trigger, derived from the
order's server-written items. Ordinary event tickets stay `event_ticket_revenue`. Orders are homogeneous
(a trigger refuses mixing competition and ordinary items) because the ledger keeps one row per event payment;
so a payment is never mis-split or double counted. Financial summary, reports, accounting map and Wave
mapping recognise the new category (Wave refunds map to `event_ticket_refund` until the refund follow-up).
New category ⇒ organizers with Wave auto-posting must map it once (`blocksAutoPostWhenUnmapped`).

## 8. Capacity (what 10C enforces)

- No division/contest capacity exists in the schema; none is invented.
- Competition registrations have no ticket type, so the event ticket-capacity trigger does not count them and
  they cannot oversell ticket capacity.
- Holds: pending orders expire (40-minute hold; Stripe session inside it); expired/failed/abandoned holds are
  released by webhook, cancel link or lazily by the status page; released entries are `withdrawn`.
- Carry-forward: division capacity / waitlists; a scheduled sweeper for stale pending orders that never got a
  session (today they stay `pending` entries — not confirmed — until viewed).

## 9. Security posture

Service role is used only by trusted server code; every rule (event/studio binding, lifecycle, window,
identity anchors, pricing, relationship integrity, provider binding) is enforced inside the database
functions. Clients cannot execute START/PREPARE/ATTACH/FINALIZE/RELEASE/QUOTE or the internal helpers, cannot
read competitors (managers of the event only), cannot write anchors or lifecycle columns. Composite event FKs
on every new reference. Forged competitor/registration/order/session ids, stale quotes, replays, concurrent
duplicates and cross-studio anchors are covered by the SQL suite; a live DEV probe ran 6 concurrent same-key
STARTs (1 order, 5 replays) and 4 concurrent orders anchoring one instructor (1 competitor).

## 10. PII, deletion, retention

- Competitors hold only Competition OS data; anchored people keep their canonical PERSON record. Guest PII
  (name, optional email/DOB) lives on the competitor and the cart roster snapshot; both are event-scoped and
  cascade with the event.
- Anchor FKs are `ON DELETE SET NULL` (deleting a client/instructor/user unlinks, keeps the competitor).
- Participants reference competitors `ON DELETE RESTRICT`; entries reference their order item `RESTRICT`
  (payment evidence cannot be orphaned). Released registrations keep their rows (withdrawn) for audit.
- Carry-forward: guest PII minimisation/erasure workflow for competitors after the event.

## 11. Refund boundary and follow-up

10C does not change refunds: the staff refund path and webhook refund sync are untouched; a refunded
registration still withdraws its entries (10A trigger); full refund still voids revenue.

**Follow-up — EVENT / COMPETITION REFUND INTEGRITY (bounded):**
1. per-entry / partial refunds using `entry.order_item_id` (refund one entry of a multi-entry order);
2. Stripe partial-refund amount allocation (today a staff refund refunds the whole PaymentIntent);
3. refund accounting entries (`*_refund` categories) instead of voiding revenue;
4. order-level `refunded` / `partially_refunded` reconciliation on `event_orders`;
5. shared normal-event refund cleanup (same payment objects).

## 12. Release and launch notes

- Release order: **SQL first, then app** (the workspace reads the new program columns). Rollback: **app first**,
  then the SQL rollback (refuses once real 10C registrations, competitors, competition revenue or open
  registration exist — forward-fix after launch).
- PROD preflight must confirm no duplicate `event_payments` (registration, session|payment intent) rows and no
  mixed orders (the migration refuses otherwise), and re-check the pinned function bodies.
- Stripe Connect webhook endpoint must be subscribed to `checkout.session.expired` and
  `checkout.session.async_payment_failed` (in addition to `checkout.session.completed`) before the flag is on.
- DEV drift found (not repaired here): `event_payments.event_id` is missing on DEV (the accounting trigger now
  reads it defensively); `uq_accounting_entries_event_payment_source` exists on DEV but not in the repo.

### Controlled flag enablement (separate gate)

Technically ready to *trial* behind the flag after release, gated on: Connect webhook subscriptions above;
an end-to-end Stripe test-mode run (anonymous guest, verified "this is me", required waiver, cancel, expiry)
on a preview deployment; organizer UI walkthrough (open/close registration, status page); and a decision on
per-competitor waivers and the refund follow-up for the first live event.
