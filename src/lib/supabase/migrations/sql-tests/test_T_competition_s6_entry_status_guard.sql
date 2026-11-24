-- Competition S6 -- event_competition_entries.status direct-write guard (20270301141000) and the lifecycle RPC as SECURITY DEFINER (20270301140000).
-- Run as a SUPERUSER (supabase_admin) on a database carrying the chain through BOTH S6 migrations. One transaction, synthetic fixtures (UUID block ...-cf1032XXXXXX), rolled back.
-- Callers are simulated with SET LOCAL ROLE (anon, authenticated with a manager JWT claim, service_role, and a probe role that is a member of authenticated): this reproduces table
-- privileges, RLS and trigger behaviour but is NOT an HTTP/PostgREST request.
-- Sections: A every status value x client role refused; B leaving any status refused; C unaffected behaviour; D INSERT; E bypass attempts (marker forgery, upsert, bulk, SET ROLE,
-- TRIGGER privilege, DDL, replica mode); F legitimate operations (lifecycle RPC, locked heat, definer writers incl. the real R2 withdrawal); G consistency and coexistence.
-- The final block ALWAYS raises: "COMPETITION S6 ENTRY STATUS GUARD SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".
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
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1032000001', 't-cf1032-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1032000001', 't-cf1032-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1032a00001', 'CF1 U18 Studio', 't-cf1032-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1032000001', '00000000-0000-0000-0000-cf1032a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032a00001', 'U18', 't-cf1032-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1032002001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1032c00001', '00000000-0000-0000-0000-cf1032e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1032006001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1032009001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1032d00001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1032002001', '00000000-0000-0000-0000-cf1032c00001', '00000000-0000-0000-0000-cf1032009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1032800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1032900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032d00001',
       ('00000000-0000-0000-0000-cf1032800' || lpad(i::text, 3, '0'))::uuid, i, case when i = 4 then 'danced' else 'scheduled' end
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000001","role":"authenticated"}', true);

-- helpers -----------------------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.es(p_n text) returns text language sql as $$
  select status from public.event_competition_entries where id = ('00000000-0000-0000-0000-cf1032800' || p_n)::uuid $$;
create or replace function pg_temp.hs(p_n text) returns text language sql as $$
  select status from public.event_competition_heat_entries where id = ('00000000-0000-0000-0000-cf1032900' || p_n)::uuid $$;
create or replace function pg_temp.aud(p_entry uuid) returns bigint language sql as $$
  select count(*) from public.event_competition_entry_changes where entry_id = p_entry $$;

-- extra fixtures: seven matrix entries (one per status value the CHECK allows) and a second user with no studio role
set local session_replication_role = replica;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1032810' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'm' || i, 'confirmed', 'eligible', '70' || i
from generate_series(1, 7) i;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1032000002', 't-cf1032-outsider@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1032000002', 't-cf1032-outsider@example.test', 'CF1032 outsider');
set local session_replication_role = origin;
create role cf1032_probe nologin;
grant authenticated to cf1032_probe;

-- A. every status value, every client role: refused, unchanged, no audit row, no participation-class change ------------------------------------------------
create temp table t_m (target text, as_role text, outcome text, start_status text, status_after text, audits_before bigint, audits_after bigint, class_before text, class_after text);
grant all on t_m to authenticated, anon, service_role;
do $m$
declare t text; r text; e uuid; s text; i int := 0; v text; b bigint; cb text;
begin
  foreach t in array array['pending','confirmed','waitlisted','scratched','withdrawn','disqualified','complete'] loop
    i := i + 1;
    e := ('00000000-0000-0000-0000-cf1032810' || lpad(i::text, 3, '0'))::uuid;
    s := case when t = 'confirmed' then 'pending' else 'confirmed' end;
    foreach r in array array['authenticated','service_role','anon','cf1032_probe'] loop
      update public.event_competition_entries set status = s where id = e;          -- owner/superuser reset (allowed)
      b := (select count(*) from public.event_competition_entry_changes where entry_id = e);
      cb := public._r2_entry_participation_class(e);
      v := pg_temp.try_as(r, format('update public.event_competition_entries set status = %L where id = %L', t, e));
      insert into t_m values (t, r, v, s, (select status from public.event_competition_entries where id = e), b,
        (select count(*) from public.event_competition_entry_changes where entry_id = e), cb, public._r2_entry_participation_class(e));
    end loop;
  end loop;
end $m$;
select pg_temp.chk('A1 ' || target || ' by ' || as_role || ': refused 42501 COMP_S6, status unchanged, no audit row, R2 class unchanged',
  outcome like '42501 COMP_S6_ENTRY_STATUS_WRITER%' and status_after = start_status and audits_after = audits_before and class_after is not distinct from class_before, outcome)
from t_m where as_role in ('authenticated', 'service_role', 'cf1032_probe');
select pg_temp.chk('A1 ' || target || ' by anon: no effect (no policy / refused), status unchanged, no audit row',
  status_after = start_status and audits_after = audits_before, outcome)
from t_m where as_role = 'anon';

-- B. leaving any non-confirmed status is refused too (reinstatement, un-disqualify, un-scratch, un-withdraw ...) --------------------------------------------
create temp table t_b (start_status text, as_role text, outcome text, status_after text);
grant all on t_b to authenticated, anon, service_role;
do $b$
declare s text; r text; e uuid := '00000000-0000-0000-0000-cf1032810001';
begin
  foreach s in array array['pending','waitlisted','scratched','withdrawn','disqualified','complete'] loop
    foreach r in array array['authenticated','service_role'] loop
      update public.event_competition_entries set status = s where id = e;
      insert into t_b values (s, r, pg_temp.try_as(r, format('update public.event_competition_entries set status = %L where id = %L', 'confirmed', e)),
        (select status from public.event_competition_entries where id = e));
    end loop;
  end loop;
end $b$;
select pg_temp.chk('B ' || start_status || ' -> confirmed by ' || as_role || ' refused and unchanged', outcome like '42501 COMP_S6%' and status_after = start_status, outcome) from t_b;

-- C. what is NOT affected ----------------------------------------------------------------------------------------------------------------------------
update public.event_competition_entries set status = 'confirmed' where id = '00000000-0000-0000-0000-cf1032810001';
select pg_temp.chk('C1 a manager can still edit other columns (display_name, entry_number)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_entries set display_name = 'renamed', entry_number = '799' where id = '00000000-0000-0000-0000-cf1032810001'$q$) = 'OK'
  and (select display_name from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810001') = 'renamed');
select pg_temp.chk('C2 re-writing the same status value is not a change (allowed)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'confirmed' where id = '00000000-0000-0000-0000-cf1032810001'$q$) = 'OK');
update public.event_competition_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1032810002';
update public.event_competition_entries set status = 'confirmed' where id = '00000000-0000-0000-0000-cf1032810002';
select pg_temp.chk('C3 owner/superuser session can still write disqualified and clear it',
  (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810002') = 'confirmed');

-- D. INSERT paths ------------------------------------------------------------------------------------------------------------------------------------
create temp table t_d (k text, r text);
grant all on t_d to authenticated, anon, service_role;
insert into t_d select 'ins_confirmed_auth', pg_temp.try_as('authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820001', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x1', 'confirmed', 'unverified', '801')$q$);
insert into t_d select 'ins_disq_service', pg_temp.try_as('service_role', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820002', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x2', 'disqualified', 'unverified', '802')$q$);
insert into t_d select 'ins_pending_auth', pg_temp.try_as('authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
  values ('00000000-0000-0000-0000-cf1032820003', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'x3', 'pending', 'unverified', '803')$q$);
select pg_temp.chk('D1 client INSERT of a confirmed or disqualified entry is refused and no row appears',
  (select r from t_d where k = 'ins_confirmed_auth') like '42501 COMP_S6%' and (select r from t_d where k = 'ins_disq_service') like '42501 COMP_S6%'
  and not exists (select 1 from public.event_competition_entries where id in ('00000000-0000-0000-0000-cf1032820001', '00000000-0000-0000-0000-cf1032820002')),
  (select string_agg(k || '=' || r, ' | ') from t_d));
select pg_temp.chk('D2 a client INSERT as pending is not refused by THIS guard (outcome recorded)', (select r from t_d where k = 'ins_pending_auth') not like '%COMP_S6%', (select r from t_d where k = 'ins_pending_auth'));

-- E. bypass attempts --------------------------------------------------------------------------------------------------------------------------------
select set_config('app.competition_entry_change_type', 'scratch', true), set_config('app.competition_entry_change_reason', 'forged marker', true);
select pg_temp.chk('E1 forging the U18-S style workflow marker does not unlock a direct parent scratch (the guard does not read any marker)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1032810003'$q$) like '42501 COMP_S6%'
  and pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'withdrawn' where id = '00000000-0000-0000-0000-cf1032810003'$q$) like '42501 COMP_S6%'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810003') = 'confirmed');
select set_config('app.competition_entry_change_type', '', true), set_config('app.competition_entry_change_reason', '', true);
select pg_temp.chk('E2 INSERT ... ON CONFLICT (id) DO UPDATE cannot change status',
  pg_temp.try_as('authenticated', $q$insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values ('00000000-0000-0000-0000-cf1032810004', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032001001', '00000000-0000-0000-0000-cf1032003001', 'u', 'pending', 'unverified', '890')
    on conflict (id) do update set status = 'disqualified'$q$) like '42501 COMP_S6%'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810004') = 'confirmed');
select pg_temp.chk('E3 a bulk UPDATE touching several entries is refused as a whole (nothing changed)',
  pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'withdrawn' where id in ('00000000-0000-0000-0000-cf1032810005', '00000000-0000-0000-0000-cf1032810006', '00000000-0000-0000-0000-cf1032810007')$q$) like '42501 COMP_S6%'
  and (select count(*) from public.event_competition_entries where id in ('00000000-0000-0000-0000-cf1032810005', '00000000-0000-0000-0000-cf1032810006', '00000000-0000-0000-0000-cf1032810007') and status = 'confirmed') = 3);
select pg_temp.chk('E4 a client cannot SET ROLE to an owner role',
  pg_temp.try_as('authenticated', 'set role postgres') like '42501%' and pg_temp.try_as('service_role', 'set role supabase_admin') like '42501%');
select pg_temp.chk('E5 TRIGGER privilege on the entries table is gone for anon, authenticated and service_role (finding F2)',
  not has_table_privilege('anon', 'public.event_competition_entries', 'TRIGGER') and not has_table_privilege('authenticated', 'public.event_competition_entries', 'TRIGGER') and not has_table_privilege('service_role', 'public.event_competition_entries', 'TRIGGER'));
select pg_temp.chk('E6 a client cannot create its own trigger on the entries table (authenticated, service_role, member probe)',
  pg_temp.try_as('authenticated', $q$create trigger zz_probe before update on public.event_competition_entries for each row execute function public.cf1_s6_guard_entry_status()$q$) like '42501%'
  and pg_temp.try_as('service_role', $q$create trigger zz_probe2 before update on public.event_competition_entries for each row execute function public.cf1_s6_guard_entry_status()$q$) like '42501%'
  and pg_temp.try_as('cf1032_probe', $q$create trigger zz_probe3 before update on public.event_competition_entries for each row execute function public.cf1_s6_guard_entry_status()$q$) like '42501%');
select pg_temp.chk('E7 a client cannot disable, drop or replace the guard',
  pg_temp.try_as('authenticated', 'alter table public.event_competition_entries disable trigger cf1_s6_guard_entry_status') like '42501%'
  and pg_temp.try_as('service_role', 'drop trigger cf1_s6_guard_entry_status on public.event_competition_entries') like '42501%'
  and pg_temp.try_as('authenticated', $q$create or replace function public.cf1_s6_guard_entry_status() returns trigger language plpgsql as 'begin return new; end'$q$) like '42501%');
select pg_temp.chk('E8 a client cannot set session_replication_role, and the guard is ENABLE ALWAYS and AFTER ROW',
  pg_temp.try_as('authenticated', 'set session_replication_role = replica') like '42501%'
  and (select tgenabled = 'A' and (tgtype & 2) = 0 and (tgtype & 1) = 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status'));
select pg_temp.chk('E9 the guard function is SECURITY INVOKER and not executable by clients',
  (select not prosecdef from pg_proc where proname = 'cf1_s6_guard_entry_status')
  and not has_function_privilege('anon', 'public.cf1_s6_guard_entry_status()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.cf1_s6_guard_entry_status()', 'EXECUTE') and not has_function_privilege('service_role', 'public.cf1_s6_guard_entry_status()', 'EXECUTE'));

-- F. legitimate operations keep working ------------------------------------------------------------------------------------------------------------
create temp table t_f (k text, r text);
grant all on t_f to authenticated, anon, service_role;
-- F1/F2: the lifecycle RPC as the event manager
insert into t_f select 'rpc_scratch', pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800001', 'scratched', 'S6 scratch', 'retain')$q$);
select pg_temp.chk('F1 lifecycle RPC (definer): manager scratches an entry; parent AND heat entry scratched, ONE audit row with reason and actor',
  (select r from t_f where k = 'rpc_scratch') = 'OK' and pg_temp.es('001') = 'scratched' and pg_temp.hs('001') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1032800001' and change_type = 'scratch' and reason = 'S6 scratch' and performed_by = '00000000-0000-0000-0000-cf1032000001') = 1,
  (select r from t_f where k = 'rpc_scratch'));
insert into t_f select 'rpc_withdraw', pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800002', 'withdrawn', 'S6 withdraw', 'refund')$q$);
select pg_temp.chk('F2 lifecycle RPC: manager withdraws an entry; parent withdrawn, heat entry scratched, one withdraw audit row',
  (select r from t_f where k = 'rpc_withdraw') = 'OK' and pg_temp.es('002') = 'withdrawn' and pg_temp.hs('002') = 'scratched'
  and (select count(*) from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-cf1032800002' and change_type = 'withdraw') = 1,
  (select r from t_f where k = 'rpc_withdraw'));
select pg_temp.chk('F3 lifecycle RPC cannot be used to write other statuses (disqualified, complete, danced)',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800003', 'disqualified', 'x', 'retain')$q$) like '%Lifecycle action must be scratch or withdraw%'
  and pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800003', 'complete', 'x', 'retain')$q$) like '%Lifecycle action must be scratch or withdraw%'
  and pg_temp.es('003') = 'confirmed');
-- F4: a user who is not a manager of the event is refused by the RPC's own authorization (not by RLS)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000002","role":"authenticated"}', true);
select pg_temp.chk('F4 lifecycle RPC as an authenticated user who does not manage the event is refused and nothing changes',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800003', 'scratched', 'outsider', 'retain')$q$) like '%cannot be managed%'
  and pg_temp.es('003') = 'confirmed' and pg_temp.hs('003') = 'scheduled');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1032000001","role":"authenticated"}', true);
select pg_temp.chk('F5 lifecycle RPC is not executable by anon or service_role (no auth.uid) and is SECURITY DEFINER owned by an owner role',
  not has_function_privilege('anon', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE') and not has_function_privilege('service_role', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.change_competition_entry_lifecycle(uuid,text,text,text)', 'EXECUTE')
  and (select prosecdef and pg_get_userbyid(proowner) in ('postgres', 'supabase_admin') from pg_proc where oid = 'public.change_competition_entry_lifecycle(uuid,text,text,text)'::regprocedure));
-- F6: locked heat refusal of the RPC is preserved
set local session_replication_role = replica;
update public.event_competition_heats set lock_state = 'locked' where id = '00000000-0000-0000-0000-cf1032d00001';
set local session_replication_role = origin;
select pg_temp.chk('F6 the RPC still refuses an entry in a locked heat (entry 3 is in heat 1 which is now locked) and nothing changes',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800003', 'scratched', 'locked', 'retain')$q$) like '%locked or certified heat%' and pg_temp.es('003') = 'confirmed');
-- F7: SECURITY DEFINER writers owned by an exempt role: the real R2 withdrawal and an arbitrary definer stand-in for finalize / sync
select pg_temp.chk('F7 the real R2 withdrawal definer (_r2_withdraw_entry) still withdraws an entry', (select count(*) from (select public._r2_withdraw_entry('00000000-0000-0000-0000-cf1032800005', 'S6 R2', 'retain')) z) = 1 and pg_temp.es('005') = 'withdrawn');
create function pg_temp.definer_writer(p_status text) returns void language plpgsql security definer as $$
begin update public.event_competition_entries set status = p_status where id = '00000000-0000-0000-0000-cf1032810003'; end $$;
grant execute on function pg_temp.definer_writer(text) to authenticated;
select pg_temp.chk('F8 a SECURITY DEFINER function owned by the owner role, called by a client, can still move an entry through every status (finalize / sync style)',
  (select bool_and(pg_temp.try_as('authenticated', format('select pg_temp.definer_writer(%L)', s)) = 'OK') from unnest(array['pending','waitlisted','scratched','withdrawn','disqualified','complete','confirmed']) s)
  and pg_temp.es('003') = 'confirmed');

-- H. lifecycle RPC hardening (20270301142000): idempotent, serialized source states, placed entries refused -------------------------------------------------------
create temp table t_h (k text, r text, v bigint);
grant all on t_h to authenticated, anon, service_role;
-- H1 a repeat scratch of an already scratched entry (entry 1 was scratched in F1) is a no-op: no second audit row, no lifecycle_version bump
create temp table t_h1 (ver bigint, aud bigint);
insert into t_h1 select lifecycle_version, pg_temp.aud(id) from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032800001';
insert into t_h select 'repeat_scratch', pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800001', 'scratched', 'again', 'retain')$q$), 0;
select pg_temp.chk('H1 repeat scratch is a silent no-op: same lifecycle_version, same audit row count, still scratched',
  (select r from t_h where k = 'repeat_scratch') = 'OK'
  and (select lifecycle_version from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032800001') = (select ver from t_h1)
  and pg_temp.aud('00000000-0000-0000-0000-cf1032800001') = (select aud from t_h1) and pg_temp.es('001') = 'scratched');
-- H1b repair: an entry scratched earlier whose heat entry was left scheduled (owner-written state) is repaired by repeating the call: heat entry scratched, still no new audit row or version bump
set local session_replication_role = replica;
update public.event_competition_heats set lock_state = 'open' where id = '00000000-0000-0000-0000-cf1032d00001';
update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1032810003';
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
values ('00000000-0000-0000-0000-cf1032900071', '00000000-0000-0000-0000-cf1032e00001', '00000000-0000-0000-0000-cf1032003001', '00000000-0000-0000-0000-cf1032d00001', '00000000-0000-0000-0000-cf1032810003', 71, 'scheduled');
set local session_replication_role = origin;
create temp table t_h1b (ver bigint, aud bigint);
insert into t_h1b select lifecycle_version, pg_temp.aud(id) from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810003';
select pg_temp.chk('H1b repeat call on an already scratched entry completes the heat-entry cascade without a new audit row or version bump',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032810003', 'scratched', 'repair', 'not_applicable')$q$) = 'OK'
  and (select status from public.event_competition_heat_entries where id = '00000000-0000-0000-0000-cf1032900071') = 'scratched'
  and (select lifecycle_version from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810003') = (select ver from t_h1b)
  and pg_temp.aud('00000000-0000-0000-0000-cf1032810003') = (select aud from t_h1b));
-- H2 a scratched entry cannot be withdrawn through the RPC (and not the other way); the refusal changes nothing
select pg_temp.chk('H2 scratched -> withdrawn through the RPC is refused with COMP_ENTRY_LIFECYCLE_STATE and changes nothing',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800001', 'withdrawn', 'x', 'retain')$q$) like '%COMP_ENTRY_LIFECYCLE_STATE%'
  and pg_temp.es('001') = 'scratched' and pg_temp.aud('00000000-0000-0000-0000-cf1032800001') = (select aud from t_h1));
-- H3 disqualified / complete entries cannot be scratched or withdrawn through the RPC
update public.event_competition_entries set status = 'complete' where id = '00000000-0000-0000-0000-cf1032810004';
update public.event_competition_entries set status = 'disqualified' where id = '00000000-0000-0000-0000-cf1032810005';
select pg_temp.chk('H3 complete and disqualified entries are refused by the RPC (COMP_ENTRY_LIFECYCLE_STATE) and unchanged',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032810004', 'scratched', 'x', 'retain')$q$) like '%COMP_ENTRY_LIFECYCLE_STATE%'
  and pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032810005', 'withdrawn', 'x', 'retain')$q$) like '%COMP_ENTRY_LIFECYCLE_STATE%'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810004') = 'complete'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810005') = 'disqualified');
-- H4 an entry whose heat entry is danced is refused (R2 participation rule), although the heat is not locked
update public.event_competition_heat_entries set status = 'danced' where entry_id = '00000000-0000-0000-0000-cf1032800004';
set local session_replication_role = replica;
update public.event_competition_heats set lock_state = 'open' where id = '00000000-0000-0000-0000-cf1032d00001';
set local session_replication_role = origin;
select pg_temp.chk('H4 an entry with a danced heat entry (heat unlocked) is refused with COMP_ENTRY_LIFECYCLE_PLACED and unchanged',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800004', 'scratched', 'x', 'retain')$q$) like '%COMP_ENTRY_LIFECYCLE_PLACED%'
  and pg_temp.es('004') = 'confirmed' and pg_temp.hs('004') = 'danced');
-- H5 an entry in an active heat is refused too
set local session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scheduled' where entry_id = '00000000-0000-0000-0000-cf1032800004';
update public.event_competition_heats set status = 'active' where id = '00000000-0000-0000-0000-cf1032d00001';
set local session_replication_role = origin;
select pg_temp.chk('H5 an entry in an ACTIVE heat is refused with COMP_ENTRY_LIFECYCLE_PLACED and unchanged',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032800004', 'scratched', 'x', 'retain')$q$) like '%COMP_ENTRY_LIFECYCLE_PLACED%'
  and pg_temp.es('004') = 'confirmed');
-- H6 legitimate source states still work: waitlisted -> scratched, pending -> withdrawn
update public.event_competition_entries set status = 'waitlisted' where id = '00000000-0000-0000-0000-cf1032810006';
update public.event_competition_entries set status = 'pending' where id = '00000000-0000-0000-0000-cf1032810007';
select pg_temp.chk('H6 waitlisted -> scratched and pending -> withdrawn through the RPC still work (one audit row each)',
  pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032810006', 'scratched', 'w', 'retain')$q$) = 'OK'
  and pg_temp.try_as('authenticated', $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-cf1032810007', 'withdrawn', 'p', 'not_applicable')$q$) = 'OK'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810006') = 'scratched'
  and (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-cf1032810007') = 'withdrawn'
  and (select count(*) from public.event_competition_entry_changes where entry_id in ('00000000-0000-0000-0000-cf1032810006', '00000000-0000-0000-0000-cf1032810007') and change_type in ('scratch', 'withdraw')) = 2);

-- G. heat entry / entry consistency and downstream classes -----------------------------------------------------------------------------------------
select pg_temp.chk('G1 no fixture entry is scratched/withdrawn while one of its heat entries is still scheduled/checked_in',
  not exists (select 1 from public.event_competition_entries e join public.event_competition_heat_entries h on h.entry_id = e.id
              where e.id::text like '00000000-0000-0000-0000-cf1032%' and e.status in ('scratched', 'withdrawn') and h.status in ('scheduled', 'checked_in')));
select pg_temp.chk('G2 refused direct writes left the R2 class and the ballot heat set exactly as before (matrix rows)',
  not exists (select 1 from t_m where as_role in ('authenticated', 'service_role', 'cf1032_probe') and class_after is distinct from class_before));
select pg_temp.chk('G3 other triggers on the entries table are still present and enabled (audit, updated_at, registration links) alongside the guard',
  (select count(*) from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and not tgisinternal and tgname in ('audit_competition_entry_change', 'set_event_competition_updated_at', 'validate_competition_entry_registration_links', 'cf1_s6_guard_entry_status') and tgenabled <> 'D') = 4);

select * from t_m order by target, as_role;
select name, ok, left(detail, 200) from t_results where not ok;
do $$
declare v_fail text; v_n integer;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_n, v_fail from t_results;
  if v_fail is null then raise exception 'COMPETITION S6 ENTRY STATUS GUARD SQL SUITE PASS (% checks)', v_n;
  else raise exception 'COMPETITION S6 ENTRY STATUS GUARD SQL SUITE FAIL: %', v_fail; end if;
end $$;
rollback;
