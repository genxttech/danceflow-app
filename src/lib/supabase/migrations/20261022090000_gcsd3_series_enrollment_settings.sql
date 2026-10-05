-- ============================================================================
-- GC-S1D-3 -- series ("this and following classes") enrollment settings.
--
-- Function-only migration: no table, column, index, policy, trigger or data change at apply time. It applies the SAME
-- per-occurrence enrollment settings the single-class editor (GC-3.3) already manages -- the public-discovery switch, the
-- self-enrollment switch, and whether package and membership funding are accepted -- to the selected occurrence and the
-- following occurrences of the same split lineage (the GC-S1C-5 successor chain, traversed with _gcsc5_series_family), by
-- updating ordinary group_class_enrollment_policies rows. No second policy store, no customization-preservation model and no
-- override tracking (owner decision D4): a later class that differs is overwritten by design; earlier classes are never touched.
--
-- Managed settings (exactly the single-class editor's): publicly_discoverable, self_enrollment_allowed, and the "package" and
-- "membership" entries of accepted_funding_types. Every other value a class already carries (direct_payment, manual_other, and
-- direct_payment_amount) is preserved per class, exactly as the single-class editor preserves it. The series-level default
-- columns on group_class_series are creation-time data and are not read by any enrollment behavior; they are not changed.
--
-- Public RPCs (broad staff only, enforced here -- an assigned instructor gets GCSD3_UNAUTHORIZED, as for the policy table's
-- own row-level security):
--   preview_group_class_series_enrollment_settings(appointment, discoverable, self_enroll, package, membership)
--   apply_group_class_series_enrollment_settings(appointment, discoverable, self_enroll, package, membership, expected_count)
-- Each returns structured jsonb (outcome, per-class states, counts). Expected domain states are RESULTS, not exceptions;
-- authority / shape problems raise a stable GCSD3_* code.
--
-- Targets: cancelled and ended (past, or marked attended / no_show) occurrences are skipped and reported -- their enrollment
-- settings are no longer meaningful, and this is the same cancelled / ended classification the roster workflow uses. Every other
-- occurrence from the selected one onward is targeted. A skipped selected occurrence is reported as skipped; the anchor is never
-- shifted. A class that already matches is reported "matches" and not written. A class whose settings cannot be applied (the
-- database's own check, e.g. discovery or self-enrollment with no accepted funding type) blocks the whole operation.
--
-- Atomicity and preview: the updates are attempted inside one savepoint; any blocker, a stale expected count, or a preview run
-- rolls every attempted change back, so a blocked or previewed operation changes nothing. Apply re-derives the anchor, lineage,
-- targets, current state and authority under locks and never trusts a preview; expected_count only refuses a stale preview.
--
-- Lock order: reuses the GC-S1D-2 helper (anchor series FOR UPDATE re-read once locked, every successor series in chain order,
-- then the target class rows in occurrence order); policy rows are written last. Compatible with GC-S1C-4/5 and GC-S1D-2.
--
-- Rollback: rollback/20261022090000_gcsd3_series_enrollment_settings_rollback.sql (drops the five functions).
-- Must run in BOTH DEV and PROD. Requires the GC-S1D-2 migration (helper _gcsd2_lock_series_and_targets). Error codes (stable
-- prefix): GCSD3_NOT_FOUND, GCSD3_UNAUTHORIZED, GCSD3_NOT_A_SERIES_OCCURRENCE.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Internal: validate the request and return the studio id. No grants.
-- ----------------------------------------------------------------------------
create function public._gcsd3_check(p_appointment_id uuid)
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
    raise exception 'GCSD3_NOT_FOUND: Group class not found.';
  end if;

  if not public._gc1_4_has_broad_studio_authority(v_studio) then
    raise exception 'GCSD3_UNAUTHORIZED: Not authorized to change the enrollment settings of a whole series.';
  end if;

  if v_series is null then
    raise exception 'GCSD3_NOT_A_SERIES_OCCURRENCE: This class is not part of a series.';
  end if;

  return v_studio;
end;
$$;

revoke all on function public._gcsd3_check(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: the selected occurrence and every following occurrence across the successor lineage, with the current
-- enrollment settings of each. Ordered by occurrence index. No grants.
--   cancelled | ended | open
-- ----------------------------------------------------------------------------
create function public._gcsd3_targets(p_anchor_id uuid)
returns table (
  appointment_id uuid,
  occurrence_index integer,
  starts_at timestamptz,
  classification text,
  has_policy boolean,
  publicly_discoverable boolean,
  self_enrollment_allowed boolean,
  accepted_funding_types text[]
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
      else 'open'
    end,
    pol.id is not null,
    coalesce(pol.publicly_discoverable, false),
    coalesce(pol.self_enrollment_allowed, false),
    pol.accepted_funding_types
  from public.appointments anchor
  join lateral public._gcsc5_series_family(anchor.group_class_series_id) f on true
  join public.appointments a
    on a.group_class_series_id = f.series_id
   and a.appointment_type = 'group_class'::public.appointment_type
   and a.series_occurrence_index >= anchor.series_occurrence_index
  left join public.group_class_enrollment_policies pol on pol.appointment_id = a.id
  where anchor.id = p_anchor_id
  order by a.series_occurrence_index;
$$;

revoke all on function public._gcsd3_targets(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Internal: the run shared by preview (always rolled back) and apply. No grants. Locks, when needed, were taken by the
-- caller. Returns the structured result.
-- ----------------------------------------------------------------------------
create function public._gcsd3_run(
  p_anchor_id uuid,
  p_publicly_discoverable boolean,
  p_self_enrollment_allowed boolean,
  p_package_enabled boolean,
  p_membership_enabled boolean,
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
  v_preserved text[];
  v_new text[];
  v_matches boolean;
  v_changes integer := 0;
  v_same integer := 0;
  v_failed boolean := false;
  v_mismatch boolean := false;
  v_counts jsonb;
  v_outcome text;
  v_sqlstate text;
begin
  select a.studio_id, a.group_class_series_id, a.series_occurrence_index
    into v_studio, v_series, v_index
    from public.appointments a where a.id = p_anchor_id;

  begin
    for v_t in select * from public._gcsd3_targets(p_anchor_id) loop
      v_state := null;

      if v_t.classification = 'cancelled' then
        v_state := 'skipped_cancelled';
      elsif v_t.classification = 'ended' then
        v_state := 'skipped_ended';
      else
        v_preserved := coalesce(
          array(
            select x.val
            from unnest(coalesce(v_t.accepted_funding_types, array[]::text[])) with ordinality as x(val, ord)
            where x.val not in ('package', 'membership')
            order by x.ord
          ),
          array[]::text[]
        );
        v_new := v_preserved
          || case when p_package_enabled then array['package'] else array[]::text[] end
          || case when p_membership_enabled then array['membership'] else array[]::text[] end;
        if cardinality(v_new) = 0 then
          v_new := null;
        end if;

        if v_t.has_policy then
          v_matches := v_t.publicly_discoverable = p_publicly_discoverable
            and v_t.self_enrollment_allowed = p_self_enrollment_allowed
            and ('package' = any (coalesce(v_t.accepted_funding_types, array[]::text[]))) = p_package_enabled
            and ('membership' = any (coalesce(v_t.accepted_funding_types, array[]::text[]))) = p_membership_enabled;
        else
          v_matches := not p_publicly_discoverable and not p_self_enrollment_allowed
            and not p_package_enabled and not p_membership_enabled;
        end if;

        if v_matches then
          v_state := 'matches';
          v_same := v_same + 1;
        else
          begin
            if v_t.has_policy then
              update public.group_class_enrollment_policies
                set publicly_discoverable = p_publicly_discoverable,
                    self_enrollment_allowed = p_self_enrollment_allowed,
                    accepted_funding_types = v_new,
                    updated_at = now()
                where appointment_id = v_t.appointment_id;
            else
              insert into public.group_class_enrollment_policies (
                studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, created_by
              )
              values (v_studio, v_t.appointment_id, p_publicly_discoverable, p_self_enrollment_allowed, v_new, auth.uid());
            end if;
            v_state := 'will_change';
            v_changes := v_changes + 1;
          exception when others then
            get stacked diagnostics v_sqlstate = returned_sqlstate;
            v_failed := true;
            v_state := case when v_sqlstate = '23514' then 'blocked_requires_funding' else 'blocked_other' end;
          end;
        end if;
      end if;

      v_classes := v_classes || jsonb_build_object(
        'appointment_id', v_t.appointment_id,
        'occurrence_index', v_t.occurrence_index,
        'starts_at', v_t.starts_at,
        'state', v_state
      );
    end loop;

    v_mismatch := p_commit and not v_failed and p_expected_count is not null and p_expected_count <> v_changes;

    -- All or nothing: any blocker, a stale preview, or a preview run undoes every attempted change.
    if v_failed or v_mismatch or not p_commit then
      raise exception 'GCSD3_ROLLBACK';
    end if;
  exception when others then
    if sqlerrm <> 'GCSD3_ROLLBACK' then
      raise;
    end if;
  end;

  select coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb) into v_counts
    from (select e ->> 'state' as state, count(*) as n from jsonb_array_elements(v_classes) e group by 1) s;

  v_outcome := case
    when v_failed then 'blocked'
    when v_mismatch then 'changed'
    when v_changes = 0 and v_same = 0 then 'no_eligible_targets'
    when v_changes = 0 then 'noop'
    when p_commit then 'updated'
    else 'ready'
  end;

  return jsonb_build_object(
    'mode', case when p_commit then 'apply' else 'preview' end,
    'outcome', v_outcome,
    'series_id', v_series,
    'anchor_index', v_index,
    'updated_count', case when v_outcome = 'updated' then v_changes else 0 end,
    'counts', v_counts,
    'classes', v_classes
  );
end;
$$;

revoke all on function public._gcsd3_run(uuid, boolean, boolean, boolean, boolean, boolean, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Public RPCs
-- ----------------------------------------------------------------------------
create function public.preview_group_class_series_enrollment_settings(
  p_appointment_id uuid,
  p_publicly_discoverable boolean,
  p_self_enrollment_allowed boolean,
  p_package_enabled boolean,
  p_membership_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform public._gcsd3_check(p_appointment_id);

  return public._gcsd3_run(
    p_appointment_id,
    coalesce(p_publicly_discoverable, false), coalesce(p_self_enrollment_allowed, false),
    coalesce(p_package_enabled, false), coalesce(p_membership_enabled, false),
    false, null
  );
end;
$$;

create function public.apply_group_class_series_enrollment_settings(
  p_appointment_id uuid,
  p_publicly_discoverable boolean,
  p_self_enrollment_allowed boolean,
  p_package_enabled boolean,
  p_membership_enabled boolean,
  p_expected_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  perform public._gcsd3_check(p_appointment_id);

  -- Series-first locking (anchor series re-read once locked, successors in chain order, target class rows in order).
  perform public._gcsd2_lock_series_and_targets(p_appointment_id, null, null);

  return public._gcsd3_run(
    p_appointment_id,
    coalesce(p_publicly_discoverable, false), coalesce(p_self_enrollment_allowed, false),
    coalesce(p_package_enabled, false), coalesce(p_membership_enabled, false),
    true, p_expected_count
  );
end;
$$;

revoke all on function public.preview_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean) from public, anon, service_role;
revoke all on function public.apply_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean, integer) from public, anon, service_role;

grant execute on function public.preview_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.apply_group_class_series_enrollment_settings(uuid, boolean, boolean, boolean, boolean, integer) to authenticated;

commit;
