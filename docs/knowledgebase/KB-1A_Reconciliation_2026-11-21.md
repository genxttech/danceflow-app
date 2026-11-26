# KB-1A: KB-1 reconciliation against `origin/main` (2026-11-21)

| | |
|---|---|
| **Status** | Docs only. Re-verifies the accepted KB-1 baseline; it changes no decision in KB-1 and authorizes no content work |
| **Baseline** | KB-1 (`KB-1_Knowledgebase_Audit_and_Help_Center_Plan.md`, audited at `858e74eb`, 2026-10-13) |
| **Checked against** | `origin/main` `8abf21c91` (2026-11-21), 421 commits after 2026-10-14 |
| **Evidence** | Repository inspection only (Repo). No production reads, no running app. Release state of anything not visible in code is **not** verified here |
| **Authorization** | KB-2B (content platform, format-only migration) is the only implementation step this reconciliation feeds. KB-2A and KB-2C content corrections need separate owner authorization (D7) |

## 1. Is the KB-1 "what exists" assessment still accurate?

**Yes, almost line for line.** No knowledgebase code changed after the 2026-10-14 audit: `src/content/knowledgebase/articles.ts` and `src/app/knowledgebase/**` were last touched by commits that predate it (Phase 9D, #198, and earlier). The 79 articles are byte-for-byte what KB-1 audited.

| KB-1 item | Today | Verdict |
|---|---|---|
| §1.1 article store: one `articles.ts`, 5,265 lines, 79 articles, no status/role/plan/related/context metadata | Same | Unchanged |
| Audience model: "every article is public; `app` unused" | 41 are `public`, 38 are `both`, 0 are `app`. All 79 are publicly served (`both` is public). Wording in KB-1 is correct in effect; the split is 41/38 | Unchanged (refinement) |
| Search: client-side weighted scoring in `KnowledgebaseSearch.tsx` | Same | Unchanged |
| Article page: "More articles" is always the first three in the file | Same (`[slug]/page.tsx:164-166`) | Unchanged |
| §1.2 renderer defects: 145 numbered steps, 24 `###`, 1 table, 2 links; no images, callouts, inline code | Recounted today: 145 numbered lines, 24 `###` headings, 4 lines starting with `\|` (one table), 2 links. Renderer is unchanged | Unchanged |
| AI assistant: public server action, OpenAI Responses API, gated only by `AI_FEATURES_ENABLED` + `OPENAI_API_KEY`, no rate limit | Same. `ai-actions.ts` still does not import `src/lib/security/rate-limit.ts` and has no bot protection. The PROD value of `AI_FEATURES_ENABLED` is still unverified | **Finding still holds** (needs separate validation, D3) |
| `/app/help` static landing; sidebar "Knowledgebase" navigates out of the app (`app/layout.tsx:550, 760, 908`) | Same | Unchanged |
| Welcome-email deep links | Same 7 article slugs plus `/knowledgebase` (`notifications/dispatch.ts:365-372`); test `welcomeEmail.br3c.test.ts` pins them | Unchanged. Slugs remain a public contract |
| Sitemap includes all articles (`sitemap.ts:203-210`) | Same | Unchanged |
| Guides: two ARIA PDFs linked as literal markdown | Same | Unchanged |
| Tests: no content-integrity tests; vocabulary test reads `articles.ts` as text | Same. `vocabulary.br4c.test.ts:55-60` asserts on the `articles.ts` source text and **must be updated by the migration** | Unchanged (migration impact noted) |

## 2. What changed since 2026-10-14 that touches the knowledgebase

| Change | Source | KB impact |
|---|---|---|
| Student mobile app now has Settings links to the public Help Center (`/knowledgebase`), Security and DPA | `mobile/student/src/components/LegalLinks.tsx` (`help: "/knowledgebase"`), #542, 2026-11-15 | A new external consumer of the **public** `/knowledgebase` route. It links only the index, not slugs, so no slug contract is added. The route and its public behavior must stay stable. Supports D4 later (student portal Help) |
| Business (staff) app and Student app exist as separate mobile apps | `mobile/business`, `mobile/student` | No KB article describes either. Public claims must not describe them as released unless the release state is confirmed. Any future mobile Help links need KB-4 context keys, not new slugs |
| Staff API / mobile staff features: client lookup, class attendance, private-lesson check-in with credit choice, lead search/enrol | #453, #722, #741 | New product behavior with no article. Candidates for KB-2C. Nothing here makes an existing article wrong |
| Student App redesign, Past events on Tickets | #456, #720 | Same: new student-facing behavior, undocumented |
| Organizer Suite entitlement enforced on every organizer-event purchase path, including in-person and Terminal sales | #363, #380 (D7) | **Reinforces** KB-1 findings #18, #31, #26 (plan prerequisite). Does not contradict them |
| Atomic staff mark-paid (no duplicate payments) | #396 | Applies to event registration payments; relevant to #56, no wrong claim |
| Marketing M-0: unsubscribe route, `List-Unsubscribe` link builder, send-compliance tests and a suppression-lookup fail-closed guard are in code | `lib/marketing/compliance/unsubscribeLinks.ts`, `api/email/unsubscribe/[token]`, `marketing/campaigns/__tests__/sendCompliance.m0.test.ts`, `actions.ts:222-227` | **Possible change to KB-1 §2.7 row "Unsubscribe suppression"**: the code KB-1 described as missing now exists on main. Whether it is **released to PROD** is not provable from the repository. Do not rewrite #37/#38 until the release state is confirmed (see §3) |
| Twilio TW-4F (many PRs), SMS price monitor | `lib/sms/**` | SMS sending is still gated. Nothing in the repo shows a studio is activated. Row stays "SMS not active" until the owner confirms an activation |
| Governance: CODEOWNERS now gates only sensitive paths | #457 | KB content under `src/content/**` is routine and merges on green CI |

Not re-examined: roadmap/Current State text. `DanceFlow_Current_State.md` still reads as of mid-October, so it cannot confirm any release after that date.

## 3. §2.7 harmful-claim list re-verified

Legend: **Holds** = still wrong or unverifiable in the repo; **Re-check** = repo evidence moved, owner/release confirmation needed before editing; **Moot** = no longer applicable.

| §2.7 claim | Articles | Result today | Evidence |
|---|---|---|---|
| Duplicate check-in protection | 19, 65 | **Holds.** Web check-in still only warns `already_checked_in` | `events/[id]/check-in/page.tsx:269`, `registrations/actions.ts:1403,1626`. No CI-B change in `git log` for these paths. The claim is still unshipped on web. (Business-app private-lesson check-in #722 is a different flow) |
| SMS texting works | 49, 50, 62, 63, 77, 78 | **Holds** unless the owner confirms an activated studio | No activation evidence in repo. TW-4F work is dark/gated |
| Unsubscribe suppression and compliance | 37, 38 | **Re-check.** M-0 compliance code now exists on main | See §2. A correction written now could be wrong in either direction. Needs release state |
| Student app features available | 1, 69 | **Re-check.** The Student app has progressed a lot (#438, #456, #542), but store release status is unknown to this repo | Needs the owner's release state before any statement either way |
| Security overclaims | 70 | **Holds.** Login rate limiting is still in-memory per instance; nothing in this task re-verified the other two open items | `lib/security/rate-limit.ts` unchanged in scope |
| Competitor registration available | 13, 34 | **Holds** (the `COMPETITION_REGISTRATION` gate still exists in the checkout and release API routes under `api/events/[slug]/competition/`; the PROD flag value is not verifiable here) | Confirm flag state before editing |
| Nonexistent UI labels | 59, 61, 4, 7, 8, 12, 41-43 | **Holds** (UI code for these screens unchanged in the KB's cited files; `/app/sell` Quick Charge exists, `Quick Sale & Payment` still absent) | `sales/new` redirects to `/app/sell`; sell forms present |
| Independent instructors can record expenses | 29 | **Holds** (no relevant change found; not re-traced line by line) | `expenses/page.tsx` last changed in #42 and the Sell polish commit |
| Intro request approval gap | 11, 41, 42 | **Holds**: `/app/schedule/requests` still exists with `actions.ts` and `page.tsx`; KB-1's "no UI caller" claim was not re-traced in this pass | Re-trace before relying on it |
| Engineering finding 1: calendar feed URL | 22 | **Still present.** `events/page.tsx:845` emits `/studios/{slug}/events.ics`; the route directory is still `studios/[studioSlug]/event.ics`; no rewrite in `next.config.ts` or `vercel.json` | Needs engineering validation (may 404) |
| Engineering finding 4: unauthenticated, unthrottled AI assistant | n/a | **Still present** | `ai-actions.ts` has no rate-limit or bot check |
| New corrections created since 10-14 | n/a | None identified from the repo alone. New undocumented features are coverage gaps (KB-2C), not new wrong claims | Section 2 |

Net: **no §2.7 item became moot**, three need release-state confirmation from the owner before any wording is changed (unsubscribe/M-0, student app, competition flag), and the engineering findings 1 and 4 still stand.

## 4. Delta table (summary)

| Area | KB-1 said | Now | Action |
|---|---|---|---|
| KB code | 79 articles, one TS file | Identical | KB-2B proceeds as planned |
| Renderer defects | 145 / 24 / 1 table / 2 links | Identical | Fixed by KB-2B renderer PR |
| Audience split | all public | 41 public, 38 both, 0 app | Migrate as `visibility: public` for all |
| Public `/knowledgebase` consumers | web only | + Student app Settings Help link (#542) | Route and index behavior must stay identical |
| Welcome-email slugs | 7 | 7 (unchanged) | Link-integrity test added |
| Harmful claims | 9 groups | All hold or need release confirmation | KB-2A needs separate authorization |
| M-0 | unreleased | Code on main; release state unknown | Owner/release confirmation |
| AI assistant rate limit | missing | Still missing | D3 decision + separate validation |
| Calendar feed URL mismatch | possible | Still present | Engineering validation |
