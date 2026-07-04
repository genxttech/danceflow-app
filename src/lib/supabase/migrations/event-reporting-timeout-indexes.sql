-- Event reporting timeout indexes
-- Apply before changing app code so event list/reporting queries can use
-- event-scoped lookups instead of large scans.

create index if not exists idx_event_registrations_event_status_created
on public.event_registrations (event_id, status, created_at desc);

create index if not exists idx_event_registrations_event_checked_in
on public.event_registrations (event_id, checked_in_at)
where checked_in_at is not null;

create index if not exists idx_event_registrations_event_payment_status
on public.event_registrations (event_id, payment_status);

create index if not exists idx_event_registration_attendees_event_checked_in
on public.event_registration_attendees (event_id, checked_in_at)
where checked_in_at is not null;

create index if not exists idx_event_registration_attendees_event_registration_sort
on public.event_registration_attendees (event_id, registration_id, sort_order);

create index if not exists idx_event_registration_attendees_event_ticket_issued
on public.event_registration_attendees (event_id, ticket_issued_at)
where ticket_issued_at is not null;

create index if not exists idx_event_registration_attendees_ticket_code_upper
on public.event_registration_attendees (upper(ticket_code))
where ticket_code is not null;

create index if not exists idx_attendance_records_event_registration
on public.attendance_records (event_registration_id);

create index if not exists idx_event_settlements_event
on public.event_settlements (event_id);

notify pgrst, 'reload schema';
