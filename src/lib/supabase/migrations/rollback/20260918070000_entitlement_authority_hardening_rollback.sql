-- Rollback for 20260918070000_entitlement_authority_hardening.sql
--
-- WARNING: rolling this back RE-OPENS entitlement tampering. Tenant roles
-- regain the ability to rewrite their own studios billing/override columns
-- and any active studio user regains INSERT/UPDATE on studio_subscriptions
-- (i.e. they can raise their own effective seat limit and plan). Use only
-- under a separately approved decision.
--
-- Restores the exact pre-migration state: drops the guard trigger/function
-- and recreates the two studio_subscriptions policies as they were. No data
-- is touched.

begin;

drop trigger if exists guard_studios_entitlement_columns on public.studios;
drop function if exists public._guard_studios_entitlement_columns();

drop policy if exists studio_subscriptions_staff_insert on public.studio_subscriptions;
create policy studio_subscriptions_staff_insert
on public.studio_subscriptions
for insert to authenticated
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = studio_subscriptions.studio_id
      and usr.active = true
  )
);

drop policy if exists studio_subscriptions_staff_update on public.studio_subscriptions;
create policy studio_subscriptions_staff_update
on public.studio_subscriptions
for update to authenticated
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

commit;
