# DanceFlow Master Roadmap

| | |
|---|---|
| **Roadmap version** | v1.0 |
| **Last reconciled against main** | `2266f5fdd0ac51394a4b5915c2408a08f4532cce` |
| **Current non-Twilio launch state** | NON-TWILIO ENGINEERING READY |
| **Current external dependency** | Twilio / per-studio A2P campaign review and ConfiDance setup |
| **Current recommended next roadmap phase** | Phase 3 — Branding Relaunch / BR-4 Public Website & Launch Messaging |

> **Explicit note:** BR-4 scope is modified by Featured Events and Partner Match maturity, but it is **not blocked** by either. See [Featured Events](#strategic-module-featured-events), [Partner Match](#strategic-module-partner-match) and Phase 3 §BR-4 restrictions.

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


### Evidence confidence

Statuses below come from a read-only reconciliation of main `2266f5f` (source, migrations, tests, release history). Evidence is largely "the routes, tables, migrations and tests exist"; it does not prove each feature behaves correctly end to end. Items marked **(unverified)** were not confirmed beyond existence or a grep. Do not read "implemented" as "QA'd" unless the item says so.

---

## Status vocabulary

| Status | Meaning |
|---|---|
| **COMPLETE** | Canonical objective met; nothing required remains. |
| **SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS** | Core delivered; a bounded closeout list remains. |
| **PARTIAL — MATERIAL WORK REMAINS** | Meaningful capability exists, but material canonical deliverables are missing. |
| **NOT STARTED** | No meaningful implementation of the canonical objective (a baseline elsewhere may exist; it is noted). |
| **EXTERNAL DEPENDENCY** | Engineering is complete or independent; completion waits on an outside party or real-world activity. |
| **SUPERSEDED / REPLACED** | Replaced by later architecture or decisions; the replacement is named. |

---

## Governing principles

- Build capability → establish security and permissions → stabilize web workflow → design mobile around the stabilized workflow.
- Twilio/A2P is an **external-dependency lane** that proceeds in parallel; it is not a global roadmap blocker.
- The Branding relaunch precedes later public launch materials, mobile store materials and broad public promotion.
- Do not redesign Business or Student mobile apps around workflows that are still structurally changing.
- The Mobile App Architecture & Boundary Audit must occur before locking final app count, app names, navigation ownership or store strategy.
- Team & Permissions must become sufficiently data-driven before DanceFlow Business navigation is finalized.
- Final web workflows are the canonical UX model for mobile.
- Every major feature area eventually closes with **Security Review** and **Branding / Polish**.
- Prefer: simple flow; fewer cards; one obvious next action; progressive disclosure; right-side contextual detail panels where appropriate; obvious expandable affordances; responsive behavior; consistent empty/error/loading states.

---

## Canonical phase order (do not silently reorder)

| # | Phase | Status |
|---|---|---|
| 1 | Landmark 1A | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 2 | Twilio A2P / SMS | EXTERNAL DEPENDENCY |
| 3 | Branding Relaunch / Public Branding & Launch Readiness | PARTIAL — MATERIAL WORK REMAINS |
| 4 | Remaining entitlement foundation | PARTIAL — MATERIAL WORK REMAINS |
| 5 | Group Class canonical foundation | PARTIAL — MATERIAL WORK REMAINS |
| 6 | GC-3.4 — Public discovery and account linking | PARTIAL — MATERIAL WORK REMAINS |
| 7 | GC-3.5 — Direct-payment Group Class enrollment | NOT STARTED |
| 8 | Documents Center completion | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 9 | Payroll Prep v1 | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 10 | Organizer + Competition OS | PARTIAL — MATERIAL WORK REMAINS |
| 11 | Messaging / Notification platform completion | PARTIAL — MATERIAL WORK REMAINS |
| 12 | Team & Permissions expansion | PARTIAL — MATERIAL WORK REMAINS |
| 13 | Marketing / Campaigns completion | PARTIAL — MATERIAL WORK REMAINS |
| 14 | Marketplace + digital products + Mux | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 15 | ARIA Operations completion | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 16 | Migration / Onboarding completion | SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS |
| 17 | Web application design-gap completion | NOT STARTED |
| 18 | Mobile App Architecture & Boundary Audit | NOT STARTED |
| 19 | DanceFlow Business app | NOT STARTED |
| 20 | Student App redesign + Google Play readiness | NOT STARTED |
| 21 | Public website / discovery expansion | NOT STARTED |
| 22 | Regular v1 pricing cutover | NOT STARTED |
| 23 | Platform Admin / DanceFlow HQ expansion | PARTIAL — MATERIAL WORK REMAINS |
| 24 | Data Loss Prevention | NOT STARTED |
| 25 | SOC 2 Type II | NOT STARTED |
| 26 | Later integrations / enterprise features | NOT STARTED |

**Strategic modules that span phases** (see dedicated sections): [Featured Events](#strategic-module-featured-events) (Phases 10, 13, 19, 20, 21, 22, 23 + analytics foundation) and [Partner Match](#strategic-module-partner-match) (Phases 17, 18, 20, 21, 23 + analytics foundation).

**Work completed outside the numbered sequence** (inserted ahead of it, all released): the launch-security and payment-integrity tracks. See [Completed launch work register](#completed-launch-work-register).

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

**STATUS:** EXTERNAL DEPENDENCY (engineering complete)

**OBJECTIVE:** Compliant SMS under Twilio's ISV model: GenX TotalTech LLC / DanceFlow is the ISV; each studio is its own campaign and message sender.

**PRODUCT INTENT:** Studios send service SMS to opted-in clients through DanceFlow, with per-studio identity, consent, registration and routing.

**COMPLETED CAPABILITIES** (all released to PROD)
- SMS-A2P-1 (#131): `studio_sms_registrations` (one row per studio; separate `messaging_service_sid`, `campaign_sid`, `sender_e164`; constrained status `not_registered | in_review | approved | rejected | suspended`; `approved` requires all three identifiers; platform-admin-only RLS; no delete policy), platform admin management form on `/platform/sms`, corrected `/sms-consent`.
- SMS-A2P-2 (#132): studio sends only through its own approved registration's Messaging Service; no global fallback; global status is only a master kill switch; inbound STOP/START/HELP and inbound logs scoped to the studio resolved from `MessagingServiceSid` and/or `To`; status callbacks scoped to the owning studio; studio footer always appended; HELP/STOP/START replies name the studio.
- SMS-A2P-3B (#133) and 3C (#134): public samples equal real dispatcher output (pinned by test); `#lead` deep link opens the Contact/opt-in form.
- ConfiDance Studio public opt-in proof verified live: `https://www.idanceflow.com/studios/confidance-studio#lead` (slug `confidance-studio`).

**REMAINING DELIVERABLES** (operational, outside engineering)
- Sachin/Twilio review of the ConfiDance package; resubmission as instructed by Twilio.
- Twilio Console work for ConfiDance: customer brand registration under the GenX ISV profile; A2P campaign; dedicated Messaging Service; sending number; inbound webhook `POST https://www.idanceflow.com/api/sms/twilio/inbound`. (Status callbacks need no Console setting; the app attaches the callback per message.)
- Console checks: brand legal name / EIN / address / website; whether any ConfiDance resource already exists; that the Console campaign SID matches the `QE…` format the database requires; that the resources are in the same Twilio account as the app's credentials (no subaccount support); Advanced Opt-Out interaction with the app's own STOP reply.
- Record the ConfiDance row in `/platform/sms` (`in_review` once submitted; `approved` only after campaign approval, number attached, webhook set).
- Flip the global SMS status to approved (PROD environment change; needs a redeploy; affects all studios, which stay fail-closed without their own approved registration).
- ConfiDance clients must hold an opted-in consent row for texts to send.

**LOCKED DECISIONS**
- Per-studio registration under the DanceFlow/GenX ISV relationship; not one global campaign.
- Registered/supported scope: automated appointment/lesson confirmation, reschedule, cancellation; one-to-one staff messages to opted-in clients; STOP/START/HELP.
- Event SMS stays blocked; no marketing or promotional SMS; no bulk or mass campaigns.
- STOP/START/HELP are scoped per studio (no cross-studio opt-out).
- Strict status-callback matching: for a registered studio the callback `MessagingServiceSid` must match; a missing or old SID fails closed. No historical-SID support.
- Consent evidence: `consent_source`, `consent_at`, and `consent_note` carrying `disclosure=a2p1b-v1;form=…`. No IP or user-agent is stored (do not claim it).

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Campaign use-case type to register (to be chosen with Twilio).

**DEPENDENCIES:** Twilio review (external). Phase 4 (plan gating of SMS is not yet implemented).

**WEB IMPLICATIONS:** Platform SMS admin page (`/platform/sms`) exists. Studio-facing registration status UX is not built.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Closed. Webhook signature verification and the callback secret are unchanged.

**BRANDING / POLISH CONSIDERATIONS:** `/sms-consent` is the public program explainer and is not itself the opt-in form.

**DEFERRED / POST-LAUNCH ITEMS:** Historical-SID support for callbacks after a future registration SID change; studio-visible registration status.

**EVIDENCE / RELEASE REFERENCES:** PRs #131–#134; final PROD deployment for this lane `dpl_G8vf1vywXJ8K9nNK4AbTuHdruR21`.

---

## Phase 3 — Branding Relaunch / Public Branding & Launch Readiness

**STATUS:** PARTIAL — MATERIAL WORK REMAINS. **Recommended next active roadmap work: BR-4.**

**OBJECTIVE:** A full relaunch of DanceFlow's identity, public presence and launch materials — not merely a logo swap.

**PRODUCT INTENT:** One coherent DanceFlow identity across public site, product, email, social, collateral, promotional media and (later) app stores, with launch messaging that speaks to dancers, studio owners, independent instructors and organizers.

**COMPLETED CAPABILITIES**
- **BR-1:** canonical artwork and logo family (Candidate A); vector masters under `docs/brand/masters/` (SHA256SUMS pinned): primary gradient/white, symbol gradient/white, app icon 1024, social avatar 1080. Runtime PNG family under `public/brand/{logo,icons}`.
- **BR-2A–2D:** public metadata/assets, public shell, authenticated shell branding, shell accessibility/responsive QA (released c808724, 2026-09-21).
- **Email/document branding:** shared email shell and branded document/campaign emails with tests (`emailShell.br3a`, `…br3b2`); studio-named sender identity (PAY-DC-3). BR-3 therefore appears complete — **confirm and record formally**.
- Public SMS/ConfiDance proof pages aligned (SMS-A2P-3B/3C).

**REMAINING DELIVERABLES**
- **BR-4** Public Website & Launch Messaging (next).
- **BR-5** Facebook / social launch content and collateral.
- **BR-6** Promotional media / video.
- **BR-7** Final brand QA.
- Vocabulary sweep: legacy "Studio Portal", "Organizer Workspace", "DanceFlow Discovery" strings remain in about 29 source files (counts were 6 / 14 / 9 files incl. tests at last count; the guide's earlier baseline was 13 / 15 / 11). "DanceFlow Workspace" is retired; organizer descriptors should converge in BR-4.
- Documentation cleanup: stale statements in `docs/brand/DANCEFLOW_BRAND_GUIDE.md` (§11 "vector master deferred", §12 legacy icon note, §7 "wordmark is artwork (script)", BR-2 status). Not a blocking phase.
- Mobile student app still ships the retired couple/script logo and DF monogram icon (see Phase 20; do not pull mobile redesign ahead of Phase 18).

**LOCKED DECISIONS**
- Approved Candidate A logo artwork is canonical.
- The package palette was not adopted as UI tokens; the current application palette (`#5b145e`, `#fff9f3`) stays authoritative.
- Sora/Inter were not adopted as the application font system.
- The compact horizontal lockup and the descriptor lockup ("Studio Operating System") were **not adopted**; the symbol is the compact mark. Any future adoption needs separate owner approval.
- Do not create a palette/font decision slice before further branding work.
- Messaging direction: **"Software that helps do the work—not just track it."**

**PROPOSED BUT NOT APPROVED:** Print/media asset list (see D and E); the final set is not locked.

**UNRESOLVED PRODUCT DECISIONS:** Final collateral asset count; video cut list; QR destination strategy; whether any public pricing page precedes Phase 22.

**DEPENDENCIES:** None blocking BR-4. Store/app-specific assets wait on Phase 18. See [Featured Events](#strategic-module-featured-events) and [Partner Match](#strategic-module-partner-match) restrictions below.

**WEB IMPLICATIONS:** BR-4 touches the public home, get-started flows, discovery entry points, pricing presentation and audience pages.

**MOBILE IMPLICATIONS:** App-store identity, screenshots, store listing and the student-app logo replacement wait on Phase 18 (see I below).

**SECURITY / PERMISSIONS CONSIDERATIONS:** Public claims must match shipped behavior (see restrictions).

**BRANDING / POLISH CONSIDERATIONS:** This phase is the branding work; carry forward deferred polish: NotificationMenu default focus ring, pre-existing nested `<main>` pages, `platform/webhooks` missing a page-owned `<h1>`, Portal invalid-logo fallback, PORTAL-UX-1/2 design-gap backlog.

**DEFERRED / POST-LAUNCH ITEMS:** The polish backlog above if not absorbed by BR-7.

**EVIDENCE / RELEASE REFERENCES:** Released c808724 / `dpl_BEu8q5cjsxJaJUi4pjYvmYDwn1QZ` (BR-1, BR-2C, BR-2D); `docs/brand/`.

### A. Brand identity foundation
Logo system (primary horizontal mark, symbol-only use, favicon/app icon, social avatar) exists. Compact horizontal and descriptor lockups are not adopted (locked). Typography/color/gradient rules follow the current application palette and fonts (locked). Product-facing identity: DanceFlow, with "Studio Portal" and similar legacy descriptors being removed.

### B. Product/public identity rollout
- **Public site:** metadata/shell done; BR-4 pending.
- **Authenticated product:** shell done (BR-2C/2D); vocabulary sweep pending.
- **Email:** done (BR-3 evidence, PAY-DC-3); confirm.
- **Social/avatar:** avatar asset exists; `FACEBOOK_RELAUNCH_FOUNDATION.md` is a requirements document only (page URL, handle, cover, bio are "owner to supply"; bio line 2 and pinned post are unwritten).
- **Favicon/app icon:** web done.
- **Organizer and competition surfaces:** branding sweep unverified and partial.
- **App-store-facing identity:** not started; waits on Phase 18.

### C. Launch messaging architecture
- Master story: "Software that helps do the work—not just track it."
- Audience-specific architecture for dancers, studio owners, independent instructors and organizers, each with: value proposition, headline hierarchy, proof points, CTA system, booth/demo talking points.
- Current state: the headline is not on any public page; there are no audience pages for instructors or dancers; there is no standalone pricing route (pricing is embedded in the home and signup pages).
- **Do not make claims about unreleased automation.**

### D. Event / print collateral (asset count NOT locked)
Considered: 33" × 81" vertical banner(s) (dancer/public; and studios / independent instructors / organizers business audience); tri-fold brochure(s) (studio, independent instructor, organizer audiences); dancer flyer/postcard; QR strategy; landing-page destination strategy; print-production specifications; reusable templates. **The final phase should choose the smallest strong collateral system rather than creating every historically proposed asset.** None exists in the repo today.

### E. Promotional media
Considered: 60-second master launch video; 30-second social/ad cut; 15-second short-form cut; event booth/display loop; studio / independent-instructor version; organizer version; dancer/public-discovery version; later app-store/Google Play version; real product footage; branded motion graphics; professional voiceover; CTA/QR destination; export specifications. None exists in the repo today.

### F. Event conversion infrastructure
Considered: audience landing pages; trackable QR codes; UTM/campaign tracking; event lead capture; studio demo request; independent-instructor interest; organizer interest; dancer signup/download; follow-up sequences; attribution. Present today: generic lead form, get-started flows, in-app lead management. Not found: QR/UTM campaign tracking, a demo-request flow, marketing follow-up sequences.

### G. Final launch maturity QA
Dead links; placeholder content; unfinished screens; empty states; CTA clarity; responsive behavior; QR/deep links; trust/credibility presentation; brand consistency. (No placeholder or "coming soon" text was found in a grep; dead-link and CTA checks are unverified.)

### H. Branding work that can proceed now
Messaging architecture and audience value propositions; BR-4 public website with audience landing pages; vocabulary sweep; print collateral and event-conversion infrastructure pointing at web destinations; promo video using web product footage; social launch content; brand QA.

### I. Branding work that must wait for Phase 18 (mobile decisions)
App-store / Google Play video variants, store listing, screenshots and icon packaging; student-app logo/icon replacement; dancer signup/download flow and app deep-link/QR behavior; anything naming DanceFlow Business or judge/competition apps.

### BR-4 restrictions (Featured Events / Partner Match)
- No meaningful Featured Events promotion claim; avoid "Featured" language beyond implemented behavior.
- Partner Match may be described only as the existing dance-partner directory.
- No claims of algorithmic matching, compatibility scoring, guaranteed or fast connections, an already-complete acquisition funnel, or "free forever".
- No Partner Match landing push, sitemap entry or SEO campaign until moderation and a working web request path exist.

---

## Phase 4 — Remaining entitlement foundation

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** Every gated feature and usage allowance is enforced centrally and consistently by plan.

**PRODUCT INTENT:** Plans (starter / growth / pro; organizer) and add-ons control access and usage predictably, with clear upgrade paths.

**COMPLETED CAPABILITIES**
- 22-key `BillingFeature` union; `PLAN_FEATURES` and `ORGANIZER_PLAN_FEATURES`; `studioHasFeature`, `requireStudioFeature` (redirects to billing with reason), organizer feature helpers; billing overrides; organizer-suite add-on entitlement. Used in about 66 files under `src/app/app`.
- Usage/credits foundation: `UsageFeatureKey` (`ai_action`, `sms_message`, `sms_segment`, `email_campaign_recipient`), AI allowances by plan, AI credit packs with checkout, seat limits.
- Owner billing authority hardened (LAUNCH-SEC-2A).

**REMAINING DELIVERABLES**
- SMS has no plan gate or usage consumption (SMS allowance is hard-coded to 0; no `BillingFeature` entry). Per-studio A2P approval exists but is not a plan entitlement.
- Email-campaign recipient allowance is defined but no enforcement call was found in campaign actions.
- No `BillingFeature` keys for payroll, marketplace, or ARIA beyond `ai_assistant`.
- No reusable upgrade-prompt component (only a billing-page query-param landing).
- No usage ledger writes outside `addons.ts` (and lumi portal).
- Future entitlement needs: Featured Events promotion (see module), Partner Match is intentionally free.

**LOCKED DECISIONS:** Starter has no AI or email allowance by design. Pricing amounts live in Phase 22.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Plan placement for SMS, payroll, marketplace and ARIA features.

**DEPENDENCIES:** Phase 2 (SMS), Phase 22 (pricing), Phase 13 (campaign allowances), Phase 19/20 (mobile gating).

**WEB IMPLICATIONS:** Upgrade prompts and usage display in the web app.

**MOBILE IMPLICATIONS:** Business app navigation must respect entitlements.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Entitlement authority is service-side hardened (migration `20260918070000`); keep enforcement server-side.

**BRANDING / POLISH CONSIDERATIONS:** Consistent upgrade and limit messaging.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/billing/{plans,access}.ts`, `src/lib/usage/addons.ts`.

---

## Phase 5 — Group Class canonical foundation

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** Group classes modeled canonically as appointments, with full operational support.

**PRODUCT INTENT:** One reliable model for classes: scheduling, rosters, eligibility, credit consumption, reminders, check-in, public sharing and reporting.

**COMPLETED CAPABILITIES**
- Appointment attendees roster foundation (`gc1_1`); attendance integrity and billing foundation (`gc1_2`); enrollment write RPCs (`gc1_4`); credit/benefit engine (`gc2a`–`gc2h`: finite benefit type, balance engine, capacity invariant, funding row selection, usage sync, consumption lifecycle guard, RLS self-access); roster capacity, enrollment policy table and funding candidate set (`gc3a`–`gc3c`); RLS tightening for group-class attendance/recap/appointments.
- Staff schedule workflow and QR check-in RPC; student check-in route (with test).
- Package/membership funding is covered by SQL tests; the credit-deduction lock-order hotfix (PKG-MUT-1) is released.

**REMAINING DELIVERABLES**
- Retire Events-based group-class creation (events actions, form and public event page still accept `group_class`).
- Close out the series/occurrence model: recurrence exists (`series_id`/`recurrence` on appointments) but no dedicated series table or documented decision; multi-week occurrence materialization **(unverified)**.
- Multiple locations/rooms for group classes (not found).
- Group-class reminders (not found).
- Group-class revenue reporting (not found).
- Public/shareable class URLs (belongs to Phase 6).

**LOCKED DECISIONS:** Group classes are canonical appointments; credits are consumed through the gc2 engine; new Events-based creation is to be retired (not yet done).

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** **Depleted-credit behavior** for group-class enrollment (open product decision #10); whether series stay appointment recurrence or get a dedicated model.

**DEPENDENCIES:** Phase 4 (entitlements); precedes Phase 6 and 7.

**WEB IMPLICATIONS:** Class scheduling/roster UX falls under Phase 17.

**MOBILE IMPLICATIONS:** Student class enrollment and check-in screens; Business app instructor roster/check-in.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Attendance and funding authority hardened; keep closed.

**BRANDING / POLISH CONSIDERATIONS:** Class pages should carry the studio identity and DanceFlow relationship consistently.

**DEFERRED / POST-LAUNCH ITEMS:** Depleted-credit product decision (see register).

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260908110000`–`20260913091100`; `src/lib/schedule/groupClassRoster.ts`.

---

## Phase 6 — GC-3.4 Public discovery and account linking

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** Public class discovery with safe account linking for students, guardians and dependents.

**PRODUCT INTENT:** A prospective student finds a class publicly, identifies themselves safely (self or dependent), and is linked to the right studio relationship without ambiguous or unsafe matching.

**COMPLETED CAPABILITIES**
- Student/guardian self-enroll RPC (`gc3d`, self and managed dependents) and portal SELECT (`gc3e`); portal schedule enrollment UI with tests.
- Student-identity library (links, lifecycle, portal connection state/context) with guardian/dependent references.
- Verified-email enforcement for email-based claims (LAUNCH-SEC-1C-B).

**REMAINING DELIVERABLES**
- Public class and series discovery routes and pages (no `/classes` route exists).
- Safe slug scheme for classes/series.
- Identity-intent capture and ambiguous-match handling.
- Link expiry and rate limiting (unverified).
- Guardian/dependent handling on the public path.
- Linking public visitors to existing student identity.

**LOCKED DECISIONS:** None currently identified beyond the verified-email binding already released.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Public-path guardian/dependent rules; ambiguity resolution policy.

**DEPENDENCIES:** Phase 5; shares public-discovery surface with Phase 21.

**WEB IMPLICATIONS:** New public routes; part of Phase 17.

**MOBILE IMPLICATIONS:** Student app class discovery and linking.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Identity matching is a high-risk surface; requires its own Security Review.

**BRANDING / POLISH CONSIDERATIONS:** Public class pages follow BR-4 presentation.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260913091200`, `20260913091300`; `src/lib/student-identity`.

---

## Phase 7 — GC-3.5 Direct-payment Group Class enrollment

**STATUS:** NOT STARTED

**OBJECTIVE:** Students pay directly (Stripe) to enroll in a group class, with seat holds and reconciliation.

**PRODUCT INTENT:** A class enrollment checkout that cannot oversell or leave orphaned payments.

**COMPLETED CAPABILITIES:** None currently identified (payment ownership and webhook patterns from the PAY-DC series exist and should be reused).

**REMAINING DELIVERABLES:** Seat-hold schema and RPCs with expiry; Stripe checkout for class enrollment; webhook finalization and release; reconciliation; tests.

**LOCKED DECISIONS:** Payments follow the established connected-account ownership model (PAY-DC).

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Hold duration and release rules; interplay with depleted-credit behavior.

**DEPENDENCIES:** Phase 5, Phase 6.

**WEB IMPLICATIONS:** Checkout and confirmation UX.

**MOBILE IMPLICATIONS:** Mobile PaymentSheet is a deferred item (see register).

**SECURITY / PERMISSIONS CONSIDERATIONS:** Payment identity, idempotency and reconciliation need a dedicated Security Review.

**BRANDING / POLISH CONSIDERATIONS:** Studio-named merchant identity per PAY-DC-3.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** No class-enrollment checkout or seat-hold objects found.

---

## Phase 8 — Documents Center completion

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS

**OBJECTIVE:** Complete document operations: revise/resend, client and general documents, waivers, signing lifecycle, certificates, receipts, branding and status UX within tier boundaries.

**PRODUCT INTENT:** Studios send, track and archive documents and signatures reliably.

**COMPLETED CAPABILITIES:** Revise-and-resend migration and operations; signing lifecycle (public and portal signing, e-signature consent, field placement editor, signed document and certificate routes); client vs general documents; branded assignment and signature emails (br3b2 tests); PDF generation; "Documents & E-Signatures" plan feature.

**REMAINING DELIVERABLES**
- Confirm tier gating on every documents action and route, including public sign and portal routes (unverified).
- Decide whether waivers are a dedicated deliverable (no waiver-specific module found; may be templates) and whether document receipts are canonical (not found).
- Status UX review.
- Revise/resend test coverage beyond the email tests.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Waiver and receipt scope.

**DEPENDENCIES:** Phase 4 (gating).

**WEB IMPLICATIONS:** Documents is a named workspace in the Phase 17 pass.

**MOBILE IMPLICATIONS:** Student wallet shows documents; Business app handles sending/tracking.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Public signing security helpers exist; keep closed.

**BRANDING / POLISH CONSIDERATIONS:** Document and email branding coverage.

**DEFERRED / POST-LAUNCH ITEMS:** None currently identified.

**EVIDENCE / RELEASE REFERENCES:** `src/lib/documents`, `src/app/app/documents`, migration `20260721000200`.

---

## Phase 9 — Payroll Prep v1

**STATUS:** SUBSTANTIALLY COMPLETE — SMALL CLOSEOUT REMAINS

**OBJECTIVE:** Draft → approved → exported/finalized payroll preparation with immutable snapshots, exports, locking and safe CSV.

**PRODUCT INTENT:** Studio owners prepare instructor pay accurately and lock it before payment.

**COMPLETED CAPABILITIES:** Pay periods and batches with create/approve/mark-paid RPCs and a lock trigger on batched earnings; per-earning classification and category snapshots; CSV and PDF exports; instructor compensation and overrides; Gusto readiness/sync tracking; payroll authorization hardened and fail-closed (LAUNCH-SEC-1A, released). Payroll CSV export neutralizes formula-leading cells (verified `csvSafe`).

**REMAINING DELIVERABLES**
- No "exported/finalized" state beyond `paid`.
- No standalone immutable calculation snapshot at approval (row-level snapshots and locking exist).
- Compensation detail/history UI.
- Responsive/empty/closed-state review.
- Accountant-delivery CSVs and the shared CSV helper do not neutralize formulas (payroll export does); see register.

**LOCKED DECISIONS:** Payroll disbursement is owner/platform-admin only.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Whether "exported/finalized" is a distinct required state.

**DEPENDENCIES:** Phase 12 (permissions) for broader roles.

**WEB IMPLICATIONS:** Named workspace in Phase 17.

**MOBILE IMPLICATIONS:** Business app (owner-level) may surface payroll later.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Authorization closed (1A). CSV formula hardening for other exports is post-launch.

**BRANDING / POLISH CONSIDERATIONS:** Payroll PDF branding.

**DEFERRED / POST-LAUNCH ITEMS:** Shared CSV formula-safe helper.

**EVIDENCE / RELEASE REFERENCES:** Migrations `20260715_payroll_*`, `20261004090000`; `src/app/app/instructor-pay`.

---

## Phase 10 — Organizer + Competition OS

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** A complete organizer workspace and a full Competition OS. **Ordinary event ticketing does not count as Competition OS.**

**PRODUCT INTENT:** Organizers run events and competitions end to end, from setup and registration through live operation, scoring, results and settlement.

**COMPLETED CAPABILITIES — EVENT side**
- Organizer workspace, organizer public page/ICS/embeds; event CRUD and public pages; ticketing (tickets, sell-tickets, digital tickets, multi-ticket cart, capacity holds, schedule items/sessions); registrations with exports and signed documents; check-in with scanner and recap; settlement/closeout (actions, export, PDF); financial summary and event order payments; organizer contacts and campaigns; event reminders and push; event-level ARIA actions; organizer roles/RLS.
- Release-hardening: zero-total checkout race closed (LAUNCH-SEC-2C).

**COMPLETED CAPABILITIES — COMPETITION side** (routes under `events/[id]/competition/*`; library `src/lib/competition`)
- Competition/showcase setup; divisions, contests, dances, WSDC rules; competitor registration (public builder, cart, fee rules, checkout, organizer registrations page); entries, entry dances and entry changes (table); heat planning with generation runs, review and apply; scheduling (schedule page, publications, constraints, conflicts, rounds); check-in (sessions, participants, credentials, participant waivers); readiness page; West Coast Swing foundation (tier rules, petitions, program profiles).

**REMAINING DELIVERABLES — COMPETITION (highly visible; drives the Phase 18 app-count decision)**
- **Officials/judges:** model, assignments, and judge access (none found).
- **Scoring:** engine, sheets, scoring-system choice (none found).
- **Placements/results:** calculation, tabulation, publishing (none found).
- **Awards** (none found).
- **Feedback** (judge or competitor) (none found).
- **Live heat management** (call, advance, delay, live status to competitors) (none found).
- **Scratches/changes workflow UI** with fees and re-heat (table exists; no UI).
- **Partnerships/couples management** (partial: entry participants and partner search only).
- Competition **test coverage** (none found for lib or routes).

**REMAINING DELIVERABLES — EVENT side:** volunteer/staff UI (labor actions exist without a page); a profitability view (only financial summary and settlement); organizer-specific notification center; organizer ARIA page; event-promotion/Featured management (see module).

**LOCKED DECISIONS:** Event and Competition are tracked separately. Competition routes live under the event.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Scoring system(s) to support; whether judging is web, mobile or a separate app (Phase 18); Featured Events model.

**DEPENDENCIES:** Phase 12 (competition-operational permissions); Phase 11 (notification integration); Phase 13/Featured module.

**WEB IMPLICATIONS:** Organizer and Competition are named workspaces in Phase 17.

**MOBILE IMPLICATIONS:** Judging, live heats and competitor surfaces drive the 2-app vs 3-app decision. Today `mobile/` contains only the student app; its competition screen is a discovery category.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Judge/scoring access and result integrity are new high-risk surfaces; require their own Security Review. Event staff-role granularity is deferred (see register).

**BRANDING / POLISH CONSIDERATIONS:** Organizer/competition surface branding unverified; vocabulary sweep ("Organizer Workspace").

**DEFERRED / POST-LAUNCH ITEMS:** Event staff-role hardening; floor-rental pricing redesign (unrelated sibling item).

**EVIDENCE / RELEASE REFERENCES:** `src/app/app/events/[id]/competition/*`, `src/lib/competition/*`, `20260622_west_coast_swing_foundation_v1`.

---

## Phase 11 — Messaging / Notification platform completion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS (Twilio approval is external and not counted against this phase)

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
- Competition-operational boundaries beyond `organizer_staff`.
- Event staff-role granularity (#7, deferred).

**LOCKED DECISIONS:** Owner-only administration and owner-access safeguards remain.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Whether custom roles are in scope.

**DEPENDENCIES:** Prerequisite for Phase 19 (Business navigation).

**WEB IMPLICATIONS:** Team settings redesign; permission-aware navigation.

**MOBILE IMPLICATIONS:** Business app navigation must be permission-driven.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Highest sensitivity; requires Security Review.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** Event staff-role granularity (#7); platform-admin MFA (#6).

**EVIDENCE / RELEASE REFERENCES:** `src/lib/auth/permissions.ts`, `20260423_role_permission_overrides.sql`.

---

## Phase 13 — Marketing / Campaigns completion

**STATUS:** PARTIAL — MATERIAL WORK REMAINS

**OBJECTIVE:** A full campaign system: editable drafts, reopen/modify before send, block editor, images, interactive elements, DanceFlow event-link picker, segmentation, analytics, email/SMS channel selection, consent enforcement and ARIA assistance.

**PRODUCT INTENT:** Studios and organizers create and send compliant, effective campaigns without leaving DanceFlow.

**COMPLETED CAPABILITIES:** Draft/test-send/recipient-generation/send for plain-text email campaigns (single CTA); fixed audiences (manual, all active clients, new leads, inactive clients, event attendees); unsubscribe table and public unsubscribe routes with compliance footer and consent acknowledgment; AI draft assistant; parallel organizer campaign system; tests for actions, authorization and email rendering.

**REMAINING DELIVERABLES**
- Edit/update-draft action and UI (unconfirmed).
- Block-based editor storing structured blocks rendered to `body_html`.
- Image upload/insert; interactive blocks (multiple CTAs/buttons).
- DanceFlow event-link picker.
- Saved/custom segments.
- Open/click/delivery/unsubscribe analytics (needs provider webhooks).
- Email/SMS channel selector (SMS campaigns gated on SMS consent and A2P; campaign recipients are email-only today).
- Client marketing-consent model beyond email unsubscribes.
- ARIA guidance beyond draft generation.
- Dedupe the duplicated action modules in campaign actions.
- Future Featured Events integration (NOT implemented; see module).

**LOCKED DECISIONS:** No marketing SMS under the current registered A2P scope.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Campaign SMS scope and use-case registration.

**DEPENDENCIES:** Phase 11, Phase 4 (allowances), Phase 2 (SMS).

**WEB IMPLICATIONS:** Marketing is a named workspace in Phase 17.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Consent enforcement and unsubscribe correctness.

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
- Web student purchase-history/wallet page (API-level only found).
- Refund → entitlement-revoke path (only a `refunded_access_retained` status seen) (unverified).
- Digital entitlement failure detection as an ARIA rule (unverified).

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** Seller payouts / third-party instructor or studio-as-seller revenue split (not found; assumed future).

**UNRESOLVED PRODUCT DECISIONS:** Seller model and payouts.

**DEPENDENCIES:** Phase 4 (marketplace entitlement keys).

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
- Refresh the stale coverage-audit document.
- No documented organizer/competition assistance beyond cron role resolution; tier/credit enforcement in ARIA beyond AI-credit allowances (unverified).

**LOCKED DECISIONS:** Autonomy levels (Handle automatically / Prepare for review / Notify only / Off) and the permission ceilings above. Do not claim unreleased automation publicly.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** None currently identified.

**DEPENDENCIES:** Phase 4, Phase 10 (organizer assistance), Phase 11.

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

**REMAINING DELIVERABLES:** The pass across Studio, Organizer, Competition, Payroll, Documents, Marketing and related operational workspaces, **plus Discovery / Partner Match where applicable** (web request flow, listing management, moderation-state UX). Absorb PORTAL-UX-1/2 backlog.

**LOCKED DECISIONS:** The finalized web workflows become the canonical UX model for mobile. Do not start before material upstream workflow phases are done.

**PROPOSED BUT NOT APPROVED:** None currently identified.

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

**STATUS:** NOT STARTED (nothing exists)

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

**REMAINING DELIVERABLES:** Redesign; replace the retired couple/script logo and DF monogram icon; Partner Match accept/decline, thread push routing, web photo parity and refined UX; featured-event visibility if built; store readiness (no listing assets, privacy/data-safety declarations or screenshots found; `eas.json` `submit.production` is empty); remove the duplicate `partners/draft` screen.

**LOCKED DECISIONS:** Must not leapfrog unfinished web workflows or the Phase 18 audit.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Dependent on Phase 18.

**DEPENDENCIES:** Phase 18; Phase 6/7; Phase 14 closeout; branding identity decision for mobile.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** This is the mobile redesign.

**SECURITY / PERMISSIONS CONSIDERATIONS:** Session/auth per Phase 18.

**BRANDING / POLISH CONSIDERATIONS:** App-store-facing identity and variants (waits on Phase 18).

**DEFERRED / POST-LAUNCH ITEMS:** Mobile PaymentSheet.

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

**DEPENDENCIES:** Moderation queue precedes Partner Match public promotion.

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

**DEPENDENCIES:** Phase 25 shares evidence needs.

**WEB IMPLICATIONS:** None currently identified.

**MOBILE IMPLICATIONS:** None currently identified.

**SECURITY / PERMISSIONS CONSIDERATIONS:** This is a security phase.

**BRANDING / POLISH CONSIDERATIONS:** None currently identified.

**DEFERRED / POST-LAUNCH ITEMS:** Post-launch by nature.

**EVIDENCE / RELEASE REFERENCES:** None found.

---

## Phase 25 — SOC 2 Type II

**STATUS:** NOT STARTED

**OBJECTIVE:** SOC 2 Type II readiness and attestation.

**PRODUCT INTENT:** Enterprise trust.

**COMPLETED CAPABILITIES:** Technical controls and public legal/security pages exist (security page, DPA, acceptable use, platform MFA setup, audit-log references). No policy documentation or SOC 2 artifacts found.

**REMAINING DELIVERABLES:** Everything.

**LOCKED DECISIONS:** None currently identified.

**PROPOSED BUT NOT APPROVED:** None currently identified.

**UNRESOLVED PRODUCT DECISIONS:** Timing and auditor.

**DEPENDENCIES:** Phase 24; platform admin MFA.

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

**COMPLETED CAPABILITIES (baseline):** Google Calendar, Gusto, and Wave integrations.

**REMAINING DELIVERABLES:** Not yet defined.

**LOCKED DECISIONS:** None currently identified.

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
- Shared CSV helper does not neutralize formula-leading cells (payroll export does; accountant-delivery CSVs unverified)
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
- Mobile PaymentSheet

**Product decisions / future work**
- Group-class depleted-credit behavior (#10)
- Floor-rental studio-authoritative pricing/approval redesign
- Public waitlist
- Featured Events governing/business model
- Partner Match age, moderation and future-monetization details
- Final mobile app boundary (Phase 18)

**Engineering hygiene**
- Repo-wide lint debt: about 293 errors and 378 warnings pre-exist (CI lints changed files only). Not a launch blocker.

---

## COMPLETED LAUNCH WORK REGISTER

Inserted ahead of the numbered sequence; all released and closed. Do not reopen without concrete regression evidence.

- **Launch security:** LAUNCH-SEC-1A (payroll authorization fail-closed), 1B/1B2 (private client photos, public asset storage authorization), 1C-0/1C-0-R (legacy auth surfaces; #123, #124), 1C-A/A1 (verified email proof; #125, #126), 1C-B (verified email enforcement; #127), 2A (owner billing authority; #128), 2B (tenant write surfaces: deduction errors, job postings, floor rentals; #129), 2C (event zero-total guard; #130).
- **Payments / package integrity:** PAY-DC-1 through 4A (#109–#115), PKG-MUT-1 (#116), PKG-REFUND-1 (#117), PKG-REFUND-2 and hold release (#118; `PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = false`).
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
8. Phase 4 plan placement for SMS, payroll, marketplace, ARIA.
9. Documents scope: waivers and receipts.
10. Payroll "exported/finalized" state.
11. Competition scoring system(s) and where judging runs.
12. Pricing cutover timing.
13. BR collateral asset count and video cut list.

---

## Roadmap information that could not be confidently preserved

- The original roadmap source is not in the repo; the 26-phase list and per-phase intent come from the owner's canonical list plus reconciliation. Phase "product intent" sentences are summaries of that list, not quoted requirements.
- Landmark 1A's canonical slice list beyond the nine migrated slices.
- The exact contents of the earlier Featured Events and Partner Match discussions beyond what is recorded in the repo and the owner's reconciliation briefs.
- Branding assets/specs for collateral and media (none exist in the repo).

---

## ROADMAP CHANGE LOG

| Date | Version | Change |
|---|---|---|
| 2026-10-02 | v1.0 | Materialized the canonical 26-phase roadmap into version control. Reconciled against main `2266f5f`. Added full Branding / Public Launch Readiness scope. Added Featured Events strategic module. Added Partner Match strategic module and public-acquisition intent. Preserved the deferred/post-launch register. Established Phase 3 / BR-4 as next active roadmap work. Twilio remains a parallel external dependency. |
