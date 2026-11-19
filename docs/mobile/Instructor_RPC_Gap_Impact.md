# Instructor RPC gap on PRODUCTION: impact and smallest fix

2026-11-18. Question from the APPS coordinator: the live web line calls `get_teaching_clients_for_instructor` (and `search_bookable_clients_for_instructor`), PROD does not have them; does an instructor on PROD hit error pages today, and what is the smallest fix? Analysis only: read-only PROD queries (`sb.sh prod-read`, aggregate counts and object names, no row data, no names, no studio identifiers), read-only Vercel log queries, git. No SQL applied, no deploy, no env change. Marks: **V** verified (evidence named), **A** assumed.

## 1. Headline

**It is not hurting anyone today; it is a latent defect that will bite the first instructor-role user.**

- **V:** PROD has **zero** `instructor`-role rows in `user_studio_roles` (6 `studio_owner`, 1 `front_desk`), so no one can reach any of the failing instructor paths.
- **V:** **0** log matches in the last 14 days of production runtime logs for the error text, both function names and `PGRST202`.
- **V:** the cause is an **ordering inversion**: FC-1B5D **Phase B** (the `clients` RLS tightening, `20260906090000`) **is applied on PROD**, while FC-1B5D **Phase A** (`20260905160000` teaching clients, `20260905160100` bookable search) **is not**. Phase A's header says Phase B is a later slice to follow it once every instructor path uses the controlled functions, and Phase B's header says Phase A already removed the instructor client paths. With both missing, an instructor has no direct read of `clients` and no function to read through.
- **Smallest fix: apply the two additive Phase A migrations** (section 6). No code change can substitute for them. Do it before any instructor-role user is created (web or Business app).

**Correction to my earlier doc (`Staff_API_Live_Line_Backport_Feasibility.md`, #666):** it said Phase B was not applied. That was an unverified inference from the policy name. The PROD policy `studio staff manage clients` is the **tightened** form (section 3). The feasibility doc is corrected in the same PR as this one.

## 2. Who could hit it (V, PROD read-only)

Definition used: an active `user_studio_roles` row with role `instructor`, plus an active `instructors` row for the same user and studio, in a studio whose subscription is `active` or `trialing`.

| Measure | Value |
|---|---|
| `user_studio_roles` by role (all active) | `studio_owner` 6, `front_desk` 1, **`instructor` 0** (no inactive instructor rows either) |
| `instructors` rows | 7 active: 6 linked to a user (these are owners who also teach, role `studio_owner`), 1 with no login |
| Studios | `active` 3, `trialing` 1, `cancelled` 1, `not_started` 2 |
| Instructor logins in active/trialing studios | **0** |
| Instructor-only users with a client-linked appointment in the past 30 days / next 14 days / either | **0 / 0 / 0** |
| Instructor-only users with a group class in that window (roster paths) | **0** |
| Instructor-only users who signed in within 30 days | **0** |

**Owners who also teach are not affected (V):** every failing call is gated on the *role* being exactly `instructor` (`src/app/app/page.tsx:1007` `context.studioRole === "instructor"`; `schedule/page.tsx:1192`, `schedule/[id]/page.tsx:473`, `schedule/calendar/page.tsx:579`, `schedule/actions.ts:4367` `role === "instructor"`). An owner with an `instructors` row takes the broad path and reads `clients` under the owner/admin/front-desk policy.

## 3. Why an instructor would fail, and how (V)

**PROD `clients` policies (read from `pg_policies`):** `studio staff manage clients` (ALL) with a predicate allowing only `studio_owner`, `studio_admin`, `front_desk` (and platform admin); two portal-user SELECT policies; **no** role-agnostic "studio members can view clients" policy. That is the Phase B end state. `get_client_by_qr_token_for_checkin` (from the later `20260905160200`) exists; both Phase A functions do not.

**What each live-line call site does with the missing function** (read from the code on `origin/release/website-embeds`, run only for role `instructor`):

| Call site | Function | On error | Effect for an instructor |
|---|---|---|---|
| `src/app/app/page.tsx:2709` (dashboard, only when the day has client-linked appointments) | teaching clients | **throws** `Failed to load appointment clients` (`page.tsx:2727-2730`) | the dashboard errors |
| `schedule/page.tsx:1407`, `schedule/[id]/page.tsx:625`, `schedule/calendar/page.tsx:809`, `schedule/[id]/edit/page.tsx:455`, `schedule/new/page.tsx:322`, `schedule/self-service/page.tsx:197` | teaching clients | error ignored, `data ?? []` | pages render, client names are missing |
| `schedule/actions.ts:115` (booking client search action) | bookable search | **throws** `Failed to search clients` | "new appointment" client search fails |
| `schedule/groupClassRosterActions.ts:91` | bookable search | returns `[]` | roster add-client search finds nobody |

Because Phase B is applied, a code fallback to a direct `clients` read would also be refused by RLS for an instructor, so **no code-only fix restores names**; it could only hide the error.

**The Business staff API (V):** `src/lib/staff/instructorToday.ts` and `src/lib/staff/clients.ts` call `get_teaching_clients_for_instructor` for the instructor scope and throw on error, so an instructor gets 503 there too (see the feasibility doc). The roster-names function `20270214120000` is a separate gap.

## 4. Evidence from production logs (V)

Vercel CLI 60.0.1 (the cached binary), read-only `vercel logs`, project `danceflow-app-qfem`, environment `production`, level and text filters below. **Retention:** a 30-day window is rejected by the API (HTTP 400); 14 days and 10 days are accepted. Control: logs do flow (50 lines from the last hour; 25 error-level lines in the last 7 days).

| Query (14 days, production) | Matches |
|---|---|
| `Failed to load appointment clients` at error level | **0** |
| `get_teaching_clients_for_instructor` at any level | 0 |
| `search_bookable_clients_for_instructor` at any level | 0 |
| `PGRST202` (PostgREST "function not found") | 0 |
| `Could not find the function` | 0 |

Consistent with section 2: nobody is on these paths. It does not bound earlier history (the first 16 or more days are outside retention).

## 5. Is PROD missing anything else the live line needs? (systematic, V with limits)

| Check | Result |
|---|---|
| Every `.rpc("<literal>")` in live-line `src` (260 distinct names, 304 call sites, multi-line calls included; dynamic names are not captured) against `pg_proc` in schema `public` on PROD | **exactly 2 missing:** `get_teaching_clients_for_instructor` (7 call sites above) and `search_bookable_clients_for_instructor` (2 call sites) |
| Every function created by the live line's 472 migration files (1,260 created, 1,242 after later `drop function`s) against PROD | **3 missing:** the two above and `record_workspace_access` (`20260524_workspace_last_access_tracking.sql`), which no `src` file calls (grep), so it has no impact |
| Every `.from("<literal>")` in live-line `src` (294 distinct relations) against tables, views and materialized views in `public` | **3 real missing:** `client_payment_methods` (`src/lib/booking/selfServiceQueries.ts:167`), `leads` (`src/app/app/events/[id]/registrations/actions.ts:1056`, an `insert`), `staff` (`src/app/app/schedule/actions.ts:572`); a fourth hit, `users`, is a code comment. **No migration in the repository creates any of these three tables**, so they are legacy or dead code paths rather than pending SQL; their reachability and effect were **not** analysed beyond the caller list (severity unassessed: **A**) |
| Column-level drift across all queries | **not checked** (the staff API's 53 columns were checked and are present, see the feasibility doc) |

## 6. Smallest fix: apply the two Phase A migrations (recommended)

| File | SHA-256 | Rollback SHA-256 | What it does |
|---|---|---|---|
| `src/lib/supabase/migrations/20260905160000_fc1b5d_teaching_client_access_rpc.sql` | `ef7ce593a4c5f4eae2835dd62fff4124a464a4a1900bb2cf96926f90c1e733f5` | `63a5e7ba3aea1337188511cc6b652523819ee05ab8e724e98c30f4d0cb8fe180` | creates `get_teaching_clients_for_instructor(target_studio_id uuid, target_client_id uuid default null)`: security definer, identity from `auth.uid()` through `instructors.user_id`, returns only id, name, dance goals, skill level, photo (never notes, referral source, birthday, financial fields or the QR token); grants: revoked from `public` and `anon`, executable by `authenticated` and `service_role` |
| `src/lib/supabase/migrations/20260905160100_fc1b5d_booking_client_search_rpc.sql` | `5187770af39932b80115ea27b74329d7b725fd2aa8ad4a8b722ca82834bd554e` | `2fab9db225313fe9e8e2b7570385ecbca6eff41c6415256bab037ae89c358a76` | creates `search_bookable_clients_for_instructor(target_studio_id uuid, search_text text, limit_count int default 20)`: security definer, caller must be an active instructor of that studio, at least 2 characters, capped at 20, returns id and name only; same grants |

- **Additive (V):** each creates one function and its grants; neither alters a table, policy or existing function (the first file's header states it changes no RLS policy; the second is independent of it).
- **Dependencies (V, PROD read-only):** all 19 columns they read exist on PROD (`appointments.instructor_id, client_id, status, starts_at, ends_at, duration_minutes, studio_id`; `instructors.id, user_id, studio_id, active`; `clients.id, first_name, last_name, dance_goals (text[]), skill_level, photo_url, studio_id, status`). No other function is called. Both function names are free on PROD.
- **Behaviour after applying (V by reading the code):** only role `instructor` callers use them, and there are none today, so applying changes nothing for any current user; it makes the dashboard, schedule pages, booking search and the Business staff API work for the first instructor.
- **Process (owner gates, as for all hosted SQL):** read-only preflight (functions absent, the 19 columns present, the Phase B policy present), owner approval of each file by hash in chat, `sb.sh prod-apply <file> <sha256>`, then a read-only postflight (function exists, `authenticated` can execute, `anon` cannot). The repository's `sql-tests/test_T_fc1b5d_teaching_and_booking_client_rpcs.sql` exercises both functions and is for a disposable database only; a PROD behavioural check needs an instructor account, which does not exist, so the postflight is existence and grants only (**unverified behaviour on PROD** until an instructor exists).
- **Pairs with:** `20270214120000_instructor_class_roster_names_rpc.sql` (roster names for an assigned instructor; separate gap, same population). Approve all three in one gate if instructors are to be invited.
- **Rollback:** the rollback files above drop the functions; safe while no instructor exists.

**Why not a code fallback (V):** Phase B is applied, so an instructor cannot read `clients` directly; a fallback would have to return no names. That converts the dashboard error into nameless rows and the search failures into empty results: a silent degradation, and a release-branch code change, for something the SQL fixes completely.

## 7. What to do until it is applied

- **Do not create an `instructor`-role user (web invite or Business) on PROD** before the SQL gate: the dashboard would error on the first client-linked appointment and client search would fail. The first Business internal test is **owner, admin and front desk only** and is unaffected (`Business_Release_Package_Internal_Testing.md`, `Staff_API_Live_Line_Backport_Feasibility.md`).
- Add the check to the instructor-invite runbook: `get_teaching_clients_for_instructor` and `search_bookable_clients_for_instructor` present on PROD.
- Not urgent by population, but it is the only systematic gap found between the live line and PROD in the function and RPC inventory (section 5); the three missing relations are a separate, lower-confidence item.

## 8. Open items

| Item | Mark | Next step |
|---|---|---|
| Owner approval and application of the two Phase A files (with `20270214120000`) | owner gate | before any instructor-role user exists |
| Why Phase B reached PROD without Phase A (the migration history on PROD is stale; the order may have been manual) | A | not investigated; PROD history is not authoritative (`DEV_Migration_Procedure.md`) |
| Reachability and effect of the three missing relations (`client_payment_methods`, `leads`, `staff`) | A / not analysed | a code reading of each caller by the web owner |
| Behaviour of the functions on PROD with a real instructor | UNVERIFIED | after an instructor exists, one read-only-safe walk |
| Log history older than the retention window | not available | none |
