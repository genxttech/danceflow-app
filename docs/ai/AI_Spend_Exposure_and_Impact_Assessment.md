# AI spend exposure and impact assessment

Status: read-only assessment, docs only. Date: 2026-11-21. Builds on `LUMI_ARIA_AI_Usage_and_Entitlement_Audit.md` (PR #757).
No provider call was made, no secret was read, no environment value was changed, no SQL was applied.

## 1. What we can and cannot see

| Source | Result | Limit |
|---|---|---|
| Vercel runtime logs (`vercel logs --environment production --json -q "method:POST"`, paged backwards) | 500 POST requests from **2026-11-15 01:46Z to 2026-11-21 20:37Z** (about 6.8 days; the CLI returned nothing older and caps each page at 50) | Retention is roughly a week. Logs show path, method and status, not payloads |
| PROD read-only SQL (`usage_events`, `usage_monthly_summaries`, `usage_addon_entitlements`, `studios`) | Aggregates only (section 3) | Records only what the app meters; LUMI, knowledgebase, event-description and report-insights calls were never recorded |
| `vercel env ls production` (names only) | `AI_FEATURES_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL_REPORT_INSIGHTS`, `STRIPE_PRICE_AI_CREDITS_*` exist; **values are hidden**; the first three exist in **Production and Preview** | We cannot see whether the flag is `true`, nor the key's project, budget or limits |
| OpenAI dashboard / usage API | **Not available to us** (no admin or usage key; the app key is never read or used) | The owner must read it (section 6) |

## 2. Provider-request volume found in the logs

Of the 500 POSTs in the window, by route (status): `/login` 320 (200/303), `/signup` 95 (303), `/platform/sms` 27, public studio pages 29, `/api/student/account/reactivate` 11, `/app/schedule…` 7, a few staff-API and platform calls. Per day: 11-15 25, 11-16 64, 11-17 71, 11-18 82, 11-19 113, 11-20 95, 11-21 (to 20:37Z) 50.

**POSTs to any AI-backed route in the window: 0.** That covers `/knowledgebase` (assistant), `/portal/<studio>/journey` (LUMI), and the pages that host the lesson, follow-up, campaign, event-description and report-insights actions. No burst, no 4xx/5xx cluster on those paths. Server actions are POSTs to the page path, so this is a direct measurement of server-action invocations; it is **not** evidence about the period before 2026-11-15.

Corroboration from the database: **0** `ai_action` usage events in the last 90 days (last event 2026-08-15); 20 events ever (18 lesson, 2 campaign), 2026-06-22 to 2026-08-15. This also shows `AI_FEATURES_ENABLED` was `true` in production at least until 2026-08-15 (the lesson and campaign actions refuse to run, and so to record, when it is not).

## 3. PROD aggregates (no personal data)

- Studios: 7 (3 Pro active, one of them an override; 1 Pro cancelled; 1 Pro not started; 2 Starter). `lumi_enabled` on **1** studio (Pro, active, not an override).
- AI credit-pack entitlements: **0**. `usage_reservations`: 0. `student_dance_goals`: 0. `lumi_response_reports`: 0.
- `usage_monthly_summaries ai_action`: 2026-06 sum 3 (1 studio), 2026-07 sum 11 (1), 2026-08 sum 6 (2 studios, max 4). Nothing later.
- Dancers: 986 auth users, 515 `dancer_profiles`, 20 linked to a studio (all to one studio).

## 4. What stops working if `AI_FEATURES_ENABLED` is not `true`

Everything below degrades to a clear "not enabled/configured" message (no data loss, no billing or entitlement change, no failure of any non-AI feature).

| # | Feature / action | Where | Who uses it | Plan gating today (main) | Behaviour when off |
|---|---|---|---|---|---|
| 1 | LUMI plan generator `generateLumiPlanAction` | `/portal/<studio>/journey` | Dancers of studios with `lumi_enabled` | Studio flag + Growth/Pro active + eligible student | "LUMI is not configured yet"; goals and the rest of the Journey page keep working |
| 2 | Lesson recap/syllabus assistant | `app/lesson-ai-actions.ts` | Studio staff | `ai_assistant` (Growth+) + allowance | Message; manual recap writing unaffected |
| 3 | Follow-up message assistant | `app/follow-up-ai-actions.ts` | Studio staff | `ai_assistant` + allowance | Message |
| 4 | Campaign draft assistant | `marketing/campaigns/ai-actions.ts` | Studio staff | `ai_assistant` + allowance | Message; campaign sending unaffected |
| 5 | Event description assistant | `app/events/ai-actions.ts` | Studio/event staff | **None before this PR**; Growth+ and allowance after | Message |
| 6 | Report insights card | `app/reports/actions.ts` | Studio staff | UI shows it for Growth/Pro; **action itself ungated before this PR** | Message |
| 7 | Public knowledgebase assistant | `/knowledgebase` | Anonymous visitors | None | Already degrades: returns matching article links instead of a generated answer |

Not affected: mobile LUMI (template-only, no provider call), ARIA (no provider call), knowledgebase search and articles, billing, credit-pack purchase and entitlement rows (PROD has none), and all non-AI product features. Observed real use of items 1-6 in the last 90 days is zero.

## 5. Financial exposure (cost model from the audit, gpt-4.1-mini at $0.40 in / $1.60 out per 1M tokens, 2026-11-21)

| Scenario | Evidence | Estimated cost |
|---|---|---|
| Legitimate use at observed levels | 0 AI POSTs in 6.8 days, 0 metered events in 90 days | **under $1 per month** |
| Legitimate use at launch scale | audit section 11 | $5 to $470 per month (1k to 100k dancers, 10-30% active) |
| Abuse of the public KB assistant, unguarded | about 6.5k input + 0.4k output tokens per call, about $0.0033 per call; no limit | 1 call/s ≈ **$285/day**; 10 calls/s ≈ **$2.8k/day**; a crafted ~1 MB question ≈ $0.10 per call |
| Abuse of event-description / report-insights, unguarded | attacker-sized prompts (bounded only by the 1 MB request body), per-IP in-memory limit only | similar order, up to about $0.10 per call |
| Same abuse after this PR's guard (per instance) | question cap 300 chars, 5/min and 30/h per IP, 300/h per instance, input ≤ 36k chars (~9k tokens), 15 s timeout | KB: at most about **$1 per hour per server instance**; studio actions require sign-in + plan + allowance |

The only real ceiling today is whatever monthly limit the OpenAI organization or project has set (default usage-tier caps apply if none was configured). We cannot see it; section 6 asks for it. **Nothing in the logs or database indicates that abuse has occurred**; the exposure is that nothing prevents it.

## 6. Owner data request (the OpenAI dashboard, which only the owner can read)

1. **Usage export by model and by day** (Dashboard, Usage; or Settings, Usage; export CSV) for **2026-05-01 to today**, grouped by project and by model. We expect near-zero; any spike, especially on or after 2026-11-14, is the finding.
2. **Which project the production key belongs to** and its **API key permissions** (Settings, API keys / the project's keys). Confirm it is a project key with only Responses/Model request scope, not an all-permissions key; confirm Production and Preview use **different** keys (Vercel shows the same variable in both environments).
3. **Spend limits:** project budget and organization monthly limit (Settings, Limits), the current usage tier, and any email alert thresholds. If none is set, set a low hard monthly limit (the exposure in section 5 is bounded by it).
4. **Model allow-list** for the project (restrict to the model actually used).
5. **Billing:** current balance/auto-recharge setting (a prepaid balance with auto-recharge off is itself a hard ceiling).
6. The **value of `AI_FEATURES_ENABLED` in Production and in Preview** (Vercel dashboard, Settings, Environment Variables; the value is hidden to our tooling).

## 7. Is an immediate production configuration change required?

**Not on the evidence of abuse:** zero AI-route POSTs in the retained window and zero metered usage in 90 days. **But it is the cheapest risk control available until the guard code reaches production**, because every guard in this PR is Git-only and the production hold and the release gate mean the code will take time to ship (and the live line `release/website-embeds` carries the same unguarded code).

Precise decision, only if the owner wants the stopgap:
- **Variable:** `AI_FEATURES_ENABLED`, **value:** `false` (or delete it), **environments:** Production **and Preview** (Preview shares the same key). Takes effect on the next deployment/redeploy (Vercel environment changes do not alter running deployments).
- **Effect:** the seven features in section 4 show their "not enabled" state; the knowledgebase assistant keeps returning article links. Observed real use is zero, so the functional cost is nil. No data, billing or entitlement change.
- **Revert:** set it back to `true` after the guarded release (backport below) is live.
- **Recommendation:** do this if the OpenAI usage export (section 6, item 1) shows any unexplained spend, **or** if the guarded release cannot ship within a few days. If neither holds, leaving the flag on is defensible for a short period given the evidence, provided the OpenAI hard spend limit (item 3) is confirmed.

## 8. Mitigation order

1. Owner reads the OpenAI dashboard (section 6) and confirms a hard monthly spend limit and key scope. No code needed; fastest and independent of deploys.
2. If the dashboard shows anything unexplained, or the limit is missing: set `AI_FEATURES_ENABLED=false` (section 7) until step 4.
3. Merge the guard PR (draft until independently reviewed; **not merged during the production hold**).
4. Backport to the live line `release/website-embeds` (see the PR for the file list) and release under the owner's release gate. After this, `AI_DISABLED_FEATURES` gives per-feature switches (for example `kb_public`) without turning everything off.
5. Next slices (audit section 9): durable per-dancer/day ledger and global daily spend ceiling in the database (SQL, designed in the audit; not applied), pin `record_usage_event` into the repo, per-feature policy env in the `writeGuard` style, A2 on the same service.

## 9. Residual limits after the guard PR

- Rate limits and the per-instance KB budget are in-memory (per serverless instance); they are speed bumps, not hard budgets. A durable global daily ceiling needs a table and function (design in the audit; STOP, not applied).
- The studio actions (lesson, follow-up, campaign, event, report) still check allowance then record after the call (no reservation): parallel calls can overshoot a studio's monthly allowance by the in-flight count. They are authenticated and plan-gated and the overshoot is bounded by the rate limiter; closing it needs the database reservation path (ENT-1 style) designed in the audit.
- LUMI's summary row for `lumi_action` can read higher than the true count (released reservations); enforcement does not use it.
- A request that dies between reservation and settle leaves a counted row (conservative).

## 10. The guard PR: what it changes, review record, backport

Changes (Git-only, no SQL, no env change, no behaviour change when everything is healthy): `src/lib/ai/providerCall.ts` (single wrapper for all 7 provider call sites: fail-closed config, per-feature deny list `AI_DISABLED_FEATURES`, input cap, output-token cap, timeout, `store:false`, no raw provider errors, one accounting log line per attempt with provider token usage); `src/lib/lumi/usage.ts` (LUMI usage is now actually recorded: own `lumi_action` key through the service-role client, reserve-then-verify, per-dancer caps 10/day and 60/month by default via `LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY|MONTH`, pool size unchanged = the plan allowance plus credit packs; dancers can no longer touch the operational `ai_action` pool); event-description and report-insights actions now require sign-in, Growth/Pro (`ai_assistant`) and allowance, and are metered; public knowledgebase assistant: 300-character cap, 5/min and 30/h per IP, per-instance hourly budget (default 300), 15 s timeout, links-only fallback.

Behaviour changes the owner should know about: (1) starter-plan studios can no longer use the event-description assistant (it was unauthenticated and unmetered; the other three studio assistants already required Growth/Pro); (2) a LUMI pool separate from `ai_action` sized like it means a studio's total AI allowance is effectively twice what it was in theory (LUMI never counted anything before, so in practice nothing shrinks); (3) report metrics over 12,000 characters are refused; (4) a dancer is limited to 10 LUMI requests a day and 60 a month (tunable by env).

Independent review (read-only subagent given the diff and a threat list, not this document's conclusions): no critical or high findings. Medium findings and their disposition: capacity stuck when a request crashes between reservation and settlement (**fixed**: try/catch releases unless the provider was reached); null `metrics` throwing after provider spend in report insights (**fixed**: validated up front); parallel overshoot of the studio allowance in the lesson, follow-up, campaign, event and report actions (**not fixed**, pre-existing check-then-record; needs the database reservation path, section 9). Low: wrapper hardening against non-string content and NaN caps (**fixed**); `setState` also filters on the client (**fixed**); in-memory budget buckets can be evicted by a flood of distinct keys and the IP helper trusts the first `x-forwarded-for` entry (**accepted**, labelled a speed bump; a durable budget is the real control); `.in("metadata->>state", …)` relies on PostgREST JSON-path filters and is covered by unit tests with a fake client only (**open: one DEV integration check before release**); released LUMI reservations still increment the `lumi_action` monthly summary through the insert trigger (**documented**, enforcement reads rows).

Tests: wrapper (flags, deny list, caps, timeout, error text, log line, budget, no retry), LUMI accounting (own key, no RPC, settle/release, parallel requests never exceed the daily cap or the 200-request pool, per-studio and per-dancer isolation, fail-closed on unreadable counts), public KB (cap, rate limit, kill switch, failure fallbacks), event/report gating and metering.

Backport to the live line (`release/website-embeds`): the touched files are byte-identical on both lines, so the same diff applies cleanly: new `src/lib/ai/*`, `src/lib/lumi/usage.ts`, edits to `src/lib/lumi/portal.ts`, the six action files and `journey/actions.ts`, plus the three new test files. No SQL, no env change required; the owner gates that release separately. Run one DEV check of the LUMI count filter first.

### Second independent review (2026-11-26, head after merging main)

A second read-only review of the full source diff found one HIGH and several smaller items. **Fixed:** (HIGH) the 40,000-character LUMI cap would have refused every request from a dancer with a long history, who cannot edit that data: the context is now serialized compactly and trimmed to 32,000 characters (`src/lib/lumi/context.ts`); billed-but-failed LUMI calls were released: the wrapper now reports `mayHaveBilled` (timeout, dropped connection, body-read timeout, empty answer) and only unbilled failures release capacity; public KB timeout raised from 8 s to 15 s (fewer billed calls that fall back to links); `KB_ASSISTANT_INSTANCE_HOURLY_BUDGET=0` now turns the model off instead of meaning the default; event descriptions are no longer silently truncated (the request input cap refuses oversize input).

**Accepted residual risk (not fixed here):** studio actions are check-then-record, so parallel calls can overshoot an allowance and failed-but-billed calls are not metered; their rate-limit keys include caller-controlled strings; the public KB ceiling is per server instance with no durable global budget; a LUMI reservation whose release fails, or whose function is killed, stays counted until month end; Starter studios (including Organizer Suite add-on holders) are refused the event-description assistant although its button still renders. All but the last need the database reservation and budget path described in the audit.

### Third review and DEV filter check (2026-11-26)

A fresh read-only re-review of the second-review fixes found no critical or high item. **Fixed:** syllabus history was trimmed in arbitrary database order, so current work could be dropped: progress is now ordered (practicing, introduced, comfortable, not started, mastered; newest first), assignments newest first, the syllabus is shortened before recaps, and a shortened context is marked `historyShortened`; added tests for the settle/release decision in the LUMI action and for a knowledgebase budget of 0. **Accepted (low):** non-2xx responses count as unbilled; connect failures count against the dancer; a 200 response with a `null` body releases; budget values such as `-1` or `off` fall back to the default; event input over about 15,000 characters is refused.

**DEV count-filter check (read-only, `sb.sh dev-read`):** as `service_role`, the SQL form of the count query runs against `usage_events`; `metadata->>'state' in ('reserved','settled')` counts exactly the reserved and settled sample rows; `service_role` has select, insert and update on the three usage tables; the table constraints accept the LUMI insert; the only trigger is the after-insert summary. The installed client builds `metadata->>state=in.(reserved,settled)` (checked offline). **Not exercised:** that URL against hosted PostgREST over HTTP (the SQL runner cannot do it). Before release, confirm on a preview or DEV app that one LUMI request leaves a `settled` row and that a second request counts it.

### Fourth review (2026-11-26)

A fresh read-only re-review of the third-round fixes required changes (three medium): when recaps were the large section, current syllabus work was cut to its smallest size first; and two tests still passed with the logic they guard removed (knowledgebase zero budget, syllabus-first trimming). **Fixed:** the syllabus now shortens one step ahead of the other sections instead of all the way first; both tests were corrected, a settle-failure test was added, and each of the three guards was removed temporarily to confirm its test now fails. These last changes have not had a further independent review. **Accepted (low):** the action test mock ignores query arguments (ordering wiring and note redaction are not tested); untouched figures tie in arbitrary order; the prompt does not explain `historyShortened`.

### Owner dispositions applied (2026-11-26)

This supersedes the behaviour listed above where they differ. Pilot LUMI limits are now 5 a day and 20 a month (E3). The public knowledgebase model answer is **off unless `KB_PUBLIC_ASSISTANT_MODEL_ENABLED=true`** (E4/K2), replacing the earlier default-to-current-behaviour switch. Studios without the AI assistant keep the event helper, signed in and metered from a separate pool (E1). The dancer name is no longer sent to the provider, mobile LUMI availability follows the plan, and complimentary studios have a capped included allowance (E7). See `AI_Spend_Controls_Plan.md` and `AI_Usage_Ledger_Proposal.md`.

### Fifth review (2026-11-26)

A fresh read-only review of the context fixes, the owner-disposition changes and the ledger SQL found no critical or high item and no unauthenticated or cross-studio path to the provider. **Fixed:** the web portal home still offered LUMI without the plan rule; a successful event-description call by a caller the usage RPC refuses (organizer-only member, support admin, or past the cap) is now recorded; the ledger proposal now revokes the default service_role grants and never re-admits a duplicate key; an unreadable studio row that triggers the complimentary cap is logged; tests added for the cap, the event metering and pool scoping. These fixes have not had a further independent review.

**Accepted residual risks, for owner acceptance:** Growth/Pro studio assistants still check, call, then record (parallel calls can pass the check together, billed-but-failed calls are not recorded, rate-limit keys include caller-chosen text); the other three assistants and report insights do not record when the usage RPC refuses the caller; any studio staff role, including instructors, can use the studio pools; staff other than owner or admin at a complimentary studio cannot read purchased packs and stop at the cap; free text written by the studio can still contain names.

