-- Competition O1 -- day-of round operations regression suite.
--
-- Covers 20270106090000_competition_o1_day_of.sql on top of 10A/10B/10C/10C.4/10D/10D.1.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0c0a10XXXXXX). The final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION O1 SQL SUITE PASS (<n> checks)"  or  "COMPETITION O1 SQL SUITE FAIL: <failures>".
-- E1's competition_round_panel_ready and F3's result_publications are stood in for by transaction-local stubs
-- (created below, rolled back with the transaction). The concurrent double start (needs a real second connection)
-- lives in test_T_competition_o1_concurrency.sh.

begin;

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
    set constraints all immediate;
    set constraints all deferred;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- Expects the statement to fail with p_fragment; an unexpected success is rolled back AND recorded as a failure.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    set constraints all immediate;
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
  set constraints all deferred;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c0a10' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.s(p_sql text) returns text
language plpgsql as $$ declare r text; begin execute p_sql into r; return r; end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.fh(p_version uuid, p_number int) returns uuid
language sql stable as $$ select id from public.event_competition_floor_heats where schedule_version_id = p_version and heat_number = p_number $$;
create or replace function pg_temp.rstatus(p_round text) returns text
language sql stable as $$ select status from public.event_competition_rounds where id = pg_temp.u(p_round) $$;
-- Distinct statuses of a floor heat's scoring heats ('a|b' when mixed).
create or replace function pg_temp.fhs(p_floor uuid) returns text
language sql stable as $$ select string_agg(distinct status, '|') from public.event_competition_heats where floor_heat_id = p_floor and status <> 'cancelled' $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-o1-owner-a@example.test'),
  (pg_temp.u('000004'), 't-o1-owner-b@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-o1-owner-a@example.test', 'Owner A'),
  (pg_temp.u('000004'), 't-o1-owner-b@example.test', 'Owner B');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'O1 Studio A', 't-o1-studio-a'),
  (pg_temp.u('00b001'), 'O1 Studio B', 't-o1-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000004'), pg_temp.u('00b001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'O1 Comp', 't-o1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'O1 Other Comp', 't-o1-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);

insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002009'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');
update public.event_competition_contest_registration_rules set dance_selection_mode = 'individual'
where contest_id in (pg_temp.u('002001'), pg_temp.u('002002'), pg_temp.u('002009'));

insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Newcomer ProAm', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Intermediate ProAm', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002002'), 'Bronze Couples', 'open'),
  (pg_temp.u('003009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002009'), 'Other Newcomer', 'open');

-- R1 (D1) and R3 (D3) share floor heat 1; R2 (D2) is floor heat 2. R4 has no heats; R5 has an unplaced heat;
-- R6 is spare (cancel); R7 is spare (stand-in lifecycle); R9 belongs to the other studio.
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Final', 'final', 1),
  (pg_temp.u('006004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Semi', 'semifinal', 2),
  (pg_temp.u('006005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Quarter', 'quarterfinal', 3),
  (pg_temp.u('006006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Spare', 'semifinal', 2),
  (pg_temp.u('006007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Spare 2', 'semifinal', 2),
  (pg_temp.u('006009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'Final', 'final', 1);

insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step');
insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004001'), 1),
  (pg_temp.u('005031'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), pg_temp.u('004001'), 1);

insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via) values
  (pg_temp.u('007001'), pg_temp.u('00e001'), 'Pat', 'Pro', 'staff'),
  (pg_temp.u('007002'), pg_temp.u('00e001'), 'Sam', 'One', 'staff'),
  (pg_temp.u('007003'), pg_temp.u('00e001'), 'Sue', 'Two', 'staff'),
  (pg_temp.u('007004'), pg_temp.u('00e001'), 'Alex', 'Morgan', 'staff'),
  (pg_temp.u('007005'), pg_temp.u('00e001'), 'Bo', 'Bee', 'staff');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Sam One / Pat Pro', 'confirmed', 'eligible', '101'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Sue Two / Pat Pro', 'confirmed', 'eligible', '102'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Alex Morgan / Bo Bee', 'confirmed', 'eligible', '103');
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name, sort_order) values
  (pg_temp.u('00e001'), pg_temp.u('008001'), pg_temp.u('007002'), 'student', 'follower', 'Sam One', 1),
  (pg_temp.u('00e001'), pg_temp.u('008001'), pg_temp.u('007001'), 'professional', 'leader', 'Pat Pro', 2),
  (pg_temp.u('00e001'), pg_temp.u('008002'), pg_temp.u('007003'), 'student', 'follower', 'Sue Two', 1),
  (pg_temp.u('00e001'), pg_temp.u('008002'), pg_temp.u('007001'), 'professional', 'leader', 'Pat Pro', 2),
  (pg_temp.u('00e001'), pg_temp.u('008003'), pg_temp.u('007004'), 'dancer', 'leader', 'Alex Morgan', 1),
  (pg_temp.u('00e001'), pg_temp.u('008003'), pg_temp.u('007005'), 'dancer', 'follower', 'Bo Bee', 2);
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select e.event_id, e.id, dd.id, 'offering', 'Offering'
from public.event_competition_entries e
join public.event_competition_division_dances dd on dd.division_id = e.division_id
where e.id::text like '00000000-0000-0000-0000-0c0a10%';

-- Stand-ins for dependencies that are not merged: E1 panel readiness (GUC-driven) and F3 publications.
create function public.competition_round_panel_ready(p_round_id uuid) returns boolean language sql stable as
  $$ select coalesce(current_setting('o1.panel_ready', true), 'off') = 'on' $$;
-- (dropped again below to prove start fails closed without E1)
drop function public.competition_round_panel_ready(uuid);

-- ============================================================================
-- Versions + plan (as owner A)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'Heats v1', null));

create or replace function pg_temp.plan() returns jsonb language sql stable as $$
  select jsonb_build_object('floorHeats', jsonb_build_array(
    jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'), 'heatNumber', 1, 'name', 'Newcomer ProAm Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008001'))),
      jsonb_build_object('divisionId', pg_temp.u('003003'), 'roundId', pg_temp.u('006003'), 'heatNumber', 1, 'name', 'Bronze Couples Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008003'))))),
    jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', pg_temp.u('006002'), 'heatNumber', 1, 'name', 'Intermediate ProAm Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008002')))))
  ));
$$;
grant execute on function pg_temp.plan() to authenticated;

select pg_temp.expect_ok('setup: plan applies', $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan())$q$);
select pg_temp.chk('setup: two floor heats, three scoring heats',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 2
  and pg_temp.n($q$select count(*) from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and status = 'scheduled'$q$) = 3);

-- An unplaced scoring heat (no version) for R5 (posted by the owner role).
reset role;
insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, name, contest_id, status)
values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006005'), 1, 'Unplaced', pg_temp.u('002001'), 'scheduled');
select pg_temp.as_user(pg_temp.u('000001'));

-- ---------------------------------------------------------------------------
-- A. schedule_competition_round
-- ---------------------------------------------------------------------------
select pg_temp.expect_msg('A1 schedule is refused before the running order is published',
  $q$select public.schedule_competition_round(pg_temp.u('006001'), pg_temp.u('0a0001'))$q$, 'COMPO1_NOT_PUBLISHED');
select pg_temp.expect_ok('A0 publish the running order', $q$select public.publish_competition_schedule_version(pg_temp.id('v1'))$q$);
select pg_temp.expect_msg('A2 a round with no heats cannot be scheduled',
  $q$select public.schedule_competition_round(pg_temp.u('006004'), pg_temp.u('0a0002'))$q$, 'COMPO1_NO_HEATS');
select pg_temp.expect_msg('A3 a round with a heat outside the published order cannot be scheduled',
  $q$select public.schedule_competition_round(pg_temp.u('006005'), pg_temp.u('0a0003'))$q$, 'COMPO1_HEATS_NOT_PUBLISHED');
select pg_temp.expect_ok('A4 draft -> scheduled',
  $q$select public.schedule_competition_round(pg_temp.u('006001'), pg_temp.u('0a0004'))$q$);
select pg_temp.chk('A4 R1 is scheduled with one audit row',
  pg_temp.rstatus('006001') = 'scheduled'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where round_id = pg_temp.u('006001') and kind = 'round_scheduled' and from_state = 'draft' and to_state = 'scheduled' and actor = pg_temp.u('000001')$q$) = 1);
select pg_temp.chk('A5 replay with the same request id is a no-op',
  (select (public.schedule_competition_round(pg_temp.u('006001'), pg_temp.u('0a0004')))->>'replayed') = 'true'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where round_id = pg_temp.u('006001')$q$) = 1);
select pg_temp.expect_msg('A6 a request id cannot be reused for another round',
  $q$select public.schedule_competition_round(pg_temp.u('006002'), pg_temp.u('0a0004'))$q$, 'COMPO1_REQUEST_REUSE');
select pg_temp.expect_msg('A7 only a draft round can be scheduled (new request id)',
  $q$select public.schedule_competition_round(pg_temp.u('006001'), pg_temp.u('0a0005'))$q$, 'COMPO1_BAD_STATE');
select pg_temp.expect_ok('A8 schedule R3 and R2', $q$select public.schedule_competition_round(pg_temp.u('006003'), pg_temp.u('0a0006')); select public.schedule_competition_round(pg_temp.u('006002'), pg_temp.u('0a0007'))$q$);

-- ---------------------------------------------------------------------------
-- B. start_competition_round (E1 panel contract)
-- ---------------------------------------------------------------------------
select pg_temp.expect_msg('B1 start fails closed while competition_round_panel_ready does not exist',
  $q$select public.start_competition_round(pg_temp.u('006001'), pg_temp.u('0b0001'))$q$, 'COMPO1_PANEL_UNAVAILABLE');
reset role;
create function public.competition_round_panel_ready(p_round_id uuid) returns boolean language sql stable as
  $$ select coalesce(current_setting('o1.panel_ready', true), 'off') = 'on' $$;
grant execute on function public.competition_round_panel_ready(uuid) to authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select set_config('o1.panel_ready', 'off', true);
select pg_temp.expect_msg('B2 start is refused until the panel is ready',
  $q$select public.start_competition_round(pg_temp.u('006001'), pg_temp.u('0b0002'))$q$, 'COMPO1_PANEL_NOT_READY');
select pg_temp.expect_msg('B3 an unscheduled (draft) round cannot be started',
  $q$select set_config('o1.panel_ready', 'on', true); select public.start_competition_round(pg_temp.u('006004'), pg_temp.u('0b0003'))$q$, 'COMPO1_BAD_STATE');
select set_config('o1.panel_ready', 'on', true);
select pg_temp.expect_ok('B4 scheduled -> active', $q$select public.start_competition_round(pg_temp.u('006001'), pg_temp.u('0b0004'))$q$);
select pg_temp.chk('B4 R1 is active with one audit row',
  pg_temp.rstatus('006001') = 'active'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where round_id = pg_temp.u('006001') and kind = 'round_started' and from_state = 'scheduled' and to_state = 'active'$q$) = 1);
select pg_temp.chk('B5 replay of the start is a no-op',
  (select (public.start_competition_round(pg_temp.u('006001'), pg_temp.u('0b0004')))->>'replayed') = 'true');
select pg_temp.expect_msg('B6 an active round cannot be started again (new request id)',
  $q$select public.start_competition_round(pg_temp.u('006001'), pg_temp.u('0b0005'))$q$, 'COMPO1_BAD_STATE');

-- ---------------------------------------------------------------------------
-- C. advance_competition_floor_heat
-- ---------------------------------------------------------------------------
select pg_temp.expect_msg('C1 heat 1 cannot be staged while R3 (scheduled) is not active',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'staging', pg_temp.u('0c0001'))$q$, 'COMPO1_ROUND_NOT_ACTIVE');
select pg_temp.expect_ok('C2 start R3', $q$select public.start_competition_round(pg_temp.u('006003'), pg_temp.u('0b0006'))$q$);
select pg_temp.expect_msg('C3 invalid target status is refused',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'draft', pg_temp.u('0c0002'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.expect_msg('C4 heat cannot start before it is staged',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'active', pg_temp.u('0c0003'))$q$, 'COMPO1_BAD_STATE');
select pg_temp.expect_ok('C5 scheduled -> staging', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'staging', pg_temp.u('0c0004'))$q$);
select pg_temp.chk('C5 every scoring heat of floor heat 1 is staging, one audit row each',
  pg_temp.fhs(pg_temp.fh(pg_temp.id('v1'), 1)) = 'staging'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where kind = 'heat_staged' and request_id = pg_temp.u('0c0004')$q$) = 2);
select pg_temp.chk('C6 replay of the stage is a no-op',
  (select (public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'staging', pg_temp.u('0c0004')))->>'replayed') = 'true'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where kind = 'heat_staged'$q$) = 2);
select pg_temp.expect_msg('C7 a heat request id cannot be reused for a different transition',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'active', pg_temp.u('0c0004'))$q$, 'COMPO1_REQUEST_REUSE');
select pg_temp.expect_ok('C8 staging -> active', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'active', pg_temp.u('0c0005'))$q$);
select pg_temp.chk('C8 floor heat 1 is active', pg_temp.fhs(pg_temp.fh(pg_temp.id('v1'), 1)) = 'active');
select pg_temp.expect_ok('C9 start R2', $q$select public.start_competition_round(pg_temp.u('006002'), pg_temp.u('0b0007'))$q$);
select pg_temp.expect_ok('C9 stage heat 2', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 'staging', pg_temp.u('0c0006'))$q$);
select pg_temp.expect_msg('C10 only one heat on the floor: heat 2 cannot start while heat 1 is active',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 'active', pg_temp.u('0c0007'))$q$, 'COMPO1_FLOOR_BUSY');
select pg_temp.expect_msg('C11 a staging round cannot be cancelled while a heat is on the floor',
  $q$select public.cancel_competition_round(pg_temp.u('006003'), 'Floor change', pg_temp.u('0d0001'))$q$, 'COMPO1_HEAT_RUNNING');
select pg_temp.expect_msg('C12 publishing a new running order is blocked once heats are running',
  $q$select public.create_competition_schedule_version(pg_temp.u('00e001'), 'v2', pg_temp.id('v1')); select public.publish_competition_schedule_version((select id from public.event_competition_schedule_versions where name = 'v2'))$q$, 'COMPO1_RUN_IN_PROGRESS');
select pg_temp.expect_ok('C13 active -> complete', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'complete', pg_temp.u('0c0008'))$q$);
select pg_temp.chk('C13 floor heat 1 is complete', pg_temp.fhs(pg_temp.fh(pg_temp.id('v1'), 1)) = 'complete');
select pg_temp.expect_msg('C14 a complete heat cannot move again',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'complete', pg_temp.u('0c0009'))$q$, 'COMPO1_BAD_STATE');
-- A locked scoring heat (10A ledger) is refused; reopening it with a reason allows the start.
select pg_temp.expect_ok('C15 lock heat 2 through the 10A ledger',
  $q$select public.set_competition_heat_lock_state((select id from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 2)), 'locked', null)$q$);
select pg_temp.expect_msg('C15 a locked heat cannot start',
  $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 'active', pg_temp.u('0c000a'))$q$, 'COMPO1_HEAT_LOCKED');
select pg_temp.expect_ok('C15 reopen heat 2',
  $q$select public.set_competition_heat_lock_state((select id from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 2)), 'open', 'Reopen for start')$q$);
select pg_temp.expect_ok('C16 start heat 2 once the floor is free', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 'active', pg_temp.u('0c000b'))$q$);
select pg_temp.expect_ok('C16 complete heat 2', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 'complete', pg_temp.u('0c000c'))$q$);
select pg_temp.expect_ok('C16b a completed heat can still be locked, then certified (E2 needs every heat locked before ballots lock)',  $q$select public.set_competition_heat_lock_state((select id from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 2)), 'locked', null); select public.set_competition_heat_lock_state((select id from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 1) and round_id = pg_temp.u('006001')), 'locked', null)$q$);select pg_temp.chk('C16b heat 2 path open -> staging -> active -> complete -> locked ends complete + locked',  pg_temp.s($q$select string_agg(distinct status || '/' || lock_state, ',') from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 2)$q$) = 'complete/locked');
select pg_temp.chk('C17 no entry rows were touched by the heat transitions',
  pg_temp.n($q$select count(*) from public.event_competition_heat_entries where status <> 'scheduled'$q$) = 0);

-- ---------------------------------------------------------------------------
-- D. cancel_competition_round
-- ---------------------------------------------------------------------------
select pg_temp.expect_msg('D1 a reason is required',
  $q$select public.cancel_competition_round(pg_temp.u('006006'), '  ', pg_temp.u('0d0002'))$q$, 'COMPO1_REASON_REQUIRED');
select pg_temp.expect_ok('D2 draft -> cancelled', $q$select public.cancel_competition_round(pg_temp.u('006006'), 'Merged into another round', pg_temp.u('0d0003'))$q$);
select pg_temp.chk('D2 R6 is cancelled with a reason on the audit row',
  pg_temp.rstatus('006006') = 'cancelled'
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events where round_id = pg_temp.u('006006') and kind = 'round_cancelled' and from_state = 'draft' and reason = 'Merged into another round'$q$) = 1);
select pg_temp.chk('D3 replay of the cancel is a no-op',
  (select (public.cancel_competition_round(pg_temp.u('006006'), 'Merged into another round', pg_temp.u('0d0003')))->>'replayed') = 'true');
select pg_temp.expect_msg('D4 a cancelled round cannot be cancelled again',
  $q$select public.cancel_competition_round(pg_temp.u('006006'), 'Again', pg_temp.u('0d0004'))$q$, 'COMPO1_BAD_STATE');
select pg_temp.expect_ok('D5 an active round whose heats are complete can be cancelled',
  $q$select public.cancel_competition_round(pg_temp.u('006002'), 'Division withdrawn', pg_temp.u('0d0005'))$q$);
-- A publication (F3 stand-in) blocks the cancel.
reset role;
create table public.event_competition_result_publications (id uuid primary key default gen_random_uuid(), round_id uuid not null);
grant select on public.event_competition_result_publications to authenticated;
insert into public.event_competition_result_publications (round_id) values (pg_temp.u('006003'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('D6 a round with a publication cannot be cancelled',
  $q$select public.cancel_competition_round(pg_temp.u('006003'), 'Too late', pg_temp.u('0d0006'))$q$, 'COMPO1_PUBLISHED');
reset role;
delete from public.event_competition_result_publications;
select pg_temp.as_user(pg_temp.u('000001'));

-- ---------------------------------------------------------------------------
-- E. Direct status writes are refused
-- ---------------------------------------------------------------------------
select pg_temp.expect_msg('E1 a manager cannot write round status through the API',
  $q$update public.event_competition_rounds set status = 'active' where id = pg_temp.u('006007')$q$, 'COMPO1_ROUND_STATUS_WRITER');
select pg_temp.expect_msg('E2 a manager cannot insert a non-draft round through the API',
  $q$insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, status) values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Sneaky', 'custom', 9, 'active')$q$, 'COMPO1_ROUND_STATUS_WRITER');
select pg_temp.expect_msg('E3 a manager cannot write day-of heat status through the API',
  $q$update public.event_competition_heats set status = 'complete' where round_id = pg_temp.u('006005')$q$, 'COMPO1_HEAT_STATUS_WRITER');
select pg_temp.expect_msg('E3 a manager cannot cancel a running heat through the API',
  $q$update public.event_competition_heats set status = 'cancelled' where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 1)$q$, 'COMPO1_HEAT_STATUS_WRITER');
reset role;
select pg_temp.expect_msg('E4 even the owner role cannot make an O1 edge without its audit row (draft -> scheduled)',
  $q$update public.event_competition_rounds set status = 'scheduled' where id = pg_temp.u('006007')$q$, 'COMPO1_ROUND_STATUS_WRITER');
select pg_temp.expect_msg('E5 ... nor cancel',
  $q$update public.event_competition_rounds set status = 'cancelled' where id = pg_temp.u('006007')$q$, 'COMPO1_ROUND_STATUS_WRITER');
select pg_temp.expect_msg('E6 ... nor a day-of heat edge without evidence',
  $q$update public.event_competition_heats set status = 'active' where round_id = pg_temp.u('006005')$q$, 'COMPO1_HEAT_STATUS_WRITER');
select pg_temp.expect_ok('E7 later writers (E2/F2 definer functions run as the owner) may move active -> ballots_locked -> active',
  $q$update public.event_competition_rounds set status = 'ballots_locked' where id = pg_temp.u('006001'); update public.event_competition_rounds set status = 'active' where id = pg_temp.u('006001')$q$);
select pg_temp.expect_msg('E8 a cancelled round can never change status, even for the owner role',
  $q$update public.event_competition_rounds set status = 'draft' where id = pg_temp.u('006006')$q$, 'COMPO1_ROUND_TERMINAL');
select pg_temp.expect_msg('E8 a complete round is terminal',
  $q$update public.event_competition_rounds set status = 'complete' where id = pg_temp.u('006001'); update public.event_competition_rounds set status = 'active' where id = pg_temp.u('006001')$q$, 'COMPO1_ROUND_TERMINAL');
select pg_temp.chk('E9 non-status round edits are unaffected',
  (select count(*) from (select 1 from public.event_competition_rounds where id = pg_temp.u('006007')) x) = 1
  and pg_temp.s($q$update public.event_competition_rounds set name = 'Spare 2 renamed' where id = pg_temp.u('006007') returning name$q$) = 'Spare 2 renamed');

-- ---------------------------------------------------------------------------
-- F. Cross-tenant, grants, audit integrity
-- ---------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.expect_msg('F1 another studio cannot schedule a round of this event',
  $q$select public.schedule_competition_round(pg_temp.u('006007'), pg_temp.u('0f0001'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.expect_msg('F2 ... nor start', $q$select public.start_competition_round(pg_temp.u('006003'), pg_temp.u('0f0002'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.expect_msg('F3 ... nor cancel', $q$select public.cancel_competition_round(pg_temp.u('006007'), 'Nope nope', pg_temp.u('0f0003'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.expect_msg('F4 ... nor advance a heat', $q$select public.advance_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 'staging', pg_temp.u('0f0004'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.chk('F5 the other studio sees zero audit rows for this event',
  pg_temp.n($q$select count(*) from public.event_competition_round_transition_events$q$) = 0);
select pg_temp.chk('F5 the manager sees them',
  (select count(*) from (select pg_temp.as_user(pg_temp.u('000001'))) x) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_round_transition_events$q$) > 0);
select pg_temp.expect_msg('F6 a different studio cannot replay this request id',
  $q$select pg_temp.as_user(pg_temp.u('000004')); select public.schedule_competition_round(pg_temp.u('006001'), pg_temp.u('0a0004'))$q$, 'COMPO1_NOT_FOUND');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('F7 an authenticated manager cannot insert audit rows',
  $q$insert into public.event_competition_round_transition_events (event_id, round_id, kind, from_state, to_state, actor, request_id) values (pg_temp.u('00e001'), pg_temp.u('006007'), 'round_scheduled', 'draft', 'scheduled', pg_temp.u('000001'), gen_random_uuid())$q$, 'permission denied');
select pg_temp.expect_msg('F8 audit rows cannot be updated', $q$update public.event_competition_round_transition_events set reason = 'x'$q$, 'permission denied');
reset role;
select pg_temp.expect_msg('F8 ... even by the owner role', $q$update public.event_competition_round_transition_events set reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('F9 ... nor deleted', $q$delete from public.event_competition_round_transition_events$q$, 'append-only');
select pg_temp.expect_msg('F9 ... nor truncated', $q$truncate public.event_competition_round_transition_events$q$, 'append-only');
select pg_temp.chk('F10 anon cannot execute the writers',
  not has_function_privilege('anon', 'public.schedule_competition_round(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.start_competition_round(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.cancel_competition_round(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.advance_competition_floor_heat(uuid,text,uuid)', 'EXECUTE'));
select pg_temp.chk('F10 authenticated can execute them',
  has_function_privilege('authenticated', 'public.schedule_competition_round(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.advance_competition_floor_heat(uuid,text,uuid)', 'EXECUTE'));
select pg_temp.chk('F11 the internal helpers are not executable by API roles',
  not has_function_privilege('authenticated', 'public._compo1_record(uuid,uuid,uuid,text,text,text,uuid,uuid,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._compo1_lock_event(uuid)', 'EXECUTE'));
select pg_temp.expect_msg('F12 no auth.uid() means not found',
  $q$select set_config('request.jwt.claims', '', true); select public.schedule_competition_round(pg_temp.u('006007'), pg_temp.u('0f0005'))$q$, 'COMPO1_NOT_FOUND');
reset role;

-- ============================================================================
-- Report
-- ============================================================================
do $$
declare
  v_fail text;
  v_total integer;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' => ' || detail, '; ') into v_fail from t_results where not ok;
  if v_fail is null then
    raise exception 'COMPETITION O1 SQL SUITE PASS (% checks)', v_total;
  else
    raise exception 'COMPETITION O1 SQL SUITE FAIL: %', v_fail;
  end if;
end $$;
