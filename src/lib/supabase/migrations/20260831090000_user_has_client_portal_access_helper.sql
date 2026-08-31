-- Portal / Multi-Studio H2-B1: canonical portal-authorization helper.
--
-- Additive only. This migration creates exactly one new function and does
-- not modify any existing RLS policy anywhere in the schema. The 33
-- policies across 19 tables that currently authorize portal/student access
-- via `clients.portal_user_id = auth.uid()` (identified in the H2-B
-- architecture review) are entirely untouched by this migration -- none of
-- them reference this function yet. That policy-replacement work is H2-B2,
-- a separate, later migration.
--
-- Purpose: answer "does the currently authenticated user have a currently
-- linked client_account_links relationship with this exact studio+client
-- pair" -- the single predicate H2-B2 will eventually substitute for every
-- `clients.portal_user_id = auth.uid()` check. `client_account_links` (not
-- the legacy, partially-unique `clients.portal_user_id` mirror column) is
-- the modern relationship authority: one auth user may hold simultaneous
-- `linked` rows across multiple studios, which `portal_user_id` can never
-- represent (H1 finding: `clients_portal_user_id_unique` is a partial
-- UNIQUE index on `portal_user_id`, so one auth identity can never be
-- mirrored onto more than one studio's `clients` row at once).
--
-- Semantics: status='linked' is the ONLY link-lifecycle state that grants
-- access. unclaimed, invited, claim_pending, disconnected, former_client,
-- rejected, and conflict all correctly return false -- confirmed by the
-- WHERE clause alone (it filters on status = 'linked' with no OR branch
-- for any other status). No relationship_type filter, no is_primary
-- filter, no independent-instructor-role check, and no reference to
-- clients.portal_user_id anywhere: per the H2-B architecture review,
-- DanceFlow currently grants identical base portal visibility to every
-- linked relationship type, and access must derive solely from the
-- modern client_account_links relationship, never the legacy mirror.
--
-- Identity: auth.uid() only. There is deliberately no user-id parameter --
-- a caller can never ask "does some other user have access?", only "does
-- the current session's own identity have access to this studio/client?".
--
-- Security contract:
--   - SECURITY DEFINER: the calling role's own RLS visibility into
--     client_account_links must not matter -- the function evaluates the
--     table as its owner, bypassing that table's RLS entirely, exactly
--     the same property already proven for user_has_studio_access(). This
--     is intentional and does not weaken anything: the query itself is
--     already scoped to `user_id = auth.uid()`, so a non-SECURITY-DEFINER
--     version would return the same true/false answer for correctly-
--     configured RLS on client_account_links -- SECURITY DEFINER instead
--     removes any future dependency on that table's RLS policy shape
--     remaining exactly as it is today.
--   - STABLE: no data mutation, safe to evaluate once per statement.
--   - SET search_path TO 'public': locked against search-path hijacking,
--     matching the established pattern.
--   - Deliberately NO platform_admin bypass (unlike user_has_studio_access,
--     which does have one). Portal/client identity and platform
--     administration are separate trust boundaries: a platform admin does
--     not need to silently pass as if they were the client themselves. If
--     platform-admin access to portal-shaped data is ever needed, it
--     belongs in the separate, existing staff-side policies, not smuggled
--     into this helper.
--
-- No recursion risk: because this function is SECURITY DEFINER, its
-- internal query against client_account_links bypasses that table's own
-- RLS, so a future policy on any of the 19 tables that calls this
-- function can never trigger a nested RLS evaluation cycle back into
-- client_account_links.

create or replace function public.user_has_client_portal_access(
  target_studio_id uuid,
  target_client_id uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = target_studio_id
      and cal.client_id = target_client_id
      and cal.status = 'linked'
  );
$$;

-- Independent pre-commit review (non-blocking note): SECURITY DEFINER
-- functions are created with Supabase's default per-role grants, which
-- include an explicit EXECUTE entry for `anon` -- not merely an inherited
-- PUBLIC grant, so revoking from PUBLIC alone would not remove it. This
-- helper is intended for authenticated portal authorization and
-- service-role/system use only; it has no reason to ever be invoked by an
-- unauthenticated caller. Matches the established repo convention (see
-- e.g. 20260620_competition_foundation_v1.sql,
-- 20260622_wave_controlled_posting_v2.sql) of explicitly locking down
-- EXECUTE on SECURITY DEFINER functions rather than relying on defaults.
revoke all on function public.user_has_client_portal_access(uuid, uuid) from public;
revoke all on function public.user_has_client_portal_access(uuid, uuid) from anon;
grant execute on function public.user_has_client_portal_access(uuid, uuid) to authenticated;
grant execute on function public.user_has_client_portal_access(uuid, uuid) to service_role;
