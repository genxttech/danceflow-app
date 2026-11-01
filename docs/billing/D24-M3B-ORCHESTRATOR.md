# D24 M3-B — inactive hosted-invoice creation orchestrator

Status: **draft, dark, TypeScript only. No SQL, no UI, no route/action call site, no Stripe client constructed, no Stripe call of any kind (live or test), nothing applied to any hosted database.** Stacks on the M3-A SQL (`d24_intent_*`, hardened `d24_register_invoice`); M3-A must be applied before anything here could ever be activated.

## What shipped
`src/lib/payments/hostedInvoice/create.ts` (server-only):
- `createHostedInvoice(request, deps)`, `resumeIntent(intentId, actor, deps)`, `sweepRecoverableIntents(deps, opts)` (bounded, unscheduled), `createSupabaseIntentStore(supabase)` (the only place the M3-A function signatures appear), `deriveIdempotencyKey`, `livemodeFromSecretKey`, `isHostedInvoiceCreationEnabled`.
- Flag `D24_HOSTED_INVOICE_CREATION`: only the exact string `on` enables it; checked before any database or Stripe access in all three entry points.
- The Stripe client is an injected interface with exactly two operations (`createDraftInvoice`, `addInvoiceLines`). No finalize / send / pay / void exists in the interface. Drafts use `collection_method: send_invoice`, `auto_advance: false`; Stripe sends nothing for a draft.
- `PRODUCTION_INVOICE_SPEC_RESOLVERS` is **empty** (decision D1 pending). A resolver returns the customer / currency / lines from trusted server records (or `null` for "not this studio's object"); nothing about the invoice content comes from the request.

## Flow
authorize (caller-verified `AuthorizedBillingActor`; studio/user derived from it only) → resolve spec (ownership) → resolve account from `studios.stripe_connected_account_id` + `stripe_connect_charges_enabled` (fail closed) → `d24_intent_begin` (key derived from studio+type+object+requestKey+content fingerprint; SQL re-resolves the account and re-checks ownership, and its account must equal ours) → Stripe create + lines with the intent key (and `:lines` suffix) in the connected account → validate the response (draft, send_invoice, customer, currency, no subscription markers, total equals spec) → **id and livemode taken from the response**; livemode must equal the deployment key mode (`sk_live_`/`rk_live_` ⇒ true, `sk_test_` ⇒ false, anything else refuses everything) → `d24_intent_mark_provider_created` (SQL re-checks the key mode, account and studio) → `d24_intent_register`. The caller must not finalize or send unless the result is `registered`.

## Recovery
- `resumeIntent`: `provider_created` ⇒ register only (never a Stripe call). `pending` ⇒ re-derive the spec from trusted records; refuse if the content fingerprint (key suffix) changed, if the account changed, or if the intent is older than 20 h (Stripe forgets idempotency keys after ~24 h and would create a second invoice) — otherwise re-issue the create with the same key. A studio actor can only resume its own intents; foreign and unknown ids both return `intent_not_found`. The system actor is the exact object `{ system: "d24_recovery" }`.
- Because the ledger stores no payload, a changed spec under the same `requestKey` yields a different key and is then refused by the ledger's one-live-intent-per-object rule (`intent_payload_conflict`). A second invoice for one object requires the first to be `failed`/`abandoned` (M3-A policy).
- Retryable Stripe failures (connection, 5xx, 429, key-in-use) leave the intent `pending`; permanent ones mark it `failed`. Messages from Stripe or the database are never returned.

## Evidence
- Unit (`create.d24.test.ts`, offline fake Stripe with same-key⇒same-invoice / different-payload⇒error semantics): flag matrix, key mode, actor forgery, cross-tenant, smuggled fields, account fail-closed, subscription refusal, spec validation, livemode both directions, response forgery, metadata untrusted, duplicate + 10-way concurrency, crash points (before Stripe, after create before lines, mark failure, register failure), permanent rejection, idempotency window, spec change, resume authorization, sweep bounds, offline signed webhook fixture.
- Contract (`createContract.d24.test.ts`): no application code references the orchestrator, flag or `d24_intent_*`; no vercel schedule; `create.ts` imports/constructs no Stripe client and has no finalize/send/pay capability.
- Real Postgres (`bash scripts/qa/d24-m3b-orchestrator.sh`, needs `D24_M3A_MIGRATION=<path to the M3-A migration>` until M3-A is merged): the real orchestrator + real store + real M1/M2-C/M3-A SQL, offline fake Stripe: happy path, 8-way concurrency (one invoice/intent/registry row), cross-tenant incl. a forged permissive TS resolver (SQL ownership refuses), no/invalid account, livemode forgery, SQL key-mode/account/studio checks, register failure then resume, crash before Stripe, webhook-before-registration adoption, forged metadata/foreign-account event.

## Not done / activation holds
- No business object, no resolver, no UI, no route: nothing can create an invoice. Activation needs D1, a separately authorized call site with real staff authentication + billing permission, M3-A applied hosted, a real Stripe client factory (deliberately absent), owner approval for Stripe calls, and a scheduler decision for the sweep.
- Retryable failures are not recorded in the ledger (`d24_intent_fail` non-permanent) — only permanent ones are.
- `PRODUCTION` hosted payments remain unattributed until registered; D24 events stay OFF/defer per the M1 rollout.
