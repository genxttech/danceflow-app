# Website Embeds (v1)

A studio can show its DanceFlow group classes on its own website with one pasted snippet. The page updates itself: change a class in DanceFlow and the website follows. Registration and payment always happen on DanceFlow.

## What is in v1

| Piece | Where |
|---|---|
| Studio UI: pick a class or the calendar, preview, copy code, install guidance | `/app/settings/embeds` (Settings, "Website Embeds"; studio owner/admin) |
| Single-class embed | `/embed/class/[appointmentId]` |
| Studio calendar embed (list, week, month, instructor filter) | `/embed/calendar/[studioSlug]` |
| Option parsing, embed-code builder | `src/lib/public/embedOptions.ts` |
| Calendar math (studio-zone days, month/week grids) | `src/lib/public/embedCalendar.ts` |
| Framing headers for the two route families | `next.config.ts` (owner-reviewed path) |

| Public studio events in the calendar | `src/lib/public/embedEvents.ts`, calendar page |
| Studio kill switch and stored settings | `src/lib/public/embedSettings.ts`, `/app/settings/embeds` settings panel, migration `20270216090000_website_embed_settings.sql` |
| Class description and price | `src/lib/public/embedClassExtras.ts`, same migration (`public_group_class_extras`) |

**Release requirement:** the migration is Git-only and has NOT been applied to any hosted database. It must be applied (owner-authorized) before the app release that serves embeds publicly. Until then embeds fail closed (see "Studio control").

## Architecture

- **Stateless iframes.** An embed URL carries only appearance options (`accent`, `theme`, `view`, `instructor`, `date`), each validated against a strict allow-list in `parseEmbedOptions`. Stored studio defaults (view, background, button color) apply only where the URL is silent; an explicit option wins. The builder omits an option equal to the stored default, so existing embeds follow later changes.
- **Studio control and kill switch.** `studio_embed_settings` holds one row per studio. RLS is on with no policies and no table privileges for any API role; everything goes through `SECURITY DEFINER` functions: `public_studio_embed_settings(slug)` (anon, answers only for a public active studio), `get_/set_studio_embed_settings(studio)` (active owner or admin of that studio only; the app derives the studio from the session, never from the form). No row means: embeds on, events on, class description and price off. With embeds off, every embed of the studio returns 404 immediately, and no studio detail appears in that response. If the settings cannot be read (function missing, database error) the embed **fails closed**. Public studio pages are unaffected.
- **Public events.** Studio-owned events with visibility `public`, listed in the directory, status published, not over, with a usable slug. Multi-day events appear on each day. Only name, type, dates/times, venue/city/state and two yes/no flags are selected; each event links to its public DanceFlow page (new tab), where registration happens. Events are hidden when the studio turns them off, and when an instructor filter is active (events have no instructor).
- **Class description and price.** Shown only when the studio turns each on. The description is the recurring series description (single classes have no description field; `appointments.notes` is private and never read). The price is `direct_payment_amount` and appears only where the registration flow would charge it (self enrollment on, direct payment accepted, amount above zero). The database enforces both opt-ins, so a direct call to the function cannot bypass them. If the function is absent, embeds simply omit the extras.
- **One data source.** Both embeds read only through the existing public read model, `public_group_class_occurrences` (see `20261024090000_gc34a_public_group_class_read_model.sql`). A class is public only if its enrollment policy is `publicly_discoverable`, the studio is in the public directory and active/trialing; instructor names appear only for instructors with a public profile. Embeds never read `appointments` directly and use no service-role client.
- **What is public.** The existing per-class "publicly discoverable" setting plus the studio's public-directory setting decide what any embed can show. The builder lists exactly what an embed can display.
- **Registration handoff.** The Register button is a link (new tab) to the existing `/studios/[slug]/classes/[id]/register` flow, shown only when `canProceedToRegister` holds. Identity, eligibility, capacity, funding, Stripe checkout, duplicate/replay protection and studio notifications are all the existing code. The iframe has no form and no card field (`form-action 'none'`). Viewing an embed creates no lead and no notification.
- **Auto-resize.** The embed posts `{type: "danceflow:embed:height", height}` to its parent. The pasted snippet only accepts that message from its own iframe window and the DanceFlow origin, clamps the value, and sizes through the `height` attribute (works even on websites that forbid inline styles).
- **Time zones.** Days and times are the class's studio time zone, labelled (for example "EST"), never the viewer's.

## Security model

- Framing is allowed only for `/embed/class/*` and `/embed/calendar/*` (`frame-ancestors *`, no `X-Frame-Options`). The global header rule now excludes exactly those two prefixes, so every other page keeps `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`. A test pins both directions (`embed.headers.websiteEmbeds.test.ts`).
- Embed CSP: `default-src 'self'`, `connect-src 'self'`, `frame-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'none'`. No Stripe or Supabase origins are reachable from the frame.
- Tenant isolation: a class id resolves only through the public read model; an unpublished class, a private-lesson id, another studio's non-public class, and a private studio's calendar all return 404. The calendar slug is looked up with the same public-studio rule as `/studios/[slug]/classes`.
- Output is rendered by React (escaped); option values are validated before use; the accent color is the only value placed in a style and must match `#rrggbb`.
- Embeds are `noindex`.

## Install guide (shown in the UI)

- **WordPress:** page editor, Custom HTML block, paste, Update.
- **Wix:** Add, Embed Code, Embed HTML, Code, paste, Apply.
- **Squarespace:** Code block, paste (Display Source off). Plan limits on code blocks are Squarespace's.
- **Plain HTML:** paste where the schedule should appear.
- If a builder blocks iframes, use the plain link (copy button) to the public class list or class page.

## QA matrix

Environment: isolated local stack (`iso-qa up baseline`, real Postgres + PostgREST + Kong, fixtures from the GC-3.4A suite), `next build && next start` on :3100, host pages on a different origin (:4000), in-app browser. "Actual" means executed against that stack.

| Workflow | Execution | Expected | Observed | Result |
|---|---|---|---|---|
| Option validation, hostile params, dates, accent contrast | vitest (unit) | defaults on bad input; no rollover; 6-digit hex only | 12 tests | PASS |
| Calendar math: studio-zone day, month/week grids, boundaries | vitest (unit) | LA 03:30Z is the previous day; Nov 2026 = 5 weeks, Aug 2026 = 6 | pass | PASS |
| Framing headers: embed routes frameable, all others protected | vitest + actual HTTP | only the two prefixes lack X-Frame-Options | curl on prod build: embed 200 without XFO, `/studios/.../classes` has SAMEORIGIN + `frame-ancestors 'self'` | PASS |
| Published vs unpublished class | actual HTTP | published 200; unpublished/no-policy 404 | 4001 200; 4003, 4007 404 | PASS |
| Cancelled, past, full class | actual HTTP | labelled; no Register button | Cancelled / already taken place / Class full | PASS |
| Private lesson, private studio, unknown ids | actual HTTP | 404 | 400a, 4008, 4099 404; private calendar 404 | PASS |
| No leakage of notes, client names, hidden instructor, non-public classes | actual HTTP body scan | none present | no matches | PASS |
| XSS / injection via query params | actual HTTP | no reflected markup | `<script>` payload absent | PASS |
| Cross-origin host page, auto-resize | actual browser | frame renders and grows | heights 530 and 342 received and applied | PASS |
| Host with strict CSP (frame-src allow-list, no inline style) | actual browser | still renders | rendered after switching sizing to attributes (first attempt failed, fixed) | PASS |
| Host that forbids all frames | actual browser | cannot render | blank frame; fallback link must be used | PASS (documented limit) |
| Mobile 375px month view | actual browser | readable day list | list renders, no horizontal scroll | PASS |
| In-frame view switch, history back/forward | actual browser | URL and view follow history | `?view=week` then back to `""` then forward to week | PASS |
| Register button goes to existing flow, new tab | code review + link href | `/studios/.../register`, `target=_blank` | href verified by markup | PASS (link only) |
| Real registration and Stripe checkout from the embed | not executed | existing flow unchanged | no Stripe TEST harness used | BLOCKED |
| Studio builder page: owner sees it; instructor and other-studio staff are turned away | actual browser (Playwright, real GoTrue sessions, local stack) | owner/admin only | instructor and other-studio instructor land on /app without the builder; owner sees it | PASS |
| Builder: class dropdown, options in code, hostile accent, copy, live preview | actual browser | only public upcoming classes; options reflected; hostile accent never reaches the code; clipboard equals the textarea; preview renders | 5 public occurrences listed (private lessons absent); `view=week&theme=dark&accent=cc3366` in the code; `red;</style>` dropped; copy matched; preview rendered classes | PASS |
| Recurring class display | actual HTTP, 4-week series fixture | "Part of a recurring class" + link to the series page | text shown; link `/studios/<slug>/classes/series/<id>` returns 200 | PASS |
| Capacity change reflected | actual HTTP, DB update between requests | live read | capacity 3 with 2 booked shows "1 spot left"; set to 2 shows "Class full" and no Register button; the database refuses a capacity below the booked count (`GCSC3_CAPACITY_BELOW_BOOKED`) | PASS |
| Register link hands off to the existing flow | actual HTTP | login with the destination preserved for a signed-out visitor | 307 to `/login?intent=public&next=/studios/<slug>/classes/<id>/register` | PASS (handoff only) |
| Authentication return: magic link from the register redirect | actual browser, local GoTrue + mail catcher | visitor lands back on the register page after signing in | link redirect carries `next`; final URL is the register page; page asks "Confirm your email to continue" (existing safeguard) | PASS |
| Full class cannot be registered, even by direct URL | actual browser | no Register link in the embed; register page refuses | "Registration isn't available. This class is full." with no checkout control | PASS |
| Public events in the calendar | actual HTTP, seeded events | public published events only, each day of a multi-day event, link to the event page | 2 public events shown (Nov 20; Nov 28-30 on three days); private event, draft event and another studio's event absent; month cells link `/events/<slug>` | PASS |
| Events off / instructor filter | actual browser + HTTP | events disappear | calendar title and rows drop events; instructor filter shows classes only | PASS |
| Class description and price (opt-in) | actual browser + HTTP | hidden by default; shown after the studio enables them; price only for direct-payment classes | default hidden; after enabling: "Price $20" and the series description on the class embed and calendar rows; a class with its own direct price shows "$25" | PASS |
| Stored defaults | actual browser | URL silent: stored view/background/color apply; explicit URL option wins; builder code omits options equal to stored defaults | stored month/dark/#cc3366 applied to a bare URL; `?view=agenda&theme=light` overrides; bad accent rejected with fixed copy and nothing saved | PASS |
| Kill switch | actual browser + HTTP | embeds off: 404 for calendar and class embeds, no studio detail, public pages unaffected, other studios unaffected, back on after re-enabling | all as expected; builder shows "switched off" notice | PASS |
| Kill switch fails closed | actual HTTP, settings function renamed | 404 when settings cannot be read | calendar 404, class 404; restored: 200 | PASS |
| Settings authorization | SQL suite (27 checks) + browser | owner/admin of the studio only; instructors, other studios' owners and signed-out callers refused; table not reachable by API roles | `test_T_website_embed_settings.sql` PASS (27 checks); instructor cannot open the builder | PASS |
| Unit tests (settings, events, extras, options) | vitest | parsers strict; queries select no private columns; fail closed | `embed.settingsEventsExtras.test.ts` + existing embed tests: 227 passing in `src/lib/public/__tests__` | PASS |
| Repeatable acceptance run | `scripts/qa/embeds/acceptance.mjs` (Playwright, real GoTrue sessions, disposable stack; creates its own fixtures) | all builder, settings, events, price/description, kill-switch and handoff checks pass without manual interpretation | 43 of 43 checks PASS in one run | PASS |
| Registration handoff through the confirmed-email state | same script, local stack with the launch-sec 1C-A migration | signed out → login with `next` → magic link → "Confirm your email" step → confirmed-email link (built as `sendEmailVerificationLink` builds it; the local stack has no email provider) → "Your email is verified" → back on the class register page → existing eligibility check runs | reaches "Online payment isn't available" because the local studio has no connected payment account (correct fail-closed); no checkout started | PASS (checkout itself NOT executed: no Stripe operation authorized) |
| Migration/application ordering and rollback | disposable DB with the app running | rollback script drops everything and is repeatable; app deployed before the SQL (or SQL rolled back) fails closed; re-apply works and is repeatable | after rollback embeds are 404 and public pages 200; re-apply restores embeds (settings back to defaults: on); both scripts ran twice cleanly | PASS |
| Hosted DEV/PROD with the migration | not executed | n/a | no hosted SQL authorized | BLOCKED |
| Month grid on desktop, dark theme, custom accent | actual browser | grid with classes on correct days, today ring | renders (P1/P2 on 17/18, P6 on 21, P9 on 24) | PASS |
| Week view on desktop; many-classes density | actual browser + HTTP | renders; busy day lists every class | desktop week screenshot correct; 9 classes on one day all listed in week and month | PASS |

### Security review (2026-11-13)

Reviewed against the running app: response headers, the pasted snippet, the frame wrapper and the builder.

- **Framing:** only `/embed/class/*` and `/embed/calendar/*` send `frame-ancestors *`; other pages still send `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` (checked on the live responses). Embedding the page is clickjack-safe in practice: it has no form and no state-changing control, only links that open DanceFlow in a new tab (`rel=noopener`).
- **CSP on embeds:** no `unsafe-eval`; `connect-src 'self'`, `frame-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'none'`. Residual: `script-src` keeps `'unsafe-inline'` because Next.js emits inline hydration scripts. Mitigation: all studio-supplied text is rendered by React (escaped) and no embed renders raw HTML. A nonce-based CSP would remove the residual; it is a framework-level change, not part of v1.
- **Images:** `img-src https:` allows studio logos and instructor photos. Accepted: images cannot run code, and the embed holds no secret a tracking pixel could leak.
- **postMessage:** the embed sends a height number to `*` (nothing else crosses the frame). The pasted listener ignores any sender that is not its own iframe window or the DanceFlow origin, and clamps the value. The origin in the snippet is a code constant, not a request value, so it cannot be injected through a Host header.
- **Snippet escaping:** `src` and `title` go through `escapeAttr`; the element id is a hash of the path.
- **Builder access:** owner and admin only; verified with real sessions that an instructor and another studio's staff cannot open it.
- **Result:** no defects found; no code change needed.

### Decision: unrestricted framing for v1 (2026-11-13)

Any website may frame the two embed routes; there is no allowed-origins list in v1.

- **Why it is acceptable:** the embeds show only data that is already public on DanceFlow's own pages (public classes, public events, and the opt-in description and price). They read no cookie or session, hold no secret, contain no form (`form-action 'none'`) and no state-changing control; every action is a link that opens DanceFlow in a new tab. Framing therefore gives a hostile site nothing it could not already copy from the public pages, and clickjacking has nothing to hijack.
- **Why not an allowlist now:** studios host on site builders with unpredictable origins (including preview and staging URLs), a wrong or missing entry would silently break a studio's published site, and there is no demonstrated abuse or requirement. An allowlist is also not a data-protection control for public content.
- **Control we do ship:** the per-studio kill switch (404 everywhere, effective at once) lets a studio revoke every embed if one is misused.
- **Revisit when:** an embed gains any personalised or state-changing content, a studio reports misuse of its embed on a site it does not control, or a requirement for per-site restriction appears.

### Release ordering and rollback

1. Owner-authorized: apply `20270216090000_website_embed_settings.sql` to DEV, verify, then PROD. (`sql-tests/test_T_website_embed_settings.sql` is for disposable databases only: it refuses to run unless `embedtest.local='on'`.)
2. Only then deploy the app. The app deployed first (or the SQL rolled back) fails closed: every embed is 404; public pages and the rest of the app are unaffected; the builder says settings are unavailable.
3. Rollback: roll the app back first, then run `rollback/20270216090000_website_embed_settings_rollback.sql`. Rollback deletes stored settings; a later re-apply starts every studio at the defaults (embeds on, no description/price, events on).

## Known gaps and follow-ups

1. **Hosted SQL not applied (release gate).** `20270216090000_website_embed_settings.sql` is Git-only. Class descriptions and prices, the settings panel and the kill switch need it applied to DEV and PROD first (owner-authorized, SQL before app). Rollback file: `rollback/20270216090000_website_embed_settings_rollback.sql`. Without it, embeds fail closed and the settings panel says so.
2. **Single (non-series) classes have no description.** There is no description column for them; adding one is a separate product decision.
3. **Allowed origins** (restricting which websites may frame an embed) is not implemented. The kill switch is per studio, not per website. `frame-ancestors *` stays; the embeds carry no state-changing control.
4. **Public listings are future-only and capped at 100 occurrences** (`limit`), so past months are empty and very busy studios see the next 100. Events are capped at 40.
5. **Real registration and Stripe checkout from the embed** were not executed (no payment or provider operation is authorized); the handoff up to the existing register page is verified below.
6. Marketing page: not published; wait for the release requirements and the BLOCKED rows above.
