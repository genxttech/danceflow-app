-- Competition U18 -- heat-entry danced / disqualified direct-write guard (20270215093000).
-- Run as a SUPERUSER on a database carrying the chain through the guard. One transaction, synthetic fixtures (UUID block ...-cf1018XXXXXX).
-- The final block ALWAYS raises: "COMPETITION U18 SQL SUITE PASS (<n> checks)" or "COMPETITION U18 SQL SUITE FAIL: <failures>".
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1018000001', 't-cf1018-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1018000001', 't-cf1018-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1018a00001', 'CF1 U18 Studio', 't-cf1018-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1018000001', '00000000-0000-0000-0000-cf1018a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018a00001', 'U18', 't-cf1018-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1018001001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1018002001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1018c00001', '00000000-0000-0000-0000-cf1018e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1018003001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018001001', '00000000-0000-0000-0000-cf1018002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1018006001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018001001', '00000000-0000-0000-0000-cf1018003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1018009001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1018d00001', '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018003001', '00000000-0000-0000-0000-cf1018006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1018002001', '00000000-0000-0000-0000-cf1018c00001', '00000000-0000-0000-0000-cf1018009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1018800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018001001', '00000000-0000-0000-0000-cf1018003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1018900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018003001', '00000000-0000-0000-0000-cf1018d00001',
       ('00000000-0000-0000-0000-cf1018800' || lpad(i::text, 3, '0'))::uuid, i, case when i = 4 then 'danced' else 'scheduled' end
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1018000001","role":"authenticated"}', true);

select pg_temp.chk('trigger exists and is enabled always (A)',
  (select tgenabled from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname = 'cf1_u18_guard_heat_entry_status') = 'A');
select pg_temp.chk('trigger function is SECURITY INVOKER and not executable by client roles',
  (select not prosecdef from pg_proc where proname = 'cf1_u18_guard_heat_entry_status')
  and not has_function_privilege('authenticated', 'public.cf1_u18_guard_heat_entry_status()', 'EXECUTE'));

-- the client can write the table at all (so the refusals below are the guard, not a missing grant)
select pg_temp.chk('fixture sanity: authenticated manager may update a heat entry (checked_in)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'checked_in' where id = '00000000-0000-0000-0000-cf1018900001'$q$) = 'OK');

-- direct writes into danced / disqualified are refused for every client role
select pg_temp.chk('authenticated: -> danced refused (42501)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900002'$q$) like '42501 COMP_U18_HEAT_ENTRY_STATUS_WRITER%');
select pg_temp.chk('authenticated: -> disqualified refused (42501)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1018900002'$q$) like '42501 COMP_U18_HEAT_ENTRY_STATUS_WRITER%');
select pg_temp.chk('service_role: -> danced refused',
  pg_temp.try_as('service_role', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900002'$q$) like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%');
select pg_temp.chk('authenticated: INSERT of a danced heat entry is refused (by this guard or an earlier schedule guard) and no row appears',
  pg_temp.try_as('authenticated', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
    values ('00000000-0000-0000-0000-cf1018e00001', '00000000-0000-0000-0000-cf1018003001', '00000000-0000-0000-0000-cf1018d00001', '00000000-0000-0000-0000-cf1018800005', 9, 'danced')$q$) <> 'OK'
  and not exists (select 1 from public.event_competition_heat_entries where entry_id = '00000000-0000-0000-0000-cf1018800005'));
select pg_temp.chk('the refused writes changed nothing (rows 2 and 3 still scheduled)',
  (select count(*) from public.event_competition_heat_entries where id in ('00000000-0000-0000-0000-cf1018900002', '00000000-0000-0000-0000-cf1018900003') and status = 'scheduled') = 2);

-- unaffected behaviour
select pg_temp.chk('authenticated: re-writing an already-danced row to danced is not a change (allowed)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900004'$q$) = 'OK');
select pg_temp.chk('authenticated: scratched is NOT refused by THIS guard (U18-S owns the scratch path)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1018900003'$q$) not like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%');
select pg_temp.chk('authenticated: un-dancing a danced row is refused and the row stays danced',
  pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scheduled' where id = '00000000-0000-0000-0000-cf1018900004'$q$) like '42501 COMP_U18_HEAT_ENTRY_STATUS_WRITER%'
  and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1018900004') = 'danced');

-- owner and definer paths are unaffected
create function pg_temp.definer_writer() returns void language plpgsql security definer as $$
begin update public.event_competition_heat_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1018900002'; end $$;
grant execute on function pg_temp.definer_writer() to authenticated;
create temp table t_def (r text) on commit drop;
grant all on t_def to authenticated;
insert into t_def select pg_temp.try_as('authenticated', 'select pg_temp.definer_writer()');
select pg_temp.chk('a SECURITY DEFINER function called by a client role can still set the status',
  (select r from t_def) = 'OK' and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1018900002') = 'disqualified', (select r from t_def));
update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900001';
select pg_temp.chk('the migration-owner / superuser session can still write danced',
  (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1018900001') = 'danced');

-- review hardening: a client cannot add its own trigger to rewrite the status; an unknown client-like role is refused (allowlist); the trigger is AFTER
select pg_temp.chk('TRIGGER privilege on the table is revoked from client roles',
  not has_table_privilege('authenticated', 'public.event_competition_heat_entries', 'TRIGGER') and not has_table_privilege('anon', 'public.event_competition_heat_entries', 'TRIGGER')
  and not has_table_privilege('service_role', 'public.event_competition_heat_entries', 'TRIGGER'));
select pg_temp.chk('authenticated: creating its own trigger on the table is refused',
  pg_temp.try_as('authenticated', $q$create trigger zz_probe before update on public.event_competition_heat_entries for each row execute function public.cf1_u18_guard_heat_entry_status()$q$) like '42501%',
  pg_temp.try_as('authenticated', $q$create trigger zz_probe2 before update on public.event_competition_heat_entries for each row execute function public.cf1_u18_guard_heat_entry_status()$q$));
select pg_temp.chk('the guard is an AFTER row trigger (sees the final status)',
  (select (tgtype & 2) = 0 from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname = 'cf1_u18_guard_heat_entry_status'));
create role cf1018_probe nologin;
grant authenticated to cf1018_probe;
select pg_temp.chk('an unknown client-like role (member of authenticated) is refused: allowlist, not denylist',
  pg_temp.try_as('cf1018_probe', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900003'$q$) like '%COMP_U18_HEAT_ENTRY_STATUS_WRITER%',
  pg_temp.try_as('cf1018_probe', $q$update public.event_competition_heat_entries set status = 'danced' where id = '00000000-0000-0000-0000-cf1018900003'$q$));

do $$
declare v_fail text; v_n integer;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_n, v_fail from t_results;
  if v_fail is null then raise exception 'COMPETITION U18 SQL SUITE PASS (% checks)', v_n;
  else raise exception 'COMPETITION U18 SQL SUITE FAIL: %', v_fail; end if;
end $$;
rollback;
