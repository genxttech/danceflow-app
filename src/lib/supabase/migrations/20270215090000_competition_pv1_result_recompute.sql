-- 20270215090000_competition_pv1_result_recompute.sql
-- PV-1 (owner decision 2026-11-10): the database independently recomputes every competition result before it is stored.
--
-- Gap closed: calculate_competition_round (F2 20270114090000, A3-patched) is SECURITY DEFINER, granted to authenticated, and stored the
-- caller-supplied p_rows after checking only the evidence hash, the trace hash and the row shape. A manager or assigned scorer could call it
-- through PostgREST with fabricated placements. Fingerprint comparison is not proof of placements.
--
-- This file (additive, one transaction):
--   1. A plpgsql port of the two approved Studio engines, pure over the evidence document (_compf2_evidence), with the same checks in the
--      same order, the same rows and the same warnings as the TypeScript engines (engines/studioCallbackTally.ts, studioOrdinalMajority.ts,
--      common.ts): studio_callback_tally@1 (D-CT-1..10, unresolved tie at the cut over capacity) and studio_ordinal_majority@1 (OM-A,
--      approved tie chain: more judges <= cutoff, lower ordinal sum, shared placement), X-1..X-7, OD-F1-1/2/3 (profile allow-list,
--      entry_heat_coverage, input caps). No table is read or written and no session object is used, so a caller cannot influence it.
--   2. _comppv1_verify(evidence, rows, warnings): refuses COMP_RESULT_RECOMPUTE_UNSUPPORTED when the pinned engine has no SQL port or the
--      port itself refuses the round (fail closed), and COMP_RESULT_RECOMPUTE_MISMATCH when the caller's rows (entry set, placement, tie
--      group, advanced flag, rating band, output incl. tie_status) or warnings differ from the database's own result.
--   4. approve_competition_round_result re-verifies the stored rows of the version it approves (security review P2), same pinning.
--   3. calculate_competition_round redefined by exact-fragment insert (md5 pinned before and after, as F2/HL1/A3 did): the verify call runs
--      after the existing row-shape checks, before any write. The replay branch is unchanged (a replay re-sends identical, already verified rows).
-- Equivalence evidence: every golden fixture of the F1/F2 suites and a seeded random corpus agree with the TypeScript engines (docs/qa).
-- Rollback: rollback/20270215090000_competition_pv1_result_recompute_rollback.sql (restores the pinned pre-PV-1 text, drops the new functions).
-- Order: SQL before app (the app only maps the two new codes to plain messages; it works unchanged against this SQL).

begin;

do $$
begin
  if to_regprocedure('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)') is null
     or to_regprocedure('public._compf2_evidence(uuid,text,text)') is null then
    raise exception 'PV-1 preflight: F2 results lifecycle is missing.';
  end if;
  if md5(replace(pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure), E'\r', ''))
     <> 'bc3cc4397e740444a4d4a53d93b499cc' then
    raise exception 'PV-1 preflight: calculate_competition_round is not the pinned post-A3 text (bc3cc439...); coordinate before changing it.';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_comppv1\_%') then
    raise exception 'PV-1 preflight: PV-1 functions already exist (roll back or clean up a partial earlier run first).';
  end if;
end $$;

create function public._comppv1_truthy(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  -- JavaScript truthiness of a JSON value (false for absent, null, false, 0 and "").
  select case
    when p is null or jsonb_typeof(p) = 'null' then false
    when jsonb_typeof(p) = 'boolean' then p::text::boolean
    when jsonb_typeof(p) = 'number' then (p::text)::numeric <> 0
    when jsonb_typeof(p) = 'string' then (p #>> '{}') <> ''
    else true end;
$$;

create function public._comppv1_is_int(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  -- JavaScript: typeof v === "number" && Number.isInteger(v)
  select p is not null and jsonb_typeof(p) = 'number' and (p::text)::numeric = trunc((p::text)::numeric);
$$;

create function public._comppv1_fail(p_reason text) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'reason', p_reason);
$$;

-- Input caps (engines/common.ts ENGINE_INPUT_CAPS), checked before anything else. Returns null when the input passes.
create function public._comppv1_caps(p_ev jsonb) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_h jsonb;
  v_total integer := 0;
begin
  if jsonb_typeof(p_ev -> 'entries') is distinct from 'array' or jsonb_typeof(p_ev -> 'judges') is distinct from 'array'
     or jsonb_typeof(p_ev -> 'marks') is distinct from 'array' or jsonb_typeof(p_ev -> 'tieBreakChain') is distinct from 'array'
     or jsonb_typeof(p_ev -> 'excludedEntries') is distinct from 'array' or jsonb_typeof(p_ev -> 'heats') is distinct from 'array'
     or jsonb_typeof(p_ev -> 'danceIds') is distinct from 'array' then
    return 'malformed_input';
  end if;
  if jsonb_array_length(p_ev -> 'entries') > 1000 or jsonb_array_length(p_ev -> 'judges') > 25 or jsonb_array_length(p_ev -> 'marks') > 50000
     or jsonb_array_length(p_ev -> 'tieBreakChain') > 32 or jsonb_array_length(p_ev -> 'excludedEntries') > 1000
     or jsonb_array_length(p_ev -> 'heats') > 500 or jsonb_array_length(p_ev -> 'danceIds') > 50 then
    return 'input_too_large';
  end if;
  for v_h in select * from jsonb_array_elements(p_ev -> 'heats') loop
    if jsonb_typeof(v_h -> 'officialIds') is distinct from 'array' or jsonb_typeof(v_h -> 'entryIds') is distinct from 'array' then
      return 'malformed_input';
    end if;
    if jsonb_array_length(v_h -> 'officialIds') > 25 or jsonb_array_length(v_h -> 'entryIds') > 1000 then
      return 'input_too_large';
    end if;
    v_total := v_total + jsonb_array_length(v_h -> 'entryIds');
  end loop;
  if v_total > 2000 then
    return 'input_too_large';
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'entries') e where jsonb_typeof(e -> 'entryId') = 'string' and length(e ->> 'entryId') > 200)
     or exists (select 1 from jsonb_array_elements(p_ev -> 'judges') j where jsonb_typeof(j -> 'officialId') = 'string' and length(j ->> 'officialId') > 200)
     or exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m
                where (jsonb_typeof(m -> 'officialId') = 'string' and length(m ->> 'officialId') > 200)
                   or (jsonb_typeof(m -> 'entryId') = 'string' and length(m ->> 'entryId') > 200)) then
    return 'input_too_large';
  end if;
  return null;
end;
$$;

-- checkProfileAndTieChain + splitEntries + orderedJudges (shared prefix of both engines after the round-type check).
-- Returns {ok:false, reason} or {ok:true, all:[...], calculated:[...], excluded:[...], judges:[{officialId, letter}] ordered by letter, officialId}.
create function public._comppv1_prefix(p_ev jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_all text[];
  v_ex text[];
  v_p jsonb := p_ev -> 'profile';
begin
  if jsonb_array_length(p_ev -> 'tieBreakChain') > 0 then
    return public._comppv1_fail('tie_break_chain_unsupported');
  end if;
  if v_p is null or jsonb_typeof(v_p) <> 'object' or (v_p -> 'key') is distinct from '"studio_simple"'::jsonb
     or jsonb_typeof(v_p -> 'version') is distinct from 'number' or (v_p ->> 'version')::numeric not in (1, 3) then
    return public._comppv1_fail('profile_unsupported');
  end if;
  select coalesce(array_agg(e ->> 'entryId'), '{}') into v_all from jsonb_array_elements(p_ev -> 'entries') e;
  if (select count(distinct x) from unnest(v_all) x) <> cardinality(v_all) then
    return public._comppv1_fail('duplicate_entry');
  end if;
  select coalesce(array_agg(e ->> 'entryId'), '{}') into v_ex from jsonb_array_elements(p_ev -> 'excludedEntries') e;
  if (select count(distinct x) from unnest(v_ex) x) <> cardinality(v_ex) then
    return public._comppv1_fail('duplicate_excluded_entry');
  end if;
  if exists (select 1 from unnest(v_ex) x where not (x = any (v_all))) then
    return public._comppv1_fail('excluded_entry_not_in_round');
  end if;
  if (select count(distinct j ->> 'officialId') from jsonb_array_elements(p_ev -> 'judges') j) <> jsonb_array_length(p_ev -> 'judges')
     or (select count(distinct j ->> 'letter') from jsonb_array_elements(p_ev -> 'judges') j) <> jsonb_array_length(p_ev -> 'judges') then
    return public._comppv1_fail('duplicate_judge');
  end if;
  return jsonb_build_object(
    'ok', true,
    'all', coalesce((select jsonb_agg(x order by x collate "C") from unnest(v_all) x), '[]'::jsonb),
    'excluded', coalesce((select jsonb_agg(x order by x collate "C") from unnest(v_ex) x), '[]'::jsonb),
    'calculated', coalesce((select jsonb_agg(x order by x collate "C") from unnest(v_all) x where not (x = any (v_ex))), '[]'::jsonb),
    'judges', coalesce((select jsonb_agg(jsonb_build_object('officialId', j ->> 'officialId', 'letter', j ->> 'letter')
                                          order by (j ->> 'letter') collate "C", (j ->> 'officialId') collate "C")
                        from jsonb_array_elements(p_ev -> 'judges') j), '[]'::jsonb));
end;
$$;

-- checkPanelStructure (X-3 flags, X-3 panel size, X-7 heats/panels/coverage, X-6 one dance). Returns {ok:false, reason} or {ok:true, warnings:[...]}.
create function public._comppv1_panel(p_ev jsonb, p_pre jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_panel text[];
  v_n integer;
begin
  if public._comppv1_truthy(p_ev -> 'chiefJudgeTiebreak') or public._comppv1_truthy(p_ev -> 'scoreRolesSeparately') then
    return public._comppv1_fail('x3_option_unsupported');
  end if;
  v_n := jsonb_array_length(p_pre -> 'judges');
  if v_n < 3 or v_n % 2 = 0 then
    return public._comppv1_fail('panel_size');
  end if;
  select array_agg(j ->> 'officialId' order by (j ->> 'officialId') collate "C") into v_panel from jsonb_array_elements(p_pre -> 'judges') j;
  if jsonb_array_length(p_ev -> 'heats') = 0 then
    return public._comppv1_fail('heat_panels_missing');
  end if;
  if (select count(distinct h ->> 'heatId') from jsonb_array_elements(p_ev -> 'heats') h) <> jsonb_array_length(p_ev -> 'heats') then
    return public._comppv1_fail('duplicate_heat');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'heats') h, jsonb_array_elements_text(h -> 'entryIds') x
             where not (p_pre -> 'all') ? x) then
    return public._comppv1_fail('heat_entry_not_in_round');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'heats') h
             where coalesce((select array_agg(o order by o collate "C") from jsonb_array_elements_text(h -> 'officialIds') o), '{}') is distinct from v_panel) then
    return public._comppv1_fail('heat_panel_mismatch');
  end if;
  if jsonb_array_length(p_ev -> 'danceIds') <> 1 then
    return public._comppv1_fail('multi_dance_unsupported');
  end if;
  -- Every calculated entry is in exactly one heat (in two heats, twice in one heat, or in none fails); excluded entries may stay on rosters.
  if exists (
       select 1 from (select x, count(distinct h ->> 'heatId') n
                      from jsonb_array_elements(p_ev -> 'heats') h, jsonb_array_elements_text(h -> 'entryIds') x group by x) c
       where c.n > 1 and not (p_pre -> 'excluded') ? c.x)
     or exists (
       select 1 from jsonb_array_elements(p_ev -> 'heats') h, lateral (
         select x from jsonb_array_elements_text(h -> 'entryIds') x group by x having count(*) > 1) d
       where not (p_pre -> 'excluded') ? d.x)
     or exists (
       select 1 from jsonb_array_elements_text(p_pre -> 'calculated') x
       where not exists (select 1 from jsonb_array_elements(p_ev -> 'heats') h where (h -> 'entryIds') ? x)) then
    return public._comppv1_fail('entry_heat_coverage');
  end if;
  return jsonb_build_object('ok', true, 'warnings', coalesce((
    select jsonb_agg(w order by w collate "C") from (
      select 'excluded_entry_in_multiple_heats:' || x || '@' || string_agg(hid, '+' order by hid collate "C") w
      from (select distinct h ->> 'heatId' hid, x from jsonb_array_elements(p_ev -> 'heats') h, jsonb_array_elements_text(h -> 'entryIds') x) s
      where (p_pre -> 'excluded') ? x
      group by x having count(*) > 1) t), '[]'::jsonb));
end;
$$;

-- studio_callback_tally@1 (engine-spec-callback-tally.md; engines/studioCallbackTally.ts). Same checks in the same order, same rows and warnings.
create function public._comppv1_callback(p_ev jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_pre jsonb;
  v_pan jsonb;
  v_t jsonb := p_ev #> '{round,targetAdvancementCount}';
  v_target integer;
  v_s jsonb := p_ev -> 'markScheme';
  v_calc text[];
  v_e integer;
  v_warn text[] := '{}';
  v_cut integer;
  v_above integer;
  v_cap jsonb := p_ev -> 'finalCapacity';
  v_cap_ok boolean;
  v_rows jsonb;
  v_tab jsonb;
begin
  if regexp_replace(coalesce(p_ev ->> 'engineKey', ''), '^studio_', '') <> 'callback_tally' or (p_ev ->> 'engineVersion') is distinct from '1' then
    return public._comppv1_fail('engine_not_available');
  end if;
  if (p_ev #> '{round,roundType}') is distinct from '"preliminary"'::jsonb or (p_ev #> '{round,advancementMethod}') is distinct from '"promote_callback"'::jsonb then
    return public._comppv1_fail('round_not_callback');
  end if;
  v_pre := public._comppv1_prefix(p_ev);
  if not (v_pre ->> 'ok')::boolean then return v_pre; end if;
  if v_t is null or jsonb_typeof(v_t) = 'null' then
    return public._comppv1_fail('target_unset');
  end if;
  if not public._comppv1_is_int(v_t) or (v_t::text)::numeric < 1 then
    return public._comppv1_fail('target_invalid');
  end if;
  v_target := (v_t::text)::numeric::integer;
  if v_s is not null and jsonb_typeof(v_s) <> 'null' then
    if jsonb_typeof(v_s) <> 'object' or ((v_s ? 'scored_by') and (v_s -> 'scored_by') is distinct from '"entry"'::jsonb)
       or ((v_s ? 'input') and (v_s -> 'input') is distinct from '"callback_yes"'::jsonb) then
      return public._comppv1_fail('scheme_unspecified');
    end if;
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where (m ? 'role') and jsonb_typeof(m -> 'role') <> 'null') then
    return public._comppv1_fail('role_marks_not_supported');
  end if;
  if jsonb_array_length(p_ev -> 'danceIds') <> 1 then
    return public._comppv1_fail('multi_dance_unsupported');
  end if;
  if public._comppv1_truthy(p_ev -> 'chiefJudgeTiebreak') or public._comppv1_truthy(p_ev -> 'scoreRolesSeparately') then
    return public._comppv1_fail('x3_option_unsupported');
  end if;
  select coalesce(array_agg(x order by x collate "C"), '{}') into v_calc from jsonb_array_elements_text(v_pre -> 'calculated') x;
  v_e := cardinality(v_calc);
  if v_e = 0 then
    return public._comppv1_fail('no_eligible_entries');
  end if;
  if jsonb_array_length(v_pre -> 'excluded') > 0 then
    v_warn := v_warn || ('excluded_entries:' || (select string_agg(x, ',' order by x collate "C") from jsonb_array_elements_text(v_pre -> 'excluded') x));
  end if;

  if v_target >= v_e then
    if jsonb_array_length(p_ev -> 'marks') > 0 then v_warn := v_warn || 'marks_ignored_round_not_danced'::text; end if;
    return jsonb_build_object('ok', true,
      'rows', (select jsonb_agg(jsonb_build_object('entry_id', x, 'placement', null, 'tie_group', null, 'advanced', true, 'rating_band', null,
                                                   'output', jsonb_build_object('not_danced', true)) order by x collate "C") from unnest(v_calc) x),
      'warnings', coalesce((select jsonb_agg(w order by w collate "C") from unnest(v_warn) w), '[]'::jsonb));
  end if;

  v_pan := public._comppv1_panel(p_ev, v_pre);
  if not (v_pan ->> 'ok')::boolean then return v_pan; end if;
  v_warn := v_warn || coalesce((select array_agg(w) from jsonb_array_elements_text(v_pan -> 'warnings') w), '{}');

  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m
             where not exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j where j ->> 'officialId' = m ->> 'officialId')) then
    return public._comppv1_fail('official_not_on_panel');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where not (v_pre -> 'all') ? (m ->> 'entryId')) then
    return public._comppv1_fail('entry_not_in_round');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m group by m ->> 'officialId', m ->> 'entryId' having count(*) > 1) then
    return public._comppv1_fail('duplicate_mark');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where (m -> 'value') is distinct from 'true'::jsonb) then
    return public._comppv1_fail('mark_not_in_scheme');
  end if;
  if exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j
             where not exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where m ->> 'officialId' = j ->> 'officialId')) then
    return public._comppv1_fail('judge_without_ballot');
  end if;
  if exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j
             where (select count(distinct m ->> 'entryId') from jsonb_array_elements(p_ev -> 'marks') m
                    where m ->> 'officialId' = j ->> 'officialId' and (m ->> 'entryId') = any (v_calc)) <> v_target) then
    return public._comppv1_fail('callback_count');
  end if;

  -- Tally, competition rank (1 + entries with a higher tally), cutoff at the T-th place of (tally desc, id). Pure query, no session objects.
  with t as (
    select x entry_id, (select count(distinct m ->> 'officialId') from jsonb_array_elements(p_ev -> 'marks') m where m ->> 'entryId' = x)::integer tally
    from unnest(v_calc) x),
  r as (
    select t.entry_id, t.tally, (1 + (select count(*) from t o where o.tally > t.tally))::integer rnk,
           row_number() over (order by t.tally desc, t.entry_id collate "C")::integer ord
    from t)
  select jsonb_agg(jsonb_build_object('entry_id', entry_id, 'tally', tally, 'rnk', rnk, 'ord', ord) order by entry_id collate "C") into v_tab from r;
  select (e ->> 'tally')::integer into v_cut from jsonb_array_elements(v_tab) e where (e ->> 'ord')::integer = v_target;
  select count(*) into v_above from jsonb_array_elements(v_tab) e where (e ->> 'tally')::integer >= v_cut;

  if v_above > v_target then
    v_cap_ok := public._comppv1_is_int(v_cap) and (v_cap::text)::numeric >= 1;
    if not v_cap_ok or v_above > (v_cap::text)::numeric then
      v_rows := (select jsonb_agg(jsonb_build_object('entry_id', e ->> 'entry_id', 'placement', null, 'tie_group', null, 'advanced', null, 'rating_band', null,
                   'output', jsonb_build_object('tally', (e ->> 'tally')::integer, 'callback_rank', (e ->> 'rnk')::integer,
                                                'tie_status', case when (e ->> 'tally')::integer > v_cut then 'above_cut'
                                                                   when (e ->> 'tally')::integer = v_cut then 'tied_at_cut' else 'below_cut' end)
                             || case when (e ->> 'tally')::integer < v_cut then jsonb_build_object('label', 'Semi-final') else '{}'::jsonb end)
                   order by (e ->> 'entry_id') collate "C") from jsonb_array_elements(v_tab) e);
      v_warn := v_warn || 'advancement_unresolved_tie_over_capacity'::text;
      return jsonb_build_object('ok', true, 'rows', v_rows, 'warnings', (select jsonb_agg(w order by w collate "C") from unnest(v_warn) w));
    end if;
  end if;
  v_rows := (select jsonb_agg(jsonb_build_object('entry_id', e ->> 'entry_id', 'placement', null, 'tie_group', null,
               'advanced', (e ->> 'tally')::integer >= v_cut, 'rating_band', null,
               'output', jsonb_build_object('tally', (e ->> 'tally')::integer, 'callback_rank', (e ->> 'rnk')::integer)
                         || case when (e ->> 'tally')::integer < v_cut then jsonb_build_object('label', 'Semi-final') else '{}'::jsonb end)
               order by (e ->> 'entry_id') collate "C") from jsonb_array_elements(v_tab) e);
  return jsonb_build_object('ok', true, 'rows', v_rows, 'warnings', coalesce((select jsonb_agg(w order by w collate "C") from unnest(v_warn) w), '[]'::jsonb));
end;
$$;

-- studio_ordinal_majority@1 (engine-spec-ordinal-majority.md; engines/studioOrdinalMajority.ts). OM-A with the approved tie chain:
-- (1) more judges <= cutoff, (2) lower sum of those ordinals, (3) still tied: shared placement, numbering skips.
create function public._comppv1_ordinal(p_ev jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_pre jsonb;
  v_pan jsonb;
  v_s jsonb := p_ev -> 'markScheme';
  v_calc text[];
  v_n integer;
  v_j integer;
  v_m integer;
  v_warn text[] := '{}';
  v_p integer := 1;
  v_c integer;
  v_cutoff integer;
  v_pos integer;
  v_prev_cnt integer;
  v_prev_sum integer;
  v_group_start integer;
  v_ord integer[];
  v_placed boolean[];
  v_place integer[];
  v_cut_of integer[];
  v_cnt_of integer[];
  v_sum_of integer[];
  v_qi integer[];
  v_qc integer[];
  v_qs integer[];
  v_rem integer;
  v_i integer;
  v_k integer;
  v_cnt integer;
  v_sum integer;
  r record;
begin
  if regexp_replace(coalesce(p_ev ->> 'engineKey', ''), '^studio_', '') <> 'ordinal_majority' or (p_ev ->> 'engineVersion') is distinct from '1' then
    return public._comppv1_fail('engine_not_available');
  end if;
  if (p_ev #> '{round,roundType}') is distinct from '"final"'::jsonb then
    return public._comppv1_fail('round_type_not_final');
  end if;
  v_pre := public._comppv1_prefix(p_ev);
  if not (v_pre ->> 'ok')::boolean then return v_pre; end if;
  if v_s is not null and jsonb_typeof(v_s) <> 'null' then
    if jsonb_typeof(v_s) <> 'object' or (v_s -> 'input') is distinct from '"placement_marks"'::jsonb or (v_s -> 'scored_by') is distinct from '"entry"'::jsonb
       or (v_s -> 'ties_allowed') = 'true'::jsonb then
      return public._comppv1_fail('scheme_mismatch');
    end if;
  end if;
  v_pan := public._comppv1_panel(p_ev, v_pre);
  if not (v_pan ->> 'ok')::boolean then return v_pan; end if;
  if jsonb_array_length(p_ev -> 'heats') > 1 then
    return public._comppv1_fail('multi_heat_combination_unspecified');
  end if;
  select coalesce(array_agg(x order by x collate "C"), '{}') into v_calc from jsonb_array_elements_text(v_pre -> 'calculated') x;
  v_n := cardinality(v_calc);
  if v_n = 0 then
    return public._comppv1_fail('no_calculated_entries');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m
             where not exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j where j ->> 'officialId' = m ->> 'officialId')) then
    return public._comppv1_fail('official_not_on_panel');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where not (v_pre -> 'all') ? (m ->> 'entryId')) then
    return public._comppv1_fail('entry_not_in_round');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where (m ? 'role') and jsonb_typeof(m -> 'role') <> 'null') then
    return public._comppv1_fail('role_not_allowed');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m group by m ->> 'officialId', m ->> 'entryId' having count(*) > 1) then
    return public._comppv1_fail('duplicate_mark');
  end if;
  if exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j
             where not exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where m ->> 'officialId' = j ->> 'officialId')) then
    return public._comppv1_fail('judge_without_ballot');
  end if;
  if exists (select 1 from jsonb_array_elements(v_pre -> 'judges') j, unnest(v_calc) x
             where not exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m where m ->> 'officialId' = j ->> 'officialId' and m ->> 'entryId' = x)) then
    return public._comppv1_fail('incomplete_ballot');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m
             where not public._comppv1_is_int(m -> 'value') or ((m -> 'value')::text)::numeric < 1 or ((m -> 'value')::text)::numeric > v_n) then
    return public._comppv1_fail('mark_out_of_range');
  end if;
  if exists (select 1 from jsonb_array_elements(p_ev -> 'marks') m
             group by m ->> 'officialId', ((m -> 'value')::text)::numeric having count(*) > 1) then
    return public._comppv1_fail('judge_tie');
  end if;

  v_j := jsonb_array_length(v_pre -> 'judges');
  v_m := v_j / 2 + 1;
  -- One row of J ordinals per calculated entry (V6/V7 guarantee exactly one mark per judge and entry). Plain arrays: no session objects.
  v_ord := array_fill(0, array[v_n, v_j]);
  for v_i in 1 .. v_n loop
    v_k := 0;
    for r in select ((m -> 'value')::text)::numeric::integer val
             from jsonb_array_elements(v_pre -> 'judges') j
             join jsonb_array_elements(p_ev -> 'marks') m on m ->> 'officialId' = j ->> 'officialId' and m ->> 'entryId' = v_calc[v_i]
             order by (j ->> 'letter') collate "C", (j ->> 'officialId') collate "C"
    loop
      v_k := v_k + 1;
      v_ord[v_i][v_k] := r.val;
    end loop;
  end loop;
  v_placed := array_fill(false, array[v_n]);
  v_place := array_fill(null::integer, array[v_n]);
  v_cut_of := array_fill(null::integer, array[v_n]);
  v_cnt_of := array_fill(null::integer, array[v_n]);
  v_sum_of := array_fill(null::integer, array[v_n]);
  v_rem := v_n;
  while v_rem > 0 loop
    v_cutoff := null;
    for v_c in v_p .. v_n loop
      for v_i in 1 .. v_n loop
        if not v_placed[v_i] then
          v_cnt := 0;
          for v_k in 1 .. v_j loop
            if v_ord[v_i][v_k] <= v_c then v_cnt := v_cnt + 1; end if;
          end loop;
          if v_cnt >= v_m then v_cutoff := v_c; exit; end if;
        end if;
      end loop;
      exit when v_cutoff is not null;
    end loop;
    if v_cutoff is null then
      return public._comppv1_fail('malformed_input');
    end if;
    v_qi := '{}';
    v_qc := '{}';
    v_qs := '{}';
    for v_i in 1 .. v_n loop
      if not v_placed[v_i] then
        v_cnt := 0;
        v_sum := 0;
        for v_k in 1 .. v_j loop
          if v_ord[v_i][v_k] <= v_cutoff then v_cnt := v_cnt + 1; v_sum := v_sum + v_ord[v_i][v_k]; end if;
        end loop;
        if v_cnt >= v_m then v_qi := v_qi || v_i; v_qc := v_qc || v_cnt; v_qs := v_qs || v_sum; end if;
      end if;
    end loop;
    v_pos := v_p;
    v_prev_cnt := null;
    v_prev_sum := null;
    v_group_start := v_p;
    for r in select u.i, u.c, u.s from unnest(v_qi, v_qc, v_qs) as u(i, c, s) order by u.c desc, u.s asc, v_calc[u.i] collate "C" loop
      if v_prev_cnt is null or r.c <> v_prev_cnt or r.s <> v_prev_sum then
        v_group_start := v_pos;
      end if;
      v_placed[r.i] := true;
      v_place[r.i] := v_group_start;
      v_cut_of[r.i] := v_cutoff;
      v_cnt_of[r.i] := r.c;
      v_sum_of[r.i] := r.s;
      v_pos := v_pos + 1;
      v_rem := v_rem - 1;
      v_prev_cnt := r.c;
      v_prev_sum := r.s;
    end loop;
    v_p := v_pos;
  end loop;

  if jsonb_array_length(v_pre -> 'excluded') > 0 then
    v_warn := v_warn || ('excluded_entries:' || (select string_agg(x, ',' order by x collate "C") from jsonb_array_elements_text(v_pre -> 'excluded') x));
  end if;
  v_warn := v_warn || coalesce((select array_agg(w) from jsonb_array_elements_text(v_pan -> 'warnings') w), '{}');
  return jsonb_build_object('ok', true,
    'rows', (select jsonb_agg(jsonb_build_object('entry_id', v_calc[i], 'placement', v_place[i],
                                                 'tie_group', case when (select count(*) from generate_subscripts(v_place, 1) o where v_place[o] = v_place[i]) > 1
                                                                   then 'tie-' || v_place[i] end,
                                                 'advanced', null, 'rating_band', null,
                                                 'output', jsonb_build_object('cutoff', v_cut_of[i], 'judges_at_cutoff', v_cnt_of[i], 'ordinal_sum_at_cutoff', v_sum_of[i]))
                              order by v_calc[i] collate "C") from generate_subscripts(v_calc, 1) i),
    'warnings', coalesce((select jsonb_agg(w order by w collate "C") from unnest(v_warn) w), '[]'::jsonb));
end;
$$;

-- Runs one engine body by name after the input caps (corpus entry point and the dispatcher below).
create function public._comppv1_run(p_engine text, p_ev jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_cap text;
begin
  if p_ev is null or jsonb_typeof(p_ev) <> 'object' then
    return public._comppv1_fail('malformed_input');
  end if;
  v_cap := public._comppv1_caps(p_ev);
  if v_cap is not null then
    return public._comppv1_fail(v_cap);
  end if;
  if p_engine = 'callback' then
    return public._comppv1_callback(p_ev);
  elsif p_engine = 'ordinal' then
    return public._comppv1_ordinal(p_ev);
  end if;
  return public._comppv1_fail('engine_not_available');
end;
$$;

-- The verifier calculate_competition_round calls. p_ev is the evidence the input hash was just checked against (v_evidence).
create function public._comppv1_verify(p_ev jsonb, p_rows jsonb, p_warnings jsonb) returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_engine text;
  v_res jsonb;
  v_given jsonb;
begin
  v_engine := case
    when (p_ev ->> 'engineKey') = 'studio_callback_tally' and (p_ev ->> 'engineVersion') = '1' then 'callback'
    when (p_ev ->> 'engineKey') = 'studio_ordinal_majority' and (p_ev ->> 'engineVersion') = '1' then 'ordinal'
  end;
  if v_engine is null then
    raise exception 'COMP_RESULT_RECOMPUTE_UNSUPPORTED: the database has no independent calculation for engine %@%.',
      coalesce(p_ev ->> 'engineKey', 'null'), coalesce(p_ev ->> 'engineVersion', 'null') using errcode = 'P0001';
  end if;
  v_res := public._comppv1_run(v_engine, p_ev);
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'COMP_RESULT_RECOMPUTE_UNSUPPORTED: the database''s own calculation refuses this round (%).', coalesce(v_res ->> 'reason', 'unknown')
      using errcode = 'P0001';
  end if;
  -- The caller's rows in the stored shape (calculate.ts rowToRpc); entry ids in canonical uuid text. Missing keys are null / {}.
  select coalesce(jsonb_agg(x.r order by x.k collate "C"), '[]'::jsonb) into v_given
  from (select (el ->> 'entry_id')::uuid::text k,
               jsonb_build_object('entry_id', (el ->> 'entry_id')::uuid::text,
                                  'placement', coalesce(el -> 'placement', 'null'::jsonb),
                                  'tie_group', coalesce(el -> 'tie_group', 'null'::jsonb),
                                  'advanced', coalesce(el -> 'advanced', 'null'::jsonb),
                                  'rating_band', coalesce(el -> 'rating_band', 'null'::jsonb),
                                  'output', coalesce(el -> 'output', '{}'::jsonb)) r
        from jsonb_array_elements(p_rows) el) x;
  if v_given is distinct from (v_res -> 'rows') or coalesce(p_warnings, '[]'::jsonb) is distinct from (v_res -> 'warnings') then
    raise exception 'COMP_RESULT_RECOMPUTE_MISMATCH: the submitted result differs from the database''s own calculation of the locked ballots; nothing was saved.'
      using errcode = 'P0001';
  end if;
end;
$$;

-- Internal only: reachable solely through calculate_competition_round (SECURITY DEFINER).
do $$
declare
  r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_comppv1\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- calculate_competition_round: exact-fragment insert of the verify call (pinned pre/post md5, as F2/HL1/A3).
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
  if md5(v_def) <> v_pre then
    raise exception 'PV-1: % is not the pinned post-A3 text (md5 %, expected %).', v_sig, md5(v_def), v_pre;
  end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'PV-1: % does not contain the anchor exactly once.', v_sig;
  end if;
  v_def := replace(v_def, v_old, v_new);
  if md5(v_def) <> v_post then
    raise exception 'PV-1: redefined text of % has md5 % (expected %).', v_sig, md5(v_def), v_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_post then
    raise exception 'PV-1: installed text of % does not match the expected post-PV-1 md5.', v_sig;
  end if;
  if position('_comppv1_verify' in pg_get_functiondef(v_sig::regprocedure)) = 0 then
    raise exception 'PV-1: calculate_competition_round was not redefined.';
  end if;
end $$;

-- approve_competition_round_result: re-verify the stored version at approval (security review P2: a version stored before PV-1, or any stored
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
  if md5(v_def) <> v_pre then
    raise exception 'PV-1: % is not the pinned post-A3 text (md5 %, expected %).', v_sig, md5(v_def), v_pre;
  end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'PV-1: % does not contain the anchor exactly once.', v_sig;
  end if;
  v_def := replace(v_def, v_old, v_new);
  if md5(v_def) <> v_post then
    raise exception 'PV-1: redefined text of % has md5 % (expected %).', v_sig, md5(v_def), v_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(v_sig::regprocedure), E'\r', '')) <> v_post then
    raise exception 'PV-1: installed text of % does not match the expected post-PV-1 md5.', v_sig;
  end if;
end $$;

comment on function public._comppv1_verify(jsonb, jsonb, jsonb) is
  'PV-1 (owner decision 2026-11-10): recomputes the result of the pinned Studio engine from the evidence and refuses COMP_RESULT_RECOMPUTE_MISMATCH / _UNSUPPORTED.';

commit;
