-- CUTOVER: dancers lose DIRECT access to event_registrations / event_registration_attendees rows; their reads go through the
-- column-restricted views from 20270222092000 (public.my_event_registrations, public.my_event_registration_attendees).
-- APPLY ONLY AFTER every dancer-facing reader has moved to the views and is deployed (web /account, client portal page, Student wallet).
--
-- Removed policies (all dancer-self paths; staff and organizer policies are untouched):
--   event_registrations_self_select (public)           qual: (user_id = auth.uid())
--   event_registration_attendees_self_select (authenticated)  via the registration's user_id / portal_user_id
--   event_registration_attendees_self_insert (authenticated)  WITH CHECK via the registration's user_id / portal_user_id
-- The self_insert policy lets a registration owner insert attendee rows with any ticket_code/ticket_token/checked_in_at; nothing legitimate
-- inserts as the dancer (the web and Student checkouts insert attendees with the service role), so it is removed, not replaced.
-- Git-only: do NOT apply to hosted databases without the owner's authorization.

begin;

drop policy if exists event_registrations_self_select on public.event_registrations;
drop policy if exists event_registration_attendees_self_select on public.event_registration_attendees;
drop policy if exists event_registration_attendees_self_insert on public.event_registration_attendees;

commit;
