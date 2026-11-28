-- P1 second-contest probe: the residual the route probe does not cover (the same people entered in a second contest; one of the two results is published).
-- OBSERVATION probe: it records every step (OK / REFUSED with SQLSTATE and message) and prints one VERDICT line per variant; it is not a pass/fail suite.
-- LOCAL DISPOSABLE QA DATABASE ONLY. One transaction, always rolled back. Competition state is built through application paths only, exactly as the route
-- probe does (its helper and identity-seed section is repeated below): the superuser seeds identities and studio roles, reads state and computes the engine
-- rows through a read-only helper. Variants: SCD second division of the same contest, SCC second contest, SCP second program, SCE second event (all prepared
-- before judging); SCA a division added to the same event after the original was judged; SCN a new event created after it was judged.
-- The original (D1) is judged and approved by a second manager and left unpublished; in each variant the judges prefer another couple, the calculator tries to
-- approve their own result (the second manager approves only if that is refused) and the result is published.

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
-- Variant helpers. A "contest key" names one division with its final: D1 is the original; the others are second contests for the SAME six people.
-- ============================================================================
create temp table t_key (k text primary key, ev uuid, prog uuid, contest uuid, division uuid, round uuid, heat uuid, floor uuid, winner text) on commit drop;
grant select, insert, update on t_key to authenticated, service_role;
create or replace function pg_temp.kk(p_k text) returns t_key language sql stable security definer as $$ select * from t_key where k = p_k $$;
create or replace function pg_temp.kset(p_k text, p_col text, p_v uuid) returns void language plpgsql security definer as $$
begin execute format('update t_key set %I = $1 where k = $2', p_col) using p_v, p_k; end $$;
create or replace function pg_temp.offi(p_ev uuid, p_actor text) returns uuid language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = p_ev and user_id = pg_temp.uid(p_actor) $$;
-- the people of a division, as names and dates of birth (competitor records differ between events, so identity is compared by these)
create or replace function pg_temp.people(p_division uuid) returns text language sql stable security definer as $$
  select string_agg(c.first_name || ' ' || c.last_name || ' ' || coalesce(c.date_of_birth::text, '?'), ';' order by c.first_name, c.last_name)
  from public.event_competition_entry_participants p join public.event_competition_entries e on e.id = p.entry_id join public.event_competition_competitors c on c.id = p.competitor_id
  where e.division_id = p_division and e.status = 'confirmed' $$;
-- the couple of an entry, named by its first dancer
create or replace function pg_temp.couple(p_entry uuid) returns text language sql stable security definer as $$
  select min(c.first_name) from public.event_competition_entry_participants p join public.event_competition_competitors c on c.id = p.competitor_id where p.entry_id = p_entry $$;
-- marks by couple (not by entry id), so that the same preference is expressed in every division
create or replace function pg_temp.marks_by_couple(p_heat uuid, p_vals int[]) returns jsonb language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals[x.rn]) order by x.rn)
  from (select he.entry_id, row_number() over (order by pg_temp.couple(he.entry_id))::int rn from public.event_competition_heat_entries he where he.heat_id = p_heat) x $$;
create or replace function pg_temp.winner_note(p_k text, p_round uuid) returns void language plpgsql as $d$
declare v_in jsonb; v_out jsonb; v_w text;
begin
  v_in := public.competition_round_calculation_input(p_round);
  v_out := pg_temp.engine(v_in -> 'evidence');
  select pg_temp.couple((r ->> 'entry_id')::uuid) into v_w from jsonb_array_elements(v_out -> 'rows') r where (r ->> 'placement')::int = 1 limit 1;
  update t_key set winner = v_w where k = p_k;
  perform pg_temp.note(p_k, '  engine winner', coalesce(v_w, 'none') || ' (ok=' || coalesce(v_out ->> 'ok', '?') || ')');
end $d$;

-- one event with a published studio profile competition whose single couples division is the key's division
create or replace function pg_temp.new_event(p_k text, p_suffix text) returns void language plpgsql as $fn$
declare v_ev uuid := pg_temp.u('00e' || p_suffix); v_prog uuid;
begin
  insert into t_key (k, ev) values (p_k, v_ev);
  perform pg_temp.step(p_k, 'create the event', format($q$insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values (%L, %L, %L, %L, 'competition', current_date + 30, current_date + 30, 'published', 'public', true)$q$, v_ev, pg_temp.u('00a001'), 'SC ' || p_k, 't-p1sc-' || p_suffix));
  perform pg_temp.step(p_k, 'create_simple_competition', format($q$select public.create_simple_competition(%L, %L::jsonb)$q$, v_ev,
    jsonb_build_object('profile_key', 'studio_simple', 'profile_version', 1, 'request_key', 'p1sc-request-' || p_suffix, 'preset', 'studio_competition', 'judging', 'placements',
      'categories', jsonb_build_array(jsonb_build_object('type', 'couples', 'price', '0', 'dances', jsonb_build_array('waltz'))), 'divisions', jsonb_build_array(jsonb_build_object('name', p_k)))));
  select id into v_prog from public.event_competition_programs where event_id = v_ev;
  perform pg_temp.kset(p_k, 'prog', v_prog);
  perform pg_temp.kset(p_k, 'division', (select id from public.event_competition_divisions where event_id = v_ev and name = p_k));
  perform pg_temp.kset(p_k, 'contest', (select contest_id from public.event_competition_divisions where event_id = v_ev and name = p_k));
  perform pg_temp.kset(p_k, 'round', (select id from public.event_competition_rounds where division_id = (pg_temp.kk(p_k)).division limit 1));
end $fn$;

-- another division (with its final and dance offering) in a contest of the base event, written by the manager
create or replace function pg_temp.add_division(p_k text, p_base text, p_contest uuid, p_prog uuid, p_dance uuid, p_open boolean default false) returns void language plpgsql as $fn$
declare b t_key := pg_temp.kk(p_base); v_div uuid := gen_random_uuid(); v_round uuid := gen_random_uuid(); ok boolean;
begin
  if p_contest is null or p_prog is null then perform pg_temp.note(p_k, 'add the division', 'REFUSED no contest or program to add it to'); return; end if;
  ok := pg_temp.step(p_k, 'add the division', format($q$insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status, sort_order) values (%L, %L, %L, %L, %L, %L, 50)$q$, v_div, b.ev, p_prog, p_contest, p_k, case when p_open then 'open' else 'draft' end));
  if not ok then return; end if;
  perform pg_temp.kset(p_k, 'division', v_div); perform pg_temp.kset(p_k, 'contest', p_contest); perform pg_temp.kset(p_k, 'prog', p_prog);
  if pg_temp.step(p_k, 'add its final', format($q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, pairing_mode) select %L, %L, %L, %L, 'Final', 'final', 1, 'draft', r.scoring_method, r.pairing_mode from public.event_competition_rounds r where r.id = %L$q$, v_round, b.ev, p_prog, v_div, b.round)) then
    perform pg_temp.kset(p_k, 'round', v_round);
  end if;
  perform pg_temp.step(p_k, 'offer the dance', format($q$insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order) select %L, %L, %L, coalesce(%L::uuid, d.dance_id), d.entry_fee, d.currency, d.required, d.sort_order from public.event_competition_division_dances d where d.division_id = %L limit 1$q$, b.ev, p_prog, v_div, p_dance, b.division));
end $fn$;

create or replace function pg_temp.copy_contest_rules(p_k text, p_new uuid, p_old uuid) returns void language plpgsql as $fn$
begin
  perform pg_temp.step(p_k, 'copy the registration rule', format($q$update public.event_competition_contest_registration_rules n set dance_selection_mode = o.dance_selection_mode, pricing_method = o.pricing_method, base_entry_fee = o.base_entry_fee, currency = o.currency, minimum_dances = o.minimum_dances, maximum_dances = o.maximum_dances, minimum_participants = o.minimum_participants, maximum_participants = o.maximum_participants, terminology = o.terminology from public.event_competition_contest_registration_rules o where n.contest_id = %L and o.contest_id = %L$q$, p_new, p_old));
end $fn$;

create or replace function pg_temp.open_reg(p_k text, p_publish boolean) returns void language plpgsql as $fn$
declare t t_key := pg_temp.kk(p_k);
begin
  if p_publish then perform pg_temp.step(p_k, 'publish the program', format('select public.publish_competition_program(%L)', t.prog)); end if;
  perform pg_temp.step(p_k, 'open registration', format('select public.open_competition_registration(%L)', t.prog));
end $fn$;

-- the same three couples (same names and dates of birth) registered into the key's division, then cleared by the organizer
create or replace function pg_temp.register(p_k text, p_n int) returns void language plpgsql as $fn$
declare t t_key := pg_temp.kk(p_k); v_people jsonb; v_entries jsonb; v_e record; v_req text[];
begin
  if t.division is null then perform pg_temp.note(p_k, 'register the couples', 'REFUSED no division'); return; end if;
  select jsonb_agg(jsonb_build_object('clientId', 'p' || g, 'firstName', 'Same' || g, 'lastName', 'Person', 'personType', 'dancer', 'dateOfBirth', '1990-01-0' || g) order by g) into v_people from generate_series(1, 6) g;
  select jsonb_agg(jsonb_build_object('clientId', 'e' || g, 'programId', t.prog, 'contestId', t.contest, 'divisionId', t.division,
           'participantIds', jsonb_build_array('p' || (2 * g - 1), 'p' || (2 * g)), 'participantRoles', jsonb_build_object('p' || (2 * g - 1), 'dancer', 'p' || (2 * g), 'dancer'),
           'participantDanceRoles', jsonb_build_object('p' || (2 * g - 1), 'leader', 'p' || (2 * g), 'follower'),
           'selectedOfferingIds', (select jsonb_agg(dd.id) from public.event_competition_division_dances dd where dd.division_id = t.division)) order by g)
  into v_entries from generate_series(1, 3) g;
  perform pg_temp.step(p_k, 'register the same three couples', format($q$select public.start_competition_registration(%L, %L, %L::jsonb, %L)$q$, t.ev, pg_temp.u('00f0' || lpad(p_n::text, 2, '0')),
    jsonb_build_object('registrationMode', 'individual', 'buyerName', 'Bea Buyer', 'buyerEmail', 'buyer@example.test', 'people', v_people, 'entries', v_entries), pg_temp.uid('A1')), 'SVC');
  for v_e in select id from public.event_competition_entries where division_id = t.division order by id loop
    if to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is not null then
      v_req := public._r15_required_criteria(v_e.id);
      perform pg_temp.step(p_k, 'eligibility determination', format($q$select public.set_competition_entry_eligibility(%L, 'eligible', 'criteria_verified_by_organizer', %L::text[], gen_random_uuid())$q$, v_e.id, v_req));
    else
      perform pg_temp.step(p_k, 'eligibility (direct write, chain without R-15)', format($q$update public.event_competition_entries set eligibility_status = 'eligible' where id = %L$q$, v_e.id));
    end if;
  end loop;
  perform pg_temp.note(p_k, 'entries', (select count(*)::text || ' confirmed' from public.event_competition_entries where division_id = t.division and status = 'confirmed'));
end $fn$;

create or replace function pg_temp.officials(p_k text) returns void language plpgsql as $fn$
declare i int; t t_key := pg_temp.kk(p_k);
begin
  for i in 1..3 loop perform pg_temp.step(p_k, 'add judge ' || i, format($q$select public.add_competition_official(%L, %L, 'judge', gen_random_uuid())$q$, t.ev, pg_temp.uid('J' || i))); end loop;
end $fn$;

-- one running order for an event holding the final of each listed key that has a round and entries; records which keys got a published heat
create or replace function pg_temp.order_event(p_note_key text, p_keys text[]) returns void language plpgsql as $fn$
declare v_ev uuid := (pg_temp.kk(p_keys[1])).ev; v_floor jsonb; k text; t t_key;
begin
  select jsonb_agg(jsonb_build_object('number', q.n, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', q.division, 'roundId', q.round, 'heatNumber', q.n, 'name', 'Heat ' || q.n,
           'danceIds', (select jsonb_agg(distinct dd.dance_id) from public.event_competition_division_dances dd where dd.division_id = q.division),
           'entryIds', (select jsonb_agg(e.id order by e.id) from public.event_competition_entries e where e.division_id = q.division and e.status = 'confirmed')))) order by q.n)
  into v_floor from (select x.division, x.round, row_number() over (order by o.ord)::int as n from unnest(p_keys) with ordinality o(key, ord) join t_key x on x.k = o.key
    where x.round is not null and exists (select 1 from public.event_competition_entries e where e.division_id = x.division and e.status = 'confirmed')) q;
  if v_floor is null then perform pg_temp.note(p_note_key, 'running order', 'REFUSED nothing to place'); return; end if;
  perform pg_temp.step(p_note_key, 'publish a running order for ' || array_to_string(p_keys, ','), format($q$do $do$ declare v uuid; begin v := public.create_competition_schedule_version(%L, 'SC order', null); perform public.apply_competition_floor_plan(v, jsonb_build_object('floorHeats', %L::jsonb)); perform public.publish_competition_schedule_version(v); end $do$ $q$, v_ev, v_floor));
  foreach k in array p_keys loop
    t := pg_temp.kk(k);
    perform pg_temp.kset(k, 'heat', (select h.id from public.event_competition_heats h join public.event_competition_schedule_versions v on v.id = h.schedule_version_id where h.round_id = t.round and v.status in ('published', 'live') limit 1));
    perform pg_temp.kset(k, 'floor', (select h.floor_heat_id from public.event_competition_heats h where h.id = (pg_temp.kk(k)).heat));
    perform pg_temp.note(k, 'published heat', case when (pg_temp.kk(k)).heat is null then 'REFUSED none' else 'present' end);
  end loop;
end $fn$;

-- panel, round start, heat, the judges' own ballots, calculation; then approval. p_self: the calculator tries first, the second manager only if refused.
create or replace function pg_temp.judge(p_k text, p_vals int[], p_self boolean, p_publish boolean) returns void language plpgsql as $fn$
declare t t_key := pg_temp.kk(p_k); i int; v_self boolean := false;
begin
  if t.round is null or t.heat is null then perform pg_temp.note(p_k, 'judging stopped', 'REFUSED no round or no published heat'); return; end if;
  for i in 1..3 loop perform pg_temp.step(p_k, 'assign judge ' || i, format($q$select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())$q$, t.round, pg_temp.offi(t.ev, 'J' || i), chr(64 + i))); end loop;
  perform pg_temp.step(p_k, 'schedule round', format('select public.schedule_competition_round(%L, gen_random_uuid())', t.round));
  perform pg_temp.step(p_k, 'start round', format('select public.start_competition_round(%L, gen_random_uuid())', t.round));
  perform pg_temp.step(p_k, 'heat staging', format($q$select public.advance_competition_floor_heat(%L, 'staging', gen_random_uuid())$q$, t.floor));
  perform pg_temp.step(p_k, 'heat active', format($q$select public.advance_competition_floor_heat(%L, 'active', gen_random_uuid())$q$, t.floor));
  for i in 1..3 loop perform pg_temp.step(p_k, 'judge ' || i || ' submits', format($q$select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid(), null)$q$, t.round, t.heat, pg_temp.marks_by_couple(t.heat, p_vals)), 'J' || i); end loop;
  perform pg_temp.step(p_k, 'heat complete', format($q$select public.advance_competition_floor_heat(%L, 'complete', gen_random_uuid())$q$, t.floor));
  perform pg_temp.step(p_k, 'lock heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'heat finished on the floor')$q$, t.heat));
  perform pg_temp.step(p_k, 'lock ballots', format('select public.lock_competition_round_ballots(%L, gen_random_uuid())', t.round));
  perform pg_temp.step(p_k, 'winner check', format('select pg_temp.winner_note(%L, %L)', p_k, t.round));
  perform pg_temp.step(p_k, 'calculate', pg_temp.calc_sql(t.round));
  if p_self then v_self := pg_temp.step(p_k, 'calculator approves own result', pg_temp.approve_sql(t.round, 'only manager present on the floor today')); end if;
  if not v_self then perform pg_temp.step(p_k, 'second manager approves', pg_temp.approve_sql(t.round, null), 'A2'); end if;
  if p_publish then
    perform pg_temp.step(p_k, 'publish the result', format($q$select public.publish_competition_round_result(%1$L, (select id from public.event_competition_result_versions where round_id = %1$L and status = 'approved'), 'entrants', gen_random_uuid())$q$, t.round), 'A1', t.round);
  else
    perform pg_temp.note(p_k, '  state (left unpublished)', coalesce(pg_temp.state(t.round), 'none'));
  end if;
end $fn$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ============================================================================
-- Scenario
-- ============================================================================
create or replace function pg_temp.scenario() returns void language plpgsql as $fn$
declare d1 t_key; v_contest uuid := gen_random_uuid(); v_prog uuid := gen_random_uuid(); v_dance uuid := gen_random_uuid(); k text; n int := 0; v_ok boolean;
begin
  -- prepared before any judging: the original (D1), a second division in its contest (SCD), a second contest (SCC), a second program (SCP), a second event (SCE)
  perform pg_temp.new_event('D1', '101');
  d1 := pg_temp.kk('D1');
  insert into t_key (k, ev) values ('SCD', d1.ev), ('SCC', d1.ev), ('SCP', d1.ev);
  perform pg_temp.add_division('SCD', 'D1', d1.contest, d1.prog, null);
  if pg_temp.step('SCC', 'add a second contest', format($q$insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, sort_order, configuration) select %L, c.event_id, c.program_id, 'Second contest', c.contest_type, c.entry_format, 60, c.configuration from public.event_competition_contests c where c.id = %L$q$, v_contest, d1.contest)) then
    perform pg_temp.copy_contest_rules('SCC', v_contest, d1.contest);
    perform pg_temp.add_division('SCC', 'D1', v_contest, d1.prog, null);
  end if;
  v_ok := pg_temp.step('SCP', 'add a second program', format($q$insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, advancement_method, feedback_policy, status, rules_profile_key, rules_profile_version, configuration) select %L, p.event_id, p.studio_id, 'Second program', p.discipline_family, p.competition_mode, p.scoring_method, p.advancement_method, p.feedback_policy, 'draft', p.rules_profile_key, p.rules_profile_version, p.configuration from public.event_competition_programs p where p.id = %L$q$, v_prog, d1.prog));
  if not v_ok then
    v_ok := pg_temp.step('SCP', 'add a second program without a rules profile', format($q$insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, advancement_method, feedback_policy, status, configuration) select %L, p.event_id, p.studio_id, 'Second program', p.discipline_family, p.competition_mode, p.scoring_method, p.advancement_method, p.feedback_policy, 'configured', '{}'::jsonb from public.event_competition_programs p where p.id = %L$q$, v_prog, d1.prog));
  end if;
  if v_ok then
    declare v_c uuid := gen_random_uuid();
    begin
      perform pg_temp.step('SCP', 'add the dance to the second program', format($q$insert into public.event_competition_dances (id, event_id, program_id, dance_key, name, category_label, sort_order) select %L, x.event_id, %L, x.dance_key, x.name, x.category_label, x.sort_order from public.event_competition_dances x where x.program_id = %L limit 1$q$, v_dance, v_prog, d1.prog));
      if pg_temp.step('SCP', 'add its contest', format($q$insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, sort_order, configuration) select %L, c.event_id, %L, c.name, c.contest_type, c.entry_format, 10, c.configuration from public.event_competition_contests c where c.id = %L$q$, v_c, v_prog, d1.contest)) then
        perform pg_temp.copy_contest_rules('SCP', v_c, d1.contest);
        perform pg_temp.add_division('SCP', 'D1', v_c, v_prog, v_dance);
      end if;
    end;
  end if;
  perform pg_temp.open_reg('D1', true);
  if (pg_temp.kk('SCP')).prog is not null then perform pg_temp.open_reg('SCP', true); end if;
  perform pg_temp.new_event('SCE', '102');
  perform pg_temp.open_reg('SCE', true);
  foreach k in array array['D1', 'SCD', 'SCC', 'SCP', 'SCE'] loop n := n + 1; perform pg_temp.register(k, n); end loop;
  perform pg_temp.officials('D1');
  perform pg_temp.officials('SCE');
  perform pg_temp.order_event('D1', array['D1', 'SCD', 'SCC', 'SCP']);
  perform pg_temp.order_event('SCE', array['SCE']);
  -- the original is judged first: couple 1 wins; a second manager approves; it is NOT published
  perform pg_temp.judge('D1', array[1, 2, 3], false, false);
  -- prepared AFTER seeing the original: a further division of the same contest (SCA) and a new event (SCN)
  insert into t_key (k, ev) values ('SCA', d1.ev);
  perform pg_temp.add_division('SCA', 'D1', d1.contest, d1.prog, null, true);
  if (pg_temp.kk('SCA')).division is not null then
    perform pg_temp.register('SCA', 6);
  end if;
  perform pg_temp.new_event('SCN', '103');
  perform pg_temp.open_reg('SCN', true);
  perform pg_temp.register('SCN', 7);
  perform pg_temp.officials('SCN');
  perform pg_temp.order_event('SCN', array['SCN']);
  -- every second contest: the other couple (3) is preferred; the calculator tries to approve first; the result is published
  foreach k in array array['SCD', 'SCC', 'SCP', 'SCE', 'SCN'] loop perform pg_temp.judge(k, array[3, 2, 1], true, true); end loop;
  -- the late division of the same event needs a new running order after heats have run
  if (pg_temp.kk('SCA')).round is not null then
    perform pg_temp.order_event('SCA', array['SCA']);
    perform pg_temp.judge('SCA', array[3, 2, 1], true, true);
  end if;
end $fn$;
grant execute on all functions in schema pg_temp to authenticated, service_role;
select pg_temp.scenario();

-- ============================================================================
-- Output (then roll everything back)
-- ============================================================================
select 'STEP ' || seq || ' [' || route || '] ' || step || ' => ' || outcome from t_probe order by seq;
select 'ORIGINAL D1: ' || coalesce(pg_temp.state(t.round), 'no round') || ' ; engine winner ' || coalesce(t.winner, 'none') from t_key t where t.k = 'D1';
select 'VERDICT ' || y.k || ' (' || y.label || '): '
  || case
       when not y.original_ok then 'INCONCLUSIVE (the original has no approved result: ' || coalesce(y.d1_refusal, 'no refusal recorded') || ')'
       when y.published and not y.same_people then 'INCONCLUSIVE (published, but not shown to be the same people)'
       when y.published and y.self_approved then 'REACHED (self-approved published result for the same people while the original stays unpublished)'
       when y.published then 'NOT REACHED self-approved; a second result for the same people WAS published with a second approver while the original stays unpublished'
       when not y.placed and y.first_refusal ~ '(COMP_P1_|compp1_)' then 'CLOSED AT SETUP by the restriction'
       when y.first_refusal is null then 'INCONCLUSIVE (not published, yet no refusal)'
       when not y.placed and y.first_refusal !~ '(COMP_P1_|compp1_)' then 'INCONCLUSIVE (the contest could not be prepared; read the refusal)'
       else 'NOT REACHED'
     end
  || ' ; winner ' || coalesce(y.winner, '-') || ' vs original ' || coalesce(y.d1_winner, '-')
  || ' ; first refusal: ' || coalesce(y.first_refusal, 'none')
from (
  select v.k, v.label, t.winner, d.winner as d1_winner,
    exists (select 1 from public.event_competition_result_versions rv join public.event_competition_result_approvals a on a.result_version_id = rv.id where rv.round_id = d.round and rv.status = 'approved') as original_ok,
    t.heat is not null as placed,
    coalesce(pg_temp.people(t.division) = pg_temp.people(d.division), false) as same_people,
    exists (select 1 from public.event_competition_result_publications pb where pb.round_id = t.round and pb.withdrawn_at is null)
      and not exists (select 1 from public.event_competition_result_publications pb where pb.round_id = d.round and pb.withdrawn_at is null) as published,
    exists (select 1 from public.event_competition_result_approvals a join public.event_competition_result_versions rv on rv.id = a.result_version_id where rv.round_id = t.round and a.approved_by = pg_temp.uid('A1') and rv.calculated_by = pg_temp.uid('A1')) as self_approved,
    (select p.step || ' => ' || p.outcome from t_probe p where p.route = v.k and p.outcome ~ '^(REFUSED|NO ROWS)' order by p.seq limit 1) as first_refusal,
    (select p.step || ' => ' || p.outcome from t_probe p where p.route = 'D1' and p.outcome ~ '^(REFUSED|NO ROWS)' order by p.seq limit 1) as d1_refusal
  from (values ('SCD', 'second division, same contest, before judging'), ('SCC', 'second contest, same program, before judging'), ('SCP', 'second program, same event, before judging'),
               ('SCE', 'second event, before judging'), ('SCA', 'division added to the same event after judging'), ('SCN', 'new event after judging')) v(k, label)
  join t_key d on d.k = 'D1'
  left join t_key t on t.k = v.k
) y;
select 'P1R11 PROBE COMPLETE';
rollback;
