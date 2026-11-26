-- Rollback for 20270226091000_g4_dancer_registration_view_event_summary: restores my_event_registrations as defined by 20270222092000.
-- A view cannot lose columns with create or replace, so it is dropped and recreated in one transaction (nothing depends on it).
-- Roll back any app that reads the event_* columns first.

begin;

drop view public.my_event_registrations;

create view public.my_event_registrations
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
  er.updated_at
from public.event_registrations er
where er.user_id = auth.uid();

revoke all on public.my_event_registrations from public, anon, authenticated;
grant select on public.my_event_registrations to authenticated;

comment on view public.my_event_registrations is
  'A signed-in dancer''s own event registrations (user_id = auth.uid()), safe columns only. Use this instead of reading event_registrations directly.';
commit;

notify pgrst, 'reload schema';
