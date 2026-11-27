-- RH02 — G7/G8 SQL tests (synthetic; whole file runs in one transaction and is ROLLED BACK)
-- (hosted) no explicit transaction: management API runs the batch as one implicit transaction
create temp table rh(id text primary key, test text, expected text, actual text, pass boolean);
grant all on rh to public;

-- seed (synthetic UUIDs)
insert into public.nsi_rh_profiles values
 ('a0000000-0000-0000-0000-00000000000a','platform_admin'),
 ('b0000000-0000-0000-0000-00000000000b', null);
insert into public.nsi_rh_requests(studio_id, client_id, answers) values
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','{"q":"synthetic-1"}'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','{"q":"synthetic-2"}'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002','{"q":"synthetic-3"}');

-- G7-01 role attributes
insert into rh select 'G7-01','role attributes','nologin noinherit nobypassrls nosuper nocreaterole',
  format('login=%s inherit=%s bypassrls=%s super=%s createrole=%s', rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole),
  not rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreaterole
from pg_roles where rolname='intake_destructive';

-- G7-02 role has no access to auth schema and no CREATE on public
insert into rh select 'G7-02','role auth/public privileges','no auth USAGE, no public CREATE',
  format('auth_usage=%s public_create=%s', has_schema_privilege('intake_destructive','auth','USAGE'), has_schema_privilege('intake_destructive','public','CREATE')),
  not has_schema_privilege('intake_destructive','auth','USAGE') and not has_schema_privilege('intake_destructive','public','CREATE');

-- G8-01 private schema not usable by API roles
insert into rh select 'G8-01','intake_private USAGE for API roles','all false',
  format('anon=%s auth=%s service=%s', has_schema_privilege('anon','intake_private','USAGE'), has_schema_privilege('authenticated','intake_private','USAGE'), has_schema_privilege('service_role','intake_private','USAGE')),
  not (has_schema_privilege('anon','intake_private','USAGE') or has_schema_privilege('authenticated','intake_private','USAGE') or has_schema_privilege('service_role','intake_private','USAGE'));

-- G8-02 function EXECUTE matrix
insert into rh select 'G8-02','EXECUTE matrix','impl: postgres only; wrapper: authenticated only; helpers: none for API roles',
  format('impl[anon=%s auth=%s svc=%s pg=%s] wrap[anon=%s auth=%s svc=%s] helpers_any_api=%s',
    has_function_privilege('anon','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE'),
    has_function_privilege('authenticated','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE'),
    has_function_privilege('service_role','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE'),
    has_function_privilege('postgres','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE'),
    has_function_privilege('anon','public.intake_erase_client(uuid,uuid,text)','EXECUTE'),
    has_function_privilege('authenticated','public.intake_erase_client(uuid,uuid,text)','EXECUTE'),
    has_function_privilege('service_role','public.intake_erase_client(uuid,uuid,text)','EXECUTE'),
    (select bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon','authenticated','service_role']) r
      where p.pronamespace='public'::regnamespace and p.proname like 'nsi_rh_%')),
  not has_function_privilege('anon','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('authenticated','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('service_role','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE')
  and has_function_privilege('postgres','intake_private.erase_client_impl(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('anon','public.intake_erase_client(uuid,uuid,text)','EXECUTE')
  and has_function_privilege('authenticated','public.intake_erase_client(uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('service_role','public.intake_erase_client(uuid,uuid,text)','EXECUTE')
  and not (select bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon','authenticated','service_role']) r
      where p.pronamespace='public'::regnamespace and p.proname like 'nsi_rh_%');

-- G8-03 table privileges of API roles
insert into rh select 'G8-03','API-role table privileges on nsi_rh tables','none',
  coalesce(string_agg(format('%s:%s', r, c.relname), ','), 'none'),
  count(*) = 0
from pg_class c, unnest(array['anon','authenticated','service_role']) r
where c.relname like 'nsi_rh_%' and c.relkind='r'
  and (has_table_privilege(r, c.oid, 'SELECT') or has_table_privilege(r, c.oid, 'INSERT') or has_table_privilege(r, c.oid, 'UPDATE') or has_table_privilege(r, c.oid, 'DELETE') or has_table_privilege(r, c.oid, 'TRUNCATE'));

-- G8-04 restricted role: permitted SELECT
do $$ declare n int; begin
  execute 'set role intake_destructive';
  select count(*) into n from public.nsi_rh_requests;
  execute 'reset role';
  insert into rh values ('G8-04','role SELECT via policy','3 rows visible', n::text, n = 3);
end $$;

-- G8-05 restricted role: INSERT / UPDATE denied; audit DELETE denied; profiles SELECT denied
do $$ declare m text; ok boolean;
begin
  begin execute 'set role intake_destructive';
    insert into public.nsi_rh_requests(studio_id, client_id) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000009');
    m := 'insert succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  execute 'reset role';
  insert into rh values ('G8-05a','role INSERT denied','42501', m, ok);

  begin execute 'set role intake_destructive';
    update public.nsi_rh_requests set answers = '{}'::jsonb;
    m := 'update succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  execute 'reset role';
  insert into rh values ('G8-05b','role UPDATE denied','42501', m, ok);

  begin execute 'set role intake_destructive';
    delete from public.nsi_rh_audit;
    m := 'audit delete succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  execute 'reset role';
  insert into rh values ('G8-05c','role DELETE on audit denied','42501', m, ok);

  begin execute 'set role intake_destructive';
    perform count(*) from public.nsi_rh_profiles;
    m := 'profiles select succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  execute 'reset role';
  insert into rh values ('G8-05d','role SELECT on profiles denied','42501', m, ok);
end $$;

-- G8-06 RLS is effective for the role: without the SELECT policy it sees nothing
do $$ declare n int; begin
  begin
    drop policy nsi_rh_requests_destructive_select on public.nsi_rh_requests;
    execute 'set role intake_destructive';
    select count(*) into n from public.nsi_rh_requests;
    execute 'reset role';
    raise exception 'undo' using errcode = 'P0001';
  exception when sqlstate 'P0001' then null; end;
  insert into rh values ('G8-06','RLS without policy','0 rows', n::text, n = 0);
end $$;

-- G8-07 protected table refuses unauthorized modification (owner, service_role, authenticated)
do $$ declare m text; ok boolean; r text;
begin
  begin delete from public.nsi_rh_requests; m := 'owner delete succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-07a','owner (postgres) DELETE refused by trigger','42501', m, ok);
  begin update public.nsi_rh_requests set answers = null; m := 'owner update succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-07b','owner (postgres) UPDATE refused by trigger','42501', m, ok);
  foreach r in array array['service_role','authenticated','anon'] loop
    begin execute format('set role %I', r); delete from public.nsi_rh_requests; m := 'delete succeeded'; ok := false;
    exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
    execute 'reset role';
    insert into rh values ('G8-07c-'||r, r||' DELETE denied','42501', m, ok);
  end loop;
  begin truncate public.nsi_rh_requests; m := 'truncate succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-07d','owner TRUNCATE refused','42501', m, ok);
  begin update public.nsi_rh_audit set event_type = 'x'; m := 'audit update ok'; ok := (select count(*) = 0 from public.nsi_rh_audit);
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-07e','audit UPDATE refused (append-only)','42501 or no rows', m, ok);
end $$;

-- G8-08 wrapper without an authenticated identity is refused
do $$ declare m text; ok boolean; begin
  begin perform public.intake_erase_client('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','synthetic');
    m := 'succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-08','wrapper with no auth.uid()','42501 not authorized', m, ok);
end $$;

-- G8-09 implementation (as wrapper owner postgres) deletes only the target client and runs as the role;
-- G8-10 privilege does not leak to a later statement in the same transaction;
-- G8-11 hostile search_path / temp shadow table does not redirect the implementation
do $$ declare n int; m text; ok boolean; remaining_c1 int; remaining_c2 int; temp_rows int; exec_role text;
begin
  create temp table nsi_rh_requests(studio_id uuid, client_id uuid);
  insert into pg_temp.nsi_rh_requests values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001');
  perform set_config('search_path', 'pg_temp, public', true);
  n := intake_private.erase_client_impl('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','synthetic');
  select count(*) into remaining_c1 from public.nsi_rh_requests where client_id='c0000000-0000-0000-0000-000000000001';
  select count(*) into remaining_c2 from public.nsi_rh_requests where client_id='c0000000-0000-0000-0000-000000000002';
  select count(*) into temp_rows from pg_temp.nsi_rh_requests;
  select a.exec_role into exec_role from public.nsi_rh_audit a where a.event_type='erasure_record' order by created_at desc limit 1;
  insert into rh values ('G8-09','impl deletes only target; runs as restricted role','deleted=2 c1=0 c2=1 exec_role=intake_destructive',
    format('deleted=%s c1=%s c2=%s exec_role=%s', n, remaining_c1, remaining_c2, exec_role),
    n = 2 and remaining_c1 = 0 and remaining_c2 = 1 and exec_role = 'intake_destructive');
  insert into rh values ('G8-11','hostile search_path + temp shadow table','temp row untouched (1)', temp_rows::text, temp_rows = 1);
  begin delete from public.nsi_rh_requests where client_id='c0000000-0000-0000-0000-000000000002'; m := 'later delete succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-10','no privilege leak after impl returns (same transaction)','42501', m || ' current_user=' || current_user, ok);
  perform set_config('search_path', '"$user", public, extensions', true);
end $$;

-- G8-12 erasure barrier blocks new records for the erased client only; audited release lifts it
do $$ declare m text; ok boolean; begin
  begin insert into public.nsi_rh_requests(studio_id, client_id) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001');
    m := 'insert succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-12a','insert for erased client refused (barrier)','42501', m, ok);
  begin insert into public.nsi_rh_requests(studio_id, client_id) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000003');
    m := 'ok'; ok := true;
  exception when others then m := sqlstate||' '||sqlerrm; ok := false; end;
  insert into rh values ('G8-12b','insert for unrelated client allowed','ok', m, ok);
  perform public.nsi_rh_audit_write('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','erasure_barrier_released','a0000000-0000-0000-0000-00000000000a','postgres');
  begin insert into public.nsi_rh_requests(studio_id, client_id) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001');
    m := 'ok'; ok := true;
  exception when others then m := sqlstate||' '||sqlerrm; ok := false; end;
  insert into rh values ('G8-12c','insert allowed after audited release','ok', m, ok);
  insert into rh select 'G8-12d','original erasure_record unchanged and release appended','1 record + 1 release',
    format('records=%s releases=%s', count(*) filter (where event_type='erasure_record'), count(*) filter (where event_type='erasure_barrier_released')),
    count(*) filter (where event_type='erasure_record') = 1 and count(*) filter (where event_type='erasure_barrier_released') = 1
  from public.nsi_rh_audit where client_ref = 'c0000000-0000-0000-0000-000000000001';
end $$;

-- G8-13 environment marker: single row, no studio, immutable
do $$ declare m text; ok boolean; n int; begin
  perform public.nsi_rh_audit_write(null, null, 'environment_first_use', null, 'postgres', 'environment_marker');
  perform public.nsi_rh_audit_write(null, null, 'environment_first_use', null, 'postgres', 'environment_marker');
  select count(*) into n from public.nsi_rh_audit where retention_class='environment_marker';
  insert into rh values ('G8-13a','marker written twice -> one row, studio_id null','1', n::text, n = 1);
  begin delete from public.nsi_rh_audit where retention_class='environment_marker'; m := 'deleted'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  insert into rh values ('G8-13b','marker delete refused (owner)','42501', m, ok);
  begin insert into public.nsi_rh_audit(studio_id, event_type, retention_class) values ('11111111-1111-1111-1111-111111111111','x','environment_marker'); m := 'inserted'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '23514'); end;
  insert into rh values ('G8-13c','studio-scoped marker rejected','23514', m, ok);
end $$;

-- G10-SQL simulated authenticated caller (definitive test is the API run in RH03)
do $$ declare m text; ok boolean; n int; actor uuid; begin
  insert into public.nsi_rh_requests(studio_id, client_id) values ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004');
  begin
    perform set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
    execute 'set role authenticated';
    perform public.intake_erase_client('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004','synthetic');
    m := 'non-admin succeeded'; ok := false;
  exception when others then m := sqlstate||' '||sqlerrm; ok := (sqlstate = '42501'); end;
  execute 'reset role';
  insert into rh values ('G10-S1','non-admin authenticated (SQL simulation) refused','42501', m, ok);
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
  execute 'set role authenticated';
  n := public.intake_erase_client('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004','synthetic');
  execute 'reset role';
  select actor_user_id into actor from public.nsi_rh_audit where client_ref='c0000000-0000-0000-0000-000000000004' and event_type='erasure_record';
  insert into rh values ('G10-S2','admin authenticated (SQL simulation): erased, actor recorded','deleted=1 actor=a000…0a', format('deleted=%s actor=%s', n, actor),
    n = 1 and actor = 'a0000000-0000-0000-0000-00000000000a');
end $$;

create table if not exists public.nsi_rh_results(run text, id text, pass boolean, test text, expected text, actual text);
insert into public.nsi_rh_results select 'RH02', id, pass, test, expected, actual from rh;
select id, pass, test, expected, actual from rh order by id;
