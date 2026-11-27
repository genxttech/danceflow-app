-- NSI I3-2 (M16b) DEV-SAFE level-13 suite. Safe for shared DEV: creates NO auth.users, profiles, studios or any other row; it only calls
-- functions that refuse (random identities, Gate A closed) and reads the catalog. The final block ALWAYS raises, so nothing persists:
-- "NSI I3-2 M16b DEV-SAFE SUITE PASS (<n> checks)" or "... FAIL: <failures>". Valid where M16b is applied and Gate A is closed.
-- M16b is NOT authorized for any shared environment yet; this suite is run locally only until it is.

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
create temp table t_before as select (select count(*) from public.intake_guardian_invitation_requests) as n_req,
  (select count(*) from public.intake_email_challenges) as n_ch, (select count(*) from public.intake_rate_limits) as n_rl,
  (select count(*) from public.intake_audit_events) as n_aud;

select pg_temp.chk('L01 M16b is applied: the m16b markers are on the sixteen bodies, the inventory is 122 functions, the catalog self-check passes',
  (select count(*) = 16 and bool_and(position('nsi-body:m16b' in prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'intake_private') and proname in (
       'guardian_requests_insert_guard', 'guardian_requests_update_guard', 'challenges_insert_guard', 'challenges_update_guard',
       'intake_guardian_request_invitation', 'intake_guardian_finalize_invitation', 'intake_guardian_challenge_target', 'intake_issue_email_challenge',
       'intake_verify_email_challenge', 'respondents_guard', 'link_valid', 'invitations_update_guard', 'intake_issue_invitation', 'intake_revoke_invitations',
       'erase_client_impl', 'purge_expired_impl'))
  and (select count(*) = 122 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and (select 'ok' = (select 'ok' from (select intake_private.assert_catalog()) x)));

select pg_temp.chk('L02 privileges: request for authenticated only, the four server functions for service_role only, guards for nobody; no API table privileges',
  has_function_privilege('authenticated', 'public.intake_guardian_request_invitation(uuid,uuid,text,smallint)', 'execute')
  and not has_function_privilege('anon', 'public.intake_guardian_request_invitation(uuid,uuid,text,smallint)', 'execute')
  and not has_function_privilege('service_role', 'public.intake_guardian_request_invitation(uuid,uuid,text,smallint)', 'execute')
  and (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')
                       and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('intake_destructive', f, 'execute'))
         from unnest(array['public.intake_guardian_finalize_invitation(uuid,uuid,integer,text,bytea,bytea,timestamptz)', 'public.intake_guardian_challenge_target(bytea)',
                      'public.intake_issue_email_challenge(bytea,uuid,bytea,bytea,bytea,text,smallint)', 'public.intake_verify_email_challenge(bytea,uuid,bytea)']) f)
  and (select bool_and(not has_function_privilege(r, f, 'execute'))
         from unnest(array['intake_private.guardian_requests_insert_guard()', 'intake_private.guardian_requests_update_guard()',
                           'intake_private.challenges_insert_guard()', 'intake_private.challenges_update_guard()']) f,
              unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r)
  and (select bool_and(not has_table_privilege(r, t, p)) from unnest(array['anon', 'authenticated', 'service_role']) r,
         unnest(array['public.intake_guardian_invitation_requests', 'public.intake_email_challenges']) t, unnest(array['select', 'insert', 'update', 'delete']) p));

select pg_temp.chk('L03 refusals with Gate A closed: a non-staff request is refused (42501); the server functions return gate_closed, invalid or no row',
  pg_temp.val_as('authenticated', gen_random_uuid(), format('select public.intake_guardian_request_invitation(%L, %L, ''h'', 1::smallint)', gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%'
  and pg_temp.val_as('service_role', null, format('select public.intake_guardian_finalize_invitation(%L, %L, 1, ''kid00001'', decode(repeat(''ab'', 16), ''hex''), sha256(''x''::bytea), now() + interval ''2 days'')', gen_random_uuid(), gen_random_uuid())) = 'gate_closed'
  and pg_temp.val_as('service_role', null, format('select public.intake_issue_email_challenge(sha256(''s''::bytea), %L, sha256(''c''::bytea), sha256(''i''::bytea), sha256(''e''::bytea), ''h'', 1::smallint)', gen_random_uuid())) = 'gate_closed'
  and pg_temp.val_as('service_role', null, format('select public.intake_verify_email_challenge(sha256(''s''::bytea), %L, sha256(''c''::bytea))', gen_random_uuid())) = 'gate_closed'
  and pg_temp.val_as('service_role', null, format('select public.intake_verify_email_challenge(''\x00''::bytea, %L, sha256(''c''::bytea))', gen_random_uuid())) = 'invalid'
  and pg_temp.val_as('service_role', null, 'select count(*)::text from public.intake_guardian_challenge_target(sha256(''s''::bytea))') = '0');

select pg_temp.chk('L04 Gate A is closed, the guardian tables are empty and nothing was written by this suite',
  not intake_private.retention_gate_open()
  and (select n_req = 0 and n_ch = 0 from t_before)
  and (select n_req from t_before) = (select count(*) from public.intake_guardian_invitation_requests)
  and (select n_ch from t_before) = (select count(*) from public.intake_email_challenges)
  and (select n_rl from t_before) = (select count(*) from public.intake_rate_limits)
  and (select n_aud from t_before) = (select count(*) from public.intake_audit_events));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-2 M16b DEV-SAFE SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-2 M16b DEV-SAFE SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;
