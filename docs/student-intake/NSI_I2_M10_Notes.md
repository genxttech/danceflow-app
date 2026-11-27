# NSI I2 M10: `intake_ensure_request` applies the eligibility evaluator

Status: **authored and validated on a fresh local disposable stack only. NOT applied to DEV or PROD.** Needs an independent review pass before any DEV apply (then DEV apply via `sb.sh dev-apply`, announced to the coordinator first). Never PROD without owner approval.

Files
- `src/lib/supabase/migrations/20261118099000_nsi_i2_m10_ensure_request_evaluator.sql`
- `src/lib/supabase/migrations/rollback/20261118099000_nsi_i2_m10_ensure_request_evaluator_rollback.sql`
- `sql-tests/test_T_nsi_i2_m10_ensure_request_local.sql` (17 checks), `sql-tests/nsi_i2_m10_lifecycle_local.sh`

## What changed

Closes the P1 release blocker recorded in M7-M9 notes (P1-BLOCKER-1..3): the write path did not apply the first-appointment rule, the `enabled_at` watermark or the 10-minute settle delay.

For `p_source = 'auto'` the function, after the structural checks and under the client lock, calls `intake_private.evaluate_appointment_eligibility(studio, client, appointment, now())` (the same code the preview and simulation use):

| Evaluator outcome | Write path |
|---|---|
| `would_create`, `would_create_reintake`, `would_attach`, `already_attached` | create or reuse the open request and attach the appointment (as before) |
| `already_completed` | return the completed request, write nothing |
| `type_not_selected`, `no_template` | raise 22023 (unchanged messages) |
| everything else: `studio_not_enabled`, `studio_not_entitled`, `before_enablement`, `settling`, `existing_student`, `earlier_appointment_pending`, `imported_source`, `erasure_barrier`, `predates_reintake_floor`, `no_published_version` | return NULL, write nothing |

Manual (staff-initiated) requests are unchanged. The table-level collection gate (Gate A, Gate B, barrier) still guards every writer, including direct ones.

Behavior changes to know about
- Where the old function raised 42501 (`retention_policy_incomplete`, `new_obligation_not_allowed`, erasure barrier) for an automatic call, the evaluator now answers first and the function returns NULL. A caller must treat NULL as "no obligation (yet)", not as an error. The I4 reconciler should call the evaluator itself for reasons.
- `no_published_version` returns NULL (previously a request could be created before any version was published).
- The `earlier_appointment_pending` case: the later booking returns NULL until the first appointment has created the request; then it attaches (`would_attach`).

## Validation (local, fresh Postgres 17.6 containers, heavy lock held)

Lifecycle harness `nsi_i2_m10_lifecycle_local.sh <public-schema-dump>`. Schema dump = `pg_dump -s -n public` of `df-isoqa/base:20261118090000` (main's chain before NSI).

- Catalog fingerprint M9 `534c5e93…|670` (identical to DEV). M10 `c6b3d46b…|670`. **Exactly two catalog parts differ M9 vs M10**: `intake_private.assert_catalog` and `public.intake_ensure_request` (ACLs, security-definer flag and search_path unchanged).
- Rollback restores the M9 fingerprint exactly; a second rollback is refused; forward again reproduces M10; M10 replay is idempotent; M8 and M9 replays fail closed on an M10 database and change nothing.
- Suites on M10: M10 boundary suite 17/17, M7 36/36 (one assertion widened: from M10 a lapsed grant yields NULL instead of a 42501 refusal; the table gate still refuses direct writers), M9 17/17. M8 suite passes on M9 only (it asserts the open P1 behavior by design). I1 foundation and I2-local suites pass on M10 with M10-aware edits to F18, G05, G06 (the "documented divergence" checks now assert the divergence is closed).
- `test_T_nsi_i1_local.sql` (303 checks) is valid for M1-M9 only: its fixtures create obligations through `ensure_request` with an appointment created "now" and no grant, which the evaluator correctly answers with NULL. It passes on M9 in this harness. Because the M9 to M10 catalog diff is exactly the two parts above, the remaining I1 behavior is unchanged; porting its obligation fixtures to eligible ones (grant, `enabled_at`, aged appointment) is a follow-up, not a blocker for DEV.
- Environment note: the pre-NSI image's `appointments` structural fingerprint is `ff651a6c…`, not PROD's `e0c4db1b…`: PROD also has the `group_class_enrollment_holds` FK and the floor-rental financial-fields trigger, which the image lacks. The harness takes the image value (`NSI_APPT_FP`). NSI adds nothing to `appointments` (checked by the catalog self-check).

## Not covered / still to do
- Independent review of M10 (required before DEV apply).
- Concurrency check of two parallel `ensure_request` calls for one client (the client lock is unchanged, but no new K-test was written).
- Full-chain replay of main's migration folder including M1-M10 (planned as its own heavy-lock slice).
- No UI or reconciler caller exists yet; nothing consumes the NULL outcome.
