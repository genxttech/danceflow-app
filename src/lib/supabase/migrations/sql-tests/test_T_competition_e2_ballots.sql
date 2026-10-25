-- Competition E2 -- immutable ballots regression suite.
--
-- Covers 20270102090000_competition_e2_ballots.sql on top of 10A..10D.1, E1 (20270101090000) and, when present, O1.
-- Run as a SUPERUSER (fixtures use session_replication_role = replica to place heats in a published schedule version
-- without the 10D publish flow). One transaction, synthetic fixtures only (UUID block ...-e20ff2XXXXXX). The final
-- block ALWAYS raises, so nothing persists:
--   "COMPETITION E2 SQL SUITE PASS (<n> checks)"  or  "COMPETITION E2 SQL SUITE FAIL: <failures>".
-- The concurrent submit-vs-lock race needs a real second connection: see sql-tests/concurrency/run_e2_submit_vs_lock.sh.

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
-- 1. Surface: grants, RLS, anon, helpers
-- ============================================================================
select pg_temp.chk('E2 tables have RLS', (select bool_and(relrowsecurity) from pg_class where oid in (
  'public.event_competition_ballots'::regclass, 'public.event_competition_marks'::regclass,
  'public.event_competition_judge_attendance'::regclass, 'public.event_competition_ballot_events'::regclass)));
select pg_temp.chk('no API role holds table write privileges',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_ballots', 'event_competition_marks', 'event_competition_judge_attendance', 'event_competition_ballot_events')
                and g.grantee in ('anon', 'authenticated', 'service_role', 'public') and g.privilege_type <> 'SELECT'));
select pg_temp.chk('anon holds no table privilege at all',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_ballots', 'event_competition_marks', 'event_competition_judge_attendance', 'event_competition_ballot_events')
                and g.grantee in ('anon', 'public')));
select pg_temp.chk('anon cannot execute any E2 function',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.proname like '\_compe2\_%' or p.proname in ('submit_competition_ballot', 'enter_competition_paper_ballot',
                'record_competition_judge_attendance', 'lock_competition_round_ballots', 'reopen_competition_round_ballots',
                'competition_round_ballot_status', 'competition_judge_ballot_sheet', 'competition_is_round_scorer'))
                and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.chk('internal helpers are not executable by API roles',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like '\_compe2\_%'
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
select pg_temp.chk('every E2 RPC is SECURITY DEFINER with a pinned search_path',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('submit_competition_ballot', 'enter_competition_paper_ballot', 'record_competition_judge_attendance',
                'lock_competition_round_ballots', 'reopen_competition_round_ballots', 'competition_round_ballot_status', 'competition_judge_ballot_sheet')
                and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))));

-- ============================================================================
-- 2. Judge submissions: derived identity, own panel only
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_ok('judge 1 submits r1 heat 1', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20001')));
select pg_temp.expect_ok('judge 1 submits r1 heat 2', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d002', '[2,1]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.u('f20002')));
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.expect_ok('judge 3 submits r1 heat 1 (half-way correct later)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,3,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20005')));
select pg_temp.expect_ok('judge 3 submits r1 heat 2', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.u('f20006')));
-- authorization negatives
select pg_temp.expect_msg('judge 3 is not on the r2 panel', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '["Gold","Gold","Gold"]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f20007')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a heat of another round is refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '["Gold","Gold","Gold"]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d003'), pg_temp.u('f20008')), 'COMP_BALLOT_HEAT_INVALID');
select pg_temp.expect_msg('a round that is not active is refused (r4 draft)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d005', '[1]'), %L)$q$, pg_temp.u('006004'), pg_temp.u('00d005'), pg_temp.u('f20009')), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.expect_msg('missing request id is refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '["Gold","Gold","Gold"]'), null)$q$, pg_temp.u('006002'), pg_temp.u('00d003')), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot submit a judge ballot', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20010')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a manager who is not a judge cannot submit a judge ballot', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20011')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000015'));
select pg_temp.expect_msg('a judge of another studio/event cannot submit to event A', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20012')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('an account with no official role cannot submit', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20013')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot call submit_competition_ballot', format($q$select public.submit_competition_ballot(%L, %L, '[]', %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20014')), 'permission denied');
reset role;
select pg_temp.chk('four ballots exist, all version 1, judge_web, each by its own judge',
  (select count(*) = 4 and bool_and(version = 1 and source = 'judge_web' and entered_by_official_id is null and supersedes_id is null)
          and bool_and(submitted_by = (select user_id from public.event_competition_officials o where o.id = b.official_id)) from public.event_competition_ballots b));
select pg_temp.chk('marks stored per entry, ordinals normalized to integers',
  (select jsonb_typeof(mark) = 'number' from public.event_competition_marks limit 1) and pg_temp.n($q$select count(*) from public.event_competition_marks$q$) = 10);
select pg_temp.chk('one audit row per submission, request ids unique',
  pg_temp.n($q$select count(*) from public.event_competition_ballot_events where kind = 'ballot_submitted'$q$) = 4);

-- ============================================================================
-- 3. Mark validation (parity with src/lib/competition/ballots/schemes.ts) -- first judge, a fresh heat per case
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('proficiency (three_band@1, not approved): any ballot fails closed', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '[1,1,2]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f21001')), 'COMP_BALLOT_FORMAT_NOT_APPROVED');
select pg_temp.expect_msg('proficiency: numeric rank refused (D-PR-3)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '[1,2,3]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f21002')), 'COMP_BALLOT_FORMAT_NOT_APPROVED');
select pg_temp.expect_msg('proficiency: lowercase band refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '["gold","Gold","Gold"]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f21003')), 'COMP_BALLOT_FORMAT_NOT_APPROVED');
select pg_temp.expect_msg('proficiency: "No rating" refused (D-PR-3)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d003', '["No rating","Gold","Gold"]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f21004')), 'COMP_BALLOT_FORMAT_NOT_APPROVED');
select pg_temp.expect_msg('proficiency: partial ballot refused (D-PR-5)', format($q$select public.submit_competition_ballot(%L, %L, (select jsonb_build_array(pg_temp.mk('00d003', '["Gold","Gold","Gold"]') -> 0)), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.u('f21005')), 'COMP_BALLOT_FORMAT_NOT_APPROVED');
select pg_temp.expect_msg('callback_tally: refused until the organizer sets T', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('f21006')), 'COMP_CALLBACK_TARGET_UNSET');
select pg_temp.expect_msg('ordinal: rank above N refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,4]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21007')), 'COMP_BALLOT_MARK_OUT_OF_RANGE');
reset role;
-- ordinal cases need a judge without an existing ballot on the heat: judge 2 on r1
set role authenticated;
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_msg('ordinal: tie refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,1,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21010')), 'COMP_BALLOT_JUDGE_TIE');
select pg_temp.expect_msg('ordinal: zero refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[0,1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21011')), 'COMP_BALLOT_MARK_OUT_OF_RANGE');
select pg_temp.expect_msg('ordinal: fractional refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1.5,1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21012')), 'COMP_BALLOT_MARK_OUT_OF_RANGE');
select pg_temp.expect_msg('ordinal: string rank refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '["1",2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21013')), 'COMP_BALLOT_MARK_OUT_OF_RANGE');
select pg_temp.expect_msg('ordinal: partial ranking refused (D-OM-5)', format($q$select public.submit_competition_ballot(%L, %L, (select jsonb_build_array(pg_temp.mk('00d001', '[1,2,3]') -> 0)), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21014')), 'COMP_BALLOT_INCOMPLETE');
select pg_temp.expect_msg('ordinal: entry of another heat refused', format($q$select public.submit_competition_ballot(%L, %L, jsonb_build_array(jsonb_build_object('entry_id', %L, 'value', 1), pg_temp.mk('00d001','[1,2,3]') -> 1, pg_temp.mk('00d001','[1,2,3]') -> 2), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('008004'), pg_temp.u('f21015')), 'COMP_BALLOT_UNKNOWN_ENTRY');
select pg_temp.expect_msg('ordinal: non-uuid entry id refused', format($q$select public.submit_competition_ballot(%L, %L, '[{"entry_id":"nope","value":1}]', %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21016')), 'COMP_BALLOT_UNKNOWN_ENTRY');
select pg_temp.expect_msg('ordinal: duplicate mark refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]') || (pg_temp.mk('00d001', '[1,2,3]') -> 0), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21017')), 'COMP_BALLOT_DUPLICATE_MARK');
select pg_temp.expect_msg('ordinal: role on a mark refused', format($q$select public.submit_competition_ballot(%L, %L, (select jsonb_agg(m || '{"role":"leader"}'::jsonb) from jsonb_array_elements(pg_temp.mk('00d001','[1,2,3]')) m), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21018')), 'COMP_BALLOT_ROLE_NOT_ALLOWED');
select pg_temp.expect_msg('marks that are not an array are refused', format($q$select public.submit_competition_ballot(%L, %L, '{"a":1}', %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f21019')), 'COMP_BALLOT_INCOMPLETE');
reset role;
select pg_temp.chk('refused ballots left no row behind', pg_temp.n($q$select count(*) from public.event_competition_ballots$q$) = 4);

-- ============================================================================
-- 4. Corrections: new version, reason required, old version kept, chain cannot fork
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.expect_msg('a second ballot without a reason is refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[3,1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f22001')), 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
select pg_temp.expect_msg('a blank reason is refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[3,1,2]'), %L, '   ')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f22002')), 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
select pg_temp.expect_ok('judge 3 corrects heat 1 with a reason', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[3,1,2]'), %L, 'Misread number 102')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f22003')));
select pg_temp.expect_ok('a second correction is version 3', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[2,1,3]'), %L, 'Second thoughts')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f22004')));
reset role;
select pg_temp.chk('versions 1,2,3 all exist, chained',
  (select array_agg(version order by version) = array[1,2,3] from public.event_competition_ballots where heat_id = pg_temp.u('00d001') and official_id = pg_temp.off('00e001','000013')));
select pg_temp.chk('v2 supersedes v1 and v3 supersedes v2; reasons stored',
  (select bool_and(b.supersedes_id = p.id and b.correction_reason is not null)
   from public.event_competition_ballots b join public.event_competition_ballots p on p.heat_id = b.heat_id and p.official_id = b.official_id and p.version = b.version - 1
   where b.official_id = pg_temp.off('00e001','000013') and b.heat_id = pg_temp.u('00d001') and b.version > 1));
select pg_temp.chk('v1 marks are untouched by the corrections',
  (select jsonb_agg(m.mark order by m.entry_id) = '[1,3,2]'::jsonb from public.event_competition_marks m
   join public.event_competition_ballots b on b.id = m.ballot_id where b.version = 1 and b.official_id = pg_temp.off('00e001','000013') and b.heat_id = pg_temp.u('00d001')));
select pg_temp.chk('audit labels: submitted for v1, corrected for v2 and v3',
  pg_temp.n($q$select count(*) from public.event_competition_ballot_events where kind = 'ballot_corrected'$q$) = 2);
-- Chain integrity at the table level (privileged writer)
select pg_temp.expect_msg('a correction cannot fork the chain (second successor of v1)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
            select event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, 2, 'judge_web', submitted_by, id, 'fork' from public.event_competition_ballots
            where heat_id = %L and official_id = %L and version = 1$q$, pg_temp.u('00d001'), pg_temp.off('00e001','000013')), 'duplicate key');
select pg_temp.expect_msg('a second root ballot for the same judge/heat is refused',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
            values (%L, %L, %L, %L, 'ordinal_rank', 1, 1, 'judge_web', %L)$q$, pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.off('00e001','000013'), pg_temp.u('000013')), 'duplicate key');
select pg_temp.expect_msg('a correction must be version + 1 of the latest',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
            select event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, 9, 'judge_web', submitted_by, id, 'skip' from public.event_competition_ballots
            where heat_id = %L and official_id = %L and version = 3$q$, pg_temp.u('00d001'), pg_temp.off('00e001','000013')), 'COMP_BALLOT_IMMUTABLE');
select pg_temp.expect_msg('a correction cannot supersede another judge''s ballot',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
            select b.event_id, b.round_id, b.heat_id, %L, b.ballot_format, b.ballot_format_version, 2, 'judge_web', b.submitted_by, b.id, 'steal' from public.event_competition_ballots b
            where b.heat_id = %L and b.official_id = %L and b.version = 1$q$, pg_temp.off('00e001','000012'), pg_temp.u('00d001'), pg_temp.off('00e001','000011')), 'COMP_BALLOT_IMMUTABLE');

-- ============================================================================
-- 5. Immutability (even for a privileged writer)
-- ============================================================================
select pg_temp.expect_msg('UPDATE ballot refused', $q$update public.event_competition_ballots set correction_reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('DELETE ballot refused', $q$delete from public.event_competition_ballots$q$, 'append-only');
select pg_temp.expect_msg('TRUNCATE ballots refused', 'truncate public.event_competition_ballots', 'cannot truncate');
select pg_temp.expect_msg('UPDATE mark refused', $q$update public.event_competition_marks set mark = '9'::jsonb$q$, 'append-only');
select pg_temp.expect_msg('DELETE mark refused', $q$delete from public.event_competition_marks$q$, 'append-only');
select pg_temp.expect_msg('TRUNCATE marks refused', 'truncate public.event_competition_marks', 'truncate');
select pg_temp.expect_msg('UPDATE audit refused', $q$update public.event_competition_ballot_events set reason = 'x'$q$, 'append-only');
select pg_temp.expect_msg('DELETE audit refused', $q$delete from public.event_competition_ballot_events$q$, 'append-only');
-- NOTE: this suite is ONE transaction, so the 'only in the creating transaction' rule is covered by the concurrency script; here: an entry not on the ballot's heat.
select pg_temp.expect_msg('a mark for an entry that is not on the ballot''s heat is refused',
  format($q$insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark)
            select b.event_id, b.id, %L, '1'::jsonb from public.event_competition_ballots b where b.heat_id = %L and b.official_id = %L and b.version = 1$q$,
         pg_temp.u('008001'), pg_temp.u('00d002'), pg_temp.off('00e001','000011')), 'COMP_BALLOT_UNKNOWN_ENTRY');
select pg_temp.expect_msg('a second mark for the same entry on one ballot is refused (unique index)',
  format($q$insert into public.event_competition_marks (event_id, ballot_id, entry_id, mark)
            select m.event_id, m.ballot_id, m.entry_id, '2'::jsonb from public.event_competition_marks m limit 1$q$), 'duplicate key');
select pg_temp.expect_msg('a round with a panel and ballots cannot be deleted', format($q$delete from public.event_competition_rounds where id = %L$q$, pg_temp.u('006001')), 'COMP_PANEL_FROZEN');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('even the studio owner cannot insert a ballot row directly', format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, version, source, submitted_by) values (%L, %L, %L, %L, 1, 'judge_web', %L)$q$, pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('000001')), 'permission denied');
select pg_temp.expect_msg('nor update one', $q$update public.event_competition_ballots set version = 1$q$, 'permission denied');
select pg_temp.expect_msg('nor delete one', $q$delete from public.event_competition_ballots$q$, 'permission denied');
reset role;

-- ============================================================================
-- 6. Idempotency
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('the same request id replays the original ballot',
  (public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.mk('00d001', '[1,2,3]'), pg_temp.u('f20001')) ->> 'replayed')::boolean);
select pg_temp.expect_msg('a request id reused for another operation is refused',
  format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d002', '[1,2]'), %L, 'x')$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.u('f20001')), 'COMP_REQUEST_REUSED');
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_msg('another judge cannot replay judge 1''s request id',
  format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f20001')), 'COMP_REQUEST_REUSED');
reset role;
select pg_temp.chk('replays wrote nothing', pg_temp.n($q$select count(*) from public.event_competition_ballots$q$) = 6);

-- ============================================================================
-- 7. Scorer paper ballots (audited, on behalf of a named judge)
-- ============================================================================
-- judge 2 has no ballots on r1: the scorer enters them on paper
set role authenticated;
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_ok('scorer enters judge 2''s paper ballot for r1 heat 1', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d001', '[2,3,1]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.off('00e001','000012'), pg_temp.u('f23001')));
select pg_temp.expect_msg('the named official must be on the round''s panel (the chair is not on r2)', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d003', '["Gold","Gold","Gold"]'), %L)$q$, pg_temp.u('006002'), pg_temp.u('00d003'), pg_temp.off('00e001','000017'), pg_temp.u('f23002')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.expect_msg('a scorer cannot name a scorer as the judge', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.off('00e001','000016'), pg_temp.u('f23003')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.expect_msg('a scorer not assigned to the round is refused', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23004')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot enter paper ballots', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23005')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot enter paper ballots', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23006')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio''s owner cannot enter paper ballots', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23007')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('a manager can enter judge 2''s paper ballot for heat 2', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[1,2]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23008')));
reset role;
select pg_temp.chk('paper ballot: scorer_paper, entered_by = the scorer official, submitted_by = the scorer account',
  (select source = 'scorer_paper' and entered_by_official_id = pg_temp.off('00e001','000016') and submitted_by = pg_temp.u('000016') and official_id = pg_temp.off('00e001','000012')
   from public.event_competition_ballots where heat_id = pg_temp.u('00d001') and official_id = pg_temp.off('00e001','000012')));
select pg_temp.chk('manager paper ballot: scorer_paper with entered_by null, submitted_by = the manager',
  (select source = 'scorer_paper' and entered_by_official_id is null and submitted_by = pg_temp.u('000001')
   from public.event_competition_ballots where heat_id = pg_temp.u('00d002') and official_id = pg_temp.off('00e001','000012')));
select pg_temp.expect_msg('a judge_web ballot cannot carry an entered_by official (constraint)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, entered_by_official_id)
            values (%L, %L, %L, %L, 'ordinal_rank', 1, 1, 'judge_web', %L, %L)$q$, pg_temp.u('00e001'), pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.off('00e001','000011'), pg_temp.u('000011'), pg_temp.off('00e001','000016')), 'entered_by_check');
-- a paper correction over a web ballot goes through the same versioning chain
set role authenticated;
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('paper over an existing ballot needs a reason', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[2,1]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23009')), 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
select pg_temp.expect_ok('paper correction with a reason', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d002', '[2,1]'), %L, 'Re-keyed from the sheet')$q$, pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.off('00e001','000012'), pg_temp.u('f23010')));
reset role;
select pg_temp.chk('paper audit rows record the actor and entered_by in refs',
  pg_temp.n($q$select count(*) from public.event_competition_ballot_events where refs ->> 'source' = 'scorer_paper' and actor_user_id in (select u from (values (pg_temp.u('000016')), (pg_temp.u('000001'))) t(u))$q$) = 3);

-- ============================================================================
-- 8. Read isolation (RLS = K0 reader matrix)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('judge 1 reads exactly their own two ballots', pg_temp.nb() = 2 and pg_temp.nb(format('official_id = %L', pg_temp.off('00e001','000011'))) = 2);
select pg_temp.chk('judge 1 reads only marks of their own ballots', (select count(*) from public.event_competition_marks) = 5);
select pg_temp.chk('judge 1 sees no attendance, audit or others'' rows', (select count(*) from public.event_competition_ballot_events) = 0);
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.chk('judge 2 reads only their own ballots (paper v1 h1, v1 h2, v2 h2)', pg_temp.nb() = 3 and pg_temp.nb(format('official_id <> %L', pg_temp.off('00e001','000012'))) = 0);
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.chk('judge 3 reads all versions of their own ballots (4) and nothing else', pg_temp.nb() = 4);
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.chk('the assigned scorer reads every ballot of their round', pg_temp.nb() = (select count(*) from public.event_competition_ballots) and pg_temp.nb() >= 9);
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.chk('an unassigned scorer reads no ballot', pg_temp.nb() = 0 and (select count(*) from public.event_competition_marks) = 0);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the manager reads all ballots and marks of their event', pg_temp.nb() >= 9 and (select count(*) from public.event_competition_marks) >= 23);
select pg_temp.chk('the manager reads the audit', (select count(*) from public.event_competition_ballot_events) >= 9);
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.chk('front desk (not a manager, not an official) reads nothing', pg_temp.nb() = 0 and (select count(*) from public.event_competition_marks) = 0);
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.chk('another studio''s owner reads nothing of event A', pg_temp.nb() = 0 and (select count(*) from public.event_competition_ballot_events) = 0);
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.chk('a verified outsider (entrant-like) reads nothing', pg_temp.nb() = 0 and (select count(*) from public.event_competition_marks) = 0);
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot read ballots', 'select count(*) from public.event_competition_ballots', 'permission denied');
select pg_temp.expect_msg('anon cannot read marks', 'select count(*) from public.event_competition_marks', 'permission denied');
reset role;

-- Judge sheet and status board
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('judge sheet: own letter, two heats, own current ballot only',
  (public.competition_judge_ballot_sheet(pg_temp.u('006001')) ->> 'judge_letter') = 'A'
  and jsonb_array_length(public.competition_judge_ballot_sheet(pg_temp.u('006001')) -> 'heats') = 2
  and (public.competition_judge_ballot_sheet(pg_temp.u('006001')) #>> '{heats,0,ballot,version}')::int = 1);
select pg_temp.chk('judge sheet shows entries with numbers',
  jsonb_array_length(public.competition_judge_ballot_sheet(pg_temp.u('006001')) #> '{heats,0,entries}') = 3);
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.chk('judge 3 sheet shows the current (v3) ballot',
  (public.competition_judge_ballot_sheet(pg_temp.u('006001')) #>> '{heats,0,ballot,version}')::int = 3);
select pg_temp.expect_msg('judge 3 has no sheet for r2', format($q$select public.competition_judge_ballot_sheet(%L)$q$, pg_temp.u('006002')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('outsider has no sheet', format($q$select public.competition_judge_ballot_sheet(%L)$q$, pg_temp.u('006001')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.expect_msg('judge cannot read the status board', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot read the status board', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio cannot read the status board', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.expect_msg('an unassigned scorer cannot read the status board', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.chk('the assigned scorer reads the status board', (public.competition_round_ballot_status(pg_temp.u('006001')) ->> 'viewer_role') = 'scorer');
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.chk('the chair reads the status board', (public.competition_round_ballot_status(pg_temp.u('006001')) ->> 'viewer_role') = 'chair');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('status board: 3 judges, 2 heats, blockers show heats not locked',
  jsonb_array_length(public.competition_round_ballot_status(pg_temp.u('006001')) -> 'judges') = 3
  and jsonb_array_length(public.competition_round_ballot_status(pg_temp.u('006001')) #> '{blockers,heats_not_locked}') = 2);
select pg_temp.chk('status board reports the callback target and eligible couples', (public.competition_round_ballot_status(pg_temp.u('006003')) ->> 'scheme_available')::boolean);
reset role;

-- ============================================================================
-- 9. Attendance (recorded absence, O1)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_ok('judge 1 submits r5', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[1,2]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f24020')));
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_ok('judge 2 submits r5', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[2,1]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f24021')));
select pg_temp.as_user(pg_temp.u('000013'));
select pg_temp.expect_ok('judge 3 submits r5', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[1,2]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f24022')));
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24002')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24004')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('an absence needs a reason', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', '  ', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24005')), 'COMP_ATTENDANCE_INVALID');
select pg_temp.expect_msg('a judge not on the round''s panel cannot be recorded', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000017'), pg_temp.u('f24006')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a judge with ballots cannot be recorded absent', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001','000011'), pg_temp.u('f24007')), 'COMP_ABSENCE_HAS_BALLOTS');
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('the chair records judge 2 absent on r2', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'Flight delayed', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24008')));
select pg_temp.as_user(pg_temp.u('000014'));
select pg_temp.expect_msg('an absent judge cannot submit', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[1,2]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f24009')), 'COMP_BALLOT_JUDGE_ABSENT');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('nor can a manager enter paper for an absent judge', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d007', '[1,2]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.off('00e001','000014'), pg_temp.u('f24010')), 'COMP_BALLOT_JUDGE_ABSENT');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the manager records judge 2 present again', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24011')));
select pg_temp.as_user(pg_temp.u('000014'));
select pg_temp.chk('a judge marked present is no longer absent on their sheet', (public.competition_judge_ballot_sheet(pg_temp.u('006005')) ->> 'absent')::boolean = false);
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('the chair records judge 4 absent again (final state before the lock)', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'Flight cancelled', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24013')));
select pg_temp.expect_msg('replaying an attendance request id with a different status is refused', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000014'), pg_temp.u('f24013')), 'COMP_REQUEST_REUSED');
reset role;
select pg_temp.chk('attendance history is insert-only with audit', pg_temp.n($q$select count(*) from public.event_competition_judge_attendance$q$) = 3
  and pg_temp.n($q$select count(*) from public.event_competition_ballot_events where kind in ('judge_absence_recorded','judge_presence_recorded')$q$) = 3);
select pg_temp.expect_msg('attendance cannot be updated', $q$update public.event_competition_judge_attendance set status = 'present'$q$, 'append-only');
select pg_temp.expect_msg('attendance cannot be deleted', $q$delete from public.event_competition_judge_attendance$q$, 'append-only');

-- ============================================================================
-- 9b. Callback ballots: round-level, exactly T across the whole round, drafts are separate and mutable
-- ============================================================================
-- r3 eligible couples: 109, 110 (heat 4) and 112, 113 (heat 6); T unset at first.
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('save draft is refused for an ineligible couple', format($q$select public.save_competition_callback_draft(%L, array[%L]::uuid[])$q$, pg_temp.u('006003'), pg_temp.u('008001')), 'COMP_BALLOT_UNKNOWN_ENTRY');
select pg_temp.expect_ok('judge 1 saves a draft across heats', format($q$select public.save_competition_callback_draft(%L, array[%L, %L]::uuid[])$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008012')));
select pg_temp.expect_msg('drafts exist only for callback rounds', format($q$select public.save_competition_callback_draft(%L, array[%L]::uuid[])$q$, pg_temp.u('006001'), pg_temp.u('008001')), 'COMP_BALLOT_HEAT_INVALID');
select pg_temp.chk('the judge sees their own draft in the sheet', jsonb_array_length(public.competition_judge_ballot_sheet(pg_temp.u('006003')) #> '{callback,draft}') = 2);
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_msg('another judge cannot save a draft on a round they are not on', format($q$select public.save_competition_callback_draft(%L, array[%L]::uuid[])$q$, pg_temp.u('006003'), pg_temp.u('008009')), 'COMP_JUDGE_NOT_ASSIGNED');
select pg_temp.chk('and cannot read the draft table', (select count(*) from public.event_competition_ballot_drafts) = 0);
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('judge 1 reads exactly one draft row', (select count(*) from public.event_competition_ballot_drafts) = 1);
select pg_temp.expect_msg('a draft cannot be written directly', $q$update public.event_competition_ballot_drafts set selections = '[]'$q$, 'permission denied');
reset role;
select pg_temp.chk('a draft is not a ballot', pg_temp.n($q$select count(*) from public.event_competition_ballots where round_id = pg_temp.u('006003')$q$) = 0);
set session_replication_role = replica;
update public.event_competition_rounds set target_advancement_count = 2 where id = pg_temp.u('006003');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('callback: one couple is not T (exactly T required)', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('f29001')), 'COMP_CALLBACK_COUNT');
select pg_temp.expect_msg('callback: three couples is not T', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008010'), pg_temp.u('008012'), pg_temp.u('f29002')), 'COMP_CALLBACK_COUNT');
select pg_temp.expect_msg('callback: a couple from another round is refused', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008001'), pg_temp.u('f29003')), 'COMP_BALLOT_UNKNOWN_ENTRY');
select pg_temp.expect_msg('callback: a mark is yes only (D-CT-1)', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":false},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008012'), pg_temp.u('f29004')), 'COMP_BALLOT_MARK_NOT_IN_SCALE');
select pg_temp.expect_msg('callback: the same couple twice is refused', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008009'), pg_temp.u('f29005')), 'COMP_BALLOT_DUPLICATE_MARK');
select pg_temp.expect_msg('callback: naming a heat is refused (round-level ballot)', format($q$select public.submit_competition_ballot(%L, %L, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('00d004'), pg_temp.u('008009'), pg_temp.u('008012'), pg_temp.u('f29006')), 'COMP_BALLOT_HEAT_INVALID');
select pg_temp.expect_ok('callback: exactly T=2 couples across two heats submits one round-level ballot', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008009'), pg_temp.u('008012'), pg_temp.u('f29007')));
select pg_temp.expect_msg('callback: a second ballot needs a reason', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L)$q$, pg_temp.u('006003'), pg_temp.u('008010'), pg_temp.u('008013'), pg_temp.u('f29008')), 'COMP_BALLOT_CORRECTION_REASON_REQUIRED');
select pg_temp.expect_ok('callback: a correction is version 2 of the same round-level chain', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L, 'Changed my mind')$q$, pg_temp.u('006003'), pg_temp.u('008010'), pg_temp.u('008013'), pg_temp.u('f29009')));
reset role;
select pg_temp.chk('callback ballots have a null heat, versions 1 and 2, two mark rows each',
  (select count(*) = 2 and bool_and(heat_id is null) and array_agg(version order by version) = array[1,2]
     and bool_and((select count(*) from public.event_competition_marks m where m.ballot_id = b.id) = 2)
   from public.event_competition_ballots b where b.round_id = pg_temp.u('006003')));
select pg_temp.chk('callback marks are boolean yes', (select bool_and(m.mark = 'true'::jsonb) from public.event_competition_marks m join public.event_competition_ballots b on b.id = m.ballot_id where b.round_id = pg_temp.u('006003')));
select pg_temp.expect_msg('a second root round-level ballot is refused (unique)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by) values (%L, %L, %L, 'callback_yes', 1, 1, 'judge_web', %L)$q$, pg_temp.u('00e001'), pg_temp.u('006003'), pg_temp.off('00e001','000011'), pg_temp.u('000011')), 'duplicate key');
select pg_temp.expect_msg('a ballot whose format is not the round''s format is refused (trigger)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by) values (%L, %L, %L, 'callback_yes', 1, 1, 'judge_web', %L)$q$, pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.off('00e001','000011'), pg_temp.u('000011')), 'COMP_BALLOT_FORMAT_MISMATCH');
set session_replication_role = replica;
update public.event_competition_rounds set target_advancement_count = 4 where id = pg_temp.u('006003');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('callback: T >= eligible couples means the round is not danced (D-CT-5)', format($q$select public.submit_competition_ballot(%L, null, '[{"entry_id":"%s","value":true},{"entry_id":"%s","value":true}]', %L, 'again')$q$, pg_temp.u('006003'), pg_temp.u('008010'), pg_temp.u('008013'), pg_temp.u('f29010')), 'COMP_CALLBACK_NOT_DANCED');
reset role;
set session_replication_role = replica;
update public.event_competition_rounds set target_advancement_count = 2 where id = pg_temp.u('006003');
set session_replication_role = origin;
-- X-3 is enforced at lock; callback and ordinal need an odd panel of at least 3
select pg_temp.chk('lock readiness for a one-judge callback round reports panel_ok = false', not (public._compe2_round_blockers(pg_temp.u('006003')) ->> 'panel_ok')::boolean);

-- Review regression (P0-1): a caller with NO relation to the round must be refused, not slip past a NULL role.
set role authenticated;
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('unrelated verified user cannot enter paper ballots', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d007', '[1,2]'), %L, 'x')$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.off('00e001','000011'), pg_temp.u('f2a001')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('unrelated verified user cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001','000011'), pg_temp.u('f2a002')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('unrelated verified user cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f2a003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000018'));
select pg_temp.expect_msg('a scorer assigned to another round cannot enter paper ballots on r5', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d007', '[1,2]'), %L, 'x')$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.off('00e001','000011'), pg_temp.u('f2a004')), 'COMP_FORBIDDEN');
-- request id bound to its payload (P2-1)
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('replaying a request id with different marks is refused', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[2,1]'), %L, 'again')$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f24020')), 'COMP_REQUEST_REUSED');
reset role;
select pg_temp.expect_msg('scoring method / callback target are frozen once a round has started (P1-1)', format($q$update public.event_competition_rounds set scoring_method = 'callback_tally' where id = %L$q$, pg_temp.u('006005')), 'COMP_ROUND_CONFIG_FROZEN');

-- ============================================================================
-- 10. Lock preconditions and authority (round r1)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('lock refused while heats are open', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25001')), 'COMP_BALLOTS_HEATS_NOT_LOCKED');
select public.set_competition_heat_lock_state(pg_temp.u('00d001'), 'locked', 'dance complete');
select public.set_competition_heat_lock_state(pg_temp.u('00d002'), 'locked', 'dance complete');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25002')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25004')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio''s owner cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25005')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25006')), 'permission denied');
reset role;
-- r2: judge 1 has no r2 ballot yet -> incomplete (missing ballots), heat not locked as well
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('lock refused: a present judge has no ballot (r2, judge 1)', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006002'), pg_temp.u('f25007')), 'COMP_BALLOTS_INCOMPLETE');
select pg_temp.expect_msg('lock refused on a draft round', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006004'), pg_temp.u('f25008')), 'COMP_BALLOTS_BAD_STATE');
select pg_temp.expect_msg('missing request id is refused', format($q$select public.lock_competition_round_ballots(%L, null)$q$, pg_temp.u('006001')), 'COMP_REQUEST_ID_REQUIRED');
reset role;
-- r1 is complete (J1,J2,J3 web; chair D paper) and heats are locked: the chair locks it
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('the designated chair locks r1', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25009')));
reset role;
select pg_temp.chk('r1 is ballots_locked', (select status = 'ballots_locked' from public.event_competition_rounds where id = pg_temp.u('006001')));
select pg_temp.chk('lock wrote one round_state_changed audit row with from/to',
  (select count(*) = 1 and bool_and(from_state = 'active' and to_state = 'ballots_locked' and actor_user_id = pg_temp.u('000017'))
   from public.event_competition_ballot_events where kind = 'round_state_changed' and round_id = pg_temp.u('006001')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.chk_sql('the same request replays', $q$select (public.lock_competition_round_ballots(pg_temp.u('006001'), pg_temp.u('f25009')) ->> 'replayed')::boolean$q$);
select pg_temp.expect_msg('a second lock with a new id is a bad state', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f25010')), 'COMP_BALLOTS_BAD_STATE');
select pg_temp.expect_msg('the id cannot be reused for another round', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006002'), pg_temp.u('f25009')), 'COMP_REQUEST_REUSED');
-- locked round refuses everything
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('judge cannot correct once locked', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[3,2,1]'), %L, 'late')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f25011')), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('scorer cannot enter paper once locked', format($q$select public.enter_competition_paper_ballot(%L, %L, %L, pg_temp.mk('00d001', '[3,2,1]'), %L, 'late')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.off('00e001','000011'), pg_temp.u('f25012')), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('attendance cannot change once locked', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'late', %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001','000012'), pg_temp.u('f25013')), 'COMP_BALLOTS_BAD_STATE');
reset role;
select pg_temp.expect_msg('the trigger also refuses a ballot on a locked round (privileged writer)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
            select event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version + 1, 'judge_web', submitted_by, id, 'x' from public.event_competition_ballots
            where heat_id = %L and official_id = %L and version = 1$q$, pg_temp.u('00d002'), pg_temp.off('00e001','000011')), 'COMP_BALLOT_ROUND_NOT_ACTIVE');
select pg_temp.expect_msg('direct status write active<->locked without the RPC is refused (guard)',
  format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.u('006001')), 'COMP_ROUND_LOCK_WRITER');
select pg_temp.expect_msg('direct status write into ballots_locked without the RPC is refused (guard)',
  format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.u('006009')), 'COMP_ROUND_LOCK_WRITER');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an API role cannot write round status', format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.u('006001')), 'WRITER');
reset role;

-- Absent judge satisfies the lock (O1) and X-4: r5 has judges 1-3 with ballots and judge 4 recorded absent -> 3 present, odd.
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('r5 refused: heat not locked', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f26002')), 'COMP_BALLOTS_HEATS_NOT_LOCKED');
reset role;
-- re-review regression (P1-1): an entry scratched after ballots exist makes them stale; lock refuses until they are corrected
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.u('00d007') and entry_id = pg_temp.u('008015');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('lock refused: current ballots mark an entry that was scratched (stale)', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f26010')), 'COMP_BALLOTS_STALE');
reset role;
update public.event_competition_heat_entries set status = 'scheduled' where heat_id = pg_temp.u('00d007') and entry_id = pg_temp.u('008015');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.u('00d007'), 'locked', 'dance complete');
select pg_temp.expect_ok('r5 locks with one judge absent (recorded) and a reduced odd panel of 3', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f26003')));
reset role;
select pg_temp.chk('the lock audit names the absent judge',
  (select (refs -> 'absent_official_ids') ? pg_temp.off('00e001','000014')::text from public.event_competition_ballot_events where kind = 'round_state_changed' and round_id = pg_temp.u('006005')));

-- Everyone absent: refused (no present judge)
-- (r3 callback: single judge; scheme unavailable blocks ballots, so absent + locked heat is the only path)
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a judge with a round-level ballot cannot be recorded absent', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'Out', %L)$q$, pg_temp.u('006003'), pg_temp.off('00e001','000011'), pg_temp.u('f26004')), 'COMP_ABSENCE_HAS_BALLOTS');
select public.set_competition_heat_lock_state(pg_temp.u('00d004'), 'locked', 'dance complete');
select public.set_competition_heat_lock_state(pg_temp.u('00d006'), 'locked', 'dance complete');
select pg_temp.expect_msg('a one-judge callback round cannot lock (X-3: at least 3, odd)', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006003'), pg_temp.u('f26005')), 'COMP_PANEL_SIZE');
reset role;

-- ============================================================================
-- 11. Reopen
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('the chair cannot reopen (manager only, O2)', format($q$select public.reopen_competition_round_ballots(%L, 'oops', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('a scorer cannot reopen', format($q$select public.reopen_competition_round_ballots(%L, 'oops', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27002')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another studio cannot reopen', format($q$select public.reopen_competition_round_ballots(%L, 'oops', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('reopen needs a reason', format($q$select public.reopen_competition_round_ballots(%L, '   ', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27004')), 'COMP_RESULT_REASON_REQUIRED');
select pg_temp.expect_msg('only locked rounds reopen', format($q$select public.reopen_competition_round_ballots(%L, 'why', %L)$q$, pg_temp.u('006004'), pg_temp.u('f27005')), 'COMP_BALLOTS_BAD_STATE');
reset role;
-- F2/F3 guards: a fake result_versions table with an approved version blocks reopen (guard on existence)
create table public.event_competition_result_versions (id uuid primary key default gen_random_uuid(), round_id uuid not null, status text not null);
insert into public.event_competition_result_versions (round_id, status) values (pg_temp.u('006001'), 'approved');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('reopen refused once a result version is approved', format($q$select public.reopen_competition_round_ballots(%L, 'why', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27006')), 'COMP_REOPEN_RESULT_APPROVED');
reset role;
update public.event_competition_result_versions set status = 'calculated';
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('reopen allowed while the result version is only calculated', format($q$select public.reopen_competition_round_ballots(%L, 'Judge 2 mis-keyed heat 1', %L)$q$, pg_temp.u('006001'), pg_temp.u('f27007')));
reset role;
drop table public.event_competition_result_versions;
select pg_temp.chk('r1 is active again; ballots untouched', (select status = 'active' from public.event_competition_rounds where id = pg_temp.u('006001')) and pg_temp.n($q$select count(*) from public.event_competition_ballots where round_id = pg_temp.u('006001')$q$) = 9);
select pg_temp.chk('reopen audit carries the reason', (select reason = 'Judge 2 mis-keyed heat 1' and from_state = 'ballots_locked' and to_state = 'active'
  from public.event_competition_ballot_events where request_id = pg_temp.u('f27007')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk_sql('reopen replays', $q$select (public.reopen_competition_round_ballots(pg_temp.u('006001'), 'Judge 2 mis-keyed heat 1', pg_temp.u('f27007')) ->> 'replayed')::boolean$q$);
select pg_temp.as_user(pg_temp.u('000012'));
select pg_temp.expect_ok('a correction is accepted again after reopen', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[2,3,1]'), %L, 'Mis-keyed after the dance')$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f27008')));
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('the chair locks again', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006001'), pg_temp.u('f27009')));
reset role;

-- ============================================================================
-- 12. Cross-tenant
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('owner B cannot record attendance in event A', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006001'), pg_temp.off('00e001','000012'), pg_temp.u('f28001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('owner A cannot lock event B''s round', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006009'), pg_temp.u('f28002')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('owner A cannot read event B''s status board', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006009')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000015'));
select pg_temp.expect_ok('judge B submits in event B', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d009', '[2,1]'), %L)$q$, pg_temp.u('006009'), pg_temp.u('00d009'), pg_temp.u('f28003')));
select pg_temp.expect_msg('judge B cannot use an event A heat in event B''s round', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,2,3]'), %L, 'x')$q$, pg_temp.u('006009'), pg_temp.u('00d001'), pg_temp.u('f28004')), 'COMP_BALLOT_HEAT_INVALID');
select pg_temp.chk('judge B reads only their own ballot', pg_temp.nb() = 1);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('owner A does not read event B ballots', pg_temp.nb(format('event_id = %L', pg_temp.u('00e002'))) = 0);
reset role;
select pg_temp.expect_msg('cross-event ballot row is refused by composite FKs (heat of event A, round of event B)',
  format($q$insert into public.event_competition_ballots (event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by) values (%L, %L, %L, %L, 'ordinal_rank', 1, 1, 'judge_web', %L)$q$,
         pg_temp.u('00e002'), pg_temp.u('006009'), pg_temp.u('00d001'), pg_temp.off('00e002','000015'), pg_temp.u('000015')), 'COMP_BALLOT_HEAT_INVALID');

-- ============================================================================
-- 13. Canonical shape the engine will read (K0 canonicalJson input): current ballots only, deterministic order
-- ============================================================================
select pg_temp.chk('exactly one current ballot per (judge, heat) in r1 after all corrections',
  (select count(*) = 6 from public.event_competition_ballots b where b.round_id = pg_temp.u('006001')
     and not exists (select 1 from public.event_competition_ballots s where s.supersedes_id = b.id)));

-- ============================================================================
-- 14. Cascades: deleting the event removes the evidence with it
-- ============================================================================
select pg_temp.expect_ok('event delete cascades through ballots, marks and audit (event B; event A has locked heats, which 10A protects)', $q$delete from public.events where id = pg_temp.u('00e002')$q$);
select pg_temp.chk('cascade left nothing behind',
  pg_temp.n($q$select (select count(*) from public.event_competition_ballots where event_id = pg_temp.u('00e002'))
                    + (select count(*) from public.event_competition_marks where event_id = pg_temp.u('00e002'))
                    + (select count(*) from public.event_competition_judge_attendance where event_id = pg_temp.u('00e002'))
                    + (select count(*) from public.event_competition_ballot_events where event_id = pg_temp.u('00e002'))$q$) = 0);

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
    raise exception 'COMPETITION E2 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION E2 SQL SUITE FAIL: %', v_failures;
end $$;
