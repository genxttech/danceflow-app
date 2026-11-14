# Website Embeds: Path B release candidate (`release/website-embeds`), prepared 2026-11-14

Status: **candidate prepared, nothing applied to PROD, nothing deployed or promoted, feature dark.** Owner decision D1 = Path B. Every hosted step below needs its own approval.

## 1. Live-base verification

- Live www (`www.idanceflow.com`, `idanceflow.com` redirects to it) is Vercel project `danceflow-app-qfem` deployment `dpl_FEzqXu6NEtBejTk5vQQMB8jszcEX`: target production, READY, promoted, source `cli`, deployment metadata `gitCommitSha c01724551708da0859e8cb7e253a2d01f3cc4393` (branch `claude/tw4f-price-monitor-schedule`).
- Because the source is a CLI upload, the metadata alone could be stale, so the deployed file tree was compared with git: **3386 of 3386 uploaded files are byte-identical (SHA-1 of contents) to the tree of `c0172455`**; the only differences are three `.gitignore` files not uploaded and a generated `tsconfig.tsbuildinfo`. The mapping live = `c0172455` is established.
- `release/website-embeds` was created from `c0172455`; nothing else from main was merged.

## 2. Included commits (cherry-picked in order with `-x`, no conflicts)

| Release commit | Main commit | Content |
|---|---|---|
| 6756b8e3 | b739e1dd #469 | Website Embeds v1: embed routes, builder, headers, migration, tests |
| 47e9ed71 | 07422c62 #482 | QA correction: acceptance waits for navigation after the verified-email Continue link |
| ef1d372c | 5e90d5bb #484 | read-only postflight, docs |
| 60fa0ecc | 44fc834c #486 | DEV procedure and fictional fixtures (scripts only) |
| 913f8f83 | 88b2ec1f #488 | docs (DEV application record) |
| 1ff2258a | 62bc2fc4 #490 | DEV validation scripts (not part of the app) |
| fd8e1ab6 | cdf4c9d0 #491 | docs |
| b37342e3 | 32c5c9f6 #493 | dark gate `WEBSITE_EMBEDS=on`, PROD preflight, flag-off check, docs |
| 818b366f | a12c1fd7 #494 | docs (SQL ordering) |

Excluded on purpose: everything else in the 189 commits main is ahead of live (Competition, TW-4F, financial, Student/Business apps, staff API).

## 3. Scoped diff against live (36 files)

Application code (the only runtime-affecting files):
- `next.config.ts` (modified): header rules. The global header set now applies to every path **except** `/embed/class/*` and `/embed/calendar/*`, which get their own set (`frame-ancestors *`, `form-action 'none'`, `connect-src 'self'`, `frame-src 'none'`). This header change is **not** behind the flag, so it was verified directly (section 5): every other page keeps `X-Frame-Options: SAMEORIGIN` and the original CSP, byte for byte.
- `src/app/app/layout.tsx` (modified): one import and one menu item shown only when `WEBSITE_EMBEDS=on`.
- New, all gated (404 / refusal when the flag is off): `src/app/embed/calendar/[studioSlug]/page.tsx`, `src/app/embed/class/[appointmentId]/page.tsx`, `src/components/embed/EmbedFrame.tsx`, `src/app/app/settings/embeds/{page,actions,EmbedBuilder,EmbedSettingsPanel}.tsx*`, `src/lib/public/{embedCalendar,embedClassExtras,embedEvents,embedOptions,embedSettings}.ts`.

Database: `src/lib/supabase/migrations/20270216090000_website_embed_settings.sql` and its rollback (additive: one RLS-protected table, five functions; nothing altered) plus an SQL test.

Tests, scripts and docs only: 3 vitest files, `scripts/qa/embeds/**`, `docs/embeds/**`.

Untouched: registration, payments, Stripe, billing, auth, Twilio/SMS, Competition, pricing, cron, monitoring, refunds, environment configuration. Competition dark gates, TW-4F pricing/SMS restrictions, the price monitor and refund safeguards are byte-identical to live because no file under their paths differs.

## 4. Production schema compatibility (migration not yet applied)

- The app tolerates the migration being absent: embed pages and the builder fail closed (404 / "settings unavailable") if the table or functions are missing, and with the flag off they do no database call at all.
- Dependencies of the migration: tables `studios`, `appointments`, `group_class_series`, `group_class_enrollment_policies`, `user_studio_roles`, `events`, type `appointment_type`, and 24 columns. All are created by migrations Sept to Oct 2026 (GC-3, GCS-1, events, org suite) that are in the live-base tree and long released. `scripts/qa/embeds/prod-preflight.sql` checks each of them and that the target is absent. It was run on a disposable stack built from the live-base schema lineage and returned `ready: true`; **it has not been run on PROD (not authorized)**.
- Migration SHA-256 `2ddcb78b988b91c955b0dd3cc1cb7891f0343262c68965f3b3b9d50031b53991` (identical bytes on main, DEV and this branch). Rollback SHA-256 `d32a7bca5da22a138600f8421cf5536af9d1d776145ad4dc7e72cbfafa420264`. Preflight `aa5278c73dcaa7d3fb11ed63ca7bef2295b44e8c47d4609b2d2ae6db6640b46a`, postflight `9b07e74d5e019a81f2d2309c070e3afd1f930d5a3896c961f986d047f4b2be05`.
- Independent of the Competition migrations JC1 `20270215092000`, U18 `20270215093000`, U18-S `20270215094000`. They are **not** applied or implied by this release.

## 5. Test evidence (production build of this branch, disposable local stack, no hosted resource)

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| eslint (embed areas, layout, next.config) | clean |
| vitest `src/lib/public` | 15 files, 228 tests pass |
| vitest full suite | 9735 pass; 13 tests in 10 files timed out under full-suite load (source-scan guards, 5 s default) and all 211 tests of those files pass in isolation (60 s timeout) |
| Build `next build` | passes |
| Gate **off** (release default): calendar and class embeds 404, builder not found, no menu item (`flag-off-check.mjs`) | 4/4 PASS |
| Gate off: `/login` still `X-Frame-Options: SAMEORIGIN` and original CSP `frame-ancestors 'self'` | PASS (unchanged from live) |
| Gate **on**: 44-check browser acceptance (embeds, builder, kill switch, handoff, email proof, eligibility stop, no Stripe page) | 44/44 PASS |
| Migration apply, postflight on the stack | `all_ok: true` |

Stack caveat: the baseline stack cannot replay LAUNCH-SEC-1C-A/1C-B (listed known-unreplayable), so 1C-A was applied to it by hand (1C-B cannot apply there). The email-proof flow therefore ran against 1C-A only; it is live's own unchanged code. A first acceptance run failed 3 checks for exactly that reason (missing functions on the stack), not an app defect.

Still untested by anything: real Stripe checkout from an embed; a third-party site framing the iframe; PROD data volumes.

## 6. Staged deployment and release sequence (each hosted step needs owner approval)

0. Publish the branch (App credential helper; never merged into main). `release/**` changes need one owner approval under CODEOWNERS before the candidate is built.
1. PROD preflight: `sb.sh prod-read scripts/qa/embeds/prod-preflight.sql` must show `"ready": true`; repeat immediately before apply.
2. Owner approves migration hash `2ddcb78b…`; `sb.sh prod-apply` the migration; `sb.sh prod-read postflight.sql` must show `all_ok`. Running app unaffected.
3. Build a **staged, non-domain** deployment from the branch head (qfem preview build; `WEBSITE_EMBEDS` unset). Staged checks: embed routes 404; no menu item; `/login` headers unchanged; ordinary pages, cron/webhook routes and Competition/TW-4F dark behaviour unchanged vs live; smoke. Owner approves promotion; `vercel promote`.
4. Observation window (30 min minimum): errors, 5xx rate, webhook/cron logs.
5. Separate owner decision: `WEBSITE_EMBEDS=on` + redeploy, then post-activation smoke on a studio the owner nominates (kill switch round trip).

## 7. Rollback

- **Target: `dpl_FEzqXu6NEtBejTk5vQQMB8jszcEX`** (current live, `c0172455`). App first: `vercel rollback` / promote that deployment (also darkens the feature). Only if needed afterwards: run the rollback SQL (deletes stored embed settings; nothing else depends on the table). Never roll the SQL back while an enabled app is live.
- The migration is additive, so rolling the app back while leaving the table in place is safe.

## 8. Owner decisions at the next gate

Approve the release PR (one owner approval); approve the PROD preflight read; approve migration apply (hash above); approve promotion; later and separately, activation. D3 (accepting the registration/Stripe residual before activation) is only needed before activation.
