# Competition OS — Scratch policy (SC1) and Competition credit (CC1)

Status: **DESIGN — docs only.** Owner product direction of 2026-10-23. This doc authorizes no financial
implementation, hosted migration, merge or deploy. Baseline: origin/main `897120e1`.

Related: R2 per-entry refunds (`docs/competition/r2-entry-refunds.md`, draft PR #292), the K0 results contract
(`docs/competition/scoring-results-contract.md`, PR #291).

## 1. Owner direction (2026-10-23)

- "Scratch" and "withdraw" mean the same thing. **Scratch** is the competition-facing term.
- A scratch is not financial and **never automatically causes a refund.**
- The organizer picks one of three financial resolutions for a scratch:
  1. **No refund** (the default): the entry/heat is scratched and the original payment is unchanged.
  2. **Future competition credit**: a separately tracked credit, redeemable against an eligible future competition,
     subject to organizer policy (CC1).
  3. **Refund**: starts the separately authorized R2 refund workflow, with its payment-integrity and heat/result
     safeguards.
- Studios/organizers configure their standard policy. Authorized officials record exceptions with an audit trail.
- Safeguards:
  - no duplicate refund and credit against the same paid amount;
  - credit is never treated as a Stripe refund;
  - credit issuance, redemption, balance, expiry and ownership are tracked;
  - historical participation, scoring and certified results are preserved;
  - danced, locked and certified heats are never silently altered;
  - the normal scratch workflow stays fast and independent of payments.

## 2. Terminology mapping (no schema change)

| UI term | Stored as today | Notes |
|---|---|---|
| Scratch (entry) | `event_competition_entries.status` = `scratched` **or** `withdrawn` | Both values exist (20260620). New UI actions write `scratched`. `withdrawn` stays for the registration cascade (full refund / cancellation) and existing rows. Both render as "Scratched". Unifying the values is optional later (owner decision S-D1). |
| Scratch (heat placement) | `event_competition_heat_entries.status = 'scratched'` | Unchanged |
| Financial resolution | `event_competition_entry_changes.fee_handling` (`retain`, `refund`, `partial_refund`, `waive`, `not_applicable`) | `retain` = No refund (default). CC1 adds `credit`. `waive` = an unpaid fee is forgiven (no money moved). |
| Scratch action | `change_competition_entry_lifecycle(entry, 'scratched', reason, fee_handling)` | Already exists; the default `fee_handling` is `retain` |

## 3. SC1 — Scratch workflow (no money)

The scratch path calls **no** payment code. Choosing "Refund" or "Credit" in the scratch dialog records the
scratch first. It then hands off to R2 or CC1 as a separate, separately authorized step with its own audit row. A
scratch never waits on Stripe.

| Entry's heat state | Scratch behaviour |
|---|---|
| No placement, or only `open` heats not yet danced | Normal scratch: entry → `scratched`, placements → `scratched`. Fast path for any event manager, including organizer staff |
| Placement in a `locked` heat, not yet danced | Explicit official action only (D5 set), with a reason, recorded in the heat lock ledger. Never automatic (owner §4.1 point 3). Owner decision S-D2 on whether this is allowed |
| Placement already `danced` (owner Q1) | No scratch. The outcome is a results matter (DNF/disqualification through the K0 correction workflow) |
| Placement in a `certified` heat | No scratch. Changes only through the audited K0 correction workflow |

**Organizer policy** (per program; organizer/studio default with program override):
- `default_resolution` (`no_refund` | `credit` | `refund`; default `no_refund`);
- whether credit is offered, plus the credit terms (§4);
- an optional scratch cutoff after which only `no_refund` applies without an exception.

Choosing anything other than the policy default is an **exception**. It needs the D5 set and a reason, and is
audited.

**R2 coordination.** R2 must never couple a scratch to a refund. A refund *may* record a scratch (R2 D4, approved).
A scratch never records a refund or reserves refund cap. R2 is asked to prove this with a test and to use "Scratch"
in its UI copy. R2 does not implement credits.

## 4. CC1 — Competition credit (separate bounded workstream)

### 4.1 Database contracts (logical; names reserved for the CC1 migration)

| Table | Purpose | Key columns |
|---|---|---|
| `competition_credit_policies` | Organizer/studio default plus program override | issuer scope (`studio_id` xor `organizer_id`), `program_id` null for default, `offer_credit`, `expiry_months`, eligibility scope (S/CC decisions), `applies_to_fees` |
| `competition_credits` | One issued credit (a grant) | `id`, issuer scope, **owner** (`owner_user_id` and/or `owner_client_id`, never email), source `event_id`/`order_id`/`order_item_id`/`entry_id`, `amount_cents`, `currency`, `issued_by`, `reason`, `issued_at`, `expires_at`, `status` (`active`, `exhausted`, `expired`, `voided`), `eligibility` snapshot (jsonb, frozen at issue) |
| `competition_credit_ledger` | Append-only movements; balance = Σ | `credit_id`, `kind` (`issue`, `redeem_reserve`, `redeem_commit`, `redeem_release`, `expire`, `void`, `restore`), `amount_cents` (signed), `order_id` (redemption), `actor`, `at`, `idempotency_key` (unique) |

**Invariants** (each becomes an SQL test):
1. **No double resolution.** Per order item, under the same order lock as R2 (order → registration → payment →
   entries → heat entries): Σ R2 refund allocations (reserved + succeeded) + Σ credit issued ≤ the item's **net paid**
   (R2 D1). The R2 cap and the CC1 issue RPC both read this one combined sum. R2 §8 records the forward contract.
2. **Credit is not a refund.** Issuing credit creates no Stripe object and never touches `event_payments.refund_amount`
   or refund accounting.
3. **Redemption.** Inside the future order's registration transaction, credit is reserved
   (`redeem_reserve`, unique per order). The Stripe charge is reduced by the reserved amount. Settlement commits
   it, and expiry or cancellation of the checkout releases it, mirroring the 10C hold/release. An order fully covered
   by credit settles without Stripe. Over-reservation is impossible: the balance is checked under a row lock on the
   credit.
4. **Paid-by-credit portion.** If a later order paid partly by credit is refunded or scratched with a credit
   resolution, its R2 refund cap is the **Stripe-captured** portion only. The credit-funded portion can only be
   `restore`d as credit, never paid out as cash.
5. **Expiry** is a ledger row written by a scheduled sweeper (idempotent per credit). Expired value is never
   silently reused.
6. Ownership is fixed at issue. Transfer is not supported unless the owner decides otherwise (CC-D6). Owners read
   their credits through a SECURITY DEFINER read RPC; issuer managers read theirs; nobody writes directly.

**Accounting.** Issuing credit is a liability (customer credit), not a refund and not a revenue reduction.
Redemption moves liability to revenue, and expiry handles breakage. Categories are shared, so this needs owner
decision CC-D4 before CC1 SQL.

### 4.2 UI integration points

| Surface | Integration | Owner slice |
|---|---|---|
| Scratch dialog: workspace registrations, check-in, day-of console | Resolution picker (policy default preselected; exception reason when changed) | SC1 (O1 for the day-of console) |
| Program settings | Scratch and credit policy | SC1 / CC1 |
| R2 refund page | Shows credit already issued per item; the cap includes it | CC1 (read-only change to R2 page after R2 merges) |
| Public registration builder and checkout | "Apply competition credit" for an eligible signed-in owner; quote shows credit applied | CC1 (with the 10C registration owner) |
| Dancer portal `/account/competitions` and student API | Credit balance, history and expiry | CC1 (with F3 portal delivery) |
| Organizer reports and closeout exports | Credits issued / redeemed / outstanding / expired per event | CC1 + C1 |

### 4.3 Dependencies and slots

- **SC1** can start now. It moves no money and only reuses `change_competition_entry_lifecycle` plus a policy table.
  Migration slot `20270108090000`.
- **CC1** starts after R2 merges, because it shares R2's cap and lock. It needs owner decisions CC-D1…D8 first.
  Migration slot `20270109090000`.
- File ownership:
  - SC1: `src/app/app/events/[id]/competition/registrations/scratch/**`, `src/lib/competition/scratch/**`.
  - CC1: `src/lib/competition/credits/**`, `src/app/app/events/[id]/competition/credits/**`; registration-checkout
    edits coordinated with the 10C owner files.

## 5. Owner decisions needed

| ID | Question | Engineering default |
|---|---|---|
| S-D1 | Keep both `scratched` and `withdrawn` stored values, or migrate to one? | Keep both; UI shows "Scratched" |
| S-D2 | May an official scratch an entry in a locked-but-not-danced heat (audited), or must the heat be reopened first? | Allowed as an audited official action, no reopen |
| CC-D1 | Who owns a credit: the paying account, the competitor's verified anchor, or both? Guests without an account? | Competitor's verified anchor; guests cannot receive credit until they claim it |
| CC-D2 | Where is credit redeemable: same organizer/studio only, or any DanceFlow competition? | Same issuer only |
| CC-D3 | Default expiry, and whether the organizer may change it | 12 months, organizer-configurable |
| CC-D4 | Accounting categories for credit liability, redemption and breakage | Owner/accountant decision |
| CC-D5 | May one item be partly refunded and partly credited? | Yes, within the combined cap |
| CC-D6 | Transferable between dancers? | No |
| CC-D7 | Can fee lines be credited, or only entry items? | Entry items only |
| CC-D8 | Can credit cover platform fees on the future order? | Owner decision (affects the platform fee rule) |

## 6. Out of scope

Cash-out of credit; transfer; gift cards; non-competition event credit; package/class credits (gc2 engine, a
different unit); SMS credits (TW-4F).
