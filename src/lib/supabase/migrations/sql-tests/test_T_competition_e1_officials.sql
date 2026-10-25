-- Competition E1 -- officials and round panel assignments regression suite.
--
-- Covers 20270101090000_competition_e1_officials.sql on top of 10A..10D.1 (+ LAUNCH-SEC-1C-B verified identities).
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-e10ff1XXXXXX). The final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION E1 SQL SUITE PASS (<n> checks)"  or  "COMPETITION E1 SQL SUITE FAIL: <failures>".

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

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-e10ff1' || p_suffix)::uuid $$;
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
create or replace function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
-- Official id for (event, user suffix).
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
-- users: 01 owner A, 02 admin A, 03 front desk A, 04 instructor A, 05 owner B,
--        11 12 13 judges (studio A team), 14 studio A member with NO verified credential,
--        15 outsider (verified, not on any team), 16 scorer (studio A team)
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-e1-owner-a@example.test'), (pg_temp.u('000002'), 't-e1-admin-a@example.test'),
  (pg_temp.u('000003'), 't-e1-desk-a@example.test'), (pg_temp.u('000004'), 't-e1-instr-a@example.test'),
  (pg_temp.u('000005'), 't-e1-owner-b@example.test'),
  (pg_temp.u('000011'), 't-e1-judge1@example.test'), (pg_temp.u('000012'), 't-e1-judge2@example.test'),
  (pg_temp.u('000013'), 't-e1-judge3@example.test'), (pg_temp.u('000014'), 't-e1-unverified@example.test'),
  (pg_temp.u('000015'), 't-e1-outsider@example.test'), (pg_temp.u('000016'), 't-e1-scorer@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'E1 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-e10ff1%';

insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-e10ff1%' and id <> pg_temp.u('000014');

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'E1 Studio A', 't-e1-studio-a'),
  (pg_temp.u('00b001'), 'E1 Studio B', 't-e1-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_admin', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000004'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000014'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000015'), pg_temp.u('00b001'), 'front_desk', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'E1 Comp', 't-e1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'E1 Other Studio Comp', 't-e1-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true),
  (pg_temp.u('00e003'), pg_temp.u('00a001'), 'E1 No Program', 't-e1-e3', 'competition', current_date + 50, current_date + 50, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Newcomer', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Intermediate', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Advanced', 'open'),
  (pg_temp.u('003009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'Other Newcomer', 'open');
-- r1 draft, r2 scheduled, r3 active, r9 other studio
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1, 'draft'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1, 'scheduled'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Final', 'final', 1, 'draft'),
  (pg_temp.u('006009'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003009'), 'Final', 'final', 1, 'draft');

-- ============================================================================
-- 1. Surface: grants, RLS, anon
-- ============================================================================
select pg_temp.chk('officials table has RLS', (select relrowsecurity from pg_class where oid = 'public.event_competition_officials'::regclass));
select pg_temp.chk('assignments table has RLS', (select relrowsecurity from pg_class where oid = 'public.event_competition_panel_assignments'::regclass));
select pg_temp.chk('audit table has RLS', (select relrowsecurity from pg_class where oid = 'public.event_competition_official_events'::regclass));
select pg_temp.chk('no API role holds table write privileges',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_officials', 'event_competition_panel_assignments', 'event_competition_official_events')
                and g.grantee in ('anon', 'authenticated', 'service_role', 'public') and g.privilege_type <> 'SELECT'));
select pg_temp.chk('anon holds no table privilege at all',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_officials', 'event_competition_panel_assignments', 'event_competition_official_events')
                and g.grantee in ('anon', 'public')));
select pg_temp.chk('anon cannot execute any E1 RPC',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('add_competition_official', 'deactivate_competition_official', 'set_competition_chair', 'clear_competition_chair',
                'assign_competition_panel_member', 'unassign_competition_panel_member', 'list_competition_official_candidates',
                'competition_round_panel_ready', 'competition_round_panel_status', 'my_competition_judging_assignments', 'competition_is_active_official')
                and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.chk('internal helpers are not executable by API roles',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like '\_comp\_e1\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));

-- ============================================================================
-- 2. Manager role matrix on add_competition_official
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('owner adds judge 1', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000011'), pg_temp.u('f00001')));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('studio admin adds judge 2', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000012'), pg_temp.u('f00002')));
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot add an official', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.expect_msg('instructor cannot add an official', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00004')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('other studio owner cannot add an official to event A', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00005')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('front desk cannot list candidates', format($q$select * from public.list_competition_official_candidates(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot list candidates (A)', format($q$select * from public.list_competition_official_candidates(%L)$q$, pg_temp.u('00e001')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot call add_competition_official', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00006')), 'permission denied');
reset role;

-- ============================================================================
-- 3. Identity binding and validation (as owner A)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('unverified account cannot be an official', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000014'), pg_temp.u('f00010')), 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED');
select pg_temp.expect_msg('outsider (not on the team) cannot be an official', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000015'), pg_temp.u('f00011')), 'COMP_OFFICIAL_NOT_TEAM_MEMBER');
select pg_temp.expect_msg('unknown user id is refused', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('0000ff'), pg_temp.u('f00012')), 'COMP_OFFICIAL_NOT_TEAM_MEMBER');
select pg_temp.expect_msg('invalid role is refused', format($q$select public.add_competition_official(%L, %L, 'owner', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00013')), 'COMP_OFFICIAL_INVALID');
select pg_temp.expect_msg('event without a competition program is refused', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e003'), pg_temp.u('000013'), pg_temp.u('f00014')), 'COMP_OFFICIAL_INVALID');
select pg_temp.expect_msg('missing request id is refused', format($q$select public.add_competition_official(%L, %L, 'judge', null)$q$, pg_temp.u('00e001'), pg_temp.u('000013')), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.chk('email matching is not a path: candidates list carries user ids',
  (select count(*) from public.list_competition_official_candidates(pg_temp.u('00e001')) where user_id = pg_temp.u('000014') and not account_verified) = 1);
reset role;

-- Identity is also enforced in the table (defence in depth): a direct insert of an unverified account fails.
select pg_temp.expect_msg('table trigger refuses an unverified official even for a privileged writer',
  format($q$insert into public.event_competition_officials (event_id, user_id, role) values (%L, %L, 'judge')$q$, pg_temp.u('00e001'), pg_temp.u('000014')), 'COMP_OFFICIAL_ACCOUNT_NOT_VERIFIED');

-- ============================================================================
-- 4. Idempotency
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('same request replays the stored result',
  (public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f00001')) ->> 'replayed')::boolean);
select pg_temp.expect_msg('request id reused for a different request is refused',
  format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00001')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_ok('add judge 3 + scorer', format($q$select public.add_competition_official(%L, %L, 'judge', %L), public.add_competition_official(%L, %L, 'scorer', %L)$q$,
  pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('f00020'), pg_temp.u('00e001'), pg_temp.u('000016'), pg_temp.u('f00021')));
select pg_temp.chk('a second add with a new request id is a no-op, not a duplicate',
  (public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f00022')) ->> 'noop')::boolean);
reset role;
select pg_temp.chk('exactly four officials exist (judge 1-3 + scorer)', pg_temp.n($q$select count(*) from public.event_competition_officials where event_id = pg_temp.u('00e001')$q$) = 4);

-- ============================================================================
-- 5. Panel: letters, chair, scorer rules
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('assign judge 1 to draft round (auto letter)', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000011'), pg_temp.u('f00030')));
select pg_temp.expect_ok('assign judge 2 (auto letter)', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000012'), pg_temp.u('f00031')));
select pg_temp.expect_ok('assign judge 3 with explicit lowercase letter', format($q$select public.assign_competition_panel_member(%L, %L, 'c', %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000013'), pg_temp.u('f00032')));
select pg_temp.expect_ok('assign scorer (no letter)', format($q$select public.assign_competition_panel_member(%L, %L, 'Z', %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000016'), pg_temp.u('f00033')));
reset role;
select pg_temp.chk('auto letters are A and B, explicit is C',
  (select string_agg(judge_letter, ',' order by judge_letter) from public.event_competition_panel_assignments where round_id = pg_temp.u('006001') and judge_letter is not null) = 'A,B,C');
select pg_temp.chk('the scorer carries no letter even when one is supplied',
  pg_temp.n($q$select count(*) from public.event_competition_panel_assignments where round_id = pg_temp.u('006001') and official_id = pg_temp.off('00e001','000016') and judge_letter is null$q$) = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('judge 1 on round 3 with letter A', format($q$select public.assign_competition_panel_member(%L, %L, 'A', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000011'), pg_temp.u('f00035')));
select pg_temp.expect_msg('duplicate judge letter in a round is refused', format($q$select public.assign_competition_panel_member(%L, %L, 'A', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000012'), pg_temp.u('f00036')), 'COMP_PANEL_LETTER_TAKEN');
select pg_temp.expect_msg('changing a letter needs unassign first', format($q$select public.assign_competition_panel_member(%L, %L, 'B', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000011'), pg_temp.u('f00037')), 'COMP_PANEL_ALREADY_ASSIGNED');
select pg_temp.expect_msg('invalid letter shape is refused', format($q$select public.assign_competition_panel_member(%L, %L, '1', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000012'), pg_temp.u('f00038')), 'letter');
select pg_temp.expect_ok('unassign works while the round is draft', format($q$select public.unassign_competition_panel_member(%L, %L, %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000011'), pg_temp.u('f00039')));
select pg_temp.chk('assignment is gone after unassign', (select count(*) from public.event_competition_panel_assignments where round_id = pg_temp.u('006003')) = 0);

-- chair
select pg_temp.expect_msg('a scorer cannot be chair', format($q$select public.set_competition_chair(%L, %L, %L)$q$, pg_temp.u('00e001'), pg_temp.off('00e001', '000016'), pg_temp.u('f00040')), 'COMP_OFFICIAL_INVALID');
select pg_temp.expect_ok('set judge 3 as chair', format($q$select public.set_competition_chair(%L, %L, %L)$q$, pg_temp.u('00e001'), pg_temp.off('00e001', '000013'), pg_temp.u('f00041')));
select pg_temp.expect_ok('replace chair with judge 1 (judge 3 is demoted)', format($q$select public.set_competition_chair(%L, %L, %L)$q$, pg_temp.u('00e001'), pg_temp.off('00e001', '000011'), pg_temp.u('f00042')));
reset role;
select pg_temp.chk('exactly one active chair, and it is judge 1',
  (select count(*) from public.event_competition_officials where event_id = pg_temp.u('00e001') and role = 'chair' and status = 'active') = 1
  and (select role from public.event_competition_officials where id = pg_temp.off('00e001', '000011')) = 'chair'
  and (select role from public.event_competition_officials where id = pg_temp.off('00e001', '000013')) = 'judge');
select pg_temp.expect_msg('database refuses a second active chair',
  format($q$update public.event_competition_officials set role = 'chair' where id = %L$q$, pg_temp.off('00e001', '000012')), 'duplicate key');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('add as chair while a chair exists is refused', format($q$select public.add_competition_official(%L, %L, 'chair', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000012'), pg_temp.u('f00043')), 'COMP_CHAIR_EXISTS');
select pg_temp.expect_ok('clear chair', format($q$select public.clear_competition_chair(%L, %L)$q$, pg_temp.u('00e001'), pg_temp.u('f00044')));
select pg_temp.expect_ok('set chair again (judge 1)', format($q$select public.set_competition_chair(%L, %L, %L)$q$, pg_temp.u('00e001'), pg_temp.off('00e001', '000011'), pg_temp.u('f00045')));
reset role;

-- ============================================================================
-- 6. Freeze: assignments are frozen once the round leaves draft/scheduled
-- ============================================================================
select pg_temp.expect_ok('a scheduled round still accepts a panel', format($q$select public.assign_competition_panel_member(%L, %L, 'A', %L)$q$, pg_temp.u('006002'), pg_temp.off('00e001', '000011'), pg_temp.u('f00050')));
-- Fixture only: put round 1 into 'active'. When O1 (20270106) is applied its guard trigger refuses direct status writes
-- (correctly: round status moves only through its transition RPCs, which need heats and a published schedule that this E1 suite
-- does not build). E1 only reads the status column, so the fixture bypasses the O1 guard for this single statement and
-- re-enables it; without O1 the plain update runs. Everything is rolled back with the suite.
do $fx$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_rounds'::regclass and tgname = 'compo1_guard_round_status') then
    alter table public.event_competition_rounds disable trigger compo1_guard_round_status;
    update public.event_competition_rounds set status = 'active' where id = pg_temp.u('006001');
    alter table public.event_competition_rounds enable trigger compo1_guard_round_status;
  else
    update public.event_competition_rounds set status = 'active' where id = pg_temp.u('006001');
  end if;
end $fx$;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('assign refused on an active round', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000012'), pg_temp.u('f00051')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('unassign refused on an active round', format($q$select public.unassign_competition_panel_member(%L, %L, %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000012'), pg_temp.u('f00052')), 'COMP_PANEL_FROZEN');
reset role;
select pg_temp.expect_msg('trigger refuses a direct letter update on an active round (privileged writer)',
  format($q$update public.event_competition_panel_assignments set judge_letter = 'Q' where round_id = %L and official_id = %L$q$, pg_temp.u('006001'), pg_temp.off('00e001', '000012')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('trigger refuses a direct delete on an active round',
  format($q$delete from public.event_competition_panel_assignments where round_id = %L$q$, pg_temp.u('006001')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('trigger refuses a direct insert on an active round',
  format($q$insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter) values (%L, %L, %L, 'Y')$q$, pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.off('00e001', '000011')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('trigger refuses truncate', 'truncate public.event_competition_panel_assignments', 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('an active round with a panel cannot be deleted (event still exists)',
  format($q$delete from public.event_competition_rounds where id = %L$q$, pg_temp.u('006001')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('a trigger cannot move an assignment to another round',
  format($q$update public.event_competition_panel_assignments set round_id = %L where round_id = %L and official_id = %L$q$, pg_temp.u('006003'), pg_temp.u('006002'), pg_temp.off('00e001', '000011')), 'COMP_PANEL_FROZEN');

-- ============================================================================
-- 7. Readiness (for O1)
-- ============================================================================
select pg_temp.chk('round 1 (3 lettered judges) is panel-ready', public.competition_round_panel_ready(pg_temp.u('006001')));
select pg_temp.chk('round 3 (no panel) is not ready', not public.competition_round_panel_ready(pg_temp.u('006003')));
select pg_temp.chk('status reports judge count and chair', (public.competition_round_panel_status(pg_temp.u('006001')) ->> 'judge_count')::int = 3
  and (public.competition_round_panel_status(pg_temp.u('006001')) ->> 'chair_designated')::boolean);
update public.event_competition_rounds set configuration = jsonb_build_object('min_panel_judges', 5) where id = pg_temp.u('006001');
select pg_temp.chk('min_panel_judges raises the bar', not public.competition_round_panel_ready(pg_temp.u('006001')));
update public.event_competition_rounds set configuration = '{}'::jsonb where id = pg_temp.u('006001');
select pg_temp.chk('unknown round is not ready', not public.competition_round_panel_ready(pg_temp.u('0000ee')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('an official cannot probe readiness (false)', not public.competition_round_panel_ready(pg_temp.u('006001')));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.chk('another studio cannot probe readiness (false)', not public.competition_round_panel_ready(pg_temp.u('006001')));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the manager sees readiness', public.competition_round_panel_ready(pg_temp.u('006001')));
reset role;

-- ============================================================================
-- 8. Deactivate instead of delete
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('deactivation needs a reason', format($q$select public.deactivate_competition_official(%L, '  ', %L)$q$, pg_temp.off('00e001', '000012'), pg_temp.u('f00060')), 'COMP_REASON_REQUIRED');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot deactivate', format($q$select public.deactivate_competition_official(%L, 'x', %L)$q$, pg_temp.off('00e001', '000012'), pg_temp.u('f00061')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio cannot deactivate', format($q$select public.deactivate_competition_official(%L, 'x', %L)$q$, pg_temp.off('00e001', '000012'), pg_temp.u('f00062')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
-- judge 2 sits on active round 1 (frozen) only; add them to draft round 3 first
select pg_temp.expect_ok('judge 2 onto draft round 3', format($q$select public.assign_competition_panel_member(%L, %L, 'B', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000012'), pg_temp.u('f00063')));
select pg_temp.chk('deactivation removes draft panels and keeps frozen history',
  (public.deactivate_competition_official(pg_temp.off('00e001', '000012'), 'unavailable', pg_temp.u('f00064')) ->> 'assignments_removed')::int = 1);
reset role;
select pg_temp.chk('judge 2 is inactive, row kept, frozen assignment kept',
  (select status from public.event_competition_officials where id = pg_temp.off('00e001', '000012')) = 'inactive'
  and pg_temp.n($q$select count(*) from public.event_competition_panel_assignments where official_id = pg_temp.off('00e001','000012')$q$) = 1);
select pg_temp.expect_msg('an official row can never be deleted', format($q$delete from public.event_competition_officials where id = %L$q$, pg_temp.off('00e001', '000012')), 'COMP_OFFICIAL_IMMUTABLE');
select pg_temp.expect_msg('an official account cannot be re-pointed', format($q$update public.event_competition_officials set user_id = %L where id = %L$q$, pg_temp.u('000011'), pg_temp.off('00e001', '000012')), 'COMP_OFFICIAL_IMMUTABLE');
select pg_temp.expect_msg('officials cannot be truncated', 'truncate public.event_competition_officials', 'cannot truncate');
select pg_temp.expect_msg('an inactive official cannot be assigned (trigger)', format($q$insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter) values (%L, %L, %L, 'M')$q$, pg_temp.u('00e001'), pg_temp.u('006003'), pg_temp.off('00e001', '000012')), 'COMP_OFFICIAL_INACTIVE');
select pg_temp.expect_msg('the scorer/judge switch is refused while assignments exist', format($q$update public.event_competition_officials set role = 'judge' where id = %L$q$, pg_temp.off('00e001', '000016')), 'COMP_OFFICIAL_HAS_ASSIGNMENTS');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('reactivate judge 2', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000012'), pg_temp.u('f00065')));
reset role;
select pg_temp.chk('reactivated official is active again with no deactivation fields',
  (select status = 'active' and deactivated_at is null and deactivation_reason is null from public.event_competition_officials where id = pg_temp.off('00e001', '000012')));

-- ============================================================================
-- 9. Audit
-- ============================================================================
select pg_temp.chk('audit rows carry fixed kinds and the actor',
  pg_temp.n($q$select count(distinct kind) from public.event_competition_official_events where event_id = pg_temp.u('00e001') and actor_user_id is not null$q$) >= 7);
select pg_temp.expect_msg('audit rows cannot be updated', $q$update public.event_competition_official_events set reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('audit rows cannot be deleted', $q$delete from public.event_competition_official_events$q$, 'append-only');
select pg_temp.expect_msg('audit rows cannot be truncated', 'truncate public.event_competition_official_events', 'append-only');
select pg_temp.expect_msg('free-text audit kinds are refused', format($q$insert into public.event_competition_official_events (event_id, kind) values (%L, 'whatever')$q$, pg_temp.u('00e001')), 'check constraint');

-- ============================================================================
-- 10. Reads (K0 reader matrix)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('manager reads all officials of the event', (select count(*) from public.event_competition_officials) = 4);
select pg_temp.chk('manager reads all assignments and audit', (select count(*) from public.event_competition_panel_assignments) >= 5 and (select count(*) from public.event_competition_official_events) > 5);
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('judge sees only their own official row', (select count(*) from public.event_competition_officials) = 1 and (select user_id from public.event_competition_officials) = pg_temp.u('000011'));
select pg_temp.chk('judge sees only their own assignments', (select count(*) from public.event_competition_panel_assignments where official_id <> pg_temp.off('00e001', '000011')) = 0
  and (select count(*) from public.event_competition_panel_assignments) = 2);
select pg_temp.chk('judge cannot read the audit trail', (select count(*) from public.event_competition_official_events) = 0);
select pg_temp.chk('my_competition_judging_assignments returns only own rows',
  (select count(*) from public.my_competition_judging_assignments()) = 2 and (select count(*) from public.my_competition_judging_assignments() where official_role <> 'chair') = 0);
select pg_temp.chk('the shell exposes the judge letter, not other judges',
  (select string_agg(judge_letter, ',' order by judge_letter) from public.my_competition_judging_assignments()) = 'A,A');
select pg_temp.expect_msg('a judge cannot write directly', format($q$insert into public.event_competition_officials (event_id, user_id, role) values (%L, %L, 'judge')$q$, pg_temp.u('00e001'), pg_temp.u('000011')), 'permission denied');
select pg_temp.expect_msg('a judge cannot update assignments directly', $q$update public.event_competition_panel_assignments set judge_letter = 'Z'$q$, 'permission denied');
select pg_temp.expect_msg('a judge cannot assign through the RPC', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000011'), pg_temp.u('f00070')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.chk('judge 2 sees their own panel only', (select count(*) from public.event_competition_panel_assignments) = 1);
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.chk('front desk reads no officials, no assignments, no audit',
  (select count(*) from public.event_competition_officials) = 0 and (select count(*) from public.event_competition_panel_assignments) = 0
  and (select count(*) from public.event_competition_official_events) = 0);
select pg_temp.chk('front desk judging shell is empty', (select count(*) from public.my_competition_judging_assignments()) = 0);
select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.chk('instructor (non official) reads nothing', (select count(*) from public.event_competition_officials) = 0 and (select count(*) from public.event_competition_panel_assignments) = 0);
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.chk('cross-tenant: other studio owner reads nothing of event A',
  (select count(*) from public.event_competition_officials) = 0 and (select count(*) from public.event_competition_panel_assignments) = 0
  and (select count(*) from public.event_competition_official_events) = 0);
select pg_temp.chk('cross-tenant: other studio judging shell is empty', (select count(*) from public.my_competition_judging_assignments()) = 0);
select pg_temp.expect_msg('cross-tenant: other studio cannot assign on event A rounds', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001', '000011'), pg_temp.u('f00071')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('unknown round gives the same error as a foreign one (no oracle)', format($q$select public.assign_competition_panel_member(%L, %L, null, %L)$q$, pg_temp.u('0000ee'), pg_temp.off('00e001', '000011'), pg_temp.u('f00072')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot read officials', 'select count(*) from public.event_competition_officials', 'permission denied');
select pg_temp.expect_msg('anon cannot read assignments', 'select count(*) from public.event_competition_panel_assignments', 'permission denied');
select pg_temp.expect_msg('anon cannot read the judging shell', 'select * from public.my_competition_judging_assignments()', 'permission denied');
reset role;

-- Deactivated official loses reads; an account that loses its verified credential loses reads.
update public.event_competition_officials set status = 'inactive', deactivated_at = now(), deactivation_reason = 'test' where id = pg_temp.off('00e001', '000013');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.chk('inactive official reads nothing', (select count(*) from public.event_competition_officials) = 0 and (select count(*) from public.my_competition_judging_assignments()) = 0);
reset role;
update public.verified_email_identities set credential_status = 'binding_required', bound_at = null, binding_session_id = gen_random_uuid(), binding_started_at = now() where user_id = pg_temp.u('000011');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('an official whose credential is no longer bound reads nothing', (select count(*) from public.my_competition_judging_assignments()) = 0 and (select count(*) from public.event_competition_panel_assignments) = 0);
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('and no longer counts toward panel readiness (only reactivated judge 2 remains)', pg_temp.n($q$select (public.competition_round_panel_status(pg_temp.u('006001')) ->> 'judge_count')::int$q$) = 1);

-- ============================================================================
-- 11. Cascades: deleting the event removes officials, panels (even on an active round) and audit
-- ============================================================================
select pg_temp.expect_ok('event delete cascades through officials, panels and audit', $q$delete from public.events where id = pg_temp.u('00e001')$q$);
select pg_temp.chk('cascade left nothing behind',
  pg_temp.n($q$select (select count(*) from public.event_competition_officials where event_id = pg_temp.u('00e001')) + (select count(*) from public.event_competition_panel_assignments where event_id = pg_temp.u('00e001')) + (select count(*) from public.event_competition_official_events where event_id = pg_temp.u('00e001'))$q$) = 0);

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
    raise exception 'COMPETITION E1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION E1 SQL SUITE FAIL: %', v_failures;
end $$;
