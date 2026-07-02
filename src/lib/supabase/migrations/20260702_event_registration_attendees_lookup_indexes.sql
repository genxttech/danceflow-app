create index if not exists event_registration_attendees_event_registration_sort_idx
on public.event_registration_attendees (event_id, registration_id, sort_order);

