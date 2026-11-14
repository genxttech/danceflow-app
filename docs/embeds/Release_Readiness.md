# Website Embeds: production release readiness (prepared 2026-11-14)

Status: prepared, **nothing applied to PROD, nothing deployed or promoted, feature not active**. Every PROD step below needs its own owner approval.

## 1. What would be released

| Item | Value |
|---|---|
| Feature commits on main | #469 `b739e1dd` (feature), release gate PR (see section 3; dark by default) |
| Migration | `src/lib/supabase/migrations/20270216090000_website_embed_settings.sql`, SHA-256 `2ddcb78b988b91c955b0dd3cc1cb7891f0343262c68965f3b3b9d50031b53991` |
| Rollback | `.../rollback/20270216090000_website_embed_settings_rollback.sql`, SHA-256 `d32a7bca5da22a138600f8421cf5536af9d1d776145ad4dc7e72cbfafa420264` |
| PROD preflight (read-only) | `scripts/qa/embeds/prod-preflight.sql`, SHA-256 `aa5278c73dcaa7d3fb11ed63ca7bef2295b44e8c47d4609b2d2ae6db6640b46a` |
| PROD postflight (read-only) | `scripts/qa/embeds/postflight.sql`, SHA-256 `9b07e74d5e019a81f2d2309c070e3afd1f930d5a3896c961f986d047f4b2be05` |
| Target database | PROD `hvsujyfbftfffxpfmlpb` through `sb.sh prod-read` / `sb.sh prod-apply` only |
| Target app | Vercel project `danceflow-app-qfem` (the `www.idanceflow.com` project), production domain by explicit promotion |

The migration is additive (one RLS-protected table, five functions, nothing altered). It depends only on tables that already exist (`studios`, `appointments`, `group_class_series`, `group_class_enrollment_policies`, `user_studio_roles`, `events`, type `appointment_type`); the preflight checks exactly those and the 24 columns used. It does **not** depend on the unapplied 0202/0209 migrations that block promoting main, and DEV/PROD migration-history tables are not used (history is stale on DEV; the objects are the source of truth).

## 2. Relationship to main and the production reconciliation

- Live www is `dpl_FEzqXu6NEtBejTk5vQQMB8jszcEX`, built from `c0172455` (PR 466 price monitor, on 39eaec03; rollback `dpl_813hjGqT…`).
- Live is **not an ancestor of main**: merge-base `2cc05d9e`; 70 commits are live-only and main is 189 commits ahead. Website Embeds exist only on main.
- The reconcile vehicle is stale. Draft PR #445 (`claude/main-reconcile-live`, App-authored, head `af413c0d`, base `ab257f59`, last updated 2026-11-10) reconciles main with the *old* live `ab940288`; it does **not** contain current live `c0172455`. Main is also not promotable until PROD has the migrations main's webhook and invoices need (0202, 0209) and two forward timestamp collisions are renumbered. The TW-4F/Twilio coordinator confirmed (2026-11-14) that it does **not** own the reconcile or the PROD SQL order; those belong to the owner and the COMPETITION/release owner. No reconcile onto `c0172455` exists yet, so Path A has no current vehicle.
- #445 carries no Embeds files or migration; Embeds migration `20270216090000` sorts after every migration #445 or the TW-4F work carries (0103, 0211, 0212, 0217), so there is no collision to renumber. This work does not touch #445 or main promotability.
- Two ways to ship Embeds, owner to choose (decision D1):
  - **Path A (wait for a new reconcile):** Embeds ride main once someone reconciles main with `c0172455`, the PROD SQL prerequisites are applied and main is promotable. No extra branch, but there is currently no owner, plan or date for that work.
  - **Path B (independent, narrow release branch):** `release/website-embeds` = live `c0172455` + #469 + the release gate. Verified without creating a branch: #469 cherry-picks onto `c0172455` with **no conflicts**; on that base `tsc --noEmit` exits 0, the 3 embed unit files pass (33/33), and eslint is clean. It would not conflict with a later reconcile (same content) and, per the TW-4F coordinator, touches nothing in their domain. A release branch needs one owner approval under CODEOWNERS governance, a qfem preview build, and a manual `vercel promote`.

## 3. Cannot become public by accident (three independent layers)

1. **Vercel cannot go live by itself.** `danceflow-app-qfem`: `autoAssignCustomDomains=false`; its ignored-build command skips every production build from `main` (recent production builds show "Canceled"); a release-branch build is a preview until someone runs `vercel promote`. `danceflow-app`: ignored-build command is `exit 0` (every build skipped) and it serves only its own `vercel.app` aliases. No GitHub workflow deploys or promotes. (Read-only settings inspection, 2026-11-14.)
2. **The feature gate.** Without `WEBSITE_EMBEDS=on` the deployment serves nothing: menu item hidden, builder 404, saves refused, embeds 404 with no database call. Verified on a production build against a disposable stack: flag on, 44/44 browser checks; flag off, 4/4 dark checks (`scripts/qa/embeds/flag-off-check.mjs`); unit test covers `off/""/true/1` all being off.
3. **Fail closed without the migration.** If the app were live and enabled but the migration missing, every embed is 404 and the builder says settings are unavailable. Each studio also has its own instant kill switch.

Gap to know: flipping the gate is a Vercel environment change plus a new deployment (a provider configuration change, owner-only). The global off switch after activation is a rollback to the previous deployment.

## 4. Release sequence (each hosted step needs owner approval; none authorized yet)

0. Preconditions: gate PR merged; decision D1 made; if Path B, branch created and CI green; the release owner confirms the PROD SQL order.
1. `sb.sh prod-read prod-preflight.sql` must return `"ready": true` (migration absent, dependencies present, no fixtures). Repeat immediately before applying (drift check).
2. Owner approves the migration hash in chat, then `sb.sh prod-apply <migration> 2ddcb78b…`; then `sb.sh prod-read postflight.sql` must return `"all_ok": true`. The running app is unaffected (additive, nothing reads it yet).
3. Build the candidate (Path A: main; Path B: release branch) as a staged, non-domain deployment with `WEBSITE_EMBEDS` **unset**. Staged checks: embed routes 404, no menu item, ordinary pages unchanged, plus the usual smoke. Owner approves promotion; promote. Feature is still dark.
4. Separate owner decision: set `WEBSITE_EMBEDS=on` in the production environment and redeploy. Post-activation smoke: public calendar embed for a studio that opts in; kill switch round trip on a studio the owner nominates; observation window.
5. Rollback order: (a) app rollback to the previous production deployment (this also darkens the feature), (b) only if needed, run the rollback SQL (it deletes stored settings; nothing else depends on the table). Never roll the SQL back while an enabled app is live (embeds would 404, which is safe, but the builder would error).

## 5. Acceptance matrix

| Area | Evidence | Where | Status |
|---|---|---|---|
| A. DEV (hosted DEV database + local DEV-wired build), 44 checks | public calendar and class embeds; private/draft/other-studio events hidden; default no price/description; frameable only on embed routes; unknown/malformed ids 404; no form/forged action; signed-out builder redirects; instructor and other-studio owner turned away; builder code, hostile accent, preview; opt-in description/price persist; events toggle; stored appearance and URL override; invalid accent refused; kill switch (404, no leak, other studio unaffected); registration **handoff to login** with destination preserved and no payment page; defaults restored; network allowlist | `dev-validate.mjs`, 2026-11-14 | PASSED 44/44; cleanup verified |
| B. Disposable stack | 44-check `acceptance.mjs` (includes the full registration flow through confirmed email, eligibility stop and full-class refusal) with the gated build, flag on | iso-qa stack | PASSED 44/44 (2026-11-14) |
| B. Gate off | embed routes 404, builder not found, no menu item | iso-qa stack | PASSED 4/4 |
| B. Static | `tsc --noEmit` 0 on main and on the live-base candidate; eslint clean; unit tests 34/34 embed files | local + CI | PASSED |
| C. NOT tested against DEV | confirmed-email step and magic-link return; registration eligibility (needs a studio with a connected payment account); **real Stripe checkout** from an embed; a real third-party site framing the iframe; behaviour against PROD data volumes | none | UNTESTED; see below |
| D. Release-stage checks | PROD preflight ready; PROD postflight all_ok; staged dark smoke; post-activation smoke; observation | not run | PENDING |

Why C is a small residual risk, not a blocker by itself: the embeds only link (new tab) into the existing registration flow. The feature PR changes no registration, email-proof, eligibility or payment code (22 files, none under registration, payments, auth or billing; it only reads `canProceedToRegister`). Those flows were exercised unchanged by the stack run (B) and by their own existing suites. Real Stripe checkout from an embed has never executed and is not authorized; closing it would need a Stripe TEST Connect account for a DEV studio (owner decision D3).

## 6. Owner decisions genuinely required

- **D1:** Path A (wait for a new main-to-live reconcile that nobody currently owns) or Path B (independent `release/website-embeds`). Recommendation: B, because A has no vehicle, owner or date.
- **D2:** Approve merging the dark release gate (a small, routine PR; this package assumes yes, it changes no behaviour until the flag is on).
- **D3:** Accept the registration/Stripe residual (section 5, C) for a dark release, or require Stripe TEST evidence before activation. Not needed to apply SQL or deploy dark.
- Later, each as its own approval: PROD migration apply (hash above), promotion, setting `WEBSITE_EMBEDS=on`.
