-- Rollback for 20260913090700_gc2h_group_class_membership_rls_self_access.sql
--
-- Genuinely new, standalone, additive policies -- safe to drop outright.
-- Removing them only revokes the new student self-access visibility; every
-- pre-existing staff/studio policy on these four tables is untouched either
-- way.

begin;

drop policy if exists "membership_plan_benefits_self_select" on public.membership_plan_benefits;
drop policy if exists "client_memberships_self_select" on public.client_memberships;
drop policy if exists "client_membership_periods_self_select" on public.client_membership_periods;
drop policy if exists "client_membership_usage_self_select" on public.client_membership_usage;

commit;
