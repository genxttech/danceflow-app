# DanceFlow Current State

Short, operational snapshot. The authoritative roadmap is [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md). Update this file whenever main, the PROD deployment, or the active slice changes.

**Last updated:** 2026-10-03 (roadmap v1.3: BR-5 merged, BR-6 parked, ENT-1 candidate)

> **Roadmap-affecting phase closeout requires canonical roadmap/current-state update before the phase is considered closed.**

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `1310e3a107404c7c81fd031696dcf9cf120c76d6` (BR-5 squash merge, PR #137; static collateral only) |
| **CURRENT PROD DEPLOYMENT** | `dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K` (source `f189d15cbef301a24e3410b79f20d3bcef7135d9`; BR-4 live on `www.idanceflow.com` and `idanceflow.com`). Main is one static-collateral commit ahead (BR-5, no runtime change); no deployment was needed |
| **SUPABASE DEV** | `epdrtzcydvnoidwrepqz` |
| **SUPABASE PROD** | `hvsujyfbftfffxpfmlpb` |
| **PRIMARY REPO LINK** | DEV |
| **NON-TWILIO LAUNCH STATUS** | READY / CLOSED; no new launch blocker from BR-4, BR-5 or ENT-1 |
| **PENDING PROD MIGRATIONS** | None on main. **ENT-1 candidate adds `20261013090000_ent1_usage_allowance_reservations.sql` (applied and verified in DEV only); PROD must apply it, behind an explicit owner gate, before the ENT-1 application deployment (the new send path fails closed: without the migration every campaign send is blocked)** |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **ACTIVE ENGINEERING LAUNCH BLOCKERS** | None identified outside the Twilio operational dependency |
| **KNOWN HYGIENE DEBT** | pre-existing lint errors in some public pages (not introduced by BR-4, BR-5 or ENT-1); they keep the changed-file lint step in CI red when those files are touched |

BR-4 (Public Website & Launch Messaging) is merged and live. Public smoke of the live domains and the live attribution cookie passed; authenticated production smoke was intentionally omitted. BR-5 (Event / Print Collateral) is merged as PR #137.

## BR-6 (active, parked)

| | |
|---|---|
| **Branch** | `br-6-promotional-media` (local; not pushed, no PR, not merged) |
| **Head** | `1f19305` |
| **Status** | ACTIVE / PARKED. The Rough Cut 3 visual system and motion engine are built; the owner locked a first-person master narrated by ARIA herself (`docs/brand/media/VOICEOVER_V4.md`). The next full master render waits for the professional ARIA voice recording (`media/_work/voice/aria-pro/`) |
| **Not done** | No music sourced or licensed; no voice talent engaged by engineering; no short cuts; BR-7 not started; BR-6 is not complete |

## ENT-1 candidate (not yet merged)

| | |
|---|---|
| **Candidate branch** | `ent-1-email-campaign-allowance` |
| **Branch base** | `1310e3a107404c7c81fd031696dcf9cf120c76d6` (current main) |
| **Exact candidate head** | The head commit of the ENT-1 branch or pull request (a commit cannot contain its own SHA) |
| **Status** | ENT-1: COMPLETE ON CANDIDATE BRANCH / AWAITING FOCUSED REVIEW. Monthly email-campaign recipient allowance enforced for studio and organizer sends (atomic reserve, send, finalize successes only, release the rest) |
| **Migration** | `20261013090000_ent1_usage_allowance_reservations.sql`: applied and verified in DEV; **PROD migration required** (not applied) |
| **Deployment** | Required after the PROD migration (application change) |
| **Phase 4** | Remains PARTIAL: SMS gating, payroll/marketplace/ARIA billing keys and the upgrade-prompt component are not done |

The feature branches are not main. Do not treat BR-6 or ENT-1 as merged until their pull requests are merged.

## Twilio status

External dependency awaiting Sachin / Twilio response before ConfiDance resource configuration and submission actions. Engineering for the per-studio A2P model is live (SMS-A2P-1 through 3C). No `studio_sms_registrations` row exists in PROD, the global SMS status has not been changed, and every studio is fail-closed until individually approved. Twilio does not block unrelated roadmap work. No new Twilio information is recorded here.

## Current roadmap position

**ACTIVE PHASE:** Phase 3 — Branding Relaunch (PARTIAL)

**BR-4 (Public Website & Launch Messaging):** COMPLETE AND LIVE

**BR-5 (Event / Print Collateral):** COMPLETE AND MERGED (PR #137)

**BR-6 (Promotional Media):** ACTIVE / PARKED awaiting the professional ARIA voice recording. BR-7 (final branding / public-launch QA) follows BR-6 and has not started. Phase 3 is not complete until both are done.

**PRODUCT WORK IN PARALLEL (Phase 4):** ENT-1 (email-campaign recipient allowance) is complete on its candidate branch; the next Phase 4 items need product decisions (plan placement for SMS, payroll, marketplace and ARIA).

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

Focused review of ENT-1, then (owner gate) the PROD migration `20261013090000` and the ENT-1 deployment. BR-6 resumes when the professional ARIA recording arrives.
