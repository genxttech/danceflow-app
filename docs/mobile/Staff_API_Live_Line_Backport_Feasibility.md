# Staff API on the live line: backport feasibility

2026-11-18. Question: how does `/api/staff/**` (the only server the Business app talks to) get onto the LIVE line, `release/website-embeds` @ `6ba312957`, so the Business app can work on PRODUCTION. Analysis only: no code was committed to any release branch, no SQL was applied, nothing was deployed. Compared: `origin/main` @ `37f87dc9b` against `origin/release/website-embeds` @ `6ba312957` (merge-base `2cc05d9e`; main is 348 commits ahead, the live line 81 ahead). Marks: **V** = verified (git, a local test run, or a read-only PROD query, evidence named); **A** = assumed.

## 1. Answer in one paragraph

A **minimal backport is small, mechanical and was proven locally**: the whole dependency closure of `src/app/api/staff/**` is **35 files**; 16 already exist on the live line byte for byte, **16 are new** (8 routes, 8 libraries) and **3 differ by purely additive hunks** that exist on main only because of the staff API itself. Checking those 19 files out of main onto a scratch copy of the live line gave a clean full-repo `tsc --noEmit` (exit 0), eslint clean, and 404 vitest tests passing (59 skipped: they need a local database stack). It needs **no new environment variable** and **no change to any existing route, page or server action**. Two database items decide whether the app works for whom: SQL `20270214120000` (roster names for assigned instructors) is not on PROD, and, found by a read-only PROD query, **`get_teaching_clients_for_instructor` is not on PROD either**, so instructor-scoped screens would fail (owner, admin and front-desk screens do not need either). Recommendation: **Option 1, a path-checkout backport PR to `release/website-embeds`**, then SQL first, staged build, smoke, promote.

## 2. Dependency closure of `src/app/api/staff/**` against the live line (V)

Method: every non-test file under `src/app/api/staff/` on main, followed through every `import`/`export from`/dynamic import that resolves under `@/` or by relative path, recursively; each file compared byte for byte with the same path on the live line (script output kept at `C:\dfr-out\` is not needed to reproduce: `git show origin/main:<path>` against `git show origin/release/website-embeds:<path>`). Result: 35 files, 4 external packages (`next`, `@supabase/ssr`, `@supabase/supabase-js`, `node:crypto`), 0 unresolved imports.

**Missing on the live line (16, all new, nothing to merge):**

| File | Lines | Role |
|---|---|---|
| `src/app/api/staff/me/route.ts` | 58 | `GET /api/staff/me` |
| `.../workspaces/[studioId]/today/route.ts` | 51 | day schedule |
| `.../appointments/[appointmentId]/route.ts` | 47 | appointment and class detail |
| `.../appointments/[appointmentId]/attendance/[clientId]/route.ts` | 71 | `PUT` Present / No-show |
| `.../clients/route.ts`, `.../clients/[clientId]/route.ts` | 40, 37 | client lookup and summary |
| `.../schedule/route.ts`, `.../pulse/route.ts` | 38, 46 | studio-wide day, Pulse |
| `src/lib/auth/staffApiAuth.ts` | 216 | bearer auth, account status, platform-admin refusal |
| `src/lib/auth/staffCapabilities.ts` | 72 | role-level capability hints |
| `src/lib/schedule/classAttendance.ts` | 80 | shared attendance upsert |
| `src/lib/staff/{instructorToday,clients,classAttendance,studioSchedule,studioPulse}.ts` | 278, 255, 147, 70, 99 | read models |

**Different on the live line (3, additive only, V by `git diff`):**

| File | Diff vs live | What the extra lines are |
|---|---|---|
| `src/lib/auth/studio.ts` | +34 / -0 | one new exported function `getWorkspacesForUserWithClient` (the bearer surface has no workspace cookie) |
| `src/lib/auth/studentApiAuth.ts` | +29 / -19 | extracts `extractAuthorizationBearerToken` and `createBearerScopedClient` from existing code; `extractStudentBearerToken` and `createStudentApiUserScopedClient` keep their behaviour (the Student API shares them, so this file needs its own review) |
| `src/lib/schedule/groupClassRosterPanel.ts` | +42 / -3 | optional `namesByClient` and `assignedInstructorView` parameters, a new `nameKnown` field on `RosterEntry`, and `loadInstructorRosterNames` (calls the roster-names RPC) |

**Do the three shared files carry unrelated main-only changes? No (V).** `git log origin/release/website-embeds..origin/main -- <file>` lists #453 (the staff API) for all three; `studio.ts` also lists H1 commits #418 and #421, but the **file-level diff against live is only the +34 staff function**, so those H1 changes are already in the live line's copy. Nothing else from main's 348 commits rides along.

**Not needed (V):** the web-side changes in #453 (`src/app/app/schedule/[id]/attendance/actions.ts`, `src/app/app/schedule/[id]/page.tsx`, `src/lib/schedule/groupClassRoster.ts`) are not imported by any staff file. Leaving them out changes nothing on the web; web instructors simply keep today's behaviour.

**Not an obstacle (V):** `src/proxy.ts` (the middleware) matches only `/app/:path*` and `/platform/:path*` (`src/proxy.ts:16`) and is identical on both lines, so `/api/staff/**` is never redirected to login; the routes answer with their own flat `{error, code}` JSON. `next.config.ts` is identical, so the staff routes get the global security headers and are not framable. `package.json` differs only by three unrelated npm script lines (QA scripts); no dependency differs.

### Per slice (V)

The routes group by what the app needs; each group's missing-or-different files:

| Slice | Routes | Files to bring | App features it serves |
|---|---|---|---|
| 1 | `me`, `today`, `appointments/{id}` | 9 (3 routes, `staffApiAuth`, `staffCapabilities`, `instructorToday`, the 3 shared hunks) | sign-in and workspace pick, Today, appointment and class detail |
| 2 | `clients`, `clients/{id}`, `attendance/{clientId}` | +6 on top of slice 1 (3 routes, `staff/clients`, `staff/classAttendance`, `schedule/classAttendance`) | Clients, class roster attendance |
| 3 | `schedule`, `pulse` | +4 on top of slice 1 (2 routes, `studioSchedule`, `studioPulse`) | Studio view, Pulse |

All three together are 19 files. The slices share most libraries, so splitting saves 10 files at most and buys little risk reduction: the routes are independent and read-only apart from the idempotent attendance write.

## 3. The trial backport that was run (V)

On a scratch worktree of `origin/release/website-embeds` @ `6ba312957` (removed afterwards; nothing pushed): `git checkout origin/main -- <the 19 files>` plus `src/app/api/staff/__tests__/` (9 files).

| Check | Result |
|---|---|
| Size | 28 files: 19 runtime files = **+1,694 / -22 lines**; 9 test files = +2,375 |
| `tsc --noEmit` on the whole repo (8 GB heap) | **exit 0** (so the 3 modified shared files break no other caller, including the web roster and the Student API) |
| `eslint` on every touched path | clean |
| `vitest run src/app/api/staff src/lib/schedule/__tests__` | **17 files passed, 2 skipped; 404 tests passed, 59 skipped** (the skipped ones are the `localStack.*` tests that need a disposable database) |
| **Not run** | `next build` (CI's "Production build" job will do it), the disposable-stack HTTP and RLS suites (`scripts/qa/staff-api/`, `localStack.*`), a device walk against the backported server |
| `node_modules` | the main checkout's (identical dependencies; `package.json` differs only in scripts), linked read-only into the scratch tree and unlinked before removal |

**Tests that can be carried (V):** the 9 files of `src/app/api/staff/__tests__/` (HTTP-level route tests over an in-memory world, refusals before any client data is read, slice 2 units, the 2026-11-17 `staffReadsGuard` that asserts staff code never reads registrations or claims). The two `localStack` files need `iso-qa`.

**CI/typecheck risk (V + A):** `tsc` is clean as above. **A:** the release line's CI uses the same 6 GB heap workflow as main (`0db5eabe`, "CI: 6 GB heap for Type check and Production build", is in the live line's history); the risk is a Production build memory or time limit, not a type error. Embeds Path B recorded 13 source-scan tests timing out at their 5 s default under full-suite load and passing in isolation (`Release_Candidate_Path_B.md` section 5): expect the same flake, not a failure.

## 4. What the routes need at runtime

**Environment (V):** none new. The staff routes read `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`createBearerScopedClient` in `studentApiAuth.ts`) and `SUPABASE_SERVICE_ROLE_KEY` only for the account-status lookup (`getDanceFlowAccountStatus`, unchanged file on both lines). The web app already requires all three. No other `process.env` is read in `src/app/api/staff`, `src/lib/staff` or `staffApiAuth.ts` (grep), so there is also **no kill switch**: removing the API means promoting the previous deployment.

**Auth path (V, `src/lib/auth/staffApiAuth.ts`):** the app's Supabase access token arrives as `Authorization: Bearer`; a client carrying exactly that token runs every read (RLS and RPCs see `auth.uid()`); `auth.getUser(token)` verifies it with Supabase Auth; the account must be `active`; platform admins are refused; every refusal is flat `{error, code}` JSON and an unexpected failure is a 503, never a pass. No cookie fallback, no new Supabase setting.

**Database (V, read-only PROD query through `sb.sh prod-read`, run during this analysis; query text `C:\dfr-out\staff-prod-readiness2.lf.sql` and `...3.lf.sql`, run log `C:\Users\mcurt\danceflow-ops\log\ops.log`; names only, no row data):**

| Needed by the staff code | On PROD? |
|---|---|
| Tables `appointments`, `appointment_attendees`, `attendance_records`, `clients`, `client_packages`, `client_package_items`, `lesson_recaps`, `profiles`, `studios`, `instructors`, `user_studio_roles`, `user_account_status`, `rooms` | **all present** |
| Every column the staff selects and filters use (53 checked, including `client_packages.active`, `client_packages.archived_at`, `clients.status`, `studios.timezone`, `studios.subscription_status`) | **all present** (a first draft of the check named two columns wrongly; re-checked against the code, nothing missing) |
| `is_own_instructor_appointment(uuid, uuid)` (used by the roster-names RPC) | present, security definer, executable by `authenticated`, not by `anon` |
| **`get_class_roster_names_for_instructor(uuid)`** (SQL `20270214120000`) | **ABSENT**: needed for an **assigned instructor's** class detail and attendance; without it those requests return `503 service_unavailable` |
| **`get_teaching_clients_for_instructor(...)`** (SQL `20260905160000_fc1b5d_teaching_client_access_rpc.sql`) | **ABSENT** on PROD (new finding): called by `src/lib/staff/instructorToday.ts` (instructor names on Today) and `src/lib/staff/clients.ts` (instructor "My clients", client summary), so for **instructors** these throw and the route answers 503. Owner, admin and front desk read `clients` directly (`loadStudioClientNames`, broad scope) and do not call it |
| `clients` RLS | still the broad policy `studio staff manage clients` (`ALL`, roles `public`) plus two portal-user SELECT policies: FC-1B5D Phase B (`20260906090000`) is not applied, which is why owners and front desk can read client names through the bearer client |

Side finding for the coordinator, outside this task: **the live line's own web code already calls `get_teaching_clients_for_instructor`** (for example `src/app/app/page.tsx:2709`, `src/app/app/schedule/page.tsx:1408` on `release/website-embeds`), and PROD does not have the function. How those web paths behave for an instructor on PROD today is **A** (not exercised here); it may degrade or error. `pg_proc` was searched in schema `public` by exact name for the two functions above only; the FC-1B5D family's other functions were not enumerated, so do not read this as a full inventory of that migration set.

**SQL files and hashes (V, from the repository):** `20270214120000_instructor_class_roster_names_rpc.sql` SHA-256 `210ca4488c1e70125cccfada22527b6dd31277bef1b86fd312c91deb5658601c` (rollback `a38fb809a475b0a59c220d73ccec7dd02c56bebd34bcc1b65a61f21056c179f2`, additive: one function). `20260905160000_fc1b5d_teaching_client_access_rpc.sql` SHA-256 `ef7ce593a4c5f4eae2835dd62fff4124a464a4a1900bb2cf96926f90c1e733f5` (rollback `63a5e7ba3aea1337188511cc6b652523819ee05ab8e724e98c30f4d0cb8fe180`; its header says it adds a function and changes no RLS policy; it still needs its own read-only preflight before an owner approves it, which this analysis did not run).

## 5. Options

### Option 1: path-checkout backport PR to `release/website-embeds` (recommended)

- **What:** one commit on a branch cut from `release/website-embeds`, made by checking out the 19 runtime files and the staff test folder from main (not a literal cherry-pick of #453: that commit also carries the web `attendance/actions.ts`, `schedule/[id]/page.tsx`, `groupClassRoster.ts` changes and the SQL, and squashes slice 1 with slice 2). The trial in section 3 is exactly this.
- **Size:** 28 files; **+1,694 / -22 runtime lines** (16 new files, 3 additive edits), +2,375 test lines.
- **Effort:** small. Hours of engineering: branch, commit, CI, review of the three shared-file hunks, a staged build and smoke. The slow parts are approvals.
- **Risk:** low to moderate. New routes only; the three edited files change only additively (V: tsc clean across the repo, existing roster and Student API call sites compile; **A:** runtime behaviour of the Student API's bearer path is unchanged because `extractStudentBearerToken` and `createStudentApiUserScopedClient` keep their logic; the trial ran only the staff and `src/lib/schedule` suites, so the Student auth tests must run in CI). Nothing touches Competition, TW-4F, billing, Embeds, cron or webhooks. Instructor paths 503 until the SQL in section 4 is applied; owner and front-desk paths work without it.
- **Governance:** the branch is protected; `release/**` changes need one owner approval (`Release_Candidate_Path_B.md` section 6); merging to the release branch is not a deployment.
- **Rollback:** promote the previous production deployment (the routes disappear; the Business app then shows "Temporarily unavailable"). The SQL is additive; leave it applied.

### Option 2: wait for the main reconcile (#445, on hold)

- **State (V, `Release_Readiness.md` section 2):** live is not an ancestor of main; **main is 348 commits ahead and the live line 81 ahead** (CF1 Competition, TW-4F, Embeds). Draft PR #445 reconciled main with an old live (`ab940288`) and does not contain the current line; it is on hold; no one currently owns a reconcile onto the live line. Main is also not promotable until PROD has the migrations main's webhook and invoices need and until forward timestamp collisions are renumbered: **26 migrations added on main since the live base are not on PROD** (`20270201090000` through `20270222094000`: billing, D24 invoices, push claim, Twilio, G-01/G-02, claim function and cutover). The main-versus-live diff is **1,469 files, +143,789 / -93,746**, including 377 files that exist only on the live line (252 of them Competition).
- **Effort:** large and uncertain (days; a reconcile merge, a promotability pass over 26 migrations and their PROD order, a full regression of every product). **Risk:** high; it touches every product at once. **Rollback:** previous deployment, but SQL already applied for main cannot all be undone.
- **For the Business app:** blocks it for an unknown time. Not recommended as the path for this goal; it remains the right long-term convergence.

### Option 3: cut a new release line from main (not recommended)

- **What it contains (V):** main's 348 commits since the merge-base: Student app and API (45 + 2 smoke), Business (31 + 14 smoke), TW-4F SMS (about 40 with its sub-series), WP-D0, D24 billing, D7, G-01/G-02, the event-registration claim chain, docs, and the 26 migrations above.
- **What it would lose (V):** the 81 live-only commits: the **CF1 Competition candidate (11 commits plus the heat-size fixes, 252 files absent from main)**, TW-4F key-setup and price-monitor line items, PRICING-P1 pieces, the live Embeds line itself. A release cut from main would **remove Competition code that is live today** unless it is merged back, which is Option 2's reconcile again.
- **Effort/risk:** high; **rollback:** the previous deployment, with the same SQL irreversibility as Option 2. Rejected.

| | Files / lines | Effort | Risk | Rollback | Time to Business-usable server |
|---|---|---|---|---|---|
| 1. Path-checkout backport | 28 files, +1,694/-22 runtime | hours + approvals | low to moderate | promote previous deployment; SQL additive | days (approval-bound) |
| 2. Wait for reconcile | 1,469 files | days to weeks, unowned | high | partial | unknown |
| 3. New line from main | 348 commits, drops 81 | high | high (removes live Competition) | partial | not viable |

## 6. Recommendation and the exact sequence

**Option 1**, shipping all eight routes together (the app's build flags decide what a tester sees; splitting saves 10 files and no meaningful risk).

1. **Owner decisions first:** (a) approve the backport PR to the protected release branch; (b) approve the PROD SQL below; (c) decide whether instructors are in the first test (needs the second SQL) or the first test is owner, admin and front desk only (works with the first SQL alone, or even with none for those roles).
2. **Engineering, no approval needed:** branch from `release/website-embeds`, commit the path-checkout (the trial above, exactly), open the PR via the App identity with the section 3 evidence, run CI (typecheck, production build, unit tests), add the Student auth suites to the run, request the one owner approval. Merge into the release branch only after approval.
3. **SQL before app (owner-approved, `sb.sh prod-apply` with the file hash):** `20270214120000` (roster names; additive) and, if instructors are in scope, `20260905160000` (teaching clients; additive, own preflight first). Each followed by a read-only postflight query for the function's existence and grants.
4. **Staged build, no domain:** build the release branch head as a non-production deployment (the same process as Embeds Path B step 3). Smoke on the preview URL with anonymous requests first: `GET /api/staff/me` returns HTTP 401 with `{"code":"unauthenticated"}`, `GET /api/staff/workspaces/<any uuid>/today` returns 401 flat JSON (proves the middleware does not intercept, V `src/proxy.ts:16`), `GET /login` still `X-Frame-Options: SAMEORIGIN`; then one real staff login supplied by the owner (**A:** the preview deployment reads the production database, as it uses the production environment; keep to read-only calls, no attendance write unless the studio agrees).
5. **Promote** (`vercel promote`, owner) with the previous deployment id recorded as the rollback target; watch the runtime logs for `/api/staff/*` 5xx for 30 minutes (a 503 on an instructor class detail means the SQL is missing).
6. **Business app:** build the signed unminified AAB against the production origin and run the tester script in `Business_Release_Package_Internal_Testing.md` section 5.

## 7. What the Business app can do if only part of the API ships

The app decides what to show from `GET /api/staff/me` capabilities and from build flags (`mobile/business/src/lib/features.ts`); a screen whose route is missing shows "Temporarily unavailable" for that screen only. `EXPO_PUBLIC_STAFF_FEATURES=none` turns the two default-on features (clients, attendance) off; `pulse` and `studioSchedule` are off unless named.

| Server has | Build flags | The app offers | Does not offer |
|---|---|---|---|
| `me` only | any | sign-in, More (role, studio, sign out); every other screen unavailable | everything else: **not releasable** |
| Slice 1 (`me`, `today`, appointment detail) | `none` | sign-in, workspace pick, Today (instructor's own day; for owner, admin, front desk the "My day" view), appointment and class detail | marking attendance, Clients, Studio view, Pulse |
| Slices 1+2 | default (clients and attendance on) | the above plus Clients and Present / No-show | Studio view, Pulse |
| Slices 1+2+3 | `pulse,studioSchedule` | everything in the Business package | nothing in v1 is missing |
| Any slice, database lacks `20270214120000` | - | owner, admin, front desk fully; an **assigned instructor's** class detail and attendance 503 | instructor class roster |
| Any slice, database lacks `get_teaching_clients_for_instructor` | - | owner, admin, front desk fully | instructor Today names, instructor My clients and client summary (503) |

**A:** the owner/admin/front-desk columns above follow from the code reading `clients` directly under today's PROD policies (broad staff policy present); they were not exercised against PROD.

## 8. Open items

| Item | Mark | How to close |
|---|---|---|
| Instructor paths on PROD need `20260905160000` and `20270214120000` | V (function absence) / A (instructors are in the first test) | owner decision (section 6 step 1c) |
| How the live web code behaves for instructors without `get_teaching_clients_for_instructor` on PROD | A | coordinator or web owner; not tested here |
| `next build` and CI of the backport | not run | CI on the PR |
| Student API suites after the `studentApiAuth.ts` refactor | not run here | CI on the PR |
| Real staff login against the staged deployment | not run | owner supplies a login (step 4) |
