# TW-4F slice E: DanceFlow traffic hold and emergency Twilio subaccount suspension

Status: DESIGN, written before any code (first commit of the slice). Dark and not activated. Nothing here authorizes a real Twilio status change, a hosted SQL apply, provisioning, production activation, an SMS, funding, a Stripe action or a provider fee. Suspension and reactivation stay DISABLED in production: the database switch is off, the environment flag is unset, and nothing in this slice turns either on.

Sources: the provider-protections research fact sheet of 2026-11-23 (official Twilio pages; tags [F] fetched and read, [S] seen only in a search snippet of an official page, "not verified" where no official statement was found) and `TW-4F_Financial_Safety_Gates_2026-11-23.md` section 1a (branch `claude/tw4f-fin-c-inbound`). Where this document says "not verified", the fact sheet says so too, and it must stay that way until someone confirms it on an official page or with Twilio Support.

## 1. Two different controls

| | (a) DanceFlow traffic hold | (b) Emergency Twilio subaccount suspension |
| --- | --- | --- |
| Where it acts | DanceFlow's own database and webhook code | Twilio: `POST /2010-04-01/Accounts/{SubaccountSid}.json Status=suspended` with the parent (main) account's credentials [F] Subaccounts API |
| Scope | one location (studio). The error-reply part applies to the whole legal business's subaccount (see 3.2) | the legal business's whole subaccount, i.e. EVERY location linked to that legal business |
| What it stops | new billed outbound texts, the dispatch of already-reserved billed texts, and optional automatic error replies | Twilio stops the subaccount from sending AND receiving SMS and calls [F]. In-progress calls continue [F] |
| What it never stops | inbound recording; STOP / START / HELP handling and their confirmations | (Twilio decides; see section 2) |
| Who | a platform administrator (aal2 to place; fresh step-up to lift) | a REGISTERED, active platform administrator in a fresh second-factor session, with typed confirmation, a written authorization reference and a reason |
| Reversible | yes, at once | reactivation with `Status=active` is documented to restore full service [F]; `closed` is permanent and is never offered |
| Default | available (it only reduces traffic) | OFF: a database switch (default off, owner-level audited setter) AND an environment flag (unset) |

The traffic hold is the normal, first response. Suspension is an emergency measure for a case where DanceFlow's own controls cannot stop provider charges (for example a compromised subaccount credential sending traffic DanceFlow never sees, or a flood that keeps billing the parent).

### Not a spending ceiling

Suspension is NOT a hard spending ceiling and must never be described as one:
* Twilio has no native hard spend cap at any level; Usage Triggers and balance emails only notify [F]/[S].
* A suspended subaccount is still charged monthly for every phone number it owns [F]. The documented way to stop number fees is to release the numbers or close the account [F]/[S].
* Messages already accepted can still be processed after a suspension, and delayed billing can follow [S] (error 30002 below). Usage data lags [F].
* Whether inbound attempts to a suspended subaccount generate any charge: **not verified** [fact sheet 3, 4]. Receiving is blocked; no official billing statement either way.
* Whether A2P 10DLC brand and campaign monthly fees keep billing while suspended: **not verified**. The conservative assumption is that they continue until the campaign is deactivated or deleted.
* Twilio does not alert anyone when a subaccount is suspended through the REST API [S].

### Not a routine insufficient-credit response

Suspension is NOT the response to low or insufficient studio credit, a usage alert, a negative balance, a failed top-up or a dispute. Those are handled by the existing credit hold, the reservation and monthly-limit checks, and the dispute / negative-balance holds. **No automated path may call suspension or reactivation**: no cron, credit check, alert, webhook, reconciler, status callback, queue worker or script. The only entry points are the two platform-administrator server actions in `src/app/platform/sms/suspensionActions.ts`; a test (`suspension.noAutomation.test.ts`) fails if any other application module imports the suspension modules. (Twilio's Anti-Fraud guide shows a trigger-to-suspend "circuit breaker" [F]; DanceFlow deliberately does NOT build one in this slice, because an automatic suspension would also silence inbound STOP traffic; see section 2.)

## 2. Compliance impact and limitations (compliance-critical)

### 2.1 STOP / START / HELP during a suspension (COMPLIANCE-CRITICAL LIMITATION)
A suspended subaccount cannot receive SMS [F]. A texter's STOP sent during the suspension may therefore never reach DanceFlow's inbound webhook. What Twilio or the carriers do natively with that STOP (whether Twilio's Advanced Opt-Out still records it at the Messaging Service, whether a carrier blocks or replies, whether the message is queued and delivered after reactivation) is **NOT verified**.

Consequences DanceFlow must accept and handle:
1. While suspended, DanceFlow cannot rely on having seen every opt-out. Nothing may be sent from the subaccount until the reactivation reconciliation below is done (this is also enforced: billed sends need an active subaccount, TW015, and the traffic hold stays on after reactivation until an administrator lifts it).
2. On reactivation, before the traffic hold is lifted, an administrator must reconcile opt-outs from the provider: read the subaccount's inbound message list for the suspension window (and Twilio's opt-out records where the Messaging Service has Advanced Opt-Out), apply any STOP that DanceFlow did not record, and record the evidence. The existing pending-opt-out ledger and usage reconciler cover messages that DanceFlow received; they cannot cover messages Twilio never delivered. The automated provider-side opt-out reconciliation is NOT built in this slice (open follow-up F-1); until it is, the reconciliation is a manual, recorded step of the runbook and suspension must stay disabled for any studio whose texters could be affected.
3. Texters who sent HELP during the suspension received no DanceFlow reply. That is unavoidable while the subaccount is suspended.
4. Under the DanceFlow traffic hold (control a) none of this applies: inbound still arrives, STOP / START / HELP are processed and confirmed exactly as without the hold.

### 2.2 Opt-out state
Suspension changes no consent row. Opt-outs recorded before the suspension stay in force. A START sent during the suspension is not received either; a texter who wants to opt back in must do so after reactivation.

### 2.3 Queued, accepted-but-unsent messages (error 30002)
Error 30002 is "message accepted for queueing, but account suspended before sending" [F]. A billed text DanceFlow handed to Twilio just before the suspension can therefore fail with 30002 (the existing status-callback and reconciler paths treat it as a failed provider outcome and release or settle from evidence), or it may already have been sent and billed. DanceFlow never resends it automatically. The traffic hold is placed BEFORE the provider call, so no new billed text is reserved or dispatched for the affected locations while the suspension is in progress.

### 2.4 Inbound traffic
Inbound SMS to the subaccount is blocked by Twilio [F]; inbound calls to an inactive account are rejected (error 10003, seen in search results, not fetched). Whether such attempts are billed: **not verified**. Inbound received before the suspension is recorded normally.

### 2.5 Outstanding and continuing charges
Number fees continue every month while suspended [F]. Brand / campaign monthly fees: **not verified**, assume they continue. Usage already accepted can still bill and the parent balance can go negative [S]. All subaccount usage is billed to the parent account and shares one balance [F]. The existing recurring-fee lifecycle keeps tracking fee-bearing resources; suspension does not change their state in DanceFlow's records.

### 2.6 Reactivation
`Status=active` restores full service [F]. Reactivation is offered only for a subaccount DanceFlow itself recorded as suspended by a confirmed suspension. **`closed` is permanent** (Twilio releases all numbers and deletes data 30 days later when data deletion is on) [F]: DanceFlow never offers it, never sends `Status=closed`, and treats an observed `closed` state as a terminal fact to report, never to change. Reactivation does NOT lift the DanceFlow traffic hold; the administrator lifts it separately after the opt-out reconciliation (2.1).

### 2.7 Parent suspension
If the parent account is suspended every subaccount is suspended [F]. DanceFlow never targets the parent: the action refuses the parent SID (the `TWILIO_ACCOUNT_SID` of the deployment), any SID not recorded for the named studio's legal business, and any account the provider does not report as a subaccount owned by the parent.

## 3. Design

### 3.1 Reuse decisions (what exists on origin/main)
* **Credit hold** (`studio_sms_credit_accounts.hold`, `tw4_credit_set_hold`): NOT reused for the traffic hold. It is one boolean per legal business shared by other reasons (manual hold, the slice-B dispute hold); lifting it from this slice could clear a hold placed for another reason. It is left untouched in both directions.
* **`tw4_rfl_suspend_df`** (revokes the sender): NOT reused; revoking the sender forces the whole activation checklist again and is a heavier, separate decision. It remains available as an existing tool.
* **Active-subaccount sender gate** (`_tw4sr_ready`, TW015 in `tw4_usage_begin`): REUSED. After a CONFIRMED suspension the business's `studio_sms_twilio_accounts.status` becomes `suspended` (the schema already allows it and the inbound, reconciliation and pricing readers already accept `active` or `suspended`), so billed sends stop through the existing gate. A confirmed reactivation sets it back to `active`.
* **Billed send path** (`studio_sms_usage_attempts`): REUSED by adding a trigger (no existing function is replaced): a new billed attempt, and the reserved-to-submitting dispatch marker, are refused (TW080) while the location is on a traffic hold. `sendBilledSms` maps TW080 to its existing `suspended` refusal; a refused dispatch marker leaves the attempt reserved, and the existing reconciler releases it.
* **Error replies** (`inboundReplyAllowed`, TW-4F D3): REUSED. An error reply (never a STOP / START / HELP confirmation) is suppressed while any location of the signing subaccount's legal business is on a traffic hold, and when the hold cannot be checked (error replies already fail closed). The compliance branch never consults the hold. Slice C's `tw4_inbound_auto_reply_allowed` (not on main) is not replaced.
* **High assurance**: REUSED, nothing weaker invented. Server side `requirePlatformStepUp("fresh")` (platform admin role first, verified claims, aal2, TOTP at most 10 minutes old). Database side the begin functions run with the administrator's OWN token and derive the actor with `_tw4price_session_actor('recent')` (session binding against `auth.sessions`, aal2, TOTP freshness configured by the owner, default 10 minutes) and require `_tw4price_admin_active` (the protected registered-administrator registry, the role, and an existing, unbanned auth user). The provider outcome is recorded only by service-role functions, so an administrator's token can never write a provider state. The pricing hardware-key (WebAuthn) ceremony is purpose-bound to price requests and is NOT reused in this slice; requiring a hardware-key assertion for reactivation is open owner decision D-E1.
* **Provider HTTP**: REUSED `TwilioRest` (timeouts, classification: only a parsed 4xx is a definite refusal). The real status client is a new, separate module with its own gate.

### 3.2 Traffic hold (control a)
`studio_sms_traffic_hold_events` is append-only (hold / release, actor, reason, optional suspension attempt). A location is held when its newest event is a hold. `tw4_traffic_hold_set(studio, hold, actor, reason)` (service role; `_tw4c_admin`) writes the event and an onboarding audit row. A suspension attempt places a hold on every location of the legal business before Twilio is called (failure-safe) and never lifts it. Error-reply suppression is evaluated per signing subaccount (the inbound route knows the account before the location), so a hold on one location also silences optional error replies for the other locations of the same business: conservative, and compliance replies are unaffected.

### 3.3 Suspension / reactivation (control b)
Tables (RLS on, no API grants; writes only through the functions):
* `studio_sms_suspension_switch` (singleton, `enabled` default false) and `studio_sms_suspension_switch_log` (append-only). Setter `tw4susp_switch_set(on, actor, reason)` is owner-level only: no API role can execute it.
* `studio_sms_suspension_attempts`: one row per request; `idempotency_key` unique; at most ONE open attempt (`in_flight` or `unknown`) per legal business (unique partial index, plus a transaction advisory lock). State moves forward only, through the functions.
* `studio_sms_suspension_audit`: append-only evidence. Every request, refusal, provider pre-check, outcome and reconciliation is a new row: actor, studio, legal business, SID last 6 characters only, action, authorization reference, reason, idempotency key, provider state before / after, outcome, detail. A trigger refuses UPDATE, DELETE and TRUNCATE for every role (enabled ALWAYS).

Flow (`runSubaccountStatusChange`):
1. Server action: `requirePlatformStepUp("fresh")` first; form fields cleaned; the environment gate checked (off: refused, nothing written).
2. `tw4susp_begin` with the administrator's own token: session actor + registered admin; database switch on (else refused); inputs; idempotency (same key: the stored result is returned and nothing is called again; a key reused for another request is refused); the studio's legal business and its recorded subaccount (active or suspended; closed refused); typed studio name; SID last 6; reactivation only after a confirmed suspension; no other open attempt. A refusal of a well-formed request is recorded as an audit row. For a suspension, every location of the business is put on a traffic hold. Returns the attempt and the recorded SID.
3. Refuse the deployment's parent SID (recorded as refused).
4. Provider GET: the reply must be the requested SID, owned by the parent (`owner_account_sid` = parent) and not the parent itself; `closed` is refused and recorded; already in the target state is recorded as `already_in_state` without a write.
5. Provider POST `Status=suspended` or `Status=active` (never `closed`).
6. Provider GET again; the observed status decides: target reached = `succeeded`; a definite refusal with the state unchanged = `failed`; anything else = `unknown`.
7. `tw4susp_record` (service role) appends the outcome; `succeeded` / `already_in_state` updates `studio_sms_twilio_accounts.status`. An `unknown` attempt stays OPEN: no further suspend or reactivate is accepted for that business until an administrator runs the read-only verification (GET only, recorded), which closes it with the observed state. Nothing ever retries a status change automatically, and nothing ever reactivates automatically.

Failure safety: every error after begin records an outcome (failed or unknown) where it can; if even that write fails the attempt stays `in_flight`, which blocks new attempts and is visible, and the traffic hold placed in step 2 stays on.

### 3.4 Gates (production-disabled)
1. Database: `studio_sms_suspension_switch.enabled` default false; owner-level setter with an audit row.
2. Environment: `TW4_SUBACCOUNT_SUSPENSION_CALLS=on` (unset everywhere), plus a production deployment and production build, checked by `suspensionCallsAllowed`.
The real status client (`suspensionReal.ts`) is built only by `createRealSuspensionProvider`, which re-checks the environment gate and reads the database switch; its status-changing method re-checks the environment on every call. It is imported only by the guarded server actions (enforced by test). Tests use only the in-memory fake.

## 4. Open decisions and follow-ups
* D-E1: require a hardware-key assertion (in addition to fresh TOTP) for reactivation and/or suspension.
* D-E2: who may hold the suspension authority (today: any registered active platform administrator).
* F-1: automated provider-side opt-out reconciliation for the suspension window (until built, it is a manual runbook step; see 2.1).
* F-2: an administrator console section (this slice ships the server actions only; no page renders them).
* F-3: confirm with Twilio Support the "not verified" items (inbound billing while suspended, campaign/brand fees while suspended, what happens to a STOP sent to a suspended subaccount).

## 5. Runbooks (UNEXECUTED PROCEDURE: never run; requires separate owner authorization, both gates on, and a release)

### 5.1 Emergency suspension
Who: a registered, active platform administrator with written owner authorization (the authorization reference, e.g. a ticket or dated message). When: only when DanceFlow's own controls (traffic hold, credit hold, sender revocation) cannot stop provider charges for a legal business, e.g. evidence of traffic DanceFlow did not originate. Never for low credit or a routine alert.
1. Place the DanceFlow traffic hold on the affected location(s) first and record why.
2. Record before evidence: the business, every linked location, the subaccount SID's last 6 characters, the parent Console balance and recent usage for that subaccount, the active fee-bearing resources (numbers, campaign) and the pending billed attempts.
3. Tell the owner, in writing, that inbound STOP / HELP for every linked location will not reach DanceFlow while suspended (2.1) and that number fees continue (2.5).
4. Sign in with a fresh authenticator code. Submit the suspension with the exact studio name, the SID's last 6 characters, the authorization reference and the reason.
5. Read-back checks: the result names `succeeded` or `already_in_state` with provider state `suspended`; the audit shows requested, precheck and outcome rows; `studio_sms_twilio_accounts.status` is `suspended`; billed sends are refused (TW015 / TW080). If the result is `unknown`, do not repeat the suspension: run the verification, record the observed state, and escalate.
6. Record the time; check the Console over the next hours for usage still accruing (accepted messages, number fees).

### 5.2 Reactivation
Who: a registered, active platform administrator with written owner authorization for the reactivation. When: after the cause is resolved and the owner agrees.
1. Confirm the attempt history shows a confirmed suspension and no open attempt.
2. Submit the reactivation (typed studio name, SID last 6, authorization reference, reason). Read-back: outcome `succeeded` with provider state `active`; account status `active`.
3. Reconcile opt-outs for the suspension window (2.1): read the subaccount's inbound messages and Twilio opt-out records for the window, apply any STOP DanceFlow did not record, and record the evidence reference.
4. Only then lift the DanceFlow traffic hold for each location, with a reason naming the reconciliation evidence.
5. Never select or request `closed`. If the provider reports `closed`, stop and escalate: the numbers are gone.
