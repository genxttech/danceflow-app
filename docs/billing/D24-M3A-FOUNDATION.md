# D24 M3-A — SQL foundation for trusted hosted-invoice creation + registration

Status: **local only, dark, draft PR. NOT applied to any hosted database.** One migration `20270208090000_d24_m3a_intent_ledger.sql` (rollback in `rollback/`). Requires M1 (`20270203110000`) and M2-B (`20270207090000`, operator helpers/switch).
No function here is called by application code. `D24_HOSTED_INVOICE_EVENTS` stays OFF. No Stripe call (live or test) is made by anything in this package. Nothing here ever finalizes, sends or collects an invoice, and nothing infers settlement.

## 1. The two M2-A release blockers (fixed in SQL)
`d24_register_invoice` keeps its **signature** `(p_studio_id uuid, p_stripe_account_id text, p_stripe_invoice_id text, p_livemode boolean, p_business_object_type text, p_business_object_id text, p_created_by uuid default null)`, but:
- it locks the **invoice id alone first**, then the M1 `(account, invoice)` key lock, and refuses (`23505 d24_invoice_id_scope_conflict`) an invoice id already registered under any other account scope;
- the account is **resolved inside** from `studios.stripe_connected_account_id` of `p_studio_id` (row share-locked for the calling transaction). `p_stripe_account_id` is only an assertion (NULL = none; non-NULL must equal the studio's). NULL / malformed / platform account ⇒ `42501 d24_studio_account_unavailable`; mismatch ⇒ `42501 d24_account_mismatch`. Platform scope is no longer registrable;
- `p_livemode` must be non-NULL; the real key-mode comparison is in `d24_intent_mark_provider_created`.
M1 section 14h changed deliberately: two registrations with crossed scopes now serialize (second gets the deterministic 23505, no deadlock). A register crossing a drain-style holder of two key locks can still hit 40P01 and is retry-safe (kept as a test). Direct `service_role` EXECUTE on `d24_register_invoice` is kept for the M2-A wrapper; it bypasses the ledger — revoke it once the wrapper is retired.

## 2. Tables (RLS on, `service_role` SELECT only, writes only through the functions below)
- `hosted_invoice_creation_intents`: `id, studio_id, business_object_type, business_object_id, idempotency_key, request_fingerprint, status, stripe_account_id, stripe_invoice_id, livemode, registry_id, created_by, attempt_count, failure_count, last_error_code, outcome_unknown, review_reason, recovery_lease_id/_expires_at, last_attempt_at, created_at, updated_at, provider_created_at, registered_at, settled_at`.
  **Immutable** (trigger-enforced): `studio_id`, type, object id, `idempotency_key`, **`request_fingerprint`**, `stripe_account_id`, `created_by`, **`created_at`**, and a recorded `stripe_invoice_id`/`livemode`.
  Unique `(studio_id, idempotency_key)`; unique `(stripe_account_id, stripe_invoice_id)`; one **live** intent (`pending|provider_created|registered|needs_review`) per `(studio, type, object)` — **`needs_review` holds the object**, so an uncertain first creation can never be followed by a second invoice.
  `last_error_code`/`review_reason` match `^[a-z][a-z0-9_]{0,63}$` (anything else is stored as `unsanitized_error_code`).
- `request_fingerprint` = lowercase sha256 hex (64 chars) of the canonical request (studio, account, customer ref, lines, currency, object ref), **computed by the app**; the DB cannot verify its content, it enforces that it never changes for a key.
- `hosted_invoice_creation_config` (private singleton): `safe_retry_minutes`, default **720 (12h)**, CHECK 1..**1380** (strictly below Stripe's 24h minimum). Changed only by the owner-only `d24_intent_set_window(int)`. **Fail closed:** a missing row or out-of-range value is a zero window (every pending intent counts as expired). It is a safety control, **not proof** that Stripe still holds the key.
- `hosted_invoice_creation_intent_events` — append-only audit of every state change (and recorded retryable failure), with `actor_user_id` + `reason` for operator actions.
- `hosted_invoice_creation_attempts` — append-only retry history: `attempt_kind` (`begin|begin_replay|recovery_replay|outcome|failure`), `outcome_code`, `outcome_unknown`, `created_at`.
- `hosted_invoice_business_object_types` — empty by default, ownership registry (section 6).

## 3. State machine
```
pending ──mark_provider_created──▶ provider_created ──register──▶ registered (terminal)
   │  ▲ replay with the SAME key (inside window,        │
   │  └─ fingerprint matches, lease held)               │ register hits an ownership/account/scope MISMATCH
   │                                                     ▼
   ├─ window expired / fingerprint mismatch / account changed / ambiguity ──▶ needs_review ──operator attach──▶ registered
   │                                                                      └─operator abandon (no invoice recorded)──▶ abandoned (terminal)
   └─ permanent fail (pending only, outcome NOT unknown, NO invoice recorded) ──▶ failed (terminal)
(an intent that records a Stripe invoice id can NEVER become failed/abandoned: trigger-enforced; it must be registered or attached)
```
Illegal transitions are refused by a trigger, not only by the functions. `outcome_unknown` is a sticky flag on `pending` (timeout / ambiguous end): the invoice MAY exist, so a permanent fail is refused (`55000 d24_intent_outcome_unknown`); recovery is only a same-key replay inside the window, otherwise `needs_review`. The database never generates a replacement key or intent.

## 4. Function contract
All `SECURITY DEFINER`, `search_path = pg_catalog, public, pg_temp`. Intent functions: EXECUTE to `service_role` only; take a **server-derived** `p_studio_id`; another studio's intent is indistinguishable from a missing one (`42501 d24_intent_not_found`).
```
d24_intent_begin(p_studio_id uuid, p_business_object_type text, p_business_object_id text, p_idempotency_key text,
                 p_request_fingerprint text, p_created_by uuid default null) returns jsonb          -- NOTE new 5th arg
d24_intent_mark_provider_created(p_intent_id uuid, p_studio_id uuid, p_stripe_invoice_id text, p_livemode boolean,
                 p_key_livemode boolean, p_stripe_account_id text default null) returns jsonb
d24_intent_register(p_intent_id uuid, p_studio_id uuid) returns jsonb
d24_intent_fail(p_intent_id uuid, p_studio_id uuid, p_error_code text, p_permanent boolean default false) returns jsonb
d24_intent_record_outcome(p_intent_id uuid, p_studio_id uuid, p_outcome_code text, p_outcome_unknown boolean default false) returns jsonb   -- NEW
d24_intent_claim_recovery(p_intent_id uuid, p_studio_id uuid, p_request_fingerprint text, p_lease_seconds integer default 120) returns jsonb -- NEW
d24_intent_flag_review(p_intent_id uuid, p_studio_id uuid, p_reason_code text) returns jsonb                                             -- NEW
d24_intent_list_recoverable(p_older_than_minutes integer default 15, p_limit integer default 50, p_studio_id uuid default null) returns jsonb
-- REMOVED: d24_intent_abandon (abandonment is operator-only, below)
```
Every intent result carries `outcome` plus `intent_id, status, stripe_account_id, stripe_invoice_id, livemode, request_fingerprint, outcome_unknown, review_reason, replay_deadline (= created_at + window), attempt_count, failure_count, last_error_code, ...`.

| function | outcomes | notes |
|---|---|---|
| begin | `created`, `existing`, `register_only`, `existing_terminal`, `needs_review` | idempotent on `(studio, key)`. Same key + different type/object ⇒ `23505 d24_idempotency_key_conflict`; **same key + different fingerprint ⇒ `23505 d24_request_fingerprint_mismatch` (never a new intent)**. `existing` (pending, inside the window) ⇒ replay with the **same key and `Stripe-Account`**. `register_only` (provider_created) ⇒ do NOT call Stripe, call `register`. `existing_terminal` (registered/failed/abandoned) and `needs_review` ⇒ **do NOT call Stripe**. A `pending` intent older than the window is moved to `needs_review` here (`window_expired`). Another live intent for the object under a different key ⇒ `23505 d24_object_has_live_intent`. Unregistered type ⇒ `22023 d24_business_object_type_unsupported`; ownership false ⇒ `42501 d24_business_object_not_owned`; studio account missing ⇒ `42501 d24_studio_account_unavailable`; reconnect since begin ⇒ `42501 d24_account_changed`. Key `[A-Za-z0-9_.:-]{8,200}`, fingerprint `[0-9a-f]{64}`. |
| mark_provider_created | `provider_created`, `already_recorded` | records Stripe's response id + `livemode`. `p_key_livemode` = the deployment key mode derived from the **configured secret-key prefix** (not the response); `p_livemode <> p_key_livemode` ⇒ `42501 d24_livemode_mismatch`; NULLs ⇒ `22023`. Optional `p_stripe_account_id` must equal the intent's ⇒ `42501 d24_account_mismatch`. Different id than recorded ⇒ `23505 d24_intent_invoice_conflict`. From `pending` (else `55000 d24_intent_state`). On a `needs_review` intent it still RECORDS the id (`recorded_in_review`: a late response must never be lost; abandon is then refused so an operator must attach). On a `pending` intent past the window it records the id but moves the intent to `needs_review` (`window_expired_provider`). No studio-account re-check (the invoice exists at Stripe; refusing would orphan it). Clears `outcome_unknown`. |
| register | `registered`, `already_registered`, `needs_review` | requires `provider_created`; same transaction as `d24_register_invoice`. An **ownership / account / scope mismatch** (`42501`/`23505`/`22023` from the checks) ⇒ the intent moves to `needs_review` (never registered) and the call **returns** `needs_review` with `review_reason` (e.g. `account_changed`, `business_object_not_owned`, `registration_conflict`). Only deliberate `d24_*` refusals are treated as mismatches; any other error (including a bare 42501) is re-raised. A transient or unexpected failure **raises** and rolls back: the intent stays `provider_created` and recoverable (call `fail`/retry). Adopts earlier webhook events (`adopted_existing_facts`). |
| fail | `recorded`, `failed`, `noop_terminal`, `needs_review` | `p_permanent=false` records a retryable failure (stays recoverable). Permanent ⇒ terminal `failed`, refused while `outcome_unknown` (`55000 d24_intent_outcome_unknown`) and whenever an invoice id is recorded (`55000 d24_intent_has_invoice`). |
| record_outcome | `recorded`, `noop_<status>` | log how a Stripe call ended. `p_outcome_unknown=true` for timeouts / ambiguous ends (sticky flag). Appends attempt history; clears any recovery lease. |
| claim_recovery | `replay_permitted`, `lease_held`, `register_only`, `needs_review`, `terminal` | row lock + lease so concurrent workers cannot both replay. **`replay_permitted=true` only** for a `pending` intent inside the window, fingerprint matching, studio account unchanged, no live lease; returns `lease_id`, `lease_expires_at`, and the original `idempotency_key`/`stripe_account_id`. Fingerprint mismatch / window expired / account changed ⇒ moved to `needs_review` with `replay_permitted=false`. `provider_created` ⇒ `register_only` (never replay Stripe). |
| flag_review | `needs_review`, `noop_terminal` | any ambiguity found by the app ⇒ fail closed. Idempotent. |
| list_recoverable | array | `pending`/`provider_created` idle ≥ N minutes (clamped ≥1), bounded (≤200). `needs_review` is listed via the operator function. |

### Operator functions (verified identity, M2-B pattern)
`GRANT EXECUTE TO authenticated`; each checks inside: the DB switch (`hosted_invoice_operator_config.enabled`, default OFF ⇒ `55000 d24_op_disabled`), verified `auth.uid()`, **AAL2**, `platform_admin` (`42501 d24_op_platform_admin_required`), mandatory reason 10..1000 chars, audited with `actor_user_id` + `reason`. They accept no actor argument and never read Stripe metadata.
```
d24_op_flag_creation_review(p_intent_id uuid, p_reason text)        -- pending|provider_created -> needs_review
d24_op_attach_creation_invoice(p_intent_id uuid, p_stripe_invoice_id text, p_livemode boolean, p_stripe_account_id text, p_reason text)
d24_op_abandon_creation(p_intent_id uuid, p_reason text)            -- needs_review (no invoice recorded) -> abandoned
d24_op_list_creation_reviews(p_limit integer default 50)
```
`attach` (needs_review → registered) validates: intent in `needs_review`; supplied account **equals the intent's** account (`d24_account_mismatch`); studio's current account still equals it (`d24_account_changed`); id/account format; webhook facts already recorded for the invoice agree on livemode and are not attributed to another studio (`d24_livemode_mismatch`); ownership via the registry (`d24_business_object_not_owned`); not registered elsewhere / for another object (`d24_registration_conflict`, `d24_invoice_id_scope_conflict`); then registers via `d24_register_invoice`. Any refusal rolls back and leaves the intent in `needs_review` (the refused attempt is not audited; DB errors are the evidence). `abandon` is refused when an invoice id is recorded (`d24_intent_has_invoice`).

## 5. Recovery rules (owner integrity requirement)
Never assume `provider_created` was persisted. After a crash with Stripe success but no DB update, only the `pending` intent exists:
1. A recovery worker calls `d24_intent_claim_recovery` (or the original request path calls `begin`, which returns `existing`).
2. If `replay_permitted`, replay to Stripe with the **original** `idempotency_key` and `Stripe-Account` (same body ⇒ same fingerprint). The response is the same invoice → `mark_provider_created` → `register`. All steps idempotent; a replay that yields a different invoice id is refused.
3. Otherwise (window expired, fingerprint changed, account changed, unknown/ambiguous) the intent is `needs_review`: **no replay, no replacement key, no second invoice**; a platform admin reconciles with Stripe evidence via `d24_op_attach_creation_invoice` or, if provably none exists, `d24_op_abandon_creation`.
4. Recovery never finalizes, sends or collects. A draft has no hosted payment URL; this package only records and registers.
Timeouts/dropped connections: call `d24_intent_record_outcome(..., true)`; do not call `fail(permanent)`.

## 6. Registering a business-object type (M3-C and later) — no M3-A function is edited
In the package's own migration (slot after `20270208`), after its table exists, run as the migration owner:
```sql
create function public.d24_owns_<type>(p_studio_id uuid, p_business_object_id text)
returns boolean language sql stable set search_path = pg_catalog, public
as $$ select exists (select 1 from public.<table> where id::text = p_business_object_id and studio_id = p_studio_id) $$;
select public.d24_register_business_object_type('<type>', 'public.d24_owns_<type>(uuid,text)'::regprocedure);
```
Enforced by `_d24_bot_guard`: function in `public`, exactly `(uuid, text) returns boolean`, STABLE/IMMUTABLE, not set-returning; type `^[a-z][a-z0-9_]{0,62}$`, no `subscription`. It must return true only when the object exists **and belongs to that studio**. `begin`, `register` and operator `attach` all call it. The package rollback should `delete from public.hosted_invoice_business_object_types where business_object_type='<type>'` first (begin then fails closed). Object ids `[A-Za-z0-9_.:-]{1,128}`.

## 7. Verification
`bash scripts/qa/d24-m3a-sql.sh` (disposable `postgres:17`, `--network none`): applies claim + M1 + M2-C + M2-B + M3-A, the ten required scenarios (1 crash before Stripe; 2 crash after Stripe before recording; 3 retry while retryable; 4 same key changed parameters; 5 concurrent recovery; 6 unknown-outcome timeout; 7 recovery after the window; 8 provider invoice found but registration fails; 9 ownership/account mismatch; 10 operator: authorized / unauthorized / AAL1 / wrong tenant), rollback and re-apply. Results are in the PR description.

## 8. Independent review and residuals
Reviews are summarized in the PR. Accepted / documented residuals:
- **livemode anchor:** `p_livemode`/`p_key_livemode` are both caller-asserted; the DB only proves they agree. The app must derive the key mode from the configured secret-key prefix. A DB-side deployment-mode anchor is a recommended follow-up (M1 adoption also flags `livemode_mismatch`).
- Direct `d24_register_invoice` (service_role) bypasses the ledger and the ownership registry (M2-A wrapper compatibility). A NULL account assertion means "no assertion".
- `studios.stripe_connected_account_id` uniqueness across studios is not enforced here. `settled_at` means "terminal", not payment-settled. Ownership functions are validated at registration only. A refused operator attempt is rolled back (not audited). Rollback drops registered business-object types and the window config (only intent/event/attempt evidence is export-gated).
- The fingerprint's content is app-defined; the DB guarantees only immutability and equality.
