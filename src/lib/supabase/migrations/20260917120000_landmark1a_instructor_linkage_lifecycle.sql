-- Landmark 1A -- Slice 2: Canonical Instructor Account Linkage Lifecycle.
--
-- 1. Security fix (folded into this migration since it already modifies
--    accept_pending_team_invitations): that function currently derives
--    which invitation to claim from the caller-supplied `p_email`
--    parameter, with zero verification that the email belongs to the
--    authenticated caller. Any authenticated user who knows or guesses a
--    pending invitation's target email can have that invitation's role
--    granted to their own account -- a live confused-deputy /
--    privilege-escalation gap, independent of Landmark 1A. Fixed by
--    deriving the email from the caller's own verified JWT
--    (auth.jwt() ->> 'email'), matching this codebase's own established
--    pattern already used by the ambassador-invite claim RPCs
--    (20260525_ambassador_invites_v1.sql,
--    20260525_ambassador_invite_smart_claim_v1_1.sql). The `p_email`
--    parameter is kept in the signature for call-site compatibility
--    (src/app/(auth)/callback/route.ts) but is no longer read.
--
-- 2. New internal helper, resolve_or_create_linked_instructor: the
--    deterministic instructors.user_id linkage precedence chain (Tiers
--    1-5), reused by accept_pending_team_invitations's new
--    role='instructor' branch. EXECUTE is explicitly revoked from
--    PUBLIC/anon/authenticated -- callable only from within another
--    already-privileged SECURITY DEFINER function's own execution
--    context, matching the existing
--    refresh_payroll_pay_period_totals precedent
--    (20260715_payroll_operations_completion.sql).
--
-- 3. Scope: linkage lifecycle only. No can_instruct grant, no seat
--    enforcement, no assignability enforcement, no bulk backfill of
--    existing rows, no partial unique index on instructors
--    (studio_id, user_id) -- all later slices.

begin;

-- 1. Deterministic linkage helper -----------------------------------------

create function public.resolve_or_create_linked_instructor(
  p_studio_id uuid,
  p_user_id uuid,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_allow_create boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_first_name text := nullif(trim(coalesce(p_first_name, '')), '');
  v_last_name text := nullif(trim(coalesce(p_last_name, '')), '');
  v_instructor_id uuid;
  v_candidate_count integer;
  v_matched_via text;
  v_before_value jsonb;
begin
  if p_studio_id is null or p_user_id is null then
    return null;
  end if;

  -- Serialize concurrent resolution/creation for the same (studio, user)
  -- pair so two near-simultaneous callers can never both reach Tier 5 and
  -- create two rows. Transaction-scoped; released automatically at the
  -- end of the calling transaction.
  perform pg_advisory_xact_lock(
    hashtext(p_studio_id::text || ':' || p_user_id::text)
  );

  -- Tier 1: already linked at this studio -- idempotent no-op.
  select id into v_instructor_id
  from public.instructors
  where studio_id = p_studio_id
    and user_id = p_user_id
  limit 1;

  if v_instructor_id is not null then
    return v_instructor_id;
  end if;

  -- Tier 2: authoritative client_account_links.user_id relationship to
  -- an existing, still-unlinked instructors row (e.g. an independent
  -- instructor/renter who already has a host instructors row).
  select i.id into v_instructor_id
  from public.instructors i
  join public.clients c
    on c.linked_instructor_id = i.id
    and c.studio_id = p_studio_id
  join public.client_account_links cal
    on cal.client_id = c.id
    and cal.studio_id = p_studio_id
    and cal.user_id = p_user_id
    and cal.status = 'linked'
  where i.studio_id = p_studio_id
    and i.user_id is null
  limit 1;

  if v_instructor_id is not null then
    v_before_value := jsonb_build_object('user_id', null);
    v_matched_via := 'client_account_links';

    update public.instructors
    set user_id = p_user_id
    where id = v_instructor_id;

    insert into public.instructor_audit_events (
      studio_id, instructor_id, actor_user_id, event_type,
      before_value, after_value, metadata
    ) values (
      p_studio_id, v_instructor_id, p_user_id, 'account_linked',
      v_before_value, jsonb_build_object('user_id', p_user_id),
      jsonb_build_object('source', 'invite_acceptance', 'matched_via', v_matched_via)
    );

    return v_instructor_id;
  end if;

  -- Tier 3: valid profile_user_id compatibility mapping, only when
  -- user_id is not already set (never overrides an existing user_id).
  select id into v_instructor_id
  from public.instructors
  where studio_id = p_studio_id
    and profile_user_id = p_user_id
    and user_id is null
  limit 1;

  if v_instructor_id is not null then
    v_before_value := jsonb_build_object('user_id', null);
    v_matched_via := 'profile_user_id';

    update public.instructors
    set user_id = p_user_id
    where id = v_instructor_id;

    insert into public.instructor_audit_events (
      studio_id, instructor_id, actor_user_id, event_type,
      before_value, after_value, metadata
    ) values (
      p_studio_id, v_instructor_id, p_user_id, 'account_linked',
      v_before_value, jsonb_build_object('user_id', p_user_id),
      jsonb_build_object('source', 'invite_acceptance', 'matched_via', v_matched_via)
    );

    return v_instructor_id;
  end if;

  -- Tier 4: exact, case-insensitive email match, same studio, only when
  -- exactly one unlinked candidate exists. Zero matches falls through to
  -- Tier 5 (if allowed); more than one match stops cleanly -- no link,
  -- no create, no guessing.
  if v_email <> '' then
    select count(*) into v_candidate_count
    from public.instructors
    where studio_id = p_studio_id
      and user_id is null
      and lower(trim(coalesce(email, ''))) = v_email;

    if v_candidate_count = 1 then
      select id into v_instructor_id
      from public.instructors
      where studio_id = p_studio_id
        and user_id is null
        and lower(trim(coalesce(email, ''))) = v_email
      limit 1;

      v_before_value := jsonb_build_object('user_id', null);
      v_matched_via := 'email';

      update public.instructors
      set user_id = p_user_id
      where id = v_instructor_id;

      insert into public.instructor_audit_events (
        studio_id, instructor_id, actor_user_id, event_type,
        before_value, after_value, metadata
      ) values (
        p_studio_id, v_instructor_id, p_user_id, 'account_linked',
        v_before_value, jsonb_build_object('user_id', p_user_id),
        jsonb_build_object('source', 'invite_acceptance', 'matched_via', v_matched_via)
      );

      return v_instructor_id;
    elsif v_candidate_count > 1 then
      -- Ambiguous -- stop, do not guess, do not create, no PII
      -- disclosed to the caller. Left for manual staff review.
      return null;
    end if;
  end if;

  -- Tier 5: create a minimal new instructors row, only when explicitly
  -- permitted by the caller (the 'instructor'-role invite-acceptance
  -- case). can_instruct is left at its Slice-1 safe default (false) --
  -- granting capability is Slice 6's seat-gated concern, not this
  -- helper's.
  if not p_allow_create then
    return null;
  end if;

  insert into public.instructors (
    studio_id, user_id, first_name, last_name, email, active,
    public_profile_enabled, display_order
  ) values (
    p_studio_id, p_user_id,
    coalesce(v_first_name, 'New'), coalesce(v_last_name, 'Instructor'),
    nullif(v_email, ''), true,
    false, 0
  )
  returning id into v_instructor_id;

  insert into public.instructor_audit_events (
    studio_id, instructor_id, actor_user_id, event_type,
    before_value, after_value, metadata
  ) values (
    p_studio_id, v_instructor_id, p_user_id, 'account_linked',
    null, jsonb_build_object('user_id', p_user_id),
    jsonb_build_object('source', 'invite_acceptance', 'matched_via', 'created_new')
  );

  return v_instructor_id;
end;
$$;

revoke execute on function public.resolve_or_create_linked_instructor(uuid, uuid, text, text, text, boolean)
  from public, anon, authenticated;

-- 2. accept_pending_team_invitations -- hardened + extended ----------------

create or replace function public.accept_pending_team_invitations(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_full_name text;
  v_first_name text;
  v_last_name text;
  v_space_pos integer;
  v_count integer := 0;
  invite_row record;
  existing_role text;
begin
  v_user_id := auth.uid();

  -- SECURITY FIX (Landmark 1A Slice 2): the target email is now derived
  -- exclusively from the caller's own verified JWT claim, never from the
  -- p_email parameter. p_email is intentionally ignored -- kept in the
  -- signature only for call-site compatibility. Matches this codebase's
  -- own established pattern for the identical "claim an invite addressed
  -- to me" scenario (see 20260525_ambassador_invites_v1.sql,
  -- 20260525_ambassador_invite_smart_claim_v1_1.sql).
  v_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));

  if v_user_id is null then
    return 0;
  end if;

  if v_email = '' then
    return 0;
  end if;

  select full_name into v_full_name from public.profiles where id = v_user_id;
  v_full_name := nullif(trim(coalesce(v_full_name, '')), '');

  if v_full_name is null then
    v_first_name := null;
    v_last_name := null;
  else
    v_space_pos := position(' ' in v_full_name);
    if v_space_pos = 0 then
      v_first_name := v_full_name;
      v_last_name := null;
    else
      v_first_name := trim(substring(v_full_name from 1 for v_space_pos - 1));
      v_last_name := trim(substring(v_full_name from v_space_pos + 1));
    end if;
  end if;

  for invite_row in
    select
      id,
      studio_id,
      role
    from public.team_invitations
    where lower(email) = v_email
      and accepted_at is null
      and revoked_at is null
      and expires_at >= now()
    order by created_at asc
  loop
    select usr.role
      into existing_role
    from public.user_studio_roles usr
    where usr.studio_id = invite_row.studio_id
      and usr.user_id = v_user_id
    limit 1;

    if existing_role is null then
      insert into public.user_studio_roles (
        studio_id,
        user_id,
        role,
        active
      )
      values (
        invite_row.studio_id,
        v_user_id,
        invite_row.role,
        true
      )
      on conflict (studio_id, user_id)
      do update set
        role = excluded.role,
        active = true;

    elsif existing_role in ('studio_owner', 'organizer_owner', 'platform_admin') then
      update public.user_studio_roles
      set active = true
      where studio_id = invite_row.studio_id
        and user_id = v_user_id;

    else
      update public.user_studio_roles
      set
        role = invite_row.role,
        active = true
      where studio_id = invite_row.studio_id
        and user_id = v_user_id;
    end if;

    -- Landmark 1A Slice 2: explicit-instructor-invite linkage/auto-create.
    -- can_instruct is never set true here -- Slice 6's seat-gated
    -- boundary owns that transition.
    if invite_row.role = 'instructor' then
      perform public.resolve_or_create_linked_instructor(
        invite_row.studio_id,
        v_user_id,
        v_email,
        v_first_name,
        v_last_name,
        true
      );
    end if;

    update public.team_invitations
    set
      accepted_by = v_user_id,
      accepted_at = now(),
      updated_at = now()
    where id = invite_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.accept_pending_team_invitations(text) to authenticated;

commit;
