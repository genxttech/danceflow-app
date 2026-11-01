# D24 M2-D — local integration, security tests and acceptance harness

Status: **test infrastructure only (no product code, no migration).** Nothing here touches a hosted database, Stripe, a deploy or an env var. The Postgres is a disposable local container (no published ports, no network, volume removed with the container). Every PASS below was produced by a real run; anything that could not run is BLOCKED with the reason, never counted as passed.

## What it is

| File | Purpose |
|---|---|
| `scripts/qa/d24-stack.sh` | `up [--m2a REF] [--m2b REF] [--m2c REF] [--stub FILE]` / `down` / `layers`. Starts one container, applies the PAY-WH-1 claim migration (unmodified, on a reconstructed base table) and M1, then every migration a sibling draft **adds** under `src/lib/supabase/migrations/20270204..09*` (from the git ref, in version order M2-A, M2-C, M2-B). A layer with no migration (M2-A) loads as a code-only marker. M2-B auto-adds `scripts/qa/d24/stubs/auth-roles.sql` (auth.uid/jwt, profiles, user_studio_roles). |
| `scripts/qa/d24-acceptance.sh` | stack up → vitest → real PASS/FAIL/BLOCKED counts per section → stack down. |
| `scripts/qa/d24/acceptance.test.ts` | End-to-end: the **real** `POST /api/payments/webhook` route, **real Stripe signature verification** (synthetic secrets), real `claim_payment_provider_event` / `complete_payment_provider_event`, real D24 SQL. Only the Supabase transport is replaced (`rpc` → `docker exec psql` as role `service_role`, so grants are exercised). `getStripe` is mocked to expose only `webhooks` (no API client exists) and `fetch` is stubbed to throw. |
| `scripts/qa/d24/layers.test.ts` | M2-B operator authorization and M2-C drain/recovery at the SQL boundary (JWT claims set as Supabase does). Skipped = BLOCKED unless the layer is loaded. |

Run: `bash scripts/qa/d24-acceptance.sh` (M1 only) or `bash scripts/qa/d24-acceptance.sh --m2a origin/d24-m2a-registration --m2c origin/claude/d24-m2c-drain-59d43a --m2b origin/claude/d24-m2b-operator-actions`. Exit code is non-zero on any FAIL or crashed run; BLOCKED is reported but only fails with `D24_FAIL_ON_BLOCKED=1`. Requires Docker and `npm ci`. The default `vitest run` does **not** include these files (they live outside `src/`).

Not covered by design: signature verification is Stripe's SDK on synthetic secrets; the base `payment_provider_events` table is reconstructed (same limitation as `stage3-claim-sql.sh`); non-D24 webhook handlers see an empty Supabase stub, so their own HTTP status is not asserted.

## QA matrix and results

Counts come from real runs of the final test files (vitest JSON report summarised by `scripts/qa/d24/summarize.mjs`, which also fails a crashed or empty run). Heads under test for the full-stack run (fetched immediately before and re-checked after; unchanged): **M2-A `007f4fb9`** (PR 387, `origin/d24-m2a-registration`), **M2-C `35e28914`** (PR 386), **M2-B `cdea702a`** (PR 385), base `27d0db87` (M1, main). The two single-layer columns (M1 only, M1+M2-C) were last run at the earlier heads M2-C `84ba3d11` and have not been re-run at `35e28914`; the full stack is the acceptance configuration. Apply order: M1 → M2-A (no SQL) → M2-C `20270206` → M2-B `20270207`.

| Section | Scenario | Cases | M1 only | M1+M2-C | Full stack |
|---|---|---|---|---|---|
| A | harness is real: claims via PAY-WH-1 functions; service_role cannot write facts; anon/authenticated cannot read/call | 2 | PASS 2 | PASS 2 | PASS 2 |
| B | D24 OFF: all six event types → `d24_not_enabled`, zero facts; OFF event **not recoverable** after enabling; mode parsing | 13 | PASS 13 | PASS 13 | PASS 13 |
| C | bad/stale/wrong-secret/missing signature → 400 before any claim; Connect secret; live event on test key; test event on live key; malformed object; no PII in D24 tables | 7 | PASS 7 | PASS 7 | PASS 7 |
| D | event before registration then adoption; registration first; duplicates; same id different content; 8 concurrent identical deliveries; same payment new event id; out-of-order; payment-first shell; amount conflict; credit-note order; transient failure → 500 → retry once | 11 | PASS 11 | PASS 11 | PASS 11 |
| E | defer stores evidence only; drain once/idempotent; defer+drain ≡ direct apply; duplicate defer; 4 concurrent drains over 24 events; drain racing registration and live route; defer without claim refused | 7 | PASS 7 | PASS 7 | PASS 7 |
| F | cross-studio and metadata-only ownership attempts (forged metadata, metadata without registry, other invoice's registry id, other studio registering, other Stripe account, platform vs Connect scope, child facts, privileged re-point, acknowledge-to-attribute, SQL metacharacters) | 10 | PASS 10 | PASS 10 | PASS 10 |
| G | subscription vs hosted invoices: markers classify but never attribute; registered + marker flagged; tenant `studio_invoices` ignored; `invoice.paid`/`payment_failed` never routed to D24 | 4 | PASS 4 | PASS 4 | PASS 4 |
| H | evidence append-only for every role; deferred replay with a different hash keeps original evidence and records mismatch; schema adds only hosted_* tables | 3 | PASS 3 | PASS 3 | PASS 3 |
| I | payment id and credit-note id replayed under a different invoice/studio stay with the first and flag the second; account X event then registration under Y; livemode mismatch flagged; void/uncollectible converge to void in either order; service_role cannot use the `d24.writer` flag to write | 6 | PASS 6 | PASS 6 | PASS 6 |
| M2A | SQL contract M2-A's wrapper relies on (code-only layer): concurrent double-submit = one row; 23505/22023 mapping; registration racing events | 3 | BLOCKED 3 (layer not loaded) | BLOCKED 3 (layer not loaded) | PASS 3 |
| M2A | app issues an invoice → registry row atomically with the business object; end-to-end studio-ownership refusal | 2 | BLOCKED 2 | BLOCKED 2 | BLOCKED 2 |
| M2C | `d24_run_drain` privileges; concurrent runs apply once and are audited; poison event rejected without starving newer events, then requeued; non-rejected event not requeued; health exposes no payload. Requeue goes **through M2-B's wrapper as platform admin at aal2** on the full stack, through M2-C's direct function otherwise | 5 | BLOCKED 5 (layer not loaded) | PASS 5 | PASS 5 |
| M2B | (9 cases) service_role/aal1/no-subject/expired-or-missing-exp refused; studio operator acks own studio with audit; no cross-studio ack, studio operators have no read access (list/get are platform-admin only, platform list is the positive control); front_desk and non-roles refused; unmatched cannot be acked, dismiss is platform-only; platform-only code needs platform admin; operator tables private | 8 | BLOCKED 9 (layer not loaded) | BLOCKED 9 (layer not loaded) | PASS 9 |
| M2X | M2-B wrapper + M2-C drain on one database: poison rejected; direct service_role requeue refused; studio owner and aal1 refused; platform admin at aal2 requeues with audit; drain applies once | 1 | BLOCKED 1 | BLOCKED 1 | PASS 1 |
| Z | stack availability marker | 1 | PASS 1 | PASS 1 | PASS 1 |

**Totals: full stack (M2-A, M2-C, M2-B on M1) PASS 82 / FAIL 0 / BLOCKED 2. M1+M2-C (earlier head) PASS 69 / FAIL 0 / BLOCKED 14. M1 only PASS 64 / FAIL 0 / BLOCKED 19.** The configurations with fewer layers are BLOCKED only because the layer is not loaded; the full stack is the acceptance configuration. `tsc --noEmit` is clean on the final tree.

A first full-stack run at M2-B `cdea702a` showed 9 FAILs: M2-B had meanwhile adopted the owner-approved policy (JWT must carry a future `exp`; list/get are platform-admin only), so my tests, written against `5deac032`, expected the old behaviour. The tests were updated to the policy (and an expired-session case added) and the run repeated: 0 FAIL.

Behaviour worth knowing, observed rather than assumed: M2-B's wrapper answers an idempotent `already_pending` (no state change, no requeue row) when asked to requeue a pending event, whereas M2-C's direct function refuses with `d24_requeue_requires_rejected_event`. M2C4 asserts nothing changed in both cases. Void always wins over uncollectible regardless of event timestamps (I5).

### Remaining BLOCKED (2) — reason, owner, what it gates

| Test | Why it is BLOCKED | Owner | Gates merge? | Gates activation? |
|---|---|---|---|---|
| M2A: invoice registry row created atomically with the business object (no orphan invoice / orphan registry row) | M2-A deliberately has no production resolver and nothing in the app creates Stripe-hosted invoices; every production call fails closed with `business_object_type_unsupported` | whichever package adds the invoice-creation workflow (adds its resolver) | no | **yes**: D24 cannot attribute any production invoice until a resolver and caller exist |
| M2A: registration for a studio the caller does not own is refused end to end | no production caller authorizes a studio yet (same cause) | same | no | **yes** |

Review hardening applied after an independent review of this harness: unique, labelled container per run (never replaces or execs into an unlabelled container), signature passed per request via AsyncLocalStorage so concurrent deliveries cannot race, BLOCKED placeholders no longer run as passes, vacuous assertions replaced, summarizer exits non-zero on a crashed or empty run, git refs validated.

Known remaining gaps: PII scan covers the main D24 tables and three sentinel fields only; the M2-A rows exercise M1's `d24_register_invoice` and prove nothing about the wrapper's own logic (PR 387's tests cover that); the route's non-D24 handlers see an empty Supabase stub, so their own HTTP status is not asserted.

## Findings (real, from running the siblings' drafts together)

1. **M2-B and M2-C could not be applied together at their first heads** (both created `hosted_invoice_deferred_requeues`, both redefined `_d24_deferred_guard` and `d24_drain_deferred`). The sessions agreed M2-C owns the requeue table/function/guard and M2-B (renumbered `20270207`) wraps it; their intermediate pushes crossed once (nothing defined the requeue function). With M2-C `84ba3d11` and M2-B `5deac032` the order M1 → M2-A → M2-C → M2-B applies cleanly and requeue-then-drain passes (M2X). **Merge order: M2-C before M2-B.**
2. After M2-C, `service_role` cannot call `d24_drain_deferred`; any caller (including the M2-D tests, which now call `d24_run_drain` when M2-C is loaded) must use the bounded singleton `d24_run_drain`.
3. **OFF mode is not reconciliation** (B2, confirmed by test): an event acknowledged with `d24_not_enabled` is marked processed in PAY-WH-1, so redelivery after enabling is "Already processed" and creates no fact. Release rule stands: deploy `defer` or `on` in the same release as the SQL.
4. A transient failure after the claim (D11) correctly finalizes the claim as `failed`, returns 500, and Stripe's retry applies the event exactly once.

## Not done / follow-ups

- Re-run after any change to the sibling heads (the refs are parameters).
- M2-A end-to-end scenarios wait for a production resolver and caller.
- The suite takes about 5–9 minutes (each RPC is a `docker exec`); a pooled `pg` client would be faster but adds a dependency, so it was not added.
