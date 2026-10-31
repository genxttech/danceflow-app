-- Competition CF1 A2 -- pinned lock-ballots eligibility check suite (OD-17 D stage `lock`, OD-15 A minimum for callback Finals).
--
-- Covers 20270120092000_competition_cf1_a2_lock_check.sql on top of the chain through HL1 (0119) and CF1 A1 (20270120085000). Run as a
-- SUPERUSER (the fixture is E2's/HL1's: heats sit in a published schedule version via session_replication_role = replica). One
-- transaction, synthetic fixtures only (UUID block ...-c1a2f2XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A2 LOCK CHECK SQL SUITE PASS (<n> checks)"  or  "... FAIL: <failures>".
-- The lock-vs-lifecycle deadlock probe needs real second connections: see sql-tests/concurrency/run_cf1_a2_lock_vs_lifecycle.sh.

begin;

-- A0 compatibility: once A0 (20270120090000) is applied its ENABLE ALWAYS guards refuse the hand-built heats, heat entries and entry/round
-- writes below (the suite places rows directly, like the E2/HL1 suites). Inside this rolled-back transaction the CF1 guards on the four
-- fixture tables are switched off so the A2 check is tested on the same fixtures with or without A0.
do $$
declare r record;
begin
  for r in select t.tgname, t.tgrelid::regclass as rel from pg_trigger t
           where not t.tgisinternal and t.tgname like 'cf1_%'
             and t.tgrelid in ('public.event_competition_heats'::regclass, 'public.event_competition_heat_entries'::regclass,
                               'public.event_competition_rounds'::regclass, 'public.event_competition_entries'::regclass) loop
    execute format('alter table %s disable trigger %I', r.rel, r.tgname);
  end loop;
end $$;


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
language sql immutable as $$ select ('00000000-0000-0000-0000-c1a2f2' || p_suffix)::uuid $$;
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
select id, email, 'E2 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-c1a2f2%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-c1a2f2%';

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

-- A2 helpers -----------------------------------------------------------------
-- Calls lock as the current role and returns 'ok' or 'SQLSTATE|message|detail'.
create or replace function pg_temp.lock_try(p_round uuid, p_req uuid) returns text
language plpgsql as $$
declare v_msg text; v_detail text; v_state text;
begin
  perform public.lock_competition_round_ballots(p_round, p_req);
  return 'ok';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  v_state := sqlstate;
  return v_state || '|' || v_msg || '|' || coalesce(v_detail, '');
end $$;
grant execute on function pg_temp.lock_try(uuid, uuid) to authenticated, anon, service_role;
create or replace function pg_temp.nev(p_round uuid) returns bigint
language sql stable security definer as $$ select count(*) from public.event_competition_ballot_events where round_id = p_round and kind = 'round_state_changed' $$;
grant execute on function pg_temp.nev(uuid) to authenticated, anon, service_role;
create or replace function pg_temp.set_status(p_entry uuid, p_status text, p_elig text) returns void
language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_entries set status = p_status, eligibility_status = p_elig where id = p_entry;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on function pg_temp.set_status(uuid, text, text) to authenticated, anon, service_role;
create or replace function pg_temp.lock_replayed(p_round uuid, p_req uuid) returns text
language plpgsql as $$
begin
  return (public.lock_competition_round_ballots(p_round, p_req)) ->> 'replayed';
exception when others then
  return 'ERR ' || sqlerrm;
end $$;
grant execute on function pg_temp.lock_replayed(uuid, uuid) to authenticated, anon, service_role;

-- Extra fixture: orders and registrations; callback Final (division 003006) and Final-only one-couple (division 003007) rounds.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b1@example.test', 'paid'),
  (pg_temp.u('0a0002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b2@example.test', 'partially_refunded');
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email) values
  (pg_temp.u('0b0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'Paid', 'g1@example.test'),
  (pg_temp.u('0b0002'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0002'), 'confirmed', 'paid', 'G', 'Part', 'g2@example.test');
-- E103 pays through a registration, E104 through a partially refunded order; E101, E102, E105 are manual / comped (no links at all)
update public.event_competition_entries set registration_id = pg_temp.u('0b0001'), order_id = pg_temp.u('0a0001') where id = pg_temp.u('008003');
update public.event_competition_entries set order_id = pg_temp.u('0a0002') where id = pg_temp.u('008004');

update public.event_competition_programs set advancement_method = 'promote_callback' where id = pg_temp.u('001001');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D6', 'open'),
  (pg_temp.u('003007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D7', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values
  (pg_temp.u('006006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'R6 Prelim', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'R7 Callback Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'R8 Final only', 'final', 1, 'draft', 'ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008030'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'E130', 'confirmed', 'eligible', '130'),
  (pg_temp.u('008031'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'E131', 'confirmed', 'eligible', '131'),
  (pg_temp.u('008032'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'E132', 'confirmed', 'eligible', '132');
set session_replication_role = replica;
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d010'), pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('006007'), 10, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d011'), pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('006008'), 11, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status) values
  (pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('00d010'), pg_temp.u('008030'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('00d010'), pg_temp.u('008031'), 2, 'scratched'),
  (pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('00d011'), pg_temp.u('008032'), 1, 'scheduled');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.assign_competition_panel_member(pg_temp.u('006007'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10071'));
select public.assign_competition_panel_member(pg_temp.u('006007'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10072'));
select public.assign_competition_panel_member(pg_temp.u('006007'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10073'));
select public.assign_competition_panel_member(pg_temp.u('006008'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10081'));
select public.assign_competition_panel_member(pg_temp.u('006008'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10082'));
select public.assign_competition_panel_member(pg_temp.u('006008'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10083'));
reset role;
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.u('006007'), pg_temp.u('006008'));
set session_replication_role = origin;

-- ============================================================================
-- 1. Surface: the redefinition is exactly one A2 block; privileges, owner, config unchanged
-- ============================================================================
select pg_temp.chk('lock_competition_round_ballots carries the A2 block exactly once',
  (select (length(d) - length(replace(d, 'CF1 A2 (OD-17 D', ''))) / length('CF1 A2 (OD-17 D') = 1
     from (select replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '') d) x));
select pg_temp.chk('the HL1 block is still present once (single insertion on top of HL1)',
  (select (length(d) - length(replace(d, 'COMP_HL1_HEAT_NOT_DANCED', ''))) / length('COMP_HL1_HEAT_NOT_DANCED') = 1
     from (select pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure) d) x));
select pg_temp.chk('the A2 block sits after the replay branch, the heat-entry FOR SHARE and the readiness checks, before the audit insert and the status write',
  (select position('v_prev.kind = ''round_state_changed''' in d) < position('where he.heat_id in' in d)
      and position('where he.heat_id in' in d) < position('COMP_BALLOTS_HEATS_NOT_LOCKED' in d)
      and position('COMP_BALLOTS_HEATS_NOT_LOCKED' in d) < position('CF1 A2 (OD-17 D' in d)
      and position('CF1 A2 (OD-17 D' in d) < position('into v_absent' in d)
      and position('into v_absent' in d) < position('_compe2_audit' in d)
      and position('_compe2_audit' in d) < position('set status = ''ballots_locked''' in d)
     from (select replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '') d) x));
select pg_temp.chk('lock_competition_round_ballots is SECURITY DEFINER, volatile, search_path = public, pg_temp, no function-level lock_timeout',
  (select p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=public, pg_temp'] from pg_proc p where p.oid = 'public.lock_competition_round_ballots(uuid,uuid)'::regprocedure));
select pg_temp.chk('lock_competition_round_ballots keeps its grants (authenticated yes, anon / public no)',
  has_function_privilege('authenticated', 'public.lock_competition_round_ballots(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.lock_competition_round_ballots(uuid,uuid)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.lock_competition_round_ballots(uuid,uuid)'::regprocedure and a.grantee = 0));
select pg_temp.chk('post-A2 pin: md5 of the installed text (CRs removed) equals the pinned value',
  md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '')) = 'c4ba327df7943d559ab52ccd07d20ea0');
select pg_temp.chk('the A1 helper stays unreachable by API roles (lock reaches it only through the definer)',
  not has_function_privilege('authenticated', 'public._cf1_require_roster_eligible(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public._cf1_require_roster_eligible(uuid,text)', 'execute'));

-- ============================================================================
-- 2. U58: lock refuses unavailable couples with the exact error and detail (round r1: heats d001 {E101, E102, E103}, d002 {E104, E105})
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
reset role;
select pg_temp.hl1_danced(pg_temp.u('00d001'));
select pg_temp.hl1_danced(pg_temp.u('00d002'));

-- 2a. a refund booked AFTER the heat locked leaves the entry confirmed (the registration sync skips locked heats); lock must still refuse
update public.event_registrations set payment_status = 'refunded' where id = pg_temp.u('0b0001');
select pg_temp.chk('fixture: the refunded-but-confirmed entry E103 stays confirmed on its locked heat',
  (select status from public.event_competition_entries where id = pg_temp.u('008003')) = 'confirmed');
create temp table t_probe (k text primary key, v text) on commit drop;
grant all on t_probe to authenticated, anon, service_role;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('refund', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7b001')));
reset role;
select pg_temp.chk('U58: lock refused with COMP_ROSTER_ENTRY_UNAVAILABLE (P0001), exact message',
  (select v like 'P0001|COMP_ROSTER_ENTRY_UNAVAILABLE: 1 couple(s) in the ranking set are ineligible, refunded or cancelled.|%' from t_probe where k = 'refund'), (select v from t_probe where k = 'refund'));
select pg_temp.chk('U58: detail is JSON {stage:lock, round_id, entries:[{entry_id, reason}]} naming E103 and registration_payment_refunded only',
  (select (split_part(v, '|', 3)::jsonb) = jsonb_build_object('stage', 'lock', 'round_id', pg_temp.u('006001'),
      'entries', jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008003'), 'reason', 'registration_payment_refunded'))) from t_probe where k = 'refund'));
select pg_temp.chk('U58: the refusal changed nothing (round active, no round_state_changed event, request id unused)',
  (select status from public.event_competition_rounds where id = pg_temp.u('006001')) = 'active'
  and pg_temp.nev(pg_temp.u('006001')) = 0
  and not exists (select 1 from public.event_competition_ballot_events where request_id = pg_temp.u('f7b001')));

-- 2b. several problems at once: reasons per entry, ordered by entry id
select pg_temp.set_status(pg_temp.u('008001'), 'withdrawn', 'eligible');
select pg_temp.set_status(pg_temp.u('008005'), 'confirmed', 'ineligible');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('multi', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7b002')));
reset role;
select pg_temp.chk('U58: three unavailable couples reported with their own reasons, in entry-id order',
  (select split_part(v, '|', 3)::jsonb -> 'entries' = jsonb_build_array(
      jsonb_build_object('entry_id', pg_temp.u('008001'), 'reason', 'entry_not_confirmed'),
      jsonb_build_object('entry_id', pg_temp.u('008003'), 'reason', 'registration_payment_refunded'),
      jsonb_build_object('entry_id', pg_temp.u('008005'), 'reason', 'entry_ineligible')) from t_probe where k = 'multi'), (select v from t_probe where k = 'multi'));
select pg_temp.chk('U58: this is not a callback Final, so no COMP_ROSTER_BELOW_MINIMUM is involved',
  (select v not like '%BELOW_MINIMUM%' from t_probe where k = 'multi'));

-- 2c. false positives that must NOT block: manual / comped entries without links, a partially refunded order, a paid order and registration
select pg_temp.set_status(pg_temp.u('008001'), 'confirmed', 'eligible');
select pg_temp.set_status(pg_temp.u('008005'), 'confirmed', 'eligible');
update public.event_registrations set payment_status = 'paid' where id = pg_temp.u('0b0001');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('clean', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7b003')));
reset role;
select pg_temp.chk('U82-like: manual / comped entries (E101, E102, E105: no registration, no order), a partially refunded order (E104) and a paid registration (E103) do not block the lock',
  (select v from t_probe where k = 'clean') = 'ok', (select v from t_probe where k = 'clean'));
select pg_temp.chk('the lock wrote exactly one round_state_changed event and the round is ballots_locked',
  pg_temp.nev(pg_temp.u('006001')) = 1 and (select status from public.event_competition_rounds where id = pg_temp.u('006001')) = 'ballots_locked');

-- ============================================================================
-- 3. U69: replay after a later eligibility change returns the same result; the check does not run on a replay
-- ============================================================================
update public.event_registrations set payment_status = 'refunded' where id = pg_temp.u('0b0001');
select pg_temp.set_status(pg_temp.u('008002'), 'withdrawn', 'ineligible');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('replay', pg_temp.lock_replayed(pg_temp.u('006001'), pg_temp.u('f7b003')));
insert into t_probe values ('newreq', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7b004')));
insert into t_probe values ('reused', pg_temp.lock_try(pg_temp.u('006002'), pg_temp.u('f7b003')));
reset role;
select pg_temp.chk('U69: replay of the lock request id after E102 (withdrawn, ineligible) and E103 (refunded) became unavailable returns replayed=true',
  (select v from t_probe where k = 'replay') = 'true', (select v from t_probe where k = 'replay'));
select pg_temp.chk('U69: the replay wrote nothing new (still one round_state_changed event, round still ballots_locked)',
  pg_temp.nev(pg_temp.u('006001')) = 1 and (select status from public.event_competition_rounds where id = pg_temp.u('006001')) = 'ballots_locked');
select pg_temp.chk('U69: a NEW request id on the locked round keeps the existing state error (the check never runs ahead of the state check)',
  (select v like 'P0001|COMP_BALLOTS_BAD_STATE:%' from t_probe where k = 'newreq'), (select v from t_probe where k = 'newreq'));
select pg_temp.chk('U69: a request id already used for another round is still COMP_REQUEST_REUSED (replay branch unchanged)',
  (select v like 'P0001|COMP_REQUEST_REUSED:%' from t_probe where k = 'reused'), (select v from t_probe where k = 'reused'));

-- ============================================================================
-- 4. U58 / NS1 resolution: stale ballots after the roster changes, corrected ballots, reopen, re-lock
-- ============================================================================
select pg_temp.set_status(pg_temp.u('008002'), 'confirmed', 'eligible');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('manager reopens the locked round (E2 route, reason required)',
  format($q$select public.reopen_competition_round_ballots(%L, 'roster review', %L)$q$, pg_temp.u('006001'), pg_temp.u('f7c001')));
insert into t_probe values ('relock_refunded', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7c002')));
reset role;
select pg_temp.chk('U58: re-lock while E103 is still refunded is refused again with the same code (stage lock)',
  (select v like 'P0001|COMP_ROSTER_ENTRY_UNAVAILABLE:%' and split_part(v, '|', 3)::jsonb ->> 'stage' = 'lock' from t_probe where k = 'relock_refunded'), (select v from t_probe where k = 'relock_refunded'));
-- the couple leaves the ranking set by a scratch on its heat entry (replica fixture shortcut): the existing stale-ballot error comes first
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008003');
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('stale', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7c003')));
reset role;
select pg_temp.chk('NS1/E2 route: after the roster changed the existing stale-ballot error comes FIRST (A2 runs after the readiness checks)',
  (select v like 'P0001|COMP_BALLOTS_STALE:%' from t_probe where k = 'stale'), (select v from t_probe where k = 'stale'));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008001'), 'value', 1), jsonb_build_object('entry_id', pg_temp.u('008002'), 'value', 2)), pg_temp.u('f7c011'), 'correct after roster change');
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008001'), 'value', 2), jsonb_build_object('entry_id', pg_temp.u('008002'), 'value', 1)), pg_temp.u('f7c012'), 'correct after roster change');
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008001'), 'value', 1), jsonb_build_object('entry_id', pg_temp.u('008002'), 'value', 2)), pg_temp.u('f7c013'), 'correct after roster change');
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('relock', pg_temp.lock_try(pg_temp.u('006001'), pg_temp.u('f7c004')));
reset role;
select pg_temp.chk('U58: with corrected ballots the refunded couple is out of the ranking set and the re-lock succeeds',
  (select v from t_probe where k = 'relock') = 'ok' and (select status from public.event_competition_rounds where id = pg_temp.u('006001')) = 'ballots_locked', (select v from t_probe where k = 'relock'));

-- ============================================================================
-- 5. OD-15 A: the minimum applies to callback Finals ONLY
-- ============================================================================
select pg_temp.chk('fixture: R7 is a callback Final (A1 definition) and R8 / R1 are not',
  public._cf1_is_callback_final(pg_temp.u('006007')) and not public._cf1_is_callback_final(pg_temp.u('006008')) and not public._cf1_is_callback_final(pg_temp.u('006001')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select public.submit_competition_ballot(pg_temp.u('006007'), pg_temp.u('00d010'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008030'), 'value', 1)), pg_temp.u('f7d001'));
select public.submit_competition_ballot(pg_temp.u('006008'), pg_temp.u('00d011'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008032'), 'value', 1)), pg_temp.u('f7d002'));
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006007'), pg_temp.u('00d010'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008030'), 'value', 1)), pg_temp.u('f7d003'));
select public.submit_competition_ballot(pg_temp.u('006008'), pg_temp.u('00d011'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008032'), 'value', 1)), pg_temp.u('f7d004'));
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006007'), pg_temp.u('00d010'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008030'), 'value', 1)), pg_temp.u('f7d005'));
select public.submit_competition_ballot(pg_temp.u('006008'), pg_temp.u('00d011'), jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('008032'), 'value', 1)), pg_temp.u('f7d006'));
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.u('00d010'), 'locked', 'early');
select public.set_competition_heat_lock_state(pg_temp.u('00d011'), 'locked', 'early');
reset role;
select pg_temp.hl1_danced(pg_temp.u('00d010'));
select pg_temp.hl1_danced(pg_temp.u('00d011'));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_probe values ('below', pg_temp.lock_try(pg_temp.u('006007'), pg_temp.u('f7d010')));
insert into t_probe values ('finalonly', pg_temp.lock_try(pg_temp.u('006008'), pg_temp.u('f7d011')));
reset role;
select pg_temp.chk('OD-15 A: a callback Final with one eligible couple is refused COMP_ROSTER_BELOW_MINIMUM (P0001), detail {stage lock, eligible 1, minimum 2}',
  (select v like 'P0001|COMP_ROSTER_BELOW_MINIMUM:%'
      and split_part(v, '|', 3)::jsonb = jsonb_build_object('stage', 'lock', 'round_id', pg_temp.u('006007'), 'eligible', 1, 'minimum', 2) from t_probe where k = 'below'), (select v from t_probe where k = 'below'));
select pg_temp.chk('OD-15 A: the refused callback Final stayed active', (select status from public.event_competition_rounds where id = pg_temp.u('006007')) = 'active');
select pg_temp.chk('OD-15 A: a Final-only division with ONE couple (not a callback Final) locks normally',
  (select v from t_probe where k = 'finalonly') = 'ok' and (select status from public.event_competition_rounds where id = pg_temp.u('006008')) = 'ballots_locked', (select v from t_probe where k = 'finalonly'));

-- ============================================================================
-- 6. Access is unchanged: the role check still runs first; anon cannot execute
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('an unrelated verified user is still COMP_FORBIDDEN', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006007'), pg_temp.u('f7e001')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot execute lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006007'), pg_temp.u('f7e002')), 'permission denied');
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
    raise exception 'COMPETITION CF1 A2 LOCK CHECK SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION CF1 A2 LOCK CHECK SQL SUITE FAIL: %', v_failures;
end $$;
