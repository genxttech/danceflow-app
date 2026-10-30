-- Competition CF1 package A4a -- callback-target lower bound (OD-21) regression suite.
--
-- Covers 20270120091000_competition_cf1_a4a_callback_target_guard.sql on top of the chain through HL1, A1 (20270120085000) and A0 (20270120090000).
-- Gates: U67 (T below two refused at setup and at publication on every F2 arm; existing rows not retro-failed; Final-only unaffected) and the
-- fixture-scope part of U77 (the suites that carry callback targets are run separately and unchanged: O1 day-of, SS1, E2, K1, NS1, CX1, A0).
-- Run as a SUPERUSER. One transaction, synthetic fixtures only (md5-derived ids). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A4a SQL SUITE PASS (<n> checks, <b> blocked)"  or  "... FAIL: <failures>".
-- Rows with T = 1 that the guard would now refuse (the "existing programs are not retro-failed" fixtures) are seeded with the F2 setup trigger
-- disabled inside the transaction; the trigger is re-enabled ALWAYS immediately afterwards.

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
create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_name, true, 'ok');
  exception when others then
    perform pg_temp.chk(p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;
-- The statement must fail with a message containing p_fragment; p_state, when given, must equal the SQLSTATE.
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
-- The statement must fail, and its message must NOT contain p_fragment.
create or replace function pg_temp.expect_not_msg(p_name text, p_sql text, p_fragment text) returns void
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
      perform pg_temp.chk(p_name, position(lower(p_fragment) in lower(sqlerrm)) = 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;
create or replace function pg_temp.id(p_kind text, p_n int default 0) returns uuid
language sql immutable as $$ select md5('cf1a4a:' || p_kind || ':' || p_n)::uuid $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.id('user', 1), 't-cf1a4a-owner@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'CF1A4a owner' from auth.users where email like 't-cf1a4a-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a4a-%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 A4a Studio', 't-cf1a4a-a');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.id('user', 1), pg_temp.id('studio', 1), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'CF1 A4a Comp', 't-cf1a4a-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);

-- Programs: 1 callback, 2 callback (T null at lock), 3 callback (T = 2 at lock), 4 callback (Final-only division + no-successor round), 5 non-callback,
-- 6 callback (T above capacity at lock), 7 callback (setup/arms scratch program, never locked), 8 callback (lock after a refused lock).
create or replace function pg_temp.prog(p_n int, p_method text) returns void
language plpgsql security definer as $$
begin
  insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method, rules_profile_key, rules_profile_version)
  values (pg_temp.id('prg', p_n), pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'Program ' || p_n, 'showcase', 'relative', 'ordinal_majority', 'draft', p_method, 'studio_simple', 1);
  insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values (pg_temp.id('cts', p_n), pg_temp.id('evt', 1), pg_temp.id('prg', p_n), 'Contest ' || p_n, 'single_dance', 'couple', 'open');
end $$;
select pg_temp.prog(1, 'promote_callback');
select pg_temp.prog(2, 'promote_callback');
select pg_temp.prog(3, 'promote_callback');
select pg_temp.prog(4, 'promote_callback');
select pg_temp.prog(5, 'none');
select pg_temp.prog(6, 'promote_callback');
select pg_temp.prog(7, 'promote_callback');
select pg_temp.prog(8, 'promote_callback');

create or replace function pg_temp.div(p_n int, p_prog int) returns void
language plpgsql security definer as $$
begin
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('div', p_n), pg_temp.id('evt', 1), pg_temp.id('prg', p_prog), pg_temp.id('cts', p_prog), 'D' || p_n, 'open');
end $$;
-- Seeds a round with the F2 setup trigger disabled, so the "existing row" fixtures the guard would now refuse can exist.
create or replace function pg_temp.rnd(p_n int, p_prog int, p_seq int, p_type text, p_t int, p_cap int default null) returns void
language plpgsql security definer as $$
begin
  alter table public.event_competition_rounds disable trigger cf1_guard_callback_target_capacity;
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count, configuration)
  values (pg_temp.id('rnd', p_n * 10 + p_seq), pg_temp.id('evt', 1), pg_temp.id('prg', p_prog), pg_temp.id('div', p_n), 'D' || p_n || ' ' || p_type || p_seq, p_type, p_seq, 'draft',
          case when p_type = 'final' then 'ordinal_majority' else 'callback_tally' end, p_t,
          case when p_cap is null then '{}'::jsonb else jsonb_build_object('max_entries_per_heat', p_cap) end);
  alter table public.event_competition_rounds enable always trigger cf1_guard_callback_target_capacity;
end $$;
create or replace function pg_temp.rid(p_n int, p_seq int) returns uuid language sql immutable as $$ select pg_temp.id('rnd', p_n * 10 + p_seq) $$;

-- Divisions (n -> program): 1..4 and 12 on program 7 (scratch), 20 on program 1, 21 on 2, 22 on 3, 23/24 on 4, 25 on 5, 26 on 6, 27 on 8.
select pg_temp.div(n, 7) from unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) n;
select pg_temp.div(20, 1); select pg_temp.div(21, 2); select pg_temp.div(22, 3); select pg_temp.div(23, 4); select pg_temp.div(24, 4);
select pg_temp.div(25, 5); select pg_temp.div(26, 6); select pg_temp.div(27, 8);

-- ============================================================================
-- 1. The check function itself
-- ============================================================================
select pg_temp.chk('check(1, 8) -> BELOW_MINIMUM', public._cf1_callback_target_check(1, 8) = 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.chk('check(0, 8) -> BELOW_MINIMUM', public._cf1_callback_target_check(0, 8) = 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.chk('check(-3, 8) -> BELOW_MINIMUM', public._cf1_callback_target_check(-3, 8) = 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.chk('check(2, 8), (5, 8), (8, 8) -> null', public._cf1_callback_target_check(2, 8) is null and public._cf1_callback_target_check(5, 8) is null and public._cf1_callback_target_check(8, 8) is null);
select pg_temp.chk('check(null, 8) -> null (D-CT-5: T is set before ballots)', public._cf1_callback_target_check(null, 8) is null);
select pg_temp.chk('check(9, 8) -> EXCEEDS_CAPACITY (A0 behaviour kept)', public._cf1_callback_target_check(9, 8) = 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY');
select pg_temp.chk('check(2, 2) -> null (T equal to capacity two)', public._cf1_callback_target_check(2, 2) is null);
select pg_temp.chk('check(1, 1) -> BELOW_MINIMUM (the minimum wins over a capacity of one)', public._cf1_callback_target_check(1, 1) = 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.chk('the check function has no client execute grant',
  not has_function_privilege('anon', 'public._cf1_callback_target_check(integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_callback_target_check(integer,integer)', 'execute')
  and not has_function_privilege('service_role', 'public._cf1_callback_target_check(integer,integer)', 'execute'));
select pg_temp.chk('the F2 guard functions keep their ENABLE ALWAYS triggers',
  (select count(*) from pg_trigger where tgname in ('cf1_guard_callback_target_capacity', 'cf1_guard_callback_target_program_lock') and tgenabled = 'A') = 2);

-- ============================================================================
-- 2. T edit arm (division 1: callback preliminary + Final)
-- ============================================================================
select pg_temp.rnd(1, 7, 1, 'preliminary', null);
select pg_temp.rnd(1, 7, 2, 'final', null);
select pg_temp.expect_msg('T edit: T = 1 is refused', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(1, 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_msg('T edit: the organizer message says the minimum and the capacity', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(1, 1)), 'at least 2 and no more than the Final''s capacity (8)');
select pg_temp.expect_not_msg('T edit: the organizer message no longer says the target "does not fit"', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(1, 1)), 'does not fit');
select pg_temp.expect_msg('T edit: T = 0 is refused', format($q$update public.event_competition_rounds set target_advancement_count = 0 where id = %L$q$, pg_temp.rid(1, 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_msg('T edit: T = -1 is refused', format($q$update public.event_competition_rounds set target_advancement_count = -1 where id = %L$q$, pg_temp.rid(1, 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.chk('T edit: a refused write leaves T null', (select target_advancement_count from public.event_competition_rounds where id = pg_temp.rid(1, 1)) is null);
select pg_temp.expect_ok('T edit: T = 2 passes', format($q$update public.event_competition_rounds set target_advancement_count = 2 where id = %L$q$, pg_temp.rid(1, 1)));
select pg_temp.expect_ok('T edit: T = 3 passes', format($q$update public.event_competition_rounds set target_advancement_count = 3 where id = %L$q$, pg_temp.rid(1, 1)));
select pg_temp.expect_ok('T edit: T = 8 (default capacity) passes', format($q$update public.event_competition_rounds set target_advancement_count = 8 where id = %L$q$, pg_temp.rid(1, 1)));
select pg_temp.expect_msg('T edit: T = 9 is still refused EXCEEDS_CAPACITY (A0 regression)', format($q$update public.event_competition_rounds set target_advancement_count = 9 where id = %L$q$, pg_temp.rid(1, 1)), 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY', 'P0001');
select pg_temp.expect_ok('T edit: clearing T (null) passes', format($q$update public.event_competition_rounds set target_advancement_count = null where id = %L$q$, pg_temp.rid(1, 1)));
select pg_temp.expect_msg('T edit: T = 1 refused again after a clear', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(1, 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');

-- ============================================================================
-- 3. Insert arms
-- ============================================================================
-- (a) the callback round is inserted behind an existing Final (division 2): T = 1 refused, T = 2 passes.
select pg_temp.rnd(2, 7, 2, 'final', null);
select pg_temp.expect_msg('INSERT callback round with T = 1 behind an existing Final is refused',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values (%L, %L, %L, 'p2', 'preliminary', 1, 'draft', 'callback_tally', 1)$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 2)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_ok('INSERT callback round with T = 2 behind an existing Final passes',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values (%L, %L, %L, 'p2', 'preliminary', 1, 'draft', 'callback_tally', 2)$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 2)));
-- (b) T = 1 is accepted while there is no successor Final yet (not a callback configuration), then the Final insert is the refused write.
select pg_temp.expect_ok('INSERT callback round with T = 1 and no successor Final yet is accepted (not a configuration yet)',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values (%L, %L, %L, 'p3', 'preliminary', 1, 'draft', 'callback_tally', 1)$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 3)));
select pg_temp.expect_msg('successor INSERT: the Final inserted behind T = 1 is refused BELOW_MINIMUM',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, 'f3', 'final', 2, 'draft', 'ordinal_majority')$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 3)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.chk('successor INSERT refused: no Final row was written', not exists (select 1 from public.event_competition_rounds where division_id = pg_temp.id('div', 3) and round_type = 'final'));
select pg_temp.expect_ok('INSERT of a Final at sequence 3 (its predecessor is a Final, not a preliminary) passes',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, 'f2b', 'final', 3, 'draft', 'ordinal_majority')$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 2)));

-- ============================================================================
-- 4. Capacity edit arm and the reasoned capacity RPC (existing T = 1 rows are seeded past the guard)
-- ============================================================================
select pg_temp.rnd(4, 7, 1, 'preliminary', 1);
select pg_temp.rnd(4, 7, 2, 'final', null);
select pg_temp.expect_msg('capacity edit (direct) on a Final behind an existing T = 1 is refused BELOW_MINIMUM (the F2 arm fires before the capacity writer guard)',
  format($q$update public.event_competition_rounds set configuration = jsonb_build_object('max_entries_per_heat', 6) where id = %L$q$, pg_temp.rid(4, 2)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.rnd(5, 7, 1, 'preliminary', 1);
select pg_temp.rnd(5, 7, 2, 'final', null);
select pg_temp.rnd(6, 7, 1, 'preliminary', 2);
select pg_temp.rnd(6, 7, 2, 'final', null);
set role authenticated;
select pg_temp.as_user(pg_temp.id('user', 1));
select pg_temp.expect_msg('reasoned capacity RPC: existing T = 1 refuses BELOW_MINIMUM',
  format($q$select public.set_competition_round_heat_capacity(%L, 6, 'The floor was resized after the survey.', %L)$q$, pg_temp.rid(5, 2), pg_temp.id('req', 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_msg('reasoned capacity RPC: the message carries the minimum', format($q$select public.set_competition_round_heat_capacity(%L, 6, 'The floor was resized after the survey.', %L)$q$, pg_temp.rid(5, 2), pg_temp.id('req', 2)), 'at least 2 and no more than the capacity (6)');
select pg_temp.expect_ok('reasoned capacity RPC: T = 2 and capacity 6 passes (no false refusal)',
  format($q$select public.set_competition_round_heat_capacity(%L, 6, 'The floor was resized after the survey.', %L)$q$, pg_temp.rid(6, 2), pg_temp.id('req', 3)));
select pg_temp.expect_msg('reasoned capacity RPC: capacity below T = 2 stays EXCEEDS_CAPACITY (A0 regression)',
  format($q$select public.set_competition_round_heat_capacity(%L, 1, 'The floor was resized after the survey.', %L)$q$, pg_temp.rid(6, 2), pg_temp.id('req', 4)), 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY', 'P0001');
reset role;

-- ============================================================================
-- 5. Existing rows are not retro-failed
-- ============================================================================
select pg_temp.chk('seeded T = 1 row is still readable and unchanged', (select target_advancement_count from public.event_competition_rounds where id = pg_temp.rid(4, 1)) = 1);
select pg_temp.expect_ok('unrelated write on a seeded T = 1 callback round passes (name edit)', format($q$update public.event_competition_rounds set name = 'renamed' where id = %L$q$, pg_temp.rid(4, 1)));
select pg_temp.expect_ok('rewriting T = 1 with the same value passes (no change of T)', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(4, 1)));
select pg_temp.expect_ok('unrelated write on the Final behind a seeded T = 1 passes (name edit)', format($q$update public.event_competition_rounds set name = 'renamed final' where id = %L$q$, pg_temp.rid(4, 2)));
select pg_temp.expect_ok('fixing a seeded T = 1 upward (T = 2) passes', format($q$update public.event_competition_rounds set target_advancement_count = 2 where id = %L$q$, pg_temp.rid(4, 1)));

-- ============================================================================
-- 6. Scope: nothing outside "preliminary round of a promote_callback program with a successor Final" is touched (U77)
-- ============================================================================
-- Final-only division of a callback program: T = 1 on the Final (the O1 R3 shape: a final, sequence 1, of a Final-only division) and a one-couple Final-only division.
select pg_temp.rnd(7, 7, 1, 'final', null);
select pg_temp.expect_ok('Final-only division: T = 1 on the Final round passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(7, 1)));
select pg_temp.expect_ok('Final-only division: T = 0 on the Final round passes (not a callback round)', format($q$update public.event_competition_rounds set target_advancement_count = 0 where id = %L$q$, pg_temp.rid(7, 1)));
select pg_temp.expect_ok('Final-only division: T = 1 on a Final inserted with it passes',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values (%L, %L, %L, 'only', 'final', 1, 'draft', 'callback_tally', 1)$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 7), pg_temp.id('div', 8)));
-- A 'qualifying' callback_tally round (the E2/CX1/NS1 fixture round type, not 'preliminary') with T = 1.
select pg_temp.rnd(9, 7, 1, 'qualifying', null);
select pg_temp.expect_ok('qualifying callback_tally round (not preliminary): T = 1 passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(9, 1)));
-- A preliminary round of a promote_callback program with no successor Final.
select pg_temp.rnd(10, 7, 1, 'preliminary', null);
select pg_temp.expect_ok('callback preliminary without a successor round: T = 1 passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(10, 1)));
-- Successor exists but is a semifinal, or the Final is not adjacent.
select pg_temp.rnd(11, 7, 1, 'preliminary', null);
select pg_temp.rnd(11, 7, 2, 'semifinal', null);
select pg_temp.expect_ok('callback preliminary whose successor is a semifinal: T = 1 passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(11, 1)));
select pg_temp.rnd(12, 7, 1, 'preliminary', null);
select pg_temp.rnd(12, 7, 3, 'final', null);
select pg_temp.expect_ok('callback preliminary whose Final is not the next sequence number: T = 1 passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(12, 1)));
-- A non-callback program: a preliminary round with a successor Final and T = 1.
select pg_temp.rnd(25, 5, 1, 'preliminary', null);
select pg_temp.rnd(25, 5, 2, 'final', null);
select pg_temp.expect_ok('non-callback program: preliminary + Final, T = 1 passes', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(25, 1)));
select pg_temp.expect_ok('non-callback program: inserting a further round passes',
  format($q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, 'x', 'semifinal', 3, 'draft', 'callback_tally')$q$,
    pg_temp.id('evt', 1), pg_temp.id('prg', 5), pg_temp.id('div', 25)));
-- A callback preliminary in ANOTHER division is not affected by a Final elsewhere (same sequence numbers, different division).
select pg_temp.rnd(13, 7, 1, 'preliminary', null);
select pg_temp.expect_ok('callback preliminary: a Final in another division does not count as the successor', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(13, 1)));

-- ============================================================================
-- 7. Publish / program lock arm
-- ============================================================================
-- Program 1: callback preliminary T = 1 + Final (existing row, seeded) -> the lock is refused. Program 2: T null -> allowed. Program 3: T = 2 -> allowed.
-- Program 4: a Final-only division with T = 1 on its Final and a callback preliminary without a successor with T = 1 -> allowed.
-- Program 5 (non-callback): preliminary + Final with T = 1 -> allowed. Program 6: T = 9 above the Final's capacity -> refused EXCEEDS.
select pg_temp.rnd(20, 1, 1, 'preliminary', 1);
select pg_temp.rnd(20, 1, 2, 'final', null);
select pg_temp.rnd(21, 2, 1, 'preliminary', null);
select pg_temp.rnd(21, 2, 2, 'final', null);
select pg_temp.rnd(22, 3, 1, 'preliminary', 2);
select pg_temp.rnd(22, 3, 2, 'final', null);
select pg_temp.rnd(23, 4, 1, 'final', 1);
select pg_temp.rnd(24, 4, 1, 'preliminary', 1);
select pg_temp.rnd(26, 6, 1, 'preliminary', 9);
select pg_temp.rnd(26, 6, 2, 'final', null);
select pg_temp.rnd(27, 8, 1, 'preliminary', 1);
select pg_temp.rnd(27, 8, 2, 'final', null);
insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
select pg_temp.id('prg', n), pg_temp.id('evt', 1), 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), timestamptz '2027-01-01 00:00:00+00'
from unnest(array[1, 2, 3, 4, 5, 6, 8]) n;
create or replace function pg_temp.lock_sql(p_n int) returns text language sql as $$
  select format($q$update public.event_competition_programs set status = 'configured', profile_locked_at = timestamptz '2027-01-01 00:00:00+00' where id = %L$q$, pg_temp.id('prg', p_n)) $$;
select pg_temp.expect_msg('program lock: callback round with T = 1 is refused BELOW_MINIMUM', pg_temp.lock_sql(1), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_msg('program lock: the message names the round and the minimum', pg_temp.lock_sql(1), 'at least 2 and no more than the Final''s capacity');
select pg_temp.chk('program lock refused: the program is not locked', (select profile_locked_at is null and status = 'draft' from public.event_competition_programs where id = pg_temp.id('prg', 1)));
select pg_temp.expect_ok('program lock: callback round with T null passes (D-CT-5)', pg_temp.lock_sql(2));
select pg_temp.expect_ok('program lock: callback round with T = 2 passes', pg_temp.lock_sql(3));
select pg_temp.expect_ok('program lock: Final-only division with T = 1 plus a preliminary without a successor passes', pg_temp.lock_sql(4));
select pg_temp.expect_ok('program lock: non-callback program with T = 1 passes', pg_temp.lock_sql(5));
select pg_temp.expect_msg('program lock: T = 9 above the Final capacity is still refused EXCEEDS_CAPACITY (A0 regression)', pg_temp.lock_sql(6), 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY', 'P0001');
-- The refused lock is fixable by an ordinary write and then succeeds.
select pg_temp.expect_msg('program lock (second program, T = 1): refused', pg_temp.lock_sql(8), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.expect_ok('fix: raise T to 2 on the refused program', format($q$update public.event_competition_rounds set target_advancement_count = 2 where id = %L$q$, pg_temp.rid(27, 1)));
select pg_temp.expect_ok('program lock passes after the fix', pg_temp.lock_sql(8));
select pg_temp.chk('locked program: the lock stuck', (select profile_locked_at is not null from public.event_competition_programs where id = pg_temp.id('prg', 8)));
-- After the lock the T edit arm keeps guarding (T edit is allowed on a locked program: W4/E2-governed), now with the minimum.
select pg_temp.expect_msg('locked program: a later T edit to 1 is refused', format($q$update public.event_competition_rounds set target_advancement_count = 1 where id = %L$q$, pg_temp.rid(27, 1)), 'COMP_CALLBACK_TARGET_BELOW_MINIMUM');
select pg_temp.expect_ok('locked program: a later T edit to 3 passes', format($q$update public.event_competition_rounds set target_advancement_count = 3 where id = %L$q$, pg_temp.rid(27, 1)));

-- ============================================================================
-- 8. Items outside this file
-- ============================================================================
select pg_temp.blocked('U77 fixture suites (O1 day-of, SS1 round lock, E2, K1, NS1, CX1, A0) run (the A0 file needs its T = 1 seed changed, see the contract)', 'run as separate files by the harness; results are in the PR matrix');
select pg_temp.blocked('apply / rollback / apply / rollback / apply', 'run by the harness around this file; results are in the PR matrix');

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select count(*) into v_blocked from t_results where status = 'BLOCKED';
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where status = 'FAIL';
  if v_failures is null then
    raise exception 'COMPETITION CF1 A4a SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 A4a SQL SUITE FAIL: %', v_failures;
end $$;
