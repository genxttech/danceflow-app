-- ADAPTED COPY for a chain that carries PR 877 (S6). NOT a released suite and never counted as a pass of one. NOT EXECUTED in this form.
-- Source blob: 7ad6269c2c0de911e9c88ca62341b1f738a5c76e (the PR 863 run's copy with the eligibility-clearance hook); released blob d72eee3687648257488252f4fcb590eaf4f357b1.
-- Expected change from PR 877: findings F1 and F3 are closed. C1, C1b and C3 now assert the refusal and unchanged state; same number of checks; nothing else changed.
-- OD-31 guarded-baseline NEGATIVE suite for the heat-entry integrity guards (U18 20270215093000, U18-S 20270215094000).
-- Adds cases the shipped suites (test_T_competition_u18_* / u18s_*) do not cover. NO new SQL objects: this file only exercises existing ones and creates TEMP helpers.
-- Run as a SUPERUSER on a database carrying the Competition chain through 20270215094000. One transaction, synthetic fixtures (UUID block ...-cf1031XXXXXX), rolled back.
-- Sections: A = refusals that must hold; B = legitimate server-side operations that must keep working;
--           C = CHARACTERIZATION of known residuals/findings (these rows PASS when the documented current behaviour is observed; they are NOT approvals).
-- The final block ALWAYS raises: "OD31 NEGATIVE SUITE PASS (<n> checks)" or "OD31 NEGATIVE SUITE FAIL: <failures>".
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text := 'OK';
begin
  execute format('set local role %I', p_role);
  begin execute p_sql; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  reset role;
  return v;
end $$;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

-- fixtures (session_replication_role = replica only places rows; the guard is exercised afterwards with it reset)
set local session_replication_role = replica;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1031000001', 't-cf1031-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1031000001', 't-cf1031-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1031a00001', 'CF1 U18 Studio', 't-cf1031-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1031000001', '00000000-0000-0000-0000-cf1031a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031a00001', 'U18', 't-cf1031-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1031001001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1031002001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1031c00001', '00000000-0000-0000-0000-cf1031e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031001001', '00000000-0000-0000-0000-cf1031002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1031006001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031001001', '00000000-0000-0000-0000-cf1031003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1031009001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1031d00001', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1031002001', '00000000-0000-0000-0000-cf1031c00001', '00000000-0000-0000-0000-cf1031009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1031800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031001001', '00000000-0000-0000-0000-cf1031003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
do $r15$ begin if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then perform pg_temp.r15_clear_entries(); end if; end $r15$; -- composed-run hook (S4/R-15); inert unless the integrated runner prepends fixtures/r15_clear_entries.sql
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1031900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001',
       ('00000000-0000-0000-0000-cf1031800' || lpad(i::text, 3, '0'))::uuid, i, case when i = 4 then 'danced' else 'scheduled' end
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1031000001","role":"authenticated"}', true);

-- A. refusals --------------------------------------------------------------------------------------------------------------------------------
create temp table t_a (k text, r text) on commit drop;
grant all on t_a to authenticated, anon, service_role;
create or replace function pg_temp.hes(p_id text) returns text language sql as $$
  select status from public.event_competition_heat_entries where id = ('00000000-0000-0000-0000-cf1031900' || p_id)::uuid $$;

-- A1 anon: grants exist but there is no policy for anon, so a write is a silent no-op (0 rows) or an error; either way nothing changes.
insert into t_a select 'anon_upd', pg_temp.try_as('anon', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1031900002'$q$);
insert into t_a select 'anon_upd_scr', pg_temp.try_as('anon', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1031900002'$q$);
select pg_temp.chk('A1 anon cannot change a heat entry to danced or scratched (row unchanged)', pg_temp.hes('002') = 'scheduled', (select string_agg(k || '=' || r, ' | ') from t_a));
select pg_temp.chk('A1b anon cannot insert a disqualified heat entry',
  pg_temp.try_as('anon', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    values ('00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001', '00000000-0000-0000-0000-cf1031800005', 9, 'disqualified')$q$) <> 'OK'
  and not exists (select 1 from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1031800005'));

-- A2 service_role (key holder) is NOT exempt: INSERT / UPDATE / un-write are refused for danced, disqualified, scratched
select pg_temp.chk('A2a service_role: INSERT disqualified refused, no row',
  pg_temp.try_as('service_role', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    values ('00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001', '00000000-0000-0000-0000-cf1031800005', 9, 'disqualified')$q$) <> 'OK'
  and not exists (select 1 from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1031800005'));
select pg_temp.chk('A2b service_role: UPDATE -> disqualified refused (COMP_U18)',
  pg_temp.try_as('service_role', $q$update public.event_competition_heat_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1031900002'$q$) like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%');
select pg_temp.chk('A2c service_role: un-dance refused and row stays danced',
  pg_temp.try_as('service_role', $q$update public.event_competition_heat_entries set status = 'scheduled' where id = '00000000-0000-0000-0000-cf1031900004'$q$) like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%' and pg_temp.hes('004') = 'danced');

-- A3 a client cannot disable or bypass the triggers
select pg_temp.chk('A3a authenticated cannot ALTER TABLE ... DISABLE TRIGGER (not owner)',
  pg_temp.try_as('authenticated', 'alter table public.event_competition_heat_entries disable trigger cf1_u18_guard_heat_entry_status') like '42501%');
select pg_temp.chk('A3b authenticated cannot DROP the guard trigger (not owner)',
  pg_temp.try_as('authenticated', 'drop trigger cf1_u18_guard_heat_entry_status on public.event_competition_heat_entries') like '42501%');
select pg_temp.chk('A3c service_role cannot DISABLE or DROP the guards (not owner)',
  pg_temp.try_as('service_role', 'alter table public.event_competition_heat_entries disable trigger cf1_u18s_guard_heat_entry_scratch') like '42501%'
  and pg_temp.try_as('service_role', 'drop trigger cf1_u18s_guard_heat_entry_scratch on public.event_competition_heat_entries') like '42501%');
select pg_temp.chk('A3d client cannot REPLACE the guard function (not owner)',
  pg_temp.try_as('authenticated', $q$create or replace function public.cf1_u18_guard_heat_entry_status() returns trigger language plpgsql as 'begin return new; end'$q$) like '42501%');
select pg_temp.chk('A3e guards are ENABLE ALWAYS (fire even under session_replication_role = replica)',
  (select count(*) from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch') and tgenabled = 'A') = 2);
select pg_temp.chk('A3f clients cannot set session_replication_role (superuser-only GUC)',
  pg_temp.try_as('authenticated', $q$set session_replication_role = replica$q$) like '42501%');

-- A4 scratched is not reachable from a client by direct write, and the lifecycle RPC cannot be used to write other statuses
select pg_temp.chk('A4a authenticated direct scratch refused (UNAUDITED) and row unchanged',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1031900003'$q$) like '42501 COMP_U18S_SCRATCH_UNAUDITED%' and pg_temp.hes('003') = 'scheduled');
select pg_temp.chk('A4b service_role direct scratch refused',
  pg_temp.try_as('service_role', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1031900003'$q$) like '%COMP_U18S_SCRATCH_UNAUDITED%');
select pg_temp.chk('A4c the lifecycle RPC refuses statuses other than scratched/withdrawn (cannot be used to write disqualified/danced)',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1031800003', 'disqualified', 'x', 'retain')$q$) like '%Lifecycle action must be scratch or withdraw%'
  and pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1031800003', 'danced', 'x', 'retain')$q$) like '%Lifecycle action must be scratch or withdraw%');
select pg_temp.chk('A4d lifecycle RPC as anon cannot scratch (no manager identity)',
  pg_temp.try_as('anon', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1031800003', 'scratched', 'x', 'retain')$q$) <> 'OK' and pg_temp.hes('003') = 'scheduled');

-- A5 internal helpers that read the danced / disqualified evidence are not callable by clients
select pg_temp.chk('A5 HL1 / A5 / R2 / A1 evidence helpers are not executable by anon or authenticated',
  not has_function_privilege('anon', 'public._hl1_heat_is_danced(uuid,text)', 'execute') and not has_function_privilege('authenticated', 'public._hl1_heat_is_danced(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public._a5_cf1_entry_danced(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._r2_entry_participation_class(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_heat_entry_is_excluded(uuid)', 'execute'));

-- B. legitimate server-side operations keep working ----------------------------------------------------------------------------------------------
update public.event_competition_heat_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1031900001';
select pg_temp.chk('B1 superuser/owner session can still write disqualified and read it back (migration owner path)',
  (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1031900001') = 'disqualified');
select pg_temp.chk('B2 HL1 danced evidence (_hl1_heat_is_danced) sees an owner-written disqualified placement',
  public._hl1_heat_is_danced('00000000-0000-0000-0000-cf1031d00001'::uuid, 'scheduled'));
select pg_temp.chk('B3 client checked_in <-> scheduled on a normal row still works',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'checked_in' where id = '00000000-0000-0000-0000-cf1031900003'$q$) = 'OK'
  and pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scheduled' where id = '00000000-0000-0000-0000-cf1031900003'$q$) = 'OK');
create temp table t_b (r text) on commit drop;
grant all on t_b to authenticated;
insert into t_b select pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1031800003', 'scratched', 'OD31 negative suite', 'retain')$q$);
select pg_temp.chk('B4 audited lifecycle RPC still scratches (manager), exactly one scratch audit row',
  (select r from t_b) = 'OK' and pg_temp.hes('003') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1031800003' and change_type = 'scratch' and reason = 'OD31 negative suite') = 1,
  (select r from t_b) || ' / heat=' || coalesce(pg_temp.hes('003'), 'null') || ' / audit rows=' || (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1031800003')::text);

-- C. characterization of residuals / findings (current behaviour; NOT approvals) ----------------------------------------------------------------------
create temp table t_c (k text, r text) on commit drop;
grant all on t_c to authenticated, anon, service_role;
select set_config('app.competition_entry_change_type', '', true), set_config('app.competition_entry_change_reason', '', true), set_config('app.competition_entry_fee_handling', '', true);
-- C1 FINDING OD31-F1: the guards cover HEAT entries only. A manager can still write the PARENT entry status to 'disqualified' (competition_manage policy + UPDATE grant);
--    only the audit trigger runs (audit row change_type=status_change, reason NULL).
insert into t_c select 'entry_disq', pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1031800002'$q$);
select pg_temp.chk('C1 S6: a manager CANNOT set event_competition_entries.status = disqualified by direct write (finding F1 closed)',
  (select r from t_c where k = 'entry_disq') like '42501 COMP_S6_ENTRY_STATUS_WRITER%' and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1031800002') = 'confirmed',
  (select r from t_c where k = 'entry_disq'));
select pg_temp.chk('C1b S6: the refused write leaves no status_change audit row and the heat entry untouched (still scheduled)',
  (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1031800002' and change_type = 'status_change') = 0
  and pg_temp.hes('002') = 'scheduled');
select pg_temp.chk('C1c ... and the entry still counts in the ballot/results heat set (scoring unaffected by the parent status)',
  '00000000-0000-0000-0000-cf1031800002'::uuid = any (public._compe2_heat_entries('00000000-0000-0000-0000-cf1031d00001'::uuid)));
-- C2 FINDING OD31-F2: the parent entry TRIGGER privilege is still granted to clients (only the heat-entry table was revoked by U18)
-- ADAPTED COPY (R-15 / S6): the entry TRIGGER privilege is revoked by the R-15 write guard and by the S6 entry guard; before either, finding F2 stands.
select pg_temp.chk('C2 CHARACTERIZATION (finding F2): authenticated holds TRIGGER on event_competition_entries only until a guard that revokes it is installed',
  has_table_privilege('authenticated', 'public.event_competition_entries', 'TRIGGER') = (not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname in ('r15_guard_entry_eligibility_write', 'cf1_s6_guard_entry_status'))));
-- C3 FINDING OD31-F3 (SQL-session only): the scratch workflow marker is a plain GUC. In a session that can run arbitrary SQL, a manager can satisfy the U18-S condition
--    without the RPC: audited parent-entry scratch (the audit trigger writes the row), then set the GUC, then scratch the heat entry. Not reachable via PostgREST
--    (set_config lives in pg_catalog, which is not an exposed schema; no exposed function sets the marker for an arbitrary caller other than the lifecycle RPC).
set local session_replication_role = replica;
do $r15$ begin if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then perform pg_temp.r15_clear_entries(); end if; end $r15$; -- composed-run hook (S4/R-15); inert unless the integrated runner prepends fixtures/r15_clear_entries.sql
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
values ('00000000-0000-0000-0000-cf1031900006', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001', '00000000-0000-0000-0000-cf1031800005', 6, 'scheduled');
set local session_replication_role = origin;
insert into t_c select 'before_c3', (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1031800005') || '|' ||
  (select string_agg(status, ',' order by id) from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1031800005');
insert into t_c select 'forge_parent', pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1031800005'$q$);
select set_config('app.competition_entry_change_type', 'scratch', true);
insert into t_c select 'forge_heat', pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = '00000000-0000-0000-0000-cf1031800005'$q$);
select pg_temp.chk('C3 S6: the forged marker route is closed: the parent write and the heat write are both refused and nothing changes (finding F3 closed)',
  (select r from t_c where k = 'forge_parent') like '42501 COMP_S6_ENTRY_STATUS_WRITER%'
  and (select r from t_c where k = 'forge_heat') like '42501 COMP_U18S_SCRATCH_UNAUDITED%'
  and (select r from t_c where k = 'before_c3') = (select (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1031800005') || '|' ||
        (select string_agg(status, ',' order by id) from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1031800005')),
  (select string_agg(k || '=' || r, ' | ') from t_c where k like 'forge%' or k = 'before_c3'));
select set_config('app.competition_entry_change_type', '', true);
-- C4 residual: TRUNCATE is granted to clients and fires no row trigger (not reachable through PostgREST)
select pg_temp.chk('C4 CHARACTERIZATION (accepted residual): TRUNCATE is granted to authenticated and anon on the heat-entry table',
  has_table_privilege('authenticated', 'public.event_competition_heat_entries', 'TRUNCATE') and has_table_privilege('anon', 'public.event_competition_heat_entries', 'TRUNCATE'));

-- C5 reviewer-added: the guards watch the status column only. Characterize what is NOT blocked by them (other triggers may still refuse; detail records the outcome).
create temp table t_d (k text, r text) on commit drop;
grant all on t_d to authenticated, anon, service_role;
insert into t_d select 'move_danced_floor_order', pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set floor_order = 77 where id = '00000000-0000-0000-0000-cf1031900004'$q$);
insert into t_d select 'delete_scratched_row', pg_temp.try_as('authenticated', $q$delete from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1031900003'$q$);
select pg_temp.chk('C5 CHARACTERIZATION (finding F7): non-status changes and DELETE on danced/scratched rows are not covered by U18/U18-S (outcome in detail)', true,
  (select string_agg(k || '=' || r, ' | ') from t_d));
-- A6 reviewer-added: an upsert cannot set danced on an existing scheduled row, and a marker set for entry A does not authorise scratching entry B
select pg_temp.chk('A6 INSERT ... ON CONFLICT (id) DO UPDATE cannot set danced on an existing row',
  pg_temp.try_as('authenticated', $q$insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
    values ('00000000-0000-0000-0000-cf1031900006', '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001', '00000000-0000-0000-0000-cf1031800005', 6, 'danced')
    on conflict (id) do update set status = excluded.status$q$) like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%'
  or (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1031900006') <> 'danced');

-- D. S6 matrix: direct PARENT-entry status writes by a client manager (SET ROLE authenticated, i.e. what PostgREST executes), one fresh entry per status value.
-- Observed per value: outcome, audit row written by audit_competition_entry_change, effect on the heat entry, R2 participation class, ballot/results heat set membership.
set local session_replication_role = replica;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1031810' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031001001', '00000000-0000-0000-0000-cf1031003001', 's' || i, 'confirmed', 'eligible', '80' || i from generate_series(1, 6) i;
do $r15$ begin if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then perform pg_temp.r15_clear_entries(); end if; end $r15$; -- composed-run hook (S4/R-15); inert unless the integrated runner prepends fixtures/r15_clear_entries.sql
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1031910' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1031e00001', '00000000-0000-0000-0000-cf1031003001', '00000000-0000-0000-0000-cf1031d00001', ('00000000-0000-0000-0000-cf1031810' || lpad(i::text, 3, '0'))::uuid, 20 + i, 'scheduled' from generate_series(1, 6) i;
set local session_replication_role = origin;
select set_config('app.competition_entry_change_type', '', true), set_config('app.competition_entry_change_reason', '', true), set_config('app.competition_entry_fee_handling', '', true);
create temp table t_s6 (ord int, status text, outcome text, audit_type text, audit_reason text, audit_by_manager boolean, heat_entry_status text, r2_class text, in_heat_set boolean);
grant all on t_s6 to authenticated;
do $s6$
declare v_statuses text[] := array['disqualified', 'scratched', 'withdrawn', 'complete', 'waitlisted', 'pending'];
  i int; v_eid uuid; v_out text;
begin
  for i in 1..array_length(v_statuses, 1) loop
    v_eid := ('00000000-0000-0000-0000-cf1031810' || lpad(i::text, 3, '0'))::uuid;
    v_out := pg_temp.try_as('authenticated', format('update public.event_competition_entries set status = %L where id = %L', v_statuses[i], v_eid));
    insert into t_s6 values (i, v_statuses[i], v_out,
      (select c.change_type from public.event_competition_entry_changes c where c.entry_id = v_eid order by c.performed_at desc limit 1),
      (select c.reason from public.event_competition_entry_changes c where c.entry_id = v_eid order by c.performed_at desc limit 1),
      (select c.performed_by = '00000000-0000-0000-0000-cf1031000001' from public.event_competition_entry_changes c where c.entry_id = v_eid order by c.performed_at desc limit 1),
      (select h.status from public.event_competition_heat_entries h where h.entry_id = v_eid),
      (select public._r2_entry_participation_class(v_eid)),
      v_eid = any (public._compe2_heat_entries('00000000-0000-0000-0000-cf1031d00001'::uuid)));
  end loop;
end $s6$;
select pg_temp.chk('D1 S6 matrix collected for six direct parent-entry status writes (rows printed below; no assertion on the findings themselves)', (select count(*) from t_s6) = 6);
select * from t_s6 order by ord;
select name, ok, detail from t_results;

do $$
declare v_fail text; v_n integer;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_n, v_fail from t_results;
  if v_fail is null then raise exception 'OD31 NEGATIVE SUITE PASS (% checks)', v_n;
  else raise exception 'OD31 NEGATIVE SUITE FAIL: %', v_fail; end if;
end $$;
rollback;
