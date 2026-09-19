-- Rollback for 20260918060000_platform_role_escalation_guard.sql
--
-- Drops the guard trigger and its function. Touches no data, policies, or
-- grants. WARNING: rolling this back RE-OPENS the platform_role
-- self-escalation vulnerability (any signed-in user could set their own
-- profiles.platform_role) -- use only if the guard itself is proven to
-- break a legitimate flow, and re-apply a fix promptly.

begin;

drop trigger if exists guard_profiles_platform_role on public.profiles;

drop function if exists public._guard_profiles_platform_role();

commit;
