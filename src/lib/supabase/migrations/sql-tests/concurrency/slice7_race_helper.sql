-- Landmark 1A Slice 7 -- DEV-ONLY concurrency helper (never a migration;
-- never applied to PROD). Created by slice7_race_harness.mjs setup and
-- dropped by its cleanup.
--
-- A PostgREST RPC call is exactly one transaction on its own backend
-- connection. _s7_race_op performs one operation (a writer, a revocation, or
-- a Slice 6 grant/reactivate), records how long the operation waited, then
-- sleeps p_hold seconds INSIDE the same transaction so any advisory lock it
-- took stays held while the harness starts a competing request. Two parallel
-- HTTP requests are therefore two genuinely concurrent database sessions.
--
-- SECURITY DEFINER because the Slice 7 RPCs are (correctly) not executable by
-- service_role; staff identity is simulated with request.jwt.claims exactly as
-- the SQL regression suites do. Executable only by service_role.

create or replace function public._s7_race_op(
  p_op text,
  p_x uuid,
  p_y uuid default null,
  p_hold numeric default 0,
  p_lock_timeout_ms int default 0
)
returns text
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  c_f   constant uuid := '00000000-0000-0000-0000-00001a7f1000';
  c_g   constant uuid := '00000000-0000-0000-0000-00001a7f3000';
  c_adm constant uuid := '00000000-0000-0000-0000-00001a7f5001';
  c_cl  constant uuid := '00000000-0000-0000-0000-00001a7f5301';
  t0 timestamptz;
  o text;
  v uuid;
begin
  if p_lock_timeout_ms > 0 then
    perform set_config('lock_timeout', p_lock_timeout_ms || 'ms', true);
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_adm, 'email', 't-landmark1a-s7-race-admin@example.test')::text, true);

  t0 := clock_timestamp();
  begin
    case p_op
      when 'revoke_f' then perform public.revoke_instructor_capability(c_f, p_x);
      when 'revoke_g' then perform public.revoke_instructor_capability(c_g, p_x);
      when 'grant_g' then perform public.grant_instructor_capability(c_g, p_y);
      when 'reactivate_g' then perform public.reactivate_instructor(c_g, p_y);
      when 'w_appt' then
        insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status)
        values (c_f, c_cl, p_x, 'private_lesson', 'race', now() + interval '2 days', now() + interval '2 days 1 hour', 'scheduled');
      when 'w_br' then
        insert into public.booking_requests (studio_id, client_id, instructor_id, source, status, appointment_type, requested_starts_at, requested_ends_at)
        values (c_f, c_cl, p_x, 'portal_schedule', 'pending', 'intro_lesson', now() + interval '2 days', now() + interval '2 days 1 hour');
      when 'w_ar_book' then
        insert into public.student_booking_action_requests (studio_id, client_id, action_type, mode, status, lesson_type, instructor_id, requested_starts_at, requested_ends_at)
        values (c_f, c_cl, 'book', 'approval_required', 'pending', 'private_lesson', p_x, now() + interval '2 days', now() + interval '2 days 1 hour');
      when 'w_ar_instant' then
        insert into public.student_booking_action_requests (studio_id, client_id, action_type, mode, status, lesson_type, instructor_id, requested_starts_at, requested_ends_at)
        values (c_f, c_cl, 'book', 'instant', 'approved', 'private_lesson', p_x, now() + interval '2 days', now() + interval '2 days 1 hour');
      when 'w_ar_resched' then -- p_y = an existing appointment id (another instructor's)
        insert into public.student_booking_action_requests (studio_id, client_id, appointment_id, action_type, mode, status, lesson_type, instructor_id, requested_starts_at, requested_ends_at)
        values (c_f, c_cl, p_y, 'reschedule', 'approval_required', 'pending', 'private_lesson', p_x, now() + interval '2 days', now() + interval '2 days 1 hour');
      when 'w_materialize' then -- p_y = the pending booking_request being approved
        insert into public.appointments (studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status)
        values (c_f, c_cl, p_x, 'intro_lesson', 'race', now() + interval '2 days', now() + interval '2 days 1 hour', 'scheduled')
        returning id into v;
        update public.booking_requests set status = 'approved', appointment_id = v where id = p_y;
      when 'w_br_reopen' then -- p_y = declined booking_request
        update public.booking_requests set status = 'pending' where id = p_y;
      when 'w_ar_retarget' then -- p_y = pending action request on another instructor
        update public.student_booking_action_requests set instructor_id = p_x where id = p_y;
      when 'w_cancel_resurrect' then -- p_y = a cancelled future appointment of p_x
        update public.appointments set status = 'scheduled' where id = p_y;
      when 'w_past_future' then -- p_y = a past appointment of p_x
        update public.appointments set starts_at = now() + interval '2 days', ends_at = now() + interval '2 days 1 hour' where id = p_y;
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

create or replace function public._s7_forbidden()
returns bigint
language sql
stable
security definer
set search_path = 'public'
as $$
  select count(*) from public.instructors i
  where i.studio_id in ('00000000-0000-0000-0000-00001a7f1000', '00000000-0000-0000-0000-00001a7f3000')
    and i.can_instruct = false
    and (
      exists (select 1 from public.appointments a where a.instructor_id = i.id
              and public._landmark1a_appointment_holds_instructor(a.appointment_type::text, a.status::text, a.ends_at))
      or exists (select 1 from public.booking_requests r where r.instructor_id = i.id
              and public._landmark1a_booking_request_holds_instructor(r.status, r.appointment_id, r.requested_starts_at, r.appointment_type))
      or exists (select 1 from public.student_booking_action_requests r where r.instructor_id = i.id
              and public._landmark1a_action_request_holds_instructor(r.status, r.action_type, r.requested_starts_at, r.lesson_type))
    );
$$;

revoke all on function public._s7_race_op(text, uuid, uuid, numeric, int) from public, anon, authenticated;
revoke all on function public._s7_forbidden() from public, anon, authenticated;
grant execute on function public._s7_race_op(text, uuid, uuid, numeric, int) to service_role;
grant execute on function public._s7_forbidden() to service_role;
