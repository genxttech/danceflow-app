-- G4 -- my_event_registrations event summary (migration 20270226091000): tenancy, authorization, column list.
--
-- Needs 20270222092000 plus 20270226091000. One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-00a4f0XXXXXX).
-- The final block ALWAYS raises, so nothing persists; its message is the verdict: "G4 SQL SUITE PASS (<n> checks)" or
-- "G4 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claims', case when p_user is null then '{}' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00a4f0000001', 'g4-a@example.test'),
  ('00000000-0000-0000-0000-00a4f0000002', 'g4-b@example.test');
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00a4f0000101', 'G4 Studio A', 'g4-sql-a'),
  ('00000000-0000-0000-0000-00a4f0000102', 'G4 Studio B', 'g4-sql-b');
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone, venue_name, city, state) values
  ('00000000-0000-0000-0000-00a4f0000201', '00000000-0000-0000-0000-00a4f0000101', 'G4 Private', 'g4-private', 'special_event', 'published', 'private', '2027-06-05', '2027-06-05', 'America/Chicago', 'Hall One', 'Austin', 'TX'),
  ('00000000-0000-0000-0000-00a4f0000202', '00000000-0000-0000-0000-00a4f0000101', 'G4 Draft', 'g4-draft', 'special_event', 'draft', 'private', '2027-07-05', '2027-07-05', 'America/Chicago', 'Hall Two', 'Austin', 'TX'),
  ('00000000-0000-0000-0000-00a4f0000203', '00000000-0000-0000-0000-00a4f0000102', 'G4 Other Private', 'g4-other', 'special_event', 'published', 'private', '2027-08-05', '2027-08-05', 'America/Chicago', 'Hall Three', 'Dallas', 'TX');

create or replace function pg_temp.reg(p_id uuid, p_event uuid, p_studio uuid, p_user uuid) returns void language sql as $$
  insert into public.event_registrations (id, event_id, studio_id, user_id, status, payment_status, quantity, unit_price, total_price, currency,
                                          registration_source, attendee_first_name, attendee_last_name, attendee_email, notes)
  values (p_id, p_event, p_studio, p_user, 'confirmed', 'paid', 1, 30, 30, 'USD', 'public_event_page', 'G4', 'Dancer', 'g4@example.test', 'studio-only note');
$$;
select pg_temp.reg('00000000-0000-0000-0000-00a4f0000301', '00000000-0000-0000-0000-00a4f0000201', '00000000-0000-0000-0000-00a4f0000101', '00000000-0000-0000-0000-00a4f0000001');
select pg_temp.reg('00000000-0000-0000-0000-00a4f0000302', '00000000-0000-0000-0000-00a4f0000202', '00000000-0000-0000-0000-00a4f0000101', '00000000-0000-0000-0000-00a4f0000001');
select pg_temp.reg('00000000-0000-0000-0000-00a4f0000303', '00000000-0000-0000-0000-00a4f0000203', '00000000-0000-0000-0000-00a4f0000102', '00000000-0000-0000-0000-00a4f0000002');
-- an unclaimed registration (no user_id) is nobody's
select pg_temp.reg('00000000-0000-0000-0000-00a4f0000304', '00000000-0000-0000-0000-00a4f0000203', '00000000-0000-0000-0000-00a4f0000102', null);

select pg_temp.chk('the column list is exactly the 20 existing columns followed by the 11 event summary columns',
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'my_event_registrations')
  = 'id,event_id,ticket_type_id,studio_id,user_id,status,payment_status,attendee_first_name,attendee_last_name,attendee_email,attendee_phone,quantity,unit_price,total_price,total_amount,currency,checked_in_at,cancelled_at,created_at,updated_at,event_name,event_slug,event_start_date,event_start_time,event_end_date,event_end_time,event_timezone,event_venue_name,event_city,event_state,event_status',
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'my_event_registrations'));

select pg_temp.chk('grants: authenticated has SELECT only; anon has nothing',
  has_table_privilege('authenticated', 'public.my_event_registrations', 'select')
  and not has_table_privilege('authenticated', 'public.my_event_registrations', 'insert')
  and not has_table_privilege('authenticated', 'public.my_event_registrations', 'update')
  and not has_table_privilege('authenticated', 'public.my_event_registrations', 'delete')
  and not has_table_privilege('anon', 'public.my_event_registrations', 'select'));

select pg_temp.as_user('00000000-0000-0000-0000-00a4f0000001');
set local role authenticated;
select pg_temp.chk('dancer A sees exactly their own two registrations',
  (select string_agg(id::text, ',' order by id) from public.my_event_registrations) = '00000000-0000-0000-0000-00a4f0000301,00000000-0000-0000-0000-00a4f0000302');
select pg_temp.chk('dancer A reads the summary of their private event',
  (select event_name || '|' || event_slug || '|' || event_start_date || '|' || event_venue_name || '|' || event_city || '|' || event_status
   from public.my_event_registrations where id = '00000000-0000-0000-0000-00a4f0000301') = 'G4 Private|g4-private|2027-06-05|Hall One|Austin|published');
select pg_temp.chk('a draft event gives its status and nothing else',
  (select event_status::text = 'draft' and event_name is null and event_slug is null and event_start_date is null and event_start_time is null and event_end_date is null
          and event_end_time is null and event_timezone is null and event_venue_name is null and event_city is null and event_state is null
   from public.my_event_registrations where id = '00000000-0000-0000-0000-00a4f0000302'));
select pg_temp.chk('dancer A cannot reach another dancer''s or another studio''s event through the view',
  not exists (select 1 from public.my_event_registrations where event_id = '00000000-0000-0000-0000-00a4f0000203' or event_name = 'G4 Other Private'));
select pg_temp.chk('the view grants no write',
  pg_temp.try($q$update public.my_event_registrations set status = 'cancelled' where id = '00000000-0000-0000-0000-00a4f0000301'$q$) <> 'ok'
  and pg_temp.try($q$delete from public.my_event_registrations where id = '00000000-0000-0000-0000-00a4f0000301'$q$) <> 'ok');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-00a4f0000002');
set local role authenticated;
select pg_temp.chk('dancer B sees only their own registration and its event',
  (select string_agg(id::text || ':' || event_name, ',') from public.my_event_registrations) = '00000000-0000-0000-0000-00a4f0000303:G4 Other Private');
reset role;

select pg_temp.as_user(null);
set local role authenticated;
select pg_temp.chk('no signed-in user: no rows', not exists (select 1 from public.my_event_registrations));
reset role;

set local role anon;
select pg_temp.chk('anon is refused', pg_temp.try('select count(*) from public.my_event_registrations') ilike '%permission denied%');
reset role;

do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'G4 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'G4 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;
