-- Membership Usage-Period Alignment -- P6e: terminal private-lesson
-- attendance lifecycle guard.
--
-- DEFECT/GAP (found while implementing P6d's application-layer
-- enforcement): none of the four real appointment-status writers that can
-- move a private_lesson/intro_lesson/coaching appointment out of
-- `attended`/`no_show` (cancelAppointmentAction's two branches,
-- executeApprovedStudentBookingAction's cancel branch,
-- markAppointmentNoShowAction) guarded against doing so, and
-- markAppointmentAttendedAction did not guard against overwriting
-- `no_show` back to `attended` either. Historically this "worked" only
-- by accident, because the old TypeScript writer's unconditional
-- clearMembershipUsageForAppointment call deleted any consumed
-- membership usage as a side effect of the status change -- an
-- undocumented, unaudited attendance-reversal-plus-entitlement-refund
-- mechanism with no guard, no reason captured, and no sign-off that it
-- was ever meant to work that way. Application-layer guards were added
-- to all five call sites in this same change (see the corresponding
-- application diff), but per this feature's own established discipline
-- ("must not rely on TypeScript routes"), those guards need a DB-level
-- backstop independent of any application code path, RPC, or raw SQL.
--
-- PRODUCT DECISION (this migration encodes, does not make): for
-- private_lesson/intro_lesson/coaching, `attended` and `no_show` are
-- terminal, delivered/completed outcomes. Ordinary scheduling actions
-- (cancel, no-show, re-mark-attended) must never transition an
-- appointment away from either. Correcting a recorded attendance outcome
-- belongs in a future, explicit Attendance Correction / Reversal
-- workflow (not designed or implemented here) with its own authority,
-- required reason, audit trail, and explicit entitlement-restoration
-- semantics.
--
-- SCOPE: a new, small, dedicated trigger -- not an extension of
-- enforce_private_lesson_membership_capacity (P3c). P3c's own concern is
-- membership CAPACITY and is explicitly gated on billing_type='membership'
-- (see its early return: `if new.billing_type is distinct from
-- 'membership' or new.client_membership_id is null then return new;`).
-- This new rule is appointment LIFECYCLE INTEGRITY and must apply
-- identically regardless of funding source (membership, package,
-- pay-as-you-go, or free/comped) -- bolting a billing-type-independent
-- rule onto a billing-type-gated function would be incoherent. Confirmed
-- live before writing this file: the appointment_status enum values are
-- scheduled, attended, cancelled, no_show, rescheduled, confirmed; no
-- other trigger on public.appointments protects `status` itself.
--
-- Fires only on UPDATE (never INSERT -- an appointment cannot be created
-- already mid-transition) and only when `status` actually changes,
-- leaving every ordinary pre-service transition (scheduled/confirmed/
-- rescheduled -> attended/no_show/cancelled, and among themselves)
-- completely untouched.

begin;

create or replace function public.enforce_private_lesson_attendance_lifecycle()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  if tg_op = 'UPDATE'
     and old.appointment_type in ('private_lesson', 'intro_lesson', 'coaching')
     and old.status in ('attended', 'no_show')
     and new.status is distinct from old.status
  then
    raise exception 'Attended lessons cannot be cancelled or otherwise changed. Attendance corrections require a separate correction workflow.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_private_lesson_attendance_lifecycle() from public, anon, authenticated, service_role;

create trigger appointments_enforce_attendance_lifecycle
  before update on public.appointments
  for each row
  execute function public.enforce_private_lesson_attendance_lifecycle();

commit;
