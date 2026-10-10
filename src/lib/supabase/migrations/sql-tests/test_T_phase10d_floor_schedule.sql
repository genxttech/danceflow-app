-- Phase 10D -- heats + floor schedule v1 regression suite.
--
-- Covers 20261111090000_phase10d_heats_floor_schedule.sql on top of 10A/10B/10C/10C.4.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0c10d0XXXXXX).
-- Deferred integrity checks are forced with SET CONSTRAINTS ALL IMMEDIATE inside each probe, then
-- restored to deferred. The final block ALWAYS raises, so nothing persists:
--   "PHASE 10D SQL SUITE PASS (<n> checks)"  or  "PHASE 10D SQL SUITE FAIL: <failures>".

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

-- Runs a statement and forces the deferred integrity checks (commit-time behaviour).
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

-- Expects the statement (or its commit-time checks) to fail with p_fragment. An unexpected success is
-- rolled back AND recorded as a failure (the record is written after the subtransaction is undone).
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
language sql immutable as $$ select ('00000000-0000-0000-0000-0c10d0' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Floor heat by number in a version; scoring heat by division in a version.
create or replace function pg_temp.fh(p_version uuid, p_number int) returns uuid
language sql stable as $$ select id from public.event_competition_floor_heats where schedule_version_id = p_version and heat_number = p_number $$;
create or replace function pg_temp.sh(p_version uuid, p_division uuid) returns uuid
language sql stable as $$ select id from public.event_competition_heats where schedule_version_id = p_version and division_id = p_division and status <> 'cancelled' order by heat_number limit 1 $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-p10d-owner-a@example.test'),
  (pg_temp.u('000004'), 't-p10d-owner-b@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-p10d-owner-a@example.test', 'Owner A'),
  (pg_temp.u('000004'), 't-p10d-owner-b@example.test', 'Owner B');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'P10D Studio A', 't-p10d-studio-a'),
  (pg_temp.u('00b001'), 'P10D Studio B', 't-p10d-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000004'), pg_temp.u('00b001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'P10D Comp', 't-p10d-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a001'), 'P10D Other Comp', 't-p10d-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);

insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'Other', 'country', 'relative', 'skating', 'configured');

insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002003'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProPro', 'single_dance', 'pro_pro', 'open'),
  (pg_temp.u('002004'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Team', 'team', 'team', 'open'),
  (pg_temp.u('002005'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Jack and Jill', 'jack_and_jill', 'random_partner', 'open'),
  (pg_temp.u('002006'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Showcase', 'showdance', 'custom', 'open'),
  (pg_temp.u('002007'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Spotlight', 'spotlight', 'pro_am', 'open'),
  (pg_temp.u('002009'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');

-- One registration rule per contest with the dance-selection mode under test.
insert into public.event_competition_contest_registration_rules (event_id, program_id, contest_id, dance_selection_mode, pricing_method, minimum_participants, maximum_participants)
select c.event_id, c.program_id, c.id, m.mode, 'flat_entry', 1, 10
from public.event_competition_contests c
join (values ('002001', 'individual'), ('002002', 'individual'), ('002003', 'individual'), ('002004', 'routine'),
             ('002005', 'prescribed_set'), ('002006', 'routine'), ('002007', 'prescribed_set'), ('002009', 'individual')) m(k, mode) on c.id = pg_temp.u(m.k)
where not exists (select 1 from public.event_competition_contest_registration_rules r where r.contest_id = c.id);
update public.event_competition_contest_registration_rules r set dance_selection_mode = m.mode
from (values ('002001', 'individual'), ('002002', 'individual'), ('002003', 'individual'), ('002004', 'routine'),
             ('002005', 'prescribed_set'), ('002006', 'routine'), ('002007', 'prescribed_set'), ('002009', 'individual')) m(k, mode)
where r.contest_id = pg_temp.u(m.k);

insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Newcomer ProAm', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Intermediate ProAm', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002002'), 'Bronze Couples', 'open'),
  (pg_temp.u('003004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002003'), 'ProPro I', 'open'),
  (pg_temp.u('003005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002004'), 'Team Open', 'open'),
  (pg_temp.u('003006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002005'), 'J&J Novice', 'open'),
  (pg_temp.u('003007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002006'), 'Showcase Open', 'open'),
  (pg_temp.u('003008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002007'), 'Spotlight Open', 'open'),
  (pg_temp.u('003009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002009'), 'Other Newcomer', 'open');

insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number)
select ('00000000-0000-0000-0000-0c10d0' || '00' || '6' || right(d.id::text, 3))::uuid, d.event_id, d.program_id, d.id, 'Final', 'final', 1
from public.event_competition_divisions d where d.id::text like '00000000-0000-0000-0000-0c10d0%';

insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step'),
  (pg_temp.u('004002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'waltz', 'Waltz'),
  (pg_temp.u('004003'), pg_temp.u('00e001'), pg_temp.u('001001'), 'west_coast_swing', 'West Coast Swing'),
  (pg_temp.u('004009'), pg_temp.u('00e002'), pg_temp.u('001002'), 'two_step', 'Two Step');

insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004002'), 2),
  (pg_temp.u('005021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004001'), 1),
  (pg_temp.u('005031'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), pg_temp.u('004001'), 1),
  (pg_temp.u('005032'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), pg_temp.u('004002'), 2),
  (pg_temp.u('005041'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), pg_temp.u('004001'), 1),
  (pg_temp.u('005061'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), pg_temp.u('004003'), 1),
  (pg_temp.u('005081'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003008'), pg_temp.u('004001'), 1),
  (pg_temp.u('005091'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), pg_temp.u('004009'), 1);

-- Competitors: P pro (two ProAm students), I instructor (two ProPro entries), A dancer (couples + team + second couple).
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via) values
  (pg_temp.u('007001'), pg_temp.u('00e001'), 'Pat', 'Pro', 'staff'),
  (pg_temp.u('007002'), pg_temp.u('00e001'), 'Sam', 'One', 'staff'),
  (pg_temp.u('007003'), pg_temp.u('00e001'), 'Sue', 'Two', 'staff'),
  (pg_temp.u('007004'), pg_temp.u('00e001'), 'Alex', 'Morgan', 'staff'),
  (pg_temp.u('007005'), pg_temp.u('00e001'), 'Bo', 'Bee', 'staff'),
  (pg_temp.u('007006'), pg_temp.u('00e001'), 'Ivy', 'Instructor', 'staff'),
  (pg_temp.u('007007'), pg_temp.u('00e001'), 'Quinn', 'Pro', 'staff'),
  (pg_temp.u('007008'), pg_temp.u('00e001'), 'Rae', 'Pro', 'staff'),
  (pg_temp.u('007009'), pg_temp.u('00e001'), 'Tom', 'Team', 'staff'),
  (pg_temp.u('007010'), pg_temp.u('00e001'), 'Jo', 'Jill', 'staff'),
  (pg_temp.u('007011'), pg_temp.u('00e001'), 'Cy', 'Solo', 'staff'),
  (pg_temp.u('007012'), pg_temp.u('00e001'), 'Cal', 'Cee', 'staff'),
  (pg_temp.u('007019'), pg_temp.u('00e002'), 'Otto', 'Other', 'staff');

insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Sam One / Pat Pro', 'confirmed', 'eligible', '101'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Sue Two / Pat Pro', 'confirmed', 'unverified', '102'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Alex Morgan / Bo Bee', 'confirmed', 'eligible', '103'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'Quinn Pro / Ivy Instructor', 'confirmed', 'eligible', '104'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'Rae Pro / Ivy Instructor', 'confirmed', 'eligible', '105'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'Spinners', 'confirmed', 'eligible', '106'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'Jo Jill', 'confirmed', 'eligible', '107'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'Cy Solo', 'confirmed', 'eligible', '108'),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Withdrawn ProAm', 'withdrawn', 'eligible', '109'),
  (pg_temp.u('008010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Ineligible ProAm', 'confirmed', 'ineligible', '110'),
  (pg_temp.u('008011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Pending Couple', 'pending', 'unverified', '111'),
  (pg_temp.u('008012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Alex Morgan / Cal Cee', 'confirmed', 'eligible', '112'),
  (pg_temp.u('008019'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'Otto Other', 'confirmed', 'eligible', '119');

insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name, sort_order) values
  (pg_temp.u('00e001'), pg_temp.u('008001'), pg_temp.u('007002'), 'student', 'follower', 'Sam One', 1),
  (pg_temp.u('00e001'), pg_temp.u('008001'), pg_temp.u('007001'), 'professional', 'leader', 'Pat Pro', 2),
  (pg_temp.u('00e001'), pg_temp.u('008002'), pg_temp.u('007003'), 'student', 'follower', 'Sue Two', 1),
  (pg_temp.u('00e001'), pg_temp.u('008002'), pg_temp.u('007001'), 'professional', 'leader', 'Pat Pro', 2),
  (pg_temp.u('00e001'), pg_temp.u('008003'), pg_temp.u('007004'), 'dancer', 'leader', 'Alex Morgan', 1),
  (pg_temp.u('00e001'), pg_temp.u('008003'), pg_temp.u('007005'), 'dancer', 'follower', 'Bo Bee', 2),
  (pg_temp.u('00e001'), pg_temp.u('008004'), pg_temp.u('007007'), 'professional', 'follower', 'Quinn Pro', 1),
  (pg_temp.u('00e001'), pg_temp.u('008004'), pg_temp.u('007006'), 'instructor', 'leader', 'Ivy Instructor', 2),
  (pg_temp.u('00e001'), pg_temp.u('008005'), pg_temp.u('007008'), 'professional', 'follower', 'Rae Pro', 1),
  (pg_temp.u('00e001'), pg_temp.u('008005'), pg_temp.u('007006'), 'instructor', 'leader', 'Ivy Instructor', 2),
  (pg_temp.u('00e001'), pg_temp.u('008006'), pg_temp.u('007009'), 'team_member', null, 'Tom Team', 1),
  (pg_temp.u('00e001'), pg_temp.u('008006'), pg_temp.u('007004'), 'team_member', null, 'Alex Morgan', 2),
  (pg_temp.u('00e001'), pg_temp.u('008007'), pg_temp.u('007010'), 'dancer', 'leader', 'Jo Jill', 1),
  (pg_temp.u('00e001'), pg_temp.u('008008'), pg_temp.u('007011'), 'dancer', null, 'Cy Solo', 1),
  (pg_temp.u('00e001'), pg_temp.u('008009'), pg_temp.u('007012'), 'student', 'follower', 'Cal Cee', 1),
  (pg_temp.u('00e001'), pg_temp.u('008010'), pg_temp.u('007012'), 'student', 'follower', 'Cal Cee', 1),
  (pg_temp.u('00e001'), pg_temp.u('008011'), pg_temp.u('007012'), 'dancer', 'leader', 'Cal Cee', 1),
  (pg_temp.u('00e001'), pg_temp.u('008012'), pg_temp.u('007004'), 'dancer', 'leader', 'Alex Morgan', 1),
  (pg_temp.u('00e001'), pg_temp.u('008012'), pg_temp.u('007012'), 'dancer', 'follower', 'Cal Cee', 2),
  (pg_temp.u('00e002'), pg_temp.u('008019'), pg_temp.u('007019'), 'student', 'follower', 'Otto Other', 1);

-- Per-dance registrations (Two Step everywhere it is offered; nobody on Waltz).
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select e.event_id, e.id, dd.id, 'offering', 'Offering'
from public.event_competition_entries e
join public.event_competition_division_dances dd on dd.division_id = e.division_id
join public.event_competition_dances n on n.id = dd.dance_id and n.dance_key = 'two_step'
where e.id::text like '00000000-0000-0000-0000-0c10d0%';

-- ============================================================================
-- Versions + plan (as owner A)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'Heats v1', null));
insert into t_ids values ('v9', public.create_competition_schedule_version(pg_temp.u('00e002'), 'Other v1', null));

-- Heat 1 Two Step: Newcomer ProAm (Pat). Heat 2 Two Step: Intermediate ProAm (Pat) -- separate, Pat is shared.
-- Heat 3 Two Step: Bronze Couples (Alex+Bo) + ProPro I (Ivy+Quinn). Heat 4 Two Step: Bronze Couples 2nd (Alex+Cal)
-- + ProPro I 2nd (Ivy+Rae). Heat 5 team. Heat 6 J&J. Heat 7 showcase.
create or replace function pg_temp.plan() returns jsonb language sql stable as $$
  select jsonb_build_object('floorHeats', jsonb_build_array(
    jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', '00000000-0000-0000-0000-0c10d0006001', 'heatNumber', 1, 'name', 'Newcomer ProAm Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008001'))))),
    jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', '00000000-0000-0000-0000-0c10d0006002', 'heatNumber', 1, 'name', 'Intermediate ProAm Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008002'))))),
    jsonb_build_object('number', 3, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003003'), 'roundId', '00000000-0000-0000-0000-0c10d0006003', 'heatNumber', 1, 'name', 'Bronze Couples Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008003'))),
      jsonb_build_object('divisionId', pg_temp.u('003004'), 'roundId', '00000000-0000-0000-0000-0c10d0006004', 'heatNumber', 1, 'name', 'ProPro I Two Step',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008004'))))),
    jsonb_build_object('number', 4, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003003'), 'roundId', '00000000-0000-0000-0000-0c10d0006003', 'heatNumber', 2, 'name', 'Bronze Couples Two Step (2)',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008012'))),
      jsonb_build_object('divisionId', pg_temp.u('003004'), 'roundId', '00000000-0000-0000-0000-0c10d0006004', 'heatNumber', 2, 'name', 'ProPro I Two Step (2)',
        'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008005'))))),
    jsonb_build_object('number', 5, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003005'), 'roundId', '00000000-0000-0000-0000-0c10d0006005', 'heatNumber', 1, 'name', 'Team Open',
        'danceIds', '[]'::jsonb, 'entryIds', jsonb_build_array(pg_temp.u('008006'))))),
    jsonb_build_object('number', 6, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003006'), 'roundId', '00000000-0000-0000-0000-0c10d0006006', 'heatNumber', 1, 'name', 'J&J Novice',
        'danceIds', jsonb_build_array(pg_temp.u('004003')), 'entryIds', jsonb_build_array(pg_temp.u('008007'))))),
    jsonb_build_object('number', 7, 'scoringHeats', jsonb_build_array(
      jsonb_build_object('divisionId', pg_temp.u('003007'), 'roundId', '00000000-0000-0000-0000-0c10d0006007', 'heatNumber', 1, 'name', 'Showcase Open',
        'danceIds', '[]'::jsonb, 'entryIds', jsonb_build_array(pg_temp.u('008008')))))
  ));
$$;
grant execute on function pg_temp.plan() to authenticated;

-- Variant: replaces one scoring heat's entry list (heat index i in floor heat f, 0-based).
create or replace function pg_temp.plan_with(p_floor int, p_score int, p_entries jsonb) returns jsonb language sql stable as $$
  select jsonb_set(pg_temp.plan(), array['floorHeats', p_floor::text, 'scoringHeats', p_score::text, 'entryIds'], p_entries);
$$;
grant execute on function pg_temp.plan_with(int, int, jsonb) to authenticated;

-- (18) not-schedulable entries are refused by the authority
select pg_temp.expect_msg('18 withdrawn entry cannot be scheduled',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(0, 0, jsonb_build_array(pg_temp.u('008001'), pg_temp.u('008009'))))$q$, 'COMP10D_ENTRY_NOT_SCHEDULABLE');
select pg_temp.expect_msg('18 ineligible entry cannot be scheduled',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(0, 0, jsonb_build_array(pg_temp.u('008010'))))$q$, 'COMP10D_ENTRY_NOT_SCHEDULABLE');
select pg_temp.expect_msg('18 pending entry cannot be scheduled',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(2, 0, jsonb_build_array(pg_temp.u('008011'))))$q$, 'COMP10D_ENTRY_NOT_SCHEDULABLE');
select pg_temp.expect_msg('entry from another division is refused',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(0, 0, jsonb_build_array(pg_temp.u('008002'))))$q$, 'COMP10D_PLAN_INVALID');
select pg_temp.expect_msg('16 cross-event division in a plan is refused',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_set(pg_temp.plan(), '{floorHeats,0,scoringHeats,0,divisionId}', to_jsonb(pg_temp.u('003009'))))$q$, 'COMP10D_PLAN_INVALID');
select pg_temp.expect_msg('per-dance division: entry must be registered for the dance',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_set(pg_temp.plan(), '{floorHeats,0,scoringHeats,0,danceIds}', jsonb_build_array(pg_temp.u('004002'))))$q$, 'not registered for this dance');
select pg_temp.expect_msg('6 shared ProPro instructor cannot share a scoring heat',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(2, 1, jsonb_build_array(pg_temp.u('008004'), pg_temp.u('008005'))) #- '{floorHeats,3,scoringHeats,1}')$q$, 'COMP10D_COMPETITOR_CONFLICT');
select pg_temp.expect_msg('7 shared Couples dancer cannot share a scoring heat',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan_with(2, 0, jsonb_build_array(pg_temp.u('008003'), pg_temp.u('008012'))) #- '{floorHeats,3,scoringHeats,0}')$q$, 'Alex Morgan');
select pg_temp.expect_msg('plan numbers must run 1..n',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_set(pg_temp.plan(), '{floorHeats,1,number}', '5'))$q$, 'COMP10D_PLAN_INVALID');
select pg_temp.expect_msg('unauthorized organizer cannot apply a plan',
  $q$select pg_temp.as_user(pg_temp.u('000004')); select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan())$q$, 'COMP10D_NOT_FOUND');
select pg_temp.as_user(pg_temp.u('000001'));

-- (1)(2) the valid plan applies
select pg_temp.expect_ok('1 plan applies (final-only divisions generate scoring heats)',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan())$q$);
select pg_temp.chk('1 seven numbered heats, nine scoring heats, nine entries placed',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 7
  and pg_temp.n($q$select count(*) from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and floor_heat_id is not null$q$) = 9
  and pg_temp.n($q$select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.schedule_version_id = pg_temp.id('v1')$q$) = 9);
select pg_temp.chk('1 scoring heats sit in the division''s final round',
  not exists (select 1 from public.event_competition_heats h join public.event_competition_rounds r on r.id = h.round_id
              where h.schedule_version_id = pg_temp.id('v1') and (r.round_type <> 'final' or r.division_id <> h.division_id)));
select pg_temp.chk('2 Bronze Couples and ProPro Two Step share heat 3',
  pg_temp.n($q$select count(*) from public.event_competition_heats where floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 3)$q$) = 2);
select pg_temp.chk('9 J&J heat holds one single-participant entry with lead/follow, no pairing',
  pg_temp.n($q$select count(*) from public.event_competition_heat_entries where heat_id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003006'))$q$) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_entry_participants where entry_id = pg_temp.u('008007') and dance_role = 'leader'$q$) = 1);
select pg_temp.chk('the version has no problems', pg_temp.n($q$select count(*) from public.competition_floor_schedule_problems(pg_temp.id('v1'))$q$) = 0);
select pg_temp.expect_msg('a second generation needs the plan cleared first',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), pg_temp.plan())$q$, 'COMP10D_PLAN_EXISTS');

-- (3)(4)(11) music/run compatibility is a hard rule
select pg_temp.expect_msg('3 J&J West Coast Swing cannot join a Two Step heat',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003006')), pg_temp.fh(pg_temp.id('v1'), 3))$q$, 'COMP10D_INCOMPATIBLE_MUSIC');
select pg_temp.expect_msg('4 a routine (showcase) is exclusive: cannot join a Two Step heat',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003007')), pg_temp.fh(pg_temp.id('v1'), 1))$q$, 'COMP10D_INCOMPATIBLE_MUSIC');
select pg_temp.expect_msg('4 two routines cannot share a heat',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003007')), pg_temp.fh(pg_temp.id('v1'), 5))$q$, 'COMP10D_INCOMPATIBLE_MUSIC');
select pg_temp.expect_msg('11 a direct floor-heat change cannot bypass compatibility either',
  $q$update public.event_competition_heats set floor_heat_id = pg_temp.fh(pg_temp.id('v1'), 3) where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003006'))$q$, 'COMP10D_INCOMPATIBLE_MUSIC');

-- (5)(8) competitor conflicts on manual moves
select pg_temp.expect_msg('5 shared ProAm professional: moving Newcomer into heat 2 conflicts',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001')), pg_temp.fh(pg_temp.id('v1'), 2))$q$, 'Pat Pro is dancing in more than one entry');
select pg_temp.expect_msg('6 shared ProPro instructor: heat 4 ProPro cannot join heat 3',
  $q$select public.move_competition_scoring_heat((select id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003004') and heat_number = 2), pg_temp.fh(pg_temp.id('v1'), 3))$q$, 'Ivy Instructor');
select pg_temp.expect_msg('7 shared Couples dancer: second Bronze Couples heat cannot join heat 3',
  $q$select public.move_competition_scoring_heat((select id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003003') and heat_number = 2), pg_temp.fh(pg_temp.id('v1'), 3))$q$, 'Alex Morgan');
select pg_temp.expect_msg('8 team member also in a couple: team cannot join the couples heat (conflict reported first)',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003005')), pg_temp.fh(pg_temp.id('v1'), 3))$q$, 'COMP10D_COMPETITOR_CONFLICT: Alex Morgan');
select pg_temp.expect_msg('H direct heat-entry insert cannot double-book a competitor in a floor heat',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
     values (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003003')), pg_temp.u('008012'), 2)$q$, 'COMP10D_COMPETITOR_CONFLICT');

-- (10) moving a scoring heat to a compatible, conflict-free heat works and empties/closes the gap
select pg_temp.expect_ok('10 Intermediate ProAm moves into heat 4 (no shared people)',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003002')), pg_temp.fh(pg_temp.id('v1'), 4))$q$);
select pg_temp.chk('10 the emptied heat 2 is removed and heats renumber 1..6',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 6
  and pg_temp.n($q$select max(heat_number) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 6
  and pg_temp.n($q$select count(*) from public.competition_floor_schedule_problems(pg_temp.id('v1'))$q$) = 0);
select pg_temp.expect_ok('10 move a scoring heat into a new heat at position 2',
  $q$select public.move_competition_scoring_heat_to_new_floor_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003002')), 2)$q$);
select pg_temp.chk('10 seven heats again, Intermediate ProAm alone in heat 2',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 7
  and (select floor_heat_id from public.event_competition_heats where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003002'))) = pg_temp.fh(pg_temp.id('v1'), 2));

-- (12) reordering keeps every assignment
insert into t_ids select 'snapshot_before', md5(string_agg(h.id::text || ':' || h.floor_heat_id::text, ',' order by h.id))::uuid
from public.event_competition_heats h where h.schedule_version_id = pg_temp.id('v1');
insert into t_ids values ('fh7', pg_temp.fh(pg_temp.id('v1'), 7));
select pg_temp.expect_ok('12 move heat 7 to position 1', $q$select public.move_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 7), 1)$q$);
select pg_temp.chk('12 former heat 7 is now heat 1 and numbers stay 1..7',
  pg_temp.fh(pg_temp.id('v1'), 1) = pg_temp.id('fh7')
  and pg_temp.n($q$select count(distinct heat_number) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1') and heat_number between 1 and 7$q$) = 7);
select pg_temp.chk('12 reordering preserved every scoring-heat placement',
  (select md5(string_agg(h.id::text || ':' || h.floor_heat_id::text, ',' order by h.id))::uuid
   from public.event_competition_heats h where h.schedule_version_id = pg_temp.id('v1')) = pg_temp.id('snapshot_before'));

-- (13) insert / delete resequence
select pg_temp.expect_ok('13 insert an empty heat at 3', $q$select public.insert_competition_floor_heat(pg_temp.id('v1'), 3)$q$);
select pg_temp.chk('13 eight contiguous heats',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 8
  and pg_temp.n($q$select max(heat_number) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 8);
select pg_temp.expect_msg('13 a heat with divisions cannot be deleted',
  $q$select public.delete_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1))$q$, 'COMP10D_HEAT_NOT_EMPTY');
select pg_temp.expect_msg('publishing refuses an empty heat',
  $q$select public.publish_competition_schedule_version(pg_temp.id('v1'))$q$, 'COMP10D_EMPTY_FLOOR_HEAT');
select pg_temp.expect_ok('13 delete the empty heat 3', $q$select public.delete_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 3))$q$);
select pg_temp.chk('13 back to seven contiguous heats',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 7
  and pg_temp.n($q$select max(heat_number) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 7);
select pg_temp.expect_msg('heat numbers out of range are refused',
  $q$select public.move_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 1), 9)$q$, 'COMP10D_HEAT_NUMBERS');

-- capacity (DanceFlow default 8; editable per round)
select pg_temp.expect_msg('capacity must be 1..100',
  $q$select public.set_competition_round_heat_capacity('00000000-0000-0000-0000-0c10d0006003', 0)$q$, 'COMP10D_CAPACITY');
select pg_temp.expect_ok('capacity is editable per round',
  $q$select public.set_competition_round_heat_capacity('00000000-0000-0000-0000-0c10d0006003', 12)$q$);
select pg_temp.chk('capacity stored on the round',
  (select configuration->>'max_entries_per_heat' from public.event_competition_rounds where id = '00000000-0000-0000-0000-0c10d0006003') = '12');

-- (16)(17) cross-event / cross-version / cross-competition placement (as postgres to bypass the RPC layer)
reset role;
select pg_temp.expect_msg('16 a heat cannot join another event''s floor heat',
  $q$insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number) values (pg_temp.u('00e002'), pg_temp.id('v9'), 1);
     update public.event_competition_heats set floor_heat_id = (select id from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v9'))
     where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'event_competition_heats_floor_heat_fk');
select pg_temp.expect_ok('setup: second draft version of the same event', $q$insert into t_ids values ('v2', (select public.create_competition_schedule_version(pg_temp.u('00e001'), 'scratch v2', null)))$q$);
select pg_temp.expect_msg('wrong-version: a heat cannot join a floor heat of another version',
  $q$insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number) values (pg_temp.u('00e001'), pg_temp.id('v2'), 1);
     update public.event_competition_heats set floor_heat_id = pg_temp.fh(pg_temp.id('v2'), 1) where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'event_competition_heats_floor_heat_fk');
select pg_temp.expect_msg('17 a scoring heat''s contest must match its division',
  $q$update public.event_competition_heats set contest_id = pg_temp.u('002002') where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'Heat contest must match');
select pg_temp.expect_msg('17 an entry of another division cannot be placed in a scoring heat',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001')), pg_temp.u('008002'))$q$, 'event_competition_heat_entries_entry_fk');
select pg_temp.expect_msg('17 an entry of another event cannot be placed in a scoring heat',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001')), pg_temp.u('008019'))$q$, 'event_competition_heat_entries_entry_fk');
select pg_temp.expect_msg('duplicate floor-heat numbers are refused',
  $q$insert into public.event_competition_floor_heats (event_id, schedule_version_id, heat_number) values (pg_temp.u('00e001'), pg_temp.id('v1'), 1)$q$, 'event_competition_floor_heats_number_key');
select pg_temp.expect_msg('a heat uses a floor heat or a block, not both',
  $q$update public.event_competition_heats set schedule_block_id = gen_random_uuid() where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'COMP10D_PLACEMENT');
select pg_temp.chk('organizers cannot write floor heats directly (RPC only)',
  not has_table_privilege('authenticated', 'public.event_competition_floor_heats', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_floor_heats', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.event_competition_floor_heats', 'DELETE')
  and not has_table_privilege('anon', 'public.event_competition_floor_heats', 'SELECT'));
select pg_temp.chk('internal validation helpers are not callable by API roles',
  not has_function_privilege('authenticated', 'public._comp10d_floor_heat_problems(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._comp10d_heat_music_key(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_competition_floor_plan(uuid,jsonb)', 'EXECUTE'));

-- (14) publish freezes the running order; (19) snapshot carries numbers, entries, competitor roles
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('14 publish the floor-heat schedule (no sessions needed)',
  $q$select public.publish_competition_schedule_version(pg_temp.id('v1'))$q$);
select pg_temp.chk('14 published with a snapshot of 7 numbered heats',
  (select status from public.event_competition_schedule_versions where id = pg_temp.id('v1')) = 'published'
  and (select jsonb_array_length(snapshot->'floor_heats') from public.event_competition_schedule_publications where schedule_version_id = pg_temp.id('v1')) = 7);
select pg_temp.chk('19 snapshot keeps entry numbers and lead/follow of every competitor',
  exists (select 1 from public.event_competition_schedule_publications p,
                 jsonb_array_elements(p.snapshot->'floor_heats') f, jsonb_array_elements(f->'scoring_heats') s,
                 jsonb_array_elements(s->'entries') e, jsonb_array_elements(e->'competitors') c
          where p.schedule_version_id = pg_temp.id('v1') and e->>'entry_number' = '101' and c->>'name' = 'Pat Pro' and c->>'dance_role' = 'leader'));
select pg_temp.expect_msg('14 a published heat cannot move', $q$select public.move_competition_floor_heat(pg_temp.fh(pg_temp.id('v1'), 2), 1)$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_msg('14 a published scoring heat cannot change heat', $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001')), pg_temp.fh(pg_temp.id('v1'), 2))$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_msg('14 a published schedule cannot gain heats', $q$select public.insert_competition_floor_heat(pg_temp.id('v1'), 1)$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_msg('14 a published schedule cannot be cleared', $q$select public.clear_competition_floor_plan(pg_temp.id('v1'))$q$, 'COMP10D_SCHEDULE_PUBLISHED');
reset role;
select pg_temp.expect_msg('14 even the owner role cannot renumber a published heat directly',
  $q$update public.event_competition_floor_heats set notes = 'x' where id = pg_temp.fh(pg_temp.id('v1'), 1)$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_msg('14 a published scoring heat cannot be reassigned directly',
  $q$delete from public.event_competition_heat_entries where heat_id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_msg('14 a published scoring heat cannot be deleted directly',
  $q$delete from public.event_competition_heats where id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$, 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.expect_ok('14 day-of status updates stay allowed on a published heat (check-in / danced)',
  $q$update public.event_competition_heat_entries set status = 'checked_in' where heat_id = pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003001'))$q$);

-- (15) a new version copies the running order and is editable
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('15 create a new version from the published one',
  $q$insert into t_ids values ('v3', (select public.create_competition_schedule_version(pg_temp.u('00e001'), 'Heats v3', pg_temp.id('v1'))))$q$);
select pg_temp.chk('15 the new draft carries the same 7 heats, 9 scoring heats and 9 entries',
  (select status from public.event_competition_schedule_versions where id = pg_temp.id('v3')) = 'draft'
  and pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v3')$q$) = 7
  and pg_temp.n($q$select count(*) from public.event_competition_heats where schedule_version_id = pg_temp.id('v3')$q$) = 9
  and pg_temp.n($q$select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.schedule_version_id = pg_temp.id('v3')$q$) = 9);
select pg_temp.expect_ok('15 the copy is editable', $q$select public.move_competition_floor_heat(pg_temp.fh(pg_temp.id('v3'), 2), 1)$q$);
select pg_temp.chk('15 the published original is untouched',
  pg_temp.n($q$select count(*) from public.event_competition_floor_heats where schedule_version_id = pg_temp.id('v1')$q$) = 7
  and pg_temp.fh(pg_temp.id('v1'), 1) = pg_temp.id('fh7'));
select pg_temp.expect_ok('15 clearing the draft removes only its own heats', $q$select public.clear_competition_floor_plan(pg_temp.id('v3'))$q$);
select pg_temp.chk('15 cleared draft is empty, published untouched',
  pg_temp.n($q$select count(*) from public.event_competition_heats where schedule_version_id = pg_temp.id('v3')$q$) = 0
  and pg_temp.n($q$select count(*) from public.event_competition_heats where schedule_version_id = pg_temp.id('v1')$q$) = 9);

-- (4) a spotlight is exclusive even with a single prescribed dance (own-music contest type)
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('4 setup: draft v4 with a Two Step spotlight and a Two Step couples heat',
  $q$insert into t_ids values ('v4', (select public.create_competition_schedule_version(pg_temp.u('00e001'), 'v4', null)));
     select public.apply_competition_floor_plan(pg_temp.id('v4'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003008'),
         'roundId', '00000000-0000-0000-0000-0c10d0006008', 'heatNumber', 1, 'name', 'Spotlight', 'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', '[]'::jsonb))),
       jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003003'),
         'roundId', '00000000-0000-0000-0000-0c10d0006003', 'heatNumber', 1, 'name', 'Bronze Couples Two Step', 'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008003'))))))))$q$);
select pg_temp.expect_msg('4 a single-dance spotlight still cannot share a heat',
  $q$select public.move_competition_scoring_heat(pg_temp.sh(pg_temp.id('v4'), pg_temp.u('003008')), pg_temp.fh(pg_temp.id('v4'), 2))$q$, 'COMP10D_INCOMPATIBLE_MUSIC');
reset role;
select pg_temp.chk('music keys: single dance, prescribed set, exclusive routine and spotlight',
  public._comp10d_heat_music_key(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003003'))) = 'dance:two_step'
  and public._comp10d_heat_music_key(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003006'))) = 'dance:west_coast_swing'
  and public._comp10d_heat_music_key(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003007'))) like 'exclusive:%'
  and public._comp10d_heat_music_key(pg_temp.sh(pg_temp.id('v1'), pg_temp.u('003005'))) like 'exclusive:%'
  and public._comp10d_heat_music_key(pg_temp.sh(pg_temp.id('v4'), pg_temp.u('003008'))) like 'exclusive:%');

-- (20) the ADVANCED time-block path still works under the same publication authority
reset role;
insert into public.event_competition_schedule_floors (id, event_id, name) values (pg_temp.u('009001'), pg_temp.u('00e002'), 'Main');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('20 advanced: session + block + scoring heat in the block, then publish',
  $q$insert into public.event_competition_schedule_sessions (id, event_id, schedule_version_id, name, session_date, starts_at, ends_at)
       values (pg_temp.u('009101'), pg_temp.u('00e002'), pg_temp.id('v9'), 'Day 1', current_date + 40, (current_date + 40) + time '09:00', (current_date + 40) + time '17:00');
     insert into public.event_competition_schedule_blocks (id, event_id, schedule_version_id, session_id, floor_id, name, block_type, starts_at, ends_at)
       values (pg_temp.u('009201'), pg_temp.u('00e002'), pg_temp.id('v9'), pg_temp.u('009101'), pg_temp.u('009001'), 'Morning', 'competition', (current_date + 40) + time '09:00', (current_date + 40) + time '12:00');
     insert into public.event_competition_schedule_block_contests (event_id, schedule_version_id, block_id, contest_id)
       values (pg_temp.u('00e002'), pg_temp.id('v9'), pg_temp.u('009201'), pg_temp.u('002009'));
     insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, schedule_block_id, floor_id, scheduled_at, estimated_ends_at, schedule_sequence)
       values (pg_temp.u('00e002'), pg_temp.u('003009'), '00000000-0000-0000-0000-0c10d0006009', 1, pg_temp.u('002009'), pg_temp.id('v9'), pg_temp.u('009201'), pg_temp.u('009001'),
               (current_date + 40) + time '09:00', (current_date + 40) + time '09:05', 1);
     select public.publish_competition_schedule_version(pg_temp.id('v9'))$q$);
select pg_temp.chk('20 advanced snapshot keeps sessions/blocks/heats and has no floor heats',
  (select jsonb_array_length(snapshot->'sessions') = 1 and jsonb_array_length(snapshot->'heats') = 1 and jsonb_array_length(snapshot->'floor_heats') = 0
   from public.event_competition_schedule_publications where schedule_version_id = pg_temp.id('v9')));
select pg_temp.expect_msg('20 advanced heats still need a block when not in a floor heat',
  $q$insert into t_ids values ('v10', (select public.create_competition_schedule_version(pg_temp.u('00e002'), 'v10', null)));
     insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id)
     values (pg_temp.u('00e002'), pg_temp.u('003009'), '00000000-0000-0000-0000-0c10d0006009', 2, pg_temp.u('002009'), pg_temp.id('v10'))$q$, 'A valid schedule block is required');
select pg_temp.expect_msg('20 an empty version still cannot publish',
  $q$insert into t_ids values ('v11', (select public.create_competition_schedule_version(pg_temp.u('00e002'), 'v11', null)));
     select public.publish_competition_schedule_version(pg_temp.id('v11'))$q$, 'Add at least one session, or generate floor heats');
reset role;

-- Cascades still work: deleting the whole event removes published floor heats.
select pg_temp.expect_ok('event delete cascades through published floor heats',
  $q$delete from public.events where id = pg_temp.u('00e001')$q$);
select pg_temp.chk('cascade removed the floor heats', pg_temp.n($q$select count(*) from public.event_competition_floor_heats where event_id = pg_temp.u('00e001')$q$) = 0);

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
    raise exception 'PHASE 10D SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10D SQL SUITE FAIL: %', v_failures;
end $$;
