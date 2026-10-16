# ConfiDance A2P registration: Q1–Q5 disposition, final package, and the shortest approved submission path

Status 2026-10-15. Analysis and drafts only. **Nothing was sent to Twilio, submitted, provisioned, purchased or changed; no code, commit, deploy or migration was made for this document.** Twilio facts below come from Twilio's public documentation read today (URLs in section 6) and from the approved TW-4 design; anything the documentation did not state is marked "not verified".

Inputs read: `TW-4_ISV_SMS_Onboarding_Design.md` (§0–§3, §7, §9, §11, §16–§18, §20), `TW-4A_Registration_Readiness.md`, `DanceFlow_Master_Roadmap.md` Phase 2, `DanceFlow_Current_State.md` Twilio status, the TW-4A code and schema.

---

## 1. Q1–Q5: exact wording and disposition

Principle: a question is a blocker only if ConfiDance's **first registration submission** cannot proceed without its answer. The roadmap already records Twilio's controlling guidance (Sachin Singh, 2026-10-06): *"not a Twilio architecture blocker"*, studio campaigns under the existing GenX TotalTech LLC / DanceFlow Twilio account, Mixed or Customer Care typically appropriate, and the ConfiDance opt-in flow "appears aligned".

| Q | Exact wording (design §20) | Needed for ConfiDance's first registration? | What already resolves it | Precise remaining uncertainty | Disposition |
|---|---|---|---|---|---|
| **Q1** Subaccount per studio | (a) recommend it? (b) can the parent Primary ISV profile be assigned to Secondary profiles created in subaccounts, with parent credentials scoped to the subaccount? (c) are subaccount webhooks signed with the subaccount auth token, and how to validate without storing each token? (d) what happens to brand/campaign/numbers/opt-outs when a studio leaves? | **No, if the pilot uses the parent account. Yes, only if it uses a subaccount.** | Twilio's ISV overview (read today) lists the architectures: #1 subaccount per customer is "preferred"; **#4 "no subaccounts, Messaging Services per customer under the primary Account" is allowed**, with a stated risk that one customer's non-compliant traffic could force suspension of the primary account. Our current sending, inbound and status code is parent-account only and works for #4 unchanged. Twilio's own 2026-10-06 guidance was parent-account. | Under #1: whether the Primary profile can be assigned across accounts (1b) is **not stated** in the pages read; 1c is not covered by the pages read (general Twilio webhook docs say the receiving account's token signs, not verified here); 1d "removing a customer" is not covered. | **Not a blocker for ConfiDance under #4.** Decision for the owner: pilot in the parent account (below). Q1 stays open for scaling. |
| **Q2** Opt-out without AOO | (a) default handling acceptable for approval? (b) under default handling does Twilio reply to HELP/INFO, and are STOP/START/HELP still delivered to our webhook? (c) supply OptOut/Help wording or omit? | **No.** | Twilio's UsAppToPerson docs: OptOut*/Help* fields are only *conditionally* required "if you manage these yourself rather than using Twilio's default or advanced opt-out"; we may omit them. Advanced Opt-Out is documented as Console-only (a one-time Console step on ConfiDance's Messaging Service). TW-1 (released) already runs AOO-based handling and falls back to its own keyword classification and TwiML reply when `OptOutType` is absent. Twilio's AOO page lists default STOP keywords (STOP, UNSUBSCRIBE, END, QUIT, STOPALL, REVOKE, OPTOUT, CANCEL) and does **not** state default HELP behavior. | HELP/INFO reply under default handling, and webhook delivery of STOP under default handling: not stated. Only matters if we want **zero** Console steps (the D1 `twilio_default` mode, which needs a small TW-1 amendment). | **Not a blocker.** For ConfiDance enable Advanced Opt-Out on its Messaging Service in the Console once (existing, released TW-1 behavior). `twilio_default` mode (and Q2b) is for scaling. |
| **Q3** Privacy/Terms domain | (a) are DanceFlow-hosted studio-scoped pages acceptable when the studio's website is a different domain? (b) or use the studio's DanceFlow page as the website, or the studio's own domain? | **No, by choice of website.** | ConfiDance's public DanceFlow page is live and was reviewed by Twilio: `https://www.idanceflow.com/studios/confidance-studio` (opt-in `#lead` verified). If the brand `website_url` is that page, Terms/Privacy on the same domain (`idanceflow.com/studios/confidance-studio/sms-terms`, `/sms-privacy`) satisfy the same-domain rule the design cites. | Only studios with an independent website domain. | **Resolved for ConfiDance** by using the DanceFlow studio page as its website. Q3 stays open for other studios. Note: the per-studio SMS Terms/Privacy pages are 4A code and must be **live on PROD** before a campaign can cite them (section 5). |
| **Q4** Tier/use case | (a) is LOW_VOLUME appropriate for this traffic given earlier Mixed/Customer Care guidance? (b) upgrade path? (c) EDUCATION or CONSUMER for dance studios? | **(a) only as a choice between two options; (b) no; (c) minor.** | Twilio already said **Mixed or Customer Care** is appropriate; TW-3 already allows `mixed`; Standard brand + MIXED needs no enum change and no new Twilio answer. Twilio's docs list LOW_VOLUME ("Low Volume Mixed") and say `SkipAutomaticSecVet` is for Low-Volume Standard brands. | Whether Twilio accepts LOW_VOLUME for this traffic (4a); which industry value to use (4c). | **Owner picks** (recommendation below): Standard + MIXED removes the uncertainty at a higher cost. Q4a is blocking only if the owner chooses LVS. |
| **Q5** Enablement and events | (a) enable campaign update API (Private Beta)? (b) Event Streams sink: parent or per-subaccount? (c) should Secondary profile/TrustProduct email be our ISV compliance mailbox? (d) will you review the generated ConfiDance package before submission? | **No** for (a), (b), (d); **(c) is an owner action, not a question.** | (a) editing a submitted campaign is optional (delete+recreate works, $15). (b) Event Streams are needed for per-number registration status, which has no REST endpoint; the Console shows it, so submission does not depend on it. (c) Twilio's ISV API guide (read today, §2.1) says the TrustProduct email should be "your (the ISV's) email address, **not the customer's**." (d) The roadmap already records Twilio's offer of a pre-submission review of the package. | None for first submission. | **Not blockers.** (c): the owner names/creates the ISV compliance mailbox. (d) is a process step: send the finalized package (section 2) to the ticket before campaign submission. |

**Result:** none of Q1–Q5 blocks ConfiDance's first submission provided the owner makes the two choices in section 3 (parent-account pilot; Standard + MIXED). Sending Q1–Q5 to Twilio remains useful for scaling to the second studio, but it does not gate ConfiDance.

---

## 2. Final ConfiDance registration package (in the shape of the Twilio API calls)

Confirmed values are stated; everything else is a labelled placeholder. Nothing below is an approval or an existing SID. Field names are from Twilio's ISV API guide / resource pages read today; where a name is from the design only it is marked (design).

### 2.1 Confirmed (reused, not invented)
- ISV Primary Customer Profile: `BUed777b1ed81df271793fbd097324ec94`, "Twilio Approved, ISV Reseller or Partner" (**owner-reported in the design; the runner must GET it to confirm before anything is created**).
- Studio public page (brand website if the owner chooses the DanceFlow page): `https://www.idanceflow.com/studios/confidance-studio`; opt-in `https://www.idanceflow.com/studios/confidance-studio#lead` (verified live per roadmap).
- Terms `https://www.idanceflow.com/studios/confidance-studio/sms-terms`, Privacy `.../sms-privacy` (generated by TW-4A; **not yet live on PROD**).
- Inbound webhook: `POST https://www.idanceflow.com/api/sms/twilio/inbound`; status callbacks are attached per message by the app.
- Campaign content (DanceFlow template v1, generated; lengths checked against Twilio limits: Description 40–4096 → **367**; MessageFlow 40–2048 → **1032**; MessageSamples 2–5 of 20–1024 → **264 / 293 / 250 / 166**).

### 2.2 Secondary Customer Profile and A2P TrustProduct (steps S1–S8, T1–T3)
| Twilio object / field | Value |
|---|---|
| CustomerProfile (Secondary) `Email` | `[ISV COMPLIANCE MAILBOX]` (owner; must be DanceFlow's, not ConfiDance's) |
| `business_information` EndUser: `business_name` | `[CONFIDANCE LEGAL NAME]` exactly as on the IRS letter |
| `business_identity` | direct_customer (design; verify at S2 against Twilio's allowed values) |
| `business_type` | `[LLC / Corporation / Partnership / Non-profit / Co-op]` |
| `business_industry` | `[EDUCATION or CONSUMER]` (owner confirms; the wizard offers both) |
| `business_registration_identifier` / `business_registration_number` | `EIN` / `[CONFIDANCE EIN, entered by ConfiDance's owner in the wizard; encrypted; never typed by DanceFlow staff]` |
| `business_regions_of_operation` | `USA_AND_CANADA` or the narrower value Twilio accepts (verify at S2) |
| `website_url` | `https://www.idanceflow.com/studios/confidance-studio` (owner choice; https only) |
| Authorized representative: `first_name`, `last_name`, `business_title`, `job_position`, `email`, `phone_number` | `[REP FIRST]`, `[REP LAST]`, `[TITLE]`, `[director/gm/vp/ceo/cfo/general_counsel/other]`, `[REP BUSINESS EMAIL]`, `[REP MOBILE E.164]` |
| Address: `customer_name`, `street`, `street_secondary`, `city`, `region`, `postal_code`, `iso_country` | `[CONFIDANCE LEGAL NAME]`, `[STREET]` (no PO box), `[SUITE]`, `[CITY]`, `[ST]`, `[ZIP]`, `US` |
| Assign Primary profile to the Secondary profile | `BUed777b…` (EntityAssignment) |
| A2P TrustProduct `Email` | same ISV mailbox |
| `us_a2p_messaging_profile_information` | company type per the entity (private/non-profit), per Twilio's list (verify at T2) |

### 2.3 Brand (B1)
`POST /v1/a2p/BrandRegistrations`: `CustomerProfileBundleSid` = the Secondary profile `BU…`; `A2PProfileBundleSid` = the TrustProduct `BU…`; `BrandType=STANDARD`; **`SkipAutomaticSecVet` omitted for Standard** (set true only for Low-Volume Standard). Fee-bearing. Approval comes later (minutes to 7+ business days per the design); a campaign cannot be created until the brand status is `APPROVED` (Twilio ISV API guide §5: "Do not complete this section until the BrandRegistration's status is APPROVED").

### 2.4 Messaging Service, campaign, number (M1, C1, N1–N3; after brand approval)
- Messaging Service: `InboundRequestUrl=https://www.idanceflow.com/api/sms/twilio/inbound`, `UseInboundWebhookOnNumber=false`, notifications use case (design). **Enable Advanced Opt-Out in the Console on this service (one-time, owner or platform admin).**
- Campaign `POST .../Services/{MG}/Compliance/Usa2p` (`UsAppToPerson`):
  - `BrandRegistrationSid`: `[BN… from B1]`
  - `UsAppToPersonUsecase`: **`MIXED`** (recommended; alternative `CUSTOMER_CARE`; `LOW_VOLUME` only with an LVS brand and Twilio's OK)
  - `Description`: the template description (2.5)
  - `MessageFlow`: the template message flow (2.5)
  - `MessageSamples`: the four samples in `TW-4A_Registration_Readiness.md` §2.2, with `[CONFIDANCE DISPLAY NAME]` filled in
  - `HasEmbeddedLinks=false`, `HasEmbeddedPhone=false`, `SubscriberOptIn=true`, `AgeGated=false`, `DirectLending=false`
  - `PrivacyPolicyUrl`, `TermsAndConditionsUrl`: the two studio URLs above
  - `OptInMessage/OptOutMessage/HelpMessage` and keyword fields: **omit** (Twilio default / Advanced Opt-Out), per the "conditionally required" rule
  - Fee-bearing ($15 vetting plus the monthly fee). Before submitting, send this payload to the ticket for Twilio's pre-submission review (already offered).
- Number: search `AvailablePhoneNumbers/US/Local` by `[AREA CODE]`, purchase (monthly fee), attach to the Messaging Service. Fee-bearing.

### 2.5 Campaign text (generated, `sms_campaign_template` v1)
Description and MessageFlow are exactly the strings in `TW-4A_Registration_Readiness.md` §2.1/§2.3 (placeholders for the display name and slug; the wizard produces the same text from the studio's real values). No reminder sample and no marketing sample exist.

### 2.6 Consent evidence: what exists and what does not
- Exists: the live public opt-in form with the unchecked box and exact `a2p1b-v1` disclosure at `.../confidance-studio#lead` (verified live; Twilio reviewed the flow); consent records store source, time and a note carrying `disclosure=a2p1b-v1;form=…` (no IP or user agent is stored; do not claim it).
- **Not captured (I have not made it up):** a dated screenshot of the live form and a redacted sample consent record from PROD. Both need PROD access I was not given; the owner or an authorized read-only PROD pull supplies them.

---

## 3. Decisions only the owner can make (blocking the start of the build)
1. **Pilot account architecture.** *Recommended:* register ConfiDance in the **parent account** (Twilio architecture #4, allowed by Twilio, matches Twilio's own 2026-10-06 guidance and needs **no** change to sending, inbound or status code). This is a **pilot-scoped exception to D2 (subaccount per studio)**, which was adopted "subject to Q1"; Q1b is genuinely unanswered, so D2 cannot be built for ConfiDance without waiting for Twilio. Documented cost of the exception: one customer's non-compliant traffic could affect the whole parent account (ConfiDance is the only studio), and moving ConfiDance to a subaccount later means re-registering its brand and campaign. Alternative: subaccount now = wait for Q1b/1c and build the 4B subaccount-aware send and webhook-signature work (an Opus security review item) before ConfiDance can even send.
2. **Tier and use case.** *Recommended:* **Standard brand + `MIXED`** (about $61 one-time and about $11.15/month plus number and usage, per design §11; exactly what Twilio's guidance names; no enum migration; secondary vetting adds some review time). Alternative: Low-Volume Standard + `LOW_VOLUME` (about $19.50 one-time, about $2.65/month) which needs Twilio's answer to Q4a and a TW-3 enum migration.
3. **Spend authorization** for the brand, campaign vetting and one number (about $61 + $1.15/month + $10/month at the Standard tier, list prices from the design; to be verified on the invoice).
4. **ISV compliance mailbox** to use as the profile/TrustProduct email.
5. **Industry value** (EDUCATION or CONSUMER) for ConfiDance.

## 4. Shortest approved submission path

**Currently available without new code:** only the Twilio Console plus the existing platform form that records the row afterwards (TW-3). There is no code anywhere that calls Trust Hub, A2P or Messaging-Service APIs. You told me not to reopen the manual-versus-automated decision, so below is the smallest *automated* path; the Console path is mentioned only as the timing baseline.

**Registration submission is not approval and is not activation.** Submission is two Twilio events separated by a wait: (1) profile + TrustProduct + **brand** submitted; (2) after the brand is `APPROVED` (minutes to 7+ business days) the **campaign** is submitted; (3) TCR then approves the campaign (days, sometimes weeks) and the number registers. **Activation** is separate again: the TW-3 row set to `approved` with all identifiers and a registered number, the global `DANCEFLOW_SMS_STATUS` environment flip (affects all studios, fail-closed per studio), and per-recipient consent.

**Indispensable functions (everything else from 4B–4F is deferred):**
| # | Function | From | Why indispensable |
|---|---|---|---|
| 1 | Minimal Twilio adapter in the **parent account**: Trust Hub profile/end-user/address/document/assignment/evaluation/submit, TrustProduct, BrandRegistration create + GET; later Messaging Service, UsAppToPerson, number search/purchase/attach. Deterministic FriendlyNames; fake implementation for tests | 4B (trimmed) | nothing can be submitted without it |
| 2 | Step runner for one onboarding using the existing ledger table: S1–S8, T1–T3, B1, with state transitions (`submitted_for_checks → profile_review → brand_pending`), reconcile-before-retry, **fee-bearing steps never auto-retried and never repeated** | 4C (trimmed) | prevents duplicate paid brands and orphan resources |
| 3 | Service-role database functions for the runner (claim/record step, transition state, decrypt-and-use EIN, purge on brand approval, create the TW-3 row `in_review`) | 4C (trimmed) | the 4A tables deliberately have no API privileges |
| 4 | A platform-admin "advance one step" action with an explicit confirmation on fee steps, plus a GET-only "refresh status" | replaces the cron | no cron, no background spend |
| 5 | After brand approval: Messaging Service, campaign (with the pre-review hold), number purchase and attach | 4D (trimmed) | needed to *submit the campaign*; separate slice because it waits on the brand |

**Not needed for the first submission (explicitly deferred):** subaccounts and per-account webhook validation, Event Streams endpoint and inbox, poller, `twilio_default` opt-out mode and 21610 suppression, owner emails, platform alerts, ARIA, error catalog beyond raw sanitized messages to the platform admin, billing/entitlement wiring, auto-activation, the cron, the campaign-update API, sole proprietor and tier-upgrade paths.

**Proposed bounded slices**
- **R1 "brand submission runner"** (items 1–4 for steps S1–B1): new `src/lib/sms/twilioIsv/` adapter with a fake; runner; one small migration of service-role functions; platform action. No real Twilio call in DEV or tests (design §15: DEV never calls create endpoints); verification is by the fake plus, if authorized, a Twilio `Mock` brand (documented in the BrandRegistration resource) in a controlled run. Done when: a fake-driven run reaches `brand_pending`; killing the process mid-step and rerunning creates nothing twice; the EIN is decrypted only inside the step and never logged; fee steps refuse without the platform confirmation.
- **R2 "campaign and number"** (item 5): after the brand is approved and Twilio's pre-review is clean.
- Then ConfiDance activation: the platform sets the row approved, the global env flip, and the bounded PROD verification (one consented test message, STOP, START, HELP).

## 5. Security review, migration and deployment requirements
- **Security review (targeted, not general):** one Opus review scoped to R1 before it is enabled on PROD: Twilio credential handling (the app holds the master `TWILIO_AUTH_TOKEN`; prefer a restricted API key if Trust Hub/A2P accept one, not verified), EIN decrypt/purge path, fee-gate and idempotency (no duplicate brand or campaign), service-role function privileges, absence of any DEV create calls.
- **Migrations:** (a) PROD: TW-4A `f792c351933e` then TW-4A.1 `9ca53d4d3221` (applied on DEV only so far). (b) R1: one new migration of service-role functions (DEV first). (c) Only if LVS is chosen: TW-3 `campaign_use_case` enum extension. Registration-table column extensions are **not** needed for the pilot (SIDs live in the step ledger and the existing TW-3 columns).
- **Deployment:** app deploy of the TW-4A code and the per-studio legal pages (the campaign URLs must be live); PROD env `SMS_EIN_ENCRYPTION_KEY` and `_KEY_ID`; register the EIN-purge cron; enable the pilot flag for ConfiDance only; later the global SMS status flip.
- Each step above needs your separate authorization; none was taken.

## 6. Sources read today
- https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv (architectures #1–#6)
- https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api (profile fields, ISV email, brand-before-campaign, use-case list incl. LOW_VOLUME/MIXED/CUSTOMER_CARE; page truncated in part)
- https://www.twilio.com/docs/messaging/api/usapptoperson-resource (campaign fields and limits; OptOut/Help conditional)
- https://www.twilio.com/docs/messaging/api/brand-registration-resource (brand parameters, `Mock`, statuses)
- https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out (Console-only; default STOP keywords; default HELP behavior not stated)
