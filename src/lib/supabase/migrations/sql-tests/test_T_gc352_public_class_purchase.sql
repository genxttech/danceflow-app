-- GC-3.5-2 -- public paid Group Class acquisition holds + database authority,
-- live-Postgres regression suite.
--
-- Run via `supabase db query --linked --file <this file>` against DEV AFTER
-- 20261026090000_gc352_public_class_purchase_holds.sql. One transaction, rolled
-- back; synthetic rows only. now() is constant inside the transaction, so expiry
-- is simulated by moving expires_at (the owner may; the transition guard only
-- freezes identity, price and Stripe ids). Purchasers are simulated as the real
-- `authenticated` role with JWT claims (session_id included, so
-- my_verified_email() runs its real checks); server calls as `service_role`.
-- Verified identities are produced through the real LAUNCH-SEC-1C-A functions.
--
-- Final-seat contention: this single-session suite proves the serialization
-- path structurally and sequentially (O). The true two-session race is the
-- separate harness concurrency/run_gc352_concurrency.sh.
--
-- Deterministic UUID block: 00000000-0000-0000-0000-0000035bXXXX

begin;

-- ============================================================================
-- HELPERS
-- ============================================================================
create function pg_temp.t_claims(p_sub text, p_sid text, p_role text default 'authenticated') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role, 'session_id', p_sid)::text, true);
end $$;

-- Runs p_sql (must return one text column, or nothing) as p_role; 'OK[:value]' or 'ERR:<message>'.
create function pg_temp.t_run(p_role text, p_sub text, p_sid text, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.t_claims(p_sub, p_sid, p_role);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v;
    execute 'reset role';
    return 'OK' || coalesce(':' || v, '');
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
end $$;

create function pg_temp.t_user(n int) returns text language sql as $$
  select '00000000-0000-0000-0000-0000035b1' || lpad(n::text, 3, '0'); $$;
create function pg_temp.t_sid(n int) returns text language sql as $$
  select '00000000-0000-0000-0000-0000035b3' || lpad(n::text, 3, '0'); $$;

create function pg_temp.t_start(n int, p_appt text, p_first text default 'Ada', p_last text default 'Lovelace', p_phone text default null) returns text
language sql as $$
  select pg_temp.t_run('authenticated', pg_temp.t_user(n), pg_temp.t_sid(n), format(
    'select hold_id::text || '','' || reused::text from public.start_public_class_purchase(%L::uuid, %L, %L, %L)',
    p_appt, p_first, p_last, p_phone));
$$;

create function pg_temp.t_attach(p_hold text, p_acct text, p_cs text, p_exp timestamptz default now() + interval '30 minutes') returns text
language sql as $$
  select pg_temp.t_run('service_role', null, null, format(
    'select hold_id::text || '','' || expires_at::text from public.attach_public_class_purchase_checkout(%L::uuid, %L, %L, %L::timestamptz)',
    p_hold, p_acct, p_cs, p_exp));
$$;

create function pg_temp.t_finalize(p_hold text, p_acct text, p_cs text, p_pi text, p_cents int, p_cur text default 'usd') returns text
language sql as $$
  select pg_temp.t_run('service_role', null, null, format(
    'select outcome || '','' || coalesce(conflict_reason, ''-'') || '','' || coalesce(client_id::text, ''-'') || '','' || coalesce(link_id::text, ''-'') || '','' || coalesce(attendee_id::text, ''-'') || '','' || coalesce(payment_id::text, ''-'') from public.finalize_public_class_purchase(%L::uuid, %L, %L, %L, %s, %L)',
    p_hold, p_acct, p_cs, p_pi, p_cents, p_cur));
$$;

create function pg_temp.t_release(n int, p_hold text) returns text
language sql as $$
  select pg_temp.t_run('authenticated', pg_temp.t_user(n), pg_temp.t_sid(n), format(
    'select hold_status from public.release_public_class_purchase(%L::uuid)', p_hold));
$$;

create temp table t_results (n serial primary key, label text not null);

create function pg_temp.t_pass(p_label text) returns void
language plpgsql as $$
begin
  insert into t_results (label) values (p_label);
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.t_expect(p_label text, p_got text, p_like text) returns void
language plpgsql as $$
begin
  if p_got is null or p_got not like p_like then
    raise exception 'FAIL % (expected like %, got %)', p_label, p_like, p_got;
  end if;
  perform pg_temp.t_pass(p_label);
end $$;

create function pg_temp.t_ok(p_label text, p_cond boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL % (%)', p_label, coalesce(p_detail, 'condition false');
  end if;
  perform pg_temp.t_pass(p_label);
end $$;

-- hold id from a t_start result 'OK:<uuid>,<reused>'
create function pg_temp.t_hid(p_res text) returns text language sql as $$
  select split_part(substr(p_res, 4), ',', 1); $$;

create temp table t_h (k text primary key, v text);
grant all on t_h to authenticated, service_role;

-- ============================================================================
-- 0. CATALOG POSTURE
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
           (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('start_public_class_purchase', 'release_public_class_purchase',
      'attach_public_class_purchase_checkout', 'finalize_public_class_purchase', '_group_class_roster_reserved_count')
  loop
    if r.owner <> 'postgres' or not r.prosecdef or r.proconfig <> array['search_path=public'] then
      raise exception 'FAIL T-gc352-catalog-definer (%)', row_to_json(r);
    end if;
    if r.proname in ('start_public_class_purchase', 'release_public_class_purchase')
       and r.acl <> 'authenticated=X/postgres,postgres=X/postgres' then
      raise exception 'FAIL T-gc352-catalog-acl-user (%)', row_to_json(r);
    end if;
    if r.proname in ('attach_public_class_purchase_checkout', 'finalize_public_class_purchase')
       and r.acl <> 'postgres=X/postgres,service_role=X/postgres' then
      raise exception 'FAIL T-gc352-catalog-acl-service (%)', row_to_json(r);
    end if;
    if r.proname = '_group_class_roster_reserved_count' and r.acl <> 'postgres=X/postgres' then
      raise exception 'FAIL T-gc352-catalog-acl-reserved (%)', row_to_json(r);
    end if;
  end loop;
  if (select relrowsecurity from pg_class where oid = 'public.group_class_enrollment_holds'::regclass) is not true then
    raise exception 'FAIL T-gc352-rls-enabled';
  end if;
  if has_table_privilege('authenticated', 'public.group_class_enrollment_holds', 'INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('anon', 'public.group_class_enrollment_holds', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('service_role', 'public.group_class_enrollment_holds', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'FAIL T-gc352-table-privileges';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.group_class_enrollment_holds'::regclass and polcmd <> 'r') then
    raise exception 'FAIL T-gc352-no-write-policies';
  end if;
  perform pg_temp.t_pass('T-gc352-catalog-posture');
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================
insert into public.studios (id, name, slug, stripe_connected_account_id, public_directory_enabled, subscription_status) values
  ('00000000-0000-0000-0000-0000035b0001', 'GC-3.5-2 Studio A', 't-gc352-a', 'acct_gc352StudioA', true, 'active'),
  ('00000000-0000-0000-0000-0000035b0002', 'GC-3.5-2 Studio B', 't-gc352-b', 'acct_gc352StudioB', true, 'active'),
  ('00000000-0000-0000-0000-0000035b0003', 'GC-3.5-2 Studio C', 't-gc352-c', null, true, 'active');

-- Users 1..13; all verified + bound except 3 (unverified) and 11 (staff owner).
insert into auth.users (id, email)
  select pg_temp.t_user(n)::uuid, 't-gc352-u' || n || '@example.test' from generate_series(1, 13) n;
insert into public.profiles (id, email)
  select pg_temp.t_user(n)::uuid, 't-gc352-u' || n || '@example.test' from generate_series(1, 13) n
on conflict (id) do nothing;
-- proof sessions (35b2NNN, before binding) and live sessions (35b3NNN, at binding time)
insert into auth.sessions (id, user_id, created_at, updated_at)
  select ('00000000-0000-0000-0000-0000035b2' || lpad(n::text, 3, '0'))::uuid, pg_temp.t_user(n)::uuid, now() - interval '1 minute', now()
  from generate_series(1, 13) n where n not in (3, 11);
insert into auth.sessions (id, user_id, created_at, updated_at)
  select pg_temp.t_sid(n)::uuid, pg_temp.t_user(n)::uuid, now(), now() from generate_series(1, 13) n;
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
  select gen_random_uuid(), ('00000000-0000-0000-0000-0000035b2' || lpad(n::text, 3, '0'))::uuid, now(), now(), 'otp'
  from generate_series(1, 13) n where n not in (3, 11);
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
  select gen_random_uuid(), pg_temp.t_sid(n)::uuid, now(), now(), 'password' from generate_series(1, 13) n;

do $$
declare n int; r text;
begin
  for n in select g from generate_series(1, 13) g where g not in (3, 11) loop
    perform pg_temp.t_claims(pg_temp.t_user(n), '00000000-0000-0000-0000-0000035b2' || lpad(n::text, 3, '0'));
    set local role authenticated;
    r := public.record_email_proof_web();
    reset role;
    if r <> 'binding_required' then raise exception 'FIXTURE proof %: %', n, r; end if;
    if not public.complete_email_binding(pg_temp.t_user(n)::uuid, ('00000000-0000-0000-0000-0000035b2' || lpad(n::text, 3, '0'))::uuid) then
      raise exception 'FIXTURE binding % failed', n;
    end if;
  end loop;
end $$;

insert into public.user_studio_roles (studio_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000035b0001', pg_temp.t_user(11)::uuid, 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000035b4001', '00000000-0000-0000-0000-0000035b0001', 'Ada', 'Older', 't-gc352-u1@example.test', 'active'), -- same email as u1, unlinked
  ('00000000-0000-0000-0000-0000035b4004', '00000000-0000-0000-0000-0000035b0001', 'Linked', 'Four', 't-gc352-u4@example.test', 'active'),
  ('00000000-0000-0000-0000-0000035b4005', '00000000-0000-0000-0000-0000035b0001', 'Invited', 'Five', 't-gc352-u5@example.test', 'active'),
  ('00000000-0000-0000-0000-0000035b4006', '00000000-0000-0000-0000-0000035b0001', 'Enrolled', 'Six', 't-gc352-u6@example.test', 'active'),
  ('00000000-0000-0000-0000-0000035b4012', '00000000-0000-0000-0000-0000035b0001', 'Kid', 'Twelve', null, 'active');

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary) values
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b4004', pg_temp.t_user(4)::uuid, 'linked', 'self', true, true),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b4012', pg_temp.t_user(12)::uuid, 'linked', 'guardian', true, false);

-- Classes: studio A unless noted; scheduled, 2 days out unless noted.
insert into public.appointments (id, studio_id, appointment_type, status, starts_at, ends_at, roster_capacity) values
  ('00000000-0000-0000-0000-0000035b6001', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 3),    -- K01 main
  ('00000000-0000-0000-0000-0000035b6002', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K02 not discoverable
  ('00000000-0000-0000-0000-0000035b6003', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K03 self-enroll off
  ('00000000-0000-0000-0000-0000035b6004', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K04 package only
  ('00000000-0000-0000-0000-0000035b6005', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K05 price 12.345
  ('00000000-0000-0000-0000-0000035b6006', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'cancelled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K06 cancelled
  ('00000000-0000-0000-0000-0000035b6007', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '20 minutes', now() + interval '80 minutes', null), -- K07 inside cutoff
  ('00000000-0000-0000-0000-0000035b6008', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 1),    -- K08 one seat
  ('00000000-0000-0000-0000-0000035b6009', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K09 cancelled after payment
  ('00000000-0000-0000-0000-0000035b6010', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K10 expired beyond grace
  ('00000000-0000-0000-0000-0000035b6011', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K11 already enrolled
  ('00000000-0000-0000-0000-0000035b6012', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K12 mid-payment self link
  ('00000000-0000-0000-0000-0000035b6013', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 5),    -- K13 release
  ('00000000-0000-0000-0000-0000035b6014', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K14 within grace
  ('00000000-0000-0000-0000-0000035b6015', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K15 released then paid
  ('00000000-0000-0000-0000-0000035b6016', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 1),    -- K16 seat lost in grace
  ('00000000-0000-0000-0000-0000035b6017', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K17 guardian conflict
  ('00000000-0000-0000-0000-0000035b6018', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K18 price changes after hold
  ('00000000-0000-0000-0000-0000035b6019', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K19 direct payment disabled after hold
  ('00000000-0000-0000-0000-0000035b6020', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K20 PaymentIntent binding
  ('00000000-0000-0000-0000-0000035b6021', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', 4),    -- K21 expired-row semantics
  ('00000000-0000-0000-0000-0000035b6022', '00000000-0000-0000-0000-0000035b0001', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- K22 hidden / cancelled after hold
  ('00000000-0000-0000-0000-0000035b6101', '00000000-0000-0000-0000-0000035b0002', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null), -- KB1 studio B
  ('00000000-0000-0000-0000-0000035b6201', '00000000-0000-0000-0000-0000035b0003', 'group_class', 'scheduled', now() + interval '2 days', now() + interval '2 days 1 hour', null); -- KC1 no Stripe account

insert into public.group_class_enrollment_policies (studio_id, appointment_id, publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount)
select s, a, d, se, f, amt from (values
  ('00000000-0000-0000-0000-0000035b0001'::uuid, '00000000-0000-0000-0000-0000035b6001'::uuid, true,  true,  array['package','direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6002', false, true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6003', true,  false, array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6004', true,  true,  array['package'], null),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6005', true,  true,  array['direct_payment'], 12.345),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6006', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6007', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6008', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6009', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6010', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6011', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6012', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6013', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6014', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6015', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6016', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6017', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6018', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6019', true,  true,  array['package','direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6020', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6021', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6022', true,  true,  array['direct_payment'], 25.00),
  ('00000000-0000-0000-0000-0000035b0002', '00000000-0000-0000-0000-0000035b6101', true,  true,  array['direct_payment'], 40.00),
  ('00000000-0000-0000-0000-0000035b0003', '00000000-0000-0000-0000-0000035b6201', true,  true,  array['direct_payment'], 25.00)
) v(s, a, d, se, f, amt);

-- C06 is already booked into K11 (staff path).
insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6011', '00000000-0000-0000-0000-0000035b4006', 'booked', 'staff', 'free_comped');

-- ============================================================================
-- A-H. START ELIGIBILITY
-- ============================================================================
select pg_temp.t_expect('A unverified user cannot start', pg_temp.t_start(3, '00000000-0000-0000-0000-0000035b6001'), 'ERR:GC35_EMAIL_UNVERIFIED:%');
select pg_temp.t_expect('A no session claim = unverified', pg_temp.t_run('authenticated', pg_temp.t_user(1), null,
  'select hold_id::text from public.start_public_class_purchase(''00000000-0000-0000-0000-0000035b6001''::uuid, ''Ada'', ''L'')'), 'ERR:GC35_EMAIL_UNVERIFIED:%');
select pg_temp.t_expect('A anon cannot execute start', pg_temp.t_run('anon', null, null,
  'select hold_id::text from public.start_public_class_purchase(''00000000-0000-0000-0000-0000035b6001''::uuid, ''Ada'', ''L'')'), 'ERR:permission denied%');
select pg_temp.t_expect('B linked (self) studio user refused', pg_temp.t_start(4, '00000000-0000-0000-0000-0000035b6001'), 'ERR:GC35_ALREADY_LINKED:%');
select pg_temp.t_expect('B linked (guardian-only) studio user refused', pg_temp.t_start(12, '00000000-0000-0000-0000-0000035b6001'), 'ERR:GC35_ALREADY_LINKED:%');
select pg_temp.t_expect('C non-public class denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6002'), 'ERR:GC35_CLASS_UNAVAILABLE:%');
select pg_temp.t_expect('C unknown class gives the same answer', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6fff'), 'ERR:GC35_CLASS_UNAVAILABLE:%');
select pg_temp.t_expect('D self-enrollment disabled denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6003'), 'ERR:GC35_SELF_ENROLLMENT_CLOSED:%');
select pg_temp.t_expect('E direct payment not accepted denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6004'), 'ERR:GC35_DIRECT_PAYMENT_UNAVAILABLE:%');
select pg_temp.t_expect('F sub-cent price denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6005'), 'ERR:GC35_DIRECT_PAYMENT_UNAVAILABLE:%');
select pg_temp.t_expect('F studio without a connected account denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6201'), 'ERR:GC35_DIRECT_PAYMENT_UNAVAILABLE:%');
select pg_temp.t_expect('G cancelled class denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6006'), 'ERR:GC35_CLASS_CANCELLED:%');
select pg_temp.t_expect('H class inside the 30-minute cutoff denied', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6007'), 'ERR:GC35_CHECKOUT_CUTOFF:%');
select pg_temp.t_expect('input blank name refused', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6001', '   ', 'L'), 'ERR:GC35_NAME_INVALID:%');
select pg_temp.t_expect('input bad phone refused', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6001', 'Ada', 'L', 'call me'), 'ERR:GC35_PHONE_INVALID:%');
select pg_temp.t_ok('A-H refusals created no hold rows', (select count(*) from public.group_class_enrollment_holds) = 0);

-- ============================================================================
-- J/K/X. CREATE, ONE-ACTIVE, REUSE, SNAPSHOT
-- ============================================================================
insert into t_h values ('u1k01', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6001', '  Ada   May ', ' Lovelace ', ' +1 (555) 010-2030 '));
select pg_temp.t_expect('J start creates a hold', (select v from t_h where k = 'u1k01'), 'OK:%,false');
do $$
declare h record;
begin
  select * into h from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid;
  perform pg_temp.t_ok('X snapshot normalized names/phone', h.dancer_first_name = 'Ada May' and h.dancer_last_name = 'Lovelace' and h.dancer_phone = '+1 (555) 010-2030', row_to_json(h)::text);
  perform pg_temp.t_ok('X server-derived studio, user, verified email', h.studio_id = '00000000-0000-0000-0000-0000035b0001'
    and h.purchaser_user_id = pg_temp.t_user(1)::uuid and h.purchaser_email = 't-gc352-u1@example.test', row_to_json(h)::text);
  perform pg_temp.t_ok('price snapshot in integer cents, USD, 30-minute hold', h.amount_cents = 2500 and h.currency = 'usd'
    and h.status = 'held' and h.expires_at = now() + interval '30 minutes' and h.attempt_count = 0, row_to_json(h)::text);
end $$;

-- K: reuse returns the same hold, unchanged snapshot, and never extends expiry.
update public.group_class_enrollment_holds set expires_at = now() + interval '5 minutes'
  where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid;
insert into t_h values ('u1k01b', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6001', 'Different', 'Name'));
select pg_temp.t_ok('K repeat start reuses the same hold', (select v from t_h where k = 'u1k01b') = 'OK:' || pg_temp.t_hid((select v from t_h where k = 'u1k01')) || ',true');
select pg_temp.t_ok('K reuse does not extend expiry or change the snapshot', exists (
  select 1 from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid
    and expires_at = now() + interval '5 minutes' and dancer_first_name = 'Ada May'));
select pg_temp.t_ok('J exactly one active hold for (class, purchaser)', (select count(*) from public.group_class_enrollment_holds
  where appointment_id = '00000000-0000-0000-0000-0000035b6001' and purchaser_user_id = pg_temp.t_user(1)::uuid and status in ('held', 'converting')) = 1);
do $$
begin
  begin
    insert into public.group_class_enrollment_holds (studio_id, appointment_id, purchaser_user_id, purchaser_email, dancer_first_name, dancer_last_name, amount_cents, expires_at)
    values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6001', pg_temp.t_user(1)::uuid, 'x@example.test', 'X', 'Y', 2500, now() + interval '30 minutes');
    raise exception 'FAIL J unique index allowed a second active hold';
  exception when unique_violation then
    perform pg_temp.t_pass('J database refuses a second active hold (unique index)');
  end;
end $$;

-- ============================================================================
-- M/N/O. CAPACITY
-- ============================================================================
insert into t_h values ('u1k08', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6008'));
select pg_temp.t_expect('M hold on the last seat', (select v from t_h where k = 'u1k08'), 'OK:%');
select pg_temp.t_ok('M live hold counts toward capacity', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6008') = 1);
select pg_temp.t_ok('M public spots_remaining inherits the hold', (select spots_remaining from public.public_group_class_occurrences(null, null, '00000000-0000-0000-0000-0000035b6008', 1)) = 0
  and (select availability from public.public_group_class_occurrences(null, null, '00000000-0000-0000-0000-0000035b6008', 1)) = 'full');
select pg_temp.t_expect('O second purchaser refused for the held final seat', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6008'), 'ERR:GC35_CLASS_FULL:%');
do $$
begin
  begin
    insert into public.appointment_attendees (studio_id, appointment_id, client_id, status, source, billing_type)
    values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6008', '00000000-0000-0000-0000-0000035b4005', 'booked', 'staff', 'free_comped');
    raise exception 'FAIL M staff enrollment took a held seat';
  exception when others then
    if sqlerrm <> 'This class has no available seats remaining.' then raise; end if;
    perform pg_temp.t_pass('M staff enrollment cannot take a held seat (roster trigger counts holds)');
  end;
end $$;
do $$
begin
  begin
    update public.appointments set roster_capacity = 0 where id = '00000000-0000-0000-0000-0000035b6008';
    raise exception 'FAIL M capacity lowered below a live hold';
  exception when others then
    if sqlerrm <> 'GCSC3_CAPACITY_BELOW_BOOKED: Maximum students cannot be lower than the 1 seats already booked or reserved.' then raise; end if;
    perform pg_temp.t_pass('M capacity floor counts live holds and says booked or reserved');
  end;
end $$;
-- O (structural): both start and the roster trigger lock the class row FOR UPDATE before counting.
select pg_temp.t_ok('O start locks the class row before counting', (select prosrc ~* 'from public\.appointments a\s+where a\.id = p_appointment_id\s+for update'
  from pg_proc where oid = 'public.start_public_class_purchase(uuid,text,text,text)'::regprocedure));
select pg_temp.t_ok('O roster trigger locks the same row', (select prosrc ~* 'from public\.appointments\s+where id = new\.appointment_id\s+for update'
  from pg_proc where oid = 'public.enforce_group_class_roster_capacity()'::regprocedure));

update public.group_class_enrollment_holds set expires_at = now() - interval '1 second'
  where id = pg_temp.t_hid((select v from t_h where k = 'u1k08'))::uuid;
select pg_temp.t_ok('N expired hold no longer counts', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6008') = 0
  and (select spots_remaining from public.public_group_class_occurrences(null, null, '00000000-0000-0000-0000-0000035b6008', 1)) = 1);
insert into t_h values ('u2k08', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6008'));
select pg_temp.t_expect('N seat is available again after expiry', (select v from t_h where k = 'u2k08'), 'OK:%,false');

-- ============================================================================
-- L. EXPIRED HOLD REPLACEMENT
-- ============================================================================
-- u1's expired K08 hold has no checkout: replaced (old row released). Capacity is now held by u2 -> full.
select pg_temp.t_expect('L expired hold replaced but class now full', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6008'), 'ERR:GC35_CLASS_FULL:%');
insert into t_h values ('u2k13', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6013'));
update public.group_class_enrollment_holds set expires_at = now() - interval '1 minute' where id = pg_temp.t_hid((select v from t_h where k = 'u2k13'))::uuid;
insert into t_h values ('u2k13b', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6013'));
select pg_temp.t_ok('L expired hold without checkout is released and replaced',
  pg_temp.t_hid((select v from t_h where k = 'u2k13b')) <> pg_temp.t_hid((select v from t_h where k = 'u2k13'))
  and (select status from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u2k13'))::uuid) = 'released');
-- with a checkout attached and still inside the grace: payment may settle -> refused
select pg_temp.t_expect('attach K13 replacement hold', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u2k13b')), 'acct_gc352StudioA', 'cs_test_gc352_k13'), 'OK:%');
update public.group_class_enrollment_holds set expires_at = now() - interval '5 minutes' where id = pg_temp.t_hid((select v from t_h where k = 'u2k13b'))::uuid;
select pg_temp.t_expect('L expired hold with checkout inside grace is not replaced', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6013'), 'ERR:GC35_PAYMENT_PENDING:%');
update public.group_class_enrollment_holds set expires_at = now() - interval '11 minutes' where id = pg_temp.t_hid((select v from t_h where k = 'u2k13b'))::uuid;
insert into t_h values ('u2k13c', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6013'));
select pg_temp.t_ok('L expired hold with checkout beyond grace is replaced',
  (select v from t_h where k = 'u2k13c') like 'OK:%,false'
  and (select status from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u2k13b'))::uuid) = 'released');

-- ============================================================================
-- P/Q/R/I. ATTACH CHECKOUT
-- ============================================================================
select pg_temp.t_expect('P attach with another studio''s account denied', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioB', 'cs_test_gc352_k01'), 'ERR:GC35_ACCOUNT_MISMATCH:%');
select pg_temp.t_expect('P attach with an unknown account denied', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_somethingElse', 'cs_test_gc352_k01'), 'ERR:GC35_ACCOUNT_MISMATCH:%');
select pg_temp.t_expect('attach rejects malformed ids', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'not-a-session'), 'ERR:GC35_INPUT_INVALID:%');
select pg_temp.t_expect('attach rejects an over-long checkout window', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', now() + interval '2 hours'), 'ERR:GC35_CHECKOUT_EXPIRY_INVALID:%');
select pg_temp.t_expect('attach a valid checkout', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01'), 'OK:%');
select pg_temp.t_ok('attach aligns expiry with checkout and counts one attempt', exists (
  select 1 from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid
    and expires_at = now() + interval '30 minutes' and attempt_count = 1 and stripe_account_id = 'acct_gc352StudioA'));
select pg_temp.t_expect('attach same session again is idempotent', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01'), 'OK:%');
select pg_temp.t_ok('idempotent attach does not add an attempt', (select attempt_count from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid) = 1);
select pg_temp.t_expect('Q session substitution on the same hold denied', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_other'), 'ERR:GC35_CHECKOUT_ALREADY_ATTACHED:%');
select pg_temp.t_expect('R a session already used by another hold denied', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u2k08')), 'acct_gc352StudioA', 'cs_test_gc352_k01'), 'ERR:GC35_SESSION_IN_USE:%');
select pg_temp.t_expect('attach to an expired hold denied', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u1k08')), 'acct_gc352StudioA', 'cs_test_gc352_k08x'), 'ERR:GC35_HOLD_EXPIRED:%');

insert into t_h values ('u13kb1', pg_temp.t_start(13, '00000000-0000-0000-0000-0000035b6101'));
select pg_temp.t_ok('I hold studio is derived from the class (studio B)', (select studio_id from public.group_class_enrollment_holds
  where id = pg_temp.t_hid((select v from t_h where k = 'u13kb1'))::uuid) = '00000000-0000-0000-0000-0000035b0002'
  and (select amount_cents from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u13kb1'))::uuid) = 4000);
select pg_temp.t_expect('I studio B hold cannot attach studio A account', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u13kb1')), 'acct_gc352StudioA', 'cs_test_gc352_kb1'), 'ERR:GC35_ACCOUNT_MISMATCH:%');
select pg_temp.t_expect('I studio B hold attaches its own account', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u13kb1')), 'acct_gc352StudioB', 'cs_test_gc352_kb1'), 'OK:%');

-- ============================================================================
-- S/T/U/V. FINALIZE IDENTITY CHECKS (no writes on mismatch)
-- ============================================================================
select pg_temp.t_expect('S finalize wrong account denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioB', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500), 'ERR:GC35_ACCOUNT_MISMATCH:%');
select pg_temp.t_expect('T finalize wrong session denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_kb1', 'pi_test_gc352_k01', 2500), 'ERR:GC35_SESSION_MISMATCH:%');
select pg_temp.t_expect('T finalize on a hold with no checkout denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k08')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500), 'ERR:GC35_%_MISMATCH:%');
select pg_temp.t_expect('U finalize wrong amount denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2501), 'ERR:GC35_AMOUNT_MISMATCH:%');
select pg_temp.t_expect('U finalize dollars-not-cents denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 25), 'ERR:GC35_AMOUNT_MISMATCH:%');
select pg_temp.t_expect('V finalize wrong currency denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500, 'eur'), 'ERR:GC35_CURRENCY_MISMATCH:%');
select pg_temp.t_expect('finalize unknown hold', pg_temp.t_finalize('00000000-0000-0000-0000-0000035b9999', 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500), 'ERR:GC35_HOLD_NOT_FOUND:%');
select pg_temp.t_ok('S-V mismatches wrote nothing', (select status from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid) = 'held'
  and not exists (select 1 from public.payments where studio_id = '00000000-0000-0000-0000-0000035b0001'));

-- ============================================================================
-- W/X/Y/AA/AB. SUCCESSFUL FINALIZE
-- ============================================================================
insert into t_h values ('fin_u1k01', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500, 'USD'));
select pg_temp.t_expect('W finalize converts', (select v from t_h where k = 'fin_u1k01'), 'OK:converted,-,%');
do $$
declare
  v_res text[] := string_to_array(substr((select v from t_h where k = 'fin_u1k01'), 4), ',');
  h record; c record; l record; a record; p record;
begin
  select * into h from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid;
  select * into c from public.clients where id = v_res[3]::uuid;
  select * into l from public.client_account_links where id = v_res[4]::uuid;
  select * into a from public.appointment_attendees where id = v_res[5]::uuid;
  select * into p from public.payments where id = v_res[6]::uuid;
  perform pg_temp.t_ok('W hold converted with result ids', h.status = 'converted' and h.client_id = c.id and h.link_id = l.id
    and h.attendee_id = a.id and h.payment_id = p.id and h.stripe_payment_intent_id = 'pi_test_gc352_k01', row_to_json(h)::text);
  perform pg_temp.t_ok('W/X active client from the hold snapshot', c.studio_id = '00000000-0000-0000-0000-0000035b0001'
    and c.status = 'active' and c.first_name = 'Ada May' and c.last_name = 'Lovelace' and c.email = 't-gc352-u1@example.test'
    and c.phone = '+1 (555) 010-2030' and c.portal_user_id is null, row_to_json(c)::text);
  perform pg_temp.t_ok('W self link by construction', l.user_id = pg_temp.t_user(1)::uuid and l.client_id = c.id and l.studio_id = c.studio_id
    and l.status = 'linked' and l.relationship_type = 'self' and l.can_manage_bookings and l.is_primary and l.initiated_by = 'dancer', row_to_json(l)::text);
  perform pg_temp.t_ok('W paid booked attendee', a.appointment_id = '00000000-0000-0000-0000-0000035b6001' and a.client_id = c.id
    and a.status = 'booked' and a.billing_type = 'pay_as_you_go' and a.payment_status = 'paid' and a.source = 'self_service'
    and a.price_amount = 25.00, row_to_json(a)::text);
  perform pg_temp.t_ok('W canonical paid online payment', p.studio_id = c.studio_id and p.client_id = c.id and p.status = 'paid'
    and p.payment_channel = 'online' and p.payment_method = 'card' and p.source = 'stripe' and p.amount = 25.00 and p.currency = 'usd'
    and p.refund_amount = 0 and p.platform_fee_amount = 0 and p.stripe_account_id = 'acct_gc352StudioA'
    and p.stripe_checkout_session_id = 'cs_test_gc352_k01' and p.stripe_payment_intent_id = 'pi_test_gc352_k01'
    and p.external_reference = a.id::text and p.appointment_id = a.appointment_id
    and p.client_request_id = 'gc35_hold:' || h.id::text, row_to_json(p)::text);
end $$;
select pg_temp.t_ok('W converted hold no longer counts; the attendee does', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6001') = 1);
select pg_temp.t_ok('Y no email auto-match: the older same-email client is untouched and unlinked',
  (select count(*) from public.clients where studio_id = '00000000-0000-0000-0000-0000035b0001' and email = 't-gc352-u1@example.test') = 2
  and not exists (select 1 from public.client_account_links where client_id = '00000000-0000-0000-0000-0000035b4001')
  and not exists (select 1 from public.appointment_attendees where client_id = '00000000-0000-0000-0000-0000035b4001'));
select pg_temp.t_expect('AA replay returns the same converted result', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_k01', 2500), (select v from t_h where k = 'fin_u1k01'));
select pg_temp.t_ok('AA/AB replay created nothing new', (select count(*) from public.clients where studio_id = '00000000-0000-0000-0000-0000035b0001') = 6
  and (select count(*) from public.client_account_links where user_id = pg_temp.t_user(1)::uuid) = 1
  and (select count(*) from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000035b6001') = 1
  and (select count(*) from public.payments where client_request_id = 'gc35_hold:' || pg_temp.t_hid((select v from t_h where k = 'u1k01'))) = 1);
select pg_temp.t_expect('AB replay with a different payment intent denied', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u1k01')), 'acct_gc352StudioA', 'cs_test_gc352_k01', 'pi_test_gc352_other', 2500), 'ERR:GC35_PAYMENT_INTENT_MISMATCH:%');
select pg_temp.t_expect('B purchaser is now linked; a second public purchase is refused', pg_temp.t_start(1, '00000000-0000-0000-0000-0000035b6012'), 'ERR:GC35_ALREADY_LINKED:%');

-- ============================================================================
-- Z. SELF LINK ACQUIRED WHILE PAYING -> reused, no new client
-- ============================================================================
insert into t_h values ('u5k12', pg_temp.t_start(5, '00000000-0000-0000-0000-0000035b6012', 'Five', 'Buyer'));
select pg_temp.t_expect('Z attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u5k12')), 'acct_gc352StudioA', 'cs_test_gc352_k12'), 'OK:%');
insert into public.client_account_links (id, studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary, initiated_by)
values ('00000000-0000-0000-0000-0000035b5005', '00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b4005', pg_temp.t_user(5)::uuid, 'linked', 'self', true, true, 'studio');
insert into t_h values ('fin_u5k12', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u5k12')), 'acct_gc352StudioA', 'cs_test_gc352_k12', 'pi_test_gc352_k12', 2500));
select pg_temp.t_expect('Z existing self link reused (no new client, same link)', (select v from t_h where k = 'fin_u5k12'),
  'OK:converted,-,00000000-0000-0000-0000-0000035b4005,00000000-0000-0000-0000-0000035b5005,%');
select pg_temp.t_ok('Z no client created from the snapshot', not exists (select 1 from public.clients where first_name = 'Five' and last_name = 'Buyer')
  and (select count(*) from public.client_account_links where user_id = pg_temp.t_user(5)::uuid) = 1);

-- ============================================================================
-- AC/AD/AE/AF/AG/AH + extra conflicts
-- ============================================================================
-- AC: class cancelled after payment
insert into t_h values ('u7k09', pg_temp.t_start(7, '00000000-0000-0000-0000-0000035b6009', 'Seven', 'Buyer'));
select pg_temp.t_expect('AC attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u7k09')), 'acct_gc352StudioA', 'cs_test_gc352_k09'), 'OK:%');
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-0000035b6009';
insert into t_h values ('fin_u7k09', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u7k09')), 'acct_gc352StudioA', 'cs_test_gc352_k09', 'pi_test_gc352_k09', 2500));
select pg_temp.t_expect('AC cancelled-after-payment is a conflict', (select v from t_h where k = 'fin_u7k09'), 'OK:conflict,class_cancelled,-,-,-,%');

-- AD: expired beyond grace; and within grace still converts
insert into t_h values ('u8k10', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6010', 'Eight', 'Buyer'));
select pg_temp.t_expect('AD attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u8k10')), 'acct_gc352StudioA', 'cs_test_gc352_k10'), 'OK:%');
update public.group_class_enrollment_holds set expires_at = now() - interval '11 minutes' where id = pg_temp.t_hid((select v from t_h where k = 'u8k10'))::uuid;
insert into t_h values ('fin_u8k10', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u8k10')), 'acct_gc352StudioA', 'cs_test_gc352_k10', 'pi_test_gc352_k10', 2500));
select pg_temp.t_expect('AD expired beyond grace is a conflict', (select v from t_h where k = 'fin_u8k10'), 'OK:conflict,hold_expired,-,-,-,%');

insert into t_h values ('u9k14', pg_temp.t_start(9, '00000000-0000-0000-0000-0000035b6014', 'Nine', 'Buyer'));
select pg_temp.t_expect('grace attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u9k14')), 'acct_gc352StudioA', 'cs_test_gc352_k14'), 'OK:%');
update public.group_class_enrollment_holds set expires_at = now() - interval '9 minutes' where id = pg_temp.t_hid((select v from t_h where k = 'u9k14'))::uuid;
select pg_temp.t_expect('payment inside the reconciliation grace still converts', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u9k14')), 'acct_gc352StudioA', 'cs_test_gc352_k14', 'pi_test_gc352_k14', 2500), 'OK:converted,%');

-- AE: enrolled through another path while paying (self link to an already-booked client)
insert into t_h values ('u6k11', pg_temp.t_start(6, '00000000-0000-0000-0000-0000035b6011', 'Six', 'Buyer'));
select pg_temp.t_expect('AE attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u6k11')), 'acct_gc352StudioA', 'cs_test_gc352_k11'), 'OK:%');
insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary, initiated_by)
values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b4006', pg_temp.t_user(6)::uuid, 'linked', 'self', true, true, 'studio');
insert into t_h values ('fin_u6k11', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u6k11')), 'acct_gc352StudioA', 'cs_test_gc352_k11', 'pi_test_gc352_k11', 2500));
select pg_temp.t_expect('AE already-enrolled payment is a conflict', (select v from t_h where k = 'fin_u6k11'), 'OK:conflict,already_enrolled,-,-,-,%');

-- Guardian link acquired while paying -> not a self relationship -> conflict
insert into t_h values ('u10k17', pg_temp.t_start(10, '00000000-0000-0000-0000-0000035b6017', 'Ten', 'Buyer'));
select pg_temp.t_expect('guardian attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u10k17')), 'acct_gc352StudioA', 'cs_test_gc352_k17'), 'OK:%');
insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, can_manage_bookings, is_primary, initiated_by)
values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b4012', pg_temp.t_user(10)::uuid, 'linked', 'guardian', true, false, 'studio');
select pg_temp.t_expect('AM a non-self relationship acquired while paying is a conflict', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u10k17')), 'acct_gc352StudioA', 'cs_test_gc352_k17', 'pi_test_gc352_k17', 2500), 'OK:conflict,linked_relationship_conflict,-,-,-,%');

-- Seat lost during the grace -> class_full conflict (roster trigger refusal mapped)
insert into t_h values ('u13k16', pg_temp.t_start(13, '00000000-0000-0000-0000-0000035b6016', 'Thirteen', 'Buyer'));
select pg_temp.t_expect('k16 attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u13k16')), 'acct_gc352StudioA', 'cs_test_gc352_k16'), 'OK:%');
update public.group_class_enrollment_holds set expires_at = now() - interval '2 minutes' where id = pg_temp.t_hid((select v from t_h where k = 'u13k16'))::uuid;
insert into t_h values ('u2k16', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6016', 'Two', 'Buyer'));
select pg_temp.t_expect('k16 seat taken by another purchaser after expiry', (select v from t_h where k = 'u2k16'), 'OK:%');
select pg_temp.t_expect('late payment for a lost seat is a class_full conflict', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u13k16')), 'acct_gc352StudioA', 'cs_test_gc352_k16', 'pi_test_gc352_k16', 2500), 'OK:conflict,class_full,-,-,-,%');
select pg_temp.t_ok('class_full conflict rolled back the conversion (no client/link/attendee)', not exists (select 1 from public.clients where first_name = 'Thirteen')
  and not exists (select 1 from public.client_account_links where user_id = pg_temp.t_user(13)::uuid)
  and (select count(*) from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000035b6016') = 0);

-- Released hold then paid -> hold_released conflict
insert into t_h values ('u10k15', pg_temp.t_start(10, '00000000-0000-0000-0000-0000035b6015', 'Ten', 'Buyer'));
-- (u10 is now guardian-linked from the test above, so start is refused; use a fresh purchaser)
select pg_temp.t_expect('linked guardian can no longer start', (select v from t_h where k = 'u10k15'), 'ERR:GC35_ALREADY_LINKED:%');
insert into t_h values ('u2k15', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6015', 'Two', 'Buyer'));
select pg_temp.t_expect('released attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u2k15')), 'acct_gc352StudioA', 'cs_test_gc352_k15'), 'OK:%');
select pg_temp.t_expect('AI release own hold', pg_temp.t_release(2, pg_temp.t_hid((select v from t_h where k = 'u2k15'))), 'OK:released');
select pg_temp.t_expect('release is idempotent', pg_temp.t_release(2, pg_temp.t_hid((select v from t_h where k = 'u2k15'))), 'OK:released');
select pg_temp.t_expect('payment on a released hold is a hold_released conflict', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k15')), 'acct_gc352StudioA', 'cs_test_gc352_k15', 'pi_test_gc352_k15', 2500), 'OK:conflict,hold_released,-,-,-,%');

-- AF/AG/AH: conflict evidence
do $$
declare r record;
begin
  for r in
    select h.id, h.status, h.conflict_reason, h.client_id, h.link_id, h.attendee_id, p.status as pay_status, p.amount, p.client_id as pay_client,
           p.guest_name, p.stripe_payment_intent_id as pay_pi, p.stripe_checkout_session_id as pay_cs, p.payment_channel, p.external_reference,
           h.stripe_payment_intent_id, h.stripe_checkout_session_id, h.appointment_id
    from public.group_class_enrollment_holds h
    join public.payments p on p.id = h.payment_id
    where h.status = 'conflict'
  loop
    if not (r.pay_status = 'paid' and r.amount = 25.00 and r.pay_client is null and r.guest_name is not null
            and r.pay_pi = r.stripe_payment_intent_id and r.pay_cs = r.stripe_checkout_session_id
            and r.payment_channel = 'online' and r.external_reference is null) then
      raise exception 'FAIL AF truthful paid accounting for conflict %', row_to_json(r);
    end if;
    if r.client_id is not null or r.link_id is not null or r.attendee_id is not null then
      raise exception 'FAIL AH conflict hold carries client/link/attendee %', row_to_json(r);
    end if;
    if not exists (
      select 1 from public.accounting_entries ae
      join public.group_class_enrollment_holds h2 on h2.payment_id = ae.source_id
      where h2.id = r.id and ae.source_table = 'payments' and ae.client_id is null
        and ae.entry_type = 'revenue' and ae.category = 'group_class_revenue' and ae.gross_amount = 25.00
        and ae.voided_at is null
    ) then
      raise exception 'FAIL AF clientless conflict payment has no live accounting entry %', row_to_json(r);
    end if;
  end loop;
  perform pg_temp.t_ok('AF six conflicts, each with a paid payment and no client', (select count(*) from public.group_class_enrollment_holds where status = 'conflict') = 6);
end $$;
select pg_temp.t_ok('AG conflicts created no enrollment', (select count(*) from public.appointment_attendees where appointment_id in (
  '00000000-0000-0000-0000-0000035b6009', '00000000-0000-0000-0000-0000035b6010', '00000000-0000-0000-0000-0000035b6015',
  '00000000-0000-0000-0000-0000035b6016', '00000000-0000-0000-0000-0000035b6017')) = 0
  and (select count(*) from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000035b6011') = 1);
select pg_temp.t_ok('AH conflicts created no client or link', not exists (select 1 from public.clients where first_name in ('Seven', 'Eight', 'Ten', 'Six', 'Two', 'Thirteen'))
  and not exists (select 1 from public.client_account_links where user_id in (pg_temp.t_user(7)::uuid, pg_temp.t_user(8)::uuid, pg_temp.t_user(2)::uuid, pg_temp.t_user(13)::uuid)));
select pg_temp.t_expect('conflict replay returns the stored conflict', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u7k09')), 'acct_gc352StudioA', 'cs_test_gc352_k09', 'pi_test_gc352_k09', 2500), (select v from t_h where k = 'fin_u7k09'));
select pg_temp.t_ok('conflict replay created no second payment', (select count(*) from public.payments where stripe_checkout_session_id = 'cs_test_gc352_k09') = 1);
select pg_temp.t_expect('a payment intent already bound to another hold is refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u13kb1')), 'acct_gc352StudioB', 'cs_test_gc352_kb1', 'pi_test_gc352_k01', 4000), 'ERR:GC35_PAYMENT_INTENT_IN_USE:%');

-- ============================================================================
-- AI/AJ/AK/AL. RELEASE
-- ============================================================================
select pg_temp.t_ok('AK K13 live hold counts before release', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6013') = 1);
select pg_temp.t_expect('AJ cannot release another user''s hold', pg_temp.t_release(1, pg_temp.t_hid((select v from t_h where k = 'u2k13c'))), 'ERR:GC35_HOLD_NOT_FOUND:%');
select pg_temp.t_expect('AI release own live hold', pg_temp.t_release(2, pg_temp.t_hid((select v from t_h where k = 'u2k13c'))), 'OK:released');
select pg_temp.t_ok('AK released hold stops counting immediately', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6013') = 0);
select pg_temp.t_expect('AL converted hold cannot be released', pg_temp.t_release(1, pg_temp.t_hid((select v from t_h where k = 'u1k01'))), 'ERR:GC35_HOLD_NOT_RELEASABLE:%');
select pg_temp.t_expect('AL conflict hold cannot be released', pg_temp.t_release(7, pg_temp.t_hid((select v from t_h where k = 'u7k09'))), 'ERR:GC35_HOLD_NOT_RELEASABLE:%');
select pg_temp.t_expect('attach after release refused', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u2k13c')), 'acct_gc352StudioA', 'cs_test_gc352_k13c'), 'ERR:GC35_HOLD_NOT_ACTIVE:%');

-- ============================================================================
-- AM. NO PARENT/GUARDIAN AUTHORITY CREATED
-- ============================================================================
select pg_temp.t_ok('AM every link created by finalize is a self link', not exists (
  select 1 from public.group_class_enrollment_holds h join public.client_account_links l on l.id = h.link_id
  where l.relationship_type <> 'self' or l.user_id <> h.purchaser_user_id));
select pg_temp.t_ok('AM purchasers 1 and 9 hold exactly one self link each and nothing else', (select count(*) from public.client_account_links
  where user_id in (pg_temp.t_user(1)::uuid, pg_temp.t_user(9)::uuid)) = 2 and not exists (select 1 from public.client_account_links
  where user_id in (pg_temp.t_user(1)::uuid, pg_temp.t_user(9)::uuid) and relationship_type <> 'self'));

-- ============================================================================
-- AN/AO. AUTHORITY SURFACE
-- ============================================================================
select pg_temp.t_expect('AN authenticated cannot attach', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  format('select hold_id::text from public.attach_public_class_purchase_checkout(%L::uuid, %L, %L, now() + interval ''30 minutes'')',
    pg_temp.t_hid((select v from t_h where k = 'u2k08')), 'acct_gc352StudioA', 'cs_test_gc352_self')), 'ERR:permission denied%');
select pg_temp.t_expect('AN authenticated cannot finalize', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  format('select outcome from public.finalize_public_class_purchase(%L::uuid, %L, %L, %L, 2500, ''usd'')',
    pg_temp.t_hid((select v from t_h where k = 'u2k08')), 'acct_gc352StudioA', 'cs_test_gc352_self', 'pi_test_gc352_self')), 'ERR:permission denied%');
select pg_temp.t_expect('AN anon cannot finalize', pg_temp.t_run('anon', null, null,
  'select outcome from public.finalize_public_class_purchase(''00000000-0000-0000-0000-0000035b9999''::uuid, ''acct_x'', ''cs_x'', ''pi_x'', 1, ''usd'')'), 'ERR:permission denied%');
select pg_temp.t_expect('AN service_role cannot start as a purchaser', pg_temp.t_run('service_role', null, null,
  'select hold_id::text from public.start_public_class_purchase(''00000000-0000-0000-0000-0000035b6001''::uuid, ''A'', ''B'')'), 'ERR:permission denied%');
select pg_temp.t_expect('AN nobody can call the reserved-count helper directly', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  'select public._group_class_roster_reserved_count(''00000000-0000-0000-0000-0000035b6001''::uuid)::text'), 'ERR:permission denied%');

select pg_temp.t_expect('AO authenticated direct insert denied', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  'insert into public.group_class_enrollment_holds (studio_id, appointment_id, purchaser_user_id, purchaser_email, dancer_first_name, dancer_last_name, amount_cents, expires_at) values (''00000000-0000-0000-0000-0000035b0001'', ''00000000-0000-0000-0000-0000035b6013'', ''00000000-0000-0000-0000-0000035b1002'', ''a@b.c'', ''A'', ''B'', 1, now())'), 'ERR:permission denied%');
select pg_temp.t_expect('AO authenticated direct update denied', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  'update public.group_class_enrollment_holds set expires_at = now() + interval ''1 day'''), 'ERR:permission denied%');
select pg_temp.t_expect('AO authenticated direct delete denied', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  'delete from public.group_class_enrollment_holds'), 'ERR:permission denied%');
select pg_temp.t_expect('AO service_role direct update denied', pg_temp.t_run('service_role', null, null,
  'update public.group_class_enrollment_holds set status = ''released'''), 'ERR:permission denied%');
select pg_temp.t_expect('AO anon read denied', pg_temp.t_run('anon', null, null,
  'select count(*)::text from public.group_class_enrollment_holds'), 'ERR:permission denied%');
select pg_temp.t_expect('AO purchaser reads only their own holds', pg_temp.t_run('authenticated', pg_temp.t_user(2), pg_temp.t_sid(2),
  'select count(*) filter (where purchaser_user_id <> auth.uid())::text || ''/'' || (count(*) > 0)::text from public.group_class_enrollment_holds'), 'OK:0/true');
select pg_temp.t_expect('AO studio A staff read studio A holds only', pg_temp.t_run('authenticated', pg_temp.t_user(11), pg_temp.t_sid(11),
  'select count(*) filter (where studio_id <> ''00000000-0000-0000-0000-0000035b0001'')::text || ''/'' || (count(*) > 0)::text from public.group_class_enrollment_holds'), 'OK:0/true');
select pg_temp.t_expect('AO an unrelated user reads nothing', pg_temp.t_run('authenticated', pg_temp.t_user(4), pg_temp.t_sid(4),
  'select count(*)::text from public.group_class_enrollment_holds'), 'OK:0');

-- ============================================================================
-- REVIEW: POLICY / PRICE CHANGES AFTER HOLD (locked decision: a live hold is a
-- temporary offer at its snapshotted price; only cancellation invalidates it)
-- ============================================================================
insert into t_h values ('u7k18', pg_temp.t_start(7, '00000000-0000-0000-0000-0000035b6018', 'Seven', 'Price'));
select pg_temp.t_ok('PC-A hold created at $25 (2500 cents)', (select amount_cents from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u7k18'))::uuid) = 2500);
update public.group_class_enrollment_policies set direct_payment_amount = 30.00 where appointment_id = '00000000-0000-0000-0000-0000035b6018';
select pg_temp.t_ok('PC-B staff changed the price to $30', (select direct_payment_amount from public.group_class_enrollment_policies where appointment_id = '00000000-0000-0000-0000-0000035b6018') = 30.00);
insert into t_h values ('u7k18b', pg_temp.t_start(7, '00000000-0000-0000-0000-0000035b6018', 'Seven', 'Price'));
select pg_temp.t_ok('PC-C existing hold reused at the $25 snapshot', (select v from t_h where k = 'u7k18b') = 'OK:' || pg_temp.t_hid((select v from t_h where k = 'u7k18')) || ',true'
  and (select amount_cents from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u7k18'))::uuid) = 2500);
insert into t_h values ('u8k18', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6018', 'Eight', 'Price'));
select pg_temp.t_ok('PC-D a new hold uses the new $30 price', (select amount_cents from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u8k18'))::uuid) = 3000);
select pg_temp.t_expect('PC-C attach the existing $25 hold (no policy re-check)', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u7k18')), 'acct_gc352StudioA', 'cs_test_gc352_k18'), 'OK:%');
select pg_temp.t_expect('PC-C finalize at the new price is refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u7k18')), 'acct_gc352StudioA', 'cs_test_gc352_k18', 'pi_test_gc352_k18', 3000), 'ERR:GC35_AMOUNT_MISMATCH:%');
select pg_temp.t_expect('PC-C finalize at the snapshotted $25 converts', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u7k18')), 'acct_gc352StudioA', 'cs_test_gc352_k18', 'pi_test_gc352_k18', 2500), 'OK:converted,%');
select pg_temp.t_ok('PC-C payment and attendee recorded at $25', exists (
  select 1 from public.group_class_enrollment_holds h join public.payments p on p.id = h.payment_id join public.appointment_attendees a on a.id = h.attendee_id
  where h.id = pg_temp.t_hid((select v from t_h where k = 'u7k18'))::uuid and p.amount = 25.00 and a.price_amount = 25.00));

insert into t_h values ('u13k19', pg_temp.t_start(13, '00000000-0000-0000-0000-0000035b6019', 'Thirteen', 'Disable'));
select pg_temp.t_expect('PC-E hold created while direct payment is offered', (select v from t_h where k = 'u13k19'), 'OK:%,false');
update public.group_class_enrollment_policies set accepted_funding_types = array['package'], direct_payment_amount = null
  where appointment_id = '00000000-0000-0000-0000-0000035b6019';
select pg_temp.t_ok('PC-E staff disabled direct payment', not exists (select 1 from public.group_class_enrollment_policies
  where appointment_id = '00000000-0000-0000-0000-0000035b6019' and 'direct_payment' = any (accepted_funding_types)));
select pg_temp.t_ok('PC-F existing hold is still reused after the disable',
  pg_temp.t_start(13, '00000000-0000-0000-0000-0000035b6019', 'Thirteen', 'Disable') = 'OK:' || pg_temp.t_hid((select v from t_h where k = 'u13k19')) || ',true');
select pg_temp.t_expect('PC-F existing hold can still attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u13k19')), 'acct_gc352StudioA', 'cs_test_gc352_k19'), 'OK:%');
select pg_temp.t_expect('PC-G a new purchaser cannot start a direct-payment hold', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6019', 'Two', 'Late'), 'ERR:GC35_DIRECT_PAYMENT_UNAVAILABLE:%');
select pg_temp.t_expect('PC-F existing hold completes at its snapshot', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u13k19')), 'acct_gc352StudioA', 'cs_test_gc352_k19', 'pi_test_gc352_k19', 2500), 'OK:converted,%');

-- Discoverability turned off after the hold: the hold survives; new purchasers cannot start. Cancellation invalidates.
insert into t_h values ('u8k22', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6022', 'Eight', 'Hidden'));
update public.group_class_enrollment_policies set publicly_discoverable = false where appointment_id = '00000000-0000-0000-0000-0000035b6022';
select pg_temp.t_ok('PC existing hold still reused after the class is hidden',
  pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6022', 'Eight', 'Hidden') = 'OK:' || pg_temp.t_hid((select v from t_h where k = 'u8k22')) || ',true');
select pg_temp.t_expect('PC new purchaser cannot start on a hidden class', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6022', 'Two', 'Hidden'), 'ERR:GC35_CLASS_UNAVAILABLE:%');
update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-0000035b6022';
select pg_temp.t_expect('PC cancellation invalidates the hold: reuse refused', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6022', 'Eight', 'Hidden'), 'ERR:GC35_CLASS_CANCELLED:%');
select pg_temp.t_expect('PC cancellation invalidates the hold: attach refused', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u8k22')), 'acct_gc352StudioA', 'cs_test_gc352_k22'), 'ERR:GC35_CLASS_CANCELLED:%');

-- ============================================================================
-- REVIEW: PAYMENTINTENT BINDING (the first verified finalize binds it once)
-- ============================================================================
insert into t_h values ('u2k20', pg_temp.t_start(2, '00000000-0000-0000-0000-0000035b6020', 'Two', 'Intent'));
select pg_temp.t_expect('PI attach', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20'), 'OK:%');
create function pg_temp.t_k20_unbound() returns boolean language sql as $$
  select exists (select 1 from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u2k20'))::uuid
                 and status = 'held' and stripe_payment_intent_id is null and payment_id is null)
     and not exists (select 1 from public.payments where stripe_checkout_session_id = 'cs_test_gc352_k20'); $$;
select pg_temp.t_expect('PI wrong account + candidate PI refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioB', 'cs_test_gc352_k20', 'pi_test_gc352_cand', 2500), 'ERR:GC35_ACCOUNT_MISMATCH:%');
select pg_temp.t_ok('PI wrong account left no PaymentIntent bound', pg_temp.t_k20_unbound());
select pg_temp.t_expect('PI wrong session + candidate PI refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k18', 'pi_test_gc352_cand', 2500), 'ERR:GC35_SESSION_MISMATCH:%');
select pg_temp.t_ok('PI wrong session left no PaymentIntent bound', pg_temp.t_k20_unbound());
select pg_temp.t_expect('PI wrong amount + candidate PI refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_cand', 2499), 'ERR:GC35_AMOUNT_MISMATCH:%');
select pg_temp.t_ok('PI wrong amount left no PaymentIntent bound', pg_temp.t_k20_unbound());
select pg_temp.t_expect('PI wrong currency + candidate PI refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_cand', 2500, 'cad'), 'ERR:GC35_CURRENCY_MISMATCH:%');
select pg_temp.t_ok('PI wrong currency left no PaymentIntent bound', pg_temp.t_k20_unbound());
select pg_temp.t_expect('PI already bound to another hold refused (unique)', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_k01', 2500), 'ERR:GC35_PAYMENT_INTENT_IN_USE:%');
select pg_temp.t_ok('PI in-use attempt left no PaymentIntent, client, link or attendee', pg_temp.t_k20_unbound()
  and not exists (select 1 from public.clients where first_name = 'Two' and last_name = 'Intent')
  and (select count(*) from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000035b6020') = 0);
select pg_temp.t_ok('PI no failed call persisted the candidate anywhere', not exists (select 1 from public.group_class_enrollment_holds where stripe_payment_intent_id = 'pi_test_gc352_cand')
  and not exists (select 1 from public.payments where stripe_payment_intent_id = 'pi_test_gc352_cand'));
insert into t_h values ('fin_u2k20', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_k20', 2500));
select pg_temp.t_expect('PI first verified finalize binds and converts', (select v from t_h where k = 'fin_u2k20'), 'OK:converted,%');
select pg_temp.t_ok('PI bound exactly once on hold and payment', (select stripe_payment_intent_id from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u2k20'))::uuid) = 'pi_test_gc352_k20'
  and (select count(*) from public.payments where stripe_payment_intent_id = 'pi_test_gc352_k20') = 1);
select pg_temp.t_expect('PI same replay is idempotent', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_k20', 2500), (select v from t_h where k = 'fin_u2k20'));
select pg_temp.t_expect('PI changed PaymentIntent on replay refused', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u2k20')), 'acct_gc352StudioA', 'cs_test_gc352_k20', 'pi_test_gc352_cand', 2500), 'ERR:GC35_PAYMENT_INTENT_MISMATCH:%');
select pg_temp.t_ok('PI changed attempt did not rebind', (select stripe_payment_intent_id from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u2k20'))::uuid) = 'pi_test_gc352_k20'
  and not exists (select 1 from public.payments where stripe_payment_intent_id = 'pi_test_gc352_cand'));

-- ============================================================================
-- REVIEW: EXPIRED-ROW SEMANTICS (effective active = status 'held' AND expires_at > now())
-- ============================================================================
insert into t_h values ('u8k21', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6021', 'Eight', 'Expired'));
update public.group_class_enrollment_holds set expires_at = now() - interval '1 second' where id = pg_temp.t_hid((select v from t_h where k = 'u8k21'))::uuid;
select pg_temp.t_ok('EX expired held row does not count (capacity and public spots)', public._group_class_roster_reserved_count('00000000-0000-0000-0000-0000035b6021') = 0
  and (select spots_remaining from public.public_group_class_occurrences(null, null, '00000000-0000-0000-0000-0000035b6021', 1)) = 4);
do $$
begin
  begin
    insert into public.group_class_enrollment_holds (studio_id, appointment_id, purchaser_user_id, purchaser_email, dancer_first_name, dancer_last_name, amount_cents, expires_at)
    values ('00000000-0000-0000-0000-0000035b0001', '00000000-0000-0000-0000-0000035b6021', pg_temp.t_user(8)::uuid, 't-gc352-u8@example.test', 'X', 'Y', 2500, now() + interval '30 minutes');
    raise exception 'FAIL EX a raw insert slipped past an expired held row';
  exception when unique_violation then
    perform pg_temp.t_pass('EX an expired held row still occupies the partial unique index (raw insert refused)');
  end;
end $$;
select pg_temp.t_expect('EX expired hold cannot accept a Checkout', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u8k21')), 'acct_gc352StudioA', 'cs_test_gc352_k21a'), 'ERR:GC35_HOLD_EXPIRED:%');
insert into t_h values ('u8k21b', pg_temp.t_start(8, '00000000-0000-0000-0000-0000035b6021', 'Eight', 'Expired'));
select pg_temp.t_ok('EX expired hold is not reused: start releases it and inserts a replacement in one call',
  (select v from t_h where k = 'u8k21b') like 'OK:%,false'
  and pg_temp.t_hid((select v from t_h where k = 'u8k21b')) <> pg_temp.t_hid((select v from t_h where k = 'u8k21'))
  and (select status from public.group_class_enrollment_holds where id = pg_temp.t_hid((select v from t_h where k = 'u8k21'))::uuid) = 'released'
  and (select count(*) from public.group_class_enrollment_holds where appointment_id = '00000000-0000-0000-0000-0000035b6021'
       and purchaser_user_id = pg_temp.t_user(8)::uuid and status in ('held', 'converting')) = 1);
select pg_temp.t_expect('EX the released expired row accepts no Checkout', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u8k21')), 'acct_gc352StudioA', 'cs_test_gc352_k21a'), 'ERR:GC35_HOLD_NOT_ACTIVE:%');
select pg_temp.t_ok('EX start row-locks the existing hold under the class lock before releasing it',
  (select prosrc ~* 'h\.status in \(''held'', ''converting''\)\s+for update' from pg_proc where oid = 'public.start_public_class_purchase(uuid,text,text,text)'::regprocedure));

-- Release keeps the Stripe binding needed to reconcile a late payment.
select pg_temp.t_expect('RL attach the replacement hold', pg_temp.t_attach(pg_temp.t_hid((select v from t_h where k = 'u8k21b')), 'acct_gc352StudioA', 'cs_test_gc352_k21b'), 'OK:%');
select pg_temp.t_expect('RL release with a Checkout attached', pg_temp.t_release(8, pg_temp.t_hid((select v from t_h where k = 'u8k21b'))), 'OK:released');
select pg_temp.t_ok('RL release keeps account and session', exists (select 1 from public.group_class_enrollment_holds
  where id = pg_temp.t_hid((select v from t_h where k = 'u8k21b'))::uuid and status = 'released'
    and stripe_account_id = 'acct_gc352StudioA' and stripe_checkout_session_id = 'cs_test_gc352_k21b'));
select pg_temp.t_expect('RL late payment after release becomes a hold_released conflict', pg_temp.t_finalize(pg_temp.t_hid((select v from t_h where k = 'u8k21b')), 'acct_gc352StudioA', 'cs_test_gc352_k21b', 'pi_test_gc352_k21b', 2500), 'OK:conflict,hold_released,-,-,-,%');
select pg_temp.t_ok('RL late payment: no enrollment, no client, paid clientless evidence with accounting', (select count(*) from public.appointment_attendees where appointment_id = '00000000-0000-0000-0000-0000035b6021') = 0
  and not exists (select 1 from public.clients where first_name = 'Eight')
  and exists (select 1 from public.payments p join public.accounting_entries ae on ae.source_table = 'payments' and ae.source_id = p.id
              where p.stripe_payment_intent_id = 'pi_test_gc352_k21b' and p.status = 'paid' and p.client_id is null
                and p.guest_name = 'Eight Expired' and ae.client_id is null and ae.voided_at is null));

-- ============================================================================
-- TRANSITION GUARD (owner-level writes)
-- ============================================================================
do $$
declare v_conv uuid := pg_temp.t_hid((select v from t_h where k = 'u1k01'))::uuid;
        v_live uuid := pg_temp.t_hid((select v from t_h where k = 'u2k08'))::uuid;
begin
  begin
    update public.group_class_enrollment_holds set status = 'released' where id = v_conv;
    raise exception 'FAIL guard: converted row changed';
  exception when others then
    if sqlerrm not like 'GC35_HOLD_FINAL:%' then raise; end if;
  end;
  begin
    update public.group_class_enrollment_holds set amount_cents = 1 where id = v_live;
    raise exception 'FAIL guard: price changed';
  exception when others then
    if sqlerrm not like 'GC35_HOLD_IMMUTABLE:%' then raise; end if;
  end;
  begin
    update public.group_class_enrollment_holds set status = 'converted' where id = v_live;
    raise exception 'FAIL guard: held -> converted';
  exception when others then
    if sqlerrm not like 'GC35_HOLD_TRANSITION:%' then raise; end if;
  end;
  begin
    update public.group_class_enrollment_holds set status = 'converting' where id = v_live;
    set constraints group_class_enrollment_holds_01_no_committed_converting immediate;
    raise exception 'FAIL guard: converting could be committed';
  exception when others then
    if sqlerrm not like 'GC35_HOLD_CONVERTING_UNCOMMITTABLE:%' then raise; end if;
  end;
  set constraints group_class_enrollment_holds_01_no_committed_converting deferred;
  perform pg_temp.t_pass('transition guard (final, immutable, transition, uncommittable converting)');
end $$;

select pg_temp.t_ok('no hold is left converting', not exists (select 1 from public.group_class_enrollment_holds where status = 'converting'));

do $$ begin raise notice 'GC-3.5-2 SUITE COMPLETE'; end $$;

select count(*) as assertions_passed, count(distinct label) as distinct_labels from t_results;

rollback;
