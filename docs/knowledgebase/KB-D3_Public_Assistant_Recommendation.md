# KB-D3: public knowledgebase assistant, findings and recommendation

| | |
|---|---|
| **Status** | Recommendation only. The assistant is unchanged by this document. Needs an owner decision (D3) |
| **Date / base** | 2026-11-21, `origin/main` `35c38c106` |
| **Evidence** | (Repo) code reading plus an offline retrieval evaluation (`scripts/kb/retrieval-eval.mts`, reproducible). No production observation: the PROD values of `AI_FEATURES_ENABLED`, `OPENAI_API_KEY` and `OPENAI_MODEL_KNOWLEDGEBASE_ASSISTANT` are unverified |
| **Coordination** | The ai-entitlements session is auditing provider-cost accounting. This document records only what the assistant does today for metering; it does not design cost accounting |

## 1. What it does today

| Aspect | Behavior | Evidence |
|---|---|---|
| Entry | Public form on `/knowledgebase` (`KnowledgebaseAIAssistant.tsx`) calling the server action `askKnowledgebaseAssistantAction`. No sign-in, no bot check, no plan check | `ai-actions.ts:147`, no auth import |
| Input checks | Trimmed; minimum 3 characters. **No maximum length** | `ai-actions.ts:153` |
| Retrieval | Keyword scoring over title, slug, category, summary and body of all public articles; top 8 are used. No embeddings, no synonyms, no stemming | `ai-actions.ts:62-129` |
| Context sent | For each of the 8 articles: title, category, summary, URL, first 3,200 characters of the body (so up to about 25,600 characters per call) | `ai-actions.ts:131-145` |
| Provider and prompt | OpenAI Responses API, model `OPENAI_MODEL_KNOWLEDGEBASE_ASSISTANT`, else `OPENAI_MODEL_REPORT_INSIGHTS`, else `gpt-4.1-mini`; temperature 0.2; `max_output_tokens` 850. System prompt: answer only from the excerpts, say so when they do not answer, no legal/tax/medical/financial advice, do not mention internals | `ai-actions.ts:193-217` |
| Gate | Runs the model only when `AI_FEATURES_ENABLED === "true"` and `OPENAI_API_KEY` is set. Otherwise it returns the keyword matches with a fixed sentence | `ai-actions.ts:175` |
| Sources shown | Up to 6 related article links under the answer (title, summary, category). The answer text carries no inline citations, and the links are the retrieval result, not the sources the model actually used | `ai-actions.ts:246-257` |
| Failure behavior | A non-2xx provider response or an empty output falls back to the keyword matches (fail to links, not fail to nothing). A network error from `fetch` is not caught in this function, so it reaches the caller as an exception; the client component has no try/catch around the call either (`KnowledgebaseAIAssistant.tsx:32`) | `ai-actions.ts:222-233`; no try/catch around `fetch` |
| Timeout | None: no `AbortSignal` on the provider call | `ai-actions.ts:196` |
| Metering | None. No usage event, no allowance, no per-day cap. Every other AI server action in the app checks `studioHasFeature("ai_assistant")` or an allowance and records usage (`app/follow-up-ai-actions.ts:49-100`, `lib/usage/addons.ts`) | grep of `ai-actions.ts` |
| Rate limiting | None. The shared helper exists and is used by the other AI actions (`checkRateLimit`, `getServerActionRateLimitKey` in `lib/security/rate-limit.ts`) but this action does not import it | grep |
| Logging | The question is not stored by the app. It is sent to OpenAI as submitted | code |

### The KB-1 "rate-limit engineering finding": validated

KB-1 said the assistant "appears unauthenticated and not rate-limited". Verified: it is unauthenticated, has no rate limit, no bot protection, no length cap, no timeout and no usage accounting. Whether this costs money depends on `AI_FEATURES_ENABLED` in production (unverified). When it is "true", any script can call the server action repeatedly and each call sends up to about 25,600 characters of context plus an unbounded question to a paid model.

Mitigation caveat for any fix: the in-process limiter keeps its counters in a module-level map, so each serverless instance has its own counters (documented at `rate-limit.ts:24-34`). A per-IP limit there reduces casual abuse but is not a hard budget. A hard cap needs a shared counter (database-backed daily budget) or a provider-side spend limit. The client IP is read from `x-forwarded-for` first (`rate-limit.ts:99-105`); that is acceptable behind Vercel, which sets it, and should not be relied on elsewhere.

## 2. Retrieval accuracy (offline, 79 articles)

Method: 40 questions written in a studio owner's own words (not copied from titles), each mapped to the article(s) that should answer it. 35 have a matching article; 5 ask about topics with no article. The scorer in the script is the production scorer copied verbatim (that file is a `"use server"` module and cannot export it). Run `npx tsx scripts/kb/retrieval-eval.mts`.

| Measure | Result |
|---|---|
| Expected article is the top result | 27 of 35 (77%) |
| Expected article in the top 3 | 29 of 35 (83%) |
| Expected article among the 8 sent to the model | 31 of 35 (89%) |
| Returned nothing | 0 |
| Questions with no matching article that still retrieved something | 4 of 5 |

Failure modes seen:
- **Topic words lose to incidental matches.** "How do I pay my instructors?" ranks independent-instructor and security articles above the payroll article; "send an email blast" ranks portal-invite troubleshooting above the marketing campaign article. Single common words ("email", "instructors", "students") match many bodies at +5 each, and the score has no inverse document frequency.
- **Vocabulary mismatch.** "Can DanceFlow text my students?" does not reach the SMS articles (they say "SMS", not "text"); "Do you have a mobile app?" retrieves card-reader articles ("app" matches), not the capabilities overview; "refund a ticket" misses the registration payment article.
- **No abstention on coverage gaps.** For questions the knowledgebase cannot answer (private lesson booking, group classes, package refunds, cancellation policies) it still returns plausible-looking but wrong articles. The system prompt tells the model to say the guides do not answer it, but with weak context the model may stitch an answer from unrelated text. "What is LUMI?" correctly returns nothing and shows the "could not find" message.
- **Wrong-but-confident source list.** The related links under an answer are the top 6 retrieved, even when the model's answer came from one of them.

Because the content is itself stale in places (KB-1 §2), better retrieval would also surface stale answers faster. Accuracy of the answer is bounded by article accuracy: KB-2A/2C come first.

## 3. Abuse and safety review

| Risk | Today | Note |
|---|---|---|
| Cost abuse / spam | Open (see §1) | Needs rate limit, length cap, daily budget |
| Prompt injection | The user's question is the only untrusted input; article text is repository content. The model has no tools, so injection can only change the wording of an answer or make it quote an article, not take an action. It could be made to say off-brand or false things | Keep the assistant tool-free. Never give a retrieval-grounded assistant write access (see the shared design) |
| PII in questions | Visitors may paste names or emails into the box; it goes to OpenAI | Add a one-line notice under the box, and consider a basic redaction of obvious emails and phone numbers before the call |
| Output safety | React renders the answer as text; no HTML injection | Good |
| Confident wrong answers | Prompt asks for abstention; retrieval does not support it | See §2 |
| Public claims | The assistant restates article text, so an overclaiming article becomes an overclaiming answer | Another reason to land D7 first |

## 4. Options

| Option | What it is | Cost / risk | Fit |
|---|---|---|---|
| A. Keep, harden in place | Add a per-IP rate limit, a question length cap (about 300 characters), a fetch timeout, try/catch around the provider call, and an explicit daily budget; show a notice about what is sent to the provider | Small. Counters stay per-instance unless a shared counter is added. Leaves two unrelated AI help surfaces | Fast stopgap |
| B. Replace with the shared help API | One server-side retrieval layer (see `KB-Shared-Retrieval-Design.md`) serving the public site, the in-app Help panel, ARIA and LUMI, with the same abuse controls and metering as other AI features | Medium. Needs KB-4 context metadata and an owner decision on metering | Target state |
| C. Retire the generative answer | Keep search and "related guides"; remove the model call | Smallest risk and zero provider cost. Loses a feature some visitors use | Valid if usage is low |

## 5. Recommendation

1. **Now (independent of D3, small, routine):** apply Option A's guards to the existing action: rate limit with the shared helper, a question length cap, a fetch timeout and error handling, and a daily call budget. Verify the production value of `AI_FEATURES_ENABLED` and the provider spend limit first; if the flag is off in production the exposure is currently zero and the guards can ship before anything turns it on. Treat "enabling the public assistant" as a separate owner decision.
2. **Then (KB-4):** move the assistant onto the shared retrieval layer (Option B) rather than improving the keyword scorer. Retrieval quality should come from audience filtering, `contexts`, and a better ranker, and be re-measured with the same question set (extend it as articles are added). Add abstention: if the best score is below a threshold, answer with the "could not find" message and a link to Contact Support, never a stitched answer.
3. **Coordinate** metering with the ai-entitlements session so the public assistant either has an explicit "free tier" budget or is gated like other AI features. Do not build a second accounting path.
4. Re-run the retrieval evaluation after D7/KB-2C content changes and after any ranker change; keep the question set in the repository.

## 6. Decisions needed from the owner

1. Is the public assistant meant to exist at all (A/B) or should it be retired (C)?
2. Is `AI_FEATURES_ENABLED` on in production, and what provider spend limit is set? (An owner or engineering read; not verified here.)
3. Is it acceptable that anonymous visitors can use a model-backed feature, within a daily budget, or should it require a sign-in?
