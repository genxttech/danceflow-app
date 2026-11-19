-- Claim RPC execute gate: ACL of public.claim_my_event_registrations() in the two release states.
--   psql -v expect=withheld   after 20270222090500 (and until 20270222094000): nobody but the owner can execute
--   psql -v expect=active     after 20270222094000: authenticated (only) can execute
-- Needs the claim function chain applied (20270221090000, 20270222090000, 20270222090500; 20270222094000 for expect=active).
-- Calls are made with psql SET ROLE (never through PostgREST: the known local supautils segfault on "permission denied for function").
-- One transaction, no fixtures, nothing written. The final block ALWAYS raises
-- "CLAIM EXECUTE GATE SUITE PASS (<n> checks, <expect>)" or "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.call_as(p_role text) returns text language plpgsql as $$
declare v integer;
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'select public.claim_my_event_registrations()' into v; -- dynamic: a cached plpgsql expression would skip the EXECUTE check after the first role switch
    reset role;
    return 'ok:' || v;
  exception when others then
    reset role;
    return sqlstate || ':' || sqlerrm;
  end;
end $$;

select :'expect' as expect \gset

select pg_temp.chk('function exists, security definer, owner postgres, search_path pinned',
  (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure('public.claim_my_event_registrations()')));
select pg_temp.chk('no grant to public, anon or service_role in either state',
  not has_function_privilege('anon', 'public.claim_my_event_registrations()', 'execute')
  and not has_function_privilege('service_role', 'public.claim_my_event_registrations()', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = to_regprocedure('public.claim_my_event_registrations()') and a.grantee = 0));
select pg_temp.chk('the owner (postgres) can always execute', has_function_privilege('postgres', 'public.claim_my_event_registrations()', 'execute'));
select pg_temp.chk('ACL grantees: ' || :'expect',
  (select coalesce(array_agg(distinct pg_get_userbyid(a.grantee)::text order by pg_get_userbyid(a.grantee)::text), '{}') from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = to_regprocedure('public.claim_my_event_registrations()'))
  = case :'expect' when 'active' then array['authenticated', 'postgres'] else array['postgres'] end,
  (select array_agg(distinct pg_get_userbyid(a.grantee)::text)::text from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = to_regprocedure('public.claim_my_event_registrations()')));
select pg_temp.chk('authenticated execute privilege matches the state',
  has_function_privilege('authenticated', 'public.claim_my_event_registrations()', 'execute') = (:'expect' = 'active'));

select pg_temp.call_as('authenticated') as r_auth \gset
select pg_temp.call_as('anon') as r_anon \gset
select pg_temp.call_as('service_role') as r_svc \gset
select pg_temp.chk('authenticated call: ' || :'expect',
  case :'expect' when 'active' then :'r_auth' = 'ok:0' else :'r_auth' like '42501:%' end, :'r_auth');
select pg_temp.chk('anon call is denied (42501)', :'r_anon' like '42501:%', :'r_anon');
select pg_temp.chk('service_role call is denied (42501)', :'r_svc' like '42501:%', :'r_svc');

do $$
declare
  v_fail text;
  v_total integer;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then
    raise exception 'CLAIM EXECUTE GATE SUITE PASS (% checks)', v_total;
  else
    raise exception 'CLAIM EXECUTE GATE SUITE FAIL: %', v_fail;
  end if;
end $$;
