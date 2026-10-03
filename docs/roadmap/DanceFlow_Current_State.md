# DanceFlow Current State

Short, operational snapshot. The authoritative roadmap is [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md). Update this file whenever main, the PROD deployment, or the active slice changes.

**Last updated:** 2026-10-03 (roadmap v1.1, BR-4 closeout)

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `ba3d2256db513f60eb4e6adca6e4b4f0fc435c83` (docs-only roadmap merge; application code identical to `2266f5f`) |
| **CURRENT PROD DEPLOYMENT** | `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21` (source `2266f5fdd0ac51394a4b5915c2408a08f4532cce`) |
| **SUPABASE DEV** | `epdrtzcydvnoidwrepqz` |
| **SUPABASE PROD** | `hvsujyfbftfffxpfmlpb` |
| **PRIMARY REPO LINK** | DEV |
| **NON-TWILIO LAUNCH STATUS** | READY / CLOSED; no new launch blocker from BR-4 (full validation green) |
| **PENDING PROD MIGRATIONS** | None (BR-4 has no migration) |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **ACTIVE ENGINEERING LAUNCH BLOCKERS** | None identified outside the Twilio operational dependency |

## BR-4 candidate (not yet merged)

| | |
|---|---|
| **Candidate branch** | `br-4-public-website-launch-messaging` |
| **Branch base** | `ba3d2256db513f60eb4e6adca6e4b4f0fc435c83` (current main) |
| **Slice commits** | BR-4A `0f0ee77`, BR-4B `69812d5`, BR-4C `461741e`, BR-4D closeout = the PR head commit |
| **Exact candidate head** | The head commit of the BR-4 pull request (a commit cannot contain its own SHA; read it from the PR) |
| **Status** | BR-4: COMPLETE ON CANDIDATE BRANCH / AWAITING MERGE |
| **Deployment** | Required only after the BR-4 PR is merged (BR-4 changes runtime public-site code). Not deployed. |

The feature branch is not main. Do not treat BR-4 as live until it is merged and promoted.

## Twilio status

External dependency awaiting Sachin / Twilio response before ConfiDance resource configuration and submission actions. Engineering for the per-studio A2P model is live (SMS-A2P-1 through 3C). No `studio_sms_registrations` row exists in PROD, the global SMS status has not been changed, and every studio is fail-closed until individually approved. Twilio does not block unrelated roadmap work. No new Twilio information is recorded here.

## Current roadmap position

**ACTIVE PHASE:** Phase 3 — Branding Relaunch

**BR-4 (Public Website & Launch Messaging):** COMPLETE ON CANDIDATE BRANCH / AWAITING MERGE

**NEXT ROADMAP SLICE AFTER MERGE:** BR-5 — Event / Print Collateral Strategy and Production (including Facebook / social launch content). BR-6 (promotional media) and BR-7 (final branding / public-launch QA) follow. Phase 3 is not complete until they are done.

### Public-claim restrictions (still in force for BR-5 onward)
- No meaningful Featured Events promotion claim; avoid "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory; no compatibility or matching claims, no "free forever" promise, no Partner Match SEO launch until moderation and a web request path exist.
- No Competition OS claims (judging, scoring, results, awards, live heat management).
- No SOC 2 certification or compliance claim.
- No unrestricted ARIA autonomy claim, and no claims about unreleased automation.

## Current external dependencies

- Twilio / Sachin
- Migration Center real-studio pilot validation
- Eventual pricing cutover business/configuration decision

## Major product decisions still open

- Featured Events governing/business model
- Partner Match age, moderation, and future-monetization details
- Group-class depleted-credit behavior
- Floor-rental authoritative pricing model
- Final mobile app boundary (Phase 18)
- Landmark 1A canonical closeout scope (invitation flow, seat UI, audit viewer)
- Whether to pull Partner Match moderation and the web request path forward
- Competition scoring system(s) and where judging runs
- Plan placement of SMS, payroll, marketplace and ARIA features
- BR collateral asset count and video cut list (BR-5 / BR-6)
- Demo-request / interest-capture storage (deferred; needs a storage decision)

## NEXT GATE

Human review and merge of the BR-4 pull request, then deploy the merged build, then begin BR-5.
