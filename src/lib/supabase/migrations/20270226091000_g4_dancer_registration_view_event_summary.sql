-- G4 (owner disposition 2026-11-26) -- a dancer sees the summary of an event they hold a registration for, private events included.
--
-- Before: the Student app embeds events() on my_event_registrations; the embedded row is read as the dancer, so the events table's
-- row security hides a private event and the registration shows as "Event unavailable" / an unnamed card.
-- After: my_event_registrations appends read-only event summary columns, read with the view owner's rights for the caller's own
-- registrations only (the view's existing er.user_id = auth.uid() filter). The first 20 columns are unchanged and in the same order.
-- A draft event exposes its status only. No policy, function or events-table grant changes; docs/mobile/Student_Registered_Event_Access_Proposal.md, option A.
--
-- Needs 20270222092000. Git-only: do NOT apply to hosted databases without the owner's authorization. Apply before any app that reads
-- the new columns. Rollback: rollback/20270226091000_g4_dancer_registration_view_event_summary_rollback.sql.

begin;

create or replace view public.my_event_registrations
with (security_barrier = true)
as
select
  er.id,
  er.event_id,
  er.ticket_type_id,
  er.studio_id,
  er.user_id,
  er.status,
  er.payment_status,
  er.attendee_first_name,
  er.attendee_last_name,
  er.attendee_email,
  er.attendee_phone,
  er.quantity,
  er.unit_price,
  er.total_price,
  er.total_amount,
  er.currency,
  er.checked_in_at,
  er.cancelled_at,
  er.created_at,
  er.updated_at,
  case when e.status::text <> 'draft' then e.name end as event_name,
  case when e.status::text <> 'draft' then e.slug end as event_slug,
  case when e.status::text <> 'draft' then e.start_date end as event_start_date,
  case when e.status::text <> 'draft' then e.start_time end as event_start_time,
  case when e.status::text <> 'draft' then e.end_date end as event_end_date,
  case when e.status::text <> 'draft' then e.end_time end as event_end_time,
  case when e.status::text <> 'draft' then e.timezone end as event_timezone,
  case when e.status::text <> 'draft' then e.venue_name end as event_venue_name,
  case when e.status::text <> 'draft' then e.city end as event_city,
  case when e.status::text <> 'draft' then e.state end as event_state,
  e.status as event_status
from public.event_registrations er
left join public.events e on e.id = er.event_id
where er.user_id = auth.uid();

-- create or replace keeps the existing grants; restated so the view's exposure is explicit and does not depend on history.
revoke all on public.my_event_registrations from public, anon, authenticated;
grant select on public.my_event_registrations to authenticated;

comment on view public.my_event_registrations is
  'A signed-in dancer''s own event registrations (user_id = auth.uid()), safe columns only, with a read-only summary of the registered event. Use this instead of reading event_registrations directly.';

commit;

notify pgrst, 'reload schema';
