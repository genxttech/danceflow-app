# Website Embeds: DEV application validation

Goal: exercise the authenticated builder, stored settings, kill switch, public embeds, prices/descriptions and the registration handoff against the real
DEV database (`epdrtzcydvnoidwrepqz`, migration `20270216090000` already applied, fictional fixtures present) without deploying anything hosted and without
any path to PROD.

## Decision: a DEV-connected build served on localhost, not a hosted preview

What exists today (read-only inspection, no values read):

- Every PR branch already gets a Vercel preview build on **both** projects. Those builds use the project's *Preview* environment, which on
  `danceflow-app-qfem` holds live Twilio, OpenAI, Google and Stripe-price secrets and a Supabase URL/key whose value cannot be shown without exporting secrets.
  Making a hosted preview DEV-only would mean changing Vercel project environment settings (a protected change), and its isolation could not be proven
  without reading secret values.
- Deployment URLs are SSO-protected; testing one would need an automation-bypass secret (see the qfem release notes).

So the validation runs a **production build of the exact commit on this machine** (`next build` + `next start`, the same build mode as the walkthroughs):

| Isolation control | How it is enforced |
|---|---|
| No hosted deployment, no Vercel object touched | nothing is uploaded; no `vercel` command is used; no domain, no cron, no webhook receiver |
| DEV only | `run-local-dev-app.mjs` refuses any ref but `epdrtzcydvnoidwrepqz`, and refuses if any env value mentions the PROD ref |
| No other credentials | the child process gets a minimal allowlisted environment (OS basics + DEV Supabase URL/anon/service + localhost site URL). No Stripe, Resend, Twilio, OpenAI, Mux or Google keys exist in it, so payments, email, SMS and AI cannot act |
| No `.env` surprises | the runner stops if any `.env*` (not `.example`) file exists in the repo root |
| Clean, known commit | the runner stops on any uncommitted or untracked file and prints the commit SHA; `build` writes a marker (commit + DEV ref), and `start` refuses to serve unless the marker matches the current commit, then re-runs the scan |
| Build-output proof | after `next build`, every file under `.next` except `.next/cache` (any extension, up to 40 MB) is scanned: DEV ref must appear; the PROD ref, plain or base64, must not; the service key must not be in the browser bundle. The DEV anon and service keys are also decoded and must carry the DEV ref |
| Network proof | the browser blocks (aborts) any request to a host other than `localhost`/`127.0.0.1`/the DEV Supabase host and the run fails if one was attempted (PROD host is called out explicitly). Server-side egress of the Next process is not browser-visible; it is limited by the absence of any other credential |
| Loopback only | server binds `127.0.0.1`; the test script refuses a non-local base URL |

Keys are read in-process from the supabase CLI login that `sb.sh` already uses and are never printed or written by these scripts (the public anon key is necessarily inlined into the browser bundle by Next).

## Files

| File | Purpose |
|---|---|
| `scripts/qa/embeds/dev/accounts.sql` / `accounts-cleanup.sql` | link / remove exactly three fictional accounts (hashable, idempotent) |
| `scripts/qa/embeds/dev/provision-accounts.mjs` | creates the three auth users via the GoTrue admin API (email pre-confirmed, nothing is sent); password goes only to a file outside the repo |
| `scripts/qa/embeds/dev/run-local-dev-app.mjs` | `build` (with isolation scan) and `start` |
| `scripts/qa/embeds/dev/dev-validate.mjs` | the browser acceptance run (below) |

## Test accounts (all fictional, `@example.test`, one shared random password kept outside the repo)

| Account | Role | Purpose |
|---|---|---|
| `embed-qa-owner-a@example.test` | studio_owner of `embed-qa-fictional-a` | builder, settings, kill switch |
| `embed-qa-instructor-a@example.test` | instructor of studio A | must be turned away from the builder |
| `embed-qa-owner-b@example.test` | studio_owner of `embed-qa-fictional-b` | must see studio B only, never studio A |

DEV already holds hundreds of `@example.test` users, so this follows existing practice. No payment account, student or client record is created.

## Procedure

0. Preconditions (read-only): fixtures present, three emails absent, main at the approved commit, clean tree.
1. `node scripts/qa/embeds/dev/provision-accounts.mjs dev <creds.json>` (hosted write: three auth users). The credentials file is created first and never overwritten; if a create fails part-way, run `accounts-cleanup.sql` before retrying.
2. `sb.sh dev-apply scripts/qa/embeds/dev/accounts.sql <sha256>` (hosted write: 3 profiles, 3 role rows).
3. `node scripts/qa/embeds/dev/run-local-dev-app.mjs build` must print `ISOLATION SCAN PASS`; then `... start 3100` in the background.
4. `node scripts/qa/embeds/dev/dev-validate.mjs <creds.json> <out-dir> http://localhost:3100` must end with `"failed":0`.
5. Cleanup: stop the server; `sb.sh dev-apply accounts-cleanup.sql`, then (if the fixtures are no longer wanted) `fixtures-cleanup.sql`; delete `<creds.json>` and the `.next` output; verify with a read-only query that no fixture, role, profile or auth user remains.

## Acceptance checks (about 50, listed in `dev-validate.mjs`)

- Public: calendar and class embeds serve; only public events (private, draft and other-studio events never); classes without price or description by default;
  embed routes frameable while every other page stays unframeable; unknown slug, unknown id and malformed id are 404; POST refused; builder redirects to login when signed out.
- Access: studio A instructor turned away; studio B owner gets a builder for B only, with none of A's classes.
- Builder: code is an iframe for the studio; class list shows the studio's public classes; options differing from stored defaults appear in the code, equal ones do not;
  a hostile accent value never reaches the code; the preview iframe renders classes.
- Stored settings: opt-in description and price show on the series and a directly priced class and survive a reload; the other studio is unaffected; events off hides events;
  stored month/dark/accent apply and explicit URL options override them; an invalid accent is refused with fixed copy and changes nothing.
- Kill switch: off makes every embed 404 without leaking the studio, leaves DanceFlow's own public pages and the other studio's embeds alone, and the builder says so; on restores service.
- Handoff (anonymous): the embed offers a Register link that leaves the frame; following it signed out reaches login with the destination preserved and no payment page opens.
- Cleanup and isolation: factory defaults restored through the UI; every browser request stayed within the allowlist.

## Rollback and cleanup

Nothing was deployed, so there is no application rollback: stopping the local server ends the exposure. Data cleanup is `accounts-cleanup.sql` and `fixtures-cleanup.sql`
(hashes in the authorization request), both idempotent. The migration rollback (`rollback/20270216090000_website_embed_settings_rollback.sql`) is **not** part of this
operation. Stop immediately on any non-zero exit, an isolation-scan failure, a request outside the allowlist, or an unexpected database state, and report instead of repairing.

## Residual risks and gaps

- The full registration (confirmed email, eligibility, checkout) is not covered on DEV: it needs a student account with email proof and the DEV auth email setup; it
  stays covered by `acceptance.mjs` on the disposable stack, and Stripe is absent here by design.
- DEV's trigger set differs from the baseline stack; the accounts and fixtures were dry-run on the stack and the fixtures already ran on DEV.
- Anyone with the DEV service key could create the same accounts; the accounts have a random password and a documented cleanup.
- The app talks to a real hosted DEV project: a bug could write unexpected rows to fictional studio A. Impact is limited to DEV data, covered by the cleanup scripts.
- Browser tests run Chrome via Playwright on this machine; a different browser or a real third-party site embedding the iframe is not part of this run.
