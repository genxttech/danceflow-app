-- Rollback of 20270222092000_dancer_event_registration_views.sql. Roll back 20270222093000 FIRST if it was applied (otherwise dancers
-- have neither the views nor the direct policies).
begin;
drop view if exists public.my_event_registration_attendees;
drop view if exists public.my_event_registrations;
commit;

notify pgrst, 'reload schema';
