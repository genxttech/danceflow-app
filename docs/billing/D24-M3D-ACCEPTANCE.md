# D24 M3-D — composed acceptance for M3 (harness + results)

Status: **test infrastructure and documents only. No product code, no migration, no hosted database, no deploy, no env change, no Stripe call of any kind (the Stripe TEST proof is a separate PLAN: `D24-M3D-STRIPE-TEST-PROOF-PLAN.md`).** Everything below is **offline-fixture based**: the "Stripe" is the fake shipped with M3-B (it models idempotency: same key + same parameters ⇒ same invoice; same key + other parameters ⇒ error). **Nothing here shows that real Stripe behaves that way, and no result may be quoted as a Stripe integration passing.**

## What changed in the harness
| File | Change |
|---|---|
| `scripts/qa/d24-stack.sh` | new `--m3a REF\|TREE`, `--m3b REF\|TREE`, `--m3c REF\|TREE`. A REF (PR head, e.g. `git fetch origin pull/394/head:refs/m3/394`) is diffed against `git merge-base REF HEAD`, so it loads exactly that PR's own additions over the merged tree: SQL by `git show` (nothing checked out); non-migration `src/` files are extracted to an untracked overlay (`D24_OVERLAY`, aliased `@d24overlay`). `shas` command prints the exact commit of every layer. `studios` stub gains `stripe_connected_account_id` / `stripe_connect_charges_enabled`. M3-C gets `stubs/m3c-base.sql` (+ `auth-roles.sql`). A bare `up` loads M3 layers only if the merged tree already contains them. |
| `scripts/qa/d24-acceptance.sh` | `--m3*` refs (M2 layers default to the merged tree), per-run overlay dir, prints layers + SHAs, and a loud `D24 NOTE: layer … NOT loaded` line so a green exit code can never be read as "M3 ran". |
| `scripts/qa/d24/m3.test.ts` | new composed suite (sections below) driving the **real** `create.ts` + `createSupabaseIntentStore` against the real SQL, plus the real webhook route with offline signed fixtures. |
| `scripts/qa/d24/summarize.mjs` | adds a **SUPERSEDED** category (never PASS, never hidden). |
| `acceptance.test.ts`, `layers.test.ts` | 18 M1/M2 scenarios are labelled `SUPERSEDED(m3a …)` when M3-A is loaded (see below); M2-B operator tests re-registered account-bound instead (all 10 PASS). The two former M2A BLOCKED rows moved to `m3.test.ts` (M2A-CONV). H3 allow-lists the QA fixture table (and M3-C's tables when loaded). Test timeout 120 s → 240 s (E5 timed out under machine load). |

Run: `bash scripts/qa/d24-acceptance.sh --m3a <ref> --m3b <ref> [--m3c <ref>]`. Needs Docker; the container is `--network none`, no ports; `fetch` throws in every test; the Stripe SDK is used only to sign fixtures.

## SUPERSEDED (18), honestly
M3-A deliberately refuses platform-scope/unbound-account registration (account is resolved from the studio). 18 M1/M2 scenarios register that way (D1 D2 E2 E6 F1 F4 F5 F7 F8 G2 I1 I2 I3 I4 K1 M2A1 M2A2 M2A3) and fail for exactly that reason at M3-A (observed: SQLSTATE 42501 on setup). They are skipped, not passed. Re-covered account-bound in `m3.test.ts`: **M3-RETAIN** F1, F8, G2, I1, I2 (same studio+account; ids are account-scoped, so the same payment id under another account is a separate row — observed), I4, M2A1, M2A3; and D1/D2/F4/F5/F7 via W1–W7 and O4. **Not re-covered under M3-A (known gaps):** E2/E6/K1 (deferred drain and the drain-vs-live lock race with a *registered* invoice), I3 (event under account X then registration under Y), M2A2 (error mapping inputs; O3/O4 cover the codes). Those still run and pass on the merged tree.

## Configurations and exact results
Tree under test everywhere: `c575d499` (origin/main at time of run). Layers are PR heads fetched with `git fetch origin pull/N/head` (refs `refs/m3n/*`). Counts come from real runs of the final test files.

| # | Configuration | SHAs | PASS | FAIL | BLOCKED | SUPERSEDED |
|---|---|---|---|---|---|---|
| 1 | merged tree, no M3 layers | tree `c575d499` | 85 | 0 | 64 | 0 |
| 2 | + M3-A only | m3a `76ea8d91b12c664211b60bcb0a55779c52c08973` | 81 | 0 | 50 | 18 |
| 3 | + M3-A + M3-B | m3a `76ea8d91…`, m3b `f3beb6b41eb5e48d242e5c5616d1ed56093d4733` | 126 (+1 E5 timeout under load, see below) | 1 | 4 | 18 |
| 4 | + M3-A + M3-B + M3-C | m3a `76ea8d91…`, m3b `f3beb6b4…`, m3c `0610790570e4435ca0eca475e2944c665257c4e1` | **127** | **0** | **4** | 18 |

Config 3's single FAIL was E5 (four concurrent drains) hitting the old 120 s timeout while several sessions loaded the machine (it takes ≈ 41 s on a quiet machine and passed in configs 2 and 4 after the timeout was raised); it is a load flake in an existing M2-D test, not an M3 defect, but config 3 should be re-run on a quiet machine before anyone quotes a clean number for it. Earlier runs at the previous heads (`554e2b9e` / `12bb0ff5`) found and fixed defects **in my own tests** (R9/R10 expectations, a regex typo, an `it.each` binding in the SUPERSEDED shim).

### M3 sections (config 4)
| Section | Covers | PASS | BLOCKED |
|---|---|---|---|
| M3-CREATE (10) | draft `send_invoice`/`auto_advance=false` created in the studio's own connected account and registered atomically with the intent; no settlement inferred; flag OFF default; unknown key mode; forged actors; duplicate (same key ⇒ one invoice, no new call); second key for a live object refused; 8 concurrent identical requests ⇒ 1 invoice/intent/registry row; 5 concurrent different objects; same key in two studios never collides | 10 | 0 |
| M3-RECOVERY (9) | Stripe ok then DB register failure (resume, no 2nd call); provider_created write fails (pending, replay converges); **process crash after Stripe, before provider_created persisted**; crash after DB commit; **crash after begin, before Stripe**; retryable failure; permanent rejection frees the object, no error text leaks; resume authorization; idempotency window refusal (no Stripe call) | 9 | 0 |
| M3-WEBHOOK (7) | `invoice.voided`, `invoice_payment.paid`, `credit_note.created` **before** registration stay unattributed, then registration adopts them; all three reversed; **missing registry** (crash before mark) stays unmatched even with metadata naming studio+intent; after-registration attribution + duplicate delivery; payment under another Stripe account never attaches | 7 | 0 |
| M3-OWNER (12) | foreign-object creation refused even with a forged permissive TS resolver; no/disabled account; SQL resolves the account itself (supplied account only an assertion); **studio B registering studio A's invoice id refused** (23505/42501); end-to-end version where Stripe returns A's invoice id to B; livemode forgery both ways; SQL mark_provider_created forgery (livemode/account/studio); **metadata alone never owns an invoice**; **subscription types refused** (orchestrator + SQL) and subscription-marked responses rejected; subscription-classified event unregistered; **permission matrix (database)**: anon/authenticated/studio-owner JWT cannot execute or read anything, service_role can only EXECUTE the six functions | 11 | 1 (O12 below) |
| M3-AUDIT (5) | one append-only audit event per transition, fixed codes only; ledger/events immutable even for a privileged session; refused begin leaves no trace; **registration atomicity** (object stops belonging to the studio ⇒ no registry row, no half-registered intent); no payment/transition without a delivered event | 5 | 0 |
| M3-RETAIN (8) | account-bound re-assertions listed above | 8 | 0 |
| M2A-CONV (3) | the two former BLOCKED M2-A rows: **app issues an invoice → registry row created atomically with the business object**; **registration for a studio the caller does not own is refused end to end** — both PASS, using a **QA-fixture business object** (type `event_fee`, ownership function registered by the test), not M3-C's real one | 2 | 1 |
| M3-MATRIX (9) | owner recovery matrix Q1–Q10 (offline fixtures): Q1 crash before request; Q2 crash after success before id recorded; Q3 same-key retry while retryable; Q4 same key changed parameters; Q5 five concurrent workers on one intent; Q6 timeout with unknown result; Q8 provider invoice found but registration refused; Q9 account mismatch (= O3/O5/O7) | 7 | 2 (Q7, Q10) |
| M3-SWEEP (1) | bounded recovery sweep finishes a stuck intent without a second invoice (runs last: the sweep is global) | 1 | 0 |

### BLOCKED (4) — reason, owner, gates
| Scenario | Why | Gates merge? | Gates activation? |
|---|---|---|---|
| Q7 recovery after the safe-retry window ⇒ `needs_review` and no replay (fake Stripe pruning keys) | the requested M3-A/M3-B changes (request fingerprint, configurable 12 h window, `needs_review`/`outcome_unknown`, recovery claim lease) are **not published** at the tested heads; current heads only *refuse* the replay (R10 asserts no Stripe call) | no | **yes** |
| Q10 authorized operator reconciliation of an unresolved creation | needs the reconciliation function from the same unpublished heads | no | **yes** |
| O12 app-level permission matrix (owner/admin only; front desk/instructor/other-studio refused) through the real call site | M3-C **is loaded**, but this composed scenario is **not written yet** (labelled so; it stays BLOCKED, never green). M3-C's own tests cover its authorization at their level | no | **yes** |
| App issues an invoice for the REAL business object (production resolver) | same: M3-C loaded, composed scenario not written | no | **yes** |

Honest limits: results are fixture-based; `scripts/qa/d24/stubs` reconstruct base tables (same limitation as the M2-D harness); the sweep and the global invariant A5 depend on running last / order; overlay `@/…` imports resolve overlay-first then to the merged tree.

## Re-run
Whenever a sibling head moves: `git fetch origin pull/394/head:refs/m3n/394 pull/393/head:refs/m3n/393 pull/395/head:refs/m3n/395` then the four configurations above, and update this table with the printed SHAs.
