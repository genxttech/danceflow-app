# D24 M1 — rollout, limitations and recovery

Status: **merge candidate only; nothing here is authorized to run against a hosted environment.** Every hosted step below needs its own owner authorization.

## Required release sequence
1. Apply `20270203090000_d24_hosted_invoice_facts.sql` (rollback: `rollback/20270203090000_d24_hosted_invoice_facts_rollback.sql`, refuses while evidence rows exist).
2. Deploy the handler with `D24_HOSTED_INVOICE_EVENTS=defer`.
3. Verify durable deferred capture (read-only):
   `select state, count(*) from public.hosted_invoice_deferred_events group by 1;` and that new D24 event types appear as `pending` rows.
4. Run an authorized, idempotent drain: `select public.d24_drain_deferred(25);` (service role; repeat until `applied = 0`). Batches are capped at 100 because locks are held until commit.
5. Verify reconciliation: `hosted_invoices` states, `hosted_invoice_deferred_events` all `applied` (investigate any `rejected`), no unexpected `anomaly_codes`.
6. Switch to `D24_HOSTED_INVOICE_EVENTS=on`.

Applying is idempotent across defer, drain and the live route (event-id evidence, invoice-payment-id and credit-note-id keys, per-invoice advisory lock). Enabling `on` after a drain cannot duplicate a payment, credit note, transition or tenant association. No step creates settlement, ledger, refund, credit or registration effects.

## Off mode is not reconciliation
With the variable unset (or any value other than `defer` / `on`) the route acknowledges D24 event types with outcome `d24_not_enabled`. **That is not reconciled and nothing is stored.** Such events are recoverable only by a Stripe event resend; list them with:
`select provider_event_id, event_type, created_at from public.payment_provider_events where outcome = 'd24_not_enabled' order by created_at;`
Events received before durable capture exists carry this limitation.

## Preserved records, no suppression
Unmatched, anomalous, out_of_scope and rejected-deferred records are preserved. Nothing deletes, resolves or suppresses them automatically. There is no dismissal capability in M1.
A future operator workflow must require verified authorization, tenant scope, a reason and append-only audit evidence.

## d24_acknowledge_anomalies
The `p_actor` argument is **not verified** (no studio-membership or admin check). Controls in M1:
- revoked from `public`, `anon`, `authenticated`; executable by `service_role` only (asserted in SQL checks and in `rolloutContract.d24.test.ts`);
- not referenced by any application code; no route, server action or API endpoint calls it, and no generic RPC wrapper accepts a caller-supplied function name;
- it can only add to `acknowledged_codes` on an attributed invoice (never attribute, never erase a code) and always writes an audit row.
Do not expose it to any endpoint until the operator workflow above exists.

## Known concurrency case: cross-account registration deadlock
`d24_register_invoice` takes its own (account scope, invoice id) advisory key, then the keys of other account scopes that already hold facts for the same invoice id, in sorted order. Two registrations of the same invoice id under different scopes, or a registration racing a drain whose batch holds the crossed keys, can acquire them in opposite orders and PostgreSQL aborts one transaction with SQLSTATE 40P01. Stripe invoice ids are globally unique, so this should not occur in practice.
**Retry is safe:** the aborted transaction wrote nothing outside itself; registration is idempotent (`already_registered`) and refuses a different owner; event evidence, payments and credit notes are keyed so a repeat never duplicates them; no external call or financial effect is taken. The drain already treats 40P01 as transient (the event stays pending and does not count toward quarantine). `scripts/qa/d24-m1-sql.sh` section 14h induces the deadlock and asserts the abort leaves no rows and a retry converges without duplicates.

## Open items (separate work)
Registration call site (nothing creates Stripe invoices yet), verified-authorization operator workflow (acknowledge / dismiss / requeue), scheduled drain, dead-letter recovery, reverse-direction livemode guard, real Stripe CLI delivery tests.
