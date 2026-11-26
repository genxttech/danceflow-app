# AI spending controls: provider limits, credential separation, containment and release readiness

Status: recommendations (owner dispositions A4, A5, A6, E10, 2026-11-26). Nothing here was changed: no provider setting, key, environment value, flag or deployment.

## A4. Enforced limits and proposed budgets

Verified from OpenAI's documentation (read 2026-11-26, <https://developers.openai.com/api/docs/guides/spend-limits>; no page date shown). **Not verified in this account's dashboard.**

| Control | Enforced? |
|---|---|
| Hard spend limit, organization (all projects) | **Yes**: monthly; affected requests return HTTP 429 `organization_spend_limit_exceeded` |
| Hard spend limit, project (toggle "Enforce a hard limit" in project Limits) | **Yes**: monthly, that project only; `project_spend_limit_exceeded` |
| Spend alerts | **No**: notification only |
| Usage-tier monthly limit set by OpenAI | Yes, but not a budget control |
| Prepaid balance | Requests fail when credit is exhausted |

Enforcement is not instantaneous and recorded spend can slightly exceed the limit. Project budgets, per-model rate limits and model allow-lists are not described on that page: confirm in the dashboard.

Proposed amounts (owner approves; expected legitimate use today is under $1 a month, audit §11):

| Scope | Hard limit / month | Alerts |
|---|---|---|
| Organization | $60 | $30, $48 |
| Production project | $40 | $10, $20, $32 |
| Preview/Development project | $5 | $2.50, $4 |

At about $0.0042 for a worst-case request, $40 is about 9,500 worst-case requests a month. A reached limit stops **all** AI features in that project until raised or the month ends, so the alerts matter.

Owner checklist in the dashboard: confirm hard limits are offered for this account; set them; add alerts; record the usage tier, balance and auto-recharge setting; export usage by model and day since 2026-05-01.

## A6. Separate Production and Preview credentials and controls

Today (names only, `vercel env ls`, 2026-11-21): `OPENAI_API_KEY` and `AI_FEATURES_ENABLED` are each defined for **Production and Preview** in `danceflow-app-qfem`. Whether the values differ is not visible to us. The second Vercel project (`danceflow-app`) was not inspected.

Plan (owner handles keys; engineering never reads them):
1. Create an OpenAI project `danceflow-preview`; set its $5 hard limit and a restricted key (model requests only).
2. Confirm or create `danceflow-production` with its $40 hard limit and its own restricted key.
3. In both Vercel projects: limit the existing `OPENAI_API_KEY` to Production; add a Preview-only variable with the preview key. Set Preview `AI_FEATURES_ENABLED=false` by default and turn it on only for a named test.
4. Rotate: deploy with the new production key, verify one authorized request, then revoke the old key. Values take effect only on new deployments.
5. Record which project each environment uses, without key material.

Rollback: restore the previous variable and redeploy before revoking the old key.

## A5. Can public AI spend be contained today? (recommendation only)

**Not reliably.** The live deployment (`dpl_ERsjXn2R…`, commit `e84ed0f3` on `release/website-embeds`, checked 2026-11-26) contains the unguarded public knowledgebase action. Until a provider hard limit is confirmed there is no ceiling we can verify, and a provider limit alone would stop every AI feature when reached.

Recommendation, in order:
1. Set the provider hard limits now (A4). No code, no deploy.
2. Disable only the public knowledgebase model answer on the live line: a narrow release of the default-off switch (this PR's `KB_PUBLIC_ASSISTANT_MODEL_ENABLED`, backported to the single knowledgebase action). Visitors still get article links.
3. If neither can happen quickly, the only lever on the live code is `AI_FEATURES_ENABLED=false`, which also disables the other AI features (no observed use 2026-11-15 to 11-21; not re-measured). That disables unrelated features, so it needs its own approval.

## E10. Non-production checks and provider cost

Done locally at no cost (existing images, throwaway containers removed afterwards): the real LUMI usage code against `postgres:17` + PostgREST over HTTP. Settled rows are counted and released rows are not; another studio is unaffected; 25 simultaneous requests from one dancer (cap 5) never exceeded the cap (a run admitted 0 to 2: bursts are over-refused); 260 dancers against the 200 pool admitted 194. When local connections were overloaded, release writes failed and rows stayed reserved (counted until month end): the ledger proposal removes that case. Not covered: hosted Supabase.

Charge-bearing tests (**none run**; report before running), gpt-4.1-mini:

| Test | Requests | Upper-bound cost |
|---|---|---|
| One LUMI request on a DEV app (settled row appears and is counted) | 2 | under $0.01 |
| One request through each of the 7 call sites | 7 | under $0.03 |
| Cap behaviour end to end (6 LUMI requests) | 6 | under $0.03 |

## Release readiness: live-line compatibility

Live `e84ed0f3` is on `release/website-embeds`; `main` is hundreds of commits ahead. Apply check (2026-11-26, temporary index, nothing written): the source diff applies to the live commit with a three-way merge except **one conflict, `src/app/knowledgebase/ai-actions.ts`**, which on `main` reads articles through `src/lib/knowledgebase/articles.ts`, absent on the live line. A backport must hand-port that action; it has not been built or tested on the live line. All seven provider call sites exist there. The A5 narrow containment is exactly that one file.

## Pilot values introduced by the PR (all environment-tunable; not pricing)

| Variable | Default | Meaning |
|---|---|---|
| `LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY` / `_MONTH` | 5 / 20 | E3 pilot limits |
| `AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP` | 10 per studio | E1: signed-in, metered event helper for plans without the AI assistant |
| `AI_COMPLIMENTARY_STUDIO_MONTHLY_CAP` | 50 | E7: included AI for billing-override studios (purchased packs on top) |
| `KB_PUBLIC_ASSISTANT_MODEL_ENABLED` | unset = off | E4: leave unset until a durable global cap exists |
| `KB_ASSISTANT_INSTANCE_HOURLY_BUDGET` | 300 | speed bump only |
| `AI_DISABLED_FEATURES` | empty | per-feature switch |

## E1: product promises checked

`src/lib/billing/plans.ts`: Starter lists no AI feature and the billing page says AI actions are not included on it; Growth, Pro and the **Organizer Suite plan** list `ai_assistant`. A Starter studio with the Organizer Suite *add-on* does not receive `ai_assistant` through the add-on, yet the event helper has been shown to it. To avoid removing anything people could use, every active studio that can publish events keeps the helper, signed in and metered from its own small pool. Whether the add-on should include the AI assistant stays an owner product decision.
