-- NSI I3-3 (M15) DEV-SAFE level-11 suite. Safe for shared DEV: creates NO auth.users, profiles, studios or any other row; it only calls
-- functions that refuse or return nothing (unknown ids, Gate A closed) and reads the catalog. The final block ALWAYS raises, so nothing
-- persists: "NSI I3-3 DEV-SAFE SUITE PASS (<n> checks)" or "... FAIL: <failures>".
-- Valid on a database where M15 is applied and Gate A is closed (the shipped dark state). Run through sb.sh dev-apply.

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
create temp table t_before as select count(*) as n from public.intake_minor_determinations;

select pg_temp.chk('L01 M15 is applied: every M15 body carries the m15 marker, the inventory is 110 functions, the catalog self-check passes',
  (select count(*) = 7 and bool_and(position('nsi-body:m15' in prosrc) > 0)
     from pg_proc where proname in ('studio_local_date', 'age_in_years', 'intake_determine_minor_from_birthday', 'intake_declare_minor_status', 'intake_session_minor_state', 'intake_minor_basis', 'fulfillment_state'))
  and (select count(*) = 110 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and (select 'ok' = (select 'ok' from (select intake_private.assert_catalog()) x)));

select pg_temp.chk('L02 privileges: determine, declare and session state are service_role only; the staff read is authenticated only; the helpers have no API grants; fulfillment_state stays executable by the restricted role',
  (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('intake_destructive', f, 'execute'))
     from unnest(array['public.intake_determine_minor_from_birthday(uuid,uuid)', 'public.intake_declare_minor_status(bytea,text)', 'public.intake_session_minor_state(bytea)']) f)
  and has_function_privilege('authenticated', 'public.intake_minor_basis(uuid,uuid)', 'execute') and not has_function_privilege('service_role', 'public.intake_minor_basis(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.intake_minor_basis(uuid,uuid)', 'execute')
  and (select bool_and(not has_function_privilege(r, f, 'execute'))
         from unnest(array['intake_private.studio_local_date(uuid)', 'intake_private.age_in_years(date,date)']) f, unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r)
  and has_function_privilege('intake_destructive', 'intake_private.fulfillment_state(uuid)', 'execute'));

select pg_temp.chk('L03 refusals: an unknown request raises 22023, a malformed or unknown session is invalid or NULL, a bad declaration class is refused, a non-staff caller of the staff read is refused, an unknown request has no completion',
  pg_temp.val_as('service_role', null, format('select public.intake_determine_minor_from_birthday(%L, %L)', gen_random_uuid(), gen_random_uuid())) like 'ERR 22023%'
  and pg_temp.val_as('service_role', null, 'select public.intake_declare_minor_status(decode(repeat(''ab'', 32), ''hex''), ''adult'')') = 'invalid'
  and pg_temp.val_as('service_role', null, 'select public.intake_declare_minor_status(decode(''abcd'', ''hex''), ''adult'')') = 'invalid'
  and pg_temp.val_as('service_role', null, 'select public.intake_declare_minor_status(decode(repeat(''ab'', 32), ''hex''), ''maybe'')') like 'ERR 22023%'
  and pg_temp.val_as('service_role', null, 'select public.intake_session_minor_state(decode(repeat(''ab'', 32), ''hex''))') is null
  and pg_temp.val_as('authenticated', gen_random_uuid(), format('select count(*) from public.intake_minor_basis(%L, %L)', gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%'
  and pg_temp.val_as('anon', null, format('select public.intake_determine_minor_from_birthday(%L, %L)', gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%'
  and intake_private.fulfillment_state(gen_random_uuid()) = 'incomplete');

select pg_temp.chk('L04 Gate A is closed and nothing was written: no determination rows were added by this suite',
  not intake_private.retention_gate_open() and (select n from t_before) = (select count(*) from public.intake_minor_determinations));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-3 DEV-SAFE SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-3 DEV-SAFE SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;
