-- get_class_roster_names_for_instructor (20270214120000) regression test.
--
-- Proves at the Postgres level, as `authenticated` with request.jwt.claims set:
--   1. the assigned instructor gets exactly id / first_name / last_name / attendee_status for their class's attendees;
--   2. a colleague instructor, another studio's instructor and the studio owner (not assigned) get zero rows;
--   3. a lesson appointment and a missing appointment id give zero rows;
--   4. an attendee row pointing at another studio's client is never returned;
--   5. reassigning the class moves access immediately; a deactivated instructor row or membership removes it;
--   6. anon cannot execute the function.
--
-- One transaction, rolled back at the end. Run on a DISPOSABLE local stack, for example:
--   docker exec -i <db container> psql -U postgres -v ON_ERROR_STOP=1 < this file
-- Deterministic UUID block reserved for this harness: 00000000-0000-0000-0000-0000007cXXXX.

begin;

set local session_replication_role = replica; -- plan seat and booking triggers are not under test

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000007c0001', 'Roster RPC Studio A', 't-roster-rpc-a'),
  ('00000000-0000-0000-0000-0000007c0002', 'Roster RPC Studio B', 't-roster-rpc-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000007c1001', 't-roster-assigned@example.test'),
  ('00000000-0000-0000-0000-0000007c1002', 't-roster-colleague@example.test'),
  ('00000000-0000-0000-0000-0000007c1003', 't-roster-other-studio@example.test'),
  ('00000000-0000-0000-0000-0000007c1004', 't-roster-owner@example.test');

insert into public.profiles (id, email)
select id, email from auth.users where id::text like '00000000-0000-0000-0000-0000007c1%';

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000007c1001', '00000000-0000-0000-0000-0000007c0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007c1002', '00000000-0000-0000-0000-0000007c0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000007c1003', '00000000-0000-0000-0000-0000007c0002', 'instructor', true),
  ('00000000-0000-0000-0000-0000007c1004', '00000000-0000-0000-0000-0000007c0001', 'studio_owner', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-0000007c2001', '00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c1001', 'Assigned', 'Teacher', true, true),
  ('00000000-0000-0000-0000-0000007c2002', '00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c1002', 'Colleague', 'Teacher', true, true),
  ('00000000-0000-0000-0000-0000007c2003', '00000000-0000-0000-0000-0000007c0002', '00000000-0000-0000-0000-0000007c1003', 'Other', 'Teacher', true, true);

insert into public.clients (id, studio_id, first_name, last_name, email, phone) values
  ('00000000-0000-0000-0000-0000007c3001', '00000000-0000-0000-0000-0000007c0001', 'Ana', 'Class', 'ana@example.test', '555-0001'),
  ('00000000-0000-0000-0000-0000007c3002', '00000000-0000-0000-0000-0000007c0001', 'Ben', 'Removed', 'ben@example.test', '555-0002'),
  ('00000000-0000-0000-0000-0000007c3003', '00000000-0000-0000-0000-0000007c0002', 'Bea', 'Elsewhere', 'bea@example.test', '555-0003');

insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000007c4001', '00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c2001', 'group_class', null, now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled'),
  ('00000000-0000-0000-0000-0000007c4002', '00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c2001', 'private_lesson', '00000000-0000-0000-0000-0000007c3001', now() + interval '2 days', now() + interval '2 days 1 hour', 'scheduled');

insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status, cancelled_at) values
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c4001', '00000000-0000-0000-0000-0000007c3001', 'staff', 'booked', null),
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c4001', '00000000-0000-0000-0000-0000007c3002', 'staff', 'cancelled', now()),
  -- Bad data: a studio A attendee row naming studio B's client. Must never surface.
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c4001', '00000000-0000-0000-0000-0000007c3003', 'staff', 'booked', null),
  -- Stray attendee row on a private lesson: the function is for group classes only, so this must not surface either.
  ('00000000-0000-0000-0000-0000007c0001', '00000000-0000-0000-0000-0000007c4002', '00000000-0000-0000-0000-0000007c3002', 'staff', 'booked', null);

set local session_replication_role = origin;

create temporary table roster_rpc_result (label text, rows int, detail text) on commit drop;
grant all on roster_rpc_result to authenticated, anon;

create or replace function pg_temp.as_user(target uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', target, 'role', 'authenticated')::text, true);
$$;

-- 1. assigned instructor
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1001');
set local role authenticated;
insert into roster_rpc_result
select 'assigned', count(*), string_agg(first_name || ' ' || last_name || ':' || attendee_status, ', ' order by first_name)
from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
insert into roster_rpc_result
select 'assigned_lesson', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4002');
insert into roster_rpc_result
select 'assigned_missing', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007cffff');
reset role;

-- 2. other callers
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1002');
set local role authenticated;
insert into roster_rpc_result select 'colleague', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1003');
set local role authenticated;
insert into roster_rpc_result select 'other_studio', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1004');
set local role authenticated;
insert into roster_rpc_result select 'owner_not_assigned', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;

-- 5. reassignment, deactivated instructor row, deactivated membership
set local session_replication_role = replica;
update public.appointments set instructor_id = '00000000-0000-0000-0000-0000007c2002' where id = '00000000-0000-0000-0000-0000007c4001';
set local session_replication_role = origin;
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1001');
set local role authenticated;
insert into roster_rpc_result select 'after_reassign_old', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1002');
set local role authenticated;
insert into roster_rpc_result select 'after_reassign_new', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;
set local session_replication_role = replica;
update public.appointments set instructor_id = '00000000-0000-0000-0000-0000007c2001' where id = '00000000-0000-0000-0000-0000007c4001';
update public.instructors set active = false where id = '00000000-0000-0000-0000-0000007c2001';
set local session_replication_role = origin;
select pg_temp.as_user('00000000-0000-0000-0000-0000007c1001');
set local role authenticated;
insert into roster_rpc_result select 'inactive_instructor_row', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;
set local session_replication_role = replica;
update public.instructors set active = true where id = '00000000-0000-0000-0000-0000007c2001';
update public.user_studio_roles set active = false where user_id = '00000000-0000-0000-0000-0000007c1001';
set local session_replication_role = origin;
set local role authenticated;
insert into roster_rpc_result select 'inactive_membership', count(*), null from public.get_class_roster_names_for_instructor('00000000-0000-0000-0000-0000007c4001');
reset role;

-- 6. anon
insert into roster_rpc_result
select 'anon_can_execute', has_function_privilege('anon', 'public.get_class_roster_names_for_instructor(uuid)', 'execute')::int, null;

-- Assertions
do $$
declare
  expected constant jsonb := jsonb_build_object(
    'assigned', 2, 'assigned_lesson', 0, 'assigned_missing', 0, 'colleague', 0, 'other_studio', 0, 'owner_not_assigned', 0,
    'after_reassign_old', 0, 'after_reassign_new', 2, 'inactive_instructor_row', 0, 'inactive_membership', 0, 'anon_can_execute', 0);
  r record;
  failures text := '';
begin
  for r in select * from roster_rpc_result loop
    if (expected ->> r.label)::int is distinct from r.rows then
      failures := failures || format('%s: expected %s rows, got %s; ', r.label, expected ->> r.label, r.rows);
    end if;
  end loop;
  if (select detail from roster_rpc_result where label = 'assigned') is distinct from 'Ana Class:booked, Ben Removed:cancelled' then
    failures := failures || format('assigned detail: %s; ', (select detail from roster_rpc_result where label = 'assigned'));
  end if;
  if (select count(*) from roster_rpc_result) <> 11 then
    failures := failures || 'not every case ran; ';
  end if;
  if failures <> '' then
    raise exception 'roster names RPC test FAILED: %', failures;
  end if;
  raise notice 'roster names RPC test PASSED (11 cases)';
end $$;

rollback;
