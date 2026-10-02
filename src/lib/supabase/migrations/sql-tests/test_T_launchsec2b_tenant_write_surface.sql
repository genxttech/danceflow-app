-- LAUNCH-SEC-2B -- tenant write-surface closure (#4, #5, #8).
--
-- Covers 20261011090000_launchsec2b_tenant_write_surface.sql. One
-- transaction, synthetic fixtures only (UUID block ...0000002b....), rolled
-- back at the end -- nothing persists. Tenant behavior is simulated with
-- `set local role` + request.jwt.claims. Assumes the forward migration has
-- been applied.

begin;

-- ============================================================================
-- Fixtures
-- ============================================================================
--   studio A ...2b0001, studio B ...2b0002
--   ...2b1001 owner A        ...2b1002 admin A         ...2b1003 front desk A
--   ...2b1004 instructor A   ...2b1005 hybrid renter (instructor role in A +
--             own instructors row + linked independent-instructor client)
--   ...2b1006 pure portal renter (linked independent-instructor client only)
--   ...2b1007 owner B        ...2b1008 platform admin  ...2b1009 outsider

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000002b0001', 'LAUNCH-SEC-2B Studio A', 't-launchsec2b-a'),
  ('00000000-0000-0000-0000-0000002b0002', 'LAUNCH-SEC-2B Studio B', 't-launchsec2b-b');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000002b1001', 't-launchsec2b-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000002b1002', 't-launchsec2b-admin-a@example.test'),
  ('00000000-0000-0000-0000-0000002b1003', 't-launchsec2b-frontdesk-a@example.test'),
  ('00000000-0000-0000-0000-0000002b1004', 't-launchsec2b-instructor-a@example.test'),
  ('00000000-0000-0000-0000-0000002b1005', 't-launchsec2b-hybrid@example.test'),
  ('00000000-0000-0000-0000-0000002b1006', 't-launchsec2b-renter@example.test'),
  ('00000000-0000-0000-0000-0000002b1007', 't-launchsec2b-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000002b1008', 't-launchsec2b-platform@example.test'),
  ('00000000-0000-0000-0000-0000002b1009', 't-launchsec2b-outsider@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-0000002b1001', 't-launchsec2b-owner-a@example.test', null),
  ('00000000-0000-0000-0000-0000002b1002', 't-launchsec2b-admin-a@example.test', null),
  ('00000000-0000-0000-0000-0000002b1003', 't-launchsec2b-frontdesk-a@example.test', null),
  ('00000000-0000-0000-0000-0000002b1004', 't-launchsec2b-instructor-a@example.test', null),
  ('00000000-0000-0000-0000-0000002b1005', 't-launchsec2b-hybrid@example.test', null),
  ('00000000-0000-0000-0000-0000002b1006', 't-launchsec2b-renter@example.test', null),
  ('00000000-0000-0000-0000-0000002b1007', 't-launchsec2b-owner-b@example.test', null),
  ('00000000-0000-0000-0000-0000002b1008', 't-launchsec2b-platform@example.test', 'platform_admin'),
  ('00000000-0000-0000-0000-0000002b1009', 't-launchsec2b-outsider@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000002b1001', '00000000-0000-0000-0000-0000002b0001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000002b1002', '00000000-0000-0000-0000-0000002b0001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000002b1003', '00000000-0000-0000-0000-0000002b0001', 'front_desk', true),
  ('00000000-0000-0000-0000-0000002b1004', '00000000-0000-0000-0000-0000002b0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000002b1005', '00000000-0000-0000-0000-0000002b0001', 'instructor', true),
  ('00000000-0000-0000-0000-0000002b1007', '00000000-0000-0000-0000-0000002b0002', 'studio_owner', true);

insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('00000000-0000-0000-0000-0000002b2004', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b1004', 'Instructor', 'A', true, true),
  ('00000000-0000-0000-0000-0000002b2005', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b1005', 'Hybrid', 'Renter', true, false);

insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id) values
  ('00000000-0000-0000-0000-0000002b3005', '00000000-0000-0000-0000-0000002b0001', 'Hybrid', 'Renter', 'active', true, '00000000-0000-0000-0000-0000002b2005'),
  ('00000000-0000-0000-0000-0000002b3006', '00000000-0000-0000-0000-0000002b0001', 'Pure', 'Renter', 'active', true, null),
  ('00000000-0000-0000-0000-0000002b3007', '00000000-0000-0000-0000-0000002b0002', 'Other', 'Client', 'active', false, null);

insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type) values
  ('00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3005', '00000000-0000-0000-0000-0000002b1005', 'linked', 'self'),
  ('00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3006', '00000000-0000-0000-0000-0000002b1006', 'linked', 'self');

-- Existing floor rentals (created by postgres, i.e. the studio).
insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status, payment_status, price_amount, created_by) values
  ('00000000-0000-0000-0000-0000002b4005', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3005', '00000000-0000-0000-0000-0000002b2005',
   'floor_space_rental', 'Floor Space Rental', now() + interval '3 days', now() + interval '3 days 1 hour', 'scheduled', 'unpaid', 80, '00000000-0000-0000-0000-0000002b1005'),
  ('00000000-0000-0000-0000-0000002b4006', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3006', null,
   'floor_space_rental', 'Floor Space Rental', now() + interval '4 days', now() + interval '4 days 1 hour', 'scheduled', 'unpaid', 60, '00000000-0000-0000-0000-0000002b1006');

insert into public.appointment_package_deduction_errors (id, appointment_id, studio_id, client_id, appointment_type, error_message) values
  ('00000000-0000-0000-0000-0000002b5001', '00000000-0000-0000-0000-0000002b4005', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3005', 'private_lesson', 'LAUNCH-SEC-2B fixture A'),
  ('00000000-0000-0000-0000-0000002b5002', '00000000-0000-0000-0000-0000002b4005', '00000000-0000-0000-0000-0000002b0002', '00000000-0000-0000-0000-0000002b3007', 'private_lesson', 'LAUNCH-SEC-2B fixture B');

insert into public.studio_job_postings (id, studio_id, title, status, created_by) values
  ('00000000-0000-0000-0000-0000002b6001', '00000000-0000-0000-0000-0000002b0001', 'LAUNCH-SEC-2B published A', 'published', '00000000-0000-0000-0000-0000002b1002'),
  ('00000000-0000-0000-0000-0000002b6002', '00000000-0000-0000-0000-0000002b0002', 'LAUNCH-SEC-2B draft B', 'draft', '00000000-0000-0000-0000-0000002b1007');

create function pg_temp.as_user(p_sub text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;

-- ============================================================================
-- S. Shape
-- ============================================================================
do $$
declare v_sec boolean; v_cfg text; v_first text; v_comment text;
begin
  select prosecdef, array_to_string(proconfig, ',') into v_sec, v_cfg
  from pg_proc where oid = 'public._guard_appointments_floor_rental_financial_fields()'::regprocedure;
  if v_sec or v_cfg is distinct from 'search_path=public' then
    raise exception 'FAIL T-launchsec2b-S1 guard must be SECURITY INVOKER with search_path=public';
  end if;
  if has_function_privilege('authenticated', 'public._guard_appointments_floor_rental_financial_fields()', 'execute')
     or has_function_privilege('anon', 'public._guard_appointments_floor_rental_financial_fields()', 'execute') then
    raise exception 'FAIL T-launchsec2b-S2 guard executable by tenant roles';
  end if;
  select tgname into v_first from pg_trigger
  where tgrelid = 'public.appointments'::regclass and not tgisinternal order by tgname limit 1;
  if v_first <> 'appointments_00_guard_floor_rental_financial_fields' then
    raise exception 'FAIL T-launchsec2b-S3 guard must fire first, got %', v_first;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.appointment_package_deduction_errors'::regclass)
     or has_table_privilege('anon', 'public.appointment_package_deduction_errors', 'select')
     or has_table_privilege('authenticated', 'public.appointment_package_deduction_errors', 'insert')
     or has_table_privilege('authenticated', 'public.appointment_package_deduction_errors', 'delete')
     or has_table_privilege('authenticated', 'public.appointment_package_deduction_errors', 'truncate') then
    raise exception 'FAIL T-launchsec2b-S4 deduction errors grants/RLS';
  end if;
  select obj_description(oid, 'pg_policy') into v_comment from pg_policy
  where polrelid = 'public.appointment_package_deduction_errors'::regclass
    and polname = 'Platform admins and studio finance staff read deduction errors';
  if v_comment not in ('LAUNCH-SEC-2B starting state A', 'LAUNCH-SEC-2B starting state B') then
    raise exception 'FAIL T-launchsec2b-S5 starting state not recorded: %', v_comment;
  end if;
  raise notice 'PASS T-launchsec2b-shape';
end $$;

-- ============================================================================
-- D. #4 package deduction errors
-- ============================================================================
do $$
declare v int; v_caller text;
begin
  -- D1 anon: no access at all.
  set local role anon;
  perform pg_temp.as_anon();
  begin
    perform 1 from public.appointment_package_deduction_errors;
    raise exception 'FAIL T-launchsec2b-D1 anon select allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.appointment_package_deduction_errors (studio_id, error_message) values ('00000000-0000-0000-0000-0000002b0001', 'x');
    raise exception 'FAIL T-launchsec2b-D1 anon insert allowed';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- D2 ordinary authenticated users (instructor, renter, outsider): 0 rows, no writes.
  foreach v_caller in array array['00000000-0000-0000-0000-0000002b1004', '00000000-0000-0000-0000-0000002b1006', '00000000-0000-0000-0000-0000002b1009'] loop
    set local role authenticated;
    perform pg_temp.as_user(v_caller);
    select count(*) into v from public.appointment_package_deduction_errors;
    if v <> 0 then raise exception 'FAIL T-launchsec2b-D2 % sees % rows', v_caller, v; end if;
    begin
      insert into public.appointment_package_deduction_errors (studio_id, error_message) values ('00000000-0000-0000-0000-0000002b0001', 'x');
      raise exception 'FAIL T-launchsec2b-D2 % inserted', v_caller;
    exception when insufficient_privilege then null;
    end;
    update public.appointment_package_deduction_errors set resolution_notes = 'x';
    get diagnostics v = row_count;
    if v <> 0 then raise exception 'FAIL T-launchsec2b-D2 % updated % rows', v_caller, v; end if;
    begin
      delete from public.appointment_package_deduction_errors;
      raise exception 'FAIL T-launchsec2b-D2 % delete allowed', v_caller;
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;

  -- D3 studio financial roles see exactly their studio's rows (the hard-delete
  -- history check), and cannot resolve.
  foreach v_caller in array array['00000000-0000-0000-0000-0000002b1001', '00000000-0000-0000-0000-0000002b1002', '00000000-0000-0000-0000-0000002b1003'] loop
    set local role authenticated;
    perform pg_temp.as_user(v_caller);
    select count(*) into v from public.appointment_package_deduction_errors
    where studio_id = '00000000-0000-0000-0000-0000002b0001' and appointment_id = '00000000-0000-0000-0000-0000002b4005';
    if v <> 1 then raise exception 'FAIL T-launchsec2b-D3 % history check sees % rows', v_caller, v; end if;
    select count(*) into v from public.appointment_package_deduction_errors where studio_id = '00000000-0000-0000-0000-0000002b0002';
    if v <> 0 then raise exception 'FAIL T-launchsec2b-D3 % sees another studio', v_caller; end if;
    update public.appointment_package_deduction_errors set resolution_notes = 'staff';
    get diagnostics v = row_count;
    if v <> 0 then raise exception 'FAIL T-launchsec2b-D3 % resolved', v_caller; end if;
    reset role;
  end loop;

  -- D4 platform admin reads all and resolves.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1008');
  select count(*) into v from public.appointment_package_deduction_errors where id::text like '00000000-0000-0000-0000-0000002b5%';
  if v <> 2 then raise exception 'FAIL T-launchsec2b-D4 platform admin sees % rows', v; end if;
  update public.appointment_package_deduction_errors set resolved_at = now(), resolution_notes = 'resolved by platform'
  where id = '00000000-0000-0000-0000-0000002b5001';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-D4 platform admin resolve'; end if;
  reset role;

  -- D5 the internal writers (package-deduction triggers) bypass RLS as
  -- SECURITY DEFINER functions owned by the table owner; keep it that way.
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.prosrc ~* 'insert\s+into\s+(public\.)?appointment_package_deduction_errors\y'
             and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'postgres')) then
    raise exception 'FAIL T-launchsec2b-D5 deduction error writers must stay SECURITY DEFINER (postgres)';
  end if;

  raise notice 'PASS T-launchsec2b-deduction-errors';
end $$;

-- ============================================================================
-- J. #5 job postings
-- ============================================================================
do $$
declare v int;
begin
  -- J1 authorized same-studio creation (studio_admin A) succeeds.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1002');
  insert into public.studio_job_postings (id, studio_id, title, status, created_by)
  values ('00000000-0000-0000-0000-0000002b6003', '00000000-0000-0000-0000-0000002b0001', 'Admin A draft', 'draft', '00000000-0000-0000-0000-0000002b1002');
  -- creator can update own posting in own studio
  update public.studio_job_postings set title = 'Admin A draft edited' where id = '00000000-0000-0000-0000-0000002b6003';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-J1 creator update'; end if;
  -- J4 cross-studio reassignment denied
  begin
    update public.studio_job_postings set studio_id = '00000000-0000-0000-0000-0000002b0002' where id = '00000000-0000-0000-0000-0000002b6003';
    raise exception 'FAIL T-launchsec2b-J4 moved posting to studio B';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- J2 a user with no authority in studio B cannot create under studio B
  -- (admin A, the outsider, an instructor of A for A, and a portal renter).
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1002');
  begin
    insert into public.studio_job_postings (studio_id, title, status, created_by)
    values ('00000000-0000-0000-0000-0000002b0002', 'Impersonated B', 'published', '00000000-0000-0000-0000-0000002b1002');
    raise exception 'FAIL T-launchsec2b-J2 admin A posted as studio B';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1009');
  begin
    insert into public.studio_job_postings (studio_id, title, status, created_by)
    values ('00000000-0000-0000-0000-0000002b0001', 'Impersonated A', 'published', '00000000-0000-0000-0000-0000002b1009');
    raise exception 'FAIL T-launchsec2b-J2 outsider posted as studio A';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1004');
  begin
    insert into public.studio_job_postings (studio_id, title, status, created_by)
    values ('00000000-0000-0000-0000-0000002b0001', 'Instructor post', 'published', '00000000-0000-0000-0000-0000002b1004');
    raise exception 'FAIL T-launchsec2b-J2 instructor posted for studio A';
  exception when insufficient_privilege then null;
  end;

  -- J3 cross-studio update / delete denied (owner B on studio A posting).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1007');
  update public.studio_job_postings set title = 'hijack' where id = '00000000-0000-0000-0000-0000002b6001';
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL T-launchsec2b-J3 cross-studio update'; end if;
  delete from public.studio_job_postings where id = '00000000-0000-0000-0000-0000002b6001';
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL T-launchsec2b-J3 cross-studio delete'; end if;

  -- J5 cannot assign the posting to another creator.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1002');
  begin
    update public.studio_job_postings set created_by = '00000000-0000-0000-0000-0000002b1001' where id = '00000000-0000-0000-0000-0000002b6003';
    raise exception 'FAIL T-launchsec2b-J5 creator reassigned';
  exception when insufficient_privilege then null;
  end;

  -- J6 non-creator (owner A) cannot delete admin A's posting (creator semantics kept).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1001');
  delete from public.studio_job_postings where id = '00000000-0000-0000-0000-0000002b6003';
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL T-launchsec2b-J6 non-creator delete'; end if;

  -- J7 the creator can delete its own posting.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1002');
  delete from public.studio_job_postings where id = '00000000-0000-0000-0000-0000002b6003';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-J7 creator delete'; end if;
  reset role;

  -- J8 public listing still works (anon sees published A, not draft B).
  set local role anon;
  perform pg_temp.as_anon();
  select count(*) into v from public.studio_job_postings where id in ('00000000-0000-0000-0000-0000002b6001', '00000000-0000-0000-0000-0000002b6002');
  if v <> 1 then raise exception 'FAIL T-launchsec2b-J8 public listing sees % rows', v; end if;
  reset role;

  if (select studio_id from public.studio_job_postings where id = '00000000-0000-0000-0000-0000002b6001') <> '00000000-0000-0000-0000-0000002b0001'
     or (select title from public.studio_job_postings where id = '00000000-0000-0000-0000-0000002b6001') <> 'LAUNCH-SEC-2B published A' then
    raise exception 'FAIL T-launchsec2b-J fixture posting changed';
  end if;

  raise notice 'PASS T-launchsec2b-job-postings';
end $$;

-- ============================================================================
-- F. #8 floor-rental financial authority
-- ============================================================================
do $$
declare v_set text; v_caller text; v int; v_due numeric;
begin
  -- F1 both renters (pure portal renter on its row; hybrid renter, who also
  -- reaches the row through the instructor policy branch) cannot change any
  -- financial or ownership field.
  foreach v_caller in array array['00000000-0000-0000-0000-0000002b1006', '00000000-0000-0000-0000-0000002b1005'] loop
    foreach v_set in array array[
      'price_amount = 0.01',
      'price_amount = 500',
      'price_amount = null',
      'payment_status = ''paid''',
      'payment_status = ''waived''',
      'payment_status = ''partial''',
      'billing_type = ''pay_as_you_go''',
      'billing_note = ''paid in cash''',
      'client_package_id = gen_random_uuid()',
      'client_membership_id = gen_random_uuid()',
      'created_by = ''00000000-0000-0000-0000-0000002b1001''',
      'client_id = ''00000000-0000-0000-0000-0000002b3007''',
      'studio_id = ''00000000-0000-0000-0000-0000002b0002''',
      'appointment_type = ''private_lesson'''
    ] loop
      set local role authenticated;
      perform pg_temp.as_user(v_caller);
      begin
        execute format('update public.appointments set %s where id = %L', v_set,
          case v_caller when '00000000-0000-0000-0000-0000002b1006' then '00000000-0000-0000-0000-0000002b4006'
                        else '00000000-0000-0000-0000-0000002b4005' end);
        get diagnostics v = row_count;
        raise exception 'FAIL T-launchsec2b-F1 % changed floor rental (%), % rows', v_caller, v_set, v;
      exception
        when insufficient_privilege then null;
        when foreign_key_violation then
          raise exception 'FAIL T-launchsec2b-F1 % reached FK check for (%) -- guard did not fire first', v_caller, v_set;
      end;
      reset role;
    end loop;
  end loop;

  -- F2 a staff instructor (no financial authority) cannot mark a floor rental paid either.
  update public.appointments set instructor_id = '00000000-0000-0000-0000-0000002b2004'
  where id = '00000000-0000-0000-0000-0000002b4006';
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1004');
  begin
    update public.appointments set payment_status = 'paid' where id = '00000000-0000-0000-0000-0000002b4006';
    raise exception 'FAIL T-launchsec2b-F2 staff instructor marked rental paid';
  exception when insufficient_privilege then null;
  end;
  reset role;
  update public.appointments set instructor_id = null where id = '00000000-0000-0000-0000-0000002b4006';

  -- F3 legitimate renter edits still work: notes, and cancellation.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1006');
  update public.appointments set notes = 'Bring speaker' where id = '00000000-0000-0000-0000-0000002b4006';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-F3 renter notes edit (% rows)', v; end if;
  -- a save repeating the unchanged price/status is not a change
  update public.appointments set price_amount = 60, payment_status = 'unpaid' where id = '00000000-0000-0000-0000-0000002b4006';
  get diagnostics v = row_count;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-F3 no-op financial save rejected'; end if;
  reset role;

  -- F4 renter booking (portal insert): born unpaid with fee > 0 works;
  -- born paid / zero / null fee / package-linked is rejected.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1006');
  insert into public.appointments (id, studio_id, client_id, appointment_type, title, starts_at, ends_at, status, payment_status, price_amount, is_recurring, created_by)
  values ('00000000-0000-0000-0000-0000002b4016', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3006', 'floor_space_rental',
          'Floor Space Rental', now() + interval '6 days', now() + interval '6 days 1 hour', 'scheduled', 'unpaid', 45, false, '00000000-0000-0000-0000-0000002b1006');
  foreach v_set in array array['''paid'', 45', '''unpaid'', 0', '''unpaid'', null', '''waived'', 45'] loop
    begin
      execute format(
        'insert into public.appointments (studio_id, client_id, appointment_type, title, starts_at, ends_at, status, payment_status, price_amount, is_recurring, created_by)
         values (%L, %L, ''floor_space_rental'', ''Floor Space Rental'', now() + interval ''7 days'', now() + interval ''7 days 1 hour'', ''scheduled'', %s, false, %L)',
        '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b3006', v_set, '00000000-0000-0000-0000-0000002b1006');
      raise exception 'FAIL T-launchsec2b-F4 renter booked with (%)', v_set;
    exception when insufficient_privilege then null;
    end;
  end loop;
  reset role;

  -- F5 checkout still charges the authoritative amount (same selection as
  -- getPayableFloorRentalAppointments): 60 + 45, unchanged by any attempt.
  select coalesce(sum(price_amount), 0) into v_due from public.appointments
  where studio_id = '00000000-0000-0000-0000-0000002b0001'
    and client_id = '00000000-0000-0000-0000-0000002b3006'
    and appointment_type = 'floor_space_rental'
    and status <> 'cancelled'
    and payment_status in ('unpaid', 'partial');
  if v_due <> 105 then raise exception 'FAIL T-launchsec2b-F5 payable total %', v_due; end if;

  -- F6 studio financial roles keep financial authority (front desk waives,
  -- owner re-prices, admin records partial).
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1003');
  update public.appointments set payment_status = 'waived' where id = '00000000-0000-0000-0000-0000002b4016';
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1001');
  update public.appointments set price_amount = 70 where id = '00000000-0000-0000-0000-0000002b4006';
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1002');
  update public.appointments set payment_status = 'partial' where id = '00000000-0000-0000-0000-0000002b4006';
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1008');
  update public.appointments set notes = 'platform note', price_amount = 70 where id = '00000000-0000-0000-0000-0000002b4006';
  reset role;
  if (select payment_status from public.appointments where id = '00000000-0000-0000-0000-0000002b4016') <> 'waived'
     or (select price_amount from public.appointments where id = '00000000-0000-0000-0000-0000002b4006') <> 70
     or (select payment_status from public.appointments where id = '00000000-0000-0000-0000-0000002b4006') <> 'partial' then
    raise exception 'FAIL T-launchsec2b-F6 studio financial updates';
  end if;

  -- F7 cross-studio staff (owner B) has no financial authority over studio A rows.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1007');
  update public.appointments set payment_status = 'paid' where id = '00000000-0000-0000-0000-0000002b4006';
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'FAIL T-launchsec2b-F7 cross-studio update touched % rows', v; end if;
  reset role;

  -- F8 payment completion (webhook / service role) still marks paid.
  set local role service_role;
  update public.appointments set payment_status = 'paid' where id = '00000000-0000-0000-0000-0000002b4005';
  reset role;
  if (select payment_status from public.appointments where id = '00000000-0000-0000-0000-0000002b4005') <> 'paid' then
    raise exception 'FAIL T-launchsec2b-F8 service role payment completion';
  end if;

  -- F9 the renter can still cancel its own (now paid) rental without touching money.
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1005');
  update public.appointments set status = 'cancelled' where id = '00000000-0000-0000-0000-0000002b4005';
  get diagnostics v = row_count;
  reset role;
  if v <> 1 or (select payment_status from public.appointments where id = '00000000-0000-0000-0000-0000002b4005') <> 'paid' then
    raise exception 'FAIL T-launchsec2b-F9 renter cancellation';
  end if;

  -- F10 non-floor-rental appointments are untouched by the guard (instructor
  -- edits own private lesson price as before 2B).
  insert into public.appointments (id, studio_id, instructor_id, appointment_type, title, starts_at, ends_at, status, payment_status, price_amount)
  values ('00000000-0000-0000-0000-0000002b4020', '00000000-0000-0000-0000-0000002b0001', '00000000-0000-0000-0000-0000002b2004', 'private_lesson',
          'Lesson', now() + interval '8 days', now() + interval '8 days 1 hour', 'scheduled', 'unpaid', 50);
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000002b1004');
  update public.appointments set notes = 'lesson notes', price_amount = 55 where id = '00000000-0000-0000-0000-0000002b4020';
  get diagnostics v = row_count;
  reset role;
  if v <> 1 then raise exception 'FAIL T-launchsec2b-F10 private lesson edit blocked'; end if;

  raise notice 'PASS T-launchsec2b-floor-rental-financial-authority';
end $$;

do $$
begin
  raise notice 'ALL T-launchsec2b TESTS PASSED';
end $$;

rollback;
