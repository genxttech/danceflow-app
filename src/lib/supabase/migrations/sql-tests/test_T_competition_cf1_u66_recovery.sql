-- Competition CF1 U66 -- narrow A7 correction recovery (exclusion during an open correction) regression suite.
--
-- Covers 20270120103000_competition_cf1_u66_correction_recovery.sql on top of the chain through HL1, A1, A0, A4a, A2, A3, A5, A6, A7 (and F3 when applied:
-- the current-publication scenario is BLOCKED, never passed, when the F3 table does not exist). Run as a SUPERUSER. One transaction, synthetic fixtures
-- only (md5-derived ids). Fixtures are placed with session_replication_role = replica (the ENABLE ALWAYS CF1 triggers still fire). The final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION CF1 U66 SQL SUITE PASS (<n> checks, <b> blocked ...)"  or  "... FAIL: <failures>".
-- Races (recovery vs publish, vs replacement ballot, vs co-sign, same request id, double recovery) live in test_T_competition_cf1_u66_concurrency.sh.

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
language sql immutable as $$ select md5('cf1u66:' || p_kind || ':' || p_n || ':' || p_k)::uuid $$;
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
select pg_temp.id('user', u), 't-cf1u66-u' || u || '@example.test' from unnest(array[1, 2, 4, 9, 11, 12, 13, 14, 15]) u;
insert into public.profiles (id, email, full_name) select id, email, 'CF1U66 ' || split_part(email, '@', 1) from auth.users where email like 't-cf1u66-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1u66-%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 U66 Studio', 't-cf1u66-a');
insert into public.user_studio_roles (user_id, studio_id, role, active)
select pg_temp.id('user', u), pg_temp.id('studio', 1), 'studio_owner', true from unnest(array[1, 2, 14]) u;
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
select pg_temp.id('evt', e), pg_temp.id('studio', 1), 'CF1 U66 Comp ' || e, 't-cf1u66-e' || e, 'competition', current_date + 30, current_date + 30, 'published', 'public', true
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

-- extra fixtures: user 16 = manager WITHOUT a verified email; user 17 = manager of ANOTHER studio (cross-tenant)
insert into auth.users (id, email) values (pg_temp.id('user', 16), 't-cf1u66-u16@example.test'), (pg_temp.id('user', 17), 't-cf1u66-u17@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.id('user', 16), 't-cf1u66-u16@example.test', 'CF1U66 u16'), (pg_temp.id('user', 17), 't-cf1u66-u17@example.test', 'CF1U66 u17');
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
values (pg_temp.id('user', 17), 't-cf1u66-u17@example.test', now(), now(), 'otp', 'web_callback', 'bound', now());
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 2), 'CF1 U66 Studio B', 't-cf1u66-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.id('user', 16), pg_temp.id('studio', 1), 'studio_owner', true), (pg_temp.id('user', 17), pg_temp.id('studio', 2), 'studio_owner', true);

-- recover as p_user for scenario n, entry k
create or replace function pg_temp.rec(p_n int, p_user int, p_k int, p_kind text default 'ineligible', p_reason text default 'became ineligible after the result was calculated', p_req uuid default null)
returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.recover_correction_for_exclusion(%L, %L, %L, %L, %L)$q$,
    pg_temp.id('src', p_n), pg_temp.id('ent', p_n, p_k), p_kind, p_reason, coalesce(p_req, pg_temp.id('rq', p_n, 100 + p_k))));
end $$;
create or replace function pg_temp.req_excl(p_n int, p_user int, p_k int, p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.request_round_exclusion(%L, %L, 'ineligible', 'became ineligible after the result was calculated', %L)$q$,
    pg_temp.id('src', p_n), pg_temp.id('ent', p_n, p_k), p_req));
end $$;
create or replace function pg_temp.inelig(p_n int, p_k int) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.id('ent', p_n, p_k);
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.rstate(p_n int) returns text language sql stable security definer as $$
  select status || ':' || correction_open::text from public.event_competition_rounds where id = pg_temp.id('src', p_n) $$;
create or replace function pg_temp.cnt(p_what text, p_n int) returns bigint language plpgsql stable security definer as $$
declare r bigint;
begin
  execute case p_what
    when 'cause' then 'select count(*) from public.event_competition_correction_causes where round_id = $1'
    when 'events' then 'select count(*) from public.event_competition_result_events where round_id = $1'
    when 'u66' then 'select count(*) from public.event_competition_result_events where round_id = $1 and refs ->> ''u66_recovery'' = ''true'''
    when 'excl' then 'select count(*) from public.event_competition_round_exclusions where round_id = $1'
    when 'ballots' then 'select count(*) from public.event_competition_ballots where round_id = $1'
    when 'inval' then 'select count(*) from public.event_competition_result_events where round_id = $1 and kind = ''result_invalidated'''
    when 'versions' then 'select count(*) from public.event_competition_result_versions where round_id = $1' end
    into r using pg_temp.id('src', p_n);
  return r;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- 0. Surface
-- ============================================================================
select pg_temp.chk('0a the RPC and the read exist; the helper and the trigger function have no API grants',
  to_regprocedure('public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)') is not null
  and to_regprocedure('public.competition_round_correction_recovery(uuid)') is not null
  and has_function_privilege('authenticated', 'public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.competition_round_correction_recovery(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.competition_round_correction_recovery(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_u66_blockers(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.cf1_u66_clear_correction_open()', 'execute')
  and not has_function_privilege('anon', 'public.cf1_u66_clear_correction_open()', 'execute'));
select pg_temp.chk('0b the clear trigger is ENABLE ALWAYS, BEFORE UPDATE OF correction_open, and the A7 exclusion guard is untouched and still ENABLE ALWAYS',
  (select count(*) = 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'zz_cf1_u66_clear_correction_open' and t.tgenabled = 'A' and t.tgtype & 2 = 2)
  and (select count(*) = 1 from pg_trigger t where t.tgrelid = 'public.event_competition_round_exclusions'::regclass and t.tgname = 'cf1_a7_guard_exclusion_during_correction' and t.tgenabled = 'A')
  and position('COMP_CORRECTION_EXCLUSION_DURING_CORRECTION' in pg_get_functiondef('public.cf1_a7_guard_exclusion_during_correction()'::regprocedure)) > 0
  and position('u66' in pg_get_functiondef('public.cf1_a7_guard_exclusion_during_correction()'::regprocedure)) = 0);
select pg_temp.chk('0c no BEFORE UPDATE trigger on event_competition_rounds fires after the U66 trigger (the fire order is by name; C locale)',
  not exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and not t.tgisinternal and t.tgtype & 2 = 2 and t.tgtype & 16 = 16
              and (t.tgname collate "C") > ('zz_cf1_u66_clear_correction_open' collate "C")));

-- ============================================================================
-- 1. The deadlock and its recovery (S1: judge_entry_error correction, then a couple becomes ineligible)
-- ============================================================================
select pg_temp.mk(1); select pg_temp.v1(1); select pg_temp.approve_state(1); select pg_temp.open_corr(1);
select pg_temp.chk('1a setup: S1 is an open judge_entry_error correction', (pg_temp.cause(1)).cause = 'judge_entry_error' and pg_temp.rstate(1) = 'ballots_locked:true');
select pg_temp.inelig(1, 3);
select pg_temp.chk('1b the deadlock: the normal exclusion request is refused while the correction is open (A7 guard unchanged)',
  pg_temp.code(pg_temp.req_excl(1, 2, 3)) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION');
select pg_temp.chk('1c the recovery read says eligible with no blockers to a manager and to the chair',
  (pg_temp.run_as(pg_temp.id('user', 2), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 1))) ->> 'eligible')::boolean
  and (pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 1))) -> 'blockers') = '[]'::jsonb);
select pg_temp.chk('1d the recovery read is refused to a judge, a stranger and another studio, and to anon',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 12), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 1)))) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 9), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 1)))) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 17), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 1)))) = 'COMP_FORBIDDEN');

-- authorization (every refusal leaves the correction open and writes nothing)
create temp table t_s1_before as
select (select count(*) from public.event_competition_result_events where round_id = pg_temp.id('src', 1)) ev, pg_temp.cnt('excl', 1) ex, pg_temp.cnt('cause', 1) ca, pg_temp.cnt('inval', 1) iv;
grant all on t_s1_before to authenticated, anon, service_role;
create temp table t_s1_events as select id from public.event_competition_result_events where round_id = pg_temp.id('src', 1);
grant all on t_s1_events to authenticated, anon, service_role;
select pg_temp.chk('1e authorization: a judge, a chair, a stranger, a manager of another studio and an unverified manager are all refused',
  pg_temp.code(pg_temp.rec(1, 12, 3)) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.rec(1, 4, 3)) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.rec(1, 9, 3)) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.rec(1, 17, 3)) = 'COMP_FORBIDDEN'
  and pg_temp.code(pg_temp.rec(1, 16, 3)) = 'COMP_VERIFIED_EMAIL_REQUIRED');
select pg_temp.expect_msg('1f anon cannot call it', format($q$set local role anon; select public.recover_correction_for_exclusion(%L, %L, 'ineligible', 'because reasons', gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.id('ent', 1, 3)), 'permission denied');
select pg_temp.chk('1g validation: missing request id, bad reason kind, short reason are refused',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.recover_correction_for_exclusion(%L, %L, 'ineligible', 'because reasons', null)$q$, pg_temp.id('src', 1), pg_temp.id('ent', 1, 3)))) = 'COMP_REQUEST_ID_REQUIRED'
  and pg_temp.code(pg_temp.rec(1, 1, 3, 'whatever')) = 'COMP_EXCLUSION_REASON_KIND'
  and pg_temp.code(pg_temp.rec(1, 1, 3, 'ineligible', 'x')) = 'COMP_EXCLUSION_REASON_REQUIRED'
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.recover_correction_for_exclusion(%L, null, 'ineligible', 'because reasons', gen_random_uuid())$q$, pg_temp.id('src', 1)))) = 'COMP_FORBIDDEN');
-- all or nothing: an available couple makes the inner exclusion request fail and the cancellation is rolled back with it
select pg_temp.chk('1h all-or-nothing: recovering for a couple who is still eligible fails (COMP_EXCLUSION_NOT_UNAVAILABLE) and the correction stays open',
  pg_temp.code(pg_temp.rec(1, 1, 5)) = 'COMP_EXCLUSION_NOT_UNAVAILABLE' and pg_temp.rstate(1) = 'ballots_locked:true' and pg_temp.cnt('u66', 1) = 0);
select pg_temp.chk('1i every refusal so far wrote nothing: same events, exclusions, causes; correction still open',
  (select b.ev = (select count(*) from public.event_competition_result_events where round_id = pg_temp.id('src', 1)) and b.ex = pg_temp.cnt('excl', 1) and b.ca = pg_temp.cnt('cause', 1) from t_s1_before b)
  and pg_temp.rstate(1) = 'ballots_locked:true');
-- a direct clear of the flag is not possible (no U66 audit row)
select pg_temp.catch(format($q$update public.event_competition_rounds set correction_open = false where id = %L$q$, pg_temp.id('src', 1)));
select pg_temp.chk('1j the flag cannot be cleared directly, even by a superuser (F2 guard + U66 trigger need the recovery audit row)', pg_temp.rstate(1) = 'ballots_locked:true');
-- the recovery
select pg_temp.rec(1, 1, 3, 'ineligible', 'became ineligible after the result was calculated', pg_temp.id('rq', 1, 1)) as s1_res \gset
select pg_temp.chk('1k the opener (a manager) recovers: the correction is cancelled and the exclusion request is recorded',
  (:'s1_res'::jsonb ->> 'error') is null and (:'s1_res'::jsonb ->> 'correction_cancelled')::boolean and (:'s1_res'::jsonb -> 'exclusion' ->> 'kind') = 'exclude_requested'
  and (:'s1_res'::jsonb ->> 'replayed')::boolean is false, :'s1_res');
select pg_temp.chk('1l the round is a plain ballots_locked round now (correction_open false), the same status, not reopened',
  pg_temp.rstate(1) = 'ballots_locked:false');
select pg_temp.chk('1m audit retention: every earlier audit row is still there; exactly one recovery row (actor, reason, cause, entry); the cause row is unchanged and not deleted',
  not exists (select 1 from t_s1_events o where not exists (select 1 from public.event_competition_result_events e where e.id = o.id))
  and pg_temp.cnt('u66', 1) = 1
  and (select e.actor_user_id = pg_temp.id('user', 1) and e.reason = 'became ineligible after the result was calculated' and e.request_id = pg_temp.id('rq', 1, 1)
              and e.refs ->> 'cause_id' = (pg_temp.cause(1)).id::text and e.refs ->> 'entry_id' = pg_temp.id('ent', 1, 3)::text and e.refs ->> 'cause' = 'judge_entry_error'
              and e.from_state = 'ballots_locked' and e.to_state = 'ballots_locked' and e.kind = 'round_state_changed'
       from public.event_competition_result_events e where e.round_id = pg_temp.id('src', 1) and e.refs ->> 'u66_recovery' = 'true')
  and pg_temp.cnt('cause', 1) = 1 and pg_temp.cnt('inval', 1) = (select iv from t_s1_before)
  and (pg_temp.cause(1)).cause = 'judge_entry_error' and (pg_temp.cause(1)).opened_by = pg_temp.id('user', 1));
select pg_temp.chk('1n the exclusion decision is a normal A5 row (exclude_requested, reason kind, actor, request id) and is not yet in effect',
  (select count(*) = 1 and bool_and(kind = 'exclude_requested' and reason_kind = 'ineligible' and actor = pg_temp.id('user', 1) and request_id = pg_temp.id('rq', 1, 1) and entry_id = pg_temp.id('ent', 1, 3))
   from public.event_competition_round_exclusions where round_id = pg_temp.id('src', 1))
  and not (pg_temp.id('ent', 1, 3) = any (select entry_id from public._cf1_excluded_entries(pg_temp.id('src', 1)))));
select pg_temp.chk('1o replay (same request id, same call): replayed, nothing more written',
  (pg_temp.rec(1, 1, 3, 'ineligible', 'became ineligible after the result was calculated', pg_temp.id('rq', 1, 1)) ->> 'replayed')::boolean
  and pg_temp.cnt('u66', 1) = 1 and pg_temp.cnt('excl', 1) = 1);
select pg_temp.chk('1p the same request id for another entry or another round is a reuse (COMP_REQUEST_REUSED)',
  pg_temp.code(pg_temp.rec(1, 1, 4, 'ineligible', 'became ineligible after the result was calculated', pg_temp.id('rq', 1, 1))) = 'COMP_REQUEST_REUSED'
  and pg_temp.code(pg_temp.rec(1, 2, 3, 'ineligible', 'became ineligible after the result was calculated', pg_temp.id('rq', 1, 1))) = 'COMP_REQUEST_REUSED');
select pg_temp.chk('1q a second recovery on the same (now plain) round is refused: there is no open correction',
  pg_temp.code(pg_temp.rec(1, 1, 3, 'ineligible', 'became ineligible after the result was calculated', pg_temp.id('rq', 1, 2))) = 'COMP_CORRECTION_NOT_OPEN');
-- the ordinary routes carry on: the co-sign of the exclusion (a different manager), then the exclusion is in effect
select pg_temp.run_as(pg_temp.id('user', 2), format($q$select public.cosign_round_exclusion(%L, %L)$q$, (:'s1_res'::jsonb -> 'exclusion' ->> 'exclusion_id')::uuid, pg_temp.id('rq', 1, 3))) as s1_cos \gset
select pg_temp.chk('1r a second manager co-signs the exclusion through the normal A5 route; the couple is excluded and the history holds request, co-sign, audit and cause',
  (:'s1_cos'::jsonb ->> 'error') is null and pg_temp.id('ent', 1, 3) = any (select entry_id from public._cf1_excluded_entries(pg_temp.id('src', 1)))
  and pg_temp.cnt('excl', 1) = 2 and pg_temp.cnt('cause', 1) = 1 and pg_temp.cnt('u66', 1) = 1, :'s1_cos');
select pg_temp.inelig(1, 4);
select pg_temp.chk('1s the ordinary exclusion route now works on this round (a second couple) without the recovery path', pg_temp.code(pg_temp.req_excl(1, 2, 4)) = 'OK');
select pg_temp.chk('1t the cancelled correction left no result version, no ballot and no approval behind: versions and ballots unchanged',
  pg_temp.cnt('versions', 1) = 1 and pg_temp.cnt('ballots', 1) = 3);

-- ============================================================================
-- 2. No general bypass: every other state refuses with the existing code
-- ============================================================================
-- S2: an entry_exclusion correction with a replacement ballot already filed
select pg_temp.mk(2); select pg_temp.v1(2); select pg_temp.approve_state(2); select pg_temp.scratch(2, 3);
select pg_temp.open_corr(2); select pg_temp.inelig(2, 4);
select pg_temp.chk('2a setup: S2 is an entry_exclusion correction', (pg_temp.cause(2)).cause = 'entry_exclusion');
select pg_temp.chk('2b before any replacement ballot the recovery is available', (pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 2))) ->> 'eligible')::boolean);
select pg_temp.chk('2c a replacement ballot is filed under the correction', pg_temp.code(pg_temp.file(2, 11, array[1, 2, 5], 'entry 3 scratched')) = 'OK');
create temp table t_s2_before as select (select count(*) from public.event_competition_result_events where round_id = pg_temp.id('src', 2)) ev, pg_temp.cnt('excl', 2) ex;
grant all on t_s2_before to authenticated, anon, service_role;
select pg_temp.chk('2d with a replacement ballot the recovery is refused with the EXISTING code and names the blocker; the read says not eligible',
  (select pg_temp.code(x) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION' and (x ->> 'error') like '%replacement_ballot%' and (x ->> 'detail')::jsonb -> 'blockers' ? 'replacement_ballot' from (select pg_temp.rec(2, 1, 4) x) s)
  and not (pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 2))) ->> 'eligible')::boolean
  and pg_temp.rstate(2) = 'ballots_locked:true');
select pg_temp.chk('2e the refusal wrote nothing', (select ev = (select count(*) from public.event_competition_result_events where round_id = pg_temp.id('src', 2)) and ex = pg_temp.cnt('excl', 2) from t_s2_before)
  and pg_temp.cnt('u66', 2) = 0);
select pg_temp.chk('2f the plain A5 request is still refused with the A7 code (no bypass through the normal route)', pg_temp.code(pg_temp.req_excl(2, 1, 4)) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION');

select pg_temp.chk('2g after the refused attempts S2 is still in its correction and nothing was cancelled', pg_temp.rstate(2) = 'ballots_locked:true' and pg_temp.cnt('u66', 2) = 0);

-- S3: a judge_entry_error correction that has been co-signed
select pg_temp.mk(3); select pg_temp.v1(3); select pg_temp.approve_state(3); select pg_temp.open_corr(3); select pg_temp.inelig(3, 4);
select pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.cosign_competition_correction(%L, %L)$q$, (pg_temp.cause(3)).id, pg_temp.id('cs', 3)));
select pg_temp.chk('3a a co-signed correction cannot use the recovery path', (select pg_temp.code(x) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION' and (x ->> 'detail')::jsonb -> 'blockers' ? 'cosign' from (select pg_temp.rec(3, 1, 4) x) s)
  and pg_temp.rstate(3) = 'ballots_locked:true' and pg_temp.cnt('u66', 3) = 0);

select pg_temp.chk('3a2 after the refusal S3 is still in its correction and nothing was cancelled', pg_temp.rstate(3) = 'ballots_locked:true' and pg_temp.cnt('u66', 3) = 0);

-- S4: a current publication (F3). The chain without F3 has no publication table: BLOCKED there, never a silent pass.
select pg_temp.mk(4); select pg_temp.v1(4); select pg_temp.approve_state(4); select pg_temp.su(format($q$update public.event_competition_rounds set status = 'published' where id = %L$q$, pg_temp.id('src', 4))); select pg_temp.open_corr(4); select pg_temp.inelig(4, 3);
do $$
declare
  v_res jsonb;
begin
  if to_regclass('public.event_competition_result_publications') is null then
    perform pg_temp.blocked('4a current publication blocks the recovery; a withdrawn one does not', 'F3 (20270122090000) is not applied in this chain; run after F3');
  else
    perform pg_temp.su(format($q$insert into public.event_competition_result_publications (id, event_id, round_id, result_version_id, publication_version, visibility, published_by, request_id)
      values (%L, %L, %L, %L, 1, 'entrants', %L, gen_random_uuid())$q$, pg_temp.id('pub', 4), pg_temp.id('evt', 1), pg_temp.id('src', 4), pg_temp.id('rv', 4), pg_temp.id('user', 1)));
    perform pg_temp.chk('4a with a CURRENT publication the recovery is refused (existing code, blocker current_publication)',
      (select pg_temp.code(x) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION' and (x ->> 'detail')::jsonb -> 'blockers' ? 'current_publication' from (select pg_temp.rec(4, 1, 3) x) s)
      and pg_temp.rstate(4) = 'ballots_locked:true' and pg_temp.cnt('u66', 4) = 0);
    perform pg_temp.su(format($q$update public.event_competition_result_publications set withdrawn_at = now(), withdrawn_by = %L, withdrawn_reason = 'withdrawn first' where id = %L$q$, pg_temp.id('user', 1), pg_temp.id('pub', 4)));
    v_res := pg_temp.rec(4, 1, 3);
    perform pg_temp.chk('4b after the publication is withdrawn the recovery is available and succeeds; the publication row is kept',
      (v_res ->> 'error') is null and (v_res ->> 'correction_cancelled')::boolean
      and pg_temp.rstate(4) = 'ballots_locked:false'
      and exists (select 1 from public.event_competition_result_publications where id = pg_temp.id('pub', 4) and withdrawn_reason = 'withdrawn first'));
  end if;
end $$;

-- S5: states that are not an open correction
select pg_temp.mk(5); select pg_temp.v1(5); select pg_temp.inelig(5, 3);
select pg_temp.chk('5a an active round (no correction) -> COMP_CORRECTION_NOT_OPEN (use the normal request)', pg_temp.code(pg_temp.rec(5, 1, 3)) = 'COMP_CORRECTION_NOT_OPEN');
select pg_temp.approve_state(5);
select pg_temp.chk('5b an approved round (not in a correction) -> COMP_CORRECTION_NOT_OPEN', pg_temp.code(pg_temp.rec(5, 1, 3)) = 'COMP_CORRECTION_NOT_OPEN');
select pg_temp.chk('5c the recovery read on a round without a correction says not eligible with no_open_correction',
  (pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_correction_recovery(%L)$q$, pg_temp.id('src', 5))) -> 'blockers') = '["no_open_correction"]'::jsonb);

-- S6: a live (calculated / approved) result version or any ballot filed since the correction opened
select pg_temp.mk(6); select pg_temp.v1(6); select pg_temp.approve_state(6); select pg_temp.open_corr(6); select pg_temp.inelig(6, 3);
select pg_temp.su(format($q$insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (%L, %L, %L, 2, 'callback_tally', '1', repeat('b', 64), repeat('a', 64), '{}', '[]', %L, 'calculated', %L)$q$, pg_temp.id('rv2', 6), pg_temp.id('evt', 1), pg_temp.id('src', 6), pg_temp.id('user', 1), pg_temp.id('req-rv2', 6)));
select pg_temp.chk('6a a live result version blocks the recovery (fail closed)', (select pg_temp.code(x) = 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION' and (x ->> 'detail')::jsonb -> 'blockers' ? 'live_result_version' from (select pg_temp.rec(6, 1, 3) x) s)
  and pg_temp.rstate(6) = 'ballots_locked:true');
select pg_temp.chk('6a2 after the refusal S6 is still in its correction', pg_temp.rstate(6) = 'ballots_locked:true' and pg_temp.cnt('u66', 6) = 0);
select pg_temp.su(format($q$update public.event_competition_result_versions set status = 'stale' where id = %L$q$, pg_temp.id('rv2', 6)));
select pg_temp.rec(6, 1, 3) as r6b \gset
select pg_temp.chk('6b with the version stale the recovery proceeds', (:'r6b'::jsonb ->> 'error') is null and pg_temp.rstate(6) = 'ballots_locked:false', :'r6b');

-- S7: no wrong-round leakage: a recovery names its own round's entry only
select pg_temp.mk(7); select pg_temp.v1(7); select pg_temp.approve_state(7); select pg_temp.open_corr(7); select pg_temp.inelig(7, 3); select pg_temp.inelig(1, 6);
select pg_temp.chk('7a an entry of another round is refused (inner exclusion check) and the correction stays open',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.recover_correction_for_exclusion(%L, %L, 'ineligible', 'because reasons', gen_random_uuid())$q$, pg_temp.id('src', 7), pg_temp.id('ent', 1, 6)))) in ('COMP_EXCLUSION_ENTRY_NOT_IN_ROUND', 'COMP_FORBIDDEN')
  and pg_temp.rstate(7) = 'ballots_locked:true' and pg_temp.cnt('u66', 7) = 0);
select pg_temp.chk('7b a wrong reason kind (refunded for an ineligible couple) is refused and the correction stays open',
  pg_temp.code(pg_temp.rec(7, 1, 3, 'refunded')) = 'COMP_EXCLUSION_REASON_MISMATCH' and pg_temp.rstate(7) = 'ballots_locked:true');
select pg_temp.chk('7b2 after the refusals S7 is still in its correction and nothing was cancelled', pg_temp.rstate(7) = 'ballots_locked:true' and pg_temp.cnt('u66', 7) = 0 and pg_temp.cnt('excl', 7) = 0);
select pg_temp.rec(7, 1, 3, 'other', 'organizer decision after review') as r7c \gset
select pg_temp.chk('7c reason kind other is accepted for an unavailable couple', (:'r7c'::jsonb ->> 'error') is null and pg_temp.rstate(7) = 'ballots_locked:false', :'r7c');

-- ============================================================================
-- 3. After recovery the round behaves as any plain ballots_locked round; a NEW correction opens a NEW cause
-- ============================================================================
select pg_temp.chk('3a ballots cannot be filed under the cancelled correction (round is ballots_locked, correction closed)',
  pg_temp.code(pg_temp.file(1, 11, array[1, 2, 6], 'late fix')) = 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.chk('3b the A7 co-sign of the cancelled cause is refused (no longer open)',
  pg_temp.code(pg_temp.run_as(pg_temp.id('user', 4), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(1)).id))) = 'COMP_CORRECTION_NOT_OPEN');
select pg_temp.catch(format($q$update public.event_competition_rounds set correction_open = true where id = %L$q$, pg_temp.id('src', 1)));
select pg_temp.chk('3c a direct write of correction_open = true on a plain round does not survive F2''s guard', pg_temp.rstate(1) = 'ballots_locked:false');

-- ============================================================================
-- 4. Immutability of the evidence
-- ============================================================================
select pg_temp.chk('4a the recovery audit row cannot be deleted or changed (append-only history)',
  pg_temp.catch(format($q$delete from public.event_competition_result_events where round_id = %L and refs ->> 'u66_recovery' = 'true'$q$, pg_temp.id('src', 1))) <> 'OK'
  and pg_temp.catch(format($q$update public.event_competition_result_events set reason = 'x' where round_id = %L and refs ->> 'u66_recovery' = 'true'$q$, pg_temp.id('src', 1))) <> 'OK');
select pg_temp.chk('4b the cancelled cause row cannot be deleted or changed',
  pg_temp.catch(format($q$delete from public.event_competition_correction_causes where round_id = %L$q$, pg_temp.id('src', 1))) <> 'OK'
  and pg_temp.catch(format($q$update public.event_competition_correction_causes set reason = 'x' where round_id = %L$q$, pg_temp.id('src', 1))) <> 'OK');

-- ============================================================================
-- 5. INT5-SECFIX P2-1: the recovered round cannot be reopened (E2 reopen) while the recovery is unresolved. Before this fix a lone manager could open a
--    correction, cancel it through U66 (needs only an unavailable danced couple), reopen the ballots and have judges file superseding ballots with
--    none of the A7 correction restrictions (Option R, judge_entry_error co-sign, ballot-correction rows).
-- ============================================================================
create or replace function pg_temp.reopen(p_n int, p_user int, p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.reopen_competition_round_ballots(%L, 'reopen to collect ballots again', %L)$q$, pg_temp.id('src', p_n), p_req));
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;
select pg_temp.mk(8); select pg_temp.v1(8); select pg_temp.approve_state(8); select pg_temp.open_corr(8); select pg_temp.inelig(8, 3);
select pg_temp.rec(8, 1, 3) as r8 \gset
select pg_temp.chk('5a setup: a lone manager opened the correction and recovered it (correction cancelled, plain ballots_locked)',
  (:'r8'::jsonb ->> 'error') is null and pg_temp.rstate(8) = 'ballots_locked:false', :'r8');
select pg_temp.reopen(8, 1) as ro8 \gset
select pg_temp.chk('5b P2-1: E2 reopen of the recovered round is refused (COMP_REOPEN_RECOVERY_PENDING) and the round stays ballots_locked',
  (:'ro8'::jsonb ->> 'error') like 'COMP_REOPEN_RECOVERY_PENDING%' and pg_temp.rstate(8) = 'ballots_locked:false', :'ro8');
select pg_temp.chk('5c P2-1: the lone manager cannot then file a superseding ballot as a judge (round not active), nothing was written',
  pg_temp.code(pg_temp.file(8, 11, array[1, 2, 6], 'late fix')) = 'COMP_BALLOT_ROUND_NOT_ACTIVE' and pg_temp.cnt('ballots', 8) = 3);
select pg_temp.chk('5d P2-1: even a direct status write (superuser) ballots_locked -> active is refused by the trigger (it is ENABLE ALWAYS)',
  pg_temp.catch(format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('src', 8))) like '%COMP_REOPEN_RECOVERY_PENDING%'
  and pg_temp.rstate(8) = 'ballots_locked:false'
  and (select count(*) = 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'cf1_u66_block_reopen' and t.tgenabled = 'A'));
select pg_temp.chk('5e P2-1: the other manager''s reopen is refused the same way, and the refusal wrote nothing (no reopen audit row)',
  pg_temp.code(pg_temp.reopen(8, 2)) = 'COMP_REOPEN_RECOVERY_PENDING'
  and not exists (select 1 from public.event_competition_ballot_events e where e.round_id = pg_temp.id('src', 8) and e.kind = 'round_state_changed' and e.to_state = 'active'));
-- the recovery is resolved by a LATER result_calculated event (the recalculation): fixture event (the suite runs in one transaction, so occurred_at is set explicitly)
select pg_temp.su(format($q$insert into public.event_competition_result_events (event_id, round_id, kind, actor_user_id, from_state, to_state, request_id, refs, occurred_at)
  values (%L, %L, 'result_calculated', %L, 'ballots_locked', 'calculated', gen_random_uuid(), '{}', now() + interval '1 second')$q$, pg_temp.id('evt', 1), pg_temp.id('src', 8), pg_temp.id('user', 1)));
select pg_temp.reopen(8, 1) as ro8f \gset
select pg_temp.chk('5f the block ends once a LATER result_calculated exists for the round (the recovery was resolved by the recalculation)',
  (:'ro8f'::jsonb ->> 'error') is null and pg_temp.rstate(8) = 'active:false', :'ro8f');
-- regression: a plain ballots_locked round that never used the recovery is reopened as before; a recovery on ANOTHER round does not affect it
select pg_temp.mk(9); select pg_temp.v1(9); select pg_temp.su(format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.id('src', 9)));
select pg_temp.reopen(9, 1) as ro9 \gset
select pg_temp.chk('5g regression: a round that never used the recovery still reopens (E2 behaviour unchanged)',
  (:'ro9'::jsonb ->> 'error') is null and pg_temp.rstate(9) = 'active:false', :'ro9');

select pg_temp.blocked('two-session races (recovery vs publish, vs replacement ballot, vs co-sign, same request id, double recovery)', 'see test_T_competition_cf1_u66_concurrency.sh');

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
    raise exception 'COMPETITION CF1 U66 SQL SUITE PASS (% checks, % blocked: two-session races are in the .sh script)', v_total, v_blocked;
  else
    raise exception 'COMPETITION CF1 U66 SQL SUITE FAIL: %', E'\n  ' || v_failures;
  end if;
end $$;
rollback;
