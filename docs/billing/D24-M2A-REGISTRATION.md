# D24 M2-A — trusted hosted-invoice registration

Status: **merge candidate (draft PR). Nothing here is authorized against a hosted environment.** No migration is added in M2-A.

## Hosted registration is NOT operational
**No legitimate invoice-creation / registration call site exists, so nothing can register a hosted invoice today.** The wrapper is dark and unreferenced (pinned by `registerContract.d24.test.ts`), and with an empty resolver allow-list every production call is refused with `business_object_type_unsupported` before any database access. Invoices Stripe reports without a registry row stay `unmatched` and are never attributed.

Missing integration points (all belong to a future, separately authorized, bounded creation package):
1. A studio-facing server action / route that creates a `send_invoice` Stripe invoice in the studio's connected account. Does not exist.
2. A business-object type and table that owns such an invoice (name must not contain `subscription`), plus its ownership resolver registered in `PRODUCTION_BUSINESS_OBJECT_RESOLVERS`. Does not exist.
3. The call to `registerHostedInvoice` immediately after creation (before the invoice is finalized or sent), with retry / surfacing of `retryable` failures. Does not exist.
4. A SQL-side hardening migration (invoice-id lock, in-function account binding; see follow-ups below).

Authorization dependencies for that package: studio-staff authentication with an explicit billing permission and derived `studioId`/`createdBy` (M2-B operator auth covers operator flows only); owner approval to create real Stripe invoices; hosted DB migrations applied (M1 and any hardening) before the app; `D24_HOSTED_INVOICE_EVENTS` set to `defer`/`on` per the M1 rollout; and no Stripe calls or hosted changes are authorized by M2-A.

## Caller rules
Any code that calls `registerHostedInvoice` must obey all of these; the wrapper cannot verify them itself:
- **Never** pass an unverified Stripe invoice id. The id must be the `id` of the Stripe response of an invoice DanceFlow created moments earlier in the same server flow, never a request field, form value, URL parameter, metadata value or webhook payload.
- **Never** pass studio or account values from a client, request or Stripe metadata. `studioId` comes from the server-side authorization decision; the Stripe account is resolved by the wrapper from the studio and is not an input.
- **Never** pass an unverified `livemode`. It must come from that same Stripe response (and agree with the deployment's key mode, see below), not from a request or configuration guess.
- Register immediately after creation and before finalizing or sending the invoice; handle `retryable` results by retrying, and surface permanent ones.
- Keep `PRODUCTION_BUSINESS_OBJECT_RESOLVERS` empty until the package that adds a creation workflow adds its own resolver and tests.

## Mandatory requirements for the future invoice-creation integration (release blockers)
Neither item below is implemented in M2-A. The creation integration must not ship, and no call site may be added, until both are done and tested:
1. **Account-ownership / invoice-id uniqueness guard at SQL level.** `hosted_invoice_registry` is unique per (account scope, invoice id). A SQL change to `d24_register_invoice` must take an advisory lock on the invoice id alone and refuse (23505) an invoice id already registered under any other scope, so studio B can never register studio A's invoice id (and cause `account_scope_mismatch` flagging on A's facts). The same change should resolve the account inside the function from `studios.stripe_connected_account_id` (refusing NULL or mismatch) and drop the caller-supplied account argument. M1 section 14h (cross-scope deadlock test) must be updated for the new semantics. Until then the wrapper's registry pre-check is a best-effort read, not a guard.
2. **Caller-originated `livemode` check.** `livemode` is currently caller-supplied and unchecked. The integration must derive it from the Stripe invoice response and verify it against the environment (live secret key => `true`, test key => `false`), refusing a mismatch, so test-mode invoices can never be registered by a live deployment or the reverse.

## Inventory result: no invoice-creation workflow exists
Searched `src/` for `invoices.create`, `finalizeInvoice`, `sendInvoice`, `invoiceItems`, `collection_method`, `send_invoice`.
- `src/lib/payments/subscriptions.ts` and `src/app/app/memberships/actions.ts` only create / pay **subscription** invoices with `collection_method: "charge_automatically"`. These are explicitly **not** hosted invoices and must never be registered (the wrapper refuses them).
- `studio_invoices` is DanceFlow-to-studio platform billing and is tenant-writable; it is not evidence of a hosted invoice.
- Nothing creates a Stripe-hosted (`send_invoice`) invoice for a studio client, and no business-object type exists that would own one.

So M2-A does **not** invent a creation workflow. It delivers the server-only registration wrapper that such a workflow must call, and records what that future package needs.

## What shipped
`src/lib/payments/hostedInvoice/register.ts` — `registerHostedInvoice()` around `public.d24_register_invoice` (service role only):
- **Studio** comes from the caller's server-side authorization; **Stripe account** is read from `studios.stripe_connected_account_id` inside the wrapper (never an input). A studio with no/malformed connected account is refused (`stripe_account_unavailable`); platform-account invoices are not studio invoices.
- **Business object ownership**: a closed allow-list of resolvers (`PRODUCTION_BUSINESS_OBJECT_RESOLVERS`, intentionally **empty**). Each resolver must confirm the object exists and belongs to this studio. With no resolvers, every production call fails closed (`business_object_type_unsupported`) without touching the database. No SQL ownership helper is added because there is no real table to validate against.
- **Subscriptions refused** by type pattern and by `subscriptionEvidence`. The database also reclassifies on Stripe subscription markers.
- **Metadata is never an input**; attribution comes only from the registry. Metadata mismatches on later events are flagged by M1, not trusted.
- **Idempotent**: identical re-registration → `already_registered`. A different owner/object/livemode → SQLSTATE 23505 → `registration_conflict` (safe fixed code, no database text). Registry rows are never overwritten.
- **Out of order**: events recorded before registration are adopted inside `d24_register_invoice` (`adoptedExistingFacts`). Events after registration match the registry.
- **Retry**: 40P01 / 40001 / 55P03 are retried up to 3 times (the aborted transaction wrote nothing; see the M1 rollout note on cross-account deadlock). Everything else maps to `registration_failed` / `registration_unavailable` with `retryable: true`.

## Requirements for the future invoice-creation package (not built)
1. Authorization: the action must authenticate a studio staff member with a billing permission, derive `studioId` server-side, and pass `createdBy` from the session. (Depends on M2-B operator auth for any operator-initiated flow.)
2. Create the invoice (`collection_method: send_invoice`) in the studio's connected account, then call `registerHostedInvoice` **immediately** with the Stripe response's `id` and `livemode`. Registration failure after creation must be retried (idempotent) and surfaced; do not email/finalize the invoice to the customer until registration succeeded.
3. Add a resolver for the new business-object type to `PRODUCTION_BUSINESS_OBJECT_RESOLVERS`, with a test that a cross-studio object id is refused. The type name must not contain `subscription`.
4. Keep Stripe metadata informational only.
5. Decide the invoice-before-registration window: Stripe may deliver `invoice.*` events before the registration call returns; M1 adopts these, so no ordering guarantee is required.

## Evidence
- Unit: `src/lib/payments/hostedInvoice/__tests__/register.d24.test.ts`.
- Real Postgres (disposable container, no ports/volumes): `bash scripts/qa/d24-m2a-wrapper.sh` runs the real wrapper against the real function: idempotency, cross-studio takeover, cross-studio object, out-of-order adopt/match with forged metadata, 12-way identical concurrency, two-studio race.

## Residual risk found by the real-Postgres run: registry is keyed per account scope
`hosted_invoice_registry` is unique on `(account scope, invoice id)`, not on the invoice id. Because the wrapper derives the account from the studio, studio B registering an invoice id that studio A already registered would otherwise create a second row under B's own account (it never touches A's scope, and A's events never match B's). Stripe ids are globally unique and the id comes from the studio's own creation response, so this should not occur, but M2-A adds a best-effort cross-scope pre-check (read of the registry; refuses with `registration_conflict`). It is not a lock: two simultaneous registrations by different studios can both pass it, leaving B a row under B's own scope only (asserted in the PG race test).
**Follow-up (not done, changes M1 semantics and its section 14h cross-scope deadlock test):** make `d24_register_invoice` take an invoice-id-only advisory lock and refuse an invoice id already registered under a different scope.

## Independent review follow-ups (no P0/P1 found)
- **P2 (SQL follow-up with the invoice-id lock above):** `d24_register_invoice` trusts its caller for the account and the studio-to-account binding, and accepts a NULL (platform) account. The wrapper is the only guard, and it reads the account moments before the rpc (a reconnect in between would register under the old account). Fix in SQL: look the account up inside the function, refuse NULL / mismatch, drop the account argument. Until then, no other caller may use the rpc (contract test).
- **P3:** `subscriptionEvidence` is caller-supplied and the type check is a name heuristic; the future resolver must itself confirm the object is not a subscription, and M1 flags `subscription_registry_conflict` afterwards. Studio connected-account uniqueness was not verified in this package.
- Fixed in M2-A: integrity violations (23xxx other than 23505) are non-retryable; business object ids are charset-restricted.

## Review summary (two independent reviewers; second on the final diff)
- **P0:** none. **P1:** none.
- **P2 (blocks any call site):** registry uniqueness is per (account, invoice id) and the wrapper cannot prove an invoice id belongs to the studio's account without a Stripe call. A future caller passing an unvalidated id could let studio B register studio A's id under B's account and cause `account_scope_mismatch` flagging on A's not-yet-registered facts. Required before any call site: SQL invoice-id-only lock + refusal, in-function account binding, and the call site must take the id only from its own Stripe creation response.
- **P3 (fixed):** `import "server-only"`; 42501 / PGRST301 / 23xxx are non-retryable.
- **P3 (open):** `subscriptionEvidence` is optional (fail-open by design; M1 flags afterwards); no backoff on retries; a lost-reply retry returns `already_registered` without the adoption signal; `livemode` is caller-supplied and not checked against the environment; the PG race test tolerates a second-scope row for the racing studio.

## Not done / open
- No call site exists, so the wrapper is unreferenced by app code by design (a contract test pins this).
- `retryable` results must be handled by the future caller; there is no queue for failed registrations.
