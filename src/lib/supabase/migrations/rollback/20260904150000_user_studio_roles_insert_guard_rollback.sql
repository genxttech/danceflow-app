-- Rollback for 20260904150000_user_studio_roles_insert_guard.sql
--
-- WARNING: this restores the confirmed P0 privilege-escalation policy --
-- WITH CHECK (true), meaning any authenticated user can again insert an
-- arbitrary user_studio_roles row for themselves or anyone else, at any
-- studio, with any role including studio_owner/platform_admin. Only run
-- this to unblock a legitimate write path found broken by the forward
-- migration while a corrected fix is prepared -- never as a routine
-- rollback, and never leave it applied in this state.
--
-- If the true need is to unblock settings/team/actions.ts's
-- upsertTeamMemberRoleAction after the forward migration, the correct fix
-- is to confirm that action's admin-client write path (see the
-- accompanying application-code change), not to restore this policy.

create policy "authenticated users can insert user studio roles"
on public.user_studio_roles
for insert
to authenticated
with check (true);
