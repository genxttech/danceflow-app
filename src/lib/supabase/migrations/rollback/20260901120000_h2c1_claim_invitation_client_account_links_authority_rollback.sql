-- Rollback for 20260901120000_h2c1_claim_invitation_client_account_links_authority.sql
--
-- Restores public.claim_client_account_invitation to its exact pre-H2-C1
-- definition, byte-identical to the function body originally created in
-- src/lib/supabase/migrations/20260713_student_identity_link_lifecycle.sql
-- (lines 46-136 at the time of H2-C1). Does not touch client_account_links
-- table structure, indexes, or constraints (H2-C1 introduced none), and
-- does not touch clients.portal_user_id or any RLS policy.
--
-- Grant-state fidelity: also restores the exact pre-H2-C1 EXECUTE grant
-- state -- anon, authenticated, AND service_role all individually
-- granted EXECUTE, verified via information_schema.routine_privileges
-- before H2-C1's grant hardening was ever applied. This is the real
-- historical state (Supabase's own default per-schema grants apply
-- EXECUTE to anon/authenticated individually at function-creation time,
-- independent of `revoke all ... from public`, which is why the
-- pre-H2-C1 migration's own revoke never actually removed them). A
-- rollback is only trustworthy if it reproduces the exact prior state,
-- including its insecurity -- H2-C1's grant hardening is a deliberate,
-- separately-tracked forward-only security fix, not something rollback
-- should silently also apply. Simply re-running the pre-H2-C1 migration's
-- own two grant statements (revoke all from public; grant to
-- service_role) is NOT sufficient to reproduce this, since H2-C1's
-- forward migration explicitly revoked anon/authenticated by name --
-- those must be explicitly re-granted here to genuinely restore the
-- prior state, not merely re-derived from the original literal SQL text.
--
-- Lives in a sibling rollback/ directory so it is never auto-applied as a
-- forward migration, matching the H2-B2 rollback convention.

begin;

create or replace function public.claim_client_account_invitation(
  p_user_id uuid,
  p_email text,
  p_studio_id uuid default null
)
returns table(client_id uuid, studio_id uuid, link_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(p_email, '')));
  invitation record;
  existing_user uuid;
begin
  if p_user_id is null or normalized_email = '' then
    return;
  end if;

  for invitation in
    select cal.*
    from public.client_account_links cal
    where cal.status in ('invited', 'claim_pending')
      and lower(trim(coalesce(cal.invited_email, ''))) = normalized_email
      and (p_studio_id is null or cal.studio_id = p_studio_id)
      and (cal.invite_expires_at is null or cal.invite_expires_at > now())
    order by cal.created_at asc
    for update
  loop
    select c.portal_user_id
      into existing_user
    from public.clients c
    where c.id = invitation.client_id
      and c.studio_id = invitation.studio_id
    for update;

    if existing_user is not null and existing_user <> p_user_id then
      update public.client_account_links
      set
        status = 'conflict',
        user_id = existing_user,
        conflict_details = 'Client record was already connected to a different DanceFlow account.',
        updated_at = now()
      where id = invitation.id;

      continue;
    end if;

    update public.clients
    set
      portal_user_id = p_user_id,
      updated_at = now()
    where id = invitation.client_id
      and studio_id = invitation.studio_id
      and (portal_user_id is null or portal_user_id = p_user_id);

    update public.client_account_links
    set
      user_id = p_user_id,
      status = 'linked',
      claimed_at = coalesce(claimed_at, now()),
      linked_at = coalesce(linked_at, now()),
      accepted_at = coalesce(accepted_at, now()),
      disconnected_at = null,
      disconnected_by = null,
      disconnect_reason = null,
      rejected_at = null,
      conflict_details = null,
      updated_at = now()
    where id = invitation.id;

    client_id := invitation.client_id;
    studio_id := invitation.studio_id;
    link_id := invitation.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_client_account_invitation(uuid, text, uuid) from public;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;

-- Explicit grant-state restoration (see header note above): reproduces
-- the exact pre-H2-C1 privilege state, which included anon and
-- authenticated -- intentionally restoring the pre-hardening (insecure)
-- state, since that is what "exact pre-H2-C1" means. Do not treat this
-- as an endorsement of that state; it exists solely for rollback
-- fidelity.
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to anon;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to authenticated;

comment on function public.claim_client_account_invitation(uuid, text, uuid) is
  'Claims only explicit, unexpired client-account invitations matching the authenticated email.';

commit;
