# TW-4F minimal SMS pilot activation checklist (2026-11-18)

Scope: one studio (the pilot studio, legal entity [PILOT-LEGAL-NAME]; never GenX), one subaccount, Low Volume Standard brand and Low Volume Mixed campaign, one local number, a few named consenting recipients, manual activation. DRAFT: nothing here is authorized. Each row marked OWNER is its own written approval. The [PILOT-CAP] ceiling is a limit, not authorization. Holds: #445, #326, price publication until row 3, SMS activation until row 12.

State at 2026-11-18: SQL on PROD through 20270219; live www = dpl_EJ968dkDy (6ba31295); price list 0 rows; 0 subaccounts/brands/campaigns/numbers/credit accounts.

| # | Step | Who | Evidence of done | Status |
|---|---|---|---|---|
| 0 | Engineering readiness: consent port PR #668 reviewed; reconciler/scheduler/ledger isolated QA green on the live line + port | Engineering | iso-qa results table in this file section A | in progress |
| 1 | File the six price proposals (see TW-4F_Final_Price_Reconciliation_2026-11-18.md) in the owner's signed-in session | OWNER | six pending requests, amounts match | DONE 2026-11-20 20:06-20:08Z (six pending requests, exact) |
| 2 | After 24h, sign each with the hardware key (unpublished until row 3) | OWNER | requests approved | DONE 2026-11-21 20:35-20:37Z (hardware key, owner) |
| 3 | Authorize price publication (separate) | OWNER | six active price rows; verifier ok | DONE: signing publishes; six active rows, verifier ok, audit published x6; post-check 20:48Z |
| 4 | Release the consent hardening: apply 20270215100000 + set SMS_PENDING_OPT_OUT_REQUIRED in one step, then app build/promote (staged P1/P2 pattern) | OWNER gate per step | PROD object checks; app promoted | after #668 approval |
| 5 | Fixture capture against real Twilio (about $1.30, cap $5) | OWNER | captured shapes match documentedShapes fixtures | held (activation gate) |
| 6 | Pilot access, runner window, daily checker named, stop action = pause outbound and escalate | OWNER | recorded names and window | owner |
| 7 | G-SUB: create the pilot-studio subaccount | OWNER | subaccount SID, one per legal entity | held |
| 8 | G1/G1b attestations; G2 submit profile/trust product | OWNER | submission recorded | held |
| 9 | G3 brand fee ($4.50 conservative); wait for Twilio brand approval | OWNER; Twilio | brand approved | held |
| 10 | G4 number purchase (TW4_NUMBER_REAL_CALLS only at this step; reads use TW4_NUMBER_READS) | OWNER | number active; sender readiness ok | held |
| 11 | G5 campaign fee + vetting ($15); wait for Twilio campaign approval; verify Advanced Opt-Out in the Console (V-6) | OWNER; Twilio | campaign approved; opt-out verified | held |
| 12 | Flags and schedulers on, in order: reconciler + evidence reads, fee lifecycle, sender verify, inventory reconcile; prove one clean cycle each | OWNER enables; engineering proves | reconciler ready; no findings | held |
| 13 | G6 manual activation; fund test credit; G7 first consented test SMS | OWNER | delivered; usage row + ledger debit + reconciler evidence agree | held |
| 14 | STOP and START round trip on the test number | Engineering + owner | opt-out recorded and honored; START restores | after 13 |
| 15 | 7 days of clean monitor/reconciler; first Twilio invoice reconciled to the ledger | Engineering | no findings; invoice lines match | after 13 |

Stop conditions at any row: any monitor finding, reconciler not ready, spend over the approved ceiling, an unexpected provider fee, or a send to a non-consenting number. Action: pause outbound, escalate, never release the number.

Mandatory vs later: rows 0-15 are mandatory for the pilot. Not required before the first test SMS and tracked separately: legacy-sender gate, funding-exposure monitor, escalation channel, cancellation UI, quiet hours, automatic inbound hold, repricing, provider bill ingestion, Stripe clarification and counsel/CPA review (only if studios top up by Stripe), platform-admin AAL2.

## A. Isolated QA results (this session)
(filled in below as suites finish)

Run 2026-11-19 05:2x-05:50Z. Harness: df-pilot-runner (main 8ce3e8ca), scenario `numeric` (all TW-4F migrations through 20270219, incl. six added locally to scenarios.json: 20261231110000/130000/140000/150000, 20270212090000, 20270219090000; scenarios.json on main is stale by those six). Tests from the port branch claude/tw4f-consent-hardening-live-port. One suite at a time, fresh disposable stack each, torn down (docker ps = 0). No hosted contact.

| Suite | Result |
|---|---|
| tw4recon (usage reconciler) | 38/38 pass |
| tw4usage (usage billing) | 26/26 pass |
| tw4sender (sender readiness) | 18/18 pass |
| tw4rv (re-verify) | 28/28 pass |
| tw4inbound (inbound billing, with ISO_QA_MARKER=1) | 29/29 pass |
| feeres (fee resolution, with ISO_QA_MARKER=1) | 46/46 pass |
| f3recon (reconciler readiness gate) | 9/13: F3-01..F3-08 (readiness gate behavior, stale/stuck/no-evidence/gaps) pass; F3-09 d0-d3 (rollback-path tests) fail |

F3-09 classification: the tests assume the sub-cent layer 20261231130000 is the newest replacement; migration 20270212 (price micros publication) now calls its helper, so the rollback is correctly refused. A stale rollback-path test, not a forward-behavior defect; follow-up: update F3-09 for the 20270212 layer. Not run: scheduler cron-route unit tests (covered by the 74 cron tests in Gate C), tw4recurring/tw4monthly (recurring fee lifecycle, dark until row 12).
Setup notes: harness needs ISO_QA_MARKER=1 for fixtures that insert price rows; node_modules was a temporary junction, removed.

### A.2 Correction and re-run (2026-11-19 07:3x-07:50Z)
The four F3-09 failures were a test-version artifact, verified: current main's `localStack.f3recon` already rolls the 20270212 publication layer back before the sub-cent layer and re-applies it after (12 added lines, no assertion weakened); the port branch carried the older version, and my harness checkout was 133 commits behind main (scenarios.json there lacked six migrations; main's lists all 38). No reconciliation defect.
Re-run on current main (fresh stack each, ISO_QA_MARKER=1, scenario numeric, all migrations through 20270219): f3recon 13/13, tw4inbound 29/29, feeres 46/46. On the #668 port branch after syncing f3recon to main (head b5ae0f83): f3recon 13/13. Earlier on the port branch: tw4recon 38, tw4usage 26, tw4sender 18, tw4rv 28 all pass. docker ps = 0 after each.
PRs: #677 (draft, docs only: ISO_QA_MARKER requirement and harness-currency note); #668 (draft, head b5ae0f83, CI pending). Recurring fee lifecycle suites: out of scope (release hold). Row 0 status: engineering readiness complete pending CI on #668/#677.

## A.3 Isolated QA on current main (2026-11-22, main 882df3eb, scenario numeric, ISO_QA_MARKER=1)
Full matrix: 29/41 suites pass. TW-4F suites: tw4recon 38/38, tw4usage 26/26, tw4sender 18/18, tw4rv 28/28, tw4inbound 29/29 (run separately), f3recon 13/13 (F3-09 fixed), feeres 46/46, tw4monthly 28/28, tw4recurring 30/30, tw4recexec 20/20, tw4f3a 16/16, tw4f3b0 18/18, tw4f3bpay 18/18, tw4f3bui 7/7, tw4fi 25/25, tw4fj1 11/11, tw4r1 11/11, j2owner 12/12, j3owner 11/11, r2ci1 10/10, r2ci2 15/15, inboundFreeze 3/3, aal2 4/4, canary 5/5. Unit suites (src/lib/sms, api/sms, lib/notifications): 2417 pass, 20 skipped.
Not green and why: r2a rollback suite failed 2 (layers from other workstreams had no rollback probe): fixed test-only in PR #772 (head 89fb48d7, CI green, independently reviewed; 12 layer probes, claim-chain probes verified statically), r2a 29 pass / 1 skip after the fix. r2b skips all 53 (known: refuses the real recurring-fee lifecycle chain). Realtokens suites skip (need an auth profile). tw4a, tw4f1b, tw4payhardening: known/explained. Not TW-4F: staffApi (17 fail), staffApiSlice2 (1), appointmentsClientsEmbed (1) fail on the numeric scenario; reported to APPS, outside this domain.
Coverage map: subaccount isolation = tw4rv/tw4sender (+ r2a); prepaid accounting and ledger = tw4usage, tw4f3b0/bpay, tw4recon; inbound/outbound segment charging = tw4usage, tw4inbound (+ unit segments.ts); low-balance fail closed = tw4usage, tw4fi; STOP/START/HELP = unit tests in lib/sms compliance and api/sms/twilio/inbound plus inboundFreeze; webhooks and retries = unit tests, tw4recon, f3recon; audit trails = aal2, price audit (verified on PROD for the six publications).

## A.4 State since signing (PROD, read-only)
Six prices published 2026-11-21 20:35-20:37Z; verifier ok; monitor clean (one expected price_changed finding at 20:45Z). TW4F-Pricing-Check task runs every 15 minutes. PROD has the TW-4F chain through the reconciler gate; PROD lacks sms_pending_opt_outs (#668 SQL not applied).

## A.5 Rollback by step
- Row 4 (#668): rollback/20270215100000_twilio_pending_opt_outs_rollback.sql, then unset SMS_PENDING_OPT_OUT_REQUIRED; app rollback = previous live deployment. Order on rollback: flag off, app, SQL.
- Prices: published rows are permanent audit evidence; a bad price is corrected by a new dual-control proposal (cooling-off + hardware key), or by freezing price publication; engineering never edits rows.
- Rows 7-11 (provider objects): reversal is through the provider console and the TW-4F cancel/disposition paths, owner-gated; no automatic delete.
- Rows 12-13 (flags, schedulers, activation): turn flags/schedulers off in reverse order; sending stops at the activation switch; STOP handling stays on.
Exact outstanding OWNER gates: (1) #668 merge approval, PROD SQL + flag, staged build, promotion (Apps holds the CLI); (2) CODEOWNERS approval of test PR #772 (separate from #668; docs PR #773 carries this record); (3) fixture capture at about $1.30 (cap $5); (4) pilot access/runner window/daily checker names; (5) G-SUB subaccount; (6) G1/G1b/G2 attestations and submission; (7) brand fee; (8) number purchase; (9) campaign fee + vetting; (10) flags/schedulers; (11) activation, funded test credit and first test SMS. None is authorized yet.
