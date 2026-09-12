-- Membership Usage-Period Alignment -- P6d: membership usage sync
-- historical-preservation hardening.
--
-- DEFECT (found during the DEV writer-cutover reconciliation, forensically
-- audited before this migration was written): the P3 sync function
-- (_sync_membership_usage_for_private_lesson_appointment) began with an
-- unconditional `delete from client_membership_usage ...` before
-- determining whether it could reconstruct a replacement row. For a
-- legacy appointment whose current `client_membership_id` no longer
-- matches the membership its historical usage row referenced (a
-- pre-existing DEV data inconsistency, confirmed unrelated to and
-- unreachable by any P1-P6c code path -- the appointment predates the
-- attended-history immutability invariant by ~3 months), re-running this
-- function destroyed a real, historically-coherent usage record with no
-- way to reconstruct it afterward (client_membership_id, benefit,
-- studio/client relationship, and membership period were all confirmed
-- coherent; only the appointment's own link had drifted). Confirmed via
-- direct pg_proc/pg_trigger inspection: no other trigger on
-- public.appointments protects `status`, so this class of drift, while
-- confirmed unreachable for any appointment attended after P3c went
-- live (client_id/appointment_type/starts_at/billing_type/
-- client_membership_id are frozen once status='attended'), remains a
-- live hazard for legacy pre-invariant data -- which PROD, never yet
-- audited for this pattern and holding far more historical appointment
-- volume than DEV, is presumed to contain. This is a PROD blocker until
-- this migration lands and is DEV-verified.
--
-- FIX: replace the destructive delete-first body with a classify-before-
-- mutate, three-state design (see the function body below for the exact
-- state machine). Automatic deletion of an existing usage row is removed
-- entirely -- confirmed via full-repository grep that no application
-- workflow today reverses attendance from 'attended' to any other
-- status (markAppointmentAttendedAction is strictly one-directional;
-- updateAppointmentAction's own status-derivation logic explicitly
-- preserves 'attended'/'no_show'/'cancelled' rather than letting the
-- general edit form change it), so building deletion authority for that
-- transition would be authorizing a destructive capability nothing in
-- the product exercises. If a genuine attendance-reversal workflow is
-- ever built, it must own its own transactional usage reversal
-- explicitly, as a new, separate, future operation -- not something
-- inferred by this general-purpose sync function from a bare status
-- value.
--
-- SIGNATURE DISCIPLINE (the specific implementation hazard this
-- migration was revised to avoid): an earlier draft of this fix proposed
-- adding a boolean parameter to _sync_membership_usage_for_private_lesson_
-- appointment(uuid) to distinguish a trigger-confirmed reversal from an
-- inferred one. In PostgreSQL, CREATE OR REPLACE FUNCTION matches by
-- (name, parameter TYPE list) -- adding a parameter, even with a
-- default, does not replace the existing single-argument function; it
-- creates a SECOND, ADDITIONAL overload in pg_proc, leaving the original
-- one-argument (destructive) body still live and still the one every
-- existing single-argument call site (the trigger wrapper's
-- `perform ..._sync_membership_usage_for_private_lesson_appointment(new.id)`)
-- would continue to resolve to. Removing the deletion-authority parameter
-- entirely (per the FIX above) makes this moot: both functions below keep
-- their EXACT existing signatures -- confirmed live via
-- pg_get_function_identity_arguments before writing this file
-- (_sync_membership_usage_for_private_lesson_appointment(p_appointment_id
-- uuid) returns void; retry_membership_usage_sync_error(p_error_id uuid)
-- returns boolean) -- so both are genuine CREATE OR REPLACE, no DROP, no
-- new overload, no signature change anywhere in this migration. The
-- trigger wrapper (sync_membership_usage_for_private_lesson_appointment(),
-- zero parameters) and the trigger object itself
-- (appointments_sync_membership_usage_for_private_lesson) are UNCHANGED
-- and untouched by this migration -- neither needed any modification,
-- since neither caller needs to pass anything new.
--
-- REPOSITORY-WIDE CALLSITE AUDIT (before writing this file): grepped the
-- entire repository for
-- `_sync_membership_usage_for_private_lesson_appointment` -- exactly
-- three real invocations exist: the trigger wrapper (P3),
-- retry_membership_usage_sync_error (P3), and the SQL harness's own
-- direct-call test. No application/TypeScript code calls it directly.
-- This is the complete, exhaustive callsite list this migration must
-- remain compatible with, and does.

begin;

-- ============================================================================
-- 1. Additive schema: a machine-readable reason code for the one proven
--    ambiguous-state case. Nullable, no default -- every pre-P6d error
--    row remains valid with reason_code IS NULL ("unstructured legacy
--    error text only"), not falsified or invalidated by this migration.
--    Exactly one reason code is introduced (historical_membership_link_
--    missing) -- no broader taxonomy; narrower than a first-draft
--    revision of this design that also proposed a second
--    ("attendance_reversal_unconfirmed") code, no longer needed once
--    automatic deletion-on-reversal was removed entirely (see FIX above).
-- ============================================================================
alter table public.membership_usage_sync_errors add column if not exists reason_code text;

comment on column public.membership_usage_sync_errors.reason_code is
  'Machine-readable ambiguity/error classification. NULL on pre-P6d rows '
  '(unstructured error_message only) and on ordinary technical-failure rows '
  '(the exception handler below does not set it). Currently one value is '
  'ever written: historical_membership_link_missing.';

-- ============================================================================
-- 2. DB-enforced concurrency backstop for unresolved-ambiguity dedup.
--    Confirmed live before writing this file: appointment_id and
--    resolved_at are the real, existing column names (no invented
--    schema); DEV currently holds zero rows in this table (verified by
--    direct query), so this index has nothing to conflict with. Scoped
--    to the appointment-referencing error family only (this migration's
--    entire scope) -- attendance_record_id's analogous index, if ever
--    needed for a future group-class slice, is not created here.
-- ============================================================================
create unique index if not exists uq_membership_usage_sync_errors_unresolved_reason
  on public.membership_usage_sync_errors (appointment_id, reason_code)
  where resolved_at is null and appointment_id is not null and reason_code is not null;

-- ============================================================================
-- 3. Hardened canonical sync -- SAME SIGNATURE as the P3 original
--    (p_appointment_id uuid) returns void. Classify-before-mutate,
--    three-state design; never deletes automatically.
-- ============================================================================
create or replace function public._sync_membership_usage_for_private_lesson_appointment(
  p_appointment_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_appt record;
  v_existing record;
  v_existing_count int;
  v_benefit_id uuid;
  v_period_id uuid;
  v_desired_usage_date date;
  v_desired_quantity numeric;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found or v_appt.appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    return;
  end if;

  select count(*) into v_existing_count
    from public.client_membership_usage
    where reference_type = 'appointment' and reference_id = p_appointment_id;
  select * into v_existing
    from public.client_membership_usage
    where reference_type = 'appointment' and reference_id = p_appointment_id
    order by created_at asc
    limit 1;

  -- ----------------------------------------------------------------------
  -- Bucket 3: current non-attended state. Never invent usage; never
  -- delete existing usage automatically -- no product workflow reverses
  -- attendance today (confirmed by repository-wide audit), so this
  -- function holds no deletion authority for that transition. A future,
  -- explicit, separate reversal operation would own that transactionally.
  -- ----------------------------------------------------------------------
  if v_appt.status <> 'attended' then
    -- Resolves ANY standing unresolved error for this appointment, not
    -- only ones tagged historical_membership_link_missing -- once the
    -- appointment is no longer attended, no membership-usage question
    -- about it remains open, regardless of what kind of error (P6d
    -- ambiguity, or a pre-P6d free-text technical failure with no
    -- reason_code at all) was previously recorded against it.
    update public.membership_usage_sync_errors
      set resolved_at = now(),
          resolution_notes = coalesce(resolution_notes, '') ||
            case when resolution_notes is null or resolution_notes = '' then '' else ' | ' end ||
            'Appointment is no longer attended as of ' || now()::text || '; membership-usage ambiguity is moot.'
      where appointment_id = p_appointment_id
        and resolved_at is null;
    return;
  end if;

  -- status = 'attended' from here on.
  if v_appt.billing_type = 'membership' and v_appt.client_membership_id is not null then
    select mpb.id into v_benefit_id
      from public.membership_plan_benefits mpb
      join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
      where cm.id = v_appt.client_membership_id
        and mpb.benefit_type = 'included_private_lessons';

    if v_benefit_id is not null then
      -- --------------------------------------------------------------
      -- Bucket 1: canonical eligible state. Idempotent upsert -- the
      -- desired row is fully computed before any mutation, and the
      -- last valid usage row is never removed before its replacement
      -- is already in place.
      -- --------------------------------------------------------------
      v_period_id := public._ensure_membership_period_for_date(v_appt.client_membership_id, v_appt.starts_at::date);
      v_desired_usage_date := v_appt.starts_at::date;
      v_desired_quantity := 1;

      if v_existing_count = 0 then
        insert into public.client_membership_usage (
          client_membership_id, client_membership_period_id, membership_plan_benefit_id,
          usage_date, quantity_used, reference_type, reference_id
        ) values (
          v_appt.client_membership_id, v_period_id, v_benefit_id,
          v_desired_usage_date, v_desired_quantity, 'appointment', p_appointment_id
        );
      elsif v_existing.client_membership_id is distinct from v_appt.client_membership_id
         or v_existing.membership_plan_benefit_id is distinct from v_benefit_id
         or v_existing.client_membership_period_id is distinct from v_period_id
         or v_existing.usage_date is distinct from v_desired_usage_date
         or v_existing.quantity_used is distinct from v_desired_quantity then
        update public.client_membership_usage
          set client_membership_id = v_appt.client_membership_id,
              membership_plan_benefit_id = v_benefit_id,
              client_membership_period_id = v_period_id,
              usage_date = v_desired_usage_date,
              quantity_used = v_desired_quantity
          where id = v_existing.id;
      end if;
      -- else: already canonical, no-op.

      -- Defensive cleanup: remove any OTHER duplicate rows for this
      -- appointment reference (never observed in practice -- the prior
      -- delete-first design never allowed more than one to accumulate --
      -- but only ever performed AFTER the canonical replacement above is
      -- already established, never before).
      if v_existing_count > 1 then
        delete from public.client_membership_usage
          where reference_type = 'appointment' and reference_id = p_appointment_id
            and id <> coalesce(v_existing.id, '00000000-0000-0000-0000-000000000000'::uuid);
      end if;

      -- Resolves ANY standing unresolved error for this appointment (see
      -- the identical rationale in the non-attended branch above) -- once
      -- canonical usage is established, every prior error against this
      -- appointment, whatever its reason_code (or lack of one), is moot.
      update public.membership_usage_sync_errors
        set resolved_at = now(),
            resolution_notes = coalesce(resolution_notes, '') ||
              case when resolution_notes is null or resolution_notes = '' then '' else ' | ' end ||
              'Canonical membership usage established as of ' || now()::text || '.'
        where appointment_id = p_appointment_id
          and resolved_at is null;
      return;
    end if;
  end if;

  -- ----------------------------------------------------------------------
  -- Bucket 2: ambiguous legacy/drifted state (attended + membership
  -- billing, but the link/benefit cannot be resolved). Existing usage
  -- (present or absent) is left completely untouched. Record durable,
  -- machine-readable, deduplicated evidence instead of guessing.
  -- ----------------------------------------------------------------------
  begin
    insert into public.membership_usage_sync_errors (
      studio_id, appointment_id, client_id, client_membership_id, membership_plan_benefit_id,
      error_message, reason_code
    ) values (
      v_appt.studio_id, p_appointment_id, v_appt.client_id, v_appt.client_membership_id, v_benefit_id,
      'Attended, membership-billed appointment has no resolvable membership/benefit link; ' ||
        'existing usage (if any) preserved untouched pending explicit resolution.',
      'historical_membership_link_missing'
    );
  exception when unique_violation then
    -- Another call already recorded this exact unresolved ambiguity --
    -- the DB-enforced partial unique index is the concurrency backstop;
    -- this is not a failure, just "already reported."
    null;
  end;
exception when others then
  insert into public.membership_usage_sync_errors (
    studio_id, appointment_id, client_id, client_membership_id, membership_plan_benefit_id, error_message
  ) values (
    v_appt.studio_id, p_appointment_id, v_appt.client_id, v_appt.client_membership_id, v_benefit_id, sqlerrm
  );
end;
$$;

-- ACL unchanged -- reissuing the same revoke a body-only CREATE OR
-- REPLACE does not alter, for explicitness/idempotency of this file.
revoke all on function public._sync_membership_usage_for_private_lesson_appointment(uuid) from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Hardened retry -- SAME SIGNATURE as the P3 original (p_error_id
--    uuid) returns boolean. Resolution is now based on the actual
--    resulting state (does an unresolved error for this appointment
--    still exist after calling sync?), never on "sync did not throw."
-- ============================================================================
create or replace function public.retry_membership_usage_sync_error(
  p_error_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_error record;
  v_still_unresolved boolean;
begin
  select * into v_error from public.membership_usage_sync_errors where id = p_error_id;
  if not found then
    raise exception 'Error record not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_error.studio_id) then
    raise exception 'Not authorized to retry membership usage synchronization for this studio.';
  end if;

  begin
    if v_error.attendance_record_id is not null then
      raise exception 'Group-class usage-sync retry is not yet implemented (downstream slice).';
    elsif v_error.appointment_id is not null then
      perform public._sync_membership_usage_for_private_lesson_appointment(v_error.appointment_id);

      -- Postcondition check -- never alters attendance (the sync call
      -- above never touches public.appointments), never fabricates or
      -- destroys historical usage on its own authority, and only ever
      -- reports success when the ambiguity is actually gone: the sync
      -- call itself is the only thing that ever sets resolved_at (in its
      -- own bucket-1/bucket-3 paths), so re-reading it here is checking
      -- real resulting state, not assuming success from a lack of
      -- exception.
      select exists (
        select 1 from public.membership_usage_sync_errors
        where id = p_error_id and resolved_at is null
      ) into v_still_unresolved;

      if v_still_unresolved then
        update public.membership_usage_sync_errors
          set resolution_notes = coalesce(resolution_notes, '') ||
            case when resolution_notes is null or resolution_notes = '' then '' else ' | ' end ||
            'Retry attempted at ' || now()::text || ': ambiguity not yet resolved; historical usage left untouched.'
          where id = p_error_id;
        return false;
      else
        return true;
      end if;
    else
      raise exception 'This error record has no resync target.';
    end if;
  exception when others then
    update public.membership_usage_sync_errors
      set error_message = error_message || ' | retry failed: ' || sqlerrm
      where id = p_error_id;
    return false;
  end;
end;
$$;

revoke all on function public.retry_membership_usage_sync_error(uuid) from public;
revoke all on function public.retry_membership_usage_sync_error(uuid) from anon;
revoke all on function public.retry_membership_usage_sync_error(uuid) from service_role;
grant execute on function public.retry_membership_usage_sync_error(uuid) to authenticated;

commit;
