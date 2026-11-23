# Public REST API and Outbound Webhooks: implementation design (priority 2)

Status: DESIGN ONLY (docs). Roadmap priority #2 approved by the owner (OD-10, 2026-11-23) as a priority, not an activation. No implementation, SQL, enrollment, fee or pricing decision (OD-5: none). Nothing ships on until a separate release decision; every surface is off by default behind a kill switch and a per-studio allowlist.
Inputs: `Connected_Apps_Architecture.md` (sections 7, 8, 13, 18), `Integrations_Roadmap.md` (B2, B3, B4), `Calendar_Feeds_Design.md` and its dark implementation (PRs 820-823: hash-only tokens, tenant-guarded service-role RPCs, DB rate limiter, one-time reveal, fail-closed behaviour), `docs/mobile/Staff_API_Contract.md` (flat errors, `Idempotency-Key`, client-supplied entity ids).
Internal-confidential note: generic. Competition-governed data classes, minors' data, scoring, judge identity and payment data are excluded by construction (section 9); nothing about unreleased plans is written here.
Sequencing: this design assumes Slice 0's foundation PRs (vault v2, `integration_audit_events`, kill-switch flags). Where they are not yet merged, an interim is named so no slice is blocked by design alone; implementation does not start until the APPS coordinator confirms sequencing.

## 1. Goals, non-goals
Goals: (a) a small, safe, versioned public REST API a studio owner can use through API keys (and through Zapier/Make later) to push leads in and read published schedule data out; (b) signed outbound webhooks for a reviewed event allowlist; (c) one data-classification gate that makes the hard exclusions structural, not a convention.
Non-goals for v1: any write other than creating a lead; reading clients, payments, memberships or documents; OAuth for third-party developers; a marketplace; bulk export; SMS/consent events; per-integration pricing.

## 2. Reuse (do not reinvent)
| Need | Reuse | From |
|---|---|---|
| Hash-only secrets, one-time reveal, prefix for support | `generateFeedSecret`/hash pattern, `calendar_feed_tokens` shape | PR 820/821 |
| Tenant-guarded writes | SECURITY DEFINER RPCs taking `p_studio` + subject, service-role only, no API-role grants, `lock_timeout`, pinned search_path | PR 820 |
| Rate limiting | DB fixed-window counter, fail-closed on limiter error, hashed keys | `calendar_feed_rate_check` (generalize to `integration_rate_check`) |
| Audit | append-only audit table | `integration_audit_events` (Slice 0 A1); interim: `public_api_audit_events` with the same shape |
| Secret encryption (webhook signing secrets) | vault v2 envelope with key id | Slice 0 A1; interim: `encryptIntegrationSecret` v1 (AES-256-GCM) behind a `vault.encrypt/decrypt` wrapper so v2 is a drop-in |
| Outbox, claim/lease/backoff | PAY-WH-1 pattern (claim with lease, attempts, `next_attempt_at`, completion, visible failure) | `settlementOutbox.ts`, `claim_*` functions |
| Error shape, idempotency semantics | flat `{ error, code }`, `Idempotency-Key` 8-128 chars, client-supplied entity ids | Staff API contract |
| Kill switches | per-surface env flag + per-studio allowlist table, default off | calendar feeds |
| Disconnect/lifecycle audit, ARIA read tools | Connected Apps sections 5, 12, 14 | Architecture |

## 3. Data model (new tables; RLS on, no policies, privileges revoked from PUBLIC/anon/authenticated; service-role access through RPCs)
- `api_keys`: id, studio_id, name, `key_prefix` (8 chars, unique with studio), `key_hash` (SHA-256 of a 256-bit secret, unique), scopes text[] (allowlisted values only), `status` (`active|revoked|expired`), created_by, created_at, `expires_at` (default 12 months), `last_used_at` (throttled write, at most once per 15 min), `last_used_ip_prefix` (/24 or /64, truncated), `rate_limit_per_minute`/`per_day` (caps within global ceilings), `rotated_from`, `superseded_at`/`valid_until` for overlap (same model as feed tokens). Key format: `dfk_live_<prefix>_<secret>`; only the prefix is non-secret and indexed for lookup; lookup then constant-time hash compare.
- `webhook_endpoints`: id, studio_id, url, `signing_secret_cipher` + `key_id` (vault), `previous_secret_cipher`/`previous_valid_until` (rotation overlap), `events` text[], `status` (`active|paused|disabled`), `consecutive_failures`, `disabled_reason`, created_by, timestamps. Max 5 endpoints per studio.
- `webhook_events`: id (`evt_<uuid>`, stable across retries), studio_id, type, `occurred_at`, `payload` jsonb (minimal; see 7), `schema_version`. Retained 30 days.
- `webhook_deliveries`: id (`dlv_<uuid>`, unique per attempt-chain), endpoint_id, event_id, attempt, status (`pending|in_flight|succeeded|failed|dead`), `next_attempt_at`, `lease_until`, response_code, `latency_ms`, `error_code` (taxonomy, never remote body beyond 256 truncated chars after secret scrub), `request_id`. Retained 30 days.
- `api_idempotency`: key hash, api_key_id, endpoint, request_hash, status, response_ref (id of created resource, not body), expires_at (24 h).
- `api_studio_settings`: studio_id, `api_enabled`, `webhooks_enabled` (default false), updated_by (same pattern as `calendar_feed_settings`).
- Events enter via a transactional outbox write by an RPC/trigger in the same transaction as the domain change (supabase-js cannot span a transaction): `public_event_emit(p_studio, p_type, p_ref, p_payload)` called from the domain RPCs/triggers, which no-ops when the studio has no matching active endpoint.

## 4. API surface v1 (`/api/public/v1`, JSON, HTTPS only)
Auth: `Authorization: Bearer dfk_live_...` only (never query string, never cookies, CORS disabled; the API is server-to-server). Every response carries `X-Request-Id`; errors are flat `{ "error": "...", "code": "..." }` with stable codes (`invalid_request`, `unauthorized`, `forbidden_scope`, `rate_limited`, `idempotency_conflict`, `not_found`, `studio_disabled`, `payload_too_large`, `server_error`). Unknown/revoked/expired keys all return the same `401`. 404 never confirms a resource exists in another studio.
| Route | Scope | Notes |
|---|---|---|
| `POST /leads` | `leads:write` | Creates a lead (a `clients` row with status `lead`, same insert path as the public lead form). Body: `firstName`, `lastName`, `email` and/or `phone`, `source` (free label, <= 60 chars, default "API"), `note` (<= 500, plain text), optional `externalId` (<= 64, per-key unique for replay). Requires `Idempotency-Key`. **Never sets SMS consent** (explicit SMS consent only comes from the studio's own opt-in form; TW-4F rule); email marketing consent is not set either; duplicate-by-email in the same studio returns `409 duplicate_lead` with no data about the existing record |
| `GET /leads/{id}` | `leads:read` | Only leads created by the same key (status, created time); no other client data |
| `GET /schedule` | `schedule:read` | Published, public class and event schedule (the same fields the website embeds already expose); window <= 90 days; cursor pagination, limit 1-100 |
| `GET /events` | `schedule:read` | Published public events (no registrations, no attendee data) |
| `GET /ping` | any | Key check |
No client lookup, no rosters, no payments, no documents, no private lessons, no minors. Adding any route or field needs the classification review in section 9. Versioning: path `v1`; additive changes only within v1; breaking changes need `v2` and a deprecation notice period (owner decision on the period).
Request hardening: body size cap (16 KB), strict JSON schema validation (reject unknown fields), string length caps, control-character stripping, email/phone normalization, honeypot/bot checks are not applicable (key-authenticated) but the per-key rate limit and a per-studio daily lead cap (default 500) apply; lead creation reuses the existing lead validation and `checkPublicFormProtection`-independent normalization rules.
Rate limits (fixed windows via DB counter, fail closed 503 on limiter error, `Retry-After` on 429): per key 60/min and 5,000/day by default, per studio 300/min, global ceiling via platform rule; keys in buckets are hashed prefixes, never secrets.

## 5. API key lifecycle and authorization
- Creation: owner/admin only (OD-1), in the web app; the full key is shown once (same one-time-reveal panel pattern as calendar feeds); the studio chooses scopes from the allowlist; keys are studio-owned, not person-bound, and show `created_by`. Max 10 active keys per studio.
- Rotation with overlap: issuing a replacement can keep the old key valid for <= 24 h; a second rotation kills every older overlapping key (same rule as feeds).
- Revocation: immediate; automatic revoke when the creator loses the owner/admin role until an owner re-confirms the key (mirrors the feed hooks), when the studio is disabled for the API, on studio offboarding, and by an incident "revoke all keys" action.
- Usage: last-used time and truncated IP shown to the owner; anomaly signals (new country/ASN is out of scope without geo data; v1 flags a sudden 10x volume or repeated 401s from one IP) notify the owner and can auto-pause the key.
- Verification path: `resolve_api_key(p_prefix, p_hash)` RPC returns studio, key id, scopes, limits only for an active, unexpired key whose studio has `api_enabled`; uniform empty result otherwise; the app compares hashes in constant time; never logs the key.
- Tenant isolation: every handler receives the studio from the key resolution and passes it to every query/RPC; there is no studio id in any request path or body; tests include cross-studio attempts for every route.

## 6. Webhooks: delivery
Endpoint registration (owner/admin, web UI): HTTPS on port 443 only, public hostname, URL <= 2 KB, no credentials in the URL, <= 5 per studio; on creation DanceFlow sends a signed `ping` event synchronously and requires a 2xx before activating (proves reachability, and the SSRF guard has already run). The signing secret is generated server-side (>= 256 bits), shown once, stored vault-encrypted (HMAC needs the raw value; it cannot be hash-only).
Signature (Stripe-style, documented in the KB with sample code in Node, Python, PHP and Zapier "Code" step):
`DanceFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>[,v1=<hex with previous secret during overlap>]`.
Headers also carry `DanceFlow-Event-Id`, `DanceFlow-Delivery-Id`, `DanceFlow-Event-Type`, `DanceFlow-Attempt`, `User-Agent: DanceFlow-Webhooks/1`. Body: `{ "id": "evt_...", "type": "...", "created": "<ISO>", "apiVersion": "2026-12-01", "studioId": "<uuid>", "data": { ... } }`.
Replay protection (receiver side, documented): reject `t` older than 5 minutes (tolerance), dedupe on `DanceFlow-Event-Id`, treat `DanceFlow-Delivery-Id` as per-attempt. DanceFlow side: retries re-sign with a fresh `t` and keep the same event id; an owner replay creates a new delivery id with the same event id and `DanceFlow-Replay: true`.
Secret rotation with overlap: "Rotate secret" generates a new secret, keeps the old one valid for 1-7 days (owner chooses, default 24 h) and signs with both during overlap (`v1=...,v1=...`); after the overlap the old secret is erased. Rotation is audited and a second rotation inside an overlap drops the oldest secret.
SSRF-safe delivery (a dedicated delivery module, the only code that makes outbound customer-URL requests):
1. Parse URL with WHATWG URL; require `https:`, port 443 (or none), no userinfo, hostname not an IP literal, no `localhost`/`.local`/`.internal`-style names, punycode-normalized.
2. Resolve with `dns.lookup(all)` at send time; reject if ANY answer is non-public: IPv4 private/loopback/link-local/CGNAT (100.64/10)/multicast/benchmark/documentation/`169.254.169.254` metadata, IPv6 loopback/ULA `fc00::/7`/link-local `fe80::/10`/multicast/IPv4-mapped (`::ffff:0:0/96`)/NAT64.
3. **Pin** the connection to the validated address (custom `lookup`/undici `connect` hook; TLS SNI and Host stay the original hostname) so there is no re-resolution between check and connect (no TOCTOU/DNS rebinding).
4. No redirects followed (3xx = failure), 10 s total timeout, 256 KB request body cap (events are tiny), 64 KB response read cap then abort, no cookies, no proxy env honoured, TLS verification always on, TLS >= 1.2.
5. Egress runs in the existing serverless function; if a stricter egress control (allowlisted proxy) becomes available it replaces step 2-3 without API change.
Delivery success: any 2xx. Retries: exponential with jitter (1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h; 8 attempts over ~48 h), honour `Retry-After` up to 1 h, 410 Gone disables the endpoint immediately, 3xx/4xx(except 408/429) count as permanent failures after 3 tries, repeated failures set `consecutive_failures`; at 20 consecutive failures the endpoint is auto-paused with an owner notification (once per incident) and a "re-enable" action that sends a ping first. Dead deliveries stay visible (`dead`) with a stable error code; the owner can replay any event for 30 days.
Worker: Vercel cron every 1-5 min under a time budget (set `maxDuration`), claim batches with leases (`SKIP LOCKED` style RPC), per-endpoint concurrency of 1 and ordering best-effort (documented: no ordering guarantee; payloads carry `occurred_at` and a monotonic `sequence` per studio for receivers who need it).

## 7. Event allowlist and payloads
| Event | Trigger | `data` (v1, minimal) |
|---|---|---|
| `ping` | endpoint setup/test | `{}` |
| `lead.created` | lead created from the public form, an embed or the API | `{ leadId, source, createdAt }` + opt-in `contact` object (firstName, lastName, email, phone) only for endpoints created with `includeContact: true` and never for a person under 18 or with unknown age |
| `appointment.booked` / `appointment.cancelled` | private lesson / class booking changes | `{ appointmentId, type (allowlist), startsAt, endsAt, status }` ids and times only; no names, no notes |
| `class.schedule_changed` | published class create/update/cancel | the public schedule fields |
| `event.published` / `event.updated` | public (non-competition) event published or changed | the public event fields (as the embed API) |
| `membership.started` / `membership.ended` | membership state change | `{ membershipId, planName?, startsAt/endsAt }` ids and dates; no names, no payments |
| `document.signed` | a studio document was signed | `{ documentId, templateName, signedAt }`; no content, no signer identity beyond an id |
Everything else is rejected at registration (unknown event type). Payloads are snapshots of ids/changed fields built by the emitting RPC, never joined dynamically at delivery time; free-text fields are excluded. Payload size cap 8 KB. `contact` fields are an owner opt-in per endpoint with a consent-basis acknowledgement recorded in the audit log (the studio is the processor of what it forwards; KB says so).

## 8. Delivery log, replay and owner UI
Web UI (owner/admin): Settings > Integrations > API & webhooks: keys (create, scopes, rotate, revoke, last used), endpoints (create/test, events, rotate secret, pause/resume, delete), delivery log (status, attempts, latency, truncated error, event id; no response bodies beyond the truncated scrubbed snippet), per-event "Replay", incident actions (revoke all keys, pause all endpoints). Every action audited. Read tools for ARIA (list keys without secrets, list failing endpoints, explain a delivery error code); suggest-only prompts ("Your webhook to X has failed 12 times"); no ARIA action creates keys/endpoints or changes scopes (Architecture 14).

## 9. Data classification gate (structural exclusions)
- A code-owned registry `PUBLIC_API_FIELD_CLASSES` lists, per route and event, every field with a class (`public`, `studio_internal`, `personal`, `sensitive`). Only `public` fields ship by default; `personal` only through explicit opt-in (leads contact); `sensitive` never. A unit test fails the build when a route/event emits a field missing from the registry or not allowed for its class (same spirit as the feed event-type allowlist).
- Hard exclusions (enforced by registry + tests): SMS content and consent history (TW-4F engineering position), minors' (U18) data (events with a minor attendee are suppressed or reduced to ids), Competition-governed event classes, scoring/results/judge identity, payment/Stripe/card data, health data, authentication artifacts, internal notes. Lifting any exclusion needs a documented owner decision (and, for Competition, a rulebook-governed decision).
- Adding a route, event or field requires the registry change in the same PR plus a review entry (a checklist in the PR template for this directory).

## 10. Observability, abuse and incident response
Per-key/endpoint counters (requests, 4xx/5xx, latency p95, deliveries, failures) in a daily rollup table (no request bodies logged). Structured logs carry request id, key id (never the key), studio id, route, status; PII is never logged. Platform view: studios with API/webhooks enabled, failing endpoints, oldest pending delivery age (alert threshold). Incident runbook: bulk-revoke all keys (one RPC), pause all endpoints, disable the API/webhook surface globally by env flag, rotate the vault key and re-encrypt secrets. Abuse: per-key caps, per-studio lead caps, honeypot-free dedupe, auto-pause on volume spikes.

## 11. Testing (developer-owned QA matrix)
SQL (disposable postgres under the heavy lock): privilege sweep, key issue/rotate/overlap/zero-overlap-kills-older, resolve uniformity (unknown/revoked/expired/superseded/studio-disabled), tenant guards on every RPC with wrong studio/subject, claim/lease concurrency (two workers, expired lease), idempotency uniqueness and request-hash mismatch, retention purge, triggers/hooks, rollback + re-apply. Unit/integration (vitest): auth (missing/malformed/revoked/expired/wrong scope), schema validation (unknown fields, oversize, control characters), idempotency replay vs conflict, lead creation parity with the form path (no SMS consent, duplicate handling), rate limit and fail-closed, response shape/flat errors/`X-Request-Id`, registry tests for exclusions and U18, signature vectors (known-answer tests incl. overlap and tolerance), SSRF suite (every blocked range, IPv4-mapped IPv6, DNS returning mixed answers, rebinding between lookup and connect with a fake resolver, redirects, port != 443, userinfo, oversized response, slow-loris timeout), retry/backoff schedule, auto-pause, replay semantics. QA evidence: a recorded end-to-end run on DEV with a local receiver (Zapier "Catch Hook" equivalent) is BLOCKED until a DEV studio is enabled by ops; third-party endpoints are never used for testing without owner authorization.

## 12. Slices and estimates (one engineer, +-50%; calendar excluded)
| Slice | Content | Est. | Depends on |
|---|---|---|---|
| P0 | Generic rate-limit RPC, kill switches, studio settings, audit (or consume Slice 0 A1), data-classification registry skeleton | 5-7 d | Slice 0 A1 (or interim tables) |
| P1 | API keys (schema, RPCs, resolve, one-time reveal UI, rotation, revocation hooks) + `GET /ping` | 8-10 d | P0 |
| P2 | `POST /leads`, `GET /leads/{id}`, idempotency store, lead parity tests | 6-8 d | P1 |
| P3 | `GET /schedule`, `GET /events`, pagination, registry coverage | 4-6 d | P1 |
| P4 | Webhook endpoints + secrets (vault), signing, SSRF-safe delivery module + test suite | 8-10 d | P0, vault v2 (or wrapper) |
| P5 | Event emission RPCs/triggers (`lead.created` first), outbox worker/cron, retries, auto-pause, delivery log + replay UI | 10-13 d | P4 |
| P6 | KB articles (signature verification samples, Zapier "Webhooks by Zapier" recipes), QA matrix, incident runbook | 3-4 d | P2, P5 |
Total about 44-58 engineer-days. A private Zapier/Make app (B4) follows only after P2 and P5 and needs separate owner authorization for any developer account (OD-9).

## 13. Owner decisions and open items
1. Scope of v1 routes (proposal: leads write/read-own, public schedule/events read; nothing else). 2. Whether API-created leads may ever carry SMS consent (proposal: no; the TWILIO coordinator should confirm). 3. Default contact opt-in for `lead.created` webhooks and the consent acknowledgement wording. 4. Key expiry default (12 months) and max keys/endpoints per studio. 5. API versioning/deprecation notice period. 6. Whether `membership.*` and `document.signed` are in v1 or follow later (proposal: after leads/appointments prove out). 7. Retention (events/deliveries 30 days). 8. Per-studio daily lead cap default. 9. Sequencing with Slice 0 (vault v2, audit events) and the heavy-job lock for the SQL suites. 10. Any pricing or plan gating is NOT decided (OD-5); engineering ships behind flags only. 11. Provider enrollments for Zapier/Make remain separate authorizations (OD-9).
