# Business app, Phase 1A (front-desk day): mobile audit against the plan (2026-11-24)

Audited at main `dfd204abf` against `Business_Expansion_Plan.md` §4 Phase 1A and the staff API contract as merged (S1 #715/#728, S2 #718/#727, C1/C2, P0-5d #729).

| Plan item | Status in `mobile/business` | Where | Gap |
| --- | --- | --- | --- |
| Private-lesson attended / no-show, confirm first, idempotent | **Built** (flag `appointmentAttendance`, off by default) | `PrivateLessonCheckIn`, `setAppointmentOutcome`, `useStaffMutation` (one key per action, same key on retry, optimistic with rollback) | none found. Final-result copy ("can't be changed in the app"), the no-show charge choice, `outcome_conflict`, `payment_required`, `usage_sync_pending`, `charge_failed`, `package_exhausted` all have their own words and recovery (`MutationNotice`). No reset, by decision |
| Client notes (add, list) | **Built** (`clientNotes`) | `ClientNoteSheet`, `ClientNotesList`, `ClientDetailScreen` | none found |
| Quick-add client | **Built** (`clientCreate`) | `AddClientScreen`, `app/clients/new` | none found |
| Class roster drop-in enroll / remove | **Built** (`classRoster`) | `ClassRosterEditor`, `enrollInClass`, `removeFromClass` | none found. Funding picker for an ambiguous dancer is not possible without a funding-candidate read (server follow-up, see S2 design note) |
| One obvious next action on Today / Schedule | **Missing** | studio day showed a plain list | **This PR** (`nextUp`, `NextUpCard`) |
| Instructor attendance | Waits on D4 (instructor SQL gate) | not built, by instruction | none (do not build) |
| 401 / 403 / paused / rate limit / write gate / min version | **Built** | `staffApi` error kinds, `StaffErrorState`, `MutationNotice` | none found |
| 2.0 font scale, TalkBack names, 44 pt targets | **Built** as a static audit and a reading-order harness | `test-utils/a11y.ts`, `a11y.test.tsx` | the new card is covered by the same audit |

Flags: all four write words are default OFF and still need iso-qa device-smoke evidence for the exact commit before a release word is allowed (`Test-StaffFeatures.ps1`). The server policy `STAFF_API_WRITE_POLICY` is a second, independent switch. Nothing here turns either on.

## The one missing slice: "Next up" on the studio day

`src/lib/nextUp.ts` (pure rule) and `src/components/NextUpCard.tsx`, shown on the studio day for **today only**:

- Target: the earliest lesson or class that still has no result (scheduled, confirmed or rescheduled) and has not ended (in progress counts). Check in for a one-to-one lesson, Take attendance for a class. Rentals and other types never get one.
- If nothing is left ahead, the oldest open lesson or class that already ended ("Still to record"). A line says how many earlier ones still have no result.
- A kind is offered only when its capability is on in the build (`appointmentAttendance` for lessons, `attendance` for classes) AND the studio role may mark attendance (the same conditions the appointment screen needs for its controls).
- The button opens the appointment, where the confirm-first controls already live; the card never records a result by itself.
- Fresh: the day is re-read when the screen is focused again (after checking someone in), and the card re-evaluates every 30 seconds, so a class that ends moves to "Still to record". "Today" is the calendar date in the studio's zone, so stepping away and back still counts.
- A day cut off at 500 appointments can miss a later appointment, never pick a wrong target.
- Not added to the instructor "My day" (instructor lesson attendance waits on D4).
