-- Dancer-facing, column-restricted reads of a person's OWN event registrations and attendee rows (ADDITIVE; nothing is removed).
-- docs/events/event-registration-dancer-column-restricted-read-proposal.md, option (a).
--
-- Why views: dancers, studio staff and organizer staff all use the same database role (authenticated) and the table-level SELECT grant
-- covers every column, so a column-level REVOKE would also break staff. The dancer path must therefore be a different object with an
-- explicit column list. These views run with the owner's rights (not security_invoker), are filtered to the caller (auth.uid()), carry only
-- fields a dancer may see and are granted to authenticated only (never anon).
--
-- Columns a dancer does NOT get through these views (still stored; readable by staff/organizers through their own policies):
--   event_registrations: client_id, organizer_contact_id, stripe_checkout_session_id, stripe_payment_intent_id, terminal_hold_until,
--     portal_user_id, source, registration_source, notes, order_id, promoted_from_waitlist_at, waitlist_notified_at
--   event_registration_attendees: checked_in_by, ticket_token, updated_at
-- The direct policies that let a dancer read the base tables are removed by the NEXT migration (20270222093000), which must be applied only
-- after every reader has moved to these views.
-- Git-only: do NOT apply to hosted databases without the owner's authorization.

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
  er.updated_at
from public.event_registrations er
where er.user_id = auth.uid();

create or replace view public.my_event_registration_attendees
with (security_barrier = true)
as
select
  a.id,
  a.registration_id,
  a.event_id,
  a.ticket_type_id,
  a.first_name,
  a.last_name,
  a.email,
  a.phone,
  a.attendee_role,
  a.sort_order,
  a.waiver_signed_at,
  a.checked_in_at,
  a.ticket_code,
  a.ticket_issued_at,
  a.created_at
from public.event_registration_attendees a
where exists (
  select 1
  from public.event_registrations er
  where er.id = a.registration_id
    and (er.user_id = auth.uid() or er.portal_user_id = auth.uid())
);

revoke all on public.my_event_registrations from public, anon, authenticated;
revoke all on public.my_event_registration_attendees from public, anon, authenticated;
grant select on public.my_event_registrations to authenticated;
grant select on public.my_event_registration_attendees to authenticated;

comment on view public.my_event_registrations is
  'A signed-in dancer''s own event registrations (user_id = auth.uid()), safe columns only. Use this instead of reading event_registrations directly.';
comment on view public.my_event_registration_attendees is
  'Attendee/ticket rows of the signed-in dancer''s own registrations, safe columns only (no checked_in_by, no ticket_token).';

commit;

notify pgrst, 'reload schema';
