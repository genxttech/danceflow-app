# Integrations Roadmap (proposal)

Status: DRAFT, docs only. OD-10 approved 2026-11-23 (first three are roadmap priorities only); OD-5 = no pricing/plan-gating now; OD-9 preserved (each enrollment and fee needs separate owner authorization). Nothing here is built, scheduled or activated. No provider enrollment, developer-account creation, OAuth app registration, billing change or vendor contact has been done or is implied; each such step is an owner-authorized action (see OD-9). Estimates are engineer-days of focused work excluding provider review time, ±50%, for one engineer with developer-owned QA included.
Inputs: `Integrations_Audit_Existing.md`, `Integrations_Candidates.md`, `Connected_Apps_Architecture.md`.

## 1. Recommended first three

| # | Item | Why first | Effort | Risk | Approval lead time | Duplication risk |
|---|---|---|---|---|---|---|
| 1 | **Per-dancer and per-staff ICS calendar feeds** (reuse the ICS formatting and the revocable-token idea; **new hash-only token storage, not the existing plaintext instructor-feed storage or detail level**, see Audit §9; webcal links in Business, Student app and portal) | Apple, Outlook and Google Calendar all consume ICS, so one native feature covers every read-only calendar need, including the dancer audience, which no OAuth integration serves. Pattern already exists for instructors and coaches | M (≈10–15 d incl. new token table, invalidation hooks, instructor-feed migration) | Low: secret URL leakage (mitigate with revocable tokens, minimal event detail) | None | Low: replaces future per-vendor read integrations |
| 2 | **Webhooks + public REST API + scoped API keys, then a private (invite-link) Zapier app and Make app** | One investment opens QuickBooks/Xero/Mailchimp/Sheets/Slack/HubSpot/Meta lead-ads without per-vendor approval. Zapier is table stakes among competing platforms. Built on the shared outbox, so it also forces the Connected Apps core to exist | M (≈25–35 d for core webhooks+API; +8–12 d Zapier private app; +5 d Make) | Medium: data-classification of events, abuse/rate limits, support load | None for webhooks/API; private Zapier/Make need only a free developer account (separate owner authorization, OD-9); public listing later | Low |
| 3 | **Apple Wallet + Google Wallet passes** (memberships, class packs, event tickets; QR for check-in) | Highest dancer-visible value among the near-term set, ties to Student app check-in; no third-party data leaves DanceFlow beyond the pass | M (≈20–30 d both, incl. update service) | Medium: signing-key custody, certificate renewal, update-registration bugs | Apple: Developer Program membership and pass certificate (no pass review); Google: issuer account + publishing-access review (duration undocumented) | Low |

Also near-term but not "integrations": **Slice A0, Connected Apps hardening** (§3) is a prerequisite to anything OAuth-based and should start immediately because it fixes live defects.

Why not the obvious alternatives first:
- *QuickBooks/Xero direct*: Intuit/Xero moved to metered tiers; QuickBooks token rotation and chart-of-accounts mapping make it L; QuickBooks-ready CSV/journal export plus Zapier covers most value sooner (ranked #4 below).
- *Microsoft Graph / Google two-way*: duplicates ICS for read, and Google verification state is unknown (OD-8).
- *Meta lead ads*: 4–12 week approval for a feature Zapier/Make already deliver.
- *Gusto/ADP/Paychex*: partnership gates and compliance burden; payroll export first.

## 2. Ranked list (full)

1 Per-dancer/staff ICS feeds · 2 Webhooks/API/Zapier+Make private · 3 Wallet passes · 4 Accounting and payroll exports (QuickBooks-ready CSV/journal, timesheet) · 5 Website-builder embed snippets and docs · 6 Small native fields (class playlist link, COI upload+expiry, background-check status) · 7 Google Calendar two-way/busy hints · 8 Google Business Profile reviews · 9 QuickBooks Online / Xero direct (pilot on Xero Starter tier if demand) · 10 Microsoft Graph calendar · 11 Zoom, Mailchimp, Stripe Terminal, workout write (HealthKit/Health Connect), Slack webhooks · 12 Public Zapier listing · Reject for now: Meta/WhatsApp/Instagram native, Square, DocuSign/Dropbox Sign, Spotify API, Fitbit/Garmin, Teams, CalDAV write, embedded payroll, HubSpot/Klaviyo/CC/AC, Calendly/Cal.com, review-platform APIs.

## 3. Phasing and engineering slices

### Phase A — Foundations (staffing assumption: one engineer; A is roughly 8–11 calendar weeks)
| Slice | Content | Est. | Depends on |
|---|---|---|---|
| A0 Audit remediation (live code; **dark PRs only**) | G1 minimal fix (service-role writes after role check; the credentials-table move belongs to A2/A3), G3 event timeZone/exclusive-end/retention/draft fixes, G4 cron time budget + `maxDuration` + backoff, G5 scope verification, G8 pause on inactive instructor, G13 refresh-failure classification, G14 "disconnect anyway" (OD-3), G15 reconnect keeps calendar, W2 Wave tests, W9 Wave disconnect/needs_reauth through a SECURITY DEFINER disable RPC, provider revoke on disconnect (G2/W3), OAuth/refresh tests (G10), needs-reauth notification | 14–20 d | **Owner gates (engineering prepares dark PRs only):** any PROD SQL (W9, G1 policy change) and scheduling or enabling `wave-autopost` in PROD (OD-8: scheduler unconfirmed; the Wave connection has `posting_enabled=true`) |
| A1 Vault v2 + audit + pending-connect | key ids, rotation job, `integration_audit_events`, DB-backed OAuth state with PKCE | 6–8 d | none (independent of A0) |
| A2 Generic connection model + outbox + inbound-event table | tables, RLS, claim/lease worker, health, error taxonomy; hub cards from registry (read-only first) | 15–20 d | A1; NSI outbox decision (shared pattern, no shared SQL with NSI unless NSI T4 authorizes) |
| A3 Migrate Google Calendar to generic layer | dual-read cutover, keep reconciler as capability | 8–10 d | A2 |

### Phase B — First three integrations (roughly 14–20 weeks end to end for one engineer; B1 and B2 can start once A1/A2 land, and run in parallel with a second engineer)
| Slice | Content | Est. | Depends on |
|---|---|---|---|
| B1 Dancer/staff ICS | hash-only token table, revoke/rotate UI, migrate or rotate existing instructor feeds, webcal links, student-app/portal entry points, KB article | 10–15 d | A1 (audit table, kill switches); Student app release train (APPS coordinator); design in `Calendar_Feeds_Design.md` |
| B2 Outbound webhooks | endpoint mgmt UI, signing, event allowlist, delivery log, replay | 12–15 d | A2 |
| B3 Public REST API + API keys | read lead/schedule/client lookup, create lead, idempotency, rate limits, docs | 12–18 d | A2; Staff API conventions |
| B4 Zapier private app, Make app | triggers via REST hooks, polling fallback, test accounts, KB recipes | 10–15 d | B2, B3; each developer account needs separate owner authorization and any fee (OD-9) |
| B5 Wallet passes | pass model + signing service, Apple web service + APNs, Google class/object API, Student app buttons, revoke/update | 20–30 d | A1 (key custody); Apple/Google enrollments (OD-9); Student app slice |

### Phase C — Value extensions (months 4–7)
| Slice | Est. |
|---|---|
| C1 QuickBooks-ready export + payroll timesheet export (extend accountant deliveries; mapping UI) | 8–12 d |
| C2 Embed snippets/docs per builder, auto-resize + UTM pass-through | 4–6 d |
| C3 Native fields: class playlist link, COI upload+expiry reminder, background-check status | 6–9 d |
| C4 Google Calendar busy-time import (suggestions only) incl. watch renewal | 12–15 d (after verification state known) |
| C5 Google Business Profile reviews view/reply | 12–16 d (after access approved) |

### Phase D — On demand (month 7+)
Xero (Starter-tier pilot) 15–20 d, QuickBooks Online 20–30 d, Microsoft Graph calendar 15–20 d, Zoom 12–18 d, Mailchimp one-way 10–15 d, Stripe Terminal L, workout write 10–15 d per OS, public Zapier listing 8–12 d plus review.

## 4. ARIA plan (alongside slices)
Read tools and suggest-only notifications ship with A2 (connection health, failed jobs, reconnect prompts); "act with approval" (retry, pause) with B2; per-feature suggestions (offer calendar subscription, add pass, lead arrived via webhook) with B1/B5. Autonomous connect/disconnect, money-related posting, external marketing sends and key creation stay out of ARIA permanently (Architecture §14).

## 5. Dependencies and coordination
- **Mobile (Student/Business apps):** B1 entry points and B5 buttons need release-train slots; APPS coordinator owns scheduling. Wallet "add to wallet" adds no new SDK in the app if links/JWTs are served from the backend (to verify during design).
- **NSI:** shares the transactional outbox decision (Option A: `outbound_deliveries` for intake email). The Connected Apps `integration_jobs` table is separate from email delivery; reuse the claim/lease code, not the table, until NSI T4 completes. No intake email is queued while M-0 release dependencies are open.
- **TWILIO/TW-4F (engineering position, not an owner decision):** SMS stays out of outbound integration events; Meta/WhatsApp/Instagram-style messaging is later/reject because it would bypass TW-4F consent, STOP/START/HELP, studio-prepaid credit and cost attribution; no new channel authorized in the pilot.
- **COMPETITION (engineering position, not an owner decision; internal-confidential):** generic layer excludes minors' (U18) data, scoring/results and judge identity, and payment/Stripe data until a rulebook-governed decision; calendar subscription for such events is excluded until release. No outreach to organizers/directors.
- **Pulse / Business app:** hub status surface should feed Pulse "attention" cards later (no work now).
- **Billing:** OD-5 is decided as no pricing or plan-gating decision now. These slices ship behind feature flags/allowlists with no charge, no paid entitlement and no billing change. If gating is ever decided it is a separate change that can reuse `requireStudioFeature`.

## 6. Owner decisions (collected)
| ID | Decision | Default recommendation |
|---|---|---|
| OD-1 | Who may connect accounting and create API keys/webhooks: owner only, or owner+admin? | Owner+admin for calendar/webhooks; owner only for accounting posting and API keys |
| OD-2 | May front desk connect a personal calendar / view integration status? | Personal calendar yes (own); status read-only |
| OD-3 | On disconnect, allow "disconnect anyway" leaving orphan external items? | Yes, audit-recorded |
| OD-4 | Key management: env-based key ids now, KMS later? | Env key ids now |
| OD-5 | **DECIDED (owner, 2026-11-23): no pricing or plan-gating decision now.** No charges, no paid entitlements and no per-integration pricing are introduced by these slices. Features ship dark/off (flags, allowlists) until a separate owner decision | Closed for now; revisit only on a new owner decision |
| OD-6 | Retention for mappings/job history/audit after disconnect | 90 days mappings; audit per studio policy |
| OD-7 | Data minimisation default for external calendar descriptions (client names) | Minimal by default, opt-in detail |
| OD-8 | Production configuration verification (read-only). **Partly answered** by engineering 2026-11-23, see Audit §7: env var names present; Wave posting entitlement `pilot` for 1 studio; Google Calendar has 2 studio connections, both `needs_reauth`, last sync 2026-10-27. **Not verifiable by engineering:** Google consent-screen publishing/verification status and the value of `WAVE_POSTING_ENABLED` | Owner confirms Google console state; decide whether to reconnect or retire the 2 failing connections |
| OD-9 | **PRESERVED:** each provider enrollment and any fee (Apple Developer Program membership if not already held and the pass certificate, Google Wallet issuer account, Zapier/Make developer accounts, Google Business Profile access application) needs its own separate owner authorization when its slice is about to start. The OD-10 approval does not authorize any enrollment or fee | Authorize per slice, not in advance |
| OD-10 | **APPROVED (owner, via APPS coordinator, 2026-11-23):** the first three are roadmap priorities: (1) per-dancer and per-staff calendar subscriptions, (2) secure public REST API + webhooks + private Zapier/Make, (3) Apple/Google Wallet passes. Priorities only: no production activation, provider enrollment or fees | Approved |
| OD-11 | Public Zapier listing (and its support commitment) vs staying private | Stay private until demand |
| OD-12 | Default privacy for dancer ICS (detail level, token rotation cadence) | Minimal detail, rotate on request |
| OD-13 | Cost tolerance for metered APIs (Intuit/Xero tiers) before any accounting API work | Defer |
| OD-14 | Outbound webhook event allowlist and any SMS-derived aggregate events (needs separate approved design) | No SMS events |

## 7. Risks
Provider policy churn (Meta, Google, Spotify, Intuit, Xero changed terms/pricing in 2025–26); approval unknowns (Google Wallet, Google Business Profile, Zoom, Slack); support load from customer-owned third-party accounts; token/key custody (mitigated by vault v2); scope creep into two-way edits (mitigated by projection rule); mobile release capacity; research items still unverified (Candidates §12).

## 8. Definition of done per integration (developer-owned QA)
QA matrix entry per capability (PASS only with evidence; BLOCKED where a live provider account is needed and not authorized); RLS cross-tenant tests; vault/rotation tests; outbox crash/duplicate tests; revoke/disconnect/purge tests; KB article and support runbook; flag/allowlist wiring; audit events; ARIA tools tested for role limits.
