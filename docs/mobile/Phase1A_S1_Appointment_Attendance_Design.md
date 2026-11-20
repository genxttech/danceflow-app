# Phase 1A S1: one-to-one appointment attendance (design note)

Route: `PUT /api/staff/workspaces/{studioId}/appointments/{appointmentId}/attendance` (contract in `Staff_API_Contract.md`). Code: `src/lib/staff/appointmentAttendance.ts`, called by the two web actions (`markAppointmentAttendedAction`, `markAppointmentNoShowAction`) and by the route.

## What changed

- The attendance logic and the package/membership helpers it needs moved out of `src/app/app/schedule/actions.ts` into the lib (moved verbatim, only the Supabase client type widened to `SupabaseClient`). The web actions are now thin: access guard, form parsing, call, redirect.
- `syncPackageUsageForAttendedAppointment` stays exported from `actions.ts` as a one-line wrapper, so existing importers and tests are unchanged.
- One deliberate web behaviour change: a **repeated no-show** (double submit) no longer rewrites the status, clears membership usage or writes a second "marked no-show" activity note. It still re-applies the requested charge, which is idempotent in the database. Before, each repeat added a duplicate note.

## Findings that shape the contract

1. **There is no reset.** Neither the web nor the database allows it. `attended` and `no_show` are terminal for private lessons (trigger `enforce_private_lesson_attendance_lifecycle`, migration `20260911121000`), by an explicit product decision; correcting an outcome is a future, undesigned "Attendance Correction" workflow with its own authority, reason and refund semantics. The route therefore has `attended` and `no_show` only, and answers a flip with `409 outcome_conflict`. A mobile "reset" needs that product decision first; it is not an extraction.
2. **The deduction is already atomic and exactly-once, in the database.** The `deduct_package_credit_when_appointment_attended` trigger (fires on the status change) and the `deduct_package_credit_for_appointment` RPC lock the package row, then the item, and look for a prior `lesson_deduction` / `appointment_attendance` marker. No migration or RPC was needed. Proven on real Postgres: five sequential retries, six concurrent submits (same key, different keys, three different callers) and a repeated or raced charged no-show all take exactly one credit.
3. **The multi-step flow is not one transaction, and that is safe.** Status write, usage sync, earning staging and the no-show note are separate statements. A failure after the status write leaves "attended, deduction pending" (route answer `409 usage_sync_pending`) or "no-show, charge not applied" (`409 charge_failed`). Repeating the same request completes the missing step without a second deduction (the same replay rule the web action had). No half state is hidden: the answer says what is pending. Making it one transaction would need a new RPC, hence a migration; not done.
4. **No `createAdminClient` is involved.** The attendance path uses the caller's own client (cookie client on the web, bearer client in the API), so RLS applies identically. The only `createAdminClient` use near this file (line ~546) is notification delivery in an unrelated action. The deduction RPC and the triggers are `SECURITY DEFINER` and authorize through `user_studio_roles` (owner, admin, front desk, instructor, independent instructor), so an instructor's bearer call reaches them. Verified for the assigned instructor in the local-stack test.
5. **Expired packages and the payment gate keep web parity.** `canMarkAppointmentAttendedWithoutPaymentWarning` is moved unchanged: pay-as-you-go needs the lesson paid, free/comped passes, membership needs a covering membership, package needs an active package with remaining credit (or unlimited). The gate does not look at package expiry; neither did the web.
6. **Membership usage depends on trigger `appointments_sync_membership_usage_for_private_lesson`.** The migration creates it disabled; it is enabled on DEV and PROD (read-only check 2026-11-20). The local baseline stack ships it disabled, so the local test enables it, as a cutover would.

## Tables written (same as the web action; the new path writes nothing else)

| Step | Table | By |
| --- | --- | --- |
| status | `appointments` (`status`, `attendance_marked_at`, `updated_at`) | the action / lib, as the caller (RLS) |
| package credit | `client_package_items` (`quantity_used/remaining`), `lesson_transactions` (`lesson_deduction`), `client_packages` lifecycle (`active`) | `deduct_package_credit_*` trigger and RPC, `reconcileClientPackageLifecycle` |
| membership usage | `client_membership_usage` (+ `membership_usage_sync_errors` on ambiguity) | membership usage trigger |
| instructor pay | staged earning row via `stageInstructorEarningForAppointment` (attended only) | lib |
| no-show note | `client_activity_notes` (`general`, "Appointment marked no-show…") | lib |
| reward points | via `trg_reward_appointment_attended` | trigger |

There is no separate audit table for either path today. The note (no-show) and `attendance_marked_at` (attended) are the existing record. The route does not add a `source = mobile` field: a new column would be a migration.

## Write gate

The route is behind `requireStaffWrite(request, studioId, "appointmentAttendance")` (kill switch `STAFF_API_WRITE_POLICY`, `X-DanceFlow-App` version header). Idempotency is pattern 1 (state-based). Conflict vocabulary: `outcome_conflict` (with `current.status`), `payment_required`, `usage_sync_pending`, `charge_failed`, registered in the contract.

## Live line

`origin/release/website-embeds` has identical attendance actions (no diff in the two functions) and the same staff API files, so the extraction backports without conflict in these functions.

## Evidence

- `localStack.staffApiAppointmentAttendance.test.ts` (15 tests, real Postgres, RLS, real triggers): exactly-once under retry and race, last credit, zero and unlinked package, pay-as-you-go, comped, membership, no-show with and without charge, terminal both ways, owner/front desk/assigned instructor allowed, colleague 404, independent 403, other studio 403/404, group class / floor rental / cancelled 409, request validation.
- `staffApiAppointmentAttendance.unit.test.ts` (route mapping and role matrix) and the shared refusals suite (`staffApiSlice2Refusals.test.ts`, 401/403 before any data read).
- Existing web tests unchanged and green (`markAppointmentAttendedAction`, `syncPackageUsage`, `attendedAppointmentLifecycleGuards`, the schedule and staff suites).
