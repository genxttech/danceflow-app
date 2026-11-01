# D24 M3-A — SQL foundation for trusted hosted-invoice creation + registration

Status: **local only, dark, draft PR. NOT applied to any hosted database.** Migration `20270208090000_d24_m3a_intent_ledger.sql` (rollback in `rollback/`). Requires M1 (`20270203110000`); independent of M2-B/M2-C (but the QA stack applies them).
No function here is called by application code. `D24_HOSTED_INVOICE_EVENTS` stays OFF. No Stripe call (live or test) is made by anything in this package.

## 1. The two M2-A release blockers (now fixed in SQL)
`d24_register_invoice` keeps its **signature** `(p_studio_id uuid, p_stripe_account_id text, p_stripe_invoice_id text, p_livemode boolean, p_business_object_type text, p_business_object_id text, p_created_by uuid default null)` so existing wrappers/tests still bind, but its semantics change:

| Before (M1) | Now (M3-A) |
|---|---|
| locked `(account, invoice)` only | locks the **invoice id alone first** (`d24inv:<id>`), then the M1 `(account, invoice)` key lock |
| trusted caller's account (NULL = platform) | account is **resolved inside** from `studios.stripe_connected_account_id` of `p_studio_id` (row share-locked until commit). `p_stripe_account_id` is now only an **assertion**: NULL = "no assertion"; non-NULL must equal the studio's account |
| same invoice id under two accounts allowed | an invoice id already registered under **any other account scope** is refused (`23505 d24_invoice_id_scope_conflict`) |
| `p_livemode` could be anything non-null | still required non-NULL (unchanged); real key-mode comparison happens in `d24_intent_mark_provider_created` (§3) |

Refusals: studio missing / no connected account / malformed account (platform scope is never registrable) → `42501 d24_studio_account_unavailable`; supplied account ≠ studio account → `42501 d24_account_mismatch`.
**Behavior change vs M1, deliberately:** (a) NULL/platform registrations now fail; (b) the section-14h "two registrations, crossed account scopes, one deadlock" case no longer exists between two registrations — they serialize on the invoice lock and the second gets a deterministic `23505`. A register-vs-drain crossed key-lock deadlock (40P01) is still possible (a drain batch can hold two key locks) and is still retry-safe; the new QA script keeps a test for it.
Direct `service_role` EXECUTE on `d24_register_invoice` is **kept** (the M2-A wrapper uses it). The creation flow must go through the intent functions; revoking direct EXECUTE once the wrapper is retired is a recommended follow-up (a direct caller bypasses the ledger and the key-mode check).

## 2. Creation-intent ledger
Tables (RLS on, no grants except `service_role` SELECT; writes only through the functions below, guarded by a trigger requiring `d24.writer`):
- `hosted_invoice_creation_intents` — `id, studio_id, business_object_type, business_object_id, idempotency_key, status ('pending'|'provider_created'|'registered'|'failed'|'abandoned'), stripe_account_id (resolved at begin, NOT NULL), stripe_invoice_id, livemode, registry_id, created_by, attempt_count, failure_count, last_error_code, last_attempt_at, created_at, updated_at, provider_created_at, registered_at, settled_at`.
  Unique `(studio_id, idempotency_key)`; unique `(stripe_account_id, stripe_invoice_id)`; at most **one live intent** (`pending|provider_created|registered`) per `(studio_id, type, object id)` — a second invoice for the same object needs the first to be `failed`/`abandoned` (policy choice, relax only deliberately).
  `last_error_code` must match `^[a-z][a-z0-9_]{0,63}$` (anything else is stored as `unsanitized_error_code`); no free text, no Stripe messages.
- `hosted_invoice_creation_intent_events` — append-only audit of every state change (and every recorded retryable failure).
- `hosted_invoice_business_object_types` — **empty by default.** `(business_object_type pk, owner_function regprocedure)`; the function must be `public.<name>(uuid, text) returns boolean`, STABLE/IMMUTABLE, and the type name may not contain `subscription`. Rows can be inserted only by the migration owner (service_role has no write grant) via `public.d24_register_business_object_type(text, regprocedure)` (owner-only). Contract: `fn(p_studio_id, p_business_object_id)` returns `true` only when that object exists and belongs to that studio.

### Transitions
`pending → provider_created | failed | abandoned`; `provider_created → registered | failed`; `registered`, `failed`, `abandoned` are terminal. Enforced by trigger, not only by the functions. Creation and registration **never** infer settlement: no function here writes `hosted_invoice_payments`, credit notes, transitions or any paid/settled state.

## 3. Function contract (all `SECURITY DEFINER`, `search_path = pg_catalog, public, pg_temp`, EXECUTE only to `service_role`)
All take a **server-derived** `p_studio_id` (never from a client). An intent id belonging to another studio is indistinguishable from a missing one: `42501 d24_intent_not_found`.

```
d24_intent_begin(p_studio_id uuid, p_business_object_type text, p_business_object_id text,
                 p_idempotency_key text, p_created_by uuid default null) returns jsonb
d24_intent_mark_provider_created(p_intent_id uuid, p_studio_id uuid, p_stripe_invoice_id text,
                 p_livemode boolean, p_key_livemode boolean, p_stripe_account_id text default null) returns jsonb
d24_intent_register(p_intent_id uuid, p_studio_id uuid) returns jsonb
d24_intent_fail(p_intent_id uuid, p_studio_id uuid, p_error_code text, p_permanent boolean default false) returns jsonb
d24_intent_abandon(p_intent_id uuid, p_studio_id uuid, p_error_code text default 'abandoned', p_min_age_minutes integer default 1500) returns jsonb
d24_intent_list_recoverable(p_older_than_minutes integer default 15, p_limit integer default 50, p_studio_id uuid default null) returns jsonb
```
Return shape (all but list): `{ "outcome": <string>, "intent_id", "status", "stripe_account_id", "stripe_invoice_id", "livemode", "business_object_type", "business_object_id", "idempotency_key", "attempt_count", "failure_count", "last_error_code", ... }`; register adds `registry_id`, `adopted_existing_facts`. List returns a jsonb **array** of the same intent shape, oldest first, bounded (limit clamped 1..200, minutes clamped ≥1).

| function | outcomes | notes |
|---|---|---|
| begin | `created`, `existing`, `existing_terminal`, `stale_key` | idempotent on `(studio, key)`. Same key + different type/object → `23505 d24_idempotency_key_conflict`. Another live intent for the object under a different key → `23505 d24_object_has_live_intent`. Type not registered → `22023 d24_business_object_type_unsupported`. Ownership false → `42501 d24_business_object_not_owned`. Studio account missing → `42501 d24_studio_account_unavailable`. A retry of a live intent after the studio's account changed → `42501 d24_account_changed`. `existing` bumps `attempt_count` (non-terminal only). **`existing_terminal`** (registered/failed/abandoned): the caller must NOT call Stripe. **`stale_key`**: a `pending` intent older than 23h — Stripe forgets idempotency keys after ~24h, so reusing the key could create a second invoice; reconcile with Stripe out of band first. **Use `idempotency_key` verbatim as the Stripe idempotency key and `stripe_account_id` from the result as the `Stripe-Account` header**, so a retry returns the same invoice. Key charset `[A-Za-z0-9_.:-]`, 8..200 chars. |
| mark_provider_created | `provider_created`, `already_recorded` | record **Stripe's response** id + `livemode`. `p_key_livemode` = the deployment's key mode (live secret key ⇒ true, test ⇒ false); `p_livemode <> p_key_livemode` ⇒ `42501 d24_livemode_mismatch`; NULLs ⇒ `22023`. Optional `p_stripe_account_id` (the account used in the call) must equal the intent's ⇒ `42501 d24_account_mismatch`. Different id than recorded ⇒ `23505 d24_intent_invoice_conflict`; id already on another intent ⇒ `23505`. Allowed from `pending` only (else `55000 d24_intent_state`). The studio account is deliberately NOT re-checked (the invoice already exists at Stripe under the intent's account; refusing would orphan it) — `register` re-checks. |
| register | `registered`, `already_registered` | requires `provider_created`; re-checks ownership and account binding; calls `d24_register_invoice` **in the same transaction** and marks `registered`; any failure rolls both back (intent stays `provider_created`). Adopts events that arrived earlier (`adopted_existing_facts`). |
| fail | `recorded` (stays recoverable), `failed` (permanent), `noop_terminal` | permanent fail of an intent whose invoice is already in the registry ⇒ `55000 d24_intent_registered_elsewhere`; permanent fail of a `pending` intent asserts "no invoice exists at Stripe" — the caller must have that proof. increments `failure_count`, stores the sanitized code. `p_permanent=true` ⇒ terminal `failed`. Terminal intents are never changed. Call this from the app after catching an error (a failed `register` rolled back its own writes). |
| abandon | `abandoned` | `pending` only and only if idle ≥ `p_min_age_minutes`, **floored at 1500 min (25h)** so the Stripe idempotency window has passed (a pending intent may hide an invoice whose `mark` never ran; abandoning frees the object for a new invoice) A `provider_created` intent must be failed/registered, never abandoned (a Stripe invoice exists). |
| list_recoverable | array | non-terminal intents idle for ≥ N minutes: `pending` ⇒ retry with the **same key**; `provider_created` ⇒ call `register`. |

Transient SQLSTATEs to retry: `40001`, `40P01`, `55P03`. Everything with `42501`/`23xxx`/`22023`/`55000` is permanent for that input.

## 4. Crash-point matrix (all covered by `scripts/qa/d24-m3a-sql.sh`)
1. crash after `begin`, before Stripe → intent `pending`; retry `begin` (same key) → `existing`; Stripe (same key) creates once; continue.
2. Stripe created, app died before `mark_provider_created` → `pending`; retry with the same key returns the same Stripe invoice id (Stripe-side); `mark` is idempotent.
3. Stripe created + marked, `register` fails/crashes → `provider_created`; listed by `list_recoverable`; `register` retried; webhook events that arrived meanwhile are adopted.
4. DB success then response lost → `register` again returns `already_registered`.

## 5. Verification
`bash scripts/qa/d24-m3a-sql.sh` (disposable `postgres:17`, no ports). Results and review are recorded in the PR description.

## 6. Independent review (fresh reviewer, diff only) and residuals
No P0, no P1. P2s fixed: abandon floor 25h + `stale_key`/`existing_terminal` begin outcomes; permanent-fail guard when the invoice is already registered; `mark` no longer refuses after a studio reconnect (records the invoice against the intent's own account; `register` still refuses until the binding is restored); registry index on `stripe_invoice_id`.
Accepted / documented residuals (follow-ups, not blockers for a dark migration):
- **livemode anchor:** `p_livemode` and `p_key_livemode` are both caller-asserted; the DB only proves they agree. The app must derive `p_key_livemode` from the configured secret key prefix, not from the response. A DB-side deployment-mode anchor (config row) is a recommended follow-up; `livemode_mismatch` flagging in M1 adoption is a second, partial net.
- **Direct `d24_register_invoice` (service_role) still bypasses the ledger and the ownership registry** (M2-A wrapper compatibility). Revoke direct EXECUTE once the wrapper is retired; until then no other caller may use it (contract test).
- A NULL `p_stripe_account_id` is treated as "no assertion" (account still comes from the studio); platform scope is no longer registrable.
- `studios.stripe_connected_account_id` uniqueness across studios is not enforced here (unverified); two studios sharing an account would share a scope.
- `settled_at` means "terminal", never payment-settled. Ownership functions are checked for signature/volatility at registration only, not on later `CREATE OR REPLACE`. Rollback drops registered business-object types (only intents/events are export-gated).
