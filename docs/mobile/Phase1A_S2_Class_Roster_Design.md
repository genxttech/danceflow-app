# Phase 1A S2: class roster drop-in enroll and remove (design note)

Routes: `POST .../appointments/{id}/roster` and `DELETE .../appointments/{id}/roster/{clientId}` (contract in `Staff_API_Contract.md`). Code: `src/lib/staff/classRoster.ts`, called by `enrollClassAttendeeAction` / `cancelClassAttendeeAction` and by the routes. Write gate capability `classRoster`.

## What changed
- The RPC calls, the membership precheck, the booked-only removal notice and the dancer notices moved from `src/app/app/schedule/actions.ts` into the lib. The two web actions keep their parsing, redirects and in-context return rules and call the lib.
- One source-text test (`groupClassDbAuthority.gcsc3`) asserted the classifier call in `actions.ts`; it now points at the lib.
- The web page behaves as before: the API-only reasons `not_found` and `invalid_funding` map to the page's existing generic `enrollment_failed`.

## Findings
1. **Almost no logic beyond the RPCs.** Capacity, duplicate enrollment, cancelled class, funding and authority are all inside `enroll_class_attendee` (security definer, row locks, `_gc1_4_class_enrollment_authority`). Proven on real Postgres: five concurrent identical enrolls make one row; five clients racing for the last seat make one winner and four `class_full`; capacity is never exceeded.
2. **Instructor funding is decided by the database, not the caller.** For the class's own instructor the RPC ignores every billing parameter and enrolls only when the dancer has exactly one eligible package or membership; otherwise it refuses (`ambiguous_funding_source`, "ask an owner, admin or front desk"). The API keeps that; the app should not offer an instructor a funding picker.
3. **Package credit is not taken at enrollment**, only at attendance (as on the web). Verified: the item balance is unchanged after enrolling.
4. **Idempotency** is pattern 3 (natural domain key) for enroll: the database's "already enrolled" is read as a replay and answered `200` with the existing attendee, and the notice is not sent again. Removal is pattern 1 (state-based): a repeat is `200 alreadyApplied`, with no second notice (the web action had the same booked-only rule).
5. **`createAdminClient`:** the enroll/remove path uses the caller's client; RLS applies. The only service-role use is inside `notifyGroupClassEnrolled` / `notifyGroupClassRemovedByAttendee` (the dancer email and push), which the web action already called the same way. It reads studio data server-side by id after the write commits, never throws, and cannot widen what the caller may do.
6. **Not built (needs a read route):** a funding-candidate list so the app can show which packages or memberships a dancer could be billed to. Without it the app can enroll with `free_comped`/`pay_as_you_go`, or with ids it already knows; a membership or package choice for ambiguous dancers is for the web until that read exists.

## Tables written (same as the web action)
`appointment_attendees` (insert on enroll; `status = cancelled`, `cancelled_at`, `cancelled_by` on removal), by the RPCs. Dancer notices write whatever the web action already wrote, through the unchanged notifications module. Nothing else; no new column or table.

## Evidence
- `localStack.staffApiClassRoster.test.ts` (14 tests, real Postgres, RLS, real RPCs, isolated harness container): replay, race, capacity and last-seat race, cancelled class, membership and package funding, removal and replay, attendance-recorded refusal, re-enroll, role matrix (owner, front desk, own-class instructor allowed; colleague's class 404; independent instructor 403), tenancy (other studio 403/404, cross-studio client 404), private lesson or missing class 404, write gate (no header 426, disabled 403), request validation.
- `staffApiClassRoster.unit.test.ts`: gate pass-through, roles, validation and every outcome mapping.
- Existing schedule suite (734 tests) green.
