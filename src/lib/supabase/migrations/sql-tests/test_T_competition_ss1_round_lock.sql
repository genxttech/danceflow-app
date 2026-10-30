-- Competition SS1 -- locked-round scoring freeze regression suite.
--
-- Covers 20270116090000_competition_ss1_round_scoring_lock.sql on top of 10B and REG. One transaction; the final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION SS1 SQL SUITE PASS (<n> checks)"  or  "COMPETITION SS1 SQL SUITE FAIL: <failures>".
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
language sql immutable as $$ select ('00000000-0000-0000-0000-0c0e61' || p_suffix)::uuid $$;
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
-- Fixtures (as postgres): one studio, one competition with two draft programs
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-ss1-owner@example.test'), (pg_temp.u('000002'), 't-ss1-outsider@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-ss1-owner@example.test', 'Owner'), (pg_temp.u('000002'), 't-ss1-outsider@example.test', 'Outsider');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'SS1 Studio', 't-ss1-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'SS1 Comp', 't-ss1-1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, rules_profile_key, rules_profile_version) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Locked later', 'showcase', 'relative', 'ordinal_majority', 'draft', 'studio_simple', 1),
  (pg_temp.u('001002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Stays draft', 'showcase', 'relative', 'ordinal_majority', 'draft', 'studio_simple', 1);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples 1', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001002'), 'Couples 2', 'single_dance', 'couple', 'open');
insert into public.event_competition_contest_registration_rules (event_id, program_id, contest_id, dance_selection_mode, pricing_method, minimum_participants, maximum_participants)
select e, p, c, 'individual', 'flat_entry', 1, 10
from (values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001')), (pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'))) v(e, p, c)
where not exists (select 1 from public.event_competition_contest_registration_rules r where r.contest_id = v.c);
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze', 'draft'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Silver', 'draft'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'), 'Draft div', 'draft');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, scoring_method) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Callback', 'preliminary', 1, 'callback_tally'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 2, 'ordinal_majority'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003003'), 'Final', 'final', 1, 'custom');

-- ============================================================================
-- Trigger metadata
-- ============================================================================
select pg_temp.chk('the guard trigger exists on rounds',
  exists (select 1 from pg_trigger where tgname = 'guard_competition_round_scoring_lock' and tgrelid = 'public.event_competition_rounds'::regclass and not tgisinternal));
select pg_temp.chk('the guard function is not callable by any API role',
  not has_function_privilege('authenticated', 'public.guard_competition_round_scoring_lock()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_competition_round_scoring_lock()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.guard_competition_round_scoring_lock()', 'EXECUTE'));

-- ============================================================================
-- Before lock: configuration (what SS1 does to a draft) is untouched
-- ============================================================================
select pg_temp.expect_ok('draft: scoring_method change allowed', $q$update public.event_competition_rounds set scoring_method = 'ordinal_majority' where id = pg_temp.u('006003')$q$);
select pg_temp.expect_ok('draft: sequence_number change allowed', $q$update public.event_competition_rounds set sequence_number = 3 where id = pg_temp.u('006003')$q$);
select pg_temp.expect_ok('draft: round_type change allowed', $q$update public.event_competition_rounds set round_type = 'qualifying' where id = pg_temp.u('006003')$q$);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('draft: the studio owner can reshape rounds as SS1 does',
  $q$update public.event_competition_rounds set sequence_number = 4, scoring_method = 'callback_tally' where id = pg_temp.u('006003')$q$);
select pg_temp.as_postgres();

-- ============================================================================
-- Lock program 1 (as publish does: lock row, then status + profile_locked_at)
-- ============================================================================
insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
values (pg_temp.u('001001'), pg_temp.u('00e001'), 'studio_simple', 1,
        jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), now());
update public.event_competition_programs
set status = 'configured', profile_locked_at = (select locked_at from public.event_competition_program_locks where program_id = pg_temp.u('001001'))
where id = pg_temp.u('001001');

-- ============================================================================
-- After lock: frozen columns refuse, for every role and path
-- ============================================================================
select pg_temp.expect_msg('locked: scoring_method refused (table owner)', $q$update public.event_competition_rounds set scoring_method = 'custom' where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.expect_msg('locked: sequence_number refused', $q$update public.event_competition_rounds set sequence_number = 9 where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.expect_msg('locked: round_type refused', $q$update public.event_competition_rounds set round_type = 'custom' where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.expect_msg('locked: division_id refused', $q$update public.event_competition_rounds set division_id = pg_temp.u('003002') where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.expect_msg('locked: program_id refused', $q$update public.event_competition_rounds set program_id = pg_temp.u('001002') where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('locked: the studio owner (the SS1 action role) is refused too', $q$update public.event_competition_rounds set scoring_method = 'custom', sequence_number = 7 where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.as_postgres();

select pg_temp.expect_msg('locked: a round cannot be moved INTO a locked program', $q$update public.event_competition_rounds set program_id = pg_temp.u('001001'), division_id = pg_temp.u('003002') where id = pg_temp.u('006003')$q$, 'COMP_ROUND_SCORING_LOCKED');
select pg_temp.expect_msg('locked: a round of a locked program cannot be deleted', $q$delete from public.event_competition_rounds where id = pg_temp.u('006002')$q$, 'COMP_ROUND_SCORING_LOCKED');

select pg_temp.chk('locked: nothing changed',
  (select scoring_method || '/' || sequence_number || '/' || round_type from public.event_competition_rounds where id = pg_temp.u('006002')) = 'ordinal_majority/2/final');

-- ============================================================================
-- After lock: documented non-frozen columns and existing writers still work
-- ============================================================================
select pg_temp.expect_ok('locked: a no-op update of a frozen column is allowed', $q$update public.event_competition_rounds set scoring_method = scoring_method where id = pg_temp.u('006002')$q$);
select pg_temp.expect_ok('locked: updated_at allowed (the status writers E2/O1/F2 are covered by their own suites)', $q$update public.event_competition_rounds set updated_at = now() where id = pg_temp.u('006002')$q$);
select pg_temp.expect_ok('locked: callback target (W4/E2-governed) allowed', $q$update public.event_competition_rounds set target_advancement_count = 5 where id = pg_temp.u('006001')$q$);
select pg_temp.expect_ok('locked: name and configuration (10D max_entries_per_heat) allowed',
  $q$update public.event_competition_rounds set name = 'Final (renamed)', configuration = jsonb_set(configuration, '{max_entries_per_heat}', '8') where id = pg_temp.u('006002')$q$);
select pg_temp.expect_ok('locked: a late round can still be inserted (REG pins it on insert)',
  $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
     values (pg_temp.u('006009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1, 'ordinal_majority')$q$);
select pg_temp.chk('and that late round is pinned', exists (select 1 from public.event_competition_scoring_pins where round_id = pg_temp.u('006009')));

-- ============================================================================
-- The unlocked program is unaffected by the other program's lock
-- ============================================================================
select pg_temp.expect_ok('other draft program: scoring_method still editable', $q$update public.event_competition_rounds set scoring_method = 'ordinal_majority' where id = pg_temp.u('006003')$q$);

-- ============================================================================
-- apply_competition_scoring_setup: one transaction, fail closed
-- ============================================================================
select pg_temp.chk('the configure RPC is granted to authenticated only',
  has_function_privilege('authenticated', 'public.apply_competition_scoring_setup(uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_competition_scoring_setup(uuid,jsonb)', 'EXECUTE'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('rpc: a draft studio program is configured (round update, round insert, selection)',
  $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('sequence_number', 2, 'scoring_method', 'ordinal_majority')),
       jsonb_build_object('op', 'insert_round', 'division_id', pg_temp.u('003003'), 'row', jsonb_build_object('name', 'Callback round', 'round_type', 'preliminary', 'sequence_number', 1, 'scoring_method', 'callback_tally', 'pairing_mode', 'fixed', 'scoring_override_key', 'studio_callback_tally', 'scoring_override_version', '1')),
       jsonb_build_object('op', 'set_division_selection', 'division_id', pg_temp.u('003003'), 'key', 'studio_ordinal_majority', 'version', '1')))$q$);
select pg_temp.as_postgres();
select pg_temp.chk('rpc: the configured draft has callback + final rounds and the selection',
  (select string_agg(sequence_number || ':' || scoring_method, ',' order by sequence_number) from public.event_competition_rounds where division_id = pg_temp.u('003003')) = '1:callback_tally,2:ordinal_majority'
  and (select scoring_method_key from public.event_competition_divisions where id = pg_temp.u('003003')) = 'studio_ordinal_majority');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('rpc: a locked program is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001001'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006002'), 'patch', jsonb_build_object('scoring_method', 'callback_tally'))))$q$, 'COMP_METHOD_LOCKED');
select pg_temp.expect_msg('rpc: proficiency scoring value is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('scoring_method', 'proficiency_rating'))))$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('rpc: a custom scoring value is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('scoring_method', 'custom'))))$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('rpc: UCWDC cannot be selected (REG guard)', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'set_division_selection', 'division_id', pg_temp.u('003003'), 'key', 'ucwdc_majority_rules', 'version', 'v16.9b')))$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('rpc: proficiency, NDCA and WSDC cannot be selected', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'set_division_selection', 'division_id', pg_temp.u('003003'), 'key', 'ndca_skating', 'version', 'unpinned')))$q$, 'COMP_ENGINE_NOT_AVAILABLE');
select pg_temp.expect_msg('rpc: an unsupported column is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('status', 'active'))))$q$, 'COMP_SCORING_OPS_INVALID');
select pg_temp.expect_msg('rpc: a row outside the program is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006002'), 'patch', jsonb_build_object('sequence_number', 5))))$q$, 'did not apply');
select pg_temp.expect_msg('rpc: a failing step rolls the whole request back', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('sequence_number', 9)),
       jsonb_build_object('op', 'bogus')))$q$, 'COMP_SCORING_OPS_INVALID');
select pg_temp.as_postgres();
select pg_temp.chk('rpc: the rolled-back request left no change', (select sequence_number from public.event_competition_rounds where id = pg_temp.u('006003')) = 2);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('rpc: a caller who cannot manage the event is refused', $q$select public.apply_competition_scoring_setup(pg_temp.u('001002'), jsonb_build_array(jsonb_build_object('op', 'update_round', 'round_id', pg_temp.u('006003'), 'patch', jsonb_build_object('sequence_number', 3))))$q$, 'not accessible');
select pg_temp.as_postgres();

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
    raise exception 'COMPETITION SS1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION SS1 SQL SUITE FAIL: %', v_failures;
end $$;
