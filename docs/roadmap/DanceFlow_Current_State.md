# DanceFlow Current State

Short, operational snapshot. The authoritative roadmap is [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md). Update this file whenever main, the PROD deployment, or the active slice changes.

**Last updated:** 2026-10-03 (roadmap v1.2, BR-5 closeout)

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `f189d15cbef301a24e3410b79f20d3bcef7135d9` (BR-4 squash merge, PR #136) |
| **CURRENT PROD DEPLOYMENT** | `dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K` (source `f189d15cbef301a24e3410b79f20d3bcef7135d9`; BR-4 live on `www.idanceflow.com` and `idanceflow.com`; prior production `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21`) |
| **SUPABASE DEV** | `epdrtzcydvnoidwrepqz` |
| **SUPABASE PROD** | `hvsujyfbftfffxpfmlpb` |
| **PRIMARY REPO LINK** | DEV |
| **NON-TWILIO LAUNCH STATUS** | READY / CLOSED; no new launch blocker from BR-4 or BR-5 |
| **PENDING PROD MIGRATIONS** | None (BR-4 and BR-5 have no migration) |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **ACTIVE ENGINEERING LAUNCH BLOCKERS** | None identified outside the Twilio operational dependency |
| **KNOWN HYGIENE DEBT** | 8 pre-existing lint errors in 4 public pages (not introduced by BR-4 or BR-5); they keep the changed-file lint step in CI red when those files are touched |

BR-4 (Public Website & Launch Messaging) is merged and live. Public smoke of the live domains and the live attribution cookie passed; authenticated production smoke was intentionally omitted.

## BR-5 candidate (not yet merged)

| | |
|---|---|
| **Candidate branch** | `br-5-event-print-collateral` |
| **Branch base** | `f189d15cbef301a24e3410b79f20d3bcef7135d9` (current main) |
| **Exact candidate head** | The head commit of the BR-5 pull request (a commit cannot contain its own SHA; read it from the PR or the branch) |
| **Status** | BR-5: COMPLETE ON CANDIDATE BRANCH / AWAITING MERGE |
| **Deployment** | Not needed: BR-5 is static collateral (docs, templates, exports, one builder script, one test) and does not change the application runtime |
| **Banner** | Vendor-neutral master only. Final vendor fit, bleed and bottom-feed adjustment are required before a print order (vendor not chosen) |
| **Print color** | RGB PDFs with embedded fonts; no CMYK or PDF/X conversion (done by the printer) |

The feature branch is not main. Do not treat BR-5 as merged until the pull request is merged.

## Twilio status

External dependency awaiting Sachin / Twilio response before ConfiDance resource configuration and submission actions. Engineering for the per-studio A2P model is live (SMS-A2P-1 through 3C). No `studio_sms_registrations` row exists in PROD, the global SMS status has not been changed, and every studio is fail-closed until individually approved. Twilio does not block unrelated roadmap work. No new Twilio information is recorded here.

## Current roadmap position

**ACTIVE PHASE:** Phase 3 — Branding Relaunch (PARTIAL)

**BR-4 (Public Website & Launch Messaging):** COMPLETE AND LIVE

**BR-5 (Event / Print Collateral):** COMPLETE ON CANDIDATE BRANCH / AWAITING MERGE

**NEXT ROADMAP SLICE AFTER THE BR-5 MERGE:** BR-6 — Promotional Media (not started). BR-7 (final branding / public-launch QA) follows. Phase 3 is not complete until both are done.

### Public-claim restrictions (still in force for BR-6 onward)
- No meaningful Featured Events promotion claim; avoid "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory; no compatibility or matching claims, no "free forever" promise, no Partner Match SEO launch until moderation and a web request path exist.
- No Competition OS claims (judging, scoring, results, awards, live heat management).
- No SOC 2 certification or compliance claim.
- No unrestricted ARIA autonomy claim, and no claims about unreleased automation.

## Current external dependencies

- Twilio / Sachin
- Migration Center real-studio pilot validation
- Eventual pricing cutover business/configuration decision
- Banner vendor / stand selection (BR-5 follow-up, needed only before a banner print order)

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
- Video cut list (BR-6)
- Demo-request / interest-capture storage (deferred; needs a storage decision)
- Per-event print attribution (static QR codes cannot distinguish events; needs a per-event print run or a signup survey question)

## NEXT GATE

Human review of the BR-5 collateral and merge of the BR-5 pull request, then BR-6 — Promotional Media.
