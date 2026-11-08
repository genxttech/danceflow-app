# TW-4F sender readiness and dispatch integrity (design, 2026-10-20)

Owner direction 2026-10-20 (option 1): connect approved Twilio sender provisioning to outbound dispatch WITHOUT creating Twilio resources. Provisioning itself (Messaging Service creation, A2P campaign registration, number purchase: "R2") is a separate later slice that will write into the same records. Local/synthetic only: no hosted SQL, no real Twilio call, no SMS, no flag enabled. Migration `20261204090000_twilio_sender_readiness.sql`, after `20261203090000`.

## 1. Gap being closed

- Billed dispatch (`tw4_usage_begin`) sends only through the latest `studio_sms_billed_senders` row, but nothing writes that table except a platform-admin function with no caller; it records only a Messaging Service and checks nothing at Twilio. No campaign, number or readiness is known.
- Billed sends use PARENT credentials against the subaccount's URL; the owner requires subaccount-scoped credentials.
- Inbound routing (`resolveStudioFromInboundSender`) reads only the legacy `studio_sms_registrations`; a billed studio's STOP/START/HELP sent to its subaccount number would not be mapped to the studio.
- The platform panel's "can send" is keyed on the legacy table.

## 2. Model (database)

`studio_sms_billed_senders` gains (additive) `campaign_sid` (QE), `phone_number_sid` (PN) and the status `pending`; it stays append-only, latest row per studio wins.

- **Record** `tw4_sender_record(studio, actor, mg, qe, pn, e164, reason)`: platform admin; studio linked to a verified legal business; that business has an ACTIVE subaccount, stamped on the row; all four identifiers well-formed; e164 NANP. The new row is `pending` (cannot send). Refused (`23505`) when another studio's current non-revoked sender uses the same Messaging Service, campaign or number (one sending identity per location in this slice; inbound must map to exactly one studio).
- **Verify** `tw4_sender_verify(sender_row, actor, evidence)`: evidence comes from READ-ONLY provider reads through the subaccount's own credentials (§4). Recorded in an append-only `studio_sms_sender_verifications` table (row id, account, every SID read back, campaign status, number status, Messaging Service membership, outcome, failure code, source `provider_read` or `fake`, actor, time). Outcome `verified` only if: every SID matches the pending row, the account matches the row's AND the business's current active subaccount, the Messaging Service belongs to the account, the campaign is attached to that Messaging Service with a VERIFIED (approved) status, the number belongs to the account, is attached to that Messaging Service, has SMS capability and its E.164 equals the recorded one. A verified outcome appends an `approved` row copying the pending row's identifiers plus the verification id; a failed one leaves it pending (and records why).
- **Revoke** `tw4_sender_revoke(studio, actor, reason)`: appends `revoked` (immediate stop). A re-verification that fails on an approved sender appends `revoked` as well (a campaign suspended or a number released at Twilio fails closed).
- **Readiness** `_tw4sr_ready(studio)` returns the sender only if the latest row is `approved`, carries all identifiers and a `verified` verification for exactly those identifiers and account, the account is the business's current ACTIVE subaccount, and the business is the studio's. Anything else: not ready.
- `tw4_usage_begin` (replaced from `20261201090000`; only the sender block changes) uses `_tw4sr_ready` instead of "latest row approved", and returns `sender_e164`. All other checks (switch, NANP, client, suspension, price, segments, funds, hold, monthly limit, ceiling) and the reservation are unchanged. A pending, revoked, unverified, mismatched or subaccount-suspended sender gives `TW015` before any reservation.
- **Inbound mapping** `tw4_inbound_studio_for(account, mg, to_e164)`: service role; returns the one studio whose LATEST sender row (any status, so STOP still reaches a revoked or suspended sender) matches every identifier present on the inbound webhook AND whose row account is the signing subaccount; otherwise none. Never consulted for parent-signed webhooks.
- **Admin read** `tw4_sender_overview(actor)`: per linked studio, the latest sender row, its latest verification and readiness. Counts and identifiers only; no message content.

## 3. Dispatch (application)

- `resolveStudioSmsSender` is unchanged in shape: a linked studio still returns `sms_billed_studio` and goes through `sendBilledSms`; the database chooses the sender. The billed path never falls back to the legacy registration or the parent account.
- `sendBilledSms` passes the database's `account_sid` + `messaging_service_sid` to the provider (unchanged); `sender_e164` is returned for logging and a provider-side cross-check (the Message resource's `from`).
- Reservations, the dispatch marker, idempotency per source, provider-answer classification, callbacks and evidence settlement are untouched.

## 4. Subaccount-scoped credentials

- `RealBilledSmsProvider` signs every request with the SUBACCOUNT's own SID and Auth Token, obtained on demand through the existing `SubaccountTokenProvider` (memory only, short TTL, `RedactedSecret`, spaced re-reads) and refreshed once on a 401 (the existing rotation rule). No parent-credential fallback for sends or reads; a token that cannot be obtained is `uncertain`-free: the provider refuses BEFORE any send (`credentials_unavailable`), so nothing is sent and the attempt is released as a definite refusal.
- The same credential source serves the read-only verification provider (`SenderVerificationProvider`: Messaging Service, its phone numbers, the A2P campaign, the IncomingPhoneNumber). Gates: production build + production deployment + `SMS_SENDER_VERIFY_READS=on` (reads) and the existing `SMS_BILLED_REAL_SEND=on` (sends); the in-memory fake in local fake mode; otherwise none (verification unavailable, sends refused).
- The provider interface (`send`, `fetchMessage`) is unchanged, so the scheduled-reconciliation slice can adopt it as is.

## 5. Inbound routing

`resolveStudioFromInboundSender` gains the signing account: for a SUBACCOUNT-signed webhook it asks `tw4_inbound_studio_for` first; if the subaccount's business has no matching sender it falls back to nothing (unrouted), never to the legacy table (a legacy number cannot be under a subaccount). Parent-signed webhooks keep the legacy lookup. The route's existing order (repeated keys, signature, tenant check `webhookMayActForStudio`, replay ledger, keyword effects, recording) is unchanged, so STOP/START/HELP for billed studios are processed exactly as for legacy studios.

## 6. Platform UI

A "Sending identity" block per studio on the subaccount panel: the recorded Messaging Service / campaign / number / E.164, status (pending / approved / revoked), last verification (outcome, reason, time), and actions Record, Verify, Revoke (platform admin, written reason, server actions calling the functions above; Verify performs the read-only provider reads). The panel's readiness for a linked studio comes from `tw4_sender_overview`, not the legacy table.

## 7. Failure handling

| Situation | Result |
|---|---|
| No sender, pending, revoked, unverified, verification for other SIDs | `TW015` at begin, nothing reserved |
| Subaccount suspended / closed / replaced | not ready (`TW015`); a re-verification revokes |
| Campaign not approved, number detached, wrong account at verification | verification fails, sender stays pending or is revoked |
| Two studios claiming one Messaging Service / number / campaign | refused at record time |
| Subaccount token unavailable at send | refused before the provider call (released) |
| 401 after rotation | one refresh and retry, else refused |
| Inbound to a billed sender | mapped by subaccount + identifiers to one studio; STOP works even for a revoked sender |
| Parent-signed webhook for a subaccount number | not mapped to a billed studio |

## 8. Coordination

Scheduled reconciliation (another conversation, not yet started) owns `usageReconciler.ts`, its scheduler route and the `tw4_usage_due/settle/touch/release_unsent` and `tw4_inbound_record` reconciler callers; this slice keeps the `BilledSmsProvider` interface and only changes how it is constructed. The financial-integrity P3 follow-up (unstarted) takes a migration after `20261204`.

## 9. Revisions after the Opus architecture review (2026-10-20) — authoritative where they differ from §2-§7

Verified against Twilio's documentation (2026-10-20): when a send carries both `From` and `MessagingServiceSid`, Twilio disables automatic sender selection and refuses the send unless `From` is in that service's sender pool (error 21711). A2P campaign `campaign_status` documented values include `IN_PROGRESS`, `VERIFIED`, `FAILED`; only `VERIFIED` counts.

- **Sharing model (P1-5, P1-1).** Locations of one business MAY share its Messaging Service and campaign (the onboarding plan's default); each location has its OWN number. Every billed send passes `From=<location number>` with the Messaging Service, so Twilio itself refuses a number that has left the pool. Uniqueness: a phone number / E.164 belongs to at most one studio (a revoked row keeps it until explicitly `released`); a Messaging Service or campaign is never shared across businesses. Checks run under advisory locks per identifier (race-free). Inbound maps by `To` (the location number), with the Messaging Service as a cross-check, ignoring `released` rows; STOP still reaches a revoked sender.
- **Revocation cannot fail open (P0-1/2/3).** Every sender write (record, verify, re-verify, revoke, release, callback flag) takes one per-studio row lock; history is ordered by a `seq` (bigserial) taken under that lock, never by transaction start time. Verify must name the CURRENT latest row. `tw4_usage_dispatching` re-checks readiness under the entity -> account -> attempt locks and requires the ready sender's account, Messaging Service and E.164 to equal the attempt's; otherwise the attempt is released (`sender_not_ready`) and nothing is sent. Attempts store `sender_e164`.
- **Readiness = latest row approved AND latest decisive verification `verified` for exactly its identifiers AND no older than 24 hours AND account = the business's active subaccount.** A decisive `failed` (from a re-verify or a registration-failure callback, error 30034) makes it not ready at once.
- **Evidence (P1-2, P1-3).** The server performs read-only GETs with the SUBACCOUNT's credentials: the Account (status `active`), the Messaging Service (account, `us_app_to_person_registered`), the service's inbound webhook routing (must reach DanceFlow's inbound route), the A2P campaign under the service (account, service, `VERIFIED`, not mock, brand, use case), the Brand (`APPROVED`, not mock, the business's own recorded B1 brand on that account), the IncomingPhoneNumber (account, E.164, SMS capable, `in-use`) and the service's PhoneNumber membership. It sends only normalized fields and response digests; the DATABASE computes the outcome (never trusted from the caller). Use case must match the location's verified path (Standard -> MIXED, Low-Volume Standard -> LOW_VOLUME). Advanced Opt-Out is Console-only: the admin attests it at verification. Source `fake` is accepted only where the local-QA marker table `public.tw4_local_qa_only` exists (created by the QA fixtures, never by a migration; a database setting was not usable because `alter database … set` needs superuser on Supabase); readiness ignores fake evidence elsewhere. Transient read failures (timeout, 429, 5xx) are `inconclusive` and change nothing; definite ones (404, wrong status/owner) fail.
- **Freshness (P1-4).** A scheduled read-only re-verify (library entry point; scheduling is an activation gate, not registered here) refreshes approved senders before 24 hours pass; a definite failure revokes readiness.
- **Credentials (P2-1/2/3).** The subaccount token is obtained BEFORE the dispatch marker (`prepare`); if it cannot be, the send is refused with nothing marked (the delivery retries). A dedicated token-read parent (GET `Accounts/{sid}` only, parent SID+token) is gated by production + `SMS_BILLED_REAL_SEND` / `SMS_SENDER_VERIFY_READS`, never `TW4_ISV_REAL_CALLS`; it refuses suspended or closed subaccounts. One process-wide cache per purpose, TTL 60 s. Evidence reads use the ATTEMPT's account; a closed/replaced subaccount's evidence is resolved by an admin (no parent fallback).
- **Legacy setter** `tw4_usage_billed_sender_set` is no longer executable; its old `approved` rows are not ready (no campaign, number or verification).
- **Audit:** record / verify / revoke / release / flag write `studio_sms_onboarding_audit` (normalized identifiers only).

## 10. Implementation notes

- A verification naming a row that is no longer the latest fails with errcode `TW021` (not `40001`: PostgREST retries serialization failures until its timeout).
- Token provider: `messagingTokenProvider(env)` / `createMessagingTokenParent` / `messagingTokenReadsAllowed` in `src/lib/sms/twilioIsv/real.ts`; the platform verify action and the billed sender share it.
- Order in the billed send: `tw4_usage_begin` (reserve, returns `sender_e164`) -> `provider.prepare(account)` (token; failure = retry, no marker) -> `tw4_usage_dispatching` (re-check; `sender_not_ready` releases the reservation) -> send with `From` + `MessagingServiceSid`.
- The expected inbound route is `NEXT_PUBLIC_APP_URL` (or `NEXT_PUBLIC_SITE_URL`) + `/api/sms/twilio/inbound`; without it verification refuses (`app_url_not_configured`).

## 10a. Revisions after the Opus implementation review (2026-10-20) — authoritative where they differ from §2-§10

- **A send that cannot get ready before its marker for a PERMANENT reason releases its reservation at once** (`tw4_usage_release_unprepared`): real sends off, an invalid account, or no sender number. A TRANSIENT reason (`credentials_unavailable`: the subaccount token could not be read just now) keeps the attempt reserved, so an automated delivery's retry (same source) still sends it; the re-review found that releasing here would turn one token-read blip into lost reminders. An attempt that is never retried is released by the reconciler, which is an activation gate. Only a still-`reserved` attempt changes, so an attempt another caller already marked is never touched. A replay of the same source then reads `released` (not sent), exactly like a provider refusal after the marker. If the release itself fails, the reconciler releases the unmarked attempt.
- **Billed real sends require subaccount webhooks** (`TW4_SUBACCOUNT_WEBHOOKS=on`) as well as `SMS_BILLED_REAL_SEND=on`. Without them, STOP/START/HELP replies and delivery callbacks to a subaccount number would be refused, and consent and the 30034 flag would never be recorded.
- **A location changes its number only after releasing the current one** (errcode `TW022`). Re-recording the same number, for example under a new Messaging Service, is allowed. Because no unreleased number is ever superseded, inbound maps from the latest row. When `To` is present it decides alone, since it is unique on the account. The Messaging Service is used only when there is no `To`.
- **Failed senders are never restored automatically.** This supersedes §2 and §7, which said a failure "appends revoked". A failed re-verify or a 30034 records a failed verification, and readiness stops at once. The scheduler's work list and `tw4_sender_reverify` skip such a sender; only a platform admin's verification restores it.
- **A 30034 flags only the identity the attempt was sent from**, matching its account, Messaging Service and number, and only once. A late callback for a released number changes nothing.
- **Readiness re-checks the use case** of the verified campaign against the location's current path, so a path change makes the sender not ready until it is verified again.
- **The history sequences** (`seq`) carry no API-role privileges, because readiness depends on their order.
- PROD postflight must assert that `to_regclass('public.tw4_local_qa_only') is null`.

## 11. Release blockers

1. R2 provisioning (Messaging Service, campaign, number) does not exist yet; senders can only be recorded for resources created by hand.
2. Every subaccount must have its senders recorded AND verified before it goes live: a subaccount-signed inbound text for a number without a sender record is unrouted.
3. Hosted SQL order: 20261201 -> 20261202 -> 20261202140000 / 20261202150000 -> 20261203 -> 20261204.
4. `SMS_SENDER_VERIFY_READS`, `NEXT_PUBLIC_APP_URL` and the token-read parent credentials configured on production only with owner approval.
5. The 24 h re-verify (`reverifyDueSenders`) and the usage reconciler must be scheduled before real billed sends.
6. Advanced Opt-Out set in the Twilio Console per Messaging Service before the admin attests it.
7. `SMS_USAGE_BILLING`, `SMS_BILLED_REAL_SEND`, `SMS_USAGE_EVIDENCE_READS` and the DB switch stay off until activation is approved; real sends also need `TW4_SUBACCOUNT_WEBHOOKS=on`.
8. Hosted pre/postflight: the local-QA marker `public.tw4_local_qa_only` must not exist on DEV or PROD.
