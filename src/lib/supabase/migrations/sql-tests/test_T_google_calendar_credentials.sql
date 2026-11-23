-- Google Calendar credentials isolation suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223090000.
-- Prints "GCAL CREDENTIALS SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless gcaltest.local = 'on'.
begin;
do $$ begin
  if coalesce(current_setting('gcaltest.local', true), '') <> 'on' then
    raise exception 'gcal credentials suite refused: set gcaltest.local = ''on'' only on a disposable local stack';
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
  exception when others then v := 'ERR ' || sqlstate; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

insert into auth.users (id, email) values
  ('c0000000-0000-4000-8000-0000000000a1', 'adminA@gcal.test'),
  ('c0000000-0000-4000-8000-0000000000b1', 'adminB@gcal.test');
insert into public.profiles (id) select id from auth.users where email like '%@gcal.test' on conflict do nothing;
insert into public.studios (id, name, slug) values
  ('c1000000-0000-4000-8000-00000000000a', 'Gcal A', 'gcal-a'), ('c1000000-0000-4000-8000-00000000000b', 'Gcal B', 'gcal-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('c0000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-00000000000a', 'studio_admin', true),
  ('c0000000-0000-4000-8000-0000000000b1', 'c1000000-0000-4000-8000-00000000000b', 'studio_admin', true);
insert into public.studio_google_calendar_connections (id, studio_id, status, connection_scope, encrypted_access_token, encrypted_refresh_token, token_expires_at)
values ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'connected', 'studio', 'v1.a.b.c', 'v1.d.e.f', now()),
       ('c2000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-00000000000b', 'disconnected', 'studio', null, null, null);

-- the migration's backfill statement, run twice (idempotent)
insert into public.studio_google_calendar_credentials (connection_id, encrypted_access_token, encrypted_refresh_token, token_expires_at)
select c.id, c.encrypted_access_token, c.encrypted_refresh_token, c.token_expires_at
from public.studio_google_calendar_connections c where c.encrypted_access_token is not null on conflict (connection_id) do nothing;
insert into public.studio_google_calendar_credentials (connection_id, encrypted_access_token, encrypted_refresh_token, token_expires_at)
select c.id, c.encrypted_access_token, c.encrypted_refresh_token, c.token_expires_at
from public.studio_google_calendar_connections c where c.encrypted_access_token is not null on conflict (connection_id) do nothing;

select pg_temp.chk('backfill copies connected row exactly once', (select count(*) = 1 and bool_and(encrypted_access_token = 'v1.a.b.c' and encrypted_refresh_token = 'v1.d.e.f') from public.studio_google_calendar_credentials where connection_id = 'c2000000-0000-4000-8000-00000000000a'));
select pg_temp.chk('backfill skips connection without token', not exists (select 1 from public.studio_google_calendar_credentials where connection_id = 'c2000000-0000-4000-8000-00000000000b'));
select pg_temp.chk('RLS enabled on credentials', (select relrowsecurity from pg_class where oid = 'public.studio_google_calendar_credentials'::regclass));
select pg_temp.chk('no policy on credentials', not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'studio_google_calendar_credentials'));
select pg_temp.chk('authenticated has no table privilege', not has_table_privilege('authenticated', 'public.studio_google_calendar_credentials', 'select') and not has_table_privilege('authenticated', 'public.studio_google_calendar_credentials', 'insert') and not has_table_privilege('authenticated', 'public.studio_google_calendar_credentials', 'update'));
select pg_temp.chk('anon has no table privilege', not has_table_privilege('anon', 'public.studio_google_calendar_credentials', 'select'));
select pg_temp.chk('own studio admin cannot read credentials', pg_temp.val_as('authenticated', 'c0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.studio_google_calendar_credentials') like 'ERR%');
select pg_temp.chk('other-tenant admin cannot read credentials', pg_temp.val_as('authenticated', 'c0000000-0000-4000-8000-0000000000b1', 'select count(*)::text from public.studio_google_calendar_credentials') like 'ERR%');
select pg_temp.chk('anon cannot read credentials', pg_temp.val_as('anon', null, 'select count(*)::text from public.studio_google_calendar_credentials') like 'ERR%');
select pg_temp.chk('authenticated cannot insert credentials', pg_temp.val_as('authenticated', 'c0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_google_calendar_credentials (connection_id, encrypted_access_token) values ('c2000000-0000-4000-8000-00000000000b','x') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('service role can read and write credentials', pg_temp.val_as('service_role', null, $q$update public.studio_google_calendar_credentials set encrypted_access_token = 'v1.z.z.z' where connection_id = 'c2000000-0000-4000-8000-00000000000a' returning encrypted_access_token$q$) = 'v1.z.z.z');
select pg_temp.chk('connection row still readable by its own admin', pg_temp.val_as('authenticated', 'c0000000-0000-4000-8000-0000000000a1', $q$select status from public.studio_google_calendar_connections where id = 'c2000000-0000-4000-8000-00000000000a'$q$) = 'connected');
select pg_temp.chk('other tenant cannot see connection row', pg_temp.val_as('authenticated', 'c0000000-0000-4000-8000-0000000000b1', $q$select status from public.studio_google_calendar_connections where id = 'c2000000-0000-4000-8000-00000000000a'$q$) is null);
delete from public.studio_google_calendar_connections where id = 'c2000000-0000-4000-8000-00000000000a';
select pg_temp.chk('deleting connection cascades credentials', not exists (select 1 from public.studio_google_calendar_credentials where connection_id = 'c2000000-0000-4000-8000-00000000000a'));

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'GCAL CREDENTIALS SUITE PASS (% checks)', n; else raise exception 'GCAL CREDENTIALS SUITE FAIL: %', f; end if;
end $$;
