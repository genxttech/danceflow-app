-- Landmark 1A Slice 9 -- DEV-ONLY concurrency helper (never a migration;
-- never applied to PROD). Created by slice9_race_harness.mjs setup and dropped
-- by its cleanup. See README.md.
--
-- A PostgREST RPC call is exactly one transaction on its own backend
-- connection. _s9_race_op performs ONE operation (a capability RPC, a tenant-
-- role direct write that the Slice 9 guard must reject, or a payroll / client
-- write made the way the normal writers make it), records how long it waited,
-- then sleeps p_hold seconds INSIDE the same transaction so any lock it took
-- stays held while the harness starts a competing request. Two parallel HTTP
-- requests are therefore two genuinely concurrent database sessions.
--
-- SECURITY DEFINER (owner postgres) because the capability RPCs are not
-- executable by service_role; staff identity is simulated with
-- request.jwt.claims (the harness owner/admin/front-desk users hold roles in
-- every race studio). Tenant-role direct writes switch the DB role with
-- set_config('role', 'authenticated', true), exactly as PostgREST would.
-- Executable only by service_role.

create or replace function public._s9_race_op(
  p_op text,
  p_studio uuid,
  p_x uuid default null,
  p_y text default null,
  p_hold numeric default 0
)
returns text
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  c_admin constant uuid := '00000000-0000-0000-0000-00001b9e9001';
  t0 timestamptz;
  o text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_admin, 'email', 't-s9-race-admin@example.test')::text, true);

  t0 := clock_timestamp();
  begin
    case p_op
      when 'promote' then perform public.promote_hybrid_instructor(p_studio, p_x, true, p_y);
      when 'grant' then perform public.grant_instructor_capability(p_studio, p_x);
      when 'revoke' then perform public.revoke_instructor_capability(p_studio, p_x);
      -- lock-order probe: the canonical RPC order (seat lock, then instructor row) with a pause between
      when 'seat_then_row' then
        perform pg_advisory_xact_lock(hashtext(p_studio::text || ':instructor_seat'));
        perform pg_sleep(p_y::numeric);
        perform 1 from public.instructors where id = p_x for update;
      -- prerequisite writers, as the normal writers make them
      when 'payroll_off' then update public.instructor_payroll_profiles set payroll_active = false where instructor_id = p_x;
      when 'payroll_on' then update public.instructor_payroll_profiles set payroll_active = true where instructor_id = p_x;
      when 'class_edit' then update public.instructor_payroll_profiles set worker_classification = p_y where instructor_id = p_x;
      else raise exception 'unknown op %', p_op;
    end case;
    o := 'OK';
  exception when others then
    o := 'ERR: ' || sqlerrm;
  end;
  o := o || ' | waited_ms=' || round(extract(epoch from clock_timestamp() - t0) * 1000);

  perform pg_sleep(p_hold);
  return o;
end;
$$;

-- Tenant-role operations. SECURITY INVOKER (a definer function may not switch
-- roles): called by service_role over PostgREST, it switches the transaction to
-- the authenticated role with a staff JWT exactly as a real API call would run,
-- so RLS and the Slice 9 guards apply. A rejected write leaves nothing behind.
create or replace function public._s9_race_tenant_op(
  p_op text,
  p_x uuid default null,
  p_hold numeric default 0
)
returns text
language plpgsql
security invoker
set search_path = 'public'
as $$
declare
  c_admin constant uuid := '00000000-0000-0000-0000-00001b9e9001';
  c_front constant uuid := '00000000-0000-0000-0000-00001b9e9002';
  t0 timestamptz;
  o text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', case when p_op = 'renter_off' then c_front else c_admin end,
                      'email', 't-s9-race-admin@example.test')::text, true);
  t0 := clock_timestamp();
  begin
    perform set_config('role', 'authenticated', true);
    case p_op
      when 'tenant_can_false' then update public.instructors set can_instruct = false where id = p_x;
      when 'tenant_can_true' then update public.instructors set can_instruct = true where id = p_x;
      when 'renter_off' then update public.clients set is_independent_instructor = false where id = p_x;
      when 'tenant_active_true' then update public.instructors set active = true where id = p_x;
      else raise exception 'unknown op %', p_op;
    end case;
    o := 'OK';
  exception when others then
    o := 'ERR: ' || sqlerrm;
  end;
  o := o || ' | waited_ms=' || round(extract(epoch from clock_timestamp() - t0) * 1000);
  perform pg_sleep(p_hold);
  return o;
end;
$$;

-- Derived state for post-conditions.
create or replace function public._s9_state(p_studio uuid, p_instructor uuid, p_client uuid)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce((select 'cap=' || i.can_instruct::text || ',att=' || i.hybrid_client_assignment_attested::text || ',act=' || i.active::text
                   from public.instructors i where i.id = p_instructor), 'cap=none')
      || ' | payroll=' || coalesce((select p.payroll_active::text || '/' || p.worker_classification
                   from public.instructor_payroll_profiles p where p.instructor_id = p_instructor), 'none')
      || ' | renter=' || coalesce((select c.is_independent_instructor::text from public.clients c where c.id = p_client), 'none')
      || ' | grants=' || (select count(*) from public.instructor_audit_events e where e.instructor_id = p_instructor and e.event_type = 'capability_granted')::text
      || ' | usage=' || public._landmark1a_count_counted_seats(p_studio, null)::text
$$;

revoke all on function public._s9_race_op(text, uuid, uuid, text, numeric) from public, anon, authenticated;
revoke all on function public._s9_state(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public._s9_race_tenant_op(text, uuid, numeric) from public, anon, authenticated;
grant execute on function public._s9_race_op(text, uuid, uuid, text, numeric) to service_role;
grant execute on function public._s9_state(uuid, uuid, uuid) to service_role;
grant execute on function public._s9_race_tenant_op(text, uuid, numeric) to service_role;
