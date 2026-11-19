# Web R+1 release runbook (live line `release/website-embeds`)

Status: PLAN. Nothing in this document has been executed. Prepared 2026-11-19. No deploy, promotion, hosted write or account creation is authorized by this file;
each step that needs authorization says so.

## 1. What is released

Release head **`ab9f344948c1155d8ac414dfdf56541047ba338f`** on `release/website-embeds` = live base `6ba31295` + two squash merges (9 files, `vercel.json` and `package.json` unchanged, 14 crons unchanged):

| Commit | PR | Content |
|---|---|---|
| `1c5da0c8e` | #660 | Web dancer readers read `my_event_registrations` / `my_event_registration_attendees` (`/account`, `/app/account`, `/portal/[studioSlug]`, the `/events/[slug]` retry lookup). Studio staff keep the previous base-table queries scoped to their own client record / own email on the portal and `/app/account` (union with the view for the count). |
| `ab9f34494` | #661 | `GET /api/student/events/[eventId]/availability` (service-role counts only, paged by rows actually returned) and `src/lib/events/ticketAvailability.ts`. |

Files: `src/app/account/page.tsx`, `src/app/app/account/page.tsx`, `src/app/events/[slug]/page.tsx`, `src/app/portal/[studioSlug]/page.tsx`, `src/lib/events/ticketAvailability.ts`, `src/app/api/student/events/[eventId]/availability/route.ts` and three test files. No SQL, no env change.

Prerequisite already true: Gate 1 (the two views + the withheld claim function) was applied on PROD 2026-11-19, so the readers can run before the release. Gate 2 (cutover `20270222093000`, activation `20270222094000`) is NOT part of this release and stays blocked on its own checklist.

## 2. CI evidence on the exact release head

Node 20, GitHub `ubuntu-latest`, SHA-pinned copy of the release workflow (the release copy uses floating action tags the runner rejects, see `claude/ci-verify-*`).

| Item | Value |
|---|---|
| Throwaway branch (DO NOT MERGE) | `claude/ci-verify-r1` = `ab9f3449` + one workflow-only commit |
| Tested commit | `756fae4103ec93cbbdebf5ae84ff20bff11c5a7c` (parent `ab9f344948c1155d8ac414dfdf56541047ba338f`) |
| Run | [44489400958](https://github.com/genxttech/danceflow-app/actions/runs/44489400958), conclusion **success** (typecheck, full Vitest, production build, lint of changed files all green) |
| Vitest | 615 files passed, **9770 passed**, 1297 skipped, 0 failed |
| Baseline (live base `6ba31295`, run 44452969439) | 9752 passed |
| Delta | +18 tests = #660 (+9) + #661 (+9); no other change |

## 3. Pre-flight (before asking for authorization)

1. `git fetch origin release/website-embeds` and confirm `git rev-parse origin/release/website-embeds` = `ab9f344948c1155d8ac414dfdf56541047ba338f`. If it moved, stop and redo section 2 on the new head.
2. Record the live production deployment (expected: the current alias target, `dpl_EJ968dkDy…`): `vercel inspect www.idanceflow.com --scope dance-flow`. This is the rollback target 1.
3. Record the read-only evidence baseline BEFORE any deploy: `bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read docs/events/event-registration-claim-release/gate2_prereq_evidence.sql` (one jsonb row). Keep `view_reads.calls`, `base_reads.calls`, `stats_reset`, `dancer_self_policies` (3 expected) and `claim_function_authenticated_exec` (false expected).
4. Record Production env names: `vercel env ls production --scope dance-flow` (expected 62 names; names only, never values). Record the cron list from `vercel.json` (14).
5. Ask the owner for explicit authorization of the staged build (section 5). Do not run section 5 without it.

## 4. Tree identity: prove the staged deployment equals git `ab9f3449` (read-only)

Method: Vercel stores each deployed file keyed by the sha1 of its raw content; git blob ids are a different hash (they include a `blob <size>\0` header), so the script re-hashes every git blob.

1. The operator who holds the Vercel credential saves the file tree of the staged deployment (never paste the token anywhere):
   `curl -s -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v6/deployments/<dpl_id>/files?teamId=<team_id>" > files.json`
   Confirm the first file entry has a 40-hex `uid`. If the API returns another encoding, stop and report (do not adapt the script silently).
2. From a clean checkout of this repository (any ref that contains the script), run
   `node docs/events/event-registration-claim-release/web-r1-tree-identity.mjs ab9f344948c1155d8ac414dfdf56541047ba338f files.json`
   The script reads git and the saved JSON only; it makes no network call and writes nothing.
3. Expected: `TREE IDENTITY: PASS` with exactly three files absent from the deployment (`.gitignore`, `mobile/student/.gitignore`, `mobile/student/android/.gitignore`; the CLI skips `.gitignore` files), zero extra files and zero content mismatches (3431 git files, 3428 deployed). Anything else is a FAIL: do not promote.
4. Self-test of the script on the exact head (done 2026-11-19, no deployment needed): `node …/web-r1-tree-identity.mjs ab9f344948c1155d8ac414dfdf56541047ba338f --selftest` printed `PASS` with the same three absent files.

## 5. Staged production deployment (NEEDS the owner's explicit authorization; no promotion)

Run from a clean export of the release head only, never from a working checkout:

```
git -C <repo> fetch origin release/website-embeds
rm -rf C:/Dev/verify/web-r1 && mkdir C:/Dev/verify/web-r1
git -C <repo> archive ab9f344948c1155d8ac414dfdf56541047ba338f | tar -x -C C:/Dev/verify/web-r1
cd C:/Dev/verify/web-r1      # no .env, no node_modules, no .vercel in the export
vercel deploy --prod --skip-domain --yes --scope dance-flow \
  --meta gitCommitSha=ab9f344948c1155d8ac414dfdf56541047ba338f --meta gitBranch=release/website-embeds --meta staged=web-r1
```

The `.vercel` project link has to exist in the export directory (`vercel link` to the qfem project, scope `dance-flow`) before the deploy; copy only `.vercel/project.json` from the operator's link, never an `.env*` file. `--skip-domain` creates a production-target deployment that is NOT aliased to `www.idanceflow.com`.

### 5.1 Verification of the staged deployment (all read-only)

| Check | Expected |
|---|---|
| `vercel inspect <staged-url>` meta | `gitCommitSha` = `ab9f344948c1155d8ac414dfdf56541047ba338f`, target production, status Ready |
| Aliases of the staged deployment | `[]` (only the generated `danceflow-app-qfem-…vercel.app`); `www.idanceflow.com` still resolves to the pre-release deployment |
| Cron list in the deployment | 14 crons, identical to `vercel.json` at `ab9f3449` (list in section 8) |
| Production env names | same 62 names as pre-flight (names only) |
| `www.idanceflow.com` | unchanged: `vercel inspect www.idanceflow.com` still the pre-release deployment id |
| Tree identity | section 4 PASS against the staged deployment id |

The staged URL is behind Vercel SSO: anonymous requests redirect, so smoke tests that need HTTP run after promotion on `www`, or by the owner in a signed-in browser pane (read-only, no forms).

## 6. Promotion (separate authorization) and post-promotion smoke

Promotion is its own gate: promote the staged deployment id only after section 5.1 and section 4 pass and the owner says so (`vercel promote <staged-url> --scope dance-flow`). Immediately after, on `https://www.idanceflow.com`:

| Request | Expected |
|---|---|
| `GET /`, `/login`, `/discover/studios` | 200 |
| `/login` response headers (frame/CSP/`x-frame-options`) | identical to the values recorded before promotion (pre-record them in section 3) |
| `GET /embed/class/x` | 404 |
| Each existing cron path, unauthenticated | 401 |
| the price sweep cron (`/api/cron/sms-price-sweep`) unauthenticated | 401 |
| `GET /api/student/events/<random uuid>/availability` unauthenticated | 401 |
| Signed-in smoke (dancer `/account`, `/portal/<studio>`, `/events/<slug>` retry; staff `/app/account`) | only if a test dancer/staff account already exists on PROD: ask the coordinator, never create accounts |

Do not call any write endpoint, checkout, or cron with a secret.

### 6.1 Evidence that the readers use the views (read-only, any time afterwards)

Re-run `gate2_prereq_evidence.sql` (section 3, step 3). Expected: `view_reads.calls` rises above the baseline once real users load the pages; `base_reads.calls` stays (staff paths and other readers still use the base table; it is not expected to fall to zero); `dancer_self_policies` still lists the 3 policies; `claim_function_authenticated_exec` still false. A rising `view_reads.calls` is the "web readers live" evidence for the Gate 2 prerequisite list; "a view-reading Student build is live and seen" is separate and is not satisfied by this release.

## 7. Rollback

No SQL is involved, so rollback is app-only. Promote, in this order, the first one that restores the expected behavior: `dpl_EJ968dkDy…` (the pre-release live deployment), then `dpl_BVxHhpW5…`, then `dpl_DvJFayDd…`, then `dpl_FEzqXu6N…` (`vercel promote <id> --scope dance-flow`; use the full deployment ids from `vercel ls`). If the views are ever rolled back (Gate 1 rollback), undo this release first: the new readers need the views.
Rollback does not interact with Gate 2: do not apply Gate 2 until this release has been live and verified, and if this release is rolled back, Gate 2 must not be applied.

## 8. Cron paths (unchanged, 14)

`/api/notifications/generate`, `/api/notifications/send`, `/api/platform/daily-digest`, `/api/cron/google-calendar-sync`, `/api/cron/aria-digest`, `/api/cron/aria-operations`, `/api/cron/document-operations`, `/api/cron/event-cart-orders`, `/api/cron/sms-onboarding-purge`, `/api/cron/sms-usage-reconcile`, `/api/cron/sms-provider-fee-lifecycle`, `/api/cron/sms-price-monitor`, `/api/cron/sms-price-monitor-watchdog`, `/api/cron/sms-price-sweep`.

## 9. What users will and will not notice

Dancers (and anyone signed in) will see the same pages: their event registrations, tickets and the account count now come from the column-restricted views instead of the base tables, so the numbers and rows are the same as before (the portal shows a dancer's own registrations in the studio even when one has no client attached, and a family account sees all of its own registrations under any linked client). Studio staff, organizers and platform admins notice nothing: staff keep their previous queries on their own client record and email, and the staff screens are untouched. The new availability route exists but nothing calls it yet because the Student app build that uses it is not released, and the claim function and Gate 2 stay off, so no dancer gains or loses access to anything on the day of this release.
