-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2h: student
-- self-access RLS for membership entitlement visibility.
--
-- Purely additive: four new SELECT policies, one per membership table,
-- using the existing user_has_client_portal_access(studio_id, client_id)
-- helper (already live, already used identically by appointment_attendees'
-- own select policy since GC-1.1) -- no new helper, no new pattern. Multiple
-- permissive RLS policies for the same command are OR'd together in
-- Postgres, so these can only ever add visibility a linked student/guardian
-- did not already have -- they cannot narrow or replace any existing staff
-- policy on these tables.
--
-- Enables a linked student/guardian to read their own remaining/unlimited
-- group-class (and private-lesson) entitlement directly via RLS-scoped
-- queries, without a new service-role API route. No write policy is added
-- for any of these four tables -- entitlement consumption remains
-- exclusively server/trigger-authoritative (GC-2c, GC-2f), never
-- client-writable.

begin;

create policy "membership_plan_benefits_self_select"
on public.membership_plan_benefits
for select
to authenticated
using (
  exists (
    select 1
    from public.membership_plans mp
    join public.client_memberships cm on cm.membership_plan_id = mp.id
    where mp.id = membership_plan_benefits.membership_plan_id
      and public.user_has_client_portal_access(mp.studio_id, cm.client_id)
  )
);

create policy "client_memberships_self_select"
on public.client_memberships
for select
to authenticated
using (
  public.user_has_client_portal_access(client_memberships.studio_id, client_memberships.client_id)
);

create policy "client_membership_periods_self_select"
on public.client_membership_periods
for select
to authenticated
using (
  public.user_has_client_portal_access(client_membership_periods.studio_id, client_membership_periods.client_id)
);

create policy "client_membership_usage_self_select"
on public.client_membership_usage
for select
to authenticated
using (
  exists (
    select 1
    from public.client_memberships cm
    where cm.id = client_membership_usage.client_membership_id
      and public.user_has_client_portal_access(cm.studio_id, cm.client_id)
  )
);

commit;
