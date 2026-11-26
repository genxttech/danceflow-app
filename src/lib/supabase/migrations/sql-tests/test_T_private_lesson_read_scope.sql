-- Private-lesson read-scope suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223150000 (apply it first).
-- Prints "PRIVATE LESSON SCOPE SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless
-- plscope.local = 'on'. Never calls a function the caller lacks EXECUTE on (that segfaults some local images).
begin;
do $$ begin
  if coalesce(current_setting('plscope.local', true), '') <> 'on' then
    raise exception 'private lesson scope suite refused: set plscope.local = ''on'' only on a disposable local stack';
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

-- users: 1 creator, 2 owner (not creator), 3 front desk, 4 instructor, 5 other-studio owner, 6 organizer staff, 7 signed-in visitor,
--        8 platform admin, 9 former owner (inactive role)
insert into auth.users (id, email)
select ('d0000000-0000-4000-8000-00000000000' || i)::uuid, 'u' || i || '@plscope.test' from generate_series(1, 9) i;
insert into public.profiles (id) select id from auth.users where email like '%@plscope.test' on conflict do nothing;
-- publicly listed studios, so that the anonymous checks can fail without the migration
insert into public.studios (id, name, slug, subscription_status) values
  ('d1000000-0000-4000-8000-00000000000a', 'PL A', 'pl-a', 'active'),
  ('d1000000-0000-4000-8000-00000000000b', 'PL B', 'pl-b', 'active'),
  ('d1000000-0000-4000-8000-00000000000c', 'PL C', 'pl-c', 'canceled');
update public.profiles set platform_role = 'platform_admin' where id = 'd0000000-0000-4000-8000-000000000008';
update public.studios set active = true, public_directory_enabled = true where slug in ('pl-a', 'pl-b', 'pl-c');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('d0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', 'instructor', true),
  ('d0000000-0000-4000-8000-000000000009', 'd1000000-0000-4000-8000-00000000000a', 'studio_owner', false),
  ('d0000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('d0000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-00000000000c', 'studio_owner', true),
  ('d0000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('d0000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-00000000000a', 'instructor', true),
  ('d0000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-00000000000b', 'studio_owner', true);
insert into public.organizers (id, studio_id, name, slug) values ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', 'PL Org', 'pl-org');
insert into public.organizer_users (organizer_id, user_id, role, active) values ('d2000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000006', 'organizer_staff', true);

-- events: 1 studio public, 2 organizer public, 3 studio draft, 4 public event of a canceled studio
insert into public.events (id, studio_id, organizer_id, name, slug, event_type, status, visibility, start_date, end_date, created_by) values
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', null, 'E1', 'pl-e1', 'workshop', 'published', 'public', '2027-03-01', '2027-03-01', 'd0000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001', 'E2', 'pl-e2', 'workshop', 'published', 'public', '2027-03-01', '2027-03-01', 'd0000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-00000000000a', null, 'E3', 'pl-e3', 'workshop', 'draft', 'public', '2027-03-01', '2027-03-01', 'd0000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-00000000000c', null, 'E4', 'pl-e4', 'workshop', 'published', 'public', '2027-03-01', '2027-03-01', 'd0000000-0000-4000-8000-000000000001');
insert into public.event_guest_coaches (id, event_id, studio_id, organizer_id, name, active)
select ('d4000000-0000-4000-8000-00000000000' || right(e.id::text, 1))::uuid, e.id, e.studio_id, e.organizer_id, 'Coach ' || e.name, true from public.events e where e.slug like 'pl-e%';
insert into public.event_guest_coaches (id, event_id, studio_id, name, active) values ('d4000000-0000-4000-8000-000000000009', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', 'Inactive', false);
-- one booked slot per event, plus a cancelled one on E1
insert into public.event_private_lesson_slots (id, event_id, coach_id, studio_id, organizer_id, starts_at, ends_at, status, buyer_name, buyer_email)
select ('d5000000-0000-4000-8000-00000000000' || right(c.event_id::text, 1))::uuid, c.event_id, c.id, c.studio_id, c.organizer_id, '2027-03-01 10:00+00', '2027-03-01 10:45+00', 'booked', 'Fixture Buyer', 'buyer@plscope.test'
from public.event_guest_coaches c where c.active and c.id::text like 'd4000000%';
insert into public.event_private_lesson_slots (id, event_id, coach_id, studio_id, starts_at, ends_at, status)
values ('d5000000-0000-4000-8000-000000000009', 'd3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', '2027-03-01 11:00+00', '2027-03-01 11:45+00', 'cancelled');

-- visible fixture rows per user, as a sorted list of the event numbers (slots) and coach numbers
create or replace function pg_temp.slots(p_role text, p_user uuid) returns text language sql as $$
  select pg_temp.val_as(p_role, p_user, $q$select coalesce(string_agg(right(id::text, 1), '' order by id), '-') from public.event_private_lesson_slots where id::text like 'd5000000%'$q$) $$;
create or replace function pg_temp.coaches(p_role text, p_user uuid) returns text language sql as $$
  select pg_temp.val_as(p_role, p_user, $q$select coalesce(string_agg(right(id::text, 1), '' order by id), '-') from public.event_guest_coaches where id::text like 'd4000000%'$q$) $$;
create or replace function pg_temp.expect(p_label text, p_user int, p_slots text, p_coaches text) returns void language plpgsql as $$
declare u uuid := ('d0000000-0000-4000-8000-00000000000' || p_user)::uuid; s text; c text;
begin
  s := pg_temp.slots('authenticated', u); c := pg_temp.coaches('authenticated', u);
  perform pg_temp.chk(p_label || ': slots', s = p_slots, s);
  perform pg_temp.chk(p_label || ': coaches', c = p_coaches, c);
end $$;

-- 1. Visitors get nothing.
select pg_temp.chk('anon reads no slots', pg_temp.slots('anon', null) = '-', pg_temp.slots('anon', null));
select pg_temp.chk('anon reads no coaches', pg_temp.coaches('anon', null) = '-', pg_temp.coaches('anon', null));
select pg_temp.chk('anon reads no coach link column', pg_temp.val_as('anon', null, 'select count(schedule_token)::text from public.event_guest_coaches') = '0');
select pg_temp.chk('anon cannot change a slot', pg_temp.val_as('anon', null, $q$with u as (update public.event_private_lesson_slots set status = 'available' where id::text like 'd5000000%' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.expect('signed-in visitor', 7, '-', '-');
select pg_temp.expect('instructor of the studio', 4, '-', '-');
select pg_temp.expect('owner of another studio', 5, '-', '-');
select pg_temp.expect('former owner with an inactive role', 9, '-', '-');

-- 2. Event staff keep what they had: published public events of active studios, never cancelled slots or inactive coaches.
select pg_temp.expect('studio owner (not creator)', 2, '12', '12');
select pg_temp.expect('front desk: studio-hosted only', 3, '1', '1');
select pg_temp.expect('organizer staff: own organizer only', 6, '2', '2');
select pg_temp.expect('platform admin: listed events of active studios only', 8, '12', '12');

-- 3. The event creator keeps full manage access.
select pg_temp.expect('creator', 1, '12349', '12349');
select pg_temp.chk('creator reads buyer and link columns', pg_temp.val_as('authenticated', 'd0000000-0000-4000-8000-000000000001', $q$select s.buyer_name || ':' || (length(c.schedule_token) > 20)::text from public.event_private_lesson_slots s join public.event_guest_coaches c on c.id = s.coach_id where s.id = 'd5000000-0000-4000-8000-000000000001'$q$) = 'Fixture Buyer:true');
select pg_temp.chk('creator can update a slot', pg_temp.val_as('authenticated', 'd0000000-0000-4000-8000-000000000001', $q$with u as (update public.event_private_lesson_slots set location_label = 'x' where id = 'd5000000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '1');
select pg_temp.chk('creator can add a coach', pg_temp.val_as('authenticated', 'd0000000-0000-4000-8000-000000000001', $q$insert into public.event_guest_coaches (event_id, studio_id, name) values ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-00000000000a', 'New') returning 'ok'$q$) = 'ok');
select pg_temp.chk('creator can rotate a coach link', pg_temp.val_as('authenticated', 'd0000000-0000-4000-8000-000000000001', $q$with u as (update public.event_guest_coaches set schedule_token = default where id = 'd4000000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '1');
select pg_temp.chk('staff who did not create the event still cannot write', pg_temp.val_as('authenticated', 'd0000000-0000-4000-8000-000000000002', $q$with u as (update public.event_private_lesson_slots set location_label = 'y' where id = 'd5000000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('service role reads all fixtures', pg_temp.slots('service_role', null) = '12349');

-- 4. Catalog.
select pg_temp.chk('no read policy applies to anon or everyone', not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('event_guest_coaches', 'event_private_lesson_slots') and (roles && array['public', 'anon']::name[])));
select pg_temp.chk('exactly two policies per table', (select bool_and(n = 2) and count(*) = 2 from (select tablename, count(*) n from pg_policies where schemaname = 'public' and tablename in ('event_guest_coaches', 'event_private_lesson_slots') group by tablename) q));
select pg_temp.chk('row security still enabled', (select bool_and(relrowsecurity) from pg_class where oid in ('public.event_guest_coaches'::regclass, 'public.event_private_lesson_slots'::regclass)));
select pg_temp.chk('staff function not executable by anon', case when to_regprocedure('public.can_view_event_private_lessons(uuid)') is null then false else not has_function_privilege('anon', 'public.can_view_event_private_lessons(uuid)', 'execute') end);
select pg_temp.chk('staff function executable by authenticated and service role', case when to_regprocedure('public.can_view_event_private_lessons(uuid)') is null then false else has_function_privilege('authenticated', 'public.can_view_event_private_lessons(uuid)', 'execute') and has_function_privilege('service_role', 'public.can_view_event_private_lessons(uuid)', 'execute') end);

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'PRIVATE LESSON SCOPE SUITE PASS (% checks)', n; else raise exception 'PRIVATE LESSON SCOPE SUITE FAIL: %', f; end if;
end $$;
