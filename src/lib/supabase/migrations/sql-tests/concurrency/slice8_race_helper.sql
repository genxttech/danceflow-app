-- Landmark 1A Slice 8 -- DEV-ONLY concurrency helper (never a migration;
-- never applied to PROD). Created by slice8_race_harness.mjs setup and
-- dropped by its cleanup. See README.md.
--
-- A PostgREST RPC call is exactly one transaction on its own backend
-- connection. _s8_race_op performs ONE operation (a Slice 6 seat RPC, the
-- Slice 7 revocation, a direct write to instructors / user_studio_roles, or a
-- trusted entitlement change), records how long it waited, then sleeps
-- p_hold seconds INSIDE the same transaction so any advisory lock it took
-- stays held while the harness starts a competing request. Two parallel HTTP
-- requests are therefore two genuinely concurrent database sessions.
--
-- SECURITY DEFINER (owner postgres) because the Slice 6/7 RPCs are not
-- executable by service_role; staff identity is simulated with
-- request.jwt.claims (the harness admin holds studio_admin in every race
-- studio). Entitlement ops run as postgres, i.e. a trusted writer. Executable
-- only by service_role.

create or replace function public._s8_race_op(
  p_op text,
  p_studio uuid,
  p_x uuid default null,
  p_hold numeric default 0,
  p_lock_timeout_ms int default 0
)
returns text
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  c_adm constant uuid := '00000000-0000-0000-0000-00001b8e9001';
  t0 timestamptz;
  o text;
begin
  if p_lock_timeout_ms > 0 then
    perform set_config('lock_timeout', p_lock_timeout_ms || 'ms', true);
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_adm, 'email', 't-s8-race-admin@example.test')::text, true);

  t0 := clock_timestamp();
  begin
    case p_op
      when 'grant' then perform public.grant_instructor_capability(p_studio, p_x);
      when 'reactivate' then perform public.reactivate_instructor(p_studio, p_x);
      when 'revoke' then perform public.revoke_instructor_capability(p_studio, p_x);
      when 'promote' then perform public.promote_hybrid_instructor(p_studio, p_x, true, 'contractor');
      when 'direct_can' then update public.instructors set can_instruct = true where id = p_x;
      when 'direct_active' then update public.instructors set active = true where id = p_x;
      when 'downgrade' then update public.studios set billing_plan = 'starter' where id = p_studio;
      when 'remove_override' then update public.studios set billing_override_enabled = false, billing_plan = 'starter' where id = p_studio;
      when 'demote_owner' then update public.user_studio_roles set role = 'studio_admin' where studio_id = p_studio and user_id = p_x;
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

-- Derived state for post-conditions: 'limit/usage'.
create or replace function public._s8_state(p_studio uuid)
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select public._landmark1a_resolve_studio_seat_limit(p_studio)::text || '/' ||
         public._landmark1a_count_counted_seats(p_studio, null)::text;
$$;

revoke all on function public._s8_race_op(text, uuid, uuid, numeric, int) from public, anon, authenticated;
revoke all on function public._s8_state(uuid) from public, anon, authenticated;
grant execute on function public._s8_race_op(text, uuid, uuid, numeric, int) to service_role;
grant execute on function public._s8_state(uuid) to service_role;
