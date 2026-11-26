-- Event creator guard suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223160000 (apply it first).
-- Prints "EVENT CREATOR SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless
-- creatortest.local = 'on'. Never calls a function the caller lacks EXECUTE on.
begin;
do $$ begin
  if coalesce(current_setting('creatortest.local', true), '') <> 'on' then
    raise exception 'event creator suite refused: set creatortest.local = ''on'' only on a disposable local stack';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then json_build_object('role', p_role)::text else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create or replace function pg_temp.u(i int) returns uuid language sql as $$ select ('a7000000-0000-4000-8000-00000000000' || i)::uuid $$;

-- users: 1 owner and creator, 2 studio admin, 3 instructor, 4 front desk, 5 organizer staff, 6 other-studio owner, 7 organizer admin
insert into auth.users (id, email) select pg_temp.u(i), 'u' || i || '@creator.test' from generate_series(1, 7) i;
insert into public.profiles (id) select id from auth.users where email like '%@creator.test' on conflict do nothing;
insert into public.studios (id, name, slug, subscription_status) values
  ('a7100000-0000-4000-8000-00000000000a', 'CG A', 'cg-a', 'active'), ('a7100000-0000-4000-8000-00000000000b', 'CG B', 'cg-b', 'active');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u(1), 'a7100000-0000-4000-8000-00000000000a', 'studio_owner', true),
  (pg_temp.u(2), 'a7100000-0000-4000-8000-00000000000a', 'studio_admin', true),
  (pg_temp.u(3), 'a7100000-0000-4000-8000-00000000000a', 'instructor', true),
  (pg_temp.u(4), 'a7100000-0000-4000-8000-00000000000a', 'front_desk', true),
  (pg_temp.u(6), 'a7100000-0000-4000-8000-00000000000b', 'studio_owner', true);
insert into public.organizers (id, studio_id, name, slug) values ('a7200000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', 'CG Org', 'cg-org');
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('a7200000-0000-4000-8000-000000000001', pg_temp.u(5), 'organizer_staff', true),
  ('a7200000-0000-4000-8000-000000000001', pg_temp.u(7), 'organizer_admin', true);
-- E1 studio event with one booked private lesson, E2 organizer event (both created by user 1)
insert into public.events (id, studio_id, organizer_id, name, slug, status, visibility, start_date, end_date, created_by) values
  ('a7300000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', null, 'E1', 'cg-e1', 'published', 'public', '2027-03-01', '2027-03-01', pg_temp.u(1)),
  ('a7300000-0000-4000-8000-000000000002', 'a7100000-0000-4000-8000-00000000000a', 'a7200000-0000-4000-8000-000000000001', 'E2', 'cg-e2', 'published', 'public', '2027-03-01', '2027-03-01', pg_temp.u(1));
insert into public.event_guest_coaches (id, event_id, studio_id, name) values ('a7400000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', 'Coach');
insert into public.event_private_lesson_slots (id, event_id, coach_id, studio_id, starts_at, ends_at, status, buyer_name)
values ('a7500000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', 'a7400000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', '2027-03-01 10:00+00', '2027-03-01 10:45+00', 'booked', 'Fixture Buyer');

create or replace function pg_temp.creator(e int) returns uuid language sql as $$ select created_by from public.events where id = ('a7300000-0000-4000-8000-00000000000' || e)::uuid $$;
create or replace function pg_temp.take(p_role text, p_user uuid, p_event int, p_value text) returns text language sql as $$
  select pg_temp.val_as(p_role, p_user, format($q$with u as (update public.events set created_by = %s where id = 'a7300000-0000-4000-8000-00000000000%s' returning 1) select count(*)::text from u$q$, p_value, p_event)) $$;
-- a change attempt must be refused (by the guard or by row security) and leave the creator unchanged
create or replace function pg_temp.refused(p_label text, p_result text, p_event int) returns void language sql as $$
  select pg_temp.chk(p_label, (p_result = '0' or p_result like 'ERR 42501%') and pg_temp.creator(p_event) = pg_temp.u(1), p_result) $$;

-- 1. Nobody with a user session can change the creator.
select pg_temp.refused('instructor cannot take creator', pg_temp.take('authenticated', pg_temp.u(3), 1, quote_literal(pg_temp.u(3))), 1);
select pg_temp.chk('the instructor refusal comes from the guard', pg_temp.take('authenticated', pg_temp.u(3), 1, quote_literal(pg_temp.u(3))) like 'ERR 42501 The event creator cannot be changed.%');
select pg_temp.refused('front desk cannot take creator', pg_temp.take('authenticated', pg_temp.u(4), 1, quote_literal(pg_temp.u(4))), 1);
select pg_temp.refused('studio admin cannot take creator', pg_temp.take('authenticated', pg_temp.u(2), 1, quote_literal(pg_temp.u(2))), 1);
select pg_temp.refused('the owner/creator cannot hand it over', pg_temp.take('authenticated', pg_temp.u(1), 1, quote_literal(pg_temp.u(3))), 1);
select pg_temp.refused('creator cannot be cleared', pg_temp.take('authenticated', pg_temp.u(3), 1, 'null'), 1);
select pg_temp.refused('organizer staff cannot take creator', pg_temp.take('authenticated', pg_temp.u(5), 2, quote_literal(pg_temp.u(5))), 2);
select pg_temp.refused('organizer admin cannot take creator', pg_temp.take('authenticated', pg_temp.u(7), 2, quote_literal(pg_temp.u(7))), 2);
select pg_temp.refused('organizer staff cannot take a studio event', pg_temp.take('authenticated', pg_temp.u(5), 1, quote_literal(pg_temp.u(5))), 1);
select pg_temp.refused('another studio owner cannot take creator', pg_temp.take('authenticated', pg_temp.u(6), 1, quote_literal(pg_temp.u(6))), 1);
select pg_temp.refused('anon cannot change creator', pg_temp.take('anon', null, 1, 'null'), 1);
select pg_temp.chk('mixed update is refused as a whole', pg_temp.val_as('authenticated', pg_temp.u(3), format($q$update public.events set name = 'hijack', created_by = %L where id = 'a7300000-0000-4000-8000-000000000001' returning 'ok'$q$, pg_temp.u(3))) like 'ERR 42501%' and (select name from public.events where id = 'a7300000-0000-4000-8000-000000000001') = 'E1');
select pg_temp.chk('upsert cannot change creator', pg_temp.val_as('authenticated', pg_temp.u(3), format($q$insert into public.events (id, studio_id, name, slug, status, visibility, start_date, end_date, created_by) values ('a7300000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', 'E1', 'cg-e1', 'published', 'public', '2027-03-01', '2027-03-01', %L) on conflict (id) do update set created_by = excluded.created_by returning 'ok'$q$, pg_temp.u(3))) like 'ERR 42501%' and pg_temp.creator(1) = pg_temp.u(1));

-- 2. Subsequent access after the attempts: the attackers still cannot manage the private lessons; the creator can.
select pg_temp.chk('instructor cannot change a slot afterwards', pg_temp.val_as('authenticated', pg_temp.u(3), $q$with u as (update public.event_private_lesson_slots set buyer_name = 'x' where id = 'a7500000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('instructor cannot add a coach afterwards', pg_temp.val_as('authenticated', pg_temp.u(3), $q$insert into public.event_guest_coaches (event_id, studio_id, name) values ('a7300000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-00000000000a', 'x') returning 'ok'$q$) like 'ERR 42501%');
select pg_temp.chk('organizer staff cannot manage the studio event slots', pg_temp.val_as('authenticated', pg_temp.u(5), $q$with u as (update public.event_private_lesson_slots set buyer_name = 'x' where id = 'a7500000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('creator still manages (control)', pg_temp.val_as('authenticated', pg_temp.u(1), $q$with u as (update public.event_private_lesson_slots set location_label = 'x' where id = 'a7500000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '1');

-- 3. Ordinary editing and creation are unchanged.
select pg_temp.chk('instructor can still edit ordinary fields (unchanged policy)', pg_temp.val_as('authenticated', pg_temp.u(3), $q$with u as (update public.events set name = 'E1 edited' where id = 'a7300000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$) = '1');
select pg_temp.chk('writing the same creator back is allowed', pg_temp.val_as('authenticated', pg_temp.u(2), format($q$with u as (update public.events set created_by = %L, name = 'E1' where id = 'a7300000-0000-4000-8000-000000000001' returning 1) select count(*)::text from u$q$, pg_temp.u(1))) = '1');
create or replace function pg_temp.make(p_user uuid, p_n int, p_creator text) returns text language sql as $$
  select pg_temp.val_as('authenticated', p_user, format($q$insert into public.events (id, studio_id, name, slug, status, visibility, start_date, end_date, created_by) values ('a7300000-0000-4000-8000-00000000001%s', 'a7100000-0000-4000-8000-00000000000a', 'N', 'cg-n%s', 'draft', 'public', '2027-03-01', '2027-03-01', %s) returning 'ok'$q$, p_n, p_n, p_creator)) $$;
select pg_temp.chk('create with self as creator', pg_temp.make(pg_temp.u(2), 1, quote_literal(pg_temp.u(2))) = 'ok');
select pg_temp.chk('create with no creator', pg_temp.make(pg_temp.u(2), 2, 'null') = 'ok');
select pg_temp.chk('create naming someone else is refused', pg_temp.make(pg_temp.u(3), 3, quote_literal(pg_temp.u(1))) like 'ERR 42501 The event creator must be%');

-- 4. No service-role bypass; one explicit owner maintenance path.
select pg_temp.chk('service role cannot change creator', pg_temp.take('service_role', null, 1, quote_literal(pg_temp.u(2))) like 'ERR 42501%' and pg_temp.creator(1) = pg_temp.u(1));
select pg_temp.chk('service role cannot change creator even with the maintenance setting', pg_temp.val_as('service_role', null, format($q$with s as (select set_config('app.event_creator_maintenance', 'on', true)) update public.events set created_by = %L from s where id = 'a7300000-0000-4000-8000-000000000001' returning 'ok'$q$, pg_temp.u(2))) like 'ERR 42501%' and pg_temp.creator(1) = pg_temp.u(1));
select set_config('app.event_creator_maintenance', '', true);
select pg_temp.chk('service role ordinary update still works', pg_temp.val_as('service_role', null, $q$update public.events set name = 'E1' where id = 'a7300000-0000-4000-8000-000000000001' returning 'ok'$q$) = 'ok');
select pg_temp.chk('service role server insert may name a creator', pg_temp.val_as('service_role', null, format($q$insert into public.events (id, studio_id, name, slug, status, visibility, start_date, end_date, created_by) values ('a7300000-0000-4000-8000-000000000019', 'a7100000-0000-4000-8000-00000000000a', 'S', 'cg-s', 'draft', 'public', '2027-03-01', '2027-03-01', %L) returning 'ok'$q$, pg_temp.u(1))) = 'ok');
select pg_temp.chk('database owner without the setting is refused', pg_temp.val_as('postgres', null, format($q$update public.events set created_by = %L where id = 'a7300000-0000-4000-8000-000000000001' returning 'ok'$q$, pg_temp.u(2))) like 'ERR 42501%');
-- a definer function owned by the database owner, called by a signed-in user who also sets the maintenance setting
create function public.zz_creator_probe(p uuid) returns void language plpgsql security definer set search_path = public as $$
begin perform set_config('app.event_creator_maintenance', 'on', true); update public.events set created_by = p where id = 'a7300000-0000-4000-8000-000000000001'; end $$;
grant execute on function public.zz_creator_probe(uuid) to authenticated;
select pg_temp.chk('owner-run function cannot change creator for a signed-in caller', pg_temp.val_as('authenticated', pg_temp.u(3), format($q$select public.zz_creator_probe(%L)::text$q$, pg_temp.u(3))) like 'ERR 42501%' and pg_temp.creator(1) = pg_temp.u(1));
select set_config('app.event_creator_maintenance', 'on', true);
select pg_temp.chk('owner maintenance with the setting and no user session works', pg_temp.val_as('postgres', null, format($q$update public.events set created_by = %L where id = 'a7300000-0000-4000-8000-000000000001' returning 'ok'$q$, pg_temp.u(2))) = 'ok' and pg_temp.creator(1) = pg_temp.u(2));
select set_config('app.event_creator_maintenance', '', true);

-- 5. Catalog.
select pg_temp.chk('trigger present and enabled', exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'zz_protect_event_creator' and tgenabled = 'O'));
select pg_temp.chk('guard is not security definer', not (select prosecdef from pg_proc where oid = 'public.protect_event_creator()'::regprocedure));
select pg_temp.chk('service role and authenticated are not members of the table owner', not pg_has_role('service_role', (select relowner from pg_class where oid = 'public.events'::regclass), 'MEMBER') and not pg_has_role('authenticated', (select relowner from pg_class where oid = 'public.events'::regclass), 'MEMBER'));

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'EVENT CREATOR SUITE PASS (% checks)', n; else raise exception 'EVENT CREATOR SUITE FAIL: %', f; end if;
end $$;
