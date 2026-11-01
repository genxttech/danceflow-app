# Organizer Suite complimentary grant expiry job (D7)

Status: implemented, **dark**, **not registered** anywhere that would run it. Requires migration
`20270203090000_organizer_suite_entitlement_integrity.sql` (branch `claude/d7-suite-entitlements-db`) on the target database.

## What it does

`GET|POST /api/cron/organizer-suite-entitlement-expiry` (code: `src/app/api/cron/organizer-suite-entitlement-expiry/route.ts`,
`src/lib/billing/organizerSuiteExpiryJob.ts`) makes **one** call per invocation, with the service-role client, to
`public.expire_due_usage_addon_entitlements(p_as_of => server now, p_feature_key => 'organizer_suite')`.

That function sets `status = 'expired'` on rows that are `source = 'manual_grant'`, `status = 'active'`, feature
`organizer_suite`, with a `period_end` whose end instant has passed. The end instant is the **start (00:00 local) of the
period_end calendar day in the studio's timezone** (period_end is exclusive; NULL/unknown timezone falls back to UTC). For
DanceAbel's grant (period_end 2027-07-09, America/New_York) that is 2027-07-09T04:00:00Z.

Owner policy: a complimentary grant ends on its period_end; afterwards access needs a separately purchased paid add-on (a
`stripe_subscription_item` row). The job **never purchases, charges, extends, creates or deletes** anything and never touches
Stripe-sourced rows. History is preserved: only `status` and `updated_at` change.

The response contains counts only, never studio, organizer or entitlement ids or notes:

| Mode | 200 body |
| --- | --- |
| run | `{ ok: true, dry_run: false, as_of, expired_count }` |
| dry-run | `{ ok: true, dry_run: true, as_of, would_expire_count }` |

`as_of` is always the server clock; a caller cannot choose it (no early expiry by request).

## Switches

| Env | Default | Effect |
| --- | --- | --- |
| `ORGANIZER_SUITE_EXPIRY_ENABLED` | unset (off) | Anything other than the exact string `true` answers **404** and touches nothing (checked before auth). |
| `CRON_SECRET` | existing | Required as `Authorization: Bearer <secret>` or `x-cron-secret`. Missing secret config -> 503; wrong/missing header -> 401. |
| `ORGANIZER_SUITE_EXPIRY_DRY_RUN` | unset | Exactly `true` forces every call into dry-run; a caller cannot turn it off. |
| query `?dry_run=1` (or `true`) | - | Dry-run for that call. |

## Failure behaviour

| Condition | Status | Body |
| --- | --- | --- |
| RPC missing (migration not applied: PostgREST `PGRST202` / Postgres `42883`) | 503 | `{ ok: false, error: "migration_not_applied" }` |
| Any other RPC/read error, unexpected payload, admin client failure | 500 | `{ ok: false, error: "expiry_failed" }` |

No count is reported on failure. Logs are fixed event names only (`organizer_suite_expiry_failed`,
`organizer_suite_expiry_migration_not_applied`, `organizer_suite_expiry_expiry_failed`): no ids, no error text.

## Retry and concurrency

The RPC is a single statement: rows are claimed `FOR UPDATE SKIP LOCKED` and the update re-checks `status = 'active'`.
A repeated call expires 0; two overlapping calls never expire (or audit) the same row twice. A failed call changes nothing
(the statement is atomic), so simply retry on the next tick. No lease is needed.

## Audit evidence

The audit trigger writes one `usage_addon_entitlement_events` row per expired entitlement:
`event_type = 'status_change'`, `from_status = 'active'`, `to_status = 'expired'`,
`actor = 'system:expire_due_usage_addon_entitlements'`,
`reason = 'complimentary grant reached period_end (expire_due_usage_addon_entitlements, as_of <as_of>)'`.
The events table is append-only. Query it (service role / SQL editor) to see what a run did.

## Cadence (configuration, not activation)

Suggested: **hourly at minute 7, `7 * * * *`** (`ORGANIZER_SUITE_EXPIRY_SUGGESTED_SCHEDULE`).

Why: the end instant is local midnight, which lands on a different UTC hour per studio timezone and moves with DST. A daily
run at a fixed UTC hour could leave the stored status `active` for up to ~24 hours after the end. Hourly keeps the lag under
an hour. Access itself does not depend on the job: every reader applies the same boundary rule at request time
(`organizerSuiteEntitlement.ts`), so the job only reconciles stored status and produces the audit trail. Minute 7 avoids the
crowded top-of-hour slot.

`validateOrganizerSuiteExpirySchedule()` sanity-checks a proposed schedule: 5 numeric cron fields, a single fixed minute (at
most hourly), and day/month/weekday `*` (at least daily).

## Registering it later (deliberately)

1. Apply migration 20270203090000 to the target database (separate authorization).
2. Set `ORGANIZER_SUITE_EXPIRY_ENABLED=true` (and optionally `ORGANIZER_SUITE_EXPIRY_DRY_RUN=true` for a first observation
   window) in the target environment.
3. Verify with dry-run (below), then add to `vercel.json` `crons`:
   `{ "path": "/api/cron/organizer-suite-entitlement-expiry", "schedule": "7 * * * *" }`.
   The route tests assert it is **not** registered today; update that assertion in the same release change.

## Verify with dry-run

```
curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/organizer-suite-entitlement-expiry?dry_run=1"
```

Dry-run only SELECTs (`usage_addon_entitlements`, `organizers`, `studios`) and applies the shared TS boundary rule
(`entitlementEndInstant`), the twin of the SQL rule; it never calls the mutating RPC. It cannot detect a missing RPC; a real run
answers 503 in that case.

## Disable

Unset `ORGANIZER_SUITE_EXPIRY_ENABLED` (or set anything other than `true`): the route answers 404 immediately. Remove the
`vercel.json` entry if one was added. Nothing needs to be undone in data; expired rows stay expired (re-activating a grant is a
manual, audited owner decision, never automatic).

## Evidence

Local integration (disposable PROD-equivalent Postgres, migration 20270203090000):
`scripts/qa/d7_expiry_job_integration.sh` + `.sql` + `d7_expiry_ts_boundary_check.ts`. Not run against any hosted
database; no real cron has called the route.
