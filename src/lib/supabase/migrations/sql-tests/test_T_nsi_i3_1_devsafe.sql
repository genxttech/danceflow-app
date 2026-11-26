-- NSI I3-1 (M12) DEV-SAFE level-10 suite. Safe for shared DEV: creates NO auth.users, profiles, studios or any other row; it only
-- calls functions that refuse or return nothing while Gate A is closed, and reads the catalog. The final block ALWAYS raises, so
-- nothing persists: "NSI I3-1 DEV-SAFE SUITE PASS (<n> checks)" or "... FAIL: <failures>".
-- Valid on a database where M12 is applied and Gate A is closed (the shipped dark state).

begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end; end $$;
grant execute on function pg_temp.try(text) to authenticated, anon, service_role;
-- run a statement as a role; returns 'ok', 'ERR <sqlstate>', or the first column of the first row
create or replace function pg_temp.val_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'a5300000-0000-0000-0000-0000000f1f1f', 'role', p_role)::text, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

select pg_temp.chk('M01 the level-10 catalog self-check passes and Gate A is closed',
  pg_temp.try('select intake_private.assert_catalog()') = 'ok' and not intake_private.retention_gate_open());
select pg_temp.chk('M02 the three tables exist with RLS on, hold zero rows, and no API role holds any privilege on them',
  (select count(*) = 3 and bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname in ('intake_invitations', 'intake_sessions', 'intake_rate_limits'))
  and not exists (select 1 from public.intake_invitations) and not exists (select 1 from public.intake_sessions) and not exists (select 1 from public.intake_rate_limits)
  and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['intake_invitations', 'intake_sessions', 'intake_rate_limits']) t,
                         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p where has_table_privilege(r, 'public.' || t, p)));
select pg_temp.chk('M03 function privileges: staff RPCs for authenticated only; exchange, context, revoke, rate limit, bulk revoke and purge for service_role only; anon none',
  has_function_privilege('authenticated', 'public.intake_issue_invitation(uuid,uuid,uuid,int,text,bytea,bytea,timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.intake_revoke_invitations(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.intake_next_invitation_generation(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.intake_next_invitation_generation(uuid,uuid)', 'execute')
  and (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
       from unnest(array['public.intake_exchange_invitation(bytea,bytea,int,int)', 'public.intake_session_context(bytea)', 'public.intake_revoke_session(bytea)',
                         'public.intake_rate_limit_hit(bytea,int,int)', 'public.intake_revoke_all_invitations_for_key(text,int)', 'public.intake_purge_expired(int)']) f)
  and not has_function_privilege('anon', 'public.intake_issue_invitation(uuid,uuid,uuid,int,text,bytea,bytea,timestamptz)', 'execute'));
select pg_temp.chk('M04 an authenticated user who is not staff of the studio cannot issue or revoke (42501), and nothing is written',
  pg_temp.val_as('authenticated', format('select public.intake_issue_invitation(%L, %L, %L, 1, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')',
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'kid00001', repeat('ab', 16), repeat('cd', 32))) like 'ERR 42501%'
  and pg_temp.val_as('authenticated', format('select public.intake_revoke_invitations(%L, %L)', gen_random_uuid(), gen_random_uuid())) like 'ERR 42501%'
  and not exists (select 1 from public.intake_invitations));
select pg_temp.chk('M05 with Gate A closed the rate limit denies and writes nothing, an unknown link exchanges to nothing, an unknown session resolves to nothing',
  pg_temp.val_as('service_role', format('select public.intake_rate_limit_hit(decode(%L, ''hex''), 5, 600)', repeat('ef', 32))) = 'false'
  and pg_temp.val_as('service_role', format('select count(*) from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), 1800, 14400)', repeat('01', 32), repeat('02', 32))) = '0'
  and pg_temp.val_as('service_role', format('select count(*) from public.intake_session_context(decode(%L, ''hex''))', repeat('03', 32))) = '0'
  and not exists (select 1 from public.intake_rate_limits) and not exists (select 1 from public.intake_sessions));
select pg_temp.chk('M06 exchange rejects out-of-range parameters (22023) before any work',
  pg_temp.val_as('service_role', format('select count(*) from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), 10, 14400)', repeat('01', 32), repeat('02', 32))) like 'ERR 22023%');
select pg_temp.chk('M07 erase_client_impl carries the m12 marker; purge and erase implementations are owned by the restricted role; no function has a default ACL',
  (select prosrc ~ 'nsi-body:m(12|14|16a|16b)' from pg_proc where proname = 'erase_client_impl')
  and (select bool_and(pg_get_userbyid(proowner) = 'intake_destructive') from pg_proc where proname in ('erase_client_impl', 'purge_expired_impl'))
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and p.proacl is null));
select pg_temp.chk('M08 the audit event-type CHECK knows the four M12 event types and nothing was queued for delivery',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'intake_audit_events_event_type_check')) ~ 'invitation_issued.*invitation_revoked.*link_exchanged.*session_revoked'
  and (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%'));
select pg_temp.chk('M09 the three tables carry the full guard set (gate, tenant, update, delete, no-truncate triggers; destructive-role-only policies)',
  (select count(*) = 5 from pg_trigger t where t.tgrelid = 'public.intake_invitations'::regclass and not t.tgisinternal)
  and (select count(*) = 5 from pg_trigger t where t.tgrelid = 'public.intake_sessions'::regclass and not t.tgisinternal)
  and (select count(*) = 3 from pg_trigger t where t.tgrelid = 'public.intake_rate_limits'::regclass and not t.tgisinternal)
  and (select count(*) = 6 from pg_policy where polrelid in ('public.intake_invitations'::regclass, 'public.intake_sessions'::regclass, 'public.intake_rate_limits'::regclass)));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-1 DEV-SAFE SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-1 DEV-SAFE SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;
