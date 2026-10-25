-- Competition F2 -- results lifecycle regression suite.
--
-- Covers 20270114090000_competition_f2_results_lifecycle.sql on top of 10A..10D.1, E1 (20270101090000), O1 (20270106090000)
-- and E2 (20270102090000). Run as a SUPERUSER (fixtures use session_replication_role = replica to place heats in a published
-- schedule version and rounds in a state without the O1/E2 flows). One transaction, synthetic fixtures only (UUID block
-- ...-f20ff2XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION F2 SQL SUITE PASS (<n> checks)"  or  "COMPETITION F2 SQL SUITE FAIL: <failures>".
-- Real two-connection races (double calculate, approve vs correction, calculate vs ballot) live in
-- sql-tests/concurrency/run_f2_races.sh; the rollback refusal in run_f2_rollback.sh.
--
-- Rounds (one heat of three entries each, panel J1 A / J2 B / J3 C unless noted):
--   r1 D1  main path: calculate, approve (second manager), certification, replay, reads, audit
--   r2 D2  single-staff override
--   r3 D3 seq 1 + r4 D3 seq 2   corrections and the O5 refusal
--   r5 D5  assigned scorer calculates; an entry is scratched after calculation (stale approve / incomplete recalculation)
--   r6 D6  a new ballot version invalidates the calculated version
--   r7 D7  proficiency_rating (no approved engine), r8 = round 2 of D5, active and ballot-free (inverse O5), r9 event B, r10 D10 locked never calculated,
--   r11 D11 published (fixture) for the complete precondition

begin;

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

create or replace function pg_temp.chk_sql(p_name text, p_sql text) returns void
language plpgsql as $$
declare v boolean;
begin
  begin
    execute p_sql into v;
    insert into t_results values (p_name, coalesce(v, false), coalesce(v::text, 'null'));
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- Runs a statement and swallows any error (the caller then checks that nothing changed).
create or replace function pg_temp.try(p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    null;
  end;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-f20ff2' || p_suffix)::uuid $$;
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
create or replace function pg_temp.rid(p int) returns uuid language sql immutable as $$ select pg_temp.u('06' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.did(p int) returns uuid language sql immutable as $$ select pg_temp.u('03' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.hid(p int) returns uuid language sql immutable as $$ select pg_temp.u('0d' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.eid(p int, i int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(p::text, 2, '0') || lpad(i::text, 2, '0')) $$;
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;
-- Marks for round p's heat: p_vals applied to the heat's entries in entry-id order.
create or replace function pg_temp.mkr(p int, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.hid(p)) x
$$;
-- One result row per entry of the round's heat (placement by entry order).
create or replace function pg_temp.rows(p int) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'placement', x.rn) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.hid(p)) x
$$;
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
-- The engine input as the app would read it, then a calculate call with the database's own hash.
create or replace function pg_temp.calc(p int, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_in jsonb;
begin
  v_in := public.competition_round_calculation_input(pg_temp.rid(p));
  return public.calculate_competition_round(pg_temp.rid(p), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash',
    pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.rows(p), '[]'::jsonb, p_req);
end $$;
create or replace function pg_temp.approve(p int, p_version int, p_reason text default null, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.approve_competition_round_result(pg_temp.rid(p), pg_temp.vid(p, p_version), p_reason, p_req);
end $$;

-- Fixture helpers run as superuser and switch roles internally.
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
-- users: 01 owner A (manager), 02 owner A2 (second manager), 05 owner B, 11 12 13 judges A, 16 scorer A (assigned r5),
--        18 scorer A (assigned nowhere), 20 verified user with no role, 21 verified user (stands in for an entrant dancer)
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-f2-owner-a@example.test'), (pg_temp.u('000002'), 't-f2-owner-a2@example.test'),
  (pg_temp.u('000005'), 't-f2-owner-b@example.test'), (pg_temp.u('000011'), 't-f2-judge1@example.test'),
  (pg_temp.u('000012'), 't-f2-judge2@example.test'), (pg_temp.u('000013'), 't-f2-judge3@example.test'),
  (pg_temp.u('000016'), 't-f2-scorer@example.test'), (pg_temp.u('000018'), 't-f2-scorer2@example.test'),
  (pg_temp.u('000020'), 't-f2-nobody@example.test'), (pg_temp.u('000021'), 't-f2-entrant@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'F2 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-f20ff2%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-f20ff2%';

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'F2 Studio A', 't-f2-studio-a'), (pg_temp.u('00b001'), 'F2 Studio B', 't-f2-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true), (pg_temp.u('000018'), pg_temp.u('00a001'), 'front_desk', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'F2 Comp', 't-f2-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'F2 Other Studio Comp', 't-f2-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');

-- Divisions d1..d8, d10, d11 (event A; r4 shares d3) and d9 (event B).
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.did(d), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D' || d, 'open'
from unnest(array[1, 2, 3, 5, 6, 7, 8, 10, 11]) d;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values (pg_temp.did(9), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'D9', 'open');

insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.rid(r.n), case when r.n = 9 then pg_temp.u('00e002') else pg_temp.u('00e001') end,
       case when r.n = 9 then pg_temp.u('001002') else pg_temp.u('001001') end,
       pg_temp.did(r.d), 'R' || r.n, 'final', r.seq, 'draft', case when r.n = 7 then 'proficiency_rating' else 'ordinal_majority' end
from (values (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 3, 2), (5, 5, 1), (6, 6, 1), (7, 7, 1), (8, 5, 2), (9, 9, 1), (10, 10, 1), (11, 11, 1)) r(n, d, seq);

insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(r.n, i), case when r.n = 9 then pg_temp.u('00e002') else pg_temp.u('00e001') end,
       case when r.n = 9 then pg_temp.u('001002') else pg_temp.u('001001') end,
       pg_temp.did(r.d), 'E' || r.n || i, 'confirmed', 'eligible', (r.n * 10 + i)::text
from (values (1, 1), (2, 2), (3, 3), (4, 3), (5, 5), (6, 6), (7, 7), (8, 5), (9, 9), (10, 10), (11, 11)) r(n, d)
cross join generate_series(1, 3) i;

-- Heats sit in a published schedule version. Fixture-only shortcut: replica mode skips the 10D publish flow.
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e002'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
select pg_temp.hid(r.n), case when r.n = 9 then pg_temp.u('00e002') else pg_temp.u('00e001') end, pg_temp.did(r.d), pg_temp.rid(r.n), r.n,
       case when r.n = 9 then pg_temp.u('002002') else pg_temp.u('002001') end,
       case when r.n = 9 then pg_temp.u('00c002') else pg_temp.u('00c001') end, 'scheduled'
from (values (1, 1), (2, 2), (3, 3), (4, 3), (5, 5), (6, 6), (7, 7), (8, 5), (9, 9), (10, 10), (11, 11)) r(n, d);
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select case when r.n = 9 then pg_temp.u('00e002') else pg_temp.u('00e001') end, pg_temp.did(r.d), pg_temp.hid(r.n), pg_temp.eid(r.n, i), i
from (values (1, 1), (2, 2), (3, 3), (4, 3), (5, 5), (6, 6), (7, 7), (8, 5), (9, 9), (10, 10), (11, 11)) r(n, d)
cross join generate_series(1, 3) i;
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select case when r.n = 9 then pg_temp.u('00e002') else pg_temp.u('00e001') end, pg_temp.hid(r.n), 'waltz', 'Waltz', 1
from unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) r(n);
set session_replication_role = origin;

-- Officials and panels through the E1 RPCs (as the real managers)
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000016'), 'scorer', pg_temp.u('f10005'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000018'), 'scorer', pg_temp.u('f10006'));
reset role;
select pg_temp.panel(1); select pg_temp.panel(2); select pg_temp.panel(3); select pg_temp.panel(4); select pg_temp.panel(5, true);
select pg_temp.panel(6); select pg_temp.panel(8); select pg_temp.panel(10);

-- Rounds r1..r6, r8, r10 run; r7 (no approved engine) and r9 (event B) sit at ballots_locked; r11 is published.
-- Fixture shortcut: O1 allows only scheduled->active; replica mode lets the superuser fixture place rounds directly.
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (select pg_temp.rid(n) from unnest(array[1, 2, 3, 4, 5, 6, 8, 10]) n);
update public.event_competition_rounds set status = 'ballots_locked' where id in (pg_temp.rid(7), pg_temp.rid(9));
update public.event_competition_rounds set status = 'published' where id = pg_temp.rid(11);
set session_replication_role = origin;

-- When REG (20270113) is present, programs must be profiled, locked and pinned for a reader answer (as publish would do).
do $$
begin
  if to_regprocedure('public.pin_competition_round_scoring(uuid)') is null then
    raise exception 'F2 suite needs REG 20270113 (pin_competition_round_scoring)';
  end if;
  if true then
    set local session_replication_role = replica;
    update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now();
    insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
    select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at
    from public.event_competition_programs;
    set local session_replication_role = origin;
    perform public.pin_competition_round_scoring(id) from public.event_competition_rounds;
  end if;
end $$;

-- Ballots, heat locks and ballot locks through the real E2 RPCs.
select pg_temp.prep(1); select pg_temp.prep(2); select pg_temp.prep(3); select pg_temp.prep(5); select pg_temp.prep(6); select pg_temp.prep(10);
select pg_temp.ballots(4);   -- r4 (the later round of d3) holds ballots, still active

-- ============================================================================
-- 1. Surface: grants, RLS, anon, helpers
-- ============================================================================
select pg_temp.chk('fixture: r1/r2/r3/r5/r6/r10 are ballots_locked, r4/r8 active',
  (select count(*) = 6 from public.event_competition_rounds where status = 'ballots_locked' and id in (pg_temp.rid(1), pg_temp.rid(2), pg_temp.rid(3), pg_temp.rid(5), pg_temp.rid(6), pg_temp.rid(10)))
  and (select count(*) = 2 from public.event_competition_rounds where status = 'active' and id in (pg_temp.rid(4), pg_temp.rid(8))));
select pg_temp.chk('F2 tables have RLS', (select bool_and(relrowsecurity) from pg_class where oid in (
  'public.event_competition_result_versions'::regclass, 'public.event_competition_result_rows'::regclass,
  'public.event_competition_result_approvals'::regclass, 'public.event_competition_result_events'::regclass)));
select pg_temp.chk('no API role holds table write privileges',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_result_versions', 'event_competition_result_rows', 'event_competition_result_approvals', 'event_competition_result_events')
                and g.grantee in ('anon', 'authenticated', 'service_role', 'public') and g.privilege_type <> 'SELECT'));
select pg_temp.chk('anon and service_role hold no table privilege at all',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_result_versions', 'event_competition_result_rows', 'event_competition_result_approvals', 'event_competition_result_events')
                and g.grantee in ('anon', 'public', 'service_role')));
select pg_temp.chk('anon cannot execute any F2 function',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like '\_compf2\_%' or p.proname in ('calculate_competition_round', 'approve_competition_round_result',
                'complete_competition_round', 'open_competition_round_correction', 'competition_round_calculation_input', 'competition_round_results_review', 'competition_audit_log'))
                and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.chk('internal helpers are not executable by API roles',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like '\_compf2\_%'
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))));
select pg_temp.chk('every F2 RPC is SECURITY DEFINER with a pinned search_path',
  (select count(*) = 7 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('calculate_competition_round', 'approve_competition_round_result', 'complete_competition_round',
     'open_competition_round_correction', 'competition_round_calculation_input', 'competition_round_results_review', 'competition_audit_log')
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')));
select pg_temp.chk('canonical JSON + sha256 reproduce the TypeScript golden vector',
  public._compf2_canon($j${"zeta":[3,1,{"b":null,"a":true}],"Alpha":"q\"u\\o\nte é","n":{"y":0,"x":-5},"empty":{},"list":[]}$j$::jsonb)
    = $j${"Alpha":"q\"u\\o\nte é","empty":{},"list":[],"n":{"x":-5,"y":0},"zeta":[3,1,{"a":true,"b":null}]}$j$
  and public._compf2_sha256(public._compf2_canon($j${"zeta":[3,1,{"b":null,"a":true}],"Alpha":"q\"u\\o\nte é","n":{"y":0,"x":-5},"empty":{},"list":[]}$j$::jsonb))
    = '6f684ff05c7edb2c86c41efa2a9e3da721bacc59453573d90689a195af940fb3');
select pg_temp.chk('engine pin: ordinal_majority pinned, proficiency_rating not',
  (select engine_key || '@' || engine_version from public._compf2_engine_pin(pg_temp.rid(1))) = 'studio_ordinal_majority@1'
  and not exists (select 1 from public._compf2_engine_pin(pg_temp.rid(7))));
select pg_temp.chk('rounds.correction_open exists and starts false', (select not bool_or(correction_open) from public.event_competition_rounds where event_id = pg_temp.u('00e001')));

-- ============================================================================
-- 2. calculate: authorization and preconditions (r1)
-- ============================================================================
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot calculate', format($q$select pg_temp.calc(1)$q$), 'permission denied');
select pg_temp.expect_msg('anon cannot read the calculation input', format($q$select public.competition_round_calculation_input(%L)$q$, pg_temp.rid(1)), 'permission denied');
reset role;
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('a user with no role cannot calculate', $q$select pg_temp.calc(1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.expect_msg('an entrant-like user cannot read the calculation input', format($q$select public.competition_round_calculation_input(%L)$q$, pg_temp.rid(1)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot calculate', $q$select pg_temp.calc(1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.expect_msg('an unassigned scorer cannot calculate', $q$select pg_temp.calc(1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer assigned to another round cannot calculate r1', $q$select pg_temp.calc(1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot calculate event A', $q$select pg_temp.calc(1)$q$, 'COMP_FORBIDDEN');
reset role;

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('manager reads the calculation input: available, pinned, hash is 64 hex',
  (public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'available')::boolean
  and public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'engine_key' = 'studio_ordinal_majority'
  and public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash' ~ '^[0-9a-f]{64}$');
select pg_temp.chk('the evidence carries 3 entries, 3 judges, 3 ballots and 9 marks',
  jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'entries') = 3
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'judges') = 3
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'ballots') = 3
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'marks') = 9);
select pg_temp.chk('the evidence carries what F1 needs: profile, X-3 flags, heats with the panel (X-7), the dance (X-6), no exclusions',
  (public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'profile') = '{"key":"studio_simple","version":1}'::jsonb
  and (public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' ->> 'chiefJudgeTiebreak') = 'false'
  and (public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' ->> 'scoreRolesSeparately') = 'false'
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'heats') = 1
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'heats' -> 0 -> 'officialIds') = 3
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'heats' -> 0 -> 'entryIds') = 3
  and (public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'danceIds') = '["waltz"]'::jsonb
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' -> 'excludedEntries') = 0
  and (public.competition_round_calculation_input(pg_temp.rid(1)) -> 'evidence' ->> 'finalCapacity') is null);
select pg_temp.chk('the calculation input is stable (same ballots, same hash)',
  public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash' = public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash');
select pg_temp.chk('proficiency round reports engine unavailable',
  not (public.competition_round_calculation_input(pg_temp.rid(7)) ->> 'available')::boolean);

select pg_temp.expect_msg('unpinned scoring method fails closed (r7)', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[]', '[]', '[]', gen_random_uuid())$q$, pg_temp.rid(7), repeat('a', 64)), 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('wrong engine key is refused', format($q$select public.calculate_competition_round(%L, 'studio_callback_tally', '1', %L, pg_temp.th(), '[]', '[]', '[]', gen_random_uuid())$q$, pg_temp.rid(1), repeat('a', 64)), 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('wrong engine version is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '2', %L, pg_temp.th(), '[]', '[]', '[]', gen_random_uuid())$q$, pg_temp.rid(1), repeat('a', 64)), 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('an active round cannot be calculated (r8)', $q$select pg_temp.calc(8)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_msg('a stale/wrong input hash is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), repeat('a', 64), pg_temp.rows(1)), 'COMP_RESULT_STALE');
select pg_temp.expect_msg('a missing request id is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', null)$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', pg_temp.rows(1)), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.expect_msg('a malformed trace hash is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, 'nope', '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', pg_temp.rows(1)), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('a trace that is not an array is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '{"step":1}', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', pg_temp.rows(1)), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('a result missing an entry is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', (pg_temp.rows(1) - 0)), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('a result row for an entry of another round is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash',
  jsonb_set(pg_temp.rows(1), '{0,entry_id}', to_jsonb(pg_temp.eid(2, 1)::text))), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('a duplicated entry row is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash',
  jsonb_set(pg_temp.rows(1), '{1,entry_id}', pg_temp.rows(1) -> 0 -> 'entry_id')), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('placement 0 is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash',
  jsonb_set(pg_temp.rows(1), '{0,placement}', '0')), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('a fractional placement is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$, pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash',
  jsonb_set(pg_temp.rows(1), '{0,placement}', '1.5')), 'COMP_ENGINE_INVALID_INPUT');
-- NS1 hook present: rows are one per CALCULATED entry (round entries minus no-shows). Stand-in reader: entry 3 of r1 is a no-show.
reset role;
create function public.competition_heat_no_show_entries(p_round_id uuid) returns table(entry_id uuid) language sql stable as $f$
  select e from unnest(case when p_round_id = pg_temp.rid(1) then array[pg_temp.eid(1, 3)] else '{}'::uuid[] end) e
$f$;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('no-show hook: a result that still has a row for the no-show entry is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid())$q$,
  pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', pg_temp.rows(1)), 'COMP_ENGINE_INVALID_INPUT');
select pg_temp.expect_msg('no-show hook: a result with exactly one row per calculated entry is accepted (probe rolls back)', format($q$do $d$ begin
    perform public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":1}]', %L, '[]', gen_random_uuid());
    raise exception 'PROBE_OK'; end $d$$q$,
  pg_temp.rid(1), public.competition_round_calculation_input(pg_temp.rid(1)) ->> 'input_hash', pg_temp.rows(1) - 2), 'PROBE_OK');
reset role;
drop function public.competition_heat_no_show_entries(uuid);
select pg_temp.as_user(pg_temp.u('000001'));
reset role;
select pg_temp.chk('no refused call left a version behind', pg_temp.n($q$select count(*) from public.event_competition_result_versions$q$) = 0);

-- ============================================================================
-- 3. calculate: success, idempotency, audit (r1)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('manager A1 calculates r1', format($q$select pg_temp.calc(1, %L)$q$, pg_temp.u('f30001')));
select pg_temp.expect_ok('replay with the same request id returns the same version', format($q$select pg_temp.calc(1, %L)$q$, pg_temp.u('f30001')));
reset role;
select pg_temp.chk('replay created no second version', pg_temp.n($q$select count(*) from public.event_competition_result_versions where round_id = pg_temp.rid(1)$q$) = 1);
select pg_temp.chk('version 1 is calculated, by A1, with 3 rows and the database input hash',
  (select v.status = 'calculated' and v.version = 1 and v.calculated_by = pg_temp.u('000001') and v.engine_key = 'studio_ordinal_majority'
          and v.input_hash = public._compf2_input_hash(pg_temp.rid(1), v.engine_key, v.engine_version)
          and (select count(*) = 3 from public.event_competition_result_rows r where r.result_version_id = v.id)
   from public.event_competition_result_versions v where v.round_id = pg_temp.rid(1)));
select pg_temp.chk('round r1 is calculated; correction_open false', (select status = 'calculated' and not correction_open from public.event_competition_rounds where id = pg_temp.rid(1)));
select pg_temp.chk('exactly one result_calculated audit row, with from/to and hashes',
  (select count(*) = 1 and bool_and(from_state = 'ballots_locked' and to_state = 'calculated' and refs ->> 'input_hash' ~ '^[0-9a-f]{64}$')
   from public.event_competition_result_events where round_id = pg_temp.rid(1) and kind = 'result_calculated'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('same request id with different content is refused', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[{"step":2}]', %L, '[]', %L)$q$, pg_temp.rid(1),
  (select input_hash from public.event_competition_result_versions where round_id = pg_temp.rid(1)), pg_temp.rows(1), pg_temp.u('f30001')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_msg('a second calculate on a calculated round is refused', $q$select pg_temp.calc(1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.try(format($q$update public.event_competition_rounds set status = 'approved' where id = %L$q$, pg_temp.rid(1)));
select pg_temp.try(format($q$update public.event_competition_rounds set status = 'published' where id = %L$q$, pg_temp.rid(1)));
select pg_temp.chk('a manager''s direct round status write changes nothing', pg_temp.rstatus(1) = 'calculated');
select pg_temp.expect_msg('API roles cannot insert result versions', format($q$insert into public.event_competition_result_versions (event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id)
  values (%L, %L, 9, 'x_engine', '1', %L, %L, '{}', '[]', %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(1), repeat('a', 64), repeat('b', 64), pg_temp.u('000001')), 'permission denied');
select pg_temp.expect_msg('API roles cannot update result versions', format($q$update public.event_competition_result_versions set status = 'approved' where round_id = %L$q$, pg_temp.rid(1)), 'permission denied');
reset role;

-- ============================================================================
-- 4. Reader matrix before approval (K0 section 7): managers and assigned scorers only
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('manager reads the version, rows and audit', pg_temp.n($q$select (select count(*) from public.event_competition_result_versions) + (select count(*) from public.event_competition_result_rows) + (select count(*) from public.event_competition_result_events)$q$) = 5);
select pg_temp.chk('manager review shows version 1 not stale with 3 rows',
  (public.competition_round_results_review(pg_temp.rid(1)) -> 'versions' -> 0 ->> 'stale')::boolean is false
  and jsonb_array_length(public.competition_round_results_review(pg_temp.rid(1)) -> 'versions' -> 0 -> 'rows') = 3);
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('an assigned judge reads no result version, row, approval or event', pg_temp.n($q$select (select count(*) from public.event_competition_result_versions) + (select count(*) from public.event_competition_result_rows) + (select count(*) from public.event_competition_result_approvals) + (select count(*) from public.event_competition_result_events)$q$) = 0);
select pg_temp.expect_msg('a judge cannot open the review board', format($q$select public.competition_round_results_review(%L)$q$, pg_temp.rid(1)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('an entrant-like user reads nothing', pg_temp.n($q$select (select count(*) from public.event_competition_result_versions) + (select count(*) from public.event_competition_result_rows) + (select count(*) from public.event_competition_result_events)$q$) = 0);
select pg_temp.expect_msg('an entrant-like user cannot open the review board', format($q$select public.competition_round_results_review(%L)$q$, pg_temp.rid(1)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.chk('cross-tenant: studio B owner reads no row of event A', pg_temp.n($q$select (select count(*) from public.event_competition_result_versions) + (select count(*) from public.event_competition_result_rows) + (select count(*) from public.event_competition_result_events)$q$) = 0);
select pg_temp.expect_msg('cross-tenant: studio B owner cannot open event A''s review board', format($q$select public.competition_round_results_review(%L)$q$, pg_temp.rid(1)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.chk('an unassigned scorer reads nothing', pg_temp.n($q$select count(*) from public.event_competition_result_versions$q$) = 0);
reset role;
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot select result versions', $q$select count(*) from public.event_competition_result_versions$q$, 'permission denied');
select pg_temp.expect_msg('anon cannot select result rows', $q$select count(*) from public.event_competition_result_rows$q$, 'permission denied');
select pg_temp.expect_msg('anon cannot select result events', $q$select count(*) from public.event_competition_result_events$q$, 'permission denied');
reset role;

-- ============================================================================
-- 5. approve: second person, preconditions, certification (r1)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('the calculator cannot approve without a reason (D3)', $q$select pg_temp.approve(1, 1)$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('a whitespace-only override reason is not a reason', $q$select pg_temp.approve(1, 1, '   ')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('a missing request id is refused', format($q$select public.approve_competition_round_result(%L, %L, null, null)$q$, pg_temp.rid(1), pg_temp.vid(1, 1)), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.expect_msg('a version of another round cannot be approved through r1', format($q$select public.approve_competition_round_result(%L, %L, 'x', gen_random_uuid())$q$, pg_temp.rid(1), gen_random_uuid()), 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('refusals left r1 calculated with no approval', pg_temp.rstatus(1) = 'calculated' and pg_temp.n($q$select count(*) from public.event_competition_result_approvals$q$) = 0);
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot approve', $q$select pg_temp.approve(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot approve', $q$select pg_temp.approve(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot approve', $q$select pg_temp.approve(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('a user with no role cannot approve', $q$select pg_temp.approve(1, 1)$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot approve', $q$select pg_temp.approve(1, 1)$q$, 'permission denied');
reset role;

select pg_temp.chk('before approval the r1 heat is locked, not certified', (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(1)));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('second manager A2 approves r1', format($q$select pg_temp.approve(1, 1, null, %L)$q$, pg_temp.u('f30002')));
select pg_temp.expect_ok('approval replay is idempotent', format($q$select pg_temp.approve(1, 1, null, %L)$q$, pg_temp.u('f30002')));
reset role;
select pg_temp.chk('r1 is approved; version approved; one approval by A2, calculated_by A1, no override',
  pg_temp.rstatus(1) = 'approved' and pg_temp.vstatus(1, 1) = 'approved'
  and (select count(*) = 1 and bool_and(approved_by = pg_temp.u('000002') and calculated_by = pg_temp.u('000001') and override_reason is null)
       from public.event_competition_result_approvals where result_version_id = pg_temp.vid(1, 1)));
select pg_temp.chk('exactly one result_approved audit row (not an override)',
  (select count(*) = 1 from public.event_competition_result_events where round_id = pg_temp.rid(1) and kind = 'result_approved' and from_state = 'calculated' and to_state = 'approved')
  and not exists (select 1 from public.event_competition_result_events where round_id = pg_temp.rid(1) and kind = 'result_approval_override'));
select pg_temp.chk('certification: the r1 heat is certified by the approval, other rounds'' heats untouched',
  (select lock_state = 'certified' and certified_by = pg_temp.u('000002') from public.event_competition_heats where id = pg_temp.hid(1))
  and (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(2)));
select pg_temp.chk('the certification is in the heat lock ledger',
  exists (select 1 from public.event_competition_heat_lock_events where heat_id = pg_temp.hid(1) and from_state = 'locked' and to_state = 'certified'));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('approving an approved round is refused', $q$select pg_temp.approve(1, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_msg('a certified heat cannot be reopened', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'oops')$q$, pg_temp.hid(1)), 'Certified heats');
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot add a ballot to an approved round', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mkr(1, '[3,2,1]'), gen_random_uuid(), 'late')$q$, pg_temp.rid(1), pg_temp.hid(1)), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
reset role;

-- ============================================================================
-- 6. Single-staff override (r2)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('A1 calculates r2', $q$select pg_temp.calc(2)$q$);
select pg_temp.expect_msg('A1 cannot self-approve without a reason', $q$select pg_temp.approve(2, 1)$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('an override reason longer than 500 characters is refused', format($q$select pg_temp.approve(2, 1, %L)$q$, repeat('x', 501)), 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_ok('A1 self-approves with an audited reason', $q$select pg_temp.approve(2, 1, 'sole manager on site')$q$);
reset role;
select pg_temp.chk('r2 approved; approval carries the override reason; calculator = approver',
  pg_temp.rstatus(2) = 'approved'
  and (select approved_by = calculated_by and override_reason = 'sole manager on site' from public.event_competition_result_approvals where result_version_id = pg_temp.vid(2, 1)));
select pg_temp.chk('the override has its own audit kind with the reason, and no plain approval row',
  (select count(*) = 1 and bool_and(reason = 'sole manager on site' and (refs ->> 'override')::boolean) from public.event_competition_result_events where round_id = pg_temp.rid(2) and kind = 'result_approval_override')
  and not exists (select 1 from public.event_competition_result_events where round_id = pg_temp.rid(2) and kind = 'result_approved'));
-- Check constraint exercised with the guard triggers off (replica): a self-approval row needs a reason.
select pg_temp.expect_msg('a self-approval row without a reason violates the check constraint', format($q$do $d$ begin
    set local session_replication_role = replica;
    insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, override_reason, request_id)
      values (%L, %L, %L, %L, null, gen_random_uuid()); end $d$$q$, pg_temp.u('00e001'), pg_temp.vid(2, 1), pg_temp.u('000001'), pg_temp.u('000001')), 'event_competition_result_approvals_override_check');
select pg_temp.expect_msg('a different approver row with an override reason violates the check constraint', format($q$do $d$ begin
    set local session_replication_role = replica;
    insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, override_reason, request_id)
      values (%L, %L, %L, %L, 'x', gen_random_uuid()); end $d$$q$, pg_temp.u('00e001'), pg_temp.vid(2, 1), pg_temp.u('000002'), pg_temp.u('000001')), 'event_competition_result_approvals_override_check');

-- ============================================================================
-- 7. Scorer calculates; an entry is scratched after calculation (r5)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_ok('the assigned scorer calculates r5', $q$select pg_temp.calc(5)$q$);
select pg_temp.chk('the scorer may read r5''s version (K0: scorers read unpublished results to verify)', pg_temp.n($q$select count(*) from public.event_competition_result_versions where round_id = pg_temp.rid(5)$q$) = 1);
select pg_temp.chk('the scorer may open the r5 review board', public.competition_round_results_review(pg_temp.rid(5)) ->> 'viewer_role' = 'scorer');
select pg_temp.expect_msg('the scorer cannot approve', $q$select pg_temp.approve(5, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.chk('the scorer sees no r1 version (not on r1''s panel)', pg_temp.n($q$select count(*) from public.event_competition_result_versions where round_id = pg_temp.rid(1)$q$) = 0);
reset role;
select pg_temp.chk('r5 version calculated by the scorer', (select calculated_by = pg_temp.u('000016') from public.event_competition_result_versions where round_id = pg_temp.rid(5)));
-- An entry is scratched after calculation: the stored input hash no longer matches the ballots.
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.hid(5) and entry_id = pg_temp.eid(5, 3);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('X-5: the scratched entry is in entries but listed as excluded and absent from its heat''s live entries',
  jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(5)) -> 'evidence' -> 'entries') = 3
  and (public.competition_round_calculation_input(pg_temp.rid(5)) -> 'evidence' -> 'excludedEntries') = jsonb_build_array(jsonb_build_object('entryId', pg_temp.eid(5, 3)::text, 'reason', 'scratched'))
  and jsonb_array_length(public.competition_round_calculation_input(pg_temp.rid(5)) -> 'evidence' -> 'heats' -> 0 -> 'entryIds') = 2);
select pg_temp.chk('the review board flags the version stale', (public.competition_round_results_review(pg_temp.rid(5)) -> 'versions' -> 0 ->> 'stale')::boolean);
select pg_temp.expect_msg('approve refuses a version whose input hash no longer matches', $q$select pg_temp.approve(5, 1, null)$q$, 'COMP_RESULT_STALE');
reset role;
select pg_temp.chk('the refused approval changed nothing', pg_temp.rstatus(5) = 'calculated' and pg_temp.vstatus(5, 1) = 'calculated'
  and (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(5)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('open a correction on r5 (calculated -> ballots_locked)', $q$select public.open_competition_round_correction(pg_temp.rid(5), 'entry scratched', gen_random_uuid())$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('O5 inverse: no ballot in a later round while an earlier round has an open correction (r8 follows r5)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mkr(8, '[1,2,3]'), gen_random_uuid())$q$, pg_temp.rid(8), pg_temp.hid(8)), 'COMP_CORRECTION_EARLIER_ROUND_OPEN');
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('recalculation is refused while current ballots no longer match the heat', $q$select pg_temp.calc(5)$q$, 'COMP_BALLOTS_INCOMPLETE');
reset role;

-- ============================================================================
-- 8. A new ballot version invalidates the calculated version (r6)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('A1 calculates r6', $q$select pg_temp.calc(6)$q$);
reset role;
-- Fixture shortcut: place the calculated round back at active so a judge can submit (no RPC does this; the trigger is the subject).
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id = pg_temp.rid(6);
set session_replication_role = origin;
select pg_temp.submit_as('000011', 6, '[3,2,1]', 'judge changed their mind');
select pg_temp.chk('the calculated r6 version went stale with ONE append-only invalidation row: tenant/competition scope, round, version, reason, actor, time and the causal ballot',
  pg_temp.vstatus(6, 1) = 'stale'
  and (select count(*) = 1 and bool_and(result_version_id = pg_temp.vid(6, 1) and round_id = pg_temp.rid(6) and event_id = pg_temp.u('00e001')
            and reason = 'new ballot version' and actor_user_id = pg_temp.u('000011') and occurred_at is not null
            and from_state = 'calculated' and to_state = 'stale'
            and refs ->> 'cause' = 'ballot_version' and (refs ->> 'ballot_id')::uuid = (select id from public.event_competition_ballots where round_id = pg_temp.rid(6) and version = 2)
            and refs ->> 'studio_id' = pg_temp.u('00a001')::text and refs ->> 'program_id' = pg_temp.u('001001')::text and refs ->> 'division_id' is not null)
       from public.event_competition_result_events where round_id = pg_temp.rid(6) and kind = 'result_invalidated'));
select pg_temp.expect_msg('invalidation never restores: a stale version cannot go back to calculated', format($q$update public.event_competition_result_versions set status = 'calculated' where id = %L$q$, pg_temp.vid(6, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.expect_msg('invalidation never restores: a stale version cannot be approved directly', format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(6, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('a stale version cannot be approved', $q$select pg_temp.approve(6, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;

-- ============================================================================
-- 9. Corrections (r3 + r4) and the O5 refusal
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a correction cannot open on a round with locked ballots (nothing to correct yet)', format($q$select public.open_competition_round_correction(%L, 'too early', gen_random_uuid())$q$, pg_temp.rid(10)), 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_ok('A1 calculates r3', $q$select pg_temp.calc(3)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('A2 approves r3', $q$select pg_temp.approve(3, 1)$q$);
reset role;
select pg_temp.chk('r3 approved; heat certified', pg_temp.rstatus(3) = 'approved' and (select lock_state = 'certified' from public.event_competition_heats where id = pg_temp.hid(3)));
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot open a correction', format($q$select public.open_competition_round_correction(%L, 'x', gen_random_uuid())$q$, pg_temp.rid(3)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot open a correction', format($q$select public.open_competition_round_correction(%L, 'x', gen_random_uuid())$q$, pg_temp.rid(3)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot open a correction', format($q$select public.open_competition_round_correction(%L, 'x', gen_random_uuid())$q$, pg_temp.rid(3)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a correction needs a reason', format($q$select public.open_competition_round_correction(%L, '  ', gen_random_uuid())$q$, pg_temp.rid(3)), 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('a correction reason over 500 characters is refused', format($q$select public.open_competition_round_correction(%L, %L, gen_random_uuid())$q$, pg_temp.rid(3), repeat('x', 501)), 'COMP_RESULT_REASON_REQUIRED');
-- O5: r4 (a later round of the same division) already holds ballots, so r3 cannot be corrected.
select pg_temp.expect_msg('O5: an earlier round cannot be corrected once a later round has ballots', format($q$select public.open_competition_round_correction(%L, 'judge 2 mis-ranked', gen_random_uuid())$q$, pg_temp.rid(3)), 'COMP_CORRECTION_LATER_ROUND_BALLOTS');
reset role;
select pg_temp.chk('the O5 refusal changed nothing', pg_temp.rstatus(3) = 'approved' and pg_temp.vstatus(3, 1) = 'approved'
  and not (select correction_open from public.event_competition_rounds where id = pg_temp.rid(3)));
-- The success path uses r1 (division d1 has no later round).
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('a correction opens on approved r1 (no later round): reason recorded', format($q$select public.open_competition_round_correction(%L, 'judge 2 mis-ranked heat 1', %L)$q$, pg_temp.rid(1), pg_temp.u('f30003')));
select pg_temp.expect_ok('correction replay is idempotent', format($q$select public.open_competition_round_correction(%L, 'judge 2 mis-ranked heat 1', %L)$q$, pg_temp.rid(1), pg_temp.u('f30003')));
reset role;
select pg_temp.chk('r1 is ballots_locked with correction_open; its version is stale; the heat stays certified',
  pg_temp.rstatus(1) = 'ballots_locked' and (select correction_open from public.event_competition_rounds where id = pg_temp.rid(1))
  and pg_temp.vstatus(1, 1) = 'stale' and (select lock_state = 'certified' from public.event_competition_heats where id = pg_temp.hid(1)));
select pg_temp.chk('one round_state_changed correction audit row with reason, from approved, naming the stale version',
  (select count(*) = 1 and bool_and(reason = 'judge 2 mis-ranked heat 1' and from_state = 'approved' and to_state = 'ballots_locked'
                                    and (refs ->> 'correction')::boolean and refs -> 'version_ids' ? pg_temp.vid(1, 1)::text)
   from public.event_competition_result_events where round_id = pg_temp.rid(1) and kind = 'round_state_changed' and to_state = 'ballots_locked'));
select pg_temp.chk('the correction wrote one result_invalidated row for the formerly approved version: reason = the correction reason, actor = A1, cause = correction_opened, was_approved',
  (select count(*) = 1 and bool_and(reason = 'judge 2 mis-ranked heat 1' and actor_user_id = pg_temp.u('000001') and from_state = 'approved' and to_state = 'stale'
            and refs ->> 'cause' = 'correction_opened' and (refs ->> 'was_approved')::boolean and (refs ->> 'request_id') = pg_temp.u('f30003')::text and refs ->> 'studio_id' is not null)
   from public.event_competition_result_events where result_version_id = pg_temp.vid(1, 1) and kind = 'result_invalidated'));
select pg_temp.expect_msg('invalidation never restores an approved result (stale -> approved)', format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(1, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.expect_msg('invalidation never restores an approved result (stale -> calculated)', format($q$update public.event_competition_result_versions set status = 'calculated' where id = %L$q$, pg_temp.vid(1, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.chk('while the correction is open the round has no approved version at all', not exists (select 1 from public.event_competition_result_versions where round_id = pg_temp.rid(1) and status = 'approved'));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('the stale version cannot be approved', $q$select pg_temp.approve(1, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
-- Corrected ballot is accepted only because the correction is open (E2 extension).
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_ok('judge 2 submits a corrected ballot while the correction is open', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mkr(1, '[1,2,3]'), gen_random_uuid(), 'mis-ranked heat 1')$q$, pg_temp.rid(1), pg_temp.hid(1)));
select pg_temp.expect_msg('a correction still needs a reason (E2 chain rule)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mkr(1, '[3,2,1]'), gen_random_uuid())$q$, pg_temp.rid(1), pg_temp.hid(1)), 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
reset role;
select pg_temp.chk('judge 2''s ballot is now version 2, superseding version 1',
  (select count(*) = 1 and bool_and(version = 2 and supersedes_id is not null) from public.event_competition_ballots
   where round_id = pg_temp.rid(1) and official_id = pg_temp.off('00e001', '000012') and version = 2));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('A1 recalculates r1: version 2 supersedes the stale version 1', $q$select pg_temp.calc(1)$q$);
reset role;
select pg_temp.chk('version 2 calculated with a different input hash; version 1 superseded; r1 calculated',
  pg_temp.vstatus(1, 2) = 'calculated' and pg_temp.vstatus(1, 1) = 'superseded' and pg_temp.rstatus(1) = 'calculated'
  and (select a.input_hash <> b.input_hash from public.event_competition_result_versions a, public.event_competition_result_versions b
       where a.round_id = pg_temp.rid(1) and a.version = 2 and b.round_id = pg_temp.rid(1) and b.version = 1)
  and not (select correction_open from public.event_competition_rounds where id = pg_temp.rid(1)));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('the superseded version 1 cannot be approved', $q$select pg_temp.approve(1, 1)$q$, 'COMP_RESULT_STALE');
select pg_temp.expect_ok('A2 approves version 2 (a supplied reason is ignored when the approver is not the calculator)', $q$select pg_temp.approve(1, 2, 'not needed')$q$);
reset role;
select pg_temp.chk('the second-person approval recorded no override and no reason',
  (select override_reason is null from public.event_competition_result_approvals where result_version_id = pg_temp.vid(1, 2))
  and exists (select 1 from public.event_competition_result_events where result_version_id = pg_temp.vid(1, 2) and kind = 'result_approved'));
select pg_temp.chk('r1 approved again; heats stay certified; both approvals exist', pg_temp.rstatus(1) = 'approved' and pg_temp.vstatus(1, 2) = 'approved'
  and pg_temp.n($q$select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = pg_temp.rid(1)$q$) = 2
  and (select lock_state = 'certified' from public.event_competition_heats where id = pg_temp.hid(1)));
-- A locked round without an open correction still refuses ballots (r10), at the RPC and at the table trigger.
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('ballots_locked without a correction still refuses ballots (RPC)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mkr(10, '[3,2,1]'), gen_random_uuid(), 'sneaky')$q$, pg_temp.rid(10), pg_temp.hid(10)), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
reset role;
select pg_temp.expect_msg('ballots_locked without a correction still refuses ballots (table trigger)', format($q$insert into public.event_competition_ballots
  (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
  select event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, 2, 'judge_web', submitted_by, id, 'x'
  from public.event_competition_ballots where round_id = %L limit 1$q$, pg_temp.rid(10)), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.try(format($q$update public.event_competition_rounds set correction_open = true where id = %L$q$, pg_temp.rid(10)));
select pg_temp.chk('correction_open cannot be set by a direct write (the trigger keeps the derived value)', not (select correction_open from public.event_competition_rounds where id = pg_temp.rid(10)));

-- ============================================================================
-- 10. complete_competition_round: fails closed until F3 exists
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('complete refuses a round that is not published (r1 approved)', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(1)), 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_msg('complete fails closed on a published round while no publication table exists (r11)', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(11)), 'COMP_PUBLICATION_REQUIRES_APPROVAL');
select pg_temp.expect_msg('complete needs a request id', format($q$select public.complete_competition_round(%L, null)$q$, pg_temp.rid(11)), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot complete', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(11)), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot complete', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(11)), 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('r11 is still published', pg_temp.rstatus(11) = 'published');
select pg_temp.chk('no publication table exists yet (F3 not applied), which is why completion is refused', to_regclass('public.event_competition_result_publications') is null);

-- ============================================================================
-- 11. Cross-tenant: event A managers cannot touch event B's round (r9, ballots_locked)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('A1 cannot read r9''s calculation input', format($q$select public.competition_round_calculation_input(%L)$q$, pg_temp.rid(9)), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('A1 cannot calculate r9', format($q$select public.calculate_competition_round(%L, 'studio_ordinal_majority', '1', %L, pg_temp.th(), '[]', '[]', '[]', gen_random_uuid())$q$, pg_temp.rid(9), repeat('a', 64)), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('A1 cannot open a correction on r9', format($q$select public.open_competition_round_correction(%L, 'x', gen_random_uuid())$q$, pg_temp.rid(9)), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('A1 cannot read event B''s audit log', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e002')), 'COMP_FORBIDDEN');
reset role;

-- ============================================================================
-- 12. Unified audit read
-- ============================================================================
-- One O1 transition row so all four sources are present.
insert into public.event_competition_round_transition_events (event_id, round_id, kind, from_state, to_state, actor, request_id)
values (pg_temp.u('00e001'), pg_temp.rid(1), 'round_started', 'scheduled', 'active', pg_temp.u('000001'), gen_random_uuid());
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the unified audit merges results, ballots, round and officials',
  (select array_agg(distinct source order by source) from public.competition_audit_log(pg_temp.u('00e001'), null, 1000)) = array['ballots', 'officials', 'results', 'round']);
select pg_temp.chk('round filter returns only that round''s rows (officials rows without a round are excluded)',
  (select count(*) > 0 and bool_and(round_id = pg_temp.rid(1)) from public.competition_audit_log(pg_temp.u('00e001'), pg_temp.rid(1), 1000)));
select pg_temp.chk('the limit is clamped to [1, 1000]',
  (select count(*) = 1 from public.competition_audit_log(pg_temp.u('00e001'), null, 0)) and (select count(*) <= 1000 from public.competition_audit_log(pg_temp.u('00e001'), null, 100000)));
select pg_temp.chk('the unified audit includes result_calculated, approval, override and correction rows',
  (select count(*) filter (where kind = 'result_calculated') >= 4 and count(*) filter (where kind = 'result_approved') >= 2
          and count(*) filter (where kind = 'result_approval_override') = 1 and count(*) filter (where kind = 'result_invalidated') = 3
          and count(*) filter (where kind = 'round_state_changed' and source = 'results') >= 2
   from public.competition_audit_log(pg_temp.u('00e001'), null, 1000)));
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot read the unified audit', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot read the unified audit', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.expect_msg('an entrant-like user cannot read the unified audit', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot read event A''s audit', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot read the unified audit', format($q$select * from public.competition_audit_log(%L)$q$, pg_temp.u('00e001')), 'permission denied');
reset role;

-- ============================================================================
-- 13. Append-only and writer protection (superuser attempts)
-- ============================================================================
-- r10 gets a calculated (unapproved) version to attack.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('A1 calculates r10 (kept calculated for the writer-protection probes)', $q$select pg_temp.calc(10)$q$);
reset role;
select pg_temp.expect_msg('result events cannot be updated', $q$update public.event_competition_result_events set reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('result events cannot be deleted', $q$delete from public.event_competition_result_events$q$, 'append-only');
select pg_temp.expect_msg('result events cannot be truncated', $q$truncate public.event_competition_result_events$q$, 'cannot be truncated');
select pg_temp.expect_msg('result rows cannot be updated', $q$update public.event_competition_result_rows set placement = 9$q$, 'append-only');
select pg_temp.expect_msg('result rows cannot be deleted', $q$delete from public.event_competition_result_rows$q$, 'append-only');
select pg_temp.expect_msg('result rows cannot be truncated', $q$truncate public.event_competition_result_rows$q$, 'cannot be truncated');
select pg_temp.expect_msg('approvals cannot be updated', $q$update public.event_competition_result_approvals set override_reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('approvals cannot be deleted', $q$delete from public.event_competition_result_approvals$q$, 'append-only');
select pg_temp.expect_msg('versions cannot be deleted', $q$delete from public.event_competition_result_versions$q$, 'append-only');
select pg_temp.expect_msg('versions cannot be truncated', $q$truncate public.event_competition_result_versions$q$, 'truncate');
select pg_temp.expect_msg('a version''s hash cannot be edited', $q$update public.event_competition_result_versions set input_hash = repeat('c', 64)$q$, 'COMPF2_VERSION_IMMUTABLE');
select pg_temp.expect_msg('a version''s trace cannot be edited', $q$update public.event_competition_result_versions set trace = '[]'$q$, 'COMPF2_VERSION_IMMUTABLE');
select pg_temp.expect_msg('a version''s calculator cannot be edited', format($q$update public.event_competition_result_versions set calculated_by = %L$q$, pg_temp.u('000002')), 'COMPF2_VERSION_IMMUTABLE');
select pg_temp.expect_msg('superseded is terminal (superseded -> calculated)', format($q$update public.event_competition_result_versions set status = 'calculated' where id = %L$q$, pg_temp.vid(1, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.expect_msg('approved -> calculated is not an edge', format($q$update public.event_competition_result_versions set status = 'calculated' where id = %L$q$, pg_temp.vid(2, 1)), 'COMPF2_VERSION_EDGE');
select pg_temp.expect_msg('approval without its audit row is refused (calculated r10 version)', format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(10, 1)), 'COMPF2_VERSION_WRITER');
select pg_temp.expect_msg('stale without its audit row is refused', format($q$update public.event_competition_result_versions set status = 'stale' where id = %L$q$, pg_temp.vid(10, 1)), 'COMPF2_VERSION_WRITER');
select pg_temp.expect_msg('superseded without its audit row is refused', format($q$update public.event_competition_result_versions set status = 'superseded' where id = %L$q$, pg_temp.vid(10, 1)), 'COMPF2_VERSION_WRITER');
select pg_temp.expect_msg('a round cannot jump calculated -> approved without the audit row (r10)', format($q$update public.event_competition_rounds set status = 'approved' where id = %L$q$, pg_temp.rid(10)), 'COMPF2_ROUND_WRITER');
select pg_temp.expect_msg('a round cannot jump calculated -> ballots_locked without the audit row (r10)', format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.rid(10)), 'COMPF2_ROUND_WRITER');
select pg_temp.expect_msg('a round cannot skip ballots_locked -> approved (r7)', format($q$update public.event_competition_rounds set status = 'approved' where id = %L$q$, pg_temp.rid(7)), 'COMPO1_ROUND_EDGE');
select pg_temp.chk('the refused writes changed nothing', pg_temp.rstatus(10) = 'calculated' and pg_temp.vstatus(10, 1) = 'calculated' and pg_temp.rstatus(7) = 'ballots_locked');
-- The suite is one transaction, so the transaction-binding guards are probed by backdating a version's transaction_id (replica mode).
select pg_temp.expect_msg('a result row cannot be added outside its version''s transaction', format($q$do $d$ begin
    set local session_replication_role = replica;
    update public.event_competition_result_versions set transaction_id = 1 where id = %L;
    set local session_replication_role = origin;
    insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement) values (%L, %L, %L, 1); end $d$$q$,
  pg_temp.vid(10, 1), pg_temp.u('00e001'), pg_temp.vid(10, 1), pg_temp.eid(10, 1)), 'COMPF2_ROW_IMMUTABLE');
select pg_temp.expect_msg('an approval row cannot be added outside the approve RPC (r10 version has no approval audit row)', format($q$insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, override_reason, request_id)
  values (%L, %L, %L, %L, null, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.vid(10, 1), pg_temp.u('000002'), pg_temp.u('000001')), 'COMPF2_APPROVAL_WRITER');
select pg_temp.expect_msg('a result row cannot hold an entry of another round (same transaction as its version)', format($q$do $d$ declare v uuid; begin
    insert into public.event_competition_result_versions (event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id)
      values (%L, %L, 9, 'studio_ordinal_majority', '1', repeat('a', 64), repeat('b', 64), '{}', '[]', %L, gen_random_uuid()) returning id into v;
    insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement) values (%L, v, %L, 1); end $d$$q$,
  pg_temp.u('00e001'), pg_temp.rid(6), pg_temp.u('000001'), pg_temp.u('00e001'), pg_temp.eid(1, 1)), 'COMPF2_ROW_ENTRY');
select pg_temp.expect_msg('a version cannot be inserted as approved', format($q$insert into public.event_competition_result_versions (event_id, round_id, version, status, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id)
  values (%L, %L, 9, 'approved', 'studio_ordinal_majority', '1', repeat('a', 64), repeat('b', 64), '{}', '[]', %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(6), pg_temp.u('000001')), 'COMPF2_VERSION_WRITER');
select pg_temp.expect_msg('at most one live version per round', format($q$insert into public.event_competition_result_versions (event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id)
  values (%L, %L, 9, 'studio_ordinal_majority', '1', repeat('a', 64), repeat('b', 64), '{}', '[]', %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(2), pg_temp.u('000001')), 'event_competition_result_versions_live_idx');
select pg_temp.expect_msg('an unknown audit kind is refused', format($q$insert into public.event_competition_result_events (event_id, round_id, kind, actor_user_id, request_id)
  values (%L, %L, 'result_published', %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(1), pg_temp.u('000001')), 'event_competition_result_events_kind_check');
select pg_temp.expect_msg('a request id is used once', format($q$insert into public.event_competition_result_events (event_id, round_id, kind, actor_user_id, request_id)
  select event_id, round_id, kind, actor_user_id, request_id from public.event_competition_result_events limit 1$q$), 'event_competition_result_events_request_idx');

-- ============================================================================
-- 14. E2 hooks unchanged elsewhere: lock/reopen edges and round config guard still apply
-- ============================================================================
select pg_temp.expect_msg('E2 guard: a direct active -> ballots_locked write is still refused (r8)', format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.rid(8)), 'COMP');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('E2 reopen still refuses a round that is not ballots_locked (r2 is approved)', format($q$select public.reopen_competition_round_ballots(%L, 'why', gen_random_uuid())$q$, pg_temp.rid(2)), 'COMP_BALLOTS_BAD_STATE');
-- r5 has an open correction and only stale versions: E2's reopen may abandon it, which clears correction_open.
select pg_temp.chk('r5 holds an open correction before the reopen', pg_temp.rstatus(5) = 'ballots_locked' and (select correction_open from public.event_competition_rounds where id = pg_temp.rid(5)));
select pg_temp.expect_msg('E2 reopen cannot abandon an open correction (it would lift the O5 inverse guard)', format($q$select public.reopen_competition_round_ballots(%L, 'abandon the correction', gen_random_uuid())$q$, pg_temp.rid(5)), 'COMPF2_CORRECTION_REOPEN');
reset role;
select pg_temp.chk('r5 still holds its open correction', pg_temp.rstatus(5) = 'ballots_locked' and (select correction_open from public.event_competition_rounds where id = pg_temp.rid(5)));

-- ============================================================================
-- 14b. REG pin reader (20270113) is authoritative when present; the allow-list is the fallback when absent
-- ============================================================================
select pg_temp.chk('REG is installed and its internal reader is not executable by API roles',
  to_regprocedure('public.competition_round_scoring_effective_internal(uuid)') is not null
  and not has_function_privilege('anon', 'public.competition_round_scoring_effective_internal(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.competition_round_scoring_effective_internal(uuid)', 'execute'));
select pg_temp.chk('the pin comes from the REG reader: a pinned, approved ordinal round pins studio_ordinal_majority@1',
  (select engine_key || '@' || engine_version from public._compf2_engine_pin(pg_temp.rid(1))) = 'studio_ordinal_majority@1');
select pg_temp.chk('the proficiency round (no approved engine) fails closed',
  not exists (select 1 from public._compf2_engine_pin(pg_temp.rid(7))));
-- Replica mode skips REG's pin_competition_late_round trigger, leaving this round unpinned.
set session_replication_role = replica;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
values (pg_temp.rid(12), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.did(1), 'R12 unpinned', 'final', 5, 'draft', 'ordinal_majority');
set session_replication_role = origin;
select pg_temp.chk('there is no fallback: a round with no pin fails closed even though its scoring method is ordinal_majority',
  not exists (select 1 from public.event_competition_scoring_pins where round_id = pg_temp.rid(12)) and not exists (select 1 from public._compf2_engine_pin(pg_temp.rid(12))));

-- ============================================================================
-- 14c. NS1 no-show hook: absent = identical evidence and hashes; present = no_show exclusions, deduplicated against scratched
-- ============================================================================
create temp table t_hash (k text primary key, v text);
grant all on t_hash to authenticated, anon, service_role;
insert into t_hash select 'r1_before', public._compf2_input_hash(pg_temp.rid(1), 'studio_ordinal_majority', '1');
insert into t_hash select 'r5_before', public._compf2_evidence(pg_temp.rid(5), 'studio_ordinal_majority', '1')::text;
select pg_temp.chk('absent path: the per-heat reader is absent too and no heat entry is a no-show',
  to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is null
  and not exists (select 1 from public.event_competition_heat_entries he where public._compf2_heat_entry_no_show(he.id)));
select pg_temp.chk('absent path: the hook returns nothing and r1 has no exclusions',
  to_regprocedure('public.competition_heat_no_show_entries(uuid)') is null
  and cardinality(public._compf2_no_show_entries(pg_temp.rid(1))) = 0
  and jsonb_array_length(public._compf2_evidence(pg_temp.rid(1), 'studio_ordinal_majority', '1') -> 'excludedEntries') = 0);
-- Stand-in for NS1's reader: r1 no-show = entry 3; r5 no-shows = its scratched entry 3 (must dedupe) and entry 1.
create function public.competition_heat_no_show_entries(p_round_id uuid) returns table(entry_id uuid) language sql stable as $f$
  select e from unnest(case when p_round_id = pg_temp.rid(1) then array[pg_temp.eid(1, 3)]
                            when p_round_id = pg_temp.rid(5) then array[pg_temp.eid(5, 3), pg_temp.eid(5, 1)]
                            else '{}'::uuid[] end) e
$f$;
select pg_temp.chk('present path: r1 excludes entry 3 as no_show; it stays in entries; the heat lists only the live entries',
  (public._compf2_evidence(pg_temp.rid(1), 'studio_ordinal_majority', '1') -> 'excludedEntries') = jsonb_build_array(jsonb_build_object('entryId', pg_temp.eid(1, 3)::text, 'reason', 'no_show'))
  and jsonb_array_length(public._compf2_evidence(pg_temp.rid(1), 'studio_ordinal_majority', '1') -> 'entries') = 3
  and jsonb_array_length(public._compf2_evidence(pg_temp.rid(1), 'studio_ordinal_majority', '1') -> 'heats' -> 0 -> 'entryIds') = 2
  and public._compf2_input_hash(pg_temp.rid(1), 'studio_ordinal_majority', '1') <> (select v from t_hash where k = 'r1_before'));
select pg_temp.chk('present path: r5 keeps its scratched entry as scratched (not duplicated) and adds entry 1 as no_show',
  (select jsonb_agg(x order by x ->> 'entryId') from jsonb_array_elements(public._compf2_evidence(pg_temp.rid(5), 'studio_ordinal_majority', '1') -> 'excludedEntries') x)
    = (select jsonb_agg(x order by x ->> 'entryId') from (values (jsonb_build_object('entryId', pg_temp.eid(5, 1)::text, 'reason', 'no_show')),
                                                               (jsonb_build_object('entryId', pg_temp.eid(5, 3)::text, 'reason', 'scratched'))) v(x)));
select pg_temp.chk('present path: an entry outside the round is ignored', cardinality(public._compf2_no_show_entries(pg_temp.rid(2))) = 0);
drop function public.competition_heat_no_show_entries(uuid);

-- NS1 semantics: an entry that is a no-show in EVERY heat reaches excludedEntries even when _compe2_round_entries stops listing it, and an
-- entry that is a no-show in ONE heat but danced in another stays in the other heat's entryIds. r8 gets a second heat (replica fixture):
-- entry 1 is a no-show in heat 8 only (danced in heat 13), entry 3 is a no-show everywhere.
set session_replication_role = replica;
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
values (pg_temp.hid(13), pg_temp.u('00e001'), pg_temp.did(5), pg_temp.rid(8), 13, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
values (pg_temp.u('00e001'), pg_temp.did(5), pg_temp.hid(13), pg_temp.eid(8, 1), 1);
set session_replication_role = origin;
create function public.competition_heat_no_show_entries(p_round_id uuid) returns table(entry_id uuid) language sql stable as $f$
  select e from unnest(case when p_round_id = pg_temp.rid(8) then array[pg_temp.eid(8, 3)] else '{}'::uuid[] end) e
$f$;
create function public.competition_heat_entry_is_no_show(p_heat_entry_id uuid) returns boolean language sql stable as $f$
  select exists (select 1 from public.event_competition_heat_entries he
                 where he.id = p_heat_entry_id and (he.entry_id = pg_temp.eid(8, 3) or (he.entry_id = pg_temp.eid(8, 1) and he.heat_id = pg_temp.hid(8))))
$f$;
select pg_temp.chk('NS1 semantics: a no-show in every heat is excluded (and stays in entries) even if the round-entries helper stopped listing it',
  (public._compf2_evidence(pg_temp.rid(8), 'studio_ordinal_majority', '1') -> 'excludedEntries') = jsonb_build_array(jsonb_build_object('entryId', pg_temp.eid(8, 3)::text, 'reason', 'no_show'))
  and cardinality(public._compf2_no_show_entries(pg_temp.rid(8))) = 1
  and jsonb_array_length(public._compf2_evidence(pg_temp.rid(8), 'studio_ordinal_majority', '1') -> 'entries') = 3);
select pg_temp.chk('NS1 semantics: a no-show in one heat but danced in another stays in the other heat''s entryIds',
  (select h -> 'entryIds' from jsonb_array_elements(public._compf2_evidence(pg_temp.rid(8), 'studio_ordinal_majority', '1') -> 'heats') h where h ->> 'heatId' = pg_temp.hid(13)::text)
    = jsonb_build_array(pg_temp.eid(8, 1)::text)
  and (select h -> 'entryIds' from jsonb_array_elements(public._compf2_evidence(pg_temp.rid(8), 'studio_ordinal_majority', '1') -> 'heats') h where h ->> 'heatId' = pg_temp.hid(8)::text)
    = jsonb_build_array(pg_temp.eid(8, 2)::text));
drop function public.competition_heat_entry_is_no_show(uuid);
drop function public.competition_heat_no_show_entries(uuid);
select pg_temp.chk('absent path again: the hash and the evidence are byte-identical to before the hook existed',
  public._compf2_input_hash(pg_temp.rid(1), 'studio_ordinal_majority', '1') = (select v from t_hash where k = 'r1_before')
  and public._compf2_evidence(pg_temp.rid(5), 'studio_ordinal_majority', '1')::text = (select v from t_hash where k = 'r5_before'));

-- ============================================================================
-- 15. Cascades: deleting event B removes nothing of F2 (none there); event A is protected by 10A
-- ============================================================================
select pg_temp.expect_ok('event B deletes cleanly (no F2 evidence references it)', $q$delete from public.events where id = pg_temp.u('00e002')$q$);

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION F2 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION F2 SQL SUITE FAIL: %', v_failures;
end $$;
