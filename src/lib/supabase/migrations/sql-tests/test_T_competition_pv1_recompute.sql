-- Competition PV-1 (20270215090000, owner decision 2026-11-10): the database recomputes every result.
-- Run as a SUPERUSER on a chain with PV-1 applied; one transaction, always raises "COMPETITION PV-1 SQL SUITE PASS (<n> checks)" or "... FAIL".
-- Pure-function checks over synthetic evidence documents (no fixture tables), plus the wiring of calculate / approve and the grants.
--   W   wiring: calculate and approve call the verifier after their hash checks and before any write; md5 pins; grants; volatility
--   C   callback_tally@1: honest rows accepted; flipped advance, changed tally, forged warning, missing row, extra output key refused
--   U   callback unresolved tie over capacity: every row advanced = null with tie_status; a "resolved" forgery is refused
--   O   ordinal_majority@1: honest placements and the tie chain accepted; swapped placements / tie group refused
--   F   fail closed: unknown engine, even panel, wrong profile, two dances -> UNSUPPORTED
--   S   session objects cannot influence the recompute (temp tables / pg_temp functions named like the internals)
--   N   normalization: upper-case entry ids and missing null keys are the same row; JSON 2 == 2.0 in output is the same value
begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.verify_code(p_ev jsonb, p_rows jsonb, p_warnings jsonb) returns text language plpgsql as $$
begin
  perform public._comppv1_verify(p_ev, p_rows, p_warnings);
  return 'OK';
exception when others then
  return split_part(sqlerrm, ':', 1);
end $$;

-- Synthetic evidence documents in the shape _compf2_evidence builds (ids are uuids, one dance, one heat, judges A/B/C).
create or replace function pg_temp.u(n int) returns text language sql immutable as $$ select format('00000000-0000-4000-8000-%s', lpad(n::text, 12, '0')) $$;
create or replace function pg_temp.ev(p_engine text, p_round_type text, p_method text, p_t int, p_cap int, p_marks jsonb, p_entries int,
                                      p_judges int default 3, p_profile jsonb default '{"key":"studio_simple","version":1}', p_dances jsonb default '["d1"]')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'engineKey', p_engine, 'engineVersion', '1', 'profile', p_profile, 'markScheme', null, 'tieBreakChain', '[]'::jsonb,
    'round', jsonb_build_object('id', pg_temp.u(900), 'roundType', p_round_type, 'targetAdvancementCount', p_t, 'advancementMethod', p_method),
    'chiefJudgeTiebreak', false, 'scoreRolesSeparately', false, 'finalCapacity', p_cap,
    'entries', (select jsonb_agg(jsonb_build_object('entryId', pg_temp.u(i)) order by i) from generate_series(1, p_entries) i),
    'excludedEntries', '[]'::jsonb,
    'heats', jsonb_build_array(jsonb_build_object('heatId', pg_temp.u(800),
                'officialIds', (select jsonb_agg(pg_temp.u(100 + j) order by j) from generate_series(1, p_judges) j),
                'entryIds', (select jsonb_agg(pg_temp.u(i) order by i) from generate_series(1, p_entries) i))),
    'danceIds', p_dances,
    'judges', (select jsonb_agg(jsonb_build_object('officialId', pg_temp.u(100 + j), 'letter', chr(64 + j)) order by j) from generate_series(1, p_judges) j),
    'ballots', '[]'::jsonb,
    'marks', p_marks);
$$;
-- marks: judge j (1..3) -> list of entry numbers (callback) or entry -> rank (ordinal)
create or replace function pg_temp.cb_marks(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('officialId', pg_temp.u(100 + (j.key)::int), 'entryId', pg_temp.u(e::int), 'heatId', null, 'role', null, 'value', true)), '[]'::jsonb)
  from jsonb_each(p) j, jsonb_array_elements_text(j.value) e;
$$;
create or replace function pg_temp.om_marks(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('officialId', pg_temp.u(100 + (j.key)::int), 'entryId', pg_temp.u((r.ordinality)::int), 'heatId', null, 'role', null, 'value', (r.value)::int)), '[]'::jsonb)
  from jsonb_each(p) j, jsonb_array_elements_text(j.value) with ordinality r;
$$;

-- ---------------------------------------------------------------- W wiring
select pg_temp.chk('W1 calculate calls the verifier exactly once, after the trace-hash check and before the version insert',
  (with d as (select replace(pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure), E'\r', '') t)
   select (length(t) - length(replace(t, '_comppv1_verify', ''))) / length('_comppv1_verify') = 1
      and position('trace_hash is not the canonical hash' in t) < position('_comppv1_verify' in t)
      and position('_comppv1_verify' in t) < position('insert into public.event_competition_result_versions' in t) from d));
select pg_temp.chk('W2 approve re-verifies the stored version after the input-hash check and before any status write',
  (with d as (select replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '') t)
   select position('recalculate before approving' in t) < position('_comppv1_verify' in t)
      and position('_comppv1_verify' in t) < position('update public.event_competition_rounds set status = ''approved''' in t) from d));
select pg_temp.chk('W3 md5 pins: calculate 167529ba..., approve 3cf63c3b...',
  md5(replace(pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure), E'\r', '')) = '167529bada8ca5a4dd98e22d4d0a3252'
  and md5(replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '')) = '3cf63c3bb00a78142ea2c8e70a8b4a0c');
select pg_temp.chk('W4 no API role can execute any _comppv1_ function (internal to the SECURITY DEFINER RPCs)',
  (select bool_and(not has_function_privilege(r, p.oid, 'execute'))
   from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
   where p.pronamespace = 'public'::regnamespace and p.proname like '\_comppv1\_%'));
select pg_temp.chk('W5 every _comppv1_ function pins search_path and none is SECURITY DEFINER',
  (select bool_and(not p.prosecdef and p.proconfig::text like '%search_path=public, pg_temp%') from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like '\_comppv1\_%'));
select pg_temp.chk('W6 calculate is still SECURITY DEFINER and granted to authenticated, never to anon',
  (select p.prosecdef from pg_proc p where p.oid = 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'execute'));

-- ---------------------------------------------------------------- C callback_tally
-- 4 entries, T = 2, tallies e1=3 e2=2 e3=1 e4=0 -> e1, e2 advance.
create temp table c (ev jsonb, res jsonb) on commit drop;
insert into c select e, public._comppv1_run('callback', e) from (select pg_temp.ev('studio_callback_tally', 'preliminary', 'promote_callback', 2, 8,
  pg_temp.cb_marks('{"1":[1,2],"2":[1,2],"3":[1,3]}'), 4) e) x;
select pg_temp.chk('C1 the port calculates the callback round', (select (res ->> 'ok')::boolean from c), (select res::text from c));
select pg_temp.chk('C2 honest rows and warnings are accepted', (select pg_temp.verify_code(ev, res -> 'rows', res -> 'warnings') = 'OK' from c));
select pg_temp.chk('C3 the advancing set is e1, e2 with tallies 3, 2 and ranks 1, 2',
  (select string_agg(r ->> 'entry_id' || ':' || (r -> 'output' ->> 'tally') || ':' || (r -> 'output' ->> 'callback_rank'), ',' order by r ->> 'entry_id')
   from c, jsonb_array_elements(res -> 'rows') r where (r ->> 'advanced')::boolean)
  = pg_temp.u(1) || ':3:1,' || pg_temp.u(2) || ':2:2');
select pg_temp.chk('C4 a flipped advanced flag is refused MISMATCH',
  (select pg_temp.verify_code(ev, jsonb_set(res -> 'rows', '{3,advanced}', 'true'), res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from c));
select pg_temp.chk('C5 a changed tally in output is refused MISMATCH',
  (select pg_temp.verify_code(ev, jsonb_set(res -> 'rows', '{0,output,tally}', '9'), res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from c));
select pg_temp.chk('C6 a forged warning is refused MISMATCH',
  (select pg_temp.verify_code(ev, res -> 'rows', '["operator_note"]') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from c));
select pg_temp.chk('C7 a missing row is refused MISMATCH',
  (select pg_temp.verify_code(ev, (res -> 'rows') - 0, res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from c));
select pg_temp.chk('C8 an extra key inside output is refused MISMATCH',
  (select pg_temp.verify_code(ev, jsonb_set(res -> 'rows', '{0,output,note}', '"x"'), res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from c));
select pg_temp.chk('C9 a not-called-back row carries label Semi-final and no placement',
  (select bool_and((r -> 'output' ->> 'label') = 'Semi-final' and jsonb_typeof(r -> 'placement') = 'null') from c, jsonb_array_elements(res -> 'rows') r where not (r ->> 'advanced')::boolean));

-- ---------------------------------------------------------------- U unresolved tie over capacity
-- tallies e1=3, e2=e3=e4=2 at the cut of T=2 -> 4 at or above, capacity 3 -> unresolved.
create temp table uu (ev jsonb, res jsonb) on commit drop;
insert into uu select e, public._comppv1_run('callback', e) from (select pg_temp.ev('studio_callback_tally', 'preliminary', 'promote_callback', 2, 3,
  pg_temp.cb_marks('{"1":[1,2],"2":[1,3],"3":[1,4]}'), 5) e) x;
select pg_temp.chk('U1 unresolved: every row advanced = null, ties tied_at_cut, warning advancement_unresolved_tie_over_capacity',
  (select bool_and(jsonb_typeof(r -> 'advanced') = 'null') from uu, jsonb_array_elements(res -> 'rows') r)
  and (select count(*) = 3 from uu, jsonb_array_elements(res -> 'rows') r where r -> 'output' ->> 'tie_status' = 'tied_at_cut')
  and (select res -> 'warnings' ? 'advancement_unresolved_tie_over_capacity' from uu));
select pg_temp.chk('U2 a forged resolution (advance the tied couples) is refused MISMATCH',
  (select pg_temp.verify_code(ev,
     (select jsonb_agg(case when r -> 'output' ->> 'tie_status' = 'below_cut' then r || '{"advanced":false}' else r || '{"advanced":true}' end) from jsonb_array_elements(res -> 'rows') r),
     res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from uu));
select pg_temp.chk('U3 the same tie fits a capacity of 4: all four at or above advance',
  (select count(*) = 4 from jsonb_array_elements(public._comppv1_run('callback', jsonb_set((select ev from uu), '{finalCapacity}', '4')) -> 'rows') r where (r ->> 'advanced')::boolean));

-- ---------------------------------------------------------------- O ordinal_majority
-- 3 judges, 3 entries: A: e1=1 e2=2 e3=3 ; B: e1=2 e2=1 e3=3 ; C: e1=1 e2=3 e3=2  -> e1 majority at 1 (2 judges), e2 then e3.
create temp table o (ev jsonb, res jsonb) on commit drop;
insert into o select e, public._comppv1_run('ordinal', e) from (select pg_temp.ev('studio_ordinal_majority', 'final', null, null, null,
  pg_temp.om_marks('{"1":[1,2,3],"2":[2,1,3],"3":[1,3,2]}'), 3) e) x;
select pg_temp.chk('O1 the port places the Final 1, 2, 3', (select string_agg(r ->> 'placement', ',' order by r ->> 'entry_id') from o, jsonb_array_elements(res -> 'rows') r) = '1,2,3',
  (select res::text from o));
select pg_temp.chk('O2 honest placements accepted', (select pg_temp.verify_code(ev, res -> 'rows', res -> 'warnings') = 'OK' from o));
select pg_temp.chk('O3 swapped placements refused MISMATCH',
  (select pg_temp.verify_code(ev, jsonb_set(jsonb_set(res -> 'rows', '{0,placement}', '2'), '{1,placement}', '1'), res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from o));
-- full tie: three judges rank the 3 entries in a cycle -> every entry has 1 judge per place; at cutoff 2 every entry has 2 judges with sum 3 -> shared 1st.
create temp table o2 (ev jsonb, res jsonb) on commit drop;
insert into o2 select e, public._comppv1_run('ordinal', e) from (select pg_temp.ev('studio_ordinal_majority', 'final', null, null, null,
  pg_temp.om_marks('{"1":[1,2,3],"2":[2,3,1],"3":[3,1,2]}'), 3) e) x;
select pg_temp.chk('O4 the tie chain: a full cycle shares placement 1 with tie group tie-1',
  (select bool_and((r ->> 'placement')::int = 1 and r ->> 'tie_group' = 'tie-1') from o2, jsonb_array_elements(res -> 'rows') r), (select res::text from o2));
select pg_temp.chk('O5 dropping the tie group is refused MISMATCH',
  (select pg_temp.verify_code(ev, jsonb_set(res -> 'rows', '{0,tie_group}', 'null'), res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from o2));

-- ---------------------------------------------------------------- F fail closed
select pg_temp.chk('F1 an engine with no SQL port is UNSUPPORTED',
  (select pg_temp.verify_code(jsonb_set(ev, '{engineKey}', '"studio_skating"'), res -> 'rows', res -> 'warnings') = 'COMP_RESULT_RECOMPUTE_UNSUPPORTED' from o));
select pg_temp.chk('F2 an even panel is UNSUPPORTED (panel_size)',
  public._comppv1_run('ordinal', pg_temp.ev('studio_ordinal_majority', 'final', null, null, null, pg_temp.om_marks('{"1":[1,2],"2":[2,1]}'), 2, 2)) ->> 'reason' = 'panel_size'
  and pg_temp.verify_code(pg_temp.ev('studio_ordinal_majority', 'final', null, null, null, pg_temp.om_marks('{"1":[1,2],"2":[2,1]}'), 2, 2), '[]', '[]') = 'COMP_RESULT_RECOMPUTE_UNSUPPORTED');
select pg_temp.chk('F3 a profile outside studio_simple @1/@3 is UNSUPPORTED',
  pg_temp.verify_code(pg_temp.ev('studio_ordinal_majority', 'final', null, null, null, pg_temp.om_marks('{"1":[1,2,3],"2":[2,1,3],"3":[1,3,2]}'), 3, 3, '{"key":"studio_simple","version":2}'), '[]', '[]')
  = 'COMP_RESULT_RECOMPUTE_UNSUPPORTED');
select pg_temp.chk('F4 two dances are UNSUPPORTED (multi_dance_unsupported)',
  public._comppv1_run('ordinal', pg_temp.ev('studio_ordinal_majority', 'final', null, null, null, pg_temp.om_marks('{"1":[1,2,3],"2":[2,1,3],"3":[1,3,2]}'), 3, 3,
    '{"key":"studio_simple","version":1}', '["d1","d2"]')) ->> 'reason' = 'multi_dance_unsupported');
select pg_temp.chk('F5 a callback count that is not exactly T is UNSUPPORTED (callback_count)',
  public._comppv1_run('callback', pg_temp.ev('studio_callback_tally', 'preliminary', 'promote_callback', 2, 8, pg_temp.cb_marks('{"1":[1],"2":[1,2],"3":[1,3]}'), 4)) ->> 'reason' = 'callback_count');

-- ---------------------------------------------------------------- S session objects
create temp table _comppv1_place (entry_id text, placement integer, tie_group text, cutoff integer, cnt integer, sm integer);
create temp table _comppv1_tally (entry_id text, tally integer, rnk integer, ord integer);
create or replace function pg_temp._comppv1_fail(p_reason text) returns jsonb language sql as $$ select '{"ok":true,"rows":[],"warnings":[]}'::jsonb $$;
create or replace function pg_temp._comppv1_ordinal(p_ev jsonb) returns jsonb language sql as $$ select '{"ok":true,"rows":[],"warnings":[]}'::jsonb $$;
select pg_temp.chk('S1 temp tables and pg_temp functions named like the internals change nothing (same ordinal result, forgery still refused)',
  (select public._comppv1_run('ordinal', ev) = res from o)
  and (select pg_temp.verify_code(ev, '[]', '[]') = 'COMP_RESULT_RECOMPUTE_MISMATCH' from o)
  and public._comppv1_run('ordinal', pg_temp.ev('studio_ordinal_majority', 'final', null, null, null, pg_temp.om_marks('{"1":[1,2],"2":[2,1]}'), 2, 2)) ->> 'ok' = 'false');

-- ---------------------------------------------------------------- N normalization
select pg_temp.chk('N1 upper-case entry ids, missing null keys and 2.0 for 2 inside output are the same rows',
  (select pg_temp.verify_code(ev,
     (select jsonb_agg(jsonb_build_object('entry_id', upper(r ->> 'entry_id'), 'placement', r -> 'placement', 'output',
                                          jsonb_build_object('cutoff', ((r -> 'output' ->> 'cutoff') || '.0')::numeric, 'judges_at_cutoff', r -> 'output' -> 'judges_at_cutoff',
                                                             'ordinal_sum_at_cutoff', r -> 'output' -> 'ordinal_sum_at_cutoff')))
      from jsonb_array_elements(res -> 'rows') r),
     res -> 'warnings') = 'OK' from o));

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', E'\n  ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION PV-1 SQL SUITE PASS (% checks)', v_total;
  else
    raise exception 'COMPETITION PV-1 SQL SUITE FAIL: %', E'\n  ' || v_failures;
  end if;
end $$;
rollback;
