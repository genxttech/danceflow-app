-- Event group-class check-in is session-specific. This index keeps each
-- selected class/week lookup fast and supports the server-side upsert path.
create index if not exists attendance_records_event_session_registration_idx
on public.attendance_records (studio_id, event_session_id, event_registration_id)
where event_session_id is not null;
