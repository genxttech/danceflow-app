# TW-4 — Automated Twilio ISV SMS Onboarding (Design for Owner Review)

**Status (roadmap v2.22, 2026-10-13):** Self-service architecture **APPROVED AS THE PRODUCT DIRECTION** (owner). D1–D7 (§18) are **established design directions**; what remains for them is technical verification (Twilio Q1–Q5, §20), not product choice. **Implementation is not yet authorized** (each slice needs its own authorization). The ConfiDance pilot uses the real automated onboarding flow. D1–D7 supersede conflicting text in §2–§17. The §20 Twilio message is still a draft and has not been sent.
*(Original status, 2026-10-12: PROPOSED; architecture direction approved for further planning; not approved for implementation.)*
**Date:** 2026-10-12. **Audited code:** `origin/main` `733a20c0`. **Roadmap:** recorded in v2.22 (Phase 2); this document is the TW-4 design reference.
**Ticket:** Twilio #29647095. Primary Customer Profile `BUed777b1ed81df271793fbd097324ec94` (GenX TotalTech LLC) is now Twilio Approved as **ISV Reseller or Partner** (owner-reported).
**Guardrails respected:** no Twilio resources created, no registrations submitted, no numbers bought, no SMS sent, no credentials touched, no SQL applied, no application code changed. PAY-WH-1 is not touched.

---

## 0. Executive summary

DanceFlow can automate almost the whole studio onboarding path through Twilio's Trust Hub, A2P and Messaging APIs:

- Secondary Customer Profile
- A2P Trust Product
- Brand
- Messaging Service
- Campaign
- Number purchase and attach
- Status reconciliation through Event Streams

The studio owner fills in one guided form inside DanceFlow, accepts disclosures, and sees plain-language status. Twilio's resource structure stays hidden.

**Five findings change the plan and need owner and/or Twilio decisions before the build (§2):**

1. **Advanced Opt-Out (AOO) cannot be configured by API.** Twilio documents it as Console-only, and once enabled it can't be turned off without Support. TW-1's locked decision ("AOO is the compliance response authority") is incompatible with zero-Console onboarding. A per-studio opt-out mode decision is needed.
2. **Twilio prefers one subaccount per ISV customer.** Our locked design (one account, one Messaging Service per studio) is "compatible but not preferred". In that design one studio's abuse can suspend every studio, and opt-outs are kept per account, so moving to subaccounts later loses them. This is the cheapest moment to decide, because no studio is live.
3. **Campaign Terms must be on the same domain as the brand's business website.** Privacy and Terms URLs have been effectively mandatory since 2026-06-30. Studios with their own website domain conflict with DanceFlow-hosted SMS terms.
4. **Low-Volume Standard + `LOW_VOLUME` (Low Volume Mixed) is far cheaper for small studios** than Standard + `MIXED`. Setup is about $20 instead of about $61; the campaign is $1.50/mo instead of $10/mo. TW-3's enum allows only `mixed`.
5. **Per-number carrier registration status has no REST endpoint.** Event Streams is therefore required, not optional.

**Recommendation:** formalize **TW-4 — ISV Studio Registration Provisioning** as a Phase 2 lane with slices 4A–4F (§16). ConfiDance is the first studio to go through the real in-app flow (§13).

---

## 1. Current-state audit (origin/main 733a20c0)

| Area | What exists | Gap for automated ISV onboarding |
|---|---|---|
| Twilio client | `twilio@^5.13.1`. `src/lib/sms/twilio.ts` sends only, via `messagingServiceSid` (no global fallback). Credentials are `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (master token) | No Trust Hub / A2P / Messaging Service / number / Event Streams calls. No restricted API key |
| Sender selection | `src/lib/sms/studioSender.ts`: global kill switch `DANCEFLOW_SMS_STATUS`, then the studio's own `studio_sms_registrations` row with `registration_status='approved'`, a valid MG and QE, and a sender. Inbound and status webhooks map back to the studio by MG and/or `To` | Reused unchanged. It is the final send gate |
| Registration model | `studio_sms_registrations` (A2P-1 + TW-3): one row per studio. BU, BN, MG, QE, PN, sender, `brand_status`/`campaign_status` (`not_started, in_review, approved, rejected, suspended`), `campaign_use_case` (`mixed` only), aggregate `registration_status`. The DB constraint enforces the approved invariant. RLS is platform-admin only, with unique MG/QE/sender/PN | No A2P Trust Product BU, address SID, brand type, identity status, failure codes, number registration status, opt-out mode, account SID, or sync timestamps. No studio-facing read path |
| Admin UI | `/platform/sms` manual metadata form (TW-3) | Becomes a read-mostly operations console plus an exception queue |
| Webhooks | `/api/sms/twilio/inbound` (signature-validated; TW-1 `OptOutType`-aware, with a whole-message keyword fallback when `OptOutType` is absent) and `/api/sms/twilio/status` (signature + callback secret; strict MG match) | No Event Streams endpoint |
| Consent | TW-2: `sms_contact_permissions` (client + studio/phone-level rows), append-only `sms_consent_history`, consumer-STOP lock, `resolveEffectiveSmsConsent`. Public opt-in checkbox (`SmsConsentCheckbox`, disclosure `a2p1b-v1`) on `/studios/{slug}` lead/booking forms. `/sms-consent`, `/privacy` §7, `/terms` SMS section | Campaign text and opt-in evidence are hand-written per studio. Studio-specific SMS terms/privacy pages are missing (see §2 F3) |
| Allowed SMS traffic | `SMS_AUTOMATED_TEMPLATES` = appointment confirmed / rescheduled / cancelled. Staff 1:1 via `/api/sms/send` (owner/admin/front_desk, rate-limited) | Matches a Mixed or Low-Volume-Mixed campaign. Event and reminder SMS stay blocked. Marketing SMS doesn't exist (Phase 13) |
| Studio profile data | Settings carry `business_name`, address/city/state/postal/country, `public_email`/`public_phone`, `website_url`, timezone. Stripe Connect status flags | No legal entity name, entity type, EIN, industry, or authorized representative. Display name ≠ legal name |
| Billing / entitlements | `BillingFeature` + `requireStudioFeature`. `usage_events` / `usage_monthly_summaries` / `usage_addon_entitlements` ("SMS metering later"). SMS allowance hard-coded to 0 | Blocked on **open decision #8** (SMS plan placement) and Phase 22 pricing |
| Notifications | Branded email shell + studio-named sender (`src/lib/email`). `outbound_deliveries`. `platform_alerts`. Crons in `vercel.json` (notifications, ARIA, documents) | No onboarding emails, alerts or cron |
| ARIA | Deterministic Operations matrix, packs, digest crons; knowledgebase article "Using SMS Consent and Message History" | No SMS onboarding guidance |
| Roles | `studio_owner`, `studio_admin`, `front_desk`; `requirePlatformAdmin` | Onboarding must be owner-only (legal attestation) |

---

## 2. Findings that need decisions before build

### F1 — Opt-out authority (AOO is Console-only)
Twilio documents Advanced Opt-Out only as Console steps:
- There is no REST parameter or endpoint.
- It can't be disabled once enabled.
- `OptOutType` reaches our webhook **only** when AOO is enabled.
- Without AOO, Twilio's default handling still blocks STOP/START keywords (error 21610 on later sends). It doesn't send `OptOutType`, and HELP handling differs.

Today, TW-1 falls back to whole-message keyword classification and replies with its own TwiML when `OptOutType` is absent.

| Option | Automation | Compliance | Engineering |
|---|---|---|---|
| **A. AOO per studio, Console** | ✗ (one human Console step per studio; violates the requirement) | Strong | None |
| **B. Twilio default opt-out ("platform-managed mode")** | ✓ fully automated | Twilio still enforces STOP/START at the carrier edge. DanceFlow supplies the HELP reply (studio-named) and records events through the existing fallback | TW-1 adjustment: no app reply where Twilio already replies (to verify: default STOP/START reply text, HELP behavior). Campaign `OptOut*`/`Help*` fields supplied by DanceFlow |
| **C. Ask Twilio for an ISV path** (API/account-level AOO template, or Support bulk-enable) | ✓ if offered | Strong | Small |

**Recommendation:**
- Ask Twilio (C) on #29647095.
- Design for **B as the automated default**, plus a per-registration `opt_out_mode` (`twilio_default` | `twilio_advanced`) so studios Twilio enables for AOO work unchanged.
- The owner must **supersede the locked decision** "AOO is the compliance authority" with "Twilio opt-out enforcement is authoritative; AOO where available".

### F2 — Account architecture (single account vs subaccount per studio)
Twilio's ISV guide lists six architectures:
- Ours is **#4, one account with a Messaging Service per customer**: compatible, not preferred.
- **#1, a subaccount per customer**, is preferred. It isolates suspension blast radius, attributes usage and cost per studio, and keeps opt-outs per studio account.
- Opt-out records are per account, so migrating later drops Twilio-held opt-outs.

Subaccount costs:
- A provisioning step (create subaccount).
- Every API call scoped to the subaccount SID with parent credentials.
- **Webhook signatures are computed with the subaccount's auth token.** The app would have to obtain it at runtime through the parent API (not stored) or hold it as a secret. *Verify with Twilio.*
- A2P resources (Secondary profile, brand, MG, campaign, number) live in the subaccount, and the primary ISV profile is assigned in.

**Recommendation:**
- Raise with Twilio together with F1.
- Make the schema account-aware now (`twilio_account_sid` per registration) so either model works.
- **I recommend subaccount-per-studio** if Twilio confirms that parent-credential A2P registration works inside subaccounts and that the webhook validation approach holds.
- This **supersedes the locked decision "Subaccounts are NOT part of the architecture"**, so it's an owner decision.

### F3 — Terms/Privacy URL domain rule
- Campaigns need `PrivacyPolicyUrl` and `TermsAndConditionsUrl` (rejected without them since 2026-06-30).
- **Terms must be on the same domain as the business website.**
- The privacy policy must say mobile numbers / opt-in data are not shared with third parties, plus frequency and "Msg & data rates may apply".
- Website URLs are screenshotted and must be live and business-related.

Proposed approach:
- Per-studio SMS Terms and Privacy pages hosted by DanceFlow: `https://www.idanceflow.com/studios/{slug}/sms-terms` and `/sms-privacy`.
- Generated from DanceFlow-owned templates with the studio's legal and display names.
- Brand `website_url`:
  - (a) the studio's own website if it has one. *Domain mismatch: ask Twilio whether ISV-hosted studio-scoped terms are acceptable.*
  - (b) the studio's DanceFlow public page if it has none.
- Current `/privacy` §7 already says mobile information isn't shared for marketing purposes. Add the explicit TCR wording ("No mobile information will be shared with third parties/affiliates for marketing/promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties.") to the per-studio page.

### F4 — Brand/campaign tier (cost and TW-3 enum)

| Tier | Brand | Campaign vetting | Campaign monthly | Throughput | Use case |
|---|---|---|---|---|---|
| Low-Volume Standard (`SkipAutomaticSecVet=true`) | $4.50 | $15 | $1.50 | lowest tier (≈2,000 T-Mobile segments/day) | `LOW_VOLUME` only |
| Standard (secondary vetting) | $46 | $15 | $10 | by trust score | `MIXED`, `CUSTOMER_CARE`, … |

A dance studio's appointment + 1:1 traffic is far below the LVS limits.

**Recommendation:**
- Default to **LVS + `LOW_VOLUME`**, describing the same transactional + staff 1:1 content.
- Standard + `MIXED` stays available for high-volume studios.
- This needs a TW-3 enum extension (`low_volume_mixed`) and a decision that "Mixed" means Twilio `MIXED` or `LOW_VOLUME`. *Confirm with Twilio that LOW_VOLUME fits the guidance given for ConfiDance.*
- Upgrading LVS→Standard later means new vetting and a new campaign.

### F5 — Status visibility
- Brand and campaign status can be polled.
- **Per-number registration status has no REST endpoint**, only Event Streams (`number-registration.pending/successful/failed`).
- There are no suspension events, so polling remains necessary for `SUSPENDED`.
- **Design: Event Streams plus a poller** (§7).

### Other confirmed constraints
- There is no REST idempotency key. Recovery depends on a ledger plus deterministic FriendlyNames (list filters exist for CustomerProfiles and IncomingPhoneNumbers, not for every resource).
- Editing a campaign after submission is **Private Beta**: request enablement from 10dlc-onboarding@twilio.com. Otherwise delete and recreate, with a new $15 fee.
- Brand resubmission: 3 free. A brand can't be edited while a campaign is attached.
- Compliance Embeddable is still **Private Beta** and doesn't cover the Messaging Service, numbers or opt-out, so we use the direct API.
- Sole Proprietor (no EIN) is supported by API, but with an OTP to the owner's mobile, 1 campaign, 1 number, and US LLCs ineligible. **Excluded from v1** and planned as a later slice.
- The Secondary profile and Trust Product `Email` should be **ISV-owned**: a DanceFlow compliance mailbox, e.g. `sms-compliance@idanceflow.com` (to create).
- Each email and address can be reused on at most 10 TCR brands. Brand contact emails can't be free-mail. There are at most 50 brands per EIN.

---

## 3. Twilio resource dependency sequence (Standard / LVS brand)

All calls are server-side, using DanceFlow credentials (in the parent account, or scoped to the studio subaccount if F2 is adopted). FriendlyName convention: `df:{env}:{studio_id}:{step}`.

```
P0  (platform, once)  Primary ISV profile approved (BUed777…)       — precondition check (GET)
P1  (platform, once)  Event Streams sink DG… + subscription DF…      — 15 A2P event types
P2  (studio, F2 only) Subaccount AC…

S1  Secondary Customer Profile BU…   POST trusthub/v1/CustomerProfiles (Policy RNdfbf3f…, Email=ISV mailbox, StatusCallback)
S2  EndUser business info IT…        type customer_profile_business_information → assign to S1
S3  EndUser authorized rep IT…       type authorized_representative_1 → assign to S1
S4  Address AD…                      api/2010-04-01/Addresses
S5  SupportingDocument RD…           type customer_profile_address (address_sids=AD) → assign to S1
S6  Assign Primary profile BUed777…  EntityAssignments on S1
S7  Evaluate S1                      Evaluations → compliant | noncompliant(results[])   ← validation gate
S8  Submit S1                        Status=pending-review
T1  A2P TrustProduct BU…             POST trusthub/v1/TrustProducts (Policy RNb0d477…)
T2  EndUser us_a2p_messaging_profile_information (company_type=private) → assign; assign S1
T3  Evaluate T1 → submit pending-review
B1  BrandRegistration BN…  ($)       POST messaging/v1/a2p/BrandRegistrations (BrandType=STANDARD, SkipAutomaticSecVet per tier)
        wait → APPROVED (minutes … 7+ business days)
M1  Messaging Service MG…            POST messaging/v1/Services (InboundRequestUrl=/api/sms/twilio/inbound, StatusCallback per message as today,
                                     Usecase=notifications, StickySender, UseInboundWebhookOnNumber=false)
M2  (opt-out mode)                   twilio_default: nothing. twilio_advanced: requires Twilio/Console (F1)
C0  Fetch allowed use cases          GET …/Compliance/Usa2p/Usecases?BrandRegistrationSid=BN
C1  Campaign QE…  ($)                POST …/Services/{MG}/Compliance/Usa2p  (template content §9, Privacy/Terms URLs, X-Twilio-Api-Version v1.2)
N1  Search number                    AvailablePhoneNumbers/US/Local (studio area code / near studio, SmsEnabled, address_requirements=none preferred)
N2  Purchase number PN…  ($)         IncomingPhoneNumbers (FriendlyName, no per-number SmsUrl)
N3  Attach PN to MG                  POST …/Services/{MG}/PhoneNumbers (allowed before campaign approval)
        wait → campaign VERIFIED + number-registration.successful
R1  Readiness                        all TW-3 invariants hold → platform sets aggregate approved (see §12)
```

Dependencies:
- S1–S8 must complete before T1.
- B1 needs S1 and T1 submitted, not approved.
- M1 and C0 wait for brand `APPROVED`.
- C1 needs M1.
- N1–N3 can run after M1, in parallel with C1.

Fee-bearing steps are marked ($).

---

## 4. Onboarding state machine

A studio has one active onboarding record. `state` is what the studio sees. `step` is the orchestrator's internal pointer.

```
not_started
  └─(owner opens "Turn on texting")→ draft
draft  (owner edits; autosave; local validation)
  └─(owner attests + submits)→ submitted_for_checks
submitted_for_checks  (S1–S7 run; Twilio evaluation)
  ├─ noncompliant → needs_info (field-level errors mapped back to form)
  └─ compliant → profile_review (S8, T1–T3 submitted)
profile_review
  └→ brand_pending  (B1 created; fee gate passed)
brand_pending ──FAILED──→ needs_info (fixable; ≤3 free resubmits) | blocked (not fixable / >3 → platform exception)
     │ APPROVED
     ▼
service_setup  (M1, M2, C0)
  └→ campaign_pending  (C1 submitted; N1–N3 in parallel)
campaign_pending ──FAILED──→ needs_info | blocked
     │ VERIFIED + number registered
     ▼
ready_for_activation  (all invariants; awaiting platform release gate §12)
  └─(platform approval + owner "Activate")→ active
active ──SUSPENDED (poll)──→ suspended  (sending blocked by aggregate)
any ──(owner cancels before B1)──→ cancelled (Twilio drafts left/cleaned by ops)
any ──(unknown outcome / unrecoverable)──→ exception (platform queue; studio sees "We're working on it")
```

Mapping to the TW-3 columns (written only by the orchestrator, never by the studio):

| Onboarding | `brand_status` | `campaign_status` | `registration_status` |
|---|---|---|---|
| draft … profile_review | not_started | not_started | not_registered |
| brand_pending | in_review | not_started | in_review |
| brand FAILED | rejected | not_started | rejected |
| service_setup / campaign_pending | approved | in_review | in_review |
| campaign FAILED | approved | rejected | rejected |
| ready_for_activation | approved | approved | in_review (still blocked) |
| active | approved | approved | **approved** (gate §12) |
| SUSPENDED | — | suspended | suspended |

---

## 5. Studio-owner UI journey (minimal clicks)

Entry is **Settings → Texting (SMS)**, owner only. Admins and front desk see read-only status.

1. **Intro card**
   - What texting covers: appointment confirmations, changes and cancellations, plus staff 1:1 messages. No marketing.
   - Costs from the entitlement (§11).
   - Typical timeline: brand minutes to 7+ business days, campaign days to weeks.
   - One button: **Start setup**.
2. **Business identity** (one page, prefilled, clearly labelled "must match IRS records")
   - Legal business name: prefilled from the studio name **but flagged "confirm exactly as on your IRS EIN letter (CP 575 / 147C)"**. The display name is shown separately as the "brand name customers see".
   - Entity type (LLC / Corporation / Partnership / Non-profit / Co-op), EIN (`00-0000000`), industry. Default `EDUCATION`; the owner may pick `CONSUMER`. *Ask Twilio which fits dance studios.*
   - Business address: prefilled from studio settings; a PO box warning.
   - Website: own site, or "use my DanceFlow page" (F3).
   - "No EIN / sole proprietor" exits to "not yet supported" and a waitlist.
3. **Authorized representative**
   - First and last name, title, job position (enum), business email (free-mail warning), mobile.
   - Prefilled from the owner's profile.
4. **Texting number**
   - Preferred area code, prefilled from the studio phone.
   - "We'll pick a local number; you can't choose a vanity number in v1."
5. **Review & attest** (one screen)
   - The generated campaign summary and sample messages (read-only, studio-named).
   - Links to the studio's SMS Terms and Privacy pages and the opt-in form preview.
   - Checkboxes, each logged with version, timestamp and user:
     - I am authorized to register this business.
     - Information is accurate.
     - We will text only people who opted in, and only service messages.
     - Fees and DanceFlow SMS terms.
   - **Submit**.
6. **Status tracker**
   - Steps: Business verification → Brand approval → Campaign approval → Number ready → Activate.
   - Each step shows a plain-language state, an expected time, and **"What ARIA recommends"**.
   - On `needs_info`, the exact field is highlighted with a fix message. The owner edits and resubmits from the same form.
7. **Activate** (when `ready_for_activation` and the platform gate are clear)
   - One button.
   - Shows the texting number and a reminder that clients must opt in.

Drafts autosave (resumable). The form is fully server-validated with the same validators used before Twilio evaluation. No Twilio terminology appears; SIDs are never shown to studios.

---

## 6. Database schema (proposed; all new tables RLS-enabled)

**`studio_sms_onboarding`** (one active per studio; `unique(studio_id) where state not in ('cancelled')`)
- id, studio_id → studios, `state`, `step`, `tier` (`low_volume_standard` | `standard`), `opt_out_mode`
- draft identity (non-secret): legal_name, entity_type, industry, website_choice, website_url, address fields, rep first/last/title/position/email/phone, preferred_area_code
- `ein_last4`, `ein_ciphertext` (see Security)
- attestation_version, attested_by, attested_at, disclosure versions
- `submission_seq` (increments per resubmission), lease_owner, lease_expires_at, next_attempt_at, attempt_count, last_error_code, last_error_field, timestamps
- RLS: studio owner of `studio_id` may read sanitized columns (never `ein_ciphertext`) and write **draft fields only while state ∈ {draft, needs_info}**, via a `security definer` RPC `save_sms_onboarding_draft(studio_id, …)` that checks role = `studio_owner` for that studio. Platform admin: read all except ciphertext. Service role: orchestrator.

**`studio_sms_provisioning_steps`** (ledger; unique `(onboarding_id, step_key, submission_seq)`)
- step_key (S1…N3), status (`pending` | `in_flight` | `succeeded` | `failed` | `unknown_outcome` | `skipped`), provider_sid, friendly_name, request_fingerprint (hash of non-PII inputs), fee_bearing bool, fee_confirmed_by/at, started_at, finished_at, error_code, error_detail_sanitized
- Write: service role only. Read: platform admin.

**`twilio_event_inbox`**
- event_id (CloudEvent id, **unique**), type, subject SIDs (brand/campaign/service/number), event_time, received_at, processed_at, outcome, payload_sanitized (no PII)
- Service role only.

**`studio_sms_onboarding_audit`** (append-only, trigger blocks update/delete)
- actor (user | system | platform_admin), action, from_state, to_state, step_key, provider_sid, note. No PII values, no secrets.

**Extend `studio_sms_registrations`** (TW-3 table stays the single send-time source of truth):
- `twilio_account_sid` (AC…, F2), `trust_product_sid` (BU…), `address_sid` (AD…), `brand_type`, `brand_tier`, `brand_identity_status`, `brand_error_codes text[]`, `campaign_error_codes text[]`, `number_registration_status` (`unregistered` | `pending` | `registered` | `failed`), `opt_out_mode`, `provisioned_by` (`manual` | `automated`), `last_synced_at`
- Extend the `campaign_use_case` enum: `low_volume_mixed` (F4)
- Extend the approved invariant: + `number_registration_status='registered'`
- Keep: aggregate `approved` requires the existing invariants. The orchestrator writes component statuses only.

**Studio-facing read:** RPC `get_studio_sms_status(studio_id)` → `{state, step_label, needs_info_fields[], sender_display (masked until active), activated_at}`. Owner/admin of that studio only. No SIDs, ever.

**Entitlement:** `BillingFeature 'sms_messaging'` or `usage_addon_entitlements.feature_key='sms_messaging'` (decision #8). Usage metering `usage_events.feature_key='sms_segment'`.

---

## 7. Orchestration, idempotency, retries and recovery

**Runner**
- Cron `/api/cron/sms-onboarding` every 2–5 minutes (CRON_SECRET), plus an immediate kick after owner submit and after each Event Streams event.
- Processes due onboardings with a **row lease** (`update … set lease_owner, lease_expires_at where lease_expires_at < now() returning`), one step per studio per tick.
- Global token bucket: BrandRegistrations ≤1/s; account concurrency respects 429 / `Twilio-Concurrent-Requests`.

**Step protocol (every create step)**
1. If the ledger row is `succeeded`, skip (use the stored SID).
2. If `in_flight` or `unknown_outcome`, **reconcile first**: look up the resource by deterministic FriendlyName (CustomerProfiles, TrustProducts, IncomingPhoneNumbers), by parent linkage (EntityAssignments of the bundle, BrandRegistrations by `A2PProfileBundleSid`, Usa2p list on the MG, PhoneNumbers on the MG), or by Services list scan by FriendlyName. Exactly one found → adopt the SID, mark succeeded. None found and the step is not fee-bearing → retry. **Fee-bearing (B1, C1, N2) with ambiguous outcome → `exception`, never auto-recreate.**
3. Mark `in_flight` (commit) → call Twilio → **persist the SID in the same transaction that marks `succeeded`** → advance.
4. Errors:
   - 429/5xx/network → `unknown_outcome` for POSTs (reconcile next tick), exponential backoff (1m, 5m, 15m, 1h, cap 6h).
   - 4xx validation → `failed` → map to `needs_info` with field and message.
   - Twilio account-level errors → `exception` + platform alert.

**Fee gate**
- B1, C1 and N2 run only if the onboarding has an active SMS entitlement, the attestation is current, and the platform release gate allows the tier (pilot allow-list).
- Each fee step stores `fee_confirmed_by/at` (system confirmation from the entitlement, or platform admin for exceptions).

**Resubmission**
- `needs_info` edits bump `submission_seq`.
- Steps reuse existing SIDs where Twilio allows edit (EndUser/Address update + re-evaluate + resubmit; brand `POST /BrandRegistrations/{BN}` resubmit, max 3).
- Campaign fixes use the update API if Private Beta is enabled; else delete + recreate under fee gate.

**Status reconciliation**
- `/api/sms/twilio/events`:
  - Validate `X-Twilio-Signature` against the exact sink URL and raw body.
  - Respond within 5s.
  - Insert into `twilio_event_inbox` (dedupe on event id, return 200 on duplicate).
  - Process asynchronously, ordering by event time.
  - Unknown subject SID → ignore + alert.
- Poller: every in-review brand/campaign hourly; every active campaign daily (detects `SUSPENDED`, no event exists); profiles/TrustProducts via GET.

**Recovery tools (platform admin)**
- "Re-sync from Twilio" (GET-only).
- "Adopt orphan resource" (choose a found SID).
- "Mark step resolved".
- "Cancel onboarding".
- All audited. No free-text SID editing on automated rows (manual TW-3 form stays only for `provisioned_by='manual'`).

---

## 8. Tenant isolation

- Every onboarding, step, event and registration row is keyed to exactly one `studio_id`. The studio-facing RPCs derive `studio_id` from the authenticated studio context **and** re-check the caller's role for that studio. No client-supplied IDs are trusted.
- Studios can't read SIDs, other studios' rows, the ledger, the inbox, or EIN ciphertext. There's no studio write path to `studio_sms_registrations`.
- Sending stays on `resolveStudioSmsSender` (approved row for *this* studio only).
- Inbound and status webhooks keep the strict MG/To agreement check.
- Event Streams events are applied only when the subject SID maps to exactly one registration (unique indexes on MG/QE/PN/BN + new unique on `brand_sid`, `customer_profile_sid`, `trust_product_sid`).
- With F2 subaccounts, `twilio_account_sid` must also match the event/webhook `AccountSid`.
- Provider identifiers stay server-only. Logs and audit store no EIN, rep phone/email, or message bodies.

---

## 9. Consent, campaign content and compliance controls

**Campaign content is DanceFlow-owned and versioned (`sms_campaign_template` vN), not studio-editable.** Studio values are interpolated (legal/display name, slug URLs, support contact).
- `Description`: transactional appointment messages (confirmations, reschedules, cancellations) and staff-initiated one-to-one operational messages to the studio's own opted-in clients. No marketing, promotional, bulk or lead-generation SMS. Sent via the DanceFlow platform (GenX TotalTech LLC, ISV).
- `MessageFlow`: the public studio page form (`/studios/{slug}#lead`, the optional unchecked checkbox, the exact `a2p1b-v1` disclosure) and staff-recorded verbal/written consent using the same disclosure. URL plus the per-studio Terms/Privacy pages. Hosted screenshot URL generated by DanceFlow (static capture of the studio's opt-in form).
- `MessageSamples` (2–5; real dispatcher output, studio-named, footer included): confirmation, reschedule, cancellation, staff 1:1. **No "reminder"**: appointment reminder SMS isn't an allowed automated template.
- `HasEmbeddedLinks=false`, `HasEmbeddedPhone=false` (true if samples ever include them).
- `SubscriberOptIn=true`, `AgeGated=false`, `DirectLending=false`.
- Opt-out/HELP fields: set by `opt_out_mode` (F1). Studio-named HELP: "{Studio} texts through DanceFlow, operated by GenX TotalTech LLC. For help, contact support@idanceflow.com or the studio. Reply STOP to opt out. Msg&data rates may apply."

**Sending controls (existing; unchanged):**
- TW-2 consent precedence: consumer STOP is locked, START restores only prior consent, no staff reversal.
- The per-studio footer is always appended.
- Automated templates are limited to the three appointment templates.
- Event SMS is blocked.

**Marketing SMS** (Phase 13) is *out of scope*. It would require a separate `MARKETING` campaign under the same brand, a separate marketing-consent record and disclosure (distinct from transactional consent), quiet hours, and recipient allowance metering. The design reserves `campaign_use_case` values and a `purpose` on consent, but builds nothing.

**Delivery callbacks:** unchanged per-message `StatusCallback` with strict MG match. Add `usage_events` metering of segments (on `sent`).

**Audit:** onboarding audit (§6), consent history (TW-2), `sms_message_logs`, the Event inbox.

---

## 10. Automated review, alerts and ARIA

- **Error catalog** `src/lib/sms/onboardingErrors.ts` maps Twilio evaluation `results[]`, brand `errors[]` / registration error codes, and campaign error codes (including the granular codes introduced 2026-09-15, e.g. 30917/30925/30883–30885) to:
  - `field` (form field to highlight);
  - `fixable` (owner / platform / not fixable);
  - plain-language owner text;
  - ARIA next-step text.
  - Unknown codes → `exception` + platform alert.
- **Branded emails** (studio-named shell, to the studio owner): setup submitted; information needed (with a deep link); brand approved; campaign submitted; ready to activate; activated; rejected (not fixable); suspended.
- **Platform alerts** (`platform_alerts` + daily digest): exception, unknown outcome on a fee step, brand IN_REVIEW > 2 business days, campaign pending > 10 business days, suspension, Event Streams signature failures, poll/event disagreement.
- **ARIA:**
  - A deterministic "SMS setup" guidance item on the ARIA Operations page and the tracker, driven by `state` + the error catalog (no LLM required).
  - A knowledgebase article "Turning on texting for your studio" (timeline, costs, what each status means, how to fix common rejections, opt-in requirements).
  - ARIA never submits or edits registration data itself.

---

## 11. Billing and operating costs (no purchases made)

Twilio list prices (US, as published Oct 2026; A2P fees from Twilio support snippets; **verify before pricing**):

| Item | LVS tier | Standard tier |
|---|---|---|
| Brand (one-time) | $4.50 | $46 (incl. $41.50 secondary vetting) |
| Campaign vetting (one-time, non-refundable) | $15 | $15 |
| Campaign monthly | $1.50 | $10 (MIXED) |
| Local number monthly | $1.15 | $1.15 |
| SMS per segment (out/in) | $0.0083 + carrier fees (~$0.0035–0.005 out) | same |
| Failed-message fee | $0.001 | $0.001 |
| Re-vetting / appeal / Authentication+ | n/a | $11 / $12.50 (public cos only) |

Per studio: LVS setup ≈ **$19.50**, then ≈ **$2.65/mo** + usage. Standard setup ≈ **$61**, then ≈ **$11.15/mo** + usage. A campaign delete + recreate costs another $15.

**Proposed SaaS packaging (decision #8 / Phase 22; amounts not set):**
- "Texting" add-on (or plan feature) gates onboarding.
- One-time setup fee covering brand + vetting (non-refundable once submitted).
- Monthly fee covering number + campaign.
- Included segment allowance with metered overage via `usage_events` (`sms_segment`).
- Pilot studios get a platform-granted comp entitlement.
- Cancellation releases the number (after a grace period) and deletes the campaign to stop monthly fees.

---

## 12. Launch gates (SMS can't turn on prematurely)

Sending requires **all** of:
1. Global kill switch `DANCEFLOW_SMS_STATUS=approved` (unchanged; env + redeploy).
2. Studio entitlement active.
3. `studio_sms_registrations.registration_status='approved'`, which the DB constraint allows only with all SIDs, brand approved, campaign approved, use case set, sender present, **number registered** (new), plus `twilio_account_sid` if F2.
4. **Aggregate `approved` is set only by:**
   - a **platform-admin "Release" action** during pilot (`pilot_requires_manual_release=true`), and later
   - automatically once ≥ N studios have passed production verification (owner decision).
5. Per-recipient TW-2 consent.
6. Feature flag `sms_isv_onboarding` (per studio allow-list during pilot). Onboarding UI is hidden otherwise.

Fee steps additionally need gates §7. DEV/preview environments **never** call Trust Hub/A2P create endpoints (§15).

---

## 13. ConfiDance pilot (real in-app flow)

1. Twilio answers F1–F4 questions; the owner decides.
2. Ship 4A–4E to PROD behind the flag; enable only for ConfiDance; grant comp entitlement.
3. **ConfiDance's owner** completes Settings → Texting in production (DanceFlow owner observes; does not enter data for them, beyond helping locate the EIN letter).
4. Orchestrator creates S1–T3, B1. Observe events and polls. Any needs_info is fixed through the UI.
5. Before C1: export the generated campaign package from the platform console and send it to Twilio (#29647095) for pre-submission review, as promised. C1 is held by a pilot-only "campaign hold" until the review is clean.
6. M1, C1, N1–N3 run. Campaign and number approval arrive via events.
7. Platform Release → `approved` → `DANCEFLOW_SMS_STATUS=approved` (env) → owner activates.
8. Bounded PROD verification (TW-OPS step 9):
   - one appointment confirmation to a consented test recipient;
   - status callback;
   - STOP → blocked;
   - START → restored per TW-2;
   - HELP reply per opt-out mode.
9. Retrospective, then open to a second studio.

The pass-1 TW-OPS package (description, samples, opt-in trace) becomes template v1 content.

---

## 14. Implementation inventory

**Migrations** (each with rollback + SQL tests, DEV first):
1. `tw4a_sms_onboarding`: `studio_sms_onboarding`, `studio_sms_provisioning_steps`, `studio_sms_onboarding_audit`, RPCs `save_sms_onboarding_draft`, `submit_sms_onboarding`, `get_studio_sms_status`, RLS/grants.
2. `tw4b_twilio_event_inbox` + registration column extensions + enum `low_volume_mixed` + extended approved invariant + unique indexes on BN/BU/trust-product.
3. (if F2) `twilio_account_sid` invariants.

**Server modules:**
- `src/lib/sms/provider/twilioIsv.ts` (typed adapter; the only module calling Trust Hub/A2P/Services/Numbers/Events; injectable fake).
- `src/lib/sms/onboarding/{stateMachine,steps,orchestrator,reconcile,templates,errors,validation}.ts`.

**Routes:**
- `POST /api/cron/sms-onboarding` (cron secret).
- `POST /api/sms/twilio/events` (Event Streams; signature).
- Server actions under `/app/settings/sms` (owner).
- `/platform/sms` console actions (platform admin): re-sync, adopt, resolve, release, hold/unhold campaign.

**Public pages:** `/studios/[slug]/sms-terms`, `/studios/[slug]/sms-privacy` (generated, versioned).

**Emails:** 8 templates in the branded shell (§10).

**Permissions:**
- Onboarding write: `studio_owner` only.
- Status read: owner/admin (front_desk sees "Texting is on/off" only).
- Console: platform admin.
- Cron/webhook: service role.

**Credentials:**
- New restricted **API Key** (SK…) for REST provisioning, stored only as env secrets.
- The auth token is kept solely for webhook signature validation.
- No credentials in the DB (EIN encryption key in env/Vault; see §17 D6).

**One-time platform setup (scripted, owner-approved run):** Event Streams sink + subscription; ISV compliance mailbox.

---

## 15. Developer-owned QA matrix (functional QA owned by engineering; BLOCKED ≠ PASSED)

**Test environments:**
- Unit/integration against a **fake Twilio adapter** (recorded response fixtures incl. errors, 429, timeouts).
- DEV E2E against the fake.
- Optional real-API smoke limited to **GET** calls and `Mock=true` brand creation in a non-PROD-billed context. *Verify that mock brands are free and never reach TCR.*
- No real Secondary profile is ever submitted from DEV.

| # | Area | Cases |
|---|---|---|
| Q1 | Form & validation | prefill from studio settings; legal name ≠ display name; EIN format; entity/industry/job enums; free-mail rep email warning; PO box; website liveness check; autosave/resume; sole-prop exit |
| Q2 | Permissions | owner can edit; admin/front_desk read-only; other studio's owner denied (RPC + direct table); anon denied; platform admin can't read EIN ciphertext |
| Q3 | State machine | every transition in §4; illegal transitions rejected; cancel before fee step; resubmission bumps seq |
| Q4 | Orchestrator idempotency | crash after Twilio success before persist → reconcile adopts SID (each step); double cron tick + lease; duplicate events; out-of-order events; 429/5xx retry; fee-step ambiguous outcome → exception, never duplicate create |
| Q5 | Error mapping | noncompliant evaluation results → field errors; brand FAILED (fixable/unfixable); 3-resubmit limit; campaign FAILED codes (30917/30925/30883–5); unknown code → exception |
| Q6 | Event Streams | valid signature; invalid/missing signature 403; dedupe; unknown SID; batch array; 5s response; all 15 types mapped |
| Q7 | Tenant isolation | events/webhooks for studio A never mutate B; unique SIDs; subaccount mismatch (F2) |
| Q8 | Readiness gate | approved impossible without each invariant (DB tests); release action required in pilot; global kill switch; entitlement removal blocks send; suspended poll → blocked |
| Q9 | Sending regression | existing A2P-1/2, TW-1/2/3 suites green; opt-out mode B: no duplicate replies; HELP reply text; STOP lock; START restore |
| Q10 | Templates | samples equal dispatcher output (existing pin); per-studio Terms/Privacy pages render with required statements; no reminder/marketing language |
| Q11 | Notifications & ARIA | each email fires once per transition, studio-branded, to owner only; platform alerts; ARIA guidance per state |
| Q12 | Billing | fee steps blocked without entitlement; comp entitlement path; segment metering |
| Q13 | Security | no SIDs in studio payloads/HTML; no PII in logs/audit/inbox; API key scope; CSRF on actions |
| Q14 | PROD pilot verification | §13 step 8, recorded in the TW-OPS checklist |

---

## 16. Slices, rollout and roadmap placement

**Phase 2 — Twilio A2P / SMS, new lane TW-4 — ISV Studio Registration Provisioning** (PROPOSED). It replaces "manual Console" TW-OPS steps 1–2; TW-OPS resumes at pre-submission review/verification.

| Slice | Scope | Twilio writes | Model |
|---|---|---|---|
| 4A | Schema, owner wizard (draft/validate/attest), status RPC, flag, per-studio SMS Terms/Privacy pages | none | Opus (schema/RLS) |
| 4B | Twilio ISV adapter (fake + real), restricted API key, Event Streams endpoint + inbox, poller, read-only re-sync | none (GET only); platform sink setup script | Opus (security) |
| 4C | Orchestrator S1–T3 + B1, fee gates, reconcile, error catalog | yes (behind flag) | Opus |
| 4D | M1 (+opt-out mode), C0–C1 (campaign hold), N1–N3, number registration | yes | Opus |
| 4E | Readiness/release action, emails, platform alerts, ARIA guidance + KB, tracker polish | none | Sonnet |
| 4F | ConfiDance pilot + PROD verification (TW-OPS) | yes (pilot only) | ops |
| later | Sole proprietor path; Standard↔LVS upgrade; Marketing SMS campaign (Phase 13); auto-release; Compliance Embeddable re-evaluation | — | — |

**Dependencies:** owner decisions D1–D6 (§17); Twilio answers; open decision #8 only for *general* availability (pilot uses comp entitlement). TW-4 doesn't block Phase 10, and PAY-WH-1 and Phase 10 continue first. Roadmap and Current State are updated only when the owner approves this design (as v2.22: Phase 2 objective → automated self-service onboarding, superseded locked decisions recorded).

---

## 17. Explicit limitations and decisions

**Cannot be automated via API (per Twilio docs):**
1. Advanced Opt-Out enablement/custom replies: Console-only, irreversible (F1).
2. Campaign edits after submission: Private Beta (else delete + recreate, new fee).
3. Per-number registration status: Event Streams only.
4. Brand resubmissions beyond 3, appeals, re-vetting, deleting SUSPENDED campaigns, >5 campaigns/brand: Twilio Support.
5. Sole Proprietor OTP depends on the owner replying from their mobile.
6. Compliance Embeddable: beta access + feature flag.
7. Legal identity (EIN letter accuracy) and authorization attestation: studio owner.
8. Business review timing: Twilio/TCR (minutes to weeks).

**Owner decisions requested:**
- **D1** Opt-out authority: adopt "platform-managed default opt-out (B) with AOO where Twilio enables it", superseding the TW-1 locked decision?
- **D2** Account architecture: subaccount-per-studio (recommended, pending Twilio confirmation) vs current single account?
- **D3** Per-studio SMS Terms/Privacy pages on idanceflow.com and the website-domain approach?
- **D4** Default tier LVS + `LOW_VOLUME` (recommended) vs Standard + `MIXED`; extend TW-3 enum?
- **D5** Pilot release model: manual platform Release before aggregate approved (recommended)?
- **D6** EIN storage: encrypted with an env-held key + last4 for display (recommended), or not retained after Twilio accepts the profile?
- **D7** SMS packaging/pricing direction for decision #8 (setup fee + monthly + metered).

**Questions to send Twilio (#29647095):**
- Can AOO be enabled/configured per Messaging Service by API or account-level default for ISVs? If not, is Twilio default opt-out handling acceptable for the campaigns, and what is the default HELP behavior?
- Do you recommend subaccount-per-studio for our ISV case? Confirm that parent-credential A2P registration works in subaccounts and how webhook signatures are computed there.
- Are DanceFlow-hosted, studio-scoped Terms/Privacy pages acceptable when the studio's website is a different domain?
- Is Low-Volume Standard + `LOW_VOLUME` appropriate for ConfiDance-type traffic, given the earlier Mixed/Customer Care guidance?
- Please enable campaign-update API (Private Beta) for our account.

---

## 18. Owner decisions (2026-10-12) and updated architecture recommendations

| # | Decision | Status |
|---|---|---|
| D1 | Twilio default STOP/START blocking + DanceFlow consent/suppression enforcement; validate HELP; no duplicate replies | ADOPTED (validate with Twilio Q2) |
| D2 | One Twilio subaccount per studio (preferred ISV architecture) | ADOPTED, subject to confirming registration, webhook signing, lifecycle (Q1) |
| D3 | Studio-specific SMS Privacy and Terms pages | ADOPTED; final domain design HELD (Q3) |
| D4 | Low-Volume Standard default for eligible studios, correct alternatives where applicable | ADOPTED (Q4) |
| D5 | Manual platform approval for the ConfiDance pilot only; automated activation afterwards | ADOPTED |
| D6 | Minimize EIN retention; encrypt any retained value; display last 4 only | ADOPTED |
| D7 | Setup fee + monthly service fee + message allowance/overage; no final prices until Twilio costs are verified | ADOPTED (direction only) |

### 18.1 D1: opt-out model
- Each registration gets `opt_out_mode` (`twilio_default` | `twilio_advanced`). Automated studios start at `twilio_default`. `twilio_advanced` is kept only for studios where Twilio enables AOO.
- **STOP/START in `twilio_default`:**
  - Twilio blocks or unblocks and sends its own confirmation.
  - DanceFlow **records only**: the TW-1 fallback classification, then the TW-2 `apply` RPC.
  - DanceFlow returns empty TwiML, so it sends no second reply.
- **HELP in `twilio_default`:** DanceFlow replies with the studio-named HELP text **only if** Twilio confirms it does not reply to HELP under default handling (Q2). Otherwise it records only. The reply must never duplicate Twilio's.
- **Suppression enforcement:**
  - The app keeps pre-send blocking through `resolveEffectiveSmsConsent`.
  - New: a Twilio send error **21610** (recipient opted out at Twilio) marks the log `suppressed` with a sanitized reason and raises a platform alert. It never retries automatically.
  - *Proposal needing TW-2-level (Opus) review:* also record a studio+phone-level opt-out with a distinct source (e.g. `twilio_send_blocked`). It must never weaken the consumer-STOP lock, and it must be liftable only by consumer START.
- **Campaign fields:** supply `OptOut*`/`Help*` text matching actual behavior, or omit and let Twilio fill them, per Twilio's answer to Q2.

### 18.2 D2: subaccount per studio (engineering consequences)
- **Provisioning:** new first step P2 creates a subaccount `df:{env}:{studio_id}`. All A2P resources (Secondary profile, TrustProduct, brand, Messaging Service, campaign, number) are created **inside the subaccount**, using parent credentials scoped by the subaccount SID. The parent's ISV primary profile is assigned into each Secondary profile. *Confirm cross-account assignment (Q1).*
- **Sending:** `sendTwilioSms` today hard-codes `Accounts/{TWILIO_ACCOUNT_SID}/Messages.json`. It must post to `Accounts/{registration.twilio_account_sid}/Messages.json`, and `resolveStudioSmsSender` must return `twilioAccountSid`. A null account SID is allowed only for `provisioned_by='manual'` legacy rows.
- **Webhook signatures:** `verifyTwilioWebhook` validates only against the parent `TWILIO_AUTH_TOKEN`. Requests for subaccount-owned numbers and services are expected to be signed with the **subaccount's** auth token *(confirm, Q1)*. Design:
  - Read `AccountSid` from the signed params.
  - Accept only a subaccount SID registered to exactly one studio.
  - Obtain that subaccount's token at runtime through the parent API, with an in-memory cache and short TTL. It is **never stored in the DB**.
  - Validate, then require `AccountSid` + MG/To to agree with the same studio.
  - This is security-critical (Opus review).
- **Event Streams:** decide between one parent-level sink receiving subaccount A2P events and a sink per subaccount (Q5). Events must carry or resolve `AccountSid`, and it must match the registration.
- **Lifecycle:**
  - Studio cancels: hold → delete campaign (stops monthly fee) → release number → suspend subaccount → close after grace.
  - Subaccount closure is permanent, so it is gated behind platform confirmation *(confirm brand/number/opt-out consequences, Q1)*.
  - A studio past due: suspend sending in-app first (entitlement gate), not the Twilio subaccount.
- **Opt-outs:** Twilio-held opt-outs become per-studio, matching TW-2's per-studio STOP scope.
- **Cost attribution:** per-subaccount usage records give verified per-studio Twilio cost (feeds D7).
- **Existing PROD data:** no `studio_sms_registrations` rows exist in PROD (as of TW-3 release). Nothing needs migrating. The old shared campaign in the parent account stays unused.

### 18.3 D3: legal pages
4A builds `/studios/{slug}/sms-privacy` and `/studios/{slug}/sms-terms`, generated from versioned DanceFlow templates. They contain:
- the studio legal and display names;
- the DanceFlow/GenX ISV statement;
- the CTIA/TCR mobile-data non-sharing statement;
- frequency, "Msg & data rates may apply", STOP/HELP;
- consent is optional;
- support contacts.

Brand `website_url` and campaign URL domains stay HELD until Q3 is answered. 4C/4D can't submit for a studio with an independent website until then.

### 18.4 D4: tier selection rules (deterministic, shown to the platform console, not chosen by the studio)

| Studio situation | Brand | Campaign use case |
|---|---|---|
| Private/for-profit or non-profit with EIN, expected < ~2,000 T-Mobile segments/day | Low-Volume Standard (`SkipAutomaticSecVet=true`) | `LOW_VOLUME` |
| High volume / multi-location / needs higher throughput | Standard (secondary vetting) | `MIXED` (or `CUSTOMER_CARE` if Twilio advises) |
| No EIN (sole proprietor) | Sole Proprietor (later slice; not v1) | `SOLE_PROPRIETOR` |
| Publicly traded | Standard + Authentication+ | `MIXED` (exceptional; platform review) |

- The final use case is always taken from the `Usecases` endpoint for that brand.
- If the expected value isn't offered, the onboarding stops and goes to `exception`.
- TW-3's `campaign_use_case` enum is extended (`low_volume_mixed`, later others). The approved invariant accepts any registered transactional use case, never `MARKETING`.

### 18.5 D5: activation
- **Pilot (ConfiDance):**
  - A platform-admin **Release** sets aggregate `approved`.
  - A pilot-only **campaign hold** before campaign creation (C1) allows Twilio's pre-submission review.
  - `DANCEFLOW_SMS_STATUS=approved` is a deliberate environment change.
- **After the pilot** (owner sign-off on the pilot retrospective): the orchestrator sets `approved` automatically when all of these hold:
  - all DB invariants;
  - number registered;
  - entitlement active;
  - no open exception;
  - a GET re-verification of brand, campaign and number at activation time.

  The owner then clicks Activate. A per-studio "require manual release" override stays available.

### 18.6 D6: EIN lifecycle
1. Entered in the wizard.
2. Stored only as `ein_ciphertext` (AES-GCM, key in an env secret, never in the DB) plus `ein_last4`.
3. Decrypted only inside the orchestrator step that creates or updates the Twilio EndUser.
4. Ciphertext **purged** when the Secondary profile reaches `twilio-approved` *and* the brand is `APPROVED`, or 30 days after a terminal state (cancelled/blocked).
5. If a later fix needs it (needs_info on a tax-ID error), the owner re-enters it.

Throughout: never logged, never in audit, never returned to any client (owner or platform admin) beyond the last 4 digits. The value Twilio holds remains the system of record.

### 18.7 D7: commercial model (direction only)
- Entitlement `sms_messaging` covers the setup fee (brand + vetting pass-through + onboarding), the monthly service (number + campaign + platform), and an included segment allowance with metered overage (`usage_events: sms_segment`).
- Final prices wait for verified costs: the pilot's actual Twilio invoice lines and per-subaccount usage records over at least one full billing cycle, checked against the published list prices in §11.
- This resolves the **direction** of open decision #8 for SMS. Amounts stay with Phase 22.
- The ConfiDance pilot uses a platform comp entitlement; no billing action is taken.

### 18.8 Revised slice plan

| Slice | Scope (changes from §16 in bold) | Gated on |
|---|---|---|
| 4A | Schema, owner wizard, status RPC, flag, **per-studio SMS legal pages (template; domain held)**, **EIN encryption/purge** | owner approval to implement |
| 4B | **Subaccount-aware Twilio client (send + provisioning), per-AccountSid webhook signature validation**, Event Streams endpoint/inbox, poller, **TW-1 `opt_out_mode` amendment**, **21610 suppression handling** | Twilio Q1, Q2, Q5; Opus security review |
| 4C | **P2 subaccount** + S1–T3 + B1, fee gates, reconcile, error catalog, **tier selection** | Q1, Q4 |
| 4D | M1, C0–C1 (pilot hold), N1–N3 | Q2, Q3 |
| 4E | Release/auto-activation, emails, alerts, ARIA, KB | — |
| 4F | ConfiDance pilot + PROD verification (TW-OPS) | all above |
| 4G | **Entitlement + billing wiring (D7)** | PAY-WH-1 released; decision #8 amounts |

---

## 19. Reconciliation with TW-1, TW-2, TW-3 and the canonical roadmap

### TW-1 (Advanced Opt-Out alignment; released)
- **Superseded locked decision:** "Twilio Advanced Opt-Out is the compliance response authority" becomes "Twilio opt-out enforcement (default handling, or AOO where Twilio enables it) is authoritative; DanceFlow records and enforces suppression and never duplicates Twilio replies."
- **Code impact (4B):**
  - `inboundKeywords.ts` (header comment says every service *must* have AOO).
  - The inbound route: today, without `OptOutType`, it replies via TwiML to STOP/START/HELP. In `twilio_default` it must stay silent on STOP/START, and on HELP if Twilio replies.
  - `twilioWebhook.ts` (per-account token).
- **Kept:** `OptOutType` precedence when present, whole-message matching, studio scoping, unrouted reply.

### TW-2 (consent integrity; released)
- **Unchanged:**
  - consumer-STOP lock;
  - START restores only prior consent;
  - phone-level rows;
  - append-only history with `danceflow.sms_consent_context`;
  - public opt-in never clears an opt-out;
  - `resolveEffectiveSmsConsent` precedence.
- **Additions** need TW-2-level review: optional `twilio_send_blocked` source from 21610; consent RPC tenant checks extended with `AccountSid` agreement when called from webhooks.
- Twilio-held opt-outs become per-studio subaccount state, consistent with TW-2's per-studio scope. Neither system ever overrides consumer STOP.

### TW-3 (registration metadata; released)
- `studio_sms_registrations` stays the single send-time authority, one row per studio.
- **Additions:**
  - `twilio_account_sid`, `trust_product_sid`, `address_sid`, `brand_tier`/`brand_type`/`brand_identity_status`;
  - error-code arrays, `number_registration_status`, `opt_out_mode`, `provisioned_by`, `last_synced_at`;
  - enum `low_volume_mixed`;
  - approved invariant + `number_registration_status='registered'` (+ `twilio_account_sid` for automated rows);
  - unique indexes on BN/BU/trust product/account SID.
- `/platform/sms` becomes an operations console. Manual SID editing is limited to `provisioned_by='manual'`.
- The TW-3 rollback contract (refuse if data) is preserved, and each new migration gets its own rollback.

### Canonical roadmap v2.21 (no edit made; proposed for v2.22 after Twilio answers and owner implementation approval)
- **Phase 2:**
  - The objective becomes "automated self-service studio onboarding under the DanceFlow ISV profile, subaccount per studio". The primary profile is now ISV Reseller or Partner (ticket #29647095).
  - TW-4 is added as PROPOSED, with slices 4A–4G.
  - Superseded locked decisions are recorded:
    - AOO authority (D1);
    - single account / no subaccounts (D2);
    - manual Console provisioning;
    - `mixed`-only use case (D4).
  - The TW-OPS deliverables are re-sequenced: steps 1–2 (resource identification/manual population) are replaced by in-app onboarding; pre-submission review, submission and production verification remain.
  - The pass-1 TW-OPS package becomes campaign template v1 (minus "reminder").
- **Stale v2.21 text to correct at the same time:**
  - Phase 2 still lists TW-2 as "not yet merged"; it was released in PR #199.
  - Header and Current State still show main `67e735c` and `dpl_C5TYuEwJ…`, and the Phase 10 next slice as 10A. Main is now `733a20c0`, and Phase 10 has advanced through 10D.1/10C.5 plus the CI-A releases.
- **Phase 4:** decision #8, SMS direction recorded per D7; amounts remain open.
- **Phase 11:** add 21610 suppression handling and Event Streams as part of the SMS platform.
- **Phase 13:** unchanged. Marketing SMS stays out of scope and would need its own `MARKETING` campaign and separate marketing consent.
- **Phase 22:** SMS prices follow verified pilot costs.
- **Current State:** external dependency is Twilio answers on #29647095 (Q1–Q5); TW-4 is design-approved for planning only.

### PAY-WH-1 isolation
- TW-4 shares no files with the Stripe webhook-ordering work.
- 4A–4F don't touch Stripe routes, billing webhooks or entitlement code. Billing wiring is deferred to 4G, after PAY-WH-1 is released.
- TW-4 work happens in its own worktree from a fresh main, with migration timestamps coordinated at release.
- No TW-4 activity is authorized now.

---

## 20. Twilio Support message (ticket #29647095), DRAFT, not sent

> **Subject:** DanceFlow ISV – architecture confirmation before automated studio onboarding (ConfiDance pilot)
>
> Hello Sachin / A2P 10DLC team,
>
> Thank you for updating our Primary Customer Profile (GenX TotalTech LLC, BUed777b1ed81df271793fbd097324ec94) to ISV Reseller or Partner. We are now designing DanceFlow's automated, API-based onboarding so each dance studio registers through our platform rather than through manual Console setup. ConfiDance Studio will be the first studio. Studio traffic is limited to transactional appointment messages (confirmations, reschedules, cancellations) and staff-initiated one-to-one operational messages, with no marketing. Before we build, we'd appreciate confirmation on five points:
>
> **1. Subaccount per studio.** Following your ISV architecture guidance, we plan one Twilio subaccount per studio, with the studio's Secondary Customer Profile, A2P TrustProduct, Brand, Messaging Service, campaign and number created inside that subaccount by our parent account via API.
>   (a) Is this the architecture you recommend for us?
>   (b) Can our parent-account Primary ISV profile be assigned to Secondary Customer Profiles created inside the subaccounts, and should those Trust Hub and A2P calls be made with parent credentials scoped to the subaccount?
>   (c) For inbound-message and status-callback webhooks on subaccount numbers and services, are requests signed with the subaccount's auth token? Is there a recommended way for an ISV to validate them without storing each subaccount's token?
>   (d) When a studio leaves, what happens to its brand, campaign, numbers and opt-out records if we delete the campaign, release the numbers, and suspend or close the subaccount? Does any of this affect the parent account or other subaccounts?
>
> **2. Opt-out handling without Advanced Opt-Out.** Advanced Opt-Out appears to be Console-only. Can it be enabled or configured per Messaging Service by API, or set as an account-level default for ISV subaccounts? If not, we plan to use Twilio's default opt-out handling, with our platform also recording opt-outs and blocking sends.
>   (a) Is default handling acceptable for campaign approval?
>   (b) Under default handling, does Twilio reply to HELP/INFO, and are STOP/START/HELP messages still delivered to our inbound webhook?
>   (c) Should the campaign's OptOut/Help message and keyword fields be supplied with our exact wording, or omitted?
>
> **3. Privacy Policy and Terms domain.** We plan studio-specific SMS Privacy Policy and Terms pages hosted by DanceFlow (e.g. `https://www.idanceflow.com/studios/{studio}/sms-privacy` and `/sms-terms`). They name the studio and DanceFlow's ISV role and include the mobile-data non-sharing statement. Many studios have their own independent website on a different domain.
>   (a) Given the requirement that Terms be on the same domain as the business website, are these DanceFlow-hosted, studio-scoped pages acceptable for those studios?
>   (b) Or should the brand website be the studio's DanceFlow page, or should the pages live on the studio's own domain?
>
> **4. Brand tier and use case.** Studios send low volumes. We intend Low-Volume Standard brands (skip automatic secondary vetting) with the LOW_VOLUME (Low Volume Mixed) use case by default, and Standard + MIXED only for higher-volume studios.
>   (a) Is LOW_VOLUME appropriate for this transactional and one-to-one traffic, given your earlier Mixed / Customer Care guidance?
>   (b) What is the upgrade path if a studio outgrows it?
>   (c) Which business_industry value do you recommend for dance studios (EDUCATION or CONSUMER)?
>
> **5. Account enablement and status events.**
>   (a) Please enable, or tell us how to request, the campaign update API (Private Beta) for our parent account and its subaccounts.
>   (b) For Event Streams A2P events (brand, campaign, number registration), should we create one sink and subscription in the parent account that receives subaccount events, or one per subaccount?
>   (c) Should the Secondary profile and TrustProduct notification email be our own ISV compliance mailbox?
>   (d) Will you review the first automatically generated ConfiDance campaign package before we submit it?
>
> We will not create any studio registrations until you confirm. Thank you,
> Michael Curtis — GenX TotalTech LLC / DanceFlow

---

## Sources (Twilio, retrieved 2026-10-12)
- ISV overview (architectures): https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv
- ISV API guide: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
- Business info fields: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info
- Customer Profiles: https://www.twilio.com/docs/trust-hub/trusthub-rest-api/customer-profiles
- Brand Registration resource: https://www.twilio.com/docs/messaging/api/brand-registration-resource
- Brand troubleshooting/resubmission: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-standardlvs-brands
- Sole Proprietor ISV API: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new
- Messaging Service resource: https://www.twilio.com/docs/messaging/api/service-resource
- Advanced Opt-Out: https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
- UsAppToPerson resource: https://www.twilio.com/docs/messaging/api/usapptoperson-resource
- Campaign troubleshooting/updates: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-campaigns
- Privacy/Terms URL requirement: https://www.twilio.com/en-us/changelog/a2p-10dlc-campaign-registration-will-require-privacy-policy-and-
- New registration error codes: https://www.twilio.com/en-us/changelog/new-error-codes-provide-clearer-tfv-and-a2p-10dlc-registration-f
- Available numbers: https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource
- Incoming numbers: https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource
- Messaging Service PhoneNumber: https://www.twilio.com/docs/messaging/api/phonenumber-resource
- Number registration troubleshooting: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-a2p-phone-number-registration-issues
- Event Streams for A2P: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/event-streams-setup
- Event delivery/duplication: https://www.twilio.com/docs/events/event-delivery-and-duplication
- Compliance Embeddable: https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/compliance-embeddable-onboarding and https://www.twilio.com/en-us/changelog/compliance-embeddable-USA2P10DLC-beta
- US SMS pricing: https://www.twilio.com/en-us/sms/pricing/us
- Rate limiting (20429): https://www.twilio.com/docs/api/errors/20429
