drop index if exists public.uq_attendance_records_event_registration;

create unique index if not exists uq_attendance_records_event_registration_no_session
on public.attendance_records(event_registration_id)
where event_registration_id is not null
  and event_session_id is null;

create unique index if not exists uq_attendance_records_event_registration_session
on public.attendance_records(event_registration_id, event_session_id)
where event_registration_id is not null
  and event_session_id is not null;

create index if not exists attendance_records_event_session_id_idx
on public.attendance_records(event_session_id)
where event_session_id is not null;

notify pgrst, 'reload schema';