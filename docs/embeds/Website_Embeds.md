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

Not in v1 (follow-ups, see below): events in the calendar, class description and price, stored per-studio embed settings / kill switch.

## Architecture

- **Stateless iframes.** An embed URL carries only appearance options (`accent`, `theme`, `view`, `instructor`, `date`), each validated against a strict allow-list in `parseEmbedOptions`. No new table, no SQL.
- **One data source.** Both embeds read only through the existing public read model, `public_group_class_occurrences` (see `20261024090000_gc34a_public_group_class_read_model.sql`). A class is public only if its enrollment policy is `publicly_discoverable`, the studio is in the public directory and active/trialing; instructor names appear only for instructors with a public profile. Embeds never read `appointments` directly and use no service-role client.
- **Studio control.** The existing per-class "publicly discoverable" setting plus the studio's public-directory setting decide what any embed can show. The builder lists exactly what an embed can display.
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

## Known gaps and follow-ups

1. **Class description and price are not shown.** They are not in the public read model's output (`public_group_class_occurrences`) and the existing public class page does not show them either. Adding them needs a small migration of the public function (PROD-SQL-gated, owner approval) or a new public RPC.
2. **Events in the calendar** (public events table) are not included yet; reuse `eventTiming.ts` and the events embed API logic.
3. **Stored embed settings / kill switch / allowed origins** would need a table and migration. Today the only controls are making classes non-public or the studio non-public.
4. **Public listings are future-only and capped at 100 occurrences** (`limit`), so past months are empty and very busy studios see the next 100.
5. Marketing page: not published; wait for items 1, 2 and the BLOCKED rows above.
