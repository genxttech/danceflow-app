# Staff write gate: fail-closed evidence for the R+3 candidate (2026-11-21)

Commit under test: `0533462198363a966b4a337c6ba0aafce279f5be` (`origin/release/website-embeds`, the Phase 1A live-line backport, PR 748). Clean worktree, `npm` dependencies of that lockfile, **production build** (`next build`) served with `next start`, against a **disposable iso-qa `--auth` stack** (local Postgres, PostgREST, Kong, GoTrue; loopback only). `STAFF_API_WRITE_POLICY` was **not set** (same as every Vercel environment target) except in the policy-variant phase, where each variant was set on a restarted server and nothing else changed. Tokens were issued by the disposable GoTrue and held only in the script's memory (never argv, child env, logs or saved files; a leak guard scans the evidence folder and found nothing).

Scripts (all under `scripts/qa/staff-api/`): `write-gate-matrix.mjs`, `web-actions-qa.mjs`, `v01-parity.mjs`, with `r3-gate-lib.mjs` and `r3-gate-seed.mjs`. The matrix script refuses to run unless the web tree is exactly the expected commit and clean, the build exists, the stack is loopback, and the policy variable is unset in its own shell.

## Results

| Phase | Cells | Result |
|---|---|---|
| Closed gate (policy unset): 5 write routes x 5 staff roles x 4 header variants (valid, missing, malformed, other app), valid existing ids; expect 403 `writes_disabled` and an unchanged database | 100 | 100 PASS |
| Identity refusals come first: no token, garbage token, studio B owner on studio A, platform admin, studio id not a uuid; each on all 5 routes | 25 | 25 PASS |
| Whole closed phase: 18 tables (appointments, attendees, lesson_transactions, client_package_items, client_packages, client_membership_usage, client_activity_notes, clients, notifications, deliveries, deduction/usage error tables, mobile log, sms log, roles, instructors, studios, profiles) identical by row count and md5 before and after | 1 | PASS |
| Malformed or closed policies (empty, whitespace, not JSON, `null`, array, `{}`, `enabled` empty / a string / a non-string, unknown word only, malformed `minimumCode` x3, malformed `blockedCodes`): all 5 routes stay 403, zero mutation | 14 x 6 = 84 | 84 PASS |
| One capability at a time (`clientCreate`, `clientNotes`, `classRoster`, `appointmentAttendance`): the other capabilities stay 403 with zero mutation; the enabled route with a missing / malformed / other-app header is 426 `upgrade_required` with zero mutation; no token / studio B / platform admin keep their own refusal; with the same valid ids and header the enabled route writes (positive control) | 47 | 47 PASS |
| Version gate (all four enabled): `minimumCode` 3 vs code 2 and `blockedCodes [2]` are 426 with zero mutation; an iOS header is not held to the Android minimum | 3 | 3 PASS |
| Reads: `/me`, `today`, `schedule`, `pulse`, appointment detail; `GET /clients` default (leads and inactive in, archived out), `?status=lead`, `?status=archived`, `?status=bogus` (400), `q`, admin and front desk, instructor scope (taught clients only, no leads); notes paging (5 notes, 3 pages, newest first, bad cursor 400); instructor notes refused | 16 | 16 PASS |
| **Matrix total** | **276** | **276 PASS, 0 FAIL** |
| Affected web actions in a real browser as seeded owner, DB asserted after each (below) | 11 | 11 PASS |
| v0.1 class-attendance route and unchanged reads, previous live commit `127994122` vs candidate, same requests and equivalent fixtures, responses normalised (ids, times, emails, slugs masked) | 26 | 25 identical; 1 intended difference (below) |

Transport note: 33 requests of the matrix run were retried after a socket reset before any response (counted in `matrix.json` `networkRetries`). Every retried request was a refusal or a fixture-valid control and all cells passed; no 429 occurred.

### Web actions (11)
Mark attended on a package lesson (status attended, exactly one lesson transaction, package used 1); no-show with no charge (no transaction, note says `No lesson deduction` and carries `Appointment ref: <id>`); no-show with a package charge (one transaction, used 1, note rewritten to `deducted`); the same no-show submitted again from a stale tab (no second deduction, no duplicate note); a different decision from a stale tab after a charge (refused with "already recorded with a different charge decision", database unchanged); add client (created) and the same email again (refused, no row); add a client note; enrol a dancer in a class and again (`already_enrolled`, roster unchanged); remove the dancer (attendee `cancelled`, `?success=attendee_cancelled`).

### v0.1 parity
`PUT .../attendance/{clientId}` (owner, admin, front desk, instructor; repeat; terminal re-mark; independent instructor 403 `role_not_permitted`; bad key / status / body / ids; not on roster 404; no token 401; other studio 403; platform admin 403; a stray `X-DanceFlow-App` header ignored) and `GET me/today/schedule/pulse/appointment/client summary/today (instructor)/schedule (other studio)` answer identically on both commits. The one difference is intended: `GET .../clients/{id}/notes` does not exist on `127994122` (404) and answers 200 on the candidate.

## Not covered by the browser run
- The dancer notices that enrol/cancel queue (`groupClassNotices`) wrote no rows on this stack (no notification provider or settings seeded); the notice code is byte-identical to main and was not exercised end to end. Covered by unit tests only.
- Hosted-Checkout / payment flows are not touched by this change and were not run.
- The no-show path with `membership` charge was not driven in the browser (covered by the library tests).

## Residual risk
- The Vercel-built artifact and the production environment are **not** exercised: this is a local build of the same commit with a local `next start`. Vercel build settings, edge/middleware behaviour and the real environment-variable set were checked separately by the APPS coordinator (no `STAFF_API*` variable exists in any target).
- The PROD database state is not exercised. The database is the iso-qa baseline (July production schema plus migrations through 20261205); no migration after that cutoff touches the objects used here, and the five functions the writes depend on were compared read-only against PROD (bodies equal the migration definitions). `get_teaching_clients_for_instructor` is absent on PROD (pre-existing; instructor client search), which this run, using a stack where it exists, cannot show.
- A single local server process: the in-memory rate limiter and restart-to-change-policy behaviour are as on one serverless instance, not across Vercel instances.
- Seeded data is small; concurrency and load were not tested.
- Evidence folder (not committed, contains screenshots and per-cell JSON): `C:\dfr-out\r3gate\FINAL\`.
