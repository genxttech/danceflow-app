-- FC-1B5D Phase B: clients RLS tightening.
--
-- Phase A (already merged and verified live in production at
-- 5440467c6cc3bd67ca4c2f3c01d9eaef16e53b07) replaced every legitimate
-- instructor-facing raw public.clients dependency with controlled,
-- field-minimized interfaces: get_teaching_clients_for_instructor,
-- search_bookable_clients_for_instructor, get_client_by_qr_token_for_checkin,
-- and a set of already-enforced canView*/canManage* server-action gates.
-- No live application code path depends on instructor having direct
-- database-level access to public.clients any more.
--
-- This migration makes that already-live product model structurally true
-- at the database layer:
--
--   1. Drops "studio members can view clients" -- a role-agnostic SELECT
--      policy (USING user_has_studio_access(studio_id), which only checks
--      for ANY active user_studio_roles row at the studio, regardless of
--      role). This is the sole source of instructor's (and, at their own
--      studio, independent_instructor's) direct SELECT today. Every
--      legitimate CRM-tier role's SELECT need is already covered
--      redundantly by the ALL policy below, so dropping this policy
--      removes zero legitimate access.
--
--   2. Drops and recreates "studio staff manage clients" (a FOR ALL
--      policy covering SELECT/INSERT/UPDATE/DELETE in one predicate),
--      removing 'instructor' from the permitted role array. The
--      platform-admin OR-clause is preserved byte-for-byte in semantics.
--
-- NO FUNCTIONAL CHANGE -- enforcement/security only: Phase A already
-- removed every legitimate instructor general-CRM/client-mutation
-- application path; this migration enforces that same boundary at the
-- database. One notable consequence called out explicitly, not hidden
-- under "SELECT containment": the ALL policy being narrowed currently
-- grants instructor direct INSERT/UPDATE/DELETE on public.clients at the
-- database layer (independent of and broader than any app-layer control),
-- with no known legitimate application workflow exercising it. This
-- migration closes that direct mutation capability, not merely SELECT.
--
-- independent_instructor and organizer_owner/organizer_admin were never
-- present in "studio staff manage clients"'s role array (confirmed via a
-- live DEV catalog read immediately before writing this migration) -- no
-- change needed for them; the secure default already held.
--
-- Portal/self access (the two "portal users ..." SELECT policies, backed
-- by user_has_client_portal_access via client_account_links) is
-- structurally independent of both policies touched here and is left
-- completely untouched, as is every other table's RLS and every shared
-- helper function.
--
-- The two statements below are security-coupled -- narrowing one without
-- the other would still leave a role-agnostic or role-scoped path open to
-- instructor -- so this migration is wrapped in an explicit transaction
-- (a deviation from this repo's recent migration convention, applied here
-- intentionally) so both land together or neither does.

begin;

drop policy if exists "studio members can view clients" on public.clients;

drop policy if exists "studio staff manage clients" on public.clients;

create policy "studio staff manage clients" on public.clients
for all
using (
  (exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = clients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::public.app_role[])
      and usr.active = true
  ))
  or (exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  ))
)
with check (
  (exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = clients.studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::public.app_role[])
      and usr.active = true
  ))
  or (exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  ))
);

commit;
