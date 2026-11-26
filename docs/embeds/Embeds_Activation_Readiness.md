# Website Embeds: smallest safe activation (pilot)

2026-11-18, written from `main` `793ef6439` and the `origin/release/website-embeds` line (head `6ba312957`). Scope: how to turn Website Embeds on for **one pilot studio and one embed type** on PRODUCTION, with exact steps, what the studio owner sees, smoke tests, pass criteria, monitoring and rollback. It changes nothing: no env, deploy, SQL or production request was made to write it. Read with `Release_Readiness.md` (main) and `Release_Candidate_Path_B.md` (on `origin/release/website-embeds`; it is not on main). Facts are marked **V** (verified from code or a repository document, source cited) or **A** (assumed, or not checkable from the repository: confirm before relying on it).

## 1. Where things stand

| Fact | Mark | Source |
|---|---|---|
| Embeds ship **dark**: nothing is served, listed or savable until the server environment has `WEBSITE_EMBEDS=on` (case-insensitive after trim; any other value, including `true` and `1`, is off) | V | `src/lib/public/embedSettings.ts:35-37`; unit test per `Release_Readiness.md` section 3 |
| The release line is `release/website-embeds` = live base `c0172455` + #469 + the gate + docs, plus later commits on the live line (head `6ba312957`, #637 TW-4F sweep) | V | `Release_Candidate_Path_B.md` sections 1-2; `git log origin/release/website-embeds` |
| The code is on the release line and on `main` | V | same files in both (`embedSettings.ts` byte-identical) |
| The embeds are live on PRODUCTION in the **dark** state, i.e. a deployment containing them is promoted with `WEBSITE_EMBEDS` unset | **A** (stated by the coordinator; the repository cannot show what Vercel serves) | confirm: the production deployment's source commit contains `6756b8e3` (#469) and `b37342e3` (gate); the embed URLs return 404 (step 0 below) |
| The migration `20270216090000_website_embed_settings.sql` is applied on PRODUCTION | **A** (as of 2026-11-14 it was not: `Release_Readiness.md` header; nothing since is recorded in the repository) | confirm with the read-only `scripts/qa/embeds/postflight.sql` through `sb.sh prod-read` (must return `"all_ok": true`) |
| Without the migration, an enabled app fails closed: every embed 404, the builder says settings are unavailable | V | `Release_Readiness.md` section 3 layer 3; `fetchEmbedGate` returns `unavailable` on a database error (`embedSettings.ts:80-92`) |

**If the migration is absent, applying it is the first activation step and it is an owner-approved PROD SQL apply** (hash `2ddcb78b988b91c955b0dd3cc1cb7891f0343262c68965f3b3b9d50031b53991`, `Release_Readiness.md` section 1). It is additive (one RLS table, five functions).

## 2. Two things the code settles that the earlier docs leave open

### 2.1 Does turning the flag on need a redeploy? Yes, and no new code.

- **V:** the flag is read at request time on the server: `websiteEmbedsAvailable(env = process.env)` (`embedSettings.ts:35`), called from the embed gate `fetchEmbedGate` (`embedSettings.ts:85`), the builder page (`src/app/app/settings/embeds/page.tsx:25`), the save action (`src/app/app/settings/embeds/actions.ts:15`) and the Settings menu item (`src/app/app/layout.tsx:700` (line numbers are from main; the release line differs by a few lines)). Both embed pages are `export const dynamic = "force-dynamic"` (`src/app/embed/calendar/[studioSlug]/page.tsx:41`; class page line 29), so no static or cached copy of an "off" answer can survive.
- **V:** it is not a `NEXT_PUBLIC_*` variable, so it is not inlined into a bundle at build time; no rebuild of the source is needed.
- **A (Vercel platform behaviour, not in this repository):** a changed environment variable applies only to deployments created after the change; an already-running deployment keeps the value it started with. `Release_Readiness.md` section 3 says the same ("a Vercel environment change plus a new deployment"). So: set the variable, create a new deployment (a **Redeploy** of the current production deployment from the Vercel dashboard re-uses the build and picks up the new environment, or a new build of the same commit), and because `danceflow-app-qfem` has `autoAssignCustomDomains=false` and ignores production builds from `main` (`Release_Readiness.md` section 3 layer 1), that new deployment is a preview until it is **promoted** (`vercel promote`). Both the environment change and the promotion are owner actions.
- **Per-studio settings alone cannot activate anything.** The studio kill switch only matters once the global flag is on (the gate returns before any database call otherwise, `embedSettings.ts:85`). So the activation always includes the global flag.

### 2.2 A pilot cannot be confined to one studio by code. Decide this explicitly.

- **V:** the per-studio switch defaults to **on**: the table column is `embeds_enabled boolean not null default true` (`src/lib/supabase/migrations/20270216090000_website_embed_settings.sql:21`) and the public function answers `coalesce(s.embeds_enabled, true)` for a studio with no row (same file, line 67). A studio never opens the builder and never saves anything: its embeds are enabled the moment the global flag is on.
- **V:** what an embed can show is bounded by existing public data: only `publicly_discoverable` classes of a studio with `public_directory_enabled = true` and subscription `active` or `trialing`, read through the existing public read model; description and price stay off unless the studio turns them on; private lessons, client names and staff notes are not in the model (`Website_Embeds.md` "Architecture" and "Security model"; calendar page lines 64-68). The product decision of 2026-11-13 accepts unrestricted framing because it exposes nothing that is not already public (`Website_Embeds.md` "Decision: unrestricted framing for v1").
- **So when the flag goes on, the embed URL of every public active studio becomes servable** (and framable by any website), not only the pilot's. In practice only a studio that pastes its snippet on a site uses it, and the data equals its public classes page.
- **Options for the owner (decision E1):** (a) **accept it** (recommended: it matches the recorded security decision and the data is already public); (b) before activation, set `embeds_enabled=false` for every other studio (a PROD data write across studios: not recommended, large and reversible only by another write); (c) a small code and SQL change making a studio with no row default **off** and requiring an explicit "turn on" in the builder (a product change, a new migration, its own review; not needed for a safe pilot if (a) is accepted). Whichever is chosen, the pilot **studio** and the pilot **embed type** below are what the owner tells the world about; the platform setting is global.

## 3. The smallest safe activation

- **One pilot studio:** owner-nominated; it must have `public_directory_enabled` on, subscription `active` or `trialing`, a slug, and at least one `publicly_discoverable` group class (these are exactly the conditions in `src/app/app/settings/embeds/page.tsx:37` and the calendar page). **A:** confirm each on PRODUCTION data before the day.
- **One embed type:** the **studio calendar** (`/embed/calendar/<studioSlug>`). It is one URL, needs no class id, and updates itself. Do not announce the single-class embed or events in the calendar for the pilot (the events toggle defaults to on per studio, `public_studio_embed_settings` `coalesce(s.show_events, true)`; if the pilot studio does not want its public events shown, it turns that off in the builder first).
- **Registration handoff is a link** to the existing registration flow in a new tab; no embed contains a form (`form-action 'none'`), and real Stripe checkout from an embed has never been exercised (`Release_Readiness.md` section 5 row C, decision D3). For the pilot, tell the studio that registering from the embedded page is not part of the pilot test, or accept D3.

### Exact steps (each hosted step is an owner approval; nothing here is authorized yet)

0. **Baseline, read-only, no approval needed beyond the usual:** from outside, `GET https://www.idanceflow.com/embed/calendar/<pilot slug>` must be **404** (dark). `GET /login` must carry `X-Frame-Options: SAMEORIGIN`. Record both. (If the calendar already answers 200, the flag is already on: stop and tell the owner.)
1. **Confirm the database:** `sb.sh prod-read scripts/qa/embeds/postflight.sql` returns `"all_ok": true`. If it does not and `prod-preflight.sql` returns `"ready": true`, the migration is absent: get owner approval of hash `2ddcb78b…`, `sb.sh prod-apply` it, re-run the postflight. (Running app unaffected: nothing reads the table while dark.)
2. **Confirm the deployment:** the live production deployment's commit contains the gate (`b37342e3`); `GET /embed/calendar/<slug>` is 404 for the right reason (dark), not because the code is absent. **A:** on the release line this is the case; confirm in the Vercel deployment record.
3. **Owner sets `WEBSITE_EMBEDS=on`** in the `danceflow-app-qfem` production environment, then **redeploys** (new deployment, same commit), and checks the preview deployment URL before promotion with the same smoke tests (section 5, "pre-promotion"). **Owner promotes** (`vercel promote`). Record the new and the previous deployment ids (the previous one is the rollback target).
4. **Studio owner enables and installs** (section 4). Run the post-activation smoke (section 5) on the live domain.
5. **Observation window**, at least 30 minutes after promotion, then a check the next day (section 6). Only then tell the studio it can publish the page.

## 4. What the studio owner sees and does

(V: `src/app/app/settings/embeds/*`; `Website_Embeds.md`.)

1. Signed in as the studio **owner or admin** (instructors and other roles are turned away: `requireStudioRole(["studio_owner","studio_admin"])`, `page.tsx:26`, `actions.ts:16`). Once the flag is on, **Settings** shows **Website Embeds** (`layout.tsx:700` on main). Before, there is no menu item and the page is not found.
2. The page explains that classes shown on the website follow DanceFlow automatically and that dancers register through DanceFlow. If the studio is not public or not active it says so and the picker is empty.
3. Choose **Studio calendar**; the builder previews it and produces the embed code with the install guide. Choices: starting view (list, week, month), light or dark background, button colour (`#rrggbb`), show events, show class description, show class price (the last two default **off**).
4. **Embeds on / off:** a switch. Off saves "Your embeds are now off and show nothing on your website" (`actions.ts` message); every embed of that studio answers 404 at once.
5. Copy the snippet and paste it into the studio's website page. The embed posts its height to the page so the frame resizes; it needs no other setup. Dancers who tap Register land on DanceFlow in a new tab.

## 5. Smoke tests on the live domain

All requests are anonymous `GET`/`HEAD`; none writes. Use `curl -sI` for headers. `<slug>` is the pilot studio's slug, `<private-slug>` a studio that is not in the public directory, `<class-id>` an id of a public class of the pilot studio.

**Pre-promotion** (on the new deployment's own preview URL, flag on) and **post-activation** (live domain), same list:

| # | Request | Expected | Fails closed when |
|---|---|---|---|
| S1 | `GET /embed/calendar/<slug>` | 200; response has `Content-Security-Policy` containing `frame-ancestors *` and **no** `X-Frame-Options` header | flag off or migration absent: 404 |
| S2 | `GET /embed/calendar/<slug>?view=week&theme=dark&accent=%23123456` | 200, options applied; `accent=<script>` or a non-hex value is ignored, not reflected | - |
| S3 | `GET /embed/class/<class-id>` | 200 for a public class; the same framing headers | non-public, private-lesson, other-studio, cancelled/unknown id: 404 |
| S4 | `GET /embed/calendar/<private-slug>` and `GET /embed/calendar/does-not-exist` | 404 both, identical body (no existence leak) | - |
| S5 | `GET /embed/class/not-a-uuid` | 404, no server error | - |
| S6 | `GET /login`, `GET /` and one `/app/...` path (follows to login) | still `X-Frame-Options: SAMEORIGIN` and the original CSP with `frame-ancestors 'self'`; **no** `frame-ancestors *` anywhere outside `/embed/class/*` and `/embed/calendar/*` | any other path carrying `frame-ancestors *` is a **rollback trigger** (`next.config.ts:45-48,79-89`: the global header set excludes exactly those two prefixes) |
| S7 | Body of S1 | contains no private lesson, client name, email, phone, staff note, price or class description unless the studio turned that on | any such content is a **rollback trigger** |
| S8 | Embed in a real iframe on a test page the engineer controls (not the studio's live site), then resize | renders, height follows content, Register opens a new tab on DanceFlow | - |
| S9 | **Kill switch round trip** (studio owner, in the builder): switch embeds off, reload S1 | 404 within seconds; other studios' embeds unaffected; switch on, S1 returns 200 | - |
| S10 | Pre-existing event widget untouched: `GET /embed/events.js` and `GET /api/embed/studios/<slug>/events` | unchanged from before activation. **V:** these are older routes, not gated by `WEBSITE_EMBEDS` (grep: the flag appears only in `embedSettings.ts`, the builder page, the save action and `layout.tsx`); `/embed/events.js/route.ts` serves a static script with `Access-Control-Allow-Origin: *` | do not read their behaviour as evidence about the flag |

**Dark-state check before activation (run in step 0, and re-run if the flag is turned off again):** S1, S3 return 404; S6 unchanged; builder not reachable.

Scripts that exist for the stronger versions of these checks (disposable stack or DEV only, never PROD): `scripts/qa/embeds/flag-off-check.mjs` (4 dark checks), `scripts/qa/embeds/acceptance.mjs` (44 checks, flag on), `scripts/qa/embeds/dev/` (DEV-connected validation). **V:** results recorded: DEV 44/44 and disposable stack 44/44 with the flag on, 4/4 dark (`Release_Readiness.md` section 5). **Not tested by anything:** real Stripe checkout from an embed, a third-party site framing the iframe, PROD data volumes (section 5 row C; decision D3).

## 6. Measurable pass criteria

All of the following, for the pilot to count as passed:

1. S1 to S9 pass on the live domain after promotion; S6 unchanged for every non-embed path checked.
2. S1 returns 404 again within one minute of the kill switch being turned off and 200 within one minute of turning it on (S9).
3. During the 30-minute observation window and the next-day check: **zero 5xx** on `/embed/*` and `/app/settings/embeds`; no increase in the overall 5xx rate or in error logs of the cron and webhook routes compared with the 30 minutes before promotion; no `Embed settings save failed:` log lines other than a deliberate test.
4. The studio's own page shows its real classes, in the studio's time zone label, and a class edited in DanceFlow appears in the embed on reload.
5. No report from the studio or a dancer of wrong or private content.

Any rollback trigger in S6 or S7, any 5xx on `/embed/*` that is not explained, or any 5xx increase elsewhere: roll back (section 8) first, diagnose after.

## 7. Monitoring

- **A:** Vercel runtime logs for `danceflow-app-qfem` production, filtered to path `/embed/` and `/app/settings/embeds`: status 5xx, and the ratio of 404 to 200 (a sudden 404 on a pilot URL means the flag or the studio switch went off, or the migration is missing).
- **V:** the only server log line the feature adds is `Embed settings save failed:` with the database error code (`actions.ts`), on a failed save.
- **V:** embeds are `noindex` (`metadata` in both embed pages), so they do not enter search results from DanceFlow's side.
- **A:** compare the overall error rate and the cron/webhook route logs with the 30 minutes before promotion; the promotion replaces the whole deployment, not just the embed routes.
- Read-only database check any time: `sb.sh prod-read scripts/qa/embeds/postflight.sql` (`all_ok`).

## 8. Rollback (ordered, smallest first)

| Need | Action | Effect | Who |
|---|---|---|---|
| One studio's embeds off | The studio (or its admin) switches **Embeds off** in the builder | that studio's embeds 404 at once; all else unchanged | studio owner/admin |
| Everything off, fastest | **Promote the previous production deployment** (recorded in step 3; for the pre-activation state this is the dark deployment) | the whole feature is dark again (a deployment with the flag unset serves 404 on the embeds, no menu item) | owner |
| Everything off, same code | Remove `WEBSITE_EMBEDS` (or set it to anything but `on`) in the production environment and **redeploy then promote** | dark again; the environment change alone does nothing to the running deployment (**A**, section 2.1) | owner |
| App code problem unrelated to the flag | Promote the previous deployment, as above; for the release line the recorded target was `dpl_FEzqXu6NEtBejTk5vQQMB8jszcEX` (`c0172455`) before the later commits, so use the **deployment id recorded immediately before this promotion**, not that one, unless that is what was live | - | owner |
| Database | Only if needed afterwards: `rollback/20270216090000_website_embed_settings_rollback.sql` (hash `d32a7bca…`): it **deletes stored studio settings**; a later re-apply starts every studio at the defaults (embeds on, no description or price, events on). Never run it while an enabled deployment is live (embeds would 404, which is safe, but the builder would error) | - | owner approval |

The migration is additive, so rolling the app back with the table left in place is safe (`Release_Candidate_Path_B.md` section 7).

## 9. Owner decision versus engineering

**Needs the owner:** nominate the pilot studio and tell it; accept or change the global-default behaviour (E1, section 2.2); approve the PROD migration apply if it is not applied; set `WEBSITE_EMBEDS=on` in the production environment; redeploy and promote; accept the registration/Stripe residual (D3) for the pilot or ask for Stripe TEST evidence first; approve any `release/**` change (one owner approval under CODEOWNERS).

**Engineering can do alone (no production change):** read-only checks (route probes in step 0, `sb.sh prod-read` of the postflight, comparing the live deployment's commit with the release line); keep the docs and smoke scripts current; write the S1 to S10 commands into a runnable script that only issues `GET`/`HEAD`; prepare option (c) of E1 as a separate reviewed change if the owner wants a default-off studio setting. **Never without approval:** set or change an environment variable, redeploy or promote, apply SQL, or point the disposable-stack scripts at PRODUCTION.

## 10. Open items to close before the day

| Item | Mark | How |
|---|---|---|
| Embeds live dark on PRODUCTION | A | step 0 and the Vercel deployment record |
| Migration `20270216090000` applied on PRODUCTION | A | `sb.sh prod-read` postflight |
| The pilot studio meets the public/active/class conditions on PRODUCTION | A | owner's studio list; the builder page states it |
| `release/website-embeds` head equals what is live | A | compare the deployment's commit with `origin/release/website-embeds` |
| Vercel env-change-needs-new-deployment behaviour | A (platform) | confirmed by `Release_Readiness.md` section 3; observe it in the preview deployment before promoting |
| E1 (global default on) | owner decision | section 2.2 |
| D3 (no real Stripe checkout from an embed was run) | owner decision | `Release_Readiness.md` sections 5 and 6 |
