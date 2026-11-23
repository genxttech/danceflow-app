# TW-4F runbook: Stripe disputes and negative prepaid credit

Status: operating procedure for migration `20270221090100_twilio_dispute_negative_balance_holds.sql` (Git-only; not applied to any hosted database by this change). Nothing here authorizes a price change, a new studio fee, a refund, a Stripe action or a production write. Every hosted step goes through the normal release approval and `danceflow-ops/sb.sh`.

## 0. Owner acceptance needed: this is an alert, not a hold, for negative balances

`docs/twilio/TW-4F_Financial_Safety_Gates_2026-11-23.md` lists "negative-balance hold and alert" before the first test message. **This change delivers the alert only.** It places no hold on a negative balance. What stands in for a hold today is the existing refusal: `_tw4c_require_funds` refuses every fee-bearing reservation, checkout-driven spend and chargeable outbound text while available credit is below zero, and unfunded recurring charges do not run. STOP, START and HELP are never blocked.

The owner must either (a) accept "alert plus the existing refusal" as satisfying that gate row, or (b) ask for a real negative-balance hold in a follow-up slice. This change does not edit the gates document, and the gate row is not satisfied until the owner decides. The **dispute** hold (switch below) is a real hold, but only while its switch is ON.

## 1. What the database does by itself

**Everything in this section happens only while the record switch is ON (section 2).** With it OFF (the default) a dispute and a negative balance behave exactly as they did before this migration: no row, no audit entry, no alert, no hold.

| Event | Recorded | Hold | Alert (platform administrators only) |
| --- | --- | --- | --- |
| Stripe dispute takes credit back (`charge.dispute.created` that is not an inquiry, or `charge.dispute.funds_withdrawn`) | one row in `studio_sms_credit_dispute_holds`, with Stripe's dispute fee recorded as an **estimated provider fee, unallocated** (`est_provider_fee_cents` = 1500, `fee_basis` = `stripe_standard_fee_estimate`, `fee_allocation` = `unallocated`), plus one `credit_hold` audit row (`studio_charged=0`, `fee_allocation=unallocated`) | only when the dispute-hold switch is ON: the business's credit account is put on the existing hold with reason `dispute` (an existing manual hold is left as it is) | one `credit_dispute` (critical) per dispute |
| The same dispute again (redelivery, new event id, created then funds_withdrawn) | nothing | nothing | nothing |
| Dispute of a payment that was already refunded (nothing left to take back) | same as a normal dispute: DanceFlow still loses the money twice | as above | as above |
| Dispute won (`charge.dispute.funds_reinstated`, or `charge.dispute.closed` with `won`) | credit reinstated as before | **stays** until an administrator releases it | one `credit_dispute` (info) per dispute, only if a hold is in place |
| Dispute lost (`charge.dispute.closed` with `lost`) | nothing new (the credit was already taken back) | stays | none beyond the opening alert |
| Available credit (settled balance minus open reservations) crosses from zero or more to below zero, for any reason: dispute, absorbed inbound down to its ceiling, usage settlement | nothing new | **none** (a negative balance already refuses new fee-bearing operations and chargeable texts) | one `credit_negative` (critical) per crossing; recovering and dipping again alerts again |

The dispute fee is never posted to the ledger, never charged to the studio, never shown to a studio and never changes a price. The 1500 figure is an estimate of Stripe's US dispute received fee only (section 5b); the actual fee is on the dispute's Stripe balance transaction.

### What the hold blocks, and what it never blocks

The automatic hold is the existing account hold, so it blocks exactly what a manual hold blocks: fee-bearing reservations (brand, vetting, number, campaign), credit checkout and new top-ups, recurring charges, and chargeable outbound texts (`tw4_usage_begin` through `_tw4c_require_funds`). A payment the studio already made still settles (and stays unspendable while held).

It never blocks STOP, START or HELP handling, inbound recording (`tw4_inbound_record`), or compliance and error replies (`tw4_inbound_reply_allowed`): none of them reads the hold.

## 2. The switches (dark by default)

Two database switches, both OFF until an administrator turns them on (no row = OFF; platform administrator only; written reason of 10-300 characters; append-only log `studio_sms_dispute_hold_switch_log`, one latest row per scope):

| Switch | Function | Gates |
| --- | --- | --- |
| record | `tw4_dispute_record_switch_set(on, admin, reason)` | the dispute-hold row, its audit row and admin alert, the won-dispute alert (checked at the hook itself), and the negative-available-credit trigger. OFF = the migration changes nothing at runtime. |
| hold | `tw4_dispute_hold_switch_set(on, admin, reason)` | the automatic account hold. Needs record ON (refused 55000 otherwise); record cannot be turned off while hold is ON. |

With record ON and hold OFF a dispute is recorded as `not_held`, the alert says no hold was placed, and money paths behave as before. Alerts are delivered only when the existing alert-delivery switch is on. A dispute that happens while record is OFF leaves no row and is never backfilled; if one occurs, handle it from Stripe's dashboard.

Turn them on only with release approval, before studios pay by Stripe (TW-4F financial safety gates, row "Stripe dispute"):

```sql
select public.tw4_dispute_record_switch_set(true, '<platform admin user id>', '<written reason, 10-300 characters>');
select public.tw4_dispute_hold_switch_set(true, '<platform admin user id>', '<written reason, 10-300 characters>');
```

Turning hold off stops NEW holds only; holds already placed stay until released.

**The negative-credit alert can never block a debit.** It is an AFTER UPDATE trigger whose work (switch read, ledger lookup, alert insert) runs in a sub-transaction that turns any error into a warning. A failure writes no alert; it cannot fail the statement that moved the balance, including an inbound STOP, START or HELP debit.

**Forward-only after the first event.** Once record has been ON and has written a dispute-hold row, a `credit_dispute` alert or a `credit_negative` alert, this migration cannot be rolled back (section 5): that evidence is never deleted. Rolling back is possible only while record has stayed OFF (and no switch row exists). Turning the switches off stops new behaviour without losing evidence.

**Apply guard.** The migration replaces `tw4_credit_apply_dispute` and `tw4_credit_set_hold` wholesale, so it first checks that each live body is exactly the version it was written against (20261125090000 / 20261122090000; md5 of `prosrc` with CR removed) and refuses (55000) otherwise. A later change to either function must be merged into this file before it can apply. The latest switch row of a scope is the one with the highest `seq`.

**Reserved reason.** The migration refuses to apply while any account is on a manual hold whose reason is literally `dispute` (any case): give it another reason with `tw4_credit_set_hold` first. After the migration, `tw4_credit_set_hold` refuses that reason.

## 3. Responding to a `credit_dispute` alert

1. List the cases: `select public.tw4_credit_dispute_holds_list('<admin id>', null);` (or pass the legal entity id). Note `hold_id`, `legal_entity_id`, `dispute_id`, `withdrawn_cents`.
2. In the Stripe Dashboard (platform account), open the dispute by its id. Record the actual dispute fee from its balance transaction in the case notes; if it differs from the 1500 estimate, note the difference for the monthly reconciliation (the database row is not edited).
3. Decide whether to submit evidence. The credit purchase, the settlement event and the usage history are in `studio_sms_credit_topups`, `studio_sms_credit_ledger` (keys `topup:`, `usage:`) and `studio_sms_onboarding_audit`.
4. Contact the studio owner through the normal support channel. Do not promise a refund or any fee waiver, and do not tell the owner who bears Stripe's dispute fee: that is undecided (section 5b). No dispute fee is ever debited from the studio's balance automatically.
5. Wait for the outcome.
   - **Won**: the credit is reinstated automatically and an info alert arrives. Release the hold (step 6) once the owner relationship is resolved.
   - **Lost**: the credit stays withdrawn; the balance may be negative. Release the hold only when the owner has agreed how the account continues. A negative balance still blocks spending after the release until the studio funds the account.
6. Release, with a written note (10-500 characters):

   ```sql
   select public.tw4_credit_dispute_hold_release('<legal entity id>', '<hold id>', '<admin id>', '<note>');
   ```

   The business must match the hold (a wrong business is refused). Repeating the call returns `replayed` and changes nothing. The account hold is cleared only when no other dispute hold of that business is still held AND the account's hold reason is still `dispute`; a manual hold placed in the meantime stays and is cleared separately with `tw4_credit_set_hold` once no dispute hold is held. `tw4_credit_set_hold(..., false, ...)` refuses (55000) while any dispute hold is held, and the reason `dispute` is reserved for the automatic hold.

## 4. Responding to a `credit_negative` alert

1. Find the cause in the ledger: `select kind, balance_delta_cents, idempotency_key, note, created_at from public.studio_sms_credit_ledger where legal_entity_id = '<id>' order by seq desc limit 20;` (`dispute_w:` = dispute, `usage:in:` = absorbed inbound, `usage:` = outbound settlement, `refund:` = Stripe refund).
2. A dispute: follow section 3.
3. Absorbed inbound or settlement: confirm the inbound ceiling (`tw4_inbound_exposure_set`) is what was approved, and check the absorbed-inbound alerts. Do not place a hold for a negative balance alone: new spending is already refused; STOP/START/HELP keep working.
4. Tell the owner the account needs funding. Never adjust the balance to hide the debt; an adjustment (`tw4_credit_adjust`) needs its own written reason and approval.

## 5. Rollback

`rollback/20270221090100_twilio_dispute_negative_balance_holds_rollback.sql` restores the previous `tw4_credit_apply_dispute` and `tw4_credit_set_hold`, drops the trigger, functions and tables, and removes the two alert kinds. It refuses (55000) while any dispute-hold row, switch change, `credit_dispute` / `credit_negative` alert, or account held with reason `dispute` exists: that evidence is never deleted. It also refuses (55000) unless `tw4_credit_apply_dispute` and `tw4_credit_set_hold` are still exactly the versions this migration installed (a later migration that changed either must be reviewed first; the check ignores CR). To stop the behaviour without losing evidence, turn the switches off instead.

## 5b. Dispute fee: actual provider liability vs contractual allocation

These are two different questions. This change answers neither as policy: it records an estimate, leaves the allocation `unallocated`, and never moves money for the fee.

### Actual provider liability (what Stripe does, for this account setup)

What the repo's code shows: SMS credit top-ups are **platform charges**. `createSmsCreditCheckout` (`src/lib/billing/smsCreditPurchases.ts`) calls `stripe.checkout.sessions.create` on the platform client (`getStripe()` in `src/lib/payments/stripe.ts`, one `STRIPE_SECRET_KEY`). It passes no `stripeAccount` option (not a direct charge on a connected account), no `transfer_data`, no `on_behalf_of` and no `application_fee_amount`. Its webhook handler (`handleSmsCreditStripeEvent`) treats these events as platform-scoped only. So the payment, any dispute of it and the dispute fees all sit on DanceFlow's own Stripe account.

What Stripe's documentation says about that setup (research fact sheet, 2026-11-23; `[F]` = page read in full): for a platform's own charges (no Connect) both the disputed amount and the dispute fees are debited from the platform (https://docs.stripe.com/connect/account-balances, https://docs.stripe.com/disputes/how-disputes-work `[F]`). US fees: a **$15 dispute received fee** charged when the dispute opens and not returned; a further **$15 dispute countered fee** for disputes initiated after 2025-06-17, charged when evidence is submitted and returned if the dispute is won; neither fee is returned on a partial win (https://support.stripe.com/questions/june-2025-pricing-updates-for-disputes `[F]`). Fee handling when a dispute is withdrawn by the customer is **to verify**. Resolving an inquiry (evidence or a full refund) avoids the fee.

Consequence for the 1500 figure: it is an **estimate of the dispute received fee only**. The countered fee is **additional and unmodelled**: a countered dispute can cost a further $15, returned only on a full win, so the real cost per dispute can be $30, not $15. The real amounts are on the dispute's Stripe balance transaction; the database row is never edited to match. Before relying on the estimate for anything but an alert, confirm the current fee on the Stripe account's own pricing page (**to verify**; fees change).

So, factually, DanceFlow's Stripe account is the one Stripe charges. That is a statement about the provider, not about who ultimately bears the cost.

### Contractual allocation (who ultimately bears it): OWNER DECISION, no default assumed

Stripe's charging DanceFlow does not decide whether, or how, any of it is recovered from a studio. The options below are for the owner; none is implemented, none is assumed, and **no terms change is made or proposed here**:

1. **DanceFlow absorbs the fee.** Nothing is ever recovered from a studio.
2. **Pass-through under terms.** The fee is recovered from the studio under written terms the studio has accepted. This needs those terms to exist first. Whether passing a dispute fee on is permitted under DanceFlow's own Stripe agreement is **to verify** (a Stripe pricing page reportedly restricts passing dispute fees on to connected accounts; the Connect pricing page and the platform agreement govern; this top-up setup is not Connect, so it may not apply). It also needs a defined, visible, auditable mechanism; it is never a silent debit.
3. **Recover only from the disputed credit.** The disputed credit itself is already taken back; the fee would not be recovered beyond that.

Rules that hold whatever the owner decides: the fee estimate is recorded as `unallocated`; **no function in this migration or its hooks debits a studio balance, posts a ledger entry or adjustment, or charges a studio for the fee** (the suite proves it from the catalog and at runtime); alerts and audit text say only that who bears the fee has not been decided. If the owner chooses an option, it needs its own slice with its own approval; changing `fee_allocation` to anything but `unallocated` needs a migration.

## 6. Open owner decisions

- **Won-dispute release stays MANUAL** (owner direction): a won dispute reinstates the credit, keeps the hold and raises an info alert; an administrator releases it with a written note. Nothing in this change releases a hold automatically.
- **Dispute fee allocation (section 5b):** DanceFlow absorbs, pass-through under terms, or recover only from the disputed credit. No default is assumed.
- Whether the recorded fee should come from Stripe's balance transaction instead of the 1500 estimate (needs an application change to the webhook handler).
- When to turn the switches on (proposed: before studios pay by Stripe, per the financial safety gates).
- **Gate acceptance (section 0):** is "negative-balance alert plus the existing `_tw4c_require_funds` refusal and unfunded recurring charges" acceptable for the "negative-balance hold and alert" gate row, or is a real negative-balance hold wanted in a follow-up?

## 7. Notes for reviewers and merge order

- **Textual merge conflicts with sibling slices are expected, not semantic ones.** `scripts/qa/scenarios.json` (each slice appends its migration to `main` and `numeric`) and `RFL_ALERT_KINDS` / `COPY` in `src/lib/sms/providerFeeAlerts/templates.ts` (each slice that adds an alert kind edits the same lines) will conflict when siblings land. Resolve by keeping every slice's entries; the kind list must match the `studio_sms_provider_alerts_kind_check` constraint of the last migration applied. Whoever merges second rebases and re-runs this suite.
- **Pre-existing, not changed here:** a LOST dispute leaves `studio_sms_credit_disputes.state = 'open'` (only a won dispute moves the state; `charge.dispute.closed` with `lost` records nothing). The credit stays withdrawn, so the money is right, but the row still counts as open against what other disputes of that payment may reinstate. This needs its own follow-up; this migration neither fixes nor depends on it.
