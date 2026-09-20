-- Rollback for 20260918090000_landmark1a_slice9_capability_authority.sql
--
-- Restores the exact pre-Slice-9 state: removes the instructors capability
-- guard, the same-studio validators and the renter helper, restores the
-- previous instructors write policy (including front_desk) and restores the
-- Slice 6 bodies of grant_instructor_capability and promote_hybrid_instructor
-- verbatim. Slice 7, Slice 8 and the platform-role guard are untouched. No
-- row data is changed.
--
-- WARNING: rolling this back RE-OPENS the direct-write bypasses: any
-- platform_admin/owner/admin/front_desk can again grant or revoke can_instruct,
-- write the hybrid attestation, unlink or re-point a capable account, move or
-- delete a capable instructor directly, and cross-studio instructor references
-- become possible again. Use only under a separately approved decision.
--
-- Order: the guard/validator triggers are dropped first, the two RPC bodies
-- are restored (they no longer reference the helper), then the helper and
-- function objects are dropped last.

begin;

drop trigger if exists guard_instructors_capability_columns on public.instructors;
drop trigger if exists landmark1a_payroll_profiles_same_studio on public.instructor_payroll_profiles;
drop trigger if exists landmark1a_compensation_rules_same_studio on public.instructor_compensation_rules;
drop trigger if exists landmark1a_clients_linked_instructor_same_studio on public.clients;

drop policy if exists "studio admins manage instructors" on public.instructors;

create policy "studio admins manage instructors"
on public.instructors
for all
to public
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructors.studio_id
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructors.studio_id
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  )
);

-- Slice 6 grant_instructor_capability, restored verbatim.
create or replace function public.grant_instructor_capability(
  p_studio_id uuid,
  p_instructor_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_instructor public.instructors;
begin
  if v_caller is null then
    raise exception 'Not authenticated.';
  end if;

  if not public._landmark1a_can_manage_instructors(p_studio_id) then
    raise exception 'Not authorized to manage instructors for this studio.';
  end if;

  -- Renter guard: checked before any locking, since it is a hard
  -- rejection independent of concurrency/seat state. Same-studio scoped,
  -- current-live-state only (never historical) -- a renter relationship
  -- that has been deactivated via the existing client settings action
  -- (is_independent_instructor set back to false) naturally stops
  -- matching here on the very next attempt, with no new code needed to
  -- "unblock" it.
  if exists (
    select 1 from public.clients c
    where c.studio_id = p_studio_id
      and c.linked_instructor_id = p_instructor_id
      and c.is_independent_instructor = true
  ) then
    raise exception 'This instructor has an independent/floor-rental relationship at this studio. Use the hybrid promotion action, which also establishes the required formal instructional relationship.';
  end if;

  v_instructor := public._landmark1a_lock_instructor_for_transition(p_studio_id, p_instructor_id);

  if v_instructor.user_id is null then
    raise exception 'This instructor must have a linked DanceFlow account before capability can be granted.';
  end if;

  if v_instructor.can_instruct = true then
    return; -- idempotent no-op: no seat check, no mutation, no audit
  end if;

  perform public._landmark1a_authorize_counted_transition(p_studio_id, v_instructor);

  update public.instructors
  set can_instruct = true
  where id = p_instructor_id;

  insert into public.instructor_audit_events (
    studio_id, instructor_id, actor_user_id, event_type,
    before_value, after_value, metadata
  ) values (
    p_studio_id, p_instructor_id, v_caller, 'capability_granted',
    jsonb_build_object('can_instruct', false),
    jsonb_build_object('can_instruct', true),
    jsonb_build_object('source', 'grant_instructor_capability')
  );
end;
$$;

revoke all on function public.grant_instructor_capability(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.grant_instructor_capability(uuid, uuid) to authenticated;

-- Slice 6 promote_hybrid_instructor, restored verbatim.
create or replace function public.promote_hybrid_instructor(
  p_studio_id uuid,
  p_client_id uuid,
  p_hybrid_client_assignment_attested boolean,
  p_worker_classification text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_client public.clients;
  v_linked_user_id uuid;
  v_instructor_id uuid;
  v_instructor public.instructors;
  v_payroll_created boolean;
  v_before jsonb;
begin
  if v_caller is null then
    raise exception 'Not authenticated.';
  end if;

  if not public._landmark1a_can_manage_instructors(p_studio_id) then
    raise exception 'Not authorized to manage instructors for this studio.';
  end if;

  if p_hybrid_client_assignment_attested is distinct from true then
    raise exception 'Hybrid promotion requires an explicit staff attestation that this studio formally assigns/provides clients to this instructor.';
  end if;

  if p_worker_classification not in ('employee', 'contractor') then
    raise exception 'Hybrid promotion requires an explicit worker classification of employee or contractor.';
  end if;

  select * into v_client
  from public.clients
  where id = p_client_id
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Client not found for this studio.';
  end if;

  if v_client.is_independent_instructor is distinct from true then
    raise exception 'This client does not have an independent-instructor relationship at this studio.';
  end if;

  select cal.user_id into v_linked_user_id
  from public.client_account_links cal
  where cal.client_id = p_client_id
    and cal.studio_id = p_studio_id
    and cal.status = 'linked'
  limit 1;

  if v_linked_user_id is null then
    raise exception 'This independent instructor does not have a linked DanceFlow account yet.';
  end if;

  -- Lock order (Revision 1's R2, canonical): the Slice-2 (studio,user)
  -- linkage lock is acquired first, inside resolve_or_create_linked_instructor,
  -- and -- because pg_advisory_xact_lock is transaction-scoped -- remains
  -- held through the rest of THIS transaction, including through the
  -- Slice-6 seat lock acquired below. Never the reverse order anywhere
  -- in this system.
  v_instructor_id := public.resolve_or_create_linked_instructor(
    p_studio_id,
    v_linked_user_id,
    null,
    v_client.first_name,
    v_client.last_name,
    true
  );

  if v_instructor_id is null then
    raise exception 'Could not resolve or create the host instructor record for this account.';
  end if;

  v_instructor := public._landmark1a_lock_instructor_for_transition(p_studio_id, v_instructor_id);

  if v_instructor.can_instruct = true and v_instructor.hybrid_client_assignment_attested = true then
    return; -- fully idempotent no-op: no payroll touch, no seat check, no audit
  end if;

  if v_instructor.can_instruct = false then
    -- Genuine new seat-consuming transition -- fail fast before touching
    -- payroll data at all.
    perform public._landmark1a_authorize_counted_transition(p_studio_id, v_instructor);
  end if;
  -- If can_instruct was already true but hybrid_client_assignment_attested
  -- was false (the rare repair case -- e.g. a row made capable by some
  -- other means before this action ever ran against it), no new seat is
  -- being consumed, so no seat check runs here.

  insert into public.instructor_payroll_profiles (
    studio_id, instructor_id, payroll_active, worker_classification
  ) values (
    p_studio_id, v_instructor.id, true, p_worker_classification
  )
  on conflict (studio_id, instructor_id) do update
    set payroll_active = true,
        worker_classification = excluded.worker_classification,
        updated_at = now()
  returning (xmax = 0) into v_payroll_created;

  v_before := jsonb_build_object(
    'can_instruct', v_instructor.can_instruct,
    'hybrid_client_assignment_attested', v_instructor.hybrid_client_assignment_attested
  );

  update public.instructors
  set can_instruct = true,
      hybrid_client_assignment_attested = true
  where id = v_instructor.id;

  insert into public.instructor_audit_events (
    studio_id, instructor_id, actor_user_id, event_type,
    before_value, after_value, metadata
  ) values (
    p_studio_id, v_instructor.id, v_caller, 'capability_granted',
    v_before,
    jsonb_build_object('can_instruct', true, 'hybrid_client_assignment_attested', true),
    jsonb_build_object(
      'source', 'hybrid_promotion',
      'payroll_profile_created', v_payroll_created,
      'worker_classification', p_worker_classification
    )
  );
end;
$$;

revoke all on function public.promote_hybrid_instructor(uuid, uuid, boolean, text)
  from public, anon, service_role;
grant execute on function public.promote_hybrid_instructor(uuid, uuid, boolean, text) to authenticated;

drop function if exists public._landmark1a_instructor_has_renter_relationship(uuid, uuid);
drop function if exists public._landmark1a_assert_client_linked_instructor_same_studio();
drop function if exists public._landmark1a_assert_worker_row_same_studio();
drop function if exists public._guard_instructors_capability_columns();

commit;
