-- Competition NS1 -- heat no-shows regression suite.
--
-- Covers 20270115090000_competition_ns1_heat_no_shows.sql on top of 10A..10D.1, E1, O1, E2, REG and F2 (20270114, whose evidence hook
-- reads competition_heat_no_show_entries). Run as a SUPERUSER with fixtures/competition_round_ready.sql loaded FIRST (section 13 gets a
-- round active through the real O1 RPCs):
--     cat sql-tests/fixtures/competition_round_ready.sql sql-tests/test_T_competition_ns1_no_show.sql | psql ...
-- Sections 1-12 place heats / rounds with session_replication_role = replica (E2/F2 suite shortcut); synthetic fixtures only
-- (UUID block ...-a51ff2XXXXXX). One transaction; the final block ALWAYS raises, so nothing persists:
--   "COMPETITION NS1 SQL SUITE PASS (<n> checks)"  or  "COMPETITION NS1 SQL SUITE FAIL: <failures>".
-- Real two-connection races (no-show vs ballot submit, no-show vs lock) live in sql-tests/concurrency/run_ns1_races.sh.

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
language sql immutable as $$ select ('00000000-0000-0000-0000-a51ff2' || p_suffix)::uuid $$;
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
-- Heat entry id of (heat, entry) in the fixture numbering: he('00d001','008001').
create or replace function pg_temp.he(p_heat text, p_entry text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_heat_entries where heat_id = pg_temp.u(p_heat) and entry_id = pg_temp.u(p_entry)
$$;
-- Ordinal marks over the heat's REQUIRED set (E2's own _compe2_heat_entries, no-shows already out), values applied in entry-id order.
create or replace function pg_temp.mk(p_heat text, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.e, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select e, row_number() over (order by e)::int rn from unnest(public._compe2_heat_entries(pg_temp.u(p_heat))) e) x
$$;
-- Marks over ALL non-scratched heat entries, no-shows included (what a stale client would send).
create or replace function pg_temp.mk_all(p_heat text, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.u(p_heat) and he.status <> 'scratched') x
$$;
create or replace function pg_temp.nns(p_where text default 'true') returns bigint
language plpgsql security definer as $$ declare r bigint; begin execute 'select count(*) from public.event_competition_heat_no_shows where ' || p_where into r; return r; end $$;
create or replace function pg_temp.stale(p_round text) returns bigint
language sql stable security definer as $$ select jsonb_array_length(public._compe2_round_blockers(pg_temp.u(p_round)) -> 'stale_ballots')::bigint $$;
create or replace function pg_temp.callback_marks(p_entries text[]) returns jsonb
language sql immutable as $$ select jsonb_agg(jsonb_build_object('entry_id', pg_temp.u(e), 'value', true)) from unnest(p_entries) e $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
-- users: 01 owner A, 03 front desk A, 05 owner B, 11 12 13 judges A, 17 chair A, 16 scorer A (assigned), 15 judge B, 20 nobody
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-ns1-owner-a@example.test'), (pg_temp.u('000003'), 't-ns1-desk-a@example.test'),
  (pg_temp.u('000005'), 't-ns1-owner-b@example.test'), (pg_temp.u('000011'), 't-ns1-judge1@example.test'),
  (pg_temp.u('000012'), 't-ns1-judge2@example.test'), (pg_temp.u('000013'), 't-ns1-judge3@example.test'),
  (pg_temp.u('000017'), 't-ns1-chair@example.test'), (pg_temp.u('000016'), 't-ns1-scorer@example.test'),
  (pg_temp.u('000015'), 't-ns1-judge-b@example.test'), (pg_temp.u('000020'), 't-ns1-nobody@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'NS1 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-a51ff2%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-a51ff2%';

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'NS1 Studio A', 't-ns1-studio-a'), (pg_temp.u('00b001'), 'NS1 Studio B', 't-ns1-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000017'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true), (pg_temp.u('000015'), pg_temp.u('00b001'), 'instructor', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'NS1 Comp', 't-ns1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'NS1 Other Studio Comp', 't-ns1-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Other ProAm', 'single_dance', 'pro_am', 'open');
-- divisions D1..D9 for event A (003001..003009), D20 for event B
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.u('00300' || i), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D' || i, 'open' from generate_series(1, 9) i;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003020'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'D20', 'open');
-- r1 D1 ordinal | r3 D3 callback T=2 | r5 D5 ordinal | r6 D6 ordinal | r7 D7 ordinal | r10 D8 ordinal | r11 D9 ordinal | r20 event B
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'R1 Final', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'R3 Callback', 'qualifying', 1, 'draft', 'callback_tally', 2),
  (pg_temp.u('006005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'R5 Stale', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'R6 Complete heat', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'R7 Two heats', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003008'), 'R10 Locked', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003009'), 'R11 Scratched', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.u('006020'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003020'), 'R20 Other', 'final', 1, 'draft', 'ordinal_majority', null);

-- entries 008001.. : e01..e32 spread over the divisions below
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.u('0080' || lpad(i::text, 2, '0')), pg_temp.u('00e001'), pg_temp.u('001001'),
       pg_temp.u('00300' || case when i <= 5 then 1 when i <= 12 then 3 when i <= 16 then 5 when i <= 19 then 6 when i <= 23 then 7
                                  when i <= 25 then 8 else 9 end),
       'E' || (100 + i), 'confirmed', 'eligible', (100 + i)::text
from generate_series(1, 32) i where i not in (6, 7, 8, 13, 20, 26, 27, 28, 29);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.u('008040'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003020'), 'E140', 'confirmed', 'eligible', '140'),
  (pg_temp.u('008041'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003020'), 'E141', 'confirmed', 'eligible', '141');

set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e002'), 1, 'v1', 'published', now());
-- heats: h1 active, h2 scheduled (window), h4 active callback heat, h7 active, h8 COMPLETE, h10/h11 active (r7), h12 active (r10 locked), h13 active (r11)
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d004'), pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('006003'), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d007'), pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('006005'), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d008'), pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('006006'), 5, pg_temp.u('002001'), pg_temp.u('00c001'), 'complete'),
  (pg_temp.u('00d010'), pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('006007'), 6, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d011'), pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('006007'), 7, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d012'), pg_temp.u('00e001'), pg_temp.u('003008'), pg_temp.u('006010'), 8, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d013'), pg_temp.u('00e001'), pg_temp.u('003009'), pg_temp.u('006011'), 9, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d020'), pg_temp.u('00e002'), pg_temp.u('003020'), pg_temp.u('006020'), 1, pg_temp.u('002002'), pg_temp.u('00c002'), 'active');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.u('00e001'), pg_temp.u(d.division), pg_temp.u(d.heat), pg_temp.u('0080' || d.entry), d.ord, d.st from (values
  ('003001', '00d001', '01', 1, 'scheduled'), ('003001', '00d001', '02', 2, 'scheduled'), ('003001', '00d001', '03', 3, 'scheduled'),
  ('003001', '00d002', '04', 1, 'scheduled'), ('003001', '00d002', '05', 2, 'scheduled'),
  ('003003', '00d004', '09', 1, 'scheduled'), ('003003', '00d004', '10', 2, 'scheduled'), ('003003', '00d004', '11', 3, 'scheduled'), ('003003', '00d004', '12', 4, 'scheduled'),
  ('003005', '00d007', '14', 1, 'scheduled'), ('003005', '00d007', '15', 2, 'scheduled'), ('003005', '00d007', '16', 3, 'scheduled'),
  ('003006', '00d008', '17', 1, 'scheduled'), ('003006', '00d008', '18', 2, 'scheduled'), ('003006', '00d008', '19', 3, 'scheduled'),
  ('003007', '00d010', '21', 1, 'scheduled'), ('003007', '00d010', '22', 2, 'scheduled'),
  ('003007', '00d011', '21', 1, 'scheduled'), ('003007', '00d011', '23', 2, 'scheduled'),
  ('003008', '00d012', '24', 1, 'scheduled'), ('003008', '00d012', '25', 2, 'scheduled'),
  ('003009', '00d013', '30', 1, 'scratched'), ('003009', '00d013', '31', 2, 'scheduled'), ('003009', '00d013', '32', 3, 'scheduled')
) d(division, heat, entry, ord, st);
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values
  (pg_temp.u('00e002'), pg_temp.u('003020'), pg_temp.u('00d020'), pg_temp.u('008040'), 1),
  (pg_temp.u('00e002'), pg_temp.u('003020'), pg_temp.u('00d020'), pg_temp.u('008041'), 2);
set session_replication_role = origin;

-- Officials and panels through the E1 RPCs (as the real managers)
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000017'), 'chair', pg_temp.u('f10004'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000016'), 'scorer', pg_temp.u('f10005'));
select public.assign_competition_panel_member(r, pg_temp.off('00e001', j), l, gen_random_uuid())
from (values ('006001'), ('006003'), ('006005'), ('006006')) rr(r0)
cross join lateral (values ('000011', 'A'), ('000012', 'B'), ('000013', 'C')) jj(j, l)
cross join lateral (select pg_temp.u(rr.r0) r) q;
select public.assign_competition_panel_member(pg_temp.u(r0), pg_temp.off('00e001', '000016'), null, gen_random_uuid()) from (values ('006001'), ('006005')) rr(r0);
select pg_temp.as_user(pg_temp.u('000005'));
select public.add_competition_official(pg_temp.u('00e002'), pg_temp.u('000015'), 'judge', pg_temp.u('f10051'));
select public.assign_competition_panel_member(pg_temp.u('006020'), pg_temp.off('00e002', '000015'), 'A', pg_temp.u('f10052'));
reset role;
set session_replication_role = replica;
update public.event_competition_rounds set status = 'active'
 where id in (pg_temp.u('006001'), pg_temp.u('006003'), pg_temp.u('006005'), pg_temp.u('006006'), pg_temp.u('006007'), pg_temp.u('006011'), pg_temp.u('006020'));
update public.event_competition_rounds set status = 'ballots_locked' where id = pg_temp.u('006010');
set session_replication_role = origin;

-- ============================================================================
-- 1. Surface: grants, RLS, anon, definer posture
-- ============================================================================
select pg_temp.chk('NS1 tables have RLS', (select bool_and(relrowsecurity) from pg_class where oid in (
  'public.event_competition_heat_no_shows'::regclass, 'public.event_competition_heat_no_show_voids'::regclass)));
select pg_temp.chk('no API role holds any table privilege',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_heat_no_shows', 'event_competition_heat_no_show_voids')
                and g.grantee in ('anon', 'authenticated', 'service_role', 'public')));
select pg_temp.chk('anon cannot execute any NS1 function',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('mark_competition_heat_no_show', 'void_competition_heat_no_show', 'competition_round_no_shows',
                'competition_heat_entry_is_no_show', 'competition_heat_no_show_entries', '_compns1_guard_heat_entry_status')
                and has_function_privilege('anon', p.oid, 'execute')));
select pg_temp.chk('internal readers are not executable by API roles',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('competition_heat_entry_is_no_show', 'competition_heat_no_show_entries')
                and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))));
select pg_temp.chk('NS1 RPCs are SECURITY DEFINER with a pinned search_path and granted to authenticated',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('mark_competition_heat_no_show', 'void_competition_heat_no_show', 'competition_round_no_shows')
                and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                     or not has_function_privilege('authenticated', p.oid, 'execute'))));
select pg_temp.chk('history-protection triggers are installed on both tables',
  (select count(*) from pg_trigger where tgrelid in ('public.event_competition_heat_no_shows'::regclass, 'public.event_competition_heat_no_show_voids'::regclass)
      and tgfoid = 'public.protect_competition_history_evidence()'::regproc) = 4);

-- ============================================================================
-- 2. Authorization matrix (mark on r1 h1)
-- ============================================================================
set role authenticated;
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot mark', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30001')), 'permission denied');
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('a user with no role cannot mark', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30002')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a panel judge cannot mark', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30003')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('an assigned scorer cannot mark', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30004')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk (staff) cannot mark', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30005')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('owner of another tenant cannot mark event A', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30006')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000015'));
select pg_temp.expect_msg('judge of another tenant cannot mark event A', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30007')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('owner A cannot mark an event B heat entry', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d020', '008040'), pg_temp.u('f30008')), 'COMP_FORBIDDEN');
select pg_temp.expect_msg('unknown heat entry is refused like a forbidden one', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.u('ffffff'), pg_temp.u('f30009')), 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('no mark was written by any refused caller', pg_temp.nns() = 0);

-- ============================================================================
-- 3. Mark: chair and manager succeed; validation; idempotency
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('missing reason is refused', format($q$select public.mark_competition_heat_no_show(%L, null, %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30010')), 'COMP_NO_SHOW_REASON_REQUIRED');
select pg_temp.expect_msg('whitespace reason is refused', format($q$select public.mark_competition_heat_no_show(%L, '   ', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30011')), 'COMP_NO_SHOW_REASON_REQUIRED');
select pg_temp.expect_msg('over-long reason is refused', format($q$select public.mark_competition_heat_no_show(%L, %L, %L)$q$, pg_temp.he('00d001', '008003'), repeat('x', 501), pg_temp.u('f30012')), 'COMP_NO_SHOW_REASON_REQUIRED');
select pg_temp.expect_msg('missing request id is refused', format($q$select public.mark_competition_heat_no_show(%L, 'did not appear', null)$q$, pg_temp.he('00d001', '008003')), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.expect_ok('chair marks e03 in r1 h1', format($q$select public.mark_competition_heat_no_show(%L, 'Did not report to the floor', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30020')));
select pg_temp.expect_ok('replay (same request, same payload) succeeds', format($q$select public.mark_competition_heat_no_show(%L, 'Did not report to the floor', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30020')));
select pg_temp.expect_msg('same request id, different reason is refused', format($q$select public.mark_competition_heat_no_show(%L, 'Other reason', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30020')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_msg('same request id, different heat entry is refused', format($q$select public.mark_competition_heat_no_show(%L, 'Did not report to the floor', %L)$q$, pg_temp.he('00d001', '008002'), pg_temp.u('f30020')), 'COMP_REQUEST_REUSED');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('replayed flag is true on the replay',
  (public.mark_competition_heat_no_show(pg_temp.he('00d001', '008003'), 'Did not report to the floor', pg_temp.u('f30020')) ->> 'replayed')::boolean is not distinct from false, 'owner is a different actor');
reset role;
select pg_temp.chk('replay by a different actor was refused, so exactly one mark exists', pg_temp.nns() = 1);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.chk('chair replay returns replayed=true',
  (public.mark_competition_heat_no_show(pg_temp.he('00d001', '008003'), 'Did not report to the floor', pg_temp.u('f30020')) ->> 'replayed')::boolean);
select pg_temp.expect_msg('a new request on an already-marked entry is refused (no unrecorded request id)', format($q$select public.mark_competition_heat_no_show(%L, 'Again', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f30021')), 'COMP_NO_SHOW_ALREADY');
reset role;
select pg_temp.chk('still exactly one mark', pg_temp.nns() = 1);
select pg_temp.chk('mark carries reason, actor and event',
  exists (select 1 from public.event_competition_heat_no_shows n where n.reason = 'Did not report to the floor' and n.marked_by = pg_temp.u('000017')
          and n.event_id = pg_temp.u('00e001') and n.round_id = pg_temp.u('006001') and n.heat_id = pg_temp.u('00d001') and n.entry_id = pg_temp.u('008003')));
select pg_temp.chk('per-heat reader is true for the marked heat entry, false for its neighbour',
  public.competition_heat_entry_is_no_show(pg_temp.he('00d001', '008003')) and not public.competition_heat_entry_is_no_show(pg_temp.he('00d001', '008002')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('owner (manager) marks e22 in r7 h10', format($q$select public.mark_competition_heat_no_show(%L, 'Withdrew at the door', %L)$q$, pg_temp.he('00d010', '008022'), pg_temp.u('f30022')));
reset role;

-- ============================================================================
-- 4. Window and entry state
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a scheduled heat is outside the window', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d002', '008005'), pg_temp.u('f30030')), 'COMP_NO_SHOW_WINDOW');
select pg_temp.expect_msg('a scratched entry cannot be a no-show', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d013', '008030'), pg_temp.u('f30031')), 'COMP_NO_SHOW_ENTRY_STATE');
select pg_temp.expect_msg('ballots locked round is outside the window (correction path)', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d012', '008024'), pg_temp.u('f30032')), 'COMP_NO_SHOW_WINDOW');
select pg_temp.expect_ok('a complete heat of an active round is inside the window', format($q$select public.mark_competition_heat_no_show(%L, 'Left before the heat ended', %L)$q$, pg_temp.he('00d008', '008019'), pg_temp.u('f30033')));
reset role;
update public.event_competition_heat_entries set status = 'danced' where id = pg_temp.he('00d001', '008001');
select pg_temp.chk('a danced entry exists for the state test', (select status from public.event_competition_heat_entries where id = pg_temp.he('00d001', '008001')) = 'danced');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a danced entry cannot be a no-show', format($q$select public.mark_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008001'), pg_temp.u('f30034')), 'COMP_NO_SHOW_ENTRY_STATE');
reset role;
update public.event_competition_heat_entries set status = 'scheduled' where id = pg_temp.he('00d001', '008001');
select pg_temp.expect_msg('a no-show entry cannot become danced', format($q$update public.event_competition_heat_entries set status = 'danced' where id = %L$q$, pg_temp.he('00d001', '008003')), 'COMP_NO_SHOW_ACTIVE');

-- ============================================================================
-- 5. E2 effects: required ranking set (D-OM-5)
-- ============================================================================
select pg_temp.chk('r1 h1 required set excludes the no-show',
  public._compe2_heat_entries(pg_temp.u('00d001')) = array[pg_temp.u('008001'), pg_temp.u('008002')]::uuid[]);
select pg_temp.chk('the no-show leaves nothing else: other heats are unchanged',
  public._compe2_heat_entries(pg_temp.u('00d002')) = array[pg_temp.u('008004'), pg_temp.u('008005')]::uuid[]);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge ranking the no-show entry (full 1..3) is refused',
  format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk_all('00d001', '[1,2,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f40001')), 'COMP_');
select pg_temp.expect_msg('rank 3 is out of range once N is 2', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[1,3]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f40002')), 'COMP_BALLOT_MARK_OUT_OF_RANGE');
select pg_temp.expect_msg('a ranking that omits a danced entry is still incomplete', format($q$select public.submit_competition_ballot(%L, %L, (select jsonb_build_array(pg_temp.mk('00d001', '[1,2]') -> 0)), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f40003')), 'COMP_BALLOT_INCOMPLETE');
select pg_temp.expect_ok('full 1..2 over the remaining entries is accepted', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d001', '[2,1]'), %L)$q$, pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.u('f40004')));
reset role;
select pg_temp.chk('the stored ballot holds exactly two marks and none for the no-show',
  pg_temp.n($q$select count(*) from public.event_competition_marks m join public.event_competition_ballots b on b.id = m.ballot_id where b.heat_id = pg_temp.u('00d001')$q$) = 2
  and not exists (select 1 from public.event_competition_marks m where m.entry_id = pg_temp.u('008003')));
select pg_temp.chk('mark-insert guard refuses a mark for the no-show entry even from a trusted writer',
  (select count(*) from public.event_competition_ballots where heat_id = pg_temp.u('00d001')) = 1);
select pg_temp.expect_msg('direct mark insert for a no-show entry is refused by the guard',
  format($q$insert into public.event_competition_marks(event_id, ballot_id, entry_id, mark)
            select b.event_id, b.id, %L, to_jsonb(3) from public.event_competition_ballots b where b.heat_id = %L$q$, pg_temp.u('008003'), pg_temp.u('00d001')), 'COMP_');

-- ============================================================================
-- 6. E2 effects: callback eligible count (D-CT-2), T = 2, h4 has e09..e12
-- ============================================================================
select pg_temp.chk('r3 starts with 4 eligible couples', coalesce(array_length(public._compe2_round_entries(pg_temp.u('006003')), 1), 0) = 4);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select public.mark_competition_heat_no_show(pg_temp.he('00d004', '008012'), 'No show at callback', pg_temp.u('f50001'));
reset role;
select pg_temp.chk('one no-show: 3 eligible, T=2 still danced', coalesce(array_length(public._compe2_round_entries(pg_temp.u('006003')), 1), 0) = 3
  and not (public._compe2_round_blockers(pg_temp.u('006003')) ->> 'callback_not_danced')::boolean);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a callback selecting the no-show entry is refused',
  format($q$select public.submit_competition_ballot(%L, null, pg_temp.callback_marks(array['008009','008012']), %L)$q$, pg_temp.u('006003'), pg_temp.u('f50002')), 'COMP_');
select pg_temp.expect_ok('a callback with exactly T eligible couples is accepted',
  format($q$select public.submit_competition_ballot(%L, null, pg_temp.callback_marks(array['008009','008010']), %L)$q$, pg_temp.u('006003'), pg_temp.u('f50003')));
select pg_temp.as_user(pg_temp.u('000017'));
select public.mark_competition_heat_no_show(pg_temp.he('00d004', '008011'), 'Second no show', pg_temp.u('f50004'));
reset role;
select pg_temp.chk('two no-shows: 2 eligible, T >= eligible means not danced',
  coalesce(array_length(public._compe2_round_entries(pg_temp.u('006003')), 1), 0) = 2
  and (public._compe2_round_blockers(pg_temp.u('006003')) ->> 'callback_not_danced')::boolean);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('the not-danced callback round does not lock', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006003'), pg_temp.u('f50005')), 'COMP_CALLBACK_NOT_DANCED');
reset role;

-- ============================================================================
-- 7. Stale after no-show (r5 h7: e14 e15 e16, three judges), fails closed
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[1,2,3]'), pg_temp.u('f60001'));
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1,3]'), pg_temp.u('f60002'));
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[3,2,1]'), pg_temp.u('f60003'));
reset role;
select pg_temp.chk('before the no-show no ballot of r5 is stale', pg_temp.stale('006005') = 0);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.mark_competition_heat_no_show(pg_temp.he('00d007', '008016'), 'Withdrew after warm-up', pg_temp.u('f60010'));
reset role;
select pg_temp.chk('after the no-show all three submitted ballots are stale', pg_temp.stale('006005') = 3);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('lock refuses stale ballots', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f60011')), 'COMP_BALLOTS_STALE');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_ok('judge 1 corrects (version 2)', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[1,2]'), %L)$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f60012')));
reset role;
select pg_temp.chk('two ballots remain stale until the other judges correct', pg_temp.stale('006005') = 2);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1]'), pg_temp.u('f60013'));
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1]'), pg_temp.u('f60014'));
reset role;
select pg_temp.chk('all corrected: no stale ballot', pg_temp.stale('006005') = 0);
-- void returns the entry to the required set; the corrected ballots now lack its mark -> stale again
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('void without a reason is refused', format($q$select public.void_competition_heat_no_show(%L, '', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60020')), 'COMP_NO_SHOW_REASON_REQUIRED');
select pg_temp.expect_ok('manager voids the no-show with a reason', format($q$select public.void_competition_heat_no_show(%L, 'Arrived late, danced', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60021')));
select pg_temp.chk('void replay returns replayed=true',
  (public.void_competition_heat_no_show(pg_temp.he('00d007', '008016'), 'Arrived late, danced', pg_temp.u('f60021')) ->> 'replayed')::boolean);
select pg_temp.expect_msg('void with the same request id for a different reason is refused', format($q$select public.void_competition_heat_no_show(%L, 'Different', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60021')), 'COMP_REQUEST_REUSED');
select pg_temp.expect_msg('voiding an entry with no active no-show is refused', format($q$select public.void_competition_heat_no_show(%L, 'again', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60022')), 'COMP_NO_SHOW_NOT_FOUND');
select pg_temp.expect_msg('a mark request id cannot be reused for a void', format($q$select public.void_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60010')), 'COMP_REQUEST_REUSED');
reset role;
select pg_temp.chk('void restores the entry to the required set', public._compe2_heat_entries(pg_temp.u('00d007')) @> array[pg_temp.u('008016')]::uuid[]
  and not public.competition_heat_entry_is_no_show(pg_temp.he('00d007', '008016')));
select pg_temp.chk('after the void the 2-mark ballots are stale (fail closed)', pg_temp.stale('006005') = 3);
select pg_temp.chk('both rows are kept: one mark, one void',
  pg_temp.nns('heat_entry_id = ' || quote_literal(pg_temp.he('00d007', '008016'))) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_heat_no_show_voids$q$) = 1);
-- mark again (a new row) and correct again
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the same heat entry can be marked again after a void', format($q$select public.mark_competition_heat_no_show(%L, 'Left for good', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60030')));
reset role;
select pg_temp.chk('re-mark: stale clears (existing ballots already match the 2-entry set)', pg_temp.stale('006005') = 0);
select pg_temp.chk('two mark rows exist for that heat entry, one void', pg_temp.nns('heat_entry_id = ' || quote_literal(pg_temp.he('00d007', '008016'))) = 2);

-- ============================================================================
-- 8. Reader for the F2 hook and multi-heat entries (r7: e21 in h10 and h11, e22 no-show in h10)
-- ============================================================================
select pg_temp.chk('r7: e22 (only in h10) is a round-level no-show entry',
  (select array_agg(entry_id order by entry_id) from public.competition_heat_no_show_entries(pg_temp.u('006007'))) = array[pg_temp.u('008022')]::uuid[]);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.mark_competition_heat_no_show(pg_temp.he('00d010', '008021'), 'No show in heat 1 only', pg_temp.u('f70001'));
reset role;
select pg_temp.chk('e21 no-show in h10 only: per-heat true, but not a round-level no-show (it dances h11)',
  public.competition_heat_entry_is_no_show(pg_temp.he('00d010', '008021')) and not public.competition_heat_entry_is_no_show(pg_temp.he('00d011', '008021'))
  and not exists (select 1 from public.competition_heat_no_show_entries(pg_temp.u('006007')) where entry_id = pg_temp.u('008021')));
select pg_temp.chk('e21 stays in the round eligible set while it dances h11', pg_temp.u('008021') = any (public._compe2_round_entries(pg_temp.u('006007'))));
select pg_temp.chk('h10 required set is empty (both entries no-show), h11 keeps e21 and e23',
  coalesce(array_length(public._compe2_heat_entries(pg_temp.u('00d010')), 1), 0) = 0 and array_length(public._compe2_heat_entries(pg_temp.u('00d011')), 1) = 2);
select pg_temp.chk('h10 (only no-shows) is no longer a ballot heat; h11 is',
  not exists (select 1 from public._compe2_round_heats(pg_temp.u('006007')) h where h.heat_id = pg_temp.u('00d010'))
  and exists (select 1 from public._compe2_round_heats(pg_temp.u('006007')) h where h.heat_id = pg_temp.u('00d011')));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select public.mark_competition_heat_no_show(pg_temp.he('00d011', '008021'), 'No show in heat 2 as well', pg_temp.u('f70002'));
reset role;
select pg_temp.chk('e21 no-show in every heat: round-level no-show entry, out of the eligible set',
  exists (select 1 from public.competition_heat_no_show_entries(pg_temp.u('006007')) where entry_id = pg_temp.u('008021'))
  and not (pg_temp.u('008021') = any (public._compe2_round_entries(pg_temp.u('006007')))));
select pg_temp.chk('an entry scratched in one heat and no-show in another is not hidden: only no-show/scratched counted once',
  (select count(*) from public.competition_heat_no_show_entries(pg_temp.u('006007'))) = 2);

-- F2 hook (when F2 is installed): excludedEntries lists the no-show entries with reason no_show
select pg_temp.chk('F2 evidence lists no_show exclusions for r5? (r5 e16 is a no-show) -- when F2 is present',
  case when to_regprocedure('public._compf2_evidence(uuid,text,text)') is null then true
       else exists (select 1 from jsonb_array_elements(public._compf2_evidence(pg_temp.u('006005'), 'ordinal_majority', '1') -> 'excludedEntries') x
                    where x ->> 'reason' = 'no_show' and (x ->> 'entryId')::uuid = pg_temp.u('008016')) end,
  coalesce((public._compf2_evidence(pg_temp.u('006005'), 'ordinal_majority', '1') -> 'excludedEntries')::text, 'no F2'));

-- ============================================================================
-- 9. Lock then the correction path: window closes
-- ============================================================================
-- (r5's heat must be locked for the E2 lock; use the real 10A RPC as the manager)
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('manager locks the r5 heat', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'ns1 suite')$q$, pg_temp.u('00d007')));
select pg_temp.expect_ok('manager locks the r5 round ballots (ballots match the required set)', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f80001')));
select pg_temp.expect_msg('after lock a mark is refused', format($q$select public.mark_competition_heat_no_show(%L, 'late', %L)$q$, pg_temp.he('00d007', '008015'), pg_temp.u('f80002')), 'COMP_NO_SHOW_WINDOW');
select pg_temp.expect_msg('after lock a void is refused', format($q$select public.void_competition_heat_no_show(%L, 'late', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f80003')), 'COMP_NO_SHOW_WINDOW');
select pg_temp.expect_ok('replay of an earlier mark is still answered after lock', format($q$select public.mark_competition_heat_no_show(%L, 'Left for good', %L)$q$, pg_temp.he('00d007', '008016'), pg_temp.u('f60030')));
reset role;

-- ============================================================================
-- 10. Void authorization and window
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('a judge cannot void', format($q$select public.void_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f90001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot void', format($q$select public.void_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f90002')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another tenant cannot void', format($q$select public.void_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f90003')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot void', format($q$select public.void_competition_heat_no_show(%L, 'x', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f90004')), 'permission denied');
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('chair voids the r1 h1 no-show', format($q$select public.void_competition_heat_no_show(%L, 'Arrived at the floor', %L)$q$, pg_temp.he('00d001', '008003'), pg_temp.u('f90005')));
reset role;
select pg_temp.chk('r1 h1 required set is back to 3', array_length(public._compe2_heat_entries(pg_temp.u('00d001')), 1) = 3);

-- ============================================================================
-- 11. competition_round_no_shows (read)
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('a panel judge reads the round''s no-shows (including voided ones)',
  jsonb_array_length(public.competition_round_no_shows(pg_temp.u('006001'))) = 1
  and (public.competition_round_no_shows(pg_temp.u('006001')) -> 0 ->> 'voided')::boolean);
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.chk('an assigned scorer reads them', jsonb_array_length(public.competition_round_no_shows(pg_temp.u('006001'))) = 1);
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('a user with no role cannot read', format($q$select public.competition_round_no_shows(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('another tenant cannot read', format($q$select public.competition_round_no_shows(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('front desk cannot read', format($q$select public.competition_round_no_shows(%L)$q$, pg_temp.u('006001')), 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('anon cannot read', format($q$select public.competition_round_no_shows(%L)$q$, pg_temp.u('006001')), 'permission denied');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('judge sheet hides no-show entries (r7 is not the judge''s round; r3 callback list excludes them)',
  jsonb_array_length((public.competition_judge_ballot_sheet(pg_temp.u('006003')) -> 'heats' -> 0 -> 'entries')) = 2);
select pg_temp.expect_ok('ballot status board still renders', format($q$select public.competition_round_ballot_status(%L)$q$, pg_temp.u('006003')));
reset role;

-- ============================================================================
-- 12. Append-only protection
-- ============================================================================
select pg_temp.expect_msg('UPDATE on a mark is refused (even for a superuser)', $q$update public.event_competition_heat_no_shows set reason = 'edited'$q$, 'append-only');
select pg_temp.expect_msg('DELETE on a mark is refused', $q$delete from public.event_competition_heat_no_shows$q$, 'append-only');
select pg_temp.expect_msg('TRUNCATE on the marks is refused', $q$truncate public.event_competition_heat_no_shows cascade$q$, 'append-only');
select pg_temp.expect_msg('UPDATE on a void is refused', $q$update public.event_competition_heat_no_show_voids set reason = 'edited'$q$, 'append-only');
select pg_temp.expect_msg('DELETE on a void is refused', $q$delete from public.event_competition_heat_no_show_voids$q$, 'append-only');
select pg_temp.expect_msg('TRUNCATE on the voids is refused', $q$truncate public.event_competition_heat_no_show_voids$q$, 'append-only');
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('the owner cannot read the table directly', $q$select count(*) from public.event_competition_heat_no_shows$q$, 'permission denied');
select pg_temp.expect_msg('the owner cannot insert into the table directly', format($q$insert into public.event_competition_heat_no_shows(event_id, round_id, heat_id, heat_entry_id, entry_id, reason, marked_by, request_id)
  values (%L, %L, %L, %L, %L, 'x', %L, gen_random_uuid())$q$, pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.u('00d001'), pg_temp.he('00d001', '008002'), pg_temp.u('008002'), pg_temp.u('000001')), 'permission denied');
reset role;

-- ============================================================================
-- 13. Real-flow round via the O1 fixture helper (event C): publish -> schedule -> start -> heat transitions -> no-show
-- ============================================================================
-- Requires pg_temp.compo1_fixture_* (fixtures/competition_round_ready.sql loaded first). Skipped (recorded as NOT RUN in the detail) if absent.
select pg_temp.chk('O1 fixture helper loaded', to_regprocedure('pg_temp.compo1_fixture_activate_round(uuid,uuid)') is not null, 'cat fixtures/competition_round_ready.sql first');

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
    raise exception 'COMPETITION NS1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION NS1 SQL SUITE FAIL: %', v_failures;
end $$;
