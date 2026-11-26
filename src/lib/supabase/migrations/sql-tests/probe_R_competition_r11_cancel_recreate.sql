-- Competition R-11 OBSERVATION probe. Two questions, answered by execution, not by reading:
--   (1) Can ONE manager reach a self-approved, published result over the same couples for a corrected, never-published round, by running another
--       round (with or without cancelling the corrected one), including by moving an unrun published heat to a new round?
--   (2) Which direct table writes can move or change a heat of an ALREADY PUBLISHED running order?
-- NOT a pass/fail suite and NOT a fix. It records every step (OK / REFUSED with SQLSTATE and message) and the database state read back after it, and
-- always ends by raising "COMPETITION R11 CANCEL-RECREATE PROBE: ..." so nothing persists. Run only as a superuser on a LOCAL QA database.
-- Generated from the R-11 suite's helpers (UUID block ...-b11ff4XXXXXX).
--
-- Fixtures (superuser; replica mode only here, never in a probe step): one published running order, one numbered floor heat per round, the same three
-- couples per division. D1: r1 (corrected) + r4 never run | D2: r2 (corrected) + r3 never run | D3: r5 (corrected) + r6 never run |
-- D4: r7 (corrected, then approved by the second manager) + r8 never run | D5: r9, r10 never run (published-heat write probes only).
-- Routes: NC = run the spare round WITHOUT cancelling (D3) | CS = cancel the corrected round, run the spare (D2) | CA = cancel the independently
-- APPROVED corrected round, run the spare (D4) | R = cancel r1, create a new round, move r4's unrun published heat to it (D1) | A, C = other ways to
-- build a heat | D = single writes against a published heat, each rolled back after its read-back.
-- Probe steps run as authenticated manager A1 (lifecycle functions or ordinary table writes under RLS).

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

create or replace function pg_temp.fl(n int) returns uuid language sql immutable as $$ select pg_temp.u('0c01' || lpad(n::text, 2, '0')) $$;
grant execute on all functions in schema pg_temp to authenticated;
-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
create temp table t_probe (seq serial, route text, step text, outcome text) on commit drop;
create temp table t_map (round_no int, div int, seqno int) on commit drop;
insert into t_map values (1,1,1), (4,1,3), (2,2,1), (3,2,2), (5,3,1), (6,3,2), (7,4,1), (8,4,2), (9,5,1), (10,5,2);
grant select on t_map to authenticated;

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
select pg_temp.did(d), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D' || d, 'open' from generate_series(1, 5) d;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.rid(m.round_no), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(m.div), 'R' || m.round_no, 'final', m.seqno, 'draft', 'ordinal_majority' from t_map m;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(d, i), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(d), 'E' || d || i, 'confirmed', 'eligible', (d * 10 + i)::text
from generate_series(1, 5) d cross join generate_series(1, 3) i;
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now());
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
select pg_temp.fl(m.round_no), pg_temp.u('00e001'), pg_temp.u('00c001'), m.round_no from t_map m;
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status)
select pg_temp.hid(m.round_no), pg_temp.u('00e001'), pg_temp.did(m.div), pg_temp.rid(m.round_no), m.round_no, pg_temp.u('002001'), pg_temp.u('00c001'), pg_temp.fl(m.round_no), 'scheduled' from t_map m;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e001'), pg_temp.did(m.div), pg_temp.hid(m.round_no), pg_temp.eid(m.div, i), i from t_map m cross join generate_series(1, 3) i;
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select pg_temp.u('00e001'), pg_temp.hid(m.round_no), 'waltz', 'Waltz', 1 from t_map m;
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
reset role;
select pg_temp.panel(1); select pg_temp.panel(2); select pg_temp.panel(5); select pg_temp.panel(7);
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.rid(1), pg_temp.rid(2), pg_temp.rid(5), pg_temp.rid(7));
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
-- the four rounds to be corrected: real ballots, heat danced (fixture), real lock, calculate A1, approve A2, correction A1, recalculate A1
select pg_temp.prep(1); select pg_temp.prep(2); select pg_temp.prep(5); select pg_temp.prep(7);
select pg_temp.as_calc('000001', n) from unnest(array[1, 2, 5, 7]) n;
select pg_temp.as_approve('000002', n, 1) from unnest(array[1, 2, 5, 7]) n;
select pg_temp.as_corr('000001', n) from unnest(array[1, 2, 5, 7]) n;
select pg_temp.as_calc('000001', n) from unnest(array[1, 2, 5, 7]) n;
select pg_temp.as_approve('000002', 7, 2);

-- ============================================================================
-- Probe helpers
-- ============================================================================
create or replace function pg_temp.who(p uuid) returns text language sql stable as $$
  select case p when pg_temp.u('000001') then 'A1' when pg_temp.u('000002') then 'A2' else coalesce(right(p::text, 6), '-') end
$$;
create or replace function pg_temp.note(p_route text, p_step text, p_text text) returns void language sql security definer as $$
  insert into t_probe (route, step, outcome) values (p_route, p_step, p_text)
$$;
-- Database state of one round, read back as the superuser.
create or replace function pg_temp.state(p_round uuid) returns text language sql stable security definer as $$
  select 'round ' || right(r.id::text, 6) || ' status=' || r.status
    || ' ; versions=' || coalesce((select string_agg('v' || v.version || ':' || v.status || ':calc ' || pg_temp.who(v.calculated_by), ',' order by v.version) from public.event_competition_result_versions v where v.round_id = r.id), 'none')
    || ' ; approvals=' || coalesce((select string_agg('v' || v.version || ' by ' || pg_temp.who(ap.approved_by) || case when ap.override_reason is null then '' else ' OVERRIDE' end, ',' order by v.version)
         from public.event_competition_result_approvals ap join public.event_competition_result_versions v on v.id = ap.result_version_id where v.round_id = r.id), 'none')
    || ' ; result events=' || coalesce((select string_agg(e.kind || '(' || pg_temp.who(e.actor_user_id) || case when e.refs ? 'initial' then ' initial=' || (e.refs ->> 'initial') else '' end || case when e.refs ->> 'correction' = 'true' then ' correction' else '' end || ')', ' > ' order by e.occurred_at, e.kind)
         from public.event_competition_result_events e where e.round_id = r.id), 'none')
    || ' ; causes=' || (select count(*) from public.event_competition_correction_causes c where c.round_id = r.id)
    || ' ; publications=' || coalesce((select string_agg('v' || v.version || case when p.withdrawn_at is null then ' current' else ' withdrawn' end, ',')
         from public.event_competition_result_publications p join public.event_competition_result_versions v on v.id = p.result_version_id where p.round_id = r.id), 'none')
    || ' ; transitions=' || coalesce((select string_agg(t.kind || ' ' || coalesce(t.from_state, '-') || '>' || coalesce(t.to_state, '-') || '(' || pg_temp.who(t.actor) || ')', ', ' order by t.seq_hint) from (select kind, from_state, to_state, actor, ctid::text as seq_hint from public.event_competition_round_transition_events x where x.round_id = r.id) t), 'none')
    || ' ; panel=' || (select count(*) from public.event_competition_panel_assignments pa where pa.round_id = r.id)
    || ' ; ballots=' || coalesce((select string_agg(x.s || ' ' || x.n, ',') from (select b.source as s, count(*) as n from public.event_competition_ballots b where b.round_id = r.id group by b.source) x), 'none')
    || ' ; heats=' || coalesce((select string_agg(right(h.id::text, 6) || ' ' || h.status || '/' || h.lock_state || ' version ' || coalesce(right(h.schedule_version_id::text, 6), 'none'), ',' order by h.heat_number) from public.event_competition_heats h where h.round_id = r.id), 'none')
  from public.event_competition_rounds r where r.id = p_round
$$;
-- Runs one statement as manager A1 in its own subtransaction and records the outcome; a refusal leaves no trace.
create or replace function pg_temp.step(p_route text, p_step text, p_sql text, p_round uuid default null) returns void
language plpgsql as $$
declare v_msg text; v_n bigint;
begin
  begin
    perform pg_temp.as_user(pg_temp.u('000001'));
    execute p_sql;
    get diagnostics v_n = row_count;
    v_msg := 'OK (rows ' || v_n || ')';
  exception when others then
    v_msg := 'REFUSED ' || sqlstate || ' ' || left(replace(sqlerrm, chr(10), ' '), 200);
  end;
  execute 'reset role';
  perform pg_temp.note(p_route, p_step, v_msg);
  if p_round is not null then
    perform pg_temp.note(p_route, '  state', coalesce(pg_temp.state(p_round), 'round not found'));
  end if;
end $$;
-- One write against a published heat as A1: outcome plus the heat row read back, then ROLLED BACK.
create or replace function pg_temp.try_write(p_step text, p_sql text, p_heat uuid) returns void
language plpgsql as $$
declare v_msg text; v_n bigint; v_row text;
begin
  begin
    perform pg_temp.as_user(pg_temp.u('000001'));
    execute p_sql;
    get diagnostics v_n = row_count;
    execute 'reset role';
    select 'round ' || right(h.round_id::text, 6) || ', division ' || right(h.division_id::text, 6) || ', contest ' || coalesce(right(h.contest_id::text, 6), '-') || ', version ' || coalesce(right(h.schedule_version_id::text, 6), 'none')
      || ', floor heat ' || coalesce(right(h.floor_heat_id::text, 6), 'none') || ', heat_number ' || h.heat_number || ', status ' || h.status into v_row from public.event_competition_heats h where h.id = p_heat;
    v_msg := 'ACCEPTED (rows ' || v_n || '); read back: ' || coalesce(v_row, 'heat row gone');
    raise exception 'ROLLBACK_PROBE %', v_msg;
  exception when others then
    if sqlerrm like 'ROLLBACK_PROBE %' then
      v_msg := substr(sqlerrm, 16);
    else
      v_msg := 'REFUSED ' || sqlstate || ' ' || left(replace(sqlerrm, chr(10), ' '), 200);
    end if;
  end;
  execute 'reset role';
  perform pg_temp.note('D', p_step, v_msg);
end $$;
create or replace function pg_temp.mkh(p_heat uuid, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn from public.event_competition_heat_entries he where he.heat_id = p_heat) x
$$;
-- The whole run of one never-run round by A1: panel, schedule, start, day-of heat calls, paper ballots entered by A1, heat lock, ballot lock,
-- calculate (database engine rows), SELF-approval with a substantive reason, publication. State is read back after every step.
create or replace function pg_temp.run_round(p_route text, p_floor uuid, p_round uuid, p_heat uuid, p_corrected uuid) returns void
language plpgsql as $$
declare j record; s text;
begin
  perform pg_temp.note(p_route, 'before: the round to be run', coalesce(pg_temp.state(p_round), 'round not found'));
  perform pg_temp.note(p_route, 'before: the corrected round', pg_temp.state(p_corrected));
  for j in select * from (values ('000011', 'A'), ('000012', 'B'), ('000013', 'C')) v(u, l) loop
    perform pg_temp.step(p_route, 'assign judge ' || j.l, format($q$select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())$q$, p_round, pg_temp.off('00e001', j.u), j.l), p_round);
  end loop;
  perform pg_temp.step(p_route, 'schedule_competition_round', format($q$select public.schedule_competition_round(%L, gen_random_uuid())$q$, p_round), p_round);
  perform pg_temp.step(p_route, 'start_competition_round', format($q$select public.start_competition_round(%L, gen_random_uuid())$q$, p_round), p_round);
  perform pg_temp.step(p_route, 'observation: direct table write marking couples danced', format($q$update public.event_competition_heat_entries set status = 'danced' where heat_id = %L$q$, p_heat), p_round);
  foreach s in array array['staging', 'active'] loop
    perform pg_temp.step(p_route, 'advance_competition_floor_heat ' || s, format($q$select public.advance_competition_floor_heat(%L, %L, gen_random_uuid())$q$, p_floor, s), p_round);
  end loop;
  for j in select * from (values ('000011', 'A', '[3,2,1]'), ('000012', 'B', '[3,1,2]'), ('000013', 'C', '[2,3,1]')) v(u, l, marks) loop
    perform pg_temp.step(p_route, 'A1 enters a paper ballot for judge ' || j.l || ' (new placements)', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, %L::jsonb, gen_random_uuid())$q$, p_round, p_heat, pg_temp.off('00e001', j.u), pg_temp.mkh(p_heat, j.marks::jsonb)), p_round);
  end loop;
  perform pg_temp.step(p_route, 'advance_competition_floor_heat complete', format($q$select public.advance_competition_floor_heat(%L, 'complete', gen_random_uuid())$q$, p_floor), p_round);
  perform pg_temp.step(p_route, 'lock the heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'probe run of another round')$q$, p_heat), p_round);
  perform pg_temp.step(p_route, 'lock ballots', format($q$select public.lock_competition_round_ballots(%L, gen_random_uuid())$q$, p_round), p_round);
  perform pg_temp.step(p_route, 'calculate', format($q$select public.calculate_competition_round(%1$L, x.i ->> 'engine_key', x.i ->> 'engine_version', x.i ->> 'input_hash', pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.run_engine(x.i -> 'evidence') -> 'rows', coalesce(pg_temp.run_engine(x.i -> 'evidence') -> 'warnings', '[]'::jsonb), gen_random_uuid()) from (select public.competition_round_calculation_input(%1$L) i) x$q$, p_round), p_round);
  perform pg_temp.step(p_route, 'A1 SELF-approves with a substantive reason', format($q$select public.approve_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L order by version desc limit 1), 'only manager present on the floor today', gen_random_uuid())$q$, p_round), p_round);
  perform pg_temp.step(p_route, 'publish the result', format($q$select public.publish_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L and status = 'approved'), 'entrants', gen_random_uuid())$q$, p_round), p_round);
  perform pg_temp.note(p_route, 'RESULT', (select 'new round status=' || r.status
    || '; self-approval override events with refs.initial=true: ' || (select count(*) from public.event_competition_result_events e where e.round_id = r.id and e.kind = 'result_approval_override' and e.refs ->> 'initial' = 'true' and e.actor_user_id = pg_temp.u('000001'))
    || '; current publications: ' || (select count(*) from public.event_competition_result_publications p2 where p2.round_id = r.id and p2.withdrawn_at is null)
    || '; same couples as the corrected round: ' || (public._compe2_round_entries(r.id) @> public._compe2_round_entries(p_corrected) and public._compe2_round_entries(p_corrected) @> public._compe2_round_entries(r.id))::text
    from public.event_competition_rounds r where r.id = p_round));
  perform pg_temp.note(p_route, 'after: the corrected round', pg_temp.state(p_corrected));
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;
select pg_temp.note('start', 'corrected rounds', pg_temp.state(pg_temp.rid(n))) from unnest(array[1, 2, 5, 7]) n;
select pg_temp.step('start', 'control: A1 cannot self-approve corrected r1', $q$select public.approve_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 2), 'only manager present on the floor today', gen_random_uuid())$q$);

-- D: single writes against the published, never-run heat of r9 (each rolled back). Done first, while nothing in D5 has run.
select pg_temp.note('D', 'target heat', pg_temp.state(pg_temp.rid(9)));
select pg_temp.try_write('change round_id to another round of the division', $q$update public.event_competition_heats set round_id = pg_temp.rid(10) where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('detach from the published version (schedule_version_id null)', $q$update public.event_competition_heats set schedule_version_id = null, floor_heat_id = null where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('move to another numbered floor heat', $q$update public.event_competition_heats set floor_heat_id = pg_temp.fl(10) where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('remove from its numbered floor heat', $q$update public.event_competition_heats set floor_heat_id = null where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('change division_id and round_id together', $q$update public.event_competition_heats set division_id = pg_temp.did(1), round_id = pg_temp.rid(4) where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('change contest_id to null', $q$update public.event_competition_heats set contest_id = null where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('change heat_number', $q$update public.event_competition_heats set heat_number = 77 where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('change scheduled_at / floor_label / name', $q$update public.event_competition_heats set scheduled_at = now(), floor_label = 'B', name = 'renamed' where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('cancel the heat (status)', $q$update public.event_competition_heats set status = 'cancelled' where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('delete the heat', $q$delete from public.event_competition_heats where id = pg_temp.hid(9)$q$, pg_temp.hid(9));
select pg_temp.try_write('insert a second heat straight into the published version', $q$insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values (pg_temp.u('0d7700'), pg_temp.u('00e001'), pg_temp.did(5), pg_temp.rid(10), 78, pg_temp.u('002001'), pg_temp.u('00c001'), pg_temp.fl(10), 'scheduled')$q$, pg_temp.u('0d7700'));
select pg_temp.try_write('move a couple to another published heat (heat entry heat_id)', $q$update public.event_competition_heat_entries set heat_id = pg_temp.hid(10) where heat_id = pg_temp.hid(9) and entry_id = pg_temp.eid(5, 1)$q$, pg_temp.hid(9));
select pg_temp.try_write('delete a couple from the published heat', $q$delete from public.event_competition_heat_entries where heat_id = pg_temp.hid(9) and entry_id = pg_temp.eid(5, 1)$q$, pg_temp.hid(9));
select pg_temp.try_write('point the floor heat at another version', $q$update public.event_competition_floor_heats set schedule_version_id = null where id = pg_temp.fl(9)$q$, pg_temp.hid(9));

-- NC: run the never-run spare round WITHOUT cancelling the corrected round.
select pg_temp.run_round('NC', pg_temp.fl(6), pg_temp.rid(6), pg_temp.hid(6), pg_temp.rid(5));
-- CS: cancel the corrected round, then run the spare round.
select pg_temp.step('CS', 'cancel_competition_round(corrected r2)', $q$select public.cancel_competition_round(pg_temp.rid(2), 'running this round again', gen_random_uuid())$q$, pg_temp.rid(2));
select pg_temp.run_round('CS', pg_temp.fl(3), pg_temp.rid(3), pg_temp.hid(3), pg_temp.rid(2));
-- CA: cancel the corrected round that the SECOND manager had approved, then run the spare round.
select pg_temp.step('CA', 'cancel_competition_round(corrected and independently approved r7)', $q$select public.cancel_competition_round(pg_temp.rid(7), 'running this round again', gen_random_uuid())$q$, pg_temp.rid(7));
select pg_temp.run_round('CA', pg_temp.fl(8), pg_temp.rid(8), pg_temp.hid(8), pg_temp.rid(7));

-- A: cancel r1, create a new round, try to build a new heat and attach it to the published order.
select pg_temp.step('A', 'cancel_competition_round(r1)', $q$select public.cancel_competition_round(pg_temp.rid(1), 'running this round again', gen_random_uuid())$q$, pg_temp.rid(1));
select pg_temp.step('A', 'delete the cancelled round (its history)', $q$delete from public.event_competition_rounds where id = pg_temp.rid(1)$q$, pg_temp.rid(1));
select pg_temp.step('A', 'insert a new round, sequence 1 (taken)', $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (pg_temp.u('061100'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(1), 'R1 again', 'final', 1, 'draft', 'ordinal_majority')$q$);
select pg_temp.step('A', 'insert a new round, sequence 2', $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (pg_temp.u('061100'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(1), 'R1 again', 'final', 2, 'draft', 'ordinal_majority')$q$, pg_temp.u('061100'));
select pg_temp.step('A', 'insert a new heat with no schedule version', $q$insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, status) values (pg_temp.u('0d1100'), pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('061100'), 91, pg_temp.u('002001'), 'scheduled')$q$);
select pg_temp.step('A', 'put the same couples in the new heat', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) select pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('0d1100'), pg_temp.eid(1, i), i from generate_series(1, 3) i$q$);
select pg_temp.step('A', 'attach that heat to the PUBLISHED version (table write)', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c001') where id = pg_temp.u('0d1100')$q$);
select pg_temp.step('A', 'schedule the new round while its heat is outside the published order', $q$select public.schedule_competition_round(pg_temp.u('061100'), gen_random_uuid())$q$, pg_temp.u('061100'));
select pg_temp.step('A', 'delete the unplaced heat again', $q$delete from public.event_competition_heats where id = pg_temp.u('0d1100')$q$);
-- C: a populated draft running order, then publish it (after heats of the event have run).
select pg_temp.step('C', 'create a new draft schedule version', $q$insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values (pg_temp.u('00c009'), pg_temp.u('00e001'), 9, 'v9', 'draft')$q$);
select pg_temp.step('C', 'add a numbered floor heat to the draft', $q$insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.fl(99), pg_temp.u('00e001'), pg_temp.u('00c009'), 1)$q$);
select pg_temp.step('C', 'add a heat of the new round to the draft', $q$insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values (pg_temp.u('0d1900'), pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('061100'), 92, pg_temp.u('002001'), pg_temp.u('00c009'), pg_temp.fl(99), 'scheduled')$q$);
select pg_temp.step('C', 'put the same couples in the draft heat', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) select pg_temp.u('00e001'), pg_temp.did(1), pg_temp.u('0d1900'), pg_temp.eid(1, i), i from generate_series(1, 3) i$q$);
select pg_temp.step('C', 'publish_competition_schedule_version', $q$select public.publish_competition_schedule_version(pg_temp.u('00c009'))$q$);
select pg_temp.step('C', 'mark the draft published (table write)', $q$update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = pg_temp.u('00c009')$q$);
-- R: move the never-run published heat of spare round r4 to the new round by a direct table write of round_id, then run the new round.
select pg_temp.note('R', 'before: spare round r4 and its heat', pg_temp.state(pg_temp.rid(4)));
select pg_temp.step('R', 'repoint the unrun published heat of r4 to the new round (direct update of round_id)', $q$update public.event_competition_heats set round_id = pg_temp.u('061100') where id = pg_temp.hid(4)$q$, pg_temp.u('061100'));
select pg_temp.note('R', 'after repoint: spare round r4', pg_temp.state(pg_temp.rid(4)));
select pg_temp.run_round('R', pg_temp.fl(4), pg_temp.u('061100'), pg_temp.hid(4), pg_temp.rid(1));

do $$
declare v text;
begin
  select string_agg('[' || route || '] ' || step || ' => ' || outcome, ' || ' order by seq) into v from t_probe;
  raise exception 'COMPETITION R11 CANCEL-RECREATE PROBE: %', replace(v, '||  ', '|| ');
end $$;
