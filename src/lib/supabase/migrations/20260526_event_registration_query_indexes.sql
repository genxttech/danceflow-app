begin;

create index if not exists idx_event_registrations_event_created
on public.event_registrations (event_id, created_at);

create index if not exists idx_event_registrations_event_status
on public.event_registrations (event_id, status);

create index if not exists idx_event_registration_attendees_registration_sort
on public.event_registration_attendees (registration_id, sort_order);

create index if not exists idx_event_registration_attendees_event
on public.event_registration_attendees (event_id);

create index if not exists idx_event_registration_attendees_ticket_code_lower
on public.event_registration_attendees (lower(ticket_code))
where ticket_code is not null;

create index if not exists idx_event_payments_registration
on public.event_payments (registration_id);

create index if not exists idx_attendance_records_studio_registration
on public.attendance_records (studio_id, event_registration_id);

notify pgrst, 'reload schema';

commit;
