-- Instructor calendar feeds RLS suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223110000.
-- Prints "ICS FEEDS SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless icstest.local = 'on'.
begin;
do $$ begin
  if coalesce(current_setting('icstest.local', true), '') <> 'on' then
    raise exception 'ics feeds suite refused: set icstest.local = ''on'' only on a disposable local stack';
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
  ('e0000000-0000-4000-8000-0000000000a1', 'owner@ics.test'), ('e0000000-0000-4000-8000-0000000000a2', 'front@ics.test'),
  ('e0000000-0000-4000-8000-0000000000a3', 'instrA@ics.test'), ('e0000000-0000-4000-8000-0000000000a4', 'instrB@ics.test'),
  ('e0000000-0000-4000-8000-0000000000b1', 'otherowner@ics.test'), ('e0000000-0000-4000-8000-0000000000a5', 'platform@ics.test');
insert into public.profiles (id) select id from auth.users where email like '%@ics.test' on conflict do nothing;
insert into public.studios (id, name, slug) values
  ('e1000000-0000-4000-8000-00000000000a', 'Ics A', 'ics-a'), ('e1000000-0000-4000-8000-00000000000b', 'Ics B', 'ics-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('e0000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('e0000000-0000-4000-8000-0000000000a2', 'e1000000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('e0000000-0000-4000-8000-0000000000a3', 'e1000000-0000-4000-8000-00000000000a', 'instructor', true),
  ('e0000000-0000-4000-8000-0000000000a4', 'e1000000-0000-4000-8000-00000000000a', 'instructor', true),
  ('e0000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000000b', 'studio_owner', true),
  ('e0000000-0000-4000-8000-0000000000a5', 'e1000000-0000-4000-8000-00000000000a', 'platform_admin', true);
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active) values
  ('e3000000-0000-4000-8000-0000000000a3', 'e1000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-0000000000a3', 'Ana', 'A', true),
  ('e3000000-0000-4000-8000-0000000000a4', 'e1000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-0000000000a4', 'Bo', 'B', true);
insert into public.instructor_calendar_feeds (studio_id, instructor_id, token) values
  ('e1000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000a3', 'tok-ana'),
  ('e1000000-0000-4000-8000-00000000000a', 'e3000000-0000-4000-8000-0000000000a4', 'tok-bo');

select pg_temp.chk('owner reads all feeds of own studio', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.instructor_calendar_feeds') = '2');
select pg_temp.chk('platform admin role reads the studio feeds', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a5', 'select count(*)::text from public.instructor_calendar_feeds') = '2');
select pg_temp.chk('instructor reads only their own feed', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a3', 'select string_agg(token, '','') from public.instructor_calendar_feeds') = 'tok-ana');
select pg_temp.chk('other staff role reads nothing', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', 'select count(*)::text from public.instructor_calendar_feeds') = '0');
select pg_temp.chk('other studio owner reads nothing', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', 'select count(*)::text from public.instructor_calendar_feeds') = '0');
select pg_temp.chk('anon reads nothing', coalesce(pg_temp.val_as('anon', null, 'select count(*)::text from public.instructor_calendar_feeds'), 'ERR') in ('0', 'ERR'));
select pg_temp.chk('other staff role cannot rotate a token', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', $q$with u as (update public.instructor_calendar_feeds set token = 'x' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('instructor cannot change their own token', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a3', $q$with u as (update public.instructor_calendar_feeds set token = 'x' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('owner can rotate', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.instructor_calendar_feeds set token = token || '-r' where instructor_id = 'e3000000-0000-4000-8000-0000000000a3' returning 1) select count(*)::text from u$q$) = '1');
select pg_temp.chk('policy set is exactly two', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'instructor_calendar_feeds') = 2);

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'ICS FEEDS SUITE PASS (% checks)', n; else raise exception 'ICS FEEDS SUITE FAIL: %', f; end if;
end $$;
