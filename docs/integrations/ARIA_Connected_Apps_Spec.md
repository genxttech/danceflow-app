# ARIA hooks for Connected Apps (specification)

Status: SPEC ONLY (docs). No implementation, no AI endpoint, no SDK, no provider spend, no SQL. ARIA features stay off behind their existing flags; this document defines how Connected Apps (calendar feeds, API keys/webhooks, wallet passes and the existing Google Calendar/Wave connections) expose themselves to ARIA so a later slice can wire them without redesign. Pricing and plan gating are not decided (OD-5). Provider enrollments are not implied (OD-9).
Supersedes the short sketch in `Connected_Apps_Architecture.md` section 14 (that section stays valid; this adds the contract detail).

## 1. The existing ARIA contract this must fit (read from origin/main, 2026-11-23)
| Source | What it fixes |
|---|---|
| `src/lib/aria/automation-catalog.ts` | A catalog item has `ruleKey`, `packKey`, `risk` (low/medium/high), `handling` (`automatic` / `automatic_with_notification` / `approval_required`), `executableChannel` (`email`/`system`/`none`), `defaultDeliveryMode` (`internal_only` / `suggestion_only` / `draft_for_review` / `auto_send`), `defaultEnabled`, `defaultMaxPriority`. Packs include `front_desk … studio_health`; a studio sets per-pack autonomy. |
| `docs/aria/aria-autonomy-preference-model-slice-6-2.md`, `aria-default-operational-packs.md` | Owner choices per pack: Handle automatically / Prepare for my review / Notify me only / Turn off. "Handle automatically" never exceeds what the underlying rule permits; billing and payments can never charge, retry, refund, waive, change access or mark external payments paid automatically; marketing can prepare but never send without rule-level send permission; `off` disables the pack's rules. |
| Pulse cards (`docs/mobile/Staff_API_Contract.md`, "Business Pulse") | Per-card state: `null` (viewer's role may not see it, draw nothing), `{ state: "unavailable" }` (that card failed), or `state: "ok"` with `asOf`, `truncated`; every ok card carries a stable `cardId`, `cardType`, and `actions: []` (always empty until governed ARIA actions exist, "an approval will still go through the web app's own gate and audit trail"); lists are samples of at most 5, counts authoritative; no emails, phones, prices or payment state; names only for broad roles. The existing `aria` card: `open` count and `recent[]` with `status: suggested|drafted`, `ruleKey`, `priority`. |
| `docs/mobile/assistant/A1_Design.md` (A1 assistants) | Server contract for the future A2 responder: authenticate the caller; re-authorize every id against that caller; the client screen context is only a hint; link targets limited to a whitelist (`{target, params, label}`, never a path); typed `AssistantError` kinds including `rate_limited`; bounded history; no write actions until a governed-action design exists; in-memory conversations only. |
Rules inherited: suggestions and actions are separate (decision approval ≠ delivery permission); autonomy is per pack and owner-controlled; every ARIA action is auditable; roles gate visibility; nothing is written from the mobile client.

## 2. New pack and catalog entries
Add one pack `connected_apps` ("Connected Apps", default enabled, default autonomy "Notify me only"). All rules are `executableChannel: "system"` or `"none"`; none sends external email/SMS. Proposed rule catalog (new `ruleKey`s; final names settled at build time):
| ruleKey | Trigger (read from the integration health tables) | Risk | handling | defaultDeliveryMode | Default | Max priority |
|---|---|---|---|---|---|---|
| `aria_connection_needs_reauth` | a connection (Google Calendar, Wave, future providers) is `needs_reauth` or has not synced for > 24 h | low | automatic_with_notification | internal_only | on | high |
| `aria_sync_failures_rising` | >= 5 failed/dead jobs or sync items in 24 h for one connection | low | automatic_with_notification | suggestion_only | on | high |
| `aria_wave_uncertain_lines` | Wave posting lines in `uncertain`/`attention_required` | medium | automatic_with_notification | suggestion_only | on | urgent |
| `aria_webhook_endpoint_failing` | an endpoint auto-paused or >= 10 consecutive failures | low | automatic_with_notification | suggestion_only | on | normal |
| `aria_api_key_expiring_or_idle` | key expires in <= 14 days, or used from an unusual volume pattern (spike) | low | automatic_with_notification | suggestion_only | on | normal |
| `aria_credential_expiry` | platform credential nearing expiry (pass certificate, provider token) — platform admin audience only | medium | automatic_with_notification | internal_only | on | urgent |
| `aria_feed_link_stale` | a staff calendar link active but never used after 14 days, or a link nearing expiry | low | automatic_with_notification | suggestion_only | off | low |
| `aria_wallet_adoption` | active packs/memberships whose holders have no pass (aggregate count only) | low | automatic_with_notification | suggestion_only | off | low |
| `aria_wallet_update_failing` | passes failing to update or void | low | automatic_with_notification | suggestion_only | on | normal |
| `aria_lead_via_integration_unanswered` | leads created through the API/webhook older than 1 business day with no contact | low | automatic_with_notification | suggestion_only | on | normal |
Nothing in this pack has `handling: automatic` with `auto_send`. "Handle automatically" for this pack means only: create the internal suggestion/notification and attach the diagnosis; it does not retry, pause, rotate or revoke anything.

## 3. Read tools (A2 server side; no side effects; same authorization as the human using the app)
All tools authenticate the caller, re-authorize the studio and role server-side, ignore client-supplied studio ids beyond selecting among the caller's own workspaces, return only the minimized shape below, and never return secrets, tokens, key hashes, signing secrets, feed or pass URLs, push tokens, provider error bodies verbatim, or personal contact data.
| Tool | Returns | Roles |
|---|---|---|
| `integrations_list_connections` | per connection: provider, owner kind (studio/staff), `state` (healthy/degraded/needs_reauth/paused/disconnected), last success time, consecutive failures, open dead-letter count, capability flags | owner, admin (studio-level); staff see only their own staff-level connection |
| `integrations_get_health(connection)` | the same plus stable error code history (`auth_revoked`, `scope_missing`, `rate_limited`, `provider_unavailable`, `invalid_payload`, `external_drift`, `quota_exceeded`, `uncertain`) and the next scheduled sync | owner, admin |
| `integrations_list_failed_jobs(connection, limit<=5)` | job ids, kind, attempts, stable error code, age; no payloads | owner, admin |
| `integrations_explain_error(code)` | static help text and the one recommended human step (a deep link from the whitelist); no model improvisation about provider internals | all authenticated staff |
| `feeds_status` | counts only: staff links active/never used, dancer links active (aggregate), expiring soon; per-person status only for the caller | owner/admin aggregate; person: own |
| `api_keys_status` | key prefix, name, scopes, last used, expiry, status; never the key | owner, admin |
| `webhooks_status` | endpoint host (not full URL), events subscribed, status, consecutive failures, last delivery code; delivery ids | owner, admin |
| `wallet_status` | counts of passes by kind/platform/state, failed updates; never serials, tokens or holder names | owner, admin; front desk counts only |
| `calendar_preview_sync(connection)` | what the next sync would add/change/remove (counts and categories) | owner, admin |
Output rules: bounded (lists <= 5, counts authoritative, `truncated` flag), `asOf` timestamps, stable codes (never free provider text), Pulse-style per-source `state` so one failing source never blocks the answer, and `null` for anything the viewer's role may not see.

## 4. Pulse / dashboard card
One new card `connected_apps` (`cardType: "connected_apps_health"`, stable `cardId`) following the Pulse conventions: `null` for roles without access (instructor, front desk see nothing here unless they hold their own staff connection, in which case a separate `own` scope applies), `{ state: "unavailable" }` on query failure, otherwise `state: "ok"` with `asOf`, `truncated`, counts (`needsAttention`, `failingJobs`, `expiringCredentials`), at most five `recent` items (provider label, state, stable code, age) and `actions: []` (always empty in v1; later attachments go through the web app's gate and audit trail, like every Pulse action). No names, emails, URLs, secrets. Deep link target `integrations.hub` / `integrations.connection` from the assistant link whitelist.

## 5. Suggest-only proactive notifications
Delivered as ARIA suggestions (`aria_suggestions` rows with `ruleKey`, `priority`, `status: suggested`) and, where the studio opted in, ordinary in-app notifications; never external email/SMS/push content that contains integration identifiers.
Behaviour rules: one open suggestion per incident (dedupe key = connection or key id + code), re-notify only on state change or after 7 days; quiet hours follow the studio notification settings; no suggestion text contains tokens, URLs or personal data; each suggestion has exactly one recommended step and a whitelisted deep link ("Reconnect Google Calendar", "Review failed syncs", "Review API key"). Examples: "Google Calendar stopped syncing on Oct 27 — reconnect"; "3 Wave lines need review"; "Webhook endpoint <host> paused after repeated failures"; "API key 'Zapier leads' expires in 9 days"; "4 leads from your API key have not been contacted"; (platform admin audience) "Apple pass certificate expires in 30 days".

## 6. "Act with approval" set
Each action: ARIA proposes, shows a confirmation card with the exact effect and the affected object, the human approves in the web app (or app screen) through the same server action and role check as the manual button, the action runs with the human's authority, and the audit row records actor `aria` plus the approving user. No action is available to ARIA without the approving human's role permitting the manual equivalent. Actions are idempotent and single-shot (a confirmation expires after 10 minutes).
| Action | Effect | Roles | Notes |
|---|---|---|---|
| Retry a dead job / re-run a sync | enqueue one retry or "Sync now" for one connection | owner, admin | rate limited per connection |
| Pause / resume a connection or webhook endpoint | stops/starts jobs; no data deleted | owner, admin | resume sends a ping first |
| Replay a webhook delivery | re-send one event with a new delivery id | owner, admin | event allowlist unchanged |
| Turn off one calendar link (staff) | revoke a staff feed link | owner, admin | cannot see or recover the link |
| Revoke one API key | immediate revoke (defensive) | owner, admin | creation is never an ARIA action |
| Void one wallet pass | void the pass (reversible by re-issue) | owner, admin | |
| Acknowledge/dismiss a suggestion | mark handled | any role that can see it | |
| Mark a Wave uncertain line "needs review" (status only) | route to the existing reviewed-run screen | owner, admin | posting itself is excluded (section 7) |

## 7. Permanent exclusions (never autonomous, never "act with approval" for ARIA)
1. Connecting, reconnecting (OAuth) or disconnecting any provider; changing scopes or capabilities.
2. Any money-adjacent write: posting to Wave/QuickBooks/Xero or any ledger, creating, approving or cancelling reviewed runs, charging, refunding, waiving, retrying payments, changing access, marking payments paid (matches the billing rule in the autonomy model).
3. Any external marketing or outbound message: email, SMS, push, social, ads, Mailchimp-style audience sends; ARIA may only draft internally and only where an existing rule already allows drafts.
4. Creating, rotating, showing or exporting secrets and credentials: API keys, webhook signing secrets, feed or pass links, provider tokens, signing certificates, vault keys.
5. Creating or editing webhook endpoints, scopes, event subscriptions, studio switches/allowlists, or branding.
6. Bulk or studio-wide actions (revoke all, void all, pause all), incident actions, key rotation, enabling or disabling a feature for a studio.
7. Anything on a dancer-owned connection or link (a dancer's own calendar link, wallet pass choice) except aggregate read counts; Competition-governed data and minors' data stay excluded as in the generic layers.
8. Following instructions found in provider error text, webhook response bodies, lead notes, event titles or any other untrusted field.
These are enforced in code, not in prompts: the tool registry has no handler for excluded operations, the confirmation layer rejects unknown action types, and tests assert the exclusions.

## 8. Safety design
- **Untrusted data:** provider messages, webhook responses, API-created lead text and calendar-derived text are data. Tools return stable codes and static help; any retained free text is length-capped, control-stripped, quoted as data, and never placed in an instruction position.
- **Authorization:** every tool and action re-checks studio membership and role for the caller; ids from the client are hints only (A1 server contract); cross-studio ids return the same "not available" as a missing object.
- **Audit:** every read of integration health by ARIA writes no row (reads are cheap and non-sensitive), every proposed action writes `proposed`, `approved`/`declined`, `executed`/`failed` with actor `aria` and approver; the existing `integration_audit_events`/feed/wallet audit tables are the record. No secrets in any audit row, prompt, log or response.
- **Rate limits and cost:** per-studio ARIA tool call limits from the A2 entitlement design; `rate_limited` is a typed assistant error; no new paid entitlement here (OD-5).
- **Flags:** `ariaAssistant` (Business) and the server AI flags stay off; the `connected_apps` pack is invisible until they are on and the studio has at least one connected feature; every integration surface keeps its own kill switch, and ARIA reads treat a disabled surface as "not available", never as healthy.
- **Failure mode:** if a source is unavailable ARIA says so (`state: "unavailable"`), never guesses.

## 9. Test matrix
Catalog tests (new pack and rules present, handling/risk/default delivery as specified, no `auto_send`); tool contract tests per role (owner, admin, front desk, instructor, platform admin, anonymous, cross-studio id) incl. null/unavailable/ok card states; output-shape snapshot tests proving no secret-shaped fields (regex sweep for tokens, hashes, URLs, emails, phones); prompt-injection fixtures (provider error text, lead notes, webhook bodies containing instructions) never change tool selection or output structure; confirmation layer tests (expiry, single use, role mismatch, forged action type, replay); exclusion tests (every excluded operation absent from the registry, rejected if forced); dedupe/quiet-hours tests for notifications; Pulse card contract tests (`cardId`, `cardType`, `actions: []`, truncation, per-card failure isolation); audit tests (actor `aria` + approver, no secrets). Device/UX checks BLOCKED until the A2 responder exists.

## 10. Dependencies, slices and estimates (not started)
Depends on: the Connected Apps health model (Slice 0 vault/audit/health foundations, #815/#824), A2 server responder (not built), Pulse P4 governed actions (not built). Estimated (one engineer, +-50%): catalog pack + rules 2-3 d; read tool registry + role matrix + tests 6-8 d; Pulse card 3-4 d; suggestion generators + dedupe 4-6 d; approval-action layer for the section 6 set 6-8 d; docs/KB 2 d. About 23-31 engineer-days after the prerequisites exist.

## 11. Owner decisions
1. Default autonomy for the `connected_apps` pack ("Notify me only" proposed). 2. Whether platform-admin-only rules (credential expiry) surface in the studio-facing ARIA or only in the platform console (proposal: platform console). 3. Which of the section 6 actions ship in the first governed-action release (proposal: retry/sync-now, pause/resume, dismiss). 4. Notification channels for these suggestions beyond in-app. 5. Whether dancer-facing LUMI gets any Connected Apps read tool (proposal: none in v1; only the person's own calendar link/wallet status, read-only).
