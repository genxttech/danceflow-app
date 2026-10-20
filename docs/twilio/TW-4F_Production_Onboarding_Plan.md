# TW-4F: ConfiDance production SMS onboarding, architecture review and implementation plan

Status 2026-10-18. Written 2026-10-17 as planning only; **delivery status is in §9a** (4F-1 #227, 4F-1b #228 and 4F-2a #229 are merged; nothing was sent to Twilio, no hosted database was changed, nothing was deployed or promoted). The review baseline was main `36bd533d` (PR #226); main is now `c73d45a7`. Findings below come from reading the repository at that commit; anything not read is marked "to verify". Stage C remains unauthorized.

## 1. What exists today (do not rebuild)

| Area | State | Evidence |
|---|---|---|
| Schema (onboarding, provisioning ledger, audit, access flags, EIN storage/purge) | **Built, tested; DEV-applied; PROD foundation approved (R1/R1.1 PROD state: to verify)** | migrations `20261119090000`..`092100` |
| State machine (13 states) mirrored in SQL trigger | Built | `stateMachine.ts`, tests pin it to SQL |
| Owner wizard (Settings -> Texting): identity, representative, number, review + 4 attestations; save/submit/cancel; owner-only; pilot-flag gated | Built, component-tested | `app/settings/sms/*` |
| EIN: encrypted per studio (env key), stored via service-role RPC, purged on cancel, on `brand_approved`, and 30 days after terminal/exception (cron) | Built | `ein.ts`, R1 SQL line ~415, cron route |
| Per-studio public SMS Terms/Privacy pages, campaign text template v1 | Built (live on PROD: to verify) | `legalPages.ts`, `campaignTemplate.ts` |
| Owner status tracker | Built (static plain-language states) | `SmsStatusTracker.tsx` |
| Platform pilot UI: access switch, runner window, run/advance with fee confirm, registration list | Built | `app/platform/sms/*` |
| Runner S1..S11, T1..T6, B1 + brand status refresh; ledger, lease, window, reconcile-before-retry, fee step never retried | Built, fake-tested | `runner.ts` (+ #226 evaluation integrity) |
| Real Twilio adapter (Standard API key auth), fake adapter | Built | `real.ts`, `fake.ts` |
| Validation harness (Stage A reads, Stage B writes S1-S10, Stage C) | Developer-only, local DB; **Stage B proven live** (S1-S10, evaluation compliant) | `scripts/tw4-validation/` |

## 2. What is incomplete, simulated, or not built

- **Simulated or never run live in the app path:** the production runner via the platform action (real mode needs production + `TW4_ISV_REAL_CALLS` + key variables, none set); S11, T1-T6 and B1 have never run against Twilio (Stage C never authorized).
- **Not built:**
  1. Messaging Service, A2P campaign (UsAppToPerson), phone-number search/purchase/attach (design "R2"). The adapter interface has no such methods.
  2. Registration status tracking beyond a manual brand refresh: no polling, no Event Streams, no campaign/number status, no cron other than EIN purge.
  3. Opt-out handling decision (Advanced Opt-Out is Console-only; design F1).
  4. Activation automation (`ready_for_activation` -> `active`): today the TW-3 registration row is recorded by a platform admin and `DANCEFLOW_SMS_STATUS` is a global master switch.
  5. Owner notifications on state change, an error-to-action catalog for `needs_info` / `exception`, a package export for Twilio's pre-submission review.
  6. Subaccount architecture (Q1) and per-account webhook validation.
  7. Browser e2e for Settings -> Texting and the platform runner flow (only component/unit tests exist; `e2e/` has no SMS spec).
- **Finding F-1 (gate gap):** `confirmFee` guards only the brand (B1). **S11 and T6, the irreversible submissions, have no gate of their own in the production path**; a single platform "run" with the fee box unchecked advances S1 -> S11 -> T1..T6 and stops only at B1. The staged harness proves the bounded behavior, the production action does not have it.
- **Finding F-2 (resubmission):** the submit RPC bumps `submission_seq`, so each needs-info correction creates a **new** set of Twilio drafts (new friendly names) and orphans the previous set.

## 3. Production onboarding sequence (per studio)

| # | Step | Actor | Twilio effect | Gate |
|---|---|---|---|---|
| 0 | Pilot access on, comp entitlement, legal pages live | Platform admin | none | G0 |
| 1 | Business identity, representative, number preference | Studio owner (wizard) | none | |
| 2 | EIN entered once (encrypted, never shown again) | Owner | none | |
| 3 | Attestations (authorized, accurate, opt-in only, fees/terms) = consent evidence, stored with timestamps | Owner | none | G1 |
| 4 | Submit for checks | Owner | none | |
| 5 | Pre-run review of generated package; Twilio pre-submission review offered on ticket #29647095 | Platform admin | none | G1b |
| 6 | S1-S10: draft Secondary profile, EndUsers, Address, document, assignments, evaluation | Runner | **persistent drafts** (EIN inside the business EndUser); no fee documented | G0 + runner window |
| 7 | S11: submit profile for review | Runner | **irreversible** | **G2 (new)** |
| 8 | T1-T5, then T6: A2P trust product, evaluate, submit | Runner | persistent; T6 **irreversible** | G2 (new) |
| 9 | B1: Standard brand | Runner | **fee**, irreversible | G3 (exists: `confirmFee`) |
| 10 | Wait for brand approval (minutes to 7+ business days); EIN purged on approval | Status sync | none | |
| 11 | Messaging Service + number search/purchase/attach | Runner (R2) | **monthly fee, persistent** | G4 (new) |
| 12 | Campaign (MIXED), Terms/Privacy URLs, samples | Runner (R2) | **fee ($15 vetting + monthly), irreversible** | G5 (new, plus campaign hold for Twilio pre-review) |
| 13 | Wait for campaign approval and number registration | Status sync | none | |
| 14 | Activation: TW-3 row `approved`, aggregate checks, global flag | Platform admin (pilot: manual release, D5) | none | G6 |
| 15 | First real SMS verification: consented test recipient, STOP/START/HELP, status callback | Platform admin + owner | **real message** | G7 |

Exceptions: every `needs_info` / `exception` maps to one plain-language action for the owner (fix a field) or the platform (retry, adopt, contact Twilio). Never show Twilio terms to studios.

## 4. Architecture decisions

- **Primary vs Secondary:** GenX TotalTech LLC stays the approved ISV Primary profile (only assigned, never the subject). ConfiDance Unlimited, LLC is the first Secondary subject. The business-file and launcher guards stay developer-harness only; the production path needs its own server-side check that a studio's EIN last four differs from the Primary's.
- **Account architecture (D2, REVISED 2026-10-18 by the owner; supersedes the earlier "parent-account pilot exception"):** Twilio's preferred Type #1. GenX TotalTech LLC / DanceFlow owns the parent ISV account and the approved Primary Customer Profile (used only for DanceFlow's own traffic and assigned to Secondary profiles, never the subject of a studio's registration). **Each independent studio legal business gets its own Twilio subaccount and Secondary Customer Profile, beginning with ConfiDance Unlimited, LLC.** All of that studio's Secondary profile, TrustProduct, Brand, Messaging Service, campaign and numbers live in its subaccount. DanceFlow provisions and manages everything through the application; studio owners never need a Twilio account or the Console. Several locations of one legal business are modelled explicitly (see §13), not by creating duplicate legal registrations. **The parent-account (Type #4) pilot exception is removed: it is not a fallback and must not be reintroduced without the owner's explicit approval.** The 2026-10-06 Twilio reply that Type #4 is "not an architecture blocker" is historical context only.
- **Stage B evidence:** the Stage B draft (S1-S10 for ConfiDance, evaluation compliant) was created in the parent account. It remains valid historical evidence that the identity data, the Primary assignment and the evaluation work, and is unchanged here; it is **not** the production architecture and cannot be adopted (it lives in the wrong account; see D1). Details of the subaccount requirements, open Twilio questions and implementation consequences are in §13.
- **Stage B draft (`BU68e22e24...` and its 9 siblings):** **exclude from production onboarding; do not adopt.** It was created for a throwaway local studio id, is named for it, carries the Stage B mock-switch context, and the production runner locates resources by friendly name (including the real studio id and sequence), so it can never be found. Recommendation: delete it before the real ConfiDance run (Customer Profile and Address deletion are documented; EndUser/SupportingDocument deletion is unconfirmed; try the Console first), then keep the evidence file. Leaving it only leaves an EIN-bearing draft and a second draft profile for the same legal entity. Needs your decision (D1).

## 5. Operations that need separate explicit authorization

| Gate | Operation | Why |
|---|---|---|
| G0 | Pilot access on + runner window open (per studio, time-boxed) | existing |
| **G-SUB** | **Create the studio's Twilio subaccount (P2)** | persistent account; closing it is permanent (new, §13) |
| G1/G1b | Owner attestations; platform review of the generated package | consent evidence; Twilio pre-review |
| **G2** | **Submit the profile (S11) and the trust product (T6)** | irreversible; **new, separate from the fee gate** |
| G3 | Brand creation | fee; irreversible (existing `confirmFee`) |
| **G4** | Phone-number purchase | monthly fee; persistent |
| **G5** | Campaign registration | fee; irreversible; held until Twilio's pre-review is clean |
| G6 | Activation | enables sending |
| G7 | First real SMS | real message, real recipient |

Each gate is a distinct typed confirmation naming the studio, audited with actor and time, valid for one run, and refused if the previous gate's evidence is missing (for example the pre-submission re-evaluation added in #226).

## 6. Control review (tenant isolation, authorization, idempotency, concurrency, retention, audit, recovery)

- **Tenant isolation / authorization:** tables have no API privileges; all access is through service-role RPCs that re-check the actor (owner for the wizard, platform admin for the runner); the page 404s/redirects for non-managers and for studios without the flag. Component and local-stack tests exist. Needs an Opus review again for each new action (G2, R2).
- **Idempotency:** deterministic friendly names include the studio id, step and `submission_seq`; lookups precede creation for profile/trust product/brand; a succeeded step is never re-run.
- **Concurrency:** lease plus unique `(onboarding, step, seq)` constraint plus runner window; a second concurrent run is `lease_busy`.
- **Partial failure:** unknown outcomes are reconciled before retry; fee steps never auto-retry and end in `exception` for a human. New R2 steps (purchase, campaign) must copy this, with an extra rule: no purchase before the campaign payload evaluates clean.
- **Sensitive data:** EIN encrypted, purged on brand approval, cancel and 30 days after terminal/exception; reports and ledger carry SIDs and field names only (#226 sanitizer). The EIN remains in the Twilio draft EndUser by Twilio's design.
- **Audit:** append-only onboarding audit and runner audit rows exist; platform actions audited. Gap: no audit of "who confirmed which irreversible step" (closed by G2).
- **Evaluation integrity:** closed by #226 (fail closed, pre-submission re-verification). Open follow-ups P3-A (ledger row stays `succeeded` after a refused re-check) and P3-B (crashed S11/T6 attempt re-checked before reconcile).

## 7. Experience (clicks and clarity)

- Owner path stays one wizard: business -> representative -> number -> review. Improve: pre-fill from studio settings and the ConfiDance website choice, inline "where do I find this" help for the EIN letter, address match hint (IRS-address caveat), a single "what happens next" panel with expected waits, and an email on every state change.
- Remove developer vocabulary: no "Twilio", "brand", "campaign" in owner copy; one primary action per state; `needs_info` highlights the exact field and returns to that step (already implemented for field mapping).
- Platform path: one "Next step" button that names the gate it will pass ("Submit profile for review: irreversible"), progress per stage, and a checklist of evidence (evaluation compliant, package reviewed).

## 8. Developer-owned QA

- Unit/synthetic: adapter contract tests for every new method (fake and recorded real-shape replies), fail-closed parsing, fee/irreversible gates, idempotency and crash-recovery tests (kill between ledger write and reply), lease races.
- Authorization: owner vs manager vs staff vs other-tenant owner vs platform admin vs anon on every action and RPC; flag off; paused pilot.
- Database: real-SQL local-stack tests for every new function, grants, RLS and the transition graph; migration fingerprint before PROD.
- UI: Playwright e2e for the wizard (happy path, validation jump, needs_info round trip, cancel) and the platform runner page (gate dialogs, window, refusals); axe checks; mobile width.
- Negative cases: noncompliant, unrecognized and malformed Twilio replies; 401/403/429/5xx; duplicate submit clicks; double-tab runs.
- Production smoke after each release: flags off by default; no Twilio call without gates; pilot studio only; cron endpoints reject bad secrets; EIN purge verified on a synthetic record.

## 9a. Delivery status (2026-10-18)

| Slice | PR | Main | What shipped | Notes |
|---|---|---|---|---|
| 4F-1 | #227 | `87d4d67d` | Per-run confirmation gates for S11 / T6 (two checkboxes, typed `SUBMIT`), a confirmation counts only if the evaluation existed before the run; interim log trail | Closes finding F-1. The typed word is `SUBMIT` (not the studio name), and the durable audit came in 4F-1b |
| 4F-1b | #228 | `9b0fd351` | Database-enforced, lease-bound, single-use submission confirmations; evaluation verdicts on the ledger and audit; state / freshness guard; read-only step evidence view; rollback guards | **Migration `20261120090000` is NOT applied to DEV or PROD.** Needs the owner's authorization and a pre-apply check of onboardings whose S10/T5 succeeded earlier (they are sent back to the owner) |
| 4F-2a | #229 | `c73d45a7` | Read-only campaign package review and plain-text export for the Twilio pre-submission review (D6), owner wording fix for a setup sent back without a field | Use case in the export is labelled "to be confirmed" (D3 open) |
| 4F-3a | #234 | `d8b5f3c4` | Subaccount per legal entity: legal-entity and owner-attested location links, spend cap and reservation, one-shot confirmed subaccount creation, account-scoped adapters and runner binding (fake only) | Migration `20261121090000` NOT applied to DEV/PROD; design and owner decisions in `TW-4F-3a_Subaccount_Design.md`; Q1b and Q1c still block real Twilio activity |
| 4F-3b-0 | (this PR) | pending | Prepaid SMS credits are the billing model: legal-business credit accounts with per-location attribution, append-only ledger, settled-only funding, atomic reservation/capture/release around every fee step, usage debit/refund, reversals and negative-balance blocking, reconciliation records, studio-facing balance/history/prices (local, synthetic) | Migration `20261122090000` NOT applied to DEV/PROD; design and 10 open decisions in `TW-4F-3b_Design.md`; Stripe top-up and UI are later slices |
| 4F-3b-pay | (this PR) | pending | Stripe Checkout purchase of $25/$50/$100 prepaid SMS credit on the platform account; settled-only funding; $500 ceiling incl. pending; refunds and disputes; credit webhook handler; dark behind `SMS_CREDIT_PURCHASES` (local, synthetic) | Migration `20261123090000` NOT applied to DEV/PROD; requires 4F-1b, 3a, 3b-0 first; see `TW-4F-3b_Design.md` section 10 |
| 4F-3b-UI | (this PR) | pending | Prepaid credit screens: studio balance/available/reserved/pending, packs and purchase via the flag-gated checkout route, activity, low/insufficient/negative/hold states; minimal read-only platform-admin credit monitoring (local, synthetic) | Migration `20261124090000` (read-only functions) NOT applied to DEV/PROD; requires `20261123090000`; purchases stay off (`SMS_CREDIT_PURCHASES`); real purchase terms still to be published |
| 4F-pay-hardening | (this PR) | pending | Server-side hold enforcement on credit checkout (fail closed); per-dispute state table and order-independent reinstatement rule; replay/concurrency/property tests (local, synthetic) | Migration `20261125090000` NOT applied to DEV/PROD; requires `20261123090000`; purchases stay off |
| 4F-recurring | (this PR) | pending | Owner-authorized recurring number rent / campaign monthly fee: price, term and total limit recorded; charged only from settled prepaid credit, atomically, once per period, attributed to the authorizing location; refuses on hold / limits / price change / revocation; low-balance warnings; suspension as a state (numbers never released); minimal admin visibility (local, synthetic) | Migration `20261126090000` NOT applied to DEV/PROD; requires `20261125090000`; flag `SMS_RECURRING_AUTHORIZATION` off; scheduler, sender integration, prices and terms still to do; release risks in `TW-4F-3b_Design.md` section 14 |
| 4F-recurring-exec | (this PR) | pending | Recurring charges count toward the shared legal-business spending cap; pilot business never gets a standing recurring authorization (per-operation approvals only); scheduler entry point with DB kill switch (off), single run lease, fencing, run audit and reconciliation; sender refuses new outbound texts for a suspended business (fail closed), inbound STOP/START/HELP untouched (local, synthetic) | Migration `20261127090000` NOT applied; cron route not registered; four gates off; see `TW-4F-3b_Design.md` section 15 |
| 4F-monthly-limits | (this PR) | pending | Owner-approved calendar-month spending limits (legal business timezone, default $0, platform ceiling $500) replace the lifetime cap for usage and recurring costs; first recurring month set aside at authorization; setup fees keep the cumulative budget; pilot ceiling unchanged (local, synthetic) | Migration `20261128090000` NOT applied; requires `20261127090000`; flag `SMS_MONTHLY_LIMITS` off; D5 sender integration mandatory before real SMS; see `TW-4F-3b_Design.md` section 16 |
| 4F-provider | (this PR) | pending | Twilio ticket #29647095 answers implemented: Primary profile read through the parent (GET only) and assigned into the subaccount Secondary; subaccount-token webhook verification with AccountSid → legal business mapping, tenant check and replay ledger; token rotation (one spaced re-read, no old-token grace); Low-Volume Standard path (`SkipAutomaticSecVet`, `LOW_VOLUME`), paid LVS brand blocked until a tier price exists (local, synthetic) | Migration `20261129090000` NOT applied to DEV/PROD; switch `TW4_SUBACCOUNT_WEBHOOKS` off; financial dependencies in `TW-4F_Provider_Integration.md` section 6 |
| 4F-usage-billing | (this PR) | pending | Outgoing texts of a legal business are billed: atomic pre-send reservation (segments x per-segment price, credit, hold, monthly limit, ceiling, approved subaccount sender, suspension, DB kill switch), one attempt per source (no duplicate sends), dispatch marker, signed attempt-bound callbacks (no money), evidence-based settlement and admin resolution; legacy unlinked studios unchanged (local, synthetic, fake provider) | Migration `20261201090000` NOT applied; requires `20261128090000` (and `20261129090000` operationally); `SMS_USAGE_BILLING`, `SMS_BILLED_REAL_SEND`, `SMS_USAGE_EVIDENCE_READS` and the DB switch all off; scheduled reconciler is an activation gate; see `TW-4F_Usage_Financials_Design.md` |
| 4F-panel | (this PR) | pending | Supervised-pilot platform-admin panel: legal business from the submitted setup, owner-attested location links decided by an admin, cumulative setup budget, one owner-approved fee per operation, ConfiDance $150 pilot ceiling, separately confirmed Create subaccount (one-time request key), Standard / Low-Volume Standard with eligibility checklist, per-studio stages and audit evidence; owner location-attestation page (local, synthetic) | Migration `20261130090000` NOT applied to DEV/PROD; see `TW-4F_Admin_Panel.md`; monthly limits shown once that work merges |

Remaining: 4F-2b (read-only status sync of profile / trust product / brand / campaign, error-to-action catalog, owner emails), 4F-3, 4F-4, 4F-5, 4F-6. Open owner decisions: D1-D6, D8, D9 (D7 is satisfied).

## 9. Phased plan

| Phase | Scope | Depends on | Acceptance | Gate to release |
|---|---|---|---|---|
| **4F-0** | Decisions D1-D9 below; Twilio items: AOO stance, tier/use case, pre-review of the package (ticket #29647095) | none | decisions recorded | owner |
| **4F-1 (first dev slice)** | **Irreversible-step gates:** `confirmSubmit` in the runner (`waiting_submission_confirmation` before S11 and T6), platform UI with typed studio confirmation, audit rows, tests, runbook | #226 | no run reaches S11/T6 without a fresh confirmation; B1 still needs its own; fake-driven full run proves each stop; mutation checks | Opus review + owner merge |
| 4F-2 | Status sync and tracking: read-only profile/brand/campaign/number status fetch, platform "refresh all", owner state emails, error-to-action catalog, package export for Twilio pre-review | 4F-1 | states advance from observed Twilio status; every `needs_info` has an owner action | merge |
| 4F-3 (R2a) | **Revised for D2 (§13): 4F-3a account-scoped adapter, subaccount step, spend cap first; then** Adapter + runner: Messaging Service, campaign payload builder and evaluation-style pre-check, campaign hold (G5) | 4F-2, D3/D4 | fake-driven; no purchase/campaign without gates; payload lengths verified | Opus review; merge |
| 4F-4 (R2b) | Number search/purchase/attach (G4), registration row sync into TW-3, activation checklist (G6) | 4F-3 | `ready_for_activation` only with all invariants | Opus review; merge |
| 4F-5 | e2e + smoke suite; runbooks; production configuration (env keys, flags) | 4F-1..4 | suite green | merge |
| **4F-6 (release)** | PROD migrations if any (fingerprint first), deploy via the promote flow, ConfiDance pilot through the real in-app flow with G2..G7 each authorized in writing, production verification | all | ConfiDance active; STOP/START/HELP verified | owner |
| 4H (later) | Subaccount architecture, Event Streams, auto-activation | pilot retro (D5) | | |

Production prerequisites outside code (each needs its own authorization): production deployment/promotion of a build containing 4F (the auth-callback build issue is NOT a blocker, see §12), PROD env values (`TW4_ISV_REAL_CALLS`, ISV key variables, EIN encryption key and id, compliance email, policy SIDs), PROD migration state for R1/R1.1 (verify), ConfiDance pilot flag and comp entitlement.

## 10. First bounded development slice: 4F-1, irreversible-step gates

Why first: it is the only found gap that lets a production click cause an irreversible Twilio submission without its own confirmation, it needs no new Twilio write capability, and every later phase depends on a trustworthy gate model. Scope: runner (`confirmSubmit`, new outcome, positional check at S11/T6, composes with #226's pre-verification), platform action and card, audit rows (use existing runner audit), tests (including mutation checks), runbook note. Not in scope: R2, polling, emails, subaccounts. Requires a focused Opus review of the authorization boundary. No SQL expected (to confirm during design).

## 11. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Stage B draft: delete before the real run, leave, or (not advised) adopt | Delete before the real ConfiDance run; never adopt |
| D2 | **REVISED 2026-10-18 (owner): a Twilio subaccount per studio legal business, starting with ConfiDance; the parent-account pilot exception is REMOVED** | Decided; see §4 and §13. Do not revert without explicit owner approval |
| D3 | Tier/use case | **Approved: Standard + MIXED** (implemented inside the studio's subaccount) |
| D4 | Opt-out: Advanced Opt-Out | **Approved: Advanced Opt-Out**, enabled for the studio's Messaging Service in its subaccount (Console-only today, so a platform-admin step until Twilio confirms an API; opt-outs are per account and therefore per studio) |
| D5 | Spend limit for brand, campaign vetting and one number | **ConfiDance pilot cap: $150**, in force and **not permission to spend**; since 2026-10-19 every fee is also paid from the studio's own settled prepaid SMS credit (see `TW-4F-3b_Design.md`). Every fee-bearing step (brand, campaign vetting, number, monthly fees) still needs separate written approval before any charge; the cap is enforced in the runner (§13) |
| D6 | Send the package to Twilio for pre-submission review before the campaign | Yes |
| D7 | Approve 4F-1 as the first slice | Yes |
| D8 | Activation stays a manual platform release for the pilot | Yes (existing D5) |
| D9 | ConfiDance owner completes the wizard in production using the same legal data already verified | Yes |

## 12. Separate items (not part of TW-4F)

- **Auth callback "production-build defect" (re-examined 2026-10-18, corrected):** `src/app/(auth)/callback/route.ts` exports helper functions besides `GET` (`resolveEmailBindingDestination` since PR #127, plus three older ones). That is a real violation of Next.js's route-module rule, but it is **not a blocker for Vercel**: the default `next build` (Turbopack, what Vercel runs) completes successfully (exit 0, verified locally on 2026-10-18 on the current code), and every Vercel build on recent PRs passed. It fails only under `next build --webpack`, whose generated route validator rejects extra exports; that mode reports at least three route modules (the callback, `api/cron/aria-digest`, `api/payments/webhook`, and likely more). So it is latent hygiene, not a promotion prerequisite. If the project ever builds with webpack, move the helpers out of the route modules (the callback helpers are pure and easy to move; the payments webhook handlers are large and need their own careful PR). No change was made.
- **TW-4 P3 follow-ups:** P3-A (refused re-check leaves ledger row `succeeded`), P3-B (crashed S11/T6 re-check ordering), plus F-2 (orphaned drafts on resubmission) as a design note.
- **Docs consistency:** fixed in this update (`TW-4_StageB_Studio_Identity.md` no longer lists the Twilio Support reply as a prerequisite).
- **Production ask in the Twilio ticket:** optional now; only if an unresolved issue blocks safe execution.

## 13. D2 revision: subaccount per studio (2026-10-18, planning only)

Nothing was created at Twilio, no authenticated Twilio API was called, and no code or migration changed. Sources are Twilio's public documentation (the ISV onboarding overview, the ISV API guide, the Subaccounts and Security docs). Items marked **UNVERIFIED** must be answered by Twilio or proven by a supervised run in a subaccount before anything is built on them.

**Review of existing work for parent-account assumptions** (4F-1, 4F-1b, 4F-2a/2b are merged; 4F-3 has not been started):
- `twilioIsv/config.ts`, `real.ts`: one `accountSid` and token (or API key) for the whole adapter; Addresses are created under `/Accounts/{accountSid}`; Trust Hub and Messaging calls (`trusthub.twilio.com`, `messaging.twilio.com`) carry no account in the URL, so their scope is whatever credentials sign the request. **This assumes the parent account.**
- `IsvAdapter` has no account context; the runner and ledger identify resources only by SID and friendly name. Friendly names (`df:{env}:{studio}:{step}`) stay valid, but a lookup by name is unique only **within** an account.
- `studio_sms_registrations` (TW-3) has no account SID column, and the onboarding row and steps ledger have no subaccount reference. The global `TWILIO_ACCOUNT_SID` is also the sender for the existing TW-1/2 sending, and inbound/status webhook validation (`twilioWebhook.ts`) verifies against one token.
- The Stage A/B validation harness is parent-only by design; it is historical and stays unchanged.
- The 4F-1/4F-1b gate model (confirmations, evaluation verdicts, leases, windows) is account-independent and carries over unchanged.

**Documented Twilio requirements (verified in public docs)**
1. Type #1 is "preferred": per customer, a Secondary Customer Profile and Brand under the customer's subaccount, one campaign per use case, and each use case mapped to its own Messaging Service **in the same subaccount**. The Primary Customer Profile is for the ISV's own Brands and Campaigns only. A Brand belongs to a single Customer Profile. Campaign registration does not carry over between accounts. Campaign content must reflect the studio, not the ISV. Campaign email notices for a subaccount route to the parent's Primary profile email, so DanceFlow, not the studio, receives them.
2. Creating, suspending and closing subaccounts needs the **parent's SID and auth token** (a Main API key also works; Standard API keys cannot). Creation is `POST /2010-04-01/Accounts` with a `FriendlyName`, and the response contains the subaccount's auth token. The default limit is 1,000 subaccounts, and all usage bills to the parent's single balance. Statuses: active; suspended (sending blocked, number rental continues); **closed (permanent, numbers released, cannot reopen)**. A suspended parent suspends every subaccount.
3. **Parent credentials reach v2010 resources of any subaccount, but resources on other subdomains need the subaccount's own credentials** (its SID and token, or a subaccount-level API key). Trust Hub and Messaging A2P are such subdomains. **Consequence: the adapter must authenticate as the studio's subaccount for S1-S11, T1-T6, B1, the Messaging Service, the campaign and the number.**
4. Order is unchanged: the TrustProduct need not be approved before the Brand; the Brand must be APPROVED before the Messaging Service step and the campaign. Brand creation and campaign registration incur fees.
5. A number can be moved between accounts with parent credentials, but A2P registrations and Trust Hub enrolments must be redone, and moving to subaccounts resets account-level opt-outs (irrelevant now that studios start in their own subaccounts).

**Open questions and provider-policy blockers.** Q1b and Q1c were ANSWERED by Twilio on ticket #29647095 (2026-10-19); see `TW-4F_Provider_Integration.md` for the six answers and the implementation. The remaining items are still unverified.
- **Q1b, RESOLVED 2026-10-19 (Twilio: yes, same organization):** can the **Primary** Customer Profile (parent account) be assigned into a Secondary profile or TrustProduct that lives in a subaccount (cross-account assignment)? Twilio's public pages do not say. Stage B proved the assignment only with both in the parent account. If it is not allowed, Twilio must name the supported ISV pattern; since this is their preferred architecture, one exists. This is already question 1(b) in the TW-4 design's Twilio inquiry and needs an answer on ticket #29647095.
- **Q1c, RESOLVED 2026-10-19 (Twilio: the subaccount Auth Token; on-demand retrieval through parent credentials is supported; rotation has no overlap):** which token signs webhooks for subaccount numbers and Messaging Services? The Security docs say only "the AuthToken" and give no ISV pattern for validating without holding each token. Working assumption, to be proven in a supervised test with a consented recipient: the subaccount's token.
- **Q-hdr:** whether Trust Hub accepts parent credentials with an `X-Twilio-AccountSid`-style scoping header. Not documented in the pages read; do not assume it.
- **Q-aoo:** whether Advanced Opt-Out can be set per Messaging Service by API. Treated as Console-only until Twilio says otherwise.
- **Q-evt:** Event Streams, one parent sink or one per subaccount.
- **Q-dup:** whether the parent-account Stage B draft affects registering the same legal entity again inside a subaccount (duplicate-entity checks). Delete the draft first (D1).
- Not blockers: the 1,000-subaccount limit; Secondary profile approval is not required before the TrustProduct and Brand.

**Required design changes**
- *Schema (one new migration in TW-4F-3a; not applied without approval):* `studio_sms_legal_entities` (the legal business: legal name, EIN last four, spend cap) and `studio_sms_twilio_accounts` (legal entity, `twilio_account_sid` unique, environment, status active/suspended/closed, created_by, timestamps; **no token**). Add `twilio_account_sid` to the onboarding row, the steps ledger, the audit and `studio_sms_registrations`, with a check that every recorded SID or registration belongs to the entity's own subaccount.
- *Credentials:* never store a subaccount auth token in the database. Either fetch it from the parent API at call time (parent credentials, short in-memory cache, never logged), or mint a revocable subaccount API key kept encrypted with the existing key-id pattern. The Opus review decides. Every call asserts that the adapter's account SID equals the entity's recorded subaccount.
- *Adapter:* `IsvAdapter` becomes account-scoped (a `forAccount(subaccountSid)` factory, with no method callable without an account context). New P2 methods `findSubaccount` and `createSubaccount` are idempotent by deterministic friendly name `df:{env}:{legal_entity_id}`; an unknown outcome reconciles by lookup before any retry, as for the brand. `closeSubaccount` is **not** built in 4F (permanent; owner-approved manual runbook only). The fake adapter models separate accounts so that a cross-account SID use fails in tests.
- *Gates:* add G-SUB (subaccount creation: platform-admin confirmation, audited, one-shot, using the existing confirmation-table pattern). G2 (S11/T6), G3 (brand), G4 (number) and G5 (campaign) are unchanged but now also require that the account matches. Suspend and close would need their own future gate.
- *Idempotency:* a database uniqueness guarantee of one subaccount per legal entity, lease-protected creation, and name lookups only inside the entity's own account.
- *Tenant isolation and authorization:* webhook handlers must map `AccountSid` plus `To` or `MessagingServiceSid` to exactly one studio and reject mismatches. Platform actions re-check that the subaccount belongs to the studio being operated on. This is the most consequential change and gets a focused Opus account-isolation review before merge.
- *Audit evidence:* every runner and audit row records the account SID used; add the action `runner_subaccount_created`. Ledger reports carry SIDs only (the EIN sanitizer is unchanged).
- *Cost enforcement:* a per-legal-entity `spend_cap_cents` (ConfiDance = 15000, **the $150 pilot cap remains in force**) and a spend ledger of authorized fee events (brand, campaign vetting, number, monthly) checked in the runner **before** any fee-bearing call. A fee step is refused when it would exceed the cap or lacks a separate written approval recorded in its confirmation. Reaching the cap never auto-closes anything. Per-subaccount usage records give verified per-studio cost for the invoice check.
- *D3 Standard + MIXED:* unchanged. The payload builder and use-case labelling are account-independent, and the campaign belongs to the studio's own Messaging Service in its subaccount.
- *D4 Advanced Opt-Out:* decision unchanged. It is implemented per studio subaccount as a platform-admin Console step recorded in the activation checklist, which is now naturally per studio because opt-outs are account level. DanceFlow's own opt-out recording and send blocking stay in force.
- *Multiple locations of one legal business:* one legal entity owns one subaccount, one Secondary profile and one Brand. Locations (studios in DanceFlow) are linked to the entity explicitly. By default they share its Messaging Service and campaign when the legal entity and use case are the same, or may get their own Messaging Service in the same subaccount. A second location never triggers a second legal registration. Adding a location is a platform-admin action that links it to an existing entity, with a check that legal name and EIN last four match. Studios with different legal owners are different entities with different subaccounts.

**Proposed 4F-3 adjustment (sequence; none started)**
1. **4F-3a (local, fake only):** the schema above, the account-scoped adapter, the P2 subaccount step, G-SUB, the spend cap and ledger, and the legal-entity model. It gets an Opus account-isolation review. It can be built and tested against the fake; Q1b and Q1c matter only for what touches real Twilio behaviour.
2. **4F-3b:** Messaging Service and campaign builder with the G5 hold and the D6 Twilio pre-review, account-scoped.
3. **4F-4:** number purchase (G4, cap-checked), webhook mapping by AccountSid, registration row sync, activation checklist (D8).
4. **Before 4F-6:** a supervised check of Q1b and Q1c with the owner present and no fees. Nothing real runs until the owner separately authorizes subaccount creation, each fee, and each irreversible submission.

D1 is unchanged and now stronger: delete the parent-account Stage B draft before the real run. Real subaccount creation, any authenticated Twilio call, any fee and any submission remain unauthorized.

## 14. Billing model (2026-10-19)

Prepaid SMS credits are the default billing model for all independent studios, with **one prepaid balance per verified legal business** and cost attribution by studio location (owner decision 2026-10-19); Twilio subaccount isolation is not billing isolation. The model, the reuse of existing Stripe/ledger primitives, what slice 3b-0 built and the decisions still needed are in `TW-4F-3b_Design.md`. Effect on this plan: the spend cap and per-operation authorization (G3 brand, G4 number, G5 campaign) stay, and each of those gates now additionally requires the funding studio's settled credit; the ConfiDance pilot keeps its $150 maximum and needs separate explicit owner authorization for every real fee-bearing operation.

The ten owner decisions of 2026-10-19 on billing (one balance per legal business, packs and ceiling, no expiry, insufficient-funds blocking, authorized recurring deductions, absorbed variances, low-balance rule, retention vs deletion, and the ConfiDance founder pilot exception with a $150 cumulative cap and per-action approval) are recorded in `TW-4F-3b_Design.md` section 7; the draft cost-plus price proposal is `TW-4F-3b_Pricing_Proposal.md` (prices pending approval).
