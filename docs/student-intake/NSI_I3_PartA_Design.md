# NSI I3 Part A: design (planning only, 2026-11-23)

Status: **design document only.** No code, SQL, flag, env value or email is authorized or created by this document. Collection (Gate A) stays closed; no intake email may be queued or sent while the Marketing M-0 dependencies are open (spec §22.6). It turns `NSI_I1_Implementation_Plan.md` §11.1 (A1 to A11) into buildable slices that fit the scheduling, student-record, notification and outbox systems that already exist.

Owner correction applied: Student Intake has **no separate pricing**. Access is pilot grants (rollout control), staff roles and Gate A only. Nothing below introduces a billing key, plan check or paid entitlement.

## 1. What already exists (do not rebuild)

| Area | In place (DEV, dark) |
|---|---|
| Data core | I1 M1-M5: templates and immutable versions, requests, respondents, responses and revisions, completions, minor determinations, guardian designations, consent evidence, legal holds, audit, retention columns, erasure barrier, RPC-only writes, collection gate (Gate A) and new-obligation gate (Gate B) |
| Eligibility | M6-M11: evaluator (first appointment, watermark, settle delay, floor, history), preview and simulation RPCs, `intake_ensure_request` (M10 on DEV, M11 local), pilot grants (`config_preview`, `live_collection`) |
| Staff config | `/app/settings/student-intake`: templates, publish, default form, lesson-type selection, preview |
| Dispatcher | T2 merged: every `intake_*` outbox row is skipped until a renderer exists (`dispatch.ts`) |
| Not present | invitations, sessions, rate limits, email challenges, any student or guardian page, any renderer, any reconciler, staff status/answers UI |

## 2. Principles

1. **One person, one request, many appointments.** The request (already built) is the unit. Invitations and sessions hang off the request, never off an appointment.
2. **Nothing writes to appointments, clients or `client_account_links`.** Scheduling is read-only for intake (spec §3.4 step 5). Guardian completion never creates link rows or changes `can_sign_documents` (A4).
3. **Database owns authorization.** Student and guardian actions are RPCs that derive audience and request from the session row, never from parameters (spec §4.2). The browser holds only an opaque cookie.
4. **Fail closed and identical.** Invalid, expired, revoked, suspended and gate-closed links give one response.
5. **Email only through the shared outbox, after M-0 closes.** Until then the I3 slices ship with **staff "copy link" and in-person attestation only** (spec §7 row I3: "No automated email").

## 3. Slices

| Slice | Content | Items | Needs |
|---|---|---|---|
| I3-1 (SQL M12) | `intake_invitations` (hash, salt, kid, generation, expires_at, revoked_at, pinned version at issue), `intake_sessions`, `intake_rate_limits` (DB-backed, fail closed), issue/revoke/exchange RPCs; version pinned at issue; submission refused after `expires_at` | A1, A2, A7 | `INTAKE_ROOT_SECRET` provisioned in DEV only for tests; trusted client-IP source on Vercel confirmed |
| I3-2 (SQL M13) | `intake_email_challenges` (code derived from challenge id, 10-minute expiry, 5 attempts, limits per request, email and IP), staff attestation event (reason, method, guardian name, relationship), respondent guard change so `email_code_verified` and `staff_attested` need a matching verification record | A3, A4, A8 | owner role decision (A8) |
| I3-3 (SQL M14) | Minor determination service path (replaces the owner/admin-only interim path), guardian decline with a terminal `declined` state excluded from completion reuse, N1 outcome alignment | A5, A6, A9 | owner answers D3, D4 below |
| I3-4 (app) | `/intake` route: fragment-to-cookie exchange (`__Host-`, HttpOnly, Secure), origin and CSRF checks, `noindex`, `no-store`, `no-referrer`, `robots.ts`; student and guardian completion pages using the template renderer; draft autosave; staff copy-link and attestation UI | A2, A3 | I3-1..3 reviewed |
| I4 (after T1-T4 and M-0 close) | reconciler job calling `intake_ensure_request`, queueing invitation and reminder rows into `outbound_deliveries` in the same transaction as the invitation, intake renderer, reminder rule, cancel and reschedule sync | A10, A11 | T1 timezone, T3 templates, T4 SQL, M-0 closed, Resend tracking verified off |
| I5b | staff status chips (client profile, schedule), answers panel by role, instructor RPC | | I3 + I4 |

Each SQL slice follows the M10/M11 pattern: one migration, exact-fingerprint rollback, local fresh-stack lifecycle harness, independent review, then DEV apply via `sb.sh`; PROD is an owner gate. Rollbacks are refused once data exists, as in M7/M9.

## 4. Student and guardian completion flow

1. Staff (or, after I4, the reconciler) holds an open request for a client (exists today).
2. **Issue** (`intake_issue_invitation`, staff role or reconciler service role): checks Gate A, Gate B, barrier; pins the published version once; creates generation n and revokes n-1; returns the invitation id (the token is derived, never returned from storage). Staff "copy link" derives the same token in the app server and shows it once.
3. **Open link**: fragment `#t=` never reaches the server. Page script POSTs it to the exchange endpoint, which hashes it, looks up the invitation, checks revoked/current generation/expiry/request open/appointment live, and sets the session cookie (audience claim stored on `intake_sessions`). Prefetchers fetch no token and consume nothing.
4. **Student path** (adult): sections for audience `student`; autosave via `intake_save_draft` (exists); submit via `intake_submit_response` (exists). The minor determination must exist first (A5; the P2-4 "no silent adult default" guard is already in M5).
5. **Minor path**: the student session sees only the student sections; the guardian is invited by a separate invitation of audience `guardian` to an address different from the student's (L2 email code) or, when a verified linked guardian exists, L3 `link_verified` (no code). Staff in-person attestation (L0) is the fallback. Wording follows spec §4.3: "email verified" and "declared relationship", never "verified guardian".
6. **Decline**: a guardian can decline; the request moves to a terminal declined state, excluded from completion reuse; staff see it; a new invitation is a new request.
7. **Completion** writes `intake_completions` (exists) and the audit event; the link then shows a generic completion page.

## 5. Integration with the rest of DanceFlow

| System | Integration | Rule |
|---|---|---|
| Scheduling | Read-only: the evaluator and `appointment_snapshot` read appointments; revalidation reads status and start time. Reschedule changes the reminder key (`starts_at` epoch); cancel suspends the request via the live check. A reconciler pass (I4) re-anchors when the anchor appointment is cancelled (not covered by M11). | No locks on, writes to, or triggers on `appointments` (catalog self-check enforces it) |
| Student records | Request status chips on the client profile and schedule (I5b); answers panel by role (owner/admin full, front desk operational sections, instructors only `instructor_visible` fields through a SECURITY DEFINER RPC modeled on `get_teaching_clients_for_instructor`). No automatic copy into the client profile, marketing or ARIA. | Field visibility is a property of the immutable template version |
| Documents Center | Optional signature step through `requestDocumentForSubject` from an authenticated intake session (I5a), one signer, existing sign controls. | Needs the `documents` entitlement the studio already has; intake adds none |
| Notifications | Staff-facing submission and exception notices are **in-app** (existing notification surface), no email (spec §22.3). Student and guardian email only through the shared outbox. | In-app staff notices do not wait for M-0 |
| Shared outbox | `intake_invitation_student/guardian`, `intake_reminder_*`, `intake_email_code`; row inserted in the same transaction as the invitation or challenge; payload references only; renderer re-derives token or code; stable key `outbound-delivery:{id}`; revalidation list in spec §22.1(8). | Transactional, client-facing sender, never marketing. A10/A11 only after T1-T4 and M-0 |
| Portal / accounts | A signed-in portal student may complete through the portal path (existing `resolvePortalRelationship`); the account-free link is the default for everyone else. | No account creation; no link writes |
| Pilot grants | `config_preview` for config, `live_collection` for new obligations (exists). | Rollout control only |

## 6. Security and abuse controls (summary of spec §5)
- Token: HKDF subkeys from `INTAKE_ROOT_SECRET`, `{kid}.{base64url(HMAC(...))}`, only `sha256(token)` stored, multi-use until expiry, rotation by `kid`; resend rotates the generation.
- Sessions: `__Host-` cookie, audience claim read from the session, sliding and absolute limits, CSRF/origin checks on exchange and save.
- Rate limits: DB-backed buckets per token hash, IP, email and request; fail closed; a trusted IP source must be confirmed on Vercel before I3-1 ships.
- Logging: allowlist only; never URLs, tokens, codes or bodies.
- Resend: open and click tracking must be off on the sending domain (startup or CI check); fragment survival across mail clients is an authorized-test-send gate before any invitation email (I4), not before I3.

## 7. Tests required per slice
Concurrency (parallel issue/resend/exchange, parallel verification attempts, attempt counting), negative authorization (cross-audience, cross-studio, revoked/expired/suspended identical responses), privilege catalog (RPC-only writes, no API-role table grants), hashes and tokens (no token or code ever stored or logged), link-table and `can_sign_documents` identical before and after guardian completion, rollback refusals once data exists, and the full-chain replay (`NSI_Full_Chain_Replay_Plan.md`) re-run after each SQL slice.

## 8. Decisions needed (owner)

| # | Decision | Needed by | Recommendation |
|---|---|---|---|
| D1 (A8) | Which staff roles may create guardian invitations and select recipients | I3-2 | Owner, admin and front desk (matches attestation); instructors no |
| D2 | Account-free link default vs portal-only for existing portal users | I3-4 | Link for everyone; portal path as a convenience |
| D3 | Guardian decline semantics: terminal, or allow one re-invite by staff | I3-3 | Terminal; staff may open a new request |
| D4 | Minor threshold and "pending legal review" wording (spec §14.9) | I3-3 and Gate A | Keep 18 as a setting with the review note until cleared |
| D5 | Invitation expiry (days) and session absolute limit | I3-1 | 14 days link life, 30-minute sliding, 4-hour absolute |
| D6 | P2-1 existing-student policy (see `NSI_Resume_Status.md` §7) | Gate A | Option A with a staff "not asked" list |
| D7 | Staff and instructor visibility of delivery rows (spec §22.6) | I4 | Owner/admin/front desk see status only; no content |

Not decisions for the owner: `INTAKE_ROOT_SECRET` provisioning and the Vercel client-IP source (engineering tasks, flagged as prerequisites above).

## 9. What stays closed
Gate A, intake email, reminders, any PROD apply, flags and env. T1 (timezone), T3 (templates and previews) and T4 (outbound SQL, after M-0 close-out) are separate slices owned outside this document.
