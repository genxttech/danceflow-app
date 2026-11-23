# NSI V1 — I1 Foundation Schema Plan (revision 4.3)

| | |
|---|---|
| Status | **I1 as designed here is applied to shared DEV (2026-10-14, D-1…D-5; see the implementation plan §9.11).** Untracked, uncommitted. Roadmap v2.23, Phase 17-I. |
| Delivery decision (2026-10-14) | **Shared transactional outbox (Option A)**: intake email reuses `outbound_deliveries`; no `intake_deliveries` table is built. Details and release gates T1–T4: engineering spec §22. I1 tables are unaffected. |
| Baseline | `origin/main` = `13c4d547f5494a8bf75fc472b5d4b48a1f1440f9` |
| Revision 4.3 | Hosted rehearsal closeout: G7, G8, G10 **PASS on hosted Supabase** (standalone project, PostgreSQL 17.11) in addition to local (17.6); confirmed default-grant risk recorded as rule R25; implementation breakdown in `NSI_I1_Implementation_Plan.md`; evidence archived in `rehearsal/` (§18). Design unchanged: 18 tables, restricted role, Hybrid Instructor capability model. |
| Revision 4.2 | Post-rehearsal corrections: the restricted-role architecture is **kept** (no fallback). Role-owned implementations are created **as** `intake_destructive` after an explicit SET-membership grant; `ALTER FUNCTION … OWNER` is not used. Local rehearsal evidence and hosted preflight results in §17. |
| Revision 4.1 | Bounded corrections from the final Opus review of Rev 4 (no P0/P1): N1, N3, N6, P3-a, P3-c applied; N2, N4, N5, P3-b documented for later slices. Changes are inline and summarized in §16. Design only; not verified. |
| Revision | Rev 4 supersedes Rev 3 in full. It applies A1–A18 from the targeted Opus review of Rev 3 (one P1, seven P2, ten P3). F1–F15 corrections carry forward, amended where A-findings changed them. **Every correction is a design correction, not verified implementation.** Verification requires SQL, the §10 tests on DEV under real roles, closure of the §12 gates, and a final targeted Opus review. |
| Companions | `NSI_V1_Engineering_Spec.md` (§14–§18), `NSI_I0_Verification_Report.md` (§5, §7–§9) |
| Labels | [V] verified read-only in repo or DEV; [E] engineering design; [D] owner/legal decision; [G] technical gate |

## 0. Approved product and privacy requirements (preserved, not reopened)

- Reconciliation-first; no trigger, foreign key or index on `appointments`.
- A completion records the exact template version completed and is never modified afterwards.
- Guardian routing: one verified guardian → invite automatically; several with a designated primary → the primary; otherwise authorized staff select; never inferred from ordering, age or `is_primary`.
- Student and guardian permissions are separate.
- **Drafts:** expire 90 days after the end or cancellation of the associated appointment; normal maximum 180 days from first save; a legitimate future appointment is protected through its own subsequent 90-day window; rescheduling cannot extend retention without explicit, audited staff approval; legal holds take precedence.
- Completed answers retained during the active relationship, then the studio's permitted post-relationship period, capped by the platform maximum.
- Controlled client erasure; legally required consent evidence kept separately from questionnaire answers; evidence minimized.
- Staff-assisted, authorized exports; no account-free self-service export.
- Independent `student_intake` entitlement, disabled until approved.
- No automated purging in I1.
- No automatic sharing into marketing, ARIA or the client profile.

**Proposed V1 security baseline (from the brief; owner confirmation still pending, §13):** platform admins have no default permission to read answers; front-desk guardian selection is off unless the studio explicitly enables it; draft extensions are limited to owners and authorized admins; `independent_instructor` receives no studio-client intake access in V1.

## 1. Design rules

| Rule | Statement | Source |
|---|---|---|
| R1 | **Live personal records** may hard-reference `clients` (`RESTRICT`). **Retained records** (evidence, evidence identity, holds, audit) use soft references validated at insert and never hard-reference client-bound rows, `auth.users` or Documents | P1-1 |
| R2 | Redaction (client remains) nulls content, keeps rows. Erasure deletes all live personal rows in §5.3 order, then the client may be deleted. Archive deletes nothing | P1-1, F1 |
| R3 | No referential action targets an append-only or immutable row. The only `auth.users` FK is `intake_respondents.auth_user_id ON DELETE SET NULL` (allowlisted) | P1-2 |
| R4 | Intake-to-intake references are composite `(studio_id, x)`; nullable ones use `ON DELETE SET NULL (x)` (Postgres ≥ 15) | P1-3 |
| R5 | References to `clients`, `client_account_links`, Documents tables are validated for studio/client consistency at insert **and revalidated at use** | P1-4, F9, F10 |
| R6 | No silent permanent retention: a retention date is computed from **platform-approved** values, or the record carries an explicit pending state (audit, holds), or the write fails closed | P1-6, F5, **A1** |
| R7 | Rollback locks, checks eligibility, then drops, atomically; never after personal-data use | P1-7, F7, F13, **A10** |
| R8 | Non-personal config cascades from `studios`; personal and retained records `RESTRICT` | P2 |
| R9 | Erasure is usable before any slice writes personal records | F2 |
| R10 | One lock order (§8) | F3 |
| R11 | Every function's EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated`, `service_role` before its class grant | F4 |
| R12 | HMAC keys per purpose and per studio, application-side only | F6, **A15** |
| R13 | Every migration boundary is self-consistent and tested | F8 |
| **R14** | **Retention authority is the platform.** Approved periods come only from the migration-controlled function `intake_platform_policy()`. Studios choose only a post-relationship duration within the platform maximum | **A1** |
| **R15** | **One platform-admin source:** `profiles.platform_role = 'platform_admin'`, everywhere in Intake | **A2** |
| **R16** | **Database-enforced operator actions:** erasure and holds authorize inside the database and take the actor from `auth.uid()` | **A3** |
| **R17** | **Completions are immutable;** fulfillment is derived | **A4** |
| **R18** | **Destructive changes run as a dedicated restricted role**, not under a session flag | **A5** |
| **R19** | **Every personal-data insert, in every slice, passes the collection gate; deletion-rights operations never do** | **A6** |
| **R20** | **Tenant and ownership references are immutable after insert,** except the documented exceptions in §4.0 | **A7** |
| **R21** | **FC-1B1 / FC-1 preserved:** instructor access comes only from an actual host-studio teaching relationship (`instructors` row: same studio, active, `can_instruct = true`) assigned to the appointment — never from a role name, floor rental or independent status (amended by N4, §16.6) | **A8, N4** |
| **R22** | **Erasure barrier:** once an erasure is recorded for a client, no new intake record for that client can be inserted until an audited platform-admin barrier release | **N3** |
| **R23** | **Environment-scoped first-use marker:** one permanent marker per database, independent of any studio, never purged | **N6** |
| **R25** | **No reliance on default privileges (confirmed on hosted Supabase, §18.3):** every intake table, view, sequence and callable function is followed **in the same migration** by explicit `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, the intended class grants, RLS enablement for tables, and a catalog self-check that fails the migration if any intake object's ACL differs from §7 | **Hosted rehearsal** |
| **R24** | **Private implementation schema:** role-owned destructive implementations live in non-exposed schema `intake_private`; only `postgres`-owned public wrappers are callable | **P3-a** |

## 2. Table inventory and migration boundaries

**I1 creates exactly 18 tables and no helper table.** The Rev 3 one-time-code table is removed (A5). If the A5 role gates fail (§12), the documented fallback in Appendix A adds one unlogged helper table (19).

| # | Table | Class | Studio FK | Migration |
|---|---|---|---|---|
| 1 | `intake_settings` | config | CASCADE | M1 |
| 2 | `intake_studio_retention_choices` (renamed from `intake_retention_policies`; holds only the studio's post-relationship choice) | config, versioned | CASCADE | M1 |
| 3 | `intake_templates` | config | CASCADE | M1 |
| 4 | `intake_template_versions` | config, immutable once published | CASCADE | M1 |
| 5 | `intake_service_assignments` | config | CASCADE | M1 |
| 6 | `intake_legal_holds` | retained | RESTRICT | M2 |
| 7 | `intake_audit_events` | retained, append-only | RESTRICT | M2 |
| 8 | `intake_requests` | live personal | RESTRICT | M3 |
| 9 | `intake_request_appointments` | live personal, append-only | RESTRICT | M3 |
| 10 | `intake_respondents` | live personal | RESTRICT | M3 |
| 11 | `intake_responses` | live personal | RESTRICT | M3 |
| 12 | `intake_response_revisions` | live personal, append-only | RESTRICT | M3 |
| 13 | `intake_minor_determinations` | live personal, append-only | RESTRICT | M3 |
| 14 | `intake_completions` | live personal, **immutable** | RESTRICT | M3 |
| 15 | `intake_client_relationship_state` | live personal | RESTRICT | M3 |
| 16 | `intake_guardian_designations` | live personal | RESTRICT | M3 |
| 17 | `intake_consent_evidence` | retained, non-identifying, append-only | RESTRICT | M4 |
| 18 | `intake_consent_evidence_identity` | retained, identifying | RESTRICT | M4 |

Plus one database role, `intake_destructive` (NOLOGIN), and one non-exposed schema, `intake_private` (holds only role-owned function implementations; no tables), both created in M1 subject to gates G7–G10 (§12, §16.8). Still 18 tables.

**Deferred tables** (each obeys R1–R21 and the collection gate when built): generic feature grants (I2); `intake_invitations`, `intake_sessions`, `intake_email_challenges`, `intake_rate_limits` (I3); `intake_reconcile_failures` (I4; ~~`intake_deliveries`~~ withdrawn — intake email is queued in the shared `outbound_deliveries` outbox, spec §22); `intake_network_evidence`, `intake_export_requests`, `intake_export_artifacts` (I6).

| Migration | Contents | Depends on |
|---|---|---|
| M1 config, platform policy, helpers, role, private schema | schema `intake_private` (no `USAGE` for `anon`, `authenticated`, `service_role`; not in the PostgREST exposed schemas); tables 1–5; `intake_platform_policy()`; `intake_is_platform_admin()`; `intake_assert_staff()`; tenant helpers (clients, links, Documents); `intake_collection_allowed()`; role `intake_destructive` and its RLS policy pattern; version/floor/pin/immutability triggers; config RLS; revokes/grants | existing `studios`, `clients`, `client_account_links`, `document_templates`, `document_template_versions`, `document_sign_envelopes`, `profiles`, `user_studio_roles`, `instructors` |
| M2 governance | tables 6–7; `intake_is_held()`; `intake_audit_write()`; append-only/TRUNCATE guards; revokes/grants | M1 |
| M3 live personal | tables 8–16; R5/R20 triggers; collection-gate insert triggers; allowlist/immutability/delete guards (call `intake_is_held`); TRUNCATE guards; `intake_fulfillment_state()`; revokes/grants | M1, M2 |
| M4 retained evidence | tables 17–18; insert validation; collection-gate insert triggers; append-only/TRUNCATE guards; revokes | M1–M3 |
| M5 functions | staff RPCs, service RPCs, public wrappers `intake_erase_client` and `intake_release_erasure_barrier` (owner `postgres`) over implementations in `intake_private` (created while acting as `intake_destructive` under `SET LOCAL ROLE`, so it owns them; no `ALTER FUNCTION … OWNER`; §6.1), hold create/release, `intake_extend_draft_retention`, drift report, catalog self-check; revokes/grants | M1–M4 |

Revokes and grants are always in the same migration as the `CREATE`. Each file header lists its dependencies.

## 3. Conventions

- PK `uuid default gen_random_uuid()`; no sequences; every table has `unique (studio_id, id)`.
- `created_at timestamptz not null default now()`; mutable tables use existing `public.set_updated_at()` [V].
- Status columns `text` + `CHECK`; `appointment_type` uses `public.appointment_type` [V].
- Actor columns are plain `uuid` plus `actor_role` snapshot; **actors are always taken from `auth.uid()` inside the database** for staff and operator actions (A3); service paths record `actor_type = 'system'` or the verified session principal.
- Allowlisted `metadata` only; no personal content.
- **All functions, including trigger functions, set `search_path = pg_catalog, pg_temp`** and schema-qualify every object (A13).
- **HMAC (A15, F6):** application-side only; `K = HKDF-SHA256(INTAKE_ROOT_SECRET[kid], salt="danceflow-intake", info="intake/<purpose>/v1/<studio_id>")`. Defined purposes and consumers:
  - `respondent-email`: lets the app match a resend or verification request to an existing respondent without searching plaintext; nulled at redaction.
  - `evidence-identity-email`: proves which address was verified for retained consent; governed by identity retention.
  - `retained-ref`: pseudonymizes retained references at minimization (A16; used in I6).
  - **`answers_hmac` is removed** (no defined consumer).

## 4. Field-level schema

`col type` [N = nullable]; all tables also have `id`, `studio_id`, `created_at` unless stated.

### 4.0 Immutable references (A7) and exceptions
After insert, these never change (row trigger; tested): `studio_id` (all tables); `client_id` (tables 8, 10, 11, 14, 15, 16); `request_id` (9–14); `template_id` (4, 8, 14); `template_version_id` (11, 14); `respondent_id`, `audience` (11); `response_id` (12); `pinned_version_id` once set (8); evidence soft refs (17); `evidence_id` (18); hold `scope_type`, `scope_ref`, `client_ref` (6).
**Documented exceptions:** `intake_settings.default_template_id`, `intake_service_assignments.template_id` (config, same studio enforced by composite FK); `intake_requests.guardian_recipient_link_id` (routing change, audited, L1→L3 locked); FK-driven `SET NULL` on `intake_respondents.auth_user_id`, `.source_link_id`, `intake_guardian_designations.link_id`, `intake_requests.supersedes_request_id`; retained-reference minimization by `intake_destructive` (I6, A16); **`intake_audit_events.studio_id` is NULL for the single `environment_marker` row and only for it (N6, §4.8).**

### 4.1 `intake_settings` — PK `studio_id`
`enabled boolean not null default false`; `enabled_at N`; `minor_age_threshold smallint not null default 18 check (between 13 and 21)` (pending legal review); `default_template_id uuid N` (composite FK → templates `ON DELETE SET NULL (default_template_id)`); `active_retention_choice_id uuid N` (composite FK → table 2, `RESTRICT`); `front_desk_guardian_selection boolean not null default false` (A-baseline: off unless enabled by owner/admin); `draft_extension_admins_enabled boolean not null default false` (owners may always extend; admins only when true — definition of "authorized admin", pending §13); `min_guardian_assurance text not null default 'email_code_verified'`; `surge_threshold_per_run int not null default 25`; `surge_threshold_24h int N`; `invite_max_lifetime_days int N`; `updated_by uuid N`; `updated_at`.

### 4.2 Platform policy — `intake_platform_policy()` (function, not a table) (A1)
`SECURITY DEFINER`, owner `postgres`, `STABLE`, no parameters, returns one record. Values change only by a reviewed migration (which is the audit trail):
`policy_version int` (1); `draft_retention_days` 90; `draft_max_days` 180; `draft_protected_window_days` 90 (all three owner-approved); `post_relationship_max_days` NULL; `evidence_core_days` NULL; `evidence_identity_days` NULL; `audit_operational_days` NULL; `audit_security_days` NULL; `hold_record_days_after_release` NULL; `approved_basis_ref` NULL. **NULL means not yet approved.** Studios cannot change any of these.

### 4.3 `intake_studio_retention_choices` — versioned, append-only
`version int not null`; `effective_from not null`; `post_relationship_days int N` (null ⇒ use platform maximum); `platform_policy_version int not null` (snapshot at choice); `created_by uuid not null` (from `auth.uid()`). Unique `(studio_id, version)`. Insert RPC (owner/admin) refuses when the platform maximum is NULL or `post_relationship_days > post_relationship_max_days`. **Effective value at use** = `least(coalesce(post_relationship_days, max), max)`, re-evaluated against the current platform maximum (a later platform reduction applies automatically).

### 4.4 `intake_templates`
`name text not null`; `status check in ('active','archived')`; `reintake_floor_version int N`; `floor_effective_at N`; `created_by uuid`; `updated_at`. Floor only increases and must equal a published `reintake_required` version of this template.

### 4.5 `intake_template_versions`
`template_id` (composite FK `RESTRICT`); `version_number int not null`; `status check in ('draft','published','archived')`; `schema jsonb not null` (`octet_length(schema::text) <= 131072`); `schema_sha256 N` (not null when published); `max_answer_bytes int N` (computed at publish, A9; not null when published, `<= 262144`); `reintake_required boolean not null default false`; `document_template_version_ref uuid N` (soft; §5.2); `privacy_notice_version text N`; `published_at N`; `published_by uuid N`; `archived_at N`. Unique `(template_id, version_number)`; partial unique `(template_id) where status='draft'`. After publish only `published → archived`, `archived_at` change. Delete/TRUNCATE of non-draft rows refused.

### 4.6 `intake_service_assignments`
`appointment_type public.appointment_type not null check (in ('private_lesson','intro_lesson','coaching'))`; `template_id` (composite FK `RESTRICT`). Unique `(studio_id, appointment_type)`.

### 4.7 `intake_legal_holds` (M2)
`scope_type check in ('client','request','response','evidence','envelope')`; `scope_ref uuid not null`; `client_ref uuid not null` (soft; validated at creation); `reason text not null` (≤ 1000 chars); `retention_basis text not null`; `external_reference text N` (≤ 1000); `effective_at not null`; `review_due_at not null`; `created_by uuid not null` (`auth.uid()`); `released_at N`; `released_by uuid N`; `release_reason text N`; `record_state check in ('active','released_pending_policy','released_scheduled','metadata_minimized') default 'active'`; `record_retain_until N`; `metadata_minimized_at N`. Checks: release fields all-or-none; `record_state <> 'released_scheduled' or record_retain_until is not null`. Partial unique `(studio_id, scope_type, scope_ref) where released_at is null`; index `(studio_id, client_ref) where released_at is null`.

### 4.8 `intake_audit_events` (M2) — append-only
`event_type text not null` (allowlist); `actor_type check in ('student','guardian','staff','system','platform_admin')`; `actor_user_id uuid N`; `actor_role text N`; `request_ref`, `client_ref`, `object_type`, `object_ref`, `hold_ref` (soft, N); `metadata jsonb not null default '{}'` (`octet_length <= 4096`); `retention_class check in ('operational','security','erasure_record','legal_hold','environment_marker')`; `retain_until N`; `retention_state check in ('pending_policy','scheduled','held','permanent_marker') default 'pending_policy'`; `refs_minimized_at N`. Check `retention_state <> 'scheduled' or retain_until is not null`; `retention_class = 'environment_marker'` ⇔ `retention_state = 'permanent_marker'` and all `*_ref` null (no personal data). Audit writes are never gated and never fail closed.
**(4.1, N6)** `studio_id` is nullable on this table **only** for the marker: check `(retention_class = 'environment_marker') = (studio_id is null)`; partial unique index `on ((true)) where retention_class = 'environment_marker'` (at most one marker per database). The studio FK (`RESTRICT`) therefore never applies to the marker, so offboarding and studio deletion are unaffected. The marker is written once, by `intake_audit_write`, with `ON CONFLICT DO NOTHING`; delete, update and TRUNCATE of the marker are refused for every role including `intake_destructive`, and every purge, offboarding and minimization function excludes it. Erasure barrier records use `retention_class = 'erasure_record'` and carry `client_ref` (N3, §5.3).

### 4.9 `intake_requests`
`client_id` (FK `clients RESTRICT`; R5; immutable); `template_id` (composite `RESTRICT`); `status check in ('pending','invited','in_progress','suspended','submitted','expired','waived','cancelled_by_staff')`; `resume_status N`; `source check in ('auto','manual')`; `supersedes_request_id N` (composite FK `ON DELETE SET NULL (supersedes_request_id)`); `pinned_version_id N` (composite `RESTRICT`; set once; published; same template); `anchor_appointment_id uuid N` (soft); `issued_at`, `submitted_at`, `suspended_at`, `expires_at` (N); `platform_policy_version int N` (snapshot when retention fields are stamped).
**Removed (A4):** `requires_guardian`, `guardian_status` (were mutable duplicates of derivable state; see §4.15).
*Draft retention (approved rule; values from `intake_platform_policy()`):* `draft_first_saved_at N`; `draft_anchor_appointment_id N`; `draft_anchor_kind N check in ('appointment_end','appointment_cancelled')`; `draft_anchor_at N`; `draft_max_at N`; `draft_protected_appointment_id N`; `draft_protected_until N`; `draft_extension_count int not null default 0`; `draft_last_extension_by N`; `draft_last_extension_at N`; `draft_last_extension_reason text N` (≤ 1000); `draft_purge_after N`.
`draft_purge_after = least(draft_anchor_at + 90d, greatest(draft_max_at, coalesce(draft_protected_until, draft_max_at)))`; automatic protection once at first save for a legitimate future anchor, bound to that appointment's id and end time; further extension only via `intake_extend_draft_retention` (owners; admins when `draft_extension_admins_enabled`), audited; cancellation can only shorten. Checks as in Rev 3.
*Guardian routing:* `guardian_recipient_link_id N` (FK `client_account_links ON DELETE SET NULL`; R5); `guardian_recipient_basis N check in ('sole_verified','designated_primary','staff_selected')`; `guardian_recipient_selected_by N`; `guardian_recipient_selected_at N`; `guardian_routing_generation int not null default 0`; `updated_at`.
Indexes: partial unique `(studio_id, client_id, template_id) where status in ('pending','invited','in_progress','suspended')`; `(studio_id, status)`; `(client_id)`; `(studio_id, draft_purge_after) where draft_purge_after is not null`; `(studio_id, anchor_appointment_id) where anchor_appointment_id is not null`.

### 4.10 `intake_request_appointments` — append-only
`request_id` (composite FK `ON DELETE CASCADE`, never relied on: erasure deletes explicitly, A5); `appointment_id uuid not null` (soft); `attached_by check in ('reconciler','staff')`; `attached_by_user N`; `detached_at N`. Unique `(request_id, appointment_id)`.

### 4.11 `intake_respondents`
`request_id` (composite `RESTRICT`); `client_id` (FK `RESTRICT`; equals request's); `role check in ('student','guardian')`; `display_name text not null` (≤ 200); `email text N`; `email_hmac N`; `email_hmac_kid smallint N`; `declared_relationship N check in ('parent','legal_guardian','other_authorized')`; `auth_user_id N` (FK `auth.users ON DELETE SET NULL`); `source_link_id N` (FK `client_account_links ON DELETE SET NULL`; R5); `assurance check in ('link_verified','email_code_verified','declared_unverified','staff_attested')`; `assurance_at not null`; `superseded_at N`; `redacted_at N`. Mutable allowlist: `email`, `email_hmac`, `email_hmac_kid` → NULL (redaction, by `intake_destructive`); `auth_user_id`, `source_link_id` → NULL (FK action); `superseded_at`; `redacted_at`.

### 4.12 `intake_responses`
`request_id` (composite `RESTRICT`); `client_id` (FK `RESTRICT`); `audience check in ('student','guardian')`; `respondent_id N` (composite `RESTRICT`); `template_version_id not null` (composite `RESTRICT`; equals request pin); `status check in ('draft','submitted','superseded')`; `revision int not null default 1`; `answers jsonb N` (`jsonb_typeof = 'object'`, `octet_length(answers::text) <= 262144`); `submitted_at N`; `last_saved_at not null`; `retention_state check in ('active','clock_running','clock_pending_policy','redaction_due','redacted') default 'active'`; `platform_policy_version int N`; `retention_choice_id N`; `notice_version N`; `answers_redact_after N`; `redacted_at N`; `redacted_by N`; `redaction_reason N check in (...)`. Checks: `retention_state <> 'clock_running' or answers_redact_after is not null`; `redacted_at is null or answers is null`. Partial unique `(request_id, audience) where status in ('draft','submitted')`.
**Insert rule (A4):** a guardian response may be inserted into a request whose `status = 'submitted'` only when `intake_fulfillment_state(request_id) = 'guardian_consent_outstanding'`; any other insert into a submitted request is refused. Submitted rows change only by redaction (`intake_destructive`).

### 4.13 `intake_response_revisions` — append-only
`response_id` (composite `RESTRICT`); `revision int not null`; `answers jsonb N` (same limits); `changed_by_actor`; `changed_by_user N`; `reason` (≤ 1000). Unique `(response_id, revision)`.

### 4.14 `intake_minor_determinations` — append-only
`request_id` (composite `RESTRICT`); `is_minor boolean not null`; `source check in ('birthday','declared','staff_override')`; `evaluated_on date not null`; `threshold smallint not null`; `declared_value_class N`; `actor_user_id N`; `reason N` (required for `staff_override`; ≤ 1000).

### 4.15 `intake_completions` — immutable (A4)
`request_id` (composite `RESTRICT`, `unique (request_id)`); `client_id` (FK `RESTRICT`); `template_id`, `template_version_id` (composite `RESTRICT`); `version_number int not null`; `student_response_id N`, `guardian_response_id N` (composite `RESTRICT`; guardian set only if guardian consent was part of the original completion); `completed_at not null`. **No column is ever updated.**
**Derived fulfillment** — `intake_fulfillment_state(p_request_id)` (definer, internal):
- `incomplete` — no completion.
- `guardian_consent_outstanding` — completion exists, the **latest** minor determination for the request is `is_minor = true`, and no `submitted`, non-superseded guardian response exists that has a matching consent-evidence row whose respondent assurance meets that row's pinned `required_assurance` (N5: a later change to the studio setting never re-opens an accepted consent).
- `complete` — otherwise, with a completion.
**Reuse validity** = version requirement met **and** state = `complete`. `guardian_consent_outstanding` is treated by the reconciler as an existing obligation (no new request); staff see the outstanding consent; lessons are never blocked.

### 4.16 `intake_client_relationship_state`
`client_id` (FK `RESTRICT`, unique); `state check in ('active','ended')`; `ended_at N`; `ended_basis N check in ('staff_marked','client_erasure')`; `marked_by N`; `reactivated_at N`; `platform_policy_version N`; `retention_choice_id N`; `updated_at`. Ending stamps submitted responses `clock_running` with a date from the effective value (§4.3); `clock_pending_policy` is defensive only (the collection gate prevents responses existing without an approved maximum).

### 4.17 `intake_guardian_designations`
`client_id` (FK `RESTRICT`); `link_id N` (FK `client_account_links ON DELETE SET NULL`; R5; L3 at designation and at use); `designated_by not null`; `designated_at not null`; `reason N`; `superseded_at N`. Partial unique `(studio_id, client_id) where superseded_at is null`.

### 4.18 `intake_consent_evidence` — retained, non-identifying, append-only
`request_ref`, `client_ref` (not null), `respondent_ref` (N) — soft, validated at insert; `respondent_role`; `declared_relationship N`; `assurance not null`; `event_type check in ('acknowledged','declined','attested','withdrawn')`; `acknowledged_at not null`; `consent_text not null` (≤ 20 000 chars); `consent_text_sha256 not null`; `template_version_ref not null`; `template_schema_sha256 not null`; `sign_envelope_ref N` (soft; §5.2); `signed_sha256 N`; `outcome not null`; `actor_type not null`; `actor_user_id N`; `actor_role N`; `retention_basis check in ('legal','contractual','evidentiary')`; `retain_until not null` (= `acknowledged_at + evidence_core_days`; insert fails closed if NULL); `platform_policy_version int not null`; `refs_minimized_at N` (A16); **(4.1, N5)** `required_assurance text not null` — the studio's `min_guardian_assurance` copied at acceptance time; immutable.

### 4.19 `intake_consent_evidence_identity` — retained, identifying
`evidence_id` (composite FK `ON DELETE CASCADE`, unique; never relied on — expiry deletes identity explicitly); `subject_display_name N`; `respondent_display_name N`; `respondent_email_hmac N`; `respondent_email_hmac_kid N`; `retain_until not null` (`evidence_identity_days`; fail closed; `<= evidence.retain_until`); `minimized_at N`; `minimized_reason N`.

## 5. References, Documents, erasure

### 5.1 Foreign-key matrix
| From → To | Kind | ON DELETE | Check |
|---|---|---|---|
| tables 1–5 → `studios` | FK | CASCADE | — |
| tables 6–18 → `studios` | FK | RESTRICT | — |
| intake ↔ intake | composite | RESTRICT; CASCADE (9 → 8, 18 → 17, never relied on); `SET NULL (col)` for supersedes and default template | composite + R20 |
| live personal → `clients` | FK | RESTRICT | R5 at insert and use |
| 8 / 10 / 16 → `client_account_links` | FK | SET NULL | R5 + L3 |
| 10 → `auth.users` | FK | SET NULL (allowlisted) | — |
| versions → Documents; evidence → request/client/respondent/version/envelope; holds → scope; audit → anything; 9 → `appointments` | soft | — | insert-time and use-time validation |

### 5.2 Documents ownership (F9 + A12)
`intake_assert_document_version(p_studio_id, p_version_ref)` requires: `document_template_versions.published_at is not null` and `archived_at is null` [V columns, migration `20260705`]; parent `document_templates.scope = 'studio'`, `studio_id = p_studio_id`, `organizer_id is null`, `is_active = true`. Any other scope (including a future `platform`) is refused. Run at publish and at every use (I5). Envelope refs check `document_sign_envelopes.studio_id` and `client_id` at insert. Live scope constraint re-check is gate G5.

### 5.3 Erasure (F1, A3, A5, A11, A17)
Public wrapper `public.intake_erase_client(p_studio_id uuid, p_client_id uuid, p_reason_code text, p_case_ref text default null)` — owner `postgres`, `SECURITY DEFINER`, granted to `authenticated` only; it performs step 1 and then calls `intake_private.erase_client_impl(p_studio_id uuid, p_client_id uuid, p_actor uuid, p_reason_code text, p_drift boolean, p_case_ref text)` (owner `intake_destructive`, `SECURITY DEFINER`, EXECUTE granted only to `postgres`), which performs steps 2–6 (P3-a). *(As built — implementation plan §9.4 items 18, 22–25.)*
1. `intake_is_platform_admin()` must be true; actor = `auth.uid()`; the studio must exist (NULL or unknown studio refused); `p_reason_code` ∈ {`data_subject_request`, `guardian_request`, `studio_request`, `legal_requirement`, `other`}; optional `p_case_ref` NULL or matching `^[A-Z]{2,10}-[0-9]{1,12}$`; unknown clients refused. While the collection gate is closed and the studio holds no intake records for the client, the call returns `{"outcome":"no_records"}` and writes nothing. Results carry `outcome` = `erased` | `refused` (legal hold; the refusal is audited) | `no_records`; callers treat only `erased` as an erasure.
2. Locks: L1 → L2 → L3 (all the client's requests, by id) → L4 (responses) → L5.
3. Refuse if any active hold has `client_ref = p_client_id` or a `scope_ref` among the client's requests, responses or evidence.
4. Scope: rows where `studio_id = p_studio_id and client_id = p_client_id`, **regardless of `clients.studio_id`** (A17: drift never blocks erasure; detected drift is recorded in the audit event).
5. Delete explicitly, children first: completions → response revisions → responses → respondents → minor determinations → request appointments → requests → guardian designations → relationship state. (Explicit deletion of 9 is required because FK cascades run as the table owner, which the protected-change trigger rejects; A5.)
6. Write an `erasure_record` audit event (counts, drift flag; no personal data). **This record is the erasure barrier (R22).**
7. **Erasure barrier (A11, N3; replaces the Rev 4 same-transaction requirement).** Separate Supabase RPC calls are separate transactions, and supabase-js offers no multi-statement transaction, so erasure and the later `clients` delete are **not** assumed to share a transaction. Instead, while an unreleased `erasure_record` exists for `(studio_id, client_id)`:
   - every intake insert for that client is refused — the collection-gate insert trigger (§9) and every writer function check `intake_erasure_barrier_active(studio_id, client_id)`;
   - the reconciler's enumeration excludes the client, and `intake_ensure_request` refuses it (no reconciler-created request can appear);
   - `intake_create_hold` refuses `scope_type = 'client'` (it takes L1 first, so it serializes with erasure).
   The operator path then deletes the `clients` row in a separate call; no intake row can block it.
   **Release:** `public.intake_release_erasure_barrier(p_studio_id uuid, p_client_id uuid, p_reason_code text, p_case_ref text default null)` — wrapper owned by `postgres`, granted to `authenticated`, requires `intake_is_platform_admin()`, actor `auth.uid()`, reason code ∈ {`erased_in_error`, `new_relationship`, `legal_requirement`, `other`}, optional `p_case_ref` as for erasure; it appends an `erasure_barrier_released` audit event (append-only; the original `erasure_record` is never modified). The barrier is active when the latest of those two event types for the client is `erasure_record`. Used only if the client is intentionally not deleted.
8. Retained evidence and audit survive through soft references; their reference minimization is A16 (§6.3).

### 5.4 Erasure before personal writes (F2)
I1 delivers `intake_erase_client`, `intake_is_held`, hold create/release. **I3 entry gate:** a platform-admin-only operator server action (no studio-facing UI) calls them with the admin's own session (so `auth.uid()` is the admin). Interim hold authority: platform admin only, pending §13.

## 6. Destructive mechanism, immutability, minimization

### 6.1 Restricted role (A5)
- `CREATE ROLE intake_destructive NOLOGIN NOINHERIT NOBYPASSRLS` (M1), guarded by `IF NOT EXISTS` so re-application is a no-op.
- **(4.2) Explicit SET membership (M1).** On PostgreSQL 16+ (DEV 17.6), the creating role receives `ADMIN` but **not** `SET` or `INHERIT` on the new role (`createrole_self_grant` is empty) [V local rehearsal RH00]. M1 therefore runs `GRANT intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE`. `INHERIT FALSE` keeps the role's privileges out of `postgres` sessions; `SET TRUE` lets migrations act as the role. Re-running the grant is a no-op.
- **(4.2) Creation pattern — no ownership transfer.** Every `intake_private` implementation and its grants are created inside the migration as:
  `SET LOCAL ROLE intake_destructive; CREATE OR REPLACE FUNCTION intake_private.<impl>(…) … SECURITY DEFINER SET search_path = pg_catalog, pg_temp …; REVOKE ALL ON FUNCTION intake_private.<impl>(…) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION intake_private.<impl>(…) TO postgres; RESET ROLE;`
  Rationale [V local rehearsal RH01]: after `ALTER FUNCTION … OWNER TO intake_destructive`, `postgres` (SET but not INHERIT) can neither `CREATE OR REPLACE` the function nor `GRANT` on it, so a re-run fails; and the ownership change dropped the explicit `EXECUTE` grant to `postgres`, which would break the wrappers. Creating as the role keeps ownership, the `postgres` grant and the revokes stable across repeated runs (three re-applies produced an identical catalog fingerprint).
- `intake_destructive` holds `USAGE, CREATE` on `intake_private` (needed to create there while acting as the role) and nothing on `public` beyond the default `USAGE`.
- Destructive definer implementations (`intake_private.erase_client_impl`; later redaction, draft purge, evidence/identity expiry, retained-reference minimization) are **owned by `intake_destructive` and live in `intake_private`** (P3-a). The role needs `USAGE, CREATE` on `intake_private` only — never `CREATE` on `public`. Public entry points are thin `postgres`-owned wrappers that authenticate and authorize (`intake_is_platform_admin()`, `auth.uid()`, reason) before calling the implementation; the implementations are executable only by `postgres`. The actor is passed from the wrapper (already resolved from `auth.uid()` by `postgres`), so the role needs no access to the `auth` schema (G10 risk reduced). While they run, `current_user = 'intake_destructive'`; when they return, it reverts — nothing persists into later statements, so no session flag or nonce is needed.
- The role receives only: `SELECT` and `DELETE` on tables 8–16; column-limited `UPDATE` for redaction/minimization (I6); `EXECUTE` on `intake_is_held`, `intake_audit_write`, `intake_is_platform_admin`, `intake_fulfillment_state`. RLS policies `TO intake_destructive USING (true)` on exactly those tables (no `BYPASSRLS`).
- Protected-change triggers (delete on 8–16; redaction columns; evidence identity delete; retained-ref minimization) accept a change only when `current_user = 'intake_destructive'`. All other changes to protected data are refused for every role, including the table owner.
- Owner break-glass: `postgres` disabling a named trigger in a reviewed, logged session; documented procedure only.
- **Verification status (4.2):** role creation, SET membership, creation-as-role, RLS, privilege isolation and `auth.uid()` actor propagation **passed on a disposable local Supabase stack** (PostgreSQL 17.6.1.106; §17.1). **Still pending on hosted Supabase:** role creation and SET membership on a hosted project (G7-hosted), and preservation through backup/restore and branching (G9). The fallback (Appendix A) is **not** adopted.
- **Recovery (P3-b, documented; runbook before PROD apply):** if the role or its ownership is missing after a restore or incident, erasure fails closed. Runbook: (1) recreate `intake_destructive` with the M1 definition; (2) re-grant `intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE`, its schema and table privileges and RLS policies from the migrations; (3) re-create every `intake_private` implementation **while acting as the role** (`SET LOCAL ROLE intake_destructive` … `RESET ROLE`), exactly as in the migrations — never `ALTER FUNCTION … OWNER`; (4) run the catalog self-check (owners, ACLs, policies); (5) run the post-restore erasure smoke test on a synthetic client in a non-production branch and, in PROD, the read-only ownership/ACL check. Until (4) passes, legal-deletion requests are queued manually and the incident is recorded.

### 6.2 Other immutability
Row triggers per §4; `BEFORE TRUNCATE` statement guards on tables 4 (published rows protected by row trigger; TRUNCATE refused outright), 6–18. All trigger functions pin `search_path` (A13).

### 6.3 Retained references are pseudonymous personal data (A16)
`client_ref`, `request_ref`, `respondent_ref` in evidence and audit can re-identify a person while other records exist. Design: an I6 function owned by `intake_destructive` replaces them with `retained-ref` HMAC digests (or NULL) when (a) the client is erased and the owner/legal decision says linkage is no longer needed, or (b) the record's retention ends; it sets `refs_minimized_at`. Environment markers carry no refs. The trigger for (a) is [D].

## 7. Privileges

### 7.1 Tables
After each `CREATE TABLE`: `REVOKE ALL ON <t> FROM PUBLIC, anon, authenticated, service_role`; then:

| Tables | anon | authenticated | service_role | intake_destructive | RLS |
|---|---|---|---|---|---|
| 1–5 config | — | `SELECT` via policy: active `user_studio_roles` row in that studio **or** `intake_is_platform_admin()` | **— (4.1, P3-c)** | — | enabled |
| 8, 9, 15, 16 | — | — | **— (4.1, P3-c)** | `SELECT, DELETE` | enabled; policy only for `intake_destructive` |
| 10–14 | — | — | — | `SELECT, DELETE` (+ column `UPDATE` in I6) | enabled; policy only for `intake_destructive` |
| 6–7, 17–18 | — | — | — | I6 only (minimization/expiry) | enabled, no policies in I1 |

### 7.2 Functions
After each `CREATE FUNCTION`, per overload: `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role`; then:

| Function | Owner | Granted to | Authorization in body |
|---|---|---|---|
| `intake_platform_policy()` | postgres | `authenticated`, `service_role` | none (non-sensitive) |
| `intake_is_platform_admin()` | postgres | nobody (internal) | `profiles.platform_role = 'platform_admin'` for `auth.uid()` (A2) |
| `intake_assert_staff(p_studio_id, capability)`, tenant helpers, `intake_collection_allowed`, `intake_is_held`, `intake_audit_write`, `intake_fulfillment_state`, trigger functions | postgres | nobody (internal; `intake_destructive` gets EXECUTE on the four listed in §6.1) | — |
| Staff RPCs (publish, floor, assignments, retention choice, status, scoped answers, designate/select guardian, attest, drift report) | postgres | `authenticated` | `intake_assert_staff` per §7.3 |
| `intake_extend_draft_retention` | postgres | `authenticated` | owner, or admin when enabled |
| Instructor summary (I5) | postgres | `authenticated` | §7.3 row "instructor summary" |
| Service RPCs (ensure request, attach appointment, draft save, submit) | postgres | `service_role` | arguments validated against rows; collection gate |
| `public.intake_erase_client(uuid, uuid, text, text)`, `public.intake_release_erasure_barrier(uuid, uuid, text, text)` (wrappers) | postgres | `authenticated` | platform admin via `intake_is_platform_admin()`; actor `auth.uid()` (A3); reason code required; optional ticket-shaped `case_ref` |
| `intake_private.erase_client_impl` (and later destructive impls) | **intake_destructive** (created as the role; §6.1) | `postgres` only (granted by the role at creation) | called by wrappers only (P3-a) |
| `intake_erasure_barrier_active` | postgres | nobody (internal; EXECUTE for `intake_destructive`) | — |
| `intake_create_hold`, `intake_release_hold` | postgres | `authenticated` | platform admin (interim); actor `auth.uid()` |
| Catalog self-check | postgres | nobody (run by tests/owner) | — |

Catalog self-check: for every `intake_%` relation and function, `aclexplode` must match §7.1/§7.2 exactly for `PUBLIC`, `anon`, `authenticated`, `service_role`, `intake_destructive`; a `NULL` ACL fails; function owners must match the table above.

### 7.3 Capability matrix (proposed V1 baseline)
Studio roles require an active `user_studio_roles` row for the explicit `p_studio_id`. Platform admin = `profiles.platform_role = 'platform_admin'` only.

| Capability | owner | admin | front_desk | instructor | independent_instructor | client | organizer roles | platform admin |
|---|---|---|---|---|---|---|---|---|
| Configure settings, templates, publish, floor, assignments | ✓ | ✓ | — | — | — | — | — | read-only |
| Choose post-relationship duration (≤ platform max) | ✓ | ✓ | — | — | — | — | — | — |
| View status | ✓ | ✓ | ✓ | — | — | — | — | ✓ |
| Manual request, send, resend | ✓ | ✓ | ✓ | — | — | — | — | — |
| View all answer sections | ✓ | ✓ | — | — | — | — | — | **— (no default)** |
| View operational sections | ✓ | ✓ | ✓ | — | — | — | — | — |
| Instructor summary (relationship-based, N4) | — | — | — | if relationship* | if relationship* (Hybrid) | — | — | — |
| Designate/select guardian recipient | ✓ | ✓ | only if `front_desk_guardian_selection`, before guardian submission | — | — | — | — | — |
| In-person guardian attestation | ✓ | ✓ | ✓ | — | — | — | — | — |
| Extend draft retention | ✓ | if `draft_extension_admins_enabled` | — | — | — | — | — | — |
| Create/release legal hold | — | — | — | — | — | — | — | ✓ (interim) |
| Client erasure | — | — | — | — | — | — | — | ✓ |
| Drift report | ✓ | ✓ | — | — | — | — | — | ✓ |

\* **(4.1, N4 — supersedes the Rev 4 role-name rule; built in I5.)** Instructor summary requires all of: an `instructors` row in the same studio with `user_id = auth.uid()`, `active = true` and `can_instruct = true` (the Slice 9 guarded capability [V `20260918090000_landmark1a_slice9_capability_authority.sql`]); that row is the appointment's current `instructor_id`; a qualifying appointment type (never `floor_space_rental`); appointment current or attended within 14 days; `instructor_visible` fields only. **The literal `user_studio_roles` role is not consulted**, matching the repo's relationship model ("Hybrid is a combination of relationships, not a role" [V `lib/auth/appointmentAccess.ts:14–30`]). Consequences: a studio instructor and a Hybrid Instructor (single studio role `independent_instructor` plus an authorized host-studio teaching row) both qualify for their assigned host-studio appointments; `independent_instructor` status or a floor-rental relationship **alone** grants nothing, because it carries no `can_instruct` teaching row assigned to a qualifying appointment. FC-1B1 and FC-1 are preserved; no Hybrid role is introduced. Note: the existing `get_teaching_clients_for_instructor` checks `active` but not `can_instruct` [V `20260905160000`]; intake is stricter.

## 8. Concurrency
| Level | Lock | Taken by |
|---|---|---|
| L1 | `pg_advisory_xact_lock(hashtextextended('intake:client:'||studio_id||':'||client_id,0))` | ensure, attach, draft save, submit, relationship end/reactivate, designate, reassign, minor determination, extend, hold create/release, erasure; later redaction, export |
| L2 | relationship-state row `FOR UPDATE` | relationship end/reactivate, submit, erasure |
| L3 | request rows `FOR UPDATE`, ascending id | ensure (after insert), draft save, submit, reassign, minor determination, extend, erasure |
| L4 | response rows `FOR UPDATE`, ascending `(request_id, audience)` | draft save, submit, erasure |
| L5 | active designation row | designate, erasure |
| L6 | hold row | release |
| Separate | template row | publish, floor (never with L1–L6) |

**Implicit locks (A14):** inserting rows with FKs takes `FOR KEY SHARE` on referenced `clients`, `client_account_links`, templates/versions. These conflict only with deletes and key updates of those rows, not ordinary updates, so they are accepted outside the hierarchy; test 46 includes concurrent client updates. Submit, draft save, ensure, designation, reassignment, erasure as in Rev 3 (expressed in these levels). A minor determination takes L1 → L3 and never touches completions.

## 9. Collection gate (A1, A6)

**(4.1, N1) The gate is split into two checks.**

| Check | Function | True only if | Applies to |
|---|---|---|---|
| **Gate A — retention** | `intake_retention_gate_open()` | `intake_platform_policy()` returns non-NULL `post_relationship_max_days`, `evidence_core_days`, `evidence_identity_days`, `audit_operational_days`, `audit_security_days`, `hold_record_days_after_release` (draft values present by approval) | **every** personal-data insert, new or continuing |
| **Gate B — new obligation** | `intake_new_obligation_allowed(p_studio_id)` | `intake_settings.enabled` **and** the studio is entitled (app-side today; database-side required before collection, N2 §16.5) | **only** actions that create a new intake obligation or outreach: ensure/manual request, attach appointment, re-intake request, and (later) new invitations and the outbound delivery rows queued with them (shared outbox, spec §22) |
| **Barrier** | `intake_erasure_barrier_active(p_studio_id, p_client_id)` | an unreleased `erasure_record` exists | refuses **every** insert for that client (N3) |

Continuing an existing, validly issued request — draft save, submit, guardian response, attestation, consent evidence, minor determination, guardian routing within the request — requires **Gate A and no barrier only**. Therefore, after entitlement lapse or studio disable, students and guardians can still complete already-issued intake (spec §6 lapse rule), while no new obligations or outreach are created. **Studio input cannot open Gate A** — studios supply only an optional post-relationship choice.

Enforced twice: inside every writer function, and by a `BEFORE INSERT` trigger on every personal-data table. The trigger always checks Gate A and the barrier; it checks Gate B on `intake_requests` and `intake_request_appointments` (and on the I3 invitation and challenge tables), which are the tables that represent new obligations or outreach. Intake delivery rows live in the shared `outbound_deliveries` outbox (spec §22); they are inserted only by intake RPCs in the same transaction as the gated invitation or challenge row, and the send-time renderer re-checks the gates before sending.

| Writer | Table(s) | Gate A | Gate B | Barrier |
|---|---|---|---|---|
| ensure request / manual or re-intake request / attach appointment | 8, 9 | ✓ | ✓ | ✓ |
| draft save, submit (respondents, responses, revisions, completions) | 10–12, 14 | ✓ | — | ✓ |
| minor determination | 13 | ✓ | — | ✓ |
| relationship-state creation | 15 | ✓ (insert) | — | ✓; end/reactivate updates exempt |
| guardian designation / recipient selection | 16 (insert); 8 (update) | ✓ | — | ✓ |
| attestation, consent evidence and identity | 10, 17, 18 | ✓ | — | ✓ |
| draft-retention extension (reason text) | 8 (update) | ✓ | — | ✓ |
| I3 invitations (new or resend) | deferred | ✓ | ✓ | ✓ |
| I3 sessions, email challenges for an issued invitation | deferred | ✓ | — | ✓ |
| I4 delivery (shared `outbound_deliveries` rows queued by intake RPCs, spec §22) | deferred | ✓ (via the gated invitation/challenge insert in the same transaction, and re-checked at send time) | ✓ | ✓ |
| I6 export requests and artifacts | deferred | ✓ | — | — (exports of existing data for a verified request; not new collection) |
| I6 network evidence | deferred | ✓ | — | ✓ |

**Exempt (never gated; must work while any policy is pending):** erasure; redaction; draft purge; evidence/identity expiry and minimization; retained-reference minimization; DanceFlow account deletion (`deleteDanceFlowAccount` and its FK `SET NULL`); legal-hold create/review/release; security/operational audit writes; relationship end. **A retention-policy gap can never prevent deletion.**

Environment marker (A10, **N6**): the first gated personal-data insert **in the database** (any studio) writes the single environment-scoped `environment_marker` row (`studio_id` NULL, `permanent_marker`, no refs, `ON CONFLICT DO NOTHING`), which rollback eligibility reads. Barrier release and erasure are exempt from all gates.

## 10. Negative-test inventory (real roles, DEV)

Status per test: **K** kept, **M** modified, **R** retired, **N** new.

- **1–41 (Rev 2)**: K, except 6 (M: `deleteDanceFlowAccount` must also succeed while the collection gate is closed) and 15 (M: lock order).
- **42–62 (Rev 3)**: K, except 44 (M: operator path uses the admin's own session; DB rejects non-admin), 45 (M: client-scope hold refused after an erasure record; erase + client delete in one transaction), 48–49 (M: include `intake_destructive` in the ACL check and ownership check), 52 (M: no answers HMAC; redaction nulls answers and respondent email HMAC), 54 (M: `respondent-email` and `evidence-identity-email` only).
- **63–80 (P3)**: 63–68 K; 64 (M: also archived or unpublished Documents version); 69 (M: matrix of §7.3, independent_instructor denied everywhere); 70 (M: only `profiles.platform_role` grants platform admin; `platform_admins` alone and `user_studio_roles` role alone are refused; both = allowed); **71–74 R** (one-time-code mechanism removed); 75 (M: tiered rollback, §11); **76–77 R** (completion update removed); 78–79 (M: new byte limits); 80 K.
- **New 81–100:**

| # | Finding | Test | Expected |
|---|---|---|---|
| 81 | A1 | Studio owner inserts a retention choice with every period field they can reach, platform values NULL | Gate still false; every gated writer refuses |
| 82 | A1 | Retention choice above platform max; platform max lowered later | Insert refused; effective value capped automatically |
| 83 | A1 | Draft rule cannot be changed by any studio role | No column/RPC exists; attempts fail |
| 84 | A2 | Config RLS and every platform-admin capability evaluated with `platform_role` only / `platform_admins` only / both | Only `platform_role` matters |
| 85 | A3 | `service_role` calls `intake_erase_client` | Permission denied |
| 86 | A3 | Authenticated non-admin calls erasure/hold functions; admin call | Refused; admin succeeds with `actor_user_id = auth.uid()` (no actor parameter exists) |
| 87 | A4 | Completed adult intake → later minor determination | Completion row byte-identical before/after; state `guardian_consent_outstanding`; reconciler creates nothing |
| 88 | A4 | Guardian submits with sufficient assurance and evidence | State `complete`; completion still unchanged |
| 89 | A4 | Guardian response insert into a submitted request when no consent is outstanding; second guardian response | Refused |
| 90 | A5 | Protected delete/update attempted by `postgres` (owner), `service_role`, and a postgres-owned definer function | Refused; only `intake_destructive`-owned functions succeed |
| 91 | A5 | After `intake_erase_client` returns, same transaction attempts another protected change | Refused (current_user reverted) |
| 92 | A5 | Erasure relying on FK cascade for request appointments (simulated) | Refused by trigger; explicit-order erasure succeeds |
| 93 | A6 | Each gated writer (table above) with any platform value NULL | Refused, nothing written; table-level trigger also refuses a direct insert by the owner |
| 94 | A6 | Erasure, account deletion, hold create/release, audit write, relationship end with the gate closed | All succeed |
| 95 | A7 | Update `studio_id`, `client_id`, `request_id`, `template_id`, `template_version_id`, evidence refs, hold scope | Refused; documented exceptions succeed |
| 96 | A8 | Assigned instructor (role `instructor`) vs `independent_instructor` assigned on the same appointment; instructor without active role; floor-rental appointment | Only the first succeeds |
| 97 | A9 | Publish template whose worst-case answer size > 262 144 bytes (UTF-8 worst case); route body > 384 KB | Publish refused; body rejected |
| 98 | A10 | Rollback with config rows only and an export acknowledgment; with config rows and no acknowledgment; after an environment marker exists; after personal rows were erased | Allowed / refused / refused / refused |
| 99 | A13 | Trigger fired from a session with a hostile `search_path` and temp objects | Uses qualified objects only |
| 100 | A17 | Drifted client (`clients.studio_id` changed in test) erased by platform admin | Succeeds; drift recorded |

**Total inventory after Rev 4: 100 test IDs; 6 retired (71–74, 76–77); 94 active.** Rev 4.1 modifies 80, 86, 96 and adds 101–114 (§16.7): **114 test IDs; 6 retired; 108 active.**

## 11. Migration gates and rollback (A10)

**Pre-apply gates per environment:** G1–G10 (§12) as applicable; boundary tests green on DEV; not during a Marketing M-0 stage change.

**Rollback eligibility (one transaction):** `SET LOCAL lock_timeout = '5s'`; lock every existing intake table `ACCESS EXCLUSIVE` in table-number order; then:
- **Refuse permanently** if any row exists in tables 6–18 **other than** audit events with `retention_class` in (`operational`) and all `*_ref` null (config-only activity), **or** if the environment marker exists. Because the marker is environment-scoped (no studio FK), written at the first personal-data insert in the database, excluded from every purge and offboarding step, and protected against delete/update/TRUNCATE for every role, personal-data use permanently blocks destructive rollback even after erasure or studio offboarding empties the personal tables. Restoring a backup taken before first use is the only way to an environment without the marker, and such a restore also contains no personal data.
- **Allow** when only config tables (1–5) and config-only audit rows exist, **and** the operator has exported the config and supplies the export SHA-256 via `SET LOCAL nsi.rollback_config_export = '<sha256>'` (checked non-empty and recorded in the release record).
- Drop in reverse dependency order. **(4.2) Role context during rollback:** objects owned by `intake_destructive` are dropped while acting as it — `SET LOCAL ROLE intake_destructive; DROP FUNCTION intake_private.<impl>(…); RESET ROLE;` — because `postgres` holds `SET` but not `INHERIT` and is therefore not treated as their owner. Then drop the `intake_private` schema, its policies and grants as `postgres`, `REVOKE intake_destructive FROM postgres`, and `DROP ROLE intake_destructive` last (it must own nothing and hold no privileges in any database; verify with the catalog before dropping). The eligibility checks above are unchanged.
After personal-data use: forward-fix only; application rollback (feature off) precedes any SQL change.

## 12. Technical gates not yet verified

| Gate | Check (read-only unless noted) |
|---|---|
| G1 | Postgres ≥ 15. **Previously observed:** DEV `epdrtzcydvnoidwrepqz` = PostgreSQL 17.6 (this review's I0, `select version()` via `supabase db query --linked`, 2026-10-13); PROD `hvsujyfbftfffxpfmlpb` = PostgreSQL 17.6 (recorded in the Phase 10C.5 PROD rollback-only rehearsal and parity check, 2026-10-12, project release notes — not re-observed in this review). Status: **satisfied by prior observation; a fresh read-only re-check is required immediately before the PROD migration** |
| G2 | PROD parity: default ACLs, `appointments` fingerprints |
| G3 | `supabase_realtime` publication excludes `intake_*` |
| G4 | Postgres parameter logging (RPC arguments carry answers) |
| G5 | Live `document_templates` scope constraint and `is_active`/version columns |
| G6 | Live counts: `profiles.platform_role` vs `platform_admins` (informational for the separate platform reconciliation; Intake uses `platform_role`) |
| G7 | Migration user can `CREATE ROLE` and use SET membership on hosted Supabase — **PASS on hosted 17.11 (§18)**; DEV/PROD 17.6 capability consistent by read-only preflight (§17.2); exercised for real only at the authorized DEV apply |
| G8 | Role-owned functions created as `intake_destructive`, RLS policies `TO intake_destructive`, privilege isolation — **PASS: local 17.6 (§17.1) and hosted 17.11 (§18)** |
| G9 | Supabase backup/restore (and branching) preserves the role, its grants, the `intake_private` schema and function ownership — verification plan in §16.9 |
| G10 | Caller identity through PostgREST: wrapper resolves `auth.uid()` and passes it to the role-owned implementation; role has no `auth` access — **PASS: local 17.6 (§17.1) and hosted 17.11 (§18)** |

## 13. Outstanding owner/legal decisions
1. All platform periods: evidence core and identity, audit operational and security, hold-record after release, post-relationship platform maximum. **Launch blockers** (gate stays closed until set).
2. Definition of relationship closure beyond staff marking and erasure.
3. Erasure deletes live answers immediately (recommended) — confirm.
4. Studio offboarding disposition of retained records.
5. Legal-hold create/release roles and review cadence (interim: platform admin only).
6. Confirm the proposed V1 security baseline (§0, §7.3), including the meaning of "authorized admin" for draft extensions (proposed: per-studio flag set by the owner) and front-desk guardian selection (per-studio flag, default off).
7. When retained references are minimized after erasure (A16).
8. Evidence identity: full name vs initials.
9. Minors' jurisdictional requirements and threshold; any required network/device evidence; export approver roles and verification standards.
10. **Separate platform issue (not Intake):** reconcile `platform_admins` with `profiles.platform_role` platform-wide.

## 14. A1–A18 remediation matrix (design corrected; none verified)

| ID | Sev. | Correction | Section | Status |
|---|---|---|---|---|
| A1 | P1 | Platform-only policy function; studio limited to capped post-relationship choice; gate reads platform values | §4.2–4.3, §9, R14 | Corrected in design; periods [D] |
| A2 | P2 | `profiles.platform_role` only, via one helper, incl. RLS | §7.2–7.3, R15 | Corrected; G6 informational |
| A3 | P2 | Erasure/holds granted to `authenticated`, DB-enforced platform admin, actor `auth.uid()`, no actor parameter | §5.3, §7.2, R16 | Corrected; G10 |
| A4 | P2 | Completions immutable; derived fulfillment; guarded guardian insert; removed mutable guardian columns | §4.12, §4.15, R17 | Corrected |
| A5 | P2 | `intake_destructive` role-owned functions; helper table removed; fallback Appendix A | §6.1, R18 | Corrected; **G7–G9 unverified** |
| A6 | P2 | Gate on every writer incl. I3/I4/I6; table-level trigger; explicit deletion-rights exemptions | §9, R19 | Corrected |
| A7 | P2 | Immutable references with listed exceptions | §4.0, R20 | Corrected |
| A8 | P2 | `independent_instructor` excluded; assignment-scoped instructor summary | §7.3, R21 | Corrected |
| A9 | P3 | 262 144-byte answers, 384 KB body, publish-time worst-case size | §4.5, §4.12 | Corrected |
| A10 | P3 | Tiered rollback with permanent environment marker | §11, §4.8, §9 | Corrected |
| A11 | P3 | Client holds refused after erasure record; erase + delete in one transaction | §5.3 | Corrected |
| A12 | P3 | Documents version published, not archived | §5.2 | Corrected; G5 |
| A13 | P3 | All trigger functions pin `search_path` | §3, §6.2 | Corrected |
| A14 | P3 | Implicit FK locks documented; test 46 extended | §8 | Corrected |
| A15 | P3 | `answers_hmac` removed; HMAC purposes defined | §3 | Corrected |
| A16 | P3 | Retained refs treated as pseudonymous; minimization function (I6) | §6.3 | Corrected in design; trigger [D] |
| A17 | P3 | Erasure scoped by intake rows, works under drift | §5.3 | Corrected |
| A18 | P3 | 18 tables, no helper table; migration references and immutability claims reconciled | §2, §4.0, §4.15 | Corrected |

F1–F15 remain addressed in design as recorded in Rev 3, with these amendments: F5 gate (A1, A6), F11 platform source (A2), F12 mechanism (A5), F13 rollback (A10), F14 completion handling (A4), F15 limits (A9).

## 15. Recommendation
*(Rev 4 text kept for history; superseded by §16.10.)* **GO for one targeted final Opus review of Rev 4**, limited to: A1/A6 gate authority and coverage; A2/A3 authorization; A4 derived fulfillment; A5 role mechanism and its fallback; A7 immutability exceptions; A8 instructor scoping; A10 rollback tiers; and consistency of the document as a whole.
**Not GO for implementation:** also requires that review, gates G1–G10, owner confirmation of the §13 security baseline items needed for I1 (6), and I1 slice authorization. Launch additionally requires the §13.1 periods.

## Appendix A — Fallback if gates G7–G9 fail
Use the Rev 3 F12 nonce-bound context (one unlogged, owner-only helper table `intake_ctx_nonces`; context scoped to operation, studio and client; cleared on return; triggers additionally require `current_user` = table owner). Table count becomes 19. Tests 71–74 are reinstated. All other Rev 4 corrections are unchanged.

## 16. Revision 4.1 — final corrections (design only; not verified)

### 16.1 Closure matrix

| ID | Sev. | Disposition in 4.1 | Where | Status |
|---|---|---|---|---|
| N1 | P2 | Gate split: Gate A (platform retention) on every personal-data insert; Gate B (studio enabled + entitlement) only on new obligations/outreach; issued intake remains completable after lapse | §9 | **Applied in design** |
| N2 | P2 | Database-side entitlement for Gate B documented as required before any personal-data collection | §16.5 | **Documented; deferred to I2 (before collection)** |
| N3 | P2 | Erasure barrier replaces the same-transaction assumption; blocks every insert and reconciler request for the client; audited platform-admin release | §5.3, §9, R22 | **Applied in design** |
| N4 | P2 | Instructor summary based on the actual teaching relationship (`can_instruct`, assignment), not a role name; Hybrid Instructors covered; independent/floor-rental status alone grants nothing | §7.3, R21 | **Documented for I5** |
| N5 | P3 | `required_assurance` pinned on the consent-evidence row; fulfillment evaluates against it | §4.18, §4.15 | **Applied in design (column in I1); required before collection** |
| N6 | P2 | Single environment-scoped marker (`studio_id` NULL, one per database), excluded from purge/offboarding, immutable | §4.0, §4.8, §9, §11, R23 | **Applied in design** |
| P3-a | P3 | Role-owned implementations in non-exposed `intake_private`; `postgres`-owned public wrappers authenticate and authorize | §2, §5.3, §6.1, §7.2, R24 | **Applied in design** |
| P3-b | P3 | Role recovery runbook and post-restore erasure verification | §6.1, §16.9 | **Documented; required before PROD apply** |
| P3-c | P3 | All direct `service_role` table grants removed; no documented consumer (service paths use `postgres`-owned definer RPCs) | §7.1 | **Applied in design** |

A1–A18 dispositions from Rev 4 stand as accepted by the final review, with A8 superseded by N4, A10 amended by N6, A11 resolved by N3. None of these is verified until implemented and tested.

### 16.2 Gate B and Gate A interaction (N1)
- Existing, validly issued request + entitlement lapsed or studio disabled → draft save, submit, guardian response, attestation, evidence: **allowed** (Gate A open, no barrier).
- Same situation → new request, re-intake, appointment attach, new invitation or queued intake delivery: **refused** (Gate B); a delivery already queued is cancelled at send-time revalidation.
- Gate A closed (any platform period unapproved) → **every** personal-data insert refused, new or continuing; erasure, redaction, account deletion, holds, audit, barrier release remain allowed.

### 16.3 Erasure barrier (N3)
Defined in §5.3 step 7. Representation: append-only audit events `erasure_record` and `erasure_barrier_released` (class `erasure_record`, `client_ref` set); no new table. `intake_erasure_barrier_active` is indexed on `(studio_id, client_ref, created_at)` (existing audit index). Lock order: barrier checks run after L1, so a concurrent writer for the same client either commits before the erasure (and is then deleted by it) or sees the barrier.

### 16.4 Environment marker (N6)
Defined in §4.8 and §11. Not removable by any role short of disabling the protection trigger as table owner (documented break-glass, which itself is a reviewed operational change). Studio offboarding and every purge function exclude it by class and by `studio_id IS NULL`.

### 16.5 N2 — database-side entitlement (documented, deferred)
Before any personal data is collected, Gate B must check entitlement in the database: either the I2 generic studio feature-grant table (platform-admin grants, with expiry) or the canonical billing plan state, read by a `postgres`-owned definer helper. Until then Gate B's entitlement half is app-side only, which is acceptable **only** while Gate A is closed (no platform periods approved), because no personal data can be written in that state. Required test before collection: a service-role caller that skips the app check is refused by the database for an unentitled studio.

### 16.6 N4 — Hybrid Instructor authorization (documented for I5)
Rule in §7.3 footnote. Tests 96 (modified) and 109–111 belong to I5 and are listed now so the matrix is complete.

### 16.7 Test inventory changes

| # | Status | Test | Expected |
|---|---|---|---|
| 80 | M | Draft save, submit, ensure request, attestation, evidence insert with any platform period missing | Gate A refuses all; nothing written |
| 86 | M | Non-admin calls `public.intake_erase_client` / `intake_release_erasure_barrier`; admin calls | Refused / succeed with `auth.uid()` actor; implementation in `intake_private` not callable by `authenticated` or `service_role` |
| 96 | M (I5) | Relationship-based instructor summary (see 109–111) | As specified |
| 101 | N | Entitlement lapsed / studio disabled; existing invited request: draft save, submit, guardian response | Allowed |
| 102 | N | Same state: ensure request, re-intake, attach appointment | Refused (Gate B) |
| 103 | N | After `erasure_record`: reconciler enumeration, `intake_ensure_request`, direct owner insert into each personal table for that client | Excluded / refused / refused by trigger |
| 104 | N | After `erasure_record`, delete the `clients` row in a separate call | Succeeds; no intake FK blocks it |
| 105 | N | Barrier release by non-admin; by admin without reason; by admin with reason | Refused / refused / allowed, `erasure_barrier_released` appended, original record unchanged |
| 106 | N | Concurrent draft save and erasure on the same client (barrier) | Either draft committed then erased, or draft refused; never a surviving row |
| 107 | N | Second environment marker insert; delete/update/TRUNCATE of the marker by owner, `service_role`, `intake_destructive`; offboarding/purge run | Ignored (single row) / refused / marker remains |
| 108 | N | Studio deletion after offboarding while the marker exists | Marker does not block (no studio FK); rollback still refused |
| 109 | N (I5) | Hybrid person: studio role `independent_instructor`, `can_instruct` teaching row, assigned private lesson | Instructor summary allowed (instructor-visible fields only) |
| 110 | N (I5) | Same person on their own `floor_space_rental`; same person not assigned; `can_instruct = false`; role `instructor` with no teaching row | All denied |
| 111 | N (I5) | Independent instructor with only a floor-rental relationship | Denied |
| 112 | N | Guardian consent accepted at `email_code_verified`; studio later raises `min_guardian_assurance` to `link_verified` | Fulfillment remains `complete` |
| 113 | N | Catalog: `intake_private` has no `USAGE` for `anon`/`authenticated`/`service_role`; is not in PostgREST exposed schemas; `intake_destructive` has no `CREATE` on `public` | Pass |
| 114 | N | Catalog: `service_role` holds no direct privilege on any intake table | Pass |

### 16.8 Remaining DEV rehearsal gates (disposable DEV branch only; separate authorization required)

| Gate | Rehearsal steps | Pass criteria |
|---|---|---|
| **G7** role creation | Apply M1 as the migration user; `CREATE ROLE intake_destructive NOLOGIN NOINHERIT NOBYPASSRLS`; `GRANT intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE` | Role exists with the stated attributes; no superuser needed; re-run is a no-op. **(4.3) PASS local + hosted (§18)** |
| **G8** ownership and RLS | Create `intake_private`; grant the role `USAGE, CREATE` there only; create implementations **as the role** (`SET LOCAL ROLE`), revoke/grant as the role; add `TO intake_destructive` RLS policies on tables 8–16; run tests 90–92, 103–107, 113–114 | Role owns the implementations; `postgres` keeps `EXECUTE` across re-runs; role can delete only the intended rows; nothing else can; catalog self-check passes. **(4.3) PASS local + hosted (§18)** |
| **G10** `auth.uid()` path | Call `public.intake_erase_client` through PostgREST with (a) a platform-admin JWT, (b) a non-admin JWT, (c) the service key | (a) succeeds and the audit actor equals the admin's user id; (b) and (c) refused; the role never needs `auth` schema access (actor passed from the wrapper) |

G1 is satisfied by prior observation (17.6 on DEV and PROD; §12) with a mandatory fresh check before PROD migration. G2 (PROD parity) is required before PROD apply.

### 16.9 G9 backup/restore verification plan (before PROD apply; separate authorization)
1. In a disposable DEV branch with M1–M5 applied and synthetic data, record a catalog fingerprint: role attributes, `intake_private` ACL, function owners and ACLs, RLS policies, table ACLs, marker row.
2. Exercise each restore path Supabase offers for the project's plan (daily backup restore into a new project or branch; PITR if enabled). Restoring into the live DEV or PROD project is not part of this plan.
3. In the restored copy: compare the fingerprint; run the erasure smoke test on a synthetic client (wrapper → implementation → barrier → client delete); confirm the marker survived.
4. If the role or ownership is missing: apply the P3-b runbook (§6.1), re-fingerprint, and record whether the restore path needs a post-restore step. If no restore path preserves them and the runbook cannot restore them reliably, escalate the Appendix A fallback to a separate decision.
5. Record the result as a release artifact before the first PROD apply.

### 16.10 Implementation versus launch blockers

| Category | Items |
|---|---|
| **1. Before I1 SQL (technical)** | Disposable DEV rehearsal of G7, G8, G10 (separate authorization); fresh G1 check is only required before PROD |
| **2. Before I1 SQL (owner policy)** | Confirm the V1 security baseline (§0, §7.3: no default answer access for platform admins; front-desk guardian selection flag off by default; owners extend drafts, admins only when enabled); accept platform admin as interim legal-hold authority; confirm erasure deletes live answers immediately; confirm barrier release authority = platform admin, audited |
| **3. Before PROD apply** | G1 fresh check, G2 parity, G9 backup/restore verification, P3-b runbook |
| **4. Dark deployment allowed; before any personal-data collection** | All platform retention periods (Gate A stays closed until set); N2 database-side entitlement; N5 in use (column exists in I1); G3 realtime, G4 parameter logging, G5 Documents constraint; I3 operator erasure path; retained-reference minimization trigger [D] |
| **5. Before I5** | N4 relationship-based instructor summary and tests 96, 109–111 |
| **6. Legal/privacy/operational before launch** | Minors' jurisdictional requirements and threshold; network/device evidence; export approvers and verification; relationship-closure definition; offboarding disposition; final legal-hold roles and cadence; evidence names vs initials; audit retention operations; email/UI testing (not I1 schema dependencies); separate platform-wide `platform_admins` reconciliation |

**Recommendation:** the five required corrections are applied in design and the four documented items are recorded with their deadlines. Proceed to request **(a)** a disposable DEV rehearsal for G7, G8 and G10 and **(b)** owner confirmation of category 2. If both pass, I1 SQL authorization can be requested. Nothing here is verified implementation.

## 17. Restricted-role evidence (revision 4.2)

### 17.1 Local rehearsal — PASS (disposable local Supabase stack; not hosted)
Environment: new local stack `nsi-g7-rehearsal` (own containers, own volume, ports 56321/56322), image `supabase/postgres:17.6.1.106`, `PostgreSQL 17.6`; empty `public`, no `auth.users`, no external connections; destroyed afterwards with `supabase stop --no-backup` (0 containers, 0 volumes left). Shared DEV, PROD and the existing local stacks were not touched. Synthetic objects only; M1–M5 were not run.

| Gate | Evidence (local) | Result |
|---|---|---|
| G7 | Role created by `postgres` (no superuser); creator membership is `ADMIN` only (`set=false, inherit=false`); `ALTER FUNCTION … OWNER` fails with `must be able to SET ROLE "intake_destructive"` until `GRANT … WITH SET TRUE, INHERIT FALSE`; ownership-transfer pattern was not re-runnable and dropped `postgres` EXECUTE; creation-as-role pattern re-applied 3× with identical fingerprint; role cannot log in; no `auth` USAGE, no `public` CREATE, no default ACLs | **PASS (local)** with the §6.1 pattern |
| G8 | 31/31 SQL tests + 2 follow-ups: EXECUTE matrix (impl `postgres` only; wrapper `authenticated` only; helpers no API role); API roles have no table privileges and no `intake_private` USAGE; role SELECT/DELETE allowed only via policy, INSERT/UPDATE/audit DELETE/profile SELECT denied; RLS without policy → 0 rows; owner DELETE/UPDATE/TRUNCATE refused by trigger; audit UPDATE/DELETE refused with rows present; hostile `search_path` + temp shadow table ineffective; no authority after the implementation returns or after a trapped error; erasure barrier and environment marker behave as designed | **PASS (local)** |
| G10 | 14/14 API tests through Kong → PostgREST/GoTrue with synthetic users: platform admin 200 (rows erased); ordinary user 403 `42501`; service key 403; anon 401; spoofed `p_actor` 404 `PGRST202`; forged claims 401 `PGRST301`; unsigned token 401; private schema 406 `PGRST106`; reason required 400; audit actor = admin `auth.uid()`, exec role `intake_destructive`, other client untouched; barrier release user 403 / admin 204 appended; role has no `auth` USAGE | **PASS (local)** |

### 17.2 Hosted DEV preflight — read-only catalog inspection (`epdrtzcydvnoidwrepqz`, 2026-10-14)
Method: two `SELECT`-only batches through `supabase db query --linked`, each beginning `SET TRANSACTION READ ONLY` (confirmed `transaction_read_only = on`). No `CREATE ROLE`, `GRANT`, `SET ROLE` or ownership change was attempted. Note: the Supabase CLI itself refreshes a short-lived credential for its platform-managed login role `cli_login_postgres` on each invocation ("Initialising login role…"; `valid_until` a few minutes ahead; membership in `postgres` granted by `supabase_admin`); that is CLI/platform behavior, not part of this preflight's SQL, and the same mechanism was used by earlier read-only checks.

| Observation | Value | What it shows |
|---|---|---|
| Server version | `17.6` (`server_version_num` 170006) | PG16+ membership semantics apply (G1 consistent) |
| `postgres` attributes | `super=f createrole=t createdb=t bypassrls=t inherit=t` | Migration identity holds `CREATEROLE`; not superuser (matches local) |
| `createrole_self_grant` | empty | Creator would receive `ADMIN` only — same as local; the explicit `WITH SET TRUE` grant is required on hosted too |
| `supautils` | loaded via `session_preload_libraries`; `superuser = supabase_admin`; `privileged_role = supabase_privileged_role` | Supabase's role-guard extension is active and can intercept role DDL |
| `supautils.reserved_roles` / `reserved_memberships` | Supabase system roles only; **`intake_destructive` not listed** | The intended name is not reserved and the intended membership is not a reserved membership |
| `intake_destructive` | does not exist | Clean starting state |
| `postgres` CREATE on database | true | `CREATE SCHEMA intake_private` is permitted by privilege |
| Existing `postgres` memberships | `ADMIN, INHERIT, SET` on `anon`, `authenticated`, `service_role`, `authenticator` (grantor `supabase_admin`) | SET-membership mechanism is in use on hosted |
| Platform use of the same pattern | `cli_login_postgres` is a member of `postgres` with `set=true, inherit=false` (grantor `supabase_admin`) | Supabase itself uses `SET TRUE, INHERIT FALSE` membership on this PG17 project |

**What catalog inspection proves:** the hosted migration identity has `CREATEROLE`, the PG17 self-grant behavior is the same as local (explicit SET grant needed), the role name and membership are not on supautils' reserved lists, and SET-only membership is a working mechanism on this project.

**What it cannot prove (requires an isolated hosted branch):** that supautils actually permits `CREATE ROLE intake_destructive NOLOGIN NOINHERIT NOBYPASSRLS` by `postgres`; that `GRANT intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE` is accepted; that `SET LOCAL ROLE` + `CREATE FUNCTION` in `intake_private` succeeds under supautils hooks; that hosted PostgREST behaves as locally for G10; and everything in G9 (backup/restore, branching).

**Preflight verdict:** no catalog evidence of a blocker; hosted feasibility is **likely but unproven**.

### 17.3 Remaining G2 and G9 requirements (unchanged authority; separate authorizations)
- **G2 — PROD parity (read-only, before PROD apply):** PROD `server_version`; `postgres` attributes incl. `createrole`; `createrole_self_grant`; supautils reserved roles/memberships; default ACLs in `public`; `appointments` trigger/constraint/index/inbound-FK fingerprints against the I0 baseline; absence of any `intake_*` object and of `intake_destructive`; `supabase_realtime` publication membership; parameter-logging settings.
- **G9 — backup/restore and branching (before PROD apply):** on a hosted branch with the rehearsal objects: (1) fingerprint role attributes, `postgres` SET membership, `intake_private` ACL, implementation owner/ACL, policies; (2) create a new branch from it and restore from the project's available backup path into a new project/branch (never into live DEV/PROD); (3) compare fingerprints, run the erasure smoke test through PostgREST, confirm the environment marker; (4) if the role, the SET membership or ownership is missing, apply the P3-b runbook (§6.1) and record whether every restore needs it; (5) file the result as a release artifact.
- **G7/G8/G10 hosted:** repeat RH01–RH04 on an isolated hosted branch (synthetic objects only), plus the read-only fingerprint before and after.

## 18. Hosted rehearsal evidence (revision 4.3)

### 18.1 Environment
Standalone temporary Supabase project `nsi-i1-rehearsal` (ref `fiurmeioieenkxiaynos`), same organization as DEV, `us-east-1`, Micro, **PostgreSQL 17.11**, created and deleted 2026-10-14 (deleted 09:32:48Z; absent from the organization project list afterwards). Pre-test isolation, all confirmed: unique ref; `public` empty (0 relations, 0 functions); no DanceFlow tables; 0 `auth.users`; 0 vault secrets; no Edge Functions or function secrets; no webhook/`pg_net` triggers; no `supabase_migrations`; only platform-internal connections; no link to the live application. `postgres`: `super=f createrole=t bypassrls=t`; `createrole_self_grant` empty; supautils reserved roles identical to DEV. The database password was generated locally, passed directly to the CLI and never printed or stored; API keys were read into memory only. Estimated cost: one Micro compute hour (about $0.013), plus about $0.013 for the earlier preview-branch attempt.

### 18.2 Results
| Gate | Hosted evidence | Result |
|---|---|---|
| G7 | Role created by `postgres` (not superuser); `nologin noinherit nobypassrls nosuper nocreaterole`; memberships = automatic `ADMIN` only + explicit `SET TRUE, INHERIT FALSE`; RH01 applied 3× → identical catalog fingerprint `097f96cd1ed0` | **PASS** |
| G8 | 33 SQL checks (RH02 31/31, RH04 2/2, audit-update test with 4 rows present): EXECUTE matrix; no API-role table privileges or `intake_private` USAGE; role-specific RLS; INSERT/UPDATE/audit-DELETE/profile-SELECT denied for the role; owner/service_role/authenticated/anon modification refused; TRUNCATE refused; append-only audit; hostile `search_path`/temp shadow ineffective; no privilege after the implementation returns or after a trapped error; erasure barrier and audited release; single studio-less marker | **PASS** |
| G10 | 14 substantive API checks through the hosted Supabase API (RH03): platform admin 200 (2 rows erased); ordinary user 403 `42501`; service-key-only 401; anon 401; spoofed `p_actor` 404 `PGRST202`; forged claims 401 `PGRST301`; unsigned token 401; private schema 406 `PGRST106`; reason required 400; audit actor = admin `auth.uid()`, exec role `intake_destructive`, other client intact; barrier release user 403 / admin 204; role `auth` USAGE = false. (The harness printed FAIL for the last check only because hosted CSV renders booleans as `false` where local psql printed `f`; the value meets the criterion.) | **PASS** |

The final hosted catalog fingerprint equals the local final fingerprint line for line, except for the harness results table described in §18.3. Hosted-only differences from local: service-key-only call returns 401 (local 403); both are denials.

### 18.3 Confirmed default-grant risk (basis for R25)
The hosted harness created `public.nsi_rh_results` (a results table used only by the rehearsal harness) **without** explicit revokes. Supabase's default privileges immediately granted it `arwdDxtm` (all privileges) to `anon`, `authenticated` and `service_role`, with RLS disabled. This reproduces on hosted the I0 finding about `pg_default_acl` and is the reason for rule R25: every intake object is revoked, granted, RLS-enabled and catalog-checked **in the migration that creates it**.

### 18.4 Mechanical adaptations for hosted execution (no change to tested logic)
RH01: removed the psql-only `\set ON_ERROR_STOP` line. RH02/RH04: replaced `BEGIN … ROLLBACK` with persisted results (the Management API returns only the last statement). RH03: hosted URL, keys from `supabase projects api-keys` (not printed), `supabase db query --linked` instead of `docker exec psql`, fresh synthetic client ids. RH09 unchanged.

### 18.5 Evidence archive
`docs/student-intake/rehearsal/` (local and hosted scripts, results and fingerprints; see its README). No credentials, keys or synthetic-user passwords are stored; RH03 now reads the synthetic password from `NSI_RH_SYNTHETIC_PASSWORD` at run time.

### 18.6 Parity caveat
Hosted evidence is on PostgreSQL 17.11; DEV and PROD run 17.6. Role and membership semantics are the same across 17.x, and the DEV read-only preflight (§17.2) is consistent, but the first real exercise on 17.6 hosted is the authorized I1 DEV apply (implementation plan, gate D-0).
