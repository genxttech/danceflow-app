-- Competition CF1 package A0 -- tie-over-capacity policy (SCN-11.4b / SCN-11.4b-cap) regression suite.
--
-- Owner policy (approved): when a tie at the callback cut-off exceeds the Final's advancement capacity, DanceFlow preserves the valid scores
-- and the tie evidence, but does NOT advance additional couples, does NOT break the tie arbitrarily and does NOT commit any advancement.
-- The advancement stays UNRESOLVED until it is resolved through an authorized, auditable workflow consistent with the rules (a corrected
-- judge ballot through the A7 correction path). No tie-breaker is invented.
--
-- Database model under test (migration 20270120090000, unchanged): a calculated callback_tally version with ANY result row advanced IS NULL
-- is a "blocked tie". The F1 engine completes an over-capacity tie with EVERY row advanced = null and per-row output
-- {tally, callback_rank, tie_status in above_cut / tied_at_cut / below_cut}; this suite stores exactly that shape through the real
-- calculate_competition_round RPC (the database does not run the engine, it stores what the app sends).
--
-- Coverage map (assertion -> section):
--   (a) calculate stores the blocked version, evidence intact, no authorization rows ........ section 2
--   (b) approve refused COMP_ADVANCEMENT_BLOCKED, nothing changes ............................ section 3
--   (c) preview state 'blocked' naming COMP_ADVANCEMENT_BLOCKED / tie_over_capacity (calculated, stale and approved-replica arms) ... section 4, 8
--   (d) apply refused, nothing written ............................................................ section 5
--   (e) no override path (history guards, grants, direct writes) ............................. section 6
--   (f) capacity raise / lowering / F1 raise-to-T refused ........................................ section 7
--   (g) supported resolution: A7 corrected ballot -> supersede -> recalculate -> dissolve / still blocked ..... section 8
--   (h) a blocked version is stale-safe: tie evidence preserved after a correction opens ......... section 8
--
-- Needs the chain through HL1, A1, A0, A3, A5 and A7 (sections 8 needs A7; without it section 8 is reported BLOCKED). Run as a SUPERUSER.
-- One transaction, synthetic fixtures only (md5-derived ids). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A0 TIE POLICY SUITE PASS (<n> checks, <b> blocked ...)"  or  "... FAIL: <failures>".

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
-- @@SHARED-BEGIN (this block down to the matching end marker is also loaded, as schema cf1tie, by test_T_competition_cf1_a0_tie_concurrency.sh)
create or replace function pg_temp.id(p_kind text, p_n int default 0, p_k int default 0) returns uuid
language sql immutable as $$ select md5('cf1a0t:' || p_kind || ':' || p_n || ':' || p_k)::uuid $$;
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
create or replace function pg_temp.code(p_j jsonb) returns text language sql as $$ select split_part(coalesce(p_j ->> 'error', 'OK'), ':', 1) $$;
create or replace function pg_temp.su(p_sql text) returns void
language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  execute p_sql;
  perform set_config('session_replication_role', 'origin', true);
end $$;
-- Scalar query helpers (definer: the reads must work regardless of the current role).
create or replace function pg_temp.n(p_sql text) returns bigint language plpgsql security definer as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.t(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures. Users: 1 manager (opener / calculator), 2 second manager (approver / co-signer), 4 chair official, 11/12/13 judges, 9 unrelated verified user.
-- ============================================================================
insert into auth.users (id, email)
select pg_temp.id('user', u), 't-cf1a0t-u' || u || '@example.test' from unnest(array[1, 2, 4, 9, 11, 12, 13]) u;
insert into public.profiles (id, email, full_name) select id, email, 'CF1A0T ' || split_part(email, '@', 1) from auth.users where email like 't-cf1a0t-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a0t-%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 A0 Tie Studio', 't-cf1a0t-a');
insert into public.user_studio_roles (user_id, studio_id, role, active)
select pg_temp.id('user', u), pg_temp.id('studio', 1), 'studio_owner', true from unnest(array[1, 2]) u;
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'CF1 A0 Tie Comp', 't-cf1a0t-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values (pg_temp.id('prg', 1), pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'Callback program', 'country', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values (pg_temp.id('cts', 1), pg_temp.id('evt', 1), pg_temp.id('prg', 1), 'Contest', 'single_dance', 'pro_am', 'open');
-- The live (published, floor-mode) schedule version: the version the Final heat would be appended to.
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values (pg_temp.id('sv', 1), pg_temp.id('evt', 1), 1, 'V1', 'published', now());
insert into public.event_competition_officials (id, event_id, user_id, role)
select pg_temp.id('off', u), pg_temp.id('evt', 1), pg_temp.id('user', u), case when u = 4 then 'chair' else 'judge' end from unnest(array[4, 11, 12, 13]) u;

-- Scenario n: a callback round (T = 3, 8 entries, one danced heat, judges 11/12/13 on the panel as A/B/C) in status active, a scheduled Final (successor),
-- a certified callback heat on its own floor heat of the live version, one dance. The Final's capacity is set through the reasoned RPC (p_cap) before any
-- ballot exists, as a manager would. Ballots are filed separately (v1 / vtie).
create or replace function pg_temp.mk(p_n int, p_cap int default 3) returns void
language plpgsql security definer as $$
declare
  v_event uuid := pg_temp.id('evt', 1);
  v_k int;
  v_letter text[] := array['A', 'B', 'C'];
  j int;
  v_judges int[] := array[11, 12, 13];
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('div', p_n), v_event, pg_temp.id('prg', 1), pg_temp.id('cts', 1), 'D' || p_n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
  values (pg_temp.id('src', p_n), v_event, pg_temp.id('prg', 1), pg_temp.id('div', p_n), 'D' || p_n || ' Callback', 'preliminary', 1, 'active', 'callback_tally', 3);
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values (pg_temp.id('fin', p_n), v_event, pg_temp.id('prg', 1), pg_temp.id('div', p_n), 'D' || p_n || ' Final', 'final', 2, 'scheduled', 'ordinal_majority');
  for v_k in 1..8 loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values (pg_temp.id('ent', p_n, v_k), v_event, pg_temp.id('prg', 1), pg_temp.id('div', p_n), 'e' || p_n || '-' || v_k, 'confirmed', 'eligible', (p_n * 100 + v_k)::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.id('cbf', p_n), v_event, pg_temp.id('sv', 1), p_n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
  values (pg_temp.id('cbh', p_n), v_event, pg_temp.id('div', p_n), pg_temp.id('src', p_n), 1, 'complete', 'certified', pg_temp.id('cts', 1), pg_temp.id('sv', 1), pg_temp.id('cbf', p_n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (v_event, pg_temp.id('cbh', p_n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
  select v_event, pg_temp.id('div', p_n), pg_temp.id('cbh', p_n), pg_temp.id('ent', p_n, k), k, 'danced' from generate_series(1, 8) k;
  for j in 1..3 loop
    insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
    values (v_event, pg_temp.id('src', p_n), pg_temp.id('off', v_judges[j]), v_letter[j]);
  end loop;
  insert into public.event_competition_scoring_pins (round_id, division_id, program_id, event_id, method_key, method_version, resolution, legacy_scoring_method, registry_status, sanctioning)
  select pg_temp.id('src', p_n), pg_temp.id('div', p_n), pg_temp.id('prg', 1), v_event, 'studio_callback_tally', '1', 'legacy_map', 'callback_tally', 'approved', e.competition_sanctioning
  from public.events e where e.id = v_event;
  perform set_config('session_replication_role', 'origin', true);
end $$;
-- Capacity of the Final through the real RPC (manager 1), before any ballot.
create or replace function pg_temp.set_cap(p_n int, p_cap int) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.set_competition_round_heat_capacity(%L, %s, 'Floor limit for this division is %s couples.', %L)$q$,
    pg_temp.id('fin', p_n), p_cap, p_cap, pg_temp.id('capreq', p_n, p_cap)));
end $$;
-- Ballots: marks for entry numbers of scenario n, filed through the internal writer both public RPCs call.
create or replace function pg_temp.mk_marks(p_n int, p_nums int[]) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object('entry_id', pg_temp.id('ent', p_n, x), 'value', true) order by x) from unnest(p_nums) x
$$;
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
-- J11 {1,2,3}, J12 {1,2,4}, J13 {1,3,4}: tallies e1=3, e2=e3=e4=2, e5..e8=0 -> with T=3 the rank-2 group (3 couples, 4 in all) straddles the cut-off.
create or replace function pg_temp.vtie(p_n int) returns void language plpgsql security definer as $$
begin
  perform pg_temp.file(p_n, 11, array[1, 2, 3]);
  perform pg_temp.file(p_n, 12, array[1, 2, 4]);
  perform pg_temp.file(p_n, 13, array[1, 3, 4]);
end $$;
-- J11 {1,2,3}, J12 {1,2,4}, J13 {1,2,3}: tallies 3,3,2,1 -> exactly three couples at or above the cut-off: no tie.
create or replace function pg_temp.vclean(p_n int) returns void language plpgsql security definer as $$
begin
  perform pg_temp.file(p_n, 11, array[1, 2, 3]);
  perform pg_temp.file(p_n, 12, array[1, 2, 4]);
  perform pg_temp.file(p_n, 13, array[1, 2, 3]);
end $$;
-- What the F1 engine returns for the CURRENT ballots (database-side model of the engine, used only to build realistic p_rows): rank = 1 + number of couples
-- with a higher tally; "ge" = couples at or above this tally. A group is above the cut when ge <= T, straddles it when rank <= T < ge, else below. A straddling
-- group whose couples (ge) fit the Final's capacity is advanced as a group; a straddling group that does NOT fit makes the WHOLE result unresolved:
-- every row advanced = null (completes, does not fail), output {tally, callback_rank, tie_status}.
create or replace function pg_temp.rows_for(p_n int, p_cap int, p_t int default 3) returns jsonb
language sql stable security definer as $$
  with t as (
    select e as entry_id,
           (select count(*) from public.event_competition_marks m join public.event_competition_ballots b on b.id = m.ballot_id
             where b.round_id = pg_temp.id('src', p_n) and m.entry_id = e and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)) tally
    from unnest(public._compe2_round_entries(pg_temp.id('src', p_n))) e where e <> all (public._compf2_no_show_entries(pg_temp.id('src', p_n)))
  ), r as (
    select t.*, 1 + (select count(*) from t t2 where t2.tally > t.tally) callback_rank, (select count(*) from t t2 where t2.tally >= t.tally) ge from t
  ), s as (
    select r.*, case when ge <= p_t then 'above_cut' when callback_rank <= p_t then 'tied_at_cut' else 'below_cut' end tie_status from r
  ), u as (select bool_or(tie_status = 'tied_at_cut' and ge > p_cap) as unresolved from s)
  select jsonb_agg(jsonb_build_object('entry_id', s.entry_id, 'placement', null, 'advanced',
           case when u.unresolved then null else (s.tie_status in ('above_cut', 'tied_at_cut')) end,
           'tie_group', case when s.tie_status = 'tied_at_cut' then 'cut' end,
           'output', jsonb_build_object('tally', s.tally, 'callback_rank', s.callback_rank, 'tie_status', s.tie_status)) order by s.callback_rank, s.entry_id)
  from s cross join u
$$;
create or replace function pg_temp.th() returns text language sql immutable as $$ select encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex') $$;
create or replace function pg_temp.vid(p_n int, p_version int) returns uuid language sql stable security definer as $$
  select id from public.event_competition_result_versions where round_id = pg_temp.id('src', p_n) and version = p_version
$$;
create or replace function pg_temp.rstatus(p_n int) returns text language sql stable security definer as $$ select status from public.event_competition_rounds where id = pg_temp.id('src', p_n) $$;
create or replace function pg_temp.vstatus(p_n int, p_version int) returns text language sql stable security definer as $$
  select status from public.event_competition_result_versions where round_id = pg_temp.id('src', p_n) and version = p_version
$$;
-- Lock the round's ballots as manager 1 (flushes the deferred ballot backstops first: one transaction).
create or replace function pg_temp.lockit(p_n int) returns jsonb language plpgsql as $$
begin
  execute 'set constraints all immediate';
  execute 'set constraints all deferred';
  return pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.lock_competition_round_ballots(%L, gen_random_uuid())$q$, pg_temp.id('src', p_n)));
end $$;
-- The calculate call as SQL text (the database input hash and the F1 engine rows for the current ballots), so another session can run it.
create or replace function pg_temp.calc_sql(p_n int, p_cap int, p_req uuid default gen_random_uuid()) returns text language plpgsql as $$
declare
  v_in jsonb;
begin
  execute 'set constraints all immediate';
  execute 'set constraints all deferred';
  v_in := pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_calculation_input(%L)$q$, pg_temp.id('src', p_n)));
  return format($q$select public.calculate_competition_round(%L, %L, %L, %L, %L, '[{"step":1}]'::jsonb, %L::jsonb, '[]'::jsonb, %L)$q$,
    pg_temp.id('src', p_n), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash', pg_temp.th(), pg_temp.rows_for(p_n, p_cap)::text, p_req);
end $$;
-- Calculate exactly as the app would, as manager 1.
create or replace function pg_temp.calc(p_n int, p_cap int, p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', 1), pg_temp.calc_sql(p_n, p_cap, p_req));
end $$;
create or replace function pg_temp.approve(p_n int, p_version int, p_user int default 2) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.approve_competition_round_result(%L, %L, null, gen_random_uuid())$q$, pg_temp.id('src', p_n), pg_temp.vid(p_n, p_version)));
end $$;
create or replace function pg_temp.apply_adv(p_n int, p_version int, p_req uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.apply_competition_round_advancement(%L, %L, %L)$q$, pg_temp.id('src', p_n), pg_temp.vid(p_n, p_version), p_req));
end $$;
create or replace function pg_temp.preview(p_n int) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.competition_round_advancement_preview(%L)$q$, pg_temp.id('src', p_n)));
end $$;
-- A snapshot of everything an advancement could write or a refused call could disturb for scenario n.
create or replace function pg_temp.snap(p_n int) returns text language sql stable security definer as $$
  select jsonb_build_object(
    'round', (select status from public.event_competition_rounds where id = pg_temp.id('src', p_n)),
    'final', (select status from public.event_competition_rounds where id = pg_temp.id('fin', p_n)),
    'cap', (select configuration from public.event_competition_rounds where id = pg_temp.id('fin', p_n)),
    'versions', (select coalesce(jsonb_agg(jsonb_build_array(version, status) order by version), '[]') from public.event_competition_result_versions where round_id = pg_temp.id('src', p_n)),
    'rows', (select count(*) from public.event_competition_result_rows rr join public.event_competition_result_versions v on v.id = rr.result_version_id where v.round_id = pg_temp.id('src', p_n)),
    'events', (select count(*) from public.event_competition_result_events where round_id = pg_temp.id('src', p_n)),
    'approvals', (select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = pg_temp.id('src', p_n)),
    'adv', (select count(*) from public.event_competition_round_advancements where source_round_id = pg_temp.id('src', p_n) or target_round_id = pg_temp.id('fin', p_n)),
    'adv_entries', (select count(*) from public.event_competition_round_advancement_entries ae join public.event_competition_round_advancements a on a.id = ae.advancement_id where a.source_round_id = pg_temp.id('src', p_n)),
    'adv_heats', (select count(*) from public.event_competition_round_advancement_heats l join public.event_competition_round_advancements a on a.id = l.advancement_id where a.source_round_id = pg_temp.id('src', p_n)),
    'revocations', (select count(*) from public.event_competition_round_advancement_revocations r join public.event_competition_round_advancements a on a.id = r.advancement_id where a.source_round_id = pg_temp.id('src', p_n)),
    'final_heats', (select count(*) from public.event_competition_heats where round_id = pg_temp.id('fin', p_n)),
    'final_heat_entries', (select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', p_n)),
    'new_floor_heats', (select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('sv', 1) and heat_number > 20),
    'capacity_events', (select count(*) from public.event_competition_round_capacity_events where round_id = pg_temp.id('fin', p_n))
  )::text
$$;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.catch(p_sql text) returns text language plpgsql as $c$
begin
  begin execute p_sql; exception when others then return sqlstate || ' ' || sqlerrm; end;
  return 'OK';
end $c$;
create or replace function pg_temp.legacy_cap(p_n int, p_cap int) returns void language plpgsql security definer as $$
begin
  alter table public.event_competition_rounds disable trigger cf1_guard_round_capacity;
  alter table public.event_competition_rounds disable trigger cf1_guard_callback_target_capacity;
  update public.event_competition_rounds set configuration = jsonb_build_object('max_entries_per_heat', p_cap) where id = pg_temp.id('fin', p_n);
  alter table public.event_competition_rounds enable always trigger cf1_guard_round_capacity;
  alter table public.event_competition_rounds enable always trigger cf1_guard_callback_target_capacity;
end $$;
-- @@SHARED-END

-- ============================================================================
-- 1. Setup: S1 = blocked tie (Final capacity 3, T 3), through the real lifecycle: capacity RPC -> ballots -> lock -> calculate
-- ============================================================================
select pg_temp.mk(1);
create temp table t_cap1 on commit drop as select pg_temp.set_cap(1, 3) as r;
select pg_temp.chk('S1 setup: capacity 3 set through the reasoned RPC before any ballot', (select pg_temp.code(r) = 'OK' from t_cap1)
  and (select configuration ->> 'max_entries_per_heat' = '3' from public.event_competition_rounds where id = pg_temp.id('fin', 1)));
select pg_temp.vtie(1);
create temp table t_lock1 on commit drop as select pg_temp.lockit(1) as r;
select pg_temp.chk('S1 setup: the three judge ballots are filed and the round locks', (select pg_temp.code(r) = 'OK' from t_lock1) and pg_temp.rstatus(1) = 'ballots_locked', (select r::text from t_lock1));
create temp table t_calc1 on commit drop as select pg_temp.calc(1, 3) as r;
create temp table t_s1_pre on commit drop as select pg_temp.snap(1) as s;
grant all on t_s1_pre, t_calc1 to authenticated, anon, service_role;

-- ============================================================================
-- 2. (a) calculate completes and stores the blocked version; evidence preserved; no advancement authorization
-- ============================================================================
select pg_temp.chk('11.4b(a) calculate completes (does not fail) for an over-capacity tie: version 1, status calculated, round calculated',
  (select r ->> 'status' = 'calculated' and (r ->> 'version')::int = 1 and r ->> 'replayed' = 'false' from t_calc1) and pg_temp.rstatus(1) = 'calculated' and pg_temp.vstatus(1, 1) = 'calculated',
  (select r::text from t_calc1));
select pg_temp.chk('11.4b(a) every stored row has advanced = NULL (8 rows; none true, none false)',
  (select count(*) = 8 and count(*) filter (where rr.advanced is null) = 8 from public.event_competition_result_rows rr where rr.result_version_id = pg_temp.vid(1, 1)));
select pg_temp.chk('11.4b(a) per-row output keeps tally, callback_rank and tie_status: e1 above_cut (3, rank 1); e2-e4 tied_at_cut (2, rank 2); e5-e8 below_cut (0, rank 5)',
  (select bool_and(case when rr.entry_id = pg_temp.id('ent', 1, 1) then rr.output = '{"tally":3,"callback_rank":1,"tie_status":"above_cut"}'::jsonb
                        when rr.entry_id in (pg_temp.id('ent', 1, 2), pg_temp.id('ent', 1, 3), pg_temp.id('ent', 1, 4)) then rr.output = '{"tally":2,"callback_rank":2,"tie_status":"tied_at_cut"}'::jsonb
                        else rr.output = '{"tally":0,"callback_rank":5,"tie_status":"below_cut"}'::jsonb end)
   from public.event_competition_result_rows rr where rr.result_version_id = pg_temp.vid(1, 1)));
select pg_temp.chk('11.4b(a) the tied couples share the tie_group marker and no placement is invented (placement null on every row)',
  (select count(*) filter (where tie_group = 'cut') = 3 and count(*) filter (where placement is not null) = 0 from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 1)));
select pg_temp.chk('11.4b(a) the evidence is intact: input hash equals the live hash of the locked ballots, trace stored with its canonical hash, input holds the ballots, a result_calculated event exists',
  (select v.input_hash = public._compf2_input_hash(pg_temp.id('src', 1), v.engine_key, v.engine_version) and v.trace = '[{"step":1}]'::jsonb and v.trace_hash = pg_temp.th()
          and v.engine_key like '%callback_tally%' and jsonb_typeof(v.input) = 'object' and v.input <> '{}'::jsonb and v.calculated_by = pg_temp.id('user', 1)
   from public.event_competition_result_versions v where v.id = pg_temp.vid(1, 1))
  and (select count(*) = 1 from public.event_competition_result_events where result_version_id = pg_temp.vid(1, 1) and kind = 'result_calculated'));
select pg_temp.chk('11.4b(a) no advancement authorization exists: no round_advancement row, no list entry, no heat link, no revocation, no Final heat, no new floor heat, no approval',
  (select (s::jsonb ->> 'adv')::int = 0 and (s::jsonb ->> 'adv_entries')::int = 0 and (s::jsonb ->> 'adv_heats')::int = 0 and (s::jsonb ->> 'revocations')::int = 0
          and (s::jsonb ->> 'final_heats')::int = 0 and (s::jsonb ->> 'final_heat_entries')::int = 0 and (s::jsonb ->> 'approvals')::int = 0
          and (s::jsonb ->> 'new_floor_heats')::int = 0 from (select pg_temp.snap(1) s) x));
select pg_temp.chk('11.4b(a) the Final is untouched (still scheduled) and the callback round is only calculated, not approved',
  (select status = 'scheduled' from public.event_competition_rounds where id = pg_temp.id('fin', 1)) and pg_temp.rstatus(1) = 'calculated');
-- A tie that fits the Final's capacity resolves normally (control: the blocking is specific to an over-capacity tie).
select pg_temp.mk(3, 8);
select pg_temp.set_cap(3, 8);
select pg_temp.vtie(3);
select pg_temp.lockit(3);
select pg_temp.calc(3, 8);
select pg_temp.chk('control: the same ballots with the Final capacity 8 (the 4 tied-or-above couples fit) store decided rows (no NULL)',
  (select count(*) = 8 and count(*) filter (where advanced is null) = 0 and count(*) filter (where advanced) = 4 from public.event_competition_result_rows where result_version_id = pg_temp.vid(3, 1)));

-- ============================================================================
-- 3. (b) approve refused COMP_ADVANCEMENT_BLOCKED; version / round / audit unchanged
-- ============================================================================
create temp table t_ap1 on commit drop as select pg_temp.approve(1, 1, 2) as r;
create temp table t_ap1b on commit drop as select pg_temp.approve(1, 1, 1) as r;
grant all on t_ap1, t_ap1b to authenticated, anon, service_role;
select pg_temp.chk('11.4b(b) a second manager approving the blocked version is refused COMP_ADVANCEMENT_BLOCKED (P0001)',
  (select r ->> 'error' like 'COMP_ADVANCEMENT_BLOCKED%' and r ->> 'state' = 'P0001' from t_ap1), (select r::text from t_ap1));
select pg_temp.chk('11.4b(b) the calculator approving with an override reason is refused too (the guard sits below the override path)',
  (select r ->> 'error' like 'COMP_SECOND_APPROVER_REQUIRED%' or r ->> 'error' like 'COMP_ADVANCEMENT_BLOCKED%' from t_ap1b)
  and pg_temp.code(pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.approve_competition_round_result(%L, %L, 'override: approve the tie anyway', gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.vid(1, 1)))) = 'COMP_ADVANCEMENT_BLOCKED');
select pg_temp.chk('11.4b(b) nothing changed: version still calculated, round still calculated, no approval row, event / row counts and capacity unchanged (audit unchanged)',
  pg_temp.vstatus(1, 1) = 'calculated' and pg_temp.rstatus(1) = 'calculated' and pg_temp.snap(1) = (select s from t_s1_pre),
  pg_temp.snap(1) || ' vs ' || (select s from t_s1_pre));
select pg_temp.expect_msg('11.4b(b) a direct UPDATE of the version status to approved is refused COMP_ADVANCEMENT_BLOCKED even for a superuser (trigger is ENABLE ALWAYS)',
  format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(1, 1)), 'COMP_ADVANCEMENT_BLOCKED', 'P0001');
select pg_temp.expect_msg('11.4b(b) ... and with session_replication_role = replica (the CF1 approval guard fires regardless)',
  format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(1, 1))), 'COMP_ADVANCEMENT_BLOCKED', 'P0001');
select pg_temp.chk('11.4b(b) after the direct attempts the version is still calculated and no approval event exists',
  pg_temp.vstatus(1, 1) = 'calculated' and pg_temp.n(format($q$select count(*) from public.event_competition_result_events where round_id = %L and kind in ('result_approved', 'result_approval_override')$q$, pg_temp.id('src', 1))) = 0);

-- ============================================================================
-- 4. (c) preview
-- ============================================================================
create temp table t_pv1 on commit drop as select pg_temp.preview(1) as r;
grant all on t_pv1 to authenticated, anon, service_role;
select pg_temp.chk('11.4b(c) preview of the calculated blocked-tie round is state blocked, never ready, and lists no advanced entries',
  (select r ->> 'state' = 'blocked' and jsonb_array_length(r -> 'blockers') >= 1 and r -> 'advanced_entries' = '[]'::jsonb from t_pv1), (select r::text from t_pv1));
-- Owner tie policy: advancement stays UNRESOLVED and the preview names the tie. The preview evaluates the round's newest version whatever its status.
select pg_temp.chk('11.4b(c) actual blocker codes for the calculated blocked version: the two SOURCE_STATE arms (round not approved, no approved version) plus COMP_ADVANCEMENT_BLOCKED',
  (select count(*) filter (where b ->> 'code' = 'COMP_ADVANCEMENT_SOURCE_STATE') = 2 and count(*) filter (where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED') = 1
          and bool_and(b ->> 'code' in ('COMP_ADVANCEMENT_SOURCE_STATE', 'COMP_ADVANCEMENT_BLOCKED')) from t_pv1, jsonb_array_elements(r -> 'blockers') b), (select (r -> 'blockers')::text from t_pv1));
select pg_temp.chk('11.4b(c) preview of a calculated blocked-tie version carries COMP_ADVANCEMENT_BLOCKED with detail.reason = tie_over_capacity, the version number and its status (calculated)',
  (select exists (select 1 from jsonb_array_elements(r -> 'blockers') b
                  where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED' and b #>> '{detail,reason}' = 'tie_over_capacity'
                    and (b #>> '{detail,version}')::int = 1 and b #>> '{detail,version_status}' = 'calculated') from t_pv1), (select (r -> 'blockers')::text from t_pv1));
select pg_temp.chk('11.4b(c) the tie preview is read-only and keeps its other keys (state blocked, no advanced entries, no result_version_id)',
  (select r ->> 'state' = 'blocked' and r -> 'advanced_entries' = '[]'::jsonb and r -> 'result_version_id' = 'null'::jsonb from t_pv1));
-- The defensive arm: an APPROVED version that holds NULL rows. The lifecycle cannot produce one (the approval trigger refuses it, section 3); a hand-edited
-- or pre-guard database could. Built as a replica fixture (as the A0 suite's scenario 13) so the preview and apply BLOCKED arms are exercised.
select pg_temp.mk(4, 3);
select pg_temp.su(format($q$update public.event_competition_rounds set status = 'approved' where id = %L$q$, pg_temp.id('src', 4)));
select pg_temp.su(format($q$insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (%L, %L, %L, 1, 'callback_tally', '1', public._compf2_input_hash(%L, 'callback_tally', '1'), repeat('a', 64), '{}', '[]', %L, 'approved', %L)$q$,
  pg_temp.id('rv', 4), pg_temp.id('evt', 1), pg_temp.id('src', 4), pg_temp.id('src', 4), pg_temp.id('user', 1), pg_temp.id('req-rv', 4)));
select pg_temp.su(format($q$insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
  select %L, %L, pg_temp.id('ent', 4, k), null, jsonb_build_object('tally', 0, 'callback_rank', 1, 'tie_status', 'tied_at_cut') from generate_series(1, 8) k$q$, pg_temp.id('evt', 1), pg_temp.id('rv', 4)));
create temp table t_s4_pre on commit drop as select pg_temp.snap(4) as s;
create temp table t_pv4 on commit drop as select pg_temp.preview(4) as r;
create temp table t_apv4 on commit drop as select pg_temp.apply_adv(4, 1) as r;
grant all on t_s4_pre, t_pv4, t_apv4 to authenticated, anon, service_role;
select pg_temp.chk('11.4b(c) defensive arm: preview of an approved version with NULL rows is state blocked and names COMP_ADVANCEMENT_BLOCKED',
  (select r ->> 'state' = 'blocked' and (select count(*) = 1 from jsonb_array_elements(r -> 'blockers') b where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED' and b -> 'detail' is null) and r -> 'advanced_entries' = '[]'::jsonb from t_pv4), (select r::text from t_pv4));
select pg_temp.chk('11.4b(d) defensive arm: apply of an approved version with NULL rows is refused COMP_ADVANCEMENT_BLOCKED and nothing is written',
  (select r ->> 'error' like 'COMP_ADVANCEMENT_BLOCKED%' from t_apv4) and pg_temp.snap(4) = (select s from t_s4_pre), (select r::text from t_apv4));

-- ============================================================================
-- 5. (d) apply refused on the real blocked version, nothing written
-- ============================================================================
create temp table t_apv1 on commit drop as select pg_temp.apply_adv(1, 1) as r;
create temp table t_apv1b on commit drop as select pg_temp.run_as(pg_temp.id('user', 1), format($q$select public.apply_competition_round_advancement(%L, %L, gen_random_uuid())$q$, pg_temp.id('src', 1), gen_random_uuid())) as r;
grant all on t_apv1, t_apv1b to authenticated, anon, service_role;
select pg_temp.chk('11.4b(d) apply of the calculated blocked version is refused (round is calculated, not approved: COMP_ADVANCEMENT_SOURCE_STATE) - never succeeds',
  (select r ->> 'error' like 'COMP_ADVANCEMENT_SOURCE_STATE%' and r ->> 'state' = 'P0001' from t_apv1), (select r::text from t_apv1));
select pg_temp.chk('11.4b(d) apply with an unknown version id is refused as well', (select r ->> 'error' is not null from t_apv1b), (select r::text from t_apv1b));
select pg_temp.chk('11.4b(d) nothing was written: no advancement / list entry / heat link, no Final heat or heat entry, no new floor heat, no approval, versions and rows unchanged',
  pg_temp.snap(1) = (select s from t_s1_pre), pg_temp.snap(1));
select pg_temp.chk('11.4b(d) a refused apply leaves no advancement for its request id', not exists (select 1 from public.event_competition_round_advancements where source_round_id = pg_temp.id('src', 1)));

-- ============================================================================
-- 6. (e) no override path: grants, history guards, writers
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.id('user', 1));
select pg_temp.expect_msg('11.4b(e) a manager (authenticated) cannot UPDATE a stored result row (permission denied)',
  format($q$update public.event_competition_result_rows set advanced = true where result_version_id = %L$q$, pg_temp.vid(1, 1)), 'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) a manager cannot UPDATE the version (permission denied)',
  format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(1, 1)), 'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) a manager cannot INSERT an advancement row directly (permission denied)',
  format($q$insert into public.event_competition_round_advancements (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id, source_input_hash, source_trace_hash, advanced_count, target_capacity, applied_by, request_id)
    values (%L, %L, %L, %L, %L, 1, %L, 'x', 'y', 3, 3, %L, gen_random_uuid())$q$, pg_temp.id('evt', 1), pg_temp.id('prg', 1), pg_temp.id('div', 1), pg_temp.id('src', 1), pg_temp.id('fin', 1), pg_temp.vid(1, 1), pg_temp.id('user', 1)),
  'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) a manager cannot INSERT a result row for the blocked version (permission denied)',
  format($q$insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced) values (%L, %L, %L, true)$q$, pg_temp.id('evt', 1), pg_temp.vid(1, 1), pg_temp.id('ent', 1, 1)), 'permission denied', '42501');
select pg_temp.as_user(pg_temp.id('user', 4));
select pg_temp.expect_msg('11.4b(e) the chair (a non-manager official) cannot approve the blocked version (COMP_FORBIDDEN)',
  format($q$select public.approve_competition_round_result(%L, %L, 'chair override', gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.vid(1, 1)), 'COMP_FORBIDDEN', '42501');
select pg_temp.expect_msg('11.4b(e) the chair cannot apply it (COMP_FORBIDDEN)',
  format($q$select public.apply_competition_round_advancement(%L, %L, gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.vid(1, 1)), 'COMP_FORBIDDEN', '42501');
select pg_temp.as_user(pg_temp.id('user', 11));
select pg_temp.expect_msg('11.4b(e) a judge cannot apply it (COMP_FORBIDDEN)',
  format($q$select public.apply_competition_round_advancement(%L, %L, gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.vid(1, 1)), 'COMP_FORBIDDEN', '42501');
reset role;
set role service_role;
select pg_temp.expect_msg('11.4b(e) service_role cannot UPDATE a stored result row (permission denied)',
  format($q$update public.event_competition_result_rows set advanced = true where result_version_id = %L$q$, pg_temp.vid(1, 1)), 'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) service_role cannot UPDATE the version (permission denied)',
  format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.vid(1, 1)), 'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) service_role cannot INSERT an advancement row (permission denied)',
  format($q$insert into public.event_competition_round_advancements (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id, source_input_hash, source_trace_hash, advanced_count, target_capacity, applied_by, request_id)
    values (%L, %L, %L, %L, %L, 1, %L, 'x', 'y', 3, 3, %L, gen_random_uuid())$q$, pg_temp.id('evt', 1), pg_temp.id('prg', 1), pg_temp.id('div', 1), pg_temp.id('src', 1), pg_temp.id('fin', 1), pg_temp.vid(1, 1), pg_temp.id('user', 1)),
  'permission denied', '42501');
select pg_temp.expect_msg('11.4b(e) service_role cannot execute the apply RPC (permission denied)',
  format($q$select public.apply_competition_round_advancement(%L, %L, gen_random_uuid())$q$, pg_temp.id('src', 1), pg_temp.vid(1, 1)), 'permission denied', '42501');
reset role;
set role anon;
select pg_temp.expect_msg('11.4b(e) anon cannot UPDATE a stored result row (permission denied)',
  format($q$update public.event_competition_result_rows set advanced = true where result_version_id = %L$q$, pg_temp.vid(1, 1)), 'permission denied', '42501');
reset role;
-- Superuser (no role): the history guards still hold in the normal session mode.
select pg_temp.expect_msg('11.4b(e) even a superuser cannot UPDATE a stored result row (append-only evidence)',
  format($q$update public.event_competition_result_rows set advanced = true where result_version_id = %L$q$, pg_temp.vid(1, 1)), 'append-only evidence', '42501');
select pg_temp.expect_msg('11.4b(e) a superuser cannot DELETE a stored result row',
  format($q$delete from public.event_competition_result_rows where result_version_id = %L$q$, pg_temp.vid(1, 1)), 'append-only evidence', '42501');
select pg_temp.expect_msg('11.4b(e) a superuser cannot DELETE the blocked version',
  format($q$delete from public.event_competition_result_versions where id = %L$q$, pg_temp.vid(1, 1)), 'append-only evidence', '42501');
select pg_temp.expect_msg('11.4b(e) a superuser cannot TRUNCATE the result rows', 'truncate public.event_competition_result_rows', 'append-only evidence');
select pg_temp.expect_msg('11.4b(e) a superuser cannot rewrite the version content (only status moves)',
  format($q$update public.event_competition_result_versions set trace = '[]'::jsonb where id = %L$q$, pg_temp.vid(1, 1)), 'COMPF2_VERSION_IMMUTABLE', '42501');
select pg_temp.expect_msg('11.4b(e) a status move of the blocked version to superseded outside calculate is refused (writer guard)',
  format($q$update public.event_competition_result_versions set status = 'superseded' where id = %L$q$, pg_temp.vid(1, 1)), 'COMPF2_VERSION_WRITER', '42501');
select pg_temp.chk('11.4b(e) the approve / apply RPCs have no override or tie-breaker parameter that could set advanced (signatures), and no tie-break function exists',
  (select array_to_string(proargnames, ',') = 'p_round_id,p_result_version_id,p_request_id' from pg_proc where oid = 'public.apply_competition_round_advancement(uuid,uuid,uuid)'::regprocedure)
  and (select array_to_string(proargnames, ',') = 'p_round_id,p_result_version_id,p_override_reason,p_request_id' from pg_proc where oid = 'public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure)
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname ilike '%tie%break%' or p.proname ilike '%resolve_tie%' or p.proname ilike '%force_advance%' or p.proname ilike '%override_advance%')));
select pg_temp.chk('11.4b(e) after every attempt the blocked version, its rows, the round and the audit are unchanged',
  pg_temp.snap(1) = (select s from t_s1_pre) and (select count(*) = 8 and count(*) filter (where advanced is null) = 8 from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 1)), pg_temp.snap(1));
-- The callback target is configuration frozen once the round has started: it cannot be edited to make the tie "fit" or to push the tie below the cut-off.
select pg_temp.expect_msg('11.4b(e) lowering the callback target (3 -> 2) on the calculated blocked round is refused COMP_ROUND_CONFIG_FROZEN',
  format($q$update public.event_competition_rounds set target_advancement_count = 2 where id = %L$q$, pg_temp.id('src', 1)), 'COMP_ROUND_CONFIG_FROZEN');
select pg_temp.expect_msg('11.4b(e) raising the callback target (3 -> 4) is refused too (over the Final capacity, and frozen)',
  format($q$update public.event_competition_rounds set target_advancement_count = 4 where id = %L$q$, pg_temp.id('src', 1)), 'COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY');
select pg_temp.expect_msg('11.4b(e) the scoring method of the blocked round cannot be changed either',
  format($q$update public.event_competition_rounds set scoring_method = 'ordinal_majority' where id = %L$q$, pg_temp.id('src', 1)), 'COMP_ROUND_CONFIG_FROZEN');
select pg_temp.chk('11.4b(e) the refused target / method edits changed nothing: the version still matches its input hash and is calculated, rows NULL, no advancement',
  (select v.status = 'calculated' and v.input_hash = public._compf2_input_hash(pg_temp.id('src', 1), v.engine_key, v.engine_version) from public.event_competition_result_versions v where v.id = pg_temp.vid(1, 1))
  and pg_temp.snap(1) = (select s from t_s1_pre));

-- ============================================================================
-- 7. (f) capacity
-- ============================================================================
create temp table t_cap_a on commit drop as select pg_temp.set_cap(1, 8) as r;   -- raise to a value that fits the tie (8 >= the 4 tied-or-above couples)
create temp table t_cap_b on commit drop as select pg_temp.set_cap(1, 4) as r;   -- raise to exactly the tied count
create temp table t_cap_c on commit drop as select pg_temp.set_cap(1, 2) as r;   -- lowering
grant all on t_cap_a, t_cap_b, t_cap_c to authenticated, anon, service_role;
select pg_temp.chk('11.4b-cap raise to 8 (would fit the whole tie) is refused COMP_CAPACITY_CALLBACK_FROZEN (B5)', (select r ->> 'error' like 'COMP_CAPACITY_CALLBACK_FROZEN%' and r ->> 'state' = 'P0001' from t_cap_a), (select r::text from t_cap_a));
select pg_temp.chk('11.4b-cap raise to 4 (exactly the tied-or-above count) is refused COMP_CAPACITY_CALLBACK_FROZEN', (select r ->> 'error' like 'COMP_CAPACITY_CALLBACK_FROZEN%' from t_cap_b), (select r::text from t_cap_b));
select pg_temp.chk('11.4b-cap lowering to 2 is refused COMP_CAPACITY_CALLBACK_FROZEN', (select r ->> 'error' like 'COMP_CAPACITY_CALLBACK_FROZEN%' from t_cap_c), (select r::text from t_cap_c));
select pg_temp.chk('11.4b-cap nothing changed: capacity still 3, no capacity event added, version / rows / round / audit unchanged', pg_temp.snap(1) = (select s from t_s1_pre), pg_temp.snap(1));
select pg_temp.expect_msg('11.4b-cap a direct write of max_entries_per_heat is refused too (even for a superuser)',
  format($q$update public.event_competition_rounds set configuration = '{"max_entries_per_heat": 8}' where id = %L$q$, pg_temp.id('fin', 1)), 'COMP_CAPACITY_DIRECT_WRITE', 'P0001');

-- F1: a legacy Final whose capacity (2) is below T (3). F1 normally lets a manager raise it to exactly T before the callback is approved; with a blocked-tie
-- version present that raise is refused (it would be a way to dissolve the tie without a corrected ballot). The legacy shape is fixtured by lifting the
-- capacity guard for the one fixture UPDATE only (re-enabled ALWAYS immediately).
select pg_temp.mk(5, 3);
select pg_temp.legacy_cap(5, 2);
select pg_temp.chk('F1 setup: Final 5 has the legacy capacity 2 (< T 3)', (select configuration ->> 'max_entries_per_heat' = '2' from public.event_competition_rounds where id = pg_temp.id('fin', 5))
  and (select enabled from (select tgenabled = 'A' as enabled from pg_trigger where tgname = 'cf1_guard_round_capacity') x));
select pg_temp.vtie(5);
select pg_temp.lockit(5);
select pg_temp.calc(5, 2);
select pg_temp.chk('F1 setup: scenario 5 is a calculated blocked tie (rows NULL)', pg_temp.rstatus(5) = 'calculated'
  and (select count(*) = 8 and count(*) filter (where advanced is null) = 8 from public.event_competition_result_rows where result_version_id = pg_temp.vid(5, 1)));
create temp table t_s5_pre on commit drop as select pg_temp.snap(5) as s;
create temp table t_f1a on commit drop as select pg_temp.set_cap(5, 3) as r;   -- the F1 raise to exactly T
create temp table t_f1b on commit drop as select pg_temp.set_cap(5, 8) as r;
create temp table t_f1c on commit drop as select pg_temp.set_cap(5, 1) as r;
grant all on t_s5_pre, t_f1a, t_f1b, t_f1c to authenticated, anon, service_role;
select pg_temp.chk('11.4b-cap F1 raise to exactly T (3) with a blocked-tie version is refused COMP_CAPACITY_F1_BLOCKED_TIE', (select r ->> 'error' like 'COMP_CAPACITY_F1_BLOCKED_TIE%' and r ->> 'state' = 'P0001' from t_f1a), (select r::text from t_f1a));
select pg_temp.chk('11.4b-cap F1 raise to a value other than T (8) is refused COMP_CAPACITY_F1_NOT_EXACT_T', (select r ->> 'error' like 'COMP_CAPACITY_F1_NOT_EXACT_T%' from t_f1b), (select r::text from t_f1b));
select pg_temp.chk('11.4b-cap F1 lowering (1) is refused COMP_CAPACITY_F1_NOT_EXACT_T', (select r ->> 'error' like 'COMP_CAPACITY_F1_NOT_EXACT_T%' from t_f1c), (select r::text from t_f1c));
select pg_temp.chk('11.4b-cap nothing changed after the F1 attempts (capacity 2, no capacity event, evidence unchanged)', pg_temp.snap(5) = (select s from t_s5_pre)
  and (select configuration ->> 'max_entries_per_heat' = '2' from public.event_competition_rounds where id = pg_temp.id('fin', 5)), pg_temp.snap(5));
-- Control: the same legacy capacity with a NON-tie calculated version: the F1 raise to exactly T is allowed (so the refusal above is tie-specific).
select pg_temp.mk(6, 3);
select pg_temp.legacy_cap(6, 2);
select pg_temp.vclean(6);
select pg_temp.lockit(6);
select pg_temp.calc(6, 2);
select pg_temp.chk('F1 control setup: scenario 6 is calculated and fully decided (no NULL row)', pg_temp.rstatus(6) = 'calculated'
  and (select count(*) = 8 and count(*) filter (where advanced is null) = 0 from public.event_competition_result_rows where result_version_id = pg_temp.vid(6, 1)));
create temp table t_f1d on commit drop as select pg_temp.set_cap(6, 3) as r;
grant all on t_f1d to authenticated, anon, service_role;
select pg_temp.chk('F1 control: without a tie the raise to exactly T is accepted and audited as f1_raise_to_t', (select r ->> 'error' is null and r ->> 'exemption' = 'f1_raise_to_t' from t_f1d), (select r::text from t_f1d));

-- ============================================================================
-- 8. (g)(h) the supported resolution route: a corrected judge ballot through the A7 correction path (needs the A7 co-sign)
-- ============================================================================
select to_regprocedure('public.cosign_competition_correction(uuid,uuid)') is not null as has_a7 \gset
\if :has_a7
create or replace function pg_temp.open_corr(p_n int, p_user int default 1, p_req int default 1) returns jsonb language plpgsql as $$
begin
  execute 'set constraints all immediate';
  execute 'set constraints all deferred';
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.open_competition_round_correction(%L, 'judge entry error found after the callback was calculated', %L)$q$,
                        pg_temp.id('src', p_n), pg_temp.id('creq', p_n, p_req)));
end $$;
create or replace function pg_temp.cause(p_n int) returns public.event_competition_correction_causes language sql stable security definer as $$
  select c from public.event_competition_correction_causes c where c.round_id = pg_temp.id('src', p_n) order by c.seq desc limit 1
$$;
create or replace function pg_temp.cosign(p_n int, p_user int default 2) returns jsonb language plpgsql as $$
begin
  return pg_temp.run_as(pg_temp.id('user', p_user), format($q$select public.cosign_competition_correction(%L, gen_random_uuid())$q$, (pg_temp.cause(p_n)).id));
end $$;
grant execute on function pg_temp.open_corr(int, int, int), pg_temp.cause(int), pg_temp.cosign(int, int) to authenticated, anon, service_role;

-- ---- S1 (blocked v1; capacity 3): open the correction, co-sign, corrected ballot dissolves the tie
create temp table t_ev1_pre on commit drop as
  select (select jsonb_agg(jsonb_build_array(entry_id, advanced, output) order by entry_id) from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 1)) as rows_json,
         (select input::text || trace::text || input_hash || trace_hash from public.event_competition_result_versions where id = pg_temp.vid(1, 1)) as evidence;
grant all on t_ev1_pre to authenticated, anon, service_role;
create temp table t_oc1 on commit drop as select pg_temp.open_corr(1) as r;
grant all on t_oc1 to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) a manager opens the correction on the blocked round: round -> ballots_locked, correction_open',
  (select r ->> 'error' is null and r ->> 'status' = 'ballots_locked' from t_oc1) and (select status = 'ballots_locked' and correction_open from public.event_competition_rounds where id = pg_temp.id('src', 1)), (select r::text from t_oc1));
select pg_temp.chk('11.4b(g) the cause is judge_entry_error (no exclusion), recorded with opener and reason; no co-sign yet',
  (select c.cause = 'judge_entry_error' and c.opened_by = pg_temp.id('user', 1) and c.reason like 'judge entry error%' from (select (pg_temp.cause(1)).*) c)
  and not exists (select 1 from public.event_competition_correction_cosigns s where s.cause_id = (pg_temp.cause(1)).id));
select pg_temp.chk('11.4b(h) the stale blocked version is marked stale with a result_invalidated audit event; it is not deleted',
  pg_temp.vstatus(1, 1) = 'stale'
  and (select count(*) = 1 from public.event_competition_result_events where result_version_id = pg_temp.vid(1, 1) and kind = 'result_invalidated' and to_state = 'stale'));
select pg_temp.chk('11.4b(h) the tie evidence is preserved byte-for-byte after the correction opens: all 8 rows still NULL with tally / callback_rank / tie_status, input, trace and hashes unchanged',
  (select jsonb_agg(jsonb_build_array(entry_id, advanced, output) order by entry_id) = (select rows_json from t_ev1_pre) from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 1))
  and (select input::text || trace::text || input_hash || trace_hash = (select evidence from t_ev1_pre) from public.event_competition_result_versions where id = pg_temp.vid(1, 1)));
select pg_temp.chk('11.4b(h) opening a correction on a blocked round creates no advancement and no revocation (there was nothing to revoke)',
  (select (s::jsonb ->> 'adv')::int = 0 and (s::jsonb ->> 'revocations')::int = 0 and (s::jsonb ->> 'final_heats')::int = 0 from (select pg_temp.snap(1) s) x));
create temp table t_pv1c on commit drop as select pg_temp.preview(1) as r;
create temp table t_ap1c on commit drop as select pg_temp.approve(1, 1, 2) as r;
create temp table t_apv1c on commit drop as select pg_temp.apply_adv(1, 1) as r;
grant all on t_pv1c, t_ap1c, t_apv1c to authenticated, anon, service_role;
select pg_temp.chk('11.4b(h) the stale blocked version cannot be approved or applied during the correction (nothing advances)',
  (select r ->> 'error' is not null from t_ap1c) and (select r ->> 'error' is not null from t_apv1c) and (select r ->> 'state' = 'blocked' from t_pv1c));
select pg_temp.chk('11.4b(c) preview while the blocked version is stale (correction open): still names the tie, version 1, version_status stale',
  (select exists (select 1 from jsonb_array_elements(r -> 'blockers') b
                  where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED' and b #>> '{detail,reason}' = 'tie_over_capacity'
                    and (b #>> '{detail,version}')::int = 1 and b #>> '{detail,version_status}' = 'stale') from t_pv1c), (select (r -> 'blockers')::text from t_pv1c));
select pg_temp.chk('11.4b(g) a replacement ballot is refused before the co-sign (COMP_CORRECTION_COSIGN_REQUIRED): a judge alone cannot change the tie',
  pg_temp.code(pg_temp.file(1, 13, array[1, 2, 3], 'entry error')) = 'COMP_CORRECTION_COSIGN_REQUIRED');
select pg_temp.chk('11.4b(g) the opener cannot co-sign their own correction (COMP_CORRECTION_COSIGN_SAME_PERSON)', pg_temp.code(pg_temp.cosign(1, 1)) = 'COMP_CORRECTION_COSIGN_SAME_PERSON');
select pg_temp.chk('11.4b(g) a different manager co-signs', pg_temp.code(pg_temp.cosign(1, 2)) = 'OK');
create temp table t_file1 on commit drop as select pg_temp.file(1, 13, array[1, 2, 3], 'entry error') as r;
select pg_temp.chk('11.4b(g) the judge files the corrected ballot (J13 {1,2,3} replacing {1,3,4}): accepted, and the correction row stores original / replacement / reason / diff',
  (select pg_temp.code(r) = 'OK' from t_file1)
  and (select count(*) = 1 and bool_and(c.reason = 'entry error' and c.diff ? 'removed' and c.diff ? 'added') from public.event_competition_ballot_corrections c where c.round_id = pg_temp.id('src', 1)));
-- recalculation: a NEW version is produced from the corrected ballots; the tie dissolved (3 couples at or above the cut-off)
create temp table t_calc1b on commit drop as select pg_temp.calc(1, 3) as r;
grant all on t_calc1b to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) recalculation succeeds and stores version 2 (calculated); version 1 is superseded (not deleted)',
  (select r ->> 'error' is null and (r ->> 'version')::int = 2 and r ->> 'status' = 'calculated' from t_calc1b) and pg_temp.vstatus(1, 1) = 'superseded' and pg_temp.vstatus(1, 2) = 'calculated', (select r::text from t_calc1b));
select pg_temp.chk('11.4b(g) the tie dissolved from the ballots alone: v2 rows are decided - e1, e2, e3 advanced; the other five not; no NULL; tie_status above_cut / below_cut only',
  (select count(*) = 8 and count(*) filter (where advanced is null) = 0
          and array_agg(entry_id order by entry_id) filter (where advanced) = (select array_agg(pg_temp.id('ent', 1, k) order by pg_temp.id('ent', 1, k)) from generate_series(1, 3) k)
          and bool_and(output ->> 'tie_status' in ('above_cut', 'below_cut'))
   from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 2)));
select pg_temp.chk('11.4b(h) the earlier blocked version and its evidence remain intact after the recalculation (rows still NULL, same content)',
  (select jsonb_agg(jsonb_build_array(entry_id, advanced, output) order by entry_id) = (select rows_json from t_ev1_pre) from public.event_competition_result_rows where result_version_id = pg_temp.vid(1, 1))
  and (select input::text || trace::text || input_hash || trace_hash = (select evidence from t_ev1_pre) from public.event_competition_result_versions where id = pg_temp.vid(1, 1)));
create temp table t_pv1b on commit drop as select pg_temp.preview(1) as r;
grant all on t_pv1b to authenticated, anon, service_role;
select pg_temp.chk('11.4b(c) control: preview of a calculated NON-tie version (v2, no NULL rows; v1 superseded) does NOT carry COMP_ADVANCEMENT_BLOCKED (only the SOURCE_STATE arms)',
  (select not exists (select 1 from jsonb_array_elements(r -> 'blockers') b where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED')
          and exists (select 1 from jsonb_array_elements(r -> 'blockers') b where b ->> 'code' = 'COMP_ADVANCEMENT_SOURCE_STATE') from t_pv1b), (select (r -> 'blockers')::text from t_pv1b));
create temp table t_ap1d on commit drop as select pg_temp.approve(1, 1, 2) as r;
create temp table t_ap1e on commit drop as select pg_temp.approve(1, 2, 2) as r;
grant all on t_ap1d, t_ap1e to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) the superseded blocked version v1 can never be approved (COMP_RESULT_STALE / invalid transition)', (select r ->> 'error' is not null from t_ap1d), (select r::text from t_ap1d));
select pg_temp.chk('11.4b(g) the new version approves (second manager) and the round is approved', (select r ->> 'error' is null and r ->> 'status' = 'approved' from t_ap1e) and pg_temp.rstatus(1) = 'approved', (select r::text from t_ap1e));
create temp table t_pv1d on commit drop as select pg_temp.preview(1) as r;
grant all on t_pv1d to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) preview of the resolved round is ready with exactly the three advanced couples', (select r ->> 'state' = 'ready' and jsonb_array_length(r -> 'advanced_entries') = 3 from t_pv1d), (select r::text from t_pv1d));
create temp table t_apv1d on commit drop as select pg_temp.apply_adv(1, 2) as r;
grant all on t_apv1d to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) apply works on the resolved version: generation 1, 3 entries (first advancement of this round)',
  (select r ->> 'error' is null and (r ->> 'generation')::int = 1 and (r ->> 'entry_count')::int = 3 and r ->> 'replayed' = 'false' from t_apv1d), (select r::text from t_apv1d));
select pg_temp.chk('11.4b(g) the advancement points at v2 (not the blocked v1); one Final heat with exactly e1, e2, e3',
  (select count(*) = 1 and bool_and(a.source_result_version_id = pg_temp.vid(1, 2)) from public.event_competition_round_advancements a where a.source_round_id = pg_temp.id('src', 1))
  and (select array_agg(he.entry_id order by he.entry_id) = (select array_agg(pg_temp.id('ent', 1, k) order by pg_temp.id('ent', 1, k)) from generate_series(1, 3) k)
       from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', 1)));

-- ---- S7: the corrected ballot does NOT dissolve the tie: the new version is blocked again; a later correction resolves it
select pg_temp.mk(7, 3);
select pg_temp.set_cap(7, 3);
select pg_temp.vtie(7);
select pg_temp.lockit(7);
select pg_temp.calc(7, 3);
select pg_temp.open_corr(7);
select pg_temp.cosign(7, 2);
select pg_temp.file(7, 13, array[1, 2, 5], 'entry error');   -- J11 {1,2,3}, J12 {1,2,4}, J13 {1,2,5}: tallies 3,3,1,1,1 -> the rank-3 group of three straddles the cut-off
create temp table t_calc7b on commit drop as select pg_temp.calc(7, 3) as r;
grant all on t_calc7b to authenticated, anon, service_role;
select pg_temp.chk('11.4b(g) a corrected ballot that leaves the tie over capacity: the recalculation completes with version 2, again blocked (all 8 rows NULL, tied_at_cut on the three at tally 1)',
  (select r ->> 'error' is null and (r ->> 'version')::int = 2 from t_calc7b)
  and (select count(*) = 8 and count(*) filter (where advanced is null) = 8 and count(*) filter (where output ->> 'tie_status' = 'tied_at_cut') = 3
      from public.event_competition_result_rows where result_version_id = pg_temp.vid(7, 2)), (select r::text from t_calc7b));
select pg_temp.chk('11.4b(g) v1 is superseded with its tie evidence intact; v2 is the live calculated blocked version',
  pg_temp.vstatus(7, 1) = 'superseded' and pg_temp.vstatus(7, 2) = 'calculated'
  and (select count(*) = 8 and count(*) filter (where advanced is null) = 8 from public.event_competition_result_rows where result_version_id = pg_temp.vid(7, 1)));
create temp table t_ap7 on commit drop as select pg_temp.approve(7, 2, 2) as r;
create temp table t_apv7 on commit drop as select pg_temp.apply_adv(7, 2) as r;
create temp table t_pv7 on commit drop as select pg_temp.preview(7) as r;
grant all on t_ap7, t_apv7, t_pv7 to authenticated, anon, service_role;
select pg_temp.chk('11.4b(c) preview of the re-blocked live v2 names the tie for version 2 (calculated), not the superseded v1',
  (select exists (select 1 from jsonb_array_elements(r -> 'blockers') b
                  where b ->> 'code' = 'COMP_ADVANCEMENT_BLOCKED' and b #>> '{detail,reason}' = 'tie_over_capacity'
                    and (b #>> '{detail,version}')::int = 2 and b #>> '{detail,version_status}' = 'calculated') from t_pv7), (select (r -> 'blockers')::text from t_pv7));
select pg_temp.chk('11.4b(g) the still-blocked v2: approve refused COMP_ADVANCEMENT_BLOCKED, apply refused, preview blocked, nothing advanced',
  (select r ->> 'error' like 'COMP_ADVANCEMENT_BLOCKED%' from t_ap7) and (select r ->> 'error' is not null from t_apv7) and (select r ->> 'state' = 'blocked' from t_pv7)
  and (select (s::jsonb ->> 'adv')::int = 0 and (s::jsonb ->> 'final_heats')::int = 0 and (s::jsonb ->> 'approvals')::int = 0 from (select pg_temp.snap(7) s) x), (select r::text from t_ap7) || (select r::text from t_apv7));
select pg_temp.blocked('11.4b(g) a SECOND correction on the same round (new cause, new co-sign) finally resolving a still-blocked version', 'cannot run inside this one-transaction suite (the A7 cause trigger keys the cause to the first correction event of the transaction); covered with committed transactions in test_T_competition_cf1_a0_tie_concurrency.sh scenario S4');
\else
select pg_temp.blocked('11.4b(g)(h) corrected-ballot resolution route (open correction -> A7 co-sign -> corrected ballot -> recalculate -> approve / apply; stale-safe tie evidence)', 'A7 (20270120096000) is not installed in this chain; run the suite on the full CF1 chain');
\endif

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
    raise exception 'COMPETITION CF1 A0 TIE POLICY SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  else
    raise exception 'COMPETITION CF1 A0 TIE POLICY SUITE FAIL: %', E'\n  ' || v_failures;
  end if;
end $$;
rollback;
