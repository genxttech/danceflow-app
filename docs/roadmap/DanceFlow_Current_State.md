# DanceFlow Current State

Short, operational snapshot. The authoritative roadmap is [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md). Update this file whenever main, the PROD deployment, or the active slice changes.

**Last updated:** 2026-10-02 (roadmap v1.0)

## Release state

| | |
|---|---|
| **CURRENT MAIN** | `2266f5fdd0ac51394a4b5915c2408a08f4532cce` |
| **CURRENT PROD DEPLOYMENT** | `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21` |
| **SUPABASE DEV** | `epdrtzcydvnoidwrepqz` |
| **SUPABASE PROD** | `hvsujyfbftfffxpfmlpb` |
| **PRIMARY REPO LINK** | DEV |
| **NON-TWILIO LAUNCH STATUS** | READY / CLOSED |
| **PENDING PROD MIGRATIONS** | None known from the current reconciled state |
| **PACKAGE REFUND HOLD** | Released / `false` |
| **ACTIVE ENGINEERING LAUNCH BLOCKERS** | None identified outside the Twilio operational dependency |

## Twilio status

External dependency awaiting Sachin / Twilio response before ConfiDance resource configuration and submission actions. Engineering for the per-studio A2P model is live (SMS-A2P-1 through 3C). No `studio_sms_registrations` row exists in PROD, the global SMS status has not been changed, and every studio is fail-closed until individually approved. Twilio does not block unrelated roadmap work.

## Current roadmap position

**CURRENT ROADMAP PHASE:** Phase 3 — Branding Relaunch

**NEXT SLICE:** BR-4 — Public Website & Launch Messaging

### BR-4 special restrictions
- No meaningful Featured Events promotion claim; avoid public "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory.
- No algorithmic matching, compatibility scoring, guaranteed or fast connection claims, and no "free forever" promise.
- No Partner Match SEO or public launch push until the moderation queue and a working web request path are ready.
- No claims about unreleased automation.

BR-4 scope is modified by Featured Events and Partner Match maturity, but it is not blocked by either.

## Current external dependencies

- Twilio / Sachin (per-studio A2P review; ConfiDance resources and registration)
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

## NEXT GATE

Review and commit the roadmap documents, then begin BR-4.
