-- ============================================================================
-- GC-S1D-2 -- series ("this and following classes") enrollment and removal for ONE dancer.
--
-- Function-only migration: no table, column, index, policy, trigger or data change. Series enrollment is not a
-- second roster: it applies ORDINARY per-occurrence appointment_attendees rows (enroll) or cancels them (remove)
-- across the selected occurrence and the following occurrences of the same split lineage (the GC-S1C-5 successor
-- chain, traversed with _gcsc5_series_family). Occurrence ids and indexes are never changed.
--
-- Public RPCs (broad staff only, enforced here -- an assigned instructor gets GCSD2_UNAUTHORIZED):
--   preview_group_class_series_enrollment(appointment, client, billing_type, package, membership)
--   enroll_group_class_series_from(appointment, client, billing_type, package, membership, expected_count)
--   preview_group_class_series_removal(appointment, client)
--   remove_group_class_series_from(appointment, client, expected_count)
-- Each returns structured jsonb (outcome, per-class states, counts). Expected domain states (blocked, nothing to do,
-- changed since preview) are RESULTS, not exceptions; authority / shape problems raise a stable GCSD2_* code.
--
-- Enrollment rules (owner decisions D1/D2):
--   * Inherently non-enrollable occurrences are skipped and reported: cancelled, ended (past, or marked
--     attended / no_show) and any occurrence where THIS dancer has terminal attendance (attended / no_show).
--   * An occurrence where the dancer is already booked with the SAME funding is reported "already_enrolled" and left
--     alone (natural idempotency, no duplicate row). A booked row with DIFFERENT funding is never overwritten: it is a
--     structured "blocked_incompatible" refusal.
--   * Every other occurrence gets the real enrollment insert. Capacity, cancelled-class refusal, membership allowance
--     (cumulatively, so a finite membership cannot be over-committed by the batch) and funding-type policy are decided by
--     the SAME triggers / rules the single-class path uses, not by a parallel implementation. The attempts run inside one
--     savepoint: if ANY otherwise-enrollable class cannot be enrolled, the whole savepoint rolls back and NOTHING is
--     enrolled; the result names every affected class and why. Packages / pay-as-you-go / comped keep their per-class
--     semantics (nothing is reserved or consumed at enrollment); Decision #10 is untouched.
-- Removal rules: cancelled / ended / terminal-attendance occurrences are skipped and reported, occurrences where the
-- dancer is not booked are reported, every other booked row is cancelled. Attendance, credits, packages and
-- memberships are not touched, and the GC-S1D-1 guard trigger stays authoritative.
--
-- Lock order (series-first, like GC-S1C-4/5): anchor series FOR UPDATE (re-read once locked), every successor series in
-- chain order, the funding membership row (the single-class path also takes the membership before the class row), then
-- the target class rows in occurrence order. Attendee rows are written last. Preview takes no series lock and always
-- rolls back; apply re-derives everything under the locks and never trusts a preview. The optional expected_count lets
-- the UI refuse a stale preview ("changed") instead of applying a different count.
--
-- Rollback: rollback/20261021090000_gcsd2_series_enroll_remove_rollback.sql (drops the four RPCs and helpers).
-- Must run in BOTH DEV and PROD. Error codes (stable prefix): GCSD2_NOT_FOUND, GCSD2_UNAUTHORIZED,
-- GCSD2_NOT_A_SERIES_OCCURRENCE, GCSD2_CLIENT_NOT_FOUND, GCSD2_INVALID_FUNDING.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Internal: validate the request and return the studio id. No grants.
-- ----------------------------------------------------------------------------
create function public._gcsd2_check(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text,
  p_client_membership_id uuid,
  p_needs_funding boolean
)
returns uuid
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_studio uuid;
  v_series uuid;
begin
  select a.studio_id, a.group_class_series_id into v_studio, v_series
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSD2_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSD2_UNAUTHORIZED: Not authorized to manage the roster of a whole series.';
  end if;

  if not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = v_studio) then
    raise exception 'GCSD2_CLIENT_NOT_FOUND: Client not found for this studio.';
  end if;

  if v_series is null then
    raise exception 'GCSD2_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  if p_needs_funding then
    if p_billing_type not in ('package_credit', 'membership', 'pay_as_you_go', 'free_comped') then
      raise exception 'GCSD2_INVALID_FUNDING: Choose how to bill this enrollment.';
    end if;
    if p_billing_type = 'membership' and p_client_membership_id is null then
      raise exception 'GCSD2_INVALID_FUNDING: Select a specific membership.';
    end if;
  end if;

  return v_studio;
end;
$$;

revoke all on function public._gcsd2_check(uuid, uuid, text, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: the selected occurrence and every following occurrence across the successor lineage, classified for ONE
-- dancer. Ordered by occurrence index. No grants.
--   cancelled | ended | terminal (this dancer has attended / no_show) | booked (this dancer is booked) | open
-- ----------------------------------------------------------------------------
create function public._gcsd2_targets(p_anchor_id uuid, p_client_id uuid)
returns table (
  appointment_id uuid,
  occurrence_index integer,
  starts_at timestamptz,
  classification text,
  attendee_id uuid,
  att_billing_type text,
  att_package_id uuid,
  att_membership_id uuid
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.series_occurrence_index,
    a.starts_at,
    case
      when a.status = 'cancelled'::public.appointment_status then 'cancelled'
      when a.status in ('attended'::public.appointment_status, 'no_show'::public.appointment_status)
        or a.ends_at <= now() then 'ended'
      when exists (
        select 1 from public.attendance_records ar
        where ar.appointment_id = a.id and ar.client_id = p_client_id and ar.status in ('attended', 'no_show')
      ) then 'terminal'
      when b.id is not null then 'booked'
      else 'open'
    end,
    b.id,
    b.billing_type,
    b.client_package_id,
    b.client_membership_id
  from public.appointments anchor
  join lateral public._gcsc5_series_family(anchor.group_class_series_id) f on true
  join public.appointments a
    on a.group_class_series_id = f.series_id
   and a.appointment_type = 'group_class'::public.appointment_type
   and a.series_occurrence_index >= anchor.series_occurrence_index
  left join lateral (
    select aa.id, aa.billing_type, aa.client_package_id, aa.client_membership_id
    from public.appointment_attendees aa
    where aa.appointment_id = a.id and aa.client_id = p_client_id and aa.status = 'booked'
    limit 1
  ) b on true
  where anchor.id = p_anchor_id
  order by a.series_occurrence_index;
$$;

revoke all on function public._gcsd2_targets(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: series-first locking for apply. No grants.
-- ----------------------------------------------------------------------------
create function public._gcsd2_lock_series_and_targets(
  p_anchor_id uuid,
  p_client_id uuid,
  p_client_membership_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_now_series uuid;
  v_index integer;
  v_fam record;
  v_target record;
begin
  select a.group_class_series_id into v_series from public.appointments a where a.id = p_anchor_id;

  -- The class's series is read again once locked (a concurrent GC-S1C-5 split may have moved it into a successor).
  for i in 1..4 loop
    perform 1 from public.group_class_series s where s.id = v_series for update;
    select a.group_class_series_id into v_now_series from public.appointments a where a.id = p_anchor_id;
    exit when v_now_series = v_series;
    v_series := v_now_series;
  end loop;

  for v_fam in
    select f.series_id from public._gcsc5_series_family(v_series) f where f.depth > 0 order by f.depth
  loop
    perform 1 from public.group_class_series s where s.id = v_fam.series_id for update;
  end loop;

  -- The funding membership before any class row: the single-class enrollment path takes the same order.
  if p_client_membership_id is not null then
    perform 1 from public.client_memberships cm
      where cm.id = p_client_membership_id and cm.client_id = p_client_id for update;
  end if;

  select a.series_occurrence_index into v_index from public.appointments a where a.id = p_anchor_id;

  for v_target in
    select a.id
    from public._gcsc5_series_family(v_series) f
    join public.appointments a on a.group_class_series_id = f.series_id
    where a.appointment_type = 'group_class'::public.appointment_type
      and a.series_occurrence_index >= v_index
    order by a.series_occurrence_index
  loop
    perform 1 from public.appointments a where a.id = v_target.id for update;
  end loop;
end;
$$;

revoke all on function public._gcsd2_lock_series_and_targets(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: the enrollment run shared by preview (always rolled back) and apply. No grants. Locks, when needed,
-- were taken by the caller. Returns the structured result.
-- ----------------------------------------------------------------------------
create function public._gcsd2_enroll_run(
  p_anchor_id uuid,
  p_client_id uuid,
  p_billing_type text,
  p_client_package_id uuid,
  p_client_membership_id uuid,
  p_commit boolean,
  p_expected_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio uuid;
  v_series uuid;
  v_index integer;
  v_t record;
  v_classes jsonb := '[]'::jsonb;
  v_state text;
  v_policy text[];
  v_ftype text;
  v_msg text;
  v_will integer := 0;
  v_already integer := 0;
  v_failed boolean := false;
  v_mismatch boolean := false;
  v_counts jsonb;
  v_outcome text;
begin
  select a.studio_id, a.group_class_series_id, a.series_occurrence_index
    into v_studio, v_series, v_index
    from public.appointments a where a.id = p_anchor_id;

  begin
    for v_t in select * from public._gcsd2_targets(p_anchor_id, p_client_id) loop
      v_state := null;

      if v_t.classification = 'cancelled' then
        v_state := 'skipped_cancelled';
      elsif v_t.classification = 'ended' then
        v_state := 'skipped_ended';
      elsif v_t.classification = 'terminal' then
        v_state := 'skipped_terminal';
      elsif v_t.classification = 'booked' then
        if v_t.att_billing_type is not distinct from p_billing_type
           and v_t.att_package_id is not distinct from p_client_package_id
           and v_t.att_membership_id is not distinct from p_client_membership_id then
          v_state := 'already_enrolled';
          v_already := v_already + 1;
        else
          v_state := 'blocked_incompatible';
          v_failed := true;
        end if;
      else
        begin
          select pol.accepted_funding_types into v_policy
            from public.group_class_enrollment_policies pol
            where pol.appointment_id = v_t.appointment_id;

          if v_policy is not null then
            v_ftype := case p_billing_type
              when 'package_credit' then 'package'
              when 'membership' then 'membership'
              when 'pay_as_you_go' then 'direct_payment'
              when 'free_comped' then 'manual_other'
              else null
            end;
            if v_ftype is null or not (v_ftype = any (v_policy)) then
              raise exception 'GCSD2_FUNDING_POLICY';
            end if;
          end if;

          insert into public.appointment_attendees (
            studio_id, appointment_id, client_id, status, source,
            billing_type, client_package_id, client_membership_id, created_by
          )
          values (
            v_studio, v_t.appointment_id, p_client_id, 'booked', 'staff',
            p_billing_type, p_client_package_id, p_client_membership_id, auth.uid()
          );

          v_state := 'will_enroll';
          v_will := v_will + 1;
        exception when others then
          v_msg := sqlerrm;
          if v_msg like 'GCSC3_CLASS_CANCELLED%' then
            v_state := 'skipped_cancelled';
          else
            v_failed := true;
            v_state := case
              when v_msg like 'GCSD2_FUNDING_POLICY%' then 'blocked_funding_policy'
              when v_msg like '%no available seats%' then 'blocked_capacity'
              when v_msg like '%No allowance remaining%' then 'blocked_membership_allowance'
              when v_msg like '%does not belong to this client, or is not active%'
                or v_msg like '%no applicable group-class benefit%'
                or v_msg like '%requires a specific membership%'
                or v_msg like 'Invalid roster enrollment.%' then 'blocked_funding_invalid'
              else 'blocked_other'
            end;
          end if;
        end;
      end if;

      v_classes := v_classes || jsonb_build_object(
        'appointment_id', v_t.appointment_id,
        'occurrence_index', v_t.occurrence_index,
        'starts_at', v_t.starts_at,
        'state', v_state
      );
    end loop;

    v_mismatch := p_commit and not v_failed and p_expected_count is not null and p_expected_count <> v_will;

    -- All or nothing: any blocker, a stale preview, or a preview run undoes every attempted insert.
    if v_failed or v_mismatch or not p_commit then
      raise exception 'GCSD2_ROLLBACK';
    end if;
  exception when others then
    if sqlerrm <> 'GCSD2_ROLLBACK' then
      raise;
    end if;
  end;

  select coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb) into v_counts
    from (select e ->> 'state' as state, count(*) as n from jsonb_array_elements(v_classes) e group by 1) s;

  v_outcome := case
    when v_failed then 'blocked'
    when v_mismatch then 'changed'
    when v_will = 0 and v_already = 0 then 'no_eligible_targets'
    when v_will = 0 then 'noop'
    when p_commit then 'enrolled'
    else 'ready'
  end;

  return jsonb_build_object(
    'mode', case when p_commit then 'apply' else 'preview' end,
    'outcome', v_outcome,
    'series_id', v_series,
    'anchor_index', v_index,
    'client_id', p_client_id,
    'enrolled_count', case when v_outcome = 'enrolled' then v_will else 0 end,
    'counts', v_counts,
    'classes', v_classes
  );
end;
$$;

revoke all on function public._gcsd2_enroll_run(uuid, uuid, text, uuid, uuid, boolean, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: the removal run shared by preview and apply. No grants.
-- ----------------------------------------------------------------------------
create function public._gcsd2_remove_run(
  p_anchor_id uuid,
  p_client_id uuid,
  p_commit boolean,
  p_expected_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_index integer;
  v_t record;
  v_classes jsonb := '[]'::jsonb;
  v_state text;
  v_msg text;
  v_will integer := 0;
  v_failed boolean := false;
  v_mismatch boolean := false;
  v_counts jsonb;
  v_outcome text;
begin
  select a.group_class_series_id, a.series_occurrence_index into v_series, v_index
    from public.appointments a where a.id = p_anchor_id;

  begin
    for v_t in select * from public._gcsd2_targets(p_anchor_id, p_client_id) loop
      if v_t.classification = 'cancelled' then
        v_state := 'skipped_cancelled';
      elsif v_t.classification = 'ended' then
        v_state := 'skipped_ended';
      elsif v_t.classification = 'terminal' then
        v_state := 'skipped_terminal';
      elsif v_t.classification = 'open' then
        v_state := 'not_enrolled';
      elsif not p_commit then
        v_state := 'will_remove';
        v_will := v_will + 1;
      else
        begin
          update public.appointment_attendees
            set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
            where id = v_t.attendee_id and status = 'booked';
          v_state := 'will_remove';
          v_will := v_will + 1;
        exception when others then
          v_msg := sqlerrm;
          if v_msg like 'GCSD1_ATTENDEE_ATTENDANCE_RECORDED%' then
            -- terminal attendance was recorded after classification: the S1D-1 guard wins, the class is skipped
            v_state := 'skipped_terminal';
          else
            v_failed := true;
            v_state := 'blocked_other';
          end if;
        end;
      end if;

      v_classes := v_classes || jsonb_build_object(
        'appointment_id', v_t.appointment_id,
        'occurrence_index', v_t.occurrence_index,
        'starts_at', v_t.starts_at,
        'state', v_state
      );
    end loop;

    v_mismatch := p_commit and not v_failed and p_expected_count is not null and p_expected_count <> v_will;

    if v_failed or v_mismatch or not p_commit then
      raise exception 'GCSD2_ROLLBACK';
    end if;
  exception when others then
    if sqlerrm <> 'GCSD2_ROLLBACK' then
      raise;
    end if;
  end;

  select coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb) into v_counts
    from (select e ->> 'state' as state, count(*) as n from jsonb_array_elements(v_classes) e group by 1) s;

  v_outcome := case
    when v_failed then 'blocked'
    when v_mismatch then 'changed'
    when v_will = 0 then 'noop'
    when p_commit then 'removed'
    else 'ready'
  end;

  return jsonb_build_object(
    'mode', case when p_commit then 'apply' else 'preview' end,
    'outcome', v_outcome,
    'series_id', v_series,
    'anchor_index', v_index,
    'client_id', p_client_id,
    'removed_count', case when v_outcome = 'removed' then v_will else 0 end,
    'counts', v_counts,
    'classes', v_classes
  );
end;
$$;

revoke all on function public._gcsd2_remove_run(uuid, uuid, boolean, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Public RPCs
-- ----------------------------------------------------------------------------
create function public.preview_group_class_series_enrollment(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text default null,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_billing text := coalesce(p_billing_type, 'package_credit');
  v_package uuid;
  v_membership uuid;
begin
  perform public._gcsd2_check(p_appointment_id, p_client_id, v_billing, p_client_membership_id, true);

  v_package := case when v_billing = 'package_credit' then p_client_package_id else null end;
  v_membership := case when v_billing = 'membership' then p_client_membership_id else null end;

  return public._gcsd2_enroll_run(p_appointment_id, p_client_id, v_billing, v_package, v_membership, false, null);
end;
$$;

create function public.enroll_group_class_series_from(
  p_appointment_id uuid,
  p_client_id uuid,
  p_billing_type text default null,
  p_client_package_id uuid default null,
  p_client_membership_id uuid default null,
  p_expected_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_billing text := coalesce(p_billing_type, 'package_credit');
  v_package uuid;
  v_membership uuid;
begin
  perform public._gcsd2_check(p_appointment_id, p_client_id, v_billing, p_client_membership_id, true);

  v_package := case when v_billing = 'package_credit' then p_client_package_id else null end;
  v_membership := case when v_billing = 'membership' then p_client_membership_id else null end;

  perform public._gcsd2_lock_series_and_targets(p_appointment_id, p_client_id, v_membership);

  return public._gcsd2_enroll_run(p_appointment_id, p_client_id, v_billing, v_package, v_membership, true, p_expected_count);
end;
$$;

create function public.preview_group_class_series_removal(
  p_appointment_id uuid,
  p_client_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform public._gcsd2_check(p_appointment_id, p_client_id, null, null, false);

  return public._gcsd2_remove_run(p_appointment_id, p_client_id, false, null);
end;
$$;

create function public.remove_group_class_series_from(
  p_appointment_id uuid,
  p_client_id uuid,
  p_expected_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform public._gcsd2_check(p_appointment_id, p_client_id, null, null, false);

  perform public._gcsd2_lock_series_and_targets(p_appointment_id, p_client_id, null);

  return public._gcsd2_remove_run(p_appointment_id, p_client_id, true, p_expected_count);
end;
$$;

revoke all on function public.preview_group_class_series_enrollment(uuid, uuid, text, uuid, uuid) from public, anon, service_role;
revoke all on function public.enroll_group_class_series_from(uuid, uuid, text, uuid, uuid, integer) from public, anon, service_role;
revoke all on function public.preview_group_class_series_removal(uuid, uuid) from public, anon, service_role;
revoke all on function public.remove_group_class_series_from(uuid, uuid, integer) from public, anon, service_role;

grant execute on function public.preview_group_class_series_enrollment(uuid, uuid, text, uuid, uuid) to authenticated;
grant execute on function public.enroll_group_class_series_from(uuid, uuid, text, uuid, uuid, integer) to authenticated;
grant execute on function public.preview_group_class_series_removal(uuid, uuid) to authenticated;
grant execute on function public.remove_group_class_series_from(uuid, uuid, integer) to authenticated;

commit;
