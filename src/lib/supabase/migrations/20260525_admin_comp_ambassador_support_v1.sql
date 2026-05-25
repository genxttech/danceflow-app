-- Admin Comp / Ambassador Account Support V1
-- Adds explicit billing override fields for comped Pro/ambassador workspaces.
-- Safe to run more than once.

alter table public.studios
  add column if not exists billing_override_enabled boolean not null default false,
  add column if not exists billing_override_reason text,
  add column if not exists billing_override_expires_at timestamp with time zone,
  add column if not exists billing_override_notes text,
  add column if not exists billing_override_created_at timestamp with time zone,
  add column if not exists billing_override_created_by uuid;

create index if not exists idx_studios_billing_override_active
  on public.studios (billing_override_enabled, billing_override_expires_at)
  where billing_override_enabled = true;

comment on column public.studios.billing_override_enabled is
  'Platform-admin override for legitimate paid-plan access without an active Stripe subscription, such as ambassador or founder comp accounts.';

comment on column public.studios.billing_override_reason is
  'Reason for billing override, such as ambassador, founder, internal_test, manual_review, or other platform-admin note.';

comment on column public.studios.billing_override_expires_at is
  'Expiration timestamp for billing override. If expired, normal billing-risk checks should apply.';

comment on column public.studios.billing_override_notes is
  'Internal notes explaining the billing override.';

-- Example only. Run manually for each ambassador workspace after choosing the right studio id:
-- update public.studios
-- set
--   billing_plan = 'pro',
--   subscription_status = 'active',
--   billing_override_enabled = true,
--   billing_override_reason = 'ambassador',
--   billing_override_expires_at = now() + interval '12 months',
--   billing_override_notes = 'Ambassador Pro Pilot - 12 month comp account',
--   billing_override_created_at = now()
-- where id = 'PASTE_STUDIO_ID_HERE';
