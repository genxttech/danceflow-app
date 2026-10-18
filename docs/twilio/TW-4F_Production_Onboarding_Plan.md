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
- **Parent-account pilot exception:** Twilio documents Type #4 (customers under the primary account, one Messaging Service per customer) as supported, with the documented risk that one customer's non-compliant traffic can force suspension of the whole account, and weaker per-customer analytics. This is Twilio's documentation, not an approval of DanceFlow's plan; Twilio's 2026-10-06 reply called it "not an architecture blocker". Keep it for ConfiDance and the first studios.
- **Long term (4H):** Type #1, one subaccount per studio (Twilio's preferred). Needs answers to Q1b/Q1c (cross-account Primary assignment, per-subaccount webhook signature validation) before building. Moving a studio later means re-registering its brand and campaign and resets account-level opt-out settings. Cheap preparation now: store the owning Twilio account SID per registration and pass an account context through the adapter; do not build subaccounts in 4F.
- **Stage B draft (`BU68e22e24...` and its 9 siblings):** **exclude from production onboarding; do not adopt.** It was created for a throwaway local studio id, is named for it, carries the Stage B mock-switch context, and the production runner locates resources by friendly name (including the real studio id and sequence), so it can never be found. Recommendation: delete it before the real ConfiDance run (Customer Profile and Address deletion are documented; EndUser/SupportingDocument deletion is unconfirmed; try the Console first), then keep the evidence file. Leaving it only leaves an EIN-bearing draft and a second draft profile for the same legal entity. Needs your decision (D1).

## 5. Operations that need separate explicit authorization

| Gate | Operation | Why |
|---|---|---|
| G0 | Pilot access on + runner window open (per studio, time-boxed) | existing |
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

Remaining: 4F-2b (read-only status sync of profile / trust product / brand / campaign, error-to-action catalog, owner emails), 4F-3, 4F-4, 4F-5, 4F-6. Open owner decisions: D1-D6, D8, D9 (D7 is satisfied).

## 9. Phased plan

| Phase | Scope | Depends on | Acceptance | Gate to release |
|---|---|---|---|---|
| **4F-0** | Decisions D1-D9 below; Twilio items: AOO stance, tier/use case, pre-review of the package (ticket #29647095) | none | decisions recorded | owner |
| **4F-1 (first dev slice)** | **Irreversible-step gates:** `confirmSubmit` in the runner (`waiting_submission_confirmation` before S11 and T6), platform UI with typed studio confirmation, audit rows, tests, runbook | #226 | no run reaches S11/T6 without a fresh confirmation; B1 still needs its own; fake-driven full run proves each stop; mutation checks | Opus review + owner merge |
| 4F-2 | Status sync and tracking: read-only profile/brand/campaign/number status fetch, platform "refresh all", owner state emails, error-to-action catalog, package export for Twilio pre-review | 4F-1 | states advance from observed Twilio status; every `needs_info` has an owner action | merge |
| 4F-3 (R2a) | Adapter + runner: Messaging Service, campaign payload builder and evaluation-style pre-check, campaign hold (G5) | 4F-2, D3/D4 | fake-driven; no purchase/campaign without gates; payload lengths verified | Opus review; merge |
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
| D2 | Keep the parent-account pilot for ConfiDance and early studios | Yes; subaccounts in 4H |
| D3 | Tier/use case | Standard + MIXED (Twilio's earlier guidance) |
| D4 | Opt-out: enable Advanced Opt-Out once in the Console for the Messaging Service, or default handling | Console AOO for ConfiDance |
| D5 | Spend limit for brand, campaign vetting and one number | State a cap; amounts to be verified on the invoice |
| D6 | Send the package to Twilio for pre-submission review before the campaign | Yes |
| D7 | Approve 4F-1 as the first slice | Yes |
| D8 | Activation stays a manual platform release for the pilot | Yes (existing D5) |
| D9 | ConfiDance owner completes the wizard in production using the same legal data already verified | Yes |

## 12. Separate items (not part of TW-4F)

- **Auth callback "production-build defect" (re-examined 2026-10-18, corrected):** `src/app/(auth)/callback/route.ts` exports helper functions besides `GET` (`resolveEmailBindingDestination` since PR #127, plus three older ones). That is a real violation of Next.js's route-module rule, but it is **not a blocker for Vercel**: the default `next build` (Turbopack, what Vercel runs) completes successfully (exit 0, verified locally on 2026-10-18 on the current code), and every Vercel build on recent PRs passed. It fails only under `next build --webpack`, whose generated route validator rejects extra exports; that mode reports at least three route modules (the callback, `api/cron/aria-digest`, `api/payments/webhook`, and likely more). So it is latent hygiene, not a promotion prerequisite. If the project ever builds with webpack, move the helpers out of the route modules (the callback helpers are pure and easy to move; the payments webhook handlers are large and need their own careful PR). No change was made.
- **TW-4 P3 follow-ups:** P3-A (refused re-check leaves ledger row `succeeded`), P3-B (crashed S11/T6 re-check ordering), plus F-2 (orphaned drafts on resubmission) as a design note.
- **Docs consistency:** fixed in this update (`TW-4_StageB_Studio_Identity.md` no longer lists the Twilio Support reply as a prerequisite).
- **Production ask in the Twilio ticket:** optional now; only if an unresolved issue blocks safe execution.
