-- Competition HL1 -- heat guards regression suite.
--
-- Covers 20270119090000_competition_hl1_heat_guards.sql on top of 10A..10D.1, E1, E2, O1, F2, NS1, CX1 and SS1 (clean chain through 0118
-- + 0119). Run as a SUPERUSER (the fixture is E2's: heats are placed in a published schedule version with session_replication_role =
-- replica, and a few states are set directly where noted). One transaction, synthetic fixtures only (UUID block ...-e20ff2XXXXXX). The final
-- block ALWAYS raises, so nothing persists:
--   "COMPETITION HL1 HEAT GUARDS SQL SUITE PASS (<n> checks)"  or  "... FAIL: <failures>".
-- The reopen-vs-Lock-ballots race needs real second connections: see sql-tests/concurrency/run_hl1_reopen_vs_lock_ballots.sh.

begin;

-- HL1: Lock ballots now requires every ballot heat to be danced; suite heats that are locked are marked complete first (superuser, trigger bypass).
create or replace function pg_temp.hl1_danced(p_heat uuid) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heats set status = 'complete' where id = p_heat;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on function pg_temp.hl1_danced(uuid) to authenticated, anon, service_role;


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

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
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
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;

-- Evaluates a boolean expression; an exception records a failed check instead of aborting the suite.
create or replace function pg_temp.chk_sql(p_name text, p_sql text) returns void
language plpgsql as $$
declare v boolean;
begin
  begin
    execute p_sql into v;
    insert into t_results values (p_name, coalesce(v, false), coalesce(v::text, 'null'));
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-e20ff2' || p_suffix)::uuid $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;
-- Marks for a heat: p_vals is a JSON array applied to the heat's entries in entry-id order.
create or replace function pg_temp.mk(p_heat text, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.u(p_heat)) x
$$;
-- Ballot count helpers (run as the current role; RLS applies).
create or replace function pg_temp.nb(p_where text default 'true') returns bigint
language plpgsql as $$ declare r bigint; begin execute 'select count(*) from public.event_competition_ballots where ' || p_where into r; return r; end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
-- users: 01 owner A, 03 front desk A, 05 owner B, 11 12 13 judges A, 17 chair A, 16 scorer A (assigned),
--        18 scorer A (NOT assigned), 15 judge B, 20 verified user with no team
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-e2-owner-a@example.test'), (pg_temp.u('000003'), 't-e2-desk-a@example.test'),
  (pg_temp.u('000005'), 't-e2-owner-b@example.test'), (pg_temp.u('000011'), 't-e2-judge1@example.test'),
  (pg_temp.u('000012'), 't-e2-judge2@example.test'), (pg_temp.u('000013'), 't-e2-judge3@example.test'),
  (pg_temp.u('000017'), 't-e2-chair@example.test'), (pg_temp.u('000016'), 't-e2-scorer@example.test'),
  (pg_temp.u('000018'), 't-e2-scorer2@example.test'), (pg_temp.u('000014'), 't-e2-judge4@example.test'), (pg_temp.u('000015'), 't-e2-judge-b@example.test'),
  (pg_temp.u('000020'), 't-e2-nobody@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'E2 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-e20ff2%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-e20ff2%';

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'E2 Studio A', 't-e2-studio-a'), (pg_temp.u('00b001'), 'E2 Studio B', 't-e2-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000017'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000014'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true), (pg_temp.u('000018'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000015'), pg_temp.u('00b001'), 'instructor', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'E2 Comp', 't-e2-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'E2 Other Studio Comp', 't-e2-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D1', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D2', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D3', 'open'),
  (pg_temp.u('003004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D4', 'open'),
  (pg_temp.u('003005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D5', 'open'),
  (pg_temp.u('003009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'D9', 'open');
-- r1 ordinal (2 heats), r2 proficiency, r3 callback, r4 ordinal (never started), r9 other studio
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'R1 Final', 'final', 1, 'draft', 'ordinal_majority'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'R2 Ratings', 'proficiency', 1, 'draft', 'proficiency_rating'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'R3 Callback', 'qualifying', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'R4 Draft', 'final', 1, 'draft', 'ordinal_majority'),
  (pg_temp.u('006005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'R5 Absent', 'final', 1, 'draft', 'ordinal_majority'),
  (pg_temp.u('006009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'R9 Other', 'final', 1, 'draft', 'ordinal_majority');

insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E101', 'confirmed', 'eligible', '101'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E102', 'confirmed', 'eligible', '102'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E103', 'confirmed', 'eligible', '103'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E104', 'confirmed', 'eligible', '104'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E105', 'confirmed', 'eligible', '105'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E106', 'confirmed', 'eligible', '106'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E107', 'confirmed', 'eligible', '107'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E108', 'confirmed', 'eligible', '108'),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'E109', 'confirmed', 'eligible', '109'),
  (pg_temp.u('008010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'E110', 'confirmed', 'eligible', '110'),
  (pg_temp.u('008011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'E111', 'confirmed', 'eligible', '111'),
  (pg_temp.u('008014'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'E114', 'confirmed', 'eligible', '114'),
  (pg_temp.u('008015'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'E115', 'confirmed', 'eligible', '115'),
  (pg_temp.u('008012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'E112', 'confirmed', 'eligible', '112'),
  (pg_temp.u('008013'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'E113', 'confirmed', 'eligible', '113'),
  (pg_temp.u('008019'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'E119', 'confirmed', 'eligible', '119'),
  (pg_temp.u('008020'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'E120', 'confirmed', 'eligible', '120');

-- Heats sit in a published schedule version. Fixture-only shortcut: replica mode skips the 10D publish flow.
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e002'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d003'), pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('006002'), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d004'), pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('006003'), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d005'), pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('006004'), 5, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d007'), pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('006005'), 7, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d006'), pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('006003'), 6, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d009'), pg_temp.u('00e002'), pg_temp.u('003009'), pg_temp.u('006009'), 1, pg_temp.u('002002'), pg_temp.u('00c002'), 'scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008001'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008002'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008003'), 3),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d002'), pg_temp.u('008004'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d002'), pg_temp.u('008005'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d003'), pg_temp.u('008006'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d003'), pg_temp.u('008007'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d003'), pg_temp.u('008008'), 3),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d004'), pg_temp.u('008009'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d004'), pg_temp.u('008010'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('00d005'), pg_temp.u('008011'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('00d007'), pg_temp.u('008014'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('00d007'), pg_temp.u('008015'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d006'), pg_temp.u('008012'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d006'), pg_temp.u('008013'), 2),
  (pg_temp.u('00e002'), pg_temp.u('003009'), pg_temp.u('00d009'), pg_temp.u('008019'), 1),
  (pg_temp.u('00e002'), pg_temp.u('003009'), pg_temp.u('00d009'), pg_temp.u('008020'), 2);
set session_replication_role = origin;

-- Officials and panels through the E1 RPCs (as the real managers)
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000017'), 'chair', pg_temp.u('f10004'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000016'), 'scorer', pg_temp.u('f10005'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000018'), 'scorer', pg_temp.u('f10006'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000014'), 'judge', pg_temp.u('f10007'));
-- r1: J1 A, J2 B, J3 C, chair D, scorer;  r2: J1 A, J2 B, scorer;  r3: J1;  r4: J1
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10011'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10012'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10013'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000016'), null, pg_temp.u('f10015'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10021'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10022'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000016'), null, pg_temp.u('f10023'));
select public.assign_competition_panel_member(pg_temp.u('006003'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10031'));
select public.assign_competition_panel_member(pg_temp.u('006004'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10041'));
select public.assign_competition_panel_member(pg_temp.u('006005'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10061'));
select public.assign_competition_panel_member(pg_temp.u('006005'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10062'));
select public.assign_competition_panel_member(pg_temp.u('006005'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10063'));
select public.assign_competition_panel_member(pg_temp.u('006005'), pg_temp.off('00e001', '000014'), 'D', pg_temp.u('f10064'));
select pg_temp.as_user(pg_temp.u('000005'));
select public.add_competition_official(pg_temp.u('00e002'), pg_temp.u('000015'), 'judge', pg_temp.u('f10051'));
select public.assign_competition_panel_member(pg_temp.u('006009'), pg_temp.off('00e002', '000015'), 'A', pg_temp.u('f10052'));
reset role;
-- rounds r1, r2, r3, r9 run (r4 stays draft)
-- Fixture shortcut: O1 allows only scheduled->active; replica mode lets the superuser fixture place rounds directly in active.
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.u('006001'), pg_temp.u('006002'), pg_temp.u('006003'), pg_temp.u('006005'), pg_temp.u('006009'));
set session_replication_role = origin;

-- ============================================================================
-- 1. Surface: pins, triggers, helper privileges
-- ============================================================================
select pg_temp.chk('lock_competition_round_ballots body is the pinned post-HL1 text',
  md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '')) = '6e4175342d51ffe274d70ce413bae8c3');
select pg_temp.chk('the two HL1 triggers exist on event_competition_heats',
  (select count(*) from pg_trigger where tgrelid = 'public.event_competition_heats'::regclass and tgname in ('hl1_guard_heat_reopen', 'hl1_guard_heat_lock') and not tgisinternal) = 2);
select pg_temp.chk('set_competition_heat_lock_state is not redefined (still the 10A body, no HL1 text)',
  pg_get_functiondef('public.set_competition_heat_lock_state(uuid,text,text)'::regprocedure) not like '%HL1%');
select pg_temp.chk('HL1 helper and trigger functions are not executable by API roles',
  not has_function_privilege('authenticated', 'public._hl1_heat_is_danced(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public._hl1_heat_is_danced(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._hl1_guard_heat_reopen()', 'execute')
  and not has_function_privilege('authenticated', 'public._hl1_guard_heat_lock()', 'execute'));
select pg_temp.chk('lock_competition_round_ballots keeps its grants',
  has_function_privilege('authenticated', 'public.lock_competition_round_ballots(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.lock_competition_round_ballots(uuid,uuid)', 'execute'));
select pg_temp.chk('danced rule: scheduled and staging are not danced, active and complete are',
  not public._hl1_heat_is_danced(pg_temp.u('00d003'), 'scheduled') and not public._hl1_heat_is_danced(pg_temp.u('00d003'), 'staging')
  and public._hl1_heat_is_danced(pg_temp.u('00d003'), 'active') and public._hl1_heat_is_danced(pg_temp.u('00d003'), 'complete'));

-- ============================================================================
-- 2. Early lock, no-op lock, reopen (round r2, heat 00d003 is scheduled, round active)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('manager locks a scheduled (undanced) heat early', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'official scratch expected')$q$, pg_temp.u('00d003')));
reset role;
select pg_temp.chk('early lock wrote one audit row (open -> locked)',
  pg_temp.n($q$select count(*) from public.event_competition_heat_lock_events where heat_id = pg_temp.u('00d003') and from_state = 'open' and to_state = 'locked'$q$) = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('locking an already locked heat is refused', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'again')$q$, pg_temp.u('00d003')), 'COMP_HL1_ALREADY_LOCKED');
reset role;
select pg_temp.chk('the refused re-lock left no extra audit row',
  pg_temp.n($q$select count(*) from public.event_competition_heat_lock_events where heat_id = pg_temp.u('00d003')$q$) = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('reopen needs a reason (RPC)', format($q$select public.set_competition_heat_lock_state(%L, 'open', null)$q$, pg_temp.u('00d003')), 'A reason is required');
select pg_temp.expect_ok('manager reopens the undanced locked heat with a reason', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'locked by mistake')$q$, pg_temp.u('00d003')));
reset role;
select pg_temp.chk('the heat is open again with two audit rows (locked, then open with the reason)',
  (select lock_state = 'open' from public.event_competition_heats where id = pg_temp.u('00d003'))
  and pg_temp.n($q$select count(*) from public.event_competition_heat_lock_events where heat_id = pg_temp.u('00d003')$q$) = 2
  and exists (select 1 from public.event_competition_heat_lock_events where heat_id = pg_temp.u('00d003') and to_state = 'open' and reason = 'locked by mistake'));

-- role gate is unchanged: a judge and a scorer still cannot lock or reopen
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot lock a heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'x')$q$, pg_temp.u('00d003')), 'cannot be managed');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot lock a heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'x')$q$, pg_temp.u('00d003')), 'cannot be managed');
reset role;

-- ============================================================================
-- 3. A heat on the floor cannot be locked; a completed heat can, and then cannot be reopened (round r3, heat 00d004)
-- ============================================================================
set session_replication_role = replica;
update public.event_competition_heats set status = 'active' where id = pg_temp.u('00d004');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an active (mid-dance) heat cannot be locked', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'x')$q$, pg_temp.u('00d004')), 'COMP_HL1_LOCK_ACTIVE');
reset role;
select pg_temp.chk('the refused lock left the heat open with no audit row',
  (select lock_state = 'open' from public.event_competition_heats where id = pg_temp.u('00d004'))
  and pg_temp.n($q$select count(*) from public.event_competition_heat_lock_events where heat_id = pg_temp.u('00d004')$q$) = 0);
set session_replication_role = replica;
update public.event_competition_heats set status = 'complete' where id = pg_temp.u('00d004');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the danced-path lock (complete heat) still works', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'dance complete')$q$, pg_temp.u('00d004')));
select pg_temp.expect_msg('a completed heat cannot be reopened', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'oops')$q$, pg_temp.u('00d004')), 'COMP_HL1_REOPEN_DANCED');
reset role;
select pg_temp.chk('the completed heat is still locked', (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.u('00d004')));

-- ============================================================================
-- 4. An undanced-status heat with a danced placement cannot be reopened (round r5, heat 00d007)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('lock heat 00d007 (scheduled)', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'x')$q$, pg_temp.u('00d007')));
reset role;
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'danced' where heat_id = pg_temp.u('00d007') and entry_id = pg_temp.u('008014');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a heat with a danced placement cannot be reopened even though its status is scheduled', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'x')$q$, pg_temp.u('00d007')), 'COMP_HL1_REOPEN_DANCED');
reset role;

-- ============================================================================
-- 5. Certified heats stay unreopenable, and locked -> certified is untouched (heat 00d006)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('lock heat 00d006', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'x')$q$, pg_temp.u('00d006')));
select pg_temp.expect_ok('certify heat 00d006 (the F2 path is unaffected)', format($q$select public.set_competition_heat_lock_state(%L, 'certified', 'x')$q$, pg_temp.u('00d006')));
select pg_temp.expect_msg('a certified heat cannot be reopened', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'x')$q$, pg_temp.u('00d006')), 'Certified heats');
reset role;

-- ============================================================================
-- 6. Reopen refused once the round's ballots are locked or later (heat 00d003, undanced)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('re-lock heat 00d003 early', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'again')$q$, pg_temp.u('00d003')));
reset role;
-- Fixture shortcut (superuser, trigger bypass): place round r2 directly in each later status.
select pg_temp.chk('setup: heat 00d003 is locked and undanced', (select lock_state = 'locked' and status = 'scheduled' from public.event_competition_heats where id = pg_temp.u('00d003')));
do $$
declare
  v_status text;
begin
  foreach v_status in array array['ballots_locked', 'calculated', 'approved', 'published', 'complete', 'cancelled'] loop
    perform set_config('session_replication_role', 'replica', true);
    update public.event_competition_rounds set status = v_status where id = pg_temp.u('006002');
    perform set_config('session_replication_role', 'origin', true);
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('000001'), 'role', 'authenticated')::text, true);
      set local role authenticated;
      perform public.set_competition_heat_lock_state(pg_temp.u('00d003'), 'open', 'late reopen');
      reset role;
      insert into t_results values ('reopen refused when the round is ' || v_status, false, 'statement unexpectedly succeeded');
    exception when others then
      reset role;
      insert into t_results values ('reopen refused when the round is ' || v_status, sqlerrm like '%COMP_HL1_REOPEN_ROUND_LOCKED%', sqlerrm);
    end;
  end loop;
end $$;
select pg_temp.chk('the heat is still locked after the refusals', (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.u('00d003')));
set session_replication_role = replica;
update public.event_competition_rounds set status = 'scheduled' where id = pg_temp.u('006002');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('reopen is allowed while the round is only scheduled', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'schedule changed')$q$, pg_temp.u('00d003')));
reset role;

-- ============================================================================
-- 7. Lock ballots needs every ballot heat danced (round r1, heats 00d001 and 00d002)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.mk('00d001', '[1,2,3]'), pg_temp.u('f7a001'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.mk('00d002', '[1,2]'), pg_temp.u('f7a002'));
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.mk('00d001', '[2,1,3]'), pg_temp.u('f7a003'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.mk('00d002', '[2,1]'), pg_temp.u('f7a004'));
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.mk('00d001', '[1,3,2]'), pg_temp.u('f7a005'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.mk('00d002', '[1,2]'), pg_temp.u('f7a006'));
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.u('00d001'), 'locked', 'early');
select public.set_competition_heat_lock_state(pg_temp.u('00d002'), 'locked', 'early');
select pg_temp.expect_msg('Lock ballots refused while every heat is locked but undanced (early lock alone is not enough)', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f7a010')), 'COMP_HL1_HEAT_NOT_DANCED');
reset role;
select pg_temp.chk('the refusal left the round active', (select status = 'active' from public.event_competition_rounds where id = pg_temp.u('006001')));
select pg_temp.hl1_danced(pg_temp.u('00d001'));
select pg_temp.chk('one danced heat and one undanced heat is still refused',
  (select count(*) from public.event_competition_heats where round_id = pg_temp.u('006001') and status = 'complete') = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('Lock ballots refused with one undanced heat left', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f7a011')), 'COMP_HL1_HEAT_NOT_DANCED');
reset role;
select pg_temp.hl1_danced(pg_temp.u('00d002'));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('Lock ballots succeeds once every heat is danced', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f7a012')));
reset role;
select pg_temp.chk('the round is ballots_locked', (select status = 'ballots_locked' from public.event_competition_rounds where id = pg_temp.u('006001')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a heat of the locked round cannot be reopened', format($q$select public.set_competition_heat_lock_state(%L, 'open', 'x')$q$, pg_temp.u('00d001')), 'COMP_HL1_REOPEN_ROUND_LOCKED');
reset role;

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
    raise exception 'COMPETITION HL1 HEAT GUARDS SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION HL1 HEAT GUARDS SQL SUITE FAIL: %', v_failures;
end $$;
