-- rollback/20261025090000_gc34c_self_enroll_started_class_guard_rollback.sql
--
-- Restores the exact released gc3d body of public.self_enroll_class_attendee
-- (20260913091200; body md5 90405968bc50ed1085850fa8076c7eac), removing the
-- GC-3.4C started-class and public-discoverability guards. Function behavior
-- only: the forward migration created no data, so there is nothing else to
-- roll back. Roll the application back first. Same owner, SECURITY DEFINER,
-- search_path and grants.

begin;

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.self_enroll_class_attendee(uuid, uuid, uuid, uuid)'::regprocedure
      and md5(replace(p.prosrc, E'\r', '')) = 'c5edafd4915060533faca30a9376e2d2'
  ) then
    raise exception 'GC-3.4C rollback: self_enroll_class_attendee is not the GC-3.4C definition';
  end if;
end $$;

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
  select studio_id into v_studio_id
    from public.appointments
    where id = p_appointment_id
      and appointment_type = 'group_class'::public.appointment_type;

  if v_studio_id is null then
    raise exception 'Group class not found.';
  end if;

  -- 2. Explicit, narrow authorization (Decision 1) -- NOT
  --    user_has_client_portal_access alone. Mirrors the P6 private-lesson
  --    self-service RPC family's own confirmed gate for mutating booking
  --    actions: a linked relationship with can_manage_bookings=true. No
  --    relationship_type filter -- a guardian managing a dependent client
  --    is authorized identically to a self-link (same generalization P6
  --    already established and this migration deliberately reuses).
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

  -- 3. Policy re-check -- self_enrollment_allowed is re-verified here, live,
  --    never trusted from any client-supplied or cached page state.
  select self_enrollment_allowed into v_allowed
    from public.group_class_enrollment_policies
    where appointment_id = p_appointment_id;

  if v_allowed is not true then
    raise exception 'This class is not open for self-enrollment.';
  end if;

  -- 4. Client belongs to this studio (defense in depth, mirrors
  --    enroll_class_attendee's own equivalent check).
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id
  ) then
    raise exception 'Client not found for this studio.';
  end if;

  -- 5. Re-resolve eligibility live -- calls the internal helper directly,
  --    not the public get_eligible_group_class_funding_candidates wrapper:
  --    that wrapper's own embedded authorization check (staff/instructor
  --    only) can never be satisfied by this portal caller, who has already
  --    passed this function's own, independent, correct authorization in
  --    step 2 above. Never a cached list, closing the "stale page state"
  --    requirement.
  select count(*), (array_agg(funding_type))[1], (array_agg(source_id))[1]
    into v_eligible_count, v_candidate_funding_type, v_candidate_source_id
    from public._group_class_funding_candidates_for(v_studio_id, p_client_id, p_appointment_id, null);

  if v_eligible_count = 0 then
    raise exception 'No eligible package or membership found for this class.';
  elsif v_eligible_count = 1 then
    -- Decision 6: auto-use the sole candidate, ignore any caller-supplied IDs.
    v_client_package_id := case when v_candidate_funding_type = 'package' then v_candidate_source_id end;
    v_client_membership_id := case when v_candidate_funding_type = 'membership' then v_candidate_source_id end;
  else
    -- Decision 7: caller must supply exactly one explicit choice, and it
    -- must be one of the actually-eligible candidates just resolved above
    -- -- never trust a raw caller-supplied ID without re-checking it
    -- against the live eligible set.
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

  -- 6. Insert. Capacity race handled entirely by GC-3.1's already-universal
  --    roster-capacity trigger (Decision 9 -- no duplicated check here,
  --    avoiding a TOCTOU gap between an RPC-side check and this insert).
  --    Duplicate enrollment handled by the existing unique_violation catch
  --    (Decision 8), reused verbatim.
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
