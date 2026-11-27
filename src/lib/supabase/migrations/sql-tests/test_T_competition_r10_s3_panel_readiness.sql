-- Competition R10-S3 -- panel readiness / attendance / recovery-case regression suite.
-- DRAFT (local disposable runs only; executed status is in the PR 864 review package). Covers 20270301100000, 20270301101000 and 20270301102000 on top of E1 (20270101090000),
-- E2 (20270102090000), O1, the chain through 20270218090000 plus CF1 (capacity guard) and JC1 (20270215092000). Run as a SUPERUSER. One transaction, synthetic fixtures only (UUID block
-- 00000000-0000-0000-0000-a10ff3XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION R10-S3 SQL SUITE PASS (<n> checks)"  or  "COMPETITION R10-S3 SQL SUITE FAIL: <failures>".

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
language sql immutable as $$ select ('00000000-0000-0000-0000-a10ff3' || p_suffix)::uuid $$;
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
-- Fixtures (as postgres). users: 01 owner A, 11-16 judges (studio A team, verified), 17 front desk A, 21 outsider (studio B)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-r10-owner@example.test'), (pg_temp.u('000017'), 't-r10-desk@example.test'), (pg_temp.u('000021'), 't-r10-outsider@example.test'),
  (pg_temp.u('000011'), 't-r10-j1@example.test'), (pg_temp.u('000012'), 't-r10-j2@example.test'), (pg_temp.u('000013'), 't-r10-j3@example.test'),
  (pg_temp.u('000014'), 't-r10-j4@example.test'), (pg_temp.u('000015'), 't-r10-j5@example.test'), (pg_temp.u('000016'), 't-r10-j6@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'R10 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-a10ff3%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-a10ff3%';
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'R10 Studio A', 't-r10-studio-a'), (pg_temp.u('00b001'), 'R10 Studio B', 't-r10-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000017'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000014'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000015'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000016'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000021'), pg_temp.u('00b001'), 'front_desk', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R10 Comp', 't-r10-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.u('0030' || lpad(g::text, 2, '0')), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Div ' || g, 'open' from generate_series(1, 10) g;
-- r1 ordinal draft (parity sweep), r2 callback, r3 none, r4 proficiency, r5 ordinal (attendance while scheduled),
-- r6 ordinal (active, 5 judges), r7 ordinal (active, 3 judges), r8 ordinal draft (config tests), r9 ordinal (active, deactivation), r10 'none' (config switch)
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
select pg_temp.u('0060' || lpad(g::text, 2, '0')), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('0030' || lpad(g::text, 2, '0')), 'Final', 'final', 1, 'draft',
       (array['ordinal_majority','callback_tally','none','proficiency_rating','ordinal_majority','ordinal_majority','ordinal_majority','ordinal_majority','ordinal_majority','none'])[g],
       case when g = 2 then 3 end
from generate_series(1, 10) g;

-- ============================================================================
-- 1. Surface
-- ============================================================================
select pg_temp.chk('helper is not executable by authenticated', not has_function_privilege('authenticated', 'public._comp_r10_panel_check(uuid, uuid)', 'execute'));
select pg_temp.chk('guard trigger function is not executable by authenticated', not has_function_privilege('authenticated', 'public._comp_r10_guard_round_panel_config()', 'execute'));
select pg_temp.chk('official status trigger function is not executable by authenticated', not has_function_privilege('authenticated', 'public._comp_r10_official_status_panel()', 'execute'));
select pg_temp.chk('config guard trigger is ENABLE ALWAYS', (select tgenabled from pg_trigger where tgname = 'compr10_guard_round_panel_config') = 'A');
select pg_temp.chk('recovery case table has RLS', (select relrowsecurity from pg_class where oid = 'public.event_competition_panel_recovery_cases'::regclass));
select pg_temp.chk('old 5-arg attendance function is gone', to_regprocedure('public.record_competition_judge_attendance(uuid, uuid, text, text, uuid)') is null);
select pg_temp.chk('new attendance function is not executable by anon', not has_function_privilege('anon', 'public.record_competition_judge_attendance(uuid, uuid, text, text, uuid, boolean)', 'execute'));

-- ============================================================================
-- 2. Officials (as the owner) and the readiness parity sweep on r1 (ordinal, default configuration, NO min_panel_judges)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('add judge ' || g, format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('0000' || (10 + g)), pg_temp.u('f000' || lpad(g::text, 2, '0'))))
from generate_series(1, 6) g;
reset role;

select pg_temp.chk('r1 has no judges: not ready', not public.competition_round_panel_ready(pg_temp.u('006001')));
-- Property: for n = 1..6 lettered judges on a draft ordinal round readiness == (n >= 3 and n odd). Assignments inserted as postgres (draft round).
do $$
declare
  n int;
  v_ok boolean;
begin
  for n in 1..6 loop
    insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
    values (pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C','D','E','F'])[n]);
    v_ok := public.competition_round_panel_ready(pg_temp.u('006001'));
    insert into t_results values ('ordinal default config, ' || n || ' judge(s): ready = ' || (n >= 3 and n % 2 = 1), v_ok = (n >= 3 and n % 2 = 1), 'ready=' || v_ok);
  end loop;
end $$;
select pg_temp.chk('6 judges reports panel_even', (public.competition_round_panel_status(pg_temp.u('006001')) -> 'missing') ? 'panel_even');
select pg_temp.chk('status keeps the old keys', (public.competition_round_panel_status(pg_temp.u('006001')) ?& array['ready','judge_count','min_judges','scorer_count','chair_designated','missing']));
select pg_temp.chk('default minimum is the rule (3), not 1', (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'min_judges')::int = 3);

-- ============================================================================
-- 3. Other methods: callback accepted, unsupported methods refused even with a valid-looking panel
-- ============================================================================
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('0060' || lpad(r::text, 2, '0')), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C'])[n]
from (values (2), (3), (4)) rr(r), generate_series(1, 3) n;
select pg_temp.chk('callback_tally with 3 judges is ready', public.competition_round_panel_ready(pg_temp.u('006002')));
select pg_temp.chk('method none with 3 judges is NOT ready', not public.competition_round_panel_ready(pg_temp.u('006003')));
select pg_temp.chk('method none reports scoring_method_unsupported', (public.competition_round_panel_status(pg_temp.u('006003')) -> 'missing') ? 'scoring_method_unsupported');
select pg_temp.chk('proficiency_rating (no approved format/engine) is NOT ready', not public.competition_round_panel_ready(pg_temp.u('006004')));
-- A raised minimum makes an otherwise valid draft panel (r2: 3 judges) not ready, from either configured source.
update public.event_competition_rounds set configuration = configuration || '{"min_panel_judges": 5}' where id = pg_temp.u('006002');
select pg_temp.chk('raised min_panel_judges (5) over 3 judges: not ready, reports judges', not public.competition_round_panel_ready(pg_temp.u('006002')) and (public.competition_round_panel_status(pg_temp.u('006002')) -> 'missing') ? 'judges');
select pg_temp.chk('raised min_panel_judges: min_judges 5, rule 3, configured minimum not met', (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'min_judges')::int = 5 and (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'rule_min_judges')::int = 3 and not (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'meets_configured_minimum')::boolean);
update public.event_competition_rounds set configuration = configuration - 'min_panel_judges', minimum_panel_size = 5 where id = pg_temp.u('006002');
select pg_temp.chk('raised minimum_panel_size (5) over 3 judges: not ready', not public.competition_round_panel_ready(pg_temp.u('006002')) and (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'min_judges')::int = 5);
update public.event_competition_rounds set minimum_panel_size = default where id = pg_temp.u('006002');
select pg_temp.chk('minimum restored: ready and configured minimum met', public.competition_round_panel_ready(pg_temp.u('006002')) and (public.competition_round_panel_status(pg_temp.u('006002')) ->> 'meets_configured_minimum')::boolean);

-- ============================================================================
-- 4. Configuration guard (r8) and fail-closed reading of bad stored values
-- ============================================================================
select pg_temp.expect_msg('min_panel_judges = 1 rejected for ordinal', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 1}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_BELOW_RULE');
select pg_temp.expect_msg('min_panel_judges = 2 rejected for ordinal', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 2}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_BELOW_RULE');
select pg_temp.expect_msg('min_panel_judges = 4 (even) rejected for ordinal', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 4}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_BELOW_RULE');
select pg_temp.expect_msg('min_panel_judges = 0 rejected', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 0}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_INVALID');
select pg_temp.expect_msg('min_panel_judges = "3" (string) rejected', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": "3"}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_INVALID');
select pg_temp.expect_msg('min_panel_judges = 3.5 rejected', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 3.5}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_INVALID');
select pg_temp.expect_msg('min_panel_judges = 100 rejected', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 100}' where id = %L$q$, pg_temp.u('006008')), 'COMP_PANEL_MIN_INVALID');
select pg_temp.expect_ok('min_panel_judges = 5 accepted for ordinal', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 5}' where id = %L$q$, pg_temp.u('006008')));
select pg_temp.expect_ok('unrelated configuration key still editable', format($q$update public.event_competition_rounds set configuration = configuration || '{"organizer_note": 8}' where id = %L$q$, pg_temp.u('006008')));
select pg_temp.expect_msg('the CF1 capacity guard is not weakened (direct capacity write still refused)', format($q$update public.event_competition_rounds set configuration = configuration || '{"max_entries_per_heat": 8}' where id = %L$q$, pg_temp.u('006008')), 'COMP_CAPACITY_DIRECT_WRITE');
select pg_temp.chk('raised minimum (5) with 0 judges: min_judges = 5', (public.competition_round_panel_status(pg_temp.u('006008')) ->> 'min_judges')::int = 5);
-- A low value on a method with no rule is accepted, but switching the method re-validates it (setter bypass closed).
select pg_temp.expect_ok('min 4 accepted on method none', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 4}' where id = %L$q$, pg_temp.u('006010')));
select pg_temp.expect_msg('switching to ordinal re-validates min 4', format($q$update public.event_competition_rounds set scoring_method = 'ordinal_majority' where id = %L$q$, pg_temp.u('006010')), 'COMP_PANEL_MIN_BELOW_RULE');
-- Fail closed on a bad stored value (guard disabled by the table owner to simulate a legacy row).
alter table public.event_competition_rounds disable trigger compr10_guard_round_panel_config;
update public.event_competition_rounds set configuration = '{"min_panel_judges": "x"}' where id = pg_temp.u('006008');
alter table public.event_competition_rounds enable always trigger compr10_guard_round_panel_config;
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('006008'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C'])[n] from generate_series(1, 3) n;
select pg_temp.chk('bad stored minimum fails closed (no fallback to 1)', (public.competition_round_panel_status(pg_temp.u('006008')) -> 'missing') ? 'configured_minimum_invalid');
select pg_temp.chk('bad stored minimum with a valid panel is still not ready', not public.competition_round_panel_ready(pg_temp.u('006008')));

-- ============================================================================
-- 5. Attendance while scheduled (r5): absence is read by readiness
-- ============================================================================
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('006005'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C'])[n] from generate_series(1, 3) n;
select pg_temp.chk('r5 three judges ready', public.competition_round_panel_ready(pg_temp.u('006005')));
select set_config('session_replication_role', 'replica', true);
update public.event_competition_rounds set status = 'scheduled' where id = pg_temp.u('006005');
select set_config('session_replication_role', 'origin', true);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('absence while scheduled is recorded without confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'sick', %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001', '000013'), pg_temp.u('d00001')));
reset role;
select pg_temp.chk('absence while scheduled makes r5 NOT ready', not public.competition_round_panel_ready(pg_temp.u('006005')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('presence restores', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006005'), pg_temp.off('00e001', '000013'), pg_temp.u('d00002')));
reset role;
select pg_temp.chk('presence makes r5 ready again', public.competition_round_panel_ready(pg_temp.u('006005')));

-- ============================================================================
-- 6. Absence AFTER start: confirmation, case, auto-close (r6: 5 judges, r7: 3 judges). Status set as postgres with triggers bypassed (fixture only).
-- ============================================================================
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('006006'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C','D','E'])[n] from generate_series(1, 5) n;
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('006007'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C'])[n] from generate_series(1, 3) n;
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select pg_temp.u('00e001'), pg_temp.u('006009'), pg_temp.off('00e001', '0000' || (10 + n)), (array['A','B','C'])[n] from generate_series(1, 3) n;
select set_config('session_replication_role', 'replica', true);
update public.event_competition_rounds set status = 'active' where id in (pg_temp.u('006006'), pg_temp.u('006007'), pg_temp.u('006009'));
select set_config('session_replication_role', 'origin', true);
select pg_temp.chk('active r6 (5 judges) still ready', public.competition_round_panel_ready(pg_temp.u('006006')));

set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('absence leaving an EVEN panel after start needs confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left', %L)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000015'), pg_temp.u('d00010')), 'COMP_PANEL_BREAK_CONFIRM_REQUIRED');
reset role;
select pg_temp.chk('refused absence wrote nothing', pg_temp.n(format($q$select count(*) from public.event_competition_judge_attendance where round_id = %L$q$, pg_temp.u('006006'))) = 0
  and pg_temp.n(format($q$select count(*) from public.event_competition_panel_recovery_cases where round_id = %L$q$, pg_temp.u('006006'))) = 0);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('confirmed absence is recorded', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left', %L, true)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000015'), pg_temp.u('d00011')));
select pg_temp.chk('a recovery case is open and readable by the manager', (select count(*) from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006006') and status = 'open') = 1);
select pg_temp.chk('replay of the confirmed request is idempotent', (public.record_competition_judge_attendance(pg_temp.u('006006'), pg_temp.off('00e001', '000015'), 'absent', 'left', pg_temp.u('d00011'), true) ->> 'replayed')::boolean);
select pg_temp.expect_msg('same request id with a different confirm flag is refused', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left', %L, false)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000015'), pg_temp.u('d00011')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_ok('second absence making the panel valid again needs no confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left too', %L)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000014'), pg_temp.u('d00012')));
select pg_temp.chk('case closed by the route that restored a valid panel', (select status from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006006')) = 'resolved_restored');
select pg_temp.expect_msg('absence leaving 2 judges after start needs confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000013'), pg_temp.u('d00020')), 'COMP_PANEL_BREAK_CONFIRM_REQUIRED');
select pg_temp.expect_ok('confirmed absence on r7', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'left', %L, true)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000013'), pg_temp.u('d00021')));
select pg_temp.expect_ok('on an already broken panel a further absence (2 -> 1) is recorded without a second confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000012'), pg_temp.u('d00023')));
select pg_temp.chk('the r7 case stays open and is still the only one', (select count(*) from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006007') and status = 'open') = 1);
select pg_temp.expect_ok('restoring judge 2 on r7 (1 -> 2) needs no confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000012'), pg_temp.u('d00024')));
select pg_temp.expect_ok('presence on r7', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000013'), pg_temp.u('d00022')));
select pg_temp.chk('presence closed the r7 case', (select status from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006007')) = 'resolved_restored');
select pg_temp.expect_msg('restoring a judge that makes the panel EVEN needs confirmation (r6: 3 present + 1 restored = 4)', format($q$select public.record_competition_judge_attendance(%L, %L, 'present', null, %L)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000015'), pg_temp.u('d00013')), 'COMP_PANEL_BREAK_CONFIRM_REQUIRED');
select pg_temp.expect_msg('an absence leaving 2 present on r6 needs confirmation', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006006'), pg_temp.off('00e001', '000012'), pg_temp.u('d00014')), 'COMP_PANEL_BREAK_CONFIRM_REQUIRED');
reset role;
select pg_temp.chk('the lock rule agrees with readiness on r6 (3 present, odd)', (public._comp_r10_panel_check(pg_temp.u('006006'), null) ->> 'rule_ok')::boolean
  and (public._compe2_round_blockers(pg_temp.u('006006')) ->> 'panel_ok')::boolean);

-- ============================================================================
-- 7. Ineligible lettered judge on a started round (r9): deactivation keeps the assignment; readiness must not say ready
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('deactivate a judge of the started round', format($q$select public.deactivate_competition_official(%L, 'left the team', %L)$q$, pg_temp.off('00e001', '000013'), pg_temp.u('d00030')));
reset role;
-- Requires JC1 (20270215092000, live on DEV and PROD): a deactivated judge without a ballot counts as absent.
select pg_temp.chk('r9 after deactivation: not ready, even panel, and the lock rule agrees', not public.competition_round_panel_ready(pg_temp.u('006009'))
  and (public.competition_round_panel_status(pg_temp.u('006009')) -> 'missing') ? 'panel_even'
  and not (public._compe2_round_blockers(pg_temp.u('006009')) ->> 'panel_ok')::boolean);
select pg_temp.chk('deactivation after start opened exactly one recovery case on r9',
  (select count(*) from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006009') and status = 'open'
     and panel_snapshot ->> 'change' = 'official_inactive') = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('reactivate the judge', format($q$select public.add_competition_official(%L, %L, 'judge', %L)$q$, pg_temp.u('00e001'), pg_temp.u('000013'), pg_temp.u('d00031')));
reset role;
select pg_temp.chk('reactivation restores r9 and closes its case', public.competition_round_panel_ready(pg_temp.u('006009'))
  and (select status from public.event_competition_panel_recovery_cases where round_id = pg_temp.u('006009')) = 'resolved_restored');
-- Team membership removed (the official stays active, so the lock still counts the judge): readiness must name the ineligible judge.
update public.user_studio_roles set active = false where user_id = pg_temp.u('000012') and studio_id = pg_temp.u('00a001');
select pg_temp.chk('r9 reports panel_member_ineligible and is not ready', not public.competition_round_panel_ready(pg_temp.u('006009'))
  and (public.competition_round_panel_status(pg_temp.u('006009')) -> 'missing') ? 'panel_member_ineligible');
update public.user_studio_roles set active = true where user_id = pg_temp.u('000012') and studio_id = pg_temp.u('00a001');

-- ============================================================================
-- 8. Authorization and direct writes
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000012'), pg_temp.u('d00040')), 'COMP_FORBIDDEN');
select pg_temp.chk('a judge cannot read recovery cases', (select count(*) from public.event_competition_panel_recovery_cases) = 0);
select pg_temp.chk('a judge cannot probe readiness (r1 is ready for its manager)', not public.competition_round_panel_ready(pg_temp.u('006001')));
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('front desk cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000012'), pg_temp.u('d00041')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000021'));
select pg_temp.expect_msg('another studio cannot record attendance', format($q$select public.record_competition_judge_attendance(%L, %L, 'absent', 'x', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000012'), pg_temp.u('d00042')), 'COMP_FORBIDDEN');
select pg_temp.chk('another studio sees no recovery case', (select count(*) from public.event_competition_panel_recovery_cases) = 0);
select pg_temp.expect_msg('direct insert into recovery cases is refused', format($q$insert into public.event_competition_panel_recovery_cases (event_id, round_id, opened_by, opened_request_id, panel_snapshot) values (%L, %L, %L, %L, '{}')$q$, pg_temp.u('00e001'), pg_temp.u('006007'), pg_temp.u('000021'), pg_temp.u('d00043')), 'permission denied');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('even the manager cannot write recovery cases directly', $q$update public.event_competition_panel_recovery_cases set status = 'resolved_restored'$q$, 'permission denied');
select pg_temp.chk('the manager sees r1 ready (so the judge probe above is not vacuous)', public.competition_round_panel_ready(pg_temp.u('006001')));
select pg_temp.expect_msg('panel of a started round is still frozen (assign)', format($q$select public.assign_competition_panel_member(%L, %L, 'Z', %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000016'), pg_temp.u('d00044')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_msg('panel of a started round is still frozen (unassign)', format($q$select public.unassign_competition_panel_member(%L, %L, %L)$q$, pg_temp.u('006007'), pg_temp.off('00e001', '000011'), pg_temp.u('d00045')), 'COMP_PANEL_FROZEN');
select pg_temp.expect_ok('manager can still update configuration of a draft round (guard is definer)', format($q$update public.event_competition_rounds set configuration = configuration || '{"note": 1}' where id = %L$q$, pg_temp.u('006001')));
select pg_temp.expect_msg('min_panel_judges cannot change after start', format($q$update public.event_competition_rounds set configuration = '{"min_panel_judges": 5}' where id = %L$q$, pg_temp.u('006007')), 'COMP_ROUND_CONFIG_FROZEN');
reset role;
select pg_temp.expect_msg('a resolved case cannot be edited', format($q$update public.event_competition_panel_recovery_cases set resolution = 'x' where round_id = %L$q$, pg_temp.u('006007')), 'COMP_RECOVERY_IMMUTABLE');
select pg_temp.expect_msg('a case cannot be deleted while its round exists', format($q$delete from public.event_competition_panel_recovery_cases where round_id = %L$q$, pg_temp.u('006007')), 'COMP_RECOVERY_IMMUTABLE');
select pg_temp.expect_msg('the case table cannot be truncated', 'truncate public.event_competition_panel_recovery_cases', 'COMP_RECOVERY_IMMUTABLE');

-- Concurrency (two sessions racing attendance / assignment / lock) cannot run in one transaction: PENDING (see the PR; to be added under
-- sql-tests/concurrency with the executed run).

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION R10-S3 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION R10-S3 SQL SUITE FAIL: %', v_failures;
end $$;
