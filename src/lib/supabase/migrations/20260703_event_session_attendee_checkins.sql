-- Event group-class check-in is attendee-specific per session.
-- This supports multi-admit tickets where one ticket admits more than one person.

alter table public.attendance_records
  add column if not exists event_registration_attendee_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attendance_records_event_registration_attendee_id_fkey'
  ) then
    alter table public.attendance_records
      add constraint attendance_records_event_registration_attendee_id_fkey
      foreign key (event_registration_attendee_id)
      references public.event_registration_attendees(id)
      on delete cascade;
  end if;
end $$;

create index if not exists attendance_records_event_session_attendee_idx
on public.attendance_records (studio_id, event_session_id, event_registration_attendee_id)
where event_session_id is not null
  and event_registration_attendee_id is not null;

create unique index if not exists attendance_records_one_per_event_session_attendee
on public.attendance_records (studio_id, event_session_id, event_registration_attendee_id)
where event_session_id is not null
  and event_registration_attendee_id is not null;

