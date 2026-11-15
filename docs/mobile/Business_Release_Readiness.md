# DanceFlow Business: release readiness

What must be true on the server, in the database and in the build before an internal-testing build of the Business app (`com.idanceflow.business`) can work for a real studio. Written 2026-11-15 from main. It lists dependencies and the order to sequence them; it does not apply or promote anything.

Status words: **needed** (the app is broken without it), **optional** (the app works and hides the feature), **confirm** (the repo cannot prove it; check on the target environment).

## 1. The web deployment the app talks to (needed)

The app sends every request to `EXPO_PUBLIC_DANCEFLOW_WEB_URL` (baked in at build time) under `/api/staff/**`, with the signed-in person's Supabase access token as a bearer token. There is no cookie fallback.

**All of these routes must exist on that deployment.** They are on `main` only; live production did not have the staff API when this was written, and `main` was not yet promotable (the reconcile is with the owner).

| Route | Added in | The app needs it for |
|---|---|---|
| `GET /api/staff/me` | slice 1 | sign-in, workspaces, roles, capabilities, studio time zone |
| `GET /workspaces/{id}/today` | slice 1 | Today |
| `GET /workspaces/{id}/appointments/{id}` | slice 1 | appointment and class detail |
| `GET /workspaces/{id}/clients`, `GET .../clients/{id}` | slice 2 | Clients |
| `PUT /workspaces/{id}/appointments/{id}/attendance/{clientId}` | slice 2 | marking attendance |
| `GET /workspaces/{id}/schedule` | slice 3 (#535) | studio-wide day, only behind the `studioSchedule` flag |
| `GET /workspaces/{id}/pulse` | slice 3 (#538) | Pulse, only behind the `pulse` flag |

The contract is `docs/mobile/Staff_API_Contract.md`. Server environment the routes read: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (the service role is used only for the account-status check; no data read uses it). **Confirm** the production project has all three, as it must for the web app anyway.

## 2. Database (needed, in this order relative to the app)

| Migration | Why | If it is missing |
|---|---|---|
| `20270214120000_instructor_class_roster_names_rpc.sql` | class roster names for the **assigned instructor** (`get_class_roster_names_for_instructor`) | class detail and attendance marking for an assigned instructor return `503 service_unavailable` ("Temporarily unavailable"); owners, admins and front desk are unaffected. Measured on the local stack: exactly those cases fail without it |
| everything the routes read already shipped with the web app: `appointments`, `appointment_attendees`, `attendance_records`, `clients`, `client_packages`, `lesson_recaps`, `instructors`, `user_studio_roles`, and `get_teaching_clients_for_instructor` (`20260905160000_fc1b5d_teaching_client_access_rpc.sql`) | the teaching-relationship client names | **confirm** on production; the repo assumes the web app's own schema, so these are not new |

Rule from the contract: **apply `20270214120000` before deploying the app routes that need it** (the SQL is additive and the routes fail closed with the flat `{error, code}` shape if it is absent). It is applied to DEV, not to production.

The slice 3 routes (`schedule`, `pulse`) need **no** migration: they read only tables the web app already has. Verified against a database without `20270214120000`.

## 3. Accounts and sign-in (needed)

- The app signs in with email and password, or an emailed link, against the **same Supabase project as the web app** (`EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, baked in at build time).
- The magic-link redirect `danceflow-business://auth/callback` must be on that project's **Auth redirect URL allow-list**. **Confirm** it is there; without it the emailed link does not return to the app (password sign-in still works).
- Studio staff accounts are created on the web; the app cannot create one (`shouldCreateUser: false`). A tester needs a real staff role at a studio whose subscription allows access (a paused studio gets `workspace_paused`, explained in the app).
- Roles served: owner, admin, front desk, instructor. Independent instructors and organizer roles get "Not available for your role"; platform admins get "Use DanceFlow on the web".

## 4. Feature flags (build time, `EXPO_PUBLIC_STAFF_FEATURES`)

| Flag | Default | Needs |
|---|---|---|
| `clients` | on | slice 2 routes |
| `attendance` | on | slice 2 routes, and for assigned instructors the migration in section 2 |
| `pulse` | **off** | `GET /pulse` live on the target deployment |
| `studioSchedule` | **off** | `GET /schedule` live on the target deployment |

A default-on app calling a route that does not exist on production would show "Temporarily unavailable" on that screen. Keep `pulse` and `studioSchedule` off in shipping config until section 1 is true; the decision to flip them belongs to the release owner. Both were verified on a device (`mobile/business/DEVICE_QA_RESULTS.md`, R5).

## 5. Push notifications (optional; off without credentials)

Without Firebase credentials and an EAS project id the More screen says notifications are not available and everything else works. To turn them on:

- apply `20260626_student_push_notifications_v1.sql` (table `mobile_push_tokens`) and `20270213080000_mobile_push_token_claim.sql` (the claim function; the Student release needs both too) to the target database;
- the build needs `google-services.json` (see `Android_Push_Firebase_Setup.md`) and the EAS project id;
- the app registers an Expo push token with `claim_mobile_push_token(..., 'danceflow-business')` (no new route or table);
- a staff-facing **sender** does not exist yet (which events notify which staff, and the `{type, id, studioId}` payload `notificationRoute.ts` expects), and the token is not yet unbound at sign-out.

## 6. The build (needed)

- Signed AAB from `main`: `docs/mobile/Android_Release_Audit.md` and `Google_Play_Internal_Testing.md` (QA-key builds are never uploaded).
- Build-time env: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_DANCEFLOW_WEB_URL`, optionally `EXPO_PUBLIC_STAFF_FEATURES`. The app refuses to start without the first three.
- Icon, adaptive icon, splash and notification icon are wired (#513) and were checked on a release build.
- Text size: `fontScale` is handled by the activity (#531), so a live text-size change never leaves clipped layouts; the new size applies at next launch.
- Play listing items outside the app: privacy policy and the public account-deletion page (`/account-deletion`, #516), data-safety form, internal-testing track and tester list.

## 7. Suggested sequence for the owner

1. Promote a web build that contains `/api/staff/**` (needs the `main` reconcile).
2. Apply `20270214120000` to production (before step 3's routes are relied on).
3. Verify with a real staff account against production: `/api/staff/me` returns the workspace, `today` returns the day, a class detail for an assigned instructor returns a roster (not 503). The repo's HTTP QA scripts (`scripts/qa/staff-api/`) are for disposable stacks only; do not point them at production.
4. Confirm the redirect URL and the three server env values (sections 1 and 3).
5. Build the signed AAB with the production URLs, flags as in section 4 (`pulse`/`studioSchedule` on only if step 1 included the slice 3 routes), upload to internal testing.
6. Optional later: push (section 5).

## 8. What has and has not been proven

Proven locally on a disposable stack with real sign-in and real row-level security, via a production Next build and a release APK on an emulator: Today, appointment and class detail, attendance, Clients, Pulse and the studio schedule, in light and dark at font 1.0 and 2.0, with the empty, 401, 403 and outage states (`DEVICE_QA_RESULTS.md`, R1 to R5). **Not proven**: anything against the production database or deployment, push delivery, iOS (no macOS available), TalkBack end to end.
