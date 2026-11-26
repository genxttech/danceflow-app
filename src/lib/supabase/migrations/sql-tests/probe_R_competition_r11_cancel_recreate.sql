-- Competition R-11 OBSERVATION probe: can the single-staff override be reached for a corrected result by cancelling the round and running it
-- again as a new round? NOT a pass/fail suite and NOT a fix: it records what the CURRENT lifecycle allows one manager (A1) to do, step by step, and
-- always ends by raising "COMPETITION R11 CANCEL-RECREATE PROBE: ..." with one OK / REFUSED line per step, so nothing persists. Run only as a
-- superuser on a LOCAL QA database, after the migrations under test. Generated from the R-11 suite's helpers (UUID block ...-b11ff4XXXXXX).
--
-- Fixtures (superuser, replica mode where the lifecycle offers no shortcut): division D1 with round r1, division D2 with round r2 AND a second,
-- never-started round r3 (sequence 2) whose heat with the same couples is already in the published running order ("spare round").
-- r1 and r2 are then taken to a corrected, recalculated, never-published state (A1 calculates, A2 approves, A1 corrects, A1 recalculates).
-- EVERY probe step runs as authenticated manager A1 through lifecycle functions or ordinary table writes under RLS. No replica mode in the probe.

begin;
do $tx$
begin
  if now() = statement_timestamp() then
    raise exception 'R11 suite refused: run it inside one explicit transaction (no per-statement autocommit), on a local QA database only';
  end if;
end $tx$;

create or replace function pg_temp.hl1_danced(p_heat uuid) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heats set status = 'complete' where id = p_heat;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on function pg_temp.hl1_danced(uuid) to authenticated, anon, service_role;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- The statement must FAIL and the message must contain the fragment. A statement that unexpectedly succeeds is rolled back (it must not leak state).
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
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
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;

-- Like expect_msg, but the refusal may carry either of two fragments (an ACL refusal or the function's own COMP_FORBIDDEN).
create or replace function pg_temp.expect_msg2(p_name text, p_sql text, p_f1 text, p_f2 text) returns void
language plpgsql as $$
declare v_unexpected boolean := false;
begin
  begin
    execute p_sql; v_unexpected := true; raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_f1) in lower(sqlerrm)) > 0 or position(lower(p_f2) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then insert into t_results values (p_name, false, 'statement unexpectedly succeeded'); end if;
end $$;

create or replace function pg_temp.helper_ok(p text) returns boolean language sql security definer as $$ select public._cf1_reason_is_substantive(p) $$;
create or replace function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-b11ff4' || p_suffix)::uuid $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create or replace function pg_temp.rid(p int) returns uuid language sql immutable as $$ select pg_temp.u('06' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.did(p int) returns uuid language sql immutable as $$ select pg_temp.u('03' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.hid(p int) returns uuid language sql immutable as $$ select pg_temp.u('0d' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.eid(p int, i int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(p::text, 2, '0') || lpad(i::text, 2, '0')) $$;
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;
create or replace function pg_temp.mkr(p int, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.hid(p)) x
$$;
-- The database's own engine result for an evidence document (PV-1's independent calculation). SECURITY DEFINER in pg_temp: the function is not
-- executable by API roles.
create or replace function pg_temp.run_engine(p_ev jsonb) returns jsonb
language sql stable security definer as $$ select public._comppv1_run('ordinal', p_ev) $$;
create or replace function pg_temp.th() returns text language sql immutable as $$ select encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex') $$;
create or replace function pg_temp.vid(p int, p_version int) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_result_versions where round_id = pg_temp.rid(p) and version = p_version
$$;
create or replace function pg_temp.rstatus(p int) returns text
language sql stable security definer as $$ select status from public.event_competition_rounds where id = pg_temp.rid(p) $$;
create or replace function pg_temp.vstatus(p int, p_version int) returns text
language sql stable security definer as $$
  select status from public.event_competition_result_versions where round_id = pg_temp.rid(p) and version = p_version
$$;
create or replace function pg_temp.napprovals(p int) returns bigint
language sql stable security definer as $$
  select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = pg_temp.rid(p)
$$;
create or replace function pg_temp.nevents(p int, p_kind text) returns bigint
language sql stable security definer as $$
  select count(*) from public.event_competition_result_events where round_id = pg_temp.rid(p) and kind = p_kind
$$;
create or replace function pg_temp.calc(p int, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_in jsonb; v_res jsonb;
begin
  v_in := public.competition_round_calculation_input(pg_temp.rid(p));
  v_res := pg_temp.run_engine(v_in -> 'evidence');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'R11 suite: the database engine refused round %: %', p, v_res ->> 'reason';
  end if;
  return public.calculate_competition_round(pg_temp.rid(p), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash',
    pg_temp.th(), '[{"step":1}]'::jsonb, v_res -> 'rows', coalesce(v_res -> 'warnings', '[]'::jsonb), p_req);
end $$;
create or replace function pg_temp.approve(p int, p_version int, p_reason text default null, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.approve_competition_round_result(pg_temp.rid(p), pg_temp.vid(p, p_version), p_reason, p_req);
end $$;
create or replace function pg_temp.corr(p int, p_reason text default 'judge 2 mis-ranked the heat', p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.open_competition_round_correction(pg_temp.rid(p), p_reason, p_req);
end $$;
-- Runs as p_user (a fixture user suffix such as '000001'), then back to the superuser.
create or replace function pg_temp.as_calc(p_user text, p int) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.calc(p); execute 'reset role';
end $$;
create or replace function pg_temp.as_approve(p_user text, p int, p_version int, p_reason text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.approve(p, p_version, p_reason); execute 'reset role';
end $$;
create or replace function pg_temp.as_corr(p_user text, p int) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.corr(p); execute 'reset role';
end $$;

create or replace function pg_temp.submit_as(p_user text, p int, p_vals jsonb, p_reason text default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.u(p_user));
  v := public.submit_competition_ballot(pg_temp.rid(p), pg_temp.hid(p), pg_temp.mkr(p, p_vals), gen_random_uuid(), p_reason);
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.ballots(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.submit_as('000011', p, '[1,2,3]');
  perform pg_temp.submit_as('000012', p, '[1,3,2]');
  perform pg_temp.submit_as('000013', p, '[2,1,3]');
end $$;
create or replace function pg_temp.prep(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.ballots(p);
  perform pg_temp.as_user(pg_temp.u('000001'));
  perform pg_temp.hl1_danced(pg_temp.hid(p));
  perform public.set_competition_heat_lock_state(pg_temp.hid(p), 'locked', 'fixture');
  perform public.lock_competition_round_ballots(pg_temp.rid(p), gen_random_uuid());
  execute 'reset role';
end $$;
create or replace function pg_temp.panel(p int, p_scorer boolean default false) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u('000001'));
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000011'), 'A', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000012'), 'B', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000013'), 'C', gen_random_uuid());
  if p_scorer then
    perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000016'), null, gen_random_uuid());
  end if;
  execute 'reset role';
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
create temp table t_probe (seq serial, route text, step text, outcome text) on commit drop;
grant all on t_probe to authenticated;
grant all on sequence t_probe_seq_seq to authenticated;

insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-r11p-a1@example.test'), (pg_temp.u('000002'), 't-r11p-a2@example.test'),
  (pg_temp.u('000011'), 't-r11p-judge1@example.test'), (pg_temp.u('000012'), 't-r11p-judge2@example.test'), (pg_temp.u('000013'), 't-r11p-judge3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'R11P ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-b11ff4%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-b11ff4%';
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'R11P Studio', 't-r11p-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R11P Comp', 't-r11p-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.did(d), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D' || d, 'open' from generate_series(1, 2) d;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.rid(x.n), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(x.d), 'R' || x.n, 'final', x.seq, 'draft', 'ordinal_majority'
from (values (1, 1, 1), (2, 2, 1), (3, 2, 2)) x(n, d, seq);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(d, i), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(d), 'E' || d || i, 'confirmed', 'eligible', (d * 10 + i)::text
from generate_series(1, 2) d cross join generate_series(1, 3) i;
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
select pg_temp.hid(x.n), pg_temp.u('00e001'), pg_temp.did(x.d), pg_temp.rid(x.n), x.n, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled' from (values (1, 1), (2, 2), (3, 2)) x(n, d);
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e001'), pg_temp.did(x.d), pg_temp.hid(x.n), pg_temp.eid(x.d, i), i from (values (1, 1), (2, 2), (3, 2)) x(n, d) cross join generate_series(1, 3) i;
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select pg_temp.u('00e001'), pg_temp.hid(n), 'waltz', 'Waltz', 1 from generate_series(1, 3) n;
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
reset role;
select pg_temp.panel(1); select pg_temp.panel(2);
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.rid(1), pg_temp.rid(2));
set session_replication_role = origin;
do $$
begin
  set local session_replication_role = replica;
  update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now();
  insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
  select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at from public.event_competition_programs;
  set local session_replication_role = origin;
  perform public.pin_competition_round_scoring(id) from public.event_competition_rounds;
end $$;
select pg_temp.prep(1); select pg_temp.prep(2);
select pg_temp.as_calc('000001', 1), pg_temp.as_calc('000001', 2);
select pg_temp.as_approve('000002', 1, 1), pg_temp.as_approve('000002', 2, 1);
select pg_temp.as_corr('000001', 1), pg_temp.as_corr('000001', 2);
select pg_temp.as_calc('000001', 1), pg_temp.as_calc('000001', 2);

-- ============================================================================
-- Probe helpers
-- ============================================================================
-- Runs one statement as manager A1 in its own subtransaction and records the outcome; a refusal leaves no trace.
create or replace function pg_temp.step(p_route text, p_step text, p_sql text) returns void
language plpgsql as $$
declare v_msg text; v_n bigint; v_ok boolean := false;
begin
  begin
    perform pg_temp.as_user(pg_temp.u('000001'));
    execute p_sql;
    get diagnostics v_n = row_count;
    v_ok := true;
    v_msg := 'OK (rows ' || v_n || ')';
  exception when others then
    v_msg := 'REFUSED ' || sqlstate || ' ' || left(sqlerrm, 170);
  end;
  execute 'reset role';
  insert into t_probe (route, step, outcome) values (p_route, p_step, v_msg);
end $$;
create or replace function pg_temp.mkh(p_heat uuid, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn from public.event_competition_heat_entries he where he.heat_id = p_heat) x
$$;
-- Panel, schedule, start, paper ballots entered by A1, couples marked danced, heat lock, ballot lock, calculate, SELF-approve with a
-- substantive reason, publish: the whole run of one new round by one manager.
create or replace function pg_temp.run_round(p_route text, p int, p_round uuid, p_heat uuid) returns void
language plpgsql as $$
declare j record;
begin
  for j in select * from (values ('000011', 'A', '[3,2,1]'), ('000012', 'B', '[3,1,2]'), ('000013', 'C', '[2,3,1]')) v(u, l, marks) loop
    perform pg_temp.step(p_route, 'assign judge ' || j.l || ' to the new round', format($q$select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())$q$, p_round, pg_temp.off('00e001', j.u), j.l));
  end loop;
  perform pg_temp.step(p_route, 'schedule_competition_round', format($q$select public.schedule_competition_round(%L, gen_random_uuid())$q$, p_round));
  perform pg_temp.step(p_route, 'start_competition_round', format($q$select public.start_competition_round(%L, gen_random_uuid())$q$, p_round));
  for j in select * from (values ('000011', 'A', '[3,2,1]'), ('000012', 'B', '[3,1,2]'), ('000013', 'C', '[2,3,1]')) v(u, l, marks) loop
    perform pg_temp.step(p_route, 'A1 enters a paper ballot for judge ' || j.l || ' (different placements)', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, %L::jsonb, gen_random_uuid())$q$, p_round, p_heat, pg_temp.off('00e001', j.u), pg_temp.mkh(p_heat, j.marks::jsonb)));
  end loop;
  perform pg_temp.step(p_route, 'A1 marks the couples danced (table write)', format($q$update public.event_competition_heat_entries set status = 'danced' where heat_id = %L$q$, p_heat));
  perform pg_temp.step(p_route, 'lock the heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'probe run of the new round')$q$, p_heat));
  perform pg_temp.step(p_route, 'lock ballots', format($q$select public.lock_competition_round_ballots(%L, gen_random_uuid())$q$, p_round));
  perform pg_temp.step(p_route, 'calculate', format($q$select public.calculate_competition_round(%1$L, x.i ->> 'engine_key', x.i ->> 'engine_version', x.i ->> 'input_hash', pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.run_engine(x.i -> 'evidence') -> 'rows', coalesce(pg_temp.run_engine(x.i -> 'evidence') -> 'warnings', '[]'::jsonb), gen_random_uuid()) from (select public.competition_round_calculation_input(%1$L) i) x$q$, p_round));
  perform pg_temp.step(p_route, 'A1 SELF-approves the new round with a substantive reason', format($q$select public.approve_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L order by version desc limit 1), 'only manager present on the floor today', gen_random_uuid())$q$, p_round));
  perform pg_temp.step(p_route, 'publish the new result', format($q$select public.publish_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L and status = 'approved'), 'entrants', gen_random_uuid())$q$, p_round));
  insert into t_probe (route, step, outcome)
  select p_route, 'RESULT', 'round status ' || r.status || '; override events with refs.initial=true: '
    || (select count(*) from public.event_competition_result_events e where e.round_id = r.id and e.kind = 'result_approval_override' and e.refs ->> 'initial' = 'true')
    || '; current publications: ' || (select count(*) from public.event_competition_result_publications p2 where p2.round_id = r.id and p2.withdrawn_at is null)
  from public.event_competition_rounds r where r.id = p_round;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

insert into t_probe (route, step, outcome)
select 'start', 'r1 and r2 corrected and recalculated, never published', string_agg('r' || x.n || ' status ' || pg_temp.rstatus(x.n) || ' v2 ' || pg_temp.vstatus(x.n, 2)
  || ', causes ' || (select count(*) from public.event_competition_correction_causes c where c.round_id = pg_temp.rid(x.n))
  || ', heat ' || (select h.status || '/' || h.lock_state from public.event_competition_heats h where h.id = pg_temp.hid(x.n)), '; ') from (values (1), (2)) x(n);
select pg_temp.step('start', 'control: A1 cannot self-approve corrected r1', $q$select public.approve_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 2), 'only manager present on the floor today', gen_random_uuid())$q$);

-- Route A: cancel r1, create a new round in the same division, build a new heat with the SAME couples and attach it to the published order.
select pg_temp.step('A', 'cancel_competition_round(r1)', $q$select public.cancel_competition_round(pg_temp.rid(1), 'running this round again', gen_random_uuid())$q$);
select pg_temp.step('A', 'delete the cancelled round (its history)', $q$delete from public.event_competition_rounds where id = pg_temp.rid(1)$q$);
select pg_temp.step('A', 'insert a new round, sequence 1 (taken)', $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (pg_temp.u('061100'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(1), 'R1 again', 'final', 1, 'draft', 'ordinal_majority')$q$);
select pg_temp.step('A', 'insert a new round, sequence 2', $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (pg_temp.u('061100'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(1), 'R1 again', 'final', 2, 'draft', 'ordinal_majority')$q$);
select pg_temp.step('A', 'insert a new heat with no schedule version', $q$insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, status) values (pg_temp.u('0d1100'), pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('061100'), 91, pg_temp.u('002001'), 'scheduled')$q$);
select pg_temp.step('A', 'put the same couples in the new heat', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) select pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('0d1100'), pg_temp.eid(1, i), i from generate_series(1, 3) i$q$);
select pg_temp.step('A', 'add the dance to the new heat', $q$insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (pg_temp.u('00e001'), pg_temp.u('0d1100'), 'waltz', 'Waltz', 1)$q$);
select pg_temp.step('A', 'schedule the round while the heat is outside the published order', $q$select public.schedule_competition_round(pg_temp.u('061100'), gen_random_uuid())$q$);
-- Route C (the normal way to change a running order): a new draft version, then publish it.
select pg_temp.step('C', 'create a new draft schedule version', $q$insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values (pg_temp.u('00c009'), pg_temp.u('00e001'), 9, 'v9', 'draft')$q$);
select pg_temp.step('C', 'mark the new version published (table write)', $q$update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = pg_temp.u('00c009')$q$);
select pg_temp.step('C', 'publish_competition_schedule_version', $q$select public.publish_competition_schedule_version(pg_temp.u('00c009'))$q$);
-- Route A continued: attach the prepared heat to the already published version.
select pg_temp.step('A', 'attach the prepared heat to the PUBLISHED version (table write)', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c001') where id = pg_temp.u('0d1100')$q$);
select pg_temp.run_round('A', 1, pg_temp.u('061100'), pg_temp.u('0d1100'));

-- Route B: a second round already in the published order before the correction ("spare round"). Cancelling r2 is not even required.
select pg_temp.step('B', 'cancel_competition_round(r2)', $q$select public.cancel_competition_round(pg_temp.rid(2), 'running this round again', gen_random_uuid())$q$);
select pg_temp.run_round('B', 3, pg_temp.rid(3), pg_temp.hid(3));

do $$
declare v text;
begin
  select string_agg('[' || route || '] ' || step || ' => ' || outcome, ' || ' order by seq) into v from t_probe;
  raise exception 'COMPETITION R11 CANCEL-RECREATE PROBE: %', v;
end $$;
