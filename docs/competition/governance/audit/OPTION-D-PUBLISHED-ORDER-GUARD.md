# Option D: published running-order write guard (draft, NOT APPLIED ANYWHERE)

Owner conditional approval 2026-11-26 (non-applied draft engineering and local tests only). No DEV / PROD apply, merge, deploy or activation is requested.

## The gap (executed evidence)

Local run of 2026-11-26 (PR 865, `R-11-PROBE-LOG.txt`, database role `authenticated`, one manager, composed chain without this change): on a **published, never-run** heat these direct writes were **accepted**: changing `round_id`, detaching it from its version, changing `heat_number`, setting status `cancelled`. Moving a published spare heat to a new round this way was one of the four executed routes to a self-approved replacement of a corrected result (route R). Already refused then: floor-heat, division, contest, time and label changes together (placement validator), delete and heat-entry changes (10D).

## What the migration does (`20270301170000`)

* Heats: a direct client write that changes a placement column (including floor label, dance offering, duration, status), inserts into, or deletes from a published or past order is refused; every referenced version must be a draft and is locked `FOR SHARE`.
* Versions: clients create only draft / review; cannot move a draft into another status; on a version that left draft / review only `name` and `updated_at` can change; no delete.
* Publication: `publish_competition_schedule_version` becomes **SECURITY DEFINER** (it already requires `can_manage_event_competition`; `anon` keeps its grant and is refused by that check) and locks the version `FOR UPDATE` before validating. Pinned text replacement: pre md5 `9a61cd9bcdbe8557d76cd6ec9e72c82c` (the 10D text, computed offline), post `abccc653c7c2380c7ec65c97a54526dd`.
* Rollback restores the pinned publication text and drops the two triggers and two functions.

## What it does NOT close

**The spare-round replacement routes (NC, CS, CA) stay open**: they use no direct write. That is Option B (separate decision write-up). Also unchanged: heat entry and heat dance status writes (U18 / U18-S own entry status), direct inserts of publication rows, round name or sequence changes, heat configuration, TRUNCATE grants, advanced-mode schedule items.

## Dependencies and interplay

Base `release/website-embeds`; independent of PR 865 (touches no approval object). Effectiveness against replacement also depends on **U18 (PR 867)**. S4 (PR 866) `r15_guard_*` triggers fire before these (`zz_` names). S3 (PR 864): none. **OD-26 (PR 854)** writes only floor-heat numbers through a definer function: unaffected; a later authorized change to published heats must be a definer function. OD-07 (PR 838) / OD-12 (PR 845): none. Legitimate writers were inventoried by code reading: all definer except create-version, heat-plan apply and entry lifecycle, which write drafts or entry status.

## Review

An independent reviewer of the first draft found one blocker (a manager could still unpublish or replace the live order by direct writes) and test / runner defects (suite could not pass; four suites silently skipped; vacuous gap checks; old floor-heat branch untested; columns missing; publication race). This revision changes the publication function, the version rule, the columns, the suite, the races and the runner in response. **The revision itself has not been re-reviewed.**

## Tests

`sql-tests/test_T_competition_d_published_order_write_guard.sql`, `sql-tests/concurrency/run_d_publish_race.sh`, runner `scripts/qa/comp-d/run-d-standalone.sh` (baseline, apply, existing suites, rollback, re-apply, races; F2 races with PR 865 as information only). **Execution: PENDING** (heavy-lock queue).
