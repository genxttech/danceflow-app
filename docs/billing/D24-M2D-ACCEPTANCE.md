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

Counts come from real runs of the final test files (vitest JSON report summarised by `scripts/qa/d24/summarize.mjs`, which also fails a crashed or empty run). Heads used: M2-A `origin/d24-m2a-registration`, M2-C `84ba3d11`, M2-B `5deac032`.

| Section | Scenario | Cases | M1 only | M1+M2-C | M1+M2-A+M2-C+M2-B |
|---|---|---|---|---|---|
| A | harness is real: claim via PAY-WH-1 functions; service_role cannot write facts; anon/authenticated cannot read/call | 2 | PASS 2 | PASS 2 | PASS 2 |
| B | D24 OFF: all six event types → `d24_not_enabled`, zero facts; an OFF event is **not recoverable** after enabling; mode parsing | 13 | PASS 13 | PASS 13 | PASS 13 |
| C | tampered/wrong-secret/missing/malformed/stale signature → 400 before any claim; Connect secret; live event on test key; test event on live key; malformed object; no PII in D24 tables | 7 | PASS 7 | PASS 7 | PASS 7 |
| D | event before registration then adoption; registration first; duplicates; same id different content; 8 concurrent identical deliveries; same payment new event id; out-of-order; payment-first shell; amount conflict; credit-note order; transient failure → 500 → retry once | 11 | PASS 11 | PASS 11 | PASS 11 |
| E | defer stores evidence only; drain once and idempotent; defer+drain ≡ direct apply; duplicate defer; 4 concurrent drains over 24 events; drain racing registration and live route; defer without claim refused | 7 | PASS 7 | PASS 7 | PASS 7 |
| F | cross-studio and metadata-only ownership attempts (forged metadata, metadata without registry, other invoice's registry id, other studio registering, other Stripe account, platform vs Connect scope, child facts, privileged re-point, acknowledge-to-attribute, SQL metacharacters) | 10 | PASS 10 | PASS 10 | PASS 10 |
| G | subscription vs hosted invoices: subscription markers classify but never attribute; registered + marker flagged; tenant `studio_invoices` ignored; `invoice.paid`/`payment_failed` never routed to D24 | 4 | PASS 4 | PASS 4 | PASS 4 |
| H | evidence append-only for every role; deferred replay with a different hash keeps original evidence and records the mismatch; M1 schema adds only hosted_* tables | 3 | PASS 3 | PASS 3 | PASS 3 |
| M2A | SQL contract M2-A's wrapper relies on (code-only layer, no migration): concurrent double-submit = one row; 23505/22023 mapping; registration racing events | 5 | BLOCKED 3 | BLOCKED 3 | PASS 3 |
| M2A | atomic with business-object creation; end-to-end studio ownership | | BLOCKED 2 | BLOCKED 2 | BLOCKED 2: M2-A has no production resolver or caller yet, by design |
| M2C | `d24_run_drain` privileges; concurrent runs apply once and are audited; poison event rejected without starving newer events, recovered by requeue; only rejected requeueable; health exposes no payload | 5 | BLOCKED 5 | PASS 5 | BLOCKED 5 (skipped: with M2-B the direct requeue function is revoked; covered by M2X) |
| M2B | service_role/aal1/no-subject refused; studio operator acks own studio with audit; no cross-studio read/ack/existence oracle (positive control with own-studio rows); front_desk refused; unmatched cannot be acked and dismiss is platform-only; platform-only code needs platform admin; operator tables private | 8 | BLOCKED 8 | BLOCKED 8 | PASS 8 |
| M2X | M2-B requeue wrapper + M2-C drain on one database: poison rejected, direct service_role requeue refused, studio owner and aal1 refused, platform admin at aal2 requeues with audit, drain applies once | 1 | BLOCKED 1 | BLOCKED 1 | PASS 1 |
| Z | stack availability marker | 1 | PASS 1 | PASS 1 | PASS 1 |

**Totals: M1 only PASS 58 / FAIL 0 / BLOCKED 19. M1+M2-C PASS 63 / FAIL 0 / BLOCKED 14. M1+M2-A+M2-C+M2-B (apply order M2-A, M2-C, M2-B): PASS 70 / FAIL 0 / BLOCKED 7.** Typecheck (`tsc --noEmit`) is clean. BLOCKED is not a pass: the layer was not loaded, or the product capability does not exist yet.

Review hardening already applied (independent review of this harness): unique, labelled container per run (never replaces or execs into an unlabelled container), signature passed per request via AsyncLocalStorage so concurrent deliveries cannot race, polarity of the BLOCKED placeholders fixed, vacuous assertions replaced (H2 real replay, M2B4/M2B7, F7 positives, G4), summarizer exits non-zero on a crashed or empty run, git refs validated.

Known gaps (from the same review, not yet covered): payment/credit-note id replayed under a *different* invoice or studio through the route; metadata arriving before registration followed by a registration naming another studio; event under account X then registration under account Y; registry/event livemode mismatch; older-void-after-newer-uncollectible ordering; PII scan limited to the main D24 tables; no test that `service_role` cannot set `d24.writer` itself. The M2-A rows exercise M1's `d24_register_invoice`; they prove nothing about the wrapper's own logic (covered by PR 387's tests).

## Findings (real, from running the siblings' drafts together)

1. **M2-B and M2-C could not be applied together at their first heads** (both created `hosted_invoice_deferred_requeues`, both redefined `_d24_deferred_guard` and `d24_drain_deferred`). The sessions then agreed M2-C owns the requeue table/function/guard and M2-B (renumbered `20270207`) wraps it, but their next pushes crossed (M2-C briefly removed what M2-B now depended on). With M2-C `84ba3d11` and M2-B `5deac032` the order M1 → M2-A → M2-C → M2-B applies cleanly and the requeue-then-drain scenario passes (M2X). Merge order matters: M2-C must land before M2-B.
2. After M2-C, `service_role` cannot call `d24_drain_deferred`; any caller (including the M2-D tests, which now call `d24_run_drain` when M2-C is loaded) must use the bounded singleton `d24_run_drain`.
3. **OFF mode is not reconciliation** (B2, confirmed by test): an event acknowledged with `d24_not_enabled` is marked processed in PAY-WH-1, so redelivery after enabling is "Already processed" and creates no fact. Release rule stands: deploy `defer` or `on` in the same release as the SQL.
4. A transient failure after the claim (D11) correctly finalizes the claim as `failed`, returns 500, and Stripe's retry applies the event exactly once.

## Not done / follow-ups

- Re-run after any change to the sibling heads (the refs are parameters).
- M2-A end-to-end scenarios wait for a production resolver and caller.
- The suite takes about 5–9 minutes (each RPC is a `docker exec`); a pooled `pg` client would be faster but adds a dependency, so it was not added.
