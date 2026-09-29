-- Rollback for 20260929090000_paydc2d_payment_identity_write_lock.sql
--
-- WARNING: rolling this back RE-OPENS the PAY-DC-2D gaps. Tenant roles regain
-- the ability to write Stripe identity fields on payments / event_payments /
-- event_registrations (which refunds and webhooks trust), to rewrite
-- studios.stripe_connected_account_id, to INSERT/UPDATE stripe_subscriptions
-- and stripe_customers, and anyone regains direct INSERT on
-- event_registrations / event_registration_attendees. Use only under a
-- separately approved decision (e.g. immediately before a code rollback to a
-- release that still writes these fields with the user-scoped client).
--
-- Restores the exact pre-migration state: drops only the PAY-DC-2D guard
-- triggers/functions and recreates the six removed policies as they were.
-- PAY-DC-2A/2B/2C objects are not touched. No data is touched.

begin;

drop trigger if exists trg_payments_stripe_identity_guard on public.payments;
drop function if exists public._guard_payments_stripe_identity();

drop trigger if exists trg_event_payments_stripe_identity_guard on public.event_payments;
drop function if exists public._guard_event_payments_stripe_identity();

drop trigger if exists trg_event_registrations_stripe_identity_guard on public.event_registrations;
drop function if exists public._guard_event_registrations_stripe_identity();

drop trigger if exists guard_studios_connected_account on public.studios;
drop function if exists public._guard_studios_connected_account();

drop policy if exists stripe_subscriptions_staff_insert on public.stripe_subscriptions;
create policy stripe_subscriptions_staff_insert
on public.stripe_subscriptions
for insert to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_subscriptions.studio_id
      and usr.active = true
  )
);

drop policy if exists stripe_subscriptions_staff_update on public.stripe_subscriptions;
create policy stripe_subscriptions_staff_update
on public.stripe_subscriptions
for update to authenticated
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

drop policy if exists stripe_customers_staff_insert on public.stripe_customers;
create policy stripe_customers_staff_insert
on public.stripe_customers
for insert to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = stripe_customers.studio_id
      and usr.active = true
  )
);

drop policy if exists stripe_customers_staff_update on public.stripe_customers;
create policy stripe_customers_staff_update
on public.stripe_customers
for update to authenticated
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

drop policy if exists event_registrations_public_insert on public.event_registrations;
create policy event_registrations_public_insert
on public.event_registrations
for insert to public
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_registrations.event_id
      and e.status = 'published'
      and e.visibility = any (array['public'::text, 'unlisted'::text])
  )
);

drop policy if exists event_registration_attendees_public_insert on public.event_registration_attendees;
create policy event_registration_attendees_public_insert
on public.event_registration_attendees
for insert to public
with check (
  exists (
    select 1
    from public.event_registrations er
    join public.events e on e.id = er.event_id
    where er.id = event_registration_attendees.registration_id
      and e.id = er.event_id
      and e.status = 'published'
      and e.visibility = any (array['public'::text, 'unlisted'::text])
      and e.registration_required = true
  )
);

commit;
