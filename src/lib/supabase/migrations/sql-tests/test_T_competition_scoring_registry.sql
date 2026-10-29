-- Competition REG -- scoring-method registry regression suite.
--
-- Covers 20270113090000_competition_scoring_registry.sql on top of 10B/10C.5. One transaction; the final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION REG SQL SUITE PASS (<n> checks)"  or  "COMPETITION REG SQL SUITE FAIL: <failures>".

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
language sql immutable as $$ select ('00000000-0000-0000-0000-0c0e60' || p_suffix)::uuid $$;
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
create or replace function pg_temp.as_postgres() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres): two tenants, each with a competition
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-reg-owner-a@example.test'),
  (pg_temp.u('000002'), 't-reg-owner-b@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-reg-owner-a@example.test', 'Owner A'),
  (pg_temp.u('000002'), 't-reg-owner-b@example.test', 'Owner B');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'REG Studio A', 't-reg-studio-a'),
  (pg_temp.u('00a002'), 'REG Studio B', 't-reg-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000002'), pg_temp.u('00a002'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'REG Comp A', 't-reg-a1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a002'), 'REG Comp B', 't-reg-b1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e003'), pg_temp.u('00a001'), 'REG Comp A2', 't-reg-a2', 'competition', current_date + 40, current_date + 40, 'draft', 'private', false);

-- Event A: studio_simple@1 program (the lock path needs a profile), 2 divisions, 4 rounds with legacy methods.
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, rules_profile_key, rules_profile_version) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Studio A', 'showcase', 'relative', 'ordinal_majority', 'draft', 'studio_simple', 1),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00a002'), 'Studio B', 'showcase', 'relative', 'ordinal_majority', 'draft', 'studio_simple', 1),
  (pg_temp.u('001003'), pg_temp.u('00e003'), pg_temp.u('00a001'), 'Studio A2', 'showcase', 'relative', 'ordinal_majority', 'draft', 'studio_simple', 1);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples A', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Couples B', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002003'), pg_temp.u('00e003'), pg_temp.u('001003'), 'Couples A2', 'single_dance', 'couple', 'open');
insert into public.event_competition_contest_registration_rules (event_id, program_id, contest_id, dance_selection_mode, pricing_method, minimum_participants, maximum_participants)
select e, p, c, 'individual', 'flat_entry', 1, 10
from (values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001')),
             (pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002')),
             (pg_temp.u('00e003'), pg_temp.u('001003'), pg_temp.u('002003'))) v(e, p, c)
where not exists (select 1 from public.event_competition_contest_registration_rules r where r.contest_id = v.c);
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze A', 'draft'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Silver A', 'draft'),
  (pg_temp.u('003003'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'Bronze B', 'draft'),
  (pg_temp.u('003004'), pg_temp.u('00e003'), pg_temp.u('001003'), pg_temp.u('002003'), 'Bronze A2', 'draft');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, scoring_method) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Callback', 'preliminary', 1, 'callback_tally'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 2, 'ordinal_majority'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1, 'custom'),
  (pg_temp.u('006004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Other', 'qualifying', 2, 'ordinal_majority'),
  (pg_temp.u('006005'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003003'), 'Final', 'final', 1, 'ordinal_majority');

-- ============================================================================
-- Registry content
-- ============================================================================
select pg_temp.chk('registry seeds six entries', (select count(*) from public.competition_scoring_methods) = 6);
select pg_temp.chk('exactly the two studio methods are approved',
  (select string_agg(method_key || '@' || method_version, ',' order by method_key) from public.competition_scoring_methods where status = 'approved')
    = 'studio_callback_tally@1,studio_ordinal_majority@1');
select pg_temp.chk('UCWDC v16.9b is unavailable with no engine and a pinned source hash',
  exists (select 1 from public.competition_scoring_methods
          where method_key = 'ucwdc_majority_rules' and method_version = 'v16.9b' and status = 'unavailable' and engine_id is null
            and source_pins->0->>'sha256' = '44290a06d14c308087039bce8d57258629ae103734cce08eb21f41bdb667b02f'));
select pg_temp.chk('proficiency_rating is rejected (kept, not deleted)',
  (select status from public.competition_scoring_methods where method_key = 'proficiency_rating' and method_version = '1') = 'rejected');
select pg_temp.chk('NDCA and WSDC are unavailable placeholders',
  (select count(*) from public.competition_scoring_methods where method_key in ('ndca_skating', 'wsdc_relative_placement') and status = 'unavailable') = 2);
select pg_temp.chk('no non-approved entry has an engine, ballot formats or purposes',
  not exists (select 1 from public.competition_scoring_methods
              where status <> 'approved' and (engine_id is not null or cardinality(accepted_ballot_formats) > 0 or cardinality(result_purposes) > 0)));
select pg_temp.chk('approved entries accept exactly their ballot formats and use the studio X-3 panel rule',
  (select accepted_ballot_formats from public.competition_scoring_methods where method_key = 'studio_ordinal_majority') = array['ordinal_rank@1']
  and (select accepted_ballot_formats from public.competition_scoring_methods where method_key = 'studio_callback_tally') = array['callback_yes@1']
  and not exists (select 1 from public.competition_scoring_methods where status = 'approved' and panel_rule <> 'studio_x3'));
select pg_temp.chk('legacy map holds exactly the three explicit mappings',
  (select string_agg(legacy_value || '>' || method_key || '@' || method_version, ',' order by legacy_value) from public.competition_scoring_legacy_map)
    = 'callback_tally>studio_callback_tally@1,ordinal_majority>studio_ordinal_majority@1,proficiency_rating>proficiency_rating@1');
select pg_temp.chk('majority_rules is not mapped to UCWDC (or anything)',
  not exists (select 1 from public.competition_scoring_legacy_map where legacy_value in ('majority_rules', 'skating', 'wsdc_callback', 'relative_placement', 'custom', 'none')));
select pg_temp.expect_msg('registry rows cannot be updated, even by postgres',
  $q$update public.competition_scoring_methods set status = 'approved' where method_key = 'ucwdc_majority_rules'$q$, 'append-only');
select pg_temp.expect_msg('registry rows cannot be deleted',
  $q$delete from public.competition_scoring_methods where method_key = 'ndca_skating'$q$, 'append-only');
select pg_temp.expect_msg('registry cannot be truncated',
  $q$truncate public.competition_scoring_methods cascade$q$, 'append-only');
select pg_temp.expect_msg('legacy map cannot be updated', $q$update public.competition_scoring_legacy_map set method_version = '1'$q$, 'append-only');
select pg_temp.chk('API roles cannot write the registry or the map',
  not has_table_privilege('authenticated', 'public.competition_scoring_methods', 'INSERT')
  and not has_table_privilege('authenticated', 'public.competition_scoring_methods', 'UPDATE')
  and not has_table_privilege('service_role', 'public.competition_scoring_methods', 'INSERT')
  and not has_table_privilege('authenticated', 'public.competition_scoring_legacy_map', 'INSERT')
  and not has_table_privilege('anon', 'public.competition_scoring_methods', 'SELECT'));
select pg_temp.chk('existing rows were not backfilled',
  (select count(*) from public.event_competition_divisions where scoring_method_key is not null) = 0
  and (select count(*) from public.event_competition_rounds where scoring_override_key is not null) = 0
  and (select count(*) from public.events where competition_sanctioning <> 'none') = 0);
select pg_temp.chk('legacy round scoring_method values are untouched',
  (select string_agg(scoring_method, ',' order by id) from public.event_competition_rounds where event_id = pg_temp.u('00e001'))
    = 'callback_tally,ordinal_majority,custom,ordinal_majority');

-- ============================================================================
-- Selection guard (owner of studio A, draft program)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the probes run as the authenticated studio owner', current_user = 'authenticated' and public.can_manage_event_competition(pg_temp.u('00e001')));

select pg_temp.expect_ok('select the approved ordinal method for a division',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '1' where id = pg_temp.u('003001')$q$);
select pg_temp.expect_ok('override one round with the approved callback method',
  $q$update public.event_competition_rounds set scoring_override_key = 'studio_callback_tally', scoring_override_version = '1' where id = pg_temp.u('006001')$q$);
select pg_temp.expect_msg('UCWDC cannot be selected for a division',
  $q$update public.event_competition_divisions set scoring_method_key = 'ucwdc_majority_rules', scoring_method_version = 'v16.9b' where id = pg_temp.u('003002')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('UCWDC cannot be a round override',
  $q$update public.event_competition_rounds set scoring_override_key = 'ucwdc_majority_rules', scoring_override_version = 'v16.9b' where id = pg_temp.u('006003')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('rejected proficiency_rating cannot be selected',
  $q$update public.event_competition_divisions set scoring_method_key = 'proficiency_rating', scoring_method_version = '1' where id = pg_temp.u('003002')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('NDCA cannot be selected',
  $q$update public.event_competition_divisions set scoring_method_key = 'ndca_skating', scoring_method_version = 'unpinned' where id = pg_temp.u('003002')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('WSDC cannot be selected',
  $q$update public.event_competition_rounds set scoring_override_key = 'wsdc_relative_placement', scoring_override_version = 'unpinned' where id = pg_temp.u('006003')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('an unknown method is refused',
  $q$update public.event_competition_divisions set scoring_method_key = 'made_up', scoring_method_version = '1' where id = pg_temp.u('003002')$q$, 'COMP_METHOD_UNKNOWN');
select pg_temp.expect_msg('an unknown version of an approved method is refused',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '2' where id = pg_temp.u('003002')$q$, 'COMP_METHOD_UNKNOWN');
select pg_temp.expect_msg('a key without a version violates the pair check',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority' where id = pg_temp.u('003002')$q$, 'scoring_pair_check');
select pg_temp.expect_msg('a new division cannot be INSERTED with an unavailable method',
  $q$insert into public.event_competition_divisions (event_id, program_id, contest_id, name, scoring_method_key, scoring_method_version)
     values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bad', 'ucwdc_majority_rules', 'v16.9b')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_ok('a draft selection can be cleared',
  $q$update public.event_competition_divisions set scoring_method_key = null, scoring_method_version = null where id = pg_temp.u('003001')$q$);
select pg_temp.expect_ok('and re-selected',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '1' where id = pg_temp.u('003001')$q$);
select pg_temp.expect_ok('unrelated division edits are unaffected by the guard',
  $q$update public.event_competition_divisions set name = 'Bronze A (renamed)' where id = pg_temp.u('003002')$q$);

-- ============================================================================
-- Tenant isolation (owner of studio B)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.chk('owner B cannot see studio A divisions or rounds',
  (select count(*) from public.event_competition_divisions where event_id = pg_temp.u('00e001')) = 0);
update public.event_competition_divisions set scoring_method_key = 'studio_callback_tally', scoring_method_version = '1' where id = pg_temp.u('003002');
update public.event_competition_rounds set scoring_override_key = 'studio_callback_tally', scoring_override_version = '1' where id = pg_temp.u('006003');
select pg_temp.as_postgres();
select pg_temp.chk('owner B writes to studio A selections change nothing (RLS)',
  (select scoring_method_key from public.event_competition_divisions where id = pg_temp.u('003002')) is null
  and (select scoring_override_key from public.event_competition_rounds where id = pg_temp.u('006003')) is null);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('owner B cannot read the effective method of a studio A round',
  $q$select * from public.competition_round_scoring_effective(pg_temp.u('006001'))$q$, 'not accessible');
select pg_temp.expect_msg('an unknown round id is indistinguishable from an inaccessible one',
  $q$select * from public.competition_round_scoring_effective(pg_temp.u('0ffff1'))$q$, 'not accessible');
select pg_temp.expect_ok('owner B can read the effective method of own round',
  $q$select * from public.competition_round_scoring_effective(pg_temp.u('006005'))$q$);
select pg_temp.expect_msg('registry helper functions are not callable by API roles',
  $q$select * from public.competition_scoring_resolve(pg_temp.u('006005'))$q$, 'permission denied');
select pg_temp.expect_msg('the pin writer is not callable by API roles',
  $q$select public.pin_competition_round_scoring(pg_temp.u('006005'))$q$, 'permission denied');
select pg_temp.as_postgres();

-- ============================================================================
-- Effective method before lock (live, pinned = false)
-- ============================================================================
-- the effective reader checks the caller; use studio A's owner
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('R1 round override wins over the division selection',
  (select method_key || '@' || method_version || '/' || resolution || '/' || pinned::text from public.competition_round_scoring_effective(pg_temp.u('006001')))
    = 'studio_callback_tally@1/round_override/false');
select pg_temp.chk('R2 uses the division selection',
  (select method_key || '@' || method_version || '/' || resolution from public.competition_round_scoring_effective(pg_temp.u('006002')))
    = 'studio_ordinal_majority@1/division');
select pg_temp.chk('R3 (legacy custom) is unmapped and not selectable',
  (select resolution || '/' || coalesce(method_key, 'null') || '/' || coalesce(selectable::text, 'null') from public.competition_round_scoring_effective(pg_temp.u('006003')))
    = 'unmapped/null/false');
select pg_temp.chk('R4 (legacy ordinal_majority, no selection) maps explicitly but is not calculable until pinned',
  (select method_key || '@' || method_version || '/' || resolution || '/' || selectable::text from public.competition_round_scoring_effective(pg_temp.u('006004')))
    = 'studio_ordinal_majority@1/legacy_map/false');
select pg_temp.as_postgres();

-- ============================================================================
-- Sanctioning: independent of the method, owner/admin only, fixed at lock
-- ============================================================================
select pg_temp.chk('sanctioning defaults to none', (select competition_sanctioning from public.events where id = pg_temp.u('00e003')) = 'none');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('owner A declares UCWDC on a draft competition',
  $q$update public.events set competition_sanctioning = 'ucwdc' where id = pg_temp.u('00e003')$q$);
select pg_temp.expect_msg('an unknown sanctioning value is refused',
  $q$update public.events set competition_sanctioning = 'fifa' where id = pg_temp.u('00e003')$q$, 'sanctioning_check');
select pg_temp.expect_msg('UCWDC method still refused on a UCWDC-declared event',
  $q$update public.event_competition_divisions set scoring_method_key = 'ucwdc_majority_rules', scoring_method_version = 'v16.9b' where id = pg_temp.u('003004')$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_ok('an approved studio method is allowed on a UCWDC-declared event (no implied sanction either way)',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '1' where id = pg_temp.u('003004')$q$);
select pg_temp.expect_msg('a non-competition event cannot carry a sanctioning',
  $q$update public.events set event_type = 'workshop', competition_sanctioning = 'ucwdc' where id = pg_temp.u('00e003')$q$, 'sanctioning_type_check');
select pg_temp.as_user(pg_temp.u('000002'));
update public.events set competition_sanctioning = 'wsdc' where id = pg_temp.u('00e003');
select pg_temp.as_postgres();
select pg_temp.chk('owner B cannot change studio A sanctioning', (select competition_sanctioning from public.events where id = pg_temp.u('00e003')) = 'ucwdc');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a new event cannot be inserted with a declared sanctioning by a session user',
  $q$insert into public.events (studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, competition_sanctioning)
     values (pg_temp.u('00a001'), 'Sneaky', 't-reg-sneaky', 'competition', current_date + 9, current_date + 9, 'draft', 'private', false, 'ndca')$q$, 'Create the event first');
select pg_temp.as_postgres();

-- ============================================================================
-- Lock: pins are written, the selection freezes (program of event A)
-- ============================================================================
insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
values (pg_temp.u('001001'), pg_temp.u('00e001'), 'studio_simple', 1,
        jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), now());
update public.event_competition_programs
set status = 'configured', profile_locked_at = (select locked_at from public.event_competition_program_locks where program_id = pg_temp.u('001001'))
where id = pg_temp.u('001001');

select pg_temp.chk('locking pins every round of the program (4)',
  (select count(*) from public.event_competition_scoring_pins where program_id = pg_temp.u('001001')) = 4);
select pg_temp.chk('the other tenant program was not pinned',
  (select count(*) from public.event_competition_scoring_pins where program_id = pg_temp.u('001002')) = 0);
select pg_temp.chk('pins record override / division / unmapped / legacy resolutions',
  (select string_agg(round_id::text || '=' || coalesce(method_key, 'null') || '@' || coalesce(method_version, 'null') || '/' || resolution, ',' order by round_id)
   from public.event_competition_scoring_pins where program_id = pg_temp.u('001001'))
  = pg_temp.u('006001')::text || '=studio_callback_tally@1/round_override,'
 || pg_temp.u('006002')::text || '=studio_ordinal_majority@1/division,'
 || pg_temp.u('006003')::text || '=null@null/unmapped,'
 || pg_temp.u('006004')::text || '=studio_ordinal_majority@1/legacy_map');
select pg_temp.chk('pins record the sanctioning at lock and the registry status',
  not exists (select 1 from public.event_competition_scoring_pins where program_id = pg_temp.u('001001') and sanctioning <> 'none')
  and (select registry_status from public.event_competition_scoring_pins where round_id = pg_temp.u('006001')) = 'approved');

select pg_temp.expect_msg('pins cannot be updated', $q$update public.event_competition_scoring_pins set resolution = 'division' where round_id = pg_temp.u('006001')$q$, 'append-only');
select pg_temp.expect_msg('pins cannot be deleted', $q$delete from public.event_competition_scoring_pins where round_id = pg_temp.u('006001')$q$, 'append-only');
select pg_temp.expect_msg('pins cannot be truncated', $q$truncate public.event_competition_scoring_pins$q$, 'append-only');

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a locked division selection cannot change', $q$update public.event_competition_divisions set scoring_method_key = 'studio_callback_tally', scoring_method_version = '1' where id = pg_temp.u('003001')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('a locked division selection cannot be cleared', $q$update public.event_competition_divisions set scoring_method_key = null, scoring_method_version = null where id = pg_temp.u('003001')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('a locked round override cannot change', $q$update public.event_competition_rounds set scoring_override_key = null, scoring_override_version = null where id = pg_temp.u('006001')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('a previously unselected locked division cannot gain a selection', $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '1' where id = pg_temp.u('003002')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('sanctioning is fixed once a program of the event is locked', $q$update public.events set competition_sanctioning = 'ucwdc' where id = pg_temp.u('00e001')$q$, 'COMP_SANCTIONING_LOCKED');
select pg_temp.expect_ok('a locked competition still accepts unrelated division edits', $q$update public.event_competition_divisions set sort_order = 9 where id = pg_temp.u('003001')$q$);
select pg_temp.as_postgres();
select pg_temp.expect_msg('the lock holds even for postgres', $q$update public.event_competition_divisions set scoring_method_key = null, scoring_method_version = null where id = pg_temp.u('003001')$q$, 'COMP_METHOD_LOCKED');

-- No silent rewrite: changing the stored legacy value of a locked round does not change what it resolves to.
-- SS1 (20270116090000) now refuses this edit on a locked round; the fixture sidesteps the guard to keep proving the pin decides.
set local session_replication_role = replica;
update public.event_competition_rounds set scoring_method = 'none' where id = pg_temp.u('006004');
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the pin, not the live legacy value, decides a locked round',
  (select method_key || '@' || method_version || '/' || resolution || '/' || pinned::text from public.competition_round_scoring_effective(pg_temp.u('006004')))
    = 'studio_ordinal_majority@1/legacy_map/true');
select pg_temp.as_postgres();

-- A round added after the lock is pinned on insert.
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
values (pg_temp.u('006006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Late', 'semifinal', 3, 'callback_tally');
select pg_temp.chk('a late round of a locked program is pinned', exists (select 1 from public.event_competition_scoring_pins where round_id = pg_temp.u('006006')));

-- ============================================================================
-- Programs locked before REG have no pins: read live, never rewritten
-- ============================================================================
alter table public.event_competition_programs disable trigger pin_competition_program_scoring;
insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
values (pg_temp.u('001002'), pg_temp.u('00e002'), 'studio_simple', 1,
        jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), now());
update public.event_competition_programs
set status = 'configured', profile_locked_at = (select locked_at from public.event_competition_program_locks where program_id = pg_temp.u('001002'))
where id = pg_temp.u('001002');
alter table public.event_competition_programs enable trigger pin_competition_program_scoring;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.chk('a pre-REG locked round has no pin and is read live through the explicit legacy map',
  (select method_key || '@' || method_version || '/' || resolution || '/' || pinned::text from public.competition_round_scoring_effective(pg_temp.u('006005')))
    = 'studio_ordinal_majority@1/legacy_map/false');
select pg_temp.expect_msg('a pre-REG locked program cannot gain a selection (fail closed, S4-7)',
  $q$update public.event_competition_divisions set scoring_method_key = 'studio_ordinal_majority', scoring_method_version = '1' where id = pg_temp.u('003003')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.chk('owner B sees no pins (none exist for the pre-REG program, none of studio A)',
  (select count(*) from public.event_competition_scoring_pins) = 0);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('owner A sees only own pins', (select count(*) from public.event_competition_scoring_pins) = 5
  and (select count(*) from public.event_competition_scoring_pins where event_id <> pg_temp.u('00e001')) = 0);
select pg_temp.as_postgres();

-- ============================================================================
-- Review fixes
-- ============================================================================
select pg_temp.expect_msg('a division cannot be added to a locked program whose divisions have a selection',
  $q$insert into public.event_competition_divisions (event_id, program_id, contest_id, name)
     values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Late division')$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('the pin writer refuses a round of an unlocked program',
  $q$select public.pin_competition_round_scoring(pg_temp.u('006999'))$q$, 'locked program');
select pg_temp.chk('pin and resolve functions are not callable by service_role',
  not has_function_privilege('service_role', 'public.pin_competition_round_scoring(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.competition_scoring_resolve(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.guard_competition_scoring_selection()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.competition_round_scoring_effective(uuid)', 'EXECUTE'));

-- ============================================================================
-- Privileges
-- ============================================================================
select pg_temp.chk('API roles cannot write pins',
  not has_table_privilege('authenticated', 'public.event_competition_scoring_pins', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_scoring_pins', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.event_competition_scoring_pins', 'DELETE')
  and not has_table_privilege('anon', 'public.event_competition_scoring_pins', 'SELECT'));
select pg_temp.chk('the effective reader is not callable by anon but is by authenticated',
  not has_function_privilege('anon', 'public.competition_round_scoring_effective(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.competition_round_scoring_effective(uuid)', 'EXECUTE'));
select pg_temp.chk('guard and pin functions are not callable by API roles',
  not has_function_privilege('authenticated', 'public.guard_competition_scoring_selection()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.protect_competition_sanctioning()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.pin_competition_round_scoring(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.competition_scoring_resolve(uuid)', 'EXECUTE'));
select pg_temp.chk('the existing scoring_method checks are unchanged',
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.event_competition_rounds'::regclass and conname = 'event_competition_rounds_scoring_method_check') like '%callback_tally%');

select pg_temp.chk('the internal reader is not callable by any API role',
  not has_function_privilege('authenticated', 'public.competition_round_scoring_effective_internal(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.competition_round_scoring_effective_internal(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.competition_round_scoring_effective_internal(uuid)', 'EXECUTE'));
-- Deleting a locked program must still cascade its pins (restart / event deletion), whatever the cascade order.
select pg_temp.expect_ok('deleting a locked program cascades its pins',
  $q$delete from public.event_competition_programs where id = pg_temp.u('001001')$q$);
select pg_temp.chk('and the pins are gone with it', (select count(*) from public.event_competition_scoring_pins where program_id = pg_temp.u('001001')) = 0);

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
    raise exception 'COMPETITION REG SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION REG SQL SUITE FAIL: %', v_failures;
end $$;
