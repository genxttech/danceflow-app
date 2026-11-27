-- Competition JC1 -- deactivated judge counts as absent (no ballot) regression suite (fixtures reused from the E2 p1fix suite).
--
-- Covers 20270102090000_competition_e2_ballots.sql on top of 10A..10D.1, E1 (20270101090000) and, when present, O1.
-- Run as a SUPERUSER (fixtures use session_replication_role = replica to place heats in a published schedule version
-- without the 10D publish flow). One transaction, synthetic fixtures only (UUID block ...-e20ff2XXXXXX). The final
-- block ALWAYS raises, so nothing persists:
--   "COMPETITION E2 SQL SUITE PASS (<n> checks)"  or  "COMPETITION E2 SQL SUITE FAIL: <failures>".
-- The concurrent submit-vs-lock race needs a real second connection: see sql-tests/concurrency/run_e2_submit_vs_lock.sh.

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
-- Fixtures (superuser): users 01 owner, 11 12 13 judges. r1 ordinal (heats a,b of 2 entries), r2 callback T=2 (heats c,d of 2 entries)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-e2p1-owner@example.test'), (pg_temp.u('000011'), 't-e2p1-j1@example.test'),
  (pg_temp.u('000012'), 't-e2p1-j2@example.test'), (pg_temp.u('000013'), 't-e2p1-j3@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'E2P1 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-e20ff2%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-e20ff2%';
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'E2P1 Studio', 't-e2p1-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values (pg_temp.u('00e001'), pg_temp.u('00a001'), 'E2P1 Comp', 't-e2p1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D1', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D2', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'R1 Ordinal', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'R2 Callback', 'qualifying', 1, 'draft', 'callback_tally', 2);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E101', 'confirmed', 'eligible', '101'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E102', 'confirmed', 'eligible', '102'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E103', 'confirmed', 'eligible', '103'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E104', 'confirmed', 'eligible', '104'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E105', 'confirmed', 'eligible', '105'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E106', 'confirmed', 'eligible', '106'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E107', 'confirmed', 'eligible', '107'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E108', 'confirmed', 'eligible', '108');
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d003'), pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('006002'), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d004'), pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('006002'), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008001'), 1), (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008002'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d002'), pg_temp.u('008003'), 1), (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d002'), pg_temp.u('008004'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d003'), pg_temp.u('008005'), 1), (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d003'), pg_temp.u('008006'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d004'), pg_temp.u('008007'), 1), (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d004'), pg_temp.u('008008'), 2);
set session_replication_role = origin;
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10011'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10012'));
select public.assign_competition_panel_member(pg_temp.u('006001'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10013'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000011'), 'A', pg_temp.u('f10021'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000012'), 'B', pg_temp.u('f10022'));
select public.assign_competition_panel_member(pg_temp.u('006002'), pg_temp.off('00e001', '000013'), 'C', pg_temp.u('f10023'));
reset role;
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.u('006001'), pg_temp.u('006002'));
set session_replication_role = origin;

-- Blockers as the board/lock see them (superuser; the helper is revoked from API roles).
create or replace function pg_temp.bl(p_round text, p_key text) returns text
language sql stable security definer as $$ select (public._compe2_round_blockers(pg_temp.u(p_round)) ->> p_key) $$;
create or replace function pg_temp.missing(p_round text) returns int
language sql stable security definer as $$ select jsonb_array_length(public._compe2_round_blockers(pg_temp.u(p_round)) -> 'missing_ballots') $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- A. Baseline
select pg_temp.chk('A: r2 baseline judges=3 present=3 panel_ok', pg_temp.bl('006002','judges') = '3' and pg_temp.bl('006002','judges_present') = '3' and pg_temp.bl('006002','panel_ok') = 'true');

-- B. J3 submits ballots in r1 (ordinal) only, then is deactivated: r2 has no J3 ballot
set role authenticated;
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.mk('00d001', '[1,2]'), pg_temp.u('f31001'));
select public.submit_competition_ballot(pg_temp.u('006001'), pg_temp.u('00d002'), pg_temp.mk('00d002', '[1,2]'), pg_temp.u('f31002'));
select pg_temp.as_user(pg_temp.u('000001'));
select public.deactivate_competition_official(pg_temp.off('00e001', '000013'), 'left the event', pg_temp.u('f31003'));
reset role;
select pg_temp.chk('B: assignments of the started rounds are kept (frozen)', (select count(*) = 2 from public.event_competition_panel_assignments where official_id = pg_temp.off('00e001', '000013')));
select pg_temp.chk('B: _compe2_is_absent true for the inactive judge with no ballot (r2)', public._compe2_is_absent(pg_temp.u('006002'), pg_temp.off('00e001', '000013')));
select pg_temp.chk('B: r2 judges stays 3 (history) but present drops to 2', pg_temp.bl('006002','judges') = '3' and pg_temp.bl('006002','judges_present') = '2');
select pg_temp.chk('B: r2 panel_ok false (callback needs an odd panel; 2 present)', pg_temp.bl('006002','panel_ok') = 'false');
select pg_temp.chk('B: r2 missing_ballots no longer asks the inactive judge (2 judges still missing their own)', pg_temp.missing('006002') = 2);
select pg_temp.chk('B: inactive judge missing from r2 missing_ballots', not exists (select 1 from jsonb_array_elements(public._compe2_round_blockers(pg_temp.u('006002')) -> 'missing_ballots') m where (m ->> 'official_id')::uuid = pg_temp.off('00e001', '000013')));

-- C. Inactive judge WITH ballots (r1) is unchanged
select pg_temp.chk('C: _compe2_is_absent false for the inactive judge with ballots (r1)', not public._compe2_is_absent(pg_temp.u('006001'), pg_temp.off('00e001', '000013')));
select pg_temp.chk('C: r1 present stays 3 and panel_ok true', pg_temp.bl('006001','judges_present') = '3' and pg_temp.bl('006001','panel_ok') = 'true');

-- D. Attendance 'present' does not revive an inactive judge with no ballot
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('D: manager can record present for the inactive judge (r2)', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006002'), pg_temp.off('00e001', '000013'), pg_temp.u('f31010')));
reset role;
select pg_temp.chk('D: still absent after a present record', public._compe2_is_absent(pg_temp.u('006002'), pg_temp.off('00e001', '000013')));

-- E. Active judges are never affected; an explicit absence still works
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.record_competition_judge_attendance(pg_temp.u('006002'), pg_temp.off('00e001', '000012'), 'absent', 'sick', pg_temp.u('f31011'));
reset role;
select pg_temp.chk('E: active judge recorded absent is absent', public._compe2_is_absent(pg_temp.u('006002'), pg_temp.off('00e001', '000012')));
select pg_temp.chk('E: active judge without attendance is present', not public._compe2_is_absent(pg_temp.u('006002'), pg_temp.off('00e001', '000011')));

-- F. Reactivation restores the judge
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f31020'));
reset role;
select pg_temp.chk('F: reactivated judge is present again in r2', not public._compe2_is_absent(pg_temp.u('006002'), pg_temp.off('00e001', '000013')));

-- G. Helper stays unreachable from API roles
select pg_temp.chk('G: _compe2_is_absent not executable by authenticated', not has_function_privilege('authenticated', 'public._compe2_is_absent(uuid, uuid)', 'execute'));

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION JC1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION JC1 SQL SUITE FAIL: %', v_failures;
end $$;
