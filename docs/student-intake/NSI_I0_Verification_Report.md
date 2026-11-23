# NSI V1 — I0 Verification Report

| | |
|---|---|
| Scope | Read-only technical verification (I0). Companion to `NSI_V1_Engineering_Spec.md` (untracked, unchanged). |
| Reference | Canonical `origin/main` = `13c4d547f5494a8bf75fc472b5d4b48a1f1440f9` (Marketing M-0 #218 merged). The isolated worktree was moved from `85ab15ef` to this commit (detached; the untracked spec is preserved). Nothing was committed. |
| DEV | Supabase project `epdrtzcydvnoidwrepqz` ("ConfiDance Saas"). Confirmed three ways: `supabase/.temp/project-ref`, `supabase projects list` (linked marker), and the query ran against the linked project. PROD is `hvsujyfbftfffxpfmlpb` and was not queried. |
| Method | `supabase db query --linked` with SELECT / EXPLAIN (no ANALYZE) against `pg_catalog`, `information_schema` and aggregate counts only. The session role is `postgres` and the session is not read-only, so safety rested on query content: no DML, DDL, function calls with side effects, or row-level data. DEV holds 28 appointments and 20 clients, so no volume conclusions can come from it. |
| Not done | No email, no Resend call, no secret read or provisioned, no SQL applied, no PROD access, no M-0 interference. |

## 1. Results at a glance

| Gate | Status |
|---|---|
| G1 Appointment fields and lifecycle for reconciliation | **Closed** (with one scale caveat, G6) |
| G2 Triggers, constraints, baseline fingerprint | **Closed** (fingerprint recorded) |
| G3 Roles, grants, ownership, default privileges | **Closed** (important findings below) |
| G4 RPC-only write model compatibility | **Closed for DEV; a PROD/DEV drift check remains** |
| G5 Guardian link criteria for L3 | **Closed** (criteria defined; no guardian/parent rows exist in DEV to exercise them) |
| G6 Query plans and scale | **Open**: explain-only on a 28-row table proves nothing about indexes |
| G7 Vercel cron and secret conventions | **Partly closed**: conventions known; plan limits and provisioning are owner actions |
| G8 Resend sending domain and click tracking | **Open**: not inspected (reason below). Owner checklist provided |
| G9 Fragment/email-client matrix | **Open**: plan prepared; no email sent |
| G10 Message-classification interaction (new, from M-0) | **Closed** |

## 2. Evidence

### 2.1 Appointments (G1, G2)

Columns present that the reconciler needs: `id`, `studio_id`, `client_id` (nullable), `appointment_type` (enum), `status` (enum), `starts_at`, `ends_at`, `created_at` (default `now()`), `updated_at`, `cancelled_at`, `confirmed_at`. Also present and previously unconfirmed: `source_system`, `source_external_id`, `imported_at`.

- Enums (DEV): `appointment_status` = scheduled, attended, cancelled, no_show, rescheduled, confirmed. `appointment_type` = private_lesson, group_class, intro_lesson, coaching, practice_party, event, floor_space_rental, room_unavailable.
- **Import exclusion is now possible:** the reconciler can skip rows where `source_system IS NOT NULL` or `imported_at IS NOT NULL`, removing the import-surge risk the first spec only mitigated with a cap.
- `client_id` is nullable (room-unavailable and similar rows have no client), so eligibility must require `client_id IS NOT NULL`.
- `appointments.client_id → clients(id) ON DELETE CASCADE`. Deleting a client deletes their appointments. Consequently the intake `RESTRICT` rule on evidence is the only thing that would stop a client delete from destroying lesson history together with evidence, and it must be tested against this cascade.
- **Triggers on `appointments`: 20** non-internal triggers (guards for floor rental, group-class series/cancel/capacity/reactivation/direct-write, attendance lifecycle, membership capacity and usage sync, instructor assignability, package deduction, rewards, `set_updated_at`, reminder cancel for group classes). None references intake. The only status guard for private lessons blocks changes away from `attended`/`no_show` (`enforce_private_lesson_attendance_lifecycle`). **A private-lesson `cancelled → scheduled` change is allowed by the database**; only group classes have a reactivation guard. I found no app path that does it (grep of `schedule/actions.ts` and `lib/schedule`), but because the database permits it, the stateless reconciler's re-evaluation each pass is the correct design.
- `appointments` has 20 inbound foreign keys (e.g. attendance, recaps, confirmation tokens CASCADE; payments, notifications SET NULL). The spec's "no foreign key from intake to `appointments`" holds the count at 20.
- Indexes: 12, all single-column or specialised (`studio_id`, `client_id`, `starts_at`, `instructor_id`, source lookup, series). **No composite `(studio_id, starts_at)` or `(studio_id, created_at)` index.** RLS is enabled, not forced; owner `postgres`.

**Baseline fingerprints recorded for the "unchanged by intake" test (DEV, 2026-10-14):**

| Object set | Count | md5 |
|---|---|---|
| `appointments` triggers (name + definition) | 20 | `bddcd28908fd62a84e93547862cc0cea` |
| `appointments` constraints | 18 | `190a5b05d0c84c9c80d545c9d5d962b3` |
| inbound foreign keys | 20 | `0b9689038baab1c0ce147265abec14a8` |
| `appointments` indexes | 12 | `92917889d27c1af9a36bf6ba44696b07` |

These are DEV values. PROD may differ and must be fingerprinted separately (read-only, separately authorized, scratch-workdir rule) before I1 apply.

### 2.2 Roles, grants, ownership (G3)

- `service_role`: `bypassrls = true`, not superuser, no login. `postgres` (the migration role): `bypassrls = true`, not superuser. `anon`/`authenticated`: no bypass.
- **Default privileges in `public` auto-grant `arwdDxtm` on every new table (and EXECUTE on every new function, USAGE on sequences) to `anon`, `authenticated` and `service_role`**, for objects created by `postgres` or `supabase_admin`. Therefore every intake migration must revoke explicitly after `CREATE TABLE` and after `CREATE FUNCTION`. A migration that forgets exposes the table to PostgREST for anon. The privilege-fingerprint test is therefore mandatory in CI and post-deploy.
- **Precedent for the intended model already exists in this database:**
  - `event_settlement_outbox`: ACL has only `postgres` and `service_role` (no `anon`/`authenticated`).
  - Select-only for `service_role` (and `authenticated`), writes via definer RPCs: `sms_consent_history`, `sms_contact_permissions` (migration `20261105090000` documents direct INSERT/UPDATE/DELETE revoked and `service_role`-only RPCs `record_sms_public_opt_in`, `record_sms_inbound_opt_event`), `competition_rules_profiles`, `event_competition_*`, `group_class_enrollment_holds`.
  - `group_class_series_edit_requests`: **no API-role grants at all** (owner only). This is the precedent for answer tables.
  - Definer function pattern: owner `postgres`, `search_path` pinned (`public, pg_temp` for the newer outbox/claim functions, `public` for older ones), `EXECUTE` revoked from public roles and granted to `service_role`.
- Corrections to the earlier report:
  - `consume_document_sign_rate_limit` is **executable by `anon` and `authenticated`**, not service-role-only. The bucket key is caller-supplied, so an anonymous caller can consume a bucket whose key they can compute. Low impact because keys are `sha256(tokenHash:ip)`, but intake must not copy this grant. Revoke from `anon, authenticated`.
  - `get_teaching_clients_for_instructor` and `user_has_client_portal_access` are executable by `authenticated` and `service_role` only (correct for staff-RPC class).
- Two definer functions in `public` have no pinned `search_path` (count query). Pre-existing, outside intake; it can be filed for later cleanup.
- DEV state of Marketing M-0 stage 2: `outbound_deliveries` still shows `anon`/`authenticated` write grants in DEV, so DEV is in M-0 stage 1 state (stage-2 lockdown not applied here). PROD is releasing M-0 and I did not touch it. Intake must not assume either state of `outbound_deliveries` privileges; it does not use that table.
- Extensions present: `pgcrypto`, `uuid-ossp`, `supabase_vault`, `pg_stat_statements`. No intake-named objects exist (`relname ilike '%intake%'` returned none).

### 2.3 RPC-only write model compatibility (G4)

- Technically compatible with Supabase: ordinary grants on an ordinary role; `service_role` bypasses RLS but not grants (confirmed by the precedent tables above, which are live).
- Ownership and migrations: all relevant objects are owned by `postgres`, which also runs migrations. Definer functions run as `postgres`. Triggers fire for every role including the owner, so immutability is not bypassable by `service_role` or the owner except by disabling a trigger as owner (the documented break-glass).
- Remaining compatibility checks for I1 (all testable on DEV once SQL exists):
  1. No application code path may call `.from('intake_*')` writes through the admin client; a repo lint/test should fail on that.
  2. `sql-tests` and e2e seed scripts run as `postgres` and so will not detect missing grants. Privilege tests must `SET ROLE service_role / authenticated / anon`.
  3. `supabase db reset`, branch creation and backup restore recreate ACLs from migrations/dumps; the post-restore fingerprint test covers this.
  4. Existing platform-admin and support tooling that reads with the service role will not see answer tables. That is intended; any such tooling needs a named staff/definer RPC.

### 2.4 Guardian links and the L3 criterion (G5)

Schema (DEV): `client_account_links` with `status` ∈ {unclaimed, invited, claim_pending, linked, disconnected, former_client, rejected, conflict}; `relationship_type` ∈ {self, guardian, parent, billing_contact, dependent_manager, dependent}; `initiated_by` ∈ {system, legacy_backfill, legacy_email_repair, studio, dancer, guardian}; constraint `linked ⇒ user_id NOT NULL`; `can_sign_documents` NOT NULL default false (trigger `client_account_links_self_signing_default`).

Code paths that reach `linked`:
- Studio invitation acceptance (`lib/student-identity/lifecycle.ts`): writes `status='linked'`, `initiated_by='studio'`, the invited email recorded, `can_sign_documents` via `signingPermissionWrite`: self signs; any new non-self row gets `false` unless staff explicitly grant. Acceptance requires a signed-in user whose verified email matches the invitation (`app/studio-invites/[token]`, from the earlier audit).
- Dancer checkout (`app/api/student/marketplace/.../checkout/route.ts`): writes `linked`, **`relationship_type: 'self'`, `initiated_by: 'dancer'`, `can_sign_documents: true`**.
- Legacy backfill/repair paths: `self` only (DEV rows confirm: `linked/self/legacy_*`).
- I found no code that creates a non-self link with `initiated_by` other than `'studio'`.

**L3 criterion (proposed):** `status = 'linked'`, `relationship_type IN ('guardian','parent')`, `initiated_by = 'studio'`, `user_id IS NOT NULL`, and `studio_id`/`client_id` match the request. Exclude `dependent_manager`, `billing_contact` and anything dancer-, system- or legacy-initiated. A staff-initiated invitation accepted by a matching verified email reflects a staff-vouched relationship plus control of that mailbox; it is still not legal proof, and the UI must say "link verified by studio".

Limits: DEV contains only 3 link rows (all `self`, or one studio `invited` self), so the guardian path could not be exercised against data. One open invitation per client is enforced by a unique index (`client_account_links_one_open_invitation_per_client`), so a second guardian cannot be invited while the first invitation is open; unique `(client_id, user_id)` means one link per user per client. Automatic guardian invitation (the provisional default) therefore sends to the linked account's email only after the link is `linked`, not via a new invitation row. It must not call `createOrRefreshClientInvitation`.

### 2.5 Cron, secrets, Resend (G7, G8)

- `vercel.json` defines 8 crons (notifications generate hourly / send */15, daily-digest, google-calendar-sync */30, aria-digest */15, aria-operations */30, document-operations hourly, event-cart-orders */5). A */5 cron already exists, so sub-hourly scheduling is in use; the plan's cron-count and interval limits are not verifiable from the repo (owner / Vercel dashboard). M-0 did not alter `vercel.json`. The intake worker would be the 9th.
- Secret conventions: environment variables read via `process.env` (`CRON_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SECRET_KEY`, …); names documented in `.env.example` (values not read by me); cron routes authenticate via `getCronAuthFailure`. A new `INTAKE_ROOT_SECRET` follows the same convention (Vercel env, name added to `.env.example` in I1/I4). `supabase_vault` is installed but the app does not use it for application secrets. Provisioning is an owner action; none was done. Note the roadmap's own history of key exposure during prior production verification (Phase 5 status note) is the reason I did not extract any key from `.env.local` or `.env.synthetic-prod.local`.
- **Resend (G8) not inspected.** The only credential access available is the application's `RESEND_API_KEY` in local env files. Using it would mean reading a secret from a file, and it may be a sending-only key. I judged that outside "existing access already authorized" and not worth the exposure risk. Repo evidence only: the sender is `notify@idanceflow.com` with a studio display name (`senderIdentity.ts`); no tracking settings are referenced anywhere in the repo. The roadmap (Phase 13) states that marketing and transactional mail use separate sender variables on one Resend account and that whether the live domains are actually separated is **unverified**; M-0's remit included sender-separation verification, so its outcome should be read before choosing the intake sending domain.
- **Owner checklist (dashboard, read-only):** in Resend → Domains, for the domain that will send intake mail: (a) open tracking off; (b) click tracking off; (c) no tracking subdomain configured; (d) confirm which domain marketing uses and whether it differs; (e) API key type for production (full vs sending-only); (f) confirm whether Resend's sandbox/test mode or a test domain is available for the future fragment test.

### 2.6 Query plans (G6)

Explain-only (no ANALYZE) of the reconciler enumeration (studio + future + qualifying status/type + `created_at` window + `source_system IS NULL`, order by `created_at`, limit 200) and the first-student history check (`client_id`, non-cancelled, qualifying types) returned sequential scans. With 28 appointments the planner correctly ignores indexes, so these plans are **not evidence** about production scale. Reasoning only: the enumeration can use `appointments_studio_id_idx` and filter, bounded by one studio's appointment count; the history check uses `appointments_client_id_idx`. Whether a composite index is justified depends on PROD volume. Decision for I1 planning: **do not add an index to `appointments` in V1.** Prove adequacy with a synthetic-volume test (for example 500k rows across 500 studios on the isolated QA stack) before I4, or with PROD statistics if the owner authorizes a read-only `pg_class.reltuples` / `pg_stat_user_tables` read.

### 2.7 Message classification (G10, new from M-0)

`lib/marketing/compliance/messageClassification.ts` classifies only template keys starting with `aria_execution_` or `automation_` (unknown keys within those prefixes fail closed to commercial). Every other key is operational. Intake invitation/reminder/OTP keys must not use those prefixes (use `student_intake_*`). Because intake sends directly rather than through `outbound_deliveries`, it never passes through the M-0 dispatch-boundary controls; that is correct for operational mail, but intake must reuse `resolveClientSenderDisplayName`/`sender.ts` and the studio-mode branded shell rather than reimplementing sender logic.

## 3. Test plan prepared, not executed: URL-fragment / email-client verification (G9)

Preconditions: owner approves the test domain/inboxes; the token is a dummy non-secret value; the landing page is a static test page that echoes only "fragment present: yes/no and length" (never the value) and logs nothing server-side. No email is sent until separately authorized.

Matrix (each cell: link opens, fragment survives, JS reads it, fragment cleared after exchange, back/forward and reload behavior):

| Axis | Cases |
|---|---|
| Mail clients | Gmail web, Gmail Android/iOS apps, Apple Mail (iOS/macOS), Outlook desktop (Windows/Mac), Outlook.com/web, Outlook mobile, Yahoo web/app, one corporate gateway with link rewriting (e.g. Safe Links) if available |
| Browsers | iOS Safari, Android Chrome, desktop Chrome/Edge/Firefox/Safari |
| Wrapping | direct link, client-rewritten link (percent-encoding of `#` as `%23` must be treated as a failure), in-app browser/webview, long-press "open in browser", copy-paste |
| Transport | HTTP→HTTPS and apex→www redirects (a 30x whose `Location` has no fragment must preserve it) |
| Failure modes | JavaScript disabled, fragment stripped, link truncated by plain-text wrap, link opened twice, link opened on a second device |
| Leakage checks | server access log contains no fragment; `Referer` on outbound navigation has no fragment; no analytics event contains the URL; Resend tracking off confirmed from the delivered HTML |

Pass criteria: ≥ the agreed list of clients preserve the fragment; failure shows the "request a new link" fallback and never an error containing the token. The matrix is only needed to start I3 (the completion experience), not I1.

## 4. Provisional V1 defaults: evaluation

| Default | Assessment |
|---|---|
| Surge hold 25 new invitations per studio per run | Feasible. Weakness: at a 5-minute cadence, 25 per run allows up to 7,200 a day and a slow trickle would never trip it. **Recommend adding a rolling 24-hour studio cap** (value for the owner). Hold applies to issuance only; obligations are still recorded |
| Expiry = appointment end + 7 days with a maximum lifetime cap | Feasible. A cap value is needed (proposal: 30 days from first issue, resend resets generation but not the absolute cap) — owner to set |
| Staff attestation in person only | Feasible; fits the audited-event design. Requires a permission (owner/admin/front desk) and a reason field |
| Auto-invite existing verified linked guardians | Feasible under the L3 criterion in §2.4, from the linked account's email, never through the invitation helper, never creating link rows. One caveat: with several linked guardians, send to all qualifying ones or only the primary (`is_primary`)? Needs one line from the owner |
| Age 18 pending legal review | Fine as a configurable setting; the setting must carry a "pending legal review" note in the admin UI until cleared |
| Pricing tier unassigned | `student_intake` stays in no plan. Confirmed `planHasFeature` is default-deny for unlisted features |

Unresolved retention and privacy questions remain unapproved (spec §10). None of the defaults above stores or implies a retention period.

## 5. Unresolved technical gates

1. **G6 scale:** index adequacy at production volume (synthetic-volume test, or authorized PROD statistics read).
2. **G8 Resend:** domain tracking flags, domain separation, key type (owner dashboard check).
3. **G9 fragment matrix:** requires authorized test sends; needed before I3, not I1.
4. **PROD parity:** fingerprints, default ACLs, trigger set and `outbound_deliveries` grant state must be compared on PROD read-only (separate authorization) before the first PROD apply.
5. **Vercel plan limits** for a 9th cron and */5 interval.
6. **Privilege tests under real roles** are only definable once SQL exists (first I1 deliverable).
7. **Client-IP source** for rate limiting on Vercel (header trust) — not checked in this pass.
8. **Documents plan gating of read routes** (which routes require the `documents` plan) — only the earlier code review exists; not re-verified.

## 6. GO / NO-GO

- **GO for I1 planning** (drafting the I1 slice authorization request: table list, migration split, privilege matrix, SQL-test plan, QA matrix, release gates). Evidence supports the architecture: no intake object exists, no appointment trigger is needed, appointment fields (including import markers) are sufficient, the RPC-only model has live precedent in this database, and the L3 criterion is definable.
- **NO-GO for I1 implementation / any SQL** until: (a) the owner authorizes the I1 slice and priority; (b) a PROD read-only fingerprint comparison is authorized and clean, or the owner waives it; (c) the §10 privacy fields that I1's schema needs are confirmed (retention parameter names, redaction semantics, raw IP vs hash); (d) the Opus review of the privilege model and reconciler functions is scheduled.
- **I4 additionally gated** on G6, G8 and `INTAKE_ROOT_SECRET` provisioning; **I3 additionally gated** on G9.

## 7. Addendum: findings relevant to the approved privacy requirements (read-only, DEV; reference main 13c4d547)

- **Client deletion today.** No hard-delete action exists in the app; `archiveClientAction` only sets `clients.status='archived'` (`app/app/clients/actions.ts:1261`). A DB-level `DELETE FROM clients` cascades widely: `clients` has 66 inbound foreign keys in DEV, including CASCADE on `appointments`, `client_account_links`, `document_assignments`, `document_signed_files`, `document_signature_audit_events`, `lesson_recaps`, `payments`, `sms_contact_permissions`; SET NULL on `document_sign_envelopes`, `document_signatures`, `sms_message_logs`, `notifications`, `event_registrations`; RESTRICT on `package_sales`, `package_refund_reconciliations`, `payment_arrangements`.
- **Documents evidence.** Envelope `client_id` is SET NULL, so signed envelopes (signer name and email), events (IP and user agent), values and signed PDFs survive client deletion; envelopes are deleted only with the studio (CASCADE). No retention, purge or hold columns exist on envelopes; `document_templates.retention_policy` exists and nothing reads it.
- **Primary guardian.** `client_account_links.is_primary` is unique per (user, studio) among linked rows and is set only on `self` rows (code comment, `app/app/clients/[id]/actions.ts:124`). `client_relationships` (types partner/spouse/parent/guardian/family, with `is_primary`) is client-to-client CRM data, unverified, empty in DEV, used only on the client detail page. Neither is an authoritative primary-guardian designation, so intake needs its own selection record.
- **Relationship activity.** `client_status` values are lead, active, inactive, archived, contacted, consultation_booked, converted, lost; link status separately has `former_client`. None defines relationship closure.
- **Corrections.** The spec's original 85ab15ef baseline is superseded by main `13c4d547` (re-fetched; unchanged since §1). No other I0 conclusion changed.
- Evidence gathered by catalog queries only; no data rows were read, and PROD was not queried.

## 8. Addendum: gates added by the I1 schema review (not yet checked)

These are read-only checks for DEV and PROD, to be run only under a new authorization:
1. **Postgres version on PROD ≥ 15** (DEV is 17.6). Required for `ON DELETE SET NULL (column)` on composite keys. *(Rev 4.1 update: PROD `hvsujyfbftfffxpfmlpb` was recorded as PostgreSQL 17.6 during the Phase 10C.5 PROD rollback-only rehearsal and parity check on 2026-10-12 (project release notes); DEV 17.6 was observed in §1 of this report on 2026-10-13. G1 is satisfied by those prior observations; a fresh read-only check is still required immediately before the PROD migration.)*
2. **Realtime publication**: whether `supabase_realtime` is `FOR ALL TABLES` or would include `intake_*` tables (`pg_publication`, `pg_publication_tables`).
3. **Postgres parameter logging**: `log_min_duration_statement`, `log_statement`, `log_parameter_max_length`, `log_parameter_max_length_on_error`, so RPC arguments carrying draft answers are not written to logs.
4. Platform-admin helper: `public.is_platform_admin()` exists in the repo migrations (`20260525_platform_admins_invites_rls_fix.sql`) [V]; confirm its live definition and grants on each environment.
5. Studio/client hard-delete dependencies: no application path deletes studios or clients [V]; e2e fixtures (`competitionFixture`, `marketingFixture`, `stripeTestModeFixture`) and SQL concurrency scripts do. They remain compatible for studios without personal intake rows; intake fixtures need an offboarding/erasure helper.

## 9. Addendum: gates added by I1 revision 4 (not yet checked)

Read-only checks under a new authorization unless marked as a disposable DEV rehearsal:
- G5: live `document_templates` scope constraint, `is_active`, and `document_template_versions.published_at` / `archived_at`.
- G6: counts of `profiles.platform_role = 'platform_admin'` versus active `platform_admins` rows (informational; Intake uses `platform_role`, which the repo's escalation-guard migration `20260918060000` describes as trusted by about 71 RLS policies and 10 functions).
- G7: whether the migration user can `CREATE ROLE` on DEV and PROD.
- G8: function ownership transfer and `TO <role>` RLS policies for a restricted role (DEV rehearsal in a disposable branch only).
- G9: whether Supabase backup/restore and branching preserve a custom role, its grants and function ownership.
- G10: `auth.uid()` inside a definer function owned by the restricted role, called through PostgREST with a user JWT.

## 10. Addendum: hosted restricted-role preflight (2026-10-14, read-only)

See `NSI_I1_Schema_Plan.md` §17.2. Two `SELECT`-only batches in read-only transactions on DEV `epdrtzcydvnoidwrepqz`: PostgreSQL 17.6; `postgres` has `CREATEROLE` (not superuser); `createrole_self_grant` empty; supautils active with Supabase-only reserved roles/memberships; `intake_destructive` absent and not reserved. No role, grant or ownership change was attempted. The Supabase CLI refreshes a short-lived credential for its own `cli_login_postgres` login role on each `db query --linked` call; that is platform behavior, not part of the inspected SQL.

## 11. Addendum: hosted rehearsal and DEV artifacts (2026-10-14)

- **Hosted rehearsal:** G7, G8 and G10 passed on a temporary standalone project (`fiurmeioieenkxiaynos`, PostgreSQL 17.11), deleted the same day; details in `NSI_I1_Schema_Plan.md` §18 and `rehearsal/`. It confirmed on hosted Supabase the §2.2 finding that new `public` tables receive full privileges for `anon`, `authenticated` and `service_role` by default.
- **DEV artifacts from the earlier preview-branch attempt (not part of I1; separate cleanup authorization):** branching is enabled on DEV (`main` branch record, 09:04:56Z), and `supabase_migrations.schema_migrations` exists with one `remote_schema` row (7,680 schema-only DDL statements; owner-only; no dependents). All other DEV fingerprints match the pre-branch baseline (roles 30, `public` tables 334, `public` functions 487, policies 730, `appointments` triggers `bddcd289…`). Future DEV baselines and the PROD parity check must exclude these two artifacts until they are cleaned up.
