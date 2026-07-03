-- Group Lesson Recaps: event/session support
-- Run in development first, then production before deploying the event check-in recap UI.

alter table public.group_lesson_recaps
  alter column appointment_id drop not null;

alter table public.group_lesson_recaps
  add column if not exists event_id uuid references public.events(id) on delete cascade,
  add column if not exists event_session_id uuid references public.event_sessions(id) on delete cascade;

alter table public.group_lesson_recap_recipients
  alter column appointment_id drop not null;

alter table public.group_lesson_recap_recipients
  add column if not exists event_id uuid references public.events(id) on delete cascade,
  add column if not exists event_session_id uuid references public.event_sessions(id) on delete cascade,
  add column if not exists event_registration_id uuid references public.event_registrations(id) on delete cascade,
  add column if not exists event_registration_attendee_id uuid references public.event_registration_attendees(id) on delete cascade;

create unique index if not exists group_lesson_recaps_one_per_event_session
  on public.group_lesson_recaps (event_session_id)
  where event_session_id is not null;

create unique index if not exists group_lesson_recaps_one_per_event_without_session
  on public.group_lesson_recaps (event_id)
  where event_id is not null and event_session_id is null;

create index if not exists group_lesson_recaps_studio_event_session_idx
  on public.group_lesson_recaps (studio_id, event_id, event_session_id);

create index if not exists group_lesson_recap_recipients_studio_event_session_idx
  on public.group_lesson_recap_recipients (studio_id, event_id, event_session_id);

create index if not exists group_lesson_recap_recipients_event_registration_idx
  on public.group_lesson_recap_recipients (event_registration_id);

create unique index if not exists group_lesson_recap_recipients_unique_attendee
  on public.group_lesson_recap_recipients (recap_id, event_registration_attendee_id)
  where event_registration_attendee_id is not null;

