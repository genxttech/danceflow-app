-- Competition CF1 package A7 -- OD-13 correction-ballot integrity regression suite.
--
-- Covers 20270120096000_competition_cf1_a7_od13_correction_integrity.sql on top of the chain through HL1, A1, A0, A3, A5.
-- Run as a SUPERUSER. One transaction, synthetic fixtures only (md5-derived ids). Fixtures are placed with session_replication_role = replica
-- (the ENABLE ALWAYS CF1 triggers still fire). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A7 SQL SUITE PASS (<n> checks, <b> blocked ...)"  or  "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text, status text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'), case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end);
end $$;
create or replace function pg_temp.blocked(p_name text, p_why text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, true, p_why, 'BLOCKED');
end $$;
-- Runs p_sql; passes when it raises with p_fragment in the message (and optional sqlstate). Everything is rolled back to a savepoint.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      perform pg_temp.chk(p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state), sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;
create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_name, true, '');
  exception when others then
    perform pg_temp.chk(p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;
create or replace function pg_temp.id(p_kind text, p_n int default 0, p_k int default 0) returns uuid
language sql immutable as $$ select md5('cf1a7:' || p_kind || ':' || p_n || ':' || p_k)::uuid $$;
-- Runs p_sql (a statement returning jsonb) as p_user; returns the jsonb or {"error","state","detail"}. The role is always reset.
create or replace function pg_temp.run_as(p_user uuid, p_sql text) returns jsonb
language plpgsql as $$
declare
  r jsonb;
  d text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql into r;
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    execute 'reset role';
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate, 'detail', d);
  end;
  execute 'reset role';
  return r;
end $$;
create or replace function pg_temp.catch(p_sql text) returns text language plpgsql as $c$
begin
  begin execute p_sql; exception when others then return sqlerrm; end;
  return 'OK';
end $c$;
create or replace function pg_temp.code(p_j jsonb) returns text language sql as $$ select split_part(coalesce(p_j ->> 'error', 'OK'), ':', 1) $$;
create or replace function pg_temp.su(p_sql text) returns void
language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  execute p_sql;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures. Users: 1 manager (opener), 2 manager (second), 4 chair official (verified, not a manager), 11/12/13 judges, 14 judge who is also a manager,
-- 9 an unrelated verified user. Studio roles: 1, 2, 14 studio_owner.
-- ============================================================================
insert into auth.users (id, email)
select pg_temp.id('user', u), 't-cf1a7-u' || u || '@example.test' from unnest(array[1, 2, 4, 9, 11, 12, 13, 14, 15]) u;
insert into public.profiles (id, email, full_name) select id, email, 'CF1A7 ' || split_part(email, '@', 1) from auth.users where email like 't-cf1a7-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a7-%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 A7 Studio', 't-cf1a7-a');
insert into public.user_studio_roles (user_id, studio_id, role, active)
select pg_temp.id('user', u), pg_temp.id('studio', 1), 'studio_owner', true from unnest(array[1, 2, 14]) u;
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
select pg_temp.id('evt', e), pg_temp.id('studio', 1), 'CF1 A7 Comp ' || e, 't-cf1a7-e' || e, 'competition', current_date + 30, current_date + 30, 'published', 'public', true
from generate_series(1, 2) e;
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
select pg_temp.id('prg', e), pg_temp.id('evt', e), pg_temp.id('studio', 1), 'Program ' || e, 'country', 'relative', 'skating', 'configured', 'none'
from generate_series(1, 2) e;
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.id('cts', e), pg_temp.id('evt', e), pg_temp.id('prg', e), 'Contest ' || e, 'single_dance', 'pro_am', 'open' from generate_series(1, 2) e;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values (pg_temp.id('sv', 1), pg_temp.id('evt', 1), 1, 'V1', 'published', now());
-- officials of event 1: judges 11, 12, 13, 14; chair 4
insert into public.event_competition_officials (id, event_id, user_id, role)
select pg_temp.id('off', u), pg_temp.id('evt', 1), pg_temp.id('user', u), case when u = 4 then 'chair' else 'judge' end from unnest(array[4, 11, 12, 13, 14]) u;

-- Scenario n of event 1: a callback round (T = 3, 8 entries, one danced heat, judges 11/12/13 on the panel as A/B/C), status active, v1 ballots filed:
-- J11 {1,2,3}, J12 {1,2,4}, J13 {1,3,4}. Entries 1..8.
create or replace function pg_temp.mk(p_n int, p_judges int[] default array[11, 12, 13], p_scoring text default 'callback_tally') returns void
language plpgsql security definer as $$
declare
  v_event uuid := pg_temp.id('evt', 1);
  v_k int;
  v_letter text[] := array['A', 'B', 'C', 'D'];
  j int;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('div', p_n), v_event, pg_temp.id('prg', 1), pg_temp.id('cts', 1), 'D' || p_n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
  values (pg_temp.id('src', p_n), v_event, pg_temp.id('prg', 1), pg_temp.id('div', p_n), 'D' || p_n || ' R', 'preliminary', 1, 'active', p_scoring,
          case when p_scoring = 'callback_tally' then 3 end);
  for v_k in 1..8 loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values (pg_temp.id('ent', p_n, v_k), v_event, pg_temp.id('prg', 1), pg_temp.id('div', p_n), 'e' || p_n || '-' || v_k, 'confirmed', 'eligible', (p_n * 100 + v_k)::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.id('cbf', p_n), v_event, pg_temp.id('sv', 1), p_n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
  values (pg_temp.id('cbh', p_n), v_event, pg_temp.id('div', p_n), pg_temp.id('src', p_n), 1, 'complete', 'certified', pg_temp.id('cts', 1), pg_temp.id('sv', 1), pg_temp.id('cbf', p_n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
  values (v_event, pg_temp.id('cbh', p_n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
  select v_event, pg_temp.id('div', p_n), pg_temp.id('cbh', p_n), pg_temp.id('ent', p_n, k), k, 'danced' from generate_series(1, 8) k;
  for j in 1..array_length(p_judges, 1) loop
    insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
    values (v_event, pg_temp.id('src', p_n), pg_temp.id('off', p_judges[j]), v_letter[j]);
  end loop;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- marks for a list of entry numbers of scenario n
create or replace function pg_temp.mk_marks(p_n int, p_nums int[]) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object('entry_id', pg_temp.id('ent', p_n, x), 'value', true) order by x) from unnest(p_nums) x
$$;
-- file a ballot as the internal writer (the same function both public RPCs call); returns the jsonb result or {"error",...}
create or replace function pg_temp.file(p_n int, p_judge int, p_nums int[], p_reason text default null, p_req uuid default gen_random_uuid(), p_actor int default null)
returns jsonb language plpgsql security definer as $$
declare r jsonb; d text;
begin
  begin
    r := public._compe2_insert_ballot(pg_temp.id('user', coalesce(p_actor, p_judge)), pg_temp.id('src', p_n), null, pg_temp.id('off', p_judge), 'judge_web', null,
                                      pg_temp.mk_marks(p_n, p_nums), p_reason, p_req);
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate, 'detail', d);
  end;
  return r;
end $$;
create or replace function pg_temp.v1(p_n int) returns void language plpgsql security definer as $$
begin
  perform pg_temp.file(p_n, 11, array[1, 2, 3]);
  perform pg_temp.file(p_n, 12, array[1, 2, 4]);
  perform pg_temp.file(p_n, 13, array[1, 3, 4]);
end $$;
-- numbers (entry_number suffix 1..8) of the current picks of judge j in scenario n
create or replace function pg_temp.cur(p_n int, p_judge int) returns int[] language sql stable security definer as $$
  select array_agg((e.entry_number::int - p_n * 100) order by e.entry_number)
  from public.event_competition_marks m join public.event_competition_ballots b on b.id = m.ballot_id
  join public.event_competition_entries e on e.id = m.entry_id
  where b.round_id = pg_temp.id('src', p_n) and b.official_id = pg_temp.id('off', p_judge)
    and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)
$$;
-- approve the round the way the lifecycle leaves it (fixture shortcut, replica): status + a version whose input is the real evidence
create or replace function pg_temp.approve_state(p_n int, p_status text default 'approved') returns void
language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_rounds set status = p_status where id = pg_temp.id('src', p_n);
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (pg_temp.id('rv', p_n), pg_temp.id('evt', 1), pg_temp.id('src', p_n), 1, 'callback_tally', '1',
          public._compf2_input_hash(pg_temp.id('src', p_n), 'callback_tally', '1'), repeat('a', 64),
          public._compf2_evidence(pg_temp.id('src', p_n), 'callback_tally', '1'), '[]', pg_temp.id('user', 1), p_status, pg_temp.id('req-rv', p_n));
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.scratch(p_n int, p_k int) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heat_entries set status = 'scratched' where entry_id = pg_temp.id('ent', p_n, p_k);
  perform set_config('session_replication_role', 'origin', true);
end $$;
-- The suite runs in one transaction: flush the deferred backstops of earlier (pre-correction) ballots before the round enters a correction.
create or replace function pg_temp.open_corr(p_n int, p_user int default 1, p_req int default 1) returns jsonb language plpgsql as $$
begin
  execute 'set constraints all immediate';
  execute 'set constraints all deferred';
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.open_competition_round_correction(%L, 'correcting the callback', %L)$q$,
                        pg_temp.id('src', p_n), pg_temp.id('creq', p_n, p_req)));
end $$;
create or replace function pg_temp.cause(p_n int) returns public.event_competition_correction_causes language sql stable security definer as $$
  select c from public.event_competition_correction_causes c where c.round_id = pg_temp.id('src', p_n) order by c.seq desc limit 1
$$;

-- ============================================================================
-- 1. Cause derivation
-- ============================================================================
-- S1: an entry scratched after approval -> entry_exclusion.
select pg_temp.mk(1); select pg_temp.v1(1); select pg_temp.approve_state(1); select pg_temp.scratch(1, 3);
select pg_temp.chk('1a setup: the approved evidence has no exclusion, the live evidence now lists entry 3',
  (select public._compf2_evidence(pg_temp.id('src', 1), 'callback_tally', '1') -> 'excludedEntries') @> jsonb_build_array(jsonb_build_object('entryId', pg_temp.id('ent', 1, 3), 'reason', 'scratched'))
  and (select input -> 'excludedEntries' from public.event_competition_result_versions where id = pg_temp.id('rv', 1)) = '[]'::jsonb);
select pg_temp.chk('1b a judge cannot open a correction (COMP_FORBIDDEN) and the F2 RPC takes no cause parameter',
  pg_temp.code(pg_temp.open_corr(1, 11)) = 'COMP_FORBIDDEN'
  and (select array_to_string(proargnames, ',') from pg_proc where oid = 'public.open_competition_round_correction(uuid,text,uuid)'::regprocedure) = 'p_round_id,p_reason,p_request_id');
select pg_temp.chk('1c a manager opens the correction', pg_temp.code(pg_temp.open_corr(1)) = 'OK');
select pg_temp.chk('1d cause = entry_exclusion, X = {entry 3}, baseline = the approved version, opener, reason, request id, transaction id recorded',
  (select c.cause = 'entry_exclusion' and c.excluded_entry_ids = array[pg_temp.id('ent', 1, 3)] and c.baseline_version_id = pg_temp.id('rv', 1)
          and c.opened_by = pg_temp.id('user', 1) and c.reason = 'correcting the callback' and c.request_id = pg_temp.id('creq', 1, 1)
          and c.transaction_id is not null and c.event_id = pg_temp.id('evt', 1) from (select (pg_temp.cause(1)).*) c));
select pg_temp.chk('1e round is ballots_locked with correction_open', (select status = 'ballots_locked' and correction_open from public.event_competition_rounds where id = pg_temp.id('src', 1)));

-- S2: nothing excluded -> judge_entry_error.
select pg_temp.mk(2); select pg_temp.v1(2); select pg_temp.approve_state(2);
select pg_temp.open_corr(2);
select pg_temp.chk('2a no new exclusion -> judge_entry_error with an empty set', true
  and (select c.cause = 'judge_entry_error' and cardinality(c.excluded_entry_ids) = 0 from (select (pg_temp.cause(2)).*) c));

-- S3: an exclusion already in the baseline plus a new one -> only the new one counts, cause entry_exclusion.
select pg_temp.mk(3); select pg_temp.v1(3); select pg_temp.scratch(3, 8); select pg_temp.approve_state(3); select pg_temp.scratch(3, 3);
select pg_temp.open_corr(3);
select pg_temp.chk('3a baseline exclusion (entry 8) is not part of X; the new one (entry 3) is',
  (select c.cause = 'entry_exclusion' and c.excluded_entry_ids = array[pg_temp.id('ent', 3, 3)] from (select (pg_temp.cause(3)).*) c));

-- S4: opened from calculated (no approved version) -> baseline is the calculated version.
select pg_temp.mk(4); select pg_temp.v1(4); select pg_temp.approve_state(4, 'calculated'); select pg_temp.scratch(4, 2);
select pg_temp.open_corr(4);
select pg_temp.chk('4a a correction opened from calculated derives the cause from the calculated version',
  (select c.cause = 'entry_exclusion' and c.baseline_version_id = pg_temp.id('rv', 4) from (select (pg_temp.cause(4)).*) c));

-- S5: a no-show-free, ordinary replay: the same open request is a replay and writes no second cause.
select pg_temp.chk('5a replaying the open request writes no second cause row', pg_temp.open_corr(2) ->> 'replayed' = 'true'
  and (select count(*) from public.event_competition_correction_causes where round_id = pg_temp.id('src', 2)) = 1);

-- 6: no audit row / no version -> COMP_CORRECTION_CAUSE_REQUIRED (the trigger is ENABLE ALWAYS, so replica does not skip it)
select pg_temp.mk(6); select pg_temp.v1(6);
select pg_temp.su(format($q$update public.event_competition_rounds set status = 'approved' where id = %L$q$, pg_temp.id('src', 6)));
select pg_temp.expect_msg('6a the status edge without its audit row cannot record a cause', format($q$select pg_temp.su(%L)$q$,
  format($s$update public.event_competition_rounds set status = 'ballots_locked', correction_open = true where id = %L$s$, pg_temp.id('src', 6))), 'COMP_CORRECTION_CAUSE_REQUIRED');

-- ============================================================================
-- 2. Option R (S1: X = {3}; J11 {1,2,3} and J13 {1,3,4} hold entry 3, J12 {1,2,4} does not)
-- ============================================================================
select pg_temp.chk('R0 round entries now exclude the scratched entry', not (pg_temp.id('ent', 1, 3) = any (public._compe2_round_entries(pg_temp.id('src', 1)))));
select pg_temp.chk('R1 a judge with no excluded pick may not file (COMP_CORRECTION_BALLOT_NOT_PERMITTED)',
  pg_temp.code(pg_temp.file(1, 12, array[1, 2, 5], 'fix')) = 'COMP_CORRECTION_BALLOT_NOT_PERMITTED');
select pg_temp.chk('R2 an extra change (a swap of a non-excluded pick) is refused with the offending entries listed',
  (select pg_temp.code(x) = 'COMP_CORRECTION_BALLOT_RESTRICTED' and (x ->> 'detail')::jsonb -> 'removed_other_picks' = jsonb_build_array(pg_temp.id('ent', 1, 2))
   from (select pg_temp.file(1, 11, array[1, 5, 6], 'fix') x) s));
select pg_temp.chk('R3 keeping the excluded pick is refused', pg_temp.code(pg_temp.file(1, 11, array[1, 2, 3], 'fix')) <> 'OK');
select pg_temp.chk('R4 a replacement that is already picked is refused (the count rule)', pg_temp.code(pg_temp.file(1, 11, array[1, 2], 'fix')) <> 'OK'
  and pg_temp.code(pg_temp.file(1, 11, array[1, 2, 2], 'fix')) <> 'OK');
select pg_temp.chk('R5 nothing was written by the refused attempts',
  (select count(*) from public.event_competition_ballots where round_id = pg_temp.id('src', 1)) = 3
  and (select count(*) from public.event_competition_ballot_corrections where round_id = pg_temp.id('src', 1)) = 0);
select pg_temp.chk('R6 a correction ballot without a reason is refused (E2 rule kept)', pg_temp.code(pg_temp.file(1, 11, array[1, 2, 5])) = 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
select pg_temp.file(1, 11, array[1, 2, 5], 'entry 3 scratched') r7;
select pg_temp.chk('R7 exactly the replacement is accepted', true
  and pg_temp.cur(1, 11) = array[1, 2, 5]);
select pg_temp.chk('R8 the correction record holds original, replacement, reason, actor, time, cause and the diff',
  (select c.original_picks = (select array_agg(pg_temp.id('ent', 1, x) order by pg_temp.id('ent', 1, x)) from unnest(array[1, 2, 3]) x)
          and c.replacement_picks = (select array_agg(pg_temp.id('ent', 1, x) order by pg_temp.id('ent', 1, x)) from unnest(array[1, 2, 5]) x)
          and c.diff = jsonb_build_object('removed', jsonb_build_array(pg_temp.id('ent', 1, 3)), 'added', jsonb_build_array(pg_temp.id('ent', 1, 5)), 'unchanged', 2)
          and c.reason = 'entry 3 scratched' and c.actor = pg_temp.id('user', 11) and c.at is not null and c.cause_id = (pg_temp.cause(1)).id
          and c.official_id = pg_temp.id('off', 11) and c.transaction_id is not null
   from public.event_competition_ballot_corrections c where c.round_id = pg_temp.id('src', 1)));
select pg_temp.chk('R9 a second correction by the same judge is not permitted (the current ballot holds no excluded pick)',
  pg_temp.code(pg_temp.file(1, 11, array[1, 2, 6], 'again')) = 'COMP_CORRECTION_BALLOT_NOT_PERMITTED');
select pg_temp.file(1, 13, array[1, 4, 6], 'entry 3 scratched', pg_temp.id('rq', 1, 13)) r10;
select pg_temp.chk('R10 the same request id replays without a second correction row',
  true
  and (select (pg_temp.file(1, 13, array[1, 4, 6], 'entry 3 scratched', pg_temp.id('rq', 1, 13))) ->> 'replayed') = 'true'
  and (select count(*) from public.event_competition_ballot_corrections where round_id = pg_temp.id('src', 1)) = 2);
select pg_temp.chk('R11 a first ballot (a judge with no current ballot) cannot be filed during a correction',
  pg_temp.code(pg_temp.file(1, 14, array[1, 2, 4], 'late')) <> 'OK');

-- the public RPC reaches the same rule (judge 12 through submit_competition_ballot)
select pg_temp.chk('R12 submit_competition_ballot applies the rule (judge 12 holds no excluded pick)',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 12), format($q$select public.submit_competition_ballot(%L, null, %L::jsonb, gen_random_uuid(), 'x')$q$,
     pg_temp.id('src', 1), pg_temp.mk_marks(1, array[1, 2, 5])))) = 'COMP_CORRECTION_BALLOT_NOT_PERMITTED');

-- non-callback ballots and a round outside a correction are untouched
select pg_temp.mk(7, array[11, 12, 13], 'ordinal_majority');
select pg_temp.su(format($q$update public.event_competition_rounds set correction_open = true, status = 'ballots_locked' where id = %L$q$, pg_temp.id('src', 7)));
select pg_temp.chk('R13 the check returns null for a non-callback round even with correction_open',
  public._cf1_check_correction_ballot(pg_temp.id('src', 7), pg_temp.id('off', 11), null, '[]'::jsonb, pg_temp.id('user', 11), null) is null);
select pg_temp.mk(8); select pg_temp.v1(8);
select pg_temp.chk('R14 an active round is unchanged: a free re-pick with a reason is accepted and writes no correction row',
  pg_temp.code(pg_temp.file(8, 11, array[5, 6, 7], 'changed my mind')) = 'OK'
  and not exists (select 1 from public.event_competition_ballot_corrections where round_id = pg_temp.id('src', 8)));

-- ============================================================================
-- 3. Option F (S2: judge_entry_error, opener = user 1)
-- ============================================================================
select pg_temp.chk('F1 a replacement ballot is refused without a co-sign', pg_temp.code(pg_temp.file(2, 11, array[5, 6, 7], 'entry error')) = 'COMP_CORRECTION_COSIGN_REQUIRED');
select pg_temp.chk('F2 the opener cannot co-sign',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(2)).id))) = 'COMP_CORRECTION_COSIGN_SAME_PERSON');
select pg_temp.chk('F3 a judge, an unrelated user and anon cannot co-sign (COMP_FORBIDDEN)',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 12), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(2)).id))) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 9), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(2)).id))) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 9), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, pg_temp.id('nope')))) = 'COMP_FORBIDDEN');
select pg_temp.chk('F4 a missing request id is refused',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.cosign_competition_correction(%L, null)$q$, (pg_temp.cause(2)).id))) = 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(2)).id, pg_temp.id('cs', 2))) f5;
select pg_temp.chk('F5 the chair co-signs; the role is recorded as chair',
  true
  and (select s.role = 'chair' and s.cosigned_by = pg_temp.id('user', 4) and s.request_id = pg_temp.id('cs', 2) and s.transaction_id is not null and s.at is not null
       from public.event_competition_correction_cosigns s where s.cause_id = (pg_temp.cause(2)).id));
select pg_temp.chk('F6 replaying the co-sign returns replayed; reusing the request id elsewhere is refused; a second co-sign is refused',
  pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(2)).id, pg_temp.id('cs', 2))) ->> 'replayed' = 'true'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 2), format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(2)).id, pg_temp.id('cs', 2)))) = 'COMP_REQUEST_REUSED'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 2), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(2)).id))) = 'COMP_CORRECTION_ALREADY_COSIGNED');
select pg_temp.file(2, 11, array[5, 6, 7], 'entry error') f7;
select pg_temp.chk('F7 after the co-sign any valid ballot is accepted (full re-pick) and the diff is stored',
  true
  and (select c.diff ->> 'unchanged' = '0' and jsonb_array_length(c.diff -> 'removed') = 3 and jsonb_array_length(c.diff -> 'added') = 3
       from public.event_competition_ballot_corrections c where c.round_id = pg_temp.id('src', 2)));

-- S9: a judge who is a manager (user 14) co-signs, then cannot file; and the opposite order
select pg_temp.mk(9, array[11, 12, 14]); select pg_temp.v1(9);
select pg_temp.file(9, 14, array[1, 3, 4]);
select pg_temp.approve_state(9); select pg_temp.open_corr(9);
select pg_temp.chk('F9 setup: judge_entry_error cause on scenario 9', (pg_temp.cause(9)).cause = 'judge_entry_error');
select pg_temp.chk('F10 user 14 (judge + manager) co-signs', pg_temp.code(pg_temp.run_as(pg_temp.id('user', 14),
  format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(9)).id, pg_temp.id('cs', 9)))) = 'OK');
select pg_temp.chk('F11 the co-signer is then refused as a filer (COMP_CORRECTION_COSIGNER_CONFLICT); another judge may file',
  pg_temp.code(pg_temp.file(9, 14, array[5, 6, 7], 'r')) = 'COMP_CORRECTION_COSIGNER_CONFLICT'
  and pg_temp.code(pg_temp.file(9, 11, array[5, 6, 7], 'r')) = 'OK');
select pg_temp.chk('F12 a scorer-style filing (actor = co-signer, judge 12) is refused too',
  pg_temp.code(pg_temp.file(9, 12, array[5, 6, 7], 'r', gen_random_uuid(), 14)) = 'COMP_CORRECTION_COSIGNER_CONFLICT');

-- S10: the co-sign of an entry_exclusion cause is not required/allowed; a closed correction cannot be co-signed
select pg_temp.chk('F13 a co-sign of an entry_exclusion cause is refused', pg_temp.code(pg_temp.run_as(pg_temp.id('user', 2),
  format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(1)).id))) = 'COMP_CORRECTION_COSIGN_NOT_REQUIRED');
select pg_temp.expect_msg('F14 direct insert: the opener as co-signer is refused by the guard trigger', format($q$insert into public.event_competition_correction_cosigns (event_id, cause_id, cosigned_by, role, request_id) values (%L, %L, %L, 'manager', gen_random_uuid())$q$,
  pg_temp.id('evt', 1), (pg_temp.cause(1)).id, pg_temp.id('user', 1)), 'COMP_CORRECTION_COSIGN_NOT_REQUIRED');

-- ============================================================================
-- 4. Mid-correction exclusions (design 4.1 vs 4.6 route 4): the live set restricts a judge_entry_error correction too
-- ============================================================================
select pg_temp.mk(10); select pg_temp.v1(10); select pg_temp.approve_state(10); select pg_temp.open_corr(10);
select pg_temp.chk('M0 setup: S10 is a judge_entry_error correction', (pg_temp.cause(10)).cause = 'judge_entry_error');
-- an A5-shaped co-signed exclusion row of entry 3 written after the correction opened
alter table public.event_competition_round_exclusions disable trigger cf1_a7_guard_exclusion_during_correction;
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq)
  values (%L, %L, %L, %L, 'exclude_requested', 'ineligible', 'became ineligible', %L, 'manager', %L, 1)$q$,
  pg_temp.id('exr', 10), pg_temp.id('evt', 1), pg_temp.id('src', 10), pg_temp.id('ent', 10, 3), pg_temp.id('user', 1), pg_temp.id('exq', 10)));
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
  values (%L, %L, %L, %L, 'exclude_cosigned', 'ineligible', 'became ineligible', %L, 'chair', %L, 2, %L)$q$,
  pg_temp.id('exc', 10), pg_temp.id('evt', 1), pg_temp.id('src', 10), pg_temp.id('ent', 10, 3), pg_temp.id('user', 2), pg_temp.id('exq2', 10), pg_temp.id('exr', 10)));
alter table public.event_competition_round_exclusions enable trigger cf1_a7_guard_exclusion_during_correction; alter table public.event_competition_round_exclusions enable always trigger cf1_a7_guard_exclusion_during_correction;
select pg_temp.chk('M1 the live restricted set is {entry 3}', public._cf1_a7_new_exclusions(pg_temp.id('src', 10), (pg_temp.cause(10)).baseline_version_id) = array[pg_temp.id('ent', 10, 3)]);
select pg_temp.chk('M2 a free re-pick is now refused even though the cause row says judge_entry_error',
  pg_temp.code(pg_temp.file(10, 11, array[5, 6, 7], 'r')) in ('COMP_CORRECTION_BALLOT_RESTRICTED', 'COMP_CORRECTION_BALLOT_NOT_PERMITTED'));
select pg_temp.chk('M3 exactly the replacement is accepted without any co-sign', pg_temp.code(pg_temp.file(10, 11, array[1, 2, 5], 'entry 3 excluded')) = 'OK');
select pg_temp.chk('M4 a filer of a replacement ballot cannot then co-sign (COMP_CORRECTION_COSIGNER_FILED_BALLOT) -- user 11 is not a manager here, so the refusal is COMP_FORBIDDEN',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 11), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(10)).id))) in ('COMP_FORBIDDEN', 'COMP_CORRECTION_COSIGNER_FILED_BALLOT'));
set constraints all immediate;
set constraints all deferred;
-- reversing the exclusion empties the set: nothing may change
alter table public.event_competition_round_exclusions disable trigger cf1_a7_guard_exclusion_during_correction;
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, reverses_id)
  values (%L, %L, %L, %L, 'reverse_requested', 'ineligible', 'cause fixed', %L, 'manager', %L, 3, %L)$q$,
  pg_temp.id('exv', 10), pg_temp.id('evt', 1), pg_temp.id('src', 10), pg_temp.id('ent', 10, 3), pg_temp.id('user', 1), pg_temp.id('exq3', 10), pg_temp.id('exc', 10)));
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id)
  values (%L, %L, %L, %L, 'reverse_cosigned', 'ineligible', 'cause fixed', %L, 'chair', %L, 4, %L, %L)$q$,
  pg_temp.id('exw', 10), pg_temp.id('evt', 1), pg_temp.id('src', 10), pg_temp.id('ent', 10, 3), pg_temp.id('user', 2), pg_temp.id('exq4', 10), pg_temp.id('exv', 10), pg_temp.id('exc', 10)));
alter table public.event_competition_round_exclusions enable trigger cf1_a7_guard_exclusion_during_correction; alter table public.event_competition_round_exclusions enable always trigger cf1_a7_guard_exclusion_during_correction;
select pg_temp.chk('M5 after the reversal the live set is empty and the cause is judge_entry_error again: the co-sign rule applies',
  public._cf1_a7_new_exclusions(pg_temp.id('src', 10), (pg_temp.cause(10)).baseline_version_id) = '{}'::uuid[]
  and pg_temp.code(pg_temp.file(10, 12, array[5, 6, 7], 'r')) = 'COMP_CORRECTION_COSIGN_REQUIRED');

-- an entry_exclusion cause whose exclusion is reversed during the correction: fail closed
select pg_temp.mk(11); select pg_temp.v1(11); select pg_temp.approve_state(11);
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L, %L, %L, %L, 'exclude_requested', 'refunded', 'refunded entry', %L, 'manager', %L, 1)$q$,
  pg_temp.id('exr', 11), pg_temp.id('evt', 1), pg_temp.id('src', 11), pg_temp.id('ent', 11, 3), pg_temp.id('user', 1), pg_temp.id('exq', 11)));
select pg_temp.su(format($q$insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id) values (%L, %L, %L, %L, 'exclude_cosigned', 'refunded', 'refunded entry', %L, 'chair', %L, 2, %L)$q$,
  pg_temp.id('exc', 11), pg_temp.id('evt', 1), pg_temp.id('src', 11), pg_temp.id('ent', 11, 3), pg_temp.id('user', 2), pg_temp.id('exq2', 11), pg_temp.id('exr', 11)));
select pg_temp.su(format($q$update public.event_competition_result_versions set input = public._compf2_evidence(%L, 'callback_tally', '1') where id = %L$q$, pg_temp.id('src', 11), pg_temp.id('rv', 11)));
select pg_temp.open_corr(11);
select pg_temp.chk('M7 the baseline already holds entry 3 -> judge_entry_error', (pg_temp.cause(11)).cause = 'judge_entry_error' and cardinality((pg_temp.cause(11)).excluded_entry_ids) = 0);

-- ============================================================================
-- 5. Commit-time backstops (set constraints immediate inside a probe)
-- ============================================================================
-- S12: a correction round; insert a replacement ballot and its marks directly (bypassing the RPC and the check).
select pg_temp.mk(12); select pg_temp.v1(12); select pg_temp.approve_state(12); select pg_temp.scratch(12, 3); select pg_temp.open_corr(12);
create or replace function pg_temp.direct_ballot(p_n int, p_judge int, p_nums int[], p_with_record boolean, p_check boolean default true) returns text
language plpgsql security definer as $$
declare
  v_prior public.event_competition_ballots;
  v_new uuid := gen_random_uuid();
  v_msg text;
begin
  select * into v_prior from public.event_competition_ballots b where b.round_id = pg_temp.id('src', p_n) and b.official_id = pg_temp.id('off', p_judge)
    and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id);
  begin
    insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
    values (v_new, v_prior.event_id, v_prior.round_id, null, v_prior.official_id, 'callback_yes', 1, v_prior.version + 1, 'judge_web', pg_temp.id('user', p_judge), v_prior.id, 'direct');
    insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark)
    select v_prior.event_id, v_new, pg_temp.id('ent', p_n, x), 'true'::jsonb from unnest(p_nums) x;
    if p_with_record then
      perform public._cf1_record_ballot_correction(v_new, (pg_temp.cause(p_n)).id, pg_temp.id('user', p_judge), 'direct', gen_random_uuid());
    end if;
    set constraints all immediate;
    v_msg := 'accepted';
  exception when others then
    v_msg := sqlerrm;
  end;
  return v_msg;
end $$;
select pg_temp.chk('B1 a direct ballot without its correction record is rejected at commit', pg_temp.direct_ballot(12, 11, array[1, 2, 5], false) like 'COMP_CORRECTION_BALLOT_UNRECORDED%');
select pg_temp.chk('B2 a direct ballot with a record but breaking Option R (extra change) is rejected at commit',
  pg_temp.direct_ballot(12, 11, array[1, 5, 6], true) like 'COMP_CORRECTION_BALLOT_RESTRICTED%');
select pg_temp.chk('B3 a direct ballot that follows the rule is accepted', pg_temp.direct_ballot(12, 11, array[1, 2, 5], true) = 'accepted');
select pg_temp.mk(13); select pg_temp.v1(13); select pg_temp.approve_state(13); select pg_temp.open_corr(13);
select pg_temp.chk('B5 a direct free re-pick without a co-sign is rejected at commit (judge_entry_error)',
  pg_temp.direct_ballot(13, 11, array[5, 6, 7], true) like 'COMP_CORRECTION_COSIGN_REQUIRED%');

-- ============================================================================
-- 4b. A7-1: no exclusion decision while a correction is open (strict design 4.1 rule)
-- ============================================================================
-- S16 correction is open with entry 5 ineligible (so A5's own checks pass and only the A7 guard can refuse).
select pg_temp.mk(16); select pg_temp.v1(16); select pg_temp.approve_state(16); select pg_temp.open_corr(16);
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'ineligible' where id = %L$q$, pg_temp.id('ent', 16, 5)));
select pg_temp.chk('X1 the A5 request is refused with the stable code while the correction is open',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.request_round_exclusion(%L, %L, 'ineligible', 'became ineligible', gen_random_uuid())$q$,
    pg_temp.id('src', 16), pg_temp.id('ent', 16, 5)))) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION');
select pg_temp.chk('X2 every kind of direct insert is refused too (request, co-sign, reversal request, reversal co-sign)',
  (select bool_and(pg_temp.catch(format($q$insert into public.event_competition_round_exclusions (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id)
     values (%L, %L, %L, %L, 'ineligible', 'direct insert test', %L, 'manager', gen_random_uuid(), %s, null, null)$q$,
     pg_temp.id('evt', 1), pg_temp.id('src', 16), pg_temp.id('ent', 16, 5), k.kind, pg_temp.id('user', 1), k.n)) like 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION%')
   from (values ('exclude_requested', 1), ('exclude_cosigned', 2), ('reverse_requested', 3), ('reverse_cosigned', 4)) k(kind, n)));
select pg_temp.chk('X3 nothing was written by the refused attempts', not exists (select 1 from public.event_competition_round_exclusions where round_id = pg_temp.id('src', 16)));
-- no correction open: A5's documented request / co-sign flow is intact (round 17 active, entry 5 ineligible)
select pg_temp.mk(17); select pg_temp.v1(17);
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'ineligible' where id = %L$q$, pg_temp.id('ent', 17, 5)));
select pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.request_round_exclusion(%L, %L, 'ineligible', 'became ineligible', %L)$q$,
    pg_temp.id('src', 17), pg_temp.id('ent', 17, 5), pg_temp.id('xq', 17))) x4;
select pg_temp.chk('X4 with no correction open the A5 request is accepted', exists (select 1 from public.event_competition_round_exclusions where round_id = pg_temp.id('src', 17) and kind = 'exclude_requested'));
select pg_temp.run_as(pg_temp.id('user', 2), format($q$select public.cosign_round_exclusion(%L, %L)$q$,
    (select id from public.event_competition_round_exclusions where round_id = pg_temp.id('src', 17) and kind = 'exclude_requested'), pg_temp.id('xq2', 17))) x5;
select pg_temp.chk('X5 ... and the A5 co-sign is accepted (takes effect)', exists (select 1 from public.event_competition_round_exclusions where round_id = pg_temp.id('src', 17) and kind = 'exclude_cosigned'));
-- after the correction closes (recalculation clears correction_open) an exclusion is accepted again (fixture: flag cleared the way F2 does)
select pg_temp.su(format($q$update public.event_competition_rounds set status = 'ballots_locked', correction_open = false where id = %L$q$, pg_temp.id('src', 16)));
select pg_temp.chk('X6 after the correction closes the guard lets the A5 request through',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.request_round_exclusion(%L, %L, 'ineligible', 'became ineligible', gen_random_uuid())$q$,
    pg_temp.id('src', 16), pg_temp.id('ent', 16, 5)))) = 'OK');

-- ============================================================================
-- 4c. A7-2: the opener never files the replacement ballot (user 14 is a manager AND a panel judge)
-- ============================================================================
select pg_temp.mk(18, array[11, 12, 14]);
select pg_temp.file(18, 11, array[1, 2, 3]); select pg_temp.file(18, 12, array[1, 2, 4]); select pg_temp.file(18, 14, array[1, 3, 4]);
select pg_temp.approve_state(18); select pg_temp.scratch(18, 3); select pg_temp.open_corr(18, 14);
select pg_temp.chk('O1 setup: user 14 opened an entry_exclusion correction', (pg_temp.cause(18)).opened_by = pg_temp.id('user', 14) and (pg_temp.cause(18)).cause = 'entry_exclusion');
select pg_temp.chk('O2 Option R: the opener (judge 14, holds the excluded pick) is refused as filer; judge 11 may file',
  pg_temp.code(pg_temp.file(18, 14, array[1, 4, 5], 'r')) = 'COMP_CORRECTION_OPENER_CONFLICT'
  and pg_temp.code(pg_temp.file(18, 11, array[1, 2, 5], 'r')) = 'OK');
select pg_temp.chk('O3 the opener cannot file through an entering scorer either (actor = scorer, judge = opener)',
  pg_temp.code(pg_temp.file(18, 14, array[1, 4, 5], 'r', gen_random_uuid(), 11)) = 'COMP_CORRECTION_OPENER_CONFLICT');
select pg_temp.chk('O4 the commit-time backstop rejects a direct opener ballot', pg_temp.direct_ballot(18, 14, array[1, 4, 5], true) like 'COMP_CORRECTION_OPENER_CONFLICT%');
select pg_temp.mk(19, array[11, 12, 14]);
select pg_temp.file(19, 11, array[1, 2, 3]); select pg_temp.file(19, 12, array[1, 2, 4]); select pg_temp.file(19, 14, array[1, 3, 4]);
select pg_temp.approve_state(19); select pg_temp.open_corr(19, 14);
select pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(19)).id, pg_temp.id('cs', 19))) o5;
select pg_temp.chk('O5 Option F, co-signed by another manager: the opener is still refused; another judge may file',
  pg_temp.code(pg_temp.file(19, 14, array[5, 6, 7], 'r')) = 'COMP_CORRECTION_OPENER_CONFLICT'
  and pg_temp.code(pg_temp.file(19, 11, array[5, 6, 7], 'r')) = 'OK');

-- ============================================================================
-- 6. Immutability, privileges, pins, event deletion
-- ============================================================================
select pg_temp.expect_msg('I1 UPDATE of a cause is refused', format($q$update public.event_competition_correction_causes set reason = 'x' where id = %L$q$, (pg_temp.cause(1)).id), 'append-only');
select pg_temp.expect_msg('I2 DELETE of a cause is refused', format($q$delete from public.event_competition_correction_causes where id = %L$q$, (pg_temp.cause(1)).id), 'append-only');
set constraints all immediate;
set constraints all deferred;
select pg_temp.expect_msg('I3 TRUNCATE of the correction records is refused', $q$truncate public.event_competition_ballot_corrections$q$, 'append-only');
select pg_temp.expect_msg('I4 UPDATE of a co-sign is refused', format($q$update public.event_competition_correction_cosigns set role = 'manager' where cause_id = %L$q$, (pg_temp.cause(2)).id), 'append-only');
select pg_temp.expect_msg('I5 UPDATE of a correction record is refused even with session_replication_role = replica',
  format($q$select pg_temp.su(%L)$q$, format($s$update public.event_competition_ballot_corrections set reason = 'x' where round_id = %L$s$, pg_temp.id('src', 1))), 'append-only');
select pg_temp.chk('I6 the A7 triggers are ENABLE ALWAYS (and the six history triggers)',
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'A'
     and (t.tgname like 'cf1_a7_%' or t.tgname like 'protect_event_competition_correction_%' or t.tgname like 'protect_event_competition_ballot_corrections_%')) = 11);
select pg_temp.chk('P1 the new tables have RLS on, no policies and no grants for anon / authenticated / service_role',
  (select bool_and(c.relrowsecurity) from pg_class c where c.relname in ('event_competition_correction_causes', 'event_competition_correction_cosigns', 'event_competition_ballot_corrections') and c.relnamespace = 'public'::regnamespace)
  and not exists (select 1 from pg_policies where tablename in ('event_competition_correction_causes', 'event_competition_correction_cosigns', 'event_competition_ballot_corrections'))
  and not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
                  and g.table_name in ('event_competition_correction_causes', 'event_competition_correction_cosigns', 'event_competition_ballot_corrections')));
select pg_temp.chk('P2 the two RPCs are executable by authenticated only; every internal function by nobody',
  has_function_privilege('authenticated', 'public.cosign_competition_correction(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.competition_round_correction(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cosign_competition_correction(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.cosign_competition_correction(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.competition_round_correction(uuid)', 'execute')
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                  and (p.proname like '\_cf1\_a7\_%' or p.proname in ('_cf1_check_correction_ballot', '_cf1_record_ballot_correction', 'cf1_a7_record_correction_cause',
                       'cf1_a7_guard_cosign_insert', 'cf1_a7_backstop_ballot', 'cf1_a7_backstop_correction', 'cf1_a7_guard_exclusion_during_correction'))
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))));
select pg_temp.chk('P3 all A7 functions are SECURITY DEFINER with search_path = public, pg_temp',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and (p.proname like '\_cf1\_a7\_%' or p.proname in ('_cf1_check_correction_ballot', '_cf1_record_ballot_correction', 'cosign_competition_correction', 'competition_round_correction'))
              and p.proname <> '_cf1_a7_excluded_set'
              and (not p.prosecdef or p.proconfig is null or not (p.proconfig::text like '%search_path=public, pg_temp%'))));
select pg_temp.chk('P4 the pinned _compe2_insert_ballot holds each A7 anchor exactly once and keeps the F2 status condition',
  (with d as (select replace(pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure), E'\r', '') t)
   select (length(t) - length(replace(t, '_cf1_check_correction_ballot', ''))) / length('_cf1_check_correction_ballot') = 1
      and (length(t) - length(replace(t, '_cf1_record_ballot_correction', ''))) / length('_cf1_record_ballot_correction') = 1
      and position('correction_open' in t) > 0 from d));
select pg_temp.chk('P5 the pinned post-A7 text of _compe2_insert_ballot',
  md5(replace(pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure), E'\r', '')) = 'e5cecd7b4cff91bbdb7222cc5061b4d9');

-- read side
select pg_temp.chk('Q1 competition_round_correction returns the cause, the live restricted set and the correction ballots to a manager; refuses a judge',
  (pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_correction(%L)$q$, pg_temp.id('src', 1))) -> 'cause' ->> 'cause') = 'entry_exclusion'
  and jsonb_array_length(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_correction(%L)$q$, pg_temp.id('src', 1))) -> 'ballots') = 2
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 11), format($q$select public.competition_round_correction(%L)$q$, pg_temp.id('src', 1)))) = 'COMP_FORBIDDEN');

-- event deletion cascades through the new tables
create or replace function pg_temp.del_event() returns text language plpgsql security definer as $$
begin
  begin
    delete from public.events where id = pg_temp.id('evt', 1);
  exception when others then
    return sqlerrm;
  end;
  return 'deleted';
end $$;
select pg_temp.su(format($q$update public.event_competition_heats set lock_state = 'open' where event_id = %L$q$, pg_temp.id('evt', 1)));
select pg_temp.del_event() as del_result \gset
select pg_temp.chk('E2 event deletion cascades (A7 tables empty afterwards)', :'del_result' = 'deleted'
  and not exists (select 1 from public.event_competition_correction_causes) and not exists (select 1 from public.event_competition_ballot_corrections), :'del_result');

select pg_temp.blocked('two-session races (two judges filing at once; a ballot racing the correction closing; co-sign vs filing)', 'see test_T_competition_cf1_a7_concurrency.sh');

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*), count(*) filter (where status = 'BLOCKED') into v_total, v_blocked from t_results;
  select string_agg(name || ' [' || detail || ']', E'\n  ') into v_failures from t_results where status = 'FAIL';
  if v_failures is null then
    raise exception 'COMPETITION CF1 A7 SQL SUITE PASS (% checks, % blocked: two-session races are in the .sh script)', v_total, v_blocked;
  else
    raise exception 'COMPETITION CF1 A7 SQL SUITE FAIL: %', E'\n  ' || v_failures;
  end if;
end $$;
rollback;
