-- DanceFlow / DanceStudioAdmin
-- Security hardening migration
-- Purpose: enable Row Level Security (RLS) on previously exposed public-schema
-- tables and add explicit policies for studio-scoped, user-scoped, and
-- intentionally public discovery data.
-- Apply in dev/test first, verify app flows, then promote to production.

begin;

-- -------------------------------------------------------------------
-- Enable RLS on flagged tables
-- -------------------------------------------------------------------

alter table public.appointment_recurrence_series enable row level security;
alter table public.client_membership_usage enable row level security;
alter table public.client_memberships enable row level security;
alter table public.event_public_styles enable row level security;
alter table public.event_registration_attendees enable row level security;
alter table public.import_batch_errors enable row level security;
alter table public.import_batches enable row level security;
alter table public.lead_activities enable row level security;
alter table public.membership_plan_benefits enable row level security;
alter table public.membership_plans enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.stripe_payment_methods enable row level security;
alter table public.stripe_subscriptions enable row level security;
alter table public.studio_billing_customers enable row level security;
alter table public.studio_invoices enable row level security;
alter table public.studio_public_offerings enable row level security;
alter table public.studio_public_styles enable row level security;
alter table public.studio_subscriptions enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.user_notification_preferences enable row level security;

-- -------------------------------------------------------------------
-- Drop policies if they already exist
-- -------------------------------------------------------------------

drop policy if exists appointment_recurrence_series_studio_select on public.appointment_recurrence_series;
drop policy if exists appointment_recurrence_series_studio_insert on public.appointment_recurrence_series;
drop policy if exists appointment_recurrence_series_studio_update on public.appointment_recurrence_series;

drop policy if exists client_memberships_studio_select on public.client_memberships;
drop policy if exists client_memberships_studio_insert on public.client_memberships;
drop policy if exists client_memberships_studio_update on public.client_memberships;

drop policy if exists import_batches_studio_select on public.import_batches;
drop policy if exists import_batches_studio_insert on public.import_batches;
drop policy if exists import_batches_studio_update on public.import_batches;

drop policy if exists lead_activities_studio_select on public.lead_activities;
drop policy if exists lead_activities_studio_insert on public.lead_activities;
drop policy if exists lead_activities_studio_update on public.lead_activities;

drop policy if exists client_membership_usage_via_membership_select on public.client_membership_usage;
drop policy if exists client_membership_usage_via_membership_insert on public.client_membership_usage;
drop policy if exists client_membership_usage_via_membership_update on public.client_membership_usage;

drop policy if exists event_registration_attendees_staff_select on public.event_registration_attendees;
drop policy if exists event_registration_attendees_self_select on public.event_registration_attendees;
drop policy if exists event_registration_attendees_staff_insert on public.event_registration_attendees;
drop policy if exists event_registration_attendees_self_insert on public.event_registration_attendees;
drop policy if exists event_registration_attendees_staff_update on public.event_registration_attendees;

drop policy if exists event_public_styles_public_select on public.event_public_styles;
drop policy if exists event_public_styles_staff_insert on public.event_public_styles;
drop policy if exists event_public_styles_staff_update on public.event_public_styles;
drop policy if exists event_public_styles_staff_delete on public.event_public_styles;

drop policy if exists membership_plans_staff_select on public.membership_plans;
drop policy if exists membership_plans_staff_insert on public.membership_plans;
drop policy if exists membership_plans_staff_update on public.membership_plans;
drop policy if exists membership_plans_public_select on public.membership_plans;

drop policy if exists membership_plan_benefits_staff_select on public.membership_plan_benefits;
drop policy if exists membership_plan_benefits_staff_insert on public.membership_plan_benefits;
drop policy if exists membership_plan_benefits_staff_update on public.membership_plan_benefits;
drop policy if exists membership_plan_benefits_public_select on public.membership_plan_benefits;

drop policy if exists stripe_customers_staff_select on public.stripe_customers;
drop policy if exists stripe_customers_staff_insert on public.stripe_customers;
drop policy if exists stripe_customers_staff_update on public.stripe_customers;

drop policy if exists stripe_payment_methods_staff_select on public.stripe_payment_methods;
drop policy if exists stripe_payment_methods_staff_insert on public.stripe_payment_methods;
drop policy if exists stripe_payment_methods_staff_update on public.stripe_payment_methods;

drop policy if exists stripe_subscriptions_staff_select on public.stripe_subscriptions;
drop policy if exists stripe_subscriptions_staff_insert on public.stripe_subscriptions;
drop policy if exists stripe_subscriptions_staff_update on public.stripe_subscriptions;

drop policy if exists studio_billing_customers_staff_select on public.studio_billing_customers;
drop policy if exists studio_billing_customers_staff_insert on public.studio_billing_customers;
drop policy if exists studio_billing_customers_staff_update on public.studio_billing_customers;

drop policy if exists studio_invoices_staff_select on public.studio_invoices;
drop policy if exists studio_invoices_staff_insert on public.studio_invoices;
drop policy if exists studio_invoices_staff_update on public.studio_invoices;

drop policy if exists studio_public_offerings_public_select on public.studio_public_offerings;
drop policy if exists studio_public_offerings_staff_insert on public.studio_public_offerings;
drop policy if exists studio_public_offerings_staff_update on public.studio_public_offerings;
drop policy if exists studio_public_offerings_staff_delete on public.studio_public_offerings;

drop policy if exists studio_public_styles_public_select on public.studio_public_styles;
drop policy if exists studio_public_styles_staff_insert on public.studio_public_styles;
drop policy if exists studio_public_styles_staff_update on public.studio_public_styles;
drop policy if exists studio_public_styles_staff_delete on public.studio_public_styles;

drop policy if exists studio_subscriptions_staff_select on public.studio_subscriptions;
drop policy if exists studio_subscriptions_staff_insert on public.studio_subscriptions;
drop policy if exists studio_subscriptions_staff_update on public.studio_subscriptions;

drop policy if exists subscription_plans_public_select on public.subscription_plans;

drop policy if exists user_notification_preferences_self_select on public.user_notification_preferences;
drop policy if exists user_notification_preferences_self_insert on public.user_notification_preferences;
drop policy if exists user_notification_preferences_self_update on public.user_notification_preferences;
drop policy if exists user_notification_preferences_staff_select on public.user_notification_preferences;
drop policy if exists user_notification_preferences_staff_update on public.user_notification_preferences;

-- -------------------------------------------------------------------
-- Studio-scoped internal tables
-- -------------------------------------------------------------------

create policy appointment_recurrence_series_studio_select
on public.appointment_recurrence_series
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_recurrence_series.studio_id
      and usr.active = true
  )
);

create policy appointment_recurrence_series_studio_insert
on public.appointment_recurrence_series
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_recurrence_series.studio_id
      and usr.active = true
  )
);

create policy appointment_recurrence_series_studio_update
on public.appointment_recurrence_series
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_recurrence_series.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = appointment_recurrence_series.studio_id
      and usr.active = true
  )
);

create policy client_memberships_studio_select
on public.client_memberships
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = client_memberships.studio_id
      and usr.active = true
  )
);

create policy client_memberships_studio_insert
on public.client_memberships
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = client_memberships.studio_id
      and usr.active = true
  )
);

create policy client_memberships_studio_update
on public.client_memberships
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = client_memberships.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = client_memberships.studio_id
      and usr.active = true
  )
);

create policy import_batches_studio_select
on public.import_batches
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = import_batches.studio_id
      and usr.active = true
  )
);

create policy import_batches_studio_insert
on public.import_batches
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = import_batches.studio_id
      and usr.active = true
  )
);

create policy import_batches_studio_update
on public.import_batches
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = import_batches.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = import_batches.studio_id
      and usr.active = true
  )
);

create policy lead_activities_studio_select
on public.lead_activities
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = lead_activities.studio_id
      and usr.active = true
  )
);

create policy lead_activities_studio_insert
on public.lead_activities
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = lead_activities.studio_id
      and usr.active = true
  )
);

create policy lead_activities_studio_update
on public.lead_activities
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = lead_activities.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = lead_activities.studio_id
      and usr.active = true
  )
);

-- -------------------------------------------------------------------
-- Child/internal tables that inherit access from a parent
-- -------------------------------------------------------------------

create policy client_membership_usage_via_membership_select
on public.client_membership_usage
for select
to authenticated
using (
  exists (
    select 1
    from public.client_memberships cm
    join public.user_studio_roles usr
      on usr.studio_id = cm.studio_id
    where cm.id = client_membership_usage.client_membership_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy client_membership_usage_via_membership_insert
on public.client_membership_usage
for insert
to authenticated
with check (
  exists (
    select 1
    from public.client_memberships cm
    join public.user_studio_roles usr
      on usr.studio_id = cm.studio_id
    where cm.id = client_membership_usage.client_membership_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy client_membership_usage_via_membership_update
on public.client_membership_usage
for update
to authenticated
using (
  exists (
    select 1
    from public.client_memberships cm
    join public.user_studio_roles usr
      on usr.studio_id = cm.studio_id
    where cm.id = client_membership_usage.client_membership_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.client_memberships cm
    join public.user_studio_roles usr
      on usr.studio_id = cm.studio_id
    where cm.id = client_membership_usage.client_membership_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy event_registration_attendees_staff_select
on public.event_registration_attendees
for select
to authenticated
using (
  exists (
    select 1
    from public.event_registrations er
    join public.user_studio_roles usr
      on usr.studio_id = er.studio_id
    where er.id = event_registration_attendees.registration_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy event_registration_attendees_self_select
on public.event_registration_attendees
for select
to authenticated
using (
  exists (
    select 1
    from public.event_registrations er
    where er.id = event_registration_attendees.registration_id
      and (
        er.user_id = auth.uid()
        or er.portal_user_id = auth.uid()
      )
  )
);

create policy event_registration_attendees_staff_insert
on public.event_registration_attendees
for insert
to authenticated
with check (
  exists (
    select 1
    from public.event_registrations er
    join public.user_studio_roles usr
      on usr.studio_id = er.studio_id
    where er.id = event_registration_attendees.registration_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy event_registration_attendees_self_insert
on public.event_registration_attendees
for insert
to authenticated
with check (
  exists (
    select 1
    from public.event_registrations er
    where er.id = event_registration_attendees.registration_id
      and (
        er.user_id = auth.uid()
        or er.portal_user_id = auth.uid()
      )
  )
);

create policy event_registration_attendees_staff_update
on public.event_registration_attendees
for update
to authenticated
using (
  exists (
    select 1
    from public.event_registrations er
    join public.user_studio_roles usr
      on usr.studio_id = er.studio_id
    where er.id = event_registration_attendees.registration_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.event_registrations er
    join public.user_studio_roles usr
      on usr.studio_id = er.studio_id
    where er.id = event_registration_attendees.registration_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

-- -------------------------------------------------------------------
-- Public discovery tables
-- -------------------------------------------------------------------

create policy event_public_styles_public_select
on public.event_public_styles
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_public_styles.event_id
      and e.visibility = 'public'
      and e.status in ('published', 'open')
  )
);

create policy event_public_styles_staff_insert
on public.event_public_styles
for insert
to authenticated
with check (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy event_public_styles_staff_update
on public.event_public_styles
for update
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy event_public_styles_staff_delete
on public.event_public_styles
for delete
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy membership_plans_staff_select
on public.membership_plans
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_plans.studio_id
      and usr.active = true
  )
);

create policy membership_plans_staff_insert
on public.membership_plans
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_plans.studio_id
      and usr.active = true
  )
);

create policy membership_plans_staff_update
on public.membership_plans
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_plans.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = membership_plans.studio_id
      and usr.active = true
  )
);

create policy membership_plans_public_select
on public.membership_plans
for select
to anon, authenticated
using (
  visibility = 'public' and active = true
);

create policy membership_plan_benefits_staff_select
on public.membership_plan_benefits
for select
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy membership_plan_benefits_staff_insert
on public.membership_plan_benefits
for insert
to authenticated
with check (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy membership_plan_benefits_staff_update
on public.membership_plan_benefits
for update
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.membership_plans mp
    join public.user_studio_roles usr
      on usr.studio_id = mp.studio_id
    where mp.id = membership_plan_benefits.membership_plan_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy membership_plan_benefits_public_select
on public.membership_plan_benefits
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    where mp.id = membership_plan_benefits.membership_plan_id
      and mp.visibility = 'public'
      and mp.active = true
  )
);

create policy studio_public_offerings_public_select
on public.studio_public_offerings
for select
to anon, authenticated
using (true);

create policy studio_public_offerings_staff_insert
on public.studio_public_offerings
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_offerings.studio_id
      and usr.active = true
  )
);

create policy studio_public_offerings_staff_update
on public.studio_public_offerings
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_offerings.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_offerings.studio_id
      and usr.active = true
  )
);

create policy studio_public_offerings_staff_delete
on public.studio_public_offerings
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_offerings.studio_id
      and usr.active = true
  )
);

create policy studio_public_styles_public_select
on public.studio_public_styles
for select
to anon, authenticated
using (true);

create policy studio_public_styles_staff_insert
on public.studio_public_styles
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_styles.studio_id
      and usr.active = true
  )
);

create policy studio_public_styles_staff_update
on public.studio_public_styles
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_styles.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_styles.studio_id
      and usr.active = true
  )
);

create policy studio_public_styles_staff_delete
on public.studio_public_styles
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_public_styles.studio_id
      and usr.active = true
  )
);

create policy subscription_plans_public_select
on public.subscription_plans
for select
to anon, authenticated
using (active = true);

-- -------------------------------------------------------------------
-- Sensitive billing tables
-- -------------------------------------------------------------------

create policy stripe_customers_staff_select
on public.stripe_customers
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_customers.studio_id
      and usr.active = true
  )
);

create policy stripe_customers_staff_insert
on public.stripe_customers
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_customers.studio_id
      and usr.active = true
  )
);

create policy stripe_customers_staff_update
on public.stripe_customers
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_customers.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_customers.studio_id
      and usr.active = true
  )
);

create policy stripe_payment_methods_staff_select
on public.stripe_payment_methods
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_payment_methods.studio_id
      and usr.active = true
  )
);

create policy stripe_payment_methods_staff_insert
on public.stripe_payment_methods
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_payment_methods.studio_id
      and usr.active = true
  )
);

create policy stripe_payment_methods_staff_update
on public.stripe_payment_methods
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_payment_methods.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_payment_methods.studio_id
      and usr.active = true
  )
);

create policy stripe_subscriptions_staff_select
on public.stripe_subscriptions
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_subscriptions.studio_id
      and usr.active = true
  )
);

create policy stripe_subscriptions_staff_insert
on public.stripe_subscriptions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_subscriptions.studio_id
      and usr.active = true
  )
);

create policy stripe_subscriptions_staff_update
on public.stripe_subscriptions
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_subscriptions.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_subscriptions.studio_id
      and usr.active = true
  )
);

create policy studio_billing_customers_staff_select
on public.studio_billing_customers
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_billing_customers.studio_id
      and usr.active = true
  )
);

create policy studio_billing_customers_staff_insert
on public.studio_billing_customers
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_billing_customers.studio_id
      and usr.active = true
  )
);

create policy studio_billing_customers_staff_update
on public.studio_billing_customers
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_billing_customers.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_billing_customers.studio_id
      and usr.active = true
  )
);

create policy studio_invoices_staff_select
on public.studio_invoices
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_invoices.studio_id
      and usr.active = true
  )
);

create policy studio_invoices_staff_insert
on public.studio_invoices
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_invoices.studio_id
      and usr.active = true
  )
);

create policy studio_invoices_staff_update
on public.studio_invoices
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_invoices.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_invoices.studio_id
      and usr.active = true
  )
);

create policy studio_subscriptions_staff_select
on public.studio_subscriptions
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_subscriptions.studio_id
      and usr.active = true
  )
);

create policy studio_subscriptions_staff_insert
on public.studio_subscriptions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_subscriptions.studio_id
      and usr.active = true
  )
);

create policy studio_subscriptions_staff_update
on public.studio_subscriptions
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_subscriptions.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_subscriptions.studio_id
      and usr.active = true
  )
);

-- -------------------------------------------------------------------
-- Notification preferences
-- -------------------------------------------------------------------

create policy user_notification_preferences_self_select
on public.user_notification_preferences
for select
to authenticated
using (user_id = auth.uid());

create policy user_notification_preferences_self_insert
on public.user_notification_preferences
for insert
to authenticated
with check (user_id = auth.uid());

create policy user_notification_preferences_self_update
on public.user_notification_preferences
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy user_notification_preferences_staff_select
on public.user_notification_preferences
for select
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = user_notification_preferences.studio_id
      and usr.active = true
  )
);

create policy user_notification_preferences_staff_update
on public.user_notification_preferences
for update
to authenticated
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = user_notification_preferences.studio_id
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = user_notification_preferences.studio_id
      and usr.active = true
  )
);

-- -------------------------------------------------------------------
-- Intentional deny-by-default tables
-- These remain protected by RLS with no client-facing policies until a
-- specific app use case requires them:
--   public.import_batch_errors
--   public.notification_deliveries
--   public.payment_provider_events
-- -------------------------------------------------------------------

commit;