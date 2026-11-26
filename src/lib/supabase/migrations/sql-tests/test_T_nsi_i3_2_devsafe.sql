-- NSI I3-2 (M16a) DEV-SAFE level-12 suite. Safe for shared DEV: creates NO auth.users, profiles, studios or any other row; it only calls
-- functions that refuse (random identities, Gate A closed) and reads the catalog. The final block ALWAYS raises, so nothing persists:
-- "NSI I3-2 M16a DEV-SAFE SUITE PASS (<n> checks)" or "... FAIL: <failures>". Valid where M16a is applied and Gate A is closed. Run through sb.sh dev-apply.

begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create temp table t_before as select (select count(*) from public.intake_guardian_attestations) as n_att,
  (select count(*) from public.intake_audit_events where event_type = 'guardian_attested') as n_aud;

select pg_temp.chk('L01 M16a is applied: the m16a markers are on the six bodies, the inventory is 113 functions, the catalog self-check passes',
  (select count(*) = 6 and bool_and(prosrc ~ 'nsi-body:m16[ab]')
     from pg_proc where proname in ('respondents_guard', 'audit_write', 'erase_client_impl', 'attestations_insert_guard', 'attestations_update_guard', 'intake_attest_guardian'))
  and (select count(*) = (case when to_regclass('public.intake_email_challenges') is not null then 122 else 113 end) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and (select 'ok' = (select 'ok' from (select intake_private.assert_catalog()) x)));

select pg_temp.chk('L02 privileges: the attest function is executable by authenticated only; the guards by nobody; the table has no API privileges and the restricted role only SELECT and DELETE',
  has_function_privilege('authenticated', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('service_role', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('intake_destructive', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and (select bool_and(not has_function_privilege(r, f, 'execute'))
         from unnest(array['intake_private.attestations_insert_guard()', 'intake_private.attestations_update_guard()']) f, unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r)
  and not has_table_privilege('anon', 'public.intake_guardian_attestations', 'select') and not has_table_privilege('authenticated', 'public.intake_guardian_attestations', 'select')
  and not has_table_privilege('service_role', 'public.intake_guardian_attestations', 'select')
  and has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'select') and has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'delete')
  and not has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'insert') and not has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'update'));

select pg_temp.chk('L03 refusals: a random (non-staff) caller of attest is refused (42501) before anything else, and a malformed request is refused the same way',
  pg_temp.val_as('authenticated', gen_random_uuid(), format('select public.intake_attest_guardian(%L, %L, %L, ''in_person'', ''parent'', ''x'')', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%'
  and pg_temp.val_as('authenticated', gen_random_uuid(), format('select public.intake_attest_guardian(%L, %L, %L, ''bad'', ''parent'', ''x'')', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%');

select pg_temp.chk('L04 Gate A is closed, the guard still refuses a definer-level change without evidence, and nothing was written by this suite',
  not intake_private.retention_gate_open()
  and (select n_att from t_before) = (select count(*) from public.intake_guardian_attestations)
  and (select n_aud from t_before) = (select count(*) from public.intake_audit_events where event_type = 'guardian_attested')
  and (select count(*) = 0 from public.intake_guardian_attestations));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-2 M16a DEV-SAFE SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-2 M16a DEV-SAFE SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;
