-- GC-3.4C -- self_enroll_class_attendee started-class + public-discoverability
-- guards, live-Postgres regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261025090000_gc34c_self_enroll_started_class_guard.sql. One transaction,
-- rolled back; synthetic rows only. now() is constant inside the transaction,
-- so "starts exactly now" is exact. Callers are simulated as the real
-- `authenticated` role with JWT claims (grants are exercised, not bypassed).
--
-- Deterministic UUID block: 00000000-0000-0000-0000-0000034cXXXX

begin;

-- ============================================================================
-- HELPERS
-- ============================================================================

-- Runs p_sql as `authenticated` for user p_sub; returns 'OK' or 'ERR:<message>'.
create function pg_temp.t34c_try(p_sub uuid, p_sql text) returns text
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql;
    execute 'reset role';
    return 'OK';
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
end $$;

create function pg_temp.t34c_expect(p_label text, p_got text, p_like text) returns void
language plpgsql as $$
begin
  if p_got not like p_like then
    raise exception 'FAIL % (expected like %, got %)', p_label, p_like, p_got;
  end if;
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.t34c_enroll_sql(p_appt text, p_client text, p_pkg text default null, p_mem text default null) returns text
language sql as $$
  select format(
    'select public.self_enroll_class_attendee(%L::uuid, %L::uuid, %s, %s)',
    p_appt, p_client,
    coalesce(quote_literal(p_pkg) || '::uuid', 'null'),
    coalesce(quote_literal(p_mem) || '::uuid', 'null')
  );
$$;

create function pg_temp.t34c_booked(p_appt text, p_client text) returns int
language sql as $$
  select count(*)::int from public.appointment_attendees
  where appointment_id = p_appt::uuid and client_id = p_client::uuid and status = 'booked';
$$;

-- ============================================================================
-- 0. CATALOG POSTURE (the applied candidate, nothing broader)
-- ============================================================================
do $$
declare r record;
begin
  select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig,
         md5(replace(p.prosrc, E'\r', '')) as body_md5,
         (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) as acl
    into r
    from pg_proc p where p.oid = 'public.self_enroll_class_attendee(uuid, uuid, uuid, uuid)'::regprocedure;
  if r.owner <> 'postgres' or not r.prosecdef or r.proconfig <> array['search_path=public']
     or r.body_md5 <> 'c5edafd4915060533faca30a9376e2d2'
     or r.acl <> 'authenticated=X/postgres,postgres=X/postgres' then
    raise exception 'FAIL T-gc34c-catalog-posture (%)', row_to_json(r);
  end if;
  if (select count(*) from pg_proc where proname = 'self_enroll_class_attendee') <> 1 then
    raise exception 'FAIL T-gc34c-single-overload';
  end if;
  raise notice 'PASS T-gc34c-catalog-posture';
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000034c0001', 'GC-3.4C Studio A', 't-gc34c-a'),
  ('00000000-0000-0000-0000-0000034c0002', 'GC-3.4C Studio B', 't-gc34c-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000034c1001', 't-gc34c-guardian@example.test'),   -- manages c1 (self), c2 (guardian), c6..c10
  ('00000000-0000-0000-0000-0000034c1002', 't-gc34c-viewonly@example.test'),   -- c3 without can_manage_bookings
  ('00000000-0000-0000-0000-0000034c1003', 't-gc34c-revoked@example.test'),    -- c4 disconnected
  ('00000000-0000-0000-0000-0000034c1004', 't-gc34c-owner@example.test');      -- studio A owner (staff path)

insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000034c1001', 't-gc34c-guardian@example.test'),
  ('00000000-0000-0000-0000-0000034c1002', 't-gc34c-viewonly@example.test'),
  ('00000000-0000-0000-0000-0000034c1003', 't-gc34c-revoked@example.test'),
  ('00000000-0000-0000-0000-0000034c1004', 't-gc34c-owner@example.test')
on conflict (id) do nothing;

insert into public.user_studio_roles (studio_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c1004', 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-0000034c2001', '00000000-0000-0000-0000-0000034c0001', 'Self', 'Dancer', 'active'),
  ('00000000-0000-0000-0000-0000034c2002', '00000000-0000-0000-0000-0000034c0001', 'Kid', 'Dependent', 'active'),
  ('00000000-0000-0000-0000-0000034c2003', '00000000-0000-0000-0000-0000034c0001', 'View', 'Only', 'active'),
  ('00000000-0000-0000-0000-0000034c2004', '00000000-0000-0000-0000-0000034c0001', 'Revoked', 'Link', 'active'),
  ('00000000-0000-0000-0000-0000034c2005', '00000000-0000-0000-0000-0000034c0001', 'Stranger', 'Client', 'active'),
  ('00000000-0000-0000-0000-0000034c2006', '00000000-0000-0000-0000-0000034c0001', 'Member', 'Dancer', 'active'),
  ('00000000-0000-0000-0000-0000034c2007', '00000000-0000-0000-0000-0000034c0001', 'Exhausted', 'Package', 'active'),
  ('00000000-0000-0000-0000-0000034c2008', '00000000-0000-0000-0000-0000034c0001', 'Cap', 'Filler', 'active'),
  ('00000000-0000-0000-0000-0000034c2009', '00000000-0000-0000-0000-0000034c0001', 'Cap', 'Blocked', 'active'),
  ('00000000-0000-0000-0000-0000034c200a', '00000000-0000-0000-0000-0000034c0001', 'Multi', 'Source', 'active'),
  ('00000000-0000-0000-0000-0000034c200b', '00000000-0000-0000-0000-0000034c0002', 'StudioB', 'Dancer', 'active');

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary) values
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2001', '00000000-0000-0000-0000-0000034c1001', 'linked', 'self', true, true),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2002', '00000000-0000-0000-0000-0000034c1001', 'linked', 'guardian', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2006', '00000000-0000-0000-0000-0000034c1001', 'linked', 'parent', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2007', '00000000-0000-0000-0000-0000034c1001', 'linked', 'dependent_manager', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2008', '00000000-0000-0000-0000-0000034c1001', 'linked', 'guardian', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2009', '00000000-0000-0000-0000-0000034c1001', 'linked', 'guardian', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c200a', '00000000-0000-0000-0000-0000034c1001', 'linked', 'guardian', true, false),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2003', '00000000-0000-0000-0000-0000034c1002', 'linked', 'self', false, true),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2004', '00000000-0000-0000-0000-0000034c1003', 'disconnected', 'self', true, false),
  ('00000000-0000-0000-0000-0000034c0002', '00000000-0000-0000-0000-0000034c200b', '00000000-0000-0000-0000-0000034c1001', 'linked', 'self', true, true);

-- Classes (studio A unless noted). All self-enrollment ON + discoverable unless noted.
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', null),    -- future, unlimited
  ('00000000-0000-0000-0000-0000034c4002', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now(), now() + interval '1 hour', null),                                  -- starts exactly now
  ('00000000-0000-0000-0000-0000034c4003', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() - interval '10 minutes', now() + interval '50 minutes', null),     -- started
  ('00000000-0000-0000-0000-0000034c4004', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', null), -- past
  ('00000000-0000-0000-0000-0000034c4005', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'cancelled', now() + interval '2 days', now() + interval '2 days 1 hour', null),    -- cancelled
  ('00000000-0000-0000-0000-0000034c4006', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '3 days', now() + interval '3 days 1 hour', null),    -- NOT discoverable
  ('00000000-0000-0000-0000-0000034c4007', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '4 days', now() + interval '4 days 1 hour', null),    -- self-enrollment OFF
  ('00000000-0000-0000-0000-0000034c4008', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '5 days', now() + interval '5 days 1 hour', 1),       -- capacity 1
  ('00000000-0000-0000-0000-0000034c4009', '00000000-0000-0000-0000-0000034c0002', 'group_class', 'scheduled', now() + interval '1 day', now() + interval '1 day 1 hour', null),    -- studio B
  ('00000000-0000-0000-0000-0000034c400a', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '6 days', now() + interval '6 days 1 hour', null),    -- multi-source
  ('00000000-0000-0000-0000-0000034c400b', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '7 days', now() + interval '7 days 1 hour', null),    -- dependent / package tests
  ('00000000-0000-0000-0000-0000034c400c', '00000000-0000-0000-0000-0000034c0001', 'group_class', 'scheduled', now() + interval '8 days', now() + interval '8 days 1 hour', null);    -- no policy row

insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, created_by) values
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4001', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4002', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4003', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4004', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4005', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4006', false, true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4007', true,  false, array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c4008', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0002', '00000000-0000-0000-0000-0000034c4009', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c400a', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004'),
  ('00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c400b', true,  true,  array['package','membership']::text[], '00000000-0000-0000-0000-0000034c1004');

-- Packages: c1 finite (2 left), c2 finite (1 left), c7 exhausted, c8/c9 unlimited,
-- c10 one package + one membership (two candidates), studio-B package for c-B.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active) values
  ('00000000-0000-0000-0000-0000034c5001', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2001', 'T-gc34c Pack 2', true),
  ('00000000-0000-0000-0000-0000034c5002', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2002', 'T-gc34c Pack 1', true),
  ('00000000-0000-0000-0000-0000034c5007', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2007', 'T-gc34c Empty', true),
  ('00000000-0000-0000-0000-0000034c5008', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2008', 'T-gc34c Unlimited', true),
  ('00000000-0000-0000-0000-0000034c5009', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2009', 'T-gc34c Unlimited', true),
  ('00000000-0000-0000-0000-0000034c500a', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c200a', 'T-gc34c Multi Pack', true),
  ('00000000-0000-0000-0000-0000034c500b', '00000000-0000-0000-0000-0000034c0002', '00000000-0000-0000-0000-0000034c200b', 'T-gc34c Studio B Pack', true);

insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-0000034c5101', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c5001', 'group_class', 2, 0, 2, false),
  ('00000000-0000-0000-0000-0000034c5102', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c5002', 'group_class', 1, 0, 1, false),
  ('00000000-0000-0000-0000-0000034c5107', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c5007', 'group_class', 1, 1, 0, false),
  ('00000000-0000-0000-0000-0000034c5108', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c5008', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-0000034c5109', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c5009', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-0000034c510a', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c500a', 'group_class', null, 0, null, true),
  ('00000000-0000-0000-0000-0000034c510b', '00000000-0000-0000-0000-0000034c0002', '00000000-0000-0000-0000-0000034c500b', 'group_class', null, 0, null, true);

insert into public.membership_plans (id, studio_id, name, active) values
  ('00000000-0000-0000-0000-0000034c6001', '00000000-0000-0000-0000-0000034c0001', 'T-gc34c Unlimited Plan', true);
insert into public.membership_plan_benefits (id, membership_plan_id, benefit_type, quantity, applies_to) values
  ('00000000-0000-0000-0000-0000034c6002', '00000000-0000-0000-0000-0000034c6001', 'unlimited_group_classes', null, 'group_class');
insert into public.client_memberships (
  id, studio_id, client_id, membership_plan_id, status, name_snapshot,
  starts_on, current_period_start, current_period_end, billing_interval_snapshot
) values
  ('00000000-0000-0000-0000-0000034c6106', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c2006', '00000000-0000-0000-0000-0000034c6001', 'active', 'T-gc34c Unlimited Plan', current_date, current_date, current_date + 30, 'monthly'),
  ('00000000-0000-0000-0000-0000034c610a', '00000000-0000-0000-0000-0000034c0001', '00000000-0000-0000-0000-0000034c200a', '00000000-0000-0000-0000-0000034c6001', 'active', 'T-gc34c Unlimited Plan', current_date, current_date, current_date + 30, 'monthly');

-- ============================================================================
-- TESTS
-- ============================================================================
do $$
declare
  u_g constant uuid := '00000000-0000-0000-0000-0000034c1001';
  u_view constant uuid := '00000000-0000-0000-0000-0000034c1002';
  u_rev constant uuid := '00000000-0000-0000-0000-0000034c1003';
  u_owner constant uuid := '00000000-0000-0000-0000-0000034c1004';
  r text;
  v_used numeric;
begin
  -- 1 / 8. future, discoverable, open class + authorized self relationship enrolls (finite package auto-selected).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-01-future-public-class-self-enrolls', r, 'OK');
  if pg_temp.t34c_booked('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2001') <> 1 then
    raise exception 'FAIL T-gc34c-01-row';
  end if;

  -- 17. valid package funding: the booked row carries the package; nothing is debited at enrollment.
  select quantity_used into v_used from public.client_package_items where id = '00000000-0000-0000-0000-0000034c5101';
  if v_used <> 0 or not exists (
    select 1 from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-0000034c4001' and client_id = '00000000-0000-0000-0000-0000034c2001'
      and billing_type = 'package_credit' and client_package_id = '00000000-0000-0000-0000-0000034c5001' and source = 'self_service'
  ) then
    raise exception 'FAIL T-gc34c-17-package-funding-no-debit-at-enrollment';
  end if;
  raise notice 'PASS T-gc34c-17-package-funding-no-debit-at-enrollment';

  -- 2. starts exactly now -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4002', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-02-starts-now-refused', r, 'ERR:GC34C_CLASS_STARTED%');

  -- 3. already started -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4003', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-03-started-refused', r, 'ERR:GC34C_CLASS_STARTED%');

  -- 4. past / ended -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4004', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-04-past-refused', r, 'ERR:GC34C_CLASS_STARTED%');

  -- 5. cancelled (future) -> still refused by the existing locked trigger.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4005', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-05-cancelled-refused', r, 'ERR:GCSC3_CLASS_CANCELLED%');

  -- 6. not publicly discoverable -> refused, same message as a disabled policy (no separate signal).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4006', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-06-not-discoverable-refused', r, 'ERR:This class is not open for self-enrollment.');

  -- 7. self-enrollment disabled -> refused (identical message).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4007', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-07-self-enrollment-off-refused', r, 'ERR:This class is not open for self-enrollment.');

  -- no policy row at all -> refused (fails closed).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c400c', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-no-policy-row-refused', r, 'ERR:This class is not open for self-enrollment.');

  -- 2 (authz). guardian-managed dependent enrolls (finite package with 1 left).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c400b', '00000000-0000-0000-0000-0000034c2002'));
  perform pg_temp.t34c_expect('T-gc34c-guardian-dependent-enrolls', r, 'OK');

  -- 9. view-only relationship -> refused.
  r := pg_temp.t34c_try(u_view, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2003'));
  perform pg_temp.t34c_expect('T-gc34c-09-view-only-refused', r, 'ERR:Not authorized%');

  -- 10. disconnected relationship -> refused.
  r := pg_temp.t34c_try(u_rev, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2004'));
  perform pg_temp.t34c_expect('T-gc34c-10-revoked-refused', r, 'ERR:Not authorized%');

  -- 11. other-studio client into a studio-A class -> refused (the link is in studio B).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c200b'));
  perform pg_temp.t34c_expect('T-gc34c-11-other-studio-client-refused', r, 'ERR:Not authorized%');

  -- 11b. studio-A client into a studio-B class (wrong-studio occurrence) -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4009', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-11b-wrong-studio-occurrence-refused', r, 'ERR:Not authorized%');

  -- 12. arbitrary (unlinked) client -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2005'));
  perform pg_temp.t34c_expect('T-gc34c-12-arbitrary-client-refused', r, 'ERR:Not authorized%');

  -- Privacy order: an UNAUTHORIZED caller on a started or non-discoverable class
  -- learns only "Not authorized" -- never started/discoverable state.
  r := pg_temp.t34c_try(u_view, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4003', '00000000-0000-0000-0000-0000034c2003'));
  perform pg_temp.t34c_expect('T-gc34c-unauthorized-started-no-oracle', r, 'ERR:Not authorized%');
  r := pg_temp.t34c_try(u_view, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4006', '00000000-0000-0000-0000-0000034c2003'));
  perform pg_temp.t34c_expect('T-gc34c-unauthorized-hidden-no-oracle', r, 'ERR:Not authorized%');

  -- 13. duplicate active enrollment -> refused as already enrolled, still one row.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2001'));
  perform pg_temp.t34c_expect('T-gc34c-13-duplicate-already-enrolled', r, 'ERR:You are already enrolled in this class.');
  if pg_temp.t34c_booked('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2001') <> 1 then
    raise exception 'FAIL T-gc34c-13-single-row';
  end if;

  -- 14. finite capacity: first seat ok, second refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4008', '00000000-0000-0000-0000-0000034c2008'));
  perform pg_temp.t34c_expect('T-gc34c-14a-capacity-first-seat', r, 'OK');
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4008', '00000000-0000-0000-0000-0000034c2009'));
  perform pg_temp.t34c_expect('T-gc34c-14b-capacity-full-refused', r, 'ERR:This class has no available seats remaining.');

  -- 16. null capacity stays unlimited (c8 also enrolls into the unlimited class).
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2008'));
  perform pg_temp.t34c_expect('T-gc34c-16-null-capacity-unlimited', r, 'OK');

  -- 18. exhausted package -> no eligible funding.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2007'));
  perform pg_temp.t34c_expect('T-gc34c-18-exhausted-package-refused', r, 'ERR:No eligible package or membership found for this class.');

  -- 19. valid membership funding.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c4001', '00000000-0000-0000-0000-0000034c2006'));
  perform pg_temp.t34c_expect('T-gc34c-19-membership-enrolls', r, 'OK');
  if not exists (
    select 1 from public.appointment_attendees
    where appointment_id = '00000000-0000-0000-0000-0000034c4001' and client_id = '00000000-0000-0000-0000-0000034c2006'
      and billing_type = 'membership' and client_membership_id = '00000000-0000-0000-0000-0000034c6106'
  ) then
    raise exception 'FAIL T-gc34c-19-membership-row';
  end if;

  -- 20. another studio's entitlement (multi-source client chooses studio B's package) -> refused.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c400a', '00000000-0000-0000-0000-0000034c200a', '00000000-0000-0000-0000-0000034c500b'));
  perform pg_temp.t34c_expect('T-gc34c-20-other-studio-entitlement-refused', r, 'ERR:Selected package is not an eligible funding source for this class.');
  -- multi-source with no choice -> explicit choice required; with its own valid choice -> ok.
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c400a', '00000000-0000-0000-0000-0000034c200a'));
  perform pg_temp.t34c_expect('T-gc34c-multi-source-choice-required', r, 'ERR:A single funding source choice is required.');
  r := pg_temp.t34c_try(u_g, pg_temp.t34c_enroll_sql('00000000-0000-0000-0000-0000034c400a', '00000000-0000-0000-0000-0000034c200a', null, '00000000-0000-0000-0000-0000034c610a'));
  perform pg_temp.t34c_expect('T-gc34c-multi-source-valid-choice-enrolls', r, 'OK');

  -- 21. staff enrollment after the class started remains allowed (staff path untouched).
  r := pg_temp.t34c_try(u_owner, format(
    'select public.enroll_class_attendee(%L::uuid, %L::uuid, %L, %L::uuid, null)',
    '00000000-0000-0000-0000-0000034c4003', '00000000-0000-0000-0000-0000034c2009', 'package_credit', '00000000-0000-0000-0000-0000034c5009'));
  perform pg_temp.t34c_expect('T-gc34c-21-staff-walk-in-after-start-allowed', r, 'OK');

  -- 15. final-seat serialization stays structural: the roster trigger still locks the
  --     appointment row before counting (two concurrent sessions are not available in
  --     a single-transaction harness; the 14a/14b sequence above exercises the count).
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.appointment_attendees'::regclass
      and t.tgname = 'appointment_attendees_enforce_roster_capacity' and not t.tgisinternal
  ) or position('for update' in (select prosrc from pg_proc where oid = 'public.enforce_group_class_roster_capacity()'::regprocedure)) = 0 then
    raise exception 'FAIL T-gc34c-15-capacity-lock-structure';
  end if;
  raise notice 'PASS T-gc34c-15-capacity-lock-structure';

  -- 22. portal self-enrollment for a future class is unchanged: same RPC, same
  --     success and the same pre-existing error vocabulary (covered by 01, 13, 14b, 18).
  raise notice 'PASS T-gc34c-22-portal-future-class-unchanged';
end $$;

rollback;
