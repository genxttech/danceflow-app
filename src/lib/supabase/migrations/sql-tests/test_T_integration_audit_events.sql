-- Integration audit events suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223120000.
-- Prints "INTEGRATION AUDIT SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless auditevt.local = 'on'.
begin;
do $$ begin
  if coalesce(current_setting('auditevt.local', true), '') <> 'on' then
    raise exception 'integration audit suite refused: set auditevt.local = ''on'' only on a disposable local stack';
  end if;
end $$;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
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

insert into auth.users (id, email) values
  ('f0000000-0000-4000-8000-0000000000a1', 'ownerA@audit.test'), ('f0000000-0000-4000-8000-0000000000a2', 'frontA@audit.test'),
  ('f0000000-0000-4000-8000-0000000000b1', 'ownerB@audit.test');
insert into public.profiles (id) select id from auth.users where email like '%@audit.test' on conflict do nothing;
insert into public.studios (id, name, slug) values
  ('f1000000-0000-4000-8000-00000000000a', 'Audit A', 'audit-a'), ('f1000000-0000-4000-8000-00000000000b', 'Audit B', 'audit-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('f0000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('f0000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('f0000000-0000-4000-8000-0000000000b1', 'f1000000-0000-4000-8000-00000000000b', 'studio_owner', true);

select pg_temp.chk('service role can append an event',
  pg_temp.val_as('service_role', null, $q$insert into public.integration_audit_events (studio_id, provider, event_type, details) values ('f1000000-0000-4000-8000-00000000000a', 'google_calendar', 'connected', '{"scope":"studio"}') returning 'ok'$q$) = 'ok');
insert into public.integration_audit_events (studio_id, provider, event_type) values ('f1000000-0000-4000-8000-00000000000b', 'wave', 'disconnected');

select pg_temp.chk('owner reads only own studio events', pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.integration_audit_events') = '1');
select pg_temp.chk('other studio owner sees only theirs', pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000b1', 'select provider from public.integration_audit_events') = 'wave');
select pg_temp.chk('non-admin staff reads nothing', pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000a2', 'select count(*)::text from public.integration_audit_events') = '0');
select pg_temp.chk('anon cannot read', pg_temp.val_as('anon', null, 'select count(*)::text from public.integration_audit_events') like 'ERR%');
select pg_temp.chk('authenticated cannot insert', pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000a1', $q$insert into public.integration_audit_events (studio_id, provider, event_type) values ('f1000000-0000-4000-8000-00000000000a', 'wave', 'x') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('authenticated cannot update or delete', pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.integration_audit_events set outcome = 'failed' returning 1) select count(*)::text from u$q$) like 'ERR%'
  and pg_temp.val_as('authenticated', 'f0000000-0000-4000-8000-0000000000a1', $q$with d as (delete from public.integration_audit_events returning 1) select count(*)::text from d$q$) like 'ERR%');
select pg_temp.chk('rows are immutable even for the table owner (update)', pg_temp.val_as('postgres', null, $q$update public.integration_audit_events set outcome = 'failed' where provider = 'wave' returning 'ok'$q$) like '%immutable%');
select pg_temp.chk('bad provider, event type, outcome and non-object details are rejected',
  pg_temp.val_as('service_role', null, $q$insert into public.integration_audit_events (studio_id, provider, event_type) values ('f1000000-0000-4000-8000-00000000000a', 'Bad Provider', 'x') returning 'ok'$q$) like 'ERR%'
  and pg_temp.val_as('service_role', null, $q$insert into public.integration_audit_events (studio_id, provider, event_type, outcome) values ('f1000000-0000-4000-8000-00000000000a', 'wave', 'x', 'weird') returning 'ok'$q$) like 'ERR%'
  and pg_temp.val_as('service_role', null, $q$insert into public.integration_audit_events (studio_id, provider, event_type, details) values ('f1000000-0000-4000-8000-00000000000a', 'wave', 'x', '[1]') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('oversized details are rejected', pg_temp.val_as('service_role', null, format($q$insert into public.integration_audit_events (studio_id, provider, event_type, details) values ('f1000000-0000-4000-8000-00000000000a', 'wave', 'x', jsonb_build_object('k', %L)) returning 'ok'$q$, repeat('x', 9000))) like 'ERR%');
-- studio deletion must still cascade (a delete trigger would have blocked it)
delete from public.studios where id = 'f1000000-0000-4000-8000-00000000000b';
select pg_temp.chk('deleting a studio cascades its audit rows', not exists (select 1 from public.integration_audit_events where studio_id = 'f1000000-0000-4000-8000-00000000000b'));

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'INTEGRATION AUDIT SUITE PASS (% checks)', n; else raise exception 'INTEGRATION AUDIT SUITE FAIL: %', f; end if;
end $$;
