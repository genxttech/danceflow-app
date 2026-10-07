-- 20261025090000_gc34c_self_enroll_started_class_guard.sql
--
-- GC-3.4C (owner decisions D1 + D2): authoritative started-class and
-- public-discoverability guards on the existing self-service enrollment write.
--
-- CREATE OR REPLACE of public.self_enroll_class_attendee(uuid, uuid, uuid, uuid)
-- RETURNS uuid only -- same signature, owner, SECURITY DEFINER, search_path and
-- grants. No new RPC, no schema, constraint, index, trigger or RLS change.
--
-- Changes relative to the released gc3d body (20260913091200), and nothing else:
--   1. The class lookup also reads starts_at.
--   2. NEW, after the existing relationship authorization: the occurrence must
--      still be publicly discoverable, via the existing canonical predicate
--      public.is_group_class_publicly_discoverable (gc3e) -- the identical rule
--      preview_self_enrollment_funding_candidates applies inline. A class that
--      is not discoverable is refused with the SAME message as a class whose
--      policy disallows self-enrollment, so no new existence/status signal is
--      added for non-public classes; and it is only reached by a caller already
--      authorized for that client at that studio.
--   3. NEW, after the existing self_enrollment_allowed check: a class whose
--      starts_at <= now() (starting now, started, or ended) is refused with
--      'GC34C_CLASS_STARTED'. timestamptz comparison -- independent of browser
--      and studio time zones. A null starts_at fails closed. Only this
--      self-service function changes; staff enrollment (enroll_class_attendee)
--      and series enrollment are untouched, so staff walk-ins after the start
--      keep working.
--
-- Preserved verbatim: tenant scope from the target row; the linked
-- can_manage_bookings relationship gate; the self_enrollment_allowed re-check;
-- client-in-studio; live funding resolution (packages need remaining > 0 and
-- are debited at attendance, finite memberships stay cumulative and locked by
-- their trigger -- nothing is reserved or consumed here; decision #10 is
-- untouched); the insert and its unique_violation -> "already enrolled"
-- mapping (uq_appointment_attendees_active stays the idempotency authority);
-- the cancelled-class guard and roster capacity, which remain in the locked
-- roster-capacity trigger. No new lock is taken here (keeps the existing
-- membership -> appointment trigger lock order). Client status is not checked
-- (owner decision D3: inactive-client policy is out of scope).

begin;

-- >>> GC-3.4C PRECONDITIONS: refuse to replace anything but the reviewed predecessor.
do $$
begin
  if (select count(*) from pg_proc where proname = 'self_enroll_class_attendee') <> 1 then
    raise exception 'GC-3.4C: unexpected self_enroll_class_attendee overloads';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.self_enroll_class_attendee(uuid, uuid, uuid, uuid)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prorettype = 'uuid'::regtype
      and p.proconfig = array['search_path=public']
      and md5(replace(p.prosrc, E'\r', '')) = '90405968bc50ed1085850fa8076c7eac'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x)
          = 'authenticated=X/postgres,postgres=X/postgres'
  ) then
    raise exception 'GC-3.4C: self_enroll_class_attendee is not the reviewed gc3d definition';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.is_group_class_publicly_discoverable(uuid)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and md5(replace(p.prosrc, E'\r', '')) = '21bd382849c76fc0b6c5d9f311c4e1db'
  ) then
    raise exception 'GC-3.4C: is_group_class_publicly_discoverable is not the reviewed gc3e definition';
  end if;
end $$;
-- <<< GC-3.4C PRECONDITIONS

create or replace function public.self_enroll_class_attendee(
  p_appointment_id uuid,
  p_client_id uuid,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_starts_at timestamptz;
  v_authorized boolean;
  v_allowed boolean;
  v_eligible_count int;
  v_candidate_funding_type text;
  v_candidate_source_id uuid;
  v_client_package_id uuid;
  v_client_membership_id uuid;
  v_attendee_id uuid;
begin
  -- 1. Resolve tenant scope from the TARGET ROW. No p_studio_id parameter
  --    exists on this function -- a caller can never assert a studio.
  select studio_id, starts_at into v_studio_id, v_starts_at
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  -- 2. Explicit, narrow authorization: a linked relationship with
  --    can_manage_bookings=true for this exact user, studio and client.
  select exists (
    select 1 from public.client_account_links cal
    where cal.user_id = auth.uid()
      and cal.studio_id = v_studio_id
      and cal.client_id = p_client_id
      and cal.status = 'linked'
      and cal.can_manage_bookings = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to enroll this client into this class.';
  end if;

  -- 2b. GC-3.4C (D2): the occurrence must still be publicly discoverable, by
  --     the canonical gc3e predicate. Same message as a disallowed policy, so
  --     discoverability is never a separate signal.
  if not public.is_group_class_publicly_discoverable(p_appointment_id) then
    raise exception 'This class is not open for self-enrollment.';
  end if;

  -- 3. Policy re-check -- self_enrollment_allowed is re-verified here, live,
  --    never trusted from any client-supplied or cached page state.
  select self_enrollment_allowed into v_allowed
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

  if v_allowed is not true then
    raise exception 'This class is not open for self-enrollment.';
  end if;

  -- 3b. GC-3.4C (D1): no self-service enrollment once the class has started
  --     (or ended). timestamptz vs now(); a missing start time fails closed.
  if v_starts_at is null or v_starts_at <= now() then
    raise exception 'GC34C_CLASS_STARTED: This class has already started.';
  end if;

  -- 4. Client belongs to this studio (defense in depth).
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  -- 5. Re-resolve eligibility live via the internal candidate helper.
  select count(*), (array_agg(funding_type))[1], (array_agg(source_id))[1]
    into v_eligible_count, v_candidate_funding_type, v_candidate_source_id
    from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null);

  if v_eligible_count = 0 then
    raise exception 'No eligible package or membership found for this class.';
  elsif v_eligible_count = 1 then
    -- Auto-use the sole candidate, ignore any caller-supplied IDs.
    v_client_package_id := case when v_candidate_funding_type = 'package' then v_candidate_source_id end;
    v_client_membership_id := case when v_candidate_funding_type = 'membership' then v_candidate_source_id end;
  else
    -- The caller must supply exactly one explicit choice, re-checked against
    -- the live eligible set.
    if (p_client_package_id is null) = (p_client_membership_id is null) then
      raise exception 'A single funding source choice is required.';
    end if;

    if p_client_package_id is not null then
      if not exists (
        select 1 from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null)
        where funding_type = 'package' and source_id = p_client_package_id
      ) then
        raise exception 'Selected package is not an eligible funding source for this class.';
      end if;
    else
      if not exists (
        select 1 from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null)
        where funding_type = 'membership' and source_id = p_client_membership_id
      ) then
        raise exception 'Selected membership is not an eligible funding source for this class.';
      end if;
    end if;

    v_client_package_id := p_client_package_id;
    v_client_membership_id := p_client_membership_id;
  end if;

  -- 6. Insert. Cancelled class and capacity are enforced by the locked
  --    roster-capacity trigger; duplicates by uq_appointment_attendees_active.
  begin
    insert into public.appointment_attendees (
      studio_id, appointment_id, client_id, status, source,
      billing_type, client_package_id, client_membership_id, created_by
    )
    values (
      v_studio_id, p_appointment_id, p_client_id, 'booked', 'self_service',
      case when v_client_package_id is not null then 'package_credit' else 'membership' end,
      v_client_package_id, v_client_membership_id, auth.uid()
    )
    returning id into v_attendee_id;
  exception when unique_violation then
    raise exception 'You are already enrolled in this class.';
  end;

  return v_attendee_id;
end;
$$;

alter function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) owner to postgres;
revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from public;
revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from anon;
revoke all on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) from service_role;
grant execute on function public.self_enroll_class_attendee(uuid, uuid, uuid, uuid) to authenticated;

commit;
