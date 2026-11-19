# Competition CF1 - Stripe-TEST acceptance: runner design, coverage, blockers, authorization request (2026-11-19)

Status: DESIGN + DRAFT. Nothing here was run, merged into a live workflow, or connected to Stripe. No credential was requested or read. The draft workflow (`competition-stripe-test-acceptance.workflow.yml.draft`) is deliberately NOT under `.github/` so it cannot execute; it is unvalidated (not dry-run) and needs review before it moves.

## 1. Why a runner on GitHub (and what differs from D24)
The approved credential-isolation pattern (D24, `docs/billing/D24-GITHUB-ENVIRONMENT-PROOF.md`): a protected GitHub environment holds the only Stripe secret; the owner's approval click authorizes one run of an exact commit; the agent never sees the key; output is encrypted to the engineering evidence key (`scripts/qa/d24-gh-proof/evidence-public-key.pem`, private half stays with the owner/engineering host) and only ciphertext is uploaded.
Three things differ for Competition and are the reason a copy-paste of D24 is not enough:
1. **The harness is not on `main`.** `e2e/tests/competition-full-event.spec.ts` and the money helpers exist on `release/website-embeds` (the live line) and the CF1 candidate branch, not on `main` (`main` lacks the live-line commits; see main-reconcile status). D24's workflow is main-only. The Competition runner must run on the live line (the code that is actually in production), so its environment needs a deployment-branch rule for that branch.
2. **The harness needs a full TEST secret key, not a 3-permission restricted key.** It pays the hosted Checkout page through `POST /v1/payment_pages/<cs>/confirm` and creates `tok_visa` PaymentMethods on the connected account (`e2e/helpers/competitionFullEvent.ts: payCheckoutSession`), and the app itself creates/expires Checkout Sessions, creates refunds and reads payment intents on the connected account. A least-privilege `rk_test_` cannot be assumed to cover the undocumented `payment_pages` call; it would have to be proven by a trial run that costs an approval. Recommendation: a sandbox `sk_test_` key (TEST mode only, throwaway sandbox, expiry/rotation right after the run).
3. **It needs a running app and database, not just API calls.** The runner starts a LOCAL Supabase (`supabase start`, public demo keys, all repo migrations applied) and the Next app (`next build && next start`, per the local-E2E rule) on the runner. No hosted Supabase (DEV or PROD) credential and no production secret is involved.

## 2. Runner design (one job, one approval)
- Trigger: `workflow_dispatch` only. Environment `competition-stripe-test` (owner is the only required reviewer, "allow administrators to bypass" OFF, deployment branches = `release/website-embeds` only until `main` carries the line). Missing-environment auto-creation is unprotected, so the environment must exist BEFORE the workflow file lands.
- Guards (fail closed): repo and ref pinned; dispatched sha must equal the tip of the pinned branch; Stripe account ids pinned (platform `acct_1UZ320IPJs53nwt7`, connected `acct_1UZibNRCFiaIzL1V`, both TEST); first request is `GET /v1/account` and `GET /v1/balance` with the key: refuse unless `livemode=false`, the platform id equals the pin, and the connected account has `charges_enabled` and the `card_payments` capability active; refuse any key that is not `sk_test_`/`rk_test_`.
- Local stack: `supabase start` + apply migrations, seed through the harness fixtures only; `STRIPE_SECRET_KEY` and a locally generated `STRIPE_CONNECT_WEBHOOK_SECRET`/`STRIPE_WEBHOOK_SECRET` are passed to the app and Playwright processes as env, never echoed (GitHub masks the key; the job also unsets it for every step that does not need it).
- Webhooks: the harness today expects `stripe listen --forward-connect-to`. The draft instead uses a small **event relay** (new, reviewed code, `scripts/qa/cf1-stripe-relay.ts`, to be written): it polls `events.list` on the connected account and POSTs each authentic Stripe event, signed with the local secret, to `/api/payments/webhook`. Reasons: no Stripe CLI binary to pin, only Events-read on the key, and it gives deterministic **duplicate and out-of-order replay** for the failure-handling tests. The app's real signature verification and handlers run unchanged.
- Flags: `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true` and `E2E_COMPETITION_REGISTRATION_ENABLED=true` on the runner's LOCAL app only. Production flags are untouched.
- Evidence: Playwright JSON + traces + the harness evidence pack are written outside the checkout and encrypted with the existing evidence key; the public log shows only pass/fail counts and masked ids. Concurrency group, 60-minute timeout, one run per approval.
- Call budget: a hard wrapper cap on Stripe API calls (proposal: 600; the existing Q1 spec makes roughly 150-250) so a runaway loop stops itself.

## 3. Credential and configuration availability (checked read-only 2026-11-19, no value read)
| Item | Finding |
|---|---|
| GitHub environment for Competition TEST | **Does not exist.** Environments on the repo: `d24-stripe-test`, `Production`, `Preview` and Vercel-created ones. |
| Secrets inside any environment | **Not verifiable by engineering.** The GitHub App gets 403 "Resource not accessible by integration" on environment and repository secret listings (by design; the App cannot read or manage secrets). Whether `d24-stripe-test` still holds `D24_PROOF_STRIPE_KEY` is unknown to engineering and, by the D24 close-out (2026-11-09: no more accounts, keys or runs), it should be expired. It was a 3-permission key (Invoices, Customers, connected-account read) and would not cover this harness in any case. |
| TEST accounts | D24 sandbox platform `acct_1UZ320IPJs53nwt7` and its provisioned controller-model connected account `acct_1UZibNRCFiaIzL1V` exist (ids only, not credentials). Whether that connected account has `card_payments` active is not known; the runner's first guard checks it before any money-path call. A new account would need its own authorization. |
| Other secrets the run needs | None. Supabase is local with public demo keys; the webhook secret is generated per run. |
| Local E2E guards | `E2E_BASE_URL`/`E2E_SUPABASE_URL` are validated fail-closed to loopback by the harness itself. |
Conclusion: **the required TEST credential is NOT available to a run today.** Nothing was requested in chat; section 7 defines the only requirement.

## 4. Acceptance coverage (what exists, what is missing)
Existing, on the live line (`competition-full-event.spec.ts` + `competitionFullEventMoney.ts`, serial, 600 s timeout):
| Area | Covered by | Notes |
|---|---|---|
| Registration payments | stage 2 (three dancer accounts + one guest, hosted Checkout paid with `tok_visa`, verified webhook settles the order), stage 3 setup (two entries, fee line, discount, one order) | real Checkout session created by the app on the connected account |
| Refunds | 3b net-cap (cap+0.01 refused, nothing written), 3a partial per-entry refund (order, ledger, dated refund entry, Stripe refund agree; other entry and fee line untouched), 3c same request id twice = ONE Stripe refund (idempotency) | R2 per-entry path |
| Desk balance after partial refund | stage 3a (desk) | skipped unless `E2E_DESK_BALANCE_FIX=true`; CI-B shipped, confirm the flag value on the run |
| Scratch | 3d normal scratch moves no money (no payment or refund rows, one audit row), 3e scratch and refund are separate actions | official scratch in a locked heat is `test.fixme` |
| Tenant isolation | other studio owner gets 404, nothing written | |
| Check-in (non-money) | stage 4, 4b (two desks, first stamp kept) | |
Missing, to be authored as ONE small spec file `competition-stripe-failure-settlement.spec.ts` plus the relay (engineering work, no authorization needed to write; needs review):
| Area | Proposed test | Money effect |
|---|---|---|
| Failure handling | declined card (`tok_chargeDeclined` through the same confirm path): order stays unpaid, no confirmed entry, no payment row, buyer can retry | none (no charge) |
| Failure handling | abandoned/expired Checkout Session: hold released, entry not confirmed, session expired on the connected account | none |
| Failure handling | duplicate webhook delivery of `checkout.session.completed` (relay replay): one payment row, one ledger entry | none extra |
| Failure handling | out-of-order delivery (`charge`/`payment_intent` events before `checkout.session.completed`): no 500, settles once (PAY-WH-1 class defect) | none extra |
| Settlement integrity | after the refund scenarios: sum(order paid) - sum(refunds) equals ledger net equals Stripe charge amount minus Stripe refunds, per connected account; no orphan payment or refund row; closeout figure (stage 10 is `fixme`, replaced by this numeric reconciliation) | read-only reconciliation |
| Credits | **Cannot run: not implemented.** CC1 is designed only (PR 301, decisions CC-D1..D8 open). Not a blocker for dark release; it is a scope decision for public registration (section 5). | n/a |

## 5. Remaining genuine blockers to enabling PUBLIC registration (as of 2026-11-19)
1. **Stripe-TEST acceptance has not passed** on the composed live line (no credential available; section 3). This is the gate; everything else below is secondary.
2. **Release line.** The acceptance harness and the live code live on `release/website-embeds`, not `main`. The runner (and any future release) must come from that line; the environment branch rule or a main-reconcile decision is an owner/Apps matter (main-reconcile-live work is ON HOLD by the owner as of 2026-11-14).
3. **Credits scope decision.** Public registration can launch without credits only if the owner accepts that (CC1 undesigned/unimplemented). Owner decision, not engineering.
4. **Organizer prerequisites on PROD.** Competition checkout requires an active Organizer Suite on the organizing studio (D7). PROD has 0 organizers today; a first controlled registration needs an organizer with Suite active and a live Stripe Connect account. This is a configuration step, not code, and involves no outside outreach.
5. **Commerce residuals (non-blocking, owner to accept):** the ordinary `refundEventRegistrationAction` still refunds a whole PaymentIntent but has no UI caller; the ordinary ticket scan update lacks a `checked_in_at IS NULL` guard but competition registrations carry no ticket codes. Both verified at grep level only.
6. **Activation steps remain separate owner decisions** and are NOT requested here: registration flag, Finals/results flag, OD-17, first publication, in that order.
Not blockers any more: U18/U18-S/JC1 SQL (closed 2026-11-19), early-bird overcharge (fixed in code), webhook-ordering 500 (PAY-WH-1 released; the out-of-order test above re-proves it).

## 6. Safety boundaries
TEST mode only (guard on `livemode=false`, `sk_test_`/`rk_test_` shape, pinned account ids); sandbox platform and one connected account only; no real card, no live key, no production URL, no production or DEV database (loopback guards); no outbound email (local mailbox); no flag changes in any hosted environment; Stripe key never printed, written to disk, uploaded, or passed to any step except the app/test processes; API-call cap; one run per approval; evidence encrypted, 3-day retention; owner glances at the sandbox Developers > Logs after the run (D24 "Dashboard glance" precedent); key expired right after the run; no director or organizer contact.

## 7. Smallest actionable authorization (two owner moments, nothing before the second is spent)
**Engineering needs no authorization** to author the relay, the failure/settlement spec and the workflow (docs and test code, draft PR, no merge without the normal CODEOWNERS review).
**Owner moment 1 (setup, ~10 minutes, after engineering reports the PR green and reviewed):**
- Create GitHub environment `competition-stripe-test`: required reviewer = owner only, administrators bypass OFF, deployment branches = `release/website-embeds` only.
- In the Stripe SANDBOX that owns `acct_1UZ320IPJs53nwt7`, create one secret key (TEST mode, expiry 24 hours), and enter it in the browser as environment secret `CF1_STRIPE_TEST_SECRET_KEY`. Never in chat, never to engineering. (If the owner prefers a restricted key, a first approved run may fail on the `payment_pages` call; the full sandbox key is the recommended default.)
- Confirm in the Stripe dashboard that the connected account `acct_1UZibNRCFiaIzL1V` shows card payments enabled; if not, say so and a separate authorization for a new connected test account is needed.
**Owner moment 2 (the run authorization, text to approve):**
> Authorize ONE Competition Stripe-TEST acceptance run of commit <sha> (live line `release/website-embeds`) in environment `competition-stripe-test`, TEST mode only, sandbox platform acct_1UZ320IPJs53nwt7 and connected acct_1UZibNRCFiaIzL1V, local database and local app on the runner, Stripe API call cap 600, 60-minute limit. Scope: registration payments, per-entry refunds, scratch, tenant isolation, failure handling, settlement reconciliation. Excluded: credits, any live-mode key or account, any hosted Supabase, production flags, public registration. Expire the key after the run.
Expected cost: Stripe $0 (TEST mode, no real money, no fees); GitHub Actions about 45-75 runner minutes (the repo comments describe a public repo, where standard runners are free; confirm before the run); engineering effort roughly two working sessions to write and review the relay and the failure/settlement spec plus one dry run of the static parts; owner effort about 10 minutes plus one approval click plus a 2-minute log glance. A failed run costs one more approval; the harness fails closed before any money-path call when a guard fails.
Rollback/cleanup: the run touches only the sandbox and the ephemeral runner; objects created in the sandbox are TEST objects and are listed in the encrypted evidence; there is nothing to roll back in DanceFlow production.
