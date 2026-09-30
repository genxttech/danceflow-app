-- Rollback for 20261001090000_paydc4a_saas_billing_identity_lock.sql
--
-- WARNING: rolling this back RE-OPENS the PAY-DC-4A gap. Studio owners/admins
-- regain the ability to rewrite studios.stripe_customer_id /
-- stripe_subscription_id, and any active studio role regains INSERT/UPDATE on
-- studio_billing_customers, which the add-on, portal and SaaS webhook paths
-- trust. The released application code does not need this rollback: every
-- legitimate writer of these values uses the service role. Use only under a
-- separately approved decision.
--
-- Restores the exact pre-migration state: drops only the PAY-DC-4A guard
-- trigger/function and recreates the two removed policies as they were.
-- Entitlement and PAY-DC-2D guards are not touched. No data is touched.

begin;

drop trigger if exists guard_studios_saas_billing_identity on public.studios;
drop function if exists public._guard_studios_saas_billing_identity();

drop policy if exists studio_billing_customers_staff_insert on public.studio_billing_customers;
create policy studio_billing_customers_staff_insert
on public.studio_billing_customers
for insert to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_billing_customers.studio_id
      and usr.active = true
  )
);

drop policy if exists studio_billing_customers_staff_update on public.studio_billing_customers;
create policy studio_billing_customers_staff_update
on public.studio_billing_customers
for update to authenticated
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

commit;
