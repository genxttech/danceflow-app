-- Mobile partner push notifications.
-- Run in dev first, then production before deploying code that references partner_updates or category = 'partner'.

alter table public.mobile_notification_preferences
  add column if not exists partner_updates boolean not null default true;

alter table public.mobile_notification_log
  drop constraint if exists mobile_notification_log_category_check;

alter table public.mobile_notification_log
  add constraint mobile_notification_log_category_check
  check (
    category = any (
      array[
        'schedule',
        'event',
        'favorites',
        'learning',
        'account',
        'partner',
        'system'
      ]::text[]
    )
  );
