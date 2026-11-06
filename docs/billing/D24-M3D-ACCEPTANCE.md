# D24 M3-D — composed acceptance for M3 (harness + results)

Status: **test infrastructure and documents only. No product code, no migration, no hosted database, no deploy, no env change, no Stripe call of any kind** (the Stripe TEST proof is a separate PLAN, `D24-M3D-STRIPE-TEST-PROOF-PLAN.md`; nothing in it is authorized or executed). Everything below is **offline-fixture based**: the "Stripe" is the fake shipped with M3-B (it models idempotency — same key + same parameters ⇒ same invoice, same key + other parameters ⇒ error, and keys can be pruned). **Nothing here shows that real Stripe behaves that way, and no result may be quoted as a Stripe integration passing.**

## What the harness does
| File | Purpose |
|---|---|
| `scripts/qa/d24-stack.sh` | `--m3a / --m3b / --m3c REF\|TREE`. A REF (PR head, `git fetch origin pull/N/head:refs/…`) is diffed against `git merge-base REF HEAD`, so it loads exactly that PR's own additions over the merged tree: SQL by `git show` (nothing checked out), non-migration `src/` files into an untracked overlay (`D24_OVERLAY`, alias `@d24overlay`, overlay-first `@/…` resolution for overlay importers). `shas` prints the exact commit of every layer. A bare `up` loads M3 only if the merged tree already has it. Stubs: `studios` gets the Stripe account columns; M3-C gets `stubs/m3c-base.sql`. Renames/failed diffs abort instead of silently loading an older layer. |
| `scripts/qa/d24-acceptance.sh` | `--m3*` refs (M2 layers default to the merged tree), per-run overlay, prints layers + SHAs, and a loud `D24 NOTE: layer … NOT loaded` so a green exit code can never be read as "M3 ran". |
| `scripts/qa/d24/m3.test.ts` | the composed suite: the **real** `create.ts` + `createSupabaseIntentStore` against the real SQL, the real webhook route with offline signed fixtures, and (when M3-C is loaded) M3-C's real server action / authorizer / production resolver / SQL. |
| `acceptance.test.ts`, `layers.test.ts` | the M2-D suites. With M3-A loaded they run the **trusted account-bound registration model** (below). |
| `summarize.mjs`, `vitest.config.mts`, `pgBridge.ts` | PASS/FAIL/BLOCKED(/SUPERSEDED, now unused) counts; alphabetical file order (the files share one database); 240 s test timeout; `rpcAsUser` (call a function as role `authenticated` with a user's JWT claims). |

Run: `bash scripts/qa/d24-acceptance.sh --m3a <ref> --m3b <ref> [--m3c <ref>]`. Docker only; container `--network none`, no ports; `fetch` throws in every test; the Stripe SDK only signs fixtures; the overlay is refused if a loaded layer ships `src/lib/payments/stripe.ts`.

## K1 investigation (the configuration-1 FAIL in the previous report)
**Reproduced in isolation (3 of 3 failures on the old test), then root-caused: not a product defect and not generic "load".** K1 held the invoice key lock with a trigger `pg_sleep(8)` and assumed each `docker exec` RPC takes under a second. On this machine a bare `docker exec … psql -c "select 1"` had degraded to **4–6.5 s** (14 containers from several sessions), so the live delivery (claim + apply + complete = three execs) reached the database after the 8 s hold had already ended; the apply then returned 200 instead of the expected 500 (and in other runs the 500 arrived after > 7.5 s). Debug sampling showed the drain sleeping at 1.5 s and no session active by 3 s. Fix: the hold no longer has a fixed duration — a control row keeps the trigger sleeping until the test releases it (cap 2 min); the test waits until the drain is demonstrably in `PgSleep` (so it holds the lock), asserts the live apply returns **500 while the drain is still running** (only the live apply's own `lock_timeout` can produce that; the wall-clock bound is gone), then releases the drain and continues as before. The live event now also shares the drained event's account scope (else it takes a different lock). Results: **10 of 10 isolated passes** with docker exec still at 4–6 s, plus every full run below.

## The 18 former SUPERSEDED cases — per-case disposition
M3-A refuses platform-scope / unbound-account registration (the account is resolved from the studio). These scenarios were written for the M1/M2 model and failed at M3-A for exactly that reason (SQLSTATE 42501 on setup). **They are now re-expressed with the trusted model and run — and pass — in every configuration; SUPERSEDED is 0.** In `acceptance.test.ts`, when M3-A is loaded: `register()` binds the studio's connected account first (`acct_m3d<studio>`; an explicit account in a test is bound as given), registers under it and remembers the invoice's account scope; `deliver()` sends that invoice's events as Connect events under the same scope (Connect secret); `inv()` reads that scope; `bind()` declares the scope for tests that deliver before registering. Without M3-A all helpers behave exactly as before (platform scope).

| Case | Original assertion | Disposition |
|---|---|---|
| D1 | event before registration stays unmatched, registration adopts it | re-expressed: scope bound first, event under the studio's account, then registration adopts |
| D2 | registration first, event attributed | re-expressed, same assertion |
| E2 | deferred events drained once, idempotent | re-expressed (account-scoped events), same assertions |
| E6 | drains racing registration + live delivery | re-expressed, same assertions |
| F1 | forged metadata never re-attributes | re-expressed, same assertions |
| F4 | other studio cannot register a registered invoice (23505) | re-expressed: studio B bound to its own account ⇒ 23505 (scope conflict); the same-account form is M2A2 |
| F5 | same invoice id under another account is flagged | unchanged assertion, studio account bound |
| F7 | child facts of unmatched/registered invoices | re-expressed |
| F8 | attribution permanent even for a privileged writer | re-expressed |
| G2 | subscription markers on a registered invoice ⇒ conflict flag | re-expressed |
| I1, I2 | payment-id / credit-note-id replay under a different invoice **and studio** stays with the first | **cross-studio form retired, assertion narrowed:** both invoices belong to the same studio and account (an account belongs to one studio under M3-A, so "different studio, same account" cannot be constructed; the same id under another account is a separate row — observed). Cross-studio protection is covered at registration by O4 |
| I3 | event under account X, then registration under Y ⇒ X row flagged | unchanged assertion, studio bound to Y |
| I4 | registry/event livemode mismatch flagged | re-expressed (`register(..., livemode=true)`) |
| K1 | drain holds a key lock vs a live apply | redesigned latency-independent (above) |
| M2A1 | concurrent double-submit ⇒ one registry row | re-expressed |
| M2A2 | cross-owner 23505, null studio 22023 | re-expressed: SB is bound to SA's account in the harness (the reconstructed table does not enforce account uniqueness), so the 23505 comes from the registry-conflict guard as before |
| M2A3 | registration racing events converges | re-expressed |
| F6 (not on the old list; changed by the shim) | platform event for a Connect-registered invoice stays unmatched; Connect event for a platform-registered invoice stays unmatched | first half kept (explicit `account:"PLATFORM"` delivery); **second half retired under M3-A** (platform-scope registration is refused by design), replaced by F5, W7 (an event under another account never attaches) and O3/O4 (registration is account-bound) |

Retired outright: the `M3-RETAIN` copies (no longer needed) and the SUPERSEDED labelling. Coverage reductions, stated plainly: the cross-studio form of I1/I2 and the platform-registered half of F6.

## Results per configuration
Tree: this branch = merged `origin/main` `c1e16f6f` + harness commits (tree SHA `1dfc7fa0d6bec848a114e8ad25cdc6b0f177ecb6` for all four runs; only docs changed after). Layer SHAs are the PR heads **fetched immediately before each run** (identical in all four): PR 394 `5e7bf1eabf1740f6ab72d5a9f2afb73eaa45b91f`, PR 393 `47f09e792abae92e1f5ad8263ec6557e90ecdce5`, PR 395 `3b9da8b25f43a91e830ed3ffdcd776fd4ff46b94` (configuration 4 was re-run on this head after PR 395 merged PR 394 `5e7bf1ea`; configurations 1–3 do not load M3-C, so they are unaffected; tree SHA of that run `f4c6433e`).

| # | Configuration | Layers loaded | PASS | FAIL | BLOCKED | SUPERSEDED |
|---|---|---|---|---|---|---|
| 1 | merged tree, no M3 | m1 m2a m2c m2b | 85 | 0 | 56 | 0 |
| 2 | + M3-A | + m3a `5e7bf1ea` | 91 | 0 | 50 | 0 |
| 3 | + M3-A + M3-B | + m3b `47f09e79` | 139 | 0 | 2 | 0 |
| 4 | + M3-A + M3-B + M3-C | + m3c `3b9da8b2` | **141** | 0 | **0** | 0 |

BLOCKED in 1–2 is "layer not loaded" (named per test). Configuration 3 has 2 BLOCKED: the two M3-C-dependent rows, `BLOCKED(m3a+m3b+m3c not loaded)`. Configuration 4 has none. K1 passes in all four full runs (and 10 of 10 isolated runs). Earlier runs on previous heads (M3-A `e24ad0ef`) gave 140/1/0/0 with one remaining failure, F6, which the shim had changed — fixed and re-verified before these runs; it is the only run-level failure the re-expression produced.

## Final results on the merged tree (2026-11-06) — supersedes the table above
Run on a **clean detached worktree of `origin/main`**, no sibling refs, no local modifications (`git status` empty): commit **`0af00c9735ee6f1669d39f6d126e520c8902522c`**, git tree **`ad5f6935674404c316f32c4eca20187f0cdc5217`**. All M3 layers come from the merged tree itself (`D24 shas: tree=0af00c97… m3a=TREE@0af00c97… m3b=TREE@0af00c97… m3c=TREE@0af00c97…`). The sibling PR heads this document used earlier (394 `5e7bf1ea`, 393 `47f09e79`, 395 `3b9da8b2`) are historical; the merged heads are PR 394 `d1d3d859`, PR 393 `7d0ffa43` (includes the `orphan_recorded` one-liner), PR 407 (M3-C) `8e1c650c`, PR 399 (this harness) `0af00c97`.

| # | Configuration | Layers loaded | PASS | FAIL | BLOCKED | SUPERSEDED |
|---|---|---|---|---|---|---|
| A | full M3 stack = the merged tree (`bash scripts/qa/d24-acceptance.sh`) | m1 m2a m2c m2b m3a m3b m3c | **141** | 0 | **0** | 0 |
| B | merged tree with the M3 layers not loaded (`--m2a TREE --m2c TREE --m2b TREE`) | m1 m2a m2c m2b | 85 | 0 | 56 (`layer not loaded`, named per test) | 0 |

Per-PR suites, same clean tree (each starts its own disposable offline Postgres):

| Suite | Result |
|---|---|
| `scripts/qa/d24-m3a-sql.sh` (M3-A SQL) | 296 passed, 0 failed |
| `scripts/qa/d24-m3c-sql.sh` (M3-C SQL) | 217 passed, 0 failed |
| `scripts/qa/d24-m3b-orchestrator.sh` (orchestrator against real Postgres) | 18 passed, 0 failed |
| `vitest run src/lib/payments/hostedInvoice src/lib/billing/clientInvoices` | 10 files passed, 237 tests passed, 29 skipped (2 Postgres-backed files that skip outside their own script; the orchestrator one is run by the M3-B script above), 0 failed |

### Properties the owner asked to see confirmed, and where each is proven
| Property | Result | Evidence in the runs above |
|---|---|---|
| Finalized-invoice policy **$5.00 min / $5,000.00 max** (boundaries 499 / 500 / 500000 / 500001) | PASS, with one nuance stated plainly | M3-C SQL: *499* — an incomplete **draft** saves (owner policy) but `studio_client_invoice_creation_spec` is NULL below 500, i.e. it **cannot become a provider spec**; *500* accepted and produces a spec; *500000* accepted and produces a spec; *500001* refused (unit price, quantity×price, sum of lines, `2 x 250001`, sum one cent over); limits seeded 500/500000 and NULL limits fail closed. So the floor is enforced at provider-spec time, not at draft save. |
| **12-hour (720 min) default recovery window and 22 h cap** | PASS | M3-A SQL: default `safe_retry_minutes` = 720; setting 1320 (22 h) allowed; 1321 refused (`23514`); reset to 720. Harness R10: window expiry ⇒ `needs_review`, no Stripe call, with the fake's keys pruned so a replay would visibly duplicate. |
| **Tenant isolation** and **owner/admin-only** permissions | PASS | Harness M3-OWNER (12) incl. O12 through M3-C's real action, authorizer and SQL (owner/admin save; front desk, instructor, other studio's owner, platform admin without a studio role, role-less and no session refused); M3-C SQL cross-tenant client/studio/line refusals, role matrix and RLS reads. |
| **Account-bound registration** | PASS | Harness: `d24_register_invoice` resolves the account from the studio; a studio with no connected account is refused (42501); an asserted other/empty account is refused; no NULL-account registry row exists; the 18 former SUPERSEDED cases are re-expressed under account-bound registration (table above). M3-A SQL covers the same in SQL. |
| **M3-C contract allow-list test** | PASS | `src/lib/payments/hostedInvoice/__tests__/createContract.d24.test.ts` (SEAM_ALLOW_LIST, seam files never import the orchestrator or Stripe, no creation port wired) is in the 237 passing unit tests. |
| **`orphan_recorded` in the orchestrator**: `mark_provider_created` returning `orphan_recorded` ⇒ `needs_review` and no second Stripe create | **PARTIAL — a test gap, reported honestly** | The SQL side is covered (M3-A SQL: a late Stripe response for a failed/abandoned intent returns `orphan_recorded`, records the orphan once, idempotent on repeat). The orchestrator mapping is a one-liner (`create.ts`, `markProviderCreated`: `orphan_recorded` ⇒ `"review"`; `createHostedInvoice` then returns `needs_review` and does not register). **No committed test exercises that branch** (`grep orphan_recorded` finds it only in `create.ts` and the migration/SQL script). A test for it has been written and passes locally (store verdict mapping for all outcomes; orchestrator returns `needs_review`, registers nothing, one create); it is **not part of this docs-only PR** and belongs in a small tests-only follow-up. |

Not part of these results: owner-requested local tests O13/O14 (cross-studio replay isolation; platform-scope registration refusal) are uncommitted and not on this tree; they pass in a local configuration-4 run (143/0/0/0) and belong in a separate follow-up PR.

## M3 sections (configuration 4; configuration 3 is the same except the two M3-C rows are `BLOCKED(m3c not loaded)`)
| Section | Covers | PASS |
|---|---|---|
| M3-CREATE (10) | draft `send_invoice`/`auto_advance=false` created in the studio's own connected account and registered with the intent; no settlement inferred; flag OFF by default; unknown key mode; forged actors; duplicate (same key ⇒ one invoice, no new call); second key for a live object refused; 8 concurrent identical requests ⇒ 1 invoice/intent/registry row; 5 different objects concurrently; same key in two studios never collides | 10 |
| M3-RECOVERY (9) | R1 Stripe ok + register failure; R2 provider_created write fails ⇒ needs_review with the invoice id, replay refused without a Stripe call; R3 crash after Stripe, before the id is persisted ⇒ replay converges; R4 crash after DB commit; R5 crash after begin, before Stripe; R6 connection error is ambiguous ⇒ `outcome_unknown`, retry does not call Stripe, DB claim replays once; R7 permanent rejection; R8 resume authorization; R10 window expiry ⇒ needs_review and no Stripe call, with the fake's keys pruned so a replay would visibly duplicate | 9 |
| M3-WEBHOOK (7) | invoice / payment / credit-note events **before** registration stay unattributed, then registration adopts them; reversed order; **missing registry** stays unmatched even with metadata naming studio+intent; after-registration attribution + duplicate delivery; payment under another account never attaches | 7 |
| M3-OWNER (12) | foreign-object creation refused even with a forged permissive TS resolver; no/disabled account; SQL resolves the account itself; **studio B registering studio A's invoice id refused** incl. the end-to-end case; livemode forgery both ways; SQL forgery; **metadata alone never owns an invoice**; **subscription types refused**; database permission matrix; **O12 owner/admin-only permission matrix through M3-C's real server action, authorizer and SQL** | 12 (11 in config 3) |
| M3-AUDIT (5) | one append-only audit event per transition; ledger/events immutable even for a privileged session; refused begin leaves no trace; registration atomicity; no payment/transition without a delivered event | 5 |
| M2A-CONV (3) | the two former BLOCKED M2-A rows (app issues an invoice ⇒ registry row atomically with the business object; registration for a studio the caller does not own is refused end to end) PASS with a QA-fixture business object; the third row — the **REAL M3-C business object** — PASSES in configuration 4 | 3 (2 in config 3) |
| M3-MATRIX (9) | owner recovery matrix Q1–Q10 (offline fixtures); Q8's 23505 is injected at the transport (proves the orchestrator's reaction; the SQL path is A4/O5); Q10 = operator reconciliation (studio owner, AAL1, short reason, wrong account refused; platform admin at AAL2 attaches ⇒ registered, `operator_attached` audit, no create replayed; abandon only for a platform admin at AAL2) | 9 |
| M3-SWEEP (1) | bounded recovery sweep (global, so it runs last) | 1 |

### The two former BLOCKED rows against M3-C (configuration 4)
Run against M3-C's **real** `saveClientInvoiceDraftAction`, `authorizeClientInvoiceActor`, `resolveClientInvoiceSpec` and migration; **only the signed-in session is replaced** (who the user is, plus Next's cache/redirect); every RPC runs in the database as role `authenticated` with that user's JWT claims (or `service_role` for server-side steps), so the SQL permission helper really decides.
- **O12:** owner and admin save a draft; front desk, instructor, another studio's owner, a platform admin without a studio role, a role-less user and no session are refused, nothing is written, and the database refuses the same users directly (`client_invoice_forbidden`).
- **Real business object:** the saved draft is invoiced through `createHostedInvoice` with `CLIENT_INVOICE_SPEC_RESOLVERS`: the fake Stripe receives the invoice's own lines (15000 + 1000 cents) and a customer from the studio's client record; registry and ledger bind to `studio_client_invoice/<id>`; no settlement facts; the link freezes the invoice only from a *registered* intent; an edit after linking is refused; another studio's owner gets `business_object_not_owned` with no Stripe call.
- **Not covered:** M3-C's `getClientInvoiceCreationPort()` is a stub returning `null` (asserted), so the wiring between the server action and the orchestrator does not exist; the test performs, in test code, the steps its documented contract assigns to it. The Next.js request layer (cookies, real Supabase auth, UI) is not exercised.

## Honest limits
Fixture-based throughout; reconstructed base tables; no real Stripe call; the E5 drain race, the sweep and any test using timed waits are sensitive to this machine's `docker exec` latency (hence the 240 s timeout and the latency-independent K1); overlay `@/…` imports resolve overlay-first then to the merged tree; M3-C is loaded exactly as its branch stacks: PR 395 `3b9da8b2` contains M3-A `5e7bf1ea`, the same M3-A loaded in configurations 2–4 (no older-M3-A caveat). D7's migrations (`20270204…`, `20270205100000`) are not loaded in the D24 stack (they need tables the reconstructed base does not have). Migration versions after merging `origin/main` `c1e16f6f`: `…0203110000` (M1) < `…0204090000` / `…0205100000` (D7) < `…0206090000` (M2-C) < `…0207090000` (M2-B) < `…0208090000` (M3-A) < `…0209090000` (M3-C), no collisions.

## Independent review
Three fresh-reviewer passes over the harness diff, none with a P0. Fixed across them: R9/R10/regex defects, SUPERSEDED set too wide (now 0), overlay guard, A2 gate, non-atomic `ageIntent`, silent loss of renamed/failed-diff files in overlay extraction, escaping in H3, weak titles/assertions, proof-plan label collisions, K1 `drop table if exists` / drain catch hardening, and proof-plan metadata/email/negative-header wording. Accepted: the `fetch` stub does not block `node:https` (safety rests on the injected fake, the `getStripe` mock and the overlay guard); Q7 repeats R10; K1's 500 is tied to `lock_timeout` by construction (the drain is still running), not by an error-text assertion.

## Re-run
Whenever a sibling head moves: fetch the three PR heads, run the four configurations, update the table from the printed `D24 shas` lines.
