-- 20260602_booking_self_scheduling_settings_v1.sql
-- Adds safe, request-based booking/self-scheduling controls for studios.

alter table public.studio_settings
  add column if not exists portal_self_scheduling_enabled boolean not null default false,
  add column if not exists portal_self_scheduling_mode text not null default 'disabled',
  add column if not exists portal_self_scheduling_window_days integer not null default 14,
  add column if not exists portal_self_scheduling_min_notice_hours integer not null default 24,
  add column if not exists portal_self_scheduling_cancellation_cutoff_hours integer not null default 24;

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_mode_check;

alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_mode_check
  check (portal_self_scheduling_mode in ('disabled', 'request_only'));

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_window_days_check;

alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_window_days_check
  check (portal_self_scheduling_window_days >= 1 and portal_self_scheduling_window_days <= 365);

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_min_notice_hours_check;

alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_min_notice_hours_check
  check (portal_self_scheduling_min_notice_hours >= 0 and portal_self_scheduling_min_notice_hours <= 8760);

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_cancellation_cutoff_hours_check;

alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_cancellation_cutoff_hours_check
  check (
    portal_self_scheduling_cancellation_cutoff_hours >= 0
    and portal_self_scheduling_cancellation_cutoff_hours <= 8760
  );
