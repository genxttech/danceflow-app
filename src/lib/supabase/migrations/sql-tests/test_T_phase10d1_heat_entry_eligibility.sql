-- Phase 10D.1 -- heat entry eligibility integrity regression suite.
--
-- Covers 20261112090000_phase10d1_heat_entry_eligibility.sql on top of 10D. Every placement probe is a
-- DIRECT write to public.event_competition_heat_entries as the authenticated studio owner (the June-era
-- competition_manage policy path), not the planner RPC. Deferred integrity checks are forced with
-- SET CONSTRAINTS ALL IMMEDIATE. One transaction; the final block ALWAYS raises, so nothing persists:
--   "PHASE 10D.1 SQL SUITE PASS (<n> checks)"  or  "PHASE 10D.1 SQL SUITE FAIL: <failures>".

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

-- An unexpected success is rolled back AND recorded (written after the subtransaction is undone).
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
language sql immutable as $$ select ('00000000-0000-0000-0000-0c10d1' || p_suffix)::uuid $$;
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
-- Direct placement of an entry into the Bronze Two Step scoring heat (as the current role).
create or replace function pg_temp.place(p_entry text) returns text
language sql as $$
  select format($f$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                   values (%L, %L, %L, %L, 9)$f$,
                pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.id('heat'), pg_temp.u(p_entry));
$$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-p10d1-owner@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-p10d1-owner@example.test', 'Owner');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'P10D1 Studio', 't-p10d1-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.u('00e001'), pg_temp.u('00a001'), 'P10D1 Comp', 't-p10d1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_contest_registration_rules (event_id, program_id, contest_id, dance_selection_mode, pricing_method, minimum_participants, maximum_participants)
select pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'individual', 'flat_entry', 1, 10
where not exists (select 1 from public.event_competition_contest_registration_rules where contest_id = pg_temp.u('002001'));
update public.event_competition_contest_registration_rules set dance_selection_mode = 'individual' where contest_id = pg_temp.u('002001');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Silver Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1);
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step'),
  (pg_temp.u('004002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'waltz', 'Waltz');
insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004002'), 1);

-- One competitor per status so no probe can fail on a conflict instead of eligibility.
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via)
select pg_temp.u('0070' || lpad(n::text, 2, '0')), pg_temp.u('00e001'), 'Dancer', 'N' || n, 'staff' from generate_series(1, 14) n;

-- Entry statuses: every value the schema allows (pending, confirmed, waitlisted, scratched, withdrawn,
-- disqualified, complete) plus the eligibility values that matter.
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Placed Confirmed', 'confirmed', 'eligible'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Second Confirmed', 'confirmed', 'eligible'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Pending Entry', 'pending', 'unverified'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Waitlisted Entry', 'waitlisted', 'unverified'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Withdrawn Entry', 'withdrawn', 'eligible'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Disqualified Entry', 'disqualified', 'eligible'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Complete Entry', 'complete', 'eligible'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Scratched Entry', 'scratched', 'eligible'),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Ineligible Entry', 'confirmed', 'ineligible'),
  (pg_temp.u('008010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Needs Review Entry', 'confirmed', 'needs_review'),
  (pg_temp.u('008011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Shares Dancer 1', 'confirmed', 'eligible'),
  (pg_temp.u('008012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Silver Waltz', 'confirmed', 'eligible');
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
select pg_temp.u('00e001'), e.id, pg_temp.u('0070' || lpad(right(e.id::text, 2)::int::text, 2, '0')), 'dancer', 'leader', e.display_name
from public.event_competition_entries e where e.id::text like '00000000-0000-0000-0000-0c10d1%' and e.id <> pg_temp.u('008011');
-- Entry 11 shares Dancer N1 with entry 1 (conflict probes).
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
values (pg_temp.u('00e001'), pg_temp.u('008011'), pg_temp.u('007001'), 'dancer', 'leader', 'Dancer N1');
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select e.event_id, e.id, case when e.division_id = pg_temp.u('003001') then pg_temp.u('005011') else pg_temp.u('005021') end, 'offering', 'Offering'
from public.event_competition_entries e where e.id::text like '00000000-0000-0000-0000-0c10d1%';

-- ============================================================================
-- Planner apply still works (regression) -- creates Heat 1 Two Step and Heat 2 Waltz
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'v1', null));
select pg_temp.expect_ok('planner apply still works (confirmed entries)',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'),
         'heatNumber', 1, 'name', 'Bronze Two Step', 'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008001'))))),
       jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', pg_temp.u('006002'),
         'heatNumber', 1, 'name', 'Silver Waltz', 'danceIds', jsonb_build_array(pg_temp.u('004002')), 'entryIds', jsonb_build_array(pg_temp.u('008012'))))))))$q$);
insert into t_ids select 'heat', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003001');
insert into t_ids select 'heat_silver', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003002');
select pg_temp.expect_msg('planner apply still refuses a withdrawn entry early',
  $q$insert into t_ids values ('v2', (select public.create_competition_schedule_version(pg_temp.u('00e001'), 'v2', null)));
     select public.apply_competition_floor_plan(pg_temp.id('v2'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'),
         'heatNumber', 1, 'name', 'x', 'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008005'))))))))$q$, 'COMP10D_ENTRY_NOT_SCHEDULABLE');

-- ============================================================================
-- Direct authenticated-manager writes (the competition_manage policy path)
-- ============================================================================
select pg_temp.chk('the probes run as the authenticated studio owner with direct table rights',
  current_user = 'authenticated'
  and has_table_privilege('authenticated', 'public.event_competition_heat_entries', 'INSERT')
  and public.can_manage_event_competition(pg_temp.u('00e001')));

select pg_temp.expect_ok('valid: a confirmed, eligible entry can be placed directly', pg_temp.place('008002'));
select pg_temp.expect_ok('valid: confirmed + needs_review (not ineligible) can be placed', pg_temp.place('008010'));
select pg_temp.expect_msg('pending entry rejected', pg_temp.place('008003'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Pending Entry');
select pg_temp.expect_msg('waitlisted entry rejected', pg_temp.place('008004'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Waitlisted Entry');
select pg_temp.expect_msg('withdrawn entry rejected', pg_temp.place('008005'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Withdrawn Entry');
select pg_temp.expect_msg('disqualified entry rejected', pg_temp.place('008006'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Disqualified Entry');
select pg_temp.expect_msg('complete entry rejected', pg_temp.place('008007'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Complete Entry');
select pg_temp.expect_msg('scratched (entry-level) entry rejected', pg_temp.place('008008'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Scratched Entry');
select pg_temp.expect_msg('confirmed but ineligible entry rejected', pg_temp.place('008009'), 'COMP10D_ENTRY_NOT_SCHEDULABLE: Ineligible Entry');
select pg_temp.expect_msg('re-pointing an existing placement at a withdrawn entry is rejected',
  $q$update public.event_competition_heat_entries set entry_id = pg_temp.u('008005') where entry_id = pg_temp.u('008002') and heat_id = pg_temp.id('heat')$q$,
  'COMP10D_ENTRY_NOT_SCHEDULABLE');

-- ============================================================================
-- Regressions: conflicts, music, ownership
-- ============================================================================
select pg_temp.expect_msg('conflict regression: an eligible entry sharing an active dancer is still refused',
  pg_temp.place('008011'), 'COMP10D_COMPETITOR_CONFLICT');
select pg_temp.expect_msg('music regression: Silver Waltz cannot join the Two Step heat',
  $q$select public.move_competition_scoring_heat(pg_temp.id('heat_silver'), (select floor_heat_id from public.event_competition_heats where id = pg_temp.id('heat')))$q$,
  'COMP10D_INCOMPATIBLE_MUSIC');
select pg_temp.expect_msg('division regression: an entry of another division cannot be placed',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.id('heat'), pg_temp.u('008012'))$q$,
  'event_competition_heat_entries_entry_fk');

-- ============================================================================
-- Scratched placements: a day-of state, not entry eligibility
-- ============================================================================
-- Withdraw a placed entry through the June lifecycle workflow: its placement is scratched (status-only
-- update of an entry that is no longer confirmed) -- that must keep working.
select pg_temp.expect_ok('withdrawing a placed entry scratches its placement (status-only update allowed)',
  $q$select public.change_competition_entry_lifecycle(pg_temp.u('008001'), 'withdrawn', 'Injury', 'retain')$q$);
select pg_temp.chk('the placement of the withdrawn entry is scratched, not deleted',
  (select status from public.event_competition_heat_entries where entry_id = pg_temp.u('008001')) = 'scratched');
select pg_temp.expect_ok('scratched placements still do not count as active floor conflicts',
  pg_temp.place('008011'));
select pg_temp.expect_ok('day-of status updates on placements stay allowed',
  $q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = pg_temp.u('008002') and heat_id = pg_temp.id('heat')$q$);

reset role;
select pg_temp.chk('the rule lives in the existing 10D integrity function (no second validator)',
  position('COMP10D_ENTRY_NOT_SCHEDULABLE' in pg_get_functiondef('public._comp10d_check_floor_heat_integrity()'::regprocedure)) > 0
  and (select count(*) from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and not tgisinternal) = 4);
select pg_temp.chk('the integrity function is not callable by API roles',
  not has_function_privilege('authenticated', 'public._comp10d_check_floor_heat_integrity()', 'EXECUTE')
  and not has_function_privilege('anon', 'public._comp10d_check_floor_heat_integrity()', 'EXECUTE'));

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
    raise exception 'PHASE 10D.1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10D.1 SQL SUITE FAIL: %', v_failures;
end $$;
