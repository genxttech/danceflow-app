# KB-1 — Knowledgebase Audit and Contextual Help Center Plan

| | |
|---|---|
| **Status** | **ACCEPTED by the owner as the preliminary baseline (2026-10-13).** The Knowledgebase modernization direction is owner-approved. Implementation is **not** authorized: every KB-2A … KB-5 step needs its own authorization. Open product questions D1–D7 (§9) are **not decided** |
| **Date** | 2026-10-13 |
| **Audited code** | `origin/main` `858e74eb` (docs-only on top of `24a37a15`). Current State records `24a37a15` as the source of live `dpl_5BjsJaSPqn1qA3D4fCDijZbRNqqK` (R) |
| **Production facts used** | Only those documented in `docs/roadmap/DanceFlow_Current_State.md` and Master Roadmap v2.22 [Release holds and gates](../roadmap/DanceFlow_Master_Roadmap.md#release-holds-and-gates-v222) (R): public Competition registration flag OFF; SMS fail-closed for every studio (no `studio_sms_registrations` row in PROD); Marketing M-0 not released; CI-B and CI-D not released; the event cart is card-only |
| **Not done** | No code, no article edits, no SQL, no PROD reads, no running application, no authenticated production smoke (this follows the standing production-read rule) |
| **Roadmap home** | Phase 17, as a 17-I track: "Contextual Help Center & Knowledgebase Modernization" (KB-1 … KB-5), recorded in roadmap v2.23. See §10 |

**Evidence labels used throughout this document:**
- **(Repo)** repository inspection: established by reading the code at `858e74eb`. It shows what the deployed code *does*, but it is **not** runtime-verified production behavior.
- **(R)** taken from the canonical roadmap or Current State, including the documented production facts above.
- **(A)** assumption, or a production environment value or production data that could not be verified (for example `AI_FEATURES_ENABLED`, `WAVE_POSTING_ENABLED`, Google OAuth configuration, per-studio settings, whether any studio has the Organizer Suite).
- **Verified production behavior:** none. This audit made no production observations. The "Avail" column in §2 is therefore a **repository-plus-roadmap inference**: Released means the code path exists without a flag at the deploy source and no documented hold applies; Gated names the plan, add-on or env flag that controls it (the PROD value is (A) unless the roadmap states it); Held cites the documented hold (R). Every Avail value must be re-confirmed against the live deploy during KB-2 before an article is published.

---

## Executive summary

1. **The roadmap does not include the initiative (R).** v2.22 mentions the knowledgebase in only three places:
   - TW-4 slice 4E's "knowledgebase article" (Phase 2, line ~260).
   - Phase 15's ARIA guidance bullet (line ~1243).
   - A BR-4 vocabulary note (line ~349).

   There are no requirements for a KB audit, content modernization, an in-app Help panel, context mapping or documentation governance. The v2.23 addition described in §10 fills that gap.
2. **The knowledgebase is one hardcoded TypeScript file (Repo).** `src/content/knowledgebase/articles.ts` has 5,265 lines and 79 articles. It is rendered at the public `/knowledgebase`. Changing any article requires an application deploy. Content was last updated substantively on 2026-07-29 (`0ef82f6a`). Since then the following shipped: Documents Center (Phase 8), Payroll Prep v1 (Phase 9), the Group Class series work (GC-S1C/S1D/3.x), launch-audit auth hardening, refund reconciliation, PAY-WH-1, Competition OS slices, the Sell/Quick Charge consolidation and the self-service requests queue.
3. **Accuracy (Repo).**

   | Primary rating | Count | Share |
   |---|---|---|
   | Current and accurate | 6 | 8% |
   | Requires updates | 65 | 82% |
   | Obsolete or superseded | 1 | 1% |
   | Duplicate or overlapping | 6 | 8% |
   | Wrong for role | 1 | 1% |

   Many articles have more than one problem: another 34 overlap other articles secondarily, and article 73 is functionally superseded although rated "requires updates". **22 articles are P1.** Several make claims that are wrong and harmful today:
   - Duplicate check-in protection, which CI-B has not shipped (R; the code only warns, Repo).
   - SMS described as working, although it is fail-closed in PROD (R).
   - Marketing unsubscribe behavior described ahead of M-0.
   - An unreleased student app presented as available.
   - Labels that no longer exist: "Quick Sale & Payment", "Client Payments", "Studio Login", "Settings > Import".
4. **There is no in-app contextual help (Repo).** No `/app` page links to any article. The sidebar's "Knowledgebase" item navigates *out of the app* to the public marketing shell (`src/app/app/layout.tsx:549-550, 750-751, 898-899`), which abandons the current workflow. That is the opposite of the approved product direction.
5. **Coverage gaps are largest in the highest-frequency workflows (Repo).** There are no how-to articles for:
   - Booking or editing private lessons.
   - Group classes and attendance.
   - Selling packages.
   - The membership lifecycle: past-due, cancel and waive.
   - Refunds and reconciliation.
   - The Sell workspace.
   - Adding a client and using the client profile.
   - Studio booking policies.
   - Event payment exceptions and refunds.

   The missing-articles inventory (§3) proposes about 70 new articles.
6. **The audit surfaced four engineering findings outside the KB.** They come from repository inspection only. Each **requires separate validation**; none is a confirmed defect, and none is authorized implementation work. They are tracked in roadmap v2.23 (Preserved commitments register, section D) for triage:
   - **(Repo) Possible studio calendar feed URL mismatch.** The app emits `/studios/{slug}/events.ics` (`src/app/app/events/page.tsx:845`), but the route is `src/app/studios/[studioSlug]/event.ics`. No rewrite was found. This may 404; not checked at runtime.
   - **(Repo) Public intro booking requests appear to have no staff approve/decline UI.** `/app/schedule/requests` now redirects to `/app/schedule/self-service` (`schedule/requests/page.tsx:21`), which reads only `student_booking_action_requests`. `approveBookingRequestAction` and `declineBookingRequestAction` (`schedule/requests/actions.ts:514, 806`) have no UI caller. Leads only shows the request state.
   - **(Repo, not run) Organizer owner/admin may be redirected away from `/app/payments`.** `normalizeWorkspaceRole` maps owner and admin to `organizer_owner` and `organizer_admin` (`src/lib/auth/studio.ts:163-169`). `canViewPayments` (`src/lib/auth/permissions.ts:109-111`) does not include those roles, and `payments/page.tsx:148-149` redirects. That page is the target of the organizer "Ticket Sales & Payments" nav item and of the "Connect payouts" checklist task.
   - **(Repo) The public KB AI assistant appears unauthenticated and not rate-limited.** It calls OpenAI whenever `AI_FEATURES_ENABLED=true` (`src/app/knowledgebase/ai-actions.ts:177-200`). It does not use `src/lib/security/rate-limit.ts` and has no bot protection. The PROD value of `AI_FEATURES_ENABLED` is unverified (A).

---

## 1. Current knowledgebase implementation assessment

### 1.1 What exists (Repo)

| Component | File | What it does | Assessment |
|---|---|---|---|
| Article store | `src/content/knowledgebase/articles.ts` | 79 objects with `{slug,title,category,description,audience,content}`; markdown-ish `content` string | Single source exists, which is good. There is no status, owner, role, plan, flag, related-article or context metadata. Editing needs a deploy |
| Audience model | same, `KnowledgebaseAudience = "public" \| "app" \| "both"` | `getPublicKnowledgebaseArticles()` returns public and both | **Every article is public.** No article uses `"app"`, and `"app"` articles would 404 everywhere (`[slug]/page.tsx:150`). There is no signed-in-only content path |
| Index page | `src/app/knowledgebase/page.tsx` | Hero, search, category chips, AI assistant | Inside `PublicShell` (marketing chrome with a "Start Free Trial" CTA). It is reached from the app sidebar, so the user leaves the app |
| Search | `src/app/knowledgebase/KnowledgebaseSearch.tsx` | Client-side weighted keyword scoring over title, slug, category, description and content; category filter | Works, and is reusable for the panel. No synonyms. No ranking signal from page context. 26 categories, most with 1–6 articles |
| Article page | `src/app/knowledgebase/[slug]/page.tsx` | Static params, SEO metadata, JSON-LD, hand-rolled renderer | **Renderer is incomplete:** see 1.2. "More articles" is always the first three articles in the file, not related ones (`:162-164`) |
| AI assistant | `src/app/knowledgebase/ai-actions.ts`, `KnowledgebaseAIAssistant.tsx` | Keyword retrieval, then OpenAI Responses API (`gpt-4.1-mini` default), answering only from article excerpts | A useful pattern, but it is a **second AI support surface separate from ARIA**. It is public and not rate-limited (see the executive summary) |
| In-app Help page | `src/app/app/help/page.tsx` | Static landing: "Open Knowledgebase" and "Contact Support" links | No search, no articles, no context. Navigates away |
| Support form | `src/app/app/support/page.tsx` | `sendSupportRequestAction` | Keep. The panel should offer it as the escalation path |
| Sidebar | `src/app/app/layout.tsx:547-551, 748-752, 896-900`; `navUtils.ts:1778-1882` | "Help" goes to `/app/help`; "Knowledgebase" goes to `/knowledgebase` | Replace with a persistent Help control (KB-3) |
| Deep links | `src/lib/notifications/dispatch.ts:295-302` | The welcome email links to 7 article slugs | **These slugs are a public contract.** Retiring or renaming one needs a redirect |
| Sitemap / SEO | `src/app/sitemap.ts:167-170` | All articles are in the sitemap | Public SEO value is real. Keep public articles public |
| Guides | `public/guides/*.pdf` (2 ARIA PDFs) | Linked from articles 75 and 76 | The links render as literal markdown text |
| Tests | `src/app/__tests__/brandMetadata.br2a.test.ts`, `src/lib/public/__tests__/vocabulary.br4c.test.ts` (KB vocabulary), shell tests | Brand and vocabulary guards | No content-integrity tests: slugs, links, routes, labels |

### 1.2 Renderer defects (Repo)

`renderArticleContent` (`[slug]/page.tsx:17-110`) supports only `#`/`##` headings, `- ` bullets and `**bold**`. In the current content:

- **145 numbered steps** (`1. …`) render as separate paragraphs, so the step lists are not real ordered lists.
- **24 `###` headings** render as paragraphs that start with the literal text `###`. For example, article 4's troubleshooting section (`articles.ts:400-424`).
- **1 markdown table** (article 8, `articles.ts:733-736`) renders as raw pipe characters.
- **2 links** (articles 75 and 76) render as literal `[text](/guides/…pdf)`.
- There is no support for images, callouts (prerequisites, warnings), inline code or anchors.

There is no `dangerouslySetInnerHTML` (good). The safe React-element approach should be kept and extended.

### 1.3 Reuse vs modernize

| Reuse as is | Reuse with changes | Replace / build new |
|---|---|---|
| Support form; the slug namespace and public URLs; SEO metadata and JSON-LD; the safe element-based rendering approach; `PublicShell` for the public KB | Search scoring: extract it into a shared `src/lib/help/search.ts` used by the public page, the panel and future ARIA. The renderer: extract it into a shared component and add ordered lists, `###`, tables, links, callouts and images. Category list: consolidate it (§4). The AI assistant: apply the rate-limit helper now; fold it into ARIA later | Article storage format (one file per article with frontmatter metadata); status workflow; role, plan and flag filtering; context mapping; the in-app Help panel; related-article logic; redirects for retired slugs; content-integrity tests |

The public Knowledgebase is not rebuilt. It gets the shared renderer and loader, and keeps working throughout.

---

## 2. Existing article inventory and accuracy audit (all 79 published articles)

**Columns.**
- **Cls** (classification): 1 = Current and accurate, 2 = Requires updates, 3 = Obsolete or superseded, 4 = Duplicate or overlapping, 5 = Incorrect for the intended role or plan.
- **Avail** (availability inferred from repository inspection plus documented roadmap holds; not runtime-verified, see the evidence labels): **Rel** = Released. **Gated** = released, but needs a plan, add-on or env flag. **Part** = partially available. **Held** = held or not released.
- **Pri**: priority, P1 to P3.
- **Img**: Y means a screenshot would materially help. The KB has no images today, so every screenshot is new.
- **Placement**: the app route(s) where contextual Help should suggest the article (KB-4).
- **Evidence**: every discrepancy cites file:line in the production code baseline. All evidence below is (Repo) unless marked.
- **Common gaps** (shorthand):
  - **NAV**: no navigation path, or the wrong one.
  - **ROLE**: role prerequisite missing.
  - **PLAN**: plan prerequisite missing.

**Plan facts (Repo):**
- Ticketing, admin ticket sales, check-in, guest-coach slots and organizer contacts/campaigns need the Organizer plan or the Organizer Suite add-on. Without it, an event saves as a "Basic listing" and ticketing is stripped (`events/actions.ts:393-408`, `billing/plans.ts:287-297`).
- Documents and Marketing need Growth or above (`documents/page.tsx:946-948`, `campaigns/page.tsx:438`, `plans.ts:372`).
- Wave and report exports need Pro.

### 2.1 Getting Started, Discovery, Clients and Portal (articles 1–16)

| # | Slug | Category | Audience (actual) | Avail | Cls | Discrepancies (evidence) | Required updates | Pri | Img | Placement |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | what-is-danceflow | Getting Started | prospect | Part | 2,4 | Presents ticketing, QR check-in and waivers as included for every studio, but they need Organizer Suite (`billing/access.ts:622-633`). No plan tiers: Starter has no packages, memberships or payments (`plans.ts:60-75`). Omits Documents Center and Payroll Prep. Mobile-app claims are unverified (A). Overlaps #69 | Add a plan line. Point to #69 or merge with it. Qualify mobile claims | P2 | N | /knowledgebase only (also welcome email link) |
| 2 | getting-started-checklist-for-studios | Getting Started | owner | Rel | 2,4 | No email-confirmation step (`(auth)/signup/page.tsx:54-55`). "Settings > Import" doesn't exist; it is the "Import existing data" card on `/app/settings` (`settings/page.tsx:457-465`), owner/admin only. Public profile is "Public Profile Setup" (`layout.tsx:696`). Payouts are owner-only (`subscriptionAuthority.ts:10-16`). Guided `/app/onboarding` isn't mentioned. Overlaps #14 | Fix the paths, roles and plan per step. Add email confirmation and the onboarding guide | P1 | Y | /app, /app/onboarding (welcome email link) |
| 3 | using-partner-search | Discovery | dancer | Rel (web) | 2 | Moderation missing: published listings are `pending` (`account/partner-search/actions.ts:129-130`); only `approved` listings show (`lib/partnerSearch.ts:173-174`); ad, link or phone text forces a draft (`actions.ts:97,157-158`). The entry point is "Create a dancer profile" on `/discover/partners` (`discover/partners/page.tsx:160-164`). Block/report not documented | Add the review step, draft rules, profile source fields, and block/report | P1 | Y | /account/partner-search |
| 4 | importing-client-data-from-a-csv | Getting Started | owner/admin | Rel | 2,4 | Button labels are wrong: "Review Clients File" (`import/page.tsx:525`) and "Execute Client Import" (`[batchId]/page.tsx:152`). Email is optional; only first and last name are required (`actions.ts:1766-1771`). The `is_independent_instructor` column is never read. The Create Only mode isn't mentioned. `###` headings render literally. Overlaps #79 | Fix the labels, columns and modes. Add the owner/admin note. Hand off to #79 | P1 | Y | /app/settings/import |
| 5 | packages-vs-memberships | Sales & Revenue | owner, front desk | Gated (Growth, A: no code gate found) | 1 (minor) | Accurate credit types (`packages/new/page.tsx:145-147`). The sidebar now says "Package Templates" and "Membership Templates" (`navUtils.ts:191-201`) | Rename the nav labels. Add the plan tier and where Package Count Correction is | P3 | N | /app/packages, /app/memberships |
| 6 | independent-instructors-and-host-studio-rentals | Independent Instructors | independent instructor, host owner | Rel | 2 | Card is "Independent Instructor Portal Access" (`app/page.tsx:2994-3015`). The toggle is "Also book floor space at a host studio" (`AppointmentCreateForm.tsx:1286-1334`). No host-side setup steps | Real labels. Add host setup | P2 | Y | /app/schedule/new, /portal/[slug]/floor-space |
| 7 | billing-payments-and-payouts | Billing & Payments | owner; staff | Rel | 2 | Page is "Payment Ledger", not "Client Payments" (`payments/page.tsx:235`). The real filters are search, preset range, status, method and type (`:298-355`); there's no Source filter or custom range. Subscription is owner-only. No pointers to Take Payment, refunds or reconciliation (welcome email link) | Rename. Fix the filters, roles and pointers | P1 | Y | /app/payments, /app/settings/billing |
| 8 | client-portal-linking-invites-vs-existing-accounts | Clients & Portals | front desk, admin | Rel | 2,4 | Login options are "Studio" and "Student / Dancer" (`login/page.tsx:186,224`), not "Public Account / Client Portal" or "Studio Login". Linking requires the account to have verified that exact email, otherwise `portal_account_unverified` (`clients/[id]/actions.ts:649-653`, launch audit 1C). The tab is "Portal / Account" (`clients/[id]/page.tsx:551`). There is no "Save" step. The table renders raw. Overlaps #12, #53, #21 | Fix the labels. Add the verified-email rule. Merge #12 into it (welcome email link) | P1 | Y | /app/clients/[id]?tab=portal |
| 9 | making-your-studio-visible-in-public-discovery | Public Discovery & Leads | owner/admin | Rel | 2,4 | Toggle is "Show studio in public discovery" (`public-profile/page.tsx:205-212`). Unstated requirement: an `active`/`trialing` subscription (`discover/studios/page.tsx:136-142`). Owner/admin only. Overlaps #10, #28 (welcome email link) | Fix the label. Add the subscription rule. Merge with #28 | P1 | Y | /app/settings/public-profile |
| 10 | setting-up-your-public-studio-profile | Public Discovery & Leads | owner/admin | Rel | 2,4 | Page is "Public Presence & Booking" (`public-profile/page.tsx:167`). Inquiry fields are Headline, Button text, Supporting message, Brand color (`:515-522`). Image limits are missing (`:411-430`) (welcome email link) | Real labels and limits. Add slug, styles and offerings | P2 | Y | /app/settings/public-profile |
| 11 | setting-up-intro-lesson-requests | Public Discovery & Leads | owner/admin | Rel | 3 | Says the "Phase 2" intro settings are coming, but they shipped (`public-profile/page.tsx:534-550`). `/book/[slug]` creates a pending `booking_requests` row (`book/[studioSlug]/actions.ts:681-698`). **No staff approve UI for these requests was found** (engineering finding, needs validation; see the executive summary). Leads shows only the state (`leads/page.tsx:409-463`) (welcome email link) | Rewrite once product resolves the approval gap. Until then, describe the Leads follow-up path | P1 | Y | /app/settings/public-profile, /app/leads |
| 12 | troubleshooting-client-portal-invite-emails | Clients & Portals | front desk | Rel | 2,4,5 | "Use notify@idanceflow.com or another verified sender" is internal ops advice; studios cannot choose a sender (`lib/email/sender.ts:16`). Login labels are stale. No verified-email error | Remove the ops bullet. Merge into #8 | P2 | N | /app/clients/[id]?tab=portal |
| 13 | getting-started-with-organizer-workspace | Getting Started | organizer owner | Part | 2,4 | The body still says "organizer workspace". Pages are "Registration Hub" and "Event Check-In Hub" (`events/registrations/page.tsx:324`, `events/checkin/page.tsx:501`). Publishing modes are Internal only / Live by direct link / Public Discovery (`EventForm.tsx:135-171`). **Lists competitor registration, which is flag-OFF (R)** | Organizer Suite vocabulary and nav. Remove or qualify competition | P1 | Y | /app (organizer), /app/events/new |
| 14 | using-the-workspace-setup-checklist | Getting Started | owner | Rel | 1,4 | Tasks match (`app/page.tsx:1356-1405, 2807-2865`). Doesn't mention "Continue setup" opening `/app/onboarding` (`:661`) | Add one line. Consider merging with #2 | P3 | Y | /app |
| 15 | syncing-instructor-schedule-to-calendar | Scheduling | owner/admin, instructor | Rel | 2,4 | Only owner/admin can create the link ("Create calendar link", `instructors/page.tsx:70,237-252`). Regenerating replaces the URL. Cancelled lessons are excluded (`calendar/instructor/[token]/route.ts:205`). Overlaps #74 | Who creates the link and where. Merge with #74 | P2 | Y | /app/instructors |
| 16 | creating-multi-location-multi-date-events | Events | owner/admin, organizer | Rel | 2 | Enable it via Advanced settings with the checkbox "This event runs at multiple locations or on separate dates" (`EventForm.tsx:2755,2980-2985`). Field names differ. Sessions have no "Status" field | Add how to enable it. Fix the fields and roles | P2 | Y | /app/events/new, /app/events/[id]/edit |

### 2.2 Events, Scheduling, Reports and Portal (articles 17–32)

| # | Slug | Category | Audience | Avail | Cls | Discrepancies (evidence) | Required updates | Pri | Img | Placement |
|---|---|---|---|---|---|---|---|---|---|---|
| 17 | duplicating-an-event | Events | owner/admin, organizer | Rel | 2 | Says visibility is reused, but the copy is always draft, private, out of the directory and not featured (`events/actions.ts:2796-2800`). Named "… Copy". Guest coaches and competition setup are not copied (`:2830-2919`) | List what is and isn't copied | P2 | N | /app/events/[id] |
| 18 | selling-tickets-from-admin-side | Events | front desk, organizer staff | Gated (Organizer Suite) | 2 | Real methods are Cash, In-person card reader, Card collected outside DanceFlow, Check, Comp, Other (`SellTicketsForm.tsx:281-286`). No Venmo/Zelle. The amount is computed. There is no partial status (`sell-tickets/actions.ts:593`). PLAN (`navUtils.ts:658-680`) | Replace the method list. Add the plan and the "Sell Event Tickets" nav | P1 | Y | /app/events/sell-tickets |
| 19 | checking-in-event-attendees | Events | door staff | Part (CI-B held, R) | 2 | **"Duplicate check-in protection" is false today.** Check-in only warns `already_checked_in` (`events/[id]/check-in/page.tsx:269-274`). CI-B is an open hold (roadmap line ~159). Search and scanner are accurate (`:970-978`) | Remove the claim now. Add nav, plan and waiver status | P1 | Y | /app/events/checkin, /app/events/[id]/check-in |
| 20 | dashboard-alerts-and-announcements | Platform Updates | all users | Rel | 1 | Matches `platform_alerts` (`app/page.tsx:565-580, 1184-1230`). Alerts render only on `/app`, so the "portal_users" audience never shows in the portal | Optional: role targeting | P3 | N | /app |
| 21 | branded-portal-invite-emails | Client Portal | student, staff | Rel | 1 | Matches `portalInviteEmail.ts:19-29,47-52,86` | Optional cross-link to #32 | P3 | N | /app/clients/[id]?tab=portal |
| 22 | using-danceflow-events-on-your-website-calendar | Events | owner/admin, organizer | Part | 2 | **Possible studio feed URL mismatch** (engineering finding 1, needs validation). The card is "Add Events to Your Website" / "Calendar Feed URL / ICS". The feed needs studio discovery visibility and an active subscription (`studios/[studioSlug]/event.ics/route.ts:46-48,223`) | Validate the feed URL finding first, then fix the labels and requirements | P1 | Y | /app/events |
| 23 | using-client-account-credits-and-balances | Clients & Billing | owner/admin, front desk | Rel | 2 | The control is "Manage account ledger" in the "Account Balance" card. There are 10 entry types. Students see the balance on `/account`, not in the portal (`account/page.tsx:400-460`). Client Balances page and "Apply account credit" (`SellPackageForm.tsx:383`) not mentioned | Fix the labels, entry types and student location | P2 | Y | /app/clients/[id], /app/packages/client-balances |
| 24 | managing-daily-closeout-and-lessons-that-need-review | Scheduling | front desk, owner/admin | Rel | 2 | Says membership lessons are "Ready to close out", but the UI lists them under "May need review" (`schedule/page.tsx:609-611`). The real flow is "Review closeout details" and then "Mark Eligible Lessons Attended" | Fix the statement and labels. Add roles | P2 | Y | /app/schedule |
| 25 | choosing-the-right-lesson-billing-type | Scheduling | front desk | Rel | 2 | Labels match (`AppointmentCreateForm.tsx:1429-1432`). Omits the membership closeout review | One line plus a cross-link to #24 | P3 | N | /app/schedule/new |
| 26 | selling-guest-coach-private-lesson-slots | Events | owner/admin, organizer | Gated (Organizer Suite) | 2,4 | Without the suite, guest coaches are stripped on save (`events/actions.ts:393-408`). The slot inventory page isn't covered: offline booking, block/release, link regenerate (`private-lessons/page.tsx:534,603-646`). Overlaps #57 | Add the plan. Merge #57 into it | P2 | Y | /app/events/[id]/edit, /app/events/[id]/private-lessons |
| 27 | adding-an-event-schedule-or-agenda | Events | owner/admin, organizer | Rel | 1 | Matches "Optional Event Schedule" and "Add Schedule Item" (`EventForm.tsx:1499,1513`) | Optional exact labels | P3 | N | /app/events/[id]/edit |
| 28 | why-my-studio-or-events-do-not-appear-in-public-discovery | Public Discovery | owner/admin | Rel | 2,4 | Missing: past events drop out of discovery, the "published"/"open" status rule, the exact toggle name. Overlaps #9 | Merge into #9 as troubleshooting | P2 | N | /app/settings/public-profile |
| 29 | using-expenses-and-floor-fee-expense-tracking | Reports & Expenses | owner/admin | Rel | 5,2 | **Tells independent instructors to record expenses, but they are redirected** (`expenses/page.tsx:182-184`). Front desk is view-only (`:191-195`). Omits Payment Method, Related Event and recurring | Fix roles. Add fields | P2 | N | /app/expenses |
| 30 | understanding-basic-profit-and-loss-reports | Reports & Expenses | owner/admin | Rel | 2 | There is no standalone P&L report; it is the profit preview under "Expenses & profitability" (`RevenueExpenseWorkspace.tsx:106-112`). Instructor pay is included (`reports/page.tsx:2601-2606`). Nav is "Accounting & Reports" | Rename. Add instructor pay and event settlement | P2 | Y | /app/reports |
| 31 | managing-event-tickets-and-registrations | Events | owner/admin, organizer | Gated | 4,2 | Repeats #18 and #19. PLAN ("Basic listing" without the suite). Omits card-only checkout and whole-payment refunds (CI-D, R) | Turn into a hub article | P2 | N | /app/events/tickets, /app/events/registrations |
| 32 | using-the-student-portal | Client Portal | student | Rel | 2,4 | Stale scope. The portal now has Schedule, self-service Requests, Documents to sign, Membership, ticket QR codes and Journey (`portal/[studioSlug]/page.tsx:1410-1515`). The chooser is `/portal/choose`. Balance is on `/account` | Rewrite as the student portal hub | P2 | Y | /portal/[slug] (future portal panel) |

### 2.3 Security, Events, Marketing, Booking and Staff (articles 33–48)

| # | Slug | Category | Audience | Avail | Cls | Discrepancies (evidence) | Required updates | Pri | Img | Placement |
|---|---|---|---|---|---|---|---|---|---|---|
| 33 | privacy-security-and-student-data-basics | Security & Privacy | owner/admin | Rel | 4 | Generic but not wrong. Omits shipped controls: email confirmation for invites (`studio-invites/[token]/page.tsx:27,132`), private client photos with 600-second signed URLs (`clientPhotoAccess.ts:5-19`), export overrides (`settings/team/page.tsx:66-72`). Overlaps #70 | Merge with #70 | P3 | N | /app/settings/team |
| 34 | using-early-bird-ticket-pricing | Events | organizer | Rel (CI-A) | 2 | Accurate core (`TicketTypeForm.tsx:183-213`; server pricing at `cart/checkout/route.ts:784`). Missing: cutoff in the event's time zone, must be lower than the regular price (`ticketPricing.ts:10-13`), `ticket_price_changed` refusal. Competition example misleads (flag OFF) | Add the rules. Drop the competition example | P3 | Y | /app/events/[id]/tickets |
| 35 | understanding-public-event-pages-and-the-event-cart | Events | buyer, organizer | Rel | 2 | Tabs and cart accurate (`events/[slug]/page.tsx:1629-1634, 2482-2485`). Doesn't say checkout is card-only. Competition entry is a separate, gated flow | Add card-only. Note competition entry is unavailable | P3 | Y | /app/events/[id] |
| 36 | turning-event-registrations-into-crm-leads | Public Discovery & Leads | owner, front desk | Rel | 2,4 | Studio flow accurate (`settlementSideEffects.ts:139-231`). "Organizer workflow in a later version" is stale: organizer contacts are live | Link to #67 | P2 | N | /app/leads |
| 37 | creating-a-marketing-campaign | Marketing | owner/admin, front desk | Gated (Growth); M-0 not released (R) | 2 | Missing steps: "Prepare Send List" snapshot (`marketing/campaigns/[id]/page.tsx:1233-1292`), mailing-address footer requirement (`actions.ts:1103-1110`), confirm checkbox (`page.tsx:1438`), allowance, 500-per-action batches (`actions.ts:38`). **Suppression happens only when the list is prepared. There is no send-time re-check and no List-Unsubscribe header** (`actions.ts:1110-1116,1187-1194`) | Describe current behavior exactly: refresh the list before sending. Promise nothing from M-0. Update again after M-0 releases | P1 | Y | /app/marketing/campaigns, /app/marketing/campaigns/[id] |
| 38 | understanding-marketing-audiences | Marketing | owner/admin, front desk | Gated (Growth) | 2,4 | Real audience labels are at `marketing/campaigns/page.tsx:47-85`. The whole feature needs Growth. Templates aren't mentioned (`:94-155`). Overlaps #37 | Exact labels. Merge into #37 or link to it | P2 | Y | /app/marketing/campaigns |
| 39 | setting-up-team-members-and-front-desk-access | Getting Started | owner | Rel | 2 | Says "When team invitations are available", but they exist at "Team & Permissions", owner-only nav (`layout.tsx:733-736`). Roles are Studio Manager, Front Desk, Instructor (`settings/team/page.tsx:56-60`). There is no "Event staff" role. Omits export overrides, seat limits and invitee email confirmation | Rewrite with a roles table | P2 | Y | /app/settings/team |
| 40 | using-share-buttons-for-studios-and-events | Public Discovery & Leads | public | Rel | 1 | Confirmed (`ShareButton.tsx:48-66`) | — | P3 | N | /app/settings/public-profile |
| 41 | managing-booking-requests | Booking Requests | owner/admin, front desk | Part | 2 | Nav is "Self-service Requests"; page is "Schedule Requests" (`schedule/self-service/page.tsx:287-290`). It reads only `student_booking_action_requests` (`:120-172`), so public intro requests never appear. Tabs are pending/executed/declined/failed (`:277-280`), not Approved/All | Rewrite around the real queue. Explain where intro requests surface | P1 | Y | /app/schedule/self-service |
| 42 | approving-or-declining-booking-requests | Booking Requests | staff | Part | 2,4 | Approve and Decline exist (`self-service/page.tsx:360-380`), but the result is "executed", not "approved". Covers reschedule and cancel too. The claimed client email wasn't found in code (A: DB triggers). Overlaps #41 | Merge into #41 | P1 | Y | /app/schedule/self-service |
| 43 | portal-schedule-requests | Booking Requests | staff, student | Gated (per-studio setting) | 2 | **"Not instant booking" is wrong:** the modes are Disabled / Request only / Approval required / Instant (`SettingsForm.tsx:34,72`; `SelfServiceBookingPanel.tsx:89-92`). Clients pick generated slots (`:158`). Reschedule and cancel requests not covered | Rewrite: enabling, modes, slots, cutoffs | P1 | Y | /app/settings, /app/schedule/self-service |
| 44 | booking-availability-rules | Booking Requests | owner/admin | Rel | 2 | No NAV. The rules live in three places: `/app/schedule/self-service/availability` (`page.tsx:321-492`), Settings (`SettingsForm.tsx:75-83`), Public Presence. Says booking never auto-creates appointments, but Instant mode does | Add the three locations and fields | P2 | Y | /app/schedule/self-service/availability |
| 45 | client-photo-verification | Clients & CRM | front desk | Rel | 2,4 | Upload confirmed (`ClientCreateForm.tsx:170-186`). "Future QR" is stale: the identity page exists (`client-identity/[token]/page.tsx:199-276`). Photos are private (signed URLs). Overlaps #68 | Merge with #68 | P2 | Y | /app/clients/new, /app/clients/[id]/edit |
| 46 | staff-photos-and-credentials | Public Profile | owner/admin | Rel | 2,4 | **Photo upload is on Edit only**; Create has no file input (`instructors/new/page.tsx:263-281`; `InstructorEditForm.tsx:320-321`). Public toggle not mentioned (`:274-291`) | Merge #46–48 into one article | P2 | Y | /app/instructors/[id]/edit |
| 47 | staff-credential-verification | Public Profile | owner/admin | Rel | 2,4 | DanceFlow platform staff review credentials (`/platform/credentials`), not the studio. "Uploaded proof document" does not exist; there is only "Proof / Reference URL" (`InstructorEditForm.tsx:532`) | Merge | P3 | Y | /app/instructors/[id]/edit |
| 48 | verified-staff-credentials-on-public-pages | Public Profile | public | Rel | 4 | Accurate (`studios/[studioSlug]/page.tsx:494-521`). Instructor visibility prerequisite missing | Merge | P3 | N | /app/instructors/[id]/edit |

### 2.4 Communication, Documents, Access, Payments and ARIA (articles 49–64)

| # | Slug | Category | Audience | Avail | Cls | Discrepancies (evidence) | Required updates | Pri | Img | Placement |
|---|---|---|---|---|---|---|---|---|---|---|
| 49 | sms-consent-and-message-history | Communication | owner/admin, front desk | Part (consent yes; **sending fail-closed**, R) | 2 | The tab is "Communication", not "Marketing" (`clients/[id]/page.tsx:547`). Status badges are at `lib/sms/compliance.ts:131-136`. STOP can only be lifted by START (`:108,140`). Edit roles (`permissions.ts:150`). The UI shows "Text messaging is not active yet" (`ClientSmsConsentCard.tsx:66-73`) | Say texting isn't active yet. Document the badges and STOP/START | P1 | Y | /app/clients/[id] (Communication tab) |
| 50 | sms-opt-in-for-studios | Communication | owner | Held (sending) | 2,4 | Implies studios text clients today. Omits START resubscribe and the required disclosure text (`compliance.ts:22,193-197`). Overlaps #49 | Merge into #49. The TW-4 4E article replaces it later | P2 | N | /app/clients/[id] |
| 51 | documents-and-e-signatures | Documents & E-Signatures | owner/admin, front desk | Gated (Growth); Rel (Phase 8) | 2,4 | Predates Phase 8. Missing: "Create from template" vs "Upload PDF for signature" (`documents/page.tsx:1249,1272`), field placement (`:1502`), assignment groups (`:171-175`), due dates, reminders, waive/void, revise/resend, revoke, signed PDF and certificate (`:1577-1578`). Instructors blocked (`:947-957`) | Rewrite as the Documents Center guide | P1 | Y | /app/documents, /app/documents/sign/[envelopeId]/edit |
| 52 | finding-signed-documents-and-waivers | Documents & E-Signatures | staff | Rel | 2,4 | Mostly accurate (`clients/[id]/page.tsx:3866-3905`; registration detail `:935`). Missing: the "What needs attention" queue (`documents/page.tsx:1320-1328`), certificate links, waived/void states | Add the queue and statuses | P2 | Y | /app/clients/[id]?tab=documents, /app/events/[id]/registrations/[registrationId] |
| 53 | student-portal-access-and-sign-in-links | Client Portal | staff, student | Rel | 2,4 | Button is "Send Portal Invite" on the "Portal / Account" tab (`clients/[id]/page.tsx:551,5509`). Login button is "Email me a secure portal link" (`login/page.tsx:315`). Verified-email requirement missing. The optional app password setup (`:384-388`) isn't mentioned | Fix the labels. Add verified email | P2 | Y | /app/clients/[id]?tab=portal |
| 54 | resetting-your-password | Account Access | studio and organizer users | Rel | 2 | Flow matches (`login/page.tsx:472,491`; `reset-password/page.tsx:83-136`), **but the reset box is hidden for student/portal logins** (`login/page.tsx:467`). The 8-character minimum isn't mentioned | Scope to staff accounts. Point students to the secure link | P2 | N | /login, /app/account |
| 55 | resend-event-ticket-confirmation | Events & Ticketing | event staff | Rel | 2,4 | Buttons are "Resend ticket confirmation" or "Resend full checkout confirmation" (`registrations/[registrationId]/page.tsx:742`). Requires confirmed and paid (`:303-306`). Resend re-issues missing QR codes (`:750`) | Exact labels and prerequisites | P2 | Y | /app/events/[id]/registrations/[registrationId] |
| 56 | review-event-registration-payment-status | Events & Ticketing | event staff | Rel | 2 | Buckets and sources match (`registrations/page.tsx:278-294,1478-1511`). Missing: the "Payments needing review" exceptions panel (`PaymentExceptionsPanel.tsx:73`), whole-payment refunds, refund block for order-backed registrations | Add the exceptions panel and refund limits | P2 | Y | /app/events/[id]/registrations |
| 57 | manage-guest-coach-lesson-slots | Events & Ticketing | event staff | Rel | 2,4 | No "Unblock"; it is "Release Slot" (`private-lessons/page.tsx:1005`). Block reason is free text (`:968`). "Book Offline" payment states not covered (`:868-871`) | Merge into #26 | P2 | Y | /app/events/[id]/private-lessons |
| 58 | in-person-payment-options-and-reader-requirements | Billing & Payments | owner | Rel | 4,2 | Calls Quick Charge future, but it is live under Sell (`UnifiedSalesForm.tsx:264-300`; `QuickChargeClient.tsx:30-33`). The "Record external card" fallback isn't mentioned (`:349-353`). Studio address prerequisite (`settings/billing/page.tsx:413`). Repeats #59–61 | Make it the single overview | P2 | N | /app/settings/billing, /app/sell |
| 59 | taking-in-person-payments-with-tap-to-pay | Billing & Payments | front desk | Rel | 2 | "Quick Sale & Payment" doesn't exist; `/app/sales/new` redirects to `/app/sell`. Ad hoc payments are "Take Payment" → "Card already collected" (`TakePaymentForm.tsx:294`). The "In-person or Tap to Pay" channel field doesn't exist | Real labels | P1 | Y | /app/sell, /app/payments/take |
| 60 | registering-a-stripe-card-reader | Billing & Payments | owner only | Rel | 2 | Billing & Payouts is owner-only (`layout.tsx:506,738-742`). Real labels: "In-person payments & card readers", Create Location, Reader label, Reader registration code, Register Reader, Refresh Status (`settings/billing/page.tsx:531-700`). Needs a studio address and Stripe approval (`:411-413`) | Fix the role and labels | P2 | Y | /app/settings/billing |
| 61 | collecting-in-person-card-payments-in-danceflow | Billing & Payments | owner/admin, front desk | Rel | 2,4 | Option is "Card reader" → "Continue to card reader" (`TakePaymentForm.tsx:385,450`). Terminal buttons are "Refresh status" and "Cancel attempt" (`payments/terminal/[paymentId]/page.tsx:389,398`). Quick Charge is written as future | Real labels. Quick Charge is live | P1 | Y | /app/payments/take, /app/payments/terminal/[paymentId] |
| 62 | using-aria-revenue-insights | AI & Automations | owner/admin | Rel | 4,2 | The sidebar says "Consult with ARIA" (`navUtils.ts:922`). The hub is limited to canViewReports roles (`aria/page.tsx:391`). Goal types are at `aria/goals/page.tsx:125-133`. Repeats #63's safety lists word for word | Retitle. Drop the duplicated sections | P2 | Y | /app/aria, /app/aria/goals |
| 63 | using-automations-for-client-follow-up | AI & Automations | owner/admin | Rel | 4 | Content accurate (`automation-catalog.ts:46-106`; `automations/page.tsx:158-224`). Slug doesn't match content. Sidebar is "Automations". SMS delivery unavailable (R) | Merge with #77. Redirect the slug | P3 | Y | /app/automations |
| 64 | event-profitability-and-closeout-review | Events & Ticketing | event staff, organizer | Rel | 2 | Metrics match (`events/[id]/page.tsx:1179-1203`). Missing: readiness checklist, statuses (Open / Ready to settle / Settled / Reopened), reopen reason, locking, history, export/PDF (`:1526,1601,1744`) | Add the settlement flow | P3 | Y | /app/events/[id] (closeout) |

### 2.5 Check-in, Documents, Platform, Reports, Payroll, ARIA and Migration (articles 65–79)

| # | Slug | Category | Audience | Avail | Cls | Discrepancies (evidence) | Required updates | Pri | Img | Placement |
|---|---|---|---|---|---|---|---|---|---|---|
| 65 | using-event-qr-tickets-and-scan-check-in | Events & Ticketing | door staff | Part (CI-B held) | 2,4 | There is no "scan mode" choice; scanning uses the sticky scan panel (`events/checkin/page.tsx:500-506`). **"Duplicate check-in protection" overstated** (`events/[id]/check-in/page.tsx:269-274`; CI-B hold). Overlaps #19 | Soften now. Merge with #19 | P2 | Y | /app/events/[id]/check-in |
| 66 | using-event-waivers-and-e-signatures | Documents & E-Signatures | staff, organizer | Rel | 2,4 | Predates Phase 8. Event requirements are set in Documents > Template library (`documents/page.tsx:1599`). Check-in status comes from signed assignments (`check-in/page.tsx:609-615`) | Merge into the Documents cluster | P2 | Y | /app/documents, /app/events/[id]/check-in |
| 67 | organizer-contacts-and-event-audiences | Marketing | organizer only | Gated (Organizer Suite) | 2 | Audience "both" is wrong; studio-only users are redirected (`organizer-contacts/page.tsx:222-227`). No NAV. Organizer Campaigns not covered. Consent caveat missing (M-0) | Retarget to organizers. Add campaigns | P3 | N | /app/organizer-contacts |
| 68 | using-client-identity-and-qr-verification | Client Portal | front desk, instructor | Rel | 2 | "Future QR check-in" is stale: the page checks clients in to today's appointments (`client-identity/[token]/page.tsx:490`). **It claims package balances and notes, but the page loads neither** (`:46-51`). Wrong category (staff tool) | Fix the claims. Recategorize | P2 | Y | /app/client-identity/[token] |
| 69 | current-danceflow-capabilities | Getting Started | prospect | Part | 2 | **Public overclaims:** presents the student app (native payments, wallet, self-service booking) as available, but it is not store-released (R, roadmap line ~112). Wave posting is env-gated (`settings/integrations/wave/page.tsx:142`; A). "Integration Hub" is roadmap language. Omits Phase 8/9 | Remove or qualify the overclaims. Add released items. Owner should review (public claims rule) | P1 | N | /knowledgebase only |
| 70 | how-danceflow-protects-your-data | Security & Privacy | prospect | Part | 2,4 | "Safer error messages": raw RPC error text is still an open item (R, roadmap line ~1677). Login rate limiting is in-memory per instance (`lib/security/rate-limit.ts:24-34`). Oversell protection (EVENT-CAP-1) is unverified (R, line ~1678). Headers, honeypot and SMS secret are verified | Soften the three claims. Merge #33. Owner should review | P1 | N | /knowledgebase only |
| 71 | setting-up-accountant-report-delivery | Reports & Expenses | owner/admin | Rel | 2 | Link is "Accountant and report delivery"; h1 is "Accountant setup" (`settings/page.tsx:410`; `accountant/page.tsx:46`). "Accounting activity", not "ledger". **No payroll report option** (`AccountantForm.tsx:25-31`) | Fix the report names. Add the role | P2 | Y | /app/settings/accountant |
| 72 | sending-secure-reports-to-your-accountant | Reports & Expenses | owner/admin | Rel | 2,4 | No "Downloaded" status; there is a download count (`20260715_accountant_delivery_scheduling_v1.sql:9`). 7-day expiry not stated (`deliveries.ts:89`). "Cancel access" not covered (`accountant/page.tsx:153`) | Merge with #71 | P3 | Y | /app/settings/accountant |
| 73 | preparing-instructor-payroll | Payroll & Instructor Pay | owner/admin | Rel | 2 (largely superseded) | Predates Payroll Prep v1. Missing: stage earnings, periods, "Assign eligible earnings", batches, "Approve batch", owner-only "Mark batch paid", "Export batch CSV" (`instructor-pay/page.tsx:595-620`; `permissions.ts:134-138`). "Event/coaching compensation" is unsupported (`:571`) | Rewrite around the Phase 9 workflow | P1 | Y | /app/instructor-pay, /app/instructor-pay/periods/[id] |
| 74 | connecting-google-calendar | Scheduling | owner/admin, instructor | Gated (Google OAuth env; A) | 2,4 | No NAV. Studio page owner/admin (`google-calendar/page.tsx:114`). "Sync next 90 days" (`:267`). Personal sync every 30 minutes; disconnect removes entries (`personal/page.tsx:64,107`). Overlaps #15 | Merge #15 into it | P3 | Y | /app/settings/integrations/google-calendar(/personal) |
| 75 | aria-operations-quick-start | AI & Automations | owner/admin | Part (digest delivery unverified, R) | 2 | Sidebar "ARIA Operations" (`navUtils.ts:985`). "Suggestion/Draft mode" is now "Notify me only" / "Prepare for my review" (`automations/page.tsx:140-142`). Default packs can still email (`aria/operations/page.tsx:3129`). PDF link renders literally | Fix the labels and defaults. Fix the link rendering | P2 | Y | /app/aria/operations |
| 76 | aria-operations-expanded-setup | AI & Automations | owner/admin | Part | 2 | Ignores the Automation Center pack model. Digests default ON (`aria/operations/page.tsx:2018-2019`). PDF link renders literally | Reconcile with the packs | P2 | N | /app/aria/operations |
| 77 | aria-automation-center-and-operations | AI & Automations | owner/admin | Part | 2 | Concept matches (`aria/operations/page.tsx:3686`). Its Front Desk example implies execution, but real execution is email-only and limited to a 5-rule allowlist (R, roadmap line ~1235) | Qualify execution scope. Merge #63 into it | P2 | Y | /app/automations |
| 78 | aria-autonomy-and-safety | AI & Automations | owner/admin | Part | 2 | Levels and ceilings match (`automations/page.tsx:204-222`). "Permission to send email or SMS": SMS is fail-closed; execution is email-only (R) | One-line correction | P2 | N | /app/automations |
| 79 | moving-to-danceflow-with-the-migration-center | Getting Started | owner/admin | Part (not pilot-validated, R) | 2,4 | "Settings > Import / Migration Center" doesn't exist; it is "Import existing data", and the page is "DanceFlow Import Center" (`settings/page.tsx:458-462`; `import/page.tsx:360`). The flow is Upload → Review → Import → Fix (`:371-381`). No field-mapping UI found | Fix the nav and flow. Absorb #4 | P2 | Y | /app/settings/import |

### 2.6 Summary counts

| Classification (primary) | Count | Articles |
|---|---|---|
| 1 Current and accurate (minor polish at most) | 6 | 5, 14, 20, 21, 27, 40 |
| 2 Requires updates | 65 | All others not listed in this table (73 is functionally superseded and gets a rewrite) |
| 3 Obsolete or superseded | 1 | 11 (rewrite) |
| 4 Duplicate or overlapping (primary) | 6 | 31, 33, 48, 58, 62, 63 (another 34 articles overlap secondarily; see the clusters in §4.3) |
| 5 Incorrect for role or plan | 1 | 29 (plus a role component in 12, 54 and 67) |

**Priority:** 22 × P1, 40 × P2 and 17 × P3. Screenshots would help in 56 of 79.

### 2.7 Harmful-claim list (P1 corrections that should not wait for the full modernization)

| Claim | Articles | Why harmful |
|---|---|---|
| Duplicate check-in protection | 19, 65 | Not shipped; CI-B is an open release hold. Staff may rely on it at the door |
| SMS texting works | 49, 50, 62, 63, 77, 78 | SMS is fail-closed for every studio in PROD |
| Unsubscribe suppression and compliance behavior | 37, 38 | M-0 is unreleased. Suppression happens only at Prepare Send List |
| Student app features available | 1, 69 | The app is not store-released. Public claims rule (Phase 3 restrictions) |
| Security overclaims | 70 | Open roadmap items contradict them |
| Competitor registration available | 13, 34 | The flag is OFF |
| Nonexistent UI | 59, 61 (Quick Sale & Payment; channel field; "future" Quick Charge); 4 (button names); 7 (Client Payments); 8 and 12 (Studio Login); 41–43 (wrong queue model) | Users cannot follow the steps |
| Independent instructors can record expenses | 29 | They are redirected away |
| Intro request approval | 11, 41, 42 | No approval UI for public intro requests was found (engineering finding, needs validation and a product decision) |

---

## 3. Missing-article inventory

These are production-available features with no or only partial coverage (Repo unless marked). Priority follows the brief: high-frequency workflows are P1. The proposed titles are working titles.

| Area | Routes | Coverage | Proposed new article(s) | Pri |
|---|---|---|---|---|
| Today dashboard | /app | Partial | Your Today dashboard: cards, alerts and what to do first | P1 |
| Clients | /app/clients, /new, /[id], /[id]/edit | Partial (no core how-to) | Adding a new client; Tour of the client profile (tabs); Archiving clients and the active/inactive/archived lifecycle; Client notes; Linking dance partners | P1 |
| Leads | /app/leads | Partial | Working your New Leads inbox (convert, archive, intro requests) | P1 |
| Studio settings and policies | /app/settings, /app/settings/hours | None | Configuring studio settings and booking policies (cancellation window, lead time, no-show, negative balance, low-balance warning); Setting business hours; Turning on student portal self-scheduling | P1 |
| Instructors | /app/instructors/** | Partial | Adding and managing instructors; Instructor logins, capabilities and seats (no invitation or seat-purchase flow exists — do not imply one) | P1 |
| Instructor availability | /app/instructors/[id]/availability, /my-availability, /app/schedule/self-service/availability | Partial | Setting instructor availability and blackout dates | P1 |
| Private lessons | /app/schedule, /new, /[id], /[id]/edit, /[id]/edit-following, /blocks/** | Partial | Booking a private lesson; Editing, rescheduling and cancelling (including "this and following"); Blocking time; Marking attended and no-show | P1 |
| Group classes and attendance | /app/schedule/enroll-student, /app/schedule/[id]/attendance; public classes | **None** | Creating group classes and series; Enrolling students; Taking class attendance; Correcting attendance (reset); Public class registration and portal self-enrollment | P1 |
| Package templates and selling | /app/packages/**, /app/sell | Partial or none | Creating and managing package templates; Selling a package | P1 |
| Package balances | /app/packages/client-balances, /adjustments | Partial | Balances, usage and lesson-count corrections; Package Renewal Watch | P1 |
| Refunds and reconciliation | client billing tab; /app/payments/reconciliation | **None** | Refunding a package or client payment; Resolving reconciliation items | P1 |
| Memberships | /app/memberships/** | Partial (concept only) | Creating membership plans; Selling a membership (online or card reader); Past-due memberships and retrying billing; Cancel, reactivate or waive a period; Recording an outside payment | P1 |
| Payments | /app/payments, /take | Partial | Using the Payment Ledger; Taking a payment; Voiding a pending payment | P1 |
| Sell / Commerce | /app/sell, /app/catalog/**, /app/orders/** | None | Using the Sell workspace (P1); Catalog products, variants and inventory; Selling on-demand video; Viewing orders; How students buy from your marketplace (P2) | P1/P2 |
| Events: create and lifecycle | /app/events/new, /[id], /[id]/edit | Partial | Creating and publishing your first event (Basic listing vs DanceFlow tickets; visibility modes); Past events and event lifecycle | P1 |
| Registrations | /app/events/[id]/registrations/[registrationId] | Partial | Managing an individual registration | P1 |
| Event payment exceptions | `PaymentExceptionsPanel` | None | Reviewing and resolving event payment exceptions | P1 |
| Event refunds | `refundEventRegistrationAction` | None | Refunding an event registration (and the current limit for cart orders, until CI-D) | P1 |
| Marketing (after M-0) | /app/marketing/campaigns/[id] | Partial | Testing and sending a campaign (write when M-0 releases) | P1 |
| Lesson recaps | appointment detail; /recaps/[token] | None | Sending lesson recaps (with video) | P2 |
| Team and roles | /app/settings/team | Partial | Roles and permissions reference; Finding your way around (sidebar by role); Export permission overrides | P2 |
| Plans and add-ons | /app/settings/billing | Partial | DanceFlow plans and what each includes; Adding Organizer Suite or AI; Connecting Stripe payouts | P2 |
| Rooms | /app/rooms/** | None | Managing rooms and floor spaces (studios have rooms, not multiple locations) | P2 |
| Documents Center | /app/documents/** | Partial | Assigning documents and tracking requests; Template library and versions; Audit history and signed-document proof | P2 |
| Organizer | /app/organizers/**, /app/organizer-campaigns/** | Partial or none | Setting up your organizer profile; Creating and sending an organizer campaign | P2 |
| Communications | /app/communications | Partial | Using the Communications workspace (email log, follow-ups) | P2 |
| Notifications | /app/notifications | None | In-app notifications and preferences | P2 |
| Reports and analytics | /app/reports, /app/analytics/**, /app/reports/client-birthdays | Partial | Studio Analytics; Dance Goal Analytics; Birthday outreach; Exporting reports (Pro plus permission) | P2 |
| Wave | /app/settings/integrations/wave | None | Connecting Wave (Pro). Posting is env-gated (A), so describe posting only if enabled | P2 |
| Payroll Prep v1 | /app/instructor-pay/** | Partial | Compensation rules; Running a payroll period end to end; Exporting payroll CSV batches | P2 |
| Syllabus | /app/syllabus | None | Building your syllabus; Assigning steps and tracking progress | P2 |
| Rewards | /app/rewards | None | Setting up client rewards | P2 |
| Account | /app/account, /account/**, /legal/accept | Partial | Verifying your email; Accepting updated terms; Managing your account and profile; Choosing a get-started path | P2 |
| Student portal (student-facing) | /portal/[slug]/** | Partial | Confirming a lesson; Signing documents; Viewing your membership; Enrolling in classes; Updating contact details; Dance Journey (LUMI, plan-gated); Switching studio portals | P1/P2 |
| Instructor (staff) guide | role nav | None | Instructor guide: your schedule, attendance and recaps | P2 |
| ARIA | /app/aria/goals, /app/automations/drafts | Partial | Setting ARIA goals; Reviewing automation email drafts | P3 |
| Now Hiring | /app/now-hiring | None | Posting a job on Now Hiring | P3 |
| Migration by source | /app/settings/import | Partial | Importing from Square or Mindbody, by data type | P3 |
| Support | /app/support | None | Contacting DanceFlow support | P3 |
| Public flows | /studio-invites/[token], /appointments/confirm/[token], /favorites, /unsubscribe/** | Partial | Accepting a team invitation; Confirming a lesson from an email; Saving favorites; Unsubscribing | P3 |

**Must not be documented as generally available.** Gate evidence is (Repo) unless marked.
- **Public Competition registration.** `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED` at `src/app/events/[slug]/page.tsx:19-20,1620` and `src/app/events/[slug]/competition/register/page.tsx:7-8`; the checkout API returns 404.
- **The Competition OS admin workspace.** It is reachable by owner/admin roles without a flag (`workspaceServer.ts:62-77`), but 10E and 10F are not built and public claims are restricted. Owner decision D6.
- **Multi-Dance categories.** Hold at `studioCustomV3.ts:1587,1799`.
- **SMS sending.** Blocked at `lib/sms/compliance.ts:381-416` and `registration.ts:152-156`.
- **Gusto.** `GUSTO_INTEGRATION_ENABLED = false`, `lib/integrations/gusto/dormant.ts:11`.
- **QuickBooks, Outlook and Zapier/Make.** "Coming soon" at `settings/integrations/page.tsx:95-108`.
- **Wave posting.** Env-gated (A).
- **AI features.** Gated by `AI_FEATURES_ENABLED` and plan (A).
- **M-0 compliance behavior.**
- **Atomic check-in (CI-B) and per-ticket refunds for cart orders (CI-D).**
- **ACH.**
- **Features that do not exist at all:** gift certificates (only a Mindbody import mapping exists), studio multi-location, instructor invitation and seat purchase, and the Independent Instructor Business Workspace.

---

## 4. Proposed knowledgebase category and content structure

### 4.1 Categories

Today there are 26 categories, many with 1–3 articles and several near-duplicates ("Clients & CRM", "Clients & Portals", "Client Portal", "Clients & Billing"). The proposal has 15 task-oriented categories:

| # | Category | Primary readers | Contents (existing → new) |
|---|---|---|---|
| 1 | Getting started | owners, organizers | Setup checklist, plans and add-ons, team setup, Migration Center |
| 2 | Clients & leads | front desk, owners | Clients, profile, lifecycle, leads, intro requests, portal invites and linking, client identity and photos |
| 3 | Scheduling & private lessons | front desk, instructors | Booking, editing, blocks, availability, self-service requests, daily closeout, billing types, calendar sync |
| 4 | Group classes & attendance | front desk, instructors | Classes and series, enrollment, attendance, correction, public registration |
| 5 | Packages & memberships | front desk, owners | Templates, selling, balances, corrections, renewals, membership lifecycle |
| 6 | Payments & sales | front desk, owners | Payment Ledger, Take Payment, Sell and Quick Charge, card readers, refunds, reconciliation, account credits, catalog and orders |
| 7 | Events & ticketing | organizers, studio event staff | Create and publish, tickets and early bird, admin sales, registrations, check-in, guest coaches, payment exceptions, refunds, settlement, website calendar, discovery |
| 8 | Documents & signatures | owners, front desk | Documents Center, templates, assignment, event requirements, finding signed documents |
| 9 | Marketing & communication | owners, front desk | Campaigns, audiences, organizer campaigns and contacts, SMS consent (the single SMS article), communications log |
| 10 | ARIA & automations | owners | Consult with ARIA, goals, Automation Center, ARIA Operations, autonomy and safety |
| 11 | Studio settings & integrations | owners | Studio settings and policies, hours, rooms, public profile and discovery, staff profiles and credentials, Google Calendar, Wave, accountant delivery |
| 12 | Reports, accounting & payroll | owners | Reports and profit, analytics, expenses, Payroll Prep |
| 13 | Student portal | students (student-facing voice) | Accessing the portal, portal tour, booking requests, documents, membership, Journey, account balance, password, Partner Search |
| 14 | Organizer Suite | organizers | Getting started, organizer profile, organizer-specific differences |
| 15 | Security, privacy & account | everyone | Data protection (merged), account access, email verification, terms |

Competition OS gets no category until registration and claims are cleared.

### 4.2 Standard article template (KB-2)

1. **Summary**: one sentence on what you will accomplish.
2. **Before you start**: role(s), plan or add-on, settings that must already be on, and links to setup articles.
3. **Where to find it**: the exact sidebar label, route, page heading and section.
4. **Steps**: a numbered list using exact UI labels in bold. One action per step.
5. **What happens next**: system behavior, emails sent, and what the student sees.
6. **Common problems and fixes**: symptom, then cause, then fix. Include the error strings the UI actually shows.
7. **Limits and things to know**: current limits, stated plainly. For example: "Refunds for cart orders are whole-payment only."
8. **Related articles**: explicit slugs, not the first three in the file.
9. **Metadata**: last verified date and deploy, and the screenshot set version.

Writing rules:
- Plain language and no internal terms (RPC, RLS, migration, phase names).
- Never describe held or unreleased behavior as available.
- Never say "coming soon" or "in a later version". If a feature is not available, leave it out, or say "not available" only when users would otherwise look for it (SMS).

### 4.3 Rewrite, merge, retire and create actions

**Merges.** The kept slug is in bold. Retired slugs get a permanent redirect to it.

| Cluster | Kept article | Retired into it |
|---|---|---|
| Portal linking | **8** | 12, 53 |
| Discovery | **9** | 28 |
| Setup | **2** | 14 |
| Capabilities | **69** | 1 stays as a short public overview linking to 69 (welcome email link) |
| Import | **79** | 4 becomes a section of 79 |
| Calendar | **74** | 15 |
| Booking | **41** | 42, and later 11, after the intro-request finding is validated and decided |
| Marketing | **37** | 38 |
| Staff profiles | **46** | 47, 48 |
| Client identity | **68** | 45 |
| Guest coach slots | **26** | 57 |
| In-person payments | **58** (overview) | 59, 61 remain short task articles; 60 stays |
| Documents | **51** | 52 and 66 become task articles under 51 |
| SMS | **49** | 50 |
| ARIA | **77** | 63; 62 is retitled; 75 and 76 are reconciled |
| Accountant | **71** | 72 |
| Security | **70** | 33 |
| Check-in | **19** | 65 |
| Events hub | **31** | becomes the hub article |

**Rewrites:** 11, 41, 43, 51, 73.

**Retire outright:** none. Every slug is redirected rather than deleted, because 7 slugs are linked from the welcome email.

**Create:** about 70 new articles, per §3.

**Net result:** roughly 60 updated articles and about 70 new ones. That is about 130 articles in 15 categories.

---

## 5. Reusable contextual Help panel architecture (KB-3)

### 5.1 One authoritative content source

**Engineering recommendation (not decided; storage is open question D1): file-based articles in the repository (no SQL).** The canonical format below is the proposed format; the owner-approved direction is a single authoritative source, whatever the storage.
- Move from the single `articles.ts` array to one Markdown file per article, `src/content/knowledgebase/articles/<slug>.md`, each with typed frontmatter.
- A build-time loader generates a typed index. The public KB, the in-app panel and future ARIA all read that one index through `src/lib/help/*`.
- Edits go through PR review, which fits the developer-owned QA policy and keeps unreleased content out of production. A content-only deploy is low-risk.
- **Alternative: database-backed CMS.** It allows edits without a deploy, but needs new tables, RLS, a platform-admin editor and its own review and audit trail. Recommended only if the owner requires non-developer editing (decision D1).

Frontmatter schema, which a test validates:

```yaml
slug: selling-a-package
title: Selling a package to a client
summary: …
category: packages-memberships
status: published            # draft | reviewed | published | archived
visibility: public           # public | signed_in  (signed_in = panel/app only, not in sitemap)
roles: [studio_owner, studio_admin, front_desk]   # who the steps apply to (empty = everyone)
features: [packages]         # BillingFeature keys; hidden or flagged "needs plan" when not entitled
flags: []                    # e.g. NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED; hidden when the flag is off
contexts:                    # route patterns for KB-4 (see §6)
  - { route: /app/packages/sell, weight: 100 }
  - { route: /app/clients/[id], tab: billing, weight: 60 }
related: [creating-package-templates, package-balances-and-corrections]
redirectFrom: []             # retired slugs that should 301 here
lastVerified: { date: 2026-10-13, deploy: dpl_… , by: developer-qa }
owner: product
```

### 5.2 Panel behavior and component design

**Mount point.** The Help panel is a client component mounted once in the authenticated shell (`src/app/app/AppSidebarShell.tsx` / `src/components/app/sidebar/AppShellChrome.tsx`). A `HelpPanelProvider` context exposes `openHelp({ slug?, query? })` and `closeHelp()`.

**It never navigates.** Opening, searching, reading and going back are all in-memory state. They do not change the route or the search params, so the page and any unsaved form state are never touched.
- The panel's view stack (home, category, article and back) is kept in React state, mirrored to `sessionStorage` for reload resilience. Storage access is wrapped in try/catch.
- Do not put panel state in the URL. In the App Router, changing search params re-renders server components, which risks resetting the workflow.

**Help control placement:**
- Next to `NotificationMenu` in the mobile top bar (`AppShellChrome.tsx:~92`) and the desktop sidebar header (`:~160`).
- The two sidebar items ("Help", "Knowledgebase") are replaced by the persistent control. The "Contact support" item stays.
- Optional keyboard shortcut `?` when focus is not in an input field.

**Desktop layout (≥ lg):**
- A **non-modal** right-side `<aside role="complementary" aria-label="Help">`, about 420px wide.
- From xl up, page content reflows beside the panel. Between lg and xl the panel overlays the page.
- The page stays interactive while the panel is open, so a user can follow steps while reading.

**Smaller screens (< lg):**
- A full-height modal sheet (`role="dialog" aria-modal="true"`) with a focus trap, Escape to close, focus returned to the Help button, and body scroll lock.
- This reuses the pattern from the existing mobile navigation drawer (`AppShellChrome.tsx:270-300`).

**Panel views:**

| View | Contents |
|---|---|
| Home | Search box with autofocus; "Suggested for this page" (KB-4, up to 5 articles); category list; "Contact support" |
| Results and category | Article list with category and summary |
| Article | The full article, using the same renderer as the public page; related articles; "Was this helpful?" (optional, see §8); "Open in new tab" link to the public URL when `visibility=public` |
| Navigation and states | Back stack and a clear close (×) button. Loading skeleton, empty state ("No articles match — try fewer words or contact support"), and error state with retry |

**Workflow-state preservation (required; must be tested).** Opening, using and closing Help must never lose or reset the user's work. This is a release requirement for KB-3, not a goal.
- *Requirement:* while the user has unsaved input, the following must survive opening the panel, searching, browsing categories, reading articles, following in-panel article links, using Back, and closing the panel (× button, Escape, backdrop on small screens):
  - typed values in every field of the open form, including multi-step and conditional sections;
  - the open tab, expanded sections, selected options and dirty/validation state;
  - scroll position;
  - any open in-page dialog;
  - the current route and search parameters (unchanged).
- *Implementation constraints:* the panel is mounted outside the page subtree, so the page component never unmounts or re-renders because of Help. Panel state never touches the URL. No `router.push`/`replace`/`refresh` is called from the panel. Help never submits, resets or autosaves a form.
- *The only exit:* a link labelled "Opens page" navigates only when the user clicks it, as normal navigation. If an unsaved-changes guard exists on that page, it applies as usual.
- *Required tests (part of the KB-3 QA matrix):* browser end-to-end tests that fill real forms with unsaved data, then open Help, search, open two articles, go Back, close, and assert every value, tab, scroll position and URL is unchanged.
  - Forms covered at minimum: Add New Client (`/app/clients/new`), Create Event (`/app/events/new`), a marketing campaign draft (`/app/marketing/campaigns/[id]`) and New lesson (`/app/schedule/new`).
  - Run on desktop (non-modal panel) and mobile width (modal sheet).
  - Plus a unit test that the provider never calls the router.

**Links inside articles:**
- Links to `/knowledgebase/<slug>` are intercepted and open in the panel.
- Links to app routes are labelled "Opens page" and work as normal links. The user chooses to navigate; the panel never does it for them.
- External links open in a new tab.

**Data loading:**
- The first open loads a small index (slug, title, summary, category, contexts) from a server action or route handler, `GET /api/help/index`. It is already filtered for the viewer's role, plan entitlements (`studioHasFeature`) and flags.
- An article body loads on demand from `GET /api/help/articles/[slug]` with the same filter. Content is never rendered from untrusted HTML; it goes through the shared element renderer.
- Signed-in-only and draft articles are never sent to the public site.

**Shared modules** (one implementation, three consumers):
- `src/lib/help/index.ts`: loader, filters and `getArticle`.
- `src/lib/help/search.ts`: the existing scoring, extracted.
- `src/lib/help/context.ts`: KB-4.
- `src/components/help/ArticleRenderer.tsx`: an upgraded renderer with ordered lists, `###`, tables, links, callouts and images with alt text.

**Media.**
- Screenshots live in `public/kb/<slug>/…`, taken from DEV seed data with no real personal data.
- Alt text is required, and image width is constrained in the panel.
- Each screenshot is tied to a `lastVerified` deploy, so stale images are detectable.

**Accessibility.**
- The panel gets `aria-labelledby` pointing at its heading.
- Search results are announced via `aria-live`.
- The existing BR-2D shell a11y tests are extended to cover the Help control and panel.

**Student portal.** Out of scope for KB-3 v1. The same provider can later mount in the portal shell with `visibility`/`roles` filtering for students (decision D4).

### 5.3 Why not a modal or a separate route

- **A modal** blocks the work the user is trying to follow.
- **A separate `/app/help/[slug]` route** navigates away and breaks the "don't reset my workflow" requirement.
- **A limited "preview plus open full article" design** is explicitly rejected by the brief.

---

## 6. Page-to-article mapping approach (KB-4)

**Where mappings live.** Mappings are declared on the article (the `contexts` frontmatter), not in page components. Pages need no code changes. Adding or changing help for a page is a content edit.

**Matching.**
1. Normalize `usePathname()` to a route pattern using the known `src/app/app` route list. For example, `/app/clients/8f3…` becomes `/app/clients/[id]`.
2. Score each article. An exact pattern match plus a matching optional `tab`/query qualifier scores highest. A parent pattern scores next (for example `/app/events/[id]` for `/app/events/[id]/tickets`). The category default for the section is the fallback.
3. Drop articles the viewer cannot use: wrong role, missing plan feature, or flag off.
4. Show the top 5. Search always covers the full filtered KB.

**Maintainability guards** (tests, KB-5):
- Every `contexts.route` matches a real `page.tsx` under `src/app/app`.
- Every high-traffic route has at least one mapped article. The list starts with the brief's examples plus the P1 workflows.
- No article maps to a route its `roles` cannot reach.
- Every `related` slug and every slug used in `dispatch.ts` exists and is published.

Seed mapping (KB-4 v1), using real routes:

| Page | Route pattern | Suggested articles (new = N) |
|---|---|---|
| Add New Client | /app/clients/new | Adding a new client (N); Adding client photos (68 merged); Importing clients (79) |
| Client profile | /app/clients/[id] (+tab) | Tour of the client profile (N); portal tab → 8; billing tab → balances (N), 23; documents tab → 52; Communication tab → 49 |
| Schedule / Calendar | /app/schedule, /app/schedule/calendar | Booking a private lesson (N); Daily closeout (24); Billing types (25); Availability (N) |
| New lesson | /app/schedule/new | Booking a private lesson (N); 25; 6 (host floor space) |
| Class attendance | /app/schedule/[id]/attendance | Taking class attendance (N); Correcting attendance (N) |
| Self-service Requests | /app/schedule/self-service(/availability) | 41; 43; 44 |
| Package Templates | /app/packages, /new, /[id]/edit | Creating package templates (N); 5 |
| Sell | /app/sell, /app/packages/sell, /app/memberships/sell | Using the Sell workspace (N); Selling a package (N); Selling a membership (N); 58 |
| Memberships | /app/memberships/** | Creating membership plans (N); Past-due memberships (N); Cancel or waive (N); 5 |
| Payments | /app/payments, /take, /terminal/[paymentId], /reconciliation | 7; Taking a payment (N); 61; Reconciliation (N); Refunds (N) |
| Create or Edit Event | /app/events/new, /app/events/[id]/edit | Creating and publishing your first event (N); 16; 27; 26; 34 |
| Event registrations | /app/events/[id]/registrations(/[registrationId]) | 56; Payment exceptions (N); Event refunds (N); 55 |
| Check-in | /app/events/checkin, /app/events/[id]/check-in | 19 |
| Campaigns | /app/marketing/campaigns(/[id]) | 37; Testing and sending (N, after M-0) |
| Documents | /app/documents/** | 51; template library (N); assigning (N) |
| Accounting & Reports | /app/reports, /app/expenses, /app/settings/accountant | 30; 29; 71 |
| Instructor Pay | /app/instructor-pay/** | Running a payroll period (N); Compensation rules (N); 73 |
| ARIA | /app/aria/**, /app/automations | 62; 77; 78; 75 |
| Settings | /app/settings, /team, /billing, /public-profile, /import, /integrations/** | Studio settings (N); 39; Plans (N); 9; 79; 74 |

**Future ARIA integration** (preserved, not built in KB-3/KB-4):
- ARIA calls the same `src/lib/help` API: `searchHelpArticles(query, { route, role, features })` and `getArticle(slug)`.
- It returns a short answer plus `{ action: "open_help", slug }`, which the ARIA UI turns into `openHelp({ slug })`.
- There is no separate ARIA knowledgebase. The current public KB AI assistant becomes a consumer of the same API, or is retired in favor of ARIA (decision D3). Its rate-limit gap should be closed independently.
- Proactive suggestions ("configuring an event? here's the setup guide") reuse the KB-4 context scoring. Building them needs separate authorization under Phase 15.

---

## 7. KB-1 to KB-5 implementation sequence

| Step | Scope | Kind | Depends on | Gate |
|---|---|---|---|---|
| **KB-1** | This audit: implementation assessment, 79-article matrix, missing inventory, IA, architecture, roadmap proposal | Docs only | None | **ACCEPTED as the preliminary baseline (owner, 2026-10-13)** |
| **KB-2A** *(optional, bounded fast lane)* | Correct existing articles that inaccurately describe what is available, within the bounds below | Content-only app deploy (low risk, no SQL) | KB-1 accepted | Separate authorization (D7). Must not displace M-0/CI-B/CI-D; touches no files they touch |
| **KB-2B** | Content platform: per-article Markdown with frontmatter, loader and index, upgraded shared renderer, redirects for retired slugs, related articles, content-integrity tests, vocabulary guard extension. No content rewrite beyond migration | Engineering, app-only, no SQL | KB-1 | Normal app release; developer QA matrix (public KB unchanged visually except renderer fixes) |
| **KB-2C** | Content modernization in waves. **Wave 1**: P1 rewrites and P1 new articles (clients, scheduling, group classes, packages, memberships, payments and refunds, events, marketing). **Wave 2**: P2. **Wave 3**: P3 and screenshots. Each article verified against the live deploy and moved draft → reviewed → published | Content | KB-2B; feature releases that change the workflows being documented | Developer functional verification per article; owner business acceptance per wave |
| **KB-3** | Persistent Help control and right-side panel (search, categories, full articles, related, back, close, states, responsive, a11y) | Engineering, app-only, no SQL | KB-2B; **KB-2C Wave 1 published** (so the panel doesn't lead with stale content) | Normal app release; QA matrix including the workflow-state preservation tests in §5.2 (desktop and mobile) |
| **KB-4** | Context mapping: `contexts` frontmatter, route-pattern matcher, role/plan/flag filtering, seed mapping (§6), route-existence tests; ARIA-ready `src/lib/help` API | Engineering, app-only | KB-3 (can ship together with KB-3 for the seed routes) | Normal app release |
| **KB-5** | Governance: Definition of Done line, PR template "KB impact" section, status workflow, review cadence, stale-article report (`lastVerified` older than N releases), and closeout checks for retired features | Process plus tests | Starts with KB-2B; ongoing | Becomes part of every slice's closeout |

**Roadmap priority.** Under the v2.22 near-term order, this initiative sits inside **item 7 (Web / Business UX)** as a 17-I track. It does **not** displace items 1–6 (M-0, CI-B, CI-D, 10E/10F, TW-4, Marketing enhancements). KB-2A is the only piece that might reasonably run earlier, and only as an explicitly authorized content-only correction, because it removes customer-facing inaccuracies (including one that contradicts an open release hold).

### KB-2A fast lane: bounds

KB-2A exists only to stop existing articles from describing available features inaccurately. It is deliberately narrow.

**In scope:**
- Edits to the text of **existing** articles in `src/content/knowledgebase/articles.ts` that:
  1. remove or qualify claims that a feature, protection or behavior is available when the repository and documented release state show it is not (the §2.7 list: duplicate check-in protection, SMS sending, M-0 unsubscribe behavior, the student app, competitor registration, security overclaims);
  2. remove "future" or "coming" language for behavior that has already shipped;
  3. replace UI labels, navigation paths, buttons, statuses and roles that do not exist with the labels in the code (for example "Quick Sale & Payment", "Client Payments", "Studio Login", "Settings > Import", "Unblock");
  4. correct a role statement that tells users to do something they cannot do (for example article 29).
- Correct the marketing articles to the *current* pre-M-0 behavior. Revisit them in the M-0 closeout.

**Out of scope:**
- New articles, merges, retirements or slug changes.
- Restructuring or the new template.
- The new content format (KB-2B), renderer changes, metadata, screenshots.
- Any code other than the article strings.
- Documenting unreleased or held behavior.
- Describing anything whose availability rests only on an unverified environment value: leave it out, or state the condition.

**Size and evidence:**
- Limited to the articles flagged in §2.7, plus those whose discrepancy column names a nonexistent label or an availability error. That is about 20 articles.
- Each change records its evidence: file:line, or the roadmap hold.
- Before release, the corrected wording is checked against the release state at that time, because availability may have changed (for example, CI-B or M-0 may have shipped).

**Gate:**
- Separate owner authorization (D7).
- Normal app release with a developer QA matrix: the article renders, slugs are unchanged, welcome-email links still resolve, vocabulary tests pass.
- Owner business acceptance of the corrected public wording (the public-claims rule).

**Not a substitute for KB-2C:** corrected articles still go through full modernization later.

### KB-5: governance details

- **Definition of Done addition:** "KB impact assessed — none / update `<slugs>` / new article / retire `<slug>` (redirect) — and the canonical KB updated or a tracked KB task created before the slice is closed."
  - It applies to new workflows, navigation or label changes, permission or entitlement changes, automation changes, payment or registration changes, and retirements.
  - It sits alongside the existing ROADMAP MAINTENANCE RULE.
- **Status workflow:**
  - **draft:** being written. Never served.
  - **reviewed:** a developer has functionally verified every step against the *released* deploy, recorded in `lastVerified`. Not served publicly.
  - **published:** served. Requires reviewed status plus the feature being released and its flags on.
  - **archived:** not served. The slug redirects to `redirectFrom` on the replacement.
- **Documenting unreleased features:** an article for an unreleased feature may exist as a draft, but cannot be published until the release closeout. An article with `flags` is hidden whenever the flag is off at runtime.
- **Tests (CI):** frontmatter schema; slug uniqueness; `related`, `redirectFrom` and welcome-email slugs resolve; `contexts.route` exists; a stale-label denylist (for example "Quick Sale & Payment", "Client Payments", "Studio Login", "Settings > Import", "duplicate check-in protection" while CI-B is unreleased); published articles have `lastVerified`.
- **Cadence:** each release closeout lists the KB slugs touched. A quarterly stale report covers articles whose `lastVerified` predates changes to their mapped routes (git log on mapped route files).

---

## 8. SQL or schema requirements

- **Recommended path (KB-2B to KB-5; subject to D1): no SQL, no migrations, no new tables.** Articles live in the repository. Role, plan and flag filtering use existing helpers (`src/lib/auth/permissions.ts`, `studioHasFeature`). Panel state is client-side.
- **Optional, each requiring a separate owner decision and normal SQL release gates:**
  1. **Article feedback** ("Was this helpful?" and searches with no results). A small `kb_feedback` table: studio_id, user_id, slug, helpful, query, created_at. RLS insert-own, platform-admin read. Useful for KB-5 prioritization.
  2. **Database-backed CMS** (only if decision D1 is a database). `kb_articles`, `kb_article_versions` and an audit trail; RLS (public read of published and public articles only; platform-admin write); a platform-admin editor; and a migration of the repository content. This is a substantially larger slice.
- **No PROD data changes are needed for any KB step.**

---

## 9. Open product questions (D1–D7)

These questions are **open**. The right-hand column is an engineering recommendation for discussion only. It is **not** approved and must not be treated as a decision. Accepting KB-1 as the baseline did not decide any of them. Each is recorded as roadmap open decision #25.

| # | Open question (not decided) | Engineering recommendation (not approved) |
|---|---|---|
| D1 | Article storage: repository files vs database CMS | Repository files now; revisit a CMS only if non-developer editing becomes a requirement |
| D2 | Public vs signed-in-only articles | Keep how-to articles public (SEO, prospects). Use `signed_in` only for role-specific troubleshooting or operational detail. Never publish unreleased content |
| D3 | Public KB AI assistant | Long term, consolidate into ARIA on the shared help API, or remove it. Separately, validate the rate-limit engineering finding |
| D4 | Student portal Help panel | After KB-3 admin v1, as a follow-up |
| D5 | Screenshots | Capture from DEV seed data during KB-2C Wave 3; accept the maintenance cost only for P1 workflows at first |
| D6 | Competition workspace documentation | Hold until public registration and claims are cleared (10E/10F and the holds) |
| D7 | KB-2A fast lane | Authorize a content-only correction of the harmful claims ahead of the full modernization (does not touch M-0/CI files) |

---

## 10. Roadmap reconciliation

**Finding (R).** The full initiative is **not** in the v2.22 roadmap.
- **Existing related items:** TW-4 slice 4E knowledgebase article (Phase 2); ARIA guidance plus KB article (Phase 15, v2.22 bullet); BR-4 vocabulary retention note.
- **Missing:** the audit, content modernization, in-app panel, context mapping, ARIA reuse of a single source, and governance/DoD.

**Roadmap v2.23 changes** (documentation-only, in the same PR as this document):

1. **Phase 17:** a new subsection, "Contextual Help Center & Knowledgebase Modernization (17-I track '17-KB')", with KB-1 to KB-5, the bounded KB-2A fast lane, the workflow-state preservation requirement, dependencies, sequence, SQL (none), principles and priority placement. The status line reads: direction owner-approved, KB-1 accepted as the preliminary baseline, implementation not authorized.
2. **ROADMAP MAINTENANCE RULE:** a Definition of Done line for Knowledgebase maintenance.
3. **Phase 15:** a dependency note that future ARIA KB guidance uses the KB-4 shared help API (no separate ARIA KB).
4. **Phase 2 TW-4 4E:** a note that its knowledgebase article follows the KB-5 status workflow once that exists.
5. **Preserved Commitments Register, section A:** a row for the owner-named commitment.
6. **Open product decisions:** #25, holding questions D1–D7 as open.
7. **Preserved follow-ups, section D:** the four engineering findings, each marked as requiring separate validation. They are not confirmed defects and not authorized work.
8. **Change log and header:** a v2.23 row.

The near-term priority table is **unchanged**. The initiative sits inside existing item 7.
