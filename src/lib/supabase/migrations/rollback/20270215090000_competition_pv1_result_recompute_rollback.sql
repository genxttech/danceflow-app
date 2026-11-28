-- Rollback for 20270215090000_competition_pv1_result_recompute.sql (PV-1).
-- Restores the exact pinned pre-PV-1 text of calculate_competition_round (md5 bc3cc439...) by removing the verify call, verifying that the
-- installed text still is the post-PV-1 text (md5 167529ba...), then drops the PV-1 functions. Stored results are not touched.
-- Order: app first (the app needs no PV-1 object; it only maps the two codes), then this file.

begin;

do $$
declare
  v_sig constant text := 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)';
  v_pre constant text := 'bc3cc4397e740444a4d4a53d93b499cc';
  v_post constant text := '167529bada8ca5a4dd98e22d4d0a3252';
  v_old constant text := $o$  select coalesce(max(v.version), 0) + 1 into v_next from public.event_competition_result_versions v where v.round_id = p_round_id;$o$;
  v_new constant text := $n$  -- PV-1 (owner decision 2026-11-10): the database recomputes the result from its own evidence (the same document the input hash covers) and
  -- refuses rows, placements, advancement, tie status or warnings that differ from its own calculation. Fingerprints alone are not proof.
  perform public._comppv1_verify(v_evidence, p_rows, v_warnings);

  select coalesce(max(v.version), 0) + 1 into v_next from public.event_competition_result_versions v where v.round_id = p_round_id;$n$;
  v_def text;
begin
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '');
  if md5(v_def) <> v_post then
    raise exception 'PV-1 rollback refused: % is not the post-PV-1 text (md5 %, expected %); it changed since PV-1.', v_sig, md5(v_def), v_post;
  end if;
  if (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new) <> 1 then
    raise exception 'PV-1 rollback refused: % does not hold the PV-1 text exactly once.', v_sig;
  end if;
  v_def := replace(v_def, v_new, v_old);
  if md5(v_def) <> v_pre then
    raise exception 'PV-1 rollback refused: restored % does not match the pinned pre-PV-1 text.', v_sig;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_pre then
    raise exception 'PV-1 rollback: installed text of % does not match the pinned pre-PV-1 md5 after restore.', v_sig;
  end if;
end $$;

-- Restore approve_competition_round_result (reverse of the PV-1 insert). Original note: re-verify the stored version at approval (security review P2: a version stored before PV-1, or any stored
-- version, is approved only if it equals the database's own calculation). Exact-fragment insert after the input-hash check, md5 pinned.
do $$
declare
  v_sig constant text := 'public.approve_competition_round_result(uuid,uuid,text,uuid)';
  v_pre constant text := 'ac33e456925e64665db1ea0547bae18b';
  v_post constant text := '3cf63c3bb00a78142ea2c8e70a8b4a0c';
  v_old constant text := $o$    raise exception 'COMP_RESULT_STALE: the ballots changed after this calculation; recalculate before approving.' using errcode = 'P0001';
  end if;
$o$;
  v_new constant text := $n$    raise exception 'COMP_RESULT_STALE: the ballots changed after this calculation; recalculate before approving.' using errcode = 'P0001';
  end if;
  -- PV-1 (owner decision 2026-11-10): re-verify the stored rows and warnings against the database's own calculation of the stored evidence
  -- (the input hash above proves that evidence is still current). Also covers any version stored before PV-1.
  perform public._comppv1_verify(v_ver.input,
    (select coalesce(jsonb_agg(jsonb_build_object('entry_id', rr.entry_id, 'placement', rr.placement, 'tie_group', rr.tie_group, 'advanced', rr.advanced,
                                                  'rating_band', rr.rating_band, 'output', rr.output)), '[]'::jsonb)
     from public.event_competition_result_rows rr where rr.result_version_id = v_ver.id),
    v_ver.warnings);
$n$;
  v_def text;
begin
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '');
  if md5(v_def) <> v_post then
    raise exception 'PV-1 rollback refused: % is not the post-PV-1 text (md5 %, expected %).', v_sig, md5(v_def), v_post;
  end if;
  if (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new) <> 1 then
    raise exception 'PV-1 rollback refused: % does not hold the PV-1 approve text exactly once.', v_sig;
  end if;
  v_def := replace(v_def, v_new, v_old);
  if md5(v_def) <> v_pre then
    raise exception 'PV-1 rollback refused: restored % does not match the pinned pre-PV-1 text.', v_sig;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_pre then
    raise exception 'PV-1 rollback: installed text of % does not match the pinned pre-PV-1 md5 after restore.', v_sig;
  end if;
end $$;

drop function public._comppv1_verify(jsonb, jsonb, jsonb);
drop function public._comppv1_run(text, jsonb);
drop function public._comppv1_ordinal(jsonb);
drop function public._comppv1_callback(jsonb);
drop function public._comppv1_panel(jsonb, jsonb);
drop function public._comppv1_prefix(jsonb);
drop function public._comppv1_caps(jsonb);
drop function public._comppv1_fail(text);
drop function public._comppv1_is_int(jsonb);
drop function public._comppv1_truthy(jsonb);

do $$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_comppv1\_%') then
    raise exception 'PV-1 rollback: PV-1 functions remain.';
  end if;
end $$;

commit;
