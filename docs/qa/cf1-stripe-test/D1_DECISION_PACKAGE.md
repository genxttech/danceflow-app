# D1 decision package: database source for a real-Stripe settlement run (2026-11-22)

Status: DECISION PACKAGE, docs only. Nothing here authorizes exporting database contents, creating credentials, entering secrets, dispatching a canary or any hosted change. Confidential: describes unreleased Competition OS capability; internal engineering use only.
Builds on `docs/qa/cf1-stripe-test/D1_DATABASE_SNAPSHOT_SCOPE.md` and `STRIPE_TEST_ACCEPTANCE_PACKAGE.md` (both on draft PR 682, base `main`), and on the owner's Path A decision of 2026-11-21.

## 1. The one decision

Do you want the encrypted QA schema snapshot (D1) built now so a GitHub runner can run the full Competition end-to-end suite against Stripe TEST?

Engineering recommendation (not approved): **No, not now.** Take the split described in section 4 (option R): prove the database-backed settlement logic on the engineering host with no Stripe, and prove the real Stripe response shapes with a database-free canary extension. Keep D1 as a deferred option. Reason: after Path A, a full-suite runner buys much less than it did when it was designed, and D1 carries a permanent public-data residual.

## 2. What changed since D1 was scoped

D1 was scoped on 2026-11-19 so a runner could execute `e2e/tests/competition-full-event.spec.ts` and `e2e/tests/competition-stripe-failure-settlement.spec.ts`. Since then:

1. **Hosted Checkout payment cannot be automated.** Canary B failed on Stripe's anti-automation frame (run 44860275089); Stripe's documentation says Checkout frontends resist automated testing. The owner approved Path A (2026-11-21): real Stripe TEST direct payments plus signature-verified webhook testing. A completed hosted Checkout transaction stays explicitly NOT PROVEN.
2. **Both existing specs pay through `payCheckoutSession`** (the undocumented `/v1/payment_pages/{id}/confirm` call that returned `checkout_confirm_error` in run 44806898241). It is imported at `e2e/tests/competition-stripe-failure-settlement.spec.ts:12`, and `competition-full-event.spec.ts` calls it at lines 167 and 233; `competition-schedule-heats-acceptance.spec.ts`, `competition-scoring-results-acceptance.spec.ts` and `event-cart-settlement-integrity.spec.ts` import it too. As written, none of these specs can pass on a runner. A database snapshot alone would not make them runnable; they would need rewriting for Path A first.
3. **The settlement re-read is merged** (PR 745, `ba970a67f`): a signed event never finalizes a competition order unless Stripe's own record agrees. A replayed or synthetic event cannot finalize an order Stripe does not show as paid.
4. **The offline Path A suite is merged** (PR 780, `1ab8fbc7a`), and the dark repair for a missed webhook is merged (PR 781, `a8a0620f5`). They cover signature failures, duplicate and concurrent delivery, release paths, forged settlement and repair, against fakes for Stripe and the database.

## 3. What a real-Stripe run can and cannot prove under Path A

| Claim | Provable on Stripe TEST without hosted payment? | How |
|---|---|---|
| Session creation, application fee, metadata, connected account binding | Yes | documented API; already proven for the fee on a direct PaymentIntent (canary C) and for session create plus expire (canary A) |
| `verifySettlementWithStripe` against the REAL shape of an open or expired session | Yes | create a session, build a forged "paid" event for it, run the verifier against the real `sessions.retrieve` response; expect refusal |
| Real `checkout.session.expired` event releases a pending registration | Yes (needs app and database) | `stripe.checkout.sessions.expire`, relay the real event |
| Verifier PaymentIntent checks (`status`, `amount_received`) against a REAL succeeded PaymentIntent with an application fee | Partly | a real direct PaymentIntent (canary C pattern); the session-level checks stay unproven |
| `checkout.session.completed` with a real paid session finalizing a real order | **No** | needs a hosted Checkout payment; NOT PROVEN |
| Refund and dispute flows on a paid Checkout order | **No** | same reason |

Consequence: the part of the full suite that needs a database AND real Stripe is limited to session creation, expiry and forged-event refusal. Those do not need the full spec.

## 4. Options

| Option | What it is | Gives | Costs and risks |
|---|---|---|---|
| **R (recommended)** | R1: database-backed settlement tests on the engineering host (local QA Postgres, fake Stripe reader, real SQL: `finalize_competition_registration`, `release_competition_registration`, claim leases). R2: a database-free canary extension "D" in the existing guard (`scripts/qa/cf1-stripe-guard.ts`): create a session, forge events, run the real verifier against real responses; optionally a real succeeded direct PaymentIntent. | Real SQL binding and amount checks behind the real webhook route; verifier against real Stripe shapes. No snapshot, no new secret. | R1 needs no approval beyond existing local QA rules. R2 is a code PR (code-owner review) plus one future canary authorization; no new credential. Does not prove a runner-hosted full run. |
| D1 | Encrypted schema-only snapshot of the local QA chain committed to a public repo; passphrase as a second environment secret; full local Supabase stack on the runner. | Runner can execute database-backed specs against Stripe TEST. | Permanent public ciphertext (section 6); a new secret you must enter; specs must be rewritten for Path A first (section 2, item 2); about 6 to 10 minutes of stack start per run; F2 and F3 approvals. |
| D2 | Commit the schema-only dump in clear. | Simplest. | Exposes the pre-migration base schema of a public repo permanently. Not recommended. |
| D3 | Dedicated disposable hosted Supabase project. | No snapshot. | New credentials, cost, a hosted change. Not authorized. |
| D4 | Run credentialed tests on the engineering host. | Easiest. | Breaks the approved credential isolation (the agent would hold or use the Stripe key). Rejected. |

## 5. D1, if you choose it: exact scope

Source: `pg_dump --schema-only -n public` of the engineering host's local QA chain (July production schema-only dump, bootstrap, every live-line migration in order). No rows. Never taken from DEV or PROD. Manifest in clear: source commit, `git rev-parse <commit>:src/lib/supabase/migrations`, Postgres image tag, `pg_dump` version, fingerprint hash. The runner fails closed when the pinned commit's migrations tree id differs from the manifest (a new migration means a new snapshot).

The migrations tree id on `release/website-embeds` at `1ab8fbc7a` is `e8ef1f3898636c6ca635f1886697256e06a0ba1c`; any snapshot built earlier is already stale and would be rebuilt.

Stages (from the F1 to F3 plan in the scoping document):
- **F1 local feasibility: DONE** (2026-11-19). The stack starts in about 3.5 minutes warm; services work; the restore must run as `supabase_admin` after dropping schema `public`. Result: GO for the runner stack.
- **F2 secret scan (needs your explicit go).** Scan the dump for JWTs, `sk_`/`rk_`/`whsec_`/`Bearer` strings, URLs with credentials, non-reserved email addresses and phone numbers; hand-review cron and notification function bodies. Report counts only. Any hit that cannot be removed at the source stops D1. No scanner binary (gitleaks, trufflehog) is installed on the host, so the scan would be a documented regex pass plus review; GnuPG is installed.
- **F3 encrypt, commit, wire (needs your explicit authorization).** GnuPG symmetric AES-256, a 40+ character random passphrase generated on the host and stored only in a user-only file; commit ciphertext and manifest; pin the ciphertext sha256 in the workflow; you enter the passphrase once in the browser as environment secret `CF1_DB_SNAPSHOT_PASSPHRASE` of `competition-stripe-test`; one dry full run after PR review.

Dependencies before a full run could happen: the specs rewritten for Path A (no `payCheckoutSession`); `supabase/setup-cli` and CLI version pins; a PR changing the acceptance workflow (still a placeholder, `CF1_DB_SNAPSHOT_SHA256: "PLACEHOLDER_DB_SOURCE_NOT_DECIDED"`); and your per-run deployment approval. No run is authorized by this package.

## 6. Risks and residuals (stated plainly)

- The repository is public (GitHub reports `private: false`). The ciphertext is permanent public data. If the passphrase leaks or the cipher is ever broken, the base schema (table and column names, RLS policies, function bodies, no customer data) becomes readable. The migrations in the repo already expose most of it; the pre-migration base schema is new exposure.
- The passphrase is a second secret you must handle. The agent never sees it.
- The snapshot goes stale with every migration; each refresh is a new passphrase and a new public ciphertext.
- GoTrue version differences between the CLI stack and the live line could change the verify-email flow; unverified.
- None of these risks buys proof of a completed hosted Checkout transaction, which stays NOT PROVEN under every option.

## 7. Owner approvals

| Item | Needed? |
|---|---|
| Choose option R, D1 or defer | Yes. One answer. |
| R1 (local database-backed tests) | No. Local QA stack only, existing rules (isolated database, host heavy lock). Starting now. |
| R2 canary extension: code PR | Normal code-owner review, when ready. |
| R2 canary run | One future authorization, separate, after the PR merges, the pin is validated and you approve the deployment. Not requested now. |
| D1 F2 (secret scan) | Only if you choose D1. Explicit go. |
| D1 F3 (encrypt, commit, secret) | Only if you choose D1. Explicit authorization, plus the passphrase entry. |

## 8. What is proceeding now without any approval

R1: a subordinate session writes database-backed settlement tests on the local QA stack, with no Stripe and no hosted database. Output: a draft PR with evidence. Nothing hosted changes.
