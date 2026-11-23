# DanceFlow New Student Intake (NSI) V1 — Engineering Specification

| | |
|---|---|
| Status | **Owner-approved design; I1 database foundation applied to shared DEV only (2026-10-14, see `NSI_I1_Implementation_Plan.md` §9.11–§9.12).** Not production-deployed, not available to students or studios; collection (Gate A) closed; no intake email until the Marketing M-0 dependencies close (§22.6). Untracked, uncommitted. Each later slice (I2–I6, T1–T4, PROD) needs its own authorization. |
| Baseline | Originally authored against main `85ab15ef`; reconciled to canonical `origin/main` `13c4d547f5494a8bf75fc472b5d4b48a1f1440f9` (Marketing M-0 merged) with the I0 report. Roadmap v2.23. Roadmap home: Phase 17-I (delivery via Phase 11, signing via Phase 8). The roadmap is not edited. |
| Supersedes | The earlier audit and reconciliation reports in this review. Where they conflict, this document wins. **§14 (approved privacy requirements) and `NSI_I1_Schema_Plan.md` amend §2.2, §4.3, §5.4, §7, §10, §12 and §13 below; where they conflict, §14 and the plan win.** **§22 (owner decision 2026-10-14: shared transactional outbox, Option A) replaces the separate intake delivery outbox everywhere it appears (§2.1, §2.2 `intake_deliveries`, §2.3, §3.2, §3.5, §4.3, §5.4, §6, §7); where they conflict, §22 wins.** |

Labels: **[A]** approved requirement. **[S]** settled by the owner in this review (not reopened here). **[E]** engineering design. **[V]** verified in repo at `85ab15ef` or in vendor documentation (cited). **[G]** verification gate, not closed from the repo. **[D]** open owner decision.

## 0. Corrections adopted in this version

1. A completed submission records the exact published version the respondent completed. Nothing is ever stamped as satisfying a newer version (the earlier "grandfathering" stamp is withdrawn).
2. The version is pinned when the first invitation is issued, not when the request is created. Re-pinning never happens after issue.
3. Raising the re-intake floor never creates work by itself and never invalidates an in-progress form.
4. No trigger on `appointments` and no foreign key from any intake table to `appointments`.
5. Guardian default assurance is L2 (emailed code) or an existing verified relationship. Email possession is never presented as proof of legal guardianship.

## 1. Product requirements

### 1.1 Approved [A]
- Intake is separate from discovery leads, inquiries and intro requests, which never trigger it.
- Studios choose which service types require intake. One studio default template is the fallback.
- Templates: multiple published templates by service type. Sections: dance goals, previous experience, styles of interest, learning preferences, referral source, policies and acknowledgments, custom questions. V1 field types: short text, long text, multiple choice, checkboxes, dropdown, yes/no, date, acknowledgment. Required/optional, reorder, preview, publish. Conditional logic deferred.
- The exact published version is preserved with each submission.
- Branded HTML email invitation after the appointment is committed. Account-free secure link, also usable by a signed-in student. SMS deferred until TW-4.
- Draft save and resume. One automatic reminder 24 hours before the appointment if incomplete. Manual resend. Reschedule recalculates the reminder. Cancellation stops reminders and preserves history. Incomplete intake never cancels a lesson. A near-term booking does not get an immediate duplicate reminder.
- Completed intake stays valid for its version. Publishing a new version does not invalidate completions and does not email former students. Staff can manually request re-intake.
- Guardians complete consent and policy acknowledgments for minors. Students may answer age-appropriate questions separately. Formal e-signature reuses Documents Center.
- Owners/admins configure and review. Front desk sees status, sends/resends and sees permitted operational information. Assigned instructors see relevant information for their own appointments only. Answers never flow into marketing audiences, generic appointment notes or AI prompts.
- UX: guided setup under Settings → Student Intake, status in client and appointment detail, right-side panels where appropriate.

### 1.2 Settled in this review [S]
Trigger on committed appointment (statuses `scheduled`, `rescheduled`, `confirmed`; not the later student acknowledgement) [V: `confirmed` is a late acknowledgement, `lib/schedule/appointmentConfirmation.ts`]. Existing appointment types only; group-class intake deferred. Under-18 requires guardian consent, determined by birth date or age declaration, with authorized staff correction. No automatic backfill of historical clients. Single 24-hour reminder. Account-free guardian completion with Documents signing and no automatic link or signing permission. Independent `student_intake` entitlement, disabled until authorized. Durable outbox with token secrecy. Cancelled-appointment drafts preserved with invitation access revoked until reactivation. Retention policy proposed for legal review. Completion per applicable template version without unnecessary duplicates. No sync of answers into client-profile or marketing fields in V1.

## 2. Architecture

### 2.1 Facts the design rests on [V]
- No service-type table. The service is `appointments.appointment_type`. Per-studio config lives in `studio_settings`, whose base DDL is outside the repo.
- Appointments are created `scheduled`. There are about six write paths and no domain-event hook. Reschedule mutates the same row. Cancel flips status in place. Hard delete exists (`deleteAppointmentAction`).
- A lead is a `clients` row with `status='lead'`. Conversion happens at scheduling time, so client status cannot identify a first appointment.
- No minor concept and no guardian person. A guardian is a `client_account_links` row for an auth user.
- Public and token routes use the service-role client, so there is no RLS backstop for them.
- Documents: one signer per envelope; the account-free `/sign/[token]` path authorizes by token possession; `can_sign_documents` is enforced only on portal and app paths.
- Reminders: `outbound_deliveries` has no scheduled time or retry. The PAY-WH-1 settlement outbox has attempts, backoff, leases and dead-letter and is the reliability bar. *(Updated by §22: the T0 audit verified that `outbound_deliveries`, with the PAY-WH-1 leased claim `claim_outbound_deliveries`, can carry intake delivery once T1–T4 land; intake reuses it instead of building its own outbox.)*

### 2.2 Tables (all new; names provisional)

| Table | Purpose / key constraints |
|---|---|
| `intake_settings` | studio PK; `enabled`, `enabled_at`, minor threshold, default template, surge threshold, retention parameters |
| `intake_feature_grants` | platform-admin pilot grants (studio, feature, reason, expiry) |
| `intake_templates` | per studio; `reintake_floor_version`, `floor_effective_at` |
| `intake_template_versions` | `schema` jsonb, `schema_sha256`, `status` draft/published/archived, `reintake_required`, optional Documents template version link. Published = immutable |
| `intake_service_assignments` | studio + `appointment_type` → template |
| `intake_requests` | studio, client, template; `status`; soft `anchor_appointment_id` (no FK); `pinned_version_id` (set at first issue, then immutable); `source` auto/manual; `supersedes_request_id`; `resume_status` |
| `intake_request_appointments` | soft links (no FK) from request to appointment ids |
| `intake_responses` | one row per request and audience (student/guardian); answers jsonb; `revision`; draft/submitted; version copied from the request pin |
| `intake_response_revisions` | append-only corrections |
| `intake_respondents` | immutable attribution: name, email, declared relationship, assurance level, attestation hash, IP/UA evidence |
| `intake_minor_determinations` | append-only (is_minor, source birthday/declared/staff_override, actor, reason) |
| `intake_completions` | client, template, version completed, request/response ids, `submitted_at`. Records the version actually completed; no floor stamp |
| `intake_invitations` | request, audience, `generation`, `token_salt`, `token_hash` unique, `key_id`, `expires_at`, `revoked_at` |
| `intake_sessions` | short-lived sessions bound to request, audience and (guardian) verified email hash |
| `intake_email_challenges` | OTP: code hash, expiry, attempt cap, consumed |
| ~~`intake_deliveries`~~ | **Withdrawn (§22).** No intake-specific delivery table. Invitations, reminders and verification-code emails are rows in the shared `outbound_deliveries` outbox, queued in the same transaction as the intake row they deliver; they carry references only (never a token, code, answer or rendered body) |
| `intake_events` | audit: viewed, saved, submitted, staff_viewed(section), resent, revoked, attested, token_failed. No PII beyond ids; no tokens |
| `intake_reconcile_failures` | studio, client, error class, first/last seen, attempts, resolved_at |
| `intake_rate_limits` | DB-backed buckets (per token hash, per IP, per email) |

Hot-table rule: no trigger, foreign key, view or index is added to `appointments`. Foreign keys to `clients` and `studios` are allowed where `RESTRICT` is intended (evidence tables).

### 2.3 Services
- Reconciler (cron, 5-minute cadence) → `intake_ensure_request` RPC per client.
- Delivery: intake RPCs queue `outbound_deliveries` rows in the same transaction as the invitation/challenge; the existing generic dispatcher claims and sends them, calling an intake send-time renderer that revalidates and renders (§22). Intake orchestration stays in intake code; the dispatcher stays generic.
- Public intake routes: fragment exchange, session, draft save, submit, guardian challenge.
- Signed-in student path via the portal using existing `resolvePortalRelationship`.
- Staff UI and RPCs for status, answers (field-visibility scoped) and attestation.
- `requestDocumentForSubject` (new, Phase 8 follow-on): creates an envelope for the pinned Documents template version and the request's client only.

## 3. Lifecycles

### 3.1 Request state machine
Open states: `pending`, `invited`, `in_progress`, `suspended`. Terminal: `submitted`, `expired`, `waived`, `cancelled_by_staff`.
- `pending` → `invited` (first invitation issued; version pinned here) → `in_progress` (first draft save) → `submitted`.
- Any open state → `suspended` when its anchor appointment is cancelled or deleted and no other live appointment is attached. `suspended` → previous state on reactivation or rebook (new invitation generation), or → `expired` after the configured idle period.
- Open → `waived` / `cancelled_by_staff` by an authorized staff member.
- `submitted` with a guardian section still `consent_pending_review` or a Documents step blocked is tracked as a sub-status, not a new terminal.
- Transitions are enforced by a trigger on `intake_requests`.

### 3.2 Indexes
- Partial unique on `(studio_id, client_id, template_id)` where status ∈ open states. One open obligation per client and template, however many appointments or workers race.
- `intake_completions` index on `(client_id, template_id, submitted_at desc)`, not unique, so history and manual re-intake coexist.
- Unique on `intake_invitations.token_hash`. Delivery deduplication uses the intake row the delivery belongs to (one invitation generation, one reminder per request and `starts_at`, one challenge) plus the shared outbox's own idempotency (§22); there is no `intake_deliveries.dedupe_key`.

### 3.3 Version and floor rules
1. A published version and a submitted response are immutable (triggers; only redaction is permitted, see §5.4).
2. A request pins the latest published version at first invitation issue. After that it never re-pins. A draft finishes on its pinned version, even if the template is later republished or archived.
3. Publishing with `reintake_required` sets `reintake_floor_version` and `floor_effective_at`. It creates no requests and changes no open request.
4. A completion is valid when `completion.version_number >= template.reintake_floor_version`. A completion of an older version is simply not valid for the new floor, and its history is untouched.
5. A client whose latest completion is below the floor gets a new obligation only for a qualifying appointment created at or after `floor_effective_at`, or when staff manually request intake. An appointment that existed before the floor was raised is never retroactively subject to it. A student who just finished an older pinned version for such an appointment is therefore not asked again for that appointment.
6. Manual re-intake creates a new request (`source='manual'`, `supersedes_request_id`) pinned to the latest published version at issue. It is refused, returning the existing request, if one is already open. Prior requests, responses and completions are preserved.

### 3.4 Reconciliation (bounded, stateless)
Runs every 5 minutes. For each studio that is enabled and entitled (a failed entitlement lookup skips the studio and sends nothing):
1. Read-only enumeration RPC returns at most N candidate (client, appointment) pairs per studio per pass:
   - starts in the future; status ∈ {scheduled, rescheduled, confirmed}; type has an assigned template or the default applies;
   - `created_at >= enabled_at` and older than the settle delay (default 10 minutes; configurable constant);
   - no past appointments, ever (no automatic backfill).
2. For each pair, TS calls `intake_ensure_request(...)` in its own transaction, which:
   - takes `pg_advisory_xact_lock(hash(studio, client, template))`;
   - re-reads the appointment; aborts if cancelled, changed type, or inside the settle delay;
   - applies eligibility:
     - **New student:** no valid completion and no earlier non-cancelled qualifying appointment for the client. (Existing students are not invited by the system; staff can request intake manually.)
     - **Re-intake:** latest completion below the floor and the appointment created at or after `floor_effective_at`;
   - if an open request exists, attaches the appointment and returns it; otherwise inserts with `ON CONFLICT (partial index predicate) DO NOTHING` and re-selects;
   - recomputes `anchor_appointment_id` as the earliest live attached appointment.
3. Failure isolation: each client is its own transaction; each studio has a time budget. A failure records or updates `intake_reconcile_failures` (best effort), is shown to staff as "needs attention" with a safe Retry action, and is retried by the next pass. Stateless re-evaluation makes retry idempotent.
4. Surge threshold: if creating requests would exceed the studio's threshold within a rolling window, the reconciler still records obligations but holds invitation issuance (`surge_hold`), raises a platform alert and a studio-owner notice, and an authorized staff member releases it after seeing the count. Enabling intake shows a dry-run count first. Default threshold value is [D].
5. Nothing in this path writes to or locks appointment rows. A fault anywhere in intake cannot affect booking.
6. An optional best-effort post-booking nudge may start a reconciler run sooner. It sits outside the booking transaction and its failure is ignored.

### 3.5 Delivery lifecycle
> **Superseded by §22 (shared transactional outbox).** The state machine, claim, retry and dead-letter mechanics below now belong to the shared `outbound_deliveries` dispatcher (made reliable in T2). Still valid and carried into §22: the revalidation list, the reminder timing rule, the stable-idempotency requirement and the Resend provider facts. The "send directly, no `outbound_deliveries` row" bullet is withdrawn.

States: `pending → sending (lease) → sent | retry | dead | unknown_outcome`.
- Created by the reconciler/staff actions with deterministic `dedupe_key`s: `inv:{request}:{generation}`, `rem:{request}:{appointment_starts_at_epoch}`, `otp:{challenge}`, manual resend includes the UI idempotency id.
- Claim via a leased RPC (`FOR UPDATE SKIP LOCKED`, owner-guarded completion, exponential backoff, `max_attempts`), following the PAY-WH-1 outbox [V: `20261116091000_paywh1_settlement_outbox.sql`].
- At claim, revalidate: request open (not suspended), appointment live and `starts_at` unchanged, no valid completion, entitlement active, invitation not revoked. Otherwise cancel the delivery.
- First claim freezes non-secret render inputs (subject, studio branding, appointment text) on the row. Every retry renders from the frozen inputs plus the re-derived token, so the payload is byte-identical.
- ~~Send directly through Resend with `idempotencyKey: intake-delivery:{id}`. No `outbound_deliveries` row is created for invitations.~~ **Withdrawn (§22):** intake emails are `outbound_deliveries` rows sent by the shared dispatcher with its stable key `outbound-delivery:{id}` [V: `lib/notifications/dispatch.ts`]; tokens stay out of the outbox because rows carry references only and the body is rendered at send time.
- Reminder: due at `starts_at − 24h` from the current anchor; skipped if the invitation was issued after the due time, if the request is not `invited`/`in_progress`, or if the appointment has started. A reschedule changes the key (`starts_at` epoch) and so schedules a new reminder; the old one is cancelled at revalidation.
- Provider guarantees [V: Resend documentation]: keys are kept 24 hours; length 1–256; same key with a different payload returns 409 `invalid_idempotent_request`; a concurrent in-flight request returns 409 `concurrent_idempotent_requests` and is safe to retry later; a duplicate within the window returns the original response and sends nothing. The documentation does not state how a key from a failed request behaves, so a 5xx or timeout is treated as an unknown outcome.
- Retry policy: retry with the same key and frozen payload for at most 12 hours from first attempt (half the provider window). A 409 payload-mismatch or an exhausted window ends in `unknown_outcome`: no automatic resend, shown to staff as "may or may not have been delivered", resendable as a new generation. `dead` and `unknown_outcome` rows raise a platform alert.
- Provider-accepted-but-unrecorded: lease expires, next claim retries with the same key and bytes, the provider returns the original message id, the row is marked `sent`.
- Residual: no Resend delivery webhook exists (Phase 11), so `sent` means provider-accepted.

## 4. Authorization

### 4.1 Staff
Predicates added to `lib/auth/permissions.ts`: configure (owner/admin), view status and send/resend (plus front desk), view answers (owner/admin; front desk operational sections only), attest guardian consent (owner/admin/front desk, auditable). Instructors reach intake only through a SECURITY DEFINER RPC modeled on `get_teaching_clients_for_instructor` [V], which derives identity from `auth.uid()`, checks assignment to the appointment, and returns only fields flagged `instructor_visible`. Guardian consent sections and staff-only fields are excluded. Field visibility (`staff_only`, `front_desk`, `instructor_visible`) is a property of the immutable template version.

### 4.2 Student and guardian
- Sessions carry an audience claim; RPCs read the audience from the session, never a parameter. A student session cannot read or write guardian data, and a guardian session cannot read the student's answers. The guardian sees only the student's name and appointment.
- Signed-in path: `resolvePortalRelationship` and `user_has_client_portal_access` [V] authorize students; linked guardians are authorized by the link type below.

### 4.3 Guardian consent assurance

| Level | Basis | Counts |
|---|---|---|
| L3 `link_verified` | Signed-in user with a `linked` guardian/parent link to the client, where the link was staff-initiated or came from an accepted staff invitation [G: confirm how such links are created] | Yes |
| L2 `email_code_verified` (**default**) | Code emailed to a guardian email different from the student's own, entered correctly within limits | Yes |
| L1 `declared_unverified` | Shared mailbox or unverified | No: `consent_pending_review` |
| L0 `staff_attested` | Authorized staff attest, with reason, method, guardian name and relationship; immutable event | Yes, labelled staff-attested |

Wording rule: the record and UI say "email verified" and "declared relationship (self-attested)". They never say "verified guardian" or "legal guardian confirmed". Legal guardianship is not determined by the system. The guardian's own attestation text (hashed and versioned) is stored with name, relationship, timestamp, IP, user agent and assurance level.

Challenge: code HMAC-derived from the challenge id (retries resend the same code), 10-minute expiry, 5 attempts, limits per request, email and IP, delivered through the shared outbox (§22): the outbox row references the challenge; the code is re-derived at send time and never stored in the delivery record. Guardian email is supplied by the student's section or taken from a verified link; the system never infers it.

Not granted: nothing writes to `client_account_links`, and `can_sign_documents` is never changed. Test: link rows and flags are identical before and after guardian completion.

### 4.4 Documents Center
- Intake never creates a second signing engine.
- `requestDocumentForSubject` runs only from an authenticated intake session, for the pinned template version and the request's client, with one signer (the verified guardian email, or the adult student).
- It writes a code-defined signature block (signature, printed name, date), so no staff field placement is needed.
- Handoff uses `context_type='student_intake'` with the allowlisted `return_url` pattern [V: `lib/documents/event-signing.ts`].
- All existing sign controls remain: rate limiting, expiry, consent text, the Phase 8A re-read of the assignment, hashes, certificate, and the completed-event evidence. Signing evidence adds `declared_relationship`, `declared_via:'intake'` and the assurance level in event metadata (JSON; no schema change).
- Entitlement boundary: the signature step requires `documents`. The builder offers it only when both entitlements are active.

## 5. Security

### 5.1 Token design
- Root secret `INTAKE_ROOT_SECRET` (not provisioned) → HKDF-SHA256 (RFC 5869) subkeys with fixed `info` labels: `intake/invitation/v1`, `intake/otp/v1`, `intake/session/v1`. Distinct keys give purpose separation.
- `token = {kid}.{base64url(HMAC-SHA256(subkey, domain ‖ invitation_id(16B) ‖ generation(u32) ‖ token_salt(16B)))}`. Fixed-width binary encoding avoids concatenation ambiguity. `token_salt` is random, stored on the row. A leaked database cannot mint tokens without the key; a leaked key cannot mint tokens without the salts. Output is 256 bits.
- Only `sha256(token)` is stored; lookup is by hash, so verification needs no key. Retry re-derives the identical token from the key and row.
- Rotation: new `kid` for new invitations; old keys are kept only until in-flight deliveries finish (hours). Old issued tokens keep working until expiry because verification is hash-based. Root-key compromise runbook: rotate, bump every open invitation's generation, revoke older ones, re-issue where appropriate.
- Replay and revocation: each use re-checks not revoked, current generation, not expired, request open (not suspended), appointment live. Invalid, expired, revoked and suspended produce one identical response. Tokens are multi-use until expiry; sessions are short with a sliding and an absolute limit. After submission the link shows only a generic completion page.
- Resend rotates the generation and revokes the previous invitation. Cancellation suspends the request and the live check blocks access immediately; reactivation or rebook issues a new generation.

### 5.2 Link handling
- Link form: `https://…/intake#t=<token>`. The fragment is not sent to servers, is not in `Referer`, and is not recorded in server request logs or path-based analytics. Page script POSTs it to an exchange endpoint, receives a `__Host-` HttpOnly Secure session cookie, and clears the fragment with `history.replaceState`.
- Mail scanners and link prefetchers that fetch the URL receive no token and consume nothing.
- Origin and session-bound CSRF checks on exchange and save endpoints (route handlers have no origin check today [V]). `noindex`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `/intake` added to `robots.ts` (today only some paths are disallowed [V]).
- **Provider click tracking:** Resend tracking is configured per domain and rewrites links through a tracking subdomain; it is off by default and there is no per-email control [V: Resend documentation]. If tracking is ever enabled on the sending domain, intake links would be rewritten and logged at the tracker. Invariant: the intake sending domain must have click and open tracking off. This conflicts with a possible future Marketing analytics setting on a shared sending domain, so a startup check or CI check of the domain flags is required [G].
- **Fragment behavior across clients:** design relies on fragments surviving Outlook Safe Links-style wrapping, Gmail, Apple Mail, in-app browsers and 30x redirects (a redirect whose `Location` has no fragment preserves the original fragment). This has not been tested; it cannot be verified from the repo and no email may be sent without authorization. It is an I0 gate with a test plan (§7). Fallback if the fragment is lost: the page explains the link is incomplete and offers an enumeration-safe "send me a new link" (generic response, rate-limited, only to the address on file).
- Logging: allowlist only (delivery id, status, attempt). Never URLs, tokens, codes or email bodies. Residual, to be disclosed: the email content exists at the mail provider and in the recipient mailbox; expiry and revocation bound the exposure.

### 5.3 Rate limiting
DB-backed buckets (not the in-memory limiter [V: `lib/security/rate-limit.ts` is per-instance]): per token hash, per IP alone, per email, per request. Fail closed on error. Trusted client-IP source must be confirmed for Vercel [G].

### 5.4 SQL privilege model (RPC-only writes)

Compatibility analysis:
- `service_role` is an ordinary role with `BYPASSRLS`. RLS does not apply to it, but table privileges (GRANTs) are checked first, so revoking them is effective and supported [V: Supabase/Postgres documentation, third-party summaries; confirm in DEV]. The repo already grants `service_role` explicitly per table and revokes function execute from `public, anon, authenticated` [V: `20261116091000`], so the revoke pattern is established.
- Migrations run as `postgres`, which owns the objects. The owner is not subject to revoked grants. SECURITY DEFINER functions run as the owner, can write the tables, and require `set search_path` pinned (repo uses `public, pg_temp` [V]; schema-qualify names).
- Functions default to EXECUTE for `PUBLIC`; every function revokes from `public, anon, authenticated` and grants only what its class needs.
- Default privileges on new tables in `public` may auto-grant to `anon, authenticated, service_role`; the migration must revoke after `CREATE TABLE`. `pg_default_acl` must be checked [G]. Backup/restore (ACLs included in dumps) and PITR preserve grants.
- Triggers fire for the owner too, so immutability holds for every role. Break-glass: the owner role, in a reviewed and logged session, may disable a named trigger or use the redaction RPC. No application path uses it.
- Tables stay in `public` (repo convention). With all API-role grants revoked they are unreachable through PostgREST; a separate unexposed schema is an alternative that I do not recommend because it diverges from tooling.

Privilege matrix:

| Object class | anon | authenticated | service_role | owner (postgres) |
|---|---|---|---|---|
| Answer tables (`intake_responses`, `_revisions`, `_respondents`, `_minor_determinations`, `_completions`) | none | none | none (RPC only) | all |
| Operational tables (`intake_requests`, `_invitations`, `_sessions`, `_challenges`, `_events`, `_reconcile_failures`, `_rate_limits`) | none | none | SELECT only | all |
| Template/settings tables | none | none | SELECT only | all |
| Service RPCs (reconcile, ensure_request, issue invitation / challenge **with its `outbound_deliveries` row in the same transaction**, send-time revalidation, session and draft save, submit, redact) | none | none | EXECUTE | all |
| Shared outbox (`outbound_deliveries`, `claim_outbound_deliveries`) | unchanged by intake (M-0 owns its grant state) | unchanged | unchanged | — |
| Staff RPCs (status, scoped answers, attest, publish, instructor summary) | none | EXECUTE; in-body role check via `auth.uid()` | EXECUTE | all |

QA for this model:
- Catalog test of expected grants via `has_table_privilege` / `has_function_privilege` for each role, run in CI and after every deploy (drift detector).
- As `service_role`, direct `INSERT/UPDATE/DELETE` on every table fails with 42501, and `SELECT` on answer tables fails.
- RPC happy-path and negative tests for each role. SECURITY DEFINER functions all pin `search_path`.
- Immutability: updating a published version or submitted response fails for every role including `service_role` via RPC, except the redaction RPC.
- Restore drill on a DEV branch confirming grants and triggers after restore.
- New tables created later in the schema do not inherit API-role grants.

## 6. Entitlement and lapse

- **Owner correction 2026-11-23: Student Intake is not a separately priced feature or add-on.** No `BillingFeature`, plan requirement, paid entitlement, Stripe product or pricing change is introduced for it (the earlier plan to add `student_intake` to `BillingFeature` is withdrawn; none exists in code). "Entitlement" in this spec means the rollout control below: pilot grants govern development access, early availability and staged rollout only and are not monetization. Plan-comparison UI must not render intake as a priced item.
- Pilot access is only through `intake_feature_grants` (platform admin, expiring).
- Enforcement points: settings actions; reconciler and intake queueing RPCs (per studio, fail closed); the intake send-time renderer re-checks entitlement before every intake email (§22); Documents step (separate `documents` check).

| Surface | Entitled | Lapsed |
|---|---|---|
| Settings, builder, enabling, new requests, invitations, reminders, resend, manual requests, OTP sends | yes | blocked |
| Student/guardian completing an already-issued, valid link | yes | works until the link's own expiry; no entitlement lookup on this path |
| Staff reading existing requests and answers (role-scoped), redaction, export | yes | works, read-only for answers |
| Formal signing | needs `documents` | needs `documents`; envelopes already issued stay signable; intake answers still submit and the request shows `signature_pending` |

Completion and staff-read paths do no billing lookup, so a billing outage cannot lock out students or staff.

## 7. Implementation slices

| Slice | Content | SQL | Entry / exit |
|---|---|---|---|
| **I0** | **Verification only; no code, no SQL.** Close the gates in §8. | none | Exit: written gate report; owner accepts |
| I1 | Foundation, data core only (see `NSI_I1_Schema_Plan.md` §11): config/template/version tables, requests, responses, respondents, completions, consent and network evidence, retention and redaction columns, relationship state, guardian designations, legal-hold tables and enforcement function, audit events, export tables (tables only), non-destructive RPCs, privilege seal. **Not in I1:** invitations, sessions, OTP, rate limits (I3); deliveries and reconciliation failures (I4); destructive functions — redaction, purge, client erasure, evidence expiry, export generation (I6). Dark by default | yes | Exit: SQL tests green on DEV under real roles; privilege matrix and catalog self-check; appointments fingerprints unchanged |
| I2 | Entitlement key and grants, settings, builder, preview, publish, floor flag, service assignments, dry-run count | small | Exit: entitlement test; builder QA |
| I3 | Completion experience: fragment exchange, sessions, drafts, student/guardian sections, minor flow, OTP, staff "copy link" and attestation. No automated email | RPCs | Exit: browser and concurrency QA; fragment client matrix |
| I4 | Reconciler, intake queueing into the shared outbox (§22), intake send-time renderer, derived tokens, reminders, cancel/reschedule sync, surge hold, staff failure view | yes | Needs T1–T4 (§22.6), `INTAKE_ROOT_SECRET`, cron, Resend tracking-off verification, secure-link client testing, staff/instructor delivery-visibility decision. Flag stays off until QA |
| I5a | `requestDocumentForSubject` (Phase 8 follow-on, reviewed separately) | none expected | |
| I5b | Status chips, answers panel, instructor RPC, signature step | RPC | |
| I6 | Retention, redaction and export tooling, hardening, full QA, pilot, launch decision | maybe | Needs the §10 privacy decisions |

Dependencies: SMS reminders wait for TW-4. Intake email uses the shared transactional outbox (§22) and therefore depends on its release slices T1 (timezone consistency), T2 (transactional dispatcher reliability), T3 (branded intake templates and previews) and T4 (shared outbound SQL, after Marketing M-0 closes and its rollback window expires). Phase 12 per-user permissions are later; V1 uses fixed predicates and field visibility.

Roadmap placement (not edited): Phase 17-I, not in the v2.22 near-term priority table; delivery rides on the shared outbound pipeline (Phase 11 area) through T1–T4 (§22.6) rather than a separate intake outbox. I0 and I1–I2 share no files with M-0, CI-B/CI-D, Competition 10E/10F or TW-4 and could run as a parallel lane; I4 onward waits for the owner's priority call.

## 8. I0 gates (verification only)

Read-only DEV catalog queries unless noted; any PROD read needs separate authorization and the scratch-workdir rule.
1. Base DDL, columns, enums and indexes for `appointments` (`created_at`, `starts_at`, `client_id`, status enum, `(studio_id, starts_at)`, `(client_id)`), `clients`, `studio_settings`, `outbound_deliveries`.
2. Existing triggers/constraints on `appointments`, as a baseline fingerprint for the "unchanged" test.
3. Whether an appointment can be reactivated from `cancelled`, and by which path.
4. `pg_default_acl` and current `service_role` grants; confirm the revoke model in DEV.
5. How guardian/parent links reach `linked` (staff-initiated, staff invitation, or user claim) to define L3.
6. Resend: confirm the sending domain's open/click tracking flags (owner dashboard read); confirm SDK 6.12.x idempotency behavior; determine behavior of a key reused after a failed request in a sandbox only with explicit authorization.
7. Email-client fragment matrix: test plan using a dummy non-secret token and owner-approved test inboxes (Gmail web/app, Apple Mail/iOS, Outlook desktop/web with Safe Links, Yahoo, in-app browsers, plain-text rendering, a 30x redirect). Sending any email needs explicit authorization; until then this gate is open.
8. Vercel cron limits for a 5-minute route; `INTAKE_ROOT_SECRET` provisioning/rotation procedure (owner action).
9. Which Documents routes require the `documents` plan; trusted client-IP source on Vercel.
10. Plan-comparison UI behavior for an unlisted feature.

## 9. DEV/PROD migration considerations
- Additive only. No change to `clients` or `appointments`.
- Order: SQL first, then app; rollback app first, then SQL. Each migration has a rollback script, a `sql-tests` file and a preflight fingerprint, following the existing pattern (latest migration `20261116094000`).
- Pin from the repo, not from DEV. Base-table DDL is outside the repo, so every dependency on `clients`/`appointments` is confirmed against the live catalog in I0.
- LF-normalize function bodies and fingerprint the stored body (a CRLF issue occurred in 10D).
- Verify the privilege and trigger fingerprint after each environment apply.
- The feature flag and entitlement stay off in PROD until authorized.

## 10. Privacy and retention decisions (approved items moved to §14; the list below is what remained open and is restated in §14.9)
1. Retention basis and period for abandoned drafts.
2. Retention basis and period for submitted answers, and what starts the clock (last lesson, client inactive, studio-defined).
3. Retention for signature evidence (envelope, events, certificate), and whether it outlives answers.
4. Special handling and period for minors' data; counsel review of children's-privacy law applicability by age and jurisdiction.
5. Age of majority default and jurisdiction handling.
6. Whether to store raw IP and user agent versus hashes as consent evidence.
7. Controller/processor roles for studio-held intake data (studio as controller, DanceFlow as processor) and any DPA, privacy-policy and subprocessor (Resend) updates.
8. Deletion/redaction request process: who may request (student, guardian), who executes (studio staff), response timelines, and redaction semantics (answers nulled, hash and timestamps kept).
9. Legal hold concept and its owner.
10. Export: contents, format, and who can request (staff-run only, or student/guardian self-serve).
11. Treatment of intake data in the user's own account export and in account deletion (today neither covers studio-held data [V]).
12. Backups: retention of deleted/redacted data in backups.
13. Whether the default template may ever contain health or medical questions (default: none).
14. Client hard-delete behavior while evidence exists (proposed: blocked or archive; cascades destroy evidence today [V]).

## 11. QA requirements (developer-owned; BLOCKED, not PASSED, when unrun)

| Area | Required cases |
|---|---|
| Booking isolation | Pre/post `pg_trigger`/`pg_constraint` diff on `appointments` empty; no intake FK; appointment insert/update/delete succeed with `ACCESS EXCLUSIVE` held on every intake table; p95 latency unchanged |
| Reconciler | Qualifying, non-qualifying type, intro request without appointment, lead inquiry, returning client, past appointment never invited, recurring series (one request), enabled_at watermark, settle delay; crash mid-batch and rerun; two concurrent workers → one request; poison client does not block others; entitlement lookup failure → no sends; surge hold, alert, release |
| Versions | Publish with floor → zero requests; in-progress finishes pinned version; completion records its own version; older completion invalid for new floor; new obligation only for appointment created ≥ `floor_effective_at` or manual; manual re-intake preserves history; republish/archive during draft; two concurrent appointments → one open request |
| Lifecycle | Cancel → suspended, link dead (identical response), draft preserved; rebook/reactivation → new generation, same draft; hard delete; reschedule changes reminder key; <24h booking has no immediate reminder; incomplete intake never changes appointment status |
| Tokens/delivery | Derivation vectors; HKDF separation (a token for one purpose is rejected for another); salt and key-id behavior; rotation with in-flight retry; replay, revoked, rotated, expired; crash after provider accept → same token, same bytes, one email; 409 mismatch → `unknown_outcome`; retry cap; no token in logs, DB bodies or analytics; mocked Resend |
| Guardian | L2 flow and limits; shared-mailbox rejection → pending review; L3; L0 attestation audit; wording; links unchanged; student/guardian isolation both directions; Documents signing handoff keeps all sign controls |
| Authorization/privileges | Privilege matrix; cross-tenant; each role; assigned vs unassigned instructor; immutability for every role; restore drill |
| Entitlement | No plan lists the feature; each lapse row of §6; Documents lapse mid-flow |
| Leakage | No intake table referenced from ARIA, campaigns, AI actions; no writes to `clients.notes`, `dance_goals`, `referral_source` |
| Browser | Fragment exchange, no-JS fallback, resume on another device, concurrent tabs (revision conflict), mobile |

## 12. Remaining genuine owner decisions (see also §14.9)
1. Surge threshold default and who may release a hold.
2. Invitation link expiry (proposed: appointment end plus N days; N is the owner's).
3. Retention, privacy and legal items in §10, including the age-of-majority default.
4. Whether staff attestation (L0) is limited to in-person, or may include a verified phone call.
5. Whether verified linked guardians are invited automatically.
6. Priority: promote NSI into the near-term order, and whether I1–I2 may start as a parallel lane.
7. ~~Pricing tier for `student_intake`~~ withdrawn (owner correction 2026-11-23: no separate pricing). Release authorization remains a separate owner gate.
8. Pilot studio selection.

## 13. Explicit prerequisites for starting I1
1. Owner authorization to begin I0, and the I0 gate report accepted.
2. Written confirmation of the §10 items needed by I1's schema: retention parameter names, redaction semantics, raw-IP versus hash.
3. Live-catalog confirmation of `appointments`/`clients` columns and indexes the reconciler relies on, and of `service_role` privilege behavior.
4. Baseline fingerprint of `appointments` triggers/constraints recorded.
5. Owner decision on priority and an I1 slice authorization with its own QA matrix and release gates.
6. A DEV environment prepared for SQL tests under real roles, and Opus review of the privilege model and reconciler functions before DEV apply.

## 14. Approved privacy requirements (amendment; owner-approved, planning only)

Full field-level design, constraints, grants, RPC boundaries and QA gates are in `NSI_I1_Schema_Plan.md`. This section records the approved requirements and the architectural consequences.

### 14.1 Retention
- **Drafts:** retained 90 days after the end or cancellation of the currently associated qualifying appointment. Reattachment (reconciler-verified: live, qualifying, same client, created after the request) moves the anchor. A cancelled or stale appointment never extends retention; cancellation can shorten it. Expired links never delete responses. Drafts become purge-eligible after the deadline unless held. A platform draft hard cap is required to guarantee "not indefinite" and is open (§14.9).
- **Completed answers:** retained while the studio-client relationship is active; a studio-configurable post-relationship period starts when it ends; a platform maximum applies once approved. No numeric defaults are invented: unset values mean no automatic redaction. "Relationship active" is not `clients.status`; V1 ends a relationship only by an explicit staff action or client erasure.
- **Consent and signature evidence:** separate rows, separate clocks (`retain_until`, null until approved), independently expirable. Documents Center's existing envelope, event and certificate evidence is preserved and remains governed by Documents Center.

### 14.2 Consent evidence minimization
Stored by default: respondent display name and declared relationship, timestamp, exact acknowledgment text reference and published version, text SHA-256, assurance method, outcome, authorized actor, and an HMAC of the respondent email. Raw IP and user agent are **not** collected by default. A separate optional `intake_network_evidence` table exists only when a studio enables it with a recorded basis and a mandatory `retain_until`; it is excluded from every staff RPC. No tracking or analytics on intake forms.

### 14.3 Separated deletion concerns
Account deletion, relationship removal, client-record deletion, answer redaction and evidence retention are separate operations (plan §6). `RESTRICT` foreign keys on answer-bearing tables force client deletion through an erasure workflow that is hold-aware; evidence uses `SET NULL` with a retained subject display name. No indefinite archive is used as the default; archiving a client (the only app-level "delete" today) deletes nothing and starts no clock.

### 14.4 Legal holds
Scoped (client, request, response, evidence, envelope — never studio-wide in V1), with reason, basis, creator, releaser, effective/released timestamps, mandatory `review_due_at`, append-only event history, and enforcement by one function called from delete/redact triggers and every purge/redact RPC. No administration UI in I1; creator/releaser roles are open.

### 14.5 Exports (V1)
Staff-assisted, requester-verified, approval-gated, audited, expiring and access-controlled. Student scope: records about themselves. Guardian scope: the minor's student section and the guardian's own consent evidence while the student is a minor. Unrelated guardian data excluded by respondent and `subject_scope`. Signed documents via Documents Center. No front-desk or instructor export rights by default; no self-service account-free export.

### 14.6 Guardian routing
One verified guardian: invite automatically. Several with a designated primary: invite the primary. Several without: authorized staff must select. Never infer from query order, creation time or `is_primary`. Reassignment bumps a routing generation, revokes stale access, supersedes the prior respondent and preserves consent evidence. The existing `client_account_links.is_primary` is per user per studio and set only on `self` rows, and `client_relationships.is_primary` is an unverified CRM field, so neither is reusable: intake adds `intake_guardian_designations`, which references verified link rows and never modifies them.

### 14.7 Corrections to earlier text
- §2.2 table list and §7 I1/I3/I4 contents are superseded by plan §4 and §11.
- §4.3 L3 criterion also requires the link's studio and client to match and the designation rules of 14.6.
- §5.4 privilege matrix is superseded by plan §7 (answer and evidence tables have no `service_role` access at all; config tables are readable by studio staff through RLS).
- Responses carry `answers_hmac` (keyed) instead of a bare hash.
- Studio foreign keys are `RESTRICT` for intake tables (studio offboarding is an explicit procedure).

### 14.8 QA
The negative-test list in plan §12 is part of the required QA matrix (§11).

### 14.9 Unresolved (not decided; no legal conclusions made)
1. Numeric post-relationship default and platform maximum; draft hard cap; evidence and audit retention periods and bases.
2. Authoritative definition of relationship closure/inactivity.
3. Whether client-record deletion redacts answers immediately (recommended) or waits for the post-relationship period.
4. Jurisdiction-specific requirements for minors, including the age threshold.
5. Any legally necessary IP/device evidence and its basis.
6. Legal-hold creation, release authorization, review cadence.
7. Export approver roles, verification standards, jurisdictional restrictions.
8. Full name versus initials in retained evidence; policy-change retroactivity.

## 15. I1 security-review remediation (amendment, planning only)

The independent I1 schema review returned NO-GO with seven P1 findings. `NSI_I1_Schema_Plan.md` revision 2 supersedes revision 1 in full; its §12 matrix records each finding as **addressed in design, unverified**. Changes that affect this spec:

- **I1 creates 18 tables** (plan §2), not the earlier count. Generic feature grants move to I2; invitations, sessions, OTP and rate limits to I3; deliveries and reconciliation failures to I4; network evidence and exports to I6.
- **Retained records never hard-reference client-bound rows** (evidence, evidence identity, legal holds, audit). Live personal records use `RESTRICT` to `clients`; client erasure deletes them after hold checks (plan R1/R2). This supersedes §14.3's wording on evidence `SET NULL`.
- **No append-only table has a foreign key to `auth.users` or Documents rows.** The only auth FK is the allowlisted `intake_respondents.auth_user_id`, so `deleteDanceFlowAccount` keeps working (plan R3).
- **Consent evidence is split** into a non-identifying core and an identity table with separate, NOT NULL retention dates; evidence writes fail closed until periods are approved (plan §4.15–4.16). This supersedes §14.2's single-table description.
- **Retention values live only in `intake_retention_policies`**; settings point to the active policy. Platform maximums are a versioned SQL function returning NULL until approved.
- Definer functions use `search_path = pg_catalog, pg_temp` with schema-qualified names; staff RPCs take an explicit `p_studio_id` and verify an active role in that studio (supersedes §5.4 and §14.7 wording on studio derivation).
- New technical gates: PROD Postgres ≥ 15; realtime publication membership; Postgres parameter logging.
- Draft cap: proposed 180 days from first save, awaiting owner confirmation (plan §13.1).

## 16. I1 revision 3 (amendment, planning only)

`NSI_I1_Schema_Plan.md` revision 3 supersedes revision 2. All changes are design corrections, not verified implementation. Effects on this spec:

- **Draft retention (owner-approved; supersedes §14.1 and §15 wording):** 90 days after the end or cancellation of the associated appointment; normal maximum 180 days from first save; a legitimate future appointment is protected through its own subsequent 90-day window; repeated rescheduling cannot extend retention without explicit, audited staff approval; legal holds take precedence.
- **Erasure before personal writes:** `intake_erase_client` and the hold check ship in I1; the I3 slice may not write personal records until a platform-admin operator path is in place and tested. Interim hold authority is platform admin only, pending the owner decision.
- **Lock order:** one per-client advisory lock and a fixed row-lock hierarchy shared by every related function.
- **Function grants:** EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated` and `service_role` before class grants; internal helpers are granted to nobody.
- **Audit and hold records** carry retention classes and explicit pending-policy states; no periods are invented.
- **HMAC keys** are per purpose and per studio, versioned, application-side only; redaction removes answer HMACs.
- **Rollbacks** lock all intake tables exclusively before checking emptiness.
- **Migration order** is now config/helpers → governance (holds, audit) → live personal → retained evidence → functions; each boundary is tested on its own.
- The seven P3 findings of the Rev 2 review were not available in this session and remain open.

## 17. I1 revision 3 — P3 corrections F9–F15 (amendment, planning only)

`NSI_I1_Schema_Plan.md` §16 addresses the seven P3 findings. Design changes only, none verified. Effects on this spec:
- Documents templates used for intake signing must be studio-scoped and owned by the intake studio, resolved through `document_templates`; organizer and any non-studio scope are refused.
- Ownership of clients, guardian links, instructor assignment and Documents references is revalidated on every authorized read and write, not only at creation.
- Explicit capability matrix per role; organizer roles and `client` have no staff capability. Intake treats someone as platform admin only when both `profiles.platform_role` and an active `platform_admins` row agree, because the repo uses two divergent sources.
- Destructive-operation context is nonce-bound to one operation, studio and client, and is cleared before the function returns.
- Rollback is refused whenever any row exists in any of the 18 intake data tables; that same moment defines "first use".
- If a completed student intake later requires guardian consent, the student's answers and completion are kept and a guardian response is added to the same request; no duplicate questionnaire.
- Answer, schema, text and metadata size limits in the app and in database constraints.
- **Collection gate:** no personal intake record can be written until every required retention period (drafts, post-relationship or platform maximum, evidence core and identity, audit, hold records) is approved. The pending-policy states therefore cannot permit live data collection.
- Relation count: 18 data tables plus one internal unlogged helper table for the privileged-context nonce.

## 18. I1 revision 4 (amendment, planning only)

`NSI_I1_Schema_Plan.md` revision 4 supersedes revision 3 and addresses A1–A18. Design corrections only; none verified. Effects on this spec (they supersede conflicting text in §14–§17):
- **Retention authority:** approved periods (draft 90/180/90, evidence core and identity, audit, hold records, post-relationship platform maximum) come only from the migration-controlled `intake_platform_policy()`. Studios choose only a post-relationship duration up to the platform maximum. The collection gate reads platform values, so no studio input can open it.
- **Platform admin:** Intake uses `profiles.platform_role` only (RPCs and RLS). Reconciling `platform_admins` is a separate platform issue.
- **Operator actions:** erasure and holds are authorized inside the database; the actor is `auth.uid()`.
- **Completions are never updated.** Fulfillment (complete / guardian consent outstanding / incomplete) is derived from the latest minor determination and a separately submitted guardian response with evidence.
- **Destructive changes** run in functions owned by a restricted `intake_destructive` role; the Rev 3 helper table is removed (fallback documented if role gates fail).
- **Collection gate** covers every personal-data insert in every slice (including invitations, challenges, deliveries, exports) and is enforced by table triggers; erasure, redaction, account deletion, holds and audit are exempt so deletion rights are never blocked.
- Tenant and ownership references are immutable after insert; `independent_instructor` has no intake access in V1; assigned `instructor` role only, assignment-scoped.
- 18 tables; 100 test IDs (94 active); technical gates G1–G10.

## 19. I1 revision 4.1 (amendment, planning only)

`NSI_I1_Schema_Plan.md` revision 4.1 applies the final review's bounded corrections (design only; not verified):
- **Collection gate split (N1):** platform retention approval (Gate A) is required for every personal-data write; studio enablement and entitlement (Gate B) only block new obligations and outreach. Already-issued intake stays completable after entitlement lapse, as §6 requires.
- **Erasure barrier (N3):** after an erasure is recorded, no new intake record (including reconciler-created requests) can be written for that client until an audited platform-admin release. Erasure and client deletion are not assumed to share a transaction.
- **Environment marker (N6):** one database-wide first-use marker with no studio dependency; it survives offboarding and purges and keeps destructive rollback refused permanently.
- **Private schema (P3-a):** destructive implementations owned by the restricted role live in a non-exposed schema behind authenticated, authorized public wrappers.
- **Least privilege (P3-c):** no direct `service_role` access to any intake table.
- Documented for later: database-side entitlement before collection (N2); relationship-based instructor access covering Hybrid Instructors, not a role name (N4, I5); guardian assurance pinned to each consent (N5); role recovery and post-restore erasure checks (P3-b, before PROD).
- Postgres 17.6 previously observed on DEV (2026-10-13) and PROD (2026-10-12); fresh check before the PROD migration.

## 20. I1 revision 4.2 (amendment, planning only)

- The restricted `intake_destructive` role architecture is kept; the fallback is not used.
- PostgreSQL 17.6 gives the creating role only `ADMIN` on a new role, so M1 grants `intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE`.
- Role-owned implementations in `intake_private` are created, granted and (on rollback) dropped while acting as the role (`SET LOCAL ROLE`); `ALTER FUNCTION … OWNER` is not used because it breaks re-runs and drops the wrappers' EXECUTE grant.
- Local disposable rehearsal: G7, G8 and G10 PASS (33 SQL + 14 API tests). Hosted read-only preflight on DEV found no blocker (`postgres` has `CREATEROLE`; same PG17 self-grant behavior; role name not reserved by supautils; SET-only membership already used by the platform) but cannot prove hosted role DDL works. Hosted-branch rehearsal, G2 and G9 remain.

## 21. I1 revision 4.3 — hosted rehearsal closeout (amendment, planning only)

- The restricted-role design passed G7, G8 and G10 on a temporary standalone hosted Supabase project (PostgreSQL 17.11): role creation with explicit `SET TRUE, INHERIT FALSE` membership, repeatable setup (three identical fingerprints), private-schema ownership, RLS and least privilege (33 SQL checks), and 14 API checks covering admin allow, user/anon/service-key denial, forged and spoofed identity rejection and correct actor attribution. The project was deleted the same day. Local evidence (17.6) passed the same suites. DEV/PROD run 17.6; the first real 17.6 hosted exercise is the authorized I1 DEV apply.
- **Confirmed default-grant risk:** a table created on hosted Supabase without revokes immediately received full privileges for `anon`, `authenticated` and `service_role`. Rule R25: every intake table and callable function is revoked, granted, RLS-enabled and catalog-checked in the migration that creates it.
- The 18-table design, the restricted role and the Hybrid Instructor capability model are unchanged.
- Implementation breakdown: `NSI_I1_Implementation_Plan.md` (M1–M5, DEV gates D-0 to D-6, rollback gates, owner confirmations, PROD G2/G9). Evidence: `rehearsal/` (no credentials).
- The DEV branching and `supabase_migrations` artifacts from the preview-branch attempt are a separate cleanup requiring its own authorization.

## 22. Delivery architecture: shared transactional outbox (owner decision 2026-10-14, Option A)

Decision: the T0 audit verified that DanceFlow's existing `outbound_deliveries` pipeline can carry New Student Intake email. The owner approved **Option A — reuse the shared transactional outbox**. This section replaces the separate intake outbox (`intake_deliveries`) described in earlier sections and revisions. Documentation and design only; no SQL, code or environment change is authorized by this decision.

### 22.1 Architecture rules [S]
1. **One outbox.** Intake email (invitations, reminders, verification codes, staff-triggered resends) is delivered through `outbound_deliveries` and the existing dispatcher. No `intake_deliveries` table, worker or claim function is built.
2. **Separation of concerns.** Intake business orchestration (who is owed an invitation, when a reminder is due, whether a request is still open, token and code derivation, rendering intake content) lives in intake code and intake RPCs. The generic delivery worker stays generic: it claims, leases, sends and records outcomes, and calls a registered per-`template_key` renderer. It contains no intake rules.
3. **Transactional queueing.** The intake RPC that creates an invitation (or challenge, or due reminder) inserts its `outbound_deliveries` row **in the same database transaction**. Either both commit or neither does; there is no "invitation without delivery" or "delivery without invitation" state.
4. **References only in the outbox.** Delivery rows never contain invitation tokens, verification codes, intake answers or a rendered body (`body_html` stays NULL for intake keys). The payload carries only non-secret references (studio, request, invitation or challenge id, generation, audience, kind).
5. **Render at send time.** The intake renderer re-reads the referenced rows, re-derives the token or code from `INTAKE_ROOT_SECRET` and the stored salt (§5.1), and renders the branded email in memory. Retries re-derive the identical token and identical bytes.
6. **Stable provider idempotency.** The dispatcher's existing key `outbound-delivery:{id}` is used for every attempt of a row, so a retry after a lost provider response cannot send a second email. The Resend facts in §3.5 still apply (24-hour key window; 409 on payload mismatch → `unknown_outcome`, no automatic resend; a new generation is a new row).
7. **Unsupported keys are skipped, never sent generically.** If the dispatcher meets an intake `template_key` it has no renderer for (or the renderer is disabled), it marks the row skipped/failed with a reason and sends nothing. It never falls back to a generic message or a stored body.
8. **Revalidate before sending.** Immediately before each send the renderer checks: request still open and not suspended; appointment still live and its start unchanged (for reminders and appointment-bound invitations); invitation not revoked and still the current generation; challenge unexpired and unconsumed; studio entitlement active and intake enabled where the kind requires it (Gate B); collection gate open; erasure barrier not active. Any failure cancels the row with a reason; nothing is sent.
9. **Correct sender identity.** Intake email is client-facing and uses the studio-specific sender identity resolved by the dispatcher's existing client-facing path (studio display name and reply routing), never the DanceFlow system sender. Intake keys must be registered as client-facing (and transactional) in T3, since the dispatcher falls back to the system sender for unregistered keys [V: `lib/notifications/dispatch.ts`].
10. **M-0 unchanged.** Marketing M-0's `claim_outbound_deliveries` (and its freeze behaviour) is not modified. Intake keys are classified transactional, never commercial, so the M-0 freeze does not hold them.
11. **Claim-by-ID later.** A claim-by-ID function (to dispatch a just-committed intake row immediately instead of waiting for the next batch claim) is added only in the T4 shared-outbound SQL slice, after M-0 closes and its rollback window expires.
12. **Tenant isolation and role-scoped visibility.** Every intake delivery row carries its `studio_id`; queueing RPCs derive it from the request, never from caller input. Staff visibility of intake delivery rows follows the role rules of §4; whether front desk and instructors may see intake delivery rows (and with what fields) is a pre-I4 decision (§22.6).

### 22.2 Template keys (provisional names; registered in T3)
`intake_invitation_student`, `intake_invitation_guardian`, `intake_reminder_student`, `intake_reminder_guardian`, `intake_email_code`. Staff resend creates a new invitation generation and a new row with the same key family. All are transactional.

### 22.3 Product defaults [S]
- The guardian invitation email **omits the student's name** (it names the studio and says a family member's intake needs a guardian).
- Guardian reminders are sent **only for incomplete guardian obligations** (guardian consent outstanding); never to a guardian whose part is done.
- Staff submission and exception notifications are **in-app by default** (no email).
- A completion acknowledgment email to the student or guardian is **deferred** (not in V1).
- **No ARIA outbound intake emails**: ARIA does not compose, send or schedule intake mail.
- Intake mail is **transactional**: it is not a marketing campaign, carries no marketing unsubscribe semantics, and never enters marketing audiences or suppression lists.

### 22.4 What changes elsewhere
- The I1 foundation (applied to DEV) is unaffected: it creates no delivery table.
- I3 deferred tables are unchanged except that `intake_deliveries` is removed from the I4 list; `intake_invitations` and `intake_email_challenges` remain intake tables and are the rows outbox entries reference.
- The collection gate and Gate B still apply: the queueing RPCs enforce them (they insert the invitation/challenge, which carries the gate triggers, in the same transaction as the outbox row), and the renderer re-checks them at send time.
- Logging rule (§5.2) unchanged: delivery id, status and attempt only; never URLs, tokens, codes or bodies.

### 22.5 Security backlog item (separate from NSI) — SB-OUTBOX-1
Staff access to **stored transactional email bodies** in `outbound_deliveries` (`body_html` of existing templates) and to **bearer document-signing links** (`/sign/[token]`) that existing emails may contain. Review which roles can read stored bodies, whether bearer links are stored in bodies, and whether they should be rendered at send time like intake. Intake avoids the problem by storing no body; the existing templates are out of NSI scope and need their own review and authorization.

### 22.6 Release dependencies and gates
| Gate | Content | Blocks |
|---|---|---|
| T1 | Timezone consistency for scheduled and rendered times | reminders, I4 |
| T2 | Transactional dispatcher reliability (leases, retries/backoff, dead-letter, stable idempotency, skip-unsupported-key) | all intake email, I4 |
| T3 | Branded intake templates, renderers and previews | I4 |
| T4 | Shared outbound SQL (claim-by-ID, any outbox column/index additions) — **only after Marketing M-0 closes and its rollback window expires** | I4 |
| Pre-I4 | Resend tracking verification on the sending domain (open/click off); secure-link (fragment) testing across email clients; decision on staff/instructor visibility of intake delivery rows | I4 |
| Separate | SB-OUTBOX-1 (§22.5) | not NSI-blocking |

**No Intake transactional email may be queued or sent in any environment while the Marketing M-0 release dependencies remain open.** This covers invitations, reminders, verification codes and staff resends. The M-0 dependencies are: the conditional freeze release (Gate 1 pending), its 24-hour integrity review, M-0 close-out, and expiry of the M-0 rollback window. T4 (shared outbound SQL, including claim-by-ID) and every intake `outbound_deliveries` producer come only after that close-out. Reason: until then a rollback target without the T2 "skip unsupported key" behaviour (the M-0 rollback-compatible build) could still be promoted, and T4 changes the outbox objects M-0 fingerprints. (Recorded with the I1 DEV closeout, `NSI_I1_Implementation_Plan.md` §9.12–§11.)
