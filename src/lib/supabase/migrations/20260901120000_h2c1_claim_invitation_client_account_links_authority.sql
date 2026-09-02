-- Portal / Multi-Studio H2-C1: stop depending on clients.portal_user_id for
-- invitation-claim linking/conflict/idempotency decisions.
--
-- H2-B2 already made client_account_links the authorization (read) source
-- of truth for RLS. This migration extends the same authority to the one
-- remaining write path that still used the legacy mirror as its actual
-- linking key: claim_client_account_invitation. clients.portal_user_id
-- carries a GLOBAL partial unique index (clients_portal_user_id_unique,
-- not scoped per studio) -- claiming a second studio's invitation for the
-- same auth user in one call could therefore raise unique_violation and
-- roll back the whole RPC, including an otherwise-successful first-studio
-- claim. See the H2-C audit for the full trace.
--
-- Preserved, from the pre-H2-C1 function (captured verbatim in this
-- migration's sibling rollback file,
-- rollback/20260901120000_h2c1_claim_invitation_client_account_links_authority_rollback.sql):
--   * invitation selection: status in ('invited','claim_pending'), email
--     match (case/whitespace-insensitive), optional studio filter,
--     unexpired, processed oldest-first, each row locked with `for update`;
--   * "different-user conflict" behavior: if this exact client already has
--     a different auth identity's relationship, the invitation is marked
--     'conflict' (not silently overwritten), matching the pre-H2-C1 result
--     shape's essential guarantee. One field-level difference, found while
--     validating this migration and documented in full further down: the
--     losing invitation's user_id is no longer set to the existing owner's
--     id (the pre-H2-C1 function set it from clients.portal_user_id) --
--     that write is unconditionally unsafe once the real owner has their
--     own client_account_links row for this client_id, which is the
--     normal case, not an edge case;
--   * "linked" state transition fields (claimed_at/linked_at/accepted_at
--     coalesce-preserved; disconnected_at/disconnected_by/disconnect_reason/
--     rejected_at/conflict_details cleared);
--   * idempotency: an already-'linked' row is never re-selected by the
--     status filter, so re-processing a claimed invitation is a no-op,
--     same as before;
--   * return contract: table(client_id uuid, studio_id uuid, link_id uuid)
--     -- unchanged. The one new code path below (reconnect-merge) can
--     return a different link_id than the invitation row's own id; the
--     only current caller (src/lib/auth/portal-linking.ts,
--     ensurePortalProfileAndClientLinks) reads client_id only, so this is
--     not an observable behavior change for any caller today.
--
-- Changed:
--   * the "different-user conflict" check is now sourced from
--     client_account_links.status = 'linked' (any relationship_type) for
--     this exact studio_id+client_id, instead of the legacy
--     clients.portal_user_id column. This is a deliberate, narrow
--     authority-source change, not a business-rule change: pre-H2-B3, a
--     disconnected relationship could leave a stale non-null
--     portal_user_id behind, which the old code would have treated as an
--     active conflict even though that relationship was no longer
--     actually linked -- exactly the class of staleness H2-B2/H2-B3 exist
--     to eliminate. Scoping to status = 'linked' is the correct
--     current-state equivalent, not a loosening.
--   * clients.portal_user_id is no longer read or written anywhere in
--     this function. No write to it is required for a claim to succeed.
--   * new: a defensive precheck for the case where a DIFFERENT existing
--     client_account_links row already holds the exact (client_id,
--     p_user_id) pair this claim's UPDATE is about to write into (the
--     client_account_links_client_user_unique partial unique index, from
--     20260713_student_identity_link_lifecycle.sql -- verified present,
--     not newly introduced here). This is reachable in the real product
--     flow whenever a client is re-invited by email alone (the common
--     case: createOrRefreshClientInvitation only reuses a matching
--     historical row when the target user_id is already explicitly
--     known) after a prior disconnect -- the fresh invitation row is a
--     NEW row, separate from the old, now-disconnected one that already
--     carries this user's id. Previously this was masked because the
--     function's linking write went through clients.portal_user_id,
--     which is not subject to this per-row constraint. Handled by
--     relinking the pre-existing row (preserving its relationship
--     history) and superseding the fresh invitation row's now-redundant
--     invite fields -- mirroring the exact sibling-invite-supersession
--     pattern already used by linkExistingClientAccount
--     (src/lib/student-identity/lifecycle.ts) for the same class of
--     situation. No new constraint introduced -- this uses the existing
--     client_account_links_client_user_unique index precisely, per H2-C1
--     item 5.
--   * a per-iteration exception handler additionally catches any residual
--     unique_violation that slips past the prechecks above from a genuine
--     concurrent transaction. It does NOT blindly swallow it: it first
--     checks (via GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME) that the
--     violated constraint is one of the three this claim path can
--     legitimately race against (client_account_links_client_user_unique,
--     client_account_links_one_linked_self_per_client,
--     client_account_links_one_primary_per_user_studio) -- anything else
--     re-raises immediately. For a recognized constraint, it re-reads the
--     current studio_id+client_id relationship state fresh and only
--     treats the iteration as resolved if that state matches an outcome
--     this claim itself could legitimately have produced: the intended
--     user is now linked (idempotent success) or a different identity is
--     now legitimately linked (preserve conflict behavior, same safe
--     conflict branch as above). If the state matches neither -- e.g. the
--     same user holds a conflicting primary relationship on a different
--     client in the same studio, a genuine data-integrity condition, not
--     a race -- it re-raises (fails closed) rather than silently skipping
--     the invitation. See test_T_h2c1_claim_invitation_authority.sql's
--     T-h2c1-race-failclosed and T-h2c1-race-reconcile-* assertions.
--   * grant hardening: EXECUTE is now restricted to service_role only
--     (explicitly revoked from anon and authenticated individually, not
--     merely from PUBLIC). Discovered via a dedicated security audit
--     after local validation: the pre-H2-C1 grant state (anon and
--     authenticated both retained EXECUTE despite the original function's
--     own `revoke all ... from public`) let an unauthenticated caller
--     hijack a pending invitation, and let an authenticated caller
--     force-link a third party or take over a relationship meant for
--     someone else -- proven via local adversarial tests. See
--     test_T_h2c1_claim_invitation_authority.sql's T-h2c1-priv-catalog
--     (privilege catalog check) and T-h2c1-service-role-probe (legitimate
--     path still works); the corresponding live anon/authenticated
--     denial probes are documented there rather than run automatically
--     -- attempting them reliably crashes this local Postgres 17.6
--     instance (a pre-existing local-environment limitation, not a new
--     defect -- see that file's comments for the full reproduction).
--     The real application caller (src/lib/auth/portal-linking.ts,
--     service_role only) is unaffected by this hardening.
--   * discovered constraint gap (reported per H2-C1 item 5, not fixed by
--     introducing a new constraint): the pre-H2-C1 function's
--     conflict-marking write (`user_id = existing_user` on the losing
--     invitation row) unconditionally collides with
--     client_account_links_client_user_unique whenever the true owner
--     already holds their own linked row for this client_id -- which is
--     the ordinary case, since that owner's row is precisely how the
--     conflict was detected in the first place. This function no longer
--     performs that write (see the conflict branch below); the
--     conflict-status/conflict_details signal is preserved, and
--     linked_requires_user_check permits a null user_id on a 'conflict'
--     row. This gap is symmetric with the pre-H2-C1 implementation (its
--     write into clients.portal_user_id had no such per-row constraint to
--     violate, but did not need to; the equivalent write against
--     client_account_links does), not something H2-C1 introduces.
--
-- Not touched: the H2-B1 helper, any H2-B2 RLS policy, the
-- clients.portal_user_id column/index itself, the
-- sync_client_portal_user_to_account_link trigger (it still exists for
-- any other direct writer to clients.portal_user_id; it simply no longer
-- fires from this function, since this function no longer writes that
-- column), H2-C2 relationship-scoped unlink, H3/getLinkedPortalDestination,
-- owner multi-studio mode, Package Refund, or the unrelated
-- fulfill_terminal_payment/payments.updated_at defect.

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
  v_conflicting_user uuid;
  v_existing_pair_id uuid;
  v_constraint_name text;
  v_reconciled_linked_user uuid;
  v_reconciled_conflict_owner uuid;
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
    begin
      -- Different-user conflict: does this exact client already have a
      -- DIFFERENT auth identity's currently-linked relationship? Mirrors
      -- the pre-H2-C1 per-client (not per-relationship-type) granularity,
      -- now sourced from client_account_links.status = 'linked' rather
      -- than the legacy mirror column.
      select cal2.user_id
        into v_conflicting_user
      from public.client_account_links cal2
      where cal2.client_id = invitation.client_id
        and cal2.studio_id = invitation.studio_id
        and cal2.status = 'linked'
        and cal2.user_id is distinct from p_user_id
      order by cal2.is_primary desc nulls last, cal2.created_at asc
      limit 1
      for update;

      if v_conflicting_user is not null then
        -- Deliberately does NOT set user_id = v_conflicting_user on this
        -- losing invitation row (unlike the pre-H2-C1 function, which set
        -- it from clients.portal_user_id): the conflicting owner already
        -- holds their own client_account_links row for this exact
        -- client_id, so writing their id here would collide with
        -- client_account_links_client_user_unique on that very pair.
        -- status='conflict' plus conflict_details is sufficient to record
        -- "not silently linked, a different identity already owns this
        -- relationship" without an unsafe write; user_id is left as this
        -- invitation's own pre-existing value (null, since it was an
        -- unclaimed invitation), which the linked_requires_user_check
        -- constraint permits for status='conflict'.
        update public.client_account_links
        set
          status = 'conflict',
          conflict_details = 'Client record was already connected to a different DanceFlow account.',
          updated_at = now()
        where id = invitation.id;

        continue;
      end if;

      -- Reconnect-merge precheck: does a DIFFERENT existing row already
      -- hold this exact (client_id, user_id) pair (the unique index this
      -- claim's UPDATE is about to write into)? If so, relink that row
      -- instead of the fresh invitation row, and supersede the
      -- invitation row's invite fields -- avoids a unique_violation and
      -- preserves the pre-existing row's relationship history rather
      -- than duplicating it.
      select cal3.id
        into v_existing_pair_id
      from public.client_account_links cal3
      where cal3.client_id = invitation.client_id
        and cal3.user_id = p_user_id
        and cal3.id <> invitation.id
      for update;

      if v_existing_pair_id is not null then
        update public.client_account_links
        set
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
        where id = v_existing_pair_id;

        update public.client_account_links
        set
          invite_token_hash = null,
          invite_expires_at = null,
          updated_at = now()
        where id = invitation.id;

        client_id := invitation.client_id;
        studio_id := invitation.studio_id;
        link_id := v_existing_pair_id;
        return next;
        continue;
      end if;

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
    exception
      when unique_violation then
        -- A unique_violation here means a concurrent transaction changed
        -- this exact client's relationship state between our precheck
        -- (above) and our write. We must not assume that outcome was
        -- benign -- re-read the real, current state and only treat this
        -- as resolved if it matches one of the two outcomes this claim
        -- itself could legitimately have produced. Anything else fails
        -- closed (re-raises), per H2-C1 item 2: an unexpected integrity
        -- failure must never be silently skipped.
        get stacked diagnostics v_constraint_name = constraint_name;

        -- Guard: only attempt reconciliation for the specific
        -- constraints this claim path can legitimately race against.
        -- client_account_links_client_user_unique -- another row for
        -- (client_id, user_id) appeared concurrently (the precheck's own
        -- target). client_account_links_one_linked_self_per_client /
        -- client_account_links_one_primary_per_user_studio -- a
        -- concurrent transaction's own 'self'/'primary' write raced ours
        -- on the same client or the same user+studio. A NULL or
        -- unrecognized constraint name (any other unique/PK constraint)
        -- is not a race this function understands how to reconcile --
        -- fail closed immediately rather than guess.
        if v_constraint_name is null or v_constraint_name not in (
          'client_account_links_client_user_unique',
          'client_account_links_one_linked_self_per_client',
          'client_account_links_one_primary_per_user_studio'
        ) then
          raise;
        end if;

        -- Re-read the exact studio_id+client_id relationship state fresh
        -- (never trusted from before the violation): is the intended
        -- user (p_user_id) now legitimately linked to this exact
        -- relationship, i.e. did a concurrent transaction already
        -- produce the outcome this claim itself was trying to reach?
        select cal4.user_id
          into v_reconciled_linked_user
        from public.client_account_links cal4
        where cal4.client_id = invitation.client_id
          and cal4.studio_id = invitation.studio_id
          and cal4.status = 'linked'
          and cal4.user_id = p_user_id
        limit 1;

        if v_reconciled_linked_user is not null then
          -- Idempotent success: the intended user is now linked to this
          -- exact relationship via the concurrent transaction. Nothing
          -- left for this invitation to do.
          continue;
        end if;

        -- Otherwise: does a DIFFERENT auth identity now legitimately own
        -- this exact relationship (a concurrent transaction's own
        -- conflict-free claim beat ours)? Preserve conflict behavior
        -- rather than silently stealing or silently skipping.
        select cal5.user_id
          into v_reconciled_conflict_owner
        from public.client_account_links cal5
        where cal5.client_id = invitation.client_id
          and cal5.studio_id = invitation.studio_id
          and cal5.status = 'linked'
          and cal5.user_id is distinct from p_user_id
        order by cal5.is_primary desc nulls last, cal5.created_at asc
        limit 1;

        if v_reconciled_conflict_owner is not null then
          update public.client_account_links
          set
            status = 'conflict',
            conflict_details = 'Client record was already connected to a different DanceFlow account.',
            updated_at = now()
          where id = invitation.id;

          continue;
        end if;

        -- Neither reconciled outcome holds: the current state does not
        -- explain the violation as a recognizable concurrent-claim race
        -- (e.g. the same user holds a conflicting primary relationship
        -- on a DIFFERENT client in this studio -- a genuine data-
        -- integrity condition, not a race). Fail closed.
        raise;
    end;
  end loop;
end;
$$;

-- H2-C1 grant hardening (security audit: GRANT HARDENING REQUIRED). The
-- pre-H2-C1 function's own `revoke all ... from public` never actually
-- locked out anon/authenticated -- Supabase grants EXECUTE to those two
-- roles individually at function-creation time, independent of the PUBLIC
-- pseudo-role, so a PUBLIC-only revoke leaves both individually-granted
-- EXECUTE privileges standing (the same class of gap H2-B1's helper
-- function had to close explicitly). Verified empirically: with those
-- grants in place, an unauthenticated anon caller could claim an
-- arbitrary user into any pending invitation, and an authenticated
-- caller could force-link a third party or take over a relationship
-- meant for someone else, purely by supplying an untrusted p_user_id/
-- p_email -- this function has never validated either against auth.uid()
-- or a trusted email source, in either the pre-H2-C1 or H2-C1 version.
-- The real, sole legitimate caller is src/lib/auth/portal-linking.ts's
-- admin.rpc(...) call via createAdminClient() (service_role, server-only
-- secret) -- no anon or authenticated code path invokes this function
-- anywhere in the application, so revoking their EXECUTE breaks nothing
-- real. Deliberately not adding an auth.uid() identity-binding branch:
-- service_role calls carry no meaningful per-end-user auth.uid() context,
-- so that shape of fix would risk breaking the one real caller rather
-- than closing the actual gap; the correct fix is narrowing execution to
-- the already-fully-trusted role that calls this function today.
revoke execute on function public.claim_client_account_invitation(uuid, text, uuid) from public;
revoke execute on function public.claim_client_account_invitation(uuid, text, uuid) from anon;
revoke execute on function public.claim_client_account_invitation(uuid, text, uuid) from authenticated;
grant execute on function public.claim_client_account_invitation(uuid, text, uuid) to service_role;

comment on function public.claim_client_account_invitation(uuid, text, uuid) is
  'H2-C1: claims explicit, unexpired client-account invitations matching the authenticated email, using client_account_links (not clients.portal_user_id) as the sole relationship authority -- allows independent multi-studio claims in one call. EXECUTE restricted to service_role only (H2-C1 grant hardening) -- this function has no anon/authenticated identity binding and must never be reachable by those roles.';

commit;
