-- 20260602_booking_availability_rules_v1.sql
-- Booking Availability Rules V1
-- Adds request-window controls used by public intro requests and portal scheduling guidance.

alter table public.studio_settings
  add column if not exists booking_request_allowed_weekdays integer[] not null default array[1,2,3,4,5,6],
  add column if not exists booking_request_start_time time not null default '09:00',
  add column if not exists booking_request_end_time time not null default '21:00',
  add column if not exists public_intro_bookable_instructor_ids uuid[] not null default array[]::uuid[],
  add column if not exists portal_bookable_instructor_ids uuid[] not null default array[]::uuid[],
  add column if not exists portal_bookable_lesson_types text[] not null default array['private_lesson']::text[];

comment on column public.studio_settings.booking_request_allowed_weekdays is
  'Allowed request days for public intro and portal scheduling requests. 0=Sunday, 6=Saturday.';
comment on column public.studio_settings.booking_request_start_time is
  'Earliest local request slot start time for booking request windows.';
comment on column public.studio_settings.booking_request_end_time is
  'Latest local request slot end time for booking request windows.';
comment on column public.studio_settings.public_intro_bookable_instructor_ids is
  'Optional instructor allowlist for public intro requests. Empty means use the default intro instructor only.';
comment on column public.studio_settings.portal_bookable_instructor_ids is
  'Optional instructor allowlist for portal schedule requests. Empty means staff will choose.';
comment on column public.studio_settings.portal_bookable_lesson_types is
  'Lesson types students may request through the portal. Request-based only in V1.';
