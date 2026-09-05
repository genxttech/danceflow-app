-- FC-1B5D Phase A correction: QR check-in Phase-B continuity RPC.
--
-- Instructors must retain client QR check-in capability after Phase B
-- narrows public.clients RLS to CRM-tier roles only. QR possession is a
-- purpose-specific capability (you must have the client's actual QR
-- code), not equivalent to CRM role membership -- this function is the
-- controlled interface that keeps check-in working without depending on
-- broad clients SELECT access, and without granting general CRM
-- permission to any active studio role.
--
-- Reuses the existing client_qr_token column and existing check-in flow
-- semantics (src/app/app/client-identity/[token]/page.tsx,
-- src/app/app/client-identity/[token]/actions.ts) -- no second token
-- model is introduced. client_qr_token is already a high-entropy,
-- gen_random_uuid()::text-backed secret per client (confirmed via DEV
-- catalog: text, unique-indexed), so exact-match lookup is sufficient;
-- no additional hashing/escaping is needed (this is a plain equality
-- comparison, not a pattern match).
--
-- Authorization model: the caller must have an active user_studio_roles
-- row at target_studio_id -- ANY active role, not just CRM-tier. This is
-- intentionally broader than get_teaching_clients_for_instructor (which
-- requires a specific teaching relationship): checking a client in is a
-- general staff capability (front desk, instructor, owner, admin all
-- plausibly need it), not something scoped to "clients this instructor
-- teaches." It is still narrower than "possession of any valid session"
-- -- an anonymous caller (auth.uid() is null) can never satisfy the
-- EXISTS clause, since user_studio_roles.user_id is never null.
--
-- Field minimization: returns only id, first_name, last_name, photo_url,
-- skill_level -- never email, phone, CRM lifecycle status, notes,
-- referral_source, address, birthday, or any payment/sales field.
--
-- Enumeration resistance: takes a token, not a client id -- there is no
-- id-based lookup path at all. A wrong token returns zero rows and
-- reveals nothing about whether any client with a similar token exists
-- (exact equality, not a pattern match). Cross-studio misuse is blocked
-- twice over: the token must belong to a client actually at
-- target_studio_id, and the caller must have an active role at that same
-- target_studio_id -- a valid token for a different studio's client
-- returns nothing unless the caller also has a real role there.
create or replace function public.get_client_by_qr_token_for_checkin(
  target_studio_id uuid,
  qr_token text
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  photo_url text,
  skill_level text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    c.id,
    c.first_name,
    c.last_name,
    c.photo_url,
    c.skill_level
  from public.clients c
  where c.studio_id = target_studio_id
    and c.client_qr_token = qr_token
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = target_studio_id
        and usr.active = true
    );
$$;

-- Supabase creates functions with an explicit per-role EXECUTE grant for
-- `anon`, not merely an inherited PUBLIC grant -- revoking from PUBLIC
-- alone does not remove it (matches the established convention in
-- 20260831090000_user_has_client_portal_access_helper.sql and the other
-- FC-1B5D RPC migrations). This function has no reason to ever be invoked
-- by an unauthenticated caller.
revoke all on function public.get_client_by_qr_token_for_checkin(uuid, text) from public;
revoke all on function public.get_client_by_qr_token_for_checkin(uuid, text) from anon;
grant execute on function public.get_client_by_qr_token_for_checkin(uuid, text) to authenticated;
grant execute on function public.get_client_by_qr_token_for_checkin(uuid, text) to service_role;
