-- Landmark 1A -- Slice 6: Instructor Seat Enforcement, Capability Grant,
-- Reactivation, and Hybrid Promotion.
--
-- Implements the final, locked Slice 6 design (original design +
-- Revisions 1-3 + the approved temporary hybrid-attestation-bridge owner
-- decision). Builds the first-ever reusable capability-grant workflow --
-- every prior `can_instruct` mutation (Slice 3's backfill, Slice 5A's
-- bridge) was a one-time, hand-guarded migration, never a callable RPC.
--
-- Schema: adds instructors.hybrid_client_assignment_attested -- a
-- transitional staff-attestation bridge (never inferred, never a real
-- client-roster/assignment relationship) used only until DanceFlow has a
-- first-class client-assignment subsystem. Default false; no backfill.
--
-- Private helpers (Revision 3's authorization/mutation split -- never
-- directly callable, revoked from every role):
--   _landmark1a_can_manage_instructors      -- actor authorization
--     (platform_admin, studio_owner, studio_admin -- Decision 4's locked
--     set, deliberately narrower than the broader operational-authority
--     set used elsewhere for appointments, which also includes
--     front_desk).
--   _landmark1a_resolve_studio_seat_limit   -- plan-code + billing-status
--     -> seat-limit resolution, mirroring resolveStudioBillingPlan's
--     override-vs-subscription precedence and isWorkspaceAccessAllowedStatus's
--     exact active/trialing allow-list (Revision 1's R3 correction -- no
--     separate past_due/cancelled/inactive carve-out).
--   _landmark1a_lock_instructor_for_transition -- studio-wide advisory
--     seat lock + row-level FOR UPDATE lock + fresh row read. No
--     mutation, no audit -- every caller decides idempotency from the
--     returned row before any seat-limit check runs (Revision 3's T2:
--     unconditionally seat-checking an idempotent re-grant would
--     incorrectly self-block a studio sitting exactly at its limit).
--   _landmark1a_authorize_counted_transition -- owner-exclusion + seat-
--     count + limit comparison only. No lock acquisition (the row is
--     already locked by the caller's prior call to the function above),
--     no mutation, no audit.
--
-- Public RPCs (SECURITY DEFINER, granted only to authenticated):
--   grant_instructor_capability(studio, instructor) -- the canonical
--     ordinary capability grant. Refuses outright (before any locking)
--     when the target instructor has a current, same-studio, active
--     independent-instructor/floor-rental relationship -- the ordinary
--     path can never be used as a renter-to-hybrid bypass; only
--     promote_hybrid_instructor can move such a row to can_instruct=true.
--   reactivate_instructor(studio, instructor) -- Decision 6's symmetry
--     requirement: active:false->true while can_instruct=true shares the
--     identical seat-gated boundary as an ordinary grant; while
--     can_instruct=false, no seat check and no audit (not a counted
--     transition).
--   promote_hybrid_instructor(studio, client, attested, worker_classification)
--     -- the one new capability-establishing action. Requires, in the
--     same transaction: an explicit staff attestation
--     (hybrid_client_assignment_attested=true, never inferred), an
--     explicit worker_classification of 'employee' or 'contractor'
--     (never the evidentially-insufficient 'not_set' or the semantically
--     inapplicable 'owner'), and a real instructor_payroll_profiles
--     relationship established atomically alongside the capability
--     grant. Lock order: Slice-2's (studio,user) linkage lock
--     (resolve_or_create_linked_instructor, unmodified) is acquired
--     first and held through this whole transaction (pg_advisory_xact_lock
--     is transaction-scoped, never released on function return -- see
--     Revision 1's R2), then the Slice-6 studio-wide seat lock second --
--     never the reverse, so no two-lock acquisition order exists
--     anywhere in the system and a classic lock-order deadlock cannot
--     occur. Writes exactly one capability_granted audit event, after
--     both instructors columns' final state is committed-pending, with a
--     truthful two-field before/after and a metadata.payroll_profile_created
--     flag derived from the actual upsert's xmax, never from submitted
--     parameters.
--
-- Explicitly not in this migration: Slice 7 (revocation/future-work
-- protection), Slice 8 (downgrade/new-booking freeze), Slice 9
-- (payroll/capability integrity -- already separately locked and
-- unaffected), front-desk numeric seat enforcement, any change to the
-- existing instructors_studio_user_unique_idx partial unique index, any
-- change to Slice 5's assignability trigger/helper.

begin;

-- 1. Schema -----------------------------------------------------------------

alter table public.instructors
  add column hybrid_client_assignment_attested boolean not null default false;

comment on column public.instructors.hybrid_client_assignment_attested is
  'Transitional bridge only: records that an authorized staff member explicitly attested, during hybrid promotion, that this studio formally assigns/provides clients to this independent instructor. Never inferred from appointments, linked_instructor_id, or any other signal. Does not identify which clients, when, or whether the relationship remains true over time. Superseded once a first-class client-assignment relationship model exists -- see Landmark 1A Slice 6 design, Revision 2.';

-- 2. Private helpers ----------------------------------------------------------

create or replace function public._landmark1a_can_manage_instructors(
  p_studio_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.platform_role = 'platform_admin'
  )
  or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = p_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  );
$$;

revoke all on function public._landmark1a_can_manage_instructors(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_resolve_studio_seat_limit(
  p_studio_id uuid
)
returns int
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_override_active boolean;
  v_plan_code text;
  v_status text;
begin
  select
    coalesce(s.billing_override_enabled, false)
      and (s.billing_override_expires_at is null or s.billing_override_expires_at >= now())
    into v_override_active
  from public.studios s
  where s.id = p_studio_id;

  if v_override_active then
    -- Mirrors resolveStudioBillingPlan's override branch exactly: an
    -- active override always wins outright and is always treated as
    -- status='active', regardless of any real studio_subscriptions row.
    select coalesce(s.billing_plan::text, 'pro') into v_plan_code
    from public.studios s
    where s.id = p_studio_id;

    v_status := 'active';
  else
    select ss.status, sp.code
      into v_status, v_plan_code
    from public.studio_subscriptions ss
    join public.subscription_plans sp on sp.id = ss.subscription_plan_id
    where ss.studio_id = p_studio_id;

    if not found then
      select s.subscription_status, s.billing_plan::text
        into v_status, v_plan_code
      from public.studios s
      where s.id = p_studio_id;
    end if;
  end if;

  -- Revision 1's R3 correction: mirrors isWorkspaceAccessAllowedStatus's
  -- exact allow-list (active/trialing only) as a DB-level backstop --
  -- no separate past_due/cancelled/inactive carve-out, matching the
  -- existing, stronger, already-shipped app-wide lockout for exactly
  -- this status set. Existing capability/assignability is never touched
  -- by this check -- it only ever gates a NEW grant.
  if v_status is distinct from 'active' and v_status is distinct from 'trialing' then
    return 0;
  end if;

  return case v_plan_code
    when 'starter' then 1
    when 'growth' then 5
    when 'pro' then 15
    else 0 -- organizer, null/unknown, or unresolvable -- safe-by-default,
           -- never invents a number the locked policy never specified.
  end;
end;
$$;

revoke all on function public._landmark1a_resolve_studio_seat_limit(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_lock_instructor_for_transition(
  p_studio_id uuid,
  p_instructor_id uuid
)
returns public.instructors
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_instructor public.instructors;
begin
  -- Studio-wide seat lock, acquired unconditionally and first -- held
  -- until this transaction commits/rolls back. Cheap, so not worth
  -- special-casing away for an eventually-idempotent call.
  perform pg_advisory_xact_lock(hashtext(p_studio_id::text || ':instructor_seat'));

  select * into v_instructor
  from public.instructors
  where id = p_instructor_id
    and studio_id = p_studio_id
  for update; -- row-level lock, held until commit/rollback -- defense in
              -- depth against a concurrent mutation of this exact row.

  if not found then
    raise exception 'Instructor not found for this studio.';
  end if;

  return v_instructor; -- guaranteed-fresh, locked pre-transition row --
                        -- every caller uses this for its own idempotency
                        -- decision and to build a truthful before_value.
end;
$$;

revoke all on function public._landmark1a_lock_instructor_for_transition(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_authorize_counted_transition(
  p_studio_id uuid,
  p_instructor public.instructors
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_is_owner boolean;
  v_seat_limit int;
  v_counted_seats int;
begin
  select exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = p_instructor.user_id
      and usr.studio_id = p_studio_id
      and usr.role = 'studio_owner'
      and usr.active = true
  ) into v_is_owner;

  if v_is_owner then
    return; -- owner never counted, never blocked
  end if;

  select public._landmark1a_resolve_studio_seat_limit(p_studio_id) into v_seat_limit;

  select count(*) into v_counted_seats
  from public.instructors i
  where i.studio_id = p_studio_id
    and i.active = true
    and i.can_instruct = true
    and i.user_id is not null
    and i.id is distinct from p_instructor.id -- defense in depth, not
      -- load-bearing: the caller only reaches this function when
      -- p_instructor's own pre-state already fails this WHERE clause by
      -- construction (its can_instruct/active is exactly the field about
      -- to transition true), so it could never legitimately self-match.
    and not exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = i.user_id
        and usr.studio_id = p_studio_id
        and usr.role = 'studio_owner'
        and usr.active = true
    );

  if v_counted_seats >= v_seat_limit then
    raise exception 'This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.';
  end if;
end;
$$;

revoke all on function public._landmark1a_authorize_counted_transition(uuid, public.instructors)
  from public, anon, authenticated, service_role;

-- 3. Public RPCs --------------------------------------------------------------

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

create or replace function public.reactivate_instructor(
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

  v_instructor := public._landmark1a_lock_instructor_for_transition(p_studio_id, p_instructor_id);

  if v_instructor.active = true then
    return; -- idempotent no-op, no audit
  end if;

  if v_instructor.can_instruct = false then
    -- Not a counted transition -- Decision 6: no seat check, no audit.
    update public.instructors
    set active = true
    where id = p_instructor_id;

    return;
  end if;

  perform public._landmark1a_authorize_counted_transition(p_studio_id, v_instructor);

  update public.instructors
  set active = true
  where id = p_instructor_id;

  insert into public.instructor_audit_events (
    studio_id, instructor_id, actor_user_id, event_type,
    before_value, after_value, metadata
  ) values (
    p_studio_id, p_instructor_id, v_caller, 'activated',
    jsonb_build_object('active', false),
    jsonb_build_object('active', true),
    jsonb_build_object('source', 'reactivate_instructor')
  );
end;
$$;

revoke all on function public.reactivate_instructor(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.reactivate_instructor(uuid, uuid) to authenticated;

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

commit;
