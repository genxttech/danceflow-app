begin;
-- Competition U18-S -- heat-entry scratch audit guard (20270215094000).
-- Run as a SUPERUSER on a database carrying the chain through the guard. One transaction, synthetic fixtures (UUID block ...-cf1019XXXXXX).
-- The final block ALWAYS raises: COMPETITION U18S SQL SUITE PASS (<n> checks) or FAIL.
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1019000001', 't-cf1019-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1019000001', 't-cf1019-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1019a00001', 'CF1 U18 Studio', 't-cf1019-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1019000001', '00000000-0000-0000-0000-cf1019a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019a00001', 'U18', 't-cf1019-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1019001001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1019002001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1019c00001', '00000000-0000-0000-0000-cf1019e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1019003001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019001001', '00000000-0000-0000-0000-cf1019002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1019006001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019001001', '00000000-0000-0000-0000-cf1019003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1019009001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1019d00001', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019003001', '00000000-0000-0000-0000-cf1019006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1019002001', '00000000-0000-0000-0000-cf1019c00001', '00000000-0000-0000-0000-cf1019009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1019800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019001001', '00000000-0000-0000-0000-cf1019003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1019900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019003001', '00000000-0000-0000-0000-cf1019d00001',
       ('00000000-0000-0000-0000-cf1019800' || lpad(i::text, 3, '0'))::uuid, i, 'scheduled'
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1019000001","role":"authenticated"}', true);


select pg_temp.chk('trigger exists, enabled always (A), AFTER row trigger',
  (select tgenabled = 'A' and (tgtype & 2) = 0 from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname = 'cf1_u18s_guard_heat_entry_scratch'));
select pg_temp.chk('guard is SECURITY INVOKER and not executable by clients',
  (select not prosecdef from pg_proc where proname = 'cf1_u18s_guard_heat_entry_scratch')
  and not has_function_privilege('authenticated', 'public.cf1_u18s_guard_heat_entry_scratch()', 'EXECUTE'));

-- the problem path: direct writes
select pg_temp.chk('direct heat-entry scratch by a manager (entry confirmed, no audit) is refused (42501 UNAUDITED)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900001'$q$) like '42501 COMP_U18S_SCRATCH_UNAUDITED%');
select pg_temp.chk('service_role direct scratch refused',
  pg_temp.try_as('service_role', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900001'$q$) like '%COMP_U18S_SCRATCH_UNAUDITED%');
select pg_temp.chk('client INSERT of a scratched heat entry is refused and no row appears',
  pg_temp.try_as('authenticated', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    values ('00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019003001', '00000000-0000-0000-0000-cf1019d00001', '00000000-0000-0000-0000-cf1019800005', 9, 'scratched')$q$) <> 'OK'
  and not exists (select 1 from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1019800005'));
select pg_temp.chk('the refused writes changed nothing (rows 1,2 scheduled, no audit rows)',
  (select count(*) from public.event_competition_heat_entries where id in ('00000000-0000-0000-0000-cf1019900001', '00000000-0000-0000-0000-cf1019900002') and status = 'scheduled') = 2
  and (select count(*) from public.event_competition_entry_changes where event_id = '00000000-0000-0000-0000-cf1019e00001') = 0);

-- a direct parent-entry status write is audited by the entry trigger but is not the workflow: still refused (no marker)
create temp table t_dir (r text) on commit drop;
grant all on t_dir to authenticated;
insert into t_dir select pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019800002'$q$);
select pg_temp.chk('direct parent-entry status write does not unlock a direct heat-entry scratch',
  (select r from t_dir) = 'OK'
  and pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900002'$q$) like '%COMP_U18S_SCRATCH_UNAUDITED%',
  (select r from t_dir));

-- the audited workflow keeps working (client invoker RPC)
create temp table t_rpc (r text) on commit drop;
grant all on t_rpc to authenticated;
insert into t_rpc select pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1019800001', 'scratched', 'judge saw a no-show on deck', 'retain')$q$);
select pg_temp.chk('lifecycle RPC scratch works for a client manager', (select r from t_rpc limit 1) = 'OK', (select r from t_rpc limit 1));
select pg_temp.chk('... heat entry and parent entry scratched; ONE audit row with the reason and the actor',
  (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1019900001') = 'scratched'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1019800001') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1019800001' and change_type = 'scratch'
         and reason = 'judge saw a no-show on deck' and performed_by = '00000000-0000-0000-0000-cf1019000001') = 1);
insert into t_rpc select pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1019800003', 'withdrawn', 'withdrew', 'refund')$q$);
select pg_temp.chk('lifecycle RPC withdraw works and scratches the heat entry',
  (select count(*) from t_rpc where r = 'OK') = 2 and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1019900003') = 'scratched');

-- un-scratch and neighbours
select pg_temp.chk('direct un-scratch by a client is refused (42501 UNSCRATCH) and the row stays scratched',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scheduled' where id = '00000000-0000-0000-0000-cf1019900001'$q$) like '42501 COMP_U18S_UNSCRATCH_WRITER%'
  and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1019900001') = 'scratched');
select pg_temp.chk('other status writes by a client remain allowed (checked_in)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'checked_in' where id = '00000000-0000-0000-0000-cf1019900004'$q$) = 'OK');
select pg_temp.chk('re-writing scratched to scratched is not a change',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900001'$q$) = 'OK');

-- owner / definer paths
create function pg_temp.definer_unscratch() returns void language plpgsql security definer as $$
begin update public.event_competition_heat_entries set status = 'scheduled' where id = '00000000-0000-0000-0000-cf1019900001'; end $$;
grant execute on function pg_temp.definer_unscratch() to authenticated;
create function pg_temp.definer_scratch() returns void language plpgsql security definer as $$
begin update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900004'; end $$;
grant execute on function pg_temp.definer_scratch() to authenticated;
create temp table t_def (r text) on commit drop;
grant all on t_def to authenticated;
insert into t_def select pg_temp.try_as('authenticated', 'select pg_temp.definer_unscratch()');
insert into t_def select pg_temp.try_as('authenticated', 'select pg_temp.definer_scratch()');
select pg_temp.chk('SECURITY DEFINER owner paths can still un-scratch and scratch (A6 / R2 style)',
  (select count(*) from t_def where r = 'OK') = 2
  and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1019900001') = 'scheduled'
  and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1019900004') = 'scratched',
  (select string_agg(r, ',') from t_def));

-- a marker alone does not authorise a scratch; an unknown client-like role is refused (allowlist)
set local session_replication_role = replica;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status) values ('00000000-0000-0000-0000-cf1019900006', '00000000-0000-0000-0000-cf1019e00001', '00000000-0000-0000-0000-cf1019003001', '00000000-0000-0000-0000-cf1019d00001', '00000000-0000-0000-0000-cf1019800005', 6, 'scheduled');
set local session_replication_role = origin;
select set_config('app.competition_entry_change_type', 'scratch', true);
create role cf1019_probe nologin;
grant authenticated to cf1019_probe;
select pg_temp.chk('workflow marker alone (parent entry not scratched, no audit row) does not authorise a scratch',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900006'$q$) like '%COMP_U18S_SCRATCH_UNAUDITED%');
select pg_temp.chk('an unknown client-like role (member of authenticated) is refused',
  pg_temp.try_as('cf1019_probe', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1019900006'$q$) like '%COMP_U18S%');

do $$
declare v_fail text; v_n integer;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_n, v_fail from t_results;
  if v_fail is null then raise exception 'COMPETITION U18S SQL SUITE PASS (% checks)', v_n;
  else raise exception 'COMPETITION U18S SQL SUITE FAIL: %', v_fail; end if;
end $$;
rollback;
