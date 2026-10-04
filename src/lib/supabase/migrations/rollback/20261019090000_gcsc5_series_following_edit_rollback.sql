-- Rollback for 20261019090000_gcsc5_series_following_edit.sql.
-- Restores the released GC-S1C-4 bodies of preview_group_class_series_cancellation and
-- cancel_group_class_series_from, drops the GC-S1C-5 RPCs, helpers, idempotency ledger and the
-- split_from_series_id lineage column. It REFUSES to run once any successor series or edit
-- request exists (dropping the lineage or ledger then would discard data): in that case decide
-- explicitly how to treat the split series first. Roll the application back first.

begin;

do $$
begin
  if exists (select 1 from public.group_class_series where split_from_series_id is not null) then
    raise exception 'GCSC5 rollback refused: successor series exist (split_from_series_id is in use).';
  end if;
  if exists (select 1 from public.group_class_series_edit_requests) then
    raise exception 'GCSC5 rollback refused: series edit requests exist.';
  end if;
end;
$$;

create or replace function public.preview_group_class_series_cancellation(p_appointment_id uuid)
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

create or replace function public.cancel_group_class_series_from(p_appointment_id uuid)
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

drop function if exists public.edit_group_class_series_from(uuid, uuid, jsonb, boolean);
drop function if exists public.preview_group_class_series_edit(uuid, jsonb, boolean);
drop function if exists public._gcsc5_edit_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz);
drop function if exists public._gcsc5_edit_plan(uuid, jsonb, boolean);
drop function if exists public._gcsc5_validate_changes(uuid, jsonb);
drop function if exists public._gcsc5_edit_groups(jsonb);
drop function if exists public._gcsc5_series_family(uuid);

drop table if exists public.group_class_series_edit_requests;

drop index if exists public.uq_group_class_series_split_from;
alter table public.group_class_series drop constraint if exists group_class_series_split_not_self;
alter table public.group_class_series drop constraint if exists group_class_series_split_from_fk;
alter table public.group_class_series drop column if exists split_from_series_id;

commit;
