# DanceFlow Master Roadmap

| | |
|---|---|
| **Roadmap version** | v2.23 (2026-10-13; documentation-only Knowledgebase / Help Center addition on top of v2.22; prepared for owner merge review) |
| **Last reconciled against main** | `24a37a15bb0daf6f2b2de48745e84bd862ad29d1` (PAY-WH-1B, PR #216). Live application `dpl_5BjsJaSPqn1qA3D4fCDijZbRNqqK` (promoted 2026-10-13 11:58Z; application rollback target `dpl_9GRhgfVhT6eDHyQooiqjXnEvpbj3` = PAY-WH-1, app-only; PAY-WH-1B has no SQL). PROD schema includes PAY-WH-1 migrations M1–M5 (`20261116090000`–`20261116094000`, applied 2026-10-13 10:30–10:31Z). Phase 10 slices 10A–10D.1 and 10C.1–10C.5, CI-A, PAY-WH-1/1A and PAY-WH-1B are released (see Phase 10 and the [Commerce Integrity lane](#commerce-integrity-lane)). Phases 5–9 remain COMPLETE / CLOSED |
| **Current non-Twilio launch state** | Core platform released. **Public Competition registration is HELD** (flag OFF) on the open Commerce Integrity items CI-B and CI-D plus the 10C.1 launch gates; see [Release holds and gates](#release-holds-and-gates-v222). Marketing M-0 (campaign compliance remediation) is the top-priority engineering item |
| **Current external dependencies** | Twilio technical confirmation on ticket #29647095 (TW-4 Q1–Q5) gates TW-4 slices that write to Twilio. Also: Migration Center real-studio pilots; the pricing cutover business decision; banner vendor/stand (BR-5 follow-up, only before a print order); the professional ARIA voice recording (BR-6). None blocks unrelated phases |
| **Current recommended next work** | **Near-term priority order — PROVISIONALLY ACCEPTED by the owner (2026-10-13 review of PR #217):** (1) Marketing M-0 compliance remediation, (2) CI-B atomic event check-in, (3) CI-D ticket-attributed refund integrity, (4) Competition OS remaining v1 milestones (10E → 10F), (5) TW-4 automated SMS onboarding, (6) Marketing Messages enhancements, followed by the UX/mobile work. See [Near-term priority order (v2.22)](#near-term-priority-order-v222). It does not renumber, reorder or remove the 26 canonical phases or their dependencies |

> **Explicit note:** BR-4 was shaped by Featured Events and Partner Match maturity and was **not blocked** by either; their public-claim restrictions remain in force for BR-5 onward. See [Featured Events](#strategic-module-featured-events), [Partner Match](#strategic-module-partner-match) and Phase 3 §Public-claim restrictions.

---

## CANONICAL ROADMAP RULE

**This document is the authoritative DanceFlow product roadmap.**

- Do not reconstruct roadmap state from chat history, old planning documents, release notes, or implementation inference when this document is available.
- New roadmap work must be added here deliberately.
- Completed roadmap items are marked complete rather than deleted.
- Proposed ideas remain explicitly labeled **PROPOSED** until approved.
- Unresolved product decisions must remain visible until resolved.
- External dependencies do not block unrelated roadmap work unless explicitly documented as a dependency.

Companion file: [`DanceFlow_Current_State.md`](DanceFlow_Current_State.md) (short, operational snapshot; update it whenever main, the PROD deployment, or the active slice changes).

## ROADMAP MAINTENANCE RULE

**No roadmap-affecting feature, slice, phase, architectural decision or major product decision is considered fully closed until this canonical roadmap has been updated.**

- Every roadmap-affecting phase closeout must update, as applicable, both [`DanceFlow_Master_Roadmap.md`](DanceFlow_Master_Roadmap.md) and [`DanceFlow_Current_State.md`](DanceFlow_Current_State.md), in the same PR or in an explicit closeout PR.
- **The Master Roadmap preserves:** product intent, completed scope, remaining scope, locked decisions, proposed items, unresolved decisions, dependencies, sequencing, and meaningful deferrals.
- **Current State preserves only the operational snapshot:** current main, current PROD deployment, active phase, next slice, external dependencies, pending migrations, release holds, and current blockers/gates.
- Completed roadmap items are marked **COMPLETE** rather than deleted.
- Superseded decisions remain recorded as superseded when losing that history would make later reasoning ambiguous.
- Proposed items must not silently become approved requirements.
- Newly discovered product requirements are added deliberately, rather than living only in chat or session history.
- If implementation changes roadmap sequencing or dependencies, update the roadmap before closing that work.
- Chat history, release notes and old planning documents may provide evidence, but they do not override the canonical roadmap when it is available.
- **(v2.23) Knowledgebase maintenance is part of the Definition of Done.** A feature, slice or phase that adds, changes, renames or retires user-facing behavior — new workflows, navigation or UI terminology, permissions or entitlements, automation capabilities, payment or registration processes, feature retirement or replacement — is not closed until its Knowledgebase impact is assessed and recorded in the closeout as one of: *none*; *update `<slugs>`*; *new article*; *retire `<slug>`* (with a redirect). The affected articles are then updated, or a tracked KB task is created, before closure. Documentation about unreleased, held or flag-off functionality must never be published as if it were available in production. Until the Phase 17 KB-5 tooling exists, the assessment is a written closeout line; KB-5 adds the status workflow and automated checks.


### Evidence confidence

Statuses below come from a read-only reconciliation of main `2266f5f` (source, migrations, tests, release history), updated at each closeout. The v2.22 reconciliation (2026-10-13) re-checked git history `67e735ca..24a37a15`, release records and targeted code audits for Phases 2, 10, 13, 18–20 and the commerce lane; it did not re-audit every phase. Evidence is largely "the routes, tables, migrations and tests exist"; it does not prove each feature behaves correctly end to end. Items marked **(unverified)** were not confirmed beyond existence or a grep. Do not read "implemented" as "QA'd" unless the item says so.

---

## Status vocabulary

| Status | Meaning |
|---|---|
| **COMPLETE** | Canonical objective met; nothing required remains. |
| **SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS** | Core delivered; a bounded closeout list remains. |
| **PARTIAL — MATERIAL WORK REMAINS** | Meaningful capability exists, but material canonical deliverables are missing. |
| **NOT STARTED** | No meaningful implementation of the canonical objective (a baseline elsewhere may exist; it is noted). |
| **EXTERNAL DEPENDENCY** | Engineering is complete or independent; completion waits on an outside party or real-world activity. |
| **ACTIVE — FINAL COMPLIANCE / PILOT SUBMISSION** | Engineering is complete; the remaining work is owned by DanceFlow (compliance materials, submission, verification) and runs in parallel with engineering phases. Not a blocker. |
| **SUPERSEDED / REPLACED** | Replaced by later architecture or decisions; the replacement is named. |

**Provenance labels (v2.22).** Items added or restated in v2.22 carry one of these labels so that unsupported proposals cannot be mistaken for commitments:

| Label | Meaning |
|---|---|
| **OWNER-APPROVED** | An owner-typed instruction or approval exists (date cited). It is a commitment. |
| **OWNER-PROVISIONAL** | The owner accepted it provisionally (e.g. the v2.22 priority order). |
| **ENGINEERING FINDING** | A verified fact about the code or production (a defect, gap or drift) recorded so it is not lost. Fixing it still needs authorization; it is not a product commitment. |
| **AGENT-RECORDED PROPOSAL** | A follow-up or idea that exists only in engineering notes, release reports or task chips. **Not owner-approved**; it needs owner confirmation before it becomes a commitment, and may be dropped. |
| **ENGINEERING SLICING** | How engineering proposes to split an approved commitment into slices (e.g. M-0…M-7, 20-R/20-D, TW-4 4A–4G). The commitment is approved; the slicing is a proposal. |

---

## Governing principles

- Build capability → establish security and permissions → stabilize web workflow → design mobile around the stabilized workflow.
- Twilio/A2P (Phase 2) is a **parallel compliance/pilot lane** owned by DanceFlow (final compliance and submission work, then production verification); it is not a global roadmap blocker and does not gate Phase 10.
- The Branding relaunch precedes later public launch materials, mobile store materials and broad public promotion.
- Do not redesign Business or Student mobile apps around workflows that are still structurally changing.
- The Mobile App Architecture & Boundary Audit must occur before locking final app count, app names, navigation ownership or store strategy.
- Team & Permissions must become sufficiently data-driven before DanceFlow Business navigation is finalized.
- Final web workflows are the canonical UX model for mobile.
- Every major feature area eventually closes with **Security Review** and **Branding / Polish**.
- **Public Discovery operational notifications (platform rule):** externally initiated Public Discovery purchases, registrations, enrollments and bookings generate a studio-side operational notification; see Phase 6 for the full rule.
- **UX/UI quality is part of feature completion.** Relevant usability improvements, convenience workflows, interaction clarity, sensible defaults, reduced-click flows and visual polish should normally be completed within the phase that introduces the workflow; deadline discipline does not mean deferring useful UX merely because it is non-blocking. Avoid schedule drift from speculative architecture, unlikely edge cases, unrelated refactoring, repeated broad audits, premature future-proofing and work that belongs to later phases. If a worthwhile UX improvement becomes large enough to materially threaten the launch deadline, decide explicitly whether to defer it rather than deferring it silently.
- Prefer: simple flow; fewer cards; one obvious next action; progressive disclosure; right-side contextual detail panels where appropriate; obvious expandable affordances; responsive behavior; consistent empty/error/loading states.

---

## Canonical phase order (do not silently reorder)

| # | Phase | Status |
|---|---|---|
| 1 | Landmark 1A | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 2 | Twilio A2P / SMS | ACTIVE — TW-4 AUTOMATED ISV ONBOARDING (self-service direction approved; implementation not started; Twilio technical verification pending) |
| 3 | Branding Relaunch / Public Branding & Launch Readiness | PARTIAL — MATERIAL WORK REMAINS |
| 4 | Remaining entitlement foundation | PARTIAL — MATERIAL WORK REMAINS |
| 5 | Group Class canonical foundation | COMPLETE / CLOSED (items carried forward are listed in Phase 5) |
| 6 | GC-3.4 — Public discovery and account linking | COMPLETE / CLOSED (GC-3.4A, GC-3.4B and GC-3.4C released) |
| 7 | GC-3.5 — Direct-payment Group Class enrollment | COMPLETE / CLOSED (GC-3.5-1, GC-3.5-2, REFUND-RECON-1, REFUND-RECON-2 and GC-3.5-3 released) |
| 8 | Documents Center completion | COMPLETE / CLOSED (8A, 8B, 8C and 8D all released) |
| 9 | Payroll Prep v1 | COMPLETE / CLOSED (9A, 9B, 9C, 9D and 9E all released) |
| 10 | Organizer + Competition OS | PARTIAL — MATERIAL WORK REMAINS — ACTIVE (10A–10D.1 and 10C.1–10C.5 released; 10E next, gated on owner walkthrough; public registration held) |
| 11 | Messaging / Notification platform completion | PARTIAL — MATERIAL WORK REMAINS |
| 12 | Team & Permissions expansion | PARTIAL — MATERIAL WORK REMAINS |
| 13 | Marketing / Campaigns completion | PARTIAL — MATERIAL WORK REMAINS (M-0 compliance remediation is priority 1) |
| 14 | Marketplace + digital products + Mux | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 15 | ARIA Operations completion | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 16 | Migration / Onboarding completion | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 17 | Web application design-gap completion | NOT STARTED |
| 18 | Mobile App Architecture & Boundary Audit | NOT STARTED (decides whether a separate Business app exists; not pre-approved) |
| 19 | DanceFlow Business app | NOT STARTED (existence and architecture NOT approved; depends on Phase 18) |
| 20 | Student App redesign + Google Play readiness | NOT STARTED as a redesign; the existing Expo Student App is a substantial baseline that is not store-released. Split in v2.22 into 20-R (readiness and mobile QA of the existing app) and 20-D (redesign and Google Play release) |
| 21 | Public website / discovery expansion | NOT STARTED |
| 22 | Regular v1 pricing cutover | NOT STARTED |
| 23 | Platform Admin / DanceFlow HQ expansion | PARTIAL — MATERIAL WORK REMAINS |
| 24 | Data Loss Prevention | NOT STARTED |
| 25 | SOC 2 Type II | FORMAL TYPE II PROGRAM NOT STARTED (start date subject to readiness planning); SOC 2 readiness is an ongoing governance activity |
| 26 | Later integrations / enterprise features | NOT STARTED |

**Strategic modules that span phases** (see dedicated sections): [Featured Events](#strategic-module-featured-events) (Phases 10, 13, 19, 20, 21, 22, 23 + analytics foundation), [Partner Match](#strategic-module-partner-match) (Phases 17, 18, 20, 21, 23 + analytics foundation) and, added in v2.22, [DanceFlow Communities](#strategic-module-danceflow-communities) (Phases 11, 12, 18, 20, 21, 23).

**Work completed outside the numbered sequence** (inserted ahead of it, all released): the launch-security and payment-integrity tracks. See [Completed launch work register](#completed-launch-work-register).

**Parallel lanes outside the numbered sequence:** the Phase 2 Twilio lane (TW-1…TW-4) and, added in v2.22, the [Commerce Integrity lane](#commerce-integrity-lane) (CI-A, PAY-WH-1/1A/1B, CI-B, CI-D and their follow-ups). Lanes are not phases; they do not renumber the canonical order.

**Maintained backlog:** commitments that are not yet scheduled into a slice are listed in the [Preserved commitments register (v2.22)](#preserved-commitments-register-v222), the [Deferred / post-launch register](#deferred--post-launch-register) and each phase's REMAINING DELIVERABLES. Nothing is dropped by omission from the priority order below.

---

## Near-term priority order (v2.22)

**Status: PROVISIONALLY ACCEPTED by the owner (2026-10-13, owner review of PR #217).** Items 1–6 are accepted in the order shown, "followed by the UX/mobile work" (items 7–8). Item 9 (Communities V1) remains listed after the UX/mobile work and starts with product definition. "Provisional" means the order guides slice selection now and the owner may revise it at any time (recorded under the normal maintenance rule). It does **not** renumber, reorder or delete the 26 canonical phases or any existing dependency, and it does not authorize any implementation, SQL, deployment or external-service change. Each item still needs its own slice authorization, QA matrix and release gates.

| Priority | Work | Canonical home | Kind | Depends on | Release gate(s) |
|---|---|---|---|---|---|
| 1 | **Marketing M-0 — campaign compliance remediation** (send-time unsubscribe suppression, fail-closed suppression lookup, one-click `List-Unsubscribe`, sender-separation verification) | Phase 13 | Engineering (small; likely app-only) | None | Normal app release; developer-owned QA matrix |
| 2 | **CI-B — atomic event check-in** (compare-and-set check-in; no duplicate admission) | Commerce Integrity lane | Engineering (app-only expected; SQL only if a DB guard is chosen) | None | Normal release; clears one public-Competition-registration hold |
| 3 | **CI-D — ticket-attributed refund integrity** (per-registration refund attribution, order refund flow, webhook attribution) | Commerce Integrity lane | Engineering (SQL expected; payment-integrity / Opus review) | PAY-WH-1 (released) | PROD SQL + promotion, each separately authorized; clears the other hold |
| 4 | **Competition OS remaining v1 milestones**: 10E Officials + Immutable Ballots → 10F Scoring + Results + Publication (10G polish optional) | Phase 10 | Engineering (Opus; own Security Review) | Owner Schedule & Heats walkthrough (10E gate); public registration enablement additionally needs CI-B, CI-D and the 10C.1 gates | Studio v1 = 10A–10F |
| 5 | **TW-4 automated SMS onboarding** (4A–4G) | Phase 2 | Engineering + Twilio verification | Twilio answers Q1–Q5 for slices that write to Twilio (4A can start earlier); decision #8 amounts only for general availability | ConfiDance pilot through the real in-app flow (4F); manual platform release for the pilot only (D5) |
| 6 | **Marketing Messages enhancements** (M-1 studio draft editing + ARIA apply; M-2 shared composer / organizer parity; M-3 block editor; M-4 images; M-5 event-link picker; M-6 interactive blocks; M-7 segments / analytics / consent model / scheduled send) | Phase 13 | Engineering | M-0; Phase 11 provider webhooks for analytics | Per slice |
| 7 | **Web / Business UX audit and redesign** (existing web admin UX improvements, then the Phase 18 architecture decision; a separate Business app only if Phase 18 approves it) | Phases 17 → 18 (→ 19 only if approved) | Design + engineering | Phase 12 permission catalog for permission-driven navigation; material completion of upstream workflow phases | Phase 18 decision record before any Business app build |
| 8 | **Student App readiness and redesign** (20-R readiness + mobile QA of the existing Expo app first; 20-D redesign + Google Play release after Phase 18) | Phase 20 | Engineering + store operations | 20-R: none beyond test infrastructure; 20-D: Phase 18 | Store submission is an explicit owner-authorized gate |
| 9 | **DanceFlow Communities V1** | Strategic module (new) | Product definition first, then engineering | Governance/moderation model, Phase 12 permissions, Phase 23 moderation tooling, Student App integration (Phase 20) | Product definition approved before any build |

**Parallel workstreams (can run concurrently without conflicting files or gates):**
- **Lane A — Compliance & commerce integrity:** M-0 → CI-B → CI-D (serial; small, high-risk-reduction slices).
- **Lane B — Competition OS:** 10E can be prepared (design, Opus review planning) while Lane A runs; it starts building once the owner walkthrough clears. 10E/10F do not depend on CI-B/CI-D; only *public registration enablement* does.
- **Lane C — Twilio TW-4:** 4A (schema, owner wizard, legal-page templates, EIN handling) can proceed once implementation is authorized; 4B–4D wait on Twilio answers. TW-4 shares no files with the commerce lane (4G billing wiring comes last).
- **Lane D — Mobile readiness (20-R):** test harness (Expo UI automation), dependency pinning, privacy/data-safety drafts and store-release status verification do not depend on Phase 18 and do not redesign the app.
- **Owner-only tracks (not engineering):** Schedule & Heats walkthrough (10E gate); Twilio correspondence; decision #8 amounts; BR-6 professional voice recording; Communities product definition.

**Sequencing rules carried forward unchanged:** Phase 17 should not start a formal pass before upstream workflows are materially complete (it can absorb bounded UX fixes earlier); Phase 20-D must not leapfrog Phase 18; Phase 12 (data-driven permissions) precedes Business navigation and Phase 24 (DLP); public Competition OS claims stay restricted.

## Release holds and gates (v2.22)

| Hold / gate | Applies to | Cleared by | Status |
|---|---|---|---|
| **CI-B** duplicate / concurrent event check-in | Enabling public Competition registration (`NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED`) | CI-B released, or explicit owner waiver | OPEN |
| **CI-D** whole-payment refund allocation / no per-registration refund path | Enabling public Competition registration | CI-D released, or explicit owner waiver | OPEN (partly mitigated: PAY-WH-1A blocks the unsafe staff refund for order-backed registrations) |
| Early-bird overcharge (formerly blocker 1) | Public Competition registration | CI-A | CLOSED (released 2026-10-12); historical-impact query not yet run (needs PROD read authorization) |
| 10C.1 launch gates | Public Competition registration | Live Stripe Connect webhook subscriptions confirmed (`checkout.session.expired`, `checkout.session.async_payment_failed`); owner organizer walkthrough; verified "this is me" walkthrough; explicit acceptance of whole-order refunds (until CI-D) and buyer-signed waivers | OPEN |
| NDCA Multi-Dance registration hold (definition hold `multi_dance_results_not_operational`; database refusal `COMP10C_REGISTRATION_HOLD`) | Registration into Multi-Dance categories created by the 10C.5 wizard | Multi-Dance results becoming operational (10H scope) plus the holds above | OPEN |
| Owner Schedule & Heats walkthrough (10C.2/10D) | Starting 10E | Owner business acceptance | OPEN |
| Twilio Q1–Q5 confirmation | TW-4 slices that create Twilio resources (4B real adapter, 4C, 4D, 4F) | Twilio answers on #29647095 | OPEN |
| ACH / delayed payment methods | Enabling non-card methods on event cart and competition checkout | Real ACH end-to-end test and an explicit decision | Card-only by design (PAY-WH-1) |
| Marketing M-0 | None (compliance remediation of live behavior) | — | Priority 1 |

---

## Phase 1 — Landmark 1A

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS

**OBJECTIVE:** Establish the instructor capability, linkage, assignability and seat model with database-level enforcement.

**PRODUCT INTENT:** Instructors (including independent and hybrid users) are assignable to work only when their capability and seat state allow it; authority over seats and capabilities cannot be self-escalated.

**COMPLETED CAPABILITIES**
- Slices 1–9 exist as migrations with rollbacks and most with SQL tests: instructor capability schema; instructor linkage lifecycle; backfill remediation; assignability enforcement; capability activation bridge (5a); seat enforcement (6); capability revocation (7); seat authority (8); capability authority (9). Related: `platform_role_escalation_guard`, `entitlement_authority_hardening`. Race harnesses exist for slices 7/8/9.
- App wiring: `src/lib/instructors/{assignability,seatStatus}.ts`, `InstructorSeatNotice`, instructors pages (list, new, edit, revoke control), team owner-demotion guard, hybrid-instructor promotion.
- App tests for grant/reactivate, revoke, assignability, independent-instructor authority, owner demotion.

**REMAINING DELIVERABLES** (candidates; canonical scope unconfirmed — see decisions)
- Instructor invitation flow (none found under the instructors UI).
- Seat purchase/upgrade or seat-count management UI (only an informational seat notice exists).
- Viewer for `instructor_audit_events` (none found).

**LOCKED DECISIONS:** Database-level enforcement of seat/capability authority (slices 6–9) is the model.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Whether the invitation flow, seat purchase UI and audit viewer were canonical Landmark 1A deliverables or later work. The roadmap source for this is not in the repo; owner confirmation is required before closing the phase.

**DEPENDENCIES:** Phase 4 (entitlement/seat limits in billing), Phase 12 (permissions).

**WEB IMPLICATIONS:** Instructor management UX is part of the Phase 17 design-gap pass.

**MOBILE IMPLICATIONS:** Independent/hybrid instructors are an input to the Phase 18 audit.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Authority hardening is closed (slices 8–9, LAUNCH-SEC-2A). Do not reopen without concrete regression evidence.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260917030000` … `20260918090000`; `src/app/app/instructors/__tests__`, `src/lib/instructors/__tests__`.

---

## Phase 2 — Twilio A2P / SMS

**STATUS:** ACTIVE — TW-4 AUTOMATED ISV ONBOARDING. The per-studio sending, consent and registration-metadata engineering (SMS-A2P-1…3C, TW-1…TW-3) is released. The v2.21 "final compliance / pilot submission" framing (a manually provisioned ConfiDance campaign) is **SUPERSEDED** (v2.22): the owner approved self-service, API-driven ISV onboarding as the product direction, and the ConfiDance pilot will use that real automated flow. TW-4 implementation has not started and is not yet authorized. Runs in parallel with the engineering phases and does not block Phase 10.

**OBJECTIVE (v2.22):** Compliant SMS under Twilio's ISV model with **automated, self-service studio onboarding**: a studio owner completes one guided DanceFlow form; DanceFlow provisions the studio's Trust Hub profiles, brand, Messaging Service, campaign and number through Twilio's APIs (one Twilio subaccount per studio, subject to technical verification), tracks status automatically and activates only when every compliance invariant holds. **DanceFlow must not require routine founder-operated Twilio Console onboarding for studios.** DanceFlow (GenX TotalTech LLC) is the ISV; each studio is its own brand and sender. (v2.21 objective, preserved for history: "each studio receives its own studio-specific A2P campaign and is its own message sender" under the GenX account — still true; the manual provisioning model is what changed.)

**PRODUCT INTENT:** Studios send service SMS to opted-in clients through DanceFlow, with per-studio identity, consent, registration and routing, and turn texting on themselves without DanceFlow staff doing Twilio Console work.

**COMPLETED CAPABILITIES** (all released to PROD)
- SMS-A2P-1 (#131): `studio_sms_registrations` (one row per studio; separate `messaging_service_sid`, `campaign_sid`, `sender_e164`; constrained status `not_registered | in_review | approved | rejected | suspended`; `approved` requires all three identifiers; platform-admin-only RLS; no delete policy), platform admin management form on `/platform/sms`, corrected `/sms-consent`.
- SMS-A2P-2 (#132): studio sends only through its own approved registration's Messaging Service; no global fallback; global status is only a master kill switch; inbound STOP/START/HELP and inbound logs scoped to the studio resolved from `MessagingServiceSid` and/or `To`; status callbacks scoped to the owning studio; studio footer always appended; HELP/STOP/START replies name the studio.
- SMS-A2P-3B (#133) and 3C (#134): public samples equal real dispatcher output (pinned by test); `#lead` deep link opens the Contact/opt-in form.
- ConfiDance Studio public opt-in proof verified live: `https://www.idanceflow.com/studios/confidance-studio#lead` (slug `confidance-studio`).

**APPROVED DIRECTION (Twilio support ticket #29647095; latest controlling guidance from Sachin Singh, Twilio A2P 10DLC Appeals Team, 2026-10-06)**
- DanceFlow operates as the ISV. Each studio receives its own studio-specific A2P campaign, created under the existing GenX TotalTech LLC / DanceFlow Twilio account.
- For each studio-specific campaign: Brand/Customer registration uses the studio's underlying legal entity information; the studio is identified as the customer-facing brand; DanceFlow is described as the ISV providing the software and messaging infrastructure for the studio.
- The previous shared DanceFlow campaign is intentionally left unused. It does not need to be modified or resubmitted.
- ConfiDance Studio is the immediate pilot and first studio-specific campaign.
- Twilio guidance: for transactional appointment messages and one-to-one operational staff messages, the appropriate campaign use case is typically Mixed or Customer Care, provided the campaign description and samples accurately reflect transactional/operational messaging and contain no marketing or promotional content. The final use case has NOT been chosen (see Unresolved product decisions).
- Twilio reviewed the proposed ConfiDance opt-in flow and supporting materials and said they appear aligned with compliance requirements.
- The remaining work is not a Twilio architecture blocker; the next actions are on DanceFlow. Nothing is yet recorded as submitted, approved or production-verified (still true at v2.22: no `studio_sms_registrations` row exists in PROD and every studio is fail-closed).
- ~~Advanced Opt-Out is the compliance response authority for STOP/START/HELP. Mixed is the intended pilot use-case direction~~ — superseded by TW-4 D1 and D4 (v2.22; see below). No marketing or promotional SMS in the pilot campaign (unchanged).
- **2026-10-12 (owner-reported):** Twilio switched the GenX TotalTech LLC primary Customer Profile to **ISV Reseller or Partner**, enabling API-based ISV onboarding.

**COMPLIANCE-ENGINEERING SLICES (parallel lane)**
- **TW-1 — Advanced Opt-Out Alignment:** COMPLETE / RELEASED (PR #197, `b3ce238`).
- **TW-2 — Consent Integrity:** COMPLETE / RELEASED (PR #199, `6cb7a39`).
- **TW-3 — Registration Metadata & Readiness:** COMPLETE / RELEASED 2026-10-09 (PR #202 → main `67e735c`; PROD SQL `20261106090000` applied 12:34Z; production deployment `dpl_C5TYuEwJR1S2Pqh6nUpDpvLZS2Zy` live; rollback: application first to `dpl_BTRcPJ3g6fuhpVUvNW3W91jTM3CA`, then the SQL rollback).
- ~~TW-1/TW-2/TW-3 engineering is complete; no TW-4 is planned. The next Twilio work is TW-OPS (manual ConfiDance setup …)~~ — **SUPERSEDED (v2.22).** TW-OPS manual Console provisioning was paused on 2026-10-09 by owner architecture correction (manual Console creation of ConfiDance resources is not the intended workflow). On 2026-10-12 Twilio switched the GenX primary Customer Profile to **ISV Reseller or Partner** (owner-reported). TW-4 replaces TW-OPS steps 1–2; TW-OPS's remaining steps (pre-submission review, submission, production verification) are absorbed into TW-4 slice 4F.
- **TW-4 — Automated ISV SMS Onboarding: PRODUCT DIRECTION APPROVED (owner, 2026-10-12, confirmed v2.22); IMPLEMENTATION NOT STARTED / NOT YET AUTHORIZED.** Design: [`docs/twilio/TW-4_ISV_SMS_Onboarding_Design.md`](../twilio/TW-4_ISV_SMS_Onboarding_Design.md).

**TW-4 ESTABLISHED DESIGN DIRECTIONS (D1–D7; owner-approved directions, not open product choices) and their remaining technical verification requirements**

| # | Established direction | Remaining technical verification (not a product decision) |
|---|---|---|
| D1 | Opt-out: Twilio default STOP/START blocking plus DanceFlow consent/suppression enforcement; per-registration `opt_out_mode` (`twilio_default` / `twilio_advanced`); DanceFlow never duplicates a Twilio reply; Twilio send error 21610 marks the message suppressed and alerts, never auto-retries | Twilio Q2: default HELP behavior, whether STOP/START/HELP still reach the inbound webhook, whether campaign OptOut/Help fields should be supplied; TW-1 inbound amendment and any `twilio_send_blocked` consent source need TW-2-level (Opus) review |
| D2 | One Twilio subaccount per studio (preferred ISV architecture); all studio A2P resources live in the subaccount; sending and webhooks become account-aware | Twilio Q1: parent-profile assignment into subaccount Secondary profiles, parent-credential A2P calls, webhook signature token per subaccount (runtime retrieval, never stored), studio-exit lifecycle; Q5: Event Streams sink placement |
| D3 | Studio-specific SMS Privacy and Terms pages generated from versioned DanceFlow templates (`/studios/{slug}/sms-privacy`, `/sms-terms`) | Twilio Q3: domain rule for studios with their own website (brand `website_url` / campaign URL domain HELD until answered) |
| D4 | Low-Volume Standard brand + `LOW_VOLUME` use case by default for eligible studios; Standard + `MIXED` (or Customer Care if advised) for high-volume studios; final use case always taken from Twilio's `Usecases` endpoint; never `MARKETING` | Twilio Q4: suitability for ConfiDance-type traffic, upgrade path, recommended industry value; TW-3 enum extension (`low_volume_mixed`) |
| D5 | Manual platform Release before aggregate `approved` **for the ConfiDance pilot only**; automated activation afterwards (all invariants, number registered, entitlement active, no open exception, GET re-verification at activation) | Pilot retrospective sign-off before automatic activation is enabled |
| D6 | Minimize EIN retention: AES-GCM ciphertext with an env-held key plus last 4 digits; decrypted only inside the provisioning step; purged after approval or 30 days after a terminal state; never logged or returned | Security review in 4A |
| D7 | SMS commercial direction: setup fee + monthly service fee + included message allowance with metered overage (`usage_events: sms_segment`); no final prices until Twilio costs are verified over at least one pilot billing cycle | Verified pilot invoice lines; amounts remain with decision #8 / Phase 22 |

**TW-4 slice plan (from the design §18.8; engineering sequencing, not a delivery commitment)**
- **4A** — schema, owner wizard (draft / validate / attest), studio status RPC, feature flag, per-studio SMS legal pages (template; domain held), EIN encryption/purge. No Twilio writes.
- **4B** — subaccount-aware Twilio client (send + provisioning), per-AccountSid webhook signature validation, Event Streams endpoint and inbox, poller, TW-1 `opt_out_mode` amendment, 21610 suppression handling. Gated on Twilio Q1, Q2, Q5 and Opus security review.
- **4C** — subaccount creation + Secondary profile + A2P TrustProduct + brand, fee gates, reconcile, error catalog, tier selection. Gated on Q1, Q4.
- **4D** — Messaging Service, use case + campaign (pilot hold for Twilio pre-submission review), number search/purchase/attach. Gated on Q2, Q3.
- **4E** — release/auto-activation, branded emails, platform alerts, ARIA guidance and knowledgebase article. (v2.23) The article replaces the sending claims in `sms-opt-in-for-studios` / `sms-consent-and-message-history` and follows the Phase 17 KB-5 status workflow when that exists (published only once texting is actually enabled).
- **4F** — ConfiDance pilot through the real in-app flow, completed by ConfiDance's owner, plus bounded production SMS verification (confirmation to a consented test recipient, status callback, STOP/START/HELP).
- **4G** — entitlement and billing wiring per D7 (after PAY-WH-1, released; amounts per decision #8).
- **Later:** sole-proprietor path, LVS→Standard upgrade, marketing SMS campaign (Phase 13; separate `MARKETING` campaign and separate marketing consent), Compliance Embeddable re-evaluation.

**REMAINING DELIVERABLES (v2.22)**
1. Send the Twilio verification questions Q1–Q5 (design §20, draft not yet sent) and record the answers.
2. Authorize and build TW-4 slices 4A–4E (developer-owned QA; Opus review for 4B–4D security-critical paths).
3. ConfiDance pilot (4F) through the real automated onboarding experience, including Twilio's pre-submission review of the generated campaign package, campaign approval and production SMS verification.
4. 4G entitlement wiring and post-pilot automatic activation.
5. Studio-visible registration status (delivered by the 4A status RPC and tracker).

*Superseded v2.21 remaining-deliverable list (preserved for history; replaced by the list above):* (1) finalize the ConfiDance campaign description; (2) finalize supporting evidence; (3) send the package to Twilio for pre-submission review; (4) submit the ConfiDance campaign; (5) obtain approval; (6) production SMS verification; (7) use the approved ConfiDance implementation as the repeatable onboarding model. Steps 3–6 survive inside 4D/4F; steps 1–2 become DanceFlow-owned campaign template v1 content; step 7 is now the automated onboarding itself.

Supporting operational detail recorded in v2.21 for the manual model (**SUPERSEDED by TW-4; preserved for history**):
- Twilio Console work for ConfiDance: customer brand registration under the GenX ISV profile; A2P campaign; dedicated Messaging Service; sending number; inbound webhook `POST https://www.idanceflow.com/api/sms/twilio/inbound`. (Status callbacks need no Console setting; the app attaches the callback per message.)
- Console checks: brand legal name / EIN / address / website; whether any ConfiDance resource already exists; that the Console campaign SID matches the `QE…` format the database requires; that the resources are in the same Twilio account as the app's credentials (no subaccount support); Advanced Opt-Out interaction with the app's own STOP reply.
- Record the ConfiDance row in `/platform/sms` (`in_review` once submitted; `approved` only after campaign approval, number attached, webhook set).
- Flip the global SMS status to approved (PROD environment change; needs a redeploy; affects all studios, which stay fail-closed without their own approved registration).
- ConfiDance clients must hold an opted-in consent row for texts to send.

**LOCKED DECISIONS**
- Per-studio registration under the DanceFlow/GenX ISV relationship; not one global campaign. The previous shared DanceFlow campaign is retired/unused and is not to be repaired or resubmitted.
- Registered/supported scope: automated appointment/lesson confirmation, reschedule, cancellation; one-to-one staff messages to opted-in clients; STOP/START/HELP.
- Event SMS stays blocked; no marketing or promotional SMS; no bulk or mass campaigns.
- STOP/START/HELP are scoped per studio (no cross-studio opt-out).
- Strict status-callback matching: for a registered studio the callback `MessagingServiceSid` must match; a missing or old SID fails closed. No historical-SID support.
- Consent evidence: `consent_source`, `consent_at`, and `consent_note` carrying `disclosure=a2p1b-v1;form=…`. No IP or user-agent is stored (do not claim it).
- **(v2.22) No routine founder-operated Twilio Console onboarding for studios.** Studio onboarding is self-service and API-driven (TW-4). Console or Twilio Support involvement is acceptable only for documented exceptions (e.g. appeals, resubmissions beyond Twilio's limits) surfaced through the platform exception queue.
- **(v2.22) The ConfiDance pilot uses the real automated onboarding experience**, completed by the studio owner, not a hand-built campaign.
- `studio_sms_registrations` remains the single send-time authority; TW-4 writes component statuses and the aggregate `approved` only under the D5 release rules.

**SUPERSEDED DECISIONS (v2.22; preserved so later reasoning stays unambiguous)**
- "Twilio Advanced Opt-Out is the compliance response authority for STOP/START/HELP" (TW-1, 2026-10-09) → superseded by **D1** (Twilio opt-out enforcement — default handling, or Advanced Opt-Out where Twilio enables it — is authoritative; DanceFlow records and enforces suppression and never duplicates Twilio replies). Reason: Advanced Opt-Out is Console-only and irreversible, which is incompatible with zero-Console onboarding.
- "Single parent Twilio account; subaccounts are not part of the architecture" → superseded by **D2** (subaccount per studio), subject to Twilio Q1 verification.
- "Manual Console provisioning; SIDs entered by hand in `/platform/sms`" → superseded by TW-4 automated provisioning. The manual TW-3 form remains only for `provisioned_by = 'manual'` rows; `/platform/sms` becomes an operations console and exception queue.
- "Use case = Mixed (TW-3 enum `mixed` only)" → superseded by **D4** (Low-Volume Standard + `LOW_VOLUME` default; Standard + `MIXED` for high volume; enum extended at build).
- TW-OPS as a manual parallel track → absorbed into TW-4 slice 4F.

**PROPOSED BUT NOT APPROVED:** None. (TW-4's architecture is approved as direction; its implementation still needs explicit slice authorization.)

**UNRESOLVED PRODUCT DECISIONS:** Final SMS prices (decision #8 amounts; direction set by D7). *(The v2.21 open item "Mixed vs Customer Care" is SUPERSEDED by D4: the use case is selected deterministically per studio from Twilio's offered use cases.)*

**TECHNICAL VERIFICATION GATES (not product decisions):** Twilio Q1–Q5 (design §17/§20); webhook signature model under subaccounts; Event Streams sink placement; 21610 handling; per-studio legal-page domain acceptance.

**DEPENDENCIES:** Twilio technical confirmation (Q1–Q5) for slices that create Twilio resources; Phase 4 decision #8 (amounts) for general availability only — the pilot uses a platform comp entitlement; Phase 11 (Event Streams and 21610 suppression become part of the SMS platform).

**WEB IMPLICATIONS:** Platform SMS admin page (`/platform/sms`) exists and becomes an operations console under TW-4. Studio-facing onboarding wizard and status tracker (Settings → Texting) are TW-4 deliverables.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Closed. Webhook signature verification and the callback secret are unchanged.

**BRANDING / POLISH CONSIDERATIONS:** `/sms-consent` is the public program explainer and is not itself the opt-in form.

**DEFERRED / POST-LAUNCH ITEMS:** Historical-SID support for callbacks after a future registration SID change. (Studio-visible registration status moves into TW-4 4A.)

**EVIDENCE / RELEASE REFERENCES:** PRs #131–#134 (SMS-A2P, deployment `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21` at the time); TW-1 PR #197, TW-2 PR #199, TW-3 PR #202 (last Twilio-lane production release `dpl_C5TYuEwJR1S2Pqh6nUpDpvLZS2Zy`, since superseded in production by later releases). TW-4 design `docs/twilio/TW-4_ISV_SMS_Onboarding_Design.md` (added to the repository with v2.22; no code, SQL or Twilio change).

---

## Phase 3 — Branding Relaunch / Public Branding & Launch Readiness

**STATUS:** PARTIAL — MATERIAL WORK REMAINS (BR-1 to BR-5 delivered: BR-4 is live and BR-5 is merged as PR #137; BR-6 is active but parked awaiting the professional ARIA voice recording; BR-7 has not started). **Active branding work: BR-6 — Promotional Media (branch `br-6-promotional-media`, not merged).**

**OBJECTIVE:** A full relaunch of DanceFlow's identity, public presence and launch materials — not merely a logo swap.

**PRODUCT INTENT:** One coherent DanceFlow identity across public site, product, email, social, collateral, promotional media and (later) app stores, with launch messaging that speaks to dancers, studio owners, independent instructors and organizers.

**COMPLETED CAPABILITIES**
- **BR-1:** canonical artwork and logo family (Candidate A); vector masters under `docs/brand/masters/` (SHA256SUMS pinned): primary gradient/white, symbol gradient/white, app icon 1024, social avatar 1080. Runtime PNG family under `public/brand/{logo,icons}`.
- **BR-2A–2D:** public metadata/assets, public shell, authenticated shell branding, shell accessibility/responsive QA (released c808724, 2026-09-21).
- **Email/document branding:** shared email shell and branded document/campaign emails with tests (`emailShell.br3a`, `…br3b2`); studio-named sender identity (PAY-DC-3). BR-3 therefore appears complete — **confirm and record formally**.
- Public SMS/ConfiDance proof pages aligned (SMS-A2P-3B/3C).
- **BR-4 Public Website & Launch Messaging — COMPLETE: merged to main (PR #136, `f189d15cbef301a24e3410b79f20d3bcef7135d9`) and LIVE in production (`dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K`, promoted 2026-10-03; no migration).** Delivered as four slices:
  - **BR-4A — messaging architecture and homepage.** Approved positioning headline "The dance platform that helps do the work—not just track it."; homepage rebuilt around one primary action, four concept rows with shipped-capability proof on demand, a compact who-it-is-for list, an accurate Discover band, a short trust section and one final call to action; site metadata and structured data moved off the generic "studio CRM" framing; homepage trial/founder wording derived from the pricing logic (no studio count); public copy centralized in `src/lib/public/homeCopy.ts`; claims guard foundation.
  - **BR-4B — audience pathways and navigation.** Value-stage pages `/for-studios`, `/for-instructors` and `/for-organizers` with per-page metadata and sitemap entries (independent instructors use the studio plans; no separate instructor plan, price or entitlement); dancers continue through `/discover`, retuned as the dancer entry point; public navigation reduced to Discover and For Business (no misleading "Pricing" label; no standalone `/pricing` route); footer "For Business" column; trial and founder copy on the get-started and pricing pages now derived from the canonical plan definitions (the organizer pages previously said 14 days while the plan and checkout use 30; the "first 25 studios" count was removed).
  - **BR-4C — attribution and vocabulary.** First-touch campaign attribution: one shared capture in the public header reads only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` and `ref`, stores them in one first-party cookie (`df_attr`, 30 days, SameSite=Lax, Secure on https) and never stores URLs, referrers or PII; signup re-validates the cookie and copies only namespaced `attribution_*` fields into auth user metadata (no database change); one clarifying sentence added to the Privacy Policy; stable campaign destinations documented in `docs/brand/PUBLIC_DESTINATIONS.md`. Vocabulary convergence: "DanceFlow Discovery" → "Discover", "DanceFlow Organizer Workspace" → "Organizer Suite", the retired "DanceFlow Workspace" label removed, and "Studio Portal" → "Student Portal" only where the surface is the client/dancer-facing portal.
  - **BR-4D — final QA and closeout.** "Studios coming soon" replaced with an honest empty state; shared footer link targets enlarged; hero/eyebrow text contrast fixed; claims-guard source coverage extended to the remaining public launch surfaces; responsive, keyboard and accessibility review of the BR-4 surfaces; focused security/privacy review; roadmap and current-state closeout.
- **BR-5 Event / Print Collateral — COMPLETE and MERGED (PR #137, main `1310e3a`; static collateral only: no application runtime, database, Stripe, Twilio or auth change; no deployment needed).** One deliberately small, reusable system, documented in `docs/brand/collateral/COLLATERAL_GUIDE.md` (strategy in `COLLATERAL_STRATEGY.md`):
  - **Assets:** a 33" × 81" event banner (QR → `/`); Letter two-sided studio, independent-instructor and organizer sheets (one template, three copy variants; QR → `/for-studios`, `/for-instructors`, `/for-organizers`); a 4" × 6" two-sided dancer card (QR → `/discover`); and two social templates (1080 × 1080 and 1080 × 1920), each with a product-awareness and an event-presence ("Find DanceFlow at {event}") variant, with no QR.
  - **System:** all copy in `docs/brand/collateral/copy.json` (BR-4 wording reused and drift-tested); HTML/CSS templates; a deterministic builder (`scripts/brand/build-collateral.mjs`, `--verify`) using the repo's Playwright, `qrcode` and `pdf-lib`; vector QR codes with attribution tags on the BR-4 convention (`utm_source` asset type, `utm_medium=qr`, `utm_campaign=br5-launch`, `utm_content` audience-version); a focused test (`collateral.br5.test.ts`) for claims restrictions, QR/attribution URLs, export dimensions and builder QA.
  - **Limits recorded honestly:** the banner is a **vendor-neutral master; final vendor fit, bleed and bottom-feed adjustment are required before a print order** (vendor not chosen); PDFs are RGB with embedded fonts and trim/bleed boxes, with **no CMYK or PDF/X conversion** (done by the printer); static QR codes cannot distinguish events (attribution is first-touch only); type is the system stack (Segoe UI in these proofs); the dancer card photo is an existing hero crop at about 310 dpi.

**REMAINING DELIVERABLES**
- **BR-4** — COMPLETE and LIVE (see above).
- **BR-5 — Event / Print Collateral Strategy and Production** — COMPLETE and MERGED (see above). Still open outside BR-5: choosing a banner vendor and the vendor-specific final file; CMYK/press conversion at the printer; actually posting the Facebook / social content.
- **BR-6** Promotional media / video — **ACTIVE, PARKED.** Rough Cut 3 visual system and motion engine built on `br-6-promotional-media` (head `1f19305`, not merged, not pushed). The owner locked a first-person master narrated by ARIA herself (`docs/brand/media/VOICEOVER_V4.md`); a professional female voice actor is being engaged. The next full master render waits for the professional recording (`media/_work/voice/aria-pro/`, WAV 48 kHz 24-bit). No music is sourced or licensed; the music arc is timed against the performance later. BR-6 is not complete.
- **WEB-2A — Two-audience website (owner decisions 2026-10-22; Git-only, in progress).** The public site now serves public dancers and dance businesses as equal audiences. Bounded slices, each its own PR (no SQL, no deployment, no video publishing without separate authorization):
  - **W-0** this roadmap and brand-guide record;
  - **W-1** homepage: H1 "Where the dance community connects.", two equal doors (dancers first on mobile and left on desktop), a dancer section with every Discover path including Classes, a business section that keeps the BR-4 positioning line, a how-it-connects strip, a secondary Meet ARIA section with the approved 30-second horizontal cut;
  - **W-2** navigation: "For Dancers" (Discover paths) and "For Business" (audience pages, Plans & free trial, Meet ARIA), mobile menu grouped dancers first, distinct "Create free account" and "Start free trial" actions;
  - **W-3** public SEO: Discover hubs in the sitemap, organizer and marketplace item metadata;
  - **W-4** `/for-studios#meet-aria` with the full 77-second R4 commercial and captions;
  - **W-5** dancer-journey dead ends (partner connect login intent, competition registration button hidden when the flag is off);
  - **W-6** creative brief only for a future 30–45-second public-dancer video (not produced).
  - **Video delivery:** no video file is committed. The pages render the player only when the owner sets `NEXT_PUBLIC_ARIA_VIDEO_30S_URL` / `NEXT_PUBLIC_ARIA_VIDEO_77S_URL` (and the matching `_POSTER_URL`) to https, progressive-MP4 URLs; until then each section is text only. Uploading the approved files and setting the variables is an owner action. Captions are committed WebVTT.
  - The broader marketing campaign hold is unchanged: no advertising, social posting or campaign launch is part of WEB-2A.
- **BR-7** Final branding / public-launch QA, including remaining visible micro-polish (for example the "Location coming soon", "Studio image coming soon" and "Public page coming soon" placeholder strings on Discover cards).
- Vocabulary: converged for the BR-4 scope. Retained on purpose: platform-admin labels ("Organizer Workspace(s)", "DanceFlow Platform Admin"), the host-studio floor-rental portal wording, and generic lowercase "studio portal" prose in the knowledgebase.
- Documentation cleanup: stale statements in `docs/brand/DANCEFLOW_BRAND_GUIDE.md` (§11 "vector master deferred", §12 legacy icon note, §7 "wordmark is artwork (script)", BR-2 status). Not a blocking phase.
- Mobile student app still ships the retired couple/script logo and DF monogram icon (see Phase 20; do not pull mobile redesign ahead of Phase 18).

**LOCKED DECISIONS**
- Approved Candidate A logo artwork is canonical.
- The package palette was not adopted as UI tokens; the current application palette (`#5b145e`, `#fff9f3`) stays authoritative.
- Sora/Inter were not adopted as the application font system.
- The compact horizontal lockup and the descriptor lockup ("Studio Operating System") were **not adopted**; the symbol is the compact mark. Any future adoption needs separate owner approval.
- Do not create a palette/font decision slice before further branding work.
- Messaging direction: **"Software that helps do the work—not just track it."** ~~Approved homepage H1: "The dance platform that helps do the work—not just track it."~~ — **SUPERSEDED (owner, 2026-10-22):** the homepage H1 is **"Where the dance community connects."**; the BR-4 line stays as the business positioning line (homepage business section, BR-5 collateral).
- **Two-audience homepage (owner, 2026-10-22):** public dancers and dance businesses are equally important. The hero has two distinct, equally prominent entry points, dancers first on mobile; public account creation and the business free trial stay separate actions. ARIA is a secondary homepage section (30-second cut); the full 77-second R4 commercial belongs on `/for-studios`. The hero mini-search is deferred.
- Public audience architecture: `/for-studios`, `/for-instructors`, `/for-organizers`; dancers use `/discover`; there is no `/for-dancers` page (reconfirmed 2026-10-22) and no standalone `/pricing` route. Independent instructors are business users on the existing studio plans (no instructor-only plan, price or entitlement).
- ~~Public navigation is deliberately small: Discover and For Business (plus Favorites/Account when signed in).~~ — **SUPERSEDED (owner, 2026-10-22):** public navigation is **For Dancers** (Discover home, Studios, Classes, Events, Dance partners, Jobs, Learning) and **For Business** (Studios, Independent instructors, Organizers, Plans & free trial, Meet ARIA), plus Favorites/Account when signed in. Plans and trials are still reached from the audience pages and "Get Started"; there is still no standalone `/pricing` route.
- Trial length and founder wording on public surfaces are derived from the canonical plan definitions and `isFounderPricingActive()`; no remaining-studio count is ever shown.
- Attribution is first-touch only, allowlisted to the six campaign keys, with no PII, URLs or referrers; no latest-touch tracking and no third-party analytics.
- Vocabulary: "Discover", "Organizer Suite", and "Student Portal" only for the client/dancer-facing portal; "DanceFlow Workspace" is not a product name.
- A public-copy claims guard (`src/lib/public/__tests__/homeCopy.br4a.test.ts`) protects Featured Events, Partner Match, SOC 2, Competition OS and ARIA-autonomy restrictions.

**PROPOSED BUT NOT APPROVED:** Print/media asset list (see D and E); the final set is not locked.

**UNRESOLVED PRODUCT DECISIONS:** Video cut list; banner vendor and stand. (Resolved in BR-5: the collateral asset set is fixed at the nine exports above plus the guide. Resolved in BR-4: QR/campaign destinations are fixed in `docs/brand/PUBLIC_DESTINATIONS.md`; no standalone pricing page precedes Phase 22.) Demo-request / interest-capture storage is deferred to later Marketing/CRM work.

**DEPENDENCIES:** None blocking BR-4. Store/app-specific assets wait on Phase 18. See [Featured Events](#strategic-module-featured-events) and [Partner Match](#strategic-module-partner-match) restrictions below.

**WEB IMPLICATIONS:** BR-4 changed the public home, audience pages, navigation and footer, Discover framing, get-started/pricing copy, metadata and sitemap; deployment is required after the BR-4 PR merges.

**MOBILE IMPLICATIONS:** App-store identity, screenshots, store listing and the student-app logo replacement wait on Phase 18 (see I below).

**SECURITY / PERMISSIONS CONSIDERATIONS:** Public claims must match shipped behavior (see restrictions).

**BRANDING / POLISH CONSIDERATIONS:** This phase is the branding work; carry forward deferred polish: NotificationMenu default focus ring, pre-existing nested `<main>` pages, `platform/webhooks` missing a page-owned `<h1>`, Portal invalid-logo fallback, PORTAL-UX-1/2 design-gap backlog.

**DEFERRED / POST-LAUNCH ITEMS:** The polish backlog above if not absorbed by BR-7.

**EVIDENCE / RELEASE REFERENCES:** Released c808724 / `dpl_BEu8q5cjsxJaJUi4pjYvmYDwn1QZ` (BR-1, BR-2C, BR-2D); `docs/brand/`. BR-4: merged as PR #136 (BR-4A–C commits `0f0ee77`, `69812d5`, `461741e`, plus BR-4D) to main `f189d15cbef301a24e3410b79f20d3bcef7135d9`; live as `dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K` (prior production `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21`). BR-5: merged as PR #137 (main `1310e3a`; static collateral, no deployment needed).

### A. Brand identity foundation
Logo system (primary horizontal mark, symbol-only use, favicon/app icon, social avatar) exists. Compact horizontal and descriptor lockups are not adopted (locked). Typography/color/gradient rules follow the current application palette and fonts (locked). Product-facing identity: DanceFlow, with "Studio Portal" and similar legacy descriptors being removed.

### B. Product/public identity rollout
- **Public site:** metadata/shell done; BR-4 done and live (v2.22 correction; this line previously said "BR-4 pending").
- **Authenticated product:** shell done (BR-2C/2D); vocabulary sweep pending.
- **Email:** done (BR-3 evidence, PAY-DC-3); confirm.
- **Social/avatar:** avatar asset exists; `FACEBOOK_RELAUNCH_FOUNDATION.md` is a requirements document only (page URL, handle, cover, bio are "owner to supply"; bio line 2 and pinned post are unwritten).
- **Favicon/app icon:** web done.
- **Organizer and competition surfaces:** branding sweep unverified and partial.
- **App-store-facing identity:** not started; waits on Phase 18.

### C. Launch messaging architecture
- Master story: "Software that helps do the work—not just track it."
- Audience-specific architecture for dancers, studio owners, independent instructors and organizers, each with: value proposition, headline hierarchy, proof points, CTA system, booth/demo talking points.
- Current state (v2.22 correction; the pre-BR-4 text said the headline and audience pages did not exist): the approved headline is the homepage H1; `/for-studios`, `/for-instructors` and `/for-organizers` exist and dancers use `/discover` (BR-4); there is deliberately no standalone pricing route.
- **Do not make claims about unreleased automation.**

### D. Event / print collateral (BR-5 delivered the minimum set; see Delivered above)
Considered: 33" × 81" vertical banner(s) (dancer/public; and studios / independent instructors / organizers business audience); tri-fold brochure(s) (studio, independent instructor, organizer audiences); dancer flyer/postcard; QR strategy; landing-page destination strategy; print-production specifications; reusable templates. **The final phase should choose the smallest strong collateral system rather than creating every historically proposed asset.** BR-5 chose and produced it (banner, three business sheets, dancer card, two social templates); tri-fold brochures, a second banner and a Facebook landscape graphic were intentionally not produced.

### E. Promotional media
Considered: 60-second master launch video; 30-second social/ad cut; 15-second short-form cut; event booth/display loop; studio / independent-instructor version; organizer version; dancer/public-discovery version; later app-store/Google Play version; real product footage; branded motion graphics; professional voiceover; CTA/QR destination; export specifications. None exists in the repo today.

### F. Event conversion infrastructure
Considered: audience landing pages; trackable QR codes; UTM/campaign tracking; event lead capture; studio demo request; independent-instructor interest; organizer interest; dancer signup/download; follow-up sequences; attribution. Delivered in BR-4: audience landing pages (`/for-studios`, `/for-instructors`, `/for-organizers`, `/discover`), stable campaign destinations, and first-touch UTM/ref attribution carried into signup metadata (see Delivered above). Delivered in BR-5: QR codes and attribution-tagged print assets (banner, sheets, dancer card). Still not built: per-event print attribution (static QR codes cannot tell events apart), a demo-request / interest-capture flow (deferred; needs storage), marketing follow-up sequences, and an attribution reporting view.

### G. Final launch maturity QA
Dead links; placeholder content; unfinished screens; empty states; CTA clarity; responsive behavior; QR/deep links; trust/credibility presentation; brand consistency. (The original reconciliation grep found no "coming soon" text; that was superseded — BR-7 lists remaining "coming soon" placeholder strings on Discover cards. Dead-link and CTA checks are unverified.)

### H. Branding work that can proceed now
BR-4 (messaging architecture, audience pages, vocabulary, attribution foundation) is live, and BR-5 produced the print and social collateral. Remaining and unblocked: promo video using web product footage (BR-6), and brand QA (BR-7).

### I. Branding work that must wait for Phase 18 (mobile decisions)
App-store / Google Play video variants, store listing, screenshots and icon packaging; student-app logo/icon replacement; dancer signup/download flow and app deep-link/QR behavior; anything naming DanceFlow Business or judge/competition apps.

### Public-claim restrictions (applied in BR-4; continue through BR-5 onward)
These were enforced for BR-4 and remain in force for all later public materials (collateral, media, social) until the underlying capabilities ship. The BR-4 claims guard tests them for the public site.
- No meaningful Featured Events promotion claim; avoid "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory.
- No claims of algorithmic matching, compatibility scoring, guaranteed or fast connections, an already-complete acquisition funnel, or "free forever".
- No Partner Match landing push, sitemap entry or SEO campaign until moderation and a working web request path exist.
- No Competition OS claims (judging, scoring, results, awards, live heat management), no SOC 2 claim, and no unrestricted-ARIA-autonomy claim.

---

## Phase 4 — Remaining entitlement foundation

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** Every gated feature and usage allowance is enforced centrally and consistently by plan.

**PRODUCT INTENT:** Plans (starter / growth / pro; organizer) and add-ons control access and usage predictably, with clear upgrade paths.

**COMPLETED CAPABILITIES**
- **ENT-1 — email-campaign recipient allowance enforcement: COMPLETE and RELEASED (PR #138, squash merge `782fd680fdb0ab8928faccb4ac859bbe4e6109f6`; migration `20261013090000_ent1_usage_allowance_reservations.sql` applied and verified in PROD before the deployment; live as `dpl_HcYmcSqF4hLApbwASov1xacA4mbu`, promoted 2026-10-03). Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.** Studio and organizer campaign sends now enforce the monthly recipient allowance (starter 0, growth 1,000, pro 5,000, organizer 1,000, unchanged) atomically in the database, with two scopes kept apart: the ENTITLEMENT scope is the whole logical campaign (admitted all-or-nothing; capacity for every pending recipient is committed at admission under a per-workspace/feature/month advisory lock, and later 500-recipient delivery batches continue under that same commitment, so no concurrent campaign can take it and an admitted campaign is never left partially mailed by allowance), while the DELIVERY scope stays the existing safe batch. Per batch: reserve (admit or continue) → send → settle with only the recipients whose send succeeded (the commitment shrinks to what is still pending; failed recipients release their share; the campaign closes when nothing is pending). Capacity is never released while a batch is unsettled; a stale open batch is reconciled from the durable per-recipient `sent` records, so a successful send cannot stay uncounted. A campaign that does not fit sends nothing; zero allowance blocks; an inactive or unresolvable entitlement fails closed. Tenant-scoped, no email add-on or pricing implied. Reservation functions are service-role only (`usage_reservations`, migration `20261013090000`); proven with SQL tests, a DEV concurrency harness and app tests. ENT-1 also corrects the organizer send pipeline, which ignored the provider's resolved `{ error }` result and recorded rejected sends as `sent`. Only this slice is complete: Phase 4 remains PARTIAL.
- 22-key `BillingFeature` union; `PLAN_FEATURES` and `ORGANIZER_PLAN_FEATURES`; `studioHasFeature`, `requireStudioFeature` (redirects to billing with reason), organizer feature helpers; billing overrides; organizer-suite add-on entitlement. Used in about 66 files under `src/app/app`.
- Usage/credits foundation: `UsageFeatureKey` (`ai_action`, `sms_message`, `sms_segment`, `email_campaign_recipient`), AI allowances by plan, AI credit packs with checkout, seat limits.
- Owner billing authority hardened (LAUNCH-SEC-2A).

**REMAINING DELIVERABLES**
- **SMS plan gating: BLOCKED on open decision #8 (plan placement and allowance).** SMS has no plan gate or usage consumption (SMS allowance is hard-coded to 0; no `BillingFeature` entry). The send paths already enforce role, per-contact consent, the studio's own approved A2P registration and the global kill switch (SMS-A2P-2); plan/usage gating is the only missing layer and is independent of the Twilio / Sachin external dependency, which gates A2P approval and the global status, not plan placement.
- ~~Email-campaign recipient allowance is defined but not enforced~~ — DONE for studio and organizer campaigns by ENT-1 (released; see above). **Scope clarified (owner-approved):** the campaign-recipient allowance applies to user-created marketing campaigns only. Operational and transactional email (auth and verification, portal invites, documents and signing, reminders, receipts and payments, accountant delivery, support, platform digest) and current ARIA operational outreach (the 1:1 `aria_execution_*` client messages queued through `outbound_deliveries`) are NOT campaign-recipient-metered under the current product model, and are not an open ENT-1 gap. ARIA has no marketing-campaign send path: its marketing rules (`aria_marketing_opportunity`, `aria_event_promotion_gap`) are suggestion-only drafts, and any send goes through the enforced studio/organizer campaign actions. **No email add-on or credit product is approved, and none is required to close Phase 4:** the approved state is a capped allowance with an upgrade path (pricing belongs to Phase 22). The unreferenced duplicate campaign action module `src/app/app/marketing/campaigns/[id]/actions.ts` is not an enforcement gap (it is not bundled or callable); its removal stays with the planned Phase 13 action-module dedupe.
- **Payroll Prep tier placement: DECIDED — Growth+ (owner-approved 2026-09-15; reaffirmed by the owner 2026-10-13, see below).** **Payroll Prep entitlement enforcement and its `BillingFeature` key: NOT IMPLEMENTED — pending a separately authorized slice** (today Payroll Prep has role authorization only and no plan gate).
- **Plan placement and `BillingFeature` keys for marketplace and ARIA: BLOCKED on open decision #8.** Today ARIA Operations/automations and the marketplace/catalog pages have no plan gate (role authorization only); only `ai_assistant` gates AI generation. No speculative keys are to be created before placement is decided.
- ~~No reusable upgrade-prompt component~~ — **reassigned to Phase 17** (owner-approved). Phase 4 is satisfied by the existing functional entitlement-denial behavior: `requireStudioFeature` / organizer helpers redirect to `/app/settings/billing?reason=feature_required&feature=…&requiredPlan=…`, which the billing page renders, plus feature-specific inline limit messages (reports, AI insights, events, organizer contacts, ENT-1 campaign allowance). The shared upgrade-prompt component and usage display are web-UX completion work (see Phase 17).
- Usage ledger writes outside `addons.ts` (and lumi portal): ENT-1 adds reservation-based writes for campaign recipients; no other new metering.
- Future entitlement needs: Featured Events promotion (see module), Partner Match is intentionally free.

**LOCKED DECISIONS:** Starter has no AI or email allowance by design. Pricing amounts live in Phase 22.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Open decision #8 — plan placement for SMS (including whether it has a monthly allowance and its quantity), marketplace and ARIA features (payroll placement resolved in v2.22: Growth+) (including whether ARIA Operations is plan-gated or only AI-credit metered), and how that ties to Phase 22 pricing. All remaining Phase 4 implementation waits on it. **Phase 4 stays PARTIAL; it is not complete.** **v2.22 progress on #8:** (a) **Payroll Prep placement is RESOLVED: Growth+** (owner decision below); (b) the SMS **commercial direction** is set by TW-4 D7 (setup fee + monthly service fee + included allowance with metered overage). SMS amounts and allowance, marketplace placement and ARIA placement remain **open**.

**Payroll Prep tier placement — DECIDED: Growth+ (OWNER-APPROVED).** Source: the owner's 2026-09-15 entitlement decisions listed *Payroll Prep = Growth+* among "locked decisions" and restated it the same day as already locked (superseding the earlier same-day Decision 4 note that the tier "will be decided separately"). The 2026-10-03 Phase 4 reconciliation listed "payroll plan placement" among the items blocked on decision #8; **on 2026-10-13 the owner explicitly resolved that conflict in favor of Growth+** ("Payroll Prep = Growth+ is reaffirmed as the current owner-approved product-tier decision") during the v2.22 merge review.
- **What is decided:** the product tier — Payroll Prep is included in Growth and Pro, not Starter.
- **What is still pending (implementation, not a product decision):** the Payroll Prep `BillingFeature` key, server-side entitlement enforcement and the denial/upgrade UX. These need their own authorized slice (with a live-plan check before any grandfathering exception, per the owner's 2026-09-15 note that the then-live studios were on Pro). No billing, pricing or Stripe change is implied.
- **Not affected:** Gusto remains a separate, dormant future capability (Decision 4) with its pricing undecided; the other 2026-09-15 tier statements (general Documents/e-signature Growth+, minimal Group Class waiver Core, Packages/Memberships Core, ARIA Core with metered usage, seat and owned-location limits) are **not ruled on in v2.22** and stay as recorded evidence; marketplace and ARIA placement and SMS amounts stay open under #8.

**DEPENDENCIES:** Phase 2 (SMS), Phase 22 (pricing), Phase 13 (campaign allowances), Phase 19/20 (mobile gating).

**WEB IMPLICATIONS:** The shared upgrade-prompt component and usage display in the web app are Phase 17 work (not a Phase 4 build); existing feature-specific denial behavior stays until then.

**MOBILE IMPLICATIONS:** Business app navigation must respect entitlements.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Entitlement authority is service-side hardened (migration `20260918070000`); keep enforcement server-side.

**BRANDING / POLISH CONSIDERATIONS:** Consistent upgrade and limit messaging is delivered with the Phase 17 shared upgrade-prompt work.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/billing/{plans,access}.ts`, `src/lib/usage/addons.ts`. ENT-1: `src/lib/usage/campaignAllowance.ts`, migration `src/lib/supabase/migrations/20261013090000_ent1_usage_allowance_reservations.sql` (rollback and SQL test alongside; race harness `sql-tests/concurrency/ent1_race_harness.mjs`), campaign send actions under `src/app/app/marketing/campaigns/` and `src/app/app/organizer-campaigns/`.

**PHASE 4 RECONCILIATION (2026-10-03, owner-approved):** no dependency-safe Phase 4 implementation work remains. What is left is blocked by open decision #8 (SMS, payroll, marketplace and ARIA plan placement) and, for pricing, Phase 22. SMS stays blocked on plan placement independently of the separate Twilio / Sachin external dependency. Existing functional entitlement denial is sufficient until Phase 17. Phase 4 is PARTIAL by decision, not by missing engineering; the unresolved items stay visible in this section and in the consolidated decisions list. *(v2.22: the payroll placement part of this reconciliation is superseded by the owner's 2026-10-13 reaffirmation of Payroll Prep = Growth+; payroll enforcement remains unimplemented. SMS, marketplace and ARIA are unchanged.)*

**PHASE 5 HANDOFF (explicit, not a silent reorder):** roadmap execution may proceed to Phase 5 while Phase 4 remains PARTIAL because (1) the remaining Phase 4 work is explicitly blocked by product decisions, (2) those items remain visible and unresolved, and (3) they do not affect the existing entitlement foundation (the plan features, seat limits, credit/benefit engine inputs and ENT-1 allowance) that Group Class work relies on. No Phase 5 work is complete as a result of this handoff.

---

## Phase 5 — Group Class canonical foundation

**STATUS:** COMPLETE / CLOSED (2026-10-05, GC-S1F released). The canonical foundation is closed; the items still listed under REMAINING DELIVERABLES that were not delivered (Events retirement, multiple rooms/locations, class revenue reporting) and open decision #10 are explicitly carried forward outside this closure; see the Phase 5 final state below.

**OBJECTIVE:** Group classes modeled canonically as appointments, with full operational support.

**PRODUCT INTENT:** One reliable model for classes: scheduling, rosters, eligibility, credit consumption, reminders, check-in, public sharing and reporting.

**COMPLETED CAPABILITIES**
- Appointment attendees roster foundation (`gc1_1`); attendance integrity and billing foundation (`gc1_2`); enrollment write RPCs (`gc1_4`); credit/benefit engine (`gc2a`–`gc2h`: finite benefit type, balance engine, capacity invariant, funding row selection, usage sync, consumption lifecycle guard, RLS self-access); roster capacity, enrollment policy table and funding candidate set (`gc3a`–`gc3c`); RLS tightening for group-class attendance/recap/appointments.
- Staff schedule workflow and QR check-in RPC; student check-in route (with test).
- Package/membership funding is covered by SQL tests; the credit-deduction lock-order hotfix (PKG-MUT-1) is released.

**REMAINING DELIVERABLES**
- Retire Events-based group-class creation (events actions, form and public event page still accept `group_class`).
- Close out the series/occurrence model: recurrence exists (`series_id`/`recurrence` on appointments) but no dedicated series table or documented decision; multi-week occurrence materialization **(unverified)**. **GC-S1 architecture approved (finite structured recurrence; occurrences are real `group_class` appointments; series enrollment first-class; no open-ended recurrence in GC-S1). GC-S1A (schema and authority foundation: `group_class_series`, four additive appointment columns, same-studio composite FK, guard and override-tracking triggers, select-only RLS) is RELEASED AND CLOSED (PR #143, migration live in DEV and PROD, no data and no app behavior yet).** Remaining GC-S1 slices, none started: S1D series enrollment and roster integration, S1E reminder/calendar/conflict integration, S1F security, polish and closeout (S1A, S1B and S1C are RELEASED AND CLOSED).
- Multiple locations/rooms for group classes (not found).
- ~~Group-class reminders (not found).~~ — **GC-R1 DONE — RELEASED AND CLOSED.** Canonical group-class attendees (`appointment_attendees.status = 'booked'`) now get the existing 24h/2h reminder cadence by email through the existing generator (`/api/notifications/generate`), `notification_deliveries`, send route and branded HTML (class variant: class title, date, time, instructor and location where present; no confirmation link, no payment or credit language). Idempotent per class + attendee + window through `dedupe_key` (no migration). Operational email: no ENT-1 allowance, no SMS, legacy Events reminders untouched. A class with attendee rows is reminded only through them; a class with none keeps the legacy `client_id` behavior. **RELEASED 2026-10-03:** PR #141 (reviewed head `1c7c415c1d7146cf5c82b99207d3c98065f55a33`) squash-merged to main `087c2c7a7a3d832fa9699682c926eff290151ff8` (parent `56b3a9c0b005990da5c8aff13008421bf32b4f3e`), promoted to PROD as `dpl_HcdC6KRD9ZRWFN4FtyvEGbpsNVcE` (www and apex); rollback target `dpl_HcYmcSqF4hLApbwASov1xacA4mbu`. No migration was required: the PROD `notification_deliveries.dedupe_key` column and its unique partial index were verified read-only before and after deployment. Authenticated production smoke was intentionally omitted under the permanent release rule (prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was validated in DEV/local before release).
- Group-class revenue reporting (not found).
- Public/shareable class URLs (belongs to Phase 6).

**LOCKED DECISIONS:** Group classes are canonical appointments; credits are consumed through the gc2 engine; new Events-based creation is to be retired (not yet done).

**PHASE 5 STATUS NOTE (GC-R1):** only GC-R1 (canonical attendee reminders) is complete. **Phase 5 remains PARTIAL.** Still open: legacy Events group-class retirement (**requires a production-data inventory of existing Event-based classes, sessions and registrations before any retirement or migration**), series/occurrence model, multiple rooms/locations, class revenue reporting, and the depleted-credit decision (#10). Pre-existing, not caused by GC-R1 and not fixed here: the private-lesson reminder dedupe relies on a unique constraint that does not dedupe when `user_id` is NULL, so overlapping hourly runs can theoretically queue duplicate private-lesson reminders; a follow-up should adopt `dedupe_key` for that path.

**PHASE 5 STATUS NOTE (GC-S1A):** **GC-S1A RELEASED AND CLOSED (2026-10-03):** PR #143 (reviewed head `efa68d14e2fa3f9966da9a7df096279a68f162bc`) squash-merged to main `8bb14afd8f1e6f4dca2e880ad99708d0679aa5e3` (parent `61ef3dafe8d3e8f5025c32e2d4e91b93a55a0896`). Migration `20261014090000_gcs1a_group_class_series_foundation.sql` was applied and verified in DEV (79 SQL checks; rollback validated and the migration re-applied) and applied once, manually, through the PROD Supabase SQL Editor, then verified read-only: PROD and DEV definitions match after normalizing cosmetic carriage returns. The 203 existing PROD appointments were unchanged; at release there were zero series rows, zero appointments attached to a series, zero override entries and zero canonical group-class appointments. Legacy Events data was unchanged (8 group-class events, 66 sessions). No application deployment or Vercel promotion was required (no runtime code). Authenticated production smoke was intentionally omitted under the permanent release rule (prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was validated in DEV/local). **GC-S1B has NOT started.** **Phase 5 remains PARTIAL.** Preserved follow-ups: (1) before any legacy Events migration design, perform the read-only, no-PII date-pattern analysis of the irregular 12-session production series; (2) the existing canonical group-class create/edit conflict-detection gap is real: `create_group_class_appointment` and the class edit path run no instructor or room conflict detection (only lesson paths call `detectAppointmentConflicts`), and `appointments.roster_capacity` has no database bound or app writer yet (the guard against capacity below the booked count belongs to S1C). Open decisions unchanged: depleted-credit decision #10; Events retirement needs canonical parity first and is not authorized.

**PHASE 5 STATUS NOTE (GC-S1B):** **GC-S1B (series creation and occurrence materialization) — RELEASED AND CLOSED (2026-10-04).** PR #145 (reviewed head `5a19362f3bb902ca1289781e1bdc3cd74f2e26a6`) squash-merged to main `13873744d9df3d36d09c671f81ead132f2b64b4f` (parent `01bab74091b06451f5b21f4cfac343d6be05889d`, tree `7f959ce8cfe50993a0bb5580b203876634f69c7c`, identical to the reviewed candidate tree). Migration `20261015090000_gcsb1_group_class_series_materialization.sql` (B1: `client_request_id` idempotency, shared occurrence generator, `preview_group_class_series`, `create_group_class_series`) was applied to PROD manually in the Supabase SQL Editor and verified BEFORE the app deployment (schema, index, four functions, grants and bodies match DEV; 203 appointments unchanged; 0 series and 0 policy rows). qfem deployment `dpl_5Q8VbkRyyZ2QuENzeZAGM7CBLF9j`, built from the exact squash SHA, promoted 2026-10-04 (www and apex serve it; rollback target `dpl_HcdC6KRD9ZRWFN4FtyvEGbpsNVcE`, app first). B2 server actions with conflict enforcement and the B3/B4 owner-facing "Class series" creation UI are live. Authenticated production smoke was intentionally omitted because it would create real series and appointment rows in production; acceptance was completed on DEV. Standalone (non-series) group classes are unchanged; legacy Events group-class creation remains active and untouched. Phase 5 remains PARTIAL. S1C (edit/exception/cancel), S1D (series enrollment/roster), S1E (reminder/calendar/conflict integration for edits) and S1F (security, polish, closeout) remain future work; depleted-credit decision #10 remains open.

**PHASE 5 STATUS NOTE (GC-S1C-1):** **GC-S1C-1 (occurrence edit safety) — RELEASED AND COMPLETE (2026-10-04); GC-S1C overall remains INCOMPLETE.** PR #147 (reviewed head `0bc12f94333fe20ed86e62e2af65aa7212207759`) squash-merged to main `3f31cb24e2bfd6d5651fd299d73783fb863fe752` (parent `e9e7485444a91a8e1e71209fc242f13a7b258544`, tree `380147ef372a7c586b9970562fa03e08b636189d`, identical to the reviewed candidate tree). qfem deployment `dpl_826bbGgRmgu6WzPwcQuGkeJdb3XN`, built from the exact squash SHA, promoted 2026-10-04 (www and apex serve it; rollback target `dpl_5Q8VbkRyyZ2QuENzeZAGM7CBLF9j`). **No migration was required and none was applied; the PROD database was not touched.** Released: THIS-OCCURRENCE-ONLY editing of canonical group classes (series occurrences and standalone classes); server-authoritative conflict recheck through the existing conflict engine for instructor/room/time changes (fails closed, safe copy only); a Maximum students field with a capacity floor (cannot be set below the currently booked attendee count) enforced at the app/server layer only; room-belongs-to-studio validation; a hard-delete refusal for series occurrences enforced at the app layer only (cancel instead; standalone delete unchanged); series identity never written and S1A override tracking reused; restrained series context in the edit UI. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release. **Future DB backstops (NOT live at the time; both delivered in GC-S1C-3):** (1) a database-level capacity-floor guard; (2) a database-level guard preventing hard delete of series occurrences. Until then both protections were application-level only. Not yet done in S1C: occurrence cancel safety (terminal-state behavior), any this-and-future/whole-series editing or propagation, and series status transitions. S1D, S1E and S1F remain future. Legacy Events remain active; Phase 5 remains PARTIAL; depleted-credit decision #10 remains open.

**PHASE 5 STATUS NOTE (GC-S1C-2):** **GC-S1C-2 (occurrence cancellation safety) — RELEASED AND CLOSED (2026-10-04); GC-S1C overall remains INCOMPLETE.** PR #149 (reviewed head `0d9406d1ac1d175cc90fa822932807ab15cbd301`) squash-merged to main `e0f8b7b4b05e70b2df7e41d542025151548453fd` (parent `0f04b144ea9f34e570bb3f49cad9e19ad19ff47f`, tree `284e81ef64c2e0e0a033805934811ffd025dd054`, identical to the reviewed candidate tree; no AI attribution in the squash commit; feature branch `gc-s1c-2-occurrence-cancel-safety` retained). **The PROD migration `20261016090000_gcsc2_group_class_cancel_safety.sql` was applied to PROD (`hvsujyfbftfffxpfmlpb`) and verified BEFORE the application promotion.** qfem deployment `dpl_9M8Gn9p9YELRrKr53gFs9Q4q7CoS`, built from the exact squash SHA, promoted 2026-10-04 at about 11:51 UTC (www and apex serve it; rollback target `dpl_826bbGgRmgu6WzPwcQuGkeJdb3XN`, app first; no rollback performed). The application release made no database changes.

Reconciliation finding that motivated the slice: every staff Cancel button routed through the generic `cancelAppointmentAction`, so a group class was cancelled by flipping its status while booked attendees stayed `booked`, and `clearMembershipUsageForAppointment` deleted `client_membership_usage` rows keyed by the class appointment id (a silent entitlement restoration for attendees whose attended/no-show consumption was already recorded); the safe `cancel_group_class_appointment` RPC was reachable from no UI. Owner decisions: group-class cancellation is BROAD STAFF ONLY (platform admin, studio owner, studio admin, front desk; no assigned-instructor cancellation); cancellation is THIS OCCURRENCE ONLY.

**Released, database (one migration, three authoritative parts):** (1) the existing `cancel_group_class_appointment(uuid) -> uuid[]` is hardened (same signature, SECURITY DEFINER, `search_path=public`, authenticated-only grant): the class row is locked `FOR UPDATE`; an already-cancelled class is an idempotent no-op (no restamp, no attendee change, empty recipient list); any `attendance_records` row with status `attended` or `no_show` refuses cancellation (`GCSC2_ATTENDANCE_RECORDED`) regardless of date or roster; otherwise status and `cancelled_at` are set and only booked attendees are cancelled and returned for the existing notification. (2) Attendance-side guard `attendance_records_00_guard_cancelled_class` (`enforce_group_class_attendance_not_cancelled()`, BEFORE INSERT OR UPDATE, SECURITY DEFINER, trigger-only) takes `FOR SHARE` on the class row and refuses a terminal attendance write on a cancelled group class (`GCSC2_CLASS_CANCELLED`). (3) Appointment-side guard `appointments_02_guard_cancel_terminal_attendance` (`enforce_group_class_cancel_no_terminal_attendance()`, BEFORE UPDATE OF status, fires only for group_class and a transition into cancelled, SECURITY DEFINER, trigger-only, no EXECUTE for any tenant role) refuses a direct `appointments.status = 'cancelled'` update when terminal attendance exists (`GCSC2_ATTENDANCE_RECORDED`). Locking: the UPDATE's own row lock (taken before the BEFORE UPDATE trigger fires) conflicts with the attendance guard's `FOR SHARE`, so no self-lock was added and the trigger writes nothing. Locked invariant: for canonical group classes, `appointments.status = 'cancelled'` and `attendance_records.status IN ('attended','no_show')` never coexist, across the RPC, a direct appointment UPDATE and a terminal attendance INSERT/UPDATE. **Concurrency statement (precise):** the invariant is enforced for DanceFlow's actual PostgREST/RPC execution model, which runs at READ COMMITTED; no stronger REPEATABLE READ guarantee is claimed (the repository sets no isolation level and has no direct Postgres connections). Never touched by cancellation: attendance records, package/membership usage, credits, series identity (`group_class_series_id`, `series_occurrence_index`, `occurrence_original_start`, `series_overridden_fields`), neighbouring occurrences, the series row, legacy Events.

**Released, application:** `cancelAppointmentAction` delegates any group class to a single `cancelCanonicalGroupClass` path before any generic mutation (shared with `cancelGroupClassAppointmentAction`), which enforces broad-staff authority, loads the class server-side, no-ops an already-cancelled class, maps RPC outcomes to fixed copy, and sends the existing push only when booked attendees were actually cancelled; usage clearing never runs for group classes. A class-specific cancel form (this class only, truthful consequence copy, no requester/reason/charge/scope) is used on the appointment detail page and schedule list, the calendar drawer links classes to it, terminal-attendance classes show no Cancel on the detail page, Delete is hidden for series occurrences, and the staff attendance actions show fixed copy for the cancelled-class refusal. Instructors cannot cancel classes.

**Evidence (DEV; authenticated PROD smoke omitted):** S1C-2 SQL suite 67/67; real two-session concurrency harness 25/25 across 8 scenarios (RPC and direct-update paths, each attendance-first and cancel-first, each with attendance INSERT and UPDATE; no deadlocks or lock timeouts; every final state is either "class not cancelled with terminal attendance" or "class cancelled with no terminal attendance"); schedule/lib app tests 597; prior broader app evidence 2239 tests / 185 files; TypeScript clean; rollback and reapply verified twice; DEV cleanup confirmed no synthetic S1C-2 data remained. PROD post-migration verification: the cancellation RPC matched the reviewed DEV candidate (normalized body md5 `b8d7cb9709fb5a26b5b53b8c579d451d`, SECURITY DEFINER, `search_path=public`, ACL postgres plus authenticated); both guard functions matched DEV (SECURITY DEFINER, volatile, `search_path=public`, no EXECUTE for authenticated, anon or service_role); both new triggers existed and were enabled; 11 appointment triggers and 7 attendance triggers in total, all enabled; appointments 203 rows, attendance_records 24 rows, appointment_attendees 0 rows and client_membership_usage 1 row, all fingerprints unchanged; zero cancelled group classes with attended/no_show attendance. Public verification: `www.idanceflow.com` served the promoted deployment, `idanceflow.com` redirected to www, the homepage and `/login` returned 200, and signed-out `/app/schedule` redirected to `/login`. Rollback: the app first (`dpl_826bbGgRmgu6WzPwcQuGkeJdb3XN`); the rollback SQL (`rollback/20261016090000_gcsc2_group_class_cancel_safety_rollback.sql`) removes both guard triggers and functions and restores the exact pre-S1C-2 RPC body, and is not required for an app rollback. The stale `gc1_2` SQL test fixture drift is pre-existing and unrelated to S1C-2.

**Release note (permanent):** Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.

Boundaries unchanged: this-and-future series editing, whole-series editing and cancellation, and series status behavior remain later S1C; already-queued reminder invalidation for cancelled classes was delivered narrowly in GC-S1C-3 and broader reminder/notification work remains S1E (GC-R1 already excludes cancelled appointments from new generation); the database capacity-floor and series-occurrence delete guards were delivered in GC-S1C-3. Legacy Events remain active; Phase 5 remains PARTIAL; depleted-credit decision #10 remains OPEN; S1D-S1F remain future.

**PHASE 5 STATUS NOTE (GC-S1C-3):** **GC-S1C-3 (database authority backstops) — RELEASED AND CLOSED (2026-10-04); GC-S1C overall remains INCOMPLETE.** PR #151 (reviewed head `fd0d9eab9d9a82557abb556ac89494f47c352d48`) squash-merged to main `5c87775ddb7d750e95f4bf5f70d6cbc2e755d1ea` (parent `57fdfc19d748ebd340c1371e7c2e43020d8a48d7`, tree `8a7c6d4f0ee35027233516f6fd5a8949dc73b0df`, identical to the reviewed candidate tree; no AI attribution in the squash commit; feature branch `gc-s1c-3-db-authority` retained). **Migration `20261017090000_gcsc3_group_class_db_authority.sql` (sha256 `052f1cccf0b152b1fb2ea1de145d9642950c782d5f1057744144c0a61ca12a43`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) and verified BEFORE the application promotion** (2026-10-04, about 16:07 UTC): the four new triggers and four new functions are present and enabled with the reviewed security/search_path/execute posture, the live roster-capacity function body md5 is `0fdbc884e11b638613655078026058cf` (it was the GC-3.1 body, `ff880047257ff0a3debb6b59364b4e13`), the S1C-2 objects and the cancellation RPC are unchanged, and PROD data fingerprints were identical before and after (203 appointments, 24 attendance records, 404 notification deliveries, 0 group classes, 0 series, 0 attendees). qfem deployment `dpl_4DDsS9z4VcZd22oU8SXNLZ2MhFnT`, built from the exact squash SHA, was promoted 2026-10-04 at 16:16:52 UTC (the Vercel production alias-assignment time; www and apex serve it; rollback target `dpl_9M8Gn9p9YELRrKr53gFs9Q4q7CoS`, app first; the rollback SQL `rollback/20261017090000_gcsc3_group_class_db_authority_rollback.sql` is retained and was not run; the previous application works against either database state). Public signed-out verification passed.

**Released behavior (database authority):** (1) canonical group-class cancellation is RPC-only for tenant roles: a direct tenant-role (assigned instructor or broad staff) UPDATE of a group class to `cancelled` is refused (`GCSC3_CANCEL_VIA_RPC_ONLY`); `cancel_group_class_appointment`, service_role and the migration owner are unaffected, and a class with recorded attended/no_show attendance still receives the S1C-2 refusal first; (2) a booked enrollment into a cancelled class is refused by the authoritative roster-capacity trigger (`GCSC3_CLASS_CANCELLED`) for staff enrollment, portal self-enrollment, raw attendee inserts and re-booking, under the same class-row lock that already serializes capacity and cancellation; (3) roster capacity cannot be lowered below the booked count (`GCSC3_CAPACITY_BELOW_BOOKED`), while increases, setting it to the booked count, clearing the limit and edits that leave capacity unchanged still work; (4) tenant-role deletion of a series occurrence is refused (`GCSC3_SERIES_OCCURRENCE_DELETE`) independently of the enrollment-policy foreign key, and standalone and non-class deletes are unchanged; (5) pending group-class client reminders are marked cancelled when the class is cancelled, and `/api/notifications/send` revalidates the class immediately before sending (a cancelled class is suppressed, an unreadable class is deferred rather than sent, private-lesson reminders are unchanged); (6) the new database codes map to fixed safe copy. The S1C-2 terminal-attendance invariant and single-occurrence editing, including the assigned instructor's own edits, are unchanged. The only remaining reminder race, the milliseconds between the last send-time check and the email provider call, is accepted. Evidence (DEV; authenticated PROD smoke omitted): new SQL suite 57/57, S1C-2 suite 69/69 (updated for RPC-only cancellation), S1A 79/79, S1B 108/108, two-session harnesses S1C-3 13/13 and S1C-2 25/25 with no deadlocks, 725 application tests across the affected suites, TypeScript clean; focused review and PROD preflight clean. Four older SQL suites (gc1_1, gc1_4a, gc3_1, fc1b5d2) have pre-existing fixture drift, identical before and after this change.

**Release note (permanent):** Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.

**PHASE 5 STATUS NOTE (GC-S1C-4):** **GC-S1C-4 (series cancellation + lifecycle authority) — RELEASED AND CLOSED (2026-10-04); GC-S1C overall remains INCOMPLETE.** PR #153 (reviewed head `5315981e5a09aa1544a6475645353ac65eae7836`) squash-merged to main `59562207c574baa566ac23adbb2d0ca7540be8d9` (parent `af44351957ad4426508c0d47a59f461cd3050839`, tree `581781aefd10d78f5a3ed20cd77a5867a368d39c`, identical to the reviewed candidate tree; no AI attribution in the squash commit; feature branch `gc-s1c-4-series-cancellation` retained). **Migration `20261018090000_gcsc4_series_cancellation_lifecycle.sql` (sha256 `39decdc800471f789b7dfc9ae55aa3c434bca55216f8d5a68d88b281eb2fb505`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) 2026-10-04 17:47:07–17:47:09Z and verified BEFORE the application promotion**: the five new functions and the reactivation trigger are present with the reviewed security/search_path/execute posture, the S1C-2/S1C-3 objects and the cancellation RPC are unchanged, the roster-capacity function md5 is still `0fdbc884e11b638613655078026058cf`, and PROD application data was identical before and after (203 appointments, 24 attendance records, 0 group classes, 0 series, 0 attendees, 401 sent / 3 failed notification deliveries, 413 outbound deliveries); the migration changes no data. qfem deployment `dpl_4iT62F5DSysrJdPpgfotp8br3YVn`, built from the exact squash SHA, was promoted 2026-10-04 at 18:00:42 UTC (www and apex serve it; rollback target `dpl_4DDsS9z4VcZd22oU8SXNLZ2MhFnT`, app first, then the database only if required; the rollback SQL `rollback/20261018090000_gcsc4_series_cancellation_lifecycle_rollback.sql`, sha256 `8edcd69aa763697c3a00718ede4c0a791cff1c151475d41e36551793078dfdcb`, is retained and was not run). Public signed-out verification passed.

**Released behavior (series cancellation and lifecycle):** (1) "This class" continues to use the canonical single-occurrence cancellation; (2) "This and following classes" (`cancel_group_class_series_from`) cancels the selected occurrence and every later one through one database transaction that reuses the canonical single-occurrence cancel, so the S1C-2 terminal-attendance rule, the S1C-3 guards and S1C-3 reminder invalidation apply unchanged; the server derives the series and occurrences from the selected appointment and the client supplies only the appointment id; there is no "Entire series" scope; (3) series-level cancellation is broad-staff only (platform admin, owner, admin, front desk); assigned instructors gain no series-level authority and keep single-occurrence edit authority; (4) earlier, historical (attended, no-show or already ended), terminal-attendance and already-cancelled occurrences are preserved (a class that gains attendance mid-run is preserved and reported); occurrence identity and index are preserved, no appointments are deleted, and no credits, usage or attendance are rewritten; (5) a read-only preview RPC supplies the confirmation summary (classes and dancers affected); (6) a direct tenant-role `cancelled -> scheduled` (or any move out of cancelled) UPDATE of a group class is refused (`GCSC4_CANCELLED_CLASS_REACTIVATION`); service_role and the definer RPCs are unaffected; there is no reactivation lifecycle, which also removes the reminder-dedupe edge carried from S1C-3; (7) one consolidated branded email per distinct address and one push per eligible linked account are produced for the attendees actually affected, each listing only that recipient's own cancelled classes; no SMS was added; delivery is best-effort after the canonical cancellation commits and a delivery failure cannot undo it; S1C-3 reminder invalidation and send-time suppression remain authoritative; (8) all reachable errors map to fixed safe copy. Evidence (DEV; authenticated PROD smoke omitted): new SQL suite 56/56, S1C-2 69/69, S1C-3 57/57, S1A 79/79, S1B 108/108, two-session harnesses S1C-4 18/18, S1C-3 13/13 and S1C-2 25/25 with no deadlocks (plus an ad hoc mid-run-attendance preserve test), 21 new application tests, TypeScript clean; focused review and PROD preflight clean.

**Release note (permanent):** Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.

**SERIES LIFECYCLE RULE (canonical — binds GC-S1C-5 and every future series-status reader):** stored `group_class_series.status` is NOT by itself sufficient to determine the user-facing lifecycle state. Stored values are only `active` and `cancelled`; "ended" is derived and never stored; there is no archived, paused, reactivated or completed state and none may be added without a roadmap decision. Current behavior: an active series with future active occurrences is active; a series with no future occurrences because it has elapsed is ended (derived); a canonical this-and-following cancellation that leaves no remaining future active occurrence stores `cancelled`; **if every remaining occurrence is cancelled individually, the stored status may remain `active`.** Any future series-status reader or UI MUST therefore derive the truthful lifecycle from occurrence state and must not blindly display stored `active`. No application surface reads the stored series status today.

**Carried non-blocking follow-ups (not launch blockers; S1C-4 is not reopened):** (a) **Terminal-anchor UX:** when the viewed occurrence has terminal attendance, the cancellation control is hidden; staff can open the next eligible occurrence and obtain the same canonical result; an optional future UX improvement, not a correctness defect. (b) **Consolidated email wording:** the email uses the selected occurrence's class title; cosmetic. (c) **Best-effort notification delivery:** email and push are queued after the canonical commit, so a process failure between commit and queueing could lose the notification; accepted existing architecture. (d) **Future DB writer lock discipline:** code that updates the same series occurrence more than once in one transaction must respect series-first lock ordering (an artificial double-update deadlock was found in focused review; no current production path exhibits it).

**PHASE 5 STATUS NOTE (GC-S1C-5):** **GC-S1C-5 (this-and-following series editing) — RELEASED AND CLOSED (2026-10-04). It was the final planned GC-S1C slice, so GC-S1C is now COMPLETE / RELEASED (S1C-1 through S1C-5).** PR #155 (reviewed head `2e68b87ceba101f3a5dbf67351e8c2bc5dbabf1e`) squash-merged to main `a14596356467157570276d74be944e1b4a2df46c` (parent `c9f8c7c902c28d73436c30450d43e6a4833bb4f5`, tree `d3a2b1481890dc70b2f5249508c9587b0eaa275a`, identical to the reviewed candidate tree; no AI attribution in the squash commit; feature branch `gc-s1c-5-series-edit` retained). **Migration `20261019090000_gcsc5_series_following_edit.sql` (sha256 `1d3f7663c427fcbc9884121be9a393bbf1a05ef88e49037cf7078850e004531c`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) 2026-10-04 19:45:55–19:45:57Z and verified BEFORE the application promotion**: the lineage column, same-studio foreign key, self-reference check, unique-successor index, idempotency ledger (RLS on, no tenant privileges), the helpers, the two new RPCs and the two lineage-aware S1C-4 cancel RPCs are present with the reviewed security posture; every S1C-2/S1C-3/S1C-4 guard and the roster-capacity function (md5 `0fdbc884e11b638613655078026058cf`) are unchanged; PROD application data was identical before and after (203 appointments, 24 attendance records, 0 group classes, 0 series, appointment fingerprint `23eddb05dd78c009a3a4daf1b2ff5eb6`). qfem deployment `dpl_DjRfdxBUZFUt4kXVaGqBrBy6hfe3`, built from the exact squash SHA, was promoted 2026-10-04 at 20:05:31 UTC (www and apex serve it; rollback target `dpl_4iT62F5DSysrJdPpgfotp8br3YVn`). Signed-out production smoke passed; the migration is immutable for this release.

**Released behavior (series editing):** (1) the scope choice is "This class" (the unchanged S1C-1 single-occurrence editor) or "This and following classes" (no "Entire series"); (2) "This and following" edits title, instructor, room, location, maximum students, start time of day and length; recurrence shape, class date, notes and enrollment policy are not part of it; (3) it is broad-staff only (platform admin, owner, admin, front desk) while assigned instructors keep single-occurrence editing only; (4) an edit beginning at occurrence N moves N and the later occurrences to a **successor series** (`split_from_series_id`, a linear predecessor chain) by re-pointing the existing appointment rows: appointment ids, occurrence indexes, rosters, attendance, usage, credits and enrollment policies are preserved, and nothing is deleted, recreated or renumbered; cancelled, historical and terminal-attendance occurrences keep every value; (5) **customized occurrences** keep their values by default (Preserve); an explicit Overwrite replaces only the edited fields; the bulk edit is expressed against the series definition so the selected class's own customized value can be propagated to the following classes; override flags stay truthful (cleared when a class ends up equal to the new series value, kept when a different customized value is preserved, untouched for fields outside the edit); (6) **Reset customizations to series values** is an explicit per-field-group action on a customized class; the existing RPC has one request-level overwrite switch, so selecting Reset forces Overwrite for the request: the reset groups return to the series value, customized following classes in those groups are returned too, and any other field edited in the same request follows the same overwrite semantics; the Review summary names the affected fields; (7) Review then Apply is protected against stale state (any change to values, the Preserve/Overwrite choice or the reset selection requires a new Review, and Apply re-derives all state in the database); (8) apply is one atomic transaction that revalidates the capacity floor and schedule conflicts against the database state visible to it, is idempotent through a request ledger (a repeated request id replays the stored result; a different request with the same id is refused), and uses series-first lock ordering; (9) S1C-4 "this and following" cancellation is lineage-aware (it spans successor segments; behavior for a never-split series is unchanged); (10) no edit notification of any kind is sent. The series lifecycle rule above is honored: nothing renders a stored status and anything not `active` is refused for editing. Evidence (DEV; authenticated PROD smoke omitted): S1C-5 SQL suite 149/149, S1C-4 56/56, S1C-3 57/57, two-session harnesses S1C-5 30/30 and S1C-4 18/18 with no deadlocks, 3,706 application tests before the final app-only reset change plus 60/60 and 691/691 focused afterwards, TypeScript clean; focused review, re-review and PROD preflight clean.

**Release note (permanent):** Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.

**Durable S1C-5 semantics for future engineers:** (a) `split_from_series_id` is the **positional predecessor segment**, not immutable creation provenance: editing an earlier segment re-parents a later successor beneath the new one, and the unique-successor index keeps the lineage linear; (b) an edit from the first occurrence of a segment edits that series definition in place rather than leaving an empty predecessor (occurrence rows keep their identity either way, but the previous series-level defaults of that segment are not retained); (c) the predecessor's recurrence end rule (`ends_on` / `occurrence_count`) is trimmed to what it still holds; (d) a time edit applies the new time of day in the series time zone to each occurrence's own local date, and a time that does not exist on a daylight-saving transition day is normalized forward (S1B-compatible); (e) **rollback:** the database rollback refuses once any successor series or edit request exists; after real adoption the strategy is app rollback first and a database forward-fix, and the S1C-4 app tolerates the S1C-5 schema.

**Follow-ups and their destinations (no new backlog created):** group-class edit notifications, reminder rescheduling when a class time changes, and the conflict-integration items (the inherited external-writer scheduling race, SQL versus TypeScript conflict-rule parity) belong to **GC-S1E** (reminder/calendar/conflict integration). The S1C-4 polish follow-ups (terminal-anchor cancel control, consolidated-email class title) belong to **GC-S1F** (security, polish and closeout). The first-occurrence in-place tradeoff, positional lineage and DST-gap normalization are accepted characteristics recorded above, not work items.

**PHASE 5 STATUS NOTE (GC-S1D-1):** **GC-S1D-1 (roster management UX) — RELEASED AND CLOSED (2026-10-04); GC-S1D overall remains IN PROGRESS / PARTIAL.** PR #157 (reviewed head `fe61c6b5c970f53843400e78d85c4f8b0dc23097`) squash-merged to main `b8e8397fc1f5a6facdb81c9f2c10115c50911e37` (parent `d35df2be5402f8209fa180006285d3758eec116d`, tree `ad1919acae200202a737f72b48cdc95e63eac422`, identical to the reviewed candidate tree; exactly the 16 reviewed files; no AI attribution in the squash commit; feature branch `gc-s1d-1-roster-ux` retained). **Migration `20261020090000_gcsd1_attendee_removal_terminal_attendance_guard.sql` (sha256 `be2ffc30741beca158b137fe3e4fada1b4cfecd9e218ebed686f50bd908bcddf`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) 2026-10-04 21:56:03–21:56:04Z and verified BEFORE the application promotion** (one function and one trigger created and one function replaced; no application-data change: PROD counts and fingerprints identical before and after; every S1C guard unchanged). qfem deployment `dpl_DfZdFAU8eTY6QkwGKijhR383EYZy`, built from the exact squash SHA, was promoted 2026-10-04 at 22:06:44 UTC (www and apex serve it; rollback target `dpl_DjRfdxBUZFUt4kXVaGqBrBy6hfe3`, app first, then a database forward-fix). Signed-out production smoke passed (apex redirect, homepage, `/login`, `/discover`, signed-out `/app/schedule` redirecting to login, assets from the new deployment). **Authenticated production smoke was intentionally omitted under the permanent release note above.**

**Released behavior (roster management):** (1) the group-class detail page is now the natural roster-management surface: a roster panel with capacity context (booked / capacity, open spots, why a class is closed to new dancers); (2) **Add dancer** and **Remove** work in context without leaving the class, with clear success and failure messages; (3) broad staff (platform admin, owner, admin, front desk) see funding context and can choose a funding source when adding; assigned instructors keep single-class roster authority scoped to their own classes and do not see funding detail; (4) each dancer shows attendance context with navigation to the existing attendance workflow (attendance recording itself is unchanged); (5) the existing Enroll Student workflow is retained as a fallback and now honors a preselected class; (6) **occurrence scope only, no series scope yet.**

**Durable roster integrity rule (database-authoritative):** an attendee who has **terminal** attendance for that same class and client cannot be removed from the roster. Terminal attendance for this rule is `attended` and `no_show`; `checked_in` and `registered` are non-terminal and a checked-in dancer can still be removed. The rule applies to the `booked` → `cancelled` transition for every writer (including a direct table update), and the removal path now takes the class-row lock so removal serializes with attendance writes (same lock order as class cancellation). Error prefix `GCSD1_ATTENDEE_ATTENDANCE_RECORDED`. Evidence (DEV; authenticated PROD smoke omitted): S1D-1 SQL suite 31/31, two-session harness 7/7, S1C-2 through S1C-5 SQL and harness regressions unchanged, 3,764 application tests, TypeScript clean; focused review and PROD preflight clean. **This backstop is complete and is not an open item.**

**PHASE 5 STATUS NOTE (GC-S1D-2):** **GC-S1D-2 (series enroll / remove) — RELEASED AND CLOSED (2026-10-04); GC-S1D overall remains IN PROGRESS / PARTIAL.** PR #159 (reviewed head `90002e012ee4c568f8e2a6c6df8f23236bd3d25a`, two commits `efcecea` and `90002e0`) squash-merged to main `af48e2e2d83652c1f3677a4f945ea648b4f787c6` (parent `5a50dad558ff9682d55422ed6669842379d45b10`, tree `68b2f36511836231a547d808be76f16faa4f3ce2`, identical to the reviewed candidate tree; exactly the 14 reviewed files; no AI attribution in the squash commit; feature branch `gc-s1d-2-series-enroll-remove` retained). **Migration `20261021090000_gcsd2_series_enroll_remove.sql` (sha256 `806bce1bc5b251438f0e7df668fbbec147c559ce80ef7c83d24a745cdc287725`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) 2026-10-04 23:13:01–23:13:03Z (exit 0, applied once) and verified BEFORE the application promotion**: it is function-only (nine functions: four public RPCs and five internal helpers with no tenant grants; no table, index, policy or trigger) and changed no data (PROD had no series, group-class or attendee rows; counts and fingerprints were identical before and after; every released helper, trigger and guard is unchanged). qfem deployment `dpl_BsKFEAgtDNVqRJq8NUJ6dQiqhuat`, built from the exact squash SHA, was promoted 2026-10-04 at 23:24:41–23:24:48 UTC (rollback target `dpl_DfZdFAU8eTY6QkwGKijhR383EYZy`, app first, then a database forward-fix; the DB rollback artifact `rollback/20261021090000_gcsd2_series_enroll_remove_rollback.sql`, sha256 `6da6f2b2d90ea00cae5bbfcfe58d9da82df17e8ef2fc0708dafd1731f4330ce2`, drops only the nine functions and was not executed). Signed-out production smoke passed and the post-release read-only database check was clean. Authenticated production smoke was intentionally omitted under the permanent release note above.

**Released behavior (series roster operations):** (1) from a canonical group-class occurrence, broad staff choose "This class" (the unchanged S1D-1 single-occurrence path, still the default) or "This and following classes"; (2) "This and following classes" starts at the selected occurrence, traverses later occurrences across the S1C-5 successor lineage (derived in the database from the selected occurrence), never backfills earlier occurrences and never touches an unrelated series; it uses ordinary per-occurrence `appointment_attendees` rows, so there is no second roster or enrollment truth source and no new table; (3) series enroll / remove is **broad staff only, enforced in the database** (the four RPCs `preview_group_class_series_enrollment`, `enroll_group_class_series_from`, `preview_group_class_series_removal`, `remove_group_class_series_from`); assigned instructors keep own-class single-occurrence authority and gain no series authority through the UI or a direct RPC; (4) **enrollment is atomic (D1)**: a capacity, funding-type-policy, funding-eligibility or membership-allowance failure, or an existing enrollment with different funding, on any otherwise-enrollable class blocks the whole operation and commits nothing, and the result names every affected class and why; cancelled, ended and terminal-attendance (attended / no_show for that dancer) occurrences are skipped and reported and never block; an already-enrolled class with the same funding is reported and left alone (idempotent, no duplicate rows); different existing funding is never overwritten; the funding choice is made once and applied to every class, packages / pay-as-you-go / comped keep per-class semantics with nothing reserved or consumed at enrollment, and finite memberships are checked per class cumulatively; Decision #10 is untouched; (5) **removal** cancels the dancer's ordinary booked rows from the selected occurrence on: earlier occurrences are untouched, attended / no_show occurrences are preserved and reported, a checked_in dancer remains removable, attendance records and package / membership consumption are unchanged, no credit is restored, and the S1D-1 terminal-attendance guard remains authoritative; (6) portal / student enrollment stays occurrence-based and enrollment-policy bulk editing is not part of S1D-2.

**Durable preview / concurrency notes for future work:** preview and apply share one authoritative eligibility path: enrollment preview is a transactional trial enrollment that always rolls back, and the attendee validators are transactional BEFORE triggers with no external or non-transactional side effect (verified in DEV and PROD); apply independently re-evaluates every condition under locks, and an optional expected count refuses a stale preview ("changed"), so a preview is advisory and never the correctness authority. Series operations lock series-first (the selected occurrence's series re-read once locked, successors in chain order, the funding membership, then class rows in occurrence order, attendee rows last), which is compatible with S1C-4 cancellation, S1C-5 split / edit, the S1D-1 attendance / removal serialization, capacity races and the single-class membership-then-class order.

**UX result:** series scope is part of the S1D-1 roster workflow (no separate page); single-class remains the default and fast path; a series operation shows a compact preview before confirmation in which skipped classes and blocking classes are distinct, a blocking result states that nothing will be partially enrolled, and a success summary reports the counts; a **full selected occurrence stays reachable** for the series workflow ("This class" is disabled and explained, "This and following classes" previews the full anchor as a capacity blocker, and the anchor is never silently skipped or shifted); a dancer already booked in the selected occurrence can be added to later eligible occurrences; the removal preview reports terminal-attendance classes that remain.

**Evidence (DEV; authenticated PROD smoke omitted):** S1D-2 SQL suite 80/80; two-session harness 28/28 (capacity races, attendance versus removal, split versus enroll, cancel versus removal, membership lock order both ways) with no deadlocks; S1D-2 application tests 40 and S1D-1 application tests 38; full Vitest 3,804/3,804; TypeScript clean; no new lint findings (the existing findings in the touched schedule detail page are unchanged); the S1D-1 31, S1C-2 69, S1C-3 57, S1C-4 56, S1C-5 149, S1A 79 and S1B 108 SQL regressions and the S1D-1 / S1C-2..5 harnesses clean; focused release review and PROD preflight clean.

**PHASE 5 STATUS NOTE (GC-S1D-3):** **GC-S1D-3 (series enrollment settings) — RELEASED AND CLOSED (2026-10-05). It was the final planned GC-S1D slice, so GC-S1D is now COMPLETE / CLOSED (S1D-1 through S1D-3).** PR #161 (reviewed head `7949ba7e53c189418e2c79709d299f0e7c91e71c`, two commits `e7ba42f` and `7949ba7`) squash-merged to main `90afc405b2e01423d17d1238f074e85d26cbf6b0` (parent `c9537e8eb89e5eee90fd6a430c327dbb6c8120fc`, tree `9bdacf6627bc8673fb131e0374408b761cbbf9e5`, identical to the reviewed candidate tree; exactly the 11 reviewed files; no AI attribution in the squash commit; feature branch `gc-s1d-3-series-enrollment-settings` retained). **Migration `20261022090000_gcsd3_series_enrollment_settings.sql` (sha256 `5fe70a0639bcf96dba74811369299d49acfc0d1d5e0d1c3f86e30ddf67615fbe`) was applied to PROD (`hvsujyfbftfffxpfmlpb`) 2026-10-05 00:43:41–00:43:42Z (once, transaction committed) and verified BEFORE the application promotion**: it is function-only (exactly five functions: two public RPCs and three internal helpers with no tenant grants; no table, index, policy or trigger) and changed no data (PROD had no series, group-class or policy rows; counts and fingerprints identical before and after). qfem deployment `dpl_8viZUFNKqBWmiCmKgn3hpbujtt7P`, built from the exact squash SHA, was promoted 2026-10-05 at 00:55:48–00:55:56 UTC (rollback target `dpl_BsKFEAgtDNVqRJq8NUJ6dQiqhuat`, app first, then a database forward-fix; the DB rollback artifact `rollback/20261022090000_gcsd3_series_enrollment_settings_rollback.sql`, sha256 `4a3fd805c330a79b8ef6be334eac0bd346262407ac4dfac48128ea86198fec72`, drops only the five functions and was not executed). Signed-out production smoke passed and the post-release read-only database check was clean. Authenticated production smoke was intentionally omitted under the permanent release note above.

**Released behavior (series enrollment settings):** (1) from a canonical group-class occurrence, on the class Edit page's enrollment-settings block, broad staff choose "This class" (the unchanged single-occurrence settings save, still the default) or "This and following classes"; (2) "This and following classes" begins at the selected occurrence as the cutoff anchor, follows the S1C-5 successor lineage (derived in the database from the selected occurrence), never backfills earlier occurrences and never touches an unrelated series; it updates the ordinary per-occurrence `group_class_enrollment_policies` rows, so there is no second policy store and no new table; (3) the settings covered are exactly the single-class editor's: publicly discoverable, student self-enrollment allowed, package funding accepted and membership funding accepted; each class's own direct_payment and manual_other funding entries and its direct_payment_amount are preserved; the series default columns on `group_class_series` are creation-time data, are not read by any enrollment behavior, and are not changed; (4) **no preserve-customization model and no policy-override tracking (D4)**: a later class whose settings differ is intentionally overwritten; classes that already match are not written; a class without a settings row gets one; (5) cancelled and ended classes (past, or marked attended / no_show) are skipped and reported and never block; **if the selected class itself is skipped it remains the cutoff anchor, is reported as skipped and is not mutated, the anchor is never shifted, and the later eligible classes still update**; (6) **atomic**: if any targeted class cannot take the settings (for example discovery or self-enrollment with no accepted funding source) nothing is changed and the preview names the class; (7) **authority**: series scope is broad-staff authority enforced in the database; assigned instructors gain no series-level settings authority and keep their existing single-class behavior; platform-admin access is the existing internal administrative authority of the settings table (its row-level security already names platform admin) and is not newly expanded by S1D-3; studio, series and lineage are server-derived.

**Durable preview / apply notes:** the compact preview shows how many classes will be updated, how many already match, what is skipped and what blocks, and states plainly that later classes with different settings will be changed to match; it is informative and apply is authoritative: apply re-derives the anchor, lineage, targets, current state and authority under locks (series-first, via the S1D-2 lock helper, compatible with S1C-4 cancellation, S1C-5 split / edit, S1D-2 roster operations and direct single-class settings updates), and an optional expected-change count refuses a materially changed preview ("changed") without mutation. Preview is a transactional trial that always rolls back; the policy table's only trigger is a BEFORE shape validator with no external or non-transactional side effect (verified in DEV and PROD).

**Evidence (DEV; authenticated PROD smoke omitted):** S1D-3 SQL suite 62/62; two-session harness 20/20 (races with series cancellation, series split, series enrollment, a direct single-class settings update and two concurrent applies) with no deadlocks; S1D-3 application tests 24 and the existing single-class policy tests 7; full Vitest 3,829/3,829; TypeScript clean; changed files lint-clean except one existing error on an untouched line of the edit form; the S1D-2 80, S1D-1 31, S1C-4 56 and S1C-5 149 SQL regressions and the earlier harnesses clean; the `gc3_2` instructor-assignability failure was reproduced with the S1D-3 functions removed and again after reapply, so it is a pre-existing fixture-level failure unrelated to S1D-3; focused release review and PROD preflight clean.

**S1D OWNER DECISIONS (canonical, locked 2026-10-04 — bound GC-S1D-2 and GC-S1D-3; do not reopen unless new implementation evidence shows one is impossible or unsafe):**
- **D1 — Series enrollment atomicity.** For "This and following classes": if any otherwise-enrollable target class is full, the whole operation fails atomically; if funding or eligibility fails on any otherwise-enrollable target, the whole operation fails atomically; the failure identifies the affected class(es). Inherently non-enrollable occurrences (cancelled, ended, or with terminal attendance) may be skipped and reported. No silently partial series enrollment.
- **D2 — Series authority.** Series-level enroll/remove is broad-staff only and is enforced in the database; assigned instructors retain their existing single-class enrollment/removal authority.
- **D3 — Portal.** Portal/student series self-enrollment is outside S1D; portal self-enrollment remains occurrence-based; GC-3.4 and GC-3.5 remain later phases.
- **D4 — Series enrollment settings.** Policy/settings may be applied to this-and-following eligible occurrences, with a preview of how many target occurrences currently differ. No preserve-customization model and no new policy override-tracking schema.

**Status of the S1D owner decisions after S1D:** D1 (atomic series enrollment) and D2 (broad-staff-only series authority, database-enforced) are implemented and released by S1D-2. D4 (series enrollment settings applied to this-and-following, previewed, no preserve-customization model, no override-tracking schema) is implemented and released by S1D-3. D3 remains the boundary: portal / student series self-enrollment stays outside S1D and portal self-enrollment remains occurrence-based (GC-3.4 / GC-3.5 are later phases). None is reopened.

**Follow-ups and their destinations (no new backlog created):** **GC-S1D-2** and **GC-S1D-3** are released (above); GC-S1D is complete. **GC-S1E (next):** enrollment/edit notifications and the reminder/calendar/conflict integration already assigned there (group-class edit notifications, reminder rescheduling when a class time changes, and the conflict-integration items). **GC-S1F:** polish and closeout items already canonically assigned there.

**GC-S1D status and what remains in Phase 5:** GC-S1C is COMPLETE / RELEASED. **GC-S1D (series enrollment and roster integration) is COMPLETE / CLOSED: GC-S1D-1 RELEASED / CLOSED, GC-S1D-2 RELEASED / CLOSED, GC-S1D-3 RELEASED / CLOSED. GC-S1E is NEXT; GC-S1F remains future and has not started.** Phase 5 remains PARTIAL: GC-S1E and GC-S1F, legacy Events group-class retirement (requires a production-data inventory first), multiple rooms/locations, class revenue reporting and the depleted-credit decision (#10, open) remain; completing S1D does not complete the Group Class program. Legacy Events remain active; GC-3.4 and GC-3.5 are Phases 6 and 7. Twilio and BR-6 status are unchanged. **Next engineering item: GC-S1E (reminder/calendar/conflict integration).** *(Superseded by the GC-S1E closeout below: GC-S1E is complete and GC-S1F is next.)*

**GC-S1E (reminder, notification, conflict and calendar integration) — COMPLETE / RELEASED (2026-10-05); GC-S1E-1 through GC-S1E-4 all RELEASED.** S1E-3's two migrations are live in PROD; S1E-1, S1E-2 and S1E-4 are application-only (S1E-4 has no SQL or migration).

- **GC-S1E-1 — Reminder integrity — RELEASED** (PR #163, squash `421331ef63e2621593daebe25f1042de646d7bc9`). Time-aware group-class reminder identity; stale reminders suppressed after a reschedule; reminders for removed attendees suppressed; A→B→A rescheduling is correct; cancellation authority preserved.
- **GC-S1E-2 — Group-class enrollment and change notifications — RELEASED** (PR #164, squash `5ab8bd94bdf879dd6473d7ff2fe45d98930b27db`). Branded HTML email plus push, no SMS. Automatic notices for material changes (date/time, instructor, room/location), consolidated This-and-following notices, dancer enrollment notices and dancer removal notices; notification idempotency; a mutation the database refuses or that fails sends no success or change notice.
- **GC-S1E-3 — DB-authoritative conflict enforcement — RELEASED** (PR #165, squash `0c7985e15f2a9979b607a2023d3768d65bf60450`; migrations `20261023090000_gcse3_group_class_conflict_authority.sql` and `20261023090100_gcse3_review_lock_order_and_studio_scope.sql`, live in PROD). One shared database conflict rule across the participating canonical writers: one-time create, series create, single-occurrence edit and S1C-5 This-and-following; deterministic instructor/room locking; studio-scoped resource validation; focused-review lock-order/deadlock remediation. **Release language: race-free among participating canonical writers.** DanceFlow scheduling is **not** described as globally conflict-proof; the remaining bounded external-writer races (ordinary lesson / floor-rental scheduling paths, the room-unavailable writer, the personal-block writer, privileged service-role/postgres writes) are intentionally outside S1E and are not reopened here.
- **GC-S1E-4 — Calendar verification / small hardening — RELEASED** (PR #166, squash `a8ea91d73174f81251ceaa05571f57ece7f3c8aa`; qfem `dpl_78dEg8zqXvkWZQ11TEnC1C3bgyr1`, rollback target `dpl_HNPqJwAyeWXixRMqKZiRWy5vcqKR`; no SQL, no migration). Google Calendar reconciliation was verified against canonical group-class behavior: the appointment id is the stable external identity, S1C-5 splits preserve external event identity, and cron and manual sync share one reconciliation path. **Defect fixed:** mapped Google events were deleted merely because the appointment aged out of (or sat beyond) the now→+90-day fetch window; they are now retained, while explicit cancellation / no_show / sync-disabled / other-instructor / deleted-appointment deletion remains, and a failed verification lookup retains the mapping instead of deleting blindly. The instructor ICS feed now emits canonical UTC instants (current writers store UTC instants derived from studio-local time), keeps the stable `{appointment.id}@danceflow` UID, and falls back to the external `location_name`, which precedes the room name. DST behavior verified. No immediate Google synchronization was added (about 30-minute reconciliation latency remains the accepted behavior). Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release.

**Bounded S1E-4 follow-ups (non-blocking; not S1F blockers and not expanded here):** (1) generic Google create→mapping-write failure: if Google event creation succeeds but the sync-item write fails, a later run may create a duplicate event (pre-existing, not group-class specific); (2) legacy wall-clock-as-UTC appointment rows (created before zone-aware writers, around mid-May 2026) may display offset in Google and ICS, and no historical normalization migration exists; (3) ICS `no_show` behavior (Google excludes no_show, ICS does not) is an unresolved product-semantic question; (4) the separate Events-table Google behavior remains outside Group Class S1E.

**GC-S1E status and what remains in Phase 5 (supersedes the earlier "S1E next" statements above):** GC-S1A, S1B, S1C, S1D and S1E are complete and closed; **GC-S1F — Security, polish and closeout is NEXT and NOT STARTED.** Phase 5 remains PARTIAL until S1F closes: S1F, legacy Events group-class retirement (requires a production-data inventory first), multiple rooms/locations, class revenue reporting and the depleted-credit decision (#10, open) remain. Legacy Events remain active; GC-3.4 (Phase 6) and GC-3.5 (Phase 7) are not part of Phase 5. Twilio and BR-6 status are unchanged. **Next engineering item: GC-S1F.** *(Superseded by the Phase 5 closeout below: GC-S1F is released and Phase 5 is COMPLETE / CLOSED.)*

**GC-S1F (security, polish and closeout) — RELEASED / CLOSED (2026-10-05); PHASE 5 — GROUP CLASS CANONICAL FOUNDATION — COMPLETE / CLOSED.** PR #168, squash `d39bf3f7e9eb18adb898f74d7954fa251c2ffa24` (parent `036e390cb1fbaba2a0b9d96895b42f5a605de424`, tree identical to the reviewed candidate); qfem `dpl_F6NpfGX6o9E7s9Dhisi4WMvKXBod`, rollback target `dpl_78dEg8zqXvkWZQ11TEnC1C3bgyr1`; no SQL, no migration. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release.

- **Security / authority:** a focused Group Class review found no new authorization defect. The attendance eligibility and studio-isolation backstop (`enforce_class_attendance_eligibility` plus attendance row-level security) was verified: a foreign-studio or non-enrolled client id cannot be recorded. Released broad-staff versus assigned-instructor boundaries are preserved. No new SQL or security model was required.
- **External self-enrollment:** the only external Group Class enrollment path that exists is client-portal self-enrollment (package credit or membership funded); no direct-payment public path exists yet (GC-3.5, Phase 7). Successful self-enrollment now produces the complete notification pair, only after the enrollment has committed: a **dancer confirmation** and a **studio operational email**. Refused, already-enrolled and failed paths send no success notice, and a notification failure never rolls back the enrollment.
- **Studio recipients (Group Class external self-enrollment notice only):** the enrolling studio's active owners, active admins and active front-desk users; duplicate addresses are deduplicated; the studio contact email remains the fallback when no applicable staff address exists; other studios' recipients are excluded; instructors are not added merely because they teach the class. Idempotent per attendee and address on the existing outbound delivery key. This is **not** declared a universal recipient rule for future notifications. The shared owner/admin helper used by other flows is unchanged.
- **Funding / payment copy:** the studio notice names the real funding source (package credit or membership) and never claims paid, purchased, payment received or an amount. Email only: no SMS, no studio push and no in-app notification row were added.
- **Dancer confirmation:** a self-enrolled dancer now reads natural wording ("You're enrolled in …") instead of staff-action wording. Staff-driven single enrollment and consolidated series enrollment semantics are unchanged.
- **Group Class UX / polish (Group Class surfaces only, not the whole application):** cancellation scope language clarified; canonical edit and cancel scopes remain **This class** and **This and following classes** (there is no "Entire series" edit scope); Group Class collapsible controls (Add dancer, class cancellation, Remove dancer, Mark No Show) now carry a visible chevron that changes when opened; one-time class create and single-class edit show visible success confirmation; the raw database error on one-time class creation is no longer exposed; missing class / appointment states show safe copy.

**Public Discovery notification rule (v2.11, preserved):** externally initiated Public Discovery purchases, registrations, enrollments and bookings generate a studio-side operational notification, tied to authoritative committed success; where payment is required, no success notice is sent before the relevant settled state is established; none for failed attempts, abandoned checkout, unresolved pending payment, previews, stale/refused operations or replays that created no new successful transaction. **The rule is RECORDED; at Phase 5 closeout only the Group Class portal self-enrollment path had implemented it.** (Later: GC-3.4C and GC-3.5-3 implement it for public Group Class enrollment and paid registration; see Phases 6 and 7.) Phase 6, Phase 7 and later public flows must carry it forward.

**Deferred / bounded, not Phase-5 blockers:** the Group Class studio notice is email-only; the generic (non-Group-Class) lesson cancel form has no chevron; the delivery-key uniqueness is part of the underlying notification infrastructure; the bounded S1E-4 Google, legacy-time and ICS concerns above remain bounded as recorded; GC-3.5 direct-payment enrollment remains Phase 7.

**Carried forward outside the closed Phase-5 foundation (not part of this closure and not Phase-5 blockers):** legacy Events group-class retirement (requires a production-data inventory of Event-based classes, sessions and registrations first; **legacy Events remain active**), multiple locations/rooms for group classes, group-class revenue reporting, and **open product decision #10 (depleted-credit behavior), which remains OPEN**.

**Phase 5 final state (supersedes the earlier "PARTIAL" and "S1F next" statements above):** S1A RELEASED / CLOSED; S1B RELEASED / CLOSED; S1C COMPLETE / CLOSED; S1D COMPLETE / CLOSED; S1E COMPLETE / CLOSED; S1F RELEASED / CLOSED. **Next: Phase 6 — GC-3.4 Public discovery and account linking (NEXT / NOT STARTED); then Phase 7 — GC-3.5 direct-payment enrollment (FUTURE / NOT STARTED).** Phase order is unchanged. Twilio and BR-6 status are unchanged. **Next engineering item: GC-3.4.**

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** **Depleted-credit behavior** for group-class enrollment (open product decision #10); whether series stay appointment recurrence or get a dedicated model. **Still unresolved after GC-R1** (GC-R1 changes no enrollment or credit behavior).

**DEPENDENCIES:** Phase 4 (entitlements); precedes Phase 6 and 7. Phase 4 remains PARTIAL by open decision #8; that remainder (SMS, payroll, marketplace, ARIA placement) does not touch group classes, so Phase 5 proceeds under the explicit Phase 4 handoff recorded in Phase 4.

**WEB IMPLICATIONS:** Class scheduling/roster UX falls under Phase 17.

**MOBILE IMPLICATIONS:** Student class enrollment and check-in screens; Business app instructor roster/check-in.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Attendance and funding authority hardened; keep closed.

**BRANDING / POLISH CONSIDERATIONS:** Class pages should carry the studio identity and DanceFlow relationship consistently.

**DEFERRED / POST-LAUNCH ITEMS:** Depleted-credit product decision (see register).

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260908110000`–`20260913091100`; `src/lib/schedule/groupClassRoster.ts`.

---

## Phase 6 — GC-3.4 Public discovery and account linking

**STATUS:** COMPLETE / CLOSED (2026-10-07): GC-3.4A RELEASED / CLOSED; GC-3.4B COMPLETE / CLOSED (GC-3.4B-0 and GC-3.4B-1); GC-3.4C RELEASED / COMPLETE. See the release records below. Next: Phase 7 — GC-3.5.

**OBJECTIVE:** Public class discovery with safe account linking for students, guardians and dependents.

**PRODUCT INTENT:** A prospective student finds a class publicly, identifies themselves safely (self or dependent), and is linked to the right studio relationship without ambiguous or unsafe matching.

**PLATFORM PRODUCT RULE — studio-side notification for externally initiated Public Discovery transactions (recorded 2026-10-05; applies to all Public Discovery purchases, registrations, enrollments and bookings, not only Group Classes):** these transactions generally occur without internal staff involvement, so each one generates a studio-side operational notification. The notification is sent only after the underlying action has been successfully committed; where payment is required, it reflects the committed/settled transaction state appropriate to that flow. A successful purchase/registration notification is **not** sent for failed attempts, abandoned checkout, pending payment where completion is not yet established, previews, stale or refused operations, or replayed operations that did not create a new successful transaction. **Status: rule recorded.** The Group Class portal self-enrollment path implements it (GC-S1F, Phase 5: dancer confirmation plus a studio email to the enrolling studio's active owners, admins and front desk, only after the enrollment commits); **GC-3.4C (2026-10-07) implements it for public Group Class self-enrollment** (the same dancer confirmation + studio operational notice, only after a committed enrollment); no other Public Discovery surface has implemented it yet, and GC-3.4A browsing triggers nothing. Later Phase 6 / Phase 7 / Phase 21 public flows must carry it forward.

**COMPLETED CAPABILITIES**
- Student/guardian self-enroll RPC (`gc3d`, self and managed dependents) and portal SELECT (`gc3e`); portal schedule enrollment UI with tests.
- Student-identity library (links, lifecycle, portal connection state/context) with guardian/dependent references.
- Verified-email enforcement for email-based claims (LAUNCH-SEC-1C-B).
- **GC-3.4A (released 2026-10-06):** anonymous-safe public Group Class read model and public discovery pages (global Classes, studio class list, occurrence and series pages); read-only, no enrollment, linking or payment.
- **GC-3.4B-0 (released 2026-10-06):** identity-linking security prerequisite: verified-email proof for invitation accept/reject, no-write mismatch handling, conflict-resolution authorization fix, contained invitation-claim failures; no SQL.
- **GC-3.4B-1 (released 2026-10-06):** public class identity and linking flow (`/studios/{slug}/classes/{appointmentId}/register`): safe login return, verified identity, invitation-only linking, generic unlinked state, scoped dancer chooser, "Open Student Portal" ready state; no enrollment, payment or SQL. **GC-3.4B is COMPLETE / CLOSED.**
- **GC-3.4C (released 2026-10-07):** authoritative non-payment public Group Class self-enrollment on `/register` (server-side dancer reauthorization, canonical funding preview with authoritative revalidation, started-class and public-discoverability database guards, idempotent enrollment, post-commit notifications). **Phase 6 is COMPLETE / CLOSED.**

**REMAINING DELIVERABLES**
- ~~Public class and series discovery routes and pages (no `/classes` route exists).~~ — **DONE in GC-3.4A (read-only).**
- ~~Safe slug scheme for classes/series.~~ — **DONE in GC-3.4A:** appointment id and series lineage root id are the identity; the studio slug is routing context and redirects when wrong.
- ~~Enrollment from discovery (GC-3.4C): reuse of the released self-enrollment function, a started-class database guard, funding picker and no-entitlement state.~~ — **DONE in GC-3.4C.**
- ~~Identity-intent capture and ambiguous-match handling.~~ — **DONE in GC-3.4B-1:** the route is the intent; ambiguity collapses into one generic state.
- Link expiry and rate limiting — inspected in GC-3.4B: staff invitations expire after 7 days (older rows without an expiry do not), and rate limiting is the existing in-memory mechanism; stronger limiting is deferred (below).
- ~~Guardian/dependent handling on the public path.~~ — **DONE in GC-3.4B-1:** existing manageable relationships only, via a scoped chooser.
- ~~Linking public visitors to existing student identity.~~ — **DONE in GC-3.4B-1:** staff-issued invitations only.

**LOCKED DECISIONS:** The verified-email binding already released; from GC-3.4A, that anonymous public class output uses `location_name` only and never the internal room name; and, from GC-3.4B (owner decisions D1–D7), that automatic account linking uses only staff-issued invitations and never `clients.email` alone, that no-match, ambiguous and cannot-safely-link cases share one generic unlinked state with no existence leak, that the public path never self-creates a studio client record or a guardian/dependent relationship, that connection help uses the studio's existing public page (no persisted connection-request workflow), and that the GC-3.4B-1 ready state is "Open Student Portal" with no public enrollment.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** None currently identified for GC-3.4B (the public-path guardian/dependent rule and the ambiguity policy were decided in GC-3.4B, above).

**DEPENDENCIES:** Phase 5; shares public-discovery surface with Phase 21.

**WEB IMPLICATIONS:** New public routes; part of Phase 17.

**MOBILE IMPLICATIONS:** Student app class discovery and linking.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Identity matching is a high-risk surface; requires its own Security Review.

**BRANDING / POLISH CONSIDERATIONS:** Public class pages follow BR-4 presentation.

**DEFERRED / POST-LAUNCH ITEMS:** Bounded GC-3.4B identity items, not automatic GC-3.5 blockers (any SQL needs its own explicit gate): database/RPC treatment of duplicate open self invitations for one email in one studio (the claim fails closed today; GC-3.4B-0 contains the failure at sign-in); clearing the invitation token hash on the login-time claim; stronger rate limiting than the current in-memory mechanism. Separate bounded follow-up (pre-existing, not introduced by GC-3.4B; a product/security policy decision, not a GC-3.4C blocker, and not remediated here): a client marked inactive while an existing linked portal relationship remains active may retain portal access under the current portal authorization model. Under current canonical rules such a client, with a still-active booking-authorized relationship, may also self-enroll (GC-3.4C did not change this; a separate product/security policy decision, not an automatic GC-3.5 blocker). Known test debt (pre-existing, not repaired in GC-3.4): the legacy SQL suites gc1_1, gc1_2, gc1_4a, gc3_1 and gc3_2 fail during instructor-assignability fixture setup (guard added in #83); they do not invoke the GC-3.4C function.

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260913091200`, `20260913091300`; `src/lib/student-identity`. GC-3.4A: PR #170 and migration `20261024090000_gc34a_public_group_class_read_model.sql` (below). GC-3.4B-0: PR #172, no migration; GC-3.4B-1: PR #174, no migration; GC-3.4C: PR #176 and migration `20261025090000_gc34c_self_enroll_started_class_guard.sql` (below).

**GC-3.4A (public Group Class read model and pages) — RELEASED / CLOSED (2026-10-06); GC-3.4 closed with GC-3.4C (below).** PR #170, squash `da25423a6594d78c2438bb15a5437aefff4efd18` (parent `6e924815b9ee2f29a71aa66d4308cebf48a0cc60`, tree identical to the reviewed candidate); qfem `dpl_89h8nJfgm8GoTEtEKXS8ZeU8dWJF`, rollback target `dpl_F6NpfGX6o9E7s9Dhisi4WMvKXBod`. Migration `20261024090000_gc34a_public_group_class_read_model.sql` (sha256 `e08ddb42df7130bfafad0e094602a70313738917fc74360ca92a832055997e84`; rollback sha256 `5e00d551ffd1e407a5c024b571fa3b1b2daee390b5756687def4a814b9b0de29`) was applied to PROD once, from an isolated workdir, and verified before the application release: function definitions identical to DEV, no RLS policy, table ACL or data change. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release. Production currently has no public canonical Group Classes, so `/discover/classes` correctly renders its empty state; that is not a defect.

- **Public read model:** the first anonymous-safe public read surface for canonical Group Classes: two narrow functions, `public_group_class_occurrences` and `public_group_class_series`, plus two internal lineage helpers. All four are owned by `postgres`, SECURITY DEFINER and STABLE, with `search_path = pg_catalog, public`. The two public functions are executable only by `anon`, `authenticated` and `postgres`; PUBLIC and `service_role` have no execute; the helpers are owner-only. Appointments, enrollment-policy and attendee row-level security were **not** widened, and anonymous and authenticated callers receive the same narrow public contract.
- **Public data contract:** appointment and series identity, studio public identity, title, date/time, instructor name where allowed, the explicit `location_name`, capacity and spots remaining, and derived public / availability / enrollment states. **Never exposed:** roster or client identities, attendance, funding, policy internals, contact data, notes, accounting, series description and internal room names.
- **Public location privacy decision:** `location_name` is explicit public class-location copy; `room.name` is **not** automatically public and there is no room-name fallback for anonymous callers. When no `location_name` was supplied the public pages simply omit the location label. No room-publicity field was added.
- **Instructor privacy:** the instructor name appears publicly only for an active instructor with a public profile; private or inactive instructors never leak a name, and studio matching prevents a foreign-studio instructor from appearing.
- **Public eligibility:** a class appears publicly only when its own enrollment-policy row says publicly discoverable (no policy fails closed; nothing is inherited from series defaults or other occurrences), its studio is directory-listed with an active or trialing subscription, and the occurrence state fits the requested view. Listings contain only future, not-cancelled classes. A direct link may show a truthful cancelled or past state, but only while the occurrence itself is still otherwise publicly discoverable.
- **Capacity / state:** spots and capacity are derived in the database; only booked attendees consume seats and cancelled attendees do not; unlimited (null) capacity is supported; a full or over-booked class shows as full and never shows negative spots; an anonymous caller cannot make the database count seats for more than the clamped number of rows requested.
- **Routes and identity:** `/discover/classes`, `/studios/{slug}/classes`, `/studios/{slug}/classes/{appointmentId}` and `/studios/{slug}/classes/series/{seriesId}`. The appointment id is the stable occurrence identity and the series lineage root is the public grouping identity; title, time and location are never identity, and a wrong or outdated studio slug redirects to the canonical path.
- **Series / S1C-5:** occurrences remain the canonical enrollment units and series pages are read-only grouping surfaces. An S1C-5 split keeps every occurrence id and link, any series id in the lineage resolves the whole lineage, and a successor-series link redirects to the lineage root. Legacy Events are not used as the canonical Group Class source and stay separate.
- **Public UX:** Classes are a distinct discovery path (hub card, discover sub-navigation, and a "View Classes" link on studios that have public classes), separate from legacy Events. Class cards are intentionally simpler than Event cards, with one primary "View class" action, no login pressure and no funding detail. Signed-out users can browse everything. **There is no enrollment, no account linking and no payment in GC-3.4A**; the class page only says registration options are coming next.
- **Notification rule status:** GC-3.4A is read-only, so the Public Discovery studio-notification rule does not trigger yet, and anonymous browsing sends no notification. The Group Class portal self-enrollment path already implements the dancer + studio notification pair (GC-S1F); no other Public Discovery surface has implemented the rule.

**GC-3.4B-0 (identity-linking security prerequisite) — RELEASED / COMPLETE (2026-10-06); GC-3.4B closed with GC-3.4B-1 (below).** PR #172, squash `4a57883ca023355b2e7d0b7668b3002b0cc00b80` (parent `b54efa52da3bb9367df9c2540145221a8c5c3011`, tree `90dae827185447450c769d4951506cb66b5b6aa2`, identical to the reviewed candidate); qfem `dpl_ELwUfwoxJ8KWNfbJJ5yTkDtoK4mx` (promoted 2026-10-06 03:33:35–03:33:41 UTC), rollback target `dpl_89h8nJfgm8GoTEtEKXS8ZeU8dWJF` (application only). **No SQL or migration.** Signed-out production smoke passed. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release. Completed before any public identity flow is exposed:

- **Invitation proof:** accepting or rejecting a client invitation requires the invitation token plus the session's canonical verified email matching the invited email; the account's unverified email alone is not identity evidence.
- **Mismatch writes nothing:** a mismatched or unverified account holding a valid token changes nothing (no account recorded, no conflict transition, no token change) and receives the same refusal for every invitation state.
- **Conflict resolution:** the pre-existing authorization defect in staff "Link Matching Email Account" is fixed — a conflict row is never promoted to an authorized link (previously a mismatched account could become a linked guardian, parent or billing contact with booking authority). Only the verified matching account is linked, only for a conflict issued to that email, and the staff-issued relationship type is preserved.
- **Distinct intents preserved:** linking no longer supersedes or token-clears invitations of a different intent, and never reuses a pending invitation row issued to another mailbox.
- **Claim containment:** an invitation-claim failure no longer blocks sign-in (callback or password login); it is logged as a bounded code, nothing is reported as claimed, and no authorization is synthesized — portal and booking paths still deny without a real relationship.
- **Privacy and errors:** a handled invitation token shows only a generic state; a mismatched or unverified signed-in account sees no client, email or relationship detail; raw database errors are not shown to users; and a successful accept no longer lands on an error page (redirect handling corrected).
- **Historical PROD posture:** one aggregate-only, read-only PROD check found zero linked non-self relationships, zero apparent historical mismatches and zero non-self conflict rows holding an account; no historical remediation is required.
- **Notification rule:** GC-3.4B-0 performs no enrollment, so it adds no Public Discovery notification behavior; the recorded rule is unchanged.

**GC-3.4B-1 (public class identity and linking flow) — RELEASED / COMPLETE (2026-10-06); with it, GC-3.4B is COMPLETE / CLOSED.** PR #174, squash `9f74439cc05e6d8b1ee021d495238c6673df8937` (parent `2fdaf5ffe4e55a2da348e337bbe7966739c1c26b`, tree `6769eb33852688fd15826649b6db42f1262f05b8`, identical to the reviewed candidate); qfem `dpl_HssyAtYo8dBm8PjAoFZnAbzJCuo2` (promoted 2026-10-06 11:32:11–11:32:16 UTC), rollback target `dpl_ELwUfwoxJ8KWNfbJJ5yTkDtoK4mx` (application only). **No SQL or migration.** Validation: 4154 / 4154 tests. Signed-out production smoke passed. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release. The class-specific signed-out smoke (the class call-to-action and the signed-out `/register` redirect) could not be exercised because production currently has no public Group Classes; a signed-out `/register` for a nonexistent class correctly returned 404. This is recorded factually and is not a blocker.

- **Entry:** the public Group Class detail page remains auth-free; an upcoming class with open public enrollment links to the identity step `/studios/{slug}/classes/{appointmentId}/register` (full, staff-only, cancelled and past classes show truthful status instead).
- **Authentication and identity:** a signed-out registration intent returns safely through the existing login `next` to the same route; an unverified account stays behind canonical verified-email proof (verify-email preserving `next`); an account whose email is already bound but whose session predates the binding gets a safe sign-in-again path.
- **Linking:** staff-issued invitations only (the existing invitation claim); `clients.email` is never used for auto-linking, and no client, guardian or relationship is created or inferred. "Check again" only retries that existing safe claim, scoped to the class's studio and bounded by the existing rate limiter.
- **Privacy:** one generic state for every no-link / no-booking-authority case, identical across conditions, so no client or invitation existence is disclosed.
- **Dancer:** exactly one manageable dancer auto-resolves; several get a chooser scoped to the account's own manageable dancers at that studio; the dancer URL parameter is revalidated server-side on every request.
- **Ready state:** "Open Student Portal"; the portal independently authorizes its own relationship. Service-role reads are server-only and scoped to the session user and the class's studio.
- **Scope:** no Group Class enrollment, no payment, no SQL. GC-3.4B performs no enrollment, so it adds no Public Discovery notification behavior.

**GC-3.4B closure:** GC-3.4B — identity and linking — is **COMPLETE / CLOSED**: GC-3.4B-0 (security prerequisite) and GC-3.4B-1 (public identity transition) are both RELEASED / COMPLETE. The GC-3.4B-0 facts recorded above (verified-email invitation acceptance, the mismatch no-write rule, the historical conflict-resolution fix, preservation of the staff-issued relationship type, claim failures never blocking sign-in, generic handled-token privacy and the clean historical PROD posture) are part of this closure.

**GC-3.4C (public Group Class non-payment self-enrollment) — RELEASED / COMPLETE (2026-10-07); with it, GC-3.4 is COMPLETE / CLOSED.** PR #176, squash `e39fa4a694858cba00c39026f4a55e5d00dc5143` (parent `8de0dc8c122c95f6d01d2407f8c645affa6e620b`, tree `af05f7d8f4aab025b606ab3607b50154f7eb3d58`, identical to the reviewed candidate); qfem `dpl_6cHFofHxhDX7AHuMKqRhz7FUU9Bh` (promoted 2026-10-07 00:22:11–00:22:16 UTC), application rollback target `dpl_HssyAtYo8dBm8PjAoFZnAbzJCuo2` (roll back the application first; the SQL rollback only afterwards, if needed). Migration `20261025090000_gc34c_self_enroll_started_class_guard.sql` (sha256 `ac5f9aaa0f9c7d252a87467f1d039b9ebc595970fd276ec3ebb8847c16f9afc3`; rollback sha256 `aa16eae26412a4ad33e7ddee52ed80b6ecf2f6b16944caaccb5d16d6d2ea378f`, available and unused) was applied to PROD once, from an isolated workdir, on 2026-10-07 00:11:41–00:11:45 UTC after a clean read-only preflight; it replaces only `self_enroll_class_attendee` (PROD body fingerprint `c5edafd4915060533faca30a9376e2d2`; owner, SECURITY DEFINER, search_path and grants unchanged; no other function changed). Validation: 4199 / 4199 Vitest tests; the GC-3.4C and gc3_3 SQL suites pass on DEV. Signed-out production smoke passed. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure; authenticated behavior was instead validated in DEV/local before release. Class-specific signed-out smoke could not run because production still has 0 public Group Classes; this is recorded factually and is not a blocker.

- **Live:** public Group Class non-payment self-enrollment. `/register` remains the identity/enrollment boundary; the public class detail page remains auth-free.
- **Authority:** the acting dancer is reauthorized server-side on every submit, and the enrollment runs through the existing `self_enroll_class_attendee` on the user's own session.
- **Funding:** candidates come from the canonical preview path and the authoritative write revalidates the choice; one eligible source auto-selects, several require the user's choice; with none, nothing is enrolled and no payment starts (direct payment remains GC-3.5).
- **Class state:** started classes cannot be joined online (database guard; the page also hides Join); hidden / no-longer-public classes cannot be self-enrolled (the write re-checks public discoverability, which also applies to the portal path); cancelled and full outcomes are refused by the database.
- **Concurrency and idempotency:** capacity remains database-authoritative under the locked roster trigger; a duplicate enrollment creates nothing new, and "already enrolled" is treated as success.
- **Notifications:** the dancer confirmation and the studio operational notification are sent only after a committed new enrollment and are idempotent on that enrollment; no false payment wording.
- **Errors:** outcomes map to plain messages shared with the portal; no raw database errors surface.
- **Entitlements:** package debit timing is unchanged (attendance-time; nothing is reserved). Decision #10 remains open.

**GC-3.4 slice status:** **Phase 6 — GC-3.4 Public discovery and account linking — is COMPLETE / CLOSED (2026-10-07). GC-3.4A RELEASED / COMPLETE; GC-3.4B COMPLETE / CLOSED (GC-3.4B-0 and GC-3.4B-1); GC-3.4C RELEASED / COMPLETE.** Completed boundaries: **GC-3.4A** — public, read-only Group Class discovery; **GC-3.4B** — authentication, verified identity, safe client/account linking and authorized dancer resolution; **GC-3.4C** — authoritative non-payment Group Class self-enrollment. **GC-3.5 — direct-payment public Group Class enrollment (Phase 7) — is NEXT / NOT STARTED;** payment was not folded into GC-3.4C, and no Stripe checkout, seat holds, webhooks or reconciliation exist in GC-3.4. Public Discovery notification rule: GC-3.4C implements it for public Group Class self-enrollment (dancer confirmation + studio operational notice, only after an authoritative successful enrollment, existing recipient policy, no false payment wording). Decision #10 (depleted-credit behavior) remains OPEN: a package must have remaining > 0 at enrollment and is debited at attendance, nothing is reserved, so future enrollments can exceed eventual attendance credits. Legacy Events remain active and separate. *(Superseded by the Phase 7 closeout: GC-3.5 is COMPLETE / CLOSED and released; Phase 8 is next.)*

---

## Phase 7 — GC-3.5 Direct-payment Group Class enrollment

**STATUS:** COMPLETE / CLOSED (2026-10-07; released to production). GC-3.5-1, GC-3.5-2, REFUND-RECON-1, REFUND-RECON-2 and GC-3.5-3 are merged and released. Next: Phase 8 — Documents Center completion.

**OBJECTIVE:** Students pay directly (Stripe) to enroll in a group class, with seat holds and reconciliation.

**PRODUCT INTENT:** A class enrollment checkout that cannot oversell or leave orphaned payments.

**COMPLETED CAPABILITIES (released)**
- An unlinked, verified customer can register and pay online for a public Group Class. Self-registration only; no parent/dependent acquisition; no email auto-link to existing studio clients and no disclosure of one. Students already linked to the studio stay on the GC-3.4C Student Portal / credit path.
- Database-backed seat holds: one active hold per purchaser and class, with an authoritative server-snapshotted price; live holds count toward capacity and the final seat is decided by the database.
- Stripe Checkout on the studio's connected account (direct charge, no platform fee, USD, card only), attached to the hold before redirect; double-clicks reuse one Checkout path.
- Webhook-authoritative settlement. Account, session, PaymentIntent, amount and currency are verified against the hold, and browser return is display-only. A successful paid finalization creates the active studio client, the self relationship and the attendee.
- After settlement, one dancer confirmation ("Paid online") and one studio public-acquisition notification are sent.
- Conflicts (class full, cancelled, started, hold released or expired) create no client or attendee. They are refunded once, automatically, on the same connected account, and the durable conflict is kept. Refund-failure and refund-not-recorded staff notices are separate and deduplicated.
- Canonical refund reconciliation: every refund (Stripe-originated, staff-issued or checkout-conflict) reaches its business effects through `_apply_payment_refund_and_reevaluate`:
  - package settlement re-evaluation;
  - full Group Class refund before attendance cancels the enrollment and releases the seat;
  - partial refund keeps the dancer booked with payment status `partial`;
  - full refund after attendance or no-show records the refund and preserves history.
- Refund timestamp / accounting integrity: the RPC sets `refunded_at` when refund progress is applied, so the refund accounting entry lands in the refund period.
- When a refund event's Charge cannot be retrieved, only a Stripe refund with status `succeeded` is reconciled.

**REMAINING DELIVERABLES:** None for Phase 7. Follow-ups are listed under DEFERRED / POST-LAUNCH ITEMS below.

**LOCKED DECISIONS:** Payments follow the established connected-account ownership model (PAY-DC). Public paid registration is self-registration only, with no email auto-link. The webhook is the only settlement authority. All refund business effects run through the canonical refund reconciliation RPC, which also owns `refunded_at`.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Hold duration and release rules were resolved in GC-3.5-2:
- 30-minute hold;
- a Checkout window that never exceeds the database's attach limit;
- a 10-minute reconciliation grace after hold expiry;
- a late payment becomes a refunded conflict.

Depleted-credit behavior (decision #10) remains OPEN. Direct payment does not consume package credits.

**DEPENDENCIES:** Phase 5, Phase 6.

**WEB IMPLICATIONS:** Checkout and confirmation UX (`/register` shows the price, "Confirming your payment…" on return, registered state only after authoritative conversion).

**MOBILE IMPLICATIONS:** Mobile PaymentSheet is a deferred item (see register).

**SECURITY / PERMISSIONS CONSIDERATIONS:** The dedicated payment/security review was completed before release. It covered price, tenant and account authority, session and PaymentIntent binding, refund replay, failed or pending refund events, staff double refund, identity boundaries and redirects.

**BRANDING / POLISH CONSIDERATIONS:** Studio-named merchant identity per PAY-DC-3.

**DEFERRED / POST-LAUNCH ITEMS (tracked; not resolved by GC-3.5):**
- The PKG-REFUND-2 package-credit ledger for staff refunds depends on `refund.created` webhook timing.
- The Stripe webhook stores raw RPC error text in `payment_provider_events`.
- `payment_provider_events` dedupe is not database-atomic.
- DEV `accounting_upsert_entry` drift: an untracked DEV-only variant; the repository and PROD are canonical.
- The floor-rental pending-payment index exists on DEV but not PROD.
- Portal-only / member-only Group Classes remain unsupported.
- "This and following" edits do not propagate direct-payment settings.
- Seven legacy SQL-suite failures: gc1_1, gc1_2, gc1_4a, gc3_1, gc3_2, h2c1, launchsec1ca.
- Depleted-credit behavior (decision #10) remains OPEN.

**EVIDENCE / RELEASE REFERENCES**
- **GC-3.5-1** — staff direct-payment policy controls: PR #178, squash `ee3f3930842535b5421a38b3c604eceee20206ee`. No SQL.
- **GC-3.5-2** — acquisition holds / database authority: PR #179, squash `c12169f87226fe33333e1c668510d467c4485bcc`. Migration `20261026090000_gc352_public_class_purchase_holds.sql` (sha256 `2eae4da2879e22812a416c1e24ba81624c96dfd86fcb4b1d537ac7971264934c`) is live on PROD.
- **REFUND-RECON-1** — canonical refund reconciliation integrity: PR #180, squash `0e003530b91af40083785f108965a94fad3bbeaf`. Migration `20261027090000_refund_reconciliation_integrity.sql` (sha256 `d2ad6bf3b74109b061bbe1da1f857b64fc50f7b4c83ed2f323cccb42117b53e1`) is live on PROD. Preflight found 0 historical stale refunds, so no remediation was needed.
- **REFUND-RECON-2** — refund timestamp / accounting integrity: PR #181, squash `e7590dfb54eec7d37b0442e7dc391b0cdcc5a057`. Migration `20261028090000_refund_reconciliation_timestamp_integrity.sql` (sha256 `7c54e68497d2d3cc637c9775412b35e54c692db4e29030cdd74ef5b4d47ab6e3`) is live on PROD; the PROD refund RPC fingerprint is `6867f57dca8ae457c04cf557c21420e7`. Preflight found 0 affected rows, so no remediation was needed.
- **GC-3.5-3** — public paid registration application: PR #182, squash `1434bb8be4f2d893cc4ce93d1c9e3b09c18a8854` (tree `5b470d4644c761ee7688e24008c775ef12e12209`). Production deployment `dpl_CnFtr8gGHahDnj6smNvFtk12Arcw`, promoted 2026-10-07 (23:37:05–23:37:15 UTC). Application rollback target `dpl_6cHFofHxhDX7AHuMKqRhz7FUU9Bh`; the SQL rollbacks are separate decisions. 4417 / 4417 tests.
- **Production smoke:** public smoke clean. Authenticated production smoke was intentionally omitted because prior production read-only verification attempts resulted in secret/key exposure. Authenticated behavior was instead validated in DEV/local before release.
- **Release note (not a blocker):** at smoke time PROD had no upcoming public Group Classes, so a real class-specific `/register` flow could not be exercised in production. Public routes and invalid-input handling were smoke-tested, transaction behavior was validated in DEV/local (including Stripe test mode), and no production class was fabricated for the smoke.

---

## Phase 8 — Documents Center completion

**STATUS:** COMPLETE / CLOSED (2026-10-08). 8A, 8B, 8C and 8D are all released to production (main `ab60dba`, PR #192; live `dpl_4JAnpXDXu9idXiVC7Dc3KsjuFtEC`); Phase 8 is fully released.

**OBJECTIVE:** Complete document operations: revise/resend, client and general documents, waivers, signing lifecycle, certificates, receipts, branding and status UX within tier boundaries.

**PRODUCT INTENT:** Studios send, track and archive documents and signatures reliably.

**COMPLETED CAPABILITIES**
- **Canonical envelope signing** for every signed document (client assignments, onboarding, event waivers): template-version evidence (source PDF + hash, signed PDF + hash, the exact version signed).
- **Signing integrity (8A, PR #189):** no client-writable signature or assignment policies; only `pending` requests are actionable; waived / void are final; an envelope-backed assignment is signed only by envelope completion; every lifecycle write is guarded against races.
- **Lifecycle correctness + entitlement gating (8B, PR #190):** Documents management is gated by the Documents plan feature on the server; after a downgrade, authorized staff keep a read-only Documents history (records, signed / source PDFs, certificates); signers can always finish already-issued requests. Revise keeps client / template / context identity and never reopens waived / void / signed or event-checkout requests; expiry and decline are derived (no new assignment statuses); reminders are bounded, ordered and starvation-free; due date is separate from link expiry; abandoned event-checkout waivers are cleaned up.
- **Evidence + portal truth (8C, PR #191):** each completion records who actually signed (entered name, signed-in account or none, relationship, on-behalf, channel, requested recipient); guardian client context survives the portal; one shared "needs your action" contract across portal, student app and counts; a deterministic, on-demand signing certificate built from recorded evidence with an event timeline; legacy typed-signature evidence is labelled as legacy; instructors cannot read raw signing evidence (RLS).
- **Closeout (8D):** fail-safe signing permission (self signs; any other relationship only when staff grant it), a staff control for it on the client profile, guardian / authorized-recipient delivery for clients without email, truthful statuses with only valid actions, a searchable client picker with one assignment flow (including "Assign document" from the client profile), and field-layout reuse per template version.

**REMAINING DELIVERABLES:** None. Non-blocking enhancements are listed under Deferred.

**LOCKED DECISIONS**
- **Signing permission:** a client's own account (self) signs for itself; every other relationship (guardian, parent, billing contact, dependent manager, dependent) signs only when authorized staff explicitly grant it. Relationship type alone never grants signing; the stored `can_sign_documents` value is the authority. The database default is fail-safe `false` (migration `20261101090000`, applied to PROD 2026-10-08); self links are set `true` by the INSERT-only self-link trigger; existing relationships were not backfilled.
- **Delivery recipient:** the client always owns and is the subject of the assignment. The request is delivered to the client, or to one explicitly eligible linked signer (active link, signing permission, signed-in account with an email). A client without email and one eligible signer uses that signer; several require staff to choose; none blocks with a clear message. The actual signer is recorded by the 8C evidence (on-behalf for a guardian).
- **Decision #9 — waivers:** a waiver is a Documents template / use type (events, clients, other workflows), not a separate signing system or evidence model; when a signature is required it uses the canonical envelope lifecycle.
- **Decision #9 — receipts:** for Documents / e-sign, the envelope completion (signing) certificate is the canonical evidence receipt; there is no separate Documents receipt object. Payment / financial receipts stay in Commerce / payments.

**PROPOSED BUT NOT APPROVED:** None.

**UNRESOLVED PRODUCT DECISIONS:** None (decision #9 closed 2026-10-08).

**DEPENDENCIES:** Phase 4 (gating).

**WEB IMPLICATIONS:** Documents is a named workspace in the Phase 17 pass.

**MOBILE IMPLICATIONS:** The student API exposes the shared presentation contract (`presentationState`, `statusLabel`, `needsAction`, `nativeSigningAvailable`); native screens should use it rather than raw statuses (Phase 18 / 19).

**SECURITY / PERMISSIONS CONSIDERATIONS:** Signing evidence (envelopes, audit events, fields, field values, legacy signatures) is readable only by Documents-management roles; instructors keep assignment status only. Signing-permission changes go through an authorized, studio- and client-scoped server action. Broader Team & Permissions remains Phase 12.

**BRANDING / POLISH CONSIDERATIONS:** All Documents emails are branded HTML (assignment, reminders, signing completion — now including the student app).

**DEFERRED / POST-LAUNCH ITEMS (non-blocking enhancements)**
- A template-level field designer (today a sent layout is reused per template version; a new version starts from a fresh layout).
- Bulk assignment.
- Additional document taxonomy beyond the current document types.
- Deeper audit exports, and an audit entry for signing-permission changes.
- Native mobile adoption of the presentation-contract fields.

**EVIDENCE / RELEASE REFERENCES:** PR #189 (`3cdff68`, migration `20261029090000`), PR #190 (`2c55cbd`, migration `20261030090000`), PR #191 (`0e8391a`, migration `20261031090000`), PR #192 (`ab60dba`, migration `20261101090000`, SHA-256 `76e9c6a8c5aebbaf7b807d834d3ddc4b67f8bbf34634745e5ca43835c1767f13`, applied to PROD 2026-10-08); SQL suites `test_T_phase8a_*`, `test_T_phase8b_*`, `test_T_phase8c_*`, `test_T_phase8d_*`; `src/lib/documents`, `src/app/app/documents`.

---

## Phase 9 — Payroll Prep v1

**STATUS:** COMPLETE / CLOSED / FULLY RELEASED (2026-10-09). 9A, 9B, 9C, 9D and 9E are all released.

**OBJECTIVE:** Draft → approved → paid payroll preparation with integrity guarantees, immutable evidence, exports, locking and safe CSV.

**PRODUCT INTENT:** Studio owners prepare instructor pay accurately and lock it before payment.

**COMPLETED CAPABILITIES**
- Baseline: pay periods and batches with create/approve/mark-paid RPCs and a lock trigger on batched earnings; per-earning classification and category snapshots; CSV and PDF exports; instructor compensation and overrides; Gusto readiness/sync tracking (dormant); payroll authorization fail-closed (LAUNCH-SEC-1A).
- **9A — Payroll Integrity Hardening (RELEASED):** same-studio relational integrity with cross-studio identifiers failing closed; the direct per-earning paid bypass removed (paid is reached only through canonical batch payment); explicit state transitions; owner/platform-admin disbursement boundary; approved-earning amount changes return to review; reimbursement integrity and consistent totals; explicit bulk-generation cap and error behavior; protected payroll history cannot be destructively deleted and survives linked-record lifecycle changes where required.
- **9B — Immutable Payroll Evidence (RELEASED):** an immutable approval snapshot per approved batch with frozen earning lines; immutable approver, disburser and exporter evidence; atomic batch approval and atomic payment/disbursement evidence; approved-batch exports read the snapshot; repeated exports append evidence events; no new exported/finalized status; explicit legacy-live handling for pre-9B batches; a trusted approved-batch export boundary (platform-admin direct table access was not broadly expanded).
- **9C — Compensation History + Validation + Detail UI (RELEASED):** one current operational compensation rule per instructor; append-only immutable history with frozen actor identity; atomic rule update plus history event; same-studio instructor enforcement; owner/admin-only rule management; percentage (0–100), non-negative amount and mode-specific validation; a right-side compensation detail and history panel. Rule edits do not change existing payroll evidence. No effective-dated compensation engine was added.
- **9D — Formula-Safe CSV Hardening (RELEASED, app-only):** one shared CSV serializer that neutralizes formulas in user-controlled text (including after leading whitespace, control or invisible characters), quotes CR/CRLF correctly, and keeps plain-decimal money-like text compatible; payroll, accountant-delivery, event and report CSVs migrated. No authorization or tenant-boundary change.
- **9E — Payroll UX / Timezone Closeout (RELEASED, app-only):** `earning_date` is the studio-local business date; generation date ranges use studio-local day boundaries; DST-safe conversion; historical approved/paid earnings are not rewritten; the visible Paid date uses the studio timezone; the 500-item generation cap is surfaced clearly; empty states give one obvious next action; closed and paid states explain why editing is unavailable; bounded responsive layout improvements.

**REMAINING DELIVERABLES:** None for Phase 9. Carry-forwards are listed under Deferred.

**LOCKED DECISIONS:** **(v2.22) Payroll Prep tier = Growth+** (owner-approved 2026-09-15, reaffirmed 2026-10-13; entitlement enforcement not yet implemented — see Phase 4). Payroll disbursement is owner/platform-admin only. Compensation rules are managed by studio owner/admin only. Approved-batch evidence is immutable. No distinct "exported/finalized" status was added; export is recorded as evidence events.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** None. (The earlier question whether "exported/finalized" is a distinct state was resolved by 9B: no new status.)

**DEPENDENCIES:** Phase 12 (permissions) for broader roles.

**WEB IMPLICATIONS:** Named workspace in Phase 17.

**MOBILE IMPLICATIONS:** Business app (owner-level) may surface payroll later.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Authorization and integrity closed (1A, 9A–9C). CSV formula hardening is complete for payroll, accountant and event/report exports (9D).

**BRANDING / POLISH CONSIDERATIONS:** Payroll PDF branding.

**DEFERRED / POST-LAUNCH ITEMS** (Phase 9 is not reopened for these)
- Phase 12: platform-admin non-batch payroll reports, platform-admin direct earning edits, and platform-admin compensation-rule management.
- Later Gusto phase: the dormant Gusto "Last checked" timestamp still displays in server time. (v2.22: Gusto is dormant by owner Decision 4 and reactivates only if Gusto approves the integration; see Phase 26.)
- Optional UX follow-up: visually inspect the newer narrow-width Payroll layouts in a browser (covered by source/class tests only).

**EVIDENCE / RELEASE REFERENCES:** 9A PR #194 (`d3fa0af`, migration `20261102090000`); 9B PR #195 (`2cc204e`, migration `20261103090000`); 9C PR #196 (`c991f9c`, migration `20261104090000`); 9D PR #198 (`8cc97f2`, app-only); 9E PR #200 (`9c3fd5a`, app-only; live `dpl_7x4dRs2rctJUw1knjZdmac8Fae6u`). Earlier: migrations `20260715_payroll_*`, `20261004090000`; SQL suites `test_T_phase9a_*`, `test_T_phase9b_*`, `test_T_phase9c_*`; `src/app/app/instructor-pay`, `src/lib/compensation`, `src/lib/utils/csv.ts`.

---

## Phase 10 — Organizer + Competition OS

**STATUS (v2.22):** PARTIAL — MATERIAL WORK REMAINS — ACTIVE. Released: 10A, 10B, 10C, 10C.1, 10C.2, 10C.4, 10D, 10D.1 and 10C.5 (10C.3 was an audit, no code). **Next slice: 10E — Officials + Immutable Ballots**, gated on the owner's Schedule & Heats walkthrough; then 10F. Studio v1 (10A–10F) is therefore about two-thirds complete by slice count; the judging, scoring, results and publication half of the v1 loop is not built. **Public Competition registration remains OFF and HELD** (see [Release holds and gates](#release-holds-and-gates-v222)). The Competition OS architecture and slice plan were approved in v2.21.

**OBJECTIVE:** A complete organizer workspace and a full Competition OS. **Ordinary event ticketing does not count as Competition OS.**

**PRODUCT INTENT:** Organizers run events and competitions end to end, from setup and registration through live operation, scoring, results and settlement.

**GOVERNING PRINCIPLE:** Simple competitions must remain simple even though Competition OS can support complex competitions. Complexity is introduced by the selected format and the actual needs of the event, not exposed by default.

**ORGANIZER EXPERIENCE LAYERS**
- **Simple Mode** — the default for studio competitions and showcases. It creates a sensible competition structure automatically and never requires the organizer to understand advanced internals.
- **Advanced Mode** — progressively exposes the rules profile, complex divisions, rounds, heat strategy, judge panels, scoring configuration, eligibility and organization reporting. Advanced Mode is never required for basic use.

**ARCHITECTURE** (approved v2.21; engineering docs and code own the schema detail)
- **Competition Core + versioned Rules/Format Profile + versioned Scoring Engine + Organizer UX.** Profile examples: `studio_simple@1`, `wsdc@2026.1C`, `ucwdc@2026-SF16.9b`, `ndca@2026-06`. The initial target profile is `studio_simple@1`.
- **Rules/version lock:** at publish a competition locks its rules profile key and version, its scoring engine version and a configuration snapshot. Future rule updates must not silently change existing or historical competitions. Human-readable rule sources are kept separate from the normalized executable configuration.
- **Rules profile and sanction status are separate.** Selecting a rules profile never implies official sanction. Sanction is not required for studio v1. DanceFlow does not claim organization authorization or endorsement until it has been independently obtained.
- **Roadmap-level model:** Event → Competition → Category → Division → Round → scoring heat; plus event-level competitors, entries, entry participants, floor heats, schedule, officials, panels, ballots, advancement decisions, adjudication actions, immutable result calculations, result publication, corrections and awards.
- **Integrity:** submitted ballots are immutable and corrections create new versions; scoring engines are deterministic and versioned; result calculation preserves its trace/evidence; finalized results are never silently overwritten; publication is versioned; corrections retain prior history. High-integrity ballot and scoring slices require Opus review and their own Security Review.

**COMPLETED CAPABILITIES — EVENT side**
- Organizer workspace, organizer public page/ICS/embeds; event CRUD and public pages; ticketing (tickets, sell-tickets, digital tickets, multi-ticket cart, capacity holds, schedule items/sessions); registrations with exports and signed documents; check-in with scanner and recap; settlement/closeout (actions, export, PDF); financial summary and event order payments; organizer contacts and campaigns; event reminders and push; event-level ARIA actions; organizer roles/RLS.
- Release-hardening: zero-total checkout race closed (LAUNCH-SEC-2C).

**COMPLETED CAPABILITIES — COMPETITION side** (routes under `events/[id]/competition/*`; library `src/lib/competition`)
- Competition/showcase setup; divisions, contests, dances, WSDC rules; competitor registration (public builder, cart, fee rules, checkout, organizer registrations page); entries, entry dances and entry changes (table); heat planning with generation runs, review and apply; scheduling (schedule page, publications, constraints, conflicts, rounds); check-in (sessions, participants, credentials, participant waivers); readiness page; West Coast Swing foundation (tier rules, petitions, program profiles).

**EXISTING FOUNDATION (June 2026, partial; not complete):** roughly 40 `event_competition_*` tables covering programs, contests, divisions, rounds, heats and heat entries; configuration templates; entry structures; generation/proposal infrastructure and the heat planner; scheduling structures; check-in including competitor numbers and credentials; the WSDC profile foundation; and a public competition registration builder behind a feature flag. Material work remains on top of it.

**KNOWN FOUNDATION DEFECTS / DRIFT (v2.21 list — ALL ADDRESSED by 10A, PR #204, released 2026-10-09; preserved for history).** 10A captured the five schedule tables and the two schedule functions into migration `20261107090000`, repaired contest/division public RLS, made entry changes non-forgeable, replaced the session-GUC heat override with a role-checked lock-event ledger, added foundation SQL and application tests, and added the workspace entry from event detail. 10A also fixed defects not on this list (anon-callable registration-rule default, a schedule trigger and an unqualified `digest()` that broke heat-plan runs and schedule publish). Original list:
- The schedule tables and the schedule-version RPC exist in the deployed databases but are not captured in repository migrations.
- Public competition read RLS defects (contest and division policies).
- `event_competition_entry_changes` is not append-only or hardened.
- Heat lock override relies on an unsafe session override rather than role checks.
- No tests exist around the foundation.
- The Competition workspace has no obvious entry from event detail.

**REMAINING DELIVERABLES — COMPETITION (highly visible; drives the Phase 18 app-count decision)**
- **Canonical event-level competitor identity** (none found; see Locked Decisions).
- **Officials, panels and judge access:** model, assignments and web ballot entry (none found).
- **Ballots and marks:** immutable ballots, marks and paper-ballot entry (none found).
- **Scoring engines and result calculations:** deterministic, versioned engines with a preserved trace (none found).
- **Approvals, publication and corrections:** review, approve, versioned publication and correction history (none found).
- **Awards** (none found).
- **Public participant result and heat views** (none found).
- **Feedback** (judge or competitor) (none found).
- **Live heat management** (call, advance, delay, live status to competitors) (none found).
- **Scratches/changes workflow UI** with fees and re-heat (table exists; no UI; 10D added scratch/no-show handling in floor heats only).
- **Partnerships/couples management** (partial: entry participants and partner search; 10C.4 added participant-role integrity — mixed relationship vs lead/follow role — and combination validation).
- Competition **test coverage**: foundation, profile, registration, role, heat and eligibility SQL suites plus application tests now exist (10A–10D.1); scoring/results coverage arrives with 10E/10F.
- (v2.22) ~~Canonical event-level competitor identity~~ — DELIVERED by 10C (event-level competitors and entries). The other items above remain for 10E–10G.

**RELEASED SLICES (v2.22 reconciliation; production releases recorded by the operator at release time — the commit bodies say "DEV only" because they were written at PR time)**

| Slice | Scope | PR → main | SQL | Production |
|---|---|---|---|---|
| 10A Competition Foundation Reconciliation | Captured undeclared schedule objects; RLS, entry-change, heat-lock and anon-EXECUTE fixes; foundation tests; workspace entry | #204 → `b0c8630f` | `20261107090000` (PROD 2026-10-09 14:30Z) | `dpl_F5jwWf7u…` |
| 10B Simple Creation + Competition Workspace | `studio_simple@1` profile, publish lock/snapshot, 5-step Simple Mode wizard, lifecycle Overview, divisions panel; old setup moved to Advanced | #205 → `72f12c4b` | `20261108090000` (PROD 19:16Z) | `dpl_3ycRADDt…` |
| 10C Competitors + Transactional Registration | Event-level competitors and entries; transactional, idempotent registration on the event commerce stack; server price snapshot; Phase 8 signing; webhook finalize (`finalize_competition_registration`) | #206 → `a2bcb203` | `20261109090000` (PROD 22:06Z; preceded by an authorized repair of two duplicate PROD `event_payments` rows) | `dpl_65HJvF9i…` |
| 10C.1 Launch readiness + entry UX | Guest checkout, idempotent resume, processing→confirmed status, cancel/expiry, waiver→resume; launch gates defined | #207 → `55344d43` | none | `dpl_3NW22SgV…` |
| 10C.2 Create Event simplification | Simplified Create Event; publish → `published` status | #208 → `be48b5b4` | none | `dpl_CMY4inat…` (owner walkthrough pending) |
| 10C.3 Entry relationship completeness (audit) | Rulebook audit (UCWDC, WSDC, NDCA) found participant-role conflation; no code | — | — | — |
| 10C.4 Participant role integrity | Relationship vs lead/follow role separation; combination validation | #209 → `5e307c98` | `20261110090000` (PROD 2026-10-10 11:06Z) | `dpl_4QJPm2Yw…` |
| 10D Heats + Floor Schedule v1 | Floor heats (canonical Schedule & Heats), running order, one publish/snapshot authority, scratches/no-show; June planner kept under Advanced | #210 → `b5e552f2` | `20261111090000` (PROD 12:07Z) | `dpl_CqspkCpy…` (owner walkthrough pending) |
| 10D.1 Heat entry eligibility integrity | Database floor-heat integrity check enforces entry eligibility | #211 → `20aefe82` | `20261112090000` (PROD 12:53Z; SQL-only) | app unchanged |
| 10C.5 Competition setup wizard + draft generator | Format-driven setup wizard; per-format division schemes (UCWDC Country, NDCA Ballroom classifications, WSDC, Studio); dance selection; feedback policy separated from official results; draft generator; registration settings isolated on the program; profile `studio_simple@3` (`@2` kept immutable) | #212 → `fb2fbd15` | `20261113090000`, `20261114090000`, `20261115090000` (PROD 2026-10-12 01:18Z, one transaction) | `dpl_4f83RdS9…` (promoted 01:44Z; 30-minute observation clean) |

All slices released with the public registration flag OFF. Later production deployments (CI-A, PAY-WH-1, PAY-WH-1B) carry these slices forward.

**v2.22 scope notes (recorded so they do not silently become requirements):**
- **Profile version:** the current Simple profile is `studio_simple@3`; `@1` and `@2` remain immutable for any competition that locked them (rules/version lock principle).
- **Pull-forward from 10H:** 10C.5 lets organizers *set up* NDCA Ballroom classifications and Multi-Dance categories, but registration into Multi-Dance categories is held (`multi_dance_results_not_operational`) until Multi-Dance results are operational. This is a bounded setup pull-forward, **not** a change to the rule that 10H–10J are outside studio v1.
- **Feedback vs official results:** 10C.5 separated feedback modes (none / written / + grade / + score) from official competitive results in the profile; feedback UI is deferred to 10F/Companion.

**REMAINING STUDIO v1 MILESTONES (v2.22)**
1. **10E — Officials + Immutable Ballots** (Opus; own Security Review). Gate: owner Schedule & Heats walkthrough (10C.2/10D). Carry-forwards from 10A that land here or in 10F: `organizer_staff` full authority and the studio-name organizer heuristic (with Phase 12), published schedule versions not trigger-immutable, audit change-type labels supplied by callers, locked heats blocking event deletion, and blocking event deletion once results exist.
2. **10F — Scoring Engines + Results + Publication** (Opus for engines and finalization): `ordinal_majority`, `proficiency_rating`, `callback_tally`; calculate, review, approve, publish, corrections, awards, public results, participant history; feedback delivery.
3. **10G — Live Competition Run + Polish** (optional for the v1 milestone).
4. **Public registration enablement** (separate from the v1 milestone; owner-authorized flag change): requires CI-B, CI-D, the 10C.1 launch gates and, for Multi-Dance categories, the Multi-Dance hold.
5. 10C carry-forwards (**AGENT-RECORDED PROPOSAL** — recorded at release; non-blocking unless noted): per-competitor waivers; duplicate admission attendees across orders; reopen re-enabling per-category rules; anchored email/DOB snapshot; expired-signing redirect; status-page lazy release; organizer manual confirm; staff-side registration UI; stale competition-order sweeper (check whether the PAY-WH-1 reconcile sweeper now covers it); three copies of the platform-fee rule; guest competitor PII erasure; publicly readable `request_key`.
6. Format carry-forwards (**AGENT-RECORDED PROPOSAL** except the Jack & Jill deferral, which was approved in 10D; 10C.4 / 10D / 10C.5; post-v1 unless a v1 slice needs them): NDCA Student/Student and Mixed Proficiency; "judged" marker; team minimum size and internal couples; per-round pairing; Jack & Jill pairing table (deferral approved in 10D); feedback UI.

**REMAINING DELIVERABLES — EVENT side:** volunteer/staff UI (labor actions exist without a page); a profitability view (only financial summary and settlement); organizer-specific notification center; organizer ARIA page (owned by Phase 15 from v2.22, with a Phase 10 dependency); event-promotion/Featured management (see module).
- **(v2.22, OWNER-APPROVED commitment "organizer parity"; matrix layout is engineering) Organizer parity matrix** — Phase 10 is the home of the cross-cutting organizer-parity checklist (campaign editing, composer, ARIA, notification center, CRM depth, organizer-owned classes, roles); see the [Preserved commitments register](#preserved-commitments-register-v222) section C.
- **(v2.22, owner-approved 2026-10-10) Edit Event simplification:** Edit Event still uses the old publishing UI/model, and its save rewrites every column and deletes/recreates child rows; bring it to the 10C.2 Create Event model.
- **(v2.22, AGENT-RECORDED PROPOSAL) Past event detail page** still shows registration / spots-remaining affordances after an event has ended (Cleanup PR B follow-up; agent-recorded, owner approval UNVERIFIED).
- **(v2.22, owner-identified 2026-10-11 during 10C.5; deferred from PR #212) Competition commerce requirements:** youth / multiple pricing categories; spectator admission tickets sold separately from competitor entries; hotel room blocks / accommodation packages (post-v1); scholarship offerings with designation, prize obligations and payment (10H/10J+ scope).
- **(v2.22, ENGINEERING FINDING) Event commerce authority hardening** (2026-10-12 commerce audit): `event_payments` amount/status/refund columns are writable by tenant staff roles, registrations/attendees are updatable by any active studio role, and `canCheckInEventAttendees` is unused. CI-B addresses the check-in part; the rest attaches to deferred item #7 (event staff/action-role hardening).

**SLICE PLAN** (approved v2.21; engineering sequencing, not a delivery commitment; **v2.22 status: 10A–10D RELEASED, plus inserted slices 10C.1–10C.5 and 10D.1 — see Released slices above; 10E NEXT**)
- **10A — Competition Foundation Reconciliation (RELEASED 2026-10-09; was NEXT in v2.21):** read-only DEV/PROD introspection; capture the deployed schedule tables and RPC into repository migrations; repair the public competition RLS defects; harden `event_competition_entry_changes`; replace the unsafe heat override with role-checked behavior; tests around the existing foundation; an obvious Competition workspace entry from event detail.
- **10B — Simple Creation + Competition Workspace:** `studio_simple@1`, profile/version lock, Simple Mode wizard, workspace shell with readiness, separate rules-profile and sanction fields.
- **10C — Competitors + Transactional Registration:** event-level competitors and entries; competition checkout hardening on the existing event commerce stack (transactional, idempotent, server price snapshot, signing via the Phase 8 workflow).
- **10D — Heats + Floor Schedule v1:** floor heats, single floor, heat sheets, scratches/no-show, check-in tie-in, participant heat lookup.
- **10E — Officials + Immutable Ballots (Opus; own Security Review).**
- **10F — Scoring Engines + Results + Publication:** calculate, review, approve, publish, corrections, awards, public results, participant history (Opus for engines and finalization).
- **10G — Live Competition Run + Polish:** may immediately follow or overlap as bounded polish once the core loop exists.
- **10H — Ballroom / Multi-Dance Expansion.**
- **10I — WSDC Profile.**
- **10J+ — UCWDC / NDCA / Sanctioned Advanced Competition.**
- **Studio v1 milestone = 10A through 10F.** 10H–10J are not v1 requirements.
- **V1 success loop:** CREATE → PUBLISH → REGISTER → PAY → CHECK-IN → BUILD HEATS → JUDGES SCORE → CALCULATE → REVIEW → APPROVE → PUBLISH RESULTS.
- **After studio v1 (profile scope):** WSDC — Relative Placement, Jack & Jill random pairing, WSDC profile/tier/reporting. UCWDC — Majority Rules, Group-and-Rank, UCWDC callbacks, modular/singular heating, championship formulas. NDCA — multi-dance Skating, penalties/invigilation/credential enforcement, required exports/reporting. The proposed engineering order is WSDC, then UCWDC, then NDCA; this is an engineering dependency order (the WSDC foundation already exists), **not** a product-market priority statement.
- **Outside studio v1:** multiple floors; championship-scale optimization; every sanctioning eligibility rule; automatic sanction submission; external points-registry sync; all organization-specific report formats; UCWDC advanced championship logic; NDCA full sanctioning/penalty administration; complex teams/choreography edge cases; a separate judging application.

**FUTURE — COMPETITION COMPANION** (owner-approved for the roadmap during the 10C.5 walkthrough, 2026-10-11; requirements only — NOT built, not part of PR #212). The existing DanceFlow **Student App is the preferred home**; no separate Competition app is planned.
- **Competition Day:** personalized heat schedules; upcoming-heat reminders; floor and schedule changes; competition check-in; instructor and partner coordination; notifications when results become available.
- **Competition History:** competitor-owned history across organizers and studios; released results and judges' feedback; secure identity linkage (verified account linking, never name/email matching); privacy controls and guardian controls for minors.
- **LUMI Performance Intelligence** (future, inside Companion): analyzes Country, Ballroom and WCS **separately**; preserves each governing body's scoring semantics (e.g. UCWDC medal marks vs WSDC Relative Placement vs NDCA Skating are never merged into one score); identifies only evidence-supported longitudinal trends; suggests training priorities; shares findings with instructors **only with the dancer's explicit permission**.
- **Dependencies:** 10F results publication and feedback (released results are the only input); Phase 11 notifications; Phase 18/20 Student App.

**COMPETITION REGISTRATION IDENTITY** (10C.5 audit, 2026-10-11): competition registration does NOT create host-studio leads or clients. The 10C model already separates the organizer (event manager), registration submitter (`entries.submitted_by_user_id`), actual competitor (`event_competition_competitors`, event-scoped; guests allowed), instructor/partner (entry participants, 10C.4 roles), represented studio (`registering_studio_id` / `represented_studio_name`), payer (`event_orders` buyer fields) and DanceFlow account (optional `user_id` anchor). A competitor is linked to an existing host-studio client only when the signed-in submitter registers themselves and already has a verified self client-account link at that studio; no client is created. The organizer's "account required" setting is enforced by the register page and by `start_competition_registration`. **Follow-ups (not built):** an explicit parent/guardian relationship for minor competitors; a verified claim flow so competitors registered by someone else (instructor, studio, parent) can link their own account to receive results and feedback; delivery of released results and judges' feedback to the competitor portal (the account benefit the setup wizard describes as planned).

**LOCKED DECISIONS:** Event and Competition are tracked separately. Competition routes live under the event.
- **Competitor identity (CLOSED / LOCKED, v2.21):** no second platform person-identity system; existing DanceFlow identity remains canonical. Competition OS adds an event-level competitor abstraction: one human is one competitor per event, with many competition entries. A competitor may optionally anchor to an account/dancer profile, a client or an instructor; guest competitors without accounts are allowed; linking follows the verified-identity rules. PERSON ≠ COMPETITOR ≠ ENTRY (example: one competitor with ProAm Two Step, ProAm Waltz, Solo and Jack & Jill entries). Partnership/team structure belongs to entries and entry participants, not duplicate person rows.
- **Floor heat (v1):** a scoring heat is one round/division scoring unit; a floor heat is the numbered on-floor/schedule unit visible to organizers and competitors. A floor heat may contain several scoring heats/divisions. Floor heats are in scope for studio v1.
- **Judge access (studio v1):** judges use authenticated DanceFlow accounts for web ballot entry; a scorer may enter paper ballots; no anonymous judge or tablet links in v1. Competition-specific event roles are implemented inside Phase 10 as needed; Phase 12 remains the generic platform Team & Permissions expansion.
- **Studio v1 scoring defaults:** final-only structure unless entry volume requires a preliminary; `ordinal_majority` for placement contests; Gold / Silver / Bronze simple rating bands for studio showcase/rating use (explicitly not UCWDC's formal medal scoring vocabulary). Engines in studio v1: `ordinal_majority`, `proficiency_rating`, `callback_tally`. Organization sanction is not required; guest competitors are supported; one physical floor initially; multiple divisions may share one numbered floor heat.
- **Payment reuse (LOCKED):** Competition OS reuses the existing event commerce stack and has no independent competition payment stack: event orders, competition-entry order items, event registrations, Stripe Connect direct charges, the existing payment webhook and ownership controls, and the studio/organizer workspace Stripe payout account. Competition checkout hardening belongs in 10C.
- **Public copy:** the existing restriction on Competition OS claims (Phase 3 public-claim restrictions) is unchanged by this architecture approval.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Whether a separate judging application exists (v1 is web with authenticated accounts; the separate-app question remains Phase 18); Featured Events model. (Scoring systems to support is resolved by the locked studio v1 defaults and the post-v1 profile order above.)

**DEPENDENCIES:** Competition-specific event roles are implemented inside Phase 10 as needed; Phase 12 (generic Team & Permissions expansion) later folds them into its permission catalog. Phase 8 (signing workflow) for competition checkout; Phase 11 (notification integration); Phase 13/Featured module. **(v2.22)** Public registration enablement depends on the Commerce Integrity lane (CI-B, CI-D).

**OWNER ACCEPTANCE GATES (business acceptance only; functional QA is developer-owned):** Schedule & Heats walkthrough (10C.2/10D; gates 10E); organizer walkthrough and verified "this is me" walkthrough (10C.1; gate public registration).

**WEB IMPLICATIONS:** Organizer and Competition are named workspaces in Phase 17.

**MOBILE IMPLICATIONS:** Studio v1 judging is web-based with authenticated accounts. Judging, live heats and competitor surfaces still drive the 2-app vs 3-app decision (Phase 18). Today `mobile/` contains only the student app; its competition screen is a discovery category.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Judge/scoring access and result integrity are new high-risk surfaces; require their own Security Review (10E and 10F require Opus review). 10A repaired the foundation's public-read RLS and append-only/override defects (released). Event staff-role granularity is deferred (see register).

**BRANDING / POLISH CONSIDERATIONS:** Organizer/competition surface branding unverified; vocabulary sweep ("Organizer Workspace").

**DEFERRED / POST-LAUNCH ITEMS:** Event staff-role hardening; floor-rental pricing redesign (unrelated sibling item).

**EVIDENCE / RELEASE REFERENCES:** `src/app/app/events/[id]/competition/*`, `src/lib/competition/*`, `20260622_west_coast_swing_foundation_v1`. v2.21 architecture approval is docs only. v2.22: PRs #204–#212 and migrations `20261107090000`–`20261115090000` (see Released slices); slice documents under `docs/competition/` and `docs/events/phase10c2-create-event-ux.md` (the 10C.1 and 10C.5 documents still describe themselves as a local candidate / open PR; both were merged — #207, #212).

---

## Phase 11 — Messaging / Notification platform completion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS (Twilio campaign approval is a parallel Phase 2 compliance lane and is not counted against this phase)

**OBJECTIVE:** A complete messaging platform across email, push and SMS with preferences, templates, reminders, alerts, logging and error visibility.

**PRODUCT INTENT:** The right message reaches the right person on the right channel, with consent, scoping and visibility into failures.

**COMPLETED CAPABILITIES:** Branded email shell and sender identity; central dispatch with outbound delivery logging (`outbound_deliveries`) for email and SMS; per-studio SMS architecture; student and mobile-partner push; notification categories and priority; in-app notifications inbox and a communications page showing failed and recent outbound messages; reminder and renewal crons; platform alerts; reply routing; studio staff recipient resolution.

**REMAINING DELIVERABLES**
- Staff-facing notification preference management UI per category/channel (only the inbox found) (unverified).
- Cross-channel fallback policy (email → SMS → push); today only SMS consent/skip reasons.
- Retry/backoff for failed deliveries (UI shows failures; no worker found).
- Email provider delivery-status webhooks.
- Editable template layer (templates are code-based).
- Quiet-hours/dedupe policy.
- Push and preference-path test coverage.
- Notification-preference membership hardening (#9, deferred).
- **(v2.22, from the owner-approved TW-4 direction)** Twilio Event Streams intake and send-error 21610 suppression handling become part of the SMS platform (built in TW-4 4B).
- **(v2.22, ENGINEERING FINDING, from PAY-WH-1)** `outbound_deliveries` claim fields (`claim_owner`, `claim_expires_at`) are not cleared after a send and mark-sent/skipped does not check the claim owner (cosmetic today; tidy when the dispatcher is next touched).
- **(v2.22, AGENT-RECORDED PROPOSAL — GC-R1 known gaps)** private-lesson reminder dedupe gap when `user_id` is NULL; cancel-after-queue handling outside Group Classes.

**LOCKED DECISIONS:** SMS is limited to the registered categories (Phase 2); no marketing SMS.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Fallback ordering; template editability; quiet hours.

**DEPENDENCIES:** Phase 2 (SMS), Phase 12 (scoping), Phase 10 (organizer/competition notifications).

**WEB IMPLICATIONS:** Preference and failure UX in Phase 17.

**MOBILE IMPLICATIONS:** Push routing (thread/partner taps are not routed today); notification preferences in both apps.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Workspace scoping of notifications; #9 deferred.

**BRANDING / POLISH CONSIDERATIONS:** Branded templates (done for email).

**DEFERRED / POST-LAUNCH ITEMS:** #9; confirm-route push.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/notifications`, `src/app/app/{notifications,communications}`.

---

## Phase 12 — Team & Permissions expansion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** Role-level permissions with per-user overrides, inherited-vs-overridden visibility, owner safeguards and boundaries for studio, instructor, front desk, organizer and competition operations — enabling permission-driven navigation.

**PRODUCT INTENT:** Owners control exactly what each person can see and do; apps show only what a person is allowed to use.

**Fixed roles alone do NOT satisfy this phase.**

**COMPLETED CAPABILITIES:** Nine fixed roles (platform_admin, studio_owner, studio_admin, front_desk, instructor, independent_instructor, organizer_owner/admin/staff) with explicit boundaries (owner-only billing, payouts and payroll disbursement; front desk vs studio admin; organizer vs studio workspace); team management UI; owner-demotion and role-insert guards with tests; per-user overrides for five export permissions only (`role_permission_overrides`).

**REMAINING DELIVERABLES**
- Data-driven permission catalog and role-to-permission matrix (none exists).
- Per-user overrides beyond exports (navigation, modules, finance, clients, competition operations).
- Inherited-vs-overridden visibility and an effective-permissions view.
- Navigation gated by permission keys (today hard-coded role checks).
- Competition-operational boundaries beyond `organizer_staff` (competition-specific event roles needed by Phase 10 are delivered inside Phase 10 and folded into this phase's permission catalog later).
- Event staff-role granularity (#7, deferred).

**LOCKED DECISIONS:** Owner-only administration and owner-access safeguards remain.
- **(v2.22 — recording owner direction of 2026-09-04/05):** the relationship/role type supplies secure default capabilities; Team & Permissions is primarily the owner-controlled override/delegation layer; support role-level defaults plus per-user overrides; clearly distinguish inherited vs overridden access; preserve owner-only permission administration; no architecture may make per-user overrides impossible.
- **(v2.22 — owner sequencing, 2026-10-13):** granular Team & Permissions (the data-driven catalog and overrides) must be delivered **before Phase 24 — Data Loss Prevention**, because DLP policies are expressed over the permission model.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Whether custom roles are in scope.

**DEPENDENCIES:** Prerequisite for Phase 19 (Business navigation), Phase 17 permission-aware navigation and **Phase 24 (DLP)**.

**WEB IMPLICATIONS:** Team settings redesign; permission-aware navigation.

**MOBILE IMPLICATIONS:** Business app navigation must be permission-driven.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Highest sensitivity; requires Security Review.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** Event staff-role granularity (#7); platform-admin MFA (#6). Carried from Phase 9: platform-admin non-batch payroll reports, platform-admin direct earning edits and platform-admin compensation-rule management.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/auth/permissions.ts`, `20260423_role_permission_overrides.sql`.

---

## Phase 13 — Marketing / Campaigns completion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** A full campaign system: editable drafts, reopen/modify before send, block editor, images, interactive elements, DanceFlow event-link picker, segmentation, analytics, email/SMS channel selection, consent enforcement and ARIA assistance.

**PRODUCT INTENT:** Studios and organizers create and send compliant, effective campaigns without leaving DanceFlow.

**COMPLETED CAPABILITIES:** Draft/test-send/recipient-generation/send for plain-text email campaigns (single CTA); fixed audiences (manual, all active clients, new leads, inactive clients, event attendees); unsubscribe table and public unsubscribe routes with compliance footer and consent acknowledgment; AI draft assistant; parallel organizer campaign system; tests for actions, authorization and email rendering; monthly recipient allowance enforced for studio and organizer sends (ENT-1, released).

**v2.22 AUDIT FINDINGS (code at `24a37a15`)**
- **Drafts:** organizers can reopen and edit drafts (`updateOrganizerCampaignDraftAction`); **studios cannot** — the studio campaign actions are create, test, generate recipients and send only, and the studio detail page shows the body read-only. (Resolves v2.21's "(unconfirmed)".)
- **Editor:** a plain textarea plus one CTA label/URL rendered through the fixed branded shell; `body_html` exists in the schema but is unused; images are limited to the studio logo; the CTA URL is free text (no event-link picker).
- **ARIA:** the draft assistant (subjects, preview, body; metered as `ai_action`) works only by copy/paste, which a studio cannot apply after creation because there is no edit form. ARIA marketing rules are suggestion-only with no send path (unchanged, locked by ENT-1 scope).
- **Compliance gaps (live behavior):** (1) unsubscribes are applied when recipients are *generated*, not re-checked at *send*, so someone who unsubscribes from campaign A after campaign B's recipients were generated can still receive B; (2) the suppression lookup fails open (a lookup error returns an empty set); (3) no `List-Unsubscribe` / `List-Unsubscribe-Post` one-click headers; (4) no recipient-side marketing-consent basis (audiences are inferred from business relationships); (5) marketing and transactional mail use separate sender variables on one Resend account — whether the live sender domains are actually separated is unverified.
- **Architecture:** studio and organizer campaigns are fully parallel systems (separate tables, separate unsubscribe implementations: anon RPC vs admin client). The unreferenced duplicate `marketing/campaigns/[id]/actions.ts` remains (a test pins it untouched until the dedupe).

**REMAINING DELIVERABLES (v2.22; the commitments are OWNER-APPROVED — drafts, block editor, images, ARIA integration, event-link picker, plus every v2.21 item; the M-0…M-7 split is ENGINEERING SLICING)**
- **M-0 — Campaign compliance remediation (PRIORITY 1):** re-check suppression at send time for every batch (studio and organizer); make the suppression lookup fail closed; add `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers backed by a one-click endpoint; verify (and record) marketing vs transactional sender-domain separation; validate CTA URL schemes on the studio form. Developer-owned QA including a concurrency case (unsubscribe between generate and send).
- **M-1 — Studio draft reopen/edit + ARIA apply:** studio update-draft action and UI matching organizer parity (edits refused once not `draft`); ARIA assistant output can be applied directly into the draft (subject/preview/body) instead of copy/paste.
- **M-2 — Shared composer model / organizer parity:** one campaign content model and editor component used by studio and organizer workspaces; dedupe the duplicated action modules (v2.21 item); align the two unsubscribe implementations.
- **M-3 — Modern block-based editor:** structured blocks (text, image, button, divider/spacer, multi-column layout/sections) stored as JSON and rendered server-side to `body_html` inside the BR-3B2 branded shell with the locked footer order; plain-text alternative generated.
- **M-4 — Image support:** campaign image upload/insert with a dedicated storage bucket and policy, size/type limits, alt text.
- **M-5 — DanceFlow event-link picker:** insert existing public DanceFlow event (and class) links from a picker of the workspace's published public items; links resolve to stable public URLs (Phase 10/21).
- **M-6 — Interactive content where technically supported:** multiple CTAs/buttons; RSVP-style links into existing DanceFlow flows. Email clients do not run scripts; "interactive" means link-driven actions, not embedded forms. (Featured Events tie-in stays with the module and is NOT implied.)
- **M-7 — Audience and measurement:** saved/custom segments; open/click/delivery/bounce/complaint/unsubscribe analytics with automatic bounce/complaint suppression (needs Resend webhooks — Phase 11); recipient marketing-consent model beyond unsubscribes (v2.21 item); scheduled send (the `scheduled` status exists without a scheduler); ARIA guidance beyond draft generation (v2.21 item).
- **Channel selector:** email/SMS channel selection stays blocked by the locked no-marketing-SMS decision; a future marketing SMS path would need its own `MARKETING` campaign and separate marketing consent (TW-4 "later" item).
- Future Featured Events integration (NOT implemented; see module).

**TRANSACTIONAL vs MARKETING BOUNDARY (v2.22 — recorded as a Phase 13 deliverable, consolidating ENT-1 and Phase 2 rules):** marketing campaigns only through the campaign actions (ENT-1 metered, legal footer, unsubscribe, marketing sender); operational and transactional messages (auth, receipts, reminders, documents, Public Discovery notices, ARIA 1:1 operational outreach) never carry marketing content, are not campaign-metered and are not suppressed by marketing unsubscribes; no marketing SMS. M-0 verifies sender separation; M-7 adds the consent model.

**LOCKED DECISIONS:** No marketing SMS under the current registered A2P scope. ENT-1 reserve → send → settle must be preserved by every new send path.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Campaign SMS scope and use-case registration; whether marketing mail gets its own sending subdomain for reputation isolation (v2.22); recipient marketing-consent model scope (CAN-SPAM-only vs CASL/GDPR-ready, depending on studio geography).

**DEPENDENCIES:** Phase 11 (provider webhooks for M-7 analytics), Phase 4 (allowances; ENT-1 released), Phase 2 (SMS), BR-3B2 branded shell (M-3), storage policy (M-4), stable public event URLs (M-5).

**WEB IMPLICATIONS:** Marketing is a named workspace in Phase 17.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Consent enforcement and unsubscribe correctness (M-0 closes the known send-time and fail-open gaps).

**BRANDING / POLISH CONSIDERATIONS:** Branded campaign rendering exists (br3b2).

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/app/app/marketing`, `src/app/app/organizer-campaigns`, `marketing-campaigns-v1-foundation.sql`.

---

## Phase 14 — Marketplace + digital products + Mux

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS

**OBJECTIVE:** Sell and deliver digital products with Mux video, entitlements, purchase history and wallet.

**PRODUCT INTENT:** Students buy digital content and watch it with proper access control.

**COMPLETED CAPABILITIES:** Mux server library, webhook reconciliation, secure playback; staff digital catalog and Mux uploader; syllabus video uploads; student marketplace pages and APIs; checkout creating digital entitlements; entitlement/expiry-aware playback and progress; mobile wallet with digital purchases and learn screens; verified-email linking.

**REMAINING DELIVERABLES**
- Web student purchase-history/wallet page (API-level only found; the web wallet appears only on the portal page and APIs).
- Refund → entitlement path — **v2.22: gap CONFIRMED, and it is a product decision first.** `commerce_entitlements` allows `active | revoked | expired | refunded_access_retained`, but no application code or SQL writes `revoked` or `refunded_access_retained`, and playback grants access for both `active` and `refunded_access_retained`. A refund therefore never changes digital access today.
- Digital entitlement failure detection as an ARIA rule (unverified).
- **(v2.22, AGENT-RECORDED PROPOSAL) Commerce integrity alignment:** digital-product checkout should adopt the PAY-WH-1 settlement pattern (atomic settlement, claim/lease webhook processing, outbox, captured-payment exceptions) and the CI-D refund-attribution pattern; PAY-WH-1 covered event tickets only.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** Seller payouts / third-party instructor or studio-as-seller revenue split (not found; assumed future).

**UNRESOLVED PRODUCT DECISIONS:** Seller model and payouts. **(v2.22) Whether a refund revokes or retains digital access** (and whether partial refunds differ).

**DEPENDENCIES:** Phase 4 (marketplace entitlement keys, decision #8); Commerce Integrity lane (CI-D pattern) for refund handling.

**WEB IMPLICATIONS:** Purchase-history UX.

**MOBILE IMPLICATIONS:** Wallet and digital library exist in the student app.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Commerce security hardening released.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** Seller payouts/revenue split.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/mux`, `src/lib/commerce`, `src/app/marketplace`.

---

## Phase 15 — ARIA Operations completion

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS

**OBJECTIVE:** A complete ARIA operations layer: suggestions, approval boundaries, automation rules, digests, retries, assistance and tier/credit enforcement.

**PRODUCT INTENT:** ARIA helps do the work, under owner-controlled autonomy, without exceeding rule-level permission.

**COMPLETED CAPABILITIES:** Operations Center; automations; operational automation matrix with all rules marked implemented; four autonomy levels per pack; digest/operations/outcome crons; digest failure observability and terminal-alert dedupe; billing rules cannot charge/retry/refund/waive/change access/mark paid; marketing send needs explicit rule permission.

**REMAINING DELIVERABLES**
- Production digest delivery, retry handling and end-to-end QA (retry completeness unverified).
- Threshold and default tuning.
- Refresh the stale coverage-audit document (`docs/aria/aria-day-to-day-automation-coverage-audit.md` predates Slices 5–6).
- No documented organizer/competition assistance beyond cron role resolution; tier/credit enforcement in ARIA beyond AI-credit allowances (unverified).
- **(v2.22, ENGINEERING FINDING) Executes vs suggests — recorded explicitly.** The operational matrix marks all 32 rules implemented (12 internal-only, 4 suggestion-only, 9 draft-for-review, 7 default auto-send), but real external execution is email only and limited to a five-rule allowlist (`low_package_balance`, `stale_active_student`, `intro_no_purchase`, `membership_past_due`, `membership_canceling`) that also requires the rule's mode to be auto-send. The matrix declares seven default auto-send rules against five executable ones; how the other two degrade must be verified and the matrix and allowlist reconciled.
- **(v2.22) ARIA operational automation — execution-scope expansion** (owner direction: ARIA as an operational team member, 2026-09-20; listed for v2.22 capture 2026-10-13): widen the executable allowlist rule by rule, SMS execution only through the Phase 2 / TW-4 registered scope and Phase 11, reversible non-message actions — each designed and explicitly authorized; billing ceilings unchanged.
- **(v2.22) Organizer ARIA** (event-side "organizer ARIA page" from Phase 10) is owned here, with a Phase 10 dependency. Today `/app/aria` has a partial, read-only organizer-workspace view (event, registration, ticket, profitability and settlement rows); there are no organizer automation rules or executions.
- **(v2.22, AGENT-RECORDED PROPOSAL) ARIA cleanup follow-ups A–D** (Cleanup PR C): #24 activation decision; draft generated-vs-edited marker; outbound claimed/sending state; move internal ARIA functions out of the server-action module. Also 14 deferred rule-wording refreshes, `aria_schedule_conflict`, a dead confirmation-gap generator, and queued-action recall claim state.
- **(v2.22) LUMI sub-track — LUMI Dance Journey Assistant.** Owned by this phase from v2.22. Existing released functionality is preserved (see the Preserved commitments register, section C); the owner-approved LUMI Performance Intelligence direction stays in Phase 10 Competition Companion; any further enhancement is a new decision (#24).
- **(v2.22)** ARIA assistance in TW-4 SMS onboarding (deterministic guidance + knowledgebase article, TW-4 4E) and in Marketing (apply-to-draft, M-1).

**LOCKED DECISIONS:** Autonomy levels (Handle automatically / Prepare for review / Notify only / Off) and the permission ceilings above. Do not claim unreleased automation publicly. ARIA never submits or edits SMS registration data itself (TW-4).

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** ARIA plan gating vs AI-credit metering only (decision #8; v2.21 said "none", which conflicted with #8).

**DEPENDENCIES:** Phase 4, Phase 10 (organizer assistance), Phase 11, Phase 2/TW-4 (any SMS execution). (v2.23) Future ARIA Knowledgebase guidance — suggesting or opening articles — uses the Phase 17 KB-4 shared help API and the single article source; no separate ARIA knowledgebase.

**WEB IMPLICATIONS:** Operations UX in Phase 17.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Closed ARIA work is not reopened without evidence.

**BRANDING / POLISH CONSIDERATIONS:** Public ARIA claims limited to released behavior.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `docs/aria/*`, `src/lib/aria`.

---

## Phase 16 — Migration / Onboarding completion

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS (real-world pilot validation outstanding)

**OBJECTIVE:** Guided onboarding, Migration Center, source-specific imports, reconciliation, readiness scoring, issue resolution, a 30-day onboarding journey and pilot validation.

**PRODUCT INTENT:** A studio moves from another system into DanceFlow with confidence.

**COMPLETED CAPABILITIES:** Guided onboarding and 30-day health view; Migration Center (upload, batch detail, classification, package activation plan); Mindbody, WellnessLiving and Square mappers with pilot-readiness UIs; related migrations.

**REMAINING DELIVERABLES:** Execute real studio pilots per source and record the results (no pilot record or validation test exists); possibly additional importers if canonical scope requires; readiness-scoring and issue-resolution depth unverified.
- **(v2.22, AGENT-RECORDED PROPOSAL for the acceptance criteria; the Migration Center commitment itself is owner-named) Migration Center pilot gates:** one real pilot per supported source (Mindbody, Square, WellnessLiving), run against the existing QA checklists in `docs/migrations/`, with results and acceptance recorded in `docs/migrations/`; the phase is not COMPLETE until at least the in-scope sources pass. "Substantially complete" rests on code that has not been pilot-validated. Confirm the 2026-09-11 Mindbody `frozen` membership follow-up is closed (the mapper handles `frozen`; closure unverified).

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** Additional source importers (e.g., other studio platforms) — not approved.

**UNRESOLVED PRODUCT DECISIONS:** Which sources are in scope.

**DEPENDENCIES:** A real studio pilot (external).

**WEB IMPLICATIONS:** Part of Phase 17.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Import authority follows studio roles.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/app/app/settings/import`, `src/app/app/onboarding`, `src/lib/imports`.

---

## Phase 17 — Web application design-gap completion

**STATUS:** NOT STARTED (no formal completion pass; shell and accessibility QA happened under Branding only)

**OBJECTIVE:** A formal design-gap completion pass over the finalized web workflows, producing the canonical UX model for mobile.

**PRODUCT INTENT:** "Simple flow. Less cards." One obvious next action; progressive disclosure; right-side detail/context panels where practical; obvious expandable affordances; consistent statuses/actions; responsive behavior; consistent branding; empty/error/loading states.

**COMPLETED CAPABILITIES:** None as a formal pass. Authenticated shell branding and accessibility QA (BR-2C/2D) are done.

**REMAINING DELIVERABLES:** The pass across Studio, Organizer, Competition, Payroll, Documents, Marketing and related operational workspaces, **plus Discovery / Partner Match where applicable** (web request flow, listing management, moderation-state UX). Absorb PORTAL-UX-1/2 backlog. **Also owns (reassigned from Phase 4): the shared, reusable upgrade-prompt component and plan/usage display** (consistent upgrade and limit messaging across features, replacing the per-feature messages and the billing-page query-param landing).

**v2.22 — two distinct kinds of web work (priority item 7, "Web / Business UX audit and redesign"; the 17-I / 17-A split is ENGINEERING SLICING):**
- **17-I — Existing web admin UX improvements (can proceed incrementally now):** bounded, previously approved fixes and workflow improvements on today's web app — they are not blocked by the formal pass and should land with the phase that owns the workflow where possible (governing principle: UX quality is part of feature completion). The tracked list lives in the [Preserved commitments register](#preserved-commitments-register-v222) (e.g. New Client `/n`, Edit Event simplification, attendance correction/reversal, package eligibility and lifecycle UX, past-event detail state, PORTAL-UX-1/2, BR polish items) **and the New Student Intake workflow** (owner-approved direction: distinct from discovery lead capture; triggered when the first qualifying appointment is scheduled/confirmed; studio-selected service types and manual sending; branded and configurable; linked to the client record and visible to staff before the lesson — see the Preserved commitments register).
- **17-A — Formal web design-gap audit and redesign pass** (this phase's canonical objective): starts once upstream workflow phases are materially complete; its output is the canonical UX model consumed by Phase 18. It is a **web** audit; it does not decide or presuppose a separate Business app.

**(v2.23) Contextual Help Center & Knowledgebase Modernization (17-I track "17-KB") — DIRECTION OWNER-APPROVED (2026-10-13); KB-1 ACCEPTED as the preliminary baseline; implementation NOT authorized (each step below needs its own authorization); open questions D1–D7 undecided (decision #25).** Owner-named direction (2026-10-13 brief): turn the Knowledgebase into an accurate, complete support system that helps users finish tasks without leaving their workflow. **The content audit precedes the Help panel redesign** — no new Help interface may lead users to outdated or incorrect articles. Audit and plan: [`docs/knowledgebase/KB-1_Knowledgebase_Audit_and_Help_Center_Plan.md`](../knowledgebase/KB-1_Knowledgebase_Audit_and_Help_Center_Plan.md).
- *Current state (repository inspection at `858e74eb`, 2026-10-13; production facts only as documented in Current State and the release-holds table; no runtime production verification):* 79 public articles hardcoded in `src/content/knowledgebase/articles.ts` (last substantive update 2026-07-29; every edit needs a deploy); no role/plan/flag/status metadata; incomplete renderer (numbered lists, `###`, tables, links); the in-app "Knowledgebase" sidebar item leaves the app for the public site; no page links to any article. Audit result: 6 current, 65 need updates, 1 superseded, 6 duplicates, 1 wrong for role; 22 P1, including claims that contradict open release holds (duplicate check-in protection vs CI-B; SMS vs the fail-closed state; unsubscribe behavior vs M-0) and public overclaims.
- **KB-1 — Knowledgebase content and feature-parity audit.** Article-by-article matrix of all 79 articles against the released feature set as established by repository inspection plus documented flags, entitlements, roles and holds (availability values must be re-confirmed against the live deploy before publication); missing-article inventory; category structure; architecture. Docs-only. *Status: **ACCEPTED as the preliminary baseline** (owner, 2026-10-13).*
- **KB-2A — bounded fast lane (optional; separate authorization, D7).** Only text corrections to **existing** articles that inaccurately describe what is available: remove or qualify availability claims that the code and documented release state contradict (e.g. duplicate check-in protection, SMS sending, M-0 unsubscribe behavior, the student app, competitor registration, security overclaims); remove "future" wording for shipped behavior; replace nonexistent labels, paths, statuses and roles with the code's; fix role statements users cannot follow. About 20 articles. **Excluded:** new, merged or retired articles; slug changes; the new format, renderer, metadata or screenshots; any non-article code; documenting held or unreleased behavior; claims resting on unverified environment values. Each correction cites its evidence and is re-checked against the release state at release time; marketing wording reflects pre-M-0 behavior and is revisited at M-0 closeout. Gate: normal app release with a developer QA matrix plus owner acceptance of public wording. Does not replace KB-2C.
- **KB-2 — Content modernization and missing-article coverage.** 2B: one authoritative content source — proposed canonical format (storage is open question D1): one Markdown file per article with typed frontmatter (`status`, `visibility`, `roles`, `features`, `flags`, `contexts`, `related`, `redirectFrom`, `lastVerified`), a shared loader/index, an upgraded shared renderer, redirects for retired slugs (welcome-email deep links are a public contract), content-integrity tests. 2C: rewrite/merge/new articles in waves (Wave 1 = P1 high-frequency workflows: clients, scheduling, group classes, packages, memberships, payments/refunds, events, marketing) using a standard template (before you start → where to find it → numbered steps → what happens next → common problems → limits → related). About 130 articles in 15 categories after merges.
- **KB-3 — Persistent contextual Help button and right-side panel.** A Help control in the authenticated shell opens a non-modal right-side panel on desktop (full-height sheet on small screens) with search, categories, full step-by-step articles (full-content rendering with the same renderer and source as the public KB — not a preview), related articles, media, back navigation, a clear close control and loading/empty/error states, responsive on smaller screens. Role/plan/flag filtering is server-side. **Workflow-state preservation is a release requirement:** opening, using (search, browse, read, in-panel links, Back) and closing Help must preserve unsaved form values, open tabs and sections, dirty/validation state, scroll position, open in-page dialogs and the route/search parameters; the panel never navigates, never changes the URL, never calls the router and never submits, resets or autosaves a form. **It must be tested:** browser end-to-end tests on real forms with unsaved data (at minimum Add New Client, Create Event, a campaign draft and New lesson), desktop and mobile widths, asserting every value, tab, scroll position and URL is unchanged after open → use → close. Student-portal panel is a later follow-up (D4).
- **KB-4 — Page-specific article mapping and ARIA integration readiness.** Mappings are declared on articles (`contexts` route patterns), not hardcoded in page components; a route-pattern matcher ranks role- and plan-aware "Suggested for this page" articles (articles the viewer's role, plan entitlements or flags exclude are not suggested) while search covers the whole filtered KB. One shared `src/lib/help` API (search, get article, context suggestions) that future ARIA guidance must use — **no separate ARIA knowledgebase**. ARIA integration itself is not built here (Phase 15, separately authorized).
- **KB-5 — Ongoing governance and documentation maintenance.** The Definition of Done includes Knowledgebase maintenance (recorded under the ROADMAP MAINTENANCE RULE): "KB impact assessed" for new workflows, navigation/label changes, permission/entitlement changes, automation changes, payment/registration changes and retirements; article status workflow draft → reviewed (developer-verified against the released deploy) → published (feature released, flags on) → archived (slug redirected); CI checks (schema, slugs, routes, related links, stale-label denylist); stale-article report at release closeout.
- *Sequence and gates:* KB-1 (accepted) → [KB-2A optional, if authorized] → KB-2B → KB-2C Wave 1 → KB-3 + KB-4 (seed routes) → remaining KB-2C waves; KB-5 starts with KB-2B and is ongoing. Each engineering step is a normal app release with a developer-owned QA matrix (KB-3 includes the workflow-state preservation tests above).
- *SQL:* none for the recommended path (subject to D1). Optional, each needing its own decision and SQL gates: an article-feedback table; a database-backed CMS (only if decision #25 D1 chooses it).
- *Priority:* sits inside near-term item 7 (Web / Business UX); **does not displace items 1–6** (M-0, CI-B, CI-D, 10E/10F, TW-4, Marketing enhancements). Only KB-2A may run earlier, as an explicitly authorized content-only correction that touches no M-0/CI files.
- *Principles of the approved direction:* one authoritative article source for the public KB, the in-app panel and ARIA; never publish unreleased, held or flag-off functionality as available; retired slugs redirect, never 404; the panel never resets the user's workflow.

**LOCKED DECISIONS:** The finalized web workflows become the canonical UX model for mobile. Do not start the formal pass (17-A) before material upstream workflow phases are done; bounded 17-I fixes are not held by this rule.

**PROPOSED BUT NOT APPROVED:** (v2.23) The engineering recommendations attached to open questions D1–D7 for the Knowledgebase track (decision #25) — e.g. repository-file storage, public-by-default articles — are recommendations only, not decisions.

**UNRESOLVED PRODUCT DECISIONS:** None currently identified.

**DEPENDENCIES:** Material completion of Phases 5–7, 10–13 and closeouts 8, 9, 14, 15 (otherwise it must be redone).

**WEB IMPLICATIONS:** This phase is the web work.

**MOBILE IMPLICATIONS:** Output feeds Phase 18.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Permission-aware navigation depends on Phase 12.

**BRANDING / POLISH CONSIDERATIONS:** Final polish and brand consistency.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** No design-gap documents found.

---

## Phase 18 — Mobile App Architecture & Boundary Audit

**STATUS:** NOT STARTED

**OBJECTIVE:** A formal architecture decision: 1 app vs 2 apps vs 3 apps. **The final architecture is not locked.**

**PRODUCT INTENT:** Each user type gets a coherent app experience without duplicated or conflicting ownership.

**COMPLETED CAPABILITIES:** None as an audit. One mobile app exists (student).

**v2.22 clarification:** Phase 18 is an **architecture decision**, not a redesign and not a build. Its outputs are a decision record (app count, names, boundaries, navigation ownership, store strategy, auth/session model) and the inputs for Phases 19 and 20-D. **A separate DanceFlow Business app is NOT assumed or approved**; it exists only if Phase 18 decides so and the owner approves. Phase 18 should also consume the Competition Companion requirements (Phase 10), the Communities requirements (strategic module) and the 20-R readiness findings.

**REMAINING DELIVERABLES:** The audit covering hybrid users; role switching; workspace switching; independent instructors; organizer/studio overlap; competition staff; judges; scoring; Dancer Passport; authentication/session architecture; deep links; push routing; shared components; store listings; version/release ownership. Partner Match is a core dancer-app requirement; organizer promotion management placement is an input.

**LOCKED DECISIONS:** The audit precedes locking app count, names, navigation ownership or store strategy.

**PROPOSED BUT NOT APPROVED (leading hypothesis only):** **DanceFlow** = dancer/student/public; **DanceFlow Business** = studio/instructor/staff/organizer/competition operations; a possible third competition/judging app **only if** operational requirements justify it.

**UNRESOLVED PRODUCT DECISIONS:** App count and boundaries.

**DEPENDENCIES:** Phase 17; a competition requirement spec for judging and live heats (Phase 10); the permission model (Phase 12); messaging/push routing (Phase 11).

**WEB IMPLICATIONS:** Consumes the Phase 17 output.

**MOBILE IMPLICATIONS:** This is the mobile decision phase.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Authentication/session model across apps.

**BRANDING / POLISH CONSIDERATIONS:** Store identity decisions follow this phase.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `mobile/` contains only `student`.

---

## Phase 19 — DanceFlow Business app

**STATUS:** NOT STARTED (nothing exists). **v2.22: existence and architecture are NOT approved** — this phase is conditional on a Phase 18 decision and owner approval. Business-user mobile needs may instead be met by the responsive web app or another Phase 18 outcome.

**OBJECTIVE:** A mobile app for studio owners, instructors, staff, organizers and potentially competition staff/judges (subject to Phase 18).

**PRODUCT INTENT:** Run the business from a phone with permission-driven navigation.

**COMPLETED CAPABILITIES:** None currently identified (mobile partner push server groundwork exists).

**REMAINING DELIVERABLES:** Everything. Known requirements to carry in: permission-driven navigation; organizer featured-event/promotion management and event ROI reporting (if Featured Events is built); competition operational surfaces (judging, live heats) if in scope.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** The two-app hypothesis (see Phase 18).

**UNRESOLVED PRODUCT DECISIONS:** Existence and scope depend on Phase 18.

**DEPENDENCIES:** Phase 18; Phase 12 data-driven permissions; Phase 10 operational APIs; Phase 11 push routing; Phase 17 canonical UX.

**WEB IMPLICATIONS:** Web workflows are the model.

**MOBILE IMPLICATIONS:** This is the mobile build.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Permission-aware navigation and session handling.

**BRANDING / POLISH CONSIDERATIONS:** Business app identity and store assets.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** None.

---

## Phase 20 — Student App redesign + Google Play readiness

**STATUS:** NOT STARTED (redesign); an existing student app is the baseline

**OBJECTIVE:** Redesign the dancer/student app around finalized web workflows and the app-boundary decision, and make it store-ready.

**PRODUCT INTENT:** A polished DanceFlow dancer app: discovery, schedule, wallet, learning, partners, jobs.

**COMPLETED CAPABILITIES (baseline):** Expo student app v0.1.0 (`com.idanceflow.student`): auth, schedule/appointments, discover (events, studios, group classes, competitions, etc.), favorites, jobs, learn/curriculum/digital video, Lumi, partners (listing editor, requests, threads, report, block, near-me), wallet (packages, memberships, tickets, documents, rewards, payment requests, digital purchases), settings and push preferences.

**v2.22 — EXISTING EXPO STUDENT APP (audited at `24a37a15`):** Expo SDK 54, v0.1.0, `com.idanceflow.student`, about 70 routes backed by about 33 `/api/student` routes. A native **card-only event PaymentSheet already exists** (`mobile/student/app/events/[id]/register.tsx`, in use since 2026-07 and exercised by the PR #214/#215 QA), with a byte-identical shared ticket-pricing rule (CI-A). Apple Pay is not configured (empty merchant identifier); marketplace purchase is disabled in the app. Push is student-only; push tap routing for threads/partners is incomplete. **Not store-released** (privacy unlisted, `submit.production` empty; whether any build was ever published is UNVERIFIED). No automated mobile tests; dependencies pinned to `latest`; README scripts missing.

**REMAINING DELIVERABLES — split in v2.22 (readiness ≠ redesign; the owner asked to separate app readiness from redesign; the 20-R / 20-D item lists are ENGINEERING SLICING except Expo UI automation, which is OWNER-APPROVED):**
- **20-R — Student App readiness and mobile QA (existing functionality; does not redesign and does not depend on Phase 18):** Expo UI automation / emulator harness (owner asked to preserve this task, 2026-10-12); pin dependency versions; restore README/dev scripts; verify actual store-release status; privacy policy and data-safety declarations drafted from real data flows; crash/analytics posture decision; push tap routing for existing notification types; PaymentSheet regression coverage; remove the duplicate `partners/draft` screen. Store **submission** itself is an owner-authorized gate and normally waits for 20-D unless the owner decides to ship the existing app.
- **20-D — Student App redesign + Google Play release (gated on Phase 18):** redesign around finalized web workflows and the app-boundary decision; replace the retired couple/script logo and DF monogram icon; Partner Match accept/decline, thread push routing, web photo parity and refined UX; featured-event visibility if built; Competition Companion and Communities surfaces if approved; store listing assets, screenshots and Google Play release.

**LOCKED DECISIONS:** 20-D must not leapfrog unfinished web workflows or the Phase 18 audit. (20-R is maintenance/QA of the existing app and is not held by this rule.)

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Dependent on Phase 18.

**DEPENDENCIES:** Phase 18; Phase 6/7; Phase 14 closeout; branding identity decision for mobile.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** This is the mobile redesign.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Session/auth per Phase 18.

**BRANDING / POLISH CONSIDERATIONS:** App-store-facing identity and variants (waits on Phase 18).

**DEFERRED / POST-LAUNCH ITEMS:** Mobile PaymentSheet — **re-scoped in v2.22:** the event-cart PaymentSheet exists (card only); what remains deferred is Apple Pay / Google Pay configuration and PaymentSheet for non-event surfaces (marketplace, packages, Group Class direct payment).

**EVIDENCE / RELEASE REFERENCES:** `mobile/student`.

---

## Phase 21 — Public website / discovery expansion

**STATUS:** NOT STARTED (a mature discovery baseline exists)

**OBJECTIVE:** Expand public discovery and the public website, including the home of the Featured Events and Partner Match public capabilities.

**PRODUCT INTENT:** Make DanceFlow discoverable and valuable to dancers before any studio relationship exists.

**COMPLETED CAPABILITIES (baseline):** `/discover` (events, studios, jobs, partners), studio and organizer public pages, marketplace pages, embeds and public calendar APIs, sitemap for studios/events.

**REMAINING DELIVERABLES:** Partner Match acquisition landing, discovery path and web request path; cross-discovery (partner → studios/classes/events/competitions/jobs); Featured Events placement (if the product is defined and built); public class discovery (shared with Phase 6); acquisition/funnel analytics.

**LOCKED DECISIONS:** See the two strategic modules.

**PROPOSED BUT NOT APPROVED:** Featured Events placement.

**UNRESOLVED PRODUCT DECISIONS:** See modules.

**DEPENDENCIES:** Partner moderation queue (Phase 23 slice) before any public Partner Match promotion; Phase 22 for any monetization; analytics foundation.

**WEB IMPLICATIONS:** Public routes and SEO.

**MOBILE IMPLICATIONS:** Discovery parity with the student app.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Public listing exposure, location precision and unwanted-contact controls for Partner Match.

**BRANDING / POLISH CONSIDERATIONS:** Follows BR-4.

**DEFERRED / POST-LAUNCH ITEMS:** Public waitlist.

**EVIDENCE / RELEASE REFERENCES:** `src/app/discover`, `src/app/sitemap.ts`.

---

## Phase 22 — Regular v1 pricing cutover

**STATUS:** NOT STARTED (mechanism exists)

**OBJECTIVE:** Cut over from founder pricing to regular v1 pricing.

**PRODUCT INTENT:** Move to standard pricing deliberately, with the entitlement model settled.

**COMPLETED CAPABILITIES:** Founder and regular price definitions in `plans.ts` (studio and organizer); founder-pricing display switch (`isFounderPricingActive`); checkout selects between standard and founder Stripe price IDs by environment configuration; billing overrides for comp/ambassador. Current cutover state is unknown (environment values were not read).

**REMAINING DELIVERABLES:** The business decision and configuration cutover; pricing presentation; Featured Events monetization decision if applicable. ("Regular v1 pricing" does not exist under that name in the repo.)

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Cutover timing; Featured Events pricing model (see module). Partner Match stays free at first (locked direction).

**DEPENDENCIES:** Phase 4.

**WEB IMPLICATIONS:** Pricing page/presentation.

**MOBILE IMPLICATIONS:** Store/in-app billing implications are not decided.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Billing authority is hardened (LAUNCH-SEC-2A).

**BRANDING / POLISH CONSIDERATIONS:** Clear pricing communication.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/billing/{plans,founderPricing}.ts`.

---

## Phase 23 — Platform Admin / DanceFlow HQ expansion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS (a large baseline exists)

**OBJECTIVE:** Expand the internal HQ for running DanceFlow itself.

**PRODUCT INTENT:** Operate, support, moderate and monitor the platform.

**COMPLETED CAPABILITIES:** About 21 platform pages: index, studios, organizers, billing, accounting, expenses, sales, analytics, studio health, success, ops review, alerts, support notes, invites, credentials, webhooks, Wave, SMS (including per-studio registrations), mobile push.

**REMAINING DELIVERABLES:** Platform-admin MFA enforcement (#6, deferred); audit-log viewer; platform user/admin management; support access/impersonation; plan and entitlement management UI; cross-studio onboarding pipeline view; **Partner Match moderation queue**; **Featured Events controls** (if built); incident/announcement and compliance pages (judgment, not canonical requirements).

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** The non-moderation items above beyond MFA are suggestions, not approved scope.

**UNRESOLVED PRODUCT DECISIONS:** HQ scope.

**DEPENDENCIES:** Moderation queue precedes Partner Match public promotion and (v2.22) DanceFlow Communities.

**WEB IMPLICATIONS:** Admin UX.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Platform-admin authority is the most sensitive; MFA is deferred, not forgotten.

**BRANDING / POLISH CONSIDERATIONS:** Internal; carry deferred `platform/webhooks` `<h1>` polish.

**DEFERRED / POST-LAUNCH ITEMS:** Platform-admin MFA.

**EVIDENCE / RELEASE REFERENCES:** `src/app/platform/*`.

---

## Phase 24 — Data Loss Prevention

**STATUS:** NOT STARTED

**OBJECTIVE:** Data loss prevention controls.

**PRODUCT INTENT:** Protect customer data from unintended exposure or loss.

**COMPLETED CAPABILITIES:** None as DLP. Adjacent controls exist (rate limiting, upload and token helpers, bot protection, RLS closures).

**REMAINING DELIVERABLES:** Everything; scope not yet defined.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Scope and tooling.

**DEPENDENCIES:** **Phase 12 granular Team & Permissions (permission catalog and overrides) must precede DLP (owner sequencing, recorded v2.22).** Phase 25 shares evidence needs.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** This is a security phase.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** Post-launch by nature.

**EVIDENCE / RELEASE REFERENCES:** None found.

---

## Phase 25 — SOC 2 Type II

**STATUS:** FORMAL TYPE II ATTAINMENT PROGRAM NOT STARTED (start date subject to resource and operational-readiness planning). SOC 2 readiness — the underlying security controls — is an ongoing governance activity (v2.22).

**OBJECTIVE:** SOC 2 Type II readiness and attestation.

**PRODUCT INTENT:** Enterprise trust.

**COMPLETED CAPABILITIES:** Technical controls and public legal/security pages exist (security page, DPA, acceptable use, platform MFA setup, audit-log references). No policy documentation or SOC 2 artifacts found.

**REMAINING DELIVERABLES:** Everything.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**v2.22 — OWNER DIRECTION (2026-10-13 review): two parts.**
- **SOC 2 readiness — ONGOING GOVERNANCE ACTIVITY (not deferred).** Security-control work continues in every slice and is not postponed to this phase: least-privilege authorization and RLS, the developer-owned QA and security-review gates, secret handling (no secret exposure in tooling or logs), change management (reviewed PRs, separately authorized merge/SQL/promotion, rollback records), production access through scratch workdirs only, audit trails (consent, documents, payroll evidence, settlement exceptions), incident follow-up, and vendor/sub-processor awareness. Essential controls already identified elsewhere stay scheduled where they are: platform-admin MFA (#6), Phase 12 granular permissions, Phase 24 DLP, the deferred security register (N-S2, G2, #7, #9, raw RPC error text).
- **SOC 2 Type II formal attainment program — ON THE ROADMAP.** Policies and evidence collection, control mapping, readiness assessment, auditor selection, the Type II observation window and the report. Its **exact start date is subject to resource and operational-readiness planning** (decision #21). Starting the formal program later does not defer any essential control above.

**UNRESOLVED PRODUCT DECISIONS:** Formal-program start date and auditor (#21). Public "no SOC 2 claim" restriction stays in force until attestation.

**DEPENDENCIES:** Phase 24 (which itself follows Phase 12 granular permissions); platform admin MFA.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Inherent.

**BRANDING / POLISH CONSIDERATIONS:** Trust presentation.

**DEFERRED / POST-LAUNCH ITEMS:** Post-launch by nature.

**EVIDENCE / RELEASE REFERENCES:** `src/app/security`.

---

## Phase 26 — Later integrations / enterprise features

**STATUS:** NOT STARTED (a small integrations baseline exists)

**OBJECTIVE:** Later integrations and enterprise capabilities.

**PRODUCT INTENT:** Extend DanceFlow for larger and more connected customers.

**COMPLETED CAPABILITIES (baseline):** Google Calendar and Wave integrations. **Gusto: DORMANT (v2.22 correction — v2.21 listed it as an active baseline).** `GUSTO_INTEGRATION_ENABLED = false`; code and tables are retained for possible reactivation. Carried from Phase 9: the dormant Gusto "Last checked" timestamp still displays in server time.

**REMAINING DELIVERABLES:** Not yet defined. **Gusto reactivation** is a candidate item only if Gusto approves the integration (owner condition); it would then need a scoped slice and security review.

**LOCKED DECISIONS:** **(v2.22 — recording owner Decision 4, 2026-09-15)** the Gusto-specific integration is removed from the active product direction; Payroll Prep stays a provider-neutral DanceFlow capability and is not tied to Gusto; the Gusto implementation is preserved for possible future reactivation if Gusto approves the integration. Gusto is a separate future capability; **its pricing/tier is undecided** (the Payroll Prep Growth+ decision does not cover Gusto).

**PROPOSED BUT NOT APPROVED:** Seller payouts/Connect revenue split for the marketplace (also listed in Phase 14).

**UNRESOLVED PRODUCT DECISIONS:** Scope.

**DEPENDENCIES:** Later phases.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Per integration.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** All of it.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/integrations`.

---

## COMMERCE INTEGRITY LANE

**Added in v2.22.** A parallel lane (not a phase) for event, ticket and competition commerce integrity found after the launch-security and PAY-DC work. It reuses the locked Phase 10 rule that Competition OS has no separate payment stack: every fix here applies to event tickets and competition entries alike. Origin: the 10C.5 commerce audit (2026-10-11) identified three issues the owner treats as **holds on enabling public Competition registration** (early-bird overcharge, whole-payment refund, duplicate check-in); CI-A QA (2026-10-12) then found the webhook-ordering defect that became PAY-WH-1.

| Item | Scope | Status | Release reference |
|---|---|---|---|
| **CI-A — Early-bird ticket pricing integrity** | Shared server/mobile ticket-pricing rule (`src/lib/events/ticketPricing.ts`, byte-identical mobile copy); cart checkout refuses a stale client price (`ticket_price_changed`) | **COMPLETE / RELEASED** 2026-10-12 | PR #213 → `1e3deed7`; `dpl_267ZZtRbzExRAnbXN3SPwZiSTysP` promoted 18:18Z; no SQL. QA PR #214 → `733a20c0` (Stripe test-mode E2E; QA-only, no promotion) |
| CI-A historical impact | Read-only query (`docs/events/ci-a-early-bird-historical-impact.md`) to find past overcharges | **NOT RUN** — needs separate PROD read authorization; any remediation (refunds) needs its own authorization | — |
| **PAY-WH-1 — Event cart webhook ordering and settlement integrity** | Webhook claim leases on `payment_provider_events` (atomic dedupe), notification outbox, guarded two-phase settlement and release, settlement exceptions, capacity trigger fixes, direct-write guards; event cart and competition checkout are **card-only** | **COMPLETE / RELEASED** 2026-10-13 | PR #215 → `21ec7b6d`; PROD SQL M1 `20261116090000` → M3 `…091000` → M2 `…092000` → M4 `…093000` → M5 `…094000`, 10:30–10:31Z; `dpl_9GRhgfVhT6eDHyQooiqjXnEvpbj3` promoted 10:39Z |
| **PAY-WH-1A — Remediation (M5)** | Captured-payment exception money state, alert queue, acknowledge/resolve panel and platform page; box-office card-reader terminal holds; competition desk payment via `record_competition_checkin_payment`; staff refund/mark-paid locked for order-backed registrations; `event_payments.event_id` fill trigger where the column exists | **COMPLETE / RELEASED** (shipped inside PR #215) | as above |
| **PAY-WH-1B — Legacy platform-account Checkout Sessions** | Gated platform-account fallback for pre-2026-07-16 destination-charge Sessions (legacy attempt + order before 2026-07-18 + not direct/competition + `resource_missing`, then metadata proof); a paid legacy Session becomes a `mismatch_account` captured exception, never settled or released | **COMPLETE / RELEASED** 2026-10-13 | PR #216 → `24a37a15`; no SQL; `dpl_5BjsJaSPqn1qA3D4fCDijZbRNqqK` promoted 11:58Z. The four stuck legacy PROD orders reconciled to expired by the normal sweeper (12:15Z) |
| **CI-B — Atomic event check-in** | Ticket-code and manual check-in currently read `checked_in_at` then update by id with no `checked_in_at is null` guard, so concurrent scans can double-admit; make check-in compare-and-set (and use `canCheckInEventAttendees`), with a clear "already checked in" outcome; competition presence check-in reviewed for the same pattern | **PLANNED — NOT STARTED** (priority 2; app-only expected) | — |
| **CI-D — Ticket-attributed refund integrity** | `refundEventRegistrationAction` refunds the whole PaymentIntent (no amount) and is not wired to any UI; Stripe-dashboard refunds are allocated across every registration on the PaymentIntent (pro-rata partial, all-refunded full); there is no per-registration refund ledger or order refund flow. Deliver per-registration refund attribution (ledger + locked RPC), webhook attribution, a staff order-refund flow and competition-entry coverage | **PARTIALLY MITIGATED — NOT STARTED** (priority 3; SQL expected; payment-integrity review). PAY-WH-1A blocks the unsafe staff refund for order-backed registrations | — |

**PAY-WH-1 / 1B follow-ups (ENGINEERING FINDINGS and AGENT-RECORDED PROPOSALS — not owner-approved commitments; none started):**
- Studio-level page for payment exceptions that have no event (`event_order_settlement_exceptions.event_id` is nullable; today only the per-event panel and `/platform/payment-exceptions` show them). Agent-recorded follow-up.
- A paid legacy Session raises a second alert (`reconcile_stuck` after six attempts) alongside the `mismatch_account` captured exception; suppress the duplicate (SQL).
- 15 of 24 PROD `event_payments` rows have a NULL `event_id` from before PAY-WH-1; the M5 trigger fills new rows only. Any backfill is a data repair that needs explicit authorization.
- ACH / delayed payment methods stay disabled until a real ACH end-to-end test and an explicit decision.
- `outbound_deliveries` claim fields not cleared after send (Phase 11, cosmetic).
- QA fixture performance (Vitest timeouts, slow storage-upload E2E) and a dedicated Playwright CI environment (engineering hygiene).
- Raw RPC error text in commerce actions and `payment_provider_events` is still open (not addressed by PAY-WH-1; deferred register).
- EVENT-CAP-1 may overlap the PAY-WH-1 capacity-trigger and terminal-hold work; verify before scheduling.

**Closed by this lane:** deferred-register item "`payment_provider_events` dedupe is not database-atomic" (PAY-WH-1 M1 claim leases); commerce blocker "early-bird overcharge" (CI-A); the webhook-ordering priority defect (PAY-WH-1).

---

## STRATEGIC MODULE: FEATURED EVENTS

A distinct discovery/promotion capability. It is **not** ordinary event discovery and **not** "newly added/upcoming events". It spans Phase 10 (Organizer), 13 (Marketing), 19 (Business), 20 (Student), 21 (Public Discovery), 22 (Pricing), 23 (Platform Admin) and an analytics foundation. It is intentionally not buried in Phase 21.

**Status:** concept not built beyond a bare flag. A July 2026 discovery redesign (commit `d5c6ff3`, 2026-07-29) removed a static "Coming Soon" Featured Events block that had no data behind it; that removal does not show the concept was abandoned.

### IMPLEMENTED
- `events.featured` boolean exists (no migration for the column was found in the migration folder; it likely predates it — unverified).
- An organizer can set it ("Featured event" checkbox).
- A "Featured" badge appears on the public event page, the organizer public page, the studio dashboard list and the events list; a "Featured Events" count card shows on the events list.
- The organizer's public page can order featured events first.
- Ordinary discovery (public directory by start date with filters and near-me) and "Newly added events" (top 3 by created date) are separate concepts. The `featuredStudios` block on `/discover` is Studios, not events.

### NOT IMPLEMENTED
Meaningful Discovery placement; homepage placement; ranking model; scheduling/duration; expiry; purchase flow; approval/moderation; entitlement; Platform Admin controls; impression/ROI analytics; Student app integration; Marketing integration; ARIA integration. The current flag is self-service and unmoderated, so "Featured" carries no governed meaning.

### Classification of product rules
- **DECIDED:** Featured Events is distinct from ordinary/new-event discovery. The current flag/badge behavior exists as described.
- **PROPOSED:** premium/promoted placement; boosted event placement ("clear, limited, and labeled"); higher-priority promotion ("higher-priority promotion later" is the checkbox help text).
- **NOT DECIDED:** paid vs editorial vs hybrid; pricing; eligibility; duration; slots; geography; approval rules; organizer entitlement; per-event fee; platform fee; complimentary placement; refund handling; ranking algorithm; analytics contract; what happens to the current self-service checkbox.

### Technical, UX and analytics gaps
No placement model, approval workflow, purchase flow, entitlement or admin control. No homepage/discovery placement, organizer request or management workflow, or student-app surface. No impressions, clicks, views, saves, shares, registration conversion, ticket-revenue attribution, geography or organizer ROI reporting.

### Dependencies and placement
Phase 10 (organizer management), Phase 13 (promotion tie-ins), Phase 19/20 (management and visibility), Phase 21 (placement), Phase 22 (pricing/monetization), Phase 23 (controls and moderation), Phase 4 (entitlement), and an analytics foundation that does not exist.
**Placement:** a product-definition decision first (no build); implementation then sits within Phase 21, gated on Phases 22 and 23 and the analytics foundation.

### Branding restriction (current)
Until the product definition and governing behavior exist, public branding and launch messaging must **not** advertise a meaningful Featured Events promotion capability. Avoid public "Featured" claims beyond implemented behavior.

---

## STRATEGIC MODULE: PARTNER MATCH

**Strategic intent (LOCKED current direction):** Partner Match is a **free-at-first public acquisition and network-growth capability**. A dancer should be able to discover DanceFlow because they need a dance partner, **without requiring an existing DanceFlow studio relationship**. This direction stays locked unless explicitly changed later. Do not invent monetization.

### Implemented state
- Studio-independent, auth-owned profile/listing (`dancer_partner_profiles.user_id` → `auth.users`, defaults from the global `dancer_profiles`).
- Public `/discover/partners` (anonymous browse of published and approved listings; no login required).
- Explicit opt-in (visibility toggle); moderation gate (public requires approval); anti-advertising and contact-information filtering.
- In-app messaging threads and connection requests (requests are sent from the mobile app only).
- Favorites, block, report (RPCs and tables), push notifications (`partner_updates` preference).
- Mobile listing editor, mobile photo upload and display, mobile near-me.
- Rate limiting and a honeypot/min-time bot check.

### Identity architecture
**ACCOUNT** (auth user) vs **GLOBAL DANCER PROFILE** (`dancer_profiles`, DanceFlow-wide) vs **STUDIO CLIENT RECORD** (`clients`, studio-owned). Partner Match is a DanceFlow/global dancer capability, **not** studio-owned identity: no studio relationship or linked client record is required. Mismatches: Partner Search does not read `dancer_profiles.profile_visibility`; `allow_studio_badge` is hard-coded false. `clients.partner_client_id` is a separate studio-side partner link, unrelated.

### Field status
| Field | Status |
|---|---|
| Dance styles, role, goals/intent | COLLECTED, DISPLAYED, USED FOR MATCHING (filters) |
| Skill level, bio, city/state | Copied from the global profile; DISPLAYED; skill USED (filter); location in text search |
| Latitude/longitude | Columns exist; nothing in the save path writes them; radius filter excludes profiles without coordinates (web-created listings can't match) |
| Travel radius (`search_radius_miles`) | Column exists; not displayed or used |
| Availability | COLLECTED (free text), DISPLAYED, not used for matching |
| Photo | Mobile only; the web page does not render it; public storage bucket |
| Practice interests, partnership goals | Folded into one goals list |

### Current gaps
- No moderation admin UI; public approval requires someone to approve listings. Whether the public directory is effectively empty is **unverified** (no rows were queried).
- Web requests dead-end to login/mobile; no accept/decline workflow; no match history.
- No recommendation engine and no compatibility scoring.
- Web photo parity missing; location save/radius mismatch; travel radius unused; availability not used for matching.
- Public SELECT contains coordinates although the UI does not render them.
- The messages API accepts pending profiles (looser than the public policy).
- No age/minor/guardian model.
- Push thread deep-link routing missing (`routeFromNotificationData` has no `threadId` handler).
- Partner Match pages do not lead users into studio, class, event, competition or jobs discovery.
- No acquisition/funnel analytics.
- No Partner Match tests found; `partners/draft` duplicates the main mobile screen.
- No sitemap or marketing landing for Partner Match.

### Acquisition funnel (preserve; breaks today at several steps)
Partner Match discovery → DanceFlow account → global dancer profile → Partner Match opt-in → moderation → public listing → connection → broader studio/class/event/competition discovery → active DanceFlow user.
Today: discovery → login link works; account → profile → publish works (pending review); **moderation → public listing is blocked without manual approval**; **connection is mobile-only**; **onward discovery is a dead end**; analytics absent.

### Classification of product rules
- **DECIDED:** free-at-first public acquisition direction (locked); studio-independence; explicit opt-in, moderation gate, in-app-only contact, blocks (in code).
- **PROPOSED:** None recoverable beyond the locked direction.
- **NOT DECIDED:** whether free remains permanent or only initial; age/eligibility; studio visibility/control; accept/decline mechanics; moderation standards and ownership; public web photo behavior; any future premium model.

### Roadmap placement
- **Phase 20 Student App:** accept/decline, push routing, photo parity, refined Partner Match UX.
- **Phase 21 Public Discovery:** acquisition landing/discovery, web request path, cross-discovery, funnel completion.
- **Phase 23 Platform Admin:** moderation queue (a prerequisite for public promotion).
- **Shared analytics foundation:** acquisition and downstream conversion measurement.
- **Phase 17 Web UX:** Partner Match web flow and moderation-state UX are included in the design-gap pass.
- **Phase 18 Audit:** Partner Match is a core dancer-app requirement.
- **OPEN DECISION (owner):** whether to pull the moderation queue and web request path forward ahead of their canonical phases.

### Branding restriction (current)
BR-4 may describe an existing dance-partner directory but must **not** claim algorithmic matching, compatibility scoring, guaranteed connections, fast matching, an already-complete acquisition funnel, or "free forever". Do not create a Partner Match SEO/public launch push until moderation and a working web request path exist.

---

## STRATEGIC MODULE: DANCEFLOW COMMUNITIES

**Added in v2.22 (owner priority item 9, "DanceFlow Communities V1"; owner commitment "Communities governance and Student App integration").** No Communities code exists ("community" appears only in marketing copy).

**Status:** NOT STARTED. Product direction APPROVED (below); detailed V1 scoping is future product-definition work (open decision #20).

**APPROVED PRODUCT DIRECTION (OWNER-APPROVED; restated in the owner's v2.22 review, 2026-10-13)**
- **DanceFlow-governed communities** organized by **dance discipline** and by **region**. DanceFlow, not a studio, governs them.
- **Independent of studio ownership:** a community is not owned by, scoped to or controlled by a studio; dancers participate as DanceFlow users, consistent with the global-dancer identity model used by Partner Match.
- **Separate, optional studio/private spaces:** studios (and private groups) may have their own optional spaces, kept separate from the DanceFlow-governed discipline/regional communities.
- **No automatic CRM effects:** community membership **must not automatically create studio leads or clients** (same principle as competition registration identity in Phase 10).
- **Governance** and **Student App integration** are part of the commitment.

**Remaining V1 product-definition decisions (genuine; owner + design):** V1 discipline and region taxonomy and granularity; who may post and what content types V1 allows; moderation standards, staffing and escalation (who moderates DanceFlow-governed communities); minors/guardian participation rules; how studio/private spaces are created, governed and kept separate (and whether they are in V1); privacy and visibility of membership; whether any opt-in, consent-based path lets a member choose to connect with a studio (never automatic); relation to Partner Match, events and Competition Companion; notifications; entitlement and pricing (none implied).

**Reusable foundations:** Partner Match's user-generated-content safety controls (opt-in, moderation gate, contact-information filtering, block/report RPCs, rate limiting) and messaging threads; verified identity linking; Phase 11 notifications.

**Dependencies and placement:** Phase 12 (permissions and community roles), **Phase 23 moderation queue** (a shared prerequisite for Partner Match public promotion and Communities), Phase 11 (notifications), Phase 18 (which app hosts it) and Phase 20-D (Student App integration), Phase 24 (DLP posture for user-generated content).

**Branding restriction (current):** no public claim of a DanceFlow community feature until it exists.

---

## PRESERVED COMMITMENTS REGISTER (v2.22)

**Purpose:** the owner asked (2026-10-13) that named commitments and previously approved UI fixes and workflow improvements be placed explicitly in the roadmap or a maintained backlog, and not dropped silently. This register is that maintained backlog. Each row names its canonical home; the phase sections remain authoritative for scope. "Owner-approved" means an owner-typed instruction was found; "agent-recorded" means it exists only in release notes or session task chips and needs owner confirmation before it becomes a commitment.

### A. Owner-named commitments (2026-10-13 brief)

| Commitment | Canonical home | v2.22 status |
|---|---|---|
| Marketing campaign drafts, block editor, image support, ARIA integration, event-link picker | Phase 13 M-1, M-3, M-4, M-1/M-7, M-5 | Planned; M-0 compliance first |
| Automated Twilio SMS onboarding (no routine founder Console work) | Phase 2 TW-4 | Direction approved; implementation not started |
| ARIA operational automation | Phase 15 (execution-scope expansion; organizer ARIA; cleanup A–D) | Partial: email execution for 5 rules only |
| Granular Team & Permissions before DLP | Phase 12 (prerequisite of Phase 24, recorded) | Partial: fixed roles + export overrides only |
| Commerce and digital entitlements | Commerce Integrity lane (CI-B, CI-D, follow-ups); Phase 14 (refund → access decision #16, wallet page, settlement pattern); Phase 4 (#8) | Event commerce hardened (PAY-WH-1); digital products not yet aligned |
| Migration Center | Phase 16 (per-source pilot gates) | Built, not pilot-validated |
| Gusto | Phase 26 (dormant; reactivation only on Gusto approval; Decision 4) | Dormant by decision |
| SOC 2 Type II | Phase 25: readiness is an ongoing governance activity; the formal Type II attainment program stays on the roadmap (after Phase 24 and platform-admin MFA) | Formal program start subject to resource/readiness planning (#21); essential controls not deferred |
| Web/Business UX audit and redesign | Phase 17 (17-I, 17-A) → Phase 18 → Phase 19 only if approved | Not started (formal pass) |
| Student App readiness and redesign | Phase 20-R, 20-D | Existing app not store-released |
| New Student Intake | Phase 17-I workflow item (section C); delivery Phase 11; signed documents Phase 8 | Direction owner-approved; not started; remaining design decisions #23 |
| LUMI enhancements | Phase 15 "LUMI" sub-track (section C); mobile delivery Phase 20; Performance Intelligence stays in Phase 10 Competition Companion | Existing functionality released and preserved; Performance Intelligence owner-approved (future); any further enhancements are new decisions (#24) |
| Communities governance and Student App integration | [DanceFlow Communities strategic module](#strategic-module-danceflow-communities) | Direction owner-approved; detailed V1 scoping future (#20) |
| Organizer parity | Phase 10 "Organizer parity matrix" (section C) | Partial; spread across Phases 10, 11, 13, 15 |
| (v2.23) Knowledgebase modernization and contextual in-app Help Center (right-side panel; role/plan-aware page suggestions; single source shared with ARIA; KB governance in the Definition of Done) | Phase 17 17-I track "17-KB" (KB-1 – KB-5, KB-2A fast lane) | Direction owner-approved 2026-10-13; KB-1 accepted as the preliminary baseline; nothing implemented or authorized; D1–D7 open (#25) |

### B. Previously approved UI fixes and workflow improvements (not previously tracked in v2.21)

| Item | Source | Approval | Canonical home |
|---|---|---|---|
| Edit Event simplification (old publishing UI; save rewrites every column and recreates child rows) | Owner prompt 2026-10-10 ("carry forward") | Owner-approved | Phase 10 event side (17-I) |
| Attendance correction / reversal workflow (permissions, reason, audit; usage, capacity and payroll correction) | Owner prompt 2026-09-12 ("do not implement, but add to roadmap") | Owner-approved | Phase 17-I; touches Phases 5, 9 |
| Package eligibility and lifecycle UX (remaining count in selectors, hide depleted/expired, archive lifecycle, auto-select, bounded reservation horizon; `block_depleted_package_booking` left dormant; self-service eligibility uses the UTC date) | Owner prompt 2026-09-12; PR #184 delivered part | Owner-approved (UTC-date item agent-recorded) | Phase 17-I; related to decision #4/#10 |
| Competition youth / multiple pricing categories; spectator admission tickets; hotel room blocks; scholarship offerings | Owner-identified 2026-10-11 (10C.5) | Owner-approved | Phase 10 (event side / 10H–10J+) |
| Dedicated Playwright CI environment | Owner prompt 2026-10-12 ("preserve") | Owner-approved | Deferred register — engineering hygiene |
| Expo UI test automation | Owner prompt 2026-10-12 ("preserve") | Owner-approved | Phase 20-R |
| Past event detail still shows registration / spots remaining | Cleanup PR B follow-up | Agent-recorded | Phase 10 event side (17-I) |
| Already tracked in v2.21 and kept: New Client `/n` bug; inactive-client portal access; PORTAL-UX-1/2; BR polish (focus ring, nested `<main>`, webhooks `<h1>`, invalid-logo fallback); upgrade prompt; Competition Companion + LUMI Performance Intelligence; competitor identity follow-ups; N-S2, G2, PAY-DC-4B; DEV drift items; BR-6/BR-7; demo-request capture; per-event print attribution; Payroll 9E narrow-width check; GC-S1C/S1E bounded follow-ups; portal-only classes; GC-3.4B identity items | — | — | Unchanged locations |

### C. Commitments without a previous roadmap owner (placed in v2.22)

**New Student Intake (NSI) — studio workflow item (canonical home Phase 17-I; delivery through Phase 11; any signed documents through Phase 8). NOT STARTED. Product direction OWNER-APPROVED** (restated in the owner's v2.22 review, 2026-10-13; it was not previously in the roadmap — Phase 16 "Onboarding" is studio migration, not student intake):
- **Distinct from discovery lead capture.** Intake is not the public lead / intro-lesson contact form and not lead creation; those stay as they are.
- **Trigger:** sent when the student's **first qualifying appointment is actually scheduled/confirmed** — not on inquiry or lead creation.
- **Studio-selected service types:** the studio chooses which appointment/service types qualify.
- **Manual sending** is also supported (staff can send or resend intake on demand).
- **Branded and configurable** (studio branding through the existing branded shell; studio-configurable content).
- **Linked to the client record**, and **accessible to staff before the lesson**.

Existing pieces it can build on: the client record, the `intro_lesson` appointment type and appointment confirmation flows, dance goals (`student_dance_goals`), the branded email shell, and Phase 8 envelopes for anything that must be signed.

**Genuine remaining design decisions (owner + design; decision #23):** (1) the exact trigger event when scheduling and confirmation differ (on booking vs on confirmation), and behavior on reschedule or cancellation before completion; (2) what "configurable" covers in v1 — editable questions/sections vs a fixed DanceFlow template with studio toggles; (3) once per student per studio vs re-sendable on a new service type; (4) completion path — tokenized link without an account vs Student Portal sign-in; (5) reminders if incomplete before the lesson; (6) minors — who completes it (guardian) and how it links to the guardian relationship; (7) whether intake may include a signature/waiver step (then it uses Phase 8 envelopes, not a second signing engine); (8) delivery channels (email by default; SMS only within the registered transactional scope); (9) retention and visibility of intake answers (staff roles that can see them, Phase 12).

**LUMI — Phase 15 sub-track "LUMI Dance Journey Assistant".** LUMI had no owning phase; v2.22 gives current-assistant work to Phase 15 (one owner for AI assistants), mobile delivery to Phase 20, and keeps Performance Intelligence in Phase 10 Competition Companion.

*Existing functionality (released; preserved — must not regress):* studio-level toggle (`lumi_enabled`); Growth/Pro gating through the shared billing-plan resolver (override-consistent since the 2026-09-15 billing-override fix); active students only; AI-allowance metering and usage recording; web Student Portal **Journey**: dance goals (create/complete), "ask LUMI" practice guidance using studio context (lesson recaps, syllabus progress, digital learning), and the LUMI practice-plan generator before the next lesson; mobile Student App **LUMI** assistant screen (schedule, practice plan and progress questions, with the context LUMI may use shown to the student); response reporting (`lumi_response_reports`).

*Previously approved commitments (OWNER-APPROVED):* **LUMI Performance Intelligence** (2026-10-11) — analyzes Country, Ballroom and WCS separately; preserves each governing body's scoring semantics; identifies only evidence-supported longitudinal trends; suggests training priorities; shares findings with instructors only with the dancer's explicit permission; lives in the Student App as part of Competition Companion; depends on 10F released results. *Public-copy rule* (2026-10-03): describe LUMI publicly only as currently real student/dancer assistance; do not force LUMI into every page.

*Genuinely new decisions (decision #24):* any LUMI enhancement beyond the above (none was found as owner-approved in the repository or session history) — e.g. new data sources, instructor-facing LUMI, proactive nudges, or plan placement changes (decision #8).

**Organizer parity — Phase 10 "Organizer parity matrix".** Owner direction: studio and organizer events are the same event product differing in ownership/business context (2026-09-08); "studio + organizer parity — do not leave one surface unenforced" (2026-10-03). Matrix to maintain:

| Capability | Studio | Organizer | Owner of the gap |
|---|---|---|---|
| Campaign draft editing | Missing | Exists | Phase 13 M-1 |
| Campaign composer / unsubscribe implementation | Separate | Separate | Phase 13 M-2 |
| Campaign allowance (ENT-1) | Enforced | Enforced | Done |
| ARIA | Full operations | Partial read-only view in `/app/aria` | Phase 15 |
| Notification center | Full | Partial organizer mode in `/app/notifications` | Phase 11 / Phase 10 |
| CRM depth (`organizer_contacts` vs studio clients) | Full | Lighter | Open question: intentionally lighter or incomplete (owner, 2026-09-08) |
| Organizer-owned standalone Group Classes | Yes | Not supported | Phase 5 follow-up (owner raised 2026-09-08; scope undecided) |
| Roles / permissions | Fixed roles | `organizer_owner/admin/staff`; `organizer_staff` has full authority | Phase 12 / 10E |
| Profitability, volunteer/staff UI | n/a | Missing | Phase 10 event side |

### D. Other preserved follow-ups added in v2.22 (agent-recorded; owner confirmation pending)

ARIA cleanup follow-ups A–D (Phase 15); GC-R1 reminder gaps (Phase 11); outbound claim fields (Phase 11); PAY-WH follow-ups and NULL `event_id` backfill (Commerce Integrity lane); event commerce authority hardening (Phase 10 / deferred #7); 10A/10C/10C.4/10D/10C.5 carry-forwards (Phase 10); DEV/PROD/repo drift additions, QA fixture performance, launch-audit forensics (deferred register). The Phase 8C "guardian delivery for clients without email" follow-up was delivered by 8D and is closed.

**(v2.23) Engineering findings from the KB-1 audit — REQUIRE SEPARATE VALIDATION.** These come from repository inspection only, not runtime or production verification. They are **not confirmed defects** and **not authorized implementation work**. Each needs validation (reproduce in DEV/local, or explain as intended) and, if confirmed, its own triage, slice and authorization. None is part of the KB track.
- **Possible studio website calendar feed URL mismatch:** `/app/events` shows `/studios/{slug}/events.ics` (`src/app/app/events/page.tsx:845`), but the route is `src/app/studios/[studioSlug]/event.ics` and no rewrite was found. If confirmed, studio feeds would 404; organizer feeds look correct. Home: Phase 10 event side.
- **Public intro booking requests — no staff approve/decline UI found:** `/app/schedule/requests` redirects to `/app/schedule/self-service`, which reads only `student_booking_action_requests`; `approveBookingRequestAction` / `declineBookingRequestAction` have no UI caller; Leads shows request state only. Product decision (intended vs regression) needed. Home: Phase 5 / 17-I.
- **Organizer owner/admin and `/app/payments` (possible redirect):** workspace roles normalize to `organizer_owner`/`organizer_admin`, which `canViewPayments` excludes. As read, the organizer "Ticket Sales & Payments" item and the "Connect payouts" checklist task would redirect to `/app`. Not run. Home: Phase 10 / Phase 12.
- **Public Knowledgebase AI assistant (possible abuse/cost exposure):** as read, unauthenticated with no rate limit or bot protection; calls OpenAI when `AI_FEATURES_ENABLED=true` (PROD value unverified). Home: Phase 24-adjacent hardening; related to decision #25 D3.

---

## DEFERRED / POST-LAUNCH REGISTER

None of these becomes immediate roadmap work without an explicit decision. Do not implement from this list.

**Security / hardening**
- Platform-admin MFA expansion (#6)
- Event staff-role / action-role hardening (#7)
- Notification-preference membership hardening (#9)
- N-S2: broad studio SELECT (portal-aware privacy hardening)
- G2
- Add-on GET → POST
- Raw RPC error text in commerce actions
- Raw RPC error text stored in `payment_provider_events` by the Stripe webhook (GC-3.5 follow-up)
- Redundant PROD deduction-errors index cleanup

**Payments / commerce**
- PAY-DC-4B: legacy/null-owner cleanup
- PAY-DC-2C F1–F3
- EVENT-CAP-1
- Mark-paid redirect bug (a swallowed redirect always shows a failure message)
- Two-step `logEventPayment`
- Pre-2A async failure skip
- Confirm-route push
- Seller payouts / revenue split for the marketplace
- Mobile PaymentSheet — **re-scoped (v2.22):** the event-cart PaymentSheet exists; Apple Pay / Google Pay and non-event surfaces remain deferred (see Phase 20)
- PKG-REFUND-2 package-credit ledger for staff refunds depends on `refund.created` webhook timing (GC-3.5 follow-up)
- ~~`payment_provider_events` dedupe is not database-atomic (GC-3.5 follow-up)~~ — **CLOSED (v2.22)** by PAY-WH-1 M1 webhook claim leases (PR #215, PROD 2026-10-13)
- (v2.22) PAY-WH-1/1B follow-ups — see the [Commerce Integrity lane](#commerce-integrity-lane)
- (v2.22, AGENT-RECORDED PROPOSAL) EVENT-CAP-1: verify overlap with PAY-WH-1 capacity and terminal-hold changes before scheduling

**Product decisions / future work**
- Group-class depleted-credit behavior (#10)
- Portal-only / member-only Group Classes (unsupported; GC-3.5 follow-up)
- "This and following" edits do not propagate Group Class direct-payment settings (GC-3.5 follow-up)
- Floor-rental studio-authoritative pricing/approval redesign
- Public waitlist
- Featured Events governing/business model
- Partner Match age, moderation and future-monetization details
- Final mobile app boundary (Phase 18)

**Engineering hygiene**
- Repo-wide lint debt: about 293 errors and 378 warnings pre-exist (CI lints changed files only). Not a launch blocker.
- **New Client page `/n` display bug (bounded UI polish):** New Client page shows a literal newline marker (`/n`, from literal `\n` text in the JSX around the "Personal details" and "Client photo" sections of `src/app/app/clients/new/page.tsx`) where a line break / layout break was intended. Fix: replace the visible marker with the intended newline, spacing or layout and verify the New Client page renders cleanly. Small UI/polish bug, not a redesign; not a launch blocker.
- **DEV `accounting_upsert_entry` drift:** DEV runs an untracked variant (md5 `a2779c25219dc8fd50a781985e6909db`); the repository and PROD are canonical (`548b512c2cf4ca3534ff2541594a1c7c`). Take migration precondition pins from the repository, not the DEV catalog. Repair in its own gate.
- **Floor-rental index drift:** `payments_floor_rental_pending_studio_client_key` exists on DEV but not PROD. Investigate in its own gate.
- **Legacy SQL-suite failures (seven, pre-existing):** gc1_1, gc1_2, gc1_4a, gc3_1, gc3_2 (instructor-assignability fixture setup), h2c1 and launchsec1ca. Not repaired in GC-3.5.
- **(v2.22, ENGINEERING FINDING) Additional DEV/PROD/repo drift:** `event_payments.event_id` (and migration `20260502000600`) is missing on DEV but present on PROD (PAY-WH-1 M5 handles both); `uq_accounting_entries_event_payment_source` exists on DEV and PROD but not in the repository; `event_document_requirements` has no repository DDL. DEV `attendance_records` has a unique `(event_registration_id)` not in the repository. Repair each in its own gate; pin from the repository.
- **(v2.22) Test infrastructure:** dedicated Playwright CI environment (the CI Playwright job is skipped because E2E secrets are absent; owner asked to preserve this task 2026-10-12); Expo UI automation (Phase 20-R); QA fixture performance (Vitest timeouts, slow storage-upload E2E).
- **(v2.22, AGENT-RECORDED PROPOSAL) Launch-audit forensics:** `legacy_email_repair` rows review deferred pending approval.

---

## COMPLETED LAUNCH WORK REGISTER

Inserted ahead of the numbered sequence; all released and closed. Do not reopen without concrete regression evidence.

- **Launch security:** LAUNCH-SEC-1A (payroll authorization fail-closed), 1B/1B2 (private client photos, public asset storage authorization), 1C-0/1C-0-R (legacy auth surfaces; #123, #124), 1C-A/A1 (verified email proof; #125, #126), 1C-B (verified email enforcement; #127), 2A (owner billing authority; #128), 2B (tenant write surfaces: deduction errors, job postings, floor rentals; #129), 2C (event zero-total guard; #130).
- **Payments / package integrity:** PAY-DC-1 through 4A (#109–#115), PKG-MUT-1 (#116), PKG-REFUND-1 (#117), PKG-REFUND-2 and hold release (#118; `PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = false`).
- **(v2.22) Commerce integrity (post-launch, released):** CI-A (#213), PAY-WH-1/1A (#215), PAY-WH-1B (#216). Open items in the same lane (CI-B, CI-D) are tracked in the [Commerce Integrity lane](#commerce-integrity-lane), not here.
- **SMS A2P:** SMS-A2P-1 through 3C (#131–#134).
- **Final non-Twilio launch gate:** typecheck, 3082 tests, production build and diff check clean on main `2266f5f`; no engineering launch blockers; launch-critical migrations present in PROD (catalog check).

---

## Open product decisions (consolidated)

1. Featured Events governing/business model (paid vs editorial vs hybrid; eligibility; duration; ranking; analytics; fate of the self-service flag).
2. Partner Match: permanence of free access; age/eligibility; studio visibility/control; accept/decline; moderation standards and ownership; web photo behavior; any premium model.
3. Whether to pull Partner Match moderation and the web request path forward.
4. Group-class depleted-credit behavior.
5. Floor-rental authoritative pricing/approval model.
6. Final mobile app boundary (Phase 18).
7. Landmark 1A canonical closeout scope (invitation flow, seat UI, audit viewer).
8. Phase 4 plan placement for SMS, marketplace and ARIA (payroll resolved — see below). **Open; blocks the remaining Phase 4 implementation for those features** (SMS allowance and quantity, marketplace/ARIA tiers, ARIA gated by plan vs AI credits only, tie to Phase 22 pricing). No speculative `BillingFeature` keys for undecided features. **v2.22 progress:** **Payroll Prep = Growth+ — RESOLVED** (owner-approved 2026-09-15, reaffirmed 2026-10-13; enforcement and billing key not yet implemented); SMS commercial *direction* set by TW-4 D7 (amounts open). The other 2026-09-15 tier statements (Documents Growth+, ARIA Core with metered usage, seat and location limits) are recorded in Phase 4 as evidence and are not ruled on in v2.22.
9. **CLOSED (2026-10-08, Phase 8D):** Documents scope: waivers and receipts. A waiver is a Documents template / use type on the canonical envelope lifecycle (no separate waiver engine); the envelope completion (signing) certificate is the canonical evidence receipt for Documents; payment receipts stay in Commerce.
10. **CLOSED (2026-10-09, Phase 9B):** Payroll "exported/finalized" state. No distinct status was added; approval and export are recorded as immutable evidence.
11. **PARTLY CLOSED (2026-10-09, v2.21):** Competition scoring systems for studio v1 are approved (Phase 10), and v1 judging is web with authenticated accounts. Whether a separate judging app exists remains open (Phase 18).
12. Pricing cutover timing.
13. Video cut list (BR-6) and the banner vendor (BR-5 follow-up).
14. **(v2.22; previously only in Current State)** Demo-request / interest-capture storage (deferred to Marketing/CRM; needs a storage decision).
15. **(v2.22; previously only in Current State)** Per-event print attribution (static QR codes cannot distinguish events; per-event print run or a signup survey question).
16. **(v2.22)** Digital products: does a refund revoke or retain digital access (and do partial refunds differ)? (Phase 14.)
17. **(v2.22)** Marketing: separate marketing sending subdomain; recipient marketing-consent scope (CAN-SPAM-only vs CASL/GDPR-ready). (Phase 13.)
18. **(v2.22)** Team & Permissions: whether custom roles are in scope (moved here from Phase 12 so it is visible).
19. **(v2.22)** Migration Center: which import sources are in scope beyond Mindbody, Square and WellnessLiving (moved here from Phase 16).
20. **(v2.22)** DanceFlow Communities V1 detailed scoping (direction approved: DanceFlow-governed discipline and regional communities, independent of studio ownership, separate optional studio/private spaces, no automatic leads/clients). Open: taxonomy, posting/content scope, moderation staffing, minors, studio/private-space governance, privacy, any opt-in studio connection, relation to Partner Match/events. (Strategic module.)
21. **(v2.22)** SOC 2 Type II formal attainment program: start date and auditor, subject to resource and operational readiness planning (Phase 25). Readiness work is ongoing and is not deferred.
22. **(v2.22)** Multi-Dance: when Multi-Dance results become operational and the registration hold lifts (10H scope; the hold is a release gate, the scope is a product decision).
23. **(v2.22)** New Student Intake remaining design decisions (direction approved; see Phase 17 / Preserved commitments register).
24. **(v2.22)** LUMI: which new enhancements, if any, beyond existing functionality and the approved Performance Intelligence direction (Phase 15).
25. **(v2.23)** Knowledgebase / Help Center open questions (Phase 17 KB track; all undecided — the engineering recommendations in the KB-1 audit §9 are not approved): **D1** article storage — repository files vs a database-backed CMS; **D2** which articles are public vs signed-in-only; **D3** the future of the public Knowledgebase AI assistant — consolidate into ARIA on the shared help API, keep, or remove; **D4** when the student-portal Help panel is built; **D5** screenshot policy — scope, capture source and maintenance; **D6** whether and when to document the Competition workspace; **D7** whether to authorize the bounded KB-2A correction fast lane.

*Superseded in v2.22:* Phase 2 "Mixed vs Customer Care" (→ TW-4 D4). *Resolved direction, verification pending:* TW-4 D1–D7 are established directions, not open decisions (see Technical verification gates).

## Technical verification gates (v2.22; not product decisions)

These are facts engineering or a third party must confirm. They do not need an owner product choice, but they gate specific work.

| Gate | Gates | Owner of the check |
|---|---|---|
| Twilio Q1 — subaccount registration with parent credentials, parent-profile assignment, webhook signing per subaccount, studio-exit lifecycle | TW-4 4B–4D | Twilio (ticket #29647095) + engineering |
| Twilio Q2 — default opt-out/HELP behavior and webhook delivery without Advanced Opt-Out; campaign OptOut/Help fields | TW-4 4B, 4D | Twilio + engineering |
| Twilio Q3 — studio-scoped SMS Terms/Privacy pages on a different domain from the studio's website | TW-4 4C/4D for studios with their own website | Twilio |
| Twilio Q4 — Low-Volume Standard + `LOW_VOLUME` suitability, upgrade path, industry value | TW-4 4C | Twilio |
| Twilio Q5 — campaign-update API enablement; Event Streams sink placement; compliance mailbox; pre-submission review of the first generated package | TW-4 4B, 4F | Twilio |
| Live Stripe Connect webhook subscriptions include `checkout.session.expired` and `checkout.session.async_payment_failed` | Public Competition registration | Engineering (read-only check) |
| Real ACH end-to-end test | Enabling delayed payment methods | Engineering |
| CI-A historical overcharge query on PROD | Deciding whether remediation is needed | Engineering, after separate PROD read authorization |
| Marketing vs transactional sender-domain separation (live env values) | M-0 closeout; decision #17 | Engineering (read-only; no secret values printed) |
| ARIA matrix (7 default auto-send) vs executable allowlist (5) degradation behavior | Phase 15 closeout | Engineering |
| EVENT-CAP-1 overlap with PAY-WH-1 capacity work | Scheduling EVENT-CAP-1 | Engineering |
| Student App store-release status (any published build?) | Phase 20-R scoping | Engineering + owner store accounts |
| Migration Center per-source pilot results | Phase 16 completion | Engineering + pilot studios |

## Owner business-acceptance gates (v2.22)

Functional QA is developer-owned (untested work is BLOCKED, not PASSED); these gates are owner **business acceptance** only.

- Schedule & Heats walkthrough (10C.2 Create Event + 10D) — gates 10E.
- Organizer walkthrough and verified "this is me" walkthrough (10C.1) — gate public Competition registration.
- Explicit acceptance of whole-order refund behavior (until CI-D) and buyer-signed waivers (10C.1).
- ConfiDance owner completes TW-4 onboarding in production (4F); pilot retrospective sign-off before automatic activation (D5).
- Any merge, PROD SQL, promotion, commerce enablement (flags), financial correction or store submission remains a separate explicit authorization.

---

## Roadmap information that could not be confidently preserved

- The original roadmap source is not in the repo; the 26-phase list and per-phase intent come from the owner's canonical list plus reconciliation. Phase "product intent" sentences are summaries of that list, not quoted requirements.
- Landmark 1A's canonical slice list beyond the nine migrated slices.
- The exact contents of the earlier Featured Events and Partner Match discussions beyond what is recorded in the repo and the owner's reconciliation briefs.
- Branding assets/specs for promotional media (BR-6; none exist in the repo). Collateral assets and specs exist from BR-5 under `docs/brand/collateral/`.
- (v2.22) The owner restated the approved directions for New Student Intake and DanceFlow Communities during the v2.22 review; their earlier source discussions are not in the repository or the available session history. No owner-approved LUMI enhancement list beyond Performance Intelligence was found.
- (v2.22) Production releases of Phase 10 slices and CI-A are recorded from the operator's release records; the commit bodies (written at PR time) say "DEV only".

---

## v2.22 RECONCILIATION LEDGER

Itemized list of roadmap entries **closed, added, moved or superseded** in v2.22. Nothing was deleted; superseded text is kept and marked.

**Closed / marked complete (released work recorded)**
- Phase 10 slices 10A, 10B, 10C, 10D (were "NEXT"/"Planned"); inserted slices 10C.1, 10C.2, 10C.4, 10D.1, 10C.5 recorded as released; 10C.3 recorded as an audit.
- Phase 10 "Known foundation defects / drift (to be fixed in 10A; not yet fixed)" → addressed by 10A.
- Phase 10 remaining item "canonical event-level competitor identity" → delivered by 10C.
- Commerce: CI-A, PAY-WH-1/1A, PAY-WH-1B recorded as released; commerce blocker "early-bird overcharge" closed.
- Deferred register: "`payment_provider_events` dedupe is not database-atomic" → closed by PAY-WH-1 M1.
- Phase 8C follow-up "guardian delivery for clients without email" → recorded as delivered by 8D.

**Added**
- Owner review corrections (PR #217 revision): provenance labels in Status vocabulary; New Student Intake approved direction + remaining decisions (#23); Communities approved direction; LUMI existing functionality / approved commitments / new decisions (#24); SOC 2 two-part direction (ongoing readiness + formal Type II program); Payroll Prep tier = Growth+ recorded as decided (enforcement pending), other Phase 4 pricing decisions unchanged; Current State archive file.
- Sections: Near-term priority order (v2.22); Release holds and gates; Commerce Integrity lane; Strategic module: DanceFlow Communities; Preserved commitments register; Technical verification gates; Owner business-acceptance gates; this ledger.
- Phase 2: TW-4 (approved direction, D1–D7 table with verification requirements, slices 4A–4G); locked "no routine founder Console onboarding" and "ConfiDance pilot uses the real automated flow".
- Commerce: CI-B, CI-D, PAY-WH follow-ups, CI-A historical impact (not run).
- Phase 10: released-slices table, profile `@3`, Multi-Dance pull-forward and hold, remaining v1 milestones, owner acceptance gates, organizer parity matrix pointer, Edit Event simplification, past-event detail state, competition commerce requirements (youth pricing, spectator tickets, hotel blocks, scholarships), event commerce authority hardening, 10C and format carry-forwards.
- Phase 11: Event Streams / 21610, outbound claim fields, GC-R1 reminder gaps.
- Phase 12: owner override/delegation model (locked direction); "before DLP" sequencing.
- Phase 13: audit findings, M-0…M-7, transactional/marketing boundary, new unresolved decisions.
- Phase 14: refund → digital access gap confirmed + decision; PAY-WH settlement alignment.
- Phase 15: executes-vs-suggests record, execution-scope expansion, organizer ARIA ownership, ARIA cleanup A–D, LUMI sub-track; decision #8 cross-reference.
- Phase 16: per-source pilot gates.
- Phase 17: 17-I / 17-A split; New Student Intake workflow item.
- Phase 20: existing-app audit facts; 20-R / 20-D split.
- Phase 24: dependency on Phase 12. Phase 25: timing owner-to-set. Phase 26: Gusto Decision 4.
- Open decisions #14–#22. Deferred register: drift additions, test infrastructure, launch-audit forensics, EVENT-CAP-1 overlap check.

**Moved**
- Organizer ARIA page: Phase 10 event side → owned by Phase 15 (Phase 10 dependency).
- Studio-visible SMS registration status: Phase 2 deferred → TW-4 4A.
- Demo-request storage and per-event print attribution: Current State only → consolidated decisions #14/#15.
- Custom roles (Phase 12) and import-source scope (Phase 16): also listed as consolidated decisions #18/#19.
- Current State release histories (Phases 5–7 and earlier) → archived verbatim, marked non-authoritative, in `docs/roadmap/archive/DanceFlow_Current_State_v2.21.md`; Current State is now a short operational snapshot with an explicit authority split (operational facts there; everything else here), so there are no two competing status sections.

**Superseded (kept, marked)**
- Phase 2: TW-1 "Advanced Opt-Out is the compliance authority" (→ D1); "single account, no subaccounts" (→ D2); manual Console provisioning and SID entry (→ TW-4); Mixed-only use case and the "Mixed vs Customer Care" open decision (→ D4); TW-OPS manual track, "no TW-4 is planned" and the v2.21 seven-step remaining list (→ TW-4, 4F); v2.21 status "Final compliance / pilot submission".
- Header / Current State: "next slice 10A", main `67e735ca`, live `dpl_C5TYuEwJ…`, "Launch blockers: None identified" (→ holds table).
- Mobile PaymentSheet (deferred) → re-scoped to Apple/Google Pay and non-event surfaces.
- Phase 26: Gusto listed as an active baseline → dormant.
- Stale text corrected: Phase 3 "BR-4 pending" / "headline not on any page" / "no coming soon text"; Phase 5 notification-rule sentence; a stray `(x) => x` artifact removed.

**Not changed:** the 26-phase numbering and canonical order; Phases 5–9 closed scope; Featured Events and Partner Match modules (except Communities cross-references); public-claim restrictions.

---

## ROADMAP CHANGE LOG

| Date | Version | Change |
|---|---|---|
| 2026-10-13 | v2.23 | **Docs-only addition (no application, Knowledgebase article, SQL, test, configuration, deployment or external-service change).** Owner accepted the KB-1 audit as the preliminary baseline and approved the Knowledgebase modernization direction (2026-10-13); implementation is not authorized. (1) **Phase 17:** new 17-I track "Contextual Help Center & Knowledgebase Modernization" — KB-1 content and feature-parity audit (ACCEPTED as the preliminary baseline); bounded KB-2A correction fast lane (optional, separately authorized); KB-2 content modernization and missing-article coverage (proposed canonical article format); KB-3 persistent Help button and right-side panel with full-content rendering and a tested workflow-state preservation requirement; KB-4 role/plan-aware page mapping and ARIA readiness; KB-5 governance — with the rule that the content audit precedes the Help panel. KB-1 audit document added at `docs/knowledgebase/KB-1_Knowledgebase_Audit_and_Help_Center_Plan.md` (full 79-article inventory and missing-article analysis). (2) ROADMAP MAINTENANCE RULE: Knowledgebase maintenance added to the Definition of Done. (3) Phase 15 dependency: future ARIA KB guidance uses the shared help API (no separate ARIA KB). (4) Phase 2 TW-4 4E: its KB article follows KB-5. (5) Preserved commitments register row added. (6) Open decision #25: KB questions D1–D7, all undecided. (7) Four engineering findings from the audit recorded under preserved follow-ups (section D) as requiring separate validation — not confirmed defects, not authorized work. (8) Current State: stale "Next gate" (PR #217 merge review) refreshed to the current operational state (M-0 PR #218 open, not merged or released; v2.23 PR #219 awaiting owner merge authorization); release state and production deployment unchanged. Near-term priority order unchanged; the track sits inside item 7 and does not displace items 1–6. |
| 2026-10-13 | v2.22 | **Docs-only reconciliation and prioritization for owner review (no application, SQL, test, configuration, deployment or external-service change).** Reconciled against main `24a37a15` (PAY-WH-1B) and live `dpl_5BjsJaSPqn1qA3D4fCDijZbRNqqK`; v2.21 had last been reconciled at `67e735ca` and #212 had edited it without a version entry. (1) **Phase 10:** 10A, 10B, 10C, 10C.1, 10C.2, 10C.4, 10D, 10D.1 and 10C.5 recorded as released with PRs, migrations and deployments; 10C.3 recorded as an audit; the v2.21 foundation-defect list marked addressed by 10A; profile `studio_simple@3`; Multi-Dance setup pull-forward and registration hold recorded; remaining v1 milestones 10E → 10F (10E gated on the owner Schedule & Heats walkthrough); public registration held. (2) **Commerce Integrity lane added:** CI-A, PAY-WH-1/1A, PAY-WH-1B released; CI-B (atomic check-in) and CI-D (ticket-attributed refunds) open as holds on public Competition registration; PAY-WH follow-ups recorded; register item "`payment_provider_events` dedupe not atomic" closed. (3) **Phase 2 Twilio:** TW-4 self-service ISV onboarding recorded as the approved product direction; D1–D7 recorded as established design directions with separate technical verification gates (Twilio Q1–Q5); "no routine founder-operated Console onboarding" and "ConfiDance pilot uses the real automated flow" locked; AOO-authority, single-account, manual-provisioning, Mixed-only and TW-OPS decisions recorded as superseded; TW-4 design document added to the repository. (4) **Near-term priority order — provisionally accepted by the owner** (M-0, CI-B, CI-D, Competition v1, TW-4, Marketing enhancements, then UX/mobile; Communities after) with parallel workstreams, dependencies and release gates, without renumbering phases. (5) **Phase 13** restructured into M-0…M-7 with audit findings (studio drafts not editable; send-time unsubscribe and fail-open suppression gaps; no one-click unsubscribe) and the transactional/marketing boundary recorded as a deliverable. (6) **Apps separated:** Phase 17 split into 17-I (existing web UX fixes) and 17-A (formal pass); Phase 18 clarified as a decision, with no Business app assumed; Phase 19 marked not approved; Phase 20 split into 20-R (readiness and mobile QA of the existing Expo app) and 20-D (redesign and Google Play release); Mobile PaymentSheet re-scoped. (7) **Preserved commitments** captured explicitly (register added). (8) Open product decisions separated from technical verification gates and owner acceptance gates; decisions #14–#22 added. (9) **Owner review corrections (same version, PR #217 revision):** provisional acceptance of the priority order; **Payroll Prep tier recorded as DECIDED: Growth+** (owner-approved 2026-09-15; the owner resolved the conflict with the 2026-10-03 reconciliation in favor of Growth+ on 2026-10-13), distinguished from the still-pending enforcement and billing-key implementation; Gusto pricing undecided; other 2026-09-15 tier statements recorded as evidence only; New Student Intake and Communities approved directions recorded with only genuine remaining decisions; LUMI existing functionality and the approved Performance Intelligence direction separated from new decisions; SOC 2 readiness recorded as ongoing governance with the formal Type II program kept on the roadmap; provenance labels added (owner-approved vs engineering finding vs agent-recorded proposal vs engineering slicing); Current State reduced to a single operational snapshot with the v2.21 text archived. (10) Stale text corrected (header, Current State, Phase 3 BR-4 lines, Phase 5 notification-rule wording, stray artifact, Phase 26 Gusto). See [v2.22 reconciliation ledger](#v222-reconciliation-ledger) for the itemized list. |
| 2026-10-09 | v2.21 | **Docs-only reconciliation (no application, SQL, test, configuration or deployment change).** (1) **Phase 10 — Organizer + Competition OS: Competition OS architecture approved.** Phase 10 is not greenfield: a partial June-2026 foundation exists (about 40 competition tables, heat planner, scheduling, check-in, WSDC profile foundation, flagged public registration builder). Governing principle: simple competitions stay simple; complexity comes from the selected format. Two organizer layers (Simple Mode default; Advanced Mode progressive). Architecture: Competition Core + versioned Rules/Format Profile + versioned Scoring Engine + Organizer UX, initial profile `studio_simple@1`; rules/scoring version and configuration snapshot locked at publish; rules profile and sanction status are separate and no organization authorization is claimed. (2) **Locked:** event-level competitor identity (one human, one competitor per event, many entries; no second person-identity system; guests allowed); scoring heat vs floor heat; authenticated-account web judging with paper-ballot entry and no anonymous judge links in v1; competition roles implemented in Phase 10 and folded into Phase 12 later; integrity rules (immutable ballots, versioned deterministic engines, versioned publication, corrections keep history); studio v1 scoring defaults (`ordinal_majority`, `proficiency_rating`, `callback_tally`; Gold/Silver/Bronze rating bands); payment reuse of the existing event commerce stack. (3) **Slice plan:** 10A Competition Foundation Reconciliation (NEXT), 10B–10G, 10H–10J+; studio v1 = 10A–10F; post-v1 engineering order WSDC, UCWDC, NDCA (dependency order, not market priority). Known foundation defects recorded for 10A (undeclared schedule tables/RPC, public-read RLS defects, non-hardened entry-changes table, unsafe heat override, no tests, no workspace entry). Open decision #11 partly closed; separate judging app stays a Phase 18 question; public Competition OS claim restriction unchanged. (4) **Twilio TW-3 (registration metadata and readiness) RELEASED 2026-10-09:** PR #202 → main `67e735c`; PROD SQL `20261106090000` applied 12:34Z; production deployment `dpl_C5TYuEwJR1S2Pqh6nUpDpvLZS2Zy` live (rollback: app first to `dpl_BTRcPJ3g6fuhpVUvNW3W91jTM3CA`, then the SQL rollback). TW-1/TW-2/TW-3 engineering complete; Phase 2 stays ACTIVE — FINAL COMPLIANCE / PILOT SUBMISSION; next Twilio work is TW-OPS; no TW-4 planned; Twilio remains a separate parallel track. |
| 2026-10-09 | v2.20 | **Docs-only reconciliation (no application, SQL, test, configuration or deployment change).** (1) **Phase 9 — Payroll Prep v1 — COMPLETE / CLOSED / FULLY RELEASED:** 9A integrity (PR #194), 9B immutable evidence (PR #195), 9C compensation history and validation (PR #196), 9D formula-safe CSV (PR #198) and 9E UX/timezone closeout (PR #200) are all released; main `9c3fd5a`, live `dpl_7x4dRs2rctJUw1knjZdmac8Fae6u`; Phase 9 migrations `20261102090000`, `20261103090000` and `20261104090000` applied to PROD. (2) Decision #10 (payroll exported/finalized state) closed: no new status; the shared-CSV-helper register item resolved. (3) **Phase 10 — Organizer + Competition OS is the next primary engineering phase;** numbering and the 26-phase order are unchanged. (4) Twilio Phase 2 remains ACTIVE in parallel: TW-1 released (PR #197); TW-2 implemented / DEV complete / Opus review complete, not merged or released. (5) Carry-forwards recorded without reopening Phase 9: platform-admin payroll items (Phase 12), dormant Gusto timestamp display (later Gusto phase), optional narrow-width visual check. |
| 2026-10-08 | v2.19 | **Docs-only reconciliation (no application, SQL, Twilio-integration or deployment change).** (1) **Phase 2 Twilio A2P status corrected** to ACTIVE — FINAL COMPLIANCE / PILOT SUBMISSION: DanceFlow is the ISV and each studio gets its own studio-specific A2P campaign (ticket #29647095; Twilio guidance 2026-10-06); the shared campaign is unused; ConfiDance is the pilot and its opt-in materials appear aligned; Mixed vs Customer Care not yet selected; no remaining step recorded as done; Twilio proceeds in parallel with Phase 9. (2) **Phase 8 production baseline reconciled after the final 8D release:** main `ab60dba` (PR #192), live `dpl_4JAnpXDXu9idXiVC7Dc3KsjuFtEC`, migration `20261101090000` applied to PROD 2026-10-08; Phase 8 scope unchanged. Phase 9 — Payroll Prep v1 remains next; numbering unchanged. |
| 2026-10-08 | v2.18 | **Phase 8 — Documents Center completion — COMPLETE / CLOSED.** Cleanup before Phase 8: PR #184 (`6588400`, lesson package eligibility + client form rendering), PR #185 (`c5e9553`, past event lifecycle across Discovery and Events), PRs #186–#188 (`291e9a4`, `a3857cb`, `fd925ff`, ARIA reconciliation, current-state and opportunity truthfulness lifecycle), all released. **8A** signing integrity PR #189 (`3cdff68`); PROD migration `20261029090000` applied 2026-10-08 11:35Z after the application release. **8B** lifecycle correctness + gating PR #190 (`2c55cbd`); application `dpl_898GsDy9i8GPFN5mJHXg8swR522p`; PROD verify-only migration `20261030090000` applied 18:12Z (no-op; canonical fingerprint confirmed). **8C** evidence + portal truth PR #191 (`0e8391a`, tree `2f9c73c0`); application `dpl_7sxSQDWYn2bBzmPPhZXMCcA5SDD6` promoted 19:47Z; PROD evidence-read migration `20261031090000` applied 19:49Z. **8D** closeout: fail-safe signing permission (migration `20261101090000`, DEV applied; PROD with its release), staff signing-permission control, guardian / authorized-recipient delivery for clients without email, truthful statuses and actions, searchable assignment picker + Assign document from the client profile, field-layout reuse, decision #9 closed (waivers = Documents template type; signing certificate = Documents evidence receipt). Rollback note: `dpl_898GsDy9…` is not a clean rollback target under the 8C evidence policies. Next phase: Phase 9 — Payroll Prep v1 |
| 2026-10-07 | v2.17 | GC-3.5 canonical closeout (docs only). **Phase 7 — GC-3.5 Direct-payment Group Class enrollment — COMPLETE / CLOSED and released.** GC-3.5-1 (staff direct-payment policy controls) PR #178 `ee3f3930842535b5421a38b3c604eceee20206ee`, no SQL. GC-3.5-2 (acquisition holds / database authority) PR #179 `c12169f87226fe33333e1c668510d467c4485bcc`, migration `20261026090000` live on PROD. REFUND-RECON-1 (canonical refund reconciliation integrity) PR #180 `0e003530b91af40083785f108965a94fad3bbeaf`, migration `20261027090000` live on PROD. REFUND-RECON-2 (refund timestamp / accounting integrity) PR #181 `e7590dfb54eec7d37b0442e7dc391b0cdcc5a057`, migration `20261028090000` live on PROD (refund RPC `6867f57dca8ae457c04cf557c21420e7`). GC-3.5-3 (public paid registration application) PR #182 `1434bb8be4f2d893cc4ce93d1c9e3b09c18a8854` (tree `5b470d4644c761ee7688e24008c775ef12e12209`), production `dpl_CnFtr8gGHahDnj6smNvFtk12Arcw`, promoted 2026-10-07, application rollback `dpl_6cHFofHxhDX7AHuMKqRhz7FUU9Bh`. 4417 / 4417 tests. Public smoke clean; authenticated production smoke omitted under the established policy; class-specific `/register` not exercisable in production (no upcoming public Group Classes; none fabricated). Released: verified, unlinked self-registration and payment for public Group Classes (no email auto-link; linked students stay on the portal/credit path), database seat holds, studio-connected Stripe Checkout, webhook-authoritative settlement creating client + self link + attendee, dancer and studio notifications after settlement, safe conflict refunds, canonical refund reconciliation for every refund path (full, partial and post-attendance handling) and refund timestamp/accounting integrity. Follow-ups tracked in the deferred register: PKG-REFUND-2 `refund.created` timing, raw RPC error text in `payment_provider_events`, non-atomic event dedupe, DEV `accounting_upsert_entry` drift, DEV-only floor-rental index, portal-only/member-only classes, "This and following" direct-payment propagation, seven legacy SQL-suite failures. Decision #10 open. **Next: Phase 8 — Documents Center completion.** Twilio and BR-6 unchanged. |
| 2026-10-07 | v2.16 | GC-3.4 canonical closeout (docs only): GC-3.4C PR #176 squash `e39fa4a694858cba00c39026f4a55e5d00dc5143` (tree `af05f7d8f4aab025b606ab3607b50154f7eb3d58`, identical to the reviewed candidate), qfem `dpl_6cHFofHxhDX7AHuMKqRhz7FUU9Bh`, application rollback `dpl_HssyAtYo8dBm8PjAoFZnAbzJCuo2` (application first, then SQL if needed). Migration `20261025090000_gc34c_self_enroll_started_class_guard.sql` (sha256 `ac5f9aaa0f9c7d252a87467f1d039b9ebc595970fd276ec3ebb8847c16f9afc3`; rollback sha256 `aa16eae26412a4ad33e7ddee52ed80b6ecf2f6b16944caaccb5d16d6d2ea378f`) applied to PROD once after a clean read-only preflight; PROD function fingerprint `c5edafd4915060533faca30a9376e2d2`; no other function changed. 4199 / 4199 tests; GC-3.4C and gc3_3 SQL suites pass on DEV; signed-out production smoke passed; authenticated smoke omitted under the established policy; class-specific smoke not exercisable (0 public Group Classes in production). Authoritative non-payment public Group Class self-enrollment: auth-free class page, `/register` as the identity/enrollment boundary, server-side dancer reauthorization, canonical funding preview with authoritative revalidation, single source auto-selected and explicit choice otherwise, no-funding boundary with no payment, started and non-public classes refused by the database, database-authoritative capacity, idempotent duplicates with already-enrolled as success, post-commit idempotent dancer + studio notifications, no raw database errors. **Phase 6 — GC-3.4 — COMPLETE / CLOSED** (A read-only discovery; B identity and linking; C non-payment enrollment). **GC-3.5 (Phase 7, direct payment) NEXT / NOT STARTED.** Public Discovery notification rule implemented for public Group Class self-enrollment. Decision #10 open; inactive-client follow-up extended to self-enrollment (separate policy decision); legacy SQL test debt (gc1_1, gc1_2, gc1_4a, gc3_1, gc3_2) recorded; New Client `/n` polish item preserved; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-06 | v2.15 | GC-3.4B canonical closeout (docs only): GC-3.4B-1 PR #174 squash `9f74439cc05e6d8b1ee021d495238c6673df8937` (tree `6769eb33852688fd15826649b6db42f1262f05b8`, identical to the reviewed candidate), qfem `dpl_HssyAtYo8dBm8PjAoFZnAbzJCuo2`, rollback `dpl_ELwUfwoxJ8KWNfbJJ5yTkDtoK4mx` (application only), no SQL or migration, 4154 / 4154 tests. Public class identity and linking flow: auth-free public class page with one call-to-action into `/studios/{slug}/classes/{appointmentId}/register`; safe login return via `next`; canonical verified-email proof; staff-issued invitations only (never `clients.email`); one generic no-link / no-booking-authority state; Check again limited to the existing claim; single dancer auto-resolves, scoped chooser otherwise, dancer parameter revalidated server-side; Open Student Portal ready state with the portal authorizing independently; sign-in-again path for stale bound sessions; server-only scoped service-role reads; no enrollment, payment or SQL. Signed-out production smoke passed; authenticated smoke omitted under the established policy; class-specific signed-out smoke not exercisable (production has no public Group Classes). **GC-3.4B COMPLETE / CLOSED** (B-0 and B-1 released; B-0 facts preserved). **GC-3.4C NEXT / NOT STARTED** with the enrollment-write boundary recorded (enrollment mutation, entitlement consumption, capacity/concurrency, idempotency, studio notification, confirmation, security review; non-payment enrollment only). GC-3.5 future; identity deferrals preserved (no longer framed as GC-3.4B-1 blockers; not automatic GC-3.4C blockers); the pre-existing inactive-client portal-access behavior recorded as a separate policy follow-up; Public Discovery notification rule unchanged; decision #10 open; legacy Events active; GC-3.4 PARTIAL / ACTIVE; Twilio and BR-6 unchanged. Engineering hygiene: the New Client page literal `/n` display bug recorded as a bounded UI polish item. |
| 2026-10-06 | v2.14 | GC-3.4B-0 release closeout (docs only): PR #172 squash `4a57883ca023355b2e7d0b7668b3002b0cc00b80` (tree `90dae827185447450c769d4951506cb66b5b6aa2`, identical to the reviewed candidate), qfem `dpl_ELwUfwoxJ8KWNfbJJ5yTkDtoK4mx`, rollback `dpl_89h8nJfgm8GoTEtEKXS8ZeU8dWJF` (application only), no SQL or migration. Identity-linking security prerequisite completed before any public identity flow: verified-email proof required for invitation accept/reject; mismatched or unverified token holders cause no invitation mutation; the historical staff conflict-resolution authorization defect fixed with the staff-issued relationship type preserved; unrelated invitation intents preserved and another mailbox's pending invitation row never reused; invitation-claim failures no longer block sign-in and never synthesize authorization; handled invitation tokens render generically; raw database errors not surfaced; redirect handling corrected. Historical aggregate PROD posture check clean (zero linked non-self relationships, zero apparent mismatches; no remediation). Signed-out production smoke passed; authenticated production smoke omitted under the established policy. GC-3.4B owner decisions recorded (staff-issued invitations only, never `clients.email`; one generic unlinked state; no self-created clients or public guardian relationships; existing studio page for contact; no persisted connection requests) and the approved GC-3.4B-1 direction recorded; bounded identity deferrals recorded (duplicate self-invitation DB treatment, token clearing on login-time claim, stronger rate limiting). GC-3.4 PARTIAL / ACTIVE; GC-3.4A RELEASED / CLOSED; GC-3.4B PARTIAL / ACTIVE (B-0 released, B-1 next); GC-3.4C and GC-3.5 future; Public Discovery notification rule unchanged; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-06 | v2.13 | GC-3.4A release closeout (docs only): PR #170 squash `da25423a6594d78c2438bb15a5437aefff4efd18`, migration `20261024090000_gc34a_public_group_class_read_model.sql` (sha256 `e08ddb42df7130bfafad0e094602a70313738917fc74360ca92a832055997e84`; rollback sha256 `5e00d551ffd1e407a5c024b571fa3b1b2daee390b5756687def4a814b9b0de29`) applied to PROD once and verified before promotion (definitions identical to DEV; no RLS, ACL or data change), qfem `dpl_89h8nJfgm8GoTEtEKXS8ZeU8dWJF`, rollback `dpl_F6NpfGX6o9E7s9Dhisi4WMvKXBod`. First anonymous-safe public read surface for canonical Group Classes: narrow SECURITY DEFINER functions (search_path pg_catalog, public; anon + authenticated + postgres execute only), no table RLS widening; /discover/classes, studio class list, occurrence and series pages; appointment id and series lineage root as stable identity, S1C-5 splits keep every link; DB-derived spots; public location is location_name only (no room-name fallback); instructor name only for active public-profile instructors; no enrollment, linking or payment. Stale Phase 6 notification wording reconciled (the Group Class portal path implements the rule; no other Public Discovery surface does). GC-3.4 PARTIAL / ACTIVE; GC-3.4A RELEASED / CLOSED; GC-3.4B next; GC-3.4C and GC-3.5 future; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-05 | v2.12 | GC-S1F release closeout and Phase 5 closeout (docs only): PR #168 squash `d39bf3f7e9eb18adb898f74d7954fa251c2ffa24`, qfem `dpl_F6NpfGX6o9E7s9Dhisi4WMvKXBod`, rollback `dpl_78dEg8zqXvkWZQ11TEnC1C3bgyr1`, no SQL. GC-S1F RELEASED / CLOSED; Phase 5 — Group Class canonical foundation COMPLETE / CLOSED (S1A–S1F). Portal self-enrollment now sends a dancer confirmation and a studio operational email (active owners, admins and front desk of the enrolling studio; package/membership funding named accurately, no payment claim; email only); attendance eligibility backstop verified, no authorization defect; Group Class UX polish (cancellation scope copy, collapsible chevrons, create/edit success, safe errors, not-found banners). Public Discovery studio-notification rule preserved (recorded; implemented only for Group Class self-enrollment). Carried forward outside the closure: Events retirement, multiple rooms/locations, class revenue reporting, decision #10 (open). GC-3.4 (Phase 6) is next and not started; GC-3.5 (Phase 7) after it; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-05 | v2.11 | GC-S1E release closeout (docs only): GC-S1E COMPLETE / RELEASED. S1E-1 reminder integrity (PR #163, squash `421331ef63e2621593daebe25f1042de646d7bc9`); S1E-2 enrollment/change notifications (PR #164, squash `5ab8bd94bdf879dd6473d7ff2fe45d98930b27db`); S1E-3 DB-authoritative conflict enforcement, race-free among participating canonical writers and not globally conflict-proof (PR #165, squash `0c7985e15f2a9979b607a2023d3768d65bf60450`, two migrations live in PROD); S1E-4 calendar verification and hardening (PR #166, squash `a8ea91d73174f81251ceaa05571f57ece7f3c8aa`, qfem `dpl_78dEg8zqXvkWZQ11TEnC1C3bgyr1`, rollback `dpl_HNPqJwAyeWXixRMqKZiRWy5vcqKR`, no SQL): appointment-id Google identity, S1C-5 split identity preserved, mapped events no longer deleted for leaving the fetch window, ICS UTC instants and location_name fallback. Platform Public Discovery studio-notification rule recorded (Phase 6) and a GC-S1F studio-side external-enrollment notification item recorded (not implemented). Bounded S1E-4 follow-ups preserved. GC-S1F next and not started; Phase 5 PARTIAL; Phase 6/7 ordering unchanged; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-05 | v2.10 | GC-S1D-3 release closeout (docs only): PR #161 squash `90afc405b2e01423d17d1238f074e85d26cbf6b0` (reviewed candidate `7949ba7e53c189418e2c79709d299f0e7c91e71c`, merged tree `9bdacf6627bc8673fb131e0374408b761cbbf9e5` identical); function-only migration `20261022090000_gcsd3_series_enrollment_settings.sql` (sha256 `5fe70a0639bcf96dba74811369299d49acfc0d1d5e0d1c3f86e30ddf67615fbe`) applied to PROD 2026-10-05 00:43:41–00:43:42Z and verified before app promotion (five functions, no data change); qfem `dpl_8viZUFNKqBWmiCmKgn3hpbujtt7P` promoted 00:55:48–00:55:56 UTC, rollback target `dpl_BsKFEAgtDNVqRJq8NUJ6dQiqhuat`; signed-out smoke passed, authenticated production smoke omitted, post-release DB check clean; DEV validation 62/62 SQL and 20/20 concurrency, 3,829 application tests. "This and following classes" enrollment settings (discoverable, self-enrollment, package and membership funding accepted) from the selected occurrence across the successor lineage: compact preview (differing / matching / skipped / blocked), intentional overwrite of differing later classes (no preserve-customization model, no override tracking), direct_payment / manual_other and the dormant amount preserved per class, missing rows created, atomic apply with stale-count refusal, skipped anchor stays the cutoff and later classes still update, broad-staff series authority in the database with platform admin as existing authority and instructors gaining none. D4 released (D1 and D2 released by S1D-2; D3 remains the boundary). GC-S1D COMPLETE / CLOSED; GC-S1E next, GC-S1F future; Phase 5 PARTIAL; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-04 | v2.9 | GC-S1D-2 release closeout (docs only): PR #159 squash `af48e2e2d83652c1f3677a4f945ea648b4f787c6` (reviewed candidate `90002e012ee4c568f8e2a6c6df8f23236bd3d25a`, merged tree identical); function-only migration `20261021090000_gcsd2_series_enroll_remove.sql` (sha256 `806bce1bc5b251438f0e7df668fbbec147c559ce80ef7c83d24a745cdc287725`) applied to PROD 23:13:01–23:13:03Z and verified before app promotion (nine functions, no data change); qfem `dpl_BsKFEAgtDNVqRJq8NUJ6dQiqhuat` promoted 2026-10-04 23:24:41–23:24:48 UTC, rollback target `dpl_DfZdFAU8eTY6QkwGKijhR383EYZy`; signed-out smoke passed, authenticated production smoke omitted, post-release DB check clean; DEV validation 80/80 SQL and 28/28 concurrency, 3,804 application tests. "This and following classes" series enroll / remove for one dancer from a canonical occurrence: lineage-aware traversal, atomic enrollment (D1) with skipped-versus-blocked reporting and idempotent already-enrolled handling, broad-staff-only series authority in the database (D2), removal preserving attended / no_show and attendance, compact preview then apply with stale-count refusal, full selected class stays reachable as a capacity blocker. D1 and D2 released; D3 and D4 unchanged. GC-S1D IN PROGRESS / PARTIAL (S1D-1 and S1D-2 closed, S1D-3 next); S1E/S1F future; Phase 5 PARTIAL; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-04 | v2.8 | GC-S1D-1 release closeout (docs only): PR #157 squash `b8e8397fc1f5a6facdb81c9f2c10115c50911e37`; migration `20261020090000_gcsd1_attendee_removal_terminal_attendance_guard.sql` (sha256 `be2ffc30741beca158b137fe3e4fada1b4cfecd9e218ebed686f50bd908bcddf`) applied to PROD 21:56:03–21:56:04Z and verified before app promotion (no application-data change); qfem `dpl_DfZdFAU8eTY6QkwGKijhR383EYZy` promoted 2026-10-04 22:06:44 UTC, rollback target `dpl_DjRfdxBUZFUt4kXVaGqBrBy6hfe3`; signed-out smoke passed, authenticated production smoke omitted; DEV validation 31/31 SQL and 7/7 concurrency. Roster management on group-class detail (capacity context, in-context Add dancer and Remove, broad-staff funding visibility, attendance context, Enroll Student class preselection; occurrence scope only). Database-authoritative rule: an attendee with terminal attendance (attended, no_show) for that class cannot be removed; removal serializes with attendance via the class-row lock. Owner decisions D1–D4 for series enrollment locked. GC-S1D IN PROGRESS / PARTIAL (S1D-1 closed, S1D-2 next, S1D-3 future); S1E/S1F future; Phase 5 PARTIAL; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-04 | v2.7 | GC-S1C-5 release closeout (docs only): PR #155 squash `a14596356467157570276d74be944e1b4a2df46c`; migration `20261019090000_gcsc5_series_following_edit.sql` (sha256 `1d3f7663c427fcbc9884121be9a393bbf1a05ef88e49037cf7078850e004531c`) applied to PROD 19:45:55–19:45:57Z and verified before app promotion (no application-data change); qfem `dpl_DjRfdxBUZFUt4kXVaGqBrBy6hfe3` promoted 2026-10-04 20:05:31 UTC, rollback target `dpl_4iT62F5DSysrJdPpgfotp8br3YVn`; signed-out smoke passed, authenticated production smoke omitted; DEV validation 149/149 SQL and 30/30 concurrency. "This and following classes" series editing with successor-series segmentation (existing rows re-pointed, identities and history preserved), Preserve/Overwrite of customized occurrences, customized-anchor propagation, truthful override reconciliation, reset customizations to series values (forces request-level Overwrite), Review/Apply stale protection, transactional conflict/capacity revalidation, idempotency ledger, lineage-aware S1C-4 cancellation. GC-S1C COMPLETE / RELEASED (final planned slice); Phase 5 PARTIAL; S1D next, S1E/S1F future; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. Governing principle added: UX quality is part of feature completion. |
| 2026-10-04 | v2.6 | GC-S1C-4 release closeout (docs only): PR #153 squash `59562207c574baa566ac23adbb2d0ca7540be8d9`; migration `20261018090000_gcsc4_series_cancellation_lifecycle.sql` applied to PROD 17:47:07–17:47:09Z and verified before app promotion (no application-data change); qfem `dpl_4iT62F5DSysrJdPpgfotp8br3YVn` promoted 2026-10-04 18:00:42 UTC, rollback target `dpl_4DDsS9z4VcZd22oU8SXNLZ2MhFnT`; authenticated production smoke omitted, DEV validation 56/56 SQL and 18/18 concurrency. "This and following classes" series cancellation (broad staff only; historical, terminal-attendance and cancelled occurrences preserved; no credit/usage/attendance rewrite), direct cancelled-to-scheduled group-class reactivation refused, consolidated email/push after commit (best-effort, no SMS). Canonical series lifecycle rule recorded: stored status alone is insufficient; readers must derive lifecycle from occurrences. S1C overall incomplete (GC-S1C-5 remains); Phase 5 PARTIAL; S1D-S1F future; decision #10 open; legacy Events active; Twilio and BR-6 unchanged. |
| 2026-10-04 | v2.5 | GC-S1C-3 release closeout (docs only): PR #151 squash `5c87775ddb7d750e95f4bf5f70d6cbc2e755d1ea`; migration `20261017090000_gcsc3_group_class_db_authority.sql` applied to PROD and verified before app promotion (PROD data unchanged); qfem `dpl_4DDsS9z4VcZd22oU8SXNLZ2MhFnT` promoted 2026-10-04 16:16:52 UTC, rollback target `dpl_9M8Gn9p9YELRrKr53gFs9Q4q7CoS`; authenticated production smoke omitted, DEV validation 57/57 SQL and 13/13 concurrency. Group-class cancellation is RPC-only for tenant roles; cancelled classes reject booked enrollment; capacity floor and series-occurrence delete are database-authoritative; queued group-class reminders are cancelled and revalidated at send time. S1C overall incomplete (GC-S1C-4 and GC-S1C-5 remain, including the direct `cancelled -> scheduled` reactivation authority carried to GC-S1C-4); Phase 5 PARTIAL; S1D-S1F future; decision #10 open; legacy Events active. |
| 2026-10-04 | v2.4 | GC-S1C-2 release closeout (docs only): PR #149 squash `e0f8b7b4b05e70b2df7e41d542025151548453fd`; migration `20261016090000_gcsc2_group_class_cancel_safety.sql` (hardened cancellation RPC, attendance-side guard, appointment-side guard) applied to PROD and verified before app promotion; qfem `dpl_9M8Gn9p9YELRrKr53gFs9Q4q7CoS` promoted, rollback target `dpl_826bbGgRmgu6WzPwcQuGkeJdb3XN`; authenticated production smoke omitted, DEV validation 67/67 SQL and 25/25 concurrency. Invariant enforced for the PostgREST/RPC READ COMMITTED model (no REPEATABLE READ claim). S1C overall incomplete (this-and-future, whole-series editing, series status behavior remain); DB capacity-floor and series-delete backstops remain future; Phase 5 PARTIAL; S1D-S1F future; decision #10 open; legacy Events active. |
| 2026-10-04 | v2.3 | GC-S1C-2 implementation-candidate state recorded (feature branch; docs only here): authoritative group-class cancellation RPC hardening (already-cancelled no-op, recorded-attendance refusal) with a small migration (DEV only, NOT applied to PROD), canonical classes routed away from the generic membership-usage-clearing cancel path, broad-staff-only cancellation, class-specific cancel UI, Delete hidden for series occurrences. (Superseded by v2.4: released.) S1C incomplete; Phase 5 PARTIAL; S1D-S1F future; decision #10 open. |
| 2026-10-04 | v2.2 | GC-S1C-1 release closeout (docs only): PR #147 squash `3f31cb24e2bfd6d5651fd299d73783fb863fe752`; qfem `dpl_826bbGgRmgu6WzPwcQuGkeJdb3XN` promoted; no migration; authenticated production smoke omitted. Occurrence-only edit, conflict recheck, app-level capacity floor and app-level series-occurrence delete block released. DB capacity-floor and series-delete guards recorded as future backstops (not live). S1C overall incomplete; Phase 5 PARTIAL; S1D-S1F future; decision #10 open. |
| 2026-10-04 | v2.1 | GC-S1C-1 implementation-candidate state recorded (feature branch; docs only here): occurrence-only edit safety (server conflict recheck, capacity floor, series-occurrence delete refusal, series context UI). NOT released; no migration. DB capacity-floor backstop recorded as a follow-up. GC-S1C not complete; GC-S1B closed state unchanged; Phase 5 PARTIAL; S1D-S1F future; decision #10 open. |
| 2026-10-04 | v2.0 | GC-S1B release closeout (docs only): PR #145 squash `13873744d9df3d36d09c671f81ead132f2b64b4f`; migration `20261015090000_gcsb1_group_class_series_materialization.sql` applied to PROD and verified before app deploy; qfem `dpl_5Q8VbkRyyZ2QuENzeZAGM7CBLF9j` promoted; authenticated production smoke omitted, DEV acceptance complete; standalone group classes unchanged; legacy Events creation active; Phase 5 PARTIAL; S1C-S1F future; decision #10 open. |
| 2026-10-03 | v1.9 | GC-S1B implementation-candidate state recorded (feature branch; docs only here): B1 SQL (DEV only, not applied to PROD), B2 server actions and conflict enforcement, B3 creation UI, B4 closeout are implemented and reviewed. NOT released; coordinated PROD migration and app release pending. GC-S1A closed state unchanged. Legacy Events creation remains active; S1C-S1F remain future work; Phase 5 stays PARTIAL; depleted-credit decision #10 unresolved. |
| 2026-10-03 | v1.8 | GC-S1A release closeout (docs only): PR #143 squash `8bb14afd8f1e6f4dca2e880ad99708d0679aa5e3`; migration `20261014090000_gcs1a_group_class_series_foundation.sql` applied and verified in DEV, applied once manually in the PROD SQL Editor and verified read-only (DEV/PROD match after carriage-return normalization); 203 PROD appointments unchanged, zero series rows and attachments; legacy Events unchanged; no app deployment; authenticated PROD smoke omitted under the permanent rule. GC-S1 architecture approved (decisions A: finite-only, B: series enrollment first-class). GC-S1B not started; Phase 5 stays PARTIAL; conflict-detection gap and 12-session date-pattern analysis recorded as follow-ups. |
| 2026-10-03 | v1.7 | GC-R1 release closeout (docs only): PR #141 squash `087c2c7a7a3d832fa9699682c926eff290151ff8`, PROD `dpl_HcdC6KRD9ZRWFN4FtyvEGbpsNVcE` (rollback `dpl_HcYmcSqF4hLApbwASov1xacA4mbu`), no migration, PROD dedupe_key index verified before and after, authenticated PROD smoke omitted under the permanent release rule. Only GC-R1 is complete; Phase 5 stays PARTIAL (Events retirement needs a production-data inventory first, series/occurrence, multiple rooms, class revenue reporting, depleted-credit decision #10; public class discovery stays Phase 6). Phase 4 stays PARTIAL on decision #8; BR-6 parked; Twilio/Sachin external wait unchanged. |
| 2026-10-03 | v1.6 | GC-R1 implemented (feature branch, local commit; not merged or released): canonical group-class attendee reminders (24h/2h, email only, existing generator and branded HTML, `dedupe_key` idempotency, no migration, no ENT-1 allowance, no SMS, Events path untouched). Only GC-R1 is marked complete; Phase 5 stays PARTIAL. Legacy Events group-class retirement still open and needs a production-data inventory; depleted-credit decision (#10) unresolved. |
| 2026-10-03 | v1.5 | Phase 4 reconciliation and explicit Phase 5 handoff (docs only). Phase 4 stays PARTIAL; ENT-1 stays RELEASED/CLOSED. Remaining Phase 4 implementation is blocked on open decision #8 (SMS, payroll, marketplace, ARIA plan placement); no speculative billing keys; SMS blocked on plan placement independently of the Twilio/Sachin dependency. Shared upgrade-prompt / usage-display UX reassigned to Phase 17 (existing entitlement-denial behavior sufficient meanwhile). Campaign-recipient allowance clarified as applying to user-created marketing campaigns only; operational/transactional email and current ARIA operational outreach are not campaign-metered; ARIA has no marketing send path that bypasses ENT-1; no email add-on is approved or required; the dead duplicate campaign action stays with the Phase 13 dedupe. Phase 22 stays the pricing cutover. Execution may proceed to Phase 5 under the recorded dependency-safe handoff. |
| 2026-10-03 | v1.4 | ENT-1 RELEASED and closed: PR #138 squash merged to main `782fd680fdb0ab8928faccb4ac859bbe4e6109f6`; PROD migration `20261013090000_ent1_usage_allowance_reservations.sql` applied and verified; deployment `dpl_HcYmcSqF4hLApbwASov1xacA4mbu` promoted to production; authenticated PROD smoke intentionally omitted under the permanent release rule. Phase 4 stays PARTIAL (SMS gating, payroll/marketplace/ARIA billing keys, upgrade-prompt component, any email add-on product and other email paths such as ARIA-originated sends remain). BR-5 stays merged (#137); BR-6 stays active/parked awaiting the professional ARIA voice recording; Twilio stays an external wait. Docs only. |
| 2026-10-03 | v1.3 | Corrected the stale BR-5 state: BR-5 is MERGED (PR #137, main `1310e3a`). BR-6 recorded as active but parked (first-person ARIA master locked; waiting for the professional ARIA recording; branch `br-6-promotional-media` head `1f19305`, not merged). ENT-1 (monthly email-campaign recipient allowance, studio and organizer, atomic reserve/finalize/release) marked COMPLETE on its candidate branch `ent-1-email-campaign-allowance`: DEV migration `20261013090000` applied and verified, PROD migration required. Phase 4 stays PARTIAL (SMS gating, payroll/marketplace/ARIA keys and the upgrade-prompt component remain). |
| 2026-10-03 | v1.2 | BR-4 recorded as merged (PR #136, main `f189d15`) and LIVE (`dpl_HnWJ1Qn2g3onGb9wEWULyKZkfd5K`). BR-5 Event / Print Collateral marked COMPLETE on its candidate branch (awaiting merge): banner master (vendor fit pending), three business sheets, dancer card, social templates, QR/attribution convention, collateral guide, builder and focused test. Phase 3 stays PARTIAL: BR-6 and BR-7 remain; next slice after the BR-5 merge is BR-6. No migration or runtime change. |
| 2026-10-03 | v1.1 | BR-4 Public Website & Launch Messaging marked COMPLETE on its candidate branch (awaiting merge): messaging architecture and homepage, audience pages and public navigation, first-touch campaign attribution, vocabulary convergence, claims guard and final public-site QA. Phase 3 stays PARTIAL: BR-5, BR-6 and BR-7 remain; next slice after merge is BR-5. No migration. |
| 2026-10-02 | v1.0 | Materialized the canonical 26-phase roadmap into version control. Reconciled against main `2266f5f`. Added full Branding / Public Launch Readiness scope. Added Featured Events strategic module. Added Partner Match strategic module and public-acquisition intent. Preserved the deferred/post-launch register. Established Phase 3 / BR-4 as next active roadmap work. Twilio remains a parallel external dependency. |
