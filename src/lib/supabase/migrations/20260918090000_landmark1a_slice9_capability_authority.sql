-- Landmark 1A -- Slice 9: capability-authority boundary.
--
-- Slice 6 made the capability RPCs the canonical way to change instructional
-- authority, and Slice 7/8 added future-work protection and seat authority.
-- But the instructors table itself still accepted direct tenant writes: the
-- "studio admins manage instructors" policy is FOR ALL for platform_admin,
-- owner, admin AND front_desk with no column limits, so a direct PostgREST
-- write could grant or revoke can_instruct (bypassing the renter guard, the
-- hybrid attestation and Slice 7's future-work protection), write the hybrid
-- attestation flag, re-point/unlink a capable account, move an instructor
-- between studios, or delete a capable instructor -- none of it audited.
--
-- Invariant established here: only the canonical SECURITY DEFINER capability
-- RPCs (running as postgres), service_role and migrations may change
-- instructional authority or capable-account linkage.
--
--   1. guard_instructors_capability_columns (BEFORE INSERT / UPDATE / DELETE
--      on instructors, SECURITY INVOKER, decides on current_user only, takes
--      no locks). anon/authenticated may not: change can_instruct (either
--      direction), change or insert hybrid_client_assignment_attested, INSERT a
--      capable row, change studio_id, change user_id of a capable row, or
--      DELETE a capable row. Ordinary staff edits and the non-capable account
--      link lifecycle are untouched. FK cascades (auth-user / studio deletion)
--      run as the table owner and pass.
--   2. The instructors write policy loses front_desk (the app never allowed
--      front desk to edit instructors; the capability RPCs exclude it).
--      Front-desk read access (separate SELECT policy) is unchanged.
--   3. Same-studio validators for instructor_payroll_profiles,
--      instructor_compensation_rules and clients.linked_instructor_id, so no
--      cross-tenant instructor reference can be created.
--   4. _landmark1a_instructor_has_renter_relationship: one studio-scoped
--      renter determination (linked_instructor_id OR a linked 'self' account
--      relationship), used by grant_instructor_capability so the ordinary grant
--      cannot be a renter-to-hybrid bypass.
--   5. promote_hybrid_instructor hardened in place (same signature, same lock
--      order): only a linked 'self' relationship resolves the promoted
--      account; client/instructor consistency; explicit worker-classification
--      guardrails (Model A: promotion may establish payroll, never silently
--      rewrite an established classification, never overwrite 'owner'); prior
--      payroll state recorded in the existing immutable audit event.
--
-- No table/column/data change, no backfill, no new audit table or event type.
-- reactivate_instructor and revoke_instructor_capability are unchanged.

begin;

-- 1. Capability-column guard ------------------------------------------------------

create or replace function public._guard_instructors_capability_columns()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.can_instruct is distinct from false
         or new.hybrid_client_assignment_attested is distinct from false then
        raise exception 'Instructor capability and hybrid attestation can only be set through the capability workflow.'
          using errcode = '42501';
      end if;
    elsif tg_op = 'DELETE' then
      if old.can_instruct is true then
        raise exception 'A capable instructor cannot be deleted directly. Revoke capability first.'
          using errcode = '42501';
      end if;
    else
      if new.can_instruct is distinct from old.can_instruct then
        raise exception 'Instructor capability can only be changed through the capability workflow.'
          using errcode = '42501';
      end if;
      if new.hybrid_client_assignment_attested is distinct from old.hybrid_client_assignment_attested then
        raise exception 'Hybrid attestation can only be changed through the hybrid promotion workflow.'
          using errcode = '42501';
      end if;
      if new.studio_id is distinct from old.studio_id then
        raise exception 'An instructor cannot be moved between studios.'
          using errcode = '42501';
      end if;
      if new.user_id is distinct from old.user_id and old.can_instruct is true then
        raise exception 'The linked account of a capable instructor cannot be changed. Revoke capability first.'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public._guard_instructors_capability_columns()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_instructors_capability_columns on public.instructors;

create trigger guard_instructors_capability_columns
before insert or update of can_instruct, hybrid_client_assignment_attested, user_id, studio_id
  or delete
on public.instructors
for each row
execute function public._guard_instructors_capability_columns();

-- 2. Front desk loses direct instructor-row write authority -----------------------

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
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = instructors.studio_id
      and usr.role = any (array['platform_admin', 'studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  )
);

-- 3. Same-studio validators ---------------------------------------------------------

create or replace function public._landmark1a_assert_worker_row_same_studio()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_instructor_studio uuid;
begin
  select i.studio_id into v_instructor_studio
  from public.instructors i
  where i.id = new.instructor_id;

  if v_instructor_studio is distinct from new.studio_id then
    raise exception '% must reference an instructor of the same studio.', tg_table_name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public._landmark1a_assert_worker_row_same_studio()
  from public, anon, authenticated, service_role;

drop trigger if exists landmark1a_payroll_profiles_same_studio on public.instructor_payroll_profiles;
create trigger landmark1a_payroll_profiles_same_studio
before insert or update of studio_id, instructor_id
on public.instructor_payroll_profiles
for each row
execute function public._landmark1a_assert_worker_row_same_studio();

drop trigger if exists landmark1a_compensation_rules_same_studio on public.instructor_compensation_rules;
create trigger landmark1a_compensation_rules_same_studio
before insert or update of studio_id, instructor_id
on public.instructor_compensation_rules
for each row
execute function public._landmark1a_assert_worker_row_same_studio();

create or replace function public._landmark1a_assert_client_linked_instructor_same_studio()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_instructor_studio uuid;
begin
  if new.linked_instructor_id is null then
    return new;
  end if;

  select i.studio_id into v_instructor_studio
  from public.instructors i
  where i.id = new.linked_instructor_id;

  if v_instructor_studio is distinct from new.studio_id then
    raise exception 'clients.linked_instructor_id must reference an instructor of the same studio.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public._landmark1a_assert_client_linked_instructor_same_studio()
  from public, anon, authenticated, service_role;

drop trigger if exists landmark1a_clients_linked_instructor_same_studio on public.clients;
create trigger landmark1a_clients_linked_instructor_same_studio
before insert or update of studio_id, linked_instructor_id
on public.clients
for each row
execute function public._landmark1a_assert_client_linked_instructor_same_studio();

-- 4. Canonical renter determination ---------------------------------------------------

-- True when, at THIS studio, the instructor is operating as an independent /
-- floor-rental renter: an independent-instructor client explicitly linked to
-- the instructor row, or an independent-instructor client whose linked
-- 'self' account relationship is the instructor's own account. Guardian /
-- dependent / other relationship types never count. Live state only.
create or replace function public._landmark1a_instructor_has_renter_relationship(
  p_studio_id uuid,
  p_instructor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1
    from public.clients c
    where c.studio_id = p_studio_id
      and c.is_independent_instructor = true
      and (
        c.linked_instructor_id = p_instructor_id
        or exists (
          select 1
          from public.client_account_links l
          join public.instructors i
            on i.id = p_instructor_id
           and i.studio_id = p_studio_id
           and i.user_id is not null
          where l.client_id = c.id
            and l.studio_id = p_studio_id
            and l.status = 'linked'
            and l.relationship_type = 'self'
            and l.user_id = i.user_id
        )
      )
  );
$$;

revoke all on function public._landmark1a_instructor_has_renter_relationship(uuid, uuid)
  from public, anon, authenticated, service_role;

-- 5. grant_instructor_capability: renter guard on the canonical helper -----------------

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

  -- Renter guard (Slice 9: canonical helper). Checked before any locking,
  -- since it is a hard rejection independent of concurrency/seat state.
  -- Same-studio scoped, current-live-state only (never historical).
  if public._landmark1a_instructor_has_renter_relationship(p_studio_id, p_instructor_id) then
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

-- 6. promote_hybrid_instructor hardening ------------------------------------------------

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
  v_self_link_count int;
  v_instructor_id uuid;
  v_instructor public.instructors;
  v_prior public.instructor_payroll_profiles;
  v_prior_exists boolean;
  v_prior_class text;
  v_payroll_action text;
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
  if p_worker_classification is null
     or p_worker_classification not in ('employee', 'contractor') then
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
  -- Slice 9: only the client's own ('self') linked account may resolve the
  -- promoted instructor -- never a guardian / dependent / other relationship.
  select count(*), min(cal.user_id::text)::uuid
    into v_self_link_count, v_linked_user_id
  from public.client_account_links cal
  where cal.client_id = p_client_id
    and cal.studio_id = p_studio_id
    and cal.status = 'linked'
    and cal.relationship_type = 'self'
    and cal.user_id is not null;
  if v_self_link_count = 0 then
    raise exception 'This independent instructor does not have a linked DanceFlow account yet.';
  end if;
  if v_self_link_count > 1 then
    raise exception 'This client has more than one linked account for itself; resolve the account link before promotion.';
  end if;
  -- Lock order (unchanged from Slice 6): the (studio,user) linkage lock is
  -- acquired first, inside resolve_or_create_linked_instructor, and remains
  -- held through the seat lock acquired below. Never the reverse order.
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
  -- Slice 9: the resolved instructor must belong to this studio and agree with
  -- the client's own instructor link when one is set.
  if v_instructor.studio_id is distinct from p_studio_id then
    raise exception 'The resolved instructor does not belong to this studio.';
  end if;
  if v_client.linked_instructor_id is not null
     and v_client.linked_instructor_id is distinct from v_instructor.id then
    raise exception 'The instructor record for this account does not match the client''s linked instructor.';
  end if;
  if v_instructor.can_instruct = true and v_instructor.hybrid_client_assignment_attested = true then
    return; -- fully idempotent no-op: no payroll touch, no seat check, no audit
  end if;
  if v_instructor.can_instruct = false then
    -- Genuine new seat-consuming transition -- fail fast before touching
    -- payroll data at all.
    perform public._landmark1a_authorize_counted_transition(p_studio_id, v_instructor);
  end if;
  -- Payroll (Model A with guardrails). The payroll row is locked last, after
  -- the instructor row, exactly where the Slice 6 upsert took it.
  select * into v_prior
  from public.instructor_payroll_profiles
  where studio_id = p_studio_id
    and instructor_id = v_instructor.id
  for update;
  v_prior_exists := found;

  if v_prior_exists then
    -- NULL and 'not_set' both mean "no classification established yet": the
    -- supplied employee/contractor may be set. Only an established
    -- employee/contractor (different) or 'owner' blocks promotion.
    v_prior_class := coalesce(v_prior.worker_classification, 'not_set');
    if v_prior_class = 'owner' then
      raise exception 'This instructor''s payroll classification is owner and cannot be replaced by hybrid promotion.';
    end if;
    if v_prior_class in ('employee', 'contractor')
       and v_prior_class <> p_worker_classification then
      raise exception 'This instructor already has an established payroll classification (%) that differs from the one supplied. Change it in payroll settings first.',
        v_prior_class;
    end if;
  end if;

  v_payroll_action := case
    when not v_prior_exists then 'created'
    when v_prior.payroll_active is not true then 'reactivated'
    when v_prior_class = 'not_set' then 'classification_established'
    else 'unchanged'
  end;

  insert into public.instructor_payroll_profiles (
    studio_id, instructor_id, payroll_active, worker_classification
  ) values (
    p_studio_id, v_instructor.id, true, p_worker_classification
  )
  on conflict (studio_id, instructor_id) do update
    set payroll_active = true,
        worker_classification = excluded.worker_classification,
        updated_at = now();

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
      'payroll_profile_created', not v_prior_exists,
      'worker_classification', p_worker_classification,
      'prior_payroll_profile_existed', v_prior_exists,
      'prior_payroll_active', case when v_prior_exists then v_prior.payroll_active else null end,
      'prior_worker_classification', case when v_prior_exists then v_prior.worker_classification else null end,
      'resulting_worker_classification', p_worker_classification,
      'payroll_profile_action', v_payroll_action
    )
  );
end;
$$;

revoke all on function public.promote_hybrid_instructor(uuid, uuid, boolean, text)
  from public, anon, service_role;
grant execute on function public.promote_hybrid_instructor(uuid, uuid, boolean, text) to authenticated;

commit;
