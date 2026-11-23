# Connected Apps Architecture (design proposal)

Status: DRAFT proposal, docs only. Nothing here is implemented or approved. Owner decisions are marked **OD-n** (collected in the Roadmap). No pricing decisions are made here; pricing questions are flagged as owner decisions.
Basis: audit of existing integrations (`Integrations_Audit_Existing.md`), candidate research (`Integrations_Candidates.md`), and existing patterns in the repo (cookie OAuth state, AES-GCM secret helper, Wave runs/lines/claims, Google item-map reconciler, PAY-WH-1 outbox, `outbound_deliveries`, `requireStudioFeature`).

## 1. Goals and non-goals
Goals: one consistent way for a studio (or a dancer) to connect, monitor, pause and remove third-party apps; one token vault; one sync/outbox engine; one status surface; a public-API/webhook layer that hedges the long tail (Zapier, Make); safe ARIA access.
Non-goals: no marketplace of third-party developers in v1; no inbound two-way edit of core records (lessons, payments, memberships) from outside systems; no SMS content or phone numbers leaving through generic webhooks (TW-4F boundary, pending TWILIO coordinator confirmation); no health data.
Principle: DanceFlow stays the system of record. Integrations are **projections** (we publish a view of our data) or **imports** (we ingest data we do not own, as suggestions or drafts), never silent co-editors.

## 2. Concepts
| Term | Meaning |
|---|---|
| Provider | A registered integration type (`google_calendar`, `microsoft_calendar`, `quickbooks`, …) with metadata: auth type, scopes per capability, supported owner kinds, approval state, rate limits |
| Connection | One authorized link between a DanceFlow owner and a provider account |
| Owner kind | `studio` (shared, admin-managed), `staff` (one instructor/staff member within a studio), `dancer` (one student profile; never shares data into the studio's connection) |
| Capability | A named thing a connection is allowed to do (`calendar.publish`, `accounting.post`, `leads.import`), each with its own scope set and its own on/off switch |
| Binding | Per-capability configuration (which calendar, which mapped accounts, which list) |
| Mapping (`sync item`) | Link from a DanceFlow object to the external object (id, etag, last hash) |
| Job | One unit of outbound or inbound work in the outbox |

## 3. Data model (proposed, per studio-scoped table; all rows carry `studio_id`)
- `integration_providers` — static/seeded registry (code-owned, not editable by studios): key, display name, auth type (`oauth2`, `api_key`, `webhook_only`, `none`), capabilities with required scopes, `approval_state` (`not_required|pending|approved|restricted_test_users`), docs URL, min plan feature key, owner kinds allowed.
- `integration_connections` — id, studio_id, owner_kind, owner_ref (instructor id / student profile id / null), provider_key, status (`pending|connected|needs_reauth|paused|error|disconnecting|disconnected`), external_account_id/label (email or company name), granted_scopes[], requested_scopes[], connected_by, connected_at, last_health_at, last_health_status, last_error_code (a stable code, not a provider message), `version` for optimistic locking.
- `integration_credentials` — connection_id (PK), `key_id`, encrypted blobs (access, refresh, API key, webhook secret), expiry, rotation counter. RLS enabled, **no policies, no grants to anon/authenticated**; read only by the service role through one server module (Wave's current pattern; fixes audit finding G1).
- `integration_capability_bindings` — connection_id, capability, enabled, config jsonb (validated per provider by a schema in code), updated_by.
- `integration_mappings` — connection_id, object_type, object_id, external_id, external_etag, content_hash, last_synced_at, last_status. Unique `(connection_id, object_type, object_id)`.
- `integration_jobs` (the outbox, see §7) and `integration_job_attempts` (optional, or counters on the job).
- `integration_inbound_events` — provider webhook deliveries: provider, delivery id (unique), signature_valid, received_at, claim lease, processed_at, outcome.
- `integration_audit_events` — append-only: studio_id, connection_id, actor (user id, `system`, `aria`), action (`connected|scopes_changed|capability_toggled|paused|resumed|disconnected|token_refreshed|export_requested|purge_completed|…`), metadata (no secrets, no PII beyond ids).
- `integration_pending_connects` — DB-backed OAuth state: state hash, PKCE verifier (encrypted) where used, studio, user, owner_kind/ref, provider, requested scopes, expires_at (10 min), consumed_at. Replaces the cookie-only state so pending/failed connects are visible to support and replay is impossible (single use).
- Existing tables (`studio_google_calendar_*`, `studio_wave_*`) migrate in later slices; they are not renamed up front. The generic layer must not break the live ones.

All new tables: RLS on; policies only for studio admins (and the owning instructor/dancer for their own `staff`/`dancer` connection) on non-secret tables; service-role-only on credentials, jobs, inbound events. Revoke default grants in the same migration (repo precedent: R25 in the NSI notes).

## 4. Permission and role model
Roles come from the existing studio role set (`platform_admin`, `studio_owner`, `studio_admin`, …, instructor, front desk, student). Proposed matrix:

| Action | Owner | Admin/Manager | Instructor | Front desk | Dancer | Platform admin |
|---|---|---|---|---|---|---|
| Connect/disconnect studio-level connection | yes | yes (OD-1: restrict accounting to owner?) | no | no | n/a | support view only |
| Connect own staff-level connection (e.g. personal calendar) | yes | yes | yes (own) | OD-2 | n/a | no |
| Connect own dancer-level connection (e.g. personal calendar, wallet pass) | n/a | n/a | n/a | n/a | yes (own) | no |
| Toggle capabilities / bindings (studio) | yes | yes | no | no | n/a | no |
| View status/health | yes | yes | own | read-only studio status (OD-2) | own | yes |
| Export / purge connection data | yes | yes | own | no | own | by request |
| Issue API keys / create webhooks | yes | OD-1 | no | no | no | no |

Rules: accounting, payroll and money-adjacent capabilities require owner-or-admin plus (for write capabilities) an explicit second step ("review run" as Wave does today). Staff/dancer connections can never be used by another user's job. A job executes with the authority of the connection's owner and only for data that owner could already see in DanceFlow.

## 5. Connection UX
### Business (studio hub `/app/settings/integrations`)
- Catalogue of cards generated from the provider registry (replaces hand-built cards): state badge (`Available`, `Connected`, `Needs attention`, `Paused`, `Locked by plan`, `Coming soon`), one-line value, "what DanceFlow will send/receive" panel, **requested scopes in plain language**, and for each capability a switch.
- Connect flow: select capability set first → least-scope consent request (incremental authorization where the provider supports it) → return page shows what was granted vs requested; if a required scope was declined the connection is saved as `connected` with that capability disabled and a "fix permission" action (closes audit finding G5).
- Detail page: account label, last sync, next scheduled sync, health trend, open exceptions (dead-letter), audit log, "Sync now", "Pause", "Disconnect".
- Disconnect dialog states exactly what will be deleted/kept (see §11) and requires typing nothing but confirming; for connections with outstanding external objects (calendar events) the default is "remove DanceFlow-created items from <provider> first"; failures block disconnect with a "disconnect anyway" owner option (OD-3: audit-recorded orphans).

### Dancer (student app + web portal)
- A small "Connected apps" screen under profile: only dancer-appropriate providers (personal calendars, wallet passes, later practice/music). Each shows exactly what leaves DanceFlow, and a one-tap remove. Dancer connections never appear in studio admin screens except as an aggregate count; the studio cannot read dancer tokens or external account ids.
- Prefer zero-credential methods (ICS subscription URL, wallet pass add button) for dancers; use OAuth only where a subscription cannot do the job.

### Support and platform admin
- A `/platform/integrations` view (read-only by default): connection counts by provider/state, failing jobs, approval state per provider, credential expiry, with studio-scoped drill-in through the existing platform-admin studio-context rules.

## 6. Authorization (OAuth) hardening
- Server-side authorization-code flow for every provider; confidential client where the provider supports it. PKCE (S256) whenever the provider supports it, even for confidential clients.
- State: random 256-bit, stored hashed in `integration_pending_connects`, single use, 10 min TTL, bound to studio + user + owner kind/ref + provider + requested scopes; callback re-authorizes the user server-side (role check) and re-checks the binding.
- One callback origin from a single required config value (no request-origin fallback; audit G12). Redirect URIs registered per environment.
- Store the **granted** scopes returned by the provider and compare with the capability's required scopes.
- Refresh with a per-connection lease (advisory lock or row claim) so concurrent workers cannot race (audit G9/W6); persist rotated refresh tokens atomically; classify failures (`invalid_grant` → `needs_reauth`; network/5xx → retry with backoff, no state change).
- Revoke at the provider on disconnect where an endpoint exists (Google, Microsoft, Intuit, Xero, Zoom, Meta) and record success or "provider revoke unavailable/failed" in the audit log.
- API-key providers (rare): keys encrypted in the same vault, shown once, rotation supported.

## 7. Token vault
- Single module `src/lib/integrations/vault` (moved from `wave/secrets.ts`). AES-256-GCM envelope with **`key_id`** in the ciphertext header (`v2.<kid>.<iv>.<tag>.<ct>`); decrypt accepts all active ids; encrypt uses the current id. Keys supplied by env (current + previous), design leaves room for a KMS later (OD-4).
- Rotation procedure: add new key id → deploy → background job re-encrypts rows → retire old key; a health check reports rows still on an old key.
- Never log tokens or provider error bodies containing tokens; log provider request ids.
- The vault API is `withCredentials(connectionId, fn)`; callers never hold refresh tokens, only a short-lived access token for one call.
- Credentials are excluded from every export, backup report and ARIA tool result.

## 8. Sync engine
### 8.1 Outbound (DanceFlow → provider): transactional outbox
- Domain code writes an `integration_jobs` row **in the same transaction** as the change that triggers it (reuse the NSI/PAY-WH-1 decision: refs only, never full payloads; render and re-validate at send time; claim by id; lease + attempts + `next_attempt_at`). Because the Google reconciler already converges by diff, calendar projection can keep a "reconcile connection" job type, triggered by change events and a safety-net cron, instead of one job per appointment.
- Job: `{id, studio_id, connection_id, capability, kind, subject_type, subject_id, idempotency_key, status, attempts, next_attempt_at, lease_until, last_error_code, payload_ref}`; idempotency key = `connection:capability:subject:version`.
- Worker: Vercel cron drains small batches under a time budget (`maxDuration` set; per-connection concurrency of 1; global concurrency cap); claims with a lease; executes with the connection's credentials; completes or schedules a retry.
- Retry/backoff: exponential with jitter (e.g. 1 min → 6 h, max 8 attempts), honour `Retry-After`, circuit-break a connection after N consecutive failures (status `error`, job intake continues but execution is paused, owner notified).
- Dead letter: after max attempts → `dead` with a stable error code; surfaced in the detail page with "retry" and "ignore" actions; never silently dropped.
- "Uncertain" outcome state (Wave pattern): a timeout or 5xx on a non-idempotent create is recorded as `uncertain` and resolved by a lookup on the external id before any retry. Providers that support client-supplied ids or extended properties (Google `extendedProperties`, Wave `externalId`, Xero/QBO idempotency keys) are preferred.

### 8.2 Inbound (provider → DanceFlow)
- One route per provider `/api/integrations/webhooks/<provider>` that does only: verify signature (provider-specific, constant-time), record the raw delivery id in `integration_inbound_events` (unique → duplicates become no-ops), return 2xx quickly; processing happens by claim from the table (PAY-WH-1 claim/lease pattern).
- Prefer "tickle + fetch" (webhook says something changed, worker fetches current state) over trusting payload content.
- Providers that need subscription renewal (Microsoft Graph, Google `events.watch`) get a renewal job and a poll fallback; webhook silence beyond a threshold flips health to `degraded`.
- Imports (e.g. lead ads, calendar busy times) land in **staging** (lead inbox, suggestions), not directly in core tables.

### 8.3 Rate limits and fairness
Per-provider token buckets in code (from provider docs), per-connection and global; 429/403-rate-limit responses push `next_attempt_at`; one noisy studio cannot starve others (round-robin claim by connection).

## 9. Conflict handling by data type
| Data | Source of truth | Rule |
|---|---|---|
| Appointments, classes, events → external calendar | DanceFlow | One-way projection. External edits are overwritten on next reconcile (document it); external deletion of a live item is recreated once and flagged. Optional later: read external **busy** times as availability hints (never create lessons) |
| Accounting entries (revenue, refunds, fees) | DanceFlow ledger | Append-only posting with external id; reviewed runs for money; no back-sync of external edits; reconcile report shows differences instead of auto-fixing |
| Contacts / leads from ads or forms | External until accepted | Import to lead inbox with source + consent flags; de-dup by normalized email/phone; accepted lead becomes a DanceFlow record; no overwrite of an existing client's fields (suggest-merge only) |
| Marketing audiences (email tools) | DanceFlow | One-way subscribe/unsubscribe projection with consent source; provider unsubscribe/bounce events flow back as suppression, never as a re-subscribe |
| Passes (wallet) | DanceFlow | Pass content derived from membership/package state; updates pushed; revoked on cancellation |
| Meeting links (Zoom/Meet) | DanceFlow | Create-on-schedule; stored on the appointment; deleted when appointment cancelled |
| Payroll / hours | DanceFlow payroll prep | Export-only or time-sheet delivery per approved batch; never imports pay rates |
Version rule everywhere: each mapping stores the last content hash we wrote; if the external object's etag/hash is not what we last wrote we log `external_drift` and apply the table rule above, rather than guess.

## 10. Entitlements, flags and approval tracking
- Gate order for any provider capability: global kill switch env (`INTEGRATION_<PROVIDER>_ENABLED`) → provider `approval_state` → studio plan feature (`requireStudioFeature(<key>)`; mapping of providers to plans and any per-integration price is **OD-5, an owner decision**) → optional per-studio allowlist (Wave's entitlement pattern, for pilots) → connection `status` → capability switch.
- The provider registry carries `approval_state` so the UI can say "Available to pilot studios only" while Google/Microsoft/Meta verification or app review is in progress; the platform admin page shows the review checklist per provider (consent-screen verification, app review submission date, expected lead time).
- All provider enrollments (developer accounts, OAuth app registration, app review submissions) are **owner-authorized actions**; this document does not perform or schedule any.
- Dancer-facing connectors follow the same flag ladder plus store policy checks for the mobile apps.

## 11. Data ownership, export and deletion
- Studio owns studio-level connections and the data in them; the staff member owns a staff-level connection; the dancer owns dancer-level connections. Providers' data stays with providers.
- On disconnect: (1) stop jobs; (2) optionally remove DanceFlow-created external objects (default for calendars); (3) revoke at provider; (4) delete credentials immediately; (5) keep mappings and audit log for a retention period (OD-6, default 90 days for mappings, audit per studio retention policy) then purge; (6) imported data that was accepted into DanceFlow stays (it is the studio's record); staged, unaccepted imports are purged.
- Connection-level export: a downloadable JSON/CSV of mappings, job history and audit trail (no secrets). Dancer deletion request cascades to dancer connections.
- Studio offboarding runs the same disconnect pipeline for every connection.

## 12. Observability and status surface
- `integration_health` computed per connection: last success, consecutive failures, dead-letter count, token expiry, webhook freshness → `healthy|degraded|attention|paused`.
- Studio hub shows state and one actionable sentence ("Reconnect Google: permission was removed"). Owners get notification on `needs_reauth` or sustained failure (existing notification system), once per incident.
- Platform view: fleet metrics, per-provider error codes, oldest unprocessed job age; alert when any job is older than a threshold.
- Stable error-code taxonomy (`auth_revoked`, `scope_missing`, `rate_limited`, `provider_unavailable`, `invalid_payload`, `external_drift`, `quota_exceeded`, `uncertain`) used in UI, KB articles and ARIA explanations.

## 13. Public API, webhooks and Zapier/Make (long-tail hedge)
- Outbound **webhooks** (studio-configurable endpoints) built on the same outbox: event types limited to a reviewed allowlist (`lead.created`, `appointment.booked`, `appointment.cancelled`, `client.created`, `payment.succeeded`, `membership.started/ended`, `document.signed`), ids and minimal fields, signed (HMAC-SHA256 with timestamp, per-endpoint secret shown once, rotation), retries with backoff, delivery log, replay. Hard exclusions: SMS content and phone numbers (pending TW-4F confirmation), card data, minors' sensitive fields, health data, anything Competition-confidential (internal).
- Inbound **REST API** with per-studio API keys scoped to resources (read leads, create lead, read schedule, read client lookup) and strict rate limits; idempotency keys on writes. Built on the Staff API contract conventions (flat errors, idempotency semantics) rather than a parallel style.
- Zapier/Make: first use generic webhooks + REST + API keys with a "Webhooks by Zapier" recipe set in the KB (zero provider approval). A branded public Zapier or Make app is later, only if usage shows demand (see Candidates).
- Review gate: each new event or endpoint passes a data-classification review (what PII, what consent basis).

## 14. ARIA hooks
- **Read tools** (no side effects, role-checked like the user): `integrations.list_connections`, `integrations.get_health(connection)`, `integrations.list_failed_jobs`, `integrations.explain_error(code)`, `calendar.preview_sync(connection)`.
- **Suggest-only (default)**: "Your Google connection needs reconnecting — 12 appointments haven't synced since Tuesday", "3 leads arrived from <source> and are unanswered", "Last month's revenue has 4 uncertain Wave lines to review", "Offer calendar subscription to 14 dancers with no calendar connected" — each as a notification or drafted message the user sends.
- **Act with approval (one-click)**: retry a dead job, pause/resume a connection, re-run a sync. Confirmation card shows exact effect.
- **Never autonomous**: connect/disconnect, scope changes, anything that posts money-related data, sends marketing to an external audience, creates API keys/webhooks, or touches dancer-owned connections. Matches the existing autonomy model (rules decide; "handle automatically" never exceeds what the rule permits).
- All ARIA actions are audit events with actor `aria` and the approving user.

## 15. Security and privacy checklist (per provider, before enabling)
Least scopes; data-minimisation switches (e.g. do not put client names in external calendar descriptions by default for dancer-visible shared calendars — OD-7); consent basis recorded for any contact export; minors' data excluded unless a guardian-level rule exists; provider terms reviewed for data-use limits (Meta, Google API Services user-data policy); sub-processor/privacy-policy update owned by the owner; incident runbook entry (how to bulk-revoke a provider's tokens).

## 16. Migration of existing integrations
1. Land vault v2 + audit + pending-connect tables without touching live flows.
2. Move Google Calendar to the generic connection/credentials tables (copy, dual-read, cut over), fixing G1–G5 on the way. Keep the reconciler as the `calendar.publish` capability.
3. Wave stays on its tables; adopt vault v2, audit table and health; add tests (W2) before any provider expansion. Gusto stays dormant.
4. New providers are generic from day one.

## 17. Test strategy (developer-owned QA)
Provider fakes for OAuth and APIs (deterministic), contract tests per provider adapter, RLS tests (cross-studio, cross-role, staff/dancer ownership), vault tests (rotation, tamper), outbox tests (lease expiry, duplicate delivery, crash after external write, `uncertain` resolution), webhook tests (bad signature, replay, ordering), disconnect/deletion tests, and a QA matrix entry per provider capability. Items needing live provider accounts are marked BLOCKED until the owner authorizes the account.
