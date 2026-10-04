-- ============================================================================
-- GC-S1C-4 -- canonical group-class series cancellation + lifecycle authority.
--
-- 1. cancel_group_class_series_from(p_appointment_id) -> jsonb: "This and following
--    classes". One SECURITY DEFINER transaction, broad staff only (the same
--    authority helper the single-class RPC uses). The client supplies ONLY the
--    selected occurrence's id: the series, studio, occurrence index and every
--    "following" occurrence are derived from the database. It takes the series row
--    FOR UPDATE, then walks the occurrences in index order and cancels each eligible
--    one by calling the released cancel_group_class_appointment -- the ONE canonical
--    cancellation path (single-class and series cancellation cannot diverge; the S1C-2
--    terminal-attendance rule, the S1C-3 guards and the S1C-3 reminder cleanup all
--    apply unchanged). It never deletes, renumbers or edits anything else and never
--    touches credits, usage or attendance.
--      Eligibility (index >= the selected occurrence), decided per occurrence:
--        already_cancelled     status 'cancelled'                        -> idempotent, untouched
--        historical            status attended/no_show, or the class has ended -> preserved
--        terminal_attendance   a recorded attended/no_show record         -> preserved
--        eligible              everything else (not yet ended)            -> cancelled
--      An occurrence that gains terminal attendance between classification and its
--      cancellation is skipped (counted), not allowed to abort the operation.
--    The result carries the counts and, per affected client, ONLY that client's own
--    cancelled class start times, so the application can send one consolidated
--    notification per attendee after commit without exposing anyone else.
-- 2. Series status (stored 'active' | 'cancelled'; 'ended' stays derived and is never
--    stored): after the walk, if NO occurrence of the series remains upcoming and not
--    cancelled (counting preserved occurrences that are still upcoming), the series is
--    stored 'cancelled'. Cancelling only some later classes leaves it 'active'. A replay
--    changes nothing.
-- 3. preview_group_class_series_cancellation(p_appointment_id) -> jsonb: the same
--    classification, read-only, for the confirmation summary (classes and dancers
--    affected, and whether the series would end up cancelled).
-- 4. Reactivation closure: appointments_05_guard_group_class_reactivation refuses a
--    tenant-role UPDATE that moves a group class out of 'cancelled'
--    (GCSC4_CANCELLED_CLASS_REACTIVATION). There is no reactivation lifecycle; a new
--    class is created instead. Decided on current_user like the S1C-3 guards, so the
--    SECURITY DEFINER RPCs and service_role are unaffected. This also removes the only
--    route to the reminder-dedupe edge (a re-enrolled reactivated class).
--    Other direct tenant status moves (scheduled/confirmed/rescheduled among
--    themselves, attended/no_show) do not bypass the cancellation lifecycle or the
--    S1C-2 terminal-state invariant and are deliberately left as they are.
--
-- Error codes (messages begin with a stable code): GCSC4_NOT_FOUND, GCSC4_UNAUTHORIZED,
-- GCSC4_NOT_A_SERIES_OCCURRENCE, GCSC4_CANCELLED_CLASS_REACTIVATION.
-- Grants: the two RPCs to authenticated only; the helper and guard are internal.
--
-- Rollback: rollback/20261018090000_gcsc4_series_cancellation_lifecycle_rollback.sql
-- Must run in BOTH DEV and PROD.
-- ============================================================================

begin;

-- ============================================================================
-- Internal: classify every occurrence of a series from a given index. No grants.
-- ============================================================================
create function public._gcsc4_series_cancel_targets(p_series_id uuid, p_from_index integer)
returns table (
  appointment_id uuid,
  occurrence_index integer,
  starts_at timestamptz,
  classification text,
  booked_count integer
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
      when a.status = 'cancelled'::public.appointment_status then 'already_cancelled'
      when a.status in ('attended'::public.appointment_status, 'no_show'::public.appointment_status)
        or a.ends_at <= now() then 'historical'
      when exists (
        select 1 from public.attendance_records ar
        where ar.appointment_id = a.id and ar.status in ('attended', 'no_show')
      ) then 'terminal_attendance'
      else 'eligible'
    end,
    (select count(*)::integer from public.appointment_attendees aa
      where aa.appointment_id = a.id and aa.status = 'booked')
  from public.appointments a
  where a.group_class_series_id = p_series_id
    and a.appointment_type = 'group_class'::public.appointment_type
    and a.series_occurrence_index >= p_from_index
  order by a.series_occurrence_index;
$$;

revoke all on function public._gcsc4_series_cancel_targets(uuid, integer) from public, anon, authenticated, service_role;

-- ============================================================================
-- Internal: occurrences of the series that would still be upcoming and not cancelled
-- after cancelling from p_from_index (earlier upcoming classes, plus preserved
-- later ones that still lie ahead). Zero means the remaining series is cancelled.
-- ============================================================================
create function public._gcsc4_series_remaining_after(p_series_id uuid, p_from_index integer)
returns integer
language sql
stable
security definer
set search_path = 'public'
as $$
  select count(*)::integer
  from public.appointments a
  where a.group_class_series_id = p_series_id
    and a.appointment_type = 'group_class'::public.appointment_type
    and a.status not in ('cancelled'::public.appointment_status, 'attended'::public.appointment_status, 'no_show'::public.appointment_status)
    and a.ends_at > now()
    and (
      a.series_occurrence_index < p_from_index
      or exists (
        select 1 from public.attendance_records ar
        where ar.appointment_id = a.id and ar.status in ('attended', 'no_show')
      )
    );
$$;

revoke all on function public._gcsc4_series_remaining_after(uuid, integer) from public, anon, authenticated, service_role;

-- ============================================================================
-- Preview (read-only, broad staff)
-- ============================================================================
create function public.preview_group_class_series_cancellation(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_index integer;
  v_studio uuid;
  v_result jsonb;
begin
  select a.group_class_series_id, a.series_occurrence_index, a.studio_id
    into v_series, v_index, v_studio
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSC4_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSC4_UNAUTHORIZED: Not authorized to cancel classes in this series.';
  end if;

  if v_series is null then
    raise exception 'GCSC4_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  select jsonb_build_object(
    'series_id', v_series,
    'occurrence_index', v_index,
    'eligible_class_count', count(*) filter (where t.classification = 'eligible'),
    'enrollments_affected', coalesce(sum(t.booked_count) filter (where t.classification = 'eligible'), 0),
    'dancers_affected', (
      select count(distinct aa.client_id)
      from public._gcsc4_series_cancel_targets(v_series, v_index) t2
      join public.appointment_attendees aa on aa.appointment_id = t2.appointment_id and aa.status = 'booked'
      where t2.classification = 'eligible'
    ),
    'already_cancelled_count', count(*) filter (where t.classification = 'already_cancelled'),
    'historical_count', count(*) filter (where t.classification = 'historical'),
    'terminal_attendance_count', count(*) filter (where t.classification = 'terminal_attendance'),
    'series_would_be_cancelled', public._gcsc4_series_remaining_after(v_series, v_index) = 0
  )
  into v_result
  from public._gcsc4_series_cancel_targets(v_series, v_index) t;

  return v_result;
end;
$$;

revoke all on function public.preview_group_class_series_cancellation(uuid) from public;
revoke all on function public.preview_group_class_series_cancellation(uuid) from anon;
grant execute on function public.preview_group_class_series_cancellation(uuid) to authenticated;
revoke all on function public.preview_group_class_series_cancellation(uuid) from service_role;

-- ============================================================================
-- "This and following classes"
-- ============================================================================
create function public.cancel_group_class_series_from(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_series uuid;
  v_index integer;
  v_studio uuid;
  v_target record;
  v_current public.appointment_status;
  v_ids uuid[];
  v_cancelled integer := 0;
  v_enrollments integer := 0;
  v_already integer := 0;
  v_historical integer := 0;
  v_terminal integer := 0;
  v_by_client jsonb := '{}'::jsonb;
  v_client uuid;
  v_remaining integer;
  v_series_cancelled boolean := false;
  v_status text;
begin
  select a.group_class_series_id, a.series_occurrence_index, a.studio_id
    into v_series, v_index, v_studio
    from public.appointments a
    where a.id = p_appointment_id
      and a.appointment_type = 'group_class'::public.appointment_type;

  if v_studio is null then
    raise exception 'GCSC4_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSC4_UNAUTHORIZED: Not authorized to cancel classes in this series.';
  end if;

  if v_series is null then
    raise exception 'GCSC4_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  -- Serialize concurrent series operations first; occurrences are then locked one at a time in
  -- index order (inside the canonical single-class RPC), so no lock-order cycle exists.
  perform 1 from public.group_class_series s where s.id = v_series for update;

  for v_target in
    select * from public._gcsc4_series_cancel_targets(v_series, v_index)
  loop
    if v_target.classification = 'already_cancelled' then
      v_already := v_already + 1;
    elsif v_target.classification = 'historical' then
      v_historical := v_historical + 1;
    elsif v_target.classification = 'terminal_attendance' then
      v_terminal := v_terminal + 1;
    else
      -- re-read under the occurrence lock: a concurrent cancellation may have won
      select a.status into v_current
        from public.appointments a where a.id = v_target.appointment_id for update;

      if v_current = 'cancelled'::public.appointment_status then
        v_already := v_already + 1;
      else
        begin
          v_ids := public.cancel_group_class_appointment(v_target.appointment_id);
          v_cancelled := v_cancelled + 1;
          v_enrollments := v_enrollments + coalesce(cardinality(v_ids), 0);

          foreach v_client in array coalesce(v_ids, array[]::uuid[]) loop
            v_by_client := jsonb_set(
              v_by_client,
              array[v_client::text],
              coalesce(v_by_client -> v_client::text, '[]'::jsonb) || to_jsonb(v_target.starts_at),
              true
            );
          end loop;
        exception when raise_exception then
          -- attendance recorded between classification and cancellation: preserved, not fatal
          if position('GCSC2_ATTENDANCE_RECORDED' in sqlerrm) = 1 then
            v_terminal := v_terminal + 1;
          else
            raise;
          end if;
        end;
      end if;
    end if;
  end loop;

  v_remaining := public._gcsc4_series_remaining_after(v_series, v_index);

  if v_remaining = 0 then
    update public.group_class_series
       set status = 'cancelled'
     where id = v_series and status = 'active';
    v_series_cancelled := found;
  end if;

  select s.status into v_status from public.group_class_series s where s.id = v_series;

  return jsonb_build_object(
    'series_id', v_series,
    'studio_id', v_studio,
    'occurrence_index', v_index,
    'cancelled_class_count', v_cancelled,
    'enrollments_cancelled', v_enrollments,
    'already_cancelled_count', v_already,
    'historical_count', v_historical,
    'terminal_attendance_count', v_terminal,
    'series_status', v_status,
    'series_cancelled_by_this_call', v_series_cancelled,
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('client_id', e.key, 'class_starts', e.value) order by e.key)
      from jsonb_each(v_by_client) e
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.cancel_group_class_series_from(uuid) from public;
revoke all on function public.cancel_group_class_series_from(uuid) from anon;
grant execute on function public.cancel_group_class_series_from(uuid) to authenticated;
revoke all on function public.cancel_group_class_series_from(uuid) from service_role;

-- ============================================================================
-- Reactivation closure (tenant roles may not reopen a cancelled group class)
-- ============================================================================
create function public._gcsc4_guard_group_class_reactivation()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'GCSC4_CANCELLED_CLASS_REACTIVATION: A cancelled class cannot be reopened. Create a new class instead.';
  end if;

  return new;
end;
$$;

revoke all on function public._gcsc4_guard_group_class_reactivation() from public, anon, authenticated, service_role;

create trigger appointments_05_guard_group_class_reactivation
  before update of status on public.appointments
  for each row
  when (new.appointment_type = 'group_class'::public.appointment_type
        and old.status = 'cancelled'::public.appointment_status
        and new.status is distinct from 'cancelled'::public.appointment_status)
  execute function public._gcsc4_guard_group_class_reactivation();

commit;
