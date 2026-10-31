-- Competition CF1 A5 -- gate U38, exclusion half (composed chain only).
-- U38 (design A.9.2): a change to the ranking set after judges submitted makes those ballots stale, lock refuses COMP_BALLOTS_STALE, and
-- the corrected-ballot route works. The NS1 no-show half lives in test_T_competition_ns1_no_show.sql section 7. This file is the A5 half:
-- an EFFECTIVE audited exclusion (request + co-sign) after three judges submitted. The ranking-set effect comes from A3's readers, so this
-- suite REQUIRES A3 (20270120093000) and A5 (20270120094000) to be applied and refuses to run otherwise (reported BLOCKED by the runner).
-- Run as a SUPERUSER, one transaction, always raises: "COMPETITION CF1 A5 U38 SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".
-- Fixtures: the NS1 suite fixtures (header copied verbatim from test_T_competition_ns1_no_show.sql, same synthetic UUID block a51ff2).
-- Load with:  cat sql-tests/fixtures/competition_round_ready.sql sql-tests/test_T_competition_cf1_a5_u38_composed.sql | psql ...
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
-- Preflight: A3 readers and A5 functions must exist (otherwise the exclusion has no ranking effect)
-- ============================================================================
do $$
begin
  if to_regprocedure('public.request_round_exclusion(uuid,uuid,text,text,uuid)') is null
     or to_regprocedure('public._cf1_excluded_entries(uuid)') is null
     or pg_get_functiondef('public._compe2_round_entries(uuid)'::regprocedure) !~ '_cf1_heat_entry_is_excluded' then
    raise exception 'U38 BLOCKED: needs A3 (readers) and A5 (exclusion action) applied';
  end if;
end $$;

create or replace function pg_temp.xid(p_request uuid) returns uuid language sql stable security definer as $$ select id from public.event_competition_round_exclusions where request_id = p_request $$;
grant execute on function pg_temp.xid(uuid) to authenticated;

-- ============================================================================
-- U38 (A5): r5 h7 (e14 e15 e16), three judges submit, e16 is excluded through the audited action, ballots go stale
-- ============================================================================
set role authenticated;
select pg_temp.as_user(pg_temp.u('000011'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[1,2,3]'), pg_temp.u('f70001'));
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1,3]'), pg_temp.u('f70002'));
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[3,2,1]'), pg_temp.u('f70003'));
reset role;
select pg_temp.chk('U38 A5: before the exclusion no ballot of r5 is stale', pg_temp.stale('006005') = 0);

-- the couple became ineligible and danced
set session_replication_role = replica;
update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.u('008016');
set session_replication_role = origin;
select pg_temp.hl1_danced(pg_temp.u('00d007'));
select pg_temp.chk('U38 A5: the couple is ineligible and the heat is complete (danced)',
  (select eligibility_status from public.event_competition_entries where id = pg_temp.u('008016')) = 'ineligible'
  and (select status from public.event_competition_heats where id = pg_temp.u('00d007')) = 'complete');

set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U38 A5: the manager requests the exclusion',
  format($q$select public.request_round_exclusion(%L, %L, 'ineligible', 'Became ineligible before the heat', %L)$q$, pg_temp.u('006005'), pg_temp.u('008016'), pg_temp.u('f70010')));
reset role;
select pg_temp.chk('U38 A5: a pending request alone does not change the ranking set (ballots not stale)', pg_temp.stale('006005') = 0
  and public._compe2_heat_entries(pg_temp.u('00d007')) @> array[pg_temp.u('008016')]::uuid[]);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_ok('U38 A5: the chair co-signs',
  format($q$select public.cosign_round_exclusion(%L, %L)$q$, pg_temp.xid(pg_temp.u('f70010')), pg_temp.u('f70011')));
reset role;
select pg_temp.chk('U38 A5: after the co-sign all three submitted ballots are stale', pg_temp.stale('006005') = 3);
select pg_temp.chk('U38 A5: the excluded couple is out of the heat ranking set', not (public._compe2_heat_entries(pg_temp.u('00d007')) @> array[pg_temp.u('008016')]::uuid[]));
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U38 A5: the heat is locked (danced)', format($q$select public.set_competition_heat_lock_state(%L, 'locked', 'u38 suite')$q$, pg_temp.u('00d007')));
select pg_temp.expect_msg('U38 A5: lock refuses stale ballots after the exclusion', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f70012')), 'COMP_BALLOTS_STALE');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_ok('U38 A5: judge 1 files a corrected version', format($q$select public.submit_competition_ballot(%L, %L, pg_temp.mk('00d007', '[1,2]'), %L, 'correct after exclusion')$q$, pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.u('f70013')));
reset role;
select pg_temp.chk('U38 A5: two ballots remain stale until the other judges correct', pg_temp.stale('006005') = 2);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000012'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1]'), pg_temp.u('f70014'), 'correct after exclusion');
select pg_temp.as_user(pg_temp.u('000013'));
select public.submit_competition_ballot(pg_temp.u('006005'), pg_temp.u('00d007'), pg_temp.mk('00d007', '[2,1]'), pg_temp.u('f70015'), 'correct after exclusion');
reset role;
select pg_temp.chk('U38 A5: all corrected: no stale ballot', pg_temp.stale('006005') = 0);
set role authenticated;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U38 A5: lock succeeds once corrected', format($q$select public.lock_competition_round_ballots(%L, %L)$q$, pg_temp.u('006005'), pg_temp.u('f70016')));
reset role;
select pg_temp.chk('U38 A5: the round is ballots_locked', (select status from public.event_competition_rounds where id = pg_temp.u('006005')) = 'ballots_locked');

do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION CF1 A5 U38 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION CF1 A5 U38 SQL SUITE FAIL: %', v_failures;
end $$;
