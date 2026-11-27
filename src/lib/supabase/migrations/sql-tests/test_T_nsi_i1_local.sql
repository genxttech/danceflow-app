-- NSI I1 foundation -- FULL functional and negative-test suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY) for migrations
-- 20261118090000 .. 20261118094000.
--
-- Staff identities need public.profiles rows, which reference auth.users, so this suite creates synthetic auth users
-- (inside its transaction). Approved V1 baseline item 8 forbids synthetic auth users on shared DEV, therefore this file
-- REFUSES to run unless the session sets: nsi.test_local = 'on'  (only on a disposable local stack).
-- REQUIRED: nsi.appointments_fp = the pre-migration appointments fingerprint (query in test_T_nsi_i1_foundation.sql).
-- The DEV-safe subset (catalog, privileges, dark gate) is test_T_nsi_i1_foundation.sql.
--
-- One transaction, synthetic fixtures only (UUID block a51xxxxx-....). The final block ALWAYS raises, so nothing
-- persists: "NSI I1 SUITE PASS (<n> checks)" or "NSI I1 SUITE FAIL: <failures>".
-- Section 3 [gate-open] replaces public.intake_platform_policy() inside this rolled-back transaction with test
-- retention values so personal-data paths can be exercised; the shipped (dark) policy is checked first.
--
-- Helpers: run_as returns exactly 'ok' or '<SQLSTATE> <message>'; val_as returns the first value or 'ERR <SQLSTATE> ...'.
-- expect_ok accepts only 'ok' (run_as); expect_val accepts only a non-NULL value that is not an 'ERR ' result (val_as).

begin;

do $$ begin
  if coalesce(current_setting('nsi.test_local', true), '') <> 'on' then
    raise exception 'NSI I1 local suite refused: set nsi.test_local = ''on'' only on a disposable local stack (never shared DEV/PROD)';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role, intake_destructive;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role, intake_destructive;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

-- Run p_sql as p_role (with JWT sub p_user when given); returns 'ok' or 'SQLSTATE message'.
create or replace function pg_temp.run_as(p_role text, p_user uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    v := 'ok';
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- Same, returning the first column of the first row (or 'ERR <SQLSTATE> <message>').
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql into v;
  exception when others then
    v := 'ERR ' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_result text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, p_result is not distinct from 'ok', coalesce(p_result, 'null'));
end $$;

create or replace function pg_temp.expect_val(p_name text, p_result text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, p_result is not null and p_result not like 'ERR %', coalesce(p_result, 'null'));
end $$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.setkv(p_k text, p_v text) returns void language sql as $$
  insert into t_kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;

-- Owner direct SQL (postgres): returns 'ok' or 'SQLSTATE message'.
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; return 'ok';
  exception when others then return sqlstate || ' ' || sqlerrm; end;
end $$;

-- Catalog drift probe: applies p_sql, runs assert_catalog, and always rolls the change back.
create or replace function pg_temp.drift_probe(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute p_sql;
    perform intake_private.assert_catalog();
    raise exception 'nsi_probe_rollback';
  exception when others then
    v := case when sqlerrm = 'nsi_probe_rollback' then 'self-check did not fail' else sqlstate || ' ' || sqlerrm end;
  end;
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fixed ids
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.setkv('studio_a', 'a5100000-0000-0000-0000-00000000000a');
select pg_temp.setkv('studio_b', 'a5100000-0000-0000-0000-00000000000b');
select pg_temp.setkv('studio_c', 'a5100000-0000-0000-0000-00000000000c');
select pg_temp.setkv('studio_d', 'a5100000-0000-0000-0000-00000000000d');
select pg_temp.setkv('client_a1', 'a5100000-0000-0000-0000-0000000000a1');
select pg_temp.setkv('client_a2', 'a5100000-0000-0000-0000-0000000000a2');
select pg_temp.setkv('client_a3', 'a5100000-0000-0000-0000-0000000000a3');
select pg_temp.setkv('client_b1', 'a5100000-0000-0000-0000-0000000000b1');
select pg_temp.setkv('owner_a', 'a5100000-0000-0000-0000-000000000101');
select pg_temp.setkv('admin_a', 'a5100000-0000-0000-0000-000000000102');
select pg_temp.setkv('fd_a', 'a5100000-0000-0000-0000-000000000103');
select pg_temp.setkv('instr_a', 'a5100000-0000-0000-0000-000000000104');
select pg_temp.setkv('indep_a', 'a5100000-0000-0000-0000-000000000105');
select pg_temp.setkv('clientrole_a', 'a5100000-0000-0000-0000-000000000106');
select pg_temp.setkv('org_a', 'a5100000-0000-0000-0000-000000000107');
select pg_temp.setkv('inactive_a', 'a5100000-0000-0000-0000-000000000108');
select pg_temp.setkv('owner_b', 'a5100000-0000-0000-0000-000000000201');
select pg_temp.setkv('guardian_user', 'a5100000-0000-0000-0000-000000000301');
select pg_temp.setkv('guardian2_user', 'a5100000-0000-0000-0000-000000000302');
select pg_temp.setkv('padmin', 'a5100000-0000-0000-0000-000000000401');
select pg_temp.setkv('appt_future', 'a5100000-0000-0000-0000-000000000501');
select pg_temp.setkv('appt_far', 'a5100000-0000-0000-0000-000000000502');
select pg_temp.setkv('appt_cancelled', 'a5100000-0000-0000-0000-000000000503');
select pg_temp.setkv('appt_a3', 'a5100000-0000-0000-0000-000000000504');
select pg_temp.setkv('appt_b1', 'a5100000-0000-0000-0000-000000000505');
select pg_temp.setkv('link_guardian', 'a5100000-0000-0000-0000-000000000601');
select pg_temp.setkv('link_self', 'a5100000-0000-0000-0000-000000000602');
select pg_temp.setkv('link_g_a1', 'a5100000-0000-0000-0000-000000000603');
select pg_temp.setkv('link_g_a2', 'a5100000-0000-0000-0000-000000000604');

-- ---------------------------------------------------------------------------------------------------------------
-- Section 1: catalog, privileges, hot table
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('C01 catalog self-check passes', pg_temp.try('select intake_private.assert_catalog()') = 'ok',
  pg_temp.try('select intake_private.assert_catalog()'));
select pg_temp.chk('C02 exactly 19 intake tables (18 + M7 grants), all with RLS',
  (select count(*) = 19 and bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r'));
select pg_temp.chk(format('C03 %s has no privilege on %s', r, c.relname),
  not (has_table_privilege(r, c.oid, 'SELECT') or has_table_privilege(r, c.oid, 'INSERT') or has_table_privilege(r, c.oid, 'UPDATE')
       or has_table_privilege(r, c.oid, 'DELETE') or has_table_privilege(r, c.oid, 'TRUNCATE') or has_table_privilege(r, c.oid, 'MAINTAIN')))
from pg_class c, unnest(array['anon', 'service_role']) r
where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r';
select pg_temp.chk(format('C04 authenticated privilege on %s matches matrix', c.relname),
  case when c.relname in ('intake_templates', 'intake_template_versions', 'intake_service_assignments', 'intake_studio_retention_choices', 'intake_settings')
       then has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'INSERT')
            and not has_table_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
       else not (has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
                 or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE')) end)
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r';
select pg_temp.chk('C05a no NSI function executable by anon',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
                and has_function_privilege('anon', p.oid, 'EXECUTE')));
select pg_temp.chk('C05b service_role executes exactly the service surface',
  (select array_agg(distinct p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
     and has_function_privilege('service_role', p.oid, 'EXECUTE'))
  = array['intake_ensure_request', 'intake_platform_policy', 'intake_reconcile_preview', 'intake_reconcile_status', 'intake_save_draft', 'intake_submit_response']::name[]);
select pg_temp.chk('C05c no intake_private function executable by authenticated or service_role',
  not exists (select 1 from pg_proc p where p.pronamespace = 'intake_private'::regnamespace
              and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))));
select pg_temp.chk('C05d erase implementation owned by intake_destructive, executable by postgres only among callers',
  (select pg_get_userbyid(p.proowner) = 'intake_destructive' and has_function_privilege('postgres', p.oid, 'EXECUTE')
          and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
   from pg_proc p where p.oid = 'intake_private.erase_client_impl(uuid,uuid,uuid,text,boolean,text)'::regprocedure));
select pg_temp.chk('C05e every NSI function pins search_path',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
                and (p.proconfig is null or not ('search_path=pg_catalog, pg_temp' = any (p.proconfig)))));
select pg_temp.chk('C06 intake_private: USAGE for intake_destructive only (no CREATE after M5); no CREATE on public',
  not has_schema_privilege('anon', 'intake_private', 'USAGE') and not has_schema_privilege('authenticated', 'intake_private', 'USAGE')
  and not has_schema_privilege('service_role', 'intake_private', 'USAGE') and has_schema_privilege('intake_destructive', 'intake_private', 'USAGE')
  and not has_schema_privilege('intake_destructive', 'intake_private', 'CREATE')
  and not has_schema_privilege('intake_destructive', 'public', 'CREATE'));
select pg_temp.chk('C07 no intake trigger, FK or index on appointments',
  not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.appointments'::regclass
              and (p.pronamespace = 'intake_private'::regnamespace or p.proname like 'intake\_%'))
  and not exists (select 1 from pg_constraint c where c.confrelid = 'public.appointments'::regclass and c.conrelid::regclass::text like '%intake\_%')
  and not exists (select 1 from pg_indexes where tablename = 'appointments' and indexname like '%intake%'));
select pg_temp.chk('C07b appointments fingerprint equals the mandatory pre-migration baseline',
  nullif(current_setting('nsi.appointments_fp', true), '') is not null
  and current_setting('nsi.appointments_fp', true) = (select md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass))),
  'supplied=' || coalesce(nullif(current_setting('nsi.appointments_fp', true), ''), '<missing>'));
select pg_temp.chk('C08 restricted role attributes; postgres SET-only (never INHERIT); no other member',
  exists (select 1 from pg_roles where rolname = 'intake_destructive' and not rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreaterole)
  and exists (select 1 from pg_auth_members where roleid = 'intake_destructive'::regrole and member = 'postgres'::regrole and set_option and not inherit_option)
  and not exists (select 1 from pg_auth_members where roleid = 'intake_destructive'::regrole and (member <> 'postgres'::regrole or inherit_option)));
-- C09 / D01-D16: injected drift is detected by assert_catalog (each probe is rolled back)
select pg_temp.setkv('c09', pg_temp.drift_probe('create table public.intake_zz_regression_probe (id int)'));
select pg_temp.chk('C09 new intake table with Supabase default grants is detected', pg_temp.kv('c09') like '42501%intake_zz_regression_probe%', pg_temp.kv('c09'));
select pg_temp.setkv('d01', pg_temp.drift_probe('grant select (answers) on public.intake_responses to authenticated'));
select pg_temp.chk('D01 column-level grant detected', pg_temp.kv('d01') like '42501%column%', pg_temp.kv('d01'));
select pg_temp.setkv('d02', pg_temp.drift_probe('create policy zz_leak on public.intake_settings for select to authenticated using (true)'));
select pg_temp.chk('D02 injected RLS policy detected', pg_temp.kv('d02') like '42501%policy drift%zz_leak%', pg_temp.kv('d02'));
select pg_temp.setkv('d03', pg_temp.drift_probe('alter table public.intake_responses disable trigger intake_responses_90_delete'));
select pg_temp.chk('D03 disabled guard trigger detected', pg_temp.kv('d03') like '42501%intake_responses_90_delete%not enabled%', pg_temp.kv('d03'));
select pg_temp.setkv('d04', pg_temp.drift_probe('drop trigger intake_completions_30_guard on public.intake_completions'));
select pg_temp.chk('D04 dropped guard trigger detected', pg_temp.kv('d04') like '42501%trigger drift%intake_completions_30_guard%', pg_temp.kv('d04'));
select pg_temp.setkv('d05', pg_temp.drift_probe('grant maintain on public.intake_settings to service_role'));
select pg_temp.chk('D05 PG17 MAINTAIN grant detected', pg_temp.kv('d05') like '42501%intake_settings%MAINTAIN%', pg_temp.kv('d05'));
select pg_temp.setkv('d06', pg_temp.drift_probe('revoke execute on function public.intake_save_draft(uuid, uuid, text, jsonb, jsonb, int) from service_role'));
select pg_temp.chk('D06 missing grant detected', pg_temp.kv('d06') like '42501%intake_save_draft%', pg_temp.kv('d06'));
select pg_temp.setkv('d07', pg_temp.drift_probe('grant intake_destructive to postgres with inherit true'));
select pg_temp.chk('D07 INHERIT membership of postgres detected', pg_temp.kv('d07') like '42501%INHERIT membership%', pg_temp.kv('d07'));
select pg_temp.setkv('d07b', pg_temp.drift_probe('grant intake_destructive to authenticated'));
select pg_temp.chk('D07b extra member of the restricted role detected', pg_temp.kv('d07b') like '42501%unexpected or INHERIT membership%', pg_temp.kv('d07b'));
select pg_temp.setkv('d08', pg_temp.drift_probe('grant create on schema intake_private to intake_destructive'));
select pg_temp.chk('D08 schema CREATE for the restricted role detected', pg_temp.kv('d08') like '42501%intake_private privileges%CREATE%', pg_temp.kv('d08'));
select pg_temp.setkv('d09', pg_temp.drift_probe('alter default privileges in schema intake_private grant execute on functions to service_role'));
select pg_temp.chk('D09 default ACL on intake_private detected', pg_temp.kv('d09') like '42501%default privileges%', pg_temp.kv('d09'));
select pg_temp.setkv('d10', pg_temp.drift_probe('create sequence public.intake_zz_seq'));
select pg_temp.chk('D10 unexpected sequence detected', pg_temp.kv('d10') like '42501%unexpected relation public.intake_zz_seq%', pg_temp.kv('d10'));
select pg_temp.setkv('d11', pg_temp.drift_probe('create function intake_private.is_held(p int) returns boolean language sql set search_path = pg_catalog, pg_temp as ''select true'''));
select pg_temp.chk('D11 function overload detected', pg_temp.kv('d11') like '42501%is_held has 2 overloads%', pg_temp.kv('d11'));
select pg_temp.setkv('d12', pg_temp.drift_probe('alter table public.intake_requests disable row level security'));
select pg_temp.chk('D12 RLS disabled detected', pg_temp.kv('d12') like '42501%intake_requests has RLS disabled%', pg_temp.kv('d12'));
select pg_temp.setkv('d13', pg_temp.drift_probe('alter function intake_private.lock_client(uuid, uuid) security definer'));
select pg_temp.chk('D13 SECURITY DEFINER drift detected', pg_temp.kv('d13') like '42501%lock_client SECURITY DEFINER%', pg_temp.kv('d13'));
select pg_temp.setkv('d14', pg_temp.drift_probe('grant execute on function intake_private.assert_staff(uuid, text) to public'));
select pg_temp.chk('D14 PUBLIC execute grant detected', pg_temp.kv('d14') like '42501%assert_staff executable by {PUBLIC}%', pg_temp.kv('d14'));
select pg_temp.setkv('d15', pg_temp.drift_probe('drop function public.intake_drift_report(uuid)'));
select pg_temp.chk('D15 partial migration detected', pg_temp.kv('d15') like '42501%M5 is partially deployed%', pg_temp.kv('d15'));
select pg_temp.setkv('d16', pg_temp.drift_probe('set local session_replication_role = replica'));
select pg_temp.chk('D16 replica session (guard triggers off) detected', pg_temp.kv('d16') like '42501%session_replication_role%', pg_temp.kv('d16'));
select pg_temp.setkv('d17', pg_temp.drift_probe('grant select on public.intake_responses to intake_destructive; grant update on public.intake_responses to intake_destructive'));
select pg_temp.chk('D17 extra restricted-role table privilege detected', pg_temp.kv('d17') like '42501%intake_responses%UPDATE%', pg_temp.kv('d17'));
select pg_temp.setkv('d19', pg_temp.drift_probe('drop trigger intake_requests_10_gate on public.intake_requests; create trigger intake_requests_10_gate before insert on public.intake_requests for each row execute function intake_private.collection_gate(''continuing'')'));
select pg_temp.chk('D19 collection-gate trigger re-created with another argument (Gate B skipped) detected',
  pg_temp.kv('d19') like '42501%trigger drift%intake_requests_10_gate%', pg_temp.kv('d19'));
select pg_temp.setkv('d20', pg_temp.drift_probe('drop trigger intake_requests_10_gate on public.intake_requests; create trigger intake_requests_10_gate before update on public.intake_requests for each row execute function intake_private.collection_gate(''new_obligation'')'));
select pg_temp.chk('D20 collection-gate trigger re-created with another event (UPDATE instead of INSERT) detected',
  pg_temp.kv('d20') like '42501%trigger drift%intake_requests_10_gate%', pg_temp.kv('d20'));
select pg_temp.setkv('d21', pg_temp.drift_probe('drop trigger intake_requests_10_gate on public.intake_requests; create trigger intake_requests_10_gate before insert on public.intake_requests for each row when (new.source = ''auto'') execute function intake_private.collection_gate(''new_obligation'')'));
select pg_temp.chk('D21 collection-gate trigger re-created with a WHEN condition detected',
  pg_temp.kv('d21') like '42501%trigger drift%intake_requests_10_gate%', pg_temp.kv('d21'));
select pg_temp.setkv('d22', pg_temp.drift_probe('drop trigger intake_responses_90_delete on public.intake_responses; create trigger intake_responses_90_delete after delete on public.intake_responses for each row execute function intake_private.delete_guard()'));
select pg_temp.chk('D22 delete guard re-created with another timing (AFTER instead of BEFORE) detected',
  pg_temp.kv('d22') like '42501%trigger drift%intake_responses_90_delete%', pg_temp.kv('d22'));
select pg_temp.chk('D18 catalog clean again after probes', pg_temp.try('select intake_private.assert_catalog()') = 'ok', pg_temp.try('select intake_private.assert_catalog()'));

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures (synthetic; local only). Staff identities need auth.users + profiles rows (user_studio_roles -> profiles).
-- ---------------------------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@nsi-test.invalid', now(), now()
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'indep_a', 'clientrole_a', 'org_a', 'inactive_a', 'owner_b', 'padmin',
                  'guardian_user', 'guardian2_user']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k = 'padmin' then 'platform_admin' end
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'indep_a', 'clientrole_a', 'org_a', 'inactive_a', 'owner_b', 'padmin']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug) values
  (pg_temp.kv('studio_a')::uuid, 'NSI Test Studio A', 'nsi-test-studio-a-a51'),
  (pg_temp.kv('studio_b')::uuid, 'NSI Test Studio B', 'nsi-test-studio-b-a51'),
  (pg_temp.kv('studio_c')::uuid, 'NSI Test Studio C', 'nsi-test-studio-c-a51'),
  (pg_temp.kv('studio_d')::uuid, 'NSI Test Studio D', 'nsi-test-studio-d-a51');
insert into public.clients (id, studio_id, first_name, last_name) values
  (pg_temp.kv('client_a1')::uuid, pg_temp.kv('studio_a')::uuid, 'Synthetic', 'A1'),
  (pg_temp.kv('client_a2')::uuid, pg_temp.kv('studio_a')::uuid, 'Synthetic', 'A2'),
  (pg_temp.kv('client_a3')::uuid, pg_temp.kv('studio_a')::uuid, 'Synthetic', 'A3'),
  (pg_temp.kv('client_b1')::uuid, pg_temp.kv('studio_b')::uuid, 'Synthetic', 'B1');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.kv('owner_a')::uuid, pg_temp.kv('studio_a')::uuid, 'studio_owner', true),
  (pg_temp.kv('admin_a')::uuid, pg_temp.kv('studio_a')::uuid, 'studio_admin', true),
  (pg_temp.kv('fd_a')::uuid, pg_temp.kv('studio_a')::uuid, 'front_desk', true),
  (pg_temp.kv('instr_a')::uuid, pg_temp.kv('studio_a')::uuid, 'instructor', true),
  (pg_temp.kv('indep_a')::uuid, pg_temp.kv('studio_a')::uuid, 'independent_instructor', true),
  (pg_temp.kv('clientrole_a')::uuid, pg_temp.kv('studio_a')::uuid, 'client', true),
  (pg_temp.kv('org_a')::uuid, pg_temp.kv('studio_a')::uuid, 'organizer_owner', true),
  (pg_temp.kv('inactive_a')::uuid, pg_temp.kv('studio_a')::uuid, 'studio_owner', false),
  (pg_temp.kv('owner_b')::uuid, pg_temp.kv('studio_b')::uuid, 'studio_owner', true);
insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at) values
  (pg_temp.kv('appt_future')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a1')::uuid, 'private_lesson', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour'),
  (pg_temp.kv('appt_far')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a2')::uuid, 'private_lesson', 'scheduled', now() + interval '250 days', now() + interval '250 days 1 hour'),
  (pg_temp.kv('appt_cancelled')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a1')::uuid, 'private_lesson', 'cancelled', now() + interval '5 days', now() + interval '5 days 1 hour'),
  (pg_temp.kv('appt_a3')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a3')::uuid, 'private_lesson', 'scheduled', now() + interval '12 days', now() + interval '12 days 1 hour'),
  (pg_temp.kv('appt_b1')::uuid, pg_temp.kv('studio_b')::uuid, pg_temp.kv('client_b1')::uuid, 'private_lesson', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, initiated_by) values
  (pg_temp.kv('link_guardian')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a2')::uuid, null, 'invited', 'guardian', 'studio'),
  (pg_temp.kv('link_self')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a2')::uuid, null, 'unclaimed', 'self', 'dancer'),
  (pg_temp.kv('link_g_a1')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a1')::uuid, pg_temp.kv('guardian_user')::uuid, 'linked', 'guardian', 'studio'),
  (pg_temp.kv('link_g_a2')::uuid, pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a2')::uuid, pg_temp.kv('guardian2_user')::uuid, 'linked', 'parent', 'studio');

-- M7: pilot grants (both capabilities) for the two configured studios, issued by the synthetic platform admin
insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at)
select pg_temp.kv(st)::uuid, c, 'regression fixture', pg_temp.kv('padmin')::uuid, now() + interval '30 days'
from unnest(array['studio_a', 'studio_b']) st, unnest(array['config_preview', 'live_collection']) c;

-- Studio deletion / offboarding (R8; deviations 4 and 5)
insert into public.intake_templates (id, studio_id, name) values ('a5100000-0000-0000-0000-000000000c01', pg_temp.kv('studio_c')::uuid, 'C');
insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
values (pg_temp.kv('studio_c')::uuid, 'a5100000-0000-0000-0000-000000000c01', 1, 'published', '{"sections":[]}', 'x', 10, now());
insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema)
values (pg_temp.kv('studio_c')::uuid, 'a5100000-0000-0000-0000-000000000c01', 2, 'draft', '{"sections":[]}');
insert into public.intake_service_assignments (studio_id, appointment_type, template_id)
values (pg_temp.kv('studio_c')::uuid, 'private_lesson', 'a5100000-0000-0000-0000-000000000c01');
insert into public.intake_studio_retention_choices (id, studio_id, version, post_relationship_days, platform_policy_version, created_by)
values ('a5100000-0000-0000-0000-000000000c02', pg_temp.kv('studio_c')::uuid, 1, 30, 1, pg_temp.kv('owner_a')::uuid);
insert into public.intake_settings (studio_id, default_template_id, active_retention_choice_id)
values (pg_temp.kv('studio_c')::uuid, 'a5100000-0000-0000-0000-000000000c01', 'a5100000-0000-0000-0000-000000000c02');
select pg_temp.chk('S01 standalone delete of a published version is refused while its studio exists',
  pg_temp.try(format('delete from public.intake_template_versions where studio_id = %L and status = ''published''', pg_temp.kv('studio_c'))) like '42501%');
-- (RPC / statement results are captured with setkv first: subqueries in the same expression may run before it)
select pg_temp.setkv('s02', pg_temp.try(format('delete from public.studios where id = %L', pg_temp.kv('studio_c'))));
select pg_temp.chk('S02 deleting a studio with configuration cascades through the config guards',
  pg_temp.kv('s02') = 'ok'
  and not exists (select 1 from public.intake_templates where studio_id = pg_temp.kv('studio_c')::uuid)
  and not exists (select 1 from public.intake_template_versions where studio_id = pg_temp.kv('studio_c')::uuid)
  and not exists (select 1 from public.intake_settings where studio_id = pg_temp.kv('studio_c')::uuid)
  and not exists (select 1 from public.intake_studio_retention_choices where studio_id = pg_temp.kv('studio_c')::uuid),
  pg_temp.kv('s02'));
select intake_private.audit_write(pg_temp.kv('studio_d')::uuid, 'settings_updated', 'staff', null, 'studio_owner', null, null, null, null, null, '{}'::jsonb, 'operational');
select pg_temp.chk('S03 a studio with retained audit records is not deleted silently (offboarding procedure, I6)',
  pg_temp.try(format('delete from public.studios where id = %L', pg_temp.kv('studio_d'))) like '23503%intake_audit_events%');

-- Template (staff RPCs; config is not gated)
select pg_temp.setkv('schema', $j${"sections":[
  {"key":"goals","title":"Goals","audience":"student","fields":[
    {"key":"dance_goals","type":"long_text","label":"Your goals","required":true,"visibility":"instructor_visible","subject_scope":"about_student"},
    {"key":"experience","type":"single_choice","label":"Experience","required":false,"visibility":"front_desk","subject_scope":"about_student",
     "options":[{"key":"none","label":"None"},{"key":"some","label":"Some"}]},
    {"key":"private_note","type":"short_text","label":"Note for the owner","required":false,"visibility":"staff_only","subject_scope":"about_student"}]},
  {"key":"consent","title":"Guardian consent","audience":"guardian","fields":[
    {"key":"guardian_ack","type":"acknowledgment","label":"I consent","required":true,"visibility":"staff_only","subject_scope":"consent"}]}]}$j$);

select pg_temp.chk('A01a front desk cannot configure templates',
  pg_temp.run_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select public.intake_save_template_draft(%L, null, %L, %L::jsonb)', pg_temp.kv('studio_a'), 'T', pg_temp.kv('schema'))) like '42501%');
select pg_temp.chk(format('A01b %s cannot configure templates', who),
  pg_temp.run_as('authenticated', pg_temp.kv(who)::uuid, format('select public.intake_save_template_draft(%L, null, %L, %L::jsonb)', pg_temp.kv('studio_a'), 'T', pg_temp.kv('schema'))) like '42501%')
from unnest(array['instr_a', 'indep_a', 'clientrole_a', 'org_a', 'inactive_a', 'owner_b']) who;
select pg_temp.setkv('draft_v1', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid,
  format('select public.intake_save_template_draft(%L, null, %L, %L::jsonb)', pg_temp.kv('studio_a'), 'Intake', pg_temp.kv('schema'))));
select pg_temp.chk('A01c owner saves a template draft', pg_temp.kv('draft_v1') ~ '^[0-9a-f-]{36}$', pg_temp.kv('draft_v1'));
select pg_temp.setkv('template', (select template_id::text from public.intake_template_versions where id = pg_temp.kv('draft_v1')::uuid));
select pg_temp.chk('A01d owner publishes version 1',
  pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_publish_template_version(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('draft_v1'))) = '1');
select pg_temp.chk('T01 published version is immutable (owner direct update)',
  pg_temp.try(format('update public.intake_template_versions set schema = ''{"sections":[]}'' where id = %L', pg_temp.kv('draft_v1'))) like '42501%published%');
select pg_temp.chk('T02 published version cannot be deleted while its studio exists',
  pg_temp.try(format('delete from public.intake_template_versions where id = %L', pg_temp.kv('draft_v1'))) like '42501%');
select pg_temp.chk('T03 TRUNCATE of template versions refused by the truncate guard',
  pg_temp.try('truncate public.intake_template_versions cascade') like '42501%TRUNCATE%', pg_temp.try('truncate public.intake_template_versions cascade'));
select pg_temp.chk('T04 schema over the field limit refused',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_save_template_draft(%L, null, %L, %L::jsonb)', pg_temp.kv('studio_a'), 'Big',
    (select jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('key','s','title','s','audience','student','fields',
       (select jsonb_agg(jsonb_build_object('key','f'||g,'type','short_text','label','L','visibility','staff_only','subject_scope','about_student')) from generate_series(1, 201) g)))))::text)) like '22023%');
select pg_temp.chk('T05 worst-case answer size over 262144 bytes refused',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_save_template_draft(%L, null, %L, %L::jsonb)', pg_temp.kv('studio_a'), 'Big2',
    (select jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('key','s','title','s','audience','student','fields',
       (select jsonb_agg(jsonb_build_object('key','f'||g,'type','long_text','label','L','visibility','staff_only','subject_scope','about_student')) from generate_series(1, 14) g)))))::text)) like '22023%262144%');
select pg_temp.chk('T06 re-intake floor cannot point at a non-required version',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_set_reintake_floor(%L, %L, 1)', pg_temp.kv('studio_a'), pg_temp.kv('template'))) like '22023%');
select pg_temp.expect_ok('A01e owner assigns the template to private lessons',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_set_service_assignment(%L, %L, %L)', pg_temp.kv('studio_a'), 'private_lesson', pg_temp.kv('template'))));
select pg_temp.chk('A03a studio admin cannot change permission flags',
  pg_temp.run_as('authenticated', pg_temp.kv('admin_a')::uuid, format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"front_desk_guardian_selection":true}')) like '42501%');
select pg_temp.expect_ok('A03b owner enables intake (settings)',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"enabled":true}')));
select pg_temp.chk('A03c config readable by studio staff only (RLS)',
  pg_temp.val_as('authenticated', pg_temp.kv('fd_a')::uuid, 'select count(*) from public.intake_templates')::int >= 1
  and pg_temp.val_as('authenticated', pg_temp.kv('owner_b')::uuid, 'select count(*) from public.intake_templates')::int = 0
  and pg_temp.val_as('authenticated', pg_temp.kv('clientrole_a')::uuid, 'select count(*) from public.intake_templates')::int = 0);

-- ---------------------------------------------------------------------------------------------------------------
-- Section 2: dark gate (shipped policy) -- every personal-data writer refuses; nothing blocks a dark rollback
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('G01 shipped platform policy keeps Gate A closed', not intake_private.retention_gate_open());
select pg_temp.chk('G02 service ensure_request refused while dark',
  pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))) like '%retention_policy_incomplete%');
select pg_temp.chk('G03 direct owner insert into intake_requests refused by the gate trigger',
  pg_temp.try(format('insert into public.intake_requests (studio_id, client_id, template_id, source) values (%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('template'), 'manual')) like '%retention_policy_incomplete%');
select pg_temp.chk('G07a studio cannot set a retention choice before the platform maximum is approved',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_set_retention_choice(%L, 30)', pg_temp.kv('studio_a'))) like '42501%platform%');
select pg_temp.chk('G07b enabling the studio does not open Gate A', not intake_private.retention_gate_open());
select pg_temp.chk('G08 no environment marker exists while dark',
  not exists (select 1 from public.intake_audit_events where retention_class = 'environment_marker'));
select pg_temp.chk('G09 configuration audit events are written while dark',
  exists (select 1 from public.intake_audit_events where studio_id = pg_temp.kv('studio_a')::uuid and event_type = 'template_version_published'));
select pg_temp.chk('G10 legal hold refused while dark when no intake records exist for the subject',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_create_legal_hold(%L, %L, %L, %L, %L, now() + interval ''30 days'')',
    pg_temp.kv('studio_a'), 'client', pg_temp.kv('client_a1'), 'synthetic', 'synthetic')) like '22023%not applicable%');
select pg_temp.expect_ok('G11a owner runs the read-only drift report while dark',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select * from public.intake_drift_report(%L)', pg_temp.kv('studio_a'))));
select pg_temp.chk('G11b drift report is audited as a reference-free operational event',
  exists (select 1 from public.intake_audit_events where studio_id = pg_temp.kv('studio_a')::uuid and event_type = 'drift_report_run'
          and retention_class = 'operational' and client_ref is null and request_ref is null and hold_ref is null));
select pg_temp.chk('G11c dark rollback stays eligible (no blocking audit event, no hold, no personal row)',
  not exists (select 1 from public.intake_audit_events where retention_class <> 'operational'
              or request_ref is not null or client_ref is not null or hold_ref is not null)
  and not exists (select 1 from public.intake_legal_holds) and not exists (select 1 from public.intake_requests));
select pg_temp.setkv('g12', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select count(*) from public.intake_get_status(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_b1'))));
select pg_temp.chk('G12 status read for a client with no intake records returns nothing and writes no security event',
  pg_temp.kv('g12') = '0'
  and not exists (select 1 from public.intake_audit_events where event_type = 'tenant_drift_detected'));
-- P2-B: an erasure attempt while dark, for a client with no intake records, writes nothing and never poisons rollback
select pg_temp.setkv('g13a', pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)',
    pg_temp.kv('studio_a'), 'a5100000-0000-0000-0000-0000000000ff', 'data_subject_request')));
select pg_temp.chk('G13a erasure of an unknown client (no intake records) refused, and no governance record is written',
  pg_temp.kv('g13a') like '22023%unknown client%'
  and not exists (select 1 from public.intake_audit_events where client_ref = 'a5100000-0000-0000-0000-0000000000ff'), pg_temp.kv('g13a'));
select pg_temp.setkv('g13f', pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(null, %L, %L)',
    pg_temp.kv('client_a1'), 'data_subject_request')));
select pg_temp.setkv('g13g', pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)',
    'a5100000-0000-0000-0000-0000000000ee', pg_temp.kv('client_a1'), 'data_subject_request')));
select pg_temp.chk('G13f erasure with a NULL studio refused before any write',
  pg_temp.kv('g13f') like '22023%unknown studio%' and not exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid), pg_temp.kv('g13f'));
select pg_temp.chk('G13g erasure with a nonexistent studio refused before any write',
  pg_temp.kv('g13g') like '22023%unknown studio%' and not exists (select 1 from public.intake_audit_events where studio_id = 'a5100000-0000-0000-0000-0000000000ee'), pg_temp.kv('g13g'));
select pg_temp.chk('G13b erasure case reference: free text refused',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request', 'the parent phoned on Tuesday')) like '22023%case reference%');
select pg_temp.chk(format('G13b-%s erasure case reference %s refused', n, d),
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request', v)) like '22023%case reference%')
from (values (1, 'lowercase (sup-1001)', 'sup-1001'), (2, 'name-like (Jane.Doe)', 'Jane.Doe'), (3, 'e-mail-like', 'JANE-1@X'),
             (4, '65 characters', repeat('A', 61) || '-123'), (5, 'too many digits', 'SUP-1234567890123'), (6, 'single-letter prefix', 'S-1'),
             (7, 'empty string', '')) t(n, d, v);
select pg_temp.setkv('g13c', pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)::text',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request', 'SUP-1001')));
select pg_temp.chk('G13c dark erasure with no intake records returns outcome no_records and writes nothing',
  pg_temp.kv('g13c') like '%"outcome": "no_records"%' and pg_temp.kv('g13c') like '%"erased": false%'
  and not exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid)
  and not exists (select 1 from public.intake_audit_events where retention_class = 'environment_marker')
  and not intake_private.erasure_barrier_active(pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a1')::uuid), pg_temp.kv('g13c'));
select pg_temp.chk('G13h barrier release with a malformed case reference refused',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error', 'ticket 77')) like '22023%case reference%');
-- N2: the strict pattern also governs barrier release (case_ref is validated before the barrier check, so an accepted
-- reference reaches "no active erasure barrier" and a refused one stops at "case reference")
select pg_temp.chk('G13i barrier release accepts a valid maximum-length ticket reference (23 characters)',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error', 'ABCDEFGHIJ-123456789012')) like '22023%no active erasure barrier%');
select pg_temp.chk('G13j barrier release refuses a lowercase reference',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error', 'sup-77')) like '22023%case reference%');
select pg_temp.chk('G13k barrier release refuses a prefix longer than ten letters',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error', 'ABCDEFGHIJK-1')) like '22023%case reference%');
select pg_temp.chk('G13l erasure refuses a prefix longer than ten letters',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request', 'ABCDEFGHIJK-1')) like '22023%case reference%');
select pg_temp.chk('G13d dark barrier release without a barrier is refused and writes nothing',
  pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error')) like '22023%no active erasure barrier%'
  and not exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid));
select pg_temp.chk('G13e after the dark erasure attempts the rollback is still eligible (same predicate as the rollback guard)',
  not exists (select 1 from public.intake_audit_events where retention_class <> 'operational'
              or request_ref is not null or client_ref is not null or hold_ref is not null)
  and not exists (select 1 from public.intake_legal_holds) and not exists (select 1 from public.intake_requests));

-- ---------------------------------------------------------------------------------------------------------------
-- Section 3 [gate-open]: replace the platform policy inside this transaction to exercise personal-data paths
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;
select pg_temp.chk('O00 test policy opens Gate A', intake_private.retention_gate_open());

-- Gate B
select pg_temp.expect_ok('O01a owner disables intake', pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid,
  format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"enabled":false}')));
select pg_temp.chk('O01b Gate B refuses new obligations when the studio is disabled',
  pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))) like '%new_obligation_not_allowed%');
select pg_temp.expect_ok('O01c owner re-enables intake', pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid,
  format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"enabled":true}')));
select pg_temp.setkv('req1', pg_temp.val_as('service_role', null,
  format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))));
select pg_temp.chk('O02a ensure_request creates the obligation', pg_temp.kv('req1') ~ '^[0-9a-f-]{36}$', pg_temp.kv('req1'));
select pg_temp.chk('O02b second ensure_request returns the same open obligation',
  pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))) = pg_temp.kv('req1'));
select pg_temp.chk('M01a first personal insert writes exactly one studio-less environment marker',
  (select count(*) = 1 and bool_and(studio_id is null) from public.intake_audit_events where retention_class = 'environment_marker'));
select pg_temp.chk('M01b environment marker cannot be deleted (owner)',
  pg_temp.try('delete from public.intake_audit_events where retention_class = ''environment_marker''') like '42501%permanent%');
select pg_temp.chk('M01c audit events are append-only (owner update)',
  pg_temp.try('update public.intake_audit_events set metadata = ''{}'' where retention_class <> ''environment_marker''') like '42501%append-only%');
select pg_temp.chk('O03 cross-tenant client refused',
  pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_b1'), pg_temp.kv('appt_b1'))) like '42501%');
select pg_temp.chk('O04a cancelled appointment refused',
  pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_cancelled'))) like '22023%');
select pg_temp.setkv('o04b', pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_b1'))));
select pg_temp.chk('O04b another studio''s appointment refused', pg_temp.kv('o04b') like '22023%', pg_temp.kv('o04b'));
select pg_temp.chk('O17a request client is immutable',
  pg_temp.try(format('update public.intake_requests set client_id = %L where id = %L', pg_temp.kv('client_a2'), pg_temp.kv('req1'))) like '42501%immutable%');
select pg_temp.chk('O17b request studio is immutable',
  pg_temp.try(format('update public.intake_requests set studio_id = %L where id = %L', pg_temp.kv('studio_b'), pg_temp.kv('req1'))) like '42501%');
select pg_temp.chk('O05a draft save refused before the version is pinned (issued)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"dance_goals":"x"}')) like '22023%not open%');
select pg_temp.setkv('draft_v2', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid,
  format('select public.intake_save_template_draft(%L, %L, null, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('template'), pg_temp.kv('schema'))));
select pg_temp.chk('O05b pin to a draft version refused',
  pg_temp.try(format('update public.intake_requests set pinned_version_id = %L where id = %L', pg_temp.kv('draft_v2'), pg_temp.kv('req1'))) like '42501%published%');
-- issue (I3 will do this through invitations): pin version 1 and mark invited
update public.intake_requests set pinned_version_id = pg_temp.kv('draft_v1')::uuid, status = 'invited', issued_at = now() where id = pg_temp.kv('req1')::uuid;
select pg_temp.chk('O05c pinned version is immutable once set',
  pg_temp.try(format('update public.intake_requests set pinned_version_id = null where id = %L', pg_temp.kv('req1'))) like '42501%pinned%');
select pg_temp.chk('R05 caller-supplied respondent assurance is refused (P1-2)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1","assurance":"link_verified"}', '{"dance_goals":"x"}')) like '22023%derived%');
select pg_temp.chk('R05b caller-supplied respondent account is refused (P1-2)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', json_build_object('display_name', 'Synthetic A1', 'auth_user_id', pg_temp.kv('guardian_user'))::text, '{"dance_goals":"x"}')) like '22023%derived%');
select pg_temp.chk('O06a unknown answer key refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"nope":"x"}')) like '22023%unknown%');
select pg_temp.chk('O06b over-long short text refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', jsonb_build_object('private_note', repeat('x', 501))::text)) like '22023%500%');
select pg_temp.chk('O06c undefined option refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"experience":"lots"}')) like '22023%option%');
select pg_temp.chk('O06d guardian field rejected in the student audience',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"guardian_ack":true}')) like '22023%unknown%');
select pg_temp.chk('P22a first draft save with a NULL expected revision refused (P2-2)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, null)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"dance_goals":"x"}')) like '40001%revision_conflict%');
select pg_temp.chk('O07a first draft save succeeds (revision 1)',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"display_name":"Synthetic A1"}', '{"dance_goals":"waltz","experience":"some","private_note":"n"}')) = '1');
select pg_temp.chk('R06a respondent without a verified link is declared_unverified with no account',
  (select assurance = 'declared_unverified' and auth_user_id is null from public.intake_respondents where request_id = pg_temp.kv('req1')::uuid and role = 'student'));
select pg_temp.chk('P22b draft save with a NULL expected revision refused on an existing draft (P2-2)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, null)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"dance_goals":"tango"}')) like '40001%revision_conflict%');
select pg_temp.chk('O07b stale revision refused (compare-and-set)',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"dance_goals":"tango"}')) like '40001%revision_conflict%');
select pg_temp.chk('O07c current revision accepted (revision 2)',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"dance_goals":"waltz and tango","experience":"some","private_note":"n"}')) = '2');
select pg_temp.chk('O08 draft retention follows the approved rule (anchor + 90 days, within the protected window)',
  (select draft_purge_after = least(draft_anchor_at + interval '90 days', greatest(draft_max_at, coalesce(draft_protected_until, draft_max_at)))
          and draft_protected_appointment_id = pg_temp.kv('appt_future')::uuid and draft_max_at is not null
   from public.intake_requests where id = pg_temp.kv('req1')::uuid));
select pg_temp.chk('O06f stored answers are a JSON object of at most 262144 bytes (constraint)',
  pg_temp.try(format('update public.intake_responses set answers = ''[1,2]''::jsonb where request_id = %L', pg_temp.kv('req1'))) like '23514%');
select pg_temp.chk('O18a owner cannot delete live personal rows',
  pg_temp.try(format('delete from public.intake_responses where request_id = %L', pg_temp.kv('req1'))) like '42501%protected change%');
select pg_temp.chk('O18b service_role cannot delete live personal rows',
  pg_temp.run_as('service_role', null, format('delete from public.intake_responses where request_id = %L', pg_temp.kv('req1'))) like '42501%');
select pg_temp.chk('O19 TRUNCATE of live personal tables refused', pg_temp.try('truncate public.intake_requests cascade') like '42501%TRUNCATE%');
select pg_temp.setkv('o10a1', pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 2)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'student', '{"experience":"some"}')));
select pg_temp.chk('O10a submit refused while a required answer is missing',
  pg_temp.kv('o10a1') = 'ok'
  and pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 3)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student')) like '22023%required%',
  pg_temp.kv('o10a1'));
select pg_temp.expect_ok('O10b restore required answer', pg_temp.run_as('service_role', null,
  format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 3)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student', '{"dance_goals":"waltz","experience":"some","private_note":"n"}')));
select pg_temp.chk('P22c submit with a NULL expected revision refused (P2-2)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, null)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student')) like '40001%revision_conflict%');
select pg_temp.chk('P24a student submit refused while no minor determination exists (P2-4: no silent adult default)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 4)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student')) like '22023%minor_determination_required%');
-- I3 records the declared / birthday determination; here owner SQL stands in for it
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
values (pg_temp.kv('studio_a')::uuid, pg_temp.kv('req1')::uuid, false, 'declared', current_date, 18);
select pg_temp.setkv('o10c', pg_temp.val_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 4)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student')));
select pg_temp.chk('O10c submit creates exactly one completion and returns complete',
  pg_temp.kv('o10c') = 'complete'
  and (select count(*) = 1 from public.intake_completions where request_id = pg_temp.kv('req1')::uuid)
  and (select status = 'submitted' from public.intake_requests where id = pg_temp.kv('req1')::uuid), pg_temp.kv('o10c'));
select pg_temp.setkv('completion_json', (select to_jsonb(c)::text from public.intake_completions c where request_id = pg_temp.kv('req1')::uuid));
select pg_temp.chk('O11 completion rows are immutable (owner update)',
  pg_temp.try(format('update public.intake_completions set completed_at = now() where request_id = %L', pg_temp.kv('req1'))) like '42501%immutable%');
select pg_temp.chk('O12a submitted answers immutable (owner update hits the guard)',
  pg_temp.try(format('update public.intake_responses set answers = ''{"dance_goals":"changed"}'' where request_id = %L', pg_temp.kv('req1'))) like '42501%submitted responses%');
select pg_temp.chk('O12b restricted role has no UPDATE privilege on live answers in I1 (redaction arrives in I6)',
  not has_table_privilege('intake_destructive', 'public.intake_responses', 'UPDATE')
  and not has_table_privilege('intake_destructive', 'public.intake_completions', 'UPDATE')
  and pg_temp.run_as('intake_destructive', null, format('update public.intake_responses set answers = ''{"dance_goals":"changed"}'' where request_id = %L', pg_temp.kv('req1'))) like '42501%permission denied%');
select pg_temp.chk('O12c draft save after submission refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 4)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'student', '{"dance_goals":"x"}')) like '22023%');
-- (the RPC runs in its own statement first, so the count below observes any row it wrote)
select pg_temp.setkv('o13a', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))));
select pg_temp.chk('O13a valid completion is reused: ensure_request returns the completed request, no new obligation',
  pg_temp.kv('o13a') = pg_temp.kv('req1')
  and (select count(*) = 1 from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid),
  pg_temp.kv('o13a') || ' requests=' || (select count(*) from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid));

-- Authorization on answers
select pg_temp.chk('A02a owner sees all answer fields',
  pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select string_agg(field_key, '','' order by field_key) from public.intake_get_answers(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1')))
  = 'dance_goals,experience,private_note');
select pg_temp.chk('A02b front desk sees only front_desk / instructor_visible fields',
  pg_temp.val_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select string_agg(field_key, '','' order by field_key) from public.intake_get_answers(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1')))
  = 'dance_goals,experience');
select pg_temp.chk(format('A02c %s cannot read answers', who),
  pg_temp.run_as('authenticated', pg_temp.kv(who)::uuid, format('select * from public.intake_get_answers(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'))) like '42501%')
from unnest(array['instr_a', 'indep_a', 'clientrole_a', 'org_a', 'inactive_a', 'owner_b']) who;
select pg_temp.chk('A02d answer reads are audited', exists (select 1 from public.intake_audit_events where request_ref = pg_temp.kv('req1')::uuid and event_type = 'staff_viewed_answers'));

-- P1-1: minor-status override is owner/admin only, with a mandatory reason; front desk cannot waive guardian consent
select pg_temp.chk('P11a front desk cannot override a minor determination',
  pg_temp.run_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select public.intake_record_minor_determination(%L, %L, true, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'synthetic correction')) like '42501%');
select pg_temp.chk(format('P11b %s cannot override a minor determination', who),
  pg_temp.run_as('authenticated', pg_temp.kv(who)::uuid, format('select public.intake_record_minor_determination(%L, %L, true, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'r')) like '42501%')
from unnest(array['instr_a', 'indep_a', 'clientrole_a', 'org_a', 'inactive_a', 'owner_b', 'padmin']) who;
select pg_temp.chk('P11c an override needs a non-blank reason (RPC)',
  pg_temp.run_as('authenticated', pg_temp.kv('admin_a')::uuid, format('select public.intake_record_minor_determination(%L, %L, true, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), '   ')) like '22023%reason%');
select pg_temp.chk('P11d an override needs a non-blank reason (table constraint)',
  pg_temp.try(format('insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold, actor_user_id, reason) values (%L, %L, true, %L, current_date, 18, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'staff_override', pg_temp.kv('admin_a'), '  ')) like '23514%override_reason%');
select pg_temp.expect_ok('P11e studio admin records a minor determination after completion, with a reason',
  pg_temp.run_as('authenticated', pg_temp.kv('admin_a')::uuid, format('select public.intake_record_minor_determination(%L, %L, true, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'synthetic correction')));
select pg_temp.chk('O13c fulfillment becomes guardian_consent_outstanding', intake_private.fulfillment_state(pg_temp.kv('req1')::uuid) = 'guardian_consent_outstanding');
select pg_temp.chk('O13d completion row unchanged',
  (select to_jsonb(c)::text from public.intake_completions c where request_id = pg_temp.kv('req1')::uuid) = pg_temp.kv('completion_json'));
select pg_temp.setkv('o13e', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))));
select pg_temp.chk('O13e outstanding consent is an existing obligation (no new request)',
  pg_temp.kv('o13e') = pg_temp.kv('req1')
  and (select count(*) = 1 from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid),
  pg_temp.kv('o13e') || ' requests=' || (select count(*) from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid));
select pg_temp.chk('O13f student cannot add another response to the submitted request',
  pg_temp.try(format('insert into public.intake_responses (studio_id, request_id, client_id, audience, template_version_id) values (%L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'student', pg_temp.kv('draft_v1'))) like '42501%already submitted%');
select pg_temp.chk('O13g guardian draft (no verified link) joins the submitted request while consent is outstanding',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'guardian', '{"display_name":"Synthetic Guardian","declared_relationship":"parent"}', '{"guardian_ack":true}')) = '1');
select pg_temp.chk('P23a guardian submit below the studio minimum assurance refused (declared_unverified)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"I consent (synthetic)"}')) like '42501%below the studio minimum%');
-- Recipient selection (success path) replaces the unverified guardian draft with the verified link
select pg_temp.setkv('a08a', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_select_guardian_recipient(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('link_g_a1'))));
select pg_temp.chk('A08a owner selects a verified guardian recipient before guardian submission',
  pg_temp.kv('a08a') = '1'
  and (select status = 'superseded' from public.intake_responses where request_id = pg_temp.kv('req1')::uuid and audience = 'guardian')
  and (select superseded_at is not null from public.intake_respondents where request_id = pg_temp.kv('req1')::uuid and role = 'guardian'), pg_temp.kv('a08a'));
select pg_temp.chk('P12a guardian draft from anyone but the selected recipient refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'guardian', '{"display_name":"Someone Else","declared_relationship":"parent"}', '{"guardian_ack":true}')) like '42501%selected guardian recipient%');
select pg_temp.chk('O13h guardian draft through the verified link',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req1'),
    'guardian', json_build_object('display_name', 'Synthetic Guardian', 'declared_relationship', 'parent', 'source_link_id', pg_temp.kv('link_g_a1'))::text, '{"guardian_ack":true}')) = '1');
select pg_temp.chk('R06b assurance derived from the verified link (link_verified) and bound to the link''s account',
  (select assurance = 'link_verified' and auth_user_id = pg_temp.kv('guardian_user')::uuid and source_link_id = pg_temp.kv('link_g_a1')::uuid
   from public.intake_respondents where request_id = pg_temp.kv('req1')::uuid and role = 'guardian' and superseded_at is null));
select pg_temp.chk('P23b guardian submit without consent evidence refused (P2-3)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian')) like '22023%consent evidence%');
-- P2-A: a guardian decline is refused before anything is written; the draft stays open for a later acknowledgment
select pg_temp.chk('P2A-a guardian decline is refused (only acknowledged consent completes a guardian response)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"I do not consent (synthetic)","event_type":"declined"}')) like '22023%guardian_consent_not_affirmative%');
select pg_temp.chk('P2A-b withdrawn consent is refused too',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"withdrawn (synthetic)","event_type":"withdrawn"}')) like '22023%guardian_consent_not_affirmative%');
select pg_temp.chk('P2A-c after the decline nothing is stuck: guardian response is still a draft, no evidence, consent still outstanding',
  (select status = 'draft' from public.intake_responses where request_id = pg_temp.kv('req1')::uuid and audience = 'guardian' and status <> 'superseded')
  and not exists (select 1 from public.intake_consent_evidence where request_ref = pg_temp.kv('req1')::uuid)
  and intake_private.fulfillment_state(pg_temp.kv('req1')::uuid) = 'guardian_consent_outstanding');
select pg_temp.chk('P2A-d contradictory guardian consent (acknowledged + outcome rejected) refused',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"I consent (synthetic)","event_type":"acknowledged","outcome":"rejected"}')) like '22023%contradictory_consent%');
select pg_temp.chk('P2A-e contradictory consent with a missing event type (defaults to acknowledged) refused',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"I consent (synthetic)","outcome":"declined"}')) like '22023%contradictory_consent%');
select pg_temp.chk('P2A-f after the contradictory attempts nothing was written (draft, no evidence)',
  (select status = 'draft' from public.intake_responses where request_id = pg_temp.kv('req1')::uuid and audience = 'guardian' and status <> 'superseded')
  and not exists (select 1 from public.intake_consent_evidence where request_ref = pg_temp.kv('req1')::uuid));
select pg_temp.chk('O14a guardian submit with consent evidence (after the decline) completes fulfillment',
  pg_temp.val_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1, %L::jsonb)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), 'guardian',
    '{"consent_text":"I consent (synthetic)","identity":{"subject_display_name":"Synthetic A1"}}')) = 'complete');
select pg_temp.chk('O14b evidence pins the required assurance, the respondent assurance and approved retention',
  (select required_assurance = 'email_code_verified' and assurance = 'link_verified' and retain_until = acknowledged_at + interval '3650 days' and platform_policy_version = 999
   from public.intake_consent_evidence where request_ref = pg_temp.kv('req1')::uuid));
select pg_temp.chk('O14c identity retention equals the approved period and not beyond the core',
  (select i.retain_until = e.acknowledged_at + interval '365 days' and i.retain_until <= e.retain_until
   from public.intake_consent_evidence_identity i join public.intake_consent_evidence e on e.id = i.evidence_id where e.request_ref = pg_temp.kv('req1')::uuid));
update public.intake_settings set min_guardian_assurance = 'link_verified' where studio_id = pg_temp.kv('studio_a')::uuid;
select pg_temp.chk('O14d raising the studio minimum later does not reopen accepted consent (N5)',
  intake_private.fulfillment_state(pg_temp.kv('req1')::uuid) = 'complete');
update public.intake_settings set min_guardian_assurance = 'email_code_verified' where studio_id = pg_temp.kv('studio_a')::uuid;
select pg_temp.chk('O14e completion still unchanged after guardian consent',
  (select to_jsonb(c)::text from public.intake_completions c where request_id = pg_temp.kv('req1')::uuid) = pg_temp.kv('completion_json'));
select pg_temp.chk('O15a evidence is append-only (owner update)',
  pg_temp.try(format('update public.intake_consent_evidence set outcome = ''x'' where request_ref = %L', pg_temp.kv('req1'))) like '42501%append-only%');
select pg_temp.chk('O15b TRUNCATE of evidence refused', pg_temp.try('truncate public.intake_consent_evidence cascade') like '42501%TRUNCATE%');
select pg_temp.chk('O16a evidence with a mismatched client reference refused',
  pg_temp.try(format($q$insert into public.intake_consent_evidence (studio_id, request_ref, client_ref, respondent_role, assurance, required_assurance,
      event_type, consent_text, consent_text_sha256, template_version_ref, template_schema_sha256, outcome, actor_type, retention_basis, retain_until,
      platform_policy_version, acknowledged_at)
    values (%L, %L, %L, 'student', 'email_code_verified', 'email_code_verified', 'acknowledged', 'x', encode(extensions.digest('x','sha256'),'hex'),
      %L, 'h', 'accepted', 'student', 'evidentiary', now() + interval '3650 days', 999, now())$q$,
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a2'), pg_temp.kv('draft_v1'))) like '42501%');
select pg_temp.chk('O16b evidence retention not equal to the approved period refused',
  pg_temp.try(format($q$insert into public.intake_consent_evidence (studio_id, request_ref, client_ref, respondent_role, assurance, required_assurance,
      event_type, consent_text, consent_text_sha256, template_version_ref, template_schema_sha256, outcome, actor_type, retention_basis, retain_until,
      platform_policy_version, acknowledged_at)
    values (%L, %L, %L, 'student', 'email_code_verified', 'email_code_verified', 'acknowledged', 'x', encode(extensions.digest('x','sha256'),'hex'),
      %L, 'h', 'accepted', 'student', 'evidentiary', now() + interval '99999 days', 999, now())$q$,
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), pg_temp.kv('draft_v1'))) like '22023%');
select pg_temp.chk('O16c evidence text hash must match the text',
  pg_temp.try(format($q$insert into public.intake_consent_evidence (studio_id, request_ref, client_ref, respondent_role, assurance, required_assurance,
      event_type, consent_text, consent_text_sha256, template_version_ref, template_schema_sha256, outcome, actor_type, retention_basis, retain_until,
      platform_policy_version, acknowledged_at)
    values (%L, %L, %L, 'student', 'email_code_verified', 'email_code_verified', 'acknowledged', 'x', repeat('0', 64),
      %L, 'h', 'accepted', 'student', 'evidentiary', now() + interval '3650 days', 999, now())$q$,
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), pg_temp.kv('draft_v1'))) like '23514%');

-- P1-2 table-level backstop: assurance can never be asserted without authoritative rows
select pg_temp.chk('R01 link_verified respondent without a link refused (table guard)',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) values (%L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'link_verified')) like '42501%verified guardian link%');
select pg_temp.chk('R02 email_code_verified respondent refused until verification records exist (I3)',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) values (%L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'email_code_verified')) like '42501%verification record%');
select pg_temp.chk('R03 staff_attested respondent refused on every I1 path',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) values (%L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'staff_attested')) like '42501%verification record%');
select pg_temp.chk('R04 an account cannot be attached without a verified link',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance, auth_user_id) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'declared_unverified', pg_temp.kv('guardian_user'))) like '42501%verified link%');
select pg_temp.chk('R07 link_verified with another client''s verified link refused',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance, source_link_id, auth_user_id) values (%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'link_verified', pg_temp.kv('link_g_a2'), pg_temp.kv('guardian2_user'))) like '42501%');
select pg_temp.chk('R08 link_verified bound to a different account refused',
  pg_temp.try(format('insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, declared_relationship, assurance, source_link_id, auth_user_id) values (%L, %L, %L, %L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('client_a1'), 'guardian', 'X', 'parent', 'link_verified', pg_temp.kv('link_g_a1'), pg_temp.kv('guardian2_user'))) like '42501%account%');

-- Far-future protection (approved 90/180/90 rule)
select pg_temp.setkv('req2', pg_temp.val_as('service_role', null,
  format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'), pg_temp.kv('appt_far'))));
update public.intake_requests set pinned_version_id = pg_temp.kv('draft_v1')::uuid, status = 'invited', issued_at = now() where id = pg_temp.kv('req2')::uuid;
select pg_temp.expect_ok('O09a draft save for a lesson 250 days away', pg_temp.run_as('service_role', null,
  format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req2'), 'student', '{"display_name":"Synthetic A2"}', '{"dance_goals":"x"}')));
select pg_temp.chk('O09b protected through the lesson''s own 90-day window, beyond the 180-day maximum',
  (select draft_purge_after > draft_max_at and draft_purge_after = draft_protected_until
          and draft_protected_until > now() + interval '339 days' from public.intake_requests where id = pg_temp.kv('req2')::uuid));
select pg_temp.chk('A04a studio admin cannot extend draft retention without the owner flag',
  pg_temp.run_as('authenticated', pg_temp.kv('admin_a')::uuid, format('select public.intake_extend_draft_retention(%L, %L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('appt_far'), 'r')) like '42501%');
select pg_temp.setkv('a04b', pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_extend_draft_retention(%L, %L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('appt_far'), 'synthetic reason')));
select pg_temp.chk('A04b owner extension is audited and increments the count',
  pg_temp.kv('a04b') = 'ok'
  and (select draft_extension_count = 1 and draft_last_extension_by = pg_temp.kv('owner_a')::uuid from public.intake_requests where id = pg_temp.kv('req2')::uuid)
  and exists (select 1 from public.intake_audit_events where request_ref = pg_temp.kv('req2')::uuid and event_type = 'draft_retention_extended'), pg_temp.kv('a04b'));
select pg_temp.chk('O09c extension count cannot decrease',
  pg_temp.try(format('update public.intake_requests set draft_extension_count = 0 where id = %L', pg_temp.kv('req2'))) like '42501%');

-- P2-10 reference coherence at the table level
select pg_temp.chk('P10a completion citing another request''s response refused',
  pg_temp.try(format('insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id) values (%L, %L, %L, %L, %L, 1, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('client_a2'), pg_temp.kv('template'), pg_temp.kv('draft_v1'),
    (select id::text from public.intake_responses where request_id = pg_temp.kv('req1')::uuid and audience = 'student'))) like '42501%submitted responses of this request%');
select pg_temp.chk('P10b completion with a version other than the pinned one refused',
  pg_temp.try(format('insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id) values (%L, %L, %L, %L, %L, 2, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('client_a2'), pg_temp.kv('template'), pg_temp.kv('draft_v1'),
    (select id::text from public.intake_responses where request_id = pg_temp.kv('req2')::uuid and audience = 'student'))) like '42501%pinned version%');
select pg_temp.chk('P10c response citing another request''s respondent refused',
  pg_temp.try(format('insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id) values (%L, %L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('client_a2'), 'guardian',
    (select id::text from public.intake_respondents where request_id = pg_temp.kv('req1')::uuid and role = 'guardian' and superseded_at is null), pg_temp.kv('draft_v1'))) like '42501%respondent does not belong%');
select pg_temp.chk('P10d request inserted with a draft (unpublished) pinned version refused',
  pg_temp.try(format('insert into public.intake_requests (studio_id, client_id, template_id, source, pinned_version_id) values (%L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('client_a3'), pg_temp.kv('template'), 'manual', pg_temp.kv('draft_v2'))) like '42501%published version%');

-- Guardian designation and recipient selection
select pg_temp.chk('A05a unverified (not linked) guardian link cannot be designated',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_designate_guardian(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'), pg_temp.kv('link_guardian'))) like '42501%verified%');
select pg_temp.chk('A05b self / dancer-initiated link cannot be designated',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_designate_guardian(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'), pg_temp.kv('link_self'))) like '42501%');
select pg_temp.setkv('a05c', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_designate_guardian(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'), pg_temp.kv('link_g_a2'))));
select pg_temp.chk('A05c owner designates a verified guardian link (success path)',
  pg_temp.kv('a05c') ~ '^[0-9a-f-]{36}$'
  and exists (select 1 from public.intake_guardian_designations where client_id = pg_temp.kv('client_a2')::uuid and link_id = pg_temp.kv('link_g_a2')::uuid and superseded_at is null),
  pg_temp.kv('a05c'));
select pg_temp.chk('A03d front desk cannot select a guardian recipient while the studio flag is off',
  pg_temp.run_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select public.intake_select_guardian_recipient(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('link_g_a2'))) like '42501%');
select pg_temp.expect_ok('A03e owner turns on front-desk guardian selection',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"front_desk_guardian_selection":true}')));
select pg_temp.chk('A03f front desk selects a verified recipient once the owner enabled it',
  pg_temp.val_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select public.intake_select_guardian_recipient(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req2'), pg_temp.kv('link_g_a2'))) = '1');
select pg_temp.chk('A06 recipient selection refused after guardian consent was submitted (owner)',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_select_guardian_recipient(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('link_g_a1'))) like '22023%already submitted%');
select pg_temp.chk('A06b front desk with the flag on still cannot override submitted guardian consent',
  pg_temp.run_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select public.intake_select_guardian_recipient(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'), pg_temp.kv('link_g_a1'))) like '22023%already submitted%');

-- Tenant drift (F10 / P2-1)
select pg_temp.chk('A07a drift report is staff-only (front desk denied)',
  pg_temp.run_as('authenticated', pg_temp.kv('fd_a')::uuid, format('select * from public.intake_drift_report(%L)', pg_temp.kv('studio_a'))) like '42501%');
update public.clients set studio_id = pg_temp.kv('studio_b')::uuid where id = pg_temp.kv('client_a2')::uuid;
select pg_temp.setkv('a07b', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select count(*) from public.intake_get_status(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'))));
select pg_temp.chk('A07b status read after the client moved studios returns no data and persists a security event',
  pg_temp.kv('a07b') = '0'
  and exists (select 1 from public.intake_audit_events where event_type = 'tenant_drift_detected' and client_ref = pg_temp.kv('client_a2')::uuid
              and retention_class = 'security' and actor_user_id = pg_temp.kv('owner_a')::uuid), pg_temp.kv('a07b'));
select pg_temp.setkv('a07c', pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select count(*) from public.intake_get_answers(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req2'))));
select pg_temp.chk('A07c answer read on a drifted request returns no data and persists a security event',
  pg_temp.kv('a07c') = '0'
  and exists (select 1 from public.intake_audit_events where event_type = 'tenant_drift_detected' and request_ref = pg_temp.kv('req2')::uuid),
  pg_temp.kv('a07c'));
select pg_temp.chk('A07d write path on a drifted client refused with a generic error',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_designate_guardian(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a2'), pg_temp.kv('link_g_a2'))) like '42501%unavailable%');
select pg_temp.chk('A07e drift report lists the drifted request',
  pg_temp.val_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select count(*) from public.intake_drift_report(%L) where object_id = %L', pg_temp.kv('studio_a'), pg_temp.kv('req2')))::int = 1);
update public.clients set studio_id = pg_temp.kv('studio_a')::uuid where id = pg_temp.kv('client_a2')::uuid;

-- P1-3: closed or suspended requests accept no submission
select pg_temp.setkv('req3', pg_temp.val_as('service_role', null,
  format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a3'), pg_temp.kv('appt_a3'))));
update public.intake_requests set pinned_version_id = pg_temp.kv('draft_v1')::uuid, status = 'invited', issued_at = now() where id = pg_temp.kv('req3')::uuid;
select pg_temp.expect_val('P13a student draft on an issued request', pg_temp.val_as('service_role', null,
  format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req3'), 'student', '{"display_name":"Synthetic A3"}', '{"dance_goals":"x"}')));
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
values (pg_temp.kv('studio_a')::uuid, pg_temp.kv('req3')::uuid, false, 'declared', current_date, 18);
update public.intake_requests set status = 'cancelled_by_staff' where id = pg_temp.kv('req3')::uuid;
select pg_temp.chk('P13b submit on a cancelled request refused (P1-3)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req3'), 'student')) like '22023%not open%');
select pg_temp.chk('P13c no completion and the draft remains a draft on the cancelled request',
  not exists (select 1 from public.intake_completions where request_id = pg_temp.kv('req3')::uuid)
  and (select status = 'draft' from public.intake_responses where request_id = pg_temp.kv('req3')::uuid));
select pg_temp.chk('P13d direct promotion of a draft on a cancelled request refused (table guard)',
  pg_temp.try(format('update public.intake_responses set status = ''submitted'', submitted_at = now() where request_id = %L', pg_temp.kv('req3'))) like '42501%not open%');
select pg_temp.setkv('req4', pg_temp.val_as('service_role', null,
  format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a3'), pg_temp.kv('appt_a3'))));
update public.intake_requests set pinned_version_id = pg_temp.kv('draft_v1')::uuid, status = 'invited', issued_at = now() where id = pg_temp.kv('req4')::uuid;
select pg_temp.expect_val('P13e student draft on the new request', pg_temp.val_as('service_role', null,
  format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req4'), 'student', '{"display_name":"Synthetic A3"}', '{"dance_goals":"x"}')));
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
values (pg_temp.kv('studio_a')::uuid, pg_temp.kv('req4')::uuid, false, 'declared', current_date, 18);
update public.intake_requests set status = 'suspended', resume_status = 'in_progress', suspended_at = now() where id = pg_temp.kv('req4')::uuid;
select pg_temp.chk('P13f submit on a suspended request refused (P1-3)',
  pg_temp.run_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req4'), 'student')) like '22023%not open%');
select pg_temp.chk('P13g draft save on a suspended request refused',
  pg_temp.run_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, null, %L::jsonb, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req4'), 'student', '{"dance_goals":"y"}')) like '22023%not open%');
select pg_temp.chk('P13h new response on a suspended request refused (table guard)',
  pg_temp.try(format('insert into public.intake_responses (studio_id, request_id, client_id, audience, template_version_id) values (%L, %L, %L, %L, %L)',
    pg_temp.kv('studio_a'), pg_temp.kv('req4'), pg_temp.kv('client_a3'), 'guardian', pg_temp.kv('draft_v1'))) like '42501%not open%');
update public.intake_requests set status = 'in_progress', resume_status = null where id = pg_temp.kv('req4')::uuid;
select pg_temp.chk('P13i after resumption the same draft can be submitted (feature-flag independent)',
  pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"enabled":false}')) = 'ok'
  and pg_temp.val_as('service_role', null, format('select public.intake_submit_response(%L, %L, %L, 1)', pg_temp.kv('studio_a'), pg_temp.kv('req4'), 'student')) = 'complete'
  and pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_update_settings(%L, %L::jsonb)', pg_temp.kv('studio_a'), '{"enabled":true}')) = 'ok');

-- Holds (owner-level fixture) and hold eligibility
insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, review_due_at, created_by)
values (pg_temp.kv('studio_a')::uuid, 'client', pg_temp.kv('client_a1')::uuid, pg_temp.kv('client_a1')::uuid, 'synthetic', 'synthetic',
        now() + interval '30 days', pg_temp.kv('owner_a')::uuid);
select pg_temp.chk('O18c restricted role cannot delete rows of a client under an active hold',
  pg_temp.run_as('intake_destructive', null, format('delete from public.intake_request_appointments where request_id = %L', pg_temp.kv('req1'))) like '42501%hold%');
select pg_temp.chk('H01 legal hold facts are immutable',
  pg_temp.try(format('update public.intake_legal_holds set scope_ref = %L where client_ref = %L', pg_temp.kv('client_a2'), pg_temp.kv('client_a1'))) like '42501%');
select pg_temp.chk('H02 legal holds cannot be deleted',
  pg_temp.try(format('delete from public.intake_legal_holds where client_ref = %L', pg_temp.kv('client_a1'))) like '42501%');
do $$
declare v text;
begin
  begin
    -- the collection gate closes again after records exist: holds over those records must stay possible
    create or replace function public.intake_platform_policy()
    returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
      post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
      audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
    language sql stable set search_path = pg_catalog, pg_temp
    as $f$ select 1, 90, 180, 90, null::int, null::int, null::int, null::int, null::int, null::int, null::text $f$;
    v := pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_create_legal_hold(%L, %L, %L, %L, %L, now() + interval ''30 days'')',
      pg_temp.kv('studio_a'), 'client', pg_temp.kv('client_a2'), 'synthetic', 'synthetic'));
    raise exception 'nsi_probe_rollback';
  exception when others then
    if sqlerrm <> 'nsi_probe_rollback' then v := 'unexpected ' || sqlstate || ' ' || sqlerrm; end if;
  end;
  perform pg_temp.chk('H03 with the gate closed again, a hold over existing intake records is still allowed', v ~ '^[0-9a-f-]{36}$', v);
end $$;
select pg_temp.chk('H04 gate restored to the test policy after the probe', intake_private.retention_gate_open());
-- P2-B regression: with the gate closed again, a client WITH intake records is genuinely erased (never "no_records"),
-- and a held client is still refused. Both run inside rolled-back probes.
do $$
declare v_er text; v_held text; v_rows int;
begin
  begin
    create or replace function public.intake_platform_policy()
    returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
      post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
      audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
    language sql stable set search_path = pg_catalog, pg_temp
    as $f$ select 1, 90, 180, 90, null::int, null::int, null::int, null::int, null::int, null::int, null::text $f$;
    v_er := pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)::text',
      pg_temp.kv('studio_a'), pg_temp.kv('client_a3'), 'data_subject_request', 'SUP-3003'));
    select count(*) into v_rows from public.intake_requests where client_id = pg_temp.kv('client_a3')::uuid;
    v_held := pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)::text',
      pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request'));
    raise exception 'nsi_probe_rollback';
  exception when others then
    if sqlerrm <> 'nsi_probe_rollback' then v_er := 'unexpected ' || sqlstate || ' ' || sqlerrm; end if;
  end;
  perform pg_temp.chk('H05 dark erasure of a client with existing intake records erases them (not no_records)',
    v_er like '%"outcome": "erased"%' and v_er like '%"requests": 2%' and v_rows = 0, coalesce(v_er, 'null') || ' remaining=' || coalesce(v_rows::text, 'null'));
  perform pg_temp.chk('H06 dark erasure of a held client with records is refused (legal hold), not no_records',
    v_held like '%"outcome": "refused"%', coalesce(v_held, 'null'));
end $$;
select pg_temp.chk('H07 the dark-erasure probes left no trace (client_a3 records and audit unchanged)',
  (select count(*) = 2 from public.intake_requests where client_id = pg_temp.kv('client_a3')::uuid)
  and not exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a3')::uuid and event_type = 'erasure_record'));

-- ---------------------------------------------------------------------------------------------------------------
-- Section 4 [local-only]: platform-admin operator paths (needs auth.users + profiles rows)
-- ---------------------------------------------------------------------------------------------------------------
do $local$
declare
  v text;
  v_hold uuid;
begin
  -- platform admin: no answer access (V1 baseline 1)
  perform pg_temp.chk('L01 platform admin cannot read answers',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select * from public.intake_get_answers(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('req1'))) like '42501%');
  perform pg_temp.chk('L02 platform admin can view status',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select * from public.intake_get_status(%L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'))) = 'ok');
  perform pg_temp.chk('L03 owner (non platform admin) cannot erase',
    pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_erase_client(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request')) like '42501%');
  -- Catalog check instead of a live denial probe: on the local Postgres 17.6 Docker image, a live "permission denied
  -- for function" on a SECURITY DEFINER function under a switched role segfaults the backend (documented in
  -- test_T_h2c1_claim_invitation_authority.sql). The hosted rehearsal proved the live denial through PostgREST.
  perform pg_temp.chk('L04 service_role and anon cannot execute erasure or barrier release (catalog)',
    not has_function_privilege('service_role', 'public.intake_erase_client(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.intake_erase_client(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.intake_release_erasure_barrier(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'intake_private.erase_client_impl(uuid,uuid,uuid,text,boolean,text)', 'EXECUTE'));
  v := pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)::text', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request'));
  perform pg_temp.chk('L05 erasure under a hold is refused (result) and the refusal event persists (P2-1)',
    v like '%"refused": "legal_hold"%' and v like '%"outcome": "refused"%'
    and exists (select 1 from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid)
    and exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid and event_type = 'erasure_refused_hold'
                and actor_user_id = pg_temp.kv('padmin')::uuid and metadata ->> 'reason_code' = 'data_subject_request'), v);
  select id into v_hold from public.intake_legal_holds where client_ref = pg_temp.kv('client_a1')::uuid and released_at is null;
  perform pg_temp.chk('L06 owner cannot release a legal hold',
    pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_release_legal_hold(%L, %L, %L)', pg_temp.kv('studio_a'), v_hold, 'r')) like '42501%');
  v := pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_legal_hold(%L, %L, %L)', pg_temp.kv('studio_a'), v_hold, 'synthetic'));
  perform pg_temp.chk('L07 platform admin releases the hold (record retention scheduled from the approved period)',
    v = 'ok' and (select record_state = 'released_scheduled' and released_by = pg_temp.kv('padmin')::uuid from public.intake_legal_holds where id = v_hold), v);
  perform pg_temp.chk('L08a erasure requires a reason code (blank refused)',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), ' ')) like '22023%reason code%');
  perform pg_temp.chk('L08b erasure takes a reason code, never free text',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'because the parent called')) like '22023%reason code%');
  v := pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_erase_client(%L, %L, %L, %L)::text', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'data_subject_request', 'SUP-2042'));
  perform pg_temp.chk('L09 lawful erasure of existing records still works (completions first, all live rows removed, outcome erased)',
    v like '%"completions": 1%' and v like '%"requests": 1%' and v like '%"outcome": "erased"%'
    and not exists (select 1 from public.intake_requests where client_id = pg_temp.kv('client_a1')::uuid)
    and not exists (select 1 from public.intake_responses where client_id = pg_temp.kv('client_a1')::uuid), v);
  perform pg_temp.chk('L10 retained evidence survives erasure (soft references)',
    exists (select 1 from public.intake_consent_evidence where client_ref = pg_temp.kv('client_a1')::uuid));
  perform pg_temp.chk('L11 erasure record carries the actor, reason code and drift flag, and no personal content (P2-9)',
    exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid and event_type = 'erasure_record'
            and actor_user_id = pg_temp.kv('padmin')::uuid and metadata ->> 'reason_code' = 'data_subject_request'
            and metadata ->> 'case_ref' = 'SUP-2042'
            and metadata ->> 'drift' = 'false' and not (metadata::text ilike '%waltz%')));
  perform pg_temp.chk('L12 no privilege leak after erasure (owner delete of another client''s row still refused)',
    pg_temp.try(format('delete from public.intake_responses where client_id = %L', pg_temp.kv('client_a2'))) like '42501%protected change%');
  perform pg_temp.chk('L13 erasure barrier blocks new obligations for the erased client',
    pg_temp.run_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), pg_temp.kv('appt_future'))) like '%erasure_barrier_active%');
  perform pg_temp.chk('L14 client-level hold refused after an erasure record (A11)',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_create_legal_hold(%L, %L, %L, %L, %L, now() + interval ''30 days'')',
      pg_temp.kv('studio_a'), 'client', pg_temp.kv('client_a1'), 'r', 'b')) like '22023%erased%');
  perform pg_temp.chk('L15 the client row can now be deleted (no intake FK remains)',
    pg_temp.try(format('delete from public.clients where id = %L', pg_temp.kv('client_a1'))) = 'ok');
  perform pg_temp.chk('L16 barrier release requires platform admin',
    pg_temp.run_as('authenticated', pg_temp.kv('owner_a')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error')) like '42501%');
  perform pg_temp.chk('L16b barrier release takes a reason code',
    pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'free text')) like '22023%reason code%');
  v := pg_temp.run_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_release_erasure_barrier(%L, %L, %L, %L)', pg_temp.kv('studio_a'), pg_temp.kv('client_a1'), 'erased_in_error', 'INC-77'));
  perform pg_temp.chk('L17 audited barrier release (valid ticket reference) appends an event; original record unchanged',
    v = 'ok'
    and exists (select 1 from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid and event_type = 'erasure_barrier_released'
                and metadata ->> 'case_ref' = 'INC-77' and metadata ->> 'reason_code' = 'erased_in_error')
    and (select count(*) filter (where event_type = 'erasure_record') = 1 and count(*) filter (where event_type = 'erasure_barrier_released') = 1
         from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid)
    and not intake_private.erasure_barrier_active(pg_temp.kv('studio_a')::uuid, pg_temp.kv('client_a1')::uuid),
    v || ' records=' || (select count(*)::text from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid and event_type = 'erasure_record')
      || ' releases=' || (select count(*)::text from public.intake_audit_events where client_ref = pg_temp.kv('client_a1')::uuid and event_type = 'erasure_barrier_released'));
  perform pg_temp.chk('L19 platform admin hold over a subject with intake records while the gate is open',
    pg_temp.val_as('authenticated', pg_temp.kv('padmin')::uuid, format('select public.intake_create_legal_hold(%L, %L, %L, %L, %L, now() + interval ''30 days'')',
      pg_temp.kv('studio_a'), 'request', pg_temp.kv('req4'), 'synthetic', 'synthetic')) ~ '^[0-9a-f-]{36}$');
  -- Account deletion compatibility: a guardian respondent bound through a verified link; the account-deletion flow
  -- disconnects the link, then deletes the user; the respondent's account reference is NULLed (allowlisted).
  v := pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, %L, %L::jsonb, %L::jsonb, 0)', pg_temp.kv('studio_a'), pg_temp.kv('req2'),
    'guardian', json_build_object('display_name', 'Synthetic Guardian 2', 'declared_relationship', 'parent', 'source_link_id', pg_temp.kv('link_g_a2'))::text, '{"guardian_ack":true}'));
  perform pg_temp.chk('L18a guardian respondent bound to the verified account',
    v = '1' and exists (select 1 from public.intake_respondents where request_id = pg_temp.kv('req2')::uuid and role = 'guardian'
                        and auth_user_id = pg_temp.kv('guardian2_user')::uuid and assurance = 'link_verified'), v);
  update public.client_account_links set status = 'disconnected', disconnected_at = now(), account_deleted_at = now() where id = pg_temp.kv('link_g_a2')::uuid;
  v := pg_temp.try(format('delete from auth.users where id = %L', pg_temp.kv('guardian2_user')));
  perform pg_temp.chk('L18b deleting the guardian''s auth user succeeds (respondent account FK SET NULL on an allowlisted column)',
    v = 'ok' and exists (select 1 from public.intake_respondents where display_name = 'Synthetic Guardian 2' and auth_user_id is null), v);
end
$local$;

-- ---------------------------------------------------------------------------------------------------------------
-- Summary (always raises so the transaction rolls back)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare v_total int; v_fail text;
begin
  select count(*), string_agg(name || ' -> ' || detail, ' | ') filter (where not ok) into v_total, v_fail from t_results;
  if v_fail is null then
    raise exception 'NSI I1 SUITE PASS (% checks)', v_total;
  else
    raise exception 'NSI I1 SUITE FAIL: %', v_fail;
  end if;
end $$;
