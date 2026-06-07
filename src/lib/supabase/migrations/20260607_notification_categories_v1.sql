-- Notification Categories V1
-- Expands notification metadata so booking, automations, QR check-ins, credentials,
-- documents, SMS, memberships, payments, and future MAMBO workflows can use
-- consistent categories and priorities without one-off constraint failures.

alter table public.notifications
  add column if not exists category text,
  add column if not exists priority text;

update public.notifications
set category = case
  when type in ('public_intro_booking', 'booking_request_pending', 'booking_request_approved', 'booking_request_declined', 'portal_schedule_request') then 'booking'
  when type in ('follow_up_overdue', 'no_upcoming_lesson', 'inactive_client', 'first_lesson_follow_up') then 'client'
  when type in ('package_low_balance', 'package_depleted', 'package_renewal_due') then 'package'
  when type in ('membership_expiring', 'membership_expired', 'membership_renewal_due') then 'membership'
  when type in ('floor_rental_upcoming') then 'schedule'
  when type in ('event_registration', 'event_check_in', 'waiver_missing') then 'event'
  when type in ('document_signature_needed', 'document_signed') then 'document'
  when type in ('credential_submitted', 'credential_verified', 'credential_rejected') then 'credential'
  when type in ('client_checked_in', 'client_qr_identity') then 'check_in'
  when type in ('sms_failed', 'sms_opt_out', 'sms_delivery_issue') then 'sms'
  when type in ('payment_failed', 'payment_overdue') then 'payment'
  when type in ('automation_action_needed', 'automation_completed', 'mambo_opportunity') then 'automation'
  else coalesce(category, 'system')
end
where category is null;

update public.notifications
set priority = case
  when type in ('package_depleted', 'payment_failed', 'waiver_missing', 'sms_failed') then 'urgent'
  when type in ('public_intro_booking', 'booking_request_pending', 'portal_schedule_request', 'follow_up_overdue', 'package_low_balance', 'membership_expiring', 'document_signature_needed', 'credential_submitted', 'automation_action_needed') then 'high'
  else coalesce(priority, 'normal')
end
where priority is null;

alter table public.notifications
  alter column category set default 'system',
  alter column priority set default 'normal';

alter table public.notifications
  alter column category set not null,
  alter column priority set not null;

alter table public.notifications
  drop constraint if exists notifications_type_check,
  drop constraint if exists notifications_category_check,
  drop constraint if exists notifications_priority_check;

alter table public.notifications
  add constraint notifications_type_check
  check (
    type = any (
      array[
        'public_intro_booking',
        'follow_up_overdue',
        'package_low_balance',
        'package_depleted',
        'floor_rental_upcoming',
        'event_registration',
        'booking_request_pending',
        'booking_request_approved',
        'booking_request_declined',
        'portal_schedule_request',
        'client_checked_in',
        'client_qr_identity',
        'credential_submitted',
        'credential_verified',
        'credential_rejected',
        'document_signature_needed',
        'document_signed',
        'waiver_missing',
        'sms_failed',
        'sms_opt_out',
        'sms_delivery_issue',
        'membership_expiring',
        'membership_expired',
        'membership_renewal_due',
        'package_renewal_due',
        'payment_failed',
        'payment_overdue',
        'automation_action_needed',
        'automation_completed',
        'mambo_opportunity',
        'no_upcoming_lesson',
        'inactive_client',
        'first_lesson_follow_up',
        'event_check_in'
      ]::text[]
    )
  );

alter table public.notifications
  add constraint notifications_category_check
  check (
    category = any (
      array[
        'booking',
        'schedule',
        'client',
        'package',
        'membership',
        'document',
        'event',
        'sms',
        'credential',
        'automation',
        'payment',
        'check_in',
        'system'
      ]::text[]
    )
  );

alter table public.notifications
  add constraint notifications_priority_check
  check (priority = any (array['low', 'normal', 'high', 'urgent']::text[]));

create index if not exists idx_notifications_studio_category_created
  on public.notifications (studio_id, category, created_at desc);

create index if not exists idx_notifications_studio_priority_unread
  on public.notifications (studio_id, priority, read_at);
