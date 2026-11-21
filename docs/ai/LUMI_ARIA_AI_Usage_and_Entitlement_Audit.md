# LUMI / ARIA / Server AI — Usage and Entitlement Audit

Status: read-only investigation, docs only. Date: 2026-11-21. No production change, SQL apply, env change, provider call or pricing decision was made.
Code read: `origin/main` @ `35c38c10` and the live line `origin/release/website-embeds` @ `05334621` (git show/grep only). PROD/DEV: read-only SQL via `sb.sh`, aggregate counts only, no personal data.
Purpose: establish the truth about how AI is authorized, metered, attributed and limited **before** A2 (mobile AI endpoints) or any new AI billing is designed.

---

## 0. LIVE RISKS TODAY (read first)

| # | Risk | Evidence | Severity |
|---|------|----------|----------|
| **L1** | **LUMI web plan generation is never metered.** `recordLumiUsage` calls `record_usage_event` through the **service-role** admin client. The function (identical on PROD and DEV, md5 `ce4844a2…`) begins `if auth.uid() is null then raise exception 'Not authenticated'` and then requires an active `user_studio_roles` row for the caller. A service-role call has no `auth.uid()`, and a student is not a studio role either. So the RPC **always errors**; the app only `console.error`s and returns false (`src/lib/lumi/portal.ts:242-257`). Every successful OpenAI call by LUMI is paid for and **recorded nowhere**; the studio's allowance never decrements, so the "allowance used" gate (`portal.ts:226`) can never trip. | Proven on DEV: `record_usage_event(...)` with a service_role claim and no sub → `P0001: Not authenticated` (read-only transaction, raised before any insert). PROD: 0 `usage_events` rows with source `lumi_journey_assistant` ever; DEV also 0. | **High** (unmetered provider cost; the only cap left is the in-memory rate limiter, L5) |
| **L2** | **Public knowledgebase assistant: unauthenticated, no rate limit, no meter, no input cap.** `askKnowledgebaseAssistantAction` (`src/app/knowledgebase/ai-actions.ts:149-260`) sits under `PublicShell` (no auth). No `checkRateLimit`, no usage record, `question` is not length-limited (only the server-action body limit applies). Each call sends up to 8 articles × 3,200 chars (~6–7k input tokens) plus the question, `max_output_tokens` 850. | Code. A crafted ~1 MB question ≈ 250k input tokens ≈ $0.10 per call at gpt-4.1-mini; a 1 req/s loop for 30 days at the normal size ≈ $4–5k (§11). Only active when `AI_FEATURES_ENABLED=true` and a key is set; the PROD value was not read (env is out of scope). | **High** if the flag is on in PROD |
| **L3** | **Two studio AI server actions have no auth, no plan check and no metering inside the action:** `generateEventDescriptionAssistantAction` (`src/app/app/events/ai-actions.ts:68`) and `generateReportInsights` (`src/app/app/reports/actions.ts:121`). The only protection is a per-IP in-memory limiter whose key includes **user-supplied** fields (`eventName`, `eventType`, `task`; `metrics.range`, `metrics.plan`), so varying them opens new buckets. `generateReportInsights` takes an arbitrary client-supplied `metrics` object (unbounded prompt size). `src/proxy.ts` only sets a header; it authenticates nothing. Server actions are reachable by crafted POST once the action id (in a public JS chunk) is known. | Code. Not exercised (no provider spend authorized). | **High/Medium** (unmetered; the auth bypass is a code-reading conclusion, not a tested exploit) |
| **L4** | Provider error text is returned to end users: `data.error?.message` is passed back in LUMI and the studio actions (e.g. `journey/actions.ts:298`). Can leak model/org/quota details. No fetch timeout anywhere (no `AbortSignal`). | Code | Medium |
| **L5** | The rate limiter is per-instance memory (`globalThis` Map, `rate-limit.ts:24-34`), keyed by the first `x-forwarded-for` hop; not shared across serverless instances, lost on cold start, capped at 5,000 buckets (oldest evicted → reset). LUMI's key is `ip + studioSlug + task`, **not per user**: a classroom behind one NAT shares 8 requests/10 min, while a rotating-IP caller multiplies them. | Code | Medium |
| **L6** | Studio AI check→call→record is non-atomic (TOCTOU). Parallel requests can all pass `getUsageAllowance` before any record lands, so the monthly cap can be exceeded by whatever parallelism the (bypassable) rate limit allows. Usage is recorded only **after** a successful provider call, and the record result is ignored. | Code (§4) | Medium |
| **L7** | Data minimization: LUMI sends the student's real full name plus goals, notes, lesson recaps, group recaps and syllabus notes to OpenAI. The name is not needed for the output. | `journey/actions.ts:233-258` | Low/Medium |

PROD exposure is currently small (§6): 1 LUMI-enabled studio, 0 student goals, 0 `lumi_response_reports`, 20 AI usage events in total, last on 2026-08-15. The risk is structural and grows with A2 and launch.

---

## 1. Exactly how a LUMI AI call is authorized, metered, attributed and limited (web)

Entry: server action `generateLumiPlanAction` (`src/app/portal/[studioSlug]/journey/actions.ts:139`). Identical on the live line and main.

1. **Identity**: `resolveLumiPortalAccess(studioSlug)` (`src/lib/lumi/portal.ts:38`) uses the session client (`createClient`) only for `auth.getUser()`; unauthenticated → redirect to login.
2. **Client used for everything else: service-role admin** (`createAdminClient`, `src/lib/supabase/admin.ts`). RLS is bypassed for the studio lookup, relationship lookup, all context reads and the usage RPC. Tenant isolation rests only on hand-written `.eq("studio_id", …).eq("client_id", …)` filters.
3. **Studio = the one in the URL slug.** Relationship: `resolvePortalRelationship({userId, studioId})` (`student-identity/portal-context.ts`) → `client_account_links` where `user_id`, `studio_id`, `status='linked'`, ordered `is_primary desc, created_at asc`, first row. `requestedClientId` is never passed by LUMI, so a guardian with several dependents always gets the primary link's client.
4. **Gates (all must pass; `reason` values)**: `is_independent_instructor` portal excluded; `studio_settings.lumi_enabled = true`; `resolveStudioBillingPlan` (`billing/access.ts:469`) status active/trialing **and** plan growth|pro; student "eligible" (active membership, package balance, upcoming or ≤60-day-past attended lesson, or upcoming event registration).
5. **Allowance check**: `getLumiUsageAllowance` (`portal.ts:184`): included allowance by plan (`usage/addons.ts:49-60`: growth 200, pro 500, organizer 100, else 0) + sum of active `usage_addon_entitlements` (`ai_action`), compared with `usage_monthly_summaries.quantity_used` for `(studio_id,'ai_action',month)`. UTC calendar month.
6. **Kill switch**: `AI_FEATURES_ENABLED === "true"` and `OPENAI_API_KEY` set (checked *after* the allowance check).
7. **Context**: ≤8 active goals, ≤20 appointments (3 upcoming used), ≤6 client-visible private recaps, ≤6 published group recaps, ≤8 portal-visible syllabus assignments (notes only if `show_notes_in_portal`), student full name.
8. **Rate limit**: `checkRateLimit("ai:lumi:<ip>:<slug>:<task>", 8 / 10 min)`, applied after the context queries (DB cost incurred before rejection).
9. **Provider call**: `fetch https://api.openai.com/v1/responses`, model `OPENAI_MODEL_LUMI ?? OPENAI_MODEL_LESSON_ASSISTANT ?? "gpt-4.1-mini"`, temperature 0.35, `max_output_tokens` 900, no timeout, no `user`/safety identifier, no `store:false`, no idempotency.
10. **Failure handling**: non-2xx → error (message leaked, L4), **no record**; unparsable JSON → error, **no record** (tokens were still spent and billed by OpenAI); success → `recordLumiUsage`, which fails (L1).
11. **Attribution**: *intended* `p_studio_id = access.studio.id`, `related_table='clients'`, `related_id=client.id`, source `lumi_journey_assistant`, metadata `{task}`. **Actual**: nothing is stored (L1). There is no per-dancer or per-user column anywhere; even if recording worked, the studio would be charged and the dancer identifiable only through `related_id`.

Who counts against what, today:
- Dancer linked to **0 studios**: cannot use LUMI at all (no slug resolves; `resolvePortalRelationship` returns null → redirect). PROD: 515 `dancer_profiles`, 20 users with a linked client, all 20 linked to exactly one studio → roughly 495 registered dancers have no LUMI access.
- **1 studio**: that studio's plan/flag/allowance would be charged (in theory).
- **Many studios**: the studio in the URL slug is charged; each studio independently needs flag + plan + eligibility. Attribution is unambiguous (slug-driven), but there is no personal allowance and no cross-studio cap: a dancer in N studios has N independent allowances. PROD has no multi-studio dancer today.
- The mobile Student app LUMI is template-only: it reads RLS-scoped data client-side and builds the answer locally (`mobile/student/app/lumi.tsx`); it writes only `lumi_response_reports` (insert; 0 rows on PROD and DEV). `studio-links` exposes `lumiEnabled = any linked studio has lumi_enabled` (`api/student/studio-links/route.ts:19`) with **no plan check**, so mobile shows LUMI for any flagged studio while web additionally requires Growth/Pro.

## 2. Is the `ai_action` allowance shared? Can dancer LUMI starve studio operations?

Yes, one bucket: `usage_monthly_summaries(studio_id, feature_key='ai_action', period_start)`, populated by trigger `usage_events_increment_summary` from `usage_events`. Sources in code:

| Source | Where | Meters? | Writer client |
|---|---|---|---|
| `lesson_ai_assistant` | `app/lesson-ai-actions.ts` (800 tok, 12/10min) | yes, after success | session |
| `follow_up_ai_assistant` | `app/follow-up-ai-actions.ts` (350 tok) | yes | session |
| `campaign_ai_assistant` | `marketing/campaigns/ai-actions.ts` (900 tok) | yes | session |
| `lumi_journey_assistant` | `portal/.../journey/actions.ts` | **attempts, always fails (L1)** | service-role |
| (none) | `events/ai-actions.ts`, `reports/actions.ts`, `knowledgebase/ai-actions.ts` | **no** | n/a |

Credit packs (`ai_200/ai_750/ai_2000`, `usage/ai-credit-packs.ts`; env `STRIPE_PRICE_AI_CREDITS_200/750/2000`; displayed $10/$25/$49 — existing, not changed here) add `usage_addon_entitlements` rows (`source='stripe_subscription_item'`) to the same bucket. ARIA (`api/cron/aria-*`, `app/aria`) contains **no LLM call**; the "operational" AI is the lesson/follow-up/campaign assistants above.

Answer to "can LUMI exhaust the credits a studio needs": **by design yes** (same studio bucket, growth 200 / pro 500 shared by all dancers and staff); **in practice no today**, only because LUMI never records (L1). Fixing L1 naively would turn it into a live starvation problem: one active class could consume a studio's whole month.

## 3. Multi-studio / zero-studio today

See §1. Access is entirely studio-relationship driven (`client_account_links`; statuses `unclaimed|invited|claim_pending|linked|disconnected|former_client|rejected|conflict`; relationship `self|guardian|billing_contact|dependent`). A user-owned `dancer_profiles` row exists (PK `user_id`, 515 on PROD) that no AI path reads. There is no personal entitlement and no global per-user cap. Cross-tenant: LUMI context is filtered by the URL studio and that studio's client id, and no cross-tenant read was found; but with the service-role client this depends on every query remembering both filters.

## 4. Concurrency, retry, failure

- **TOCTOU**: studio actions call `getUsageAllowance` (read) then later `recordUsageEvent` (which re-reads and inserts). No lock, no reservation. N parallel requests started before the first record all see the same `used`. The overshoot is bounded only by the bypassable rate limiter (L5). `usage_events` has no unique/idempotency key, so a client retry or double submit calls the provider twice and records twice.
- **Provider cost vs billing**: provider error → not billed to the studio (OpenAI normally doesn't bill failed calls; a client-side timeout can still bill, and there is no timeout/abort). Parse failure: lesson/campaign still record (they return raw text); LUMI returns an error and records nothing though tokens were spent. Success but record failure: studio actions `await recordUsageEvent` and **ignore** its result → free call.
- **Existing safe pattern**: ENT-1 (`20261013090000_ent1_usage_allowance_reservations.sql`; `usage_reservations`, `reserve_usage_allowance`, `settle_usage_reservation`; service_role only; advisory lock per (workspace, feature, month); idempotency key; reserved → finalized|released; settle is idempotent). It currently serves only `email_campaign_recipient`. It is the right foundation for AI reservation but is **not used by any AI path**. Its shape is campaign-specific (batch columns, studio/organizer workspaces) and would need generalizing.
- **Schema drift**: `record_usage_event` is **not defined in any repo migration** (only referenced); it exists in PROD and DEV with the same definition hash. It must be pinned into the repo (corrective migration) before anything builds on it.

## 5. Every OpenAI call site and its accounting

All 7 call sites are `fetch https://api.openai.com/v1/responses` (`git grep` over the repo; none in cron, none in mobile, no SDK). Identical on main and live line.

| Call site | Auth in action | Plan gate | Allowance check | Record | Rate-limit key | Max out | Model env chain |
|---|---|---|---|---|---|---|---|
| LUMI `journey/actions.ts:269` | session + portal relationship | Growth/Pro + flag | yes (studio) | **fails** | ip+slug+task, 8/10m | 900 | LUMI→LESSON→4.1-mini |
| Lesson `lesson-ai-actions.ts:154` | via studio ctx | `ai_assistant` | yes | yes | ip+mode+task+clientName, 12/10m | 800 | LESSON→REPORT_INSIGHTS→4.1-mini |
| Follow-up `follow-up-ai-actions.ts:103` | via studio ctx | `ai_assistant` | yes | yes | ip+… | 350 | FOLLOW_UPS→REPORT_INSIGHTS |
| Campaign `campaigns/ai-actions.ts:150` | via studio ctx | `ai_assistant` | yes | yes | ip+… | 900 | CAMPAIGN_DRAFTS→REPORT_INSIGHTS |
| Event description `events/ai-actions.ts:135` | **none** | **none** | **none** | **none** | ip+eventName+type+task, 10/10m | 900 | EVENT_DESCRIPTIONS→… |
| Report insights `reports/actions.ts:149` | **none** | **none** | **none** | **none** | ip+range+plan, 8/10m | 750 | REPORT_INSIGHTS→4.1-mini |
| Knowledgebase `knowledgebase/ai-actions.ts:200` | **public** | none | none | none | **none** | 850 | KB_ASSISTANT→REPORT_INSIGHTS |

Unmetered cost paths: LUMI (L1), event, reports, KB. There is one global `AI_FEATURES_ENABLED` for all seven; no per-feature kill switch.

## 6. Current entitlements and what PROD has (aggregates, 2026-11-21)

Plans (`src/lib/billing/plans.ts`): the `ai_assistant` feature starts at **growth**; included `ai_action`: growth 200, pro 500, organizer 100; SMS 0 included; email recipients 1000/5000/1000. Credit packs as in §2.

PROD (read-only):
- studios 7; `lumi_enabled=true` 1 (pro, active, not an override); `student_dance_goals` 0; `lumi_response_reports` 0; `usage_reservations` 0.
- `usage_events` `ai_action`: `lesson_ai_assistant` 18 (2026-06-22…08-07), `campaign_ai_assistant` 2 (2026-08-15); no LUMI or follow-up rows (event, reports and KB are unmetered by design, so their absence says nothing).
- `usage_monthly_summaries ai_action`: 2026-06 one studio, sum 3; 2026-07 one studio, sum 11; 2026-08 two studios, sum 6 (max 4); nothing since August.
- `usage_addon_entitlements`: 0 `ai_action` rows (2 `organizer_suite` manual grants).
- auth users 986; `dancer_profiles` 515; 20 users with a `linked` client link, each with exactly 1 studio.
- DEV: `lumi_enabled` 1; ai events 2 (campaign, follow-up).

## 7. The billing-override plan-resolution discrepancy

Roadmap `docs/roadmap/DanceFlow_Master_Roadmap.md:1884` states LUMI Growth/Pro gating goes "through the shared billing-plan resolver (override-consistent since the 2026-09-15 billing-override fix)". Verified: `resolveStudioBillingPlan` (`billing/access.ts:469-545`) gives an active `billing_override_*` outright precedence (planCode = `studios.billing_plan`, defaulting to **pro**; status forced `active`), and is used by LUMI (`portal.ts:85`) and by studio AI via `getCurrentStudioPlanForUser` (`access.ts:574`). **The earlier discrepancy (LUMI reading `studio_subscriptions` directly and ignoring comp/ambassador overrides) is fixed on main and on the live line** (`access.ts` is identical). I found no open, labelled discrepancy in the roadmap or code. Residuals to track: (a) an override whose `billing_plan` is `organizer`/unusual gets a plan LUMI's `normalizePlan` rejects (`portal.ts:32`) while `getIncludedUsageAllowance` would give it 100; (b) an override grants the full plan allowance with no separate cap, so a comped studio's AI cost falls on DanceFlow; (c) three allowance computations exist (`usage/addons.ts`, `lumi/portal.ts`, ENT-1's `usage/campaignAllowance.ts`) and must converge.

## 8. Live line (`release/website-embeds`) vs main

All AI files, `lumi/portal.ts`, `usage/addons.ts`, `ai-credit-packs.ts`, `rate-limit.ts`, `billing/access.ts`, `plans.ts`, `student-identity/portal-context.ts` and `staff/writeGuard.ts` are **byte-identical**. The only related difference is `subscriptionPlanResolution.ts` (main has an extra `_TRANSITION` price env, D7). Every risk in §0 is live.

---

## 9. Current state vs recommended target

| Area | Current | Recommended target |
|---|---|---|
| Who pays | Studio bucket only; zero-studio dancers excluded | Personal dancer allowance (platform-funded) first; optional studio sponsorship as a separate pool |
| Studio ops protection | LUMI would share `ai_action` with lesson/follow-up/campaign | Separate pools/feature keys; `ai_action` (operations) untouchable by dancers |
| Multi-studio | N independent studio allowances | Charge a sponsoring studio **only** if the dancer explicitly selected/linked it and it has an enabled sponsorship with remaining cap; else personal |
| Metering | Check → call → record; LUMI record fails | Reserve → call → settle/release, DB-atomic, idempotent |
| Caps | Monthly studio; 8/10min in-memory | Per-dancer day + month, per-studio sponsorship month, global daily spend cap, durable per-user rate limit |
| Kill switches | One env for all | Per-capability policy (staff-API `writeGuard` pattern) + DB pause flags |
| Provider cost visibility | None (no token/cost logged) | Store provider `usage` (input/output/cached tokens), model, latency, status per attempt |
| Public KB | unauthenticated, unlimited | Anonymous: retrieval only or tight IP + global caps, input length cap |

### 9.1 Ledger design (describe only; nothing applied)

Reuse ENT-1's shape; add an AI-specific ledger rather than overloading `usage_events` (whose `created_by` is tied to `auth.uid()` and whose workspace is studio/organizer only).

Tables (new; service_role only; RLS on; no grants, as ENT-1):
- `ai_entitlements`: `scope` ('dancer_personal' | 'studio_sponsorship' | 'studio_ops'), `user_id` (personal), `studio_id` (sponsorship), `feature_key`, `period_kind` ('day'|'month'), `quantity_limit`, `status`, `source`. Platform defaults come from config; per-user/per-studio overrides are rows.
- `studio_ai_sponsorships`: `studio_id`, `enabled`, `monthly_cap`, `per_dancer_monthly_cap`, `eligible_audience` (e.g. active students only), `enabled_by`, `enabled_at`; set only by an explicit studio-owner action; audit events table.
- `ai_dancer_studio_selection`: `user_id`, `studio_id`, `client_id`, `selected_at`, consent (revocable). Attribution resolves from this row, never from "first link".
- `ai_usage_ledger` (append-only): `idempotency_key` (unique per user), `user_id`, `payer_scope` + `payer_id` (user or studio), `studio_context_id` (nullable: whose data was used, distinct from who paid), `feature`, `status` ('reserved'|'settled'|'released'|'failed'), `units_reserved`, `units_settled`, `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `est_cost_micros`, `error_class`, timestamps, `request_hash`. No prompt or response content.

RPCs (service_role only, SECURITY DEFINER, advisory lock per payer + period, mirroring `reserve_usage_allowance` / `settle_usage_reservation`):
- `ai_reserve(user, selection, feature, units, idempotency_key)` → reservation id + resolved payer, or a refusal (`personal_exhausted`, `sponsorship_exhausted`, `daily_cap`, `paused`). Same key returns the existing reservation, so retries never double-reserve.
- `ai_settle(reservation, tokens, status)` → idempotent; releases on provider failure/timeout before dispatch; settles actual units on success; records real tokens even on parse failure.
- `ai_sweep_stale()` → releases reservations stuck beyond N minutes; conservative (hold until reconciled if a dispatch happened).

Charge order: (1) explicitly selected sponsoring studio with sponsorship enabled, dancer under its per-dancer cap, pool not exhausted → studio_sponsorship; (2) otherwise personal allowance; (3) otherwise refuse with a clear message. **Never** fall through to `studio_ops` (`ai_action`) and never pick a studio implicitly. A zero-studio dancer simply uses personal. Studio operations AI (lesson/follow-up/campaign) stays on `ai_action`.

Hard caps: per dancer/day, per dancer/month, per sponsoring studio/month, per studio per-dancer, and a global daily spend ceiling that flips a kill switch; a durable per-minute burst limit keyed by user id (IP only as a secondary, anonymous-only limit).

Abuse controls: auth required; verified email; max prompt chars; max history; server-built context only (client never supplies context); capped `max_output_tokens`; provider `safety_identifier`/`user` hash; `store:false`; request timeout and one bounded retry reusing the same idempotency key; 1–2 in-flight per user; anomaly flag on N× normal use.

Kill switches: reuse the `src/lib/staff/writeGuard.ts` model: one JSON env policy read per request, fail-closed, capability list (`lumiPersonal`, `lumiSponsored`, `studioOps`, `kbAnon`, `reports`, `events`), minimum app build and blocked build codes for the mobile endpoint (`x-danceflow-app` header). Plus DB pause flags (per studio, per user) to respond to abuse without a redeploy. This replaces the single `AI_FEATURES_ENABLED`.

Data minimization / context a studio relationship may provide: only what the dancer already sees in the portal (visible recaps, own goals, portal-visible syllabus, own upcoming schedule), only for the **explicitly selected** studio, scoped by `studio_id` + `client_id`; drop the name (use "the dancer"); no other clients, billing, internal notes or instructor-private data. Personal mode with no studio selected uses only the dancer's own profile goals/interests (opt-in) and general guidance/KB. Log token counts, never content.

### 9.2 Migration implications (never applied here)

Additive and backward compatible: existing `usage_events` / summaries / `usage_addon_entitlements` / credit packs / `ai_action` are untouched, so studio operations keep working unchanged. Order:
1. Corrective migration pinning `record_usage_event` into the repo (no behavior change); Git-only first, then PROD parity check.
2. New tables + RPCs above (service_role only), dark; DEV apply, then isolated QA with concurrency tests (parallel reserve, retry with the same key, crash mid-flight, release on provider error, double settle).
3. App: add a metering port; migrate **KB, events, reports** first (smallest blast radius), then LUMI web (fixes L1 by leaving `record_usage_event`), then the A2 mobile endpoint on the same service. Do not "fix L1" by calling `record_usage_event` as the student (it would charge the studio ops pool).
4. Introduce the policy env fail-closed; new capabilities default off.
5. Rollout dark → internal dancers → small cohort. PROD SQL only with the owner gate; SQL before app.
Owner decisions needed (none made here): sponsorship defaults, whether the personal allowance is platform-funded, premium expansion. Roadmap Decision #24 (any LUMI enhancement is a new decision) and #8 (ARIA/LUMI plan placement blocked) apply.

---

## 10. Ranked risk assessment

1. L1: LUMI never metered (certain; low volume today).
2. L2: public KB assistant uncapped and unauthenticated (cost-DoS).
3. L3: events/reports actions unauthenticated, unmetered, attacker-sized prompts.
4. Starvation trap: "fixing" L1 naively makes dancers consume the studio's operational `ai_action`.
5. L6: TOCTOU / no idempotency: over-cap, double charge, ignored record failures.
6. L5: weak rate limiting (per-instance, IP-keyed, user-keyed bypass).
7. Schema drift: `record_usage_event` absent from the repo; three divergent allowance calculators.
8. L4/L7: error leakage; student name sent to the provider; no `store:false`, safety identifier or timeout.
9. Mobile `lumiEnabled` ignores the plan gate (web/mobile inconsistency) — an entitlement ambiguity for A2.
10. Model lifecycle: search results describe gpt-4.1-mini's model page as deprecated while still priced; the model id must be config and monitored.

## 11. Operating-cost scenarios

Prices (USD per 1M tokens, Standard tier), read 2026-11-21 from https://developers.openai.com/api/docs/pricing (platform.openai.com/docs/pricing redirects there; the page shows no update date; figures extracted by a fetch tool, so spot-check before budgeting), cross-checked with https://developers.openai.com/api/docs/models/gpt-5-mini and https://platform.openai.com/docs/models/gpt-4.1-mini:

| Model | Input | Cached input | Output | Batch in/out |
|---|---|---|---|---|
| gpt-4.1-mini (current default) | 0.40 | 0.10 | 1.60 | 0.20 / 0.80 |
| gpt-4o-mini | 0.15 | 0.075 | 0.60 | 0.075 / 0.30 |
| gpt-5-mini | 0.25 | 0.025 | 2.00 | 0.125 / 1.00 |
| gpt-5-nano | 0.05 | 0.005 | 0.40 | 0.025 / 0.20 |
| gpt-5.4-mini | 0.75 | 0.075 | 4.50 | 0.375 / 2.25 |
| gpt-4.1-nano | described as shut down on its model page; not on the pricing page | | | |

(gpt-5-family reasoning tokens bill as output and would add to the estimates below; not modeled.)

Token estimates (assumptions derived from code limits; verify with real counters after launch):
- LUMI plan request: system prompt ≈ 200 tok; context JSON (8 goals, 6+6 recaps, 8 syllabus items, 3 lessons) typical ≈ 2.3k, worst ≈ 6.8k; output typical ≈ 500, cap 900. → typical 2.5k in / 0.5k out; max 7k / 0.9k.
- Assumed chat turn: system 250 + context 1.5k + history 900 (6 turns) + user 50 ≈ 2.7k in / 0.3k out; about 2k of the input cacheable with a stable prefix.
- KB assistant: ≤8 articles × 3,200 chars ≈ 6.5k in / ≤850 out.

Cost per request:

| Model | LUMI plan typ | LUMI plan max | Chat turn | Chat turn, 2k cached |
|---|---|---|---|---|
| gpt-4.1-mini | $0.0018 | $0.0042 | $0.00156 | $0.00096 |
| gpt-4o-mini | $0.0007 | $0.0016 | $0.00059 | $0.00044 |
| gpt-5-mini | $0.0016 | $0.0036 | $0.00128 | $0.00082 |
| gpt-5-nano | $0.0003 | $0.0007 | $0.00026 | $0.00016 |
| gpt-5.4-mini | $0.0041 | $0.0093 | $0.0034 | $0.0020 |

Monthly cost, gpt-4.1-mini chat turn (no cache → with cache); registered dancers × active ratio × requests per active dancer:

| Registered | Active | 10 req/mo | 30 req/mo |
|---|---|---|---|
| 1,000 | 10% | $2 → $1 | $5 → $3 |
| 1,000 | 30% | $5 → $3 | $14 → $9 |
| 10,000 | 10% | $16 → $10 | $47 → $29 |
| 10,000 | 30% | $47 → $29 | $140 → $86 |
| 100,000 | 10% | $156 → $96 | $468 → $288 |
| 100,000 | 30% | $468 → $288 | $1,404 → $864 |

Effects: a dancer who maxes 30 plan requests at 7k/0.9k costs ≈ $0.13/month; one abusive account at 20/day for 30 days at max size ≈ $2.5, **bounded only if a cap exists**. With no caps, 1 req/s sustained for 30 days on one endpoint at typical size ≈ $4.7k — which is why L1/L2/L3 matter more than expected spend. Halving history (6→3 turns) saves ≈ 12% of a chat turn; cutting `max_output_tokens` 900→500 lowers worst-case cost ≈ 17%; context caching saves ≈ 40% of chat cost; Batch does not apply to interactive use. Changing model scales cost roughly 0.2× (nano) to 2.2× (5.4-mini).

## 12. Recommended launch limits (no pricing or plans set)

Expected spend is small; limits exist to cap blast radius and abuse, not to ration normal use.
- Personal allowance: **20 requests/month** per registered dancer (worst case ≈ $0.09/mo at max size; typical ≈ $0.03; 100k dancers all maxing ≈ $9k, realistic ≈ $0.5–1.5k).
- Daily cap **5 requests/day**; burst **≤3/min**, enforced durably per user.
- Sponsored (optional, default off): a studio-chosen monthly pool with a per-dancer extra up to **+30/month**; the studio sets the number (not a price).
- Global: a platform daily spend ceiling (e.g. $25/day at launch) that trips the kill switch; alerts at 50% / 80%.
- Input: user message ≤ **1,000 chars**; history ≤ **6 turns / 2,500 chars**; server-built context ≤ **~3k tokens**; `max_output_tokens` **500** for chat (LUMI plan 700); timeout 20 s; ≤1 retry with the same idempotency key; ≤2 concurrent per user.
- Anonymous KB assistant: question ≤ 300 chars, per-IP 5/10 min plus a global hourly ceiling, or retrieval-only (no LLM) until metered.
- Model: keep gpt-4.1-mini or move to gpt-5-mini / 4o-mini behind the policy env; log real tokens for two weeks and re-tune.

## 13. Shared knowledge infrastructure implications

The owner wants one permission-aware retrieval layer shared by LUMI and ARIA with audience-specific permissions, built on the KB upgrade (KB-2B content platform; the kb-platform session owns it). Plug-in points, not a design: (a) retrieval must run server-side **inside** the metered AI service (§9) so the audience (`public`, `dancer`, `studio_staff`, `studio_owner`) is a server-derived filter, never client-supplied; (b) the current KB assistant's keyword scoring + 3,200-char article truncation is today's only retrieval and should be replaced by that layer, with a hard token budget per request; (c) LUMI studio-relationship context (recaps, goals) is a *separate* permissioned source from KB articles and must carry `studio_id`/`client_id` provenance so the ledger's `studio_context_id` can be filled; (d) each source needs a per-request size budget so adding sources cannot silently inflate tokens; (e) public KB search must keep working with AI off (it already degrades to article links).

---
Evidence index: `src/lib/lumi/portal.ts:38-258`; `src/app/portal/[studioSlug]/journey/actions.ts:139-325`; `src/lib/usage/addons.ts:49-267`; `src/lib/usage/ai-credit-packs.ts`; `src/lib/billing/access.ts:469-545`; `src/lib/security/rate-limit.ts`; `src/lib/supabase/migrations/20260601_usage_addons_foundation.sql`; `src/lib/supabase/migrations/20261013090000_ent1_usage_allowance_reservations.sql`; `src/lib/staff/writeGuard.ts`; `src/app/knowledgebase/ai-actions.ts`; `src/app/app/events/ai-actions.ts`; `src/app/app/reports/actions.ts`; PROD function `public.record_usage_event` (read with `pg_get_functiondef`).
