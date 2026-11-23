# TW-4F G-SUB prerequisite package (2026-11-23)

Status: preparation only. Nothing was written to production, no Twilio resource exists, nothing was deployed, funded, messaged or activated. G-SUB itself (creating the ConfiDance subaccount) is on HOLD until the three prerequisites below are met. The $150 figure is a ceiling, not authorization.

## 0. Where production stands (read-only, 2026-11-23 00:29Z)

Studio `ConfiDance Studio` (`e9365dbd-9f8d-44ee-b7ec-053a7c0651ee`) exists and is active. Onboarding access is OFF, there is no onboarding, no legal entity, no subaccount, no confirmation, no step, no spend event. Six prices are active. One platform admin. Re-check any time with `gsub_prereq_check.sql` (`sb.sh prod-read`).

## 1. Prerequisite P1: owner onboarding (G1)

What is verified: the wizard at Settings > Texting (owner only) collects legal name, entity type, industry, website, address, representative (name, title, position, email, phone), preferred area code and the EIN, which is encrypted at once and never shown again (only the last four). Four checkboxes are the consent evidence:
1. I am authorized to register this business for text messaging.
2. The information is accurate and matches my business records.
3. We will text only people who opted in, and only about appointments and lessons. No marketing.
4. I understand texting may carry setup and monthly fees, and I accept DanceFlow's SMS terms.

"Submit for review" only records the setup (state `submitted_for_checks`); it calls nothing at Twilio. Only studio owners can submit.

Blocker found: the wizard is hidden until the per-studio pilot switch (`studio_sms_onboarding_access`) is on. It is OFF for ConfiDance. The platform page action `set_sms_onboarding_access` needs a signed-in platform admin; the equivalent, hash-pinned script is `gsub_enable_onboarding_access_prod.sql` (see section 2). The switch only shows the wizard; it starts nothing.

Self-service instructions for ConfiDance's authorized representative (draft, not sent to anyone):
1. Sign in at the DanceFlow app as the studio owner of ConfiDance Studio.
2. Open Settings > Texting. Complete the four steps: business identity (legal name exactly as on the IRS letter: ConfiDance Unlimited, LLC; entity type; industry Education or Consumer), address and website, the authorized representative (a person with authority to bind the business: owner, director, GM), and the preferred area code.
3. Enter the EIN once. It is encrypted and you will only see the last four digits afterwards.
4. Read the generated campaign description, sample messages and the three public pages, then tick the four statements only if each is true, and press Submit for review.
Do not share the EIN in chat or email. Nobody at DanceFlow enters, attests or submits for you. The representative must be a genuine, authorized person; the platform admin script in section 2 refuses unless the attestation was made by an active owner of this studio.

First human action in this prerequisite: the owner decides who the representative is and completes the wizard (after the switch is on).

## 2. Prerequisite P2: legal entity and $150 limit (platform admin)

Existing platform actions (`tw4_entity_create_for_studio`, `tw4_entity_set_spend_cap`) are used unchanged. Two hash-pinned alternatives to clicking through the platform page are prepared; each guards, then calls the same functions:

| File | When | What it does |
| --- | --- | --- |
| `gsub_enable_onboarding_access_prod.sql` (sha256 `64be40f0f2587af3910bad7e06d86960a8a403eab61f4bc5512c49fecb148959`) | now, after owner approval | turns the onboarding switch on for ConfiDance Studio only (refuses on any other name or if there is not exactly one platform admin), audits it |
| `gsub_entity_and_cap_prod.sql` (sha256 `ec0f75ae2443bf409a5927ff2cdd1293a23b1019438dca09839ac8ec088d3c9a`) | only after the owner has genuinely submitted onboarding | refuses unless: studio name matches, legal name equals `ConfiDance Unlimited, LLC`, never GenX/TotalTech, onboarding is submitted, attested, EIN stored, attested by an active owner of that studio, representative and address present; then creates the legal entity and sets the cap to 15000 cents |

Audit attribution: these functions record the (sole) platform admin as the actor because they take it as an argument. The scripts write a note that engineering executed them via `danceflow-ops` under the owner's written approval of the file hash. If the owner prefers the platform page (two clicks, needs a recent sign-in), nothing else changes. Either path is a production write and needs the owner's approval of that exact file hash (`sb.sh prod-apply <file> <sha>`).

Validation (DEV, hosted, always rolled back, 2026-11-23): `gsub_dev_validate.sql` runs the exact script bodies with test constants in one transaction that ends in a deliberate exception. Results: wrong studio name refused (access and entity); access enable ok and idempotent; no onboarding refused; draft onboarding refused; attestation by a non-owner refused; wrong legal name refused; genuine path creates the entity with cap 15000; replay refused; GenX subject refused; 0 Twilio account rows; audit entries `access_enabled`, `entity_created`, `spend_cap_set`. DEV was verified clean afterwards (0 entities, 0 onboardings). An earlier rehearsal also showed `tw4_subaccount_confirm` refuses without a cap (TW004) and with an unknown entity, records a confirmation once the cap exists, and creates no Twilio account row. Existing local suites (tw4f3a 16/16, tw4f3bui, panel tests) cover the app side.

What the cap is NOT: it is DanceFlow's own application limit (`studio_sms_legal_entities.spend_cap_cents`, checked by `tw4_runner_spend_check` before any fee step against fees DanceFlow has authorized or reserved at customer prices). Twilio does not enforce it. Actual charges accrue on the parent Twilio account and its funding, which the cap cannot stop. Every fee-bearing step stays its own gate with a dated written approval; the cap only refuses further steps. Twilio offers no hard spending cap: usage triggers and balance emails only notify, a zero balance suspends the project but already-accepted messages can drive it negative, and auto-recharge refills rather than caps (see gates document section 1a). The owner should record the parent account's balance, auto-recharge and notification settings; engineering has not inspected them. Real spend is bounded only by DanceFlow's own controls and a manual suspension.

## 3. Prerequisite P3: production environment and deployment (all switches stay off until their gate)

Today production has `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_SECRET`, and `SMS_PENDING_OPT_OUT_REQUIRED=1`. The registration runtime needs, in addition (names only; SIDs are identifiers, not secrets):

| Variable | Value / source | Notes |
| --- | --- | --- |
| `TWILIO_ISV_PRIMARY_PROFILE_SID` | `BUed777b1ed81df271793fbd097324ec94` (GenX TotalTech LLC approved Primary Customer Profile; Stage A evidence, `TW-4_StageB_Decision_Memo.md`) | the Primary is only assigned, never the subject |
| `TWILIO_ISV_PRIMARY_POLICY_SID` | `RN6433641899984f951173ef1738c3bdd0` | same source |
| `TWILIO_ISV_SECONDARY_POLICY_SID` | `RNdfbf3fae0e1107f8aded0e7cead80bf5` | Twilio ISV guide step 1 |
| `TWILIO_ISV_A2P_POLICY_SID` | `RNb0d4771c2c98518d916a3d4cd70a8f8b` | Twilio ISV guide step 2.1; loader requires it though used later |
| `TWILIO_ISV_COMPLIANCE_EMAIL` | OWNER DECISION: a monitored DanceFlow mailbox | goes to Twilio as the profile contact |
| `TW4_ISV_REAL_CALLS` | `on` | the registration gate; set LAST, at G-SUB time |

Credential finding: creating subaccounts needs the parent Account SID and Auth Token (or a Main API key); Standard API keys cannot (design section 13). So G-SUB uses the existing production `TWILIO_AUTH_TOKEN` and the `TWILIO_ISV_API_KEY_SID/SECRET` variables must stay UNSET in production (with a key configured, the token is not read and creation would fail). No new secret is needed; the alternative is a revocable Main API key created in the Console (owner action). This is part of what the owner approves.

Not set in this step (each is a later gate): `TW4_PROVISIONING_REAL_CALLS` (fee-bearing provisioning), `TW4_NUMBER_REAL_CALLS` (number purchase), `TW4_NUMBER_READS`, `TW4_SUBACCOUNT_WEBHOOKS`, `TW4_ISV_MOCK_BRAND`, the SMS activation flags. Verification of the SIDs without exposing secrets: they are present in the Stage A evidence; the first real use is the runner's read-only Primary profile check, which itself is a Twilio call and therefore happens only after the real-calls gate.

Deployment plan (Apps holds the Vercel CLI; each step its own owner gate): (1) set the five non-secret variables in Production only, WITHOUT `TW4_ISV_REAL_CALLS`; (2) stage a production-target build of the release line tip (currently R+4 plus #777); smoke it (loader reports "complete", real calls still "switched off", no outbound); (3) promote; observe 30 minutes; (4) at the G-SUB moment only, set `TW4_ISV_REAL_CALLS=on`, build, promote, run G-SUB, then turn it back off if the owner wants Twilio quiet until G2. Because variables bind per deployment, step 4 needs another staged build each way. Alternative to save a build: set `TW4_ISV_REAL_CALLS=on` in step 1 (the platform action is then the only thing that can reach Twilio, and it still needs the typed phrase and a fresh admin session). The owner picks; engineering recommends the safer two-build path.

## 4. Financial isolation checklist

- G-SUB creates an empty subaccount: no documented fee, no number, brand, campaign or messaging service. First fee is G3 (brand, $4.50 provider cost conservative, $7.00 retail). Number $1.15/mo, vetting $15, campaign $1.50/mo follow as their own gates. A rejected brand or campaign could add up to about $37 per studio.
- `TW4_PROVISIONING_REAL_CALLS` and `TW4_NUMBER_REAL_CALLS` are separate and off; fee steps also need the spend check and a dated written approval (U-4).
- Subaccount creation has no close function by design: closing is permanent and manual (Twilio Console), so it is effectively irreversible.

## 5. Order of human actions (the first unavoidable one is item 1)

1. Owner approves `gsub_enable_onboarding_access_prod.sql` (hash above), or flips the switch on the platform page. One approval; engineering runs it and verifies with `gsub_prereq_check.sql`.
2. ConfiDance's authorized representative completes the wizard (cannot be delegated or done by engineering). In parallel, the owner chooses the compliance mailbox and approves the Vercel variable change and the staged build.
3. Engineering re-runs `gsub_prereq_check.sql` on the submitted onboarding, reports the findings, and asks for approval of `gsub_entity_and_cap_prod.sql` (or the platform page equivalent).
4. Engineering returns the final single-subaccount authorization request (exact legal entity id, friendly name `df:production:{legal_entity_id}`, $0 documented cost, side effects, permanence), with the typed phrase to be entered by the platform admin.

Rollback limits: items 1-3 are reversible (switch off, entity and cap are Git/DB rows that the cap function may lower; entity creation has no delete path by design, so a wrong entity needs a documented remediation); the subaccount is not.
