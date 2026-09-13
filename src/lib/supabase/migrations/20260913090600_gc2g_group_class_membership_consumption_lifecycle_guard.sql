-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2g
-- (corrected): membership-consumption lifecycle guard.
--
-- Not a blanket terminal-attendance lock (the first draft of this migration
-- was exactly that, applied to DEV, found to conflict with real, already-
-- shipped, already-tested product behavior -- GC-1.2's own
-- T-gc1-2-status-transitions test proves attended<->no_show and
-- registered->attended are intentional, supported group-class attendance
-- corrections -- and was rolled back and deleted before ever being
-- committed). This is a narrower, consumption-STATE-aware guard instead:
--
--   * 'attended' and 'no_show' are both membership-consumption states for a
--     group class -- moving between them is a label change, not a
--     consumption change, and remains fully allowed (GC-2f's own idempotent
--     upsert already guarantees the existing usage row is preserved
--     unchanged across that transition, never duplicated).
--   * Moving OUT of a consumption state (registered, checked_in, cancelled,
--     or any other non-consuming state) is only restricted for
--     MEMBERSHIP-FUNDED attendees ('billing_type' = 'membership') -- a
--     package/PAYG/free-comped attendee is completely unaffected by this
--     guard, preserving GC-1.2's existing, tested reversal behavior exactly
--     (rules 5/6: no blanket prohibition, no different ordinary attendance
--     UX for a membership-funded attendee's write path itself -- the block
--     only ever fires on the specific consuming-to-non-consuming
--     transition, nothing else).
--   * For a membership-funded attendee, that reverse transition is blocked
--     outright with a clear error naming the reason -- this prevents a
--     silent, unaudited entitlement restoration (the finite balance would
--     otherwise appear to free up the moment attendance is un-marked, with
--     no review, no audit trail, and no correction of the
--     client_membership_usage row GC-2f already wrote). This is explicitly
--     NOT the future Attendance Correction / Reversal Workflow -- it
--     defines no correction path, only a forward guard until that workflow
--     exists. Historical usage is never touched by this guard either way --
--     it only ever blocks the status write itself.

begin;

create or replace function public.enforce_group_class_membership_consumption_lifecycle()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_appointment_type public.appointment_type;
  v_attendee record;
begin
  if tg_op <> 'UPDATE' or new.appointment_id is null then
    return new;
  end if;

  -- Only relevant when leaving a consumption state for a non-consuming one.
  -- attended<->no_show (both consumption states) is unrestricted.
  if old.status not in ('attended', 'no_show') or new.status in ('attended', 'no_show') then
    return new;
  end if;

  select appointment_type into v_appointment_type
    from public.appointments
    where id = new.appointment_id;

  if v_appointment_type is distinct from 'group_class'::public.appointment_type then
    return new;
  end if;

  select aa.billing_type, aa.client_membership_id
    into v_attendee
    from public.appointment_attendees aa
    where aa.appointment_id = new.appointment_id
      and aa.client_id = new.client_id
    order by (aa.status = 'booked') desc, aa.created_at desc
    limit 1;

  -- Not membership-funded: no different attendance UX/behavior here at all
  -- -- GC-1.2's existing, tested package/PAYG/free-comped correction
  -- behavior is completely untouched by this guard.
  if v_attendee.billing_type is distinct from 'membership' or v_attendee.client_membership_id is null then
    return new;
  end if;

  raise exception 'This class attendance was membership-funded and already recorded as a consumption state (attended or no_show). Changing it to "%" would silently affect membership entitlement and requires a separate attendance correction/reversal workflow, not a direct status change.', new.status;
end;
$$;

revoke all on function public.enforce_group_class_membership_consumption_lifecycle() from public, anon, authenticated, service_role;

create trigger attendance_records_enforce_membership_consumption_lifecycle
  before update on public.attendance_records
  for each row
  execute function public.enforce_group_class_membership_consumption_lifecycle();

commit;
