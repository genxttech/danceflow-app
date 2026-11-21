# KB shared retrieval: one permission-aware knowledge layer (design only)

| | |
|---|---|
| **Status** | Design only. No code beyond the optional schema fields added in KB-2B (`audience`, `sensitivity`, `citationLabel`; `roles`, `requires`, `contexts` already existed). No vendor spend, no hosted change, no SQL |
| **Date / base** | 2026-11-21, `origin/main` `35c38c106` |
| **Goal** | The knowledgebase upgrade becomes the single grounded source behind four consumers instead of four unrelated systems: the public site and its assistant, the in-app Help panel (KB-3/KB-4), ARIA (studio operations) and LUMI (dancer learning) |

## 1. Consumers and what each may see

| Consumer | Caller | Grounding it needs | Must never get |
|---|---|---|---|
| Public site + public assistant | Anonymous visitor | `visibility: public`, `status: published`, `sensitivity: public` | Anything signed-in, draft, internal |
| In-app Help panel | Signed-in studio user (role known, plan known) | Public articles plus `signed_in` articles whose `roles` include the caller's role and whose `requires` the studio satisfies; ranked by the current page's `contexts` | Articles for roles or plans the caller lacks |
| ARIA (studio operations, marketing, reporting) | Signed-in staff, studio known | The same set as the Help panel, plus operational facts that are not articles (the studio's own data, through ARIA's existing governed tools) | Retrieved text used as an instruction; another studio's data |
| LUMI (dancer discovery, learning, events, progress) | Signed-in dancer in a studio portal | Articles with `audience` including `student`, plus the dancer's own progress data via LUMI's own tools | Staff-only articles, other dancers' data |

Rule: **retrieval filters first, ranking second.** A document the caller may not see is excluded before scoring, so it cannot appear in a snippet, a citation or a prompt.

## 2. Frontmatter needed now (so KB-2B does not paint us into a corner)

Already in the schema: `title`, `slug`, `category`, `summary`, `order`, `visibility` (`public` | `signed_in`), `status`, `roles`, `requires {plan, flags}`, `lastVerified`, `related`, `contexts` (reserved, must be empty until KB-4).
Added now as optional fields (defaults keep every migrated article valid and unchanged):

| Field | Values | Why a retrieval layer needs it |
|---|---|---|
| `audience` | list of `public_visitor`, `studio_staff`, `organizer`, `student` | Which consumer surface may serve the article. Distinct from `roles` (which person) and `visibility` (which login state). Empty means unclassified, and consumers then fall back to `visibility` and `roles` only |
| `sensitivity` | `public` (default), `internal`, `restricted` | Whether an assistant may quote it. Anything other than `public` is rejected on a public article by the schema, and is never sent to an unauthenticated caller |
| `citationLabel` | short text, at most 80 characters | How an assistant names the source in an answer; defaults to the title |
| `roles`, `requires.plan`, `requires.flags` | existing | Permission and availability filters. Flags let an article describe a feature only when it is on |
| `contexts` | route keys (KB-4) | Page-aware ranking for the Help panel |
| `lastVerified` | date | Freshness signal: consumers can down-rank or caveat articles not verified since a release that touched their area |
| `status` | `published` / `draft` | Drafts never indexed |

Not added yet (add when a consumer needs it, as optional fields): per-chunk anchors, language, supersedes, product-area tags. Heading anchors already exist (the renderer gives every heading a stable id), so a citation can deep-link to a section.

## 3. Retrieval layer

One server-only module, `src/lib/knowledgebase/retrieve.ts` (future), with one entry point:

```
retrieve({ query, caller: { kind, userId?, studioId?, role?, plan?, flags? }, context?: routeKey, limit })
  -> [{ slug, anchor?, title, citationLabel, url, snippet, score, sensitivity }]
```

Steps: (1) authorize and filter by `status`, `visibility`, `audience`, `roles`, `requires`, `sensitivity`; (2) rank; (3) return passages with citation fields; (4) log the query id and the slugs returned (no raw question text unless the studio's privacy settings allow it).

Callers never read article files directly. The loader (`loader.ts`) stays the only reader; `retrieve.ts` is the only consumer of its output for AI use.

### Indexing and embedding options (no vendor spend now)

| Option | Cost | Quality | Comment |
|---|---|---|---|
| 1. Improved lexical (recommended first) | None | Fixes the measured failures (see `KB-D3`): add inverse-document-frequency weighting, a small synonym map (text/SMS, blast/campaign, pay/payroll), heading-level passages, and an abstention threshold | Re-measure with `scripts/kb/retrieval-eval.mts` (77% top-1 today) |
| 2. Postgres full-text search | None beyond the existing database | Stemming and ranking for free; needs a table or view of passages; a migration, so a separate owner-gated change | Good fit with row-level filters |
| 3. Embeddings in pgvector | Embedding calls plus storage; small corpus (about 80 articles, a few hundred passages) so cost is trivial but nonzero | Best recall for vocabulary mismatch | Add only if option 1 plateaus. Embed at build time, not per request. Provider cost accounting belongs to the ai-entitlements work |

Index at build time from the Markdown files, per audience, so permission filtering never depends on the model.

## 4. Citation format

Every grounded answer returns structured citations, not just links:

```
{ label: citationLabel, url: "/knowledgebase/<slug>#<heading-id>", slug, lastVerified }
```
The UI shows the label as a link under the answer. The model is instructed to cite only passages it was given, and the server drops any citation not in the retrieved set. Signed-in articles cite to the in-app Help URL, never the public URL.

## 5. AI-prepared actions must not come from retrieved text

Retrieval answers questions; it never authorizes anything. For ARIA and any future assistant that can propose a change:

1. Retrieved article text is **data** in the prompt, labelled as untrusted reference material. It is never concatenated into a system instruction or a tool-argument source.
2. The model may only *propose* an action through ARIA's existing typed tools. Proposals are written as `automation_actions` rows in a pending state and go through the existing approval flow and role checks (for example `canManageSettings` in `src/lib/auth/permissions.ts:75` for settings changes), then the existing executor, which stays limited to its allowlist.
3. No tool accepts free text from retrieval as its authority: tool arguments are validated against schemas and re-authorized against the signed-in user and studio at execution time, not at proposal time.
4. The public assistant and the Help panel have **no tools**. The only thing a retrieved passage can produce there is words and a link.
5. A prompt-injection phrase inside an article (articles are repository content, so this is a content-review concern, not a runtime one) cannot change what an action may do, because authorization never reads the prompt.

## 6. Cross-cutting controls

| Control | Where |
|---|---|
| Rate limit, length cap, timeout, bot protection | The shared AI entry points reuse `checkRateLimit` / `getServerActionRateLimitKey`; anonymous callers get stricter limits and a daily budget (see `KB-D3`) |
| Metering | One accounting path through `lib/usage/addons.ts` (`getUsageAllowance`, `recordUsageEvent`), coordinated with the ai-entitlements session. Not designed here |
| Abstention | Below a score threshold: no model call, a fixed "no guide covers this" message and a Contact Support link |
| Freshness | `lastVerified` surfaced to the model ("verified 2026-11-21") so it can caveat older articles; content tests already pin slugs and links |
| Public claims | The retrieval layer cannot make an article truer. Public-claims review (the D7 process) stays the gate for what is published |
| Privacy | Do not store raw questions by default; redact obvious emails and phone numbers before any provider call |

## 7. Phasing

1. **KB-2B (done/in flight):** Markdown + frontmatter, loader, renderer, integrity tests, the optional fields above.
2. **KB-2A/2C:** fill `roles`, `requires`, `audience`, `lastVerified`, `related` as each article is reviewed.
3. **KB-3/KB-4:** Help panel and `contexts`, built on `retrieve()` with the lexical ranker (option 1).
4. **D3 follow-through:** move the public assistant onto `retrieve()`; apply the controls in §6.
5. **ARIA/LUMI adoption:** each consumer calls `retrieve()` for grounding; ARIA's action path stays unchanged (§5).
6. **Only if measured need:** Postgres full-text or embeddings (option 2 or 3), as separate owner-approved changes.

## 8. Open decisions

1. Which consumer ships second after the Help panel: the public assistant (needs D3) or ARIA grounding?
2. May `internal` articles exist (for example staff runbooks), or does the knowledgebase stay entirely customer-facing?
3. Embeddings: acceptable provider and budget when option 1 plateaus? (No decision needed now.)
