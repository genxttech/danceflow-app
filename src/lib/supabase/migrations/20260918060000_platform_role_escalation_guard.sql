-- Platform Role Escalation Hotfix.
--
-- Vulnerability closed: profiles.platform_role is trusted as platform-admin
-- authority by ~71 RLS policies and ~10 functions (user_has_studio_access,
-- _landmark1a_can_manage_instructors, ...), but ordinary API roles held
-- column-level INSERT/UPDATE on it and the own-profile UPDATE policy has no
-- WITH CHECK, so any signed-in user could grant themselves platform_admin
-- through a normal profile write. No trigger protected the column.
--
-- Fix: one BEFORE INSERT OR UPDATE OF platform_role guard trigger. It
-- decides purely on the DATABASE ROLE of the caller (current_user), which
-- PostgREST sets from the verified JWT, and never reads platform_role to
-- authorize a change to platform_role (no circularity).
--   * current_user in ('anon','authenticated') -> may not set a non-null
--     value on INSERT, and may not change the value on UPDATE.
--   * Everything else passes unchanged: service_role (admin-client app code),
--     postgres / supabase_admin (migrations, dashboard SQL), and SECURITY
--     DEFINER functions, which run as their owner. The function is SECURITY
--     INVOKER precisely so current_user reflects the real caller.
--
-- Review rule: a tenant-callable SECURITY DEFINER function that writes
-- profiles.platform_role would run as its owner and pass this guard; none
-- exists today, and any future one must be treated as a privileged change.
--
-- No grants, policies, or data are changed. Ordinary profile edits
-- (full_name, email, ...) and normal bootstrap (platform_role NULL) are
-- unaffected.

begin;

create or replace function public._guard_profiles_platform_role()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.platform_role is not null then
        raise exception 'profiles.platform_role cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.platform_role is distinct from old.platform_role then
      raise exception 'profiles.platform_role cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_profiles_platform_role()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_profiles_platform_role on public.profiles;

create trigger guard_profiles_platform_role
before insert or update of platform_role
on public.profiles
for each row
execute function public._guard_profiles_platform_role();

commit;
