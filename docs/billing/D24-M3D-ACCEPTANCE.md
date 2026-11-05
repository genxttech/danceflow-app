# D24 M3-D — composed acceptance for M3 (harness + results)

Status: **test infrastructure and documents only. No product code, no migration, no hosted database, no deploy, no env change, no Stripe call of any kind** (the Stripe TEST proof is a separate PLAN: `D24-M3D-STRIPE-TEST-PROOF-PLAN.md`; nothing in it is authorized or executed). Everything below is **offline-fixture based**: the "Stripe" is the fake shipped with M3-B (it models idempotency — same key + same parameters ⇒ same invoice, same key + other parameters ⇒ error — and this harness can make it *prune* its keys). **Nothing here shows that real Stripe behaves that way, and no result may be quoted as a Stripe integration passing.**

## What the harness does
| File | Purpose |
|---|---|
| `scripts/qa/d24-stack.sh` | `--m3a / --m3b / --m3c REF\|TREE`. A REF (PR head, `git fetch origin pull/N/head:refs/…`) is diffed against `git merge-base REF HEAD`, so it loads exactly that PR's own additions over the merged tree: SQL by `git show` (nothing checked out), non-migration `src/` files into an untracked overlay (`D24_OVERLAY`, alias `@d24overlay`, overlay-first `@/…` resolution). `shas` prints the exact commit of every layer. A bare `up` loads M3 only if the merged tree already has it. Stubs: `studios` gets the Stripe account columns; M3-C gets `stubs/m3c-base.sql`. Renames/failed diffs abort instead of silently loading an older layer. |
| `scripts/qa/d24-acceptance.sh` | `--m3*` refs (M2 layers default to the merged tree), per-run overlay, prints layers + SHAs, and a loud `D24 NOTE: layer … NOT loaded` so a green exit code can never be read as "M3 ran". |
| `scripts/qa/d24/m3.test.ts` | the composed suite: the **real** `create.ts` + `createSupabaseIntentStore` against the real SQL, and the real webhook route with offline signed fixtures. |
| `summarize.mjs`, `vitest.config.mts` | adds **SUPERSEDED** (counted separately, never PASS; counted by `D24_FAIL_ON_BLOCKED=1`); alphabetical file order (the files share one database: M2B0 asserts the operator switch ships OFF with one audit row, and Q10 toggles that audited switch); 240 s test timeout (E5 timed out under machine load at 120 s). |
| `acceptance.test.ts`, `layers.test.ts` | 18 M1/M2 scenarios labelled SUPERSEDED when M3-A is loaded (below); M2-B operator tests re-registered account-bound (all 10 PASS). The two former M2A BLOCKED rows moved into `m3.test.ts` (M2A-CONV). |

Run: `bash scripts/qa/d24-acceptance.sh --m3a <ref> --m3b <ref> [--m3c <ref>]`. Docker only; container `--network none`, no ports; `fetch` throws in every test; the Stripe SDK is used only to sign fixtures; the overlay is refused if a loaded layer ships `src/lib/payments/stripe.ts` (the offline Stripe mock would not cover it).

## SUPERSEDED (18), honestly
M3-A deliberately refuses platform-scope / unbound-account registration (the account is resolved from the studio). 18 M1/M2 scenarios register that way (D1 D2 E2 E6 F1 F4 F5 F7 F8 G2 I1 I2 I3 I4 K1 M2A1 M2A2 M2A3) and failed for exactly that reason at M3-A (observed: SQLSTATE 42501 on setup, 23 FAILs before they were labelled; M2-B's 5 were re-registered account-bound instead). They are skipped, not passed. **Re-asserted account-bound in `M3-RETAIN`:** F1, F8, G2, I1, I2 (same studio+account; ids are account-scoped — the same payment id under another account is a separate row, observed), I4, M2A1, M2A3; D1/D2/F4/F5/F7 are covered by W1–W7/O4. **Known gaps in the composed configurations:** E2/E6/K1 (deferred drain and the drain-vs-live lock race with a *registered* invoice), I3 (event under account X then registration under Y) and M2A2 (error-mapping inputs; O3/O4 cover the codes). They still run and pass on the merged tree (configuration 1).

## Results per configuration (real runs of the final test files)
Tree under test: this branch = merged `origin/main` `c06222b7` + harness commits (SHA printed in each run: config 1/2 `f111423c…`, config 3 `9d8c7467…`, config 4 `9d8c7467…`). Layer SHAs are the PR heads fetched immediately before the runs.

| # | Configuration | Layer SHAs | PASS | FAIL | BLOCKED | SUPERSEDED |
|---|---|---|---|---|---|---|
| 1 | merged tree, no M3 | — | 85 | 0 | 64 | 0 |
| 2 | + M3-A (PR 394) | m3a `e24ad0ef67b294ae6f529e3230fc628581d06611` | 81 | 0 | 50 | 18 |
| 3 | + M3-A + M3-B (PR 393) | + m3b `d2108e2997da62aad1f8f381d2c998701216e7a8` | 129 | 0 | 2 | 18 |
| 4 | + M3-A + M3-B + M3-C (PR 395) | + m3c `0610790570e4435ca0eca475e2944c665257c4e1` | 129 | 0 | 2 | 18 |

Notes: BLOCKED in 1–2 is "layer not loaded" (named per test). Config 4: M3-C's head (`06107905`) is stacked on an *older* M3-A head (`76ea8d91`), so it is composed here with the newer M3-A; its migration applied cleanly on top of `e24ad0ef`, but treat config 4 as "M3-C loaded", not "M3-C re-verified against the final M3-A". Configs 3 and 4 had earlier FAILs that were defects in my tests or load/ordering effects, all fixed: expectations for the final recovery contract (R2, A4, Q8, O5/O6/O9 now `needs_review`), a regex typo, an `it.each` binding in the shim, a stale operator-audit assertion (`operator_attached`), the E5 timeout, and the shared-database file-order dependency of M2B0.

### M3 sections (configuration 3; identical in 4)
| Section | Covers | PASS | BLOCKED |
|---|---|---|---|
| M3-CREATE | draft `send_invoice`/`auto_advance=false` created in the studio's own connected account and registered with the intent; no settlement inferred; flag OFF by default; unknown key mode; forged actors; duplicate (same key ⇒ one invoice, no new call); second key for a live object refused; 8 concurrent identical requests ⇒ 1 invoice/intent/registry row; 5 different objects concurrently; same key in two studios never collides | 10 | 0 |
| M3-RECOVERY | R1 Stripe ok + register failure (resume, no 2nd call); R2 provider_created write fails ⇒ **needs_review with the invoice id**, replay refused without a Stripe call; R3 process crash after Stripe, before the id is persisted ⇒ replay with the same key converges; R4 crash after DB commit; R5 crash after begin, before Stripe; R6 connection error = **ambiguous** ⇒ `outcome_unknown`, retry does not call Stripe, DB claim replays once; R7 permanent rejection; R8 resume authorization; R10 **window expiry ⇒ needs_review and no Stripe call, with the fake's keys pruned so a replay would visibly duplicate** | 9 | 0 |
| M3-WEBHOOK | `invoice.voided` / `invoice_payment.paid` / `credit_note.created` **before** registration stay unattributed, then registration adopts them (amount taken only from the event, 5555 ≠ the fake invoice's 5500); all three reversed; **missing registry** stays unmatched even with metadata naming studio+intent; after-registration attribution + duplicate delivery; payment under another Stripe account never attaches | 7 | 0 |
| M3-OWNER | foreign-object creation refused even with a forged permissive TS resolver; no/disabled account; SQL resolves the account itself; **studio B registering studio A's invoice id refused** (23505/42501) incl. the end-to-end case (Stripe returns A's id to B ⇒ `needs_review`, A untouched); livemode forgery both ways; SQL forgery of livemode/account/studio; **metadata alone never owns an invoice**; **subscription types refused** (orchestrator + SQL), subscription-marked response ⇒ review; subscription-classified event stays unregistered; **database permission matrix** (anon / authenticated / studio-owner JWT cannot execute the intent functions or read the ledger tables; service_role gets no DML/helper access) | 11 | 1 (O12) |
| M3-AUDIT | one append-only audit event per transition, fixed codes only; ledger and events immutable even for a privileged session; a refused begin leaves no trace; **registration atomicity** (object stops belonging to the studio ⇒ no registry row, intent held in needs_review); no payment/transition without a delivered event | 5 | 0 |
| M3-RETAIN | account-bound re-assertions listed above | 8 | 0 |
| M2A-CONV | the two former BLOCKED M2-A rows: **app issues an invoice → registry row created atomically with the business object** and **registration for a studio the caller does not own is refused end to end** — both PASS, with a **QA-fixture business object** (type `event_fee`, ownership function registered by the test), *not* M3-C's real one | 2 | 1 |
| M3-MATRIX | owner recovery matrix Q1–Q10 (offline fixtures): Q1 crash before request; Q2 crash after success before id recorded; Q3 same-key retry while definitively retryable (429); Q4 same key changed parameters (fake refuses, ledger 23505); Q5 five concurrent workers on one intent (one lease holder, others `recovery_in_progress`); Q6 timeout with unknown result (response lost after create); Q7 recovery after the window ⇒ needs_review, no replay, keys pruned; Q8 provider invoice exists but registration refused ⇒ needs_review **with the id** (the 23505 is injected at the transport, so this proves the orchestrator's reaction only; the SQL mismatch path itself is A4/O5); Q9 account mismatch = O3/O5/O7; **Q10 operator reconciliation**: studio owner, AAL1, short reason and wrong account refused; platform admin at AAL2 attaches the Stripe-evidenced invoice ⇒ registered, `operator_attached` audit with the actor, no create replayed; abandon allowed only for a platform admin at AAL2 (the operator asserts nothing exists; the ledger cannot know) | 9 | 0 |
| M3-SWEEP | bounded recovery sweep finishes a stuck intent without a second invoice (runs last: the sweep is global) | 1 | 0 |

(Q7 repeats R10 on the matrix row, so the PASS count counts that scenario twice.)

### Remaining BLOCKED (2 in configurations 3 and 4)
| Scenario | Why | Gates merge? | Gates activation? |
|---|---|---|---|
| O12 app-level permission matrix (owner/admin only; front desk / instructor / other-studio refused) through the real call site | the call site is M3-C's UI/actions; with M3-C loaded the composed scenario is **not written yet** (labelled so; stays BLOCKED, never green); M3-C's own tests cover its authorization at their level | no | **yes** |
| App issues an invoice for the REAL business object (production resolver) | same | no | **yes** |

## Honest limits
Fixture-based throughout; reconstructed base tables (same as the M2-D harness); no real Stripe call (live or test) was made by anything here; the E5 drain race and the sweep are load/order sensitive (hence alphabetical order and the longer timeout); overlay `@/…` imports resolve overlay-first then to the merged tree; M3-C was composed with a newer M3-A than it was written against.

## Independent review
Two fresh-reviewer passes over the harness diff (no P0). Fixed: R9/R10/regex defects, SUPERSEDED set too wide (now M3-RETAIN), overlay guard, A2 gate, non-atomic `ageIntent`, silent loss of renamed/failed-diff files in overlay extraction, SUPERSEDED not counted by `D24_FAIL_ON_BLOCKED`, `hosted\_%` escaping in H3, weak titles/assertions (A4, W2, W7, Q10, O11), proof-plan question labels (V1–V6) colliding with the matrix labels. Accepted: `fetch` stub does not block `node:https` (safety rests on the injected fake, the `getStripe` mock and the overlay guard); Q7 duplicates R10.

## Re-run
Whenever a sibling head moves: fetch the three PR heads, run the four configurations, update this table from the printed `D24 shas` lines.
