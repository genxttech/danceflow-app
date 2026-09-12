-- Membership Usage-Period Alignment -- P6f: membership usage
-- error-resolution scope correction (migration-history packaging
-- cleanup only, not a new behavior change).
--
-- CONTEXT: during DEV verification of P6d, the harness exposed a defect
-- in _sync_membership_usage_for_private_lesson_appointment's own
-- error-resolution scoping: its two resolution UPDATE statements
-- required an exact `reason_code = 'historical_membership_link_missing'`
-- match, so a legacy or free-text error row (reason_code IS NULL, or any
-- other value) never resolved even once canonical membership usage was
-- established or the appointment left the attended state. The fix --
-- broadening both resolution UPDATEs to match any unresolved error for
-- the appointment_id, regardless of reason_code -- was made by directly
-- editing and re-applying the P6d migration file within the same
-- authorized DEV-rollout turn P6d was first applied in. That edit is
-- already live on DEV and already fully re-verified (complete MUPA
-- harness, P6e lifecycle tests, and the exact discovered regression
-- scenario all passed against the corrected body).
--
-- PACKAGING PROBLEM THIS MIGRATION EXISTS TO FIX (not a functional one):
-- P6d is the one migration in this entire multi-week effort where an
-- already-hosted-DEV-applied file was edited and re-applied under its
-- own name, rather than corrected via a new, separately-named migration
-- -- the pattern used consistently everywhere else a defect was found in
-- an already-applied migration (P6's two real defects -> P6b, P6c; never
-- an edit-in-place of P6 itself). This migration exists solely to give
-- that already-live, already-correct, already-verified correction its
-- own explicit, immutable, hosted migration boundary, consistent with
-- P6b's and P6c's precedent -- not to change what is currently running
-- on DEV in any way.
--
-- BEHAVIOR: this is a pure CREATE OR REPLACE FUNCTION reassertion of the
-- function body already live on DEV (confirmed identical via direct
-- pg_proc inspection immediately before writing this file). Applying it
-- is behaviorally idempotent -- DEV's observable behavior does not
-- change at all, before or after. Signature
-- (_sync_membership_usage_for_private_lesson_appointment(p_appointment_id
-- uuid) returns void), volatility (VOLATILE), SECURITY DEFINER,
-- search_path ('public'), and ACLs (revoked from public/anon/
-- authenticated/service_role, executable only by the function's owner)
-- are all unchanged from P6d -- reissued here verbatim, not altered.
--
-- SCOPE DISCIPLINE: exactly one function body, no other changes. P1-P6e
-- are preserved exactly as already applied to DEV and are not edited by
-- this migration. From this point forward, any further correction to an
-- already-hosted migration must use a new migration file, never an
-- edit-in-place -- the discipline this migration itself exists to
-- restore.

begin;

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

revoke all on function public._sync_membership_usage_for_private_lesson_appointment(uuid) from public, anon, authenticated, service_role;

commit;
