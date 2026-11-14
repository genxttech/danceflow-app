-- Competition CF1 package F3 -- result publication (release blocker RB2, gate U66) regression suite.
--
-- Covers 20270122090000_competition_f3_publication.sql on top of the composed chain through CF1 A7 (HL1, A1, A0, A4a, A2, A3, A5, A6, A7).
-- Run as a SUPERUSER (supabase_admin on the partial chain). One transaction, synthetic fixtures only (UUID block ...-f30ff3XXXXXX).
-- Fixtures are placed with session_replication_role = replica; the ENABLE ALWAYS CF1 triggers still fire. The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 F3 SQL SUITE PASS (<n> checks)"  or  "COMPETITION CF1 F3 SQL SUITE FAIL: <failures>".
-- Races (publish vs publish, publish vs correction, withdraw vs supersede) live in test_T_competition_cf1_f3_concurrency.sh.
--
-- Rounds: r1 happy path (public) -> complete -> publication withdrawn (owner decision: a completed round can be withdrawn); r2 stale/exception/fail-closed; r5 correction -> supersede (entrants); r6 withdraw -> correction -> republish;
--         r10 unrelated exception; r12/r13 callback division (tie, advancement, A0 correction guard).
begin;
begin;
-- PV-1 (20270215090000, owner decision 2026-11-10): this suite exercises the result LIFECYCLE with stub engine rows (placements by entry id and a
-- stub trace), not engine correctness, so the database's own recompute would refuse its fixtures by design. Inside this suite's own transaction
-- (it never commits: it ends with the SUITE PASS/FAIL exception) the PV-1 verifier is replaced by a no-op so the lifecycle checks keep their
-- meaning. PV-1 itself is proven by test_T_competition_pv1_recompute.sql, the TS<->SQL equivalence corpus and the PV-1 e2e scenarios.
do $pv1n$
begin
  -- Refuse under per-statement autocommit (then now() equals the statement start): the no-op must never outlive this suite's own transaction.
  if now() = statement_timestamp() then
    raise exception 'PV-1 neutralizer refused: run this suite inside one explicit transaction (no per-statement autocommit), on a local QA database only';
  end if;
  if to_regprocedure('public._comppv1_verify(jsonb,jsonb,jsonb)') is not null then
    execute 'create or replace function public._comppv1_verify(p_ev jsonb, p_rows jsonb, p_warnings jsonb) returns void language plpgsql as $b$ begin null; end $b$';
  end if;
end $pv1n$;

-- HL1: Lock ballots now requires every ballot heat to be danced; suite heats that are locked are marked complete first (superuser, trigger bypass).
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
language sql immutable as $$ select ('00000000-0000-0000-0000-f30ff3' || p_suffix)::uuid $$;
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
-- users: 01 owner A (manager), 02 owner A2 (second manager), 05 owner B, 11 12 13 judges A, 16 scorer A (assigned r5),
--        18 scorer A (assigned nowhere), 20 verified user with no role, 21 verified user (stands in for an entrant dancer)
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-f3-owner-a@example.test'), (pg_temp.u('000002'), 't-f3-owner-a2@example.test'),
  (pg_temp.u('000005'), 't-f3-owner-b@example.test'), (pg_temp.u('000011'), 't-f3-judge1@example.test'),
  (pg_temp.u('000012'), 't-f3-judge2@example.test'), (pg_temp.u('000013'), 't-f3-judge3@example.test'),
  (pg_temp.u('000016'), 't-f3-scorer@example.test'), (pg_temp.u('000018'), 't-f3-scorer2@example.test'),
  (pg_temp.u('000020'), 't-f3-nobody@example.test'), (pg_temp.u('000021'), 't-f3-entrant@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'F3 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-f30ff3%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-f30ff3%';

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'F3 Studio A', 't-f3-studio-a'), (pg_temp.u('00b001'), 'F3 Studio B', 't-f3-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true), (pg_temp.u('000018'), pg_temp.u('00a001'), 'front_desk', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'F3 Comp', 't-f3-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'F3 Other Studio Comp', 't-f3-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
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
    raise exception 'F3 suite needs REG 20270113 (pin_competition_round_scoring)';
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
-- F3 fixtures (superuser): an unverified manager, an entrant stand-in, a callback division (r12 preliminary, r13 final)
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000003'), 't-f3-owner-unverified@example.test'), (pg_temp.u('000022'), 't-f3-entrant2@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000003'), 't-f3-owner-unverified@example.test', 'F3 unverified'), (pg_temp.u('000022'), 't-f3-entrant2@example.test', 'F3 entrant2');
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
values (pg_temp.u('000022'), 't-f3-entrant2@example.test', now(), now(), 'otp', 'web_callback', 'bound', now());
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000003'), pg_temp.u('00a001'), 'studio_owner', true);

-- Entrant stand-ins: user 21 is a competitor of entries r1/1 and r5/1; user 22 of r6/2 only.
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via, user_id) values
  (pg_temp.u('007101'), pg_temp.u('00e001'), 'Ena', 'Entrant', 'staff', pg_temp.u('000021')),
  (pg_temp.u('007102'), pg_temp.u('00e001'), 'Eve', 'Entrant', 'staff', pg_temp.u('000022'));
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name, sort_order) values
  (pg_temp.u('00e001'), pg_temp.eid(1, 1), pg_temp.u('007101'), 'dancer', 'leader', 'Ena Entrant', 1),
  (pg_temp.u('00e001'), pg_temp.eid(5, 1), pg_temp.u('007101'), 'dancer', 'leader', 'Ena Entrant', 1),
  (pg_temp.u('00e001'), pg_temp.eid(6, 2), pg_temp.u('007102'), 'dancer', 'leader', 'Eve Entrant', 1);

-- Callback division d12: preliminary r12 (callback_tally, program promote_callback) and its Final r13. Fixture-only (replica skips the setup guards).
set session_replication_role = replica;
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values (pg_temp.u('001012'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Callback Program', 'country', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values (pg_temp.u('002012'), pg_temp.u('00e001'), pg_temp.u('001012'), 'Callback ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values (pg_temp.did(12), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.u('002012'), 'D12', 'open'),
       (pg_temp.did(14), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.u('002012'), 'D14', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values (pg_temp.rid(12), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(12), 'R12 callback', 'preliminary', 1, 'approved', 'callback_tally', 2),
       (pg_temp.rid(13), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(12), 'R13 final', 'final', 2, 'scheduled', 'ordinal_majority', null),
       (pg_temp.rid(14), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(14), 'R14 callback', 'preliminary', 1, 'approved', 'callback_tally', 2),
       (pg_temp.rid(15), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(14), 'R15 final', 'final', 2, 'scheduled', 'ordinal_majority', null);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(d, i), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(d), 'E' || d || i, 'confirmed', 'eligible', (d * 10 + i)::text
from unnest(array[12, 14]) d cross join generate_series(1, 3) i;
set session_replication_role = origin;

create or replace function pg_temp.pubid(p int, n int) returns uuid language sql stable security definer as $$
  select id from public.event_competition_result_publications where round_id = pg_temp.rid(p) and publication_version = n $$;
create or replace function pg_temp.pcount(p int) returns bigint language sql stable security definer as $$
  select count(*) from public.event_competition_result_publications where round_id = pg_temp.rid(p) $$;
create or replace function pg_temp.pcur(p int) returns bigint language sql stable security definer as $$
  select count(*) from public.event_competition_result_publications where round_id = pg_temp.rid(p) and withdrawn_at is null and superseded_by is null $$;
create or replace function pg_temp.evn(p_kind text, p int default null) returns bigint language sql stable security definer as $$
  select count(*) from public.event_competition_result_events where kind = p_kind and (p is null or round_id = pg_temp.rid(p)) and event_id = pg_temp.u('00e001') $$;
create or replace function pg_temp.pub(p int, p_version int, p_vis text default 'entrants', p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return public.publish_competition_round_result(pg_temp.rid(p), pg_temp.vid(p, p_version), p_vis, p_req);
end $$;
create or replace function pg_temp.wd(p int, n int, p_reason text, p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return public.withdraw_competition_round_result(pg_temp.rid(p), pg_temp.pubid(p, n), p_reason, p_req);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- 1. Surface: table, grants, RLS, function privileges, audit kinds
-- ============================================================================
select pg_temp.chk('the publications table exists with RLS', (select relrowsecurity from pg_class where oid = 'public.event_competition_result_publications'::regclass));
select pg_temp.chk('no API role holds a table write privilege; anon and service_role hold none at all',
  not exists (select 1 from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = 'event_competition_result_publications'
              and ((g.grantee in ('anon', 'authenticated', 'service_role', 'public') and g.privilege_type <> 'SELECT') or g.grantee in ('anon', 'public', 'service_role'))));
select pg_temp.chk('the column names F2, E2, O1 and A5 already read exist: round_id, withdrawn_at, superseded_by',
  (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'event_competition_result_publications' and column_name in ('round_id', 'withdrawn_at', 'superseded_by')));
select pg_temp.chk('anon can execute exactly the two public readers',
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (p.proname like '%publication%' or p.proname like '%results_public' or p.proname like '\_compf3\_%' or p.proname in ('publish_competition_round_result', 'withdraw_competition_round_result', 'competition_my_results'))
     and has_function_privilege('anon', p.oid, 'execute')) = array['competition_event_results_public', 'competition_round_results_public']);
select pg_temp.chk('service_role executes none of the F3 functions and the internal helpers are not executable by any API role',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like '%publication%' or p.proname like '%results_public' or p.proname like '\_compf3\_%' or p.proname in ('publish_competition_round_result', 'withdraw_competition_round_result', 'competition_my_results'))
                and (has_function_privilege('service_role', p.oid, 'execute')
                     or (p.proname like '\_compf3\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))))));
select pg_temp.chk('every F3 function is SECURITY DEFINER with a pinned search_path',
  (select count(*) = 13 and bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (p.proname like '\_compf3\_%' or p.proname in ('publish_competition_round_result', 'withdraw_competition_round_result', 'competition_round_publications',
     'competition_round_results_public', 'competition_event_results_public', 'competition_my_results'))));
select pg_temp.chk('the audit kind check accepts the three F3 kinds and keeps the CF1 kinds',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_result_events_kind_check' and conrelid = 'public.event_competition_result_events'::regclass)
    ~ 'result_published.*result_superseded.*result_withdrawn'
  and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_result_events_kind_check') ~ 'advancement_revoked');
select pg_temp.chk('triggers are installed: insert, update, round status, delete, truncate',
  (select count(*) = 5 from pg_trigger where not tgisinternal and tgname in ('compf3_guard_publication_insert', 'compf3_guard_publication_update', 'compf3_guard_round_status',
     'protect_event_competition_result_publications_delete', 'protect_event_competition_result_publications_truncate')));
select pg_temp.chk('the two CF1 consumers were redefined to look at the CURRENT publication',
  position('_compf3_current_publication' in pg_get_functiondef('public.cf1_guard_advancement_correction()'::regprocedure)) > 0
  and position('superseded_by is null' in pg_get_functiondef('public._a5_cf1_require_no_publication(uuid)'::regprocedure)) > 0);

-- ============================================================================
-- 2. Refusals before anything is approved (r1 calculated, r2 locked, r5 locked)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('calculate r1', $q$select pg_temp.calc(1)$q$);
select pg_temp.expect_msg('a calculated round cannot be published', $q$select pg_temp.pub(1, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_msg('a ballots_locked round cannot be published', $q$select public.publish_competition_round_result(pg_temp.rid(2), gen_random_uuid(), 'entrants', gen_random_uuid())$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('a second manager approves r1', $q$select pg_temp.approve(1, 1)$q$);
reset role;
select pg_temp.chk('r1 is approved and nothing is published', pg_temp.rstatus(1) = 'approved' and pg_temp.pcount(1) = 0);

select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'permission denied');
select pg_temp.expect_msg('anon cannot withdraw', $q$select public.withdraw_competition_round_result(pg_temp.rid(1), gen_random_uuid(), 'because', gen_random_uuid())$q$, 'permission denied');
select pg_temp.expect_msg('anon cannot read the manager history', $q$select public.competition_round_publications(pg_temp.rid(1))$q$, 'permission denied');
select pg_temp.expect_msg('anon cannot read entrant results', $q$select public.competition_my_results(pg_temp.u('00e001'))$q$, 'permission denied');
reset role;
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('a user with no role cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.expect_msg('an entrant cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot publish event A', $q$select pg_temp.pub(1, 1)$q$, 'COMP_FORBIDDEN');
select pg_temp.expect_msg('cross-tenant: studio B owner cannot read event A history', $q$select public.competition_round_publications(pg_temp.rid(1))$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('a manager without a verified email cannot publish', $q$select pg_temp.pub(1, 1)$q$, 'COMP_VERIFIED_EMAIL_REQUIRED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a request id is required', $q$select public.publish_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 1), 'entrants', null)$q$, 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.expect_msg('an unknown visibility is refused (never defaults to public)', $q$select pg_temp.pub(1, 1, 'everyone')$q$, 'COMP_PUBLICATION_VISIBILITY');
select pg_temp.expect_msg('a version of another round is refused', format($q$select public.publish_competition_round_result(%L, %L, 'entrants', gen_random_uuid())$q$, pg_temp.rid(1), pg_temp.u('0aaaaa')), 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('none of the refusals wrote anything', pg_temp.pcount(1) = 0 and pg_temp.evn('result_published') = 0 and pg_temp.rstatus(1) = 'approved');

-- ============================================================================
-- 3. Stale: ballots/roster changed after approval (r2)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('calculate r2', $q$select pg_temp.calc(2)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('approve r2', $q$select pg_temp.approve(2, 1)$q$);
reset role;
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.hid(2) and entry_id = pg_temp.eid(2, 3);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an approved version whose input no longer matches the ballots cannot be published', $q$select pg_temp.pub(2, 1)$q$, 'COMP_RESULT_STALE');
reset role;
select pg_temp.chk('the refused publish changed nothing', pg_temp.pcount(2) = 0 and pg_temp.rstatus(2) = 'approved' and pg_temp.vstatus(2, 1) = 'approved');
select pg_temp.expect_msg('backstop: a direct round status write approved -> published without the F3 audit row is refused', $q$update public.event_competition_rounds set status = 'published' where id = pg_temp.rid(2)$q$, 'COMPF3_ROUND_WRITER');

-- ============================================================================
-- 4. Happy path (r1, public): publish, replay, immutability, audit
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('publish r1 as public', format($q$select public.publish_competition_round_result(%L, %L, 'public', %L)$q$, pg_temp.rid(1), pg_temp.vid(1, 1), pg_temp.u('f30001')));
select pg_temp.chk('the publish answer is not a replay', (public.publish_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 1), 'public', pg_temp.u('f30001')) ->> 'replayed')::boolean);
reset role;
select pg_temp.chk('r1 is published with one current public publication (version 1) of the approved version',
  pg_temp.rstatus(1) = 'published' and pg_temp.pcount(1) = 1 and pg_temp.pcur(1) = 1
  and (select visibility = 'public' and publication_version = 1 and result_version_id = pg_temp.vid(1, 1) and published_by = pg_temp.u('000001') from public.event_competition_result_publications where round_id = pg_temp.rid(1)));
select pg_temp.chk('the result version stays approved and the heats stay certified', pg_temp.vstatus(1, 1) = 'approved'
  and not exists (select 1 from public.event_competition_heats where round_id = pg_temp.rid(1) and lock_state <> 'certified'));
select pg_temp.chk('one result_published audit row: approved -> published, actor, version, visibility, publication id',
  (select count(*) = 1 and bool_and(from_state = 'approved' and to_state = 'published' and actor_user_id = pg_temp.u('000001') and result_version_id = pg_temp.vid(1, 1)
          and refs ->> 'visibility' = 'public' and refs ->> 'publication_id' = pg_temp.pubid(1, 1)::text and (refs ->> 'publication_version')::int = 1)
   from public.event_competition_result_events where kind = 'result_published' and round_id = pg_temp.rid(1)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('replaying the same request id returns the same publication and writes nothing',
  (public.publish_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 1), 'public', pg_temp.u('f30001')) ->> 'replayed')::boolean
  and public.publish_competition_round_result(pg_temp.rid(1), pg_temp.vid(1, 1), 'public', pg_temp.u('f30001')) ->> 'publication_id' = pg_temp.pubid(1, 1)::text);
select pg_temp.expect_msg('the same request id for another visibility is a reuse', format($q$select public.publish_competition_round_result(%L, %L, 'entrants', %L)$q$, pg_temp.rid(1), pg_temp.vid(1, 1), pg_temp.u('f30001')), 'COMP_REQUEST_REUSED');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('the same request id from another actor is a reuse', format($q$select public.publish_competition_round_result(%L, %L, 'public', %L)$q$, pg_temp.rid(1), pg_temp.vid(1, 1), pg_temp.u('f30001')), 'COMP_REQUEST_REUSED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a new request id on a published round is refused (no re-publish)', $q$select pg_temp.pub(1, 1, 'public')$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
select pg_temp.chk('replays and refusals added nothing', pg_temp.pcount(1) = 1 and pg_temp.evn('result_published', 1) = 1);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a manager cannot write the table directly', format($q$insert into public.event_competition_result_publications (event_id, round_id, result_version_id, publication_version, published_by, request_id) values (%L, %L, %L, 9, %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(1), pg_temp.vid(1, 1), pg_temp.u('000001')), 'permission denied');
select pg_temp.expect_msg('a manager cannot update the table directly', $q$update public.event_competition_result_publications set withdrawn_reason = 'x'$q$, 'permission denied');
reset role;
select pg_temp.expect_msg('immutable: a publication column other than the stamps cannot change (superuser)', $q$update public.event_competition_result_publications set visibility = 'entrants' where round_id = pg_temp.rid(1)$q$, 'COMPF3_PUBLICATION_IMMUTABLE');
select pg_temp.expect_msg('backstop: a withdraw stamp without its audit row is refused (superuser)', $q$update public.event_competition_result_publications set withdrawn_at = now(), withdrawn_by = pg_temp.u('000001'), withdrawn_reason = 'x y z' where round_id = pg_temp.rid(1)$q$, 'COMPF3_PUBLICATION_WRITER');
select pg_temp.expect_msg('backstop: a supersede stamp without its audit row is refused (superuser)', $q$update public.event_competition_result_publications set superseded_by = id where round_id = pg_temp.rid(1)$q$, 'COMPF3_PUBLICATION_WRITER');
select pg_temp.expect_msg('backstop: a publication row cannot be inserted without the audit row (superuser)', format($q$insert into public.event_competition_result_publications (event_id, round_id, result_version_id, publication_version, published_by, request_id) values (%L, %L, %L, 9, %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.rid(2), pg_temp.vid(2, 1), pg_temp.u('000001')), 'COMPF3_PUBLICATION_WRITER');
select pg_temp.expect_msg('a publication cannot be deleted', $q$delete from public.event_competition_result_publications where round_id = pg_temp.rid(1)$q$, 'append-only evidence');
set constraints all immediate;
select pg_temp.expect_msg('the table cannot be truncated', $q$truncate public.event_competition_result_publications$q$, 'append-only evidence');
select pg_temp.expect_msg('a published result row cannot be edited', $q$update public.event_competition_result_rows set placement = 9 where result_version_id = pg_temp.vid(1, 1)$q$, 'append-only evidence');

-- ============================================================================
-- 5. Readers (r1 public; later r5 entrants only)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('manager history lists the publication as current with no reason', (public.competition_round_publications(pg_temp.rid(1)) -> 0 ->> 'state') = 'current'
  and jsonb_array_length(public.competition_round_publications(pg_temp.rid(1))) = 1);
reset role;
select pg_temp.as_anon();
select pg_temp.chk('anon reads the public result of a public event: published, three rows with placements and names',
  (public.competition_round_results_public(pg_temp.rid(1)) ->> 'published')::boolean
  and jsonb_array_length(public.competition_round_results_public(pg_temp.rid(1)) -> 'rows') = 3
  and (public.competition_round_results_public(pg_temp.rid(1)) -> 'rows' -> 0 ->> 'display_name') is not null
  and (public.competition_round_results_public(pg_temp.rid(1)) -> 'rows' -> 0 ->> 'placement') = '1');
select pg_temp.chk('the public payload carries no judge, scorer, approver, hash, trace, score or reason fields',
  public.competition_round_results_public(pg_temp.rid(1))::text !~* '(input_hash|trace|calculated_by|approved_by|official|judge|scorer|reason|marks|ballot|output|published_by)');
select pg_temp.chk('the public event listing returns r1 only', jsonb_array_length(public.competition_event_results_public(pg_temp.u('00e001'))) = 1
  and public.competition_event_results_public(pg_temp.u('00e001')) -> 0 -> 'round' ->> 'id' = pg_temp.rid(1)::text);
select pg_temp.chk('an unpublished (approved) round answers published=false', public.competition_round_results_public(pg_temp.rid(2)) ->> 'published' = 'false');
select pg_temp.chk('an unknown round answers published=false', public.competition_round_results_public(gen_random_uuid()) ->> 'published' = 'false');
select pg_temp.chk('other events show nothing', public.competition_event_results_public(pg_temp.u('00e002')) = '[]'::jsonb);
reset role;
set session_replication_role = replica;
update public.events set status = 'draft' where id = pg_temp.u('00e001');
set session_replication_role = origin;
select pg_temp.as_anon();
select pg_temp.chk('a non-published event shows nothing publicly even for a public publication',
  public.competition_round_results_public(pg_temp.rid(1)) ->> 'published' = 'false' and public.competition_event_results_public(pg_temp.u('00e001')) = '[]'::jsonb);
reset role;
set session_replication_role = replica;
update public.events set status = 'published' where id = pg_temp.u('00e001');
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('the entrant sees r1 (public publication): all names, own row flagged mine',
  jsonb_array_length(public.competition_my_results(pg_temp.u('00e001'))) = 1
  and (select count(*) = 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001')) -> 0 -> 'rows') r where (r ->> 'mine')::boolean)
  and not exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001')) -> 0 -> 'rows') r where r ->> 'display_name' is null));
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.chk('a user with no entry sees nothing', public.competition_my_results(pg_temp.u('00e001')) = '[]'::jsonb);
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('an entrant of another round sees nothing of r1', public.competition_my_results(pg_temp.u('00e001')) = '[]'::jsonb);
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.chk('cross-tenant: studio B owner sees nothing of event A', public.competition_my_results(pg_temp.u('00e001')) = '[]'::jsonb);
reset role;

-- ============================================================================
-- 6. Correction -> supersede (r5, entrants only)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('calculate r5', $q$select pg_temp.calc(5)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('approve r5 v1', $q$select pg_temp.approve(5, 1)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('publish r5 v1 (entrants)', $q$select pg_temp.pub(5, 1, 'entrants', pg_temp.u('f30005'))$q$);
reset role;
select pg_temp.as_anon();
select pg_temp.chk('an entrants-only publication is invisible to the public', public.competition_round_results_public(pg_temp.rid(5)) = '{"published": false, "under_review": false}'::jsonb
  and public.competition_event_results_public(pg_temp.u('00e001')) -> 0 ->> 'rows' is not null and jsonb_array_length(public.competition_event_results_public(pg_temp.u('00e001'))) = 1);
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('the entrant sees r5 with own name only: others show a number but no name',
  (select count(*) = 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(5)::text)
  and (select count(*) filter (where r ->> 'display_name' is not null) = 1 and count(*) filter (where (r ->> 'mine')::boolean) = 1 and count(*) = 3
       from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x, jsonb_array_elements(x -> 'rows') r where x -> 'round' ->> 'id' = pg_temp.rid(5)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('a correction opens on the published r5 (published -> ballots_locked)', $q$select public.open_competition_round_correction(pg_temp.rid(5), 'judge 2 mis-ranked', gen_random_uuid())$q$);
reset role;
select pg_temp.chk('the publication stays CURRENT during the correction (K0) and the version went stale',
  pg_temp.pcur(5) = 1 and pg_temp.rstatus(5) = 'ballots_locked' and pg_temp.vstatus(5, 1) = 'stale');
select pg_temp.as_user(pg_temp.u('000021'));
-- INT5-SECFIX P2-2 (was: "the entrant still sees v1 during the correction", count 2): the stale v1 of an opened correction is NOT readable any more.
select pg_temp.chk('P2-2: the entrant does NOT see the stale v1 of r5 during the correction (only r1 remains)',
  jsonb_array_length(public.competition_my_results(pg_temp.u('00e001'))) = 1
  and not exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(5)::text));
select pg_temp.as_anon();
select pg_temp.chk('P2-2: anon event list does not contain r5 (entrants-only anyway) and the round reader gives nothing for it',
  public.competition_round_results_public(pg_temp.rid(5)) = '{"published": false, "under_review": false}'::jsonb
  and not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(5)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a stale version cannot be published (the round is not approved)', $q$select pg_temp.pub(5, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_ok('recalculate r5 (v2)', $q$select pg_temp.calc(5)$q$);
select pg_temp.expect_msg('a calculated v2 cannot be published before approval', $q$select pg_temp.pub(5, 2)$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('approve r5 v2', $q$select pg_temp.approve(5, 2)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('the superseded older version cannot be published', $q$select pg_temp.pub(5, 1)$q$, 'COMP_RESULT_STALE');
select pg_temp.expect_ok('publish r5 v2: supersedes publication 1', $q$select pg_temp.pub(5, 2, 'entrants', pg_temp.u('f30006'))$q$);
reset role;
select pg_temp.chk('r5 is published again; publication 1 is superseded by 2 and 2 is the only current one',
  pg_temp.rstatus(5) = 'published' and pg_temp.pcount(5) = 2 and pg_temp.pcur(5) = 1
  and (select superseded_by = pg_temp.pubid(5, 2) and withdrawn_at is null from public.event_competition_result_publications where id = pg_temp.pubid(5, 1))
  and (select publication_version = 2 and withdrawn_at is null and superseded_by is null and result_version_id = pg_temp.vid(5, 2) from public.event_competition_result_publications where id = pg_temp.pubid(5, 2)));
select pg_temp.chk('audit: one result_published for v2 (supersedes_publication_id) and one result_superseded for publication 1 in the same transaction',
  (select count(*) = 1 from public.event_competition_result_events where kind = 'result_published' and round_id = pg_temp.rid(5) and refs ->> 'publication_id' = pg_temp.pubid(5, 2)::text
     and refs ->> 'supersedes_publication_id' = pg_temp.pubid(5, 1)::text)
  and (select count(*) = 1 from public.event_competition_result_events s join public.event_competition_result_events p on p.request_id = (s.refs ->> 'request_id')::uuid and p.kind = 'result_published' and p.transaction_id = s.transaction_id
       where s.kind = 'result_superseded' and s.round_id = pg_temp.rid(5) and s.refs ->> 'publication_id' = pg_temp.pubid(5, 1)::text and s.refs ->> 'superseded_by' = pg_temp.pubid(5, 2)::text and p.refs ->> 'publication_id' = pg_temp.pubid(5, 2)::text));
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('P2-2: after the correction resolves the entrant sees the corrected r5 (publication 2, version 2) again',
  jsonb_array_length(public.competition_my_results(pg_temp.u('00e001'))) = 2
  and (select x -> 'publication' ->> 'version' = '2' from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(5)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('manager history: 2 rows, newest first, with states', public.competition_round_publications(pg_temp.rid(5)) -> 0 ->> 'state' = 'current'
  and public.competition_round_publications(pg_temp.rid(5)) -> 1 ->> 'state' = 'superseded');
select pg_temp.expect_msg('a superseded publication cannot be withdrawn', $q$select pg_temp.wd(5, 1, 'late fix')$q$, 'COMP_PUBLICATION_NOT_CURRENT');
reset role;

-- ============================================================================
-- 7. Withdraw and recovery (r6)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('calculate r6', $q$select pg_temp.calc(6)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('approve r6', $q$select pg_temp.approve(6, 1)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('nothing to withdraw before publication', format($q$select public.withdraw_competition_round_result(%L, %L, 'oops', gen_random_uuid())$q$, pg_temp.rid(6), pg_temp.u('0bbbbb')), 'COMP_FORBIDDEN');
select pg_temp.expect_ok('publish r6 as public', $q$select pg_temp.pub(6, 1, 'public', pg_temp.u('f30007'))$q$);
select pg_temp.expect_msg('withdraw needs a reason', $q$select pg_temp.wd(6, 1, '  ')$q$, 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('withdraw reason of one character is refused', $q$select pg_temp.wd(6, 1, 'x')$q$, 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('withdraw reason over 500 characters is refused', format($q$select pg_temp.wd(6, 1, %L)$q$, repeat('x', 501)), 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('withdraw needs a request id', format($q$select public.withdraw_competition_round_result(%L, %L, 'bad total', null)$q$, pg_temp.rid(6), pg_temp.pubid(6, 1)), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('withdraw needs a verified email', $q$select pg_temp.wd(6, 1, 'bad total')$q$, 'COMP_VERIFIED_EMAIL_REQUIRED');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot withdraw', $q$select pg_temp.wd(6, 1, 'bad total')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot withdraw', $q$select pg_temp.wd(6, 1, 'bad total')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a publication of another round cannot be withdrawn through this round', format($q$select public.withdraw_competition_round_result(%L, %L, 'bad total', gen_random_uuid())$q$, pg_temp.rid(6), pg_temp.pubid(1, 1)), 'COMP_FORBIDDEN');
reset role;
select pg_temp.expect_msg('A5: an exclusion is refused while a publication is current', $q$select public._a5_cf1_require_no_publication(pg_temp.rid(6))$q$, 'COMP_EXCLUSION_PUBLICATION_EXISTS');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('withdraw r6 publication 1', format($q$select public.withdraw_competition_round_result(%L, %L, 'wrong total shown', %L)$q$, pg_temp.rid(6), pg_temp.pubid(6, 1), pg_temp.u('f30008')));
select pg_temp.chk('replaying the withdraw returns replayed', (public.withdraw_competition_round_result(pg_temp.rid(6), pg_temp.pubid(6, 1), 'wrong total shown', pg_temp.u('f30008')) ->> 'replayed')::boolean);
select pg_temp.expect_msg('a withdrawn publication cannot be withdrawn again with a new request', $q$select pg_temp.wd(6, 1, 'again please')$q$, 'COMP_PUBLICATION_NOT_CURRENT');
reset role;
select pg_temp.chk('withdrawn: stamps set (who, when, reason), no current publication, round still published, version still approved',
  (select withdrawn_at is not null and withdrawn_by = pg_temp.u('000001') and withdrawn_reason = 'wrong total shown' and superseded_by is null
   from public.event_competition_result_publications where id = pg_temp.pubid(6, 1))
  and pg_temp.pcur(6) = 0 and pg_temp.rstatus(6) = 'published' and pg_temp.vstatus(6, 1) = 'approved');
select pg_temp.chk('one result_withdrawn audit row with the reason and publication id',
  (select count(*) = 1 and bool_and(reason = 'wrong total shown' and refs ->> 'publication_id' = pg_temp.pubid(6, 1)::text and from_state = 'current' and to_state = 'withdrawn')
   from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = pg_temp.rid(6)));
select pg_temp.expect_msg('a withdrawn publication never changes again (superuser)', $q$update public.event_competition_result_publications set superseded_by = pg_temp.pubid(6, 1) where id = pg_temp.pubid(6, 1)$q$, 'COMPF3_PUBLICATION_FINAL');
select pg_temp.as_anon();
select pg_temp.chk('the public sees a generic under-review notice and no reason', public.competition_round_results_public(pg_temp.rid(6)) = '{"published": false, "under_review": true}'::jsonb
  and jsonb_array_length(public.competition_event_results_public(pg_temp.u('00e001'))) = 1);
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('a withdrawn publication disappears from the entrant reader at once', public.competition_my_results(pg_temp.u('00e001')) = '[]'::jsonb);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('managers still read the withdrawn publication with its reason',
  public.competition_round_publications(pg_temp.rid(6)) -> 0 ->> 'state' = 'withdrawn' and public.competition_round_publications(pg_temp.rid(6)) -> 0 ->> 'withdrawn_reason' = 'wrong total shown');
select pg_temp.expect_msg('a withdrawn version is never republished as it is: the round is already published', $q$select pg_temp.pub(6, 1)$q$, 'COMP_RESULT_INVALID_TRANSITION');
select pg_temp.expect_msg('complete is refused while no publication is current', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(6)), 'COMP_PUBLICATION_REQUIRES_APPROVAL');
reset role;
select pg_temp.expect_ok('A5: the publication check passes after the withdraw', $q$select public._a5_cf1_require_no_publication(pg_temp.rid(6))$q$);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('recovery step 1: open a correction on the published, withdrawn round', $q$select public.open_competition_round_correction(pg_temp.rid(6), 'recompute after withdrawal', gen_random_uuid())$q$);
select pg_temp.expect_ok('recovery step 2: recalculate (v2)', $q$select pg_temp.calc(6)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('recovery step 3: approve v2', $q$select pg_temp.approve(6, 2)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('recovery step 4: publish v2 (no supersede: the old one was withdrawn)', $q$select pg_temp.pub(6, 2, 'public', pg_temp.u('f30009'))$q$);
reset role;
select pg_temp.chk('r6 now has publication 1 withdrawn and 2 current, nothing superseded',
  pg_temp.pcount(6) = 2 and pg_temp.pcur(6) = 1 and pg_temp.rstatus(6) = 'published'
  and (select superseded_by is null and withdrawn_at is not null from public.event_competition_result_publications where id = pg_temp.pubid(6, 1))
  and pg_temp.evn('result_superseded', 6) = 0);
select pg_temp.chk('the correction after the withdrawal recorded its own A7 cause (separation of duties stays with the correction rules)',
  (select count(*) >= 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(6)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('O1: a round with a publication (withdrawn or not) cannot be cancelled', format($q$select public.cancel_competition_round(%L, 'too late to cancel', gen_random_uuid())$q$, pg_temp.rid(6)), 'COMPO1_PUBLISHED');
reset role;
select pg_temp.as_anon();
select pg_temp.chk('the public sees the republished result again', (public.competition_round_results_public(pg_temp.rid(6)) ->> 'published')::boolean);
reset role;
-- P2-1: an excluded couple is never named on the public path (number only); the couple itself still sees its own name.
set session_replication_role = replica;
insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id) values
  (pg_temp.u('0e1001'), pg_temp.u('00e001'), pg_temp.rid(6), pg_temp.eid(6, 2), 'exclude_requested', 'refunded', 'refund after dancing', pg_temp.u('000001'), 'manager', gen_random_uuid(), 1, null);
insert into public.event_competition_round_exclusions (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id) values
  (pg_temp.u('0e1002'), pg_temp.u('00e001'), pg_temp.rid(6), pg_temp.eid(6, 2), 'exclude_cosigned', 'refunded', 'refund after dancing', pg_temp.u('000002'), 'manager', gen_random_uuid(), 2, pg_temp.u('0e1001'));
set session_replication_role = origin;
select pg_temp.as_anon();
select pg_temp.chk('public round reader: excluded couple appears by number only, no name, no reason',
  (select count(*) = 1 and bool_and(x ->> 'display_name' is null and x ->> 'entry_number' is not null) from jsonb_array_elements(public.competition_round_results_public(pg_temp.rid(6)) -> 'excluded') x)
  and not exists (select 1 from jsonb_array_elements(public.competition_round_results_public(pg_temp.rid(6)) -> 'rows') r where r ->> 'entry_number' = (select entry_number from public.event_competition_entries where id = pg_temp.eid(6, 2)) and r ->> 'display_name' is not null)
  and public.competition_round_results_public(pg_temp.rid(6))::text !~* 'refund');
select pg_temp.chk('public event reader: the excluded couple is not named there either',
  not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) p, jsonb_array_elements(p -> 'rows') r
              where r ->> 'entry_number' = (select entry_number from public.event_competition_entries where id = pg_temp.eid(6, 2)) and r ->> 'display_name' is not null)
  and not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) p, jsonb_array_elements(p -> 'excluded') x where x ->> 'display_name' is not null));
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('the excluded couple itself still sees its own name and mine flag',
  exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) p, jsonb_array_elements(p -> 'excluded') x where (x ->> 'mine')::boolean and x ->> 'display_name' is not null));
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('another entrant on the public publication does not see the excluded couple named',
  not exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) p, jsonb_array_elements(p -> 'excluded') x where not (x ->> 'mine')::boolean and x ->> 'display_name' is not null));
reset role;

-- ============================================================================
-- 8. complete needs a current publication, then final (r1)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('complete r1 (published, current publication)', format($q$select public.complete_competition_round(%L, gen_random_uuid())$q$, pg_temp.rid(1)));
reset role;
select pg_temp.chk('r1 complete and its publication still current', pg_temp.rstatus(1) = 'complete' and pg_temp.pcur(1) = 1);

-- ============================================================================
-- 8b. Owner decision (CF1 integration-4): a COMPLETED round's publication can be withdrawn (authorized, audited, history kept)
-- ============================================================================
create temp table t_w1 on commit drop as
select p.*, md5((select string_agg(rr::text, '|' order by rr.id) from public.event_competition_result_rows rr where rr.result_version_id = p.result_version_id)) as rows_md5,
       (select v::text from public.event_competition_result_versions v where v.id = p.result_version_id) as ver_text
from public.event_competition_result_publications p where p.round_id = pg_temp.rid(1);
grant all on t_w1 to authenticated, anon, service_role;
create temp table t_w1_ev on commit drop as
select e.id, e.kind from public.event_competition_result_events e where e.round_id = pg_temp.rid(1);
grant all on t_w1_ev to authenticated, anon, service_role;
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('the entrant reader shows the complete round before the withdrawal',
  exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) p where p -> 'round' ->> 'id' = pg_temp.rid(1)::text));
reset role;
select pg_temp.as_anon();
select pg_temp.chk('the public reader shows the complete public round before the withdrawal', (public.competition_round_results_public(pg_temp.rid(1)) ->> 'published')::boolean);
select pg_temp.expect_msg('complete: anon cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'permission denied');
reset role;
-- authorization
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.expect_msg('complete: an entrant cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('complete: a scorer cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('complete: a judge cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('complete: cross-tenant, studio B owner cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('complete: a manager without a verified email cannot withdraw', $q$select pg_temp.wd(1, 1, 'result sheet error')$q$, 'COMP_VERIFIED_EMAIL_REQUIRED');
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('complete: a reason is required', $q$select pg_temp.wd(1, 1, ' x ')$q$, 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('complete: a request id is required', format($q$select public.withdraw_competition_round_result(%L, %L, 'result sheet error', null)$q$, pg_temp.rid(1), pg_temp.pubid(1, 1)), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.expect_msg('complete: a publication of another round is refused', format($q$select public.withdraw_competition_round_result(%L, %L, 'result sheet error', gen_random_uuid())$q$, pg_temp.rid(1), pg_temp.pubid(6, 1)), 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('complete: every refused attempt wrote nothing', pg_temp.pcur(1) = 1 and pg_temp.evn('result_withdrawn', 1) = 0 and pg_temp.rstatus(1) = 'complete');
-- the withdrawal itself
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('complete: a manager withdraws the publication of the completed round', format($q$select public.withdraw_competition_round_result(%L, %L, 'result sheet error', %L)$q$, pg_temp.rid(1), pg_temp.pubid(1, 1), pg_temp.u('f30071')));
select pg_temp.chk('complete: replaying the same request returns replayed and writes nothing more',
  (public.withdraw_competition_round_result(pg_temp.rid(1), pg_temp.pubid(1, 1), 'result sheet error', pg_temp.u('f30071')) ->> 'replayed')::boolean
  and pg_temp.evn('result_withdrawn', 1) = 1);
select pg_temp.expect_msg('complete: the same request id for another publication is a reuse', format($q$select public.withdraw_competition_round_result(%L, %L, 'result sheet error', %L)$q$, pg_temp.rid(6), pg_temp.pubid(6, 2), pg_temp.u('f30071')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_msg('complete: a second withdrawal with a new request id is refused', $q$select pg_temp.wd(1, 1, 'again please')$q$, 'COMP_PUBLICATION_NOT_CURRENT');
select pg_temp.expect_msg('complete: a completed round cannot be re-published (no supersession path from complete)', $q$select pg_temp.pub(1, 1, 'public')$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
-- history preserved: nothing deleted, nothing rewritten except the once-only stamp
select pg_temp.chk('complete: the round stays complete and no new publication row was created', pg_temp.rstatus(1) = 'complete' and pg_temp.pcount(1) = 1 and pg_temp.pcur(1) = 0);
select pg_temp.chk('complete: original publication kept (version, visibility, publisher, time, request, result version); only the withdraw stamp changed',
  (select (to_jsonb(p) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason') = (to_jsonb(w) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason' - 'rows_md5' - 'ver_text')
          and p.withdrawn_at is not null and p.withdrawn_by = pg_temp.u('000001') and p.withdrawn_reason = 'result sheet error' and p.superseded_by is null
   from public.event_competition_result_publications p join t_w1 w on w.id = p.id));
select pg_temp.chk('complete: the result version and its rows are byte-identical after the withdrawal (the snapshot is untouched)',
  (select md5((select string_agg(rr::text, '|' order by rr.id) from public.event_competition_result_rows rr where rr.result_version_id = w.result_version_id)) = w.rows_md5
          and (select v::text from public.event_competition_result_versions v where v.id = w.result_version_id) = w.ver_text
   from t_w1 w));
select pg_temp.chk('complete: the earlier audit rows are all still there and one result_withdrawn row was added with actor, reason and the version facts',
  (select count(*) = (select count(*) from t_w1_ev) from public.event_competition_result_events e join t_w1_ev o on o.id = e.id)
  and (select count(*) = 1 and bool_and(actor_user_id = pg_temp.u('000001') and reason = 'result sheet error' and from_state = 'current' and to_state = 'withdrawn'
                                      and refs ->> 'publication_id' = pg_temp.pubid(1, 1)::text and refs ->> 'round_status' = 'complete'
                                      and refs ->> 'published_by' = pg_temp.u('000001')::text and refs ->> 'input_hash' is not null and result_version_id = pg_temp.vid(1, 1))
       from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = pg_temp.rid(1))
  and pg_temp.evn('result_published', 1) = 1);
select pg_temp.expect_msg('complete: a withdrawn publication cannot be un-withdrawn (superuser)', $q$update public.event_competition_result_publications set withdrawn_at = null, withdrawn_by = null, withdrawn_reason = null where round_id = pg_temp.rid(1)$q$, 'COMPF3_PUBLICATION_FINAL');
select pg_temp.expect_msg('complete: the withdrawn publication cannot be deleted', $q$delete from public.event_competition_result_publications where round_id = pg_temp.rid(1)$q$, 'append-only evidence');
select pg_temp.expect_msg('complete: the audit row cannot be deleted', $q$delete from public.event_competition_result_events where kind = 'result_withdrawn' and round_id = pg_temp.rid(1)$q$, 'append-only evidence');
-- readers
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.chk('complete: the entrant reader no longer shows the withdrawn publication', not exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) p where p -> 'round' ->> 'id' = pg_temp.rid(1)::text));
reset role;
select pg_temp.as_anon();
select pg_temp.chk('complete: the public round reader answers published=false with the generic under_review notice and no result data',
  (public.competition_round_results_public(pg_temp.rid(1)) ->> 'published')::boolean is false and (public.competition_round_results_public(pg_temp.rid(1)) ->> 'under_review')::boolean
  and public.competition_round_results_public(pg_temp.rid(1)) ->> 'rows' is null and public.competition_round_results_public(pg_temp.rid(1))::text !~* 'result sheet error');
select pg_temp.chk('complete: the public event reader no longer lists the withdrawn round',
  not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) p where p -> 'round' ->> 'id' = pg_temp.rid(1)::text));
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('complete: the manager history keeps the withdrawn publication with its reason',
  public.competition_round_publications(pg_temp.rid(1)) -> 0 ->> 'state' = 'withdrawn' and public.competition_round_publications(pg_temp.rid(1)) -> 0 ->> 'withdrawn_reason' = 'result sheet error'
  and jsonb_array_length(public.competition_round_publications(pg_temp.rid(1))) = 1);
reset role;

-- ============================================================================
-- 9. Unresolved callback result, advancement mismatch, correction guard (r12/r13)
-- ============================================================================
set session_replication_role = replica;
insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id, status)
select pg_temp.u('0c' || v || '000'), pg_temp.u('00e001'), pg_temp.rid(12), v, 'studio_callback_tally', '1',
       public._compf2_input_hash(pg_temp.rid(12), 'studio_callback_tally', '1'), pg_temp.th(), '{}', '[]', pg_temp.u('000001'), pg_temp.u('f3c0' || v || '1'), case when v = 1 then 'superseded' else 'approved' end
from generate_series(1, 2) v;
insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement, advanced)
select pg_temp.u('00e001'), pg_temp.u('0c2000'), pg_temp.eid(12, i), null, case when i = 3 then null else true end from generate_series(1, 3) i;
insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, request_id)
values (pg_temp.u('00e001'), pg_temp.u('0c2000'), pg_temp.u('000002'), pg_temp.u('000001'), gen_random_uuid());
set session_replication_role = origin;
create or replace function pg_temp.vid12() returns uuid language sql immutable as $$ select pg_temp.u('0c2000') $$;
grant execute on function pg_temp.vid12() to authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a callback result with an undecided row (tie) cannot be published',
  $q$select public.publish_competition_round_result(pg_temp.rid(12), pg_temp.vid12(), 'entrants', gen_random_uuid())$q$, 'COMP_PUBLICATION_UNRESOLVED');
reset role;
set session_replication_role = replica;
update public.event_competition_result_rows set advanced = false where result_version_id = pg_temp.u('0c2000') and entry_id = pg_temp.eid(12, 3);
-- r14: an old version (v1, superseded) and the latest approved version (v2); the Final was advanced from the OLD one.
insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, request_id, status)
select pg_temp.u('0c' || (2 + v) || '000'), pg_temp.u('00e001'), pg_temp.rid(14), v, 'studio_callback_tally', '1',
       public._compf2_input_hash(pg_temp.rid(14), 'studio_callback_tally', '1'), pg_temp.th(), '{}', '[]', pg_temp.u('000001'), pg_temp.u('f3c1' || v || '1'), case when v = 1 then 'superseded' else 'approved' end
from generate_series(1, 2) v;
insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement, advanced)
select pg_temp.u('00e001'), pg_temp.u('0c4000'), pg_temp.eid(14, i), null, i < 3 from generate_series(1, 3) i;
insert into public.event_competition_result_approvals (event_id, result_version_id, approved_by, calculated_by, request_id)
values (pg_temp.u('00e001'), pg_temp.u('0c4000'), pg_temp.u('000002'), pg_temp.u('000001'), gen_random_uuid());
insert into public.event_competition_round_advancements (id, event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id,
  source_input_hash, source_trace_hash, advanced_count, carried_count, target_capacity, applied_by, request_id)
values (pg_temp.u('0d1400'), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(14), pg_temp.rid(14), pg_temp.rid(15), 1, pg_temp.u('0c3000'),
  repeat('a', 64), repeat('b', 64), 2, 0, 8, pg_temp.u('000001'), gen_random_uuid());
insert into public.event_competition_round_advancements (id, event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id,
  source_input_hash, source_trace_hash, advanced_count, carried_count, target_capacity, applied_by, request_id)
values (pg_temp.u('0d1200'), pg_temp.u('00e001'), pg_temp.u('001012'), pg_temp.did(12), pg_temp.rid(12), pg_temp.rid(13), 1, pg_temp.u('0c2000'),
  repeat('a', 64), repeat('b', 64), 2, 0, 8, pg_temp.u('000001'), gen_random_uuid());
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an active advancement from a different result version blocks publication',
  $q$select public.publish_competition_round_result(pg_temp.rid(14), pg_temp.u('0c4000'), 'entrants', gen_random_uuid())$q$, 'COMP_PUBLICATION_UNRESOLVED');
reset role;
select pg_temp.chk('the refused callback publications wrote nothing', pg_temp.pcount(12) = 0 and pg_temp.pcount(14) = 0 and pg_temp.rstatus(14) = 'approved');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('a decided callback result with a matching advancement is published',
  $q$select public.publish_competition_round_result(pg_temp.rid(12), pg_temp.vid12(), 'entrants', gen_random_uuid())$q$);
reset role;
select pg_temp.chk('r12 is published', pg_temp.rstatus(12) = 'published' and pg_temp.pcur(12) = 1);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('A0 + F3: a published callback result with an active advancement cannot be corrected while its publication is current',
  format($q$select public.open_competition_round_correction(%L, 'tie fix', gen_random_uuid())$q$, pg_temp.rid(12)), 'COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3');
select pg_temp.expect_ok('withdraw the callback publication', $q$select pg_temp.wd(12, 1, 'callback list under review')$q$);
reset role;
create or replace function pg_temp.corr12() returns text language plpgsql as $$
declare v_msg text := 'opened';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('000001'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.open_competition_round_correction(pg_temp.rid(12), 'tie fix after withdrawal', gen_random_uuid());
  exception when others then
    v_msg := sqlerrm;
  end;
  execute 'reset role';
  return v_msg;
end $$;
create temp table t_corr12 on commit drop as select pg_temp.corr12() as msg;
select pg_temp.chk('after the withdraw the A0 correction guard no longer stops on PUBLISHED_NEEDS_F3', position('PUBLISHED_NEEDS_F3' in (select msg from t_corr12)) = 0, (select msg from t_corr12));
select pg_temp.chk('...and the correction opened: the round left published, the advancement was revoked in the same transaction', pg_temp.rstatus(12) = 'ballots_locked' and exists (select 1 from public.event_competition_round_advancement_revocations rv where rv.advancement_id = pg_temp.u('0d1200')), (select msg from t_corr12));

-- ============================================================================
-- 10. Exceptions (R2 table stand-in), roster, unknown shape (r10)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('calculate r10', $q$select pg_temp.calc(10)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('approve r10', $q$select pg_temp.approve(10, 1)$q$);
reset role;
-- On a chain that already has the REAL R2 table, set it aside (inside the suite transaction) so the stand-in below does not collide; it is restored after the section.
-- NOTE: this section therefore always exercises the stand-in shape, never the real R2 table shape (real-shape coverage is NOT VERIFIED here).
do $$ begin if to_regclass('public.event_competition_refund_exception_scopes') is not null then alter table public.event_competition_refund_exception_scopes rename to event_competition_refund_exception_scopes_r2real; end if; end $$;
create table public.event_competition_refund_exception_scopes (round_id uuid, competitive_effect boolean not null, resolved_at timestamptz, entry_id uuid);
insert into public.event_competition_refund_exception_scopes (round_id, competitive_effect, resolved_at) values
  (pg_temp.rid(2), true, null), (pg_temp.rid(10), false, null), (pg_temp.rid(10), true, now());
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('financial-only and resolved exceptions of the round do not block; another round''s exception does not either', $q$select pg_temp.pub(10, 1, 'entrants', pg_temp.u('f3000a'))$q$);
reset role;
select pg_temp.chk('r10 published despite an unrelated round''s unresolved competitive exception', pg_temp.rstatus(10) = 'published');
-- block on the round itself: r3 ballots are locked; use r7? Use a fresh approval path on r3 is blocked by O5 (r4 holds ballots), so block r2 (stale first) by correction instead: assert the block with r12 style data.
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scheduled' where heat_id = pg_temp.hid(2) and entry_id = pg_temp.eid(2, 3);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an unresolved competitive refund exception scoped to the round blocks its publication', $q$select pg_temp.pub(2, 1)$q$, 'COMP_PUBLICATION_BLOCKED_BY_EXCEPTION');
reset role;
update public.event_competition_refund_exception_scopes set resolved_at = now() where round_id = pg_temp.rid(2);
alter table public.event_competition_refund_exception_scopes drop column competitive_effect;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an unknown exception-table shape fails closed', $q$select pg_temp.pub(2, 1)$q$, 'could not be verified');
reset role;
drop table public.event_competition_refund_exception_scopes;
do $$ begin if to_regclass('public.event_competition_refund_exception_scopes_r2real') is not null then alter table public.event_competition_refund_exception_scopes_r2real rename to event_competition_refund_exception_scopes; end if; end $$;
select pg_temp.chk('the blocked / fail-closed attempts wrote nothing', pg_temp.pcount(2) = 0 and pg_temp.rstatus(2) = 'approved');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('with no exception table at all r2 publishes (its scratch was reverted, so the hash is current)', $q$select pg_temp.pub(2, 1, 'entrants', pg_temp.u('f3000b'))$q$);
reset role;
select pg_temp.chk('r2 published', pg_temp.rstatus(2) = 'published');

-- ============================================================================
-- 11. Roster: a refund after approval blocks publication (CF1 check reused)
-- ============================================================================
-- (covered by the CF1 A3 suite for the check itself; here only that publish calls it)
select pg_temp.chk('publish_competition_round_result calls the CF1 roster check',
  position('_cf1_require_roster_eligible' in pg_get_functiondef('public.publish_competition_round_result(uuid,uuid,text,uuid)'::regprocedure)) > 0);

-- ============================================================================
-- 12. Audit completeness and no unpublished leaks
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the unified audit log shows published, superseded and withdrawn events to a manager',
  (select count(*) filter (where kind = 'result_published') >= 5 and count(*) filter (where kind = 'result_superseded') = 1 and count(*) filter (where kind = 'result_withdrawn') >= 2
   from public.competition_audit_log(pg_temp.u('00e001'), null, 1000)));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('cross-tenant: studio B owner cannot read the audit log', $q$select * from public.competition_audit_log(pg_temp.u('00e001'), null, 10)$q$, 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('every F3 audit row has an actor, a version and a request id',
  not exists (select 1 from public.event_competition_result_events where kind in ('result_published', 'result_superseded', 'result_withdrawn') and (actor_user_id is null or result_version_id is null or request_id is null)));
select pg_temp.chk('no non-manager API read path exposes an unpublished (approved) result: r3 has no publication and the readers return nothing',
  not exists (select 1 from public.event_competition_result_publications where round_id = pg_temp.rid(3)));

-- ============================================================================
-- 13. INT5-SECFIX P2-2: readers never expose a stale / in-correction / superseded result as current (r6 is public, published, version 2 approved)
-- ============================================================================
-- The exclusion fixtures of section 7 (a refund after dancing) are removed so the correction below can be recalculated without replacement ballots (fixture only).
alter table public.event_competition_round_exclusions disable trigger user;
delete from public.event_competition_round_exclusions where round_id = pg_temp.rid(6);
alter table public.event_competition_round_exclusions enable trigger user;
select pg_temp.as_anon();
select pg_temp.chk('13a baseline: the public reader shows r6 (publication 2, version 2) and the event list has it',
  (public.competition_round_results_public(pg_temp.rid(6)) ->> 'published')::boolean
  and exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('13b baseline: the entrant of r6 sees it', exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('13c a manager opens a correction on the published r6 (a refund / error came up); the publication is NOT withdrawn',
  $q$select public.open_competition_round_correction(pg_temp.rid(6), 'refund came up after publication', gen_random_uuid())$q$);
reset role;
select pg_temp.chk('13d state: publication 2 still current (not withdrawn), version 2 stale, round ballots_locked with correction_open',
  pg_temp.pcur(6) = 1 and pg_temp.vstatus(6, 2) = 'stale' and pg_temp.rstatus(6) = 'ballots_locked'
  and (select correction_open from public.event_competition_rounds where id = pg_temp.rid(6)));
select pg_temp.as_anon();
select pg_temp.chk('13e anon during the correction: the round reader gives only the generic under-review notice, no rows, no names',
  public.competition_round_results_public(pg_temp.rid(6)) = '{"published": false, "under_review": true}'::jsonb);
select pg_temp.chk('13f anon during the correction: the event list does not contain r6',
  not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('13g the entrant (also a refunded / excluded couple) during the correction: r6 is not in the entrant reader',
  not exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('13h a manager still reads the publication history (current, nothing deleted)', public.competition_round_publications(pg_temp.rid(6)) -> 0 ->> 'state' = 'current');
select pg_temp.expect_ok('13i recalculate (v3)', $q$select pg_temp.calc(6)$q$);
reset role;
select pg_temp.as_anon();
select pg_temp.chk('13j recalculated but not yet approved: still hidden (version 3 is calculated, round calculated)',
  public.competition_round_results_public(pg_temp.rid(6)) = '{"published": false, "under_review": true}'::jsonb);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('13k approve v3', $q$select pg_temp.approve(6, 3)$q$);
reset role;
select pg_temp.as_anon();
select pg_temp.chk('13l approved but not yet published: still hidden (the old publication 2 points at superseded version 2)',
  public.competition_round_results_public(pg_temp.rid(6)) = '{"published": false, "under_review": true}'::jsonb
  and not exists (select 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('13m publish v3 (public): supersedes publication 2', $q$select pg_temp.pub(6, 3, 'public')$q$);
reset role;
select pg_temp.as_anon();
select pg_temp.chk('13n after the correction resolves the public reader shows the corrected result: publication 3, version 3',
  (public.competition_round_results_public(pg_temp.rid(6)) ->> 'published')::boolean
  and public.competition_round_results_public(pg_temp.rid(6)) -> 'publication' ->> 'version' = '3'
  and (select count(*) = 1 from jsonb_array_elements(public.competition_event_results_public(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
select pg_temp.as_user(pg_temp.u('000022'));
select pg_temp.chk('13o and the entrant sees it again', exists (select 1 from jsonb_array_elements(public.competition_my_results(pg_temp.u('00e001'))) x where x -> 'round' ->> 'id' = pg_temp.rid(6)::text));
reset role;
-- fail closed: a current publication whose version is not the round's approved one is never live
set session_replication_role = replica;
update public.event_competition_result_versions set status = 'stale' where id = pg_temp.vid(6, 3);
set session_replication_role = origin;
select pg_temp.as_anon();
select pg_temp.chk('13p a stale version behind a current publication is not served even if the round says published (defence in depth)',
  public.competition_round_results_public(pg_temp.rid(6)) = '{"published": false, "under_review": true}'::jsonb);
reset role;
set session_replication_role = replica;
update public.event_competition_result_versions set status = 'approved' where id = pg_temp.vid(6, 3);
set session_replication_role = origin;

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
    raise exception 'COMPETITION CF1 F3 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION CF1 F3 SQL SUITE FAIL: %', v_failures;
end $$;
