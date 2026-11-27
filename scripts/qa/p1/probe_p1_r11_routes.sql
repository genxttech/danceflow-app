-- P1 replay of the four executed R-11 routes (OWNER-DECISIONS.md sections 12 and 21) WITHOUT superuser-built competition state.
-- OBSERVATION probe: it records every step (OK / REFUSED with SQLSTATE and message) and prints one VERDICT line per route; it is not a pass/fail suite.
-- LOCAL DISPOSABLE QA DATABASE ONLY. One transaction, always rolled back.
--
--   NC = run a spare round without cancelling the corrected one          CS = cancel the corrected round, then run the spare
--   CA = cancel the corrected round a second manager had approved, then run the spare
--   R  = cancel the corrected round, create a new round, move the spare round's unrun published heat to it, run it
--
-- What runs as the superuser: ONLY the platform identity seed (auth users, profiles, verified emails, studio, studio roles), read-only lookups and the note
-- log. No replica mode, no trigger bypass, no direct writes to competition tables. Competition state is built through the paths the application has:
-- managers (role authenticated, RLS) call the setup / schedule / panel / lifecycle functions or write tables they are granted; registration goes through
-- start_competition_registration as service_role with the manager as actor (the app server path); judges submit their own ballots. The engine rows passed to
-- calculate_competition_round come from the database's own engine (read-only helper), standing in for the app server's calculation.
-- Run it on a chain WITHOUT the P1 restriction as the control (shows what the other corrections leave reachable) and again WITH it.
-- A refusal during setup means the verdicts below it prove nothing about the routes unless the refusal is itself the restriction under test: read the first refusal.
-- Needs the S5 chain (people carry dates of birth) or none; no fixture file is prepended.

begin;
do $tx$
begin
  if now() = statement_timestamp() then
    raise exception 'run this probe inside one explicit transaction on a local QA database only';
  end if;
end $tx$;

create temp table t_probe (seq serial, route text, step text, outcome text) on commit drop;
create temp table t_map (k text primary key, v uuid) on commit drop;

create or replace function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-9a1b0b' || p_suffix)::uuid $$;
create or replace function pg_temp.uid(p_actor text) returns uuid language sql immutable as $$
  select pg_temp.u(case p_actor when 'A1' then '000001' when 'A2' then '000002' when 'J1' then '000011' when 'J2' then '000012' when 'J3' then '000013' end) $$;
create or replace function pg_temp.m(p_k text) returns uuid language sql stable security definer as $$ select v from t_map where k = p_k $$;
create or replace function pg_temp.put(p_k text, p_v uuid) returns void language sql security definer as $$
  insert into t_map values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.rid(p int) returns uuid language sql stable security definer as $$ select pg_temp.m('round' || p) $$;
create or replace function pg_temp.hid(p int) returns uuid language sql stable security definer as $$ select pg_temp.m('heat' || p) $$;
create or replace function pg_temp.fl(p int) returns uuid language sql stable security definer as $$ select pg_temp.m('floor' || p) $$;
create or replace function pg_temp.ev() returns uuid language sql immutable as $$ select pg_temp.u('00e001') $$;
create or replace function pg_temp.off(p_actor text) returns uuid language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.ev() and user_id = pg_temp.uid(p_actor) $$;
create or replace function pg_temp.who(p uuid) returns text language sql stable as $$
  select case p when pg_temp.uid('A1') then 'A1' when pg_temp.uid('A2') then 'A2' else coalesce(right(p::text, 6), '-') end $$;
create or replace function pg_temp.note(p_route text, p_step text, p_text text) returns void language sql security definer as $$
  insert into t_probe (route, step, outcome) values (p_route, p_step, p_text) $$;
create or replace function pg_temp.state(p_round uuid) returns text language sql stable security definer as $$
  select 'round ' || right(r.id::text, 6) || ' status=' || r.status
    || ' ; versions=' || coalesce((select string_agg('v' || v.version || ':' || v.status || ':calc ' || pg_temp.who(v.calculated_by), ',' order by v.version) from public.event_competition_result_versions v where v.round_id = r.id), 'none')
    || ' ; approvals=' || coalesce((select string_agg('v' || v.version || ' by ' || pg_temp.who(ap.approved_by) || case when ap.override_reason is null then '' else ' OVERRIDE' end, ',' order by v.version)
         from public.event_competition_result_approvals ap join public.event_competition_result_versions v on v.id = ap.result_version_id where v.round_id = r.id), 'none')
    || ' ; publications=' || coalesce((select string_agg('v' || v.version || case when p.withdrawn_at is null then ' current' else ' withdrawn' end, ',')
         from public.event_competition_result_publications p join public.event_competition_result_versions v on v.id = p.result_version_id where p.round_id = r.id), 'none')
    || ' ; heats=' || coalesce((select string_agg(right(h.id::text, 6) || ' ' || h.status || '/' || h.lock_state, ',' order by h.heat_number) from public.event_competition_heats h where h.round_id = r.id), 'none')
  from public.event_competition_rounds r where r.id = p_round $$;
-- One statement as an API role in its own subtransaction; a refusal leaves no trace. Returns true when accepted.
create or replace function pg_temp.step(p_route text, p_step text, p_sql text, p_actor text default 'A1', p_round uuid default null) returns boolean
language plpgsql as $$
declare v_msg text; v_n bigint; v_ok boolean := true;
begin
  begin
    if p_actor = 'SVC' then
      perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
      perform set_config('role', 'service_role', true);
    else
      perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(p_actor), 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end if;
    execute p_sql;
    get diagnostics v_n = row_count;
    -- the transaction is always rolled back, so deferred constraint triggers are forced here: a COMMIT-time refusal must count against this step
    execute 'set constraints all immediate';
    execute 'set constraints all deferred';
    v_msg := 'OK (rows ' || v_n || ')';
    if v_n = 0 and lower(ltrim(p_sql)) ~ '^(insert|update|delete)' then v_ok := false; v_msg := 'NO ROWS (nothing changed)'; end if;
  exception when others then
    v_ok := false;
    v_msg := 'REFUSED ' || sqlstate || ' ' || left(replace(sqlerrm, chr(10), ' '), 220);
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.note(p_route, p_step || ' [' || p_actor || ']', v_msg);
  if p_round is not null then perform pg_temp.note(p_route, '  state', coalesce(pg_temp.state(p_round), 'round not found')); end if;
  return v_ok;
end $$;
create or replace function pg_temp.engine(p_ev jsonb) returns jsonb language sql stable security definer as $$ select public._comppv1_run('ordinal', p_ev) $$;
create or replace function pg_temp.th() returns text language sql immutable as $$ select encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex') $$;
create or replace function pg_temp.marks(p_heat uuid, p_vals jsonb) returns jsonb language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn from public.event_competition_heat_entries he where he.heat_id = p_heat) x $$;
create or replace function pg_temp.calc_sql(p_round uuid) returns text language sql stable as $$
  select format($q$select public.calculate_competition_round(%1$L, x.i ->> 'engine_key', x.i ->> 'engine_version', x.i ->> 'input_hash', pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.engine(x.i -> 'evidence') -> 'rows', coalesce(pg_temp.engine(x.i -> 'evidence') -> 'warnings', '[]'::jsonb), gen_random_uuid()) from (select public.competition_round_calculation_input(%1$L) i) x$q$, p_round) $$;
-- Diagnostic only: what the database engine answers for a round (a refusal by calculate_competition_round names the symptom, not the engine's reason).
create or replace function pg_temp.engine_note(p_route text, p_round uuid) returns void language plpgsql as $d$
declare v_in jsonb; v_out jsonb;
begin
  v_in := public.competition_round_calculation_input(p_round);
  v_out := pg_temp.engine(v_in -> 'evidence');
  perform pg_temp.note(p_route, '  engine', 'ok=' || coalesce(v_out ->> 'ok', '?') || ' reason=' || coalesce(v_out ->> 'reason', '-') || ' rows=' || coalesce(jsonb_array_length(case when jsonb_typeof(v_out -> 'rows') = 'array' then v_out -> 'rows' end)::text, 'none') || ' input=' || coalesce(v_in ->> 'engine_key', '?') || ' evidence=' || left((v_in -> 'evidence')::text, 700));
end $d$;
create or replace function pg_temp.approve_sql(p_round uuid, p_reason text) returns text language sql stable as $$
  select format($q$select public.approve_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L order by version desc limit 1), %2$L, gen_random_uuid())$q$, p_round, p_reason) $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ============================================================================
-- Platform identity seed (superuser; not competition state)
-- ============================================================================
insert into auth.users (id, email) select pg_temp.uid(a), 't-p1r11-' || lower(a) || '@example.test' from unnest(array['A1', 'A2', 'J1', 'J2', 'J3']) a;
insert into public.profiles (id, email, full_name) select id, email, 'P1R11 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-9a1b0b%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-9a1b0b%';
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'P1R11 Studio', 't-p1r11-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active)
select pg_temp.uid(a), pg_temp.u('00a001'), (case when a like 'A%' then 'studio_owner' else 'instructor' end)::public.app_role, true from unnest(array['A1', 'A2', 'J1', 'J2', 'J3']) a;

-- ============================================================================
-- Setup through application paths
-- ============================================================================
create or replace function pg_temp.setup() returns void language plpgsql as $fn$
declare
  d int; i int; r int; v_prog uuid; v_div uuid; v_people jsonb; v_entries jsonb; v_floor jsonb; v_version uuid; v_has_r15 boolean; v_e record; v_req text[];
  v_order int[]; j text;
begin
  perform pg_temp.step('setup', 'create the event', format($q$insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values (%L, %L, 'P1R11 Comp', 't-p1r11-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true)$q$, pg_temp.ev(), pg_temp.u('00a001')));
  perform pg_temp.step('setup', 'create_simple_competition', format($q$select public.create_simple_competition(%L, '{"profile_key":"studio_simple","profile_version":1,"request_key":"p1r11-request-0001","preset":"studio_competition","judging":"placements","categories":[{"type":"solo","price":"0"}],"divisions":[{"name":"D1"},{"name":"D2"},{"name":"D3"},{"name":"D4"}]}'::jsonb)$q$, pg_temp.ev()));
  select id into v_prog from public.event_competition_programs where event_id = pg_temp.ev();
  perform pg_temp.put('program', v_prog);
  perform pg_temp.step('setup', 'publish_competition_program', format('select public.publish_competition_program(%L)', v_prog));
  perform pg_temp.step('setup', 'open_competition_registration', format('select public.open_competition_registration(%L)', v_prog));
  for d in 1..4 loop
    select id into v_div from public.event_competition_divisions where event_id = pg_temp.ev() and name = 'D' || d;
    perform pg_temp.put('div' || d, v_div);
    select jsonb_agg(jsonb_build_object('clientId', 'p' || g, 'firstName', 'Adult' || d || g, 'lastName', 'Tester', 'personType', 'dancer', 'dateOfBirth', '1990-01-0' || g) order by g),
           jsonb_agg(jsonb_build_object('clientId', 'e' || g, 'programId', v_prog, 'contestId', (select contest_id from public.event_competition_divisions where id = v_div), 'divisionId', v_div,
             'participantIds', jsonb_build_array('p' || g), 'participantRoles', jsonb_build_object('p' || g, 'dancer'), 'selectedOfferingIds', '[]'::jsonb, 'routineTitle', 'Routine ' || d || '-' || g, 'musicTitle', 'Music ' || d || '-' || g, 'routineDurationSeconds', '90') order by g)
    into v_people, v_entries from generate_series(1, 3) g;
    perform pg_temp.step('setup', 'register three adults in D' || d, format($q$select public.start_competition_registration(%L, %L, %L::jsonb, %L)$q$, pg_temp.ev(), pg_temp.u('00f00' || d),
      jsonb_build_object('registrationMode', 'individual', 'buyerName', 'Bea Buyer', 'buyerEmail', 'buyer@example.test', 'people', v_people, 'entries', v_entries), pg_temp.uid('A1')), 'SVC');
  end loop;
  v_has_r15 := to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is not null;
  for v_e in select id from public.event_competition_entries where event_id = pg_temp.ev() order by id loop
    if v_has_r15 then
      v_req := public._r15_required_criteria(v_e.id);
      perform pg_temp.step('setup', 'eligibility determination', format($q$select public.set_competition_entry_eligibility(%L, 'eligible', 'criteria_verified_by_organizer', %L::text[], gen_random_uuid())$q$, v_e.id, v_req));
    else
      perform pg_temp.step('setup', 'eligibility (direct write, chain without R-15)', format($q$update public.event_competition_entries set eligibility_status = 'eligible' where id = %L$q$, v_e.id));
    end if;
  end loop;
  perform pg_temp.note('setup', 'entries', (select count(*)::text || ' entries, ' || count(*) filter (where status = 'confirmed')::text || ' confirmed, ' || count(*) filter (where eligibility_status = 'eligible')::text || ' eligible' from public.event_competition_entries where event_id = pg_temp.ev()));
  -- rounds: 1, 2, 5, 7 are the finals setup created (D1..D4); 4, 3, 6, 8 are manager-added spare rounds of the same divisions
  for r, d in select * from (values (1, 1), (2, 2), (5, 3), (7, 4)) v loop
    perform pg_temp.put('round' || r, (select id from public.event_competition_rounds where division_id = pg_temp.m('div' || d) order by sequence_number limit 1));
  end loop;
  for r, d in select * from (values (4, 1), (3, 2), (6, 3), (8, 4)) v loop
    if pg_temp.step('setup', 'add spare round ' || r || ' to D' || d, format($q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, %L, 'Spare', 'final', 2, 'draft', 'ordinal_majority')$q$, pg_temp.u('00600' || r), pg_temp.ev(), v_prog, pg_temp.m('div' || d))) then
      perform pg_temp.put('round' || r, pg_temp.u('00600' || r));
    end if;
  end loop;
  for i in 1..3 loop
    perform pg_temp.step('setup', 'add judge ' || i, format($q$select public.add_competition_official(%L, %L, 'judge', gen_random_uuid())$q$, pg_temp.ev(), pg_temp.uid('J' || i)));
  end loop;
  foreach r in array array[1, 2, 5, 7] loop
    foreach j in array array['1:A', '2:B', '3:C'] loop
      perform pg_temp.step('setup', 'panel round ' || r || ' ' || j, format($q$select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())$q$, pg_temp.rid(r), pg_temp.off('J' || split_part(j, ':', 1)), split_part(j, ':', 2)));
    end loop;
  end loop;
  -- one published running order: floor heats numbered in the order they are run
  for v_order in select * from (values (array[1, 2, 5, 7, 6, 3, 8, 4]), (array[1, 2, 5, 7])) v loop
    select jsonb_agg(jsonb_build_object('number', o.ord, 'scoringHeats', jsonb_build_array(jsonb_build_object(
             'divisionId', rr.division_id, 'roundId', rr.id, 'heatNumber', o.ord, 'name', 'Heat ' || o.ord, 'danceIds', '[]'::jsonb,
             'entryIds', (select jsonb_agg(e.id order by e.id) from public.event_competition_entries e where e.division_id = rr.division_id and e.status = 'confirmed')))) order by o.ord)
    into v_floor from unnest(v_order) with ordinality o(rn, ord) join public.event_competition_rounds rr on rr.id = pg_temp.rid(o.rn);
    continue when v_floor is null;
    perform pg_temp.step('setup', 'create, plan and publish the running order for rounds ' || array_to_string(v_order, ','), format($q$do $do$ declare v uuid; begin v := public.create_competition_schedule_version(%L, 'P1R11 order', null); perform public.apply_competition_floor_plan(v, jsonb_build_object('floorHeats', %L::jsonb)); perform public.publish_competition_schedule_version(v); perform pg_temp.put('version', v); end $do$ $q$, pg_temp.ev(), v_floor));
    exit when pg_temp.m('version') is not null;
  end loop;
  foreach r in array array[1, 2, 3, 4, 5, 6, 7, 8] loop
    perform pg_temp.put('heat' || r, (select id from public.event_competition_heats where round_id = pg_temp.rid(r) and schedule_version_id = pg_temp.m('version') limit 1));
    perform pg_temp.put('floor' || r, (select floor_heat_id from public.event_competition_heats where id = pg_temp.hid(r)));
  end loop;
  -- the four rounds to be corrected: schedule, start, heat on the floor, judges' own ballots, close, lock, calculate A1, approve A2, correct A1, recalculate A1
  foreach r in array array[1, 2, 5, 7] loop
    perform pg_temp.step('setup', 'schedule round ' || r, format('select public.schedule_competition_round(%L, gen_random_uuid())', pg_temp.rid(r)));
    perform pg_temp.step('setup', 'start round ' || r, format('select public.start_competition_round(%L, gen_random_uuid())', pg_temp.rid(r)));
    perform pg_temp.step('setup', 'heat ' || r || ' staging', format($q$select public.advance_competition_floor_heat(%L, 'staging', gen_random_uuid())$q$, pg_temp.fl(r)));
    perform pg_temp.step('setup', 'heat ' || r || ' active', format($q$select public.advance_competition_floor_heat(%L, 'active', gen_random_uuid())$q$, pg_temp.fl(r)));
    foreach j in array array['1:[1,2,3]', '2:[1,3,2]', '3:[2,1,3]'] loop
      perform pg_temp.step('setup', 'ballot round ' || r, format($q$select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid(), null)$q$, pg_temp.rid(r), pg_temp.hid(r), pg_temp.marks(pg_temp.hid(r), split_part(j, ':', 2)::jsonb)), 'J' || split_part(j, ':', 1));
    end loop;
    perform pg_temp.step('setup', 'heat ' || r || ' complete', format($q$select public.advance_competition_floor_heat(%L, 'complete', gen_random_uuid())$q$, pg_temp.fl(r)));
    perform pg_temp.step('setup', 'lock heat ' || r, format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'heat finished on the floor')$q$, pg_temp.hid(r)));
    perform pg_temp.step('setup', 'lock ballots ' || r, format('select public.lock_competition_round_ballots(%L, gen_random_uuid())', pg_temp.rid(r)));
    perform pg_temp.step('setup', 'control: engine check ' || r, format('select pg_temp.engine_note(%L, %L)', 'setup', pg_temp.rid(r)));
    perform pg_temp.step('setup', 'calculate ' || r, pg_temp.calc_sql(pg_temp.rid(r)));
    perform pg_temp.step('setup', 'approve ' || r || ' v1 by the second manager', pg_temp.approve_sql(pg_temp.rid(r), null), 'A2');
  end loop;
  perform pg_temp.note('setup', 'control: first result approved by a second manager', coalesce(pg_temp.state(pg_temp.rid(1)), 'no round'));
  foreach r in array array[1, 2, 5, 7] loop
    perform pg_temp.step('setup', 'open correction ' || r, format($q$select public.open_competition_round_correction(%L, 'judge 2 mis-ranked the heat', gen_random_uuid())$q$, pg_temp.rid(r)));
    perform pg_temp.step('setup', 'recalculate ' || r, pg_temp.calc_sql(pg_temp.rid(r)), 'A1', pg_temp.rid(r));
  end loop;
  perform pg_temp.step('setup', 'approve 7 v2 by the second manager', pg_temp.approve_sql(pg_temp.rid(7), null), 'A2', pg_temp.rid(7));
  perform pg_temp.step('setup', 'control: A1 cannot self-approve the corrected result of round 1', pg_temp.approve_sql(pg_temp.rid(1), 'only manager present on the floor today'));
end $fn$;
select pg_temp.setup();

-- ============================================================================
-- Routes (manager A1; judges are asked to ballot only if the manager's paper entry is refused)
-- ============================================================================
create or replace function pg_temp.run_round(p_route text, p_round uuid, p_heat uuid, p_floor uuid) returns void language plpgsql as $fn$
declare j text; v_paper boolean;
begin
  perform pg_temp.note(p_route, 'before: the round to be run', coalesce(pg_temp.state(p_round), 'round not found'));
  if p_round is null or p_heat is null then
    perform pg_temp.note(p_route, 'stopped', 'REFUSED no round or no published heat to run (see setup)');
    return;
  end if;
  foreach j in array array['1:A', '2:B', '3:C'] loop
    perform pg_temp.step(p_route, 'assign judge ' || j, format($q$select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())$q$, p_round, pg_temp.off('J' || split_part(j, ':', 1)), split_part(j, ':', 2)));
  end loop;
  perform pg_temp.step(p_route, 'schedule round', format('select public.schedule_competition_round(%L, gen_random_uuid())', p_round));
  perform pg_temp.step(p_route, 'start round', format('select public.start_competition_round(%L, gen_random_uuid())', p_round));
  perform pg_temp.step(p_route, 'heat staging', format($q$select public.advance_competition_floor_heat(%L, 'staging', gen_random_uuid())$q$, p_floor));
  perform pg_temp.step(p_route, 'heat active', format($q$select public.advance_competition_floor_heat(%L, 'active', gen_random_uuid())$q$, p_floor));
  foreach j in array array['1:[3,2,1]', '2:[3,1,2]', '3:[2,3,1]'] loop
    v_paper := pg_temp.step(p_route, 'manager enters a paper ballot for judge ' || split_part(j, ':', 1), format($q$select public.enter_competition_paper_ballot(%L, %L, %L, %L::jsonb, gen_random_uuid())$q$, p_round, p_heat, pg_temp.off('J' || split_part(j, ':', 1)), pg_temp.marks(p_heat, split_part(j, ':', 2)::jsonb)));
    if not v_paper then
      perform pg_temp.step(p_route, 'the judge submits the ballot', format($q$select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid(), null)$q$, p_round, p_heat, pg_temp.marks(p_heat, split_part(j, ':', 2)::jsonb)), 'J' || split_part(j, ':', 1));
    end if;
  end loop;
  perform pg_temp.step(p_route, 'heat complete', format($q$select public.advance_competition_floor_heat(%L, 'complete', gen_random_uuid())$q$, p_floor));
  perform pg_temp.step(p_route, 'lock heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'probe run of another round')$q$, p_heat));
  perform pg_temp.step(p_route, 'lock ballots', format('select public.lock_competition_round_ballots(%L, gen_random_uuid())', p_round));
  perform pg_temp.step(p_route, 'engine check', format('select pg_temp.engine_note(%L, %L)', p_route, p_round));
  perform pg_temp.step(p_route, 'calculate', pg_temp.calc_sql(p_round));
  perform pg_temp.step(p_route, 'SELF-approve', pg_temp.approve_sql(p_round, 'only manager present on the floor today'));
  perform pg_temp.step(p_route, 'publish the result', format($q$select public.publish_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L and status = 'approved'), 'entrants', gen_random_uuid())$q$, p_round), 'A1', p_round);
end $fn$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.run_round('NC', pg_temp.rid(6), pg_temp.hid(6), pg_temp.fl(6));
select pg_temp.step('CS', 'cancel corrected round 2', format($q$select public.cancel_competition_round(%L, 'running this round again', gen_random_uuid())$q$, pg_temp.rid(2)), 'A1', pg_temp.rid(2));
select pg_temp.run_round('CS', pg_temp.rid(3), pg_temp.hid(3), pg_temp.fl(3));
select pg_temp.step('CA', 'cancel corrected, independently approved round 7', format($q$select public.cancel_competition_round(%L, 'running this round again', gen_random_uuid())$q$, pg_temp.rid(7)), 'A1', pg_temp.rid(7));
select pg_temp.run_round('CA', pg_temp.rid(8), pg_temp.hid(8), pg_temp.fl(8));
select pg_temp.step('R', 'cancel corrected round 1', format($q$select public.cancel_competition_round(%L, 'running this round again', gen_random_uuid())$q$, pg_temp.rid(1)), 'A1', pg_temp.rid(1));
select pg_temp.step('R', 'create a new round in D1', format($q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, %L, 'R1 again', 'final', 3, 'draft', 'ordinal_majority')$q$, pg_temp.u('006011'), pg_temp.ev(), pg_temp.m('program'), pg_temp.m('div1')));
select pg_temp.step('R', 'move the unrun published heat of the spare round to the new round', format('update public.event_competition_heats set round_id = %L where id = %L', pg_temp.u('006011'), pg_temp.hid(4)));
select pg_temp.run_round('R', (select h.round_id from public.event_competition_heats h where h.id = pg_temp.hid(4) and h.round_id = pg_temp.u('006011')), pg_temp.hid(4), pg_temp.fl(4));

-- Separate observation (phase C has no unrun spare heat): a direct move of an existing published heat to another round, always rolled back.
do $mv$
declare v_msg text; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid('A1'), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    update public.event_competition_heats set round_id = pg_temp.rid(7) where id = pg_temp.hid(5);
    get diagnostics v_n = row_count;
    execute 'set constraints all immediate';
    raise exception 'ROLLBACK_PROBE %', case when v_n = 0 then 'NOT TESTED (no such published heat)' else 'ACCEPTED (rows ' || v_n || ')' end;
  exception when others then
    v_msg := case when sqlerrm like 'ROLLBACK_PROBE %' then substr(sqlerrm, 16) else 'REFUSED ' || sqlstate || ' ' || left(replace(sqlerrm, chr(10), ' '), 220) end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.note('MOVE', 'direct move of the published heat of round 5 to round 7 (heat present: ' || (pg_temp.hid(5) is not null)::text || ')', v_msg);
end $mv$;

-- ============================================================================
-- Output (then roll everything back)
-- ============================================================================
select 'STEP ' || seq || ' [' || route || '] ' || step || ' => ' || outcome from t_probe order by seq;
-- Verdicts. Preconditions per route: the spare round with its published heat, and the corrected round with a recalculated result. Without them the route was
-- never exercised: CLOSED AT SETUP only when the refusal that removed the precondition is the restriction (COMP_P1_ / compp1_), otherwise INCONCLUSIVE.
-- CS, CA and R count as REACHED only if the corrected round really was cancelled.
select 'VERDICT ' || y.route || ': '
  || case
       when not (y.spare_ok and y.corrected) then
         case when y.blocker ~ '(COMP_P1_|compp1_)' then 'CLOSED AT SETUP by the restriction (later route steps not exercised): ' || y.blocker
              else 'INCONCLUSIVE (precondition absent, not shown to be the restriction): ' || coalesce(y.blocker, y.first_setup, 'no refusal recorded') end
       when y.published and y.self_approved and (y.route = 'NC' or y.cancelled) then 'REACHED (self-approved published result over the same couples)'
       when y.published and y.self_approved then 'NOT REACHED AS DEFINED (the cancel was refused, but running the other round was reachable)'
       when y.first_route is null then 'INCONCLUSIVE (not published, yet no refusal in the route)'
       when y.first_setup is not null and y.first_setup !~ '(COMP_P1_|compp1_)' then 'INCONCLUSIVE (a setup step failed for another reason: ' || y.first_setup || ')'
       else 'NOT REACHED'
     end
  || ' ; first refusal in setup: ' || coalesce(y.first_setup, 'none')
  || ' ; first refusal in the route: ' || coalesce(y.first_route, 'none')
from (
  select v.route,
    v.spare_round is not null and v.spare_heat is not null as spare_ok,
    exists (select 1 from public.event_competition_result_publications pb where pb.round_id = v.new_round and pb.withdrawn_at is null) as published,
    exists (select 1 from public.event_competition_result_approvals a join public.event_competition_result_versions rv on rv.id = a.result_version_id where rv.round_id = v.new_round and a.approved_by = pg_temp.uid('A1') and rv.calculated_by = pg_temp.uid('A1')) as self_approved,
    (select count(*) from public.event_competition_result_versions rv where rv.round_id = v.corrected_round) >= 2 as corrected,
    coalesce((select r.status = 'cancelled' from public.event_competition_rounds r where r.id = v.corrected_round), false) as cancelled,
    (select p.step || ' => ' || p.outcome from t_probe p where p.route = 'setup' and p.outcome ~ '^(REFUSED|NO ROWS)'
       and (p.step like 'add spare round ' || v.spare_no || ' %' or p.step like 'open correction ' || v.corrected_no || ' %') order by p.seq limit 1) as blocker,
    (select p.step || ' => ' || p.outcome from t_probe p where p.route = 'setup' and p.outcome ~ '^(REFUSED|NO ROWS)' and p.step not like 'control:%' order by p.seq limit 1) as first_setup,
    (select p.step || ' => ' || p.outcome from t_probe p where p.route = v.route and p.outcome ~ '^(REFUSED|NO ROWS)' order by p.seq limit 1) as first_route
  from (values
    ('NC', pg_temp.rid(6), 6, pg_temp.rid(6), pg_temp.hid(6), pg_temp.rid(5), 5),
    ('CS', pg_temp.rid(3), 3, pg_temp.rid(3), pg_temp.hid(3), pg_temp.rid(2), 2),
    ('CA', pg_temp.rid(8), 8, pg_temp.rid(8), pg_temp.hid(8), pg_temp.rid(7), 7),
    ('R', pg_temp.u('006011'), 4, pg_temp.rid(4), pg_temp.hid(4), pg_temp.rid(1), 1)
  ) v(route, new_round, spare_no, spare_round, spare_heat, corrected_round, corrected_no)
) y;
select 'VERDICT-MOVE: ' || coalesce((select step || ' => ' || outcome from t_probe where route = 'MOVE'), 'not recorded');
select 'P1R11 PROBE COMPLETE';
rollback;
