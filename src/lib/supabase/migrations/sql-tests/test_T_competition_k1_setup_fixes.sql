-- Competition K1 setup corrections (W4) regression suite.
--
-- Covers 20270110090000_competition_k1_setup_fixes.sql on top of the Phase 10A-10D chain. One
-- transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0c1c1cXXXXXX). Tenant
-- behaviour is simulated with `set local role` + request.jwt.claims. The final block ALWAYS raises, so
-- the whole transaction aborts and nothing persists; its message is the verdict:
--   "COMPETITION K1 SQL SUITE PASS (<n> checks)"  or  "COMPETITION K1 SQL SUITE FAIL: <failures>".
-- Needs studio_simple@1 to be seeded (as the 10B suite does).

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0c1c1c000001', 't-k1-owner@example.test'),
  ('00000000-0000-0000-0000-0c1c1c000002', 't-k1-nobody@example.test');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0c1c1c000001', 't-k1-owner@example.test', 'K1 Owner'),
  ('00000000-0000-0000-0000-0c1c1c000002', 't-k1-nobody@example.test', 'K1 Nobody');
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0c1c1c00a001', 'K1 Studio', 't-k1-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0c1c1c000001', '00000000-0000-0000-0000-0c1c1c00a001', 'studio_owner', true);

-- e1 callbacks, e2 placements, e3 ratings, e4 placements whose program scoring is later set to none
do $$
declare n int;
begin
  for n in 1..4 loop
    insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
    values (('00000000-0000-0000-0000-0c1c1c00e00' || n)::uuid, '00000000-0000-0000-0000-0c1c1c00a001',
            'K1 Event ' || n, 't-k1-e' || n, 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
  end loop;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

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

create or replace function pg_temp.expect_fail(p_name text, p_sql text, p_state text default null) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, p_state is null or sqlstate = p_state, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.spec(p_preset text, p_judging text, p_request text, p_categories jsonb, p_divisions jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('profile_key', 'studio_simple', 'profile_version', 1, 'request_key', p_request,
    'preset', p_preset, 'judging', p_judging, 'name', 'K1 Competition', 'division_preset', 'levels_newcomer_gold',
    'categories', p_categories, 'divisions', p_divisions)
$$;

grant execute on function pg_temp.chk(text, boolean, text), pg_temp.expect_ok(text, text), pg_temp.expect_fail(text, text, text),
  pg_temp.spec(text, text, text, jsonb, jsonb) to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures: create the programs as the studio owner
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0c1c1c000001","role":"authenticated"}', true);
select pg_temp.expect_ok('callbacks program created',
  $q$insert into t_ids select 'cb', public.create_simple_competition('00000000-0000-0000-0000-0c1c1c00e001',
     pg_temp.spec('ballroom', 'callbacks', 'req-k1-cb-0001', '[{"type":"couples","price":20,"dances":["smooth_waltz"]}]'::jsonb, '[{"name":"Gold"}]'::jsonb))$q$);
select pg_temp.expect_ok('placements program created',
  $q$insert into t_ids select 'pl', public.create_simple_competition('00000000-0000-0000-0000-0c1c1c00e002',
     pg_temp.spec('studio_competition', 'placements', 'req-k1-pl-0001', '[{"type":"solo","price":40}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$);
select pg_temp.expect_ok('ratings program created',
  $q$insert into t_ids select 'rt', public.create_simple_competition('00000000-0000-0000-0000-0c1c1c00e003',
     pg_temp.spec('showcase', 'ratings', 'req-k1-rt-0001', '[{"type":"showcase","price":30}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$);
select pg_temp.expect_ok('scoring-none program created',
  $q$insert into t_ids select 'nn', public.create_simple_competition('00000000-0000-0000-0000-0c1c1c00e004',
     pg_temp.spec('studio_competition', 'placements', 'req-k1-nn-0001', '[{"type":"solo","price":40}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$);
reset role;

select pg_temp.chk('create_simple_competition still leaves the callback target NULL (D-CT-5 is an open owner decision; no default invented)',
  (select count(*) = 1 and bool_and(target_advancement_count is null) from public.event_competition_rounds
    where event_id = '00000000-0000-0000-0000-0c1c1c00e001' and round_type = 'preliminary'));
select pg_temp.chk('the callbacks program keeps its profile version (studio_simple@1) and callback_tally scoring',
  (select rules_profile_key = 'studio_simple' and rules_profile_version = 1 and scoring_method = 'callback_tally'
   from public.event_competition_programs where id = (select v from t_ids where k = 'cb')));

-- Existing-row defect: a legacy division with a 'none' Final must never be rewritten by the fix.
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, sort_order)
select '00000000-0000-0000-0000-0c1c1c00c001', event_id, program_id, 'Legacy category', 'single_dance', 'solo', 900
from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0c1c1c00e001' limit 1;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, sort_order)
select '00000000-0000-0000-0000-0c1c1c00d001', event_id, program_id, '00000000-0000-0000-0000-0c1c1c00c001', 'Legacy division', 10
from public.event_competition_contests where id = '00000000-0000-0000-0000-0c1c1c00c001';
insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
select event_id, program_id, '00000000-0000-0000-0000-0c1c1c00d001', 'Final', 'final', 1, 'none'
from public.event_competition_contests where id = '00000000-0000-0000-0000-0c1c1c00c001';

-- Empty categories (no division yet) in each program
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, sort_order)
select ('00000000-0000-0000-0000-0c1c1c00c00' || m.n)::uuid, c.event_id, c.program_id, 'Empty category', 'single_dance', 'solo', 910
from (values (2, '00000000-0000-0000-0000-0c1c1c00e001'::uuid), (3, '00000000-0000-0000-0000-0c1c1c00e002'::uuid),
             (4, '00000000-0000-0000-0000-0c1c1c00e003'::uuid), (5, '00000000-0000-0000-0000-0c1c1c00e004'::uuid)) as m(n, ev)
join lateral (select event_id, program_id from public.event_competition_contests where event_id = m.ev limit 1) c on true;
update public.event_competition_programs set scoring_method = 'none' where event_id = '00000000-0000-0000-0000-0c1c1c00e004';

-- ============================================================================
-- add_competition_division on an empty category
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0c1c1c000001","role":"authenticated"}', true);
select pg_temp.expect_ok('add a division to an empty category in the callbacks program',
  $q$insert into t_ids select 'dv_cb', public.add_competition_division('00000000-0000-0000-0000-0c1c1c00c002', 'New Gold', null, null)$q$);
select pg_temp.expect_ok('add a division to an empty category in the placements program',
  $q$insert into t_ids select 'dv_pl', public.add_competition_division('00000000-0000-0000-0000-0c1c1c00c003', 'New Open', null, null)$q$);
select pg_temp.expect_ok('add a division to an empty category in the ratings program',
  $q$insert into t_ids select 'dv_rt', public.add_competition_division('00000000-0000-0000-0000-0c1c1c00c004', 'New Open', null, null)$q$);
select pg_temp.expect_ok('add a division to an empty category in the scoring-none program',
  $q$insert into t_ids select 'dv_nn', public.add_competition_division('00000000-0000-0000-0000-0c1c1c00c005', 'New Open', null, null)$q$);
reset role;

select pg_temp.chk('callback program: the fallback Final is scored ordinal_majority (studio_simple@1 judging.callbacks Final), not none',
  (select count(*) = 1 and bool_and(scoring_method = 'ordinal_majority' and round_type = 'final' and sequence_number = 1 and name = 'Final')
   from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_cb')));
select pg_temp.chk('callback program: the fallback Final does not invent a callback target',
  (select bool_and(target_advancement_count is null) from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_cb')));
select pg_temp.chk('placements program fallback Final is unchanged (ordinal_majority)',
  (select scoring_method = 'ordinal_majority' from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_pl')));
select pg_temp.chk('ratings program fallback Final is unchanged (proficiency_rating)',
  (select scoring_method = 'proficiency_rating' from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_rt')));
select pg_temp.chk('a program with no studio engine still gets a none Final',
  (select scoring_method = 'none' from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_nn')));
select pg_temp.chk('an existing division with a none Final is never rewritten',
  (select scoring_method = 'none' from public.event_competition_rounds where division_id = '00000000-0000-0000-0000-0c1c1c00d001'));
select pg_temp.chk('the program profile version is not changed by adding a division',
  (select rules_profile_version = 1 from public.event_competition_programs where id = (select v from t_ids where k = 'cb')));

-- ============================================================================
-- add_competition_division on a category that already has a division: template copy unchanged
-- ============================================================================
update public.event_competition_rounds set target_advancement_count = 3
where event_id = '00000000-0000-0000-0000-0c1c1c00e001' and round_type = 'preliminary'
  and division_id in (select d.id from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id
                      where c.event_id = '00000000-0000-0000-0000-0c1c1c00e001' and c.name not in ('Legacy category', 'Empty category'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0c1c1c000001","role":"authenticated"}', true);
select pg_temp.expect_ok('add a division to a category that already has one (callbacks)',
  $q$insert into t_ids select 'dv_copy', public.add_competition_division(
       (select c.id from public.event_competition_contests c where c.event_id = '00000000-0000-0000-0000-0c1c1c00e001' and c.name not in ('Legacy category', 'Empty category') limit 1),
       'Second Gold', null, null)$q$);
reset role;
select pg_temp.chk('a second division copies the first division rounds exactly (callback round + Final, target copied from the organizer-set template)',
  (select array_agg(round_type || ':' || scoring_method || ':' || coalesce(target_advancement_count::text, 'null') order by sequence_number)
          = array['preliminary:callback_tally:3', 'final:ordinal_majority:null']
   from public.event_competition_rounds where division_id = (select v from t_ids where k = 'dv_copy')));

-- ============================================================================
-- Authority, privileges, body pin
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0c1c1c000002","role":"authenticated"}', true);
select pg_temp.expect_fail('a user who cannot manage the event cannot add a division',
  $q$select public.add_competition_division('00000000-0000-0000-0000-0c1c1c00c002', 'Intruder', null, null)$q$, '42501');
reset role;
select pg_temp.chk('anon cannot execute add_competition_division; authenticated can; it stays SECURITY INVOKER',
  not has_function_privilege('anon', 'public.add_competition_division(uuid, text, text, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.add_competition_division(uuid, text, text, text)', 'EXECUTE')
  and exists (select 1 from pg_proc where proname = 'add_competition_division' and not prosecdef));
select pg_temp.chk('the live body is the reviewed K1 body (md5 of prosrc, LF or CRLF checkout)',
  (select md5(prosrc) in ('d503110a8f8b94109e0c2da46f2ddd08', 'b29d4ddc26c0cfe50279a54209f9c6f1') from pg_proc where proname = 'add_competition_division'));
select pg_temp.chk('create_simple_competition is still the reviewed 10B body (not redefined by K1)',
  (select md5(prosrc) = '9f49fb905703f0a232cc2f3bd8fe5d17' from pg_proc where proname = 'create_simple_competition'));

-- ============================================================================
-- Verdict (always aborts the transaction)
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*), string_agg(name || ' => ' || detail, '; ') filter (where not ok)
  into v_total, v_failures from t_results;

  if v_failures is null then
    raise exception 'COMPETITION K1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION K1 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
