# CF1 settlement repair (missed competition payment webhook)

Status: dark, Git-only. No SQL, no scheduler entry, no env set anywhere.

## Problem
A paid competition Checkout Session is finalized only by the webhook. If Stripe never delivers (or retries are exhausted), the order stays `pending`;
the status page only shows "processing" and the event-cart sweeper has no competition attempt rows.

## Where the binding lives
`event_orders` row with `metadata->>source = 'competition_registration'`:
`stripe_checkout_session_id` (column) and `metadata->>stripe_account_id`, both written by `attach_competition_registration_checkout` before the buyer
sees the session. `finalize_competition_registration` re-validates session, account, amount and price snapshot against that row and is idempotent
(`already_finalized` / `already_recorded` / `late_payment_after_release`). No new SQL is needed.

## Candidate query (`listRepairCandidates`)
`event_orders` where status = pending, payment_status = pending, source = competition_registration, `stripe_checkout_session_id` not null,
`updated_at` between now-14d and now-15min (minimum 5). Oldest 4x batch, then a random sample of `batch` (default 20, hard cap 50) so a few permanently
unresolvable orders cannot starve the others (there is no per-order backoff without SQL).

## Reading Stripe and finalizing (`repairCompetitionOrder`)
1. Binding must be well-formed (uuid, `acct_...`, `cs_...`); otherwise `binding_invalid`, no Stripe call.
2. `checkout.sessions.retrieve(session, {expand:[payment_intent]}, {stripeAccount: <the order's bound account>})`. Read error -> `stripe_read_failed`, nothing else.
3. Stripe's own record must name this order and session and be `complete` + `paid`; otherwise `binding_invalid` / `not_paid` (open, expired, unpaid: do nothing).
4. Only then call the EXISTING `applyCompetitionCheckoutEvent` with an event built from that Stripe read. That function re-reads Stripe
   (`verifySettlementWithStripe`: amount, currency, PaymentIntent succeeded and received) and calls `finalize_competition_registration` with the values read back,
   which the database checks against the order. A synthetic or replayed event cannot authorize anything: the authority is Stripe's record plus the database binding.
5. After `finalized`, the same follow-ups as the webhook (fee sync, confirmation) run best-effort.

## Safety properties
- Disabled by default: route answers 404 unless `COMPETITION_SETTLEMENT_REPAIR=on`; then `CRON_SECRET` is required. Not in `vercel.json`.
- Never releases, expires or cancels (a paid session on an already released order is outside this repair; it needs the webhook or staff).
- Idempotent against the webhook racing the repair (database finalize is the single serialization point).
- Fail-closed on any read or disagreement; one order failing does not stop the batch; logs carry masked ids and outcome codes only.

## Not covered / residual
Orders already released (expired/cancelled) while Stripe shows paid; per-order backoff; scheduling (release owner adds the cron deliberately).
