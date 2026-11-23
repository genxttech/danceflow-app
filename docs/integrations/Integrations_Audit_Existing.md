# Existing Integrations Audit — Google Calendar, Wave, Gusto

Status: DRAFT for owner/coordinator review. Read-only repo analysis at main `8537ab19b` (2026-11-23). Docs only; nothing was run against DEV or PROD, no hosted SQL, no provider contact.
Status words: **V** verified in code, **A** assumed / not verifiable from the repo (production env values, hosted state), **P** probable defect (reasoned from provider docs, not run).

## 1. Summary

| Integration | State in repo | Direction | Scope | Production status |
|---|---|---|---|---|
| Google Calendar | Live code, settings UI, cron every 30 min | One-way push (DanceFlow → Google) | Studio calendar and per-instructor calendar | A (Google OAuth config and client values not visible) |
| Wave Accounting | Live code, settings UI, platform-admin rollout page, posting runner | One-way push (journal-style money transactions) | Per studio | Posting is env-gated (`WAVE_POSTING_ENABLED`), per-studio allowlisted, per-connection `posting_mode` (A for PROD values) |
| Gusto (payroll) | **DORMANT**: `GUSTO_INTEGRATION_ENABLED = false` (`src/lib/integrations/gusto/dormant.ts`); routes return a dormant response; tables kept | Was: time-sheet delivery to Gusto | Per studio | Off. Roadmap v2.22 already corrected "active baseline" to dormant |

The briefing named two integrations; there are three code paths. Gusto is retained code, not a product feature. No other third-party OAuth integration exists. Native (non-third-party) pieces that matter for the strategy: public ICS feeds for studios, organizers, instructors and coach schedules; website embeds; accountant deliveries; payroll prep and PDF/CSV batches; Stripe (Connect); Twilio SMS; Resend email; Mux video.

## 2. Google Calendar

### 2.1 What exists (V)
- OAuth routes: `src/app/api/integrations/google-calendar/{connect,callback}/route.ts`. Authorization-code flow, `access_type=offline`, `prompt=consent`, confidential client (client secret on server), redirect URI built from `NEXT_PUBLIC_APP_URL`.
- Scopes: `calendar.events`, `calendar.calendarlist.readonly`, `userinfo.email`. Reasonably narrow (no full `calendar` scope).
- State: `src/lib/security/oauth.ts` — random 32-byte state in an httpOnly, sameSite=lax, secure cookie (10 min), bound to studio id, user id, connection scope and instructor id; timing-safe compare. No PKCE (acceptable for a confidential server client).
- Two connection scopes: `studio` (one per studio, role must satisfy `canManageSettings`) and `instructor` (one per instructor, user must be linked to an active instructor row). Partial unique indexes and a validation trigger enforce this (`20260709_google_calendar_integration_v1.sql`, `20260712_google_calendar_personal_instructor_sync_v2.sql`).
- Token storage: `encrypted_access_token`, `encrypted_refresh_token` columns on `studio_google_calendar_connections`; AES-256-GCM via `encryptIntegrationSecret` (`src/lib/integrations/wave/secrets.ts`, format `v1.<iv>.<tag>.<ct>`, key env `INTEGRATION_TOKEN_ENCRYPTION_KEY`, 32 bytes hex/base64). Server decrypts with the service-role client.
- Sync: `src/lib/integrations/google-calendar/sync.ts`. Reconciler keyed by `(connection_id, source_type, source_id)` in `studio_google_calendar_sync_items`; PATCH existing event, recreate on 404/410, delete when ineligible (cancelled, no_show, sync flag off, other instructor), and a deliberate rule that a moving 90-day fetch window never deletes by itself (S1E-4). Events carry `extendedProperties.private.danceflowSourceId`.
- Triggers: Vercel cron `/api/cron/google-calendar-sync` every 30 min (`vercel.json`), and a "Sync now" server action. Cron is bearer-secret protected (`getCronAuthFailure`). Takes 50 connections per run ordered by oldest `last_sync_at`.
- Disconnect / calendar switch: deletes DanceFlow-created events first (aborts the disconnect if any delete fails), then nulls tokens and sets `status=disconnected`.
- Settings UI: Integration Hub card plus `/app/settings/integrations/google-calendar` and `.../personal`.
- Tests: `__tests__/sync.gcse4.test.ts` (reconciliation convergence, idempotency, window, DST instants, instructor reassignment). Help article `connecting-google-calendar.md`.
- RLS: policies "readable/manageable by authorized users" on connections and sync items, with studio and instructor-owner branches.

### 2.2 Docs vs reality
- The KB article says DanceFlow "can synchronize eligible schedule changes automatically" and mentions a synchronization window. It never says: one-way only; polling every 30 min (not real-time); 90-day forward window; edits made in Google are overwritten, not read back; Google "Sync now" is manual. Suggest wording fixes (KB owner decision).
- No docs exist for env names or OAuth consent-screen setup, so Google verification state is unknown (A). `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `INTEGRATION_TOKEN_ENCRYPTION_KEY` are the config names (values not inspected).

### 2.3 Defects and gaps
| # | Finding | Sev | Basis |
|---|---|---|---|
| G1 | Token ciphertext lives in the same row that RLS makes readable to studio admins and, for their own row, instructors, with no column-level revoke. The browser (anon/authenticated) role can `select` the encrypted columns. Ciphertext is AES-GCM so this is defence-in-depth, not a break, but Wave's separate no-policy credentials table is the better pattern | P2 | V (migrations have no `revoke`/column grants) |
| G2 | Disconnect only deletes local tokens; the grant at Google is not revoked (`oauth2.googleapis.com/revoke`), so the app stays listed under the user's Google account permissions | P2 | V |
| G3 | Studio events (the `events` table) are sent as naive `YYYY-MM-DDTHH:MM` strings with no `timeZone`; Google requires an offset or an explicit `timeZone` for `dateTime`. Appointments use true instants and are fine. Timed events will probably be rejected with 400 | P1 (pending a DEV check) | P |
| G4 | Cron processes up to 50 connections serially with per-event HTTP calls, no `maxDuration`, no per-run time budget, no backoff or `Retry-After` handling for 403/429 rate-limit responses. Will time out as connection count grows | P2 | V |
| G5 | Granted scopes are stored but never checked: Google's granular consent lets a user untick calendar access, producing a "connected" row that fails every sync | P2 | V |
| G6 | No audit-event table for connect/disconnect/settings changes (Wave has one) | P3 | V |
| G7 | Client full name, instructor and room go into event descriptions on a studio-shared calendar, and into a personal calendar that may be shared by the owner of that Google account. Not a defect, but a privacy/consent consideration for any future generic layer (data minimisation switch) | P3 | V |
| G8 | Deactivating an instructor does not disconnect or pause their personal connection (cron selects on connection status only) | P3 | V (no instructor-active check in the cron select) |
| G9 | Refresh path has no lock: manual "Sync now" and cron can refresh concurrently. Harmless for Google (refresh tokens are not rotated) but the same helper pattern is wrong for providers that rotate refresh tokens | P3 | V |
| G10 | No tests for OAuth state/callback, token refresh/`needs_reauth`, RLS, or the cron route | P2 | V |
| G11 | No billing/feature gate on Google Calendar (Wave has `requireStudioFeature("wave_accounting")`). Owner decision whether it should be plan-gated | decision | V |
| G12 | `NEXT_PUBLIC_APP_URL || NEXT_PUBLIC_SITE_URL || request origin` fallback in redirect URI construction: if both env vars are missing a request-derived origin would be used. Low risk on Vercel; note for the shared layer (use one required origin) | P3 | V |

## 3. Wave Accounting

### 3.1 What exists (V)
- OAuth: `src/lib/integrations/wave/client.ts`, routes `/api/integrations/wave/{connect,callback}`. Scopes requested: `user:read business:read account:read transaction:write`. Env: `WAVE_CLIENT_ID`, `WAVE_CLIENT_SECRET`, `WAVE_REDIRECT_URI`. Same cookie-bound state helper. The callback re-checks `can_manage_studio_wave` (RPC) after state validation.
- Storage: credentials in `studio_wave_credentials` (encrypted, separate table, RLS on with no policy, service-role only). Refresh in `token.ts` with `needs_reauth` handling that also turns posting off. Refresh-token replacement is handled (rotated tokens are saved).
- Data model (migrations `20260622_wave_*` through `20260629_wave_*`): connections, businesses, accounts, account mappings, payment-method mappings, sync runs, sync lines, sync reservations, posting entitlements, audit events. Posting modes (`manual_review` default, `auto_post_safe`), classic-accounting businesses blocked.
- Posting safety design (strongest part of the repo): a run is a reviewed snapshot (`configuration_snapshot`); lines are claimed via SECURITY DEFINER RPCs (`claim_next_wave_sync_line`, `claim_next_wave_sync_line_for_autopost`); each line has a stable `wave_external_id` for idempotency; a `WavePostingUncertainError` state (network error, 5xx, unreadable body) marks the line `uncertain` and the run `attention_required` rather than retrying blindly; audit events written before and after each post; platform-admin reconciliation RPC.
- Gates for live auto-posting: env `WAVE_POSTING_ENABLED=true`, studio entitlement `pilot|active`, connection `posting_enabled`, `posting_mode=auto_post_safe`, non-classic business, `transaction:write` scope present.
- Platform admin page `/platform/wave` for rollout. Studio page behind `requireStudioFeature("wave_accounting")` (Pro).
- Disconnect: deletes the credentials row (good), clears business/scopes, forces `manual_review` and posting off.
- Cron: `/api/cron/wave-autopost` (maxRuns ≤ 25, maxLines ≤ 50, accepts `CRON_SECRET` or `WAVE_AUTOPOST_CRON_SECRET`).

### 3.2 Docs vs reality
- KB-1 already records that Wave posting is env-gated and that public copy ("Integration Hub", current-capabilities page) over-claims. Confirmed: posting does not run for a studio unless all gates in 3.1 are met.
- No Wave KB article exists (`KB-1` lists it as P2).

### 3.3 Defects and gaps
| # | Finding | Sev | Basis |
|---|---|---|---|
| W1 | **`/api/cron/wave-autopost` is not in `vercel.json`.** Auto-post only runs if something outside the repo calls it. Either the scheduler lives elsewhere (A) or auto-post has never run on a schedule | P1 to confirm | V (grep of repo) |
| W2 | **No automated tests at all** for the Wave client, token refresh, autopost runner, mapping logic or OAuth callback (no `*wave*` test files in the repo) despite it moving money-adjacent data | P1 | V |
| W3 | Disconnect does not revoke the grant at Wave | P2 | V |
| W4 | `wave_businesses` rows are deleted and reinserted on every reconnect with no transaction; a mid-way failure leaves a connection with no businesses (error is surfaced, state recoverable by reconnecting) | P3 | V |
| W5 | Token endpoint errors return only the HTTP status; Wave `invalid_grant` vs transient failures are not distinguished, so any refresh failure marks `needs_reauth` and disables posting | P2 | V |
| W6 | The refresh helper has no lock; if Wave rotates refresh tokens, two concurrent refreshes can invalidate each other | P2 | P |
| W7 | Wave's public API availability and terms for new apps have not been re-verified (see Candidates doc); building more on it is a business risk | decision | see Candidates |
| W8 | `SECURITY DEFINER` RPCs are granted to `authenticated` and rely on in-function checks; they were not re-audited here (no hosted access). Recommend including them in the next RLS/RPC security sweep | P3 | A |

## 4. Gusto (dormant)
- Code: `src/lib/integrations/gusto/{client,token,dormant}.ts`, routes and settings pages, migrations `20260802*` (foundation, worker reconciliation, readiness, time-sheet preview/delivery, payroll sync tracking), all behind `GUSTO_INTEGRATION_ENABLED = false`, with dormancy tests in four places.
- Recommendation: keep dormant; treat as a reference for "per-studio payroll connection", do not re-enable without a fresh Gusto partner-program check (see Candidates). Delete is not recommended while payroll prep (Phase 9) still references the tables.

## 5. Cross-cutting findings
1. **Token vault:** one AES-256-GCM helper with a single env key and a `v1` format tag. No key id, no rotation procedure, no re-encrypt job, no KMS. The helper lives under `wave/` and is imported by Google and Gusto; move it to a neutral module.
2. **OAuth state:** shared and sound; tied to studio + user + scope. No state record in the DB (cookie only), so "pending connection" is invisible to support.
3. **Per-provider copy-paste:** each integration has its own connect route, callback, token refresh, status derivation and hub card. A third provider on this pattern means another ~1,500 lines.
4. **Status model:** each table has its own status values (`connected|needs_reauth|disconnected`, plus sync status). The hub derives card status ad hoc (`IntegrationStatus` in `settings/integrations/page.tsx`).
5. **No provider webhooks:** all inbound is polling or absent. There is no generic inbound-webhook ingestion for integrations (Stripe and Mux have their own).
6. **No outbound event/webhook or public API for customers.** The only customer-facing machine interfaces are ICS feeds and embeds. (The Staff API under `docs/mobile/Staff_API_Contract.md` is for first-party apps.)
7. **Sync reliability:** Google reconciles by full diff each run (robust, idempotent, but O(rows)); Wave uses reviewed runs with claims. Neither has a dead-letter queue; "failed" is a status on the item or line, retried on the next cron.
8. **Existing outbox patterns:** PAY-WH-1 settlement outbox (`src/lib/events/settlementOutbox.ts`, claim/lease/backoff) and `outbound_deliveries` (email) are the in-repo precedents; NSI chose the shared `outbound_deliveries` outbox (Option A).
9. **Tenant isolation:** every row carries `studio_id`; Google/Wave RLS is studio-scoped; sync code filters by `connection.studio_id` using the service-role client (correct, but isolation is by convention, not enforced by the DB, in the cron path).

## 6. Reuse for a generic Connected Apps layer
Keep and generalise: the cookie-state helper (add a DB-backed pending-connection record), `encryptIntegrationSecret` (move, add key id), Wave's credentials-in-a-separate-table and no-policy pattern, `needs_reauth` semantics, the Google item-map reconciler as the "projection" pattern, Wave's runs/lines/claims/uncertain state as the "money-adjacent write" pattern, the audit-events table shape, the hub status cards, the cron-secret helper. Do not reuse: per-provider tables with duplicated columns, request-origin fallbacks, status derivation in page components.
