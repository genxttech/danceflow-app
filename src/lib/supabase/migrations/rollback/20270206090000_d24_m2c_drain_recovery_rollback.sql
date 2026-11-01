-- Rollback of 20270206090000_d24_m2c_drain_recovery.sql. REFUSES while drain-run or requeue evidence exists, or while any event has been requeued: export first.
-- Stop the scheduler / operator first, then run this. Restores the M1 guard and M1 d24_drain_deferred verbatim.
begin;
set local lock_timeout = '5s';
lock table public.hosted_invoice_deferred_events, public.hosted_invoice_drain_runs, public.hosted_invoice_deferred_requeues in access exclusive mode;
do $$
begin
  if exists (select 1 from public.hosted_invoice_drain_runs)
     or exists (select 1 from public.hosted_invoice_deferred_requeues)
     or exists (select 1 from public.hosted_invoice_deferred_events where requeue_count > 0) then
    raise exception 'd24 m2c rollback refused: audit evidence exists; export it first';
  end if;
end $$;
drop function if exists public.d24_requeue_deferred_event(text, uuid, text);
drop function if exists public.d24_drain_health(integer, integer);
drop function if exists public.d24_record_drain_failure(text, text);
drop function if exists public.d24_run_drain(integer, text);
drop table public.hosted_invoice_deferred_requeues;
drop table public.hosted_invoice_drain_runs;
alter table public.hosted_invoice_deferred_events
  drop constraint hosted_invoice_deferred_base_chk, drop constraint hosted_invoice_deferred_requeue_chk, drop constraint hosted_invoice_deferred_code_chk;
create or replace function public._d24_deferred_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'd24: deferred events are permanent evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if coalesce(current_setting('d24.writer', true), '') <> 'on' then
      raise exception 'd24: INSERT on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  if coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: UPDATE on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
  end if;
  if new.provider_event_id is distinct from old.provider_event_id or new.event_type is distinct from old.event_type
     or new.stripe_account_id is distinct from old.stripe_account_id or new.livemode is distinct from old.livemode
     or new.event_created is distinct from old.event_created or new.payload_hash is distinct from old.payload_hash
     or new.object_kind is distinct from old.object_kind or new.object_snapshot is distinct from old.object_snapshot
     or new.received_at is distinct from old.received_at then
    raise exception 'd24: deferred event evidence is immutable' using errcode = '42501';
  end if;
  if old.state <> 'pending' and (new.state is distinct from old.state or new.settled_at is distinct from old.settled_at) then
    raise exception 'd24: a settled deferred event cannot change state' using errcode = '42501';
  end if;
  if new.attempts < old.attempts then
    raise exception 'd24: attempts cannot decrease' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function public.d24_drain_deferred(p_limit integer default 25)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.hosted_invoice_deferred_events%rowtype;
  v_applied integer := 0;
  v_rejected integer := 0;
  v_failed integer := 0;
  v_res jsonb;
begin
  perform set_config('d24.writer', 'on', true);
  for r in select * from public.hosted_invoice_deferred_events where state = 'pending'
           order by attempts, event_created, provider_event_id limit least(greatest(coalesce(p_limit, 25), 1), 100) for update skip locked loop
    begin
      v_res := public._d24_apply_core(r.provider_event_id, r.event_type, r.event_created, r.stripe_account_id, r.livemode, r.payload_hash, r.object_kind, r.object_snapshot);
      if r.payload_mismatch and (v_res->>'invoice_row_id') is not null then
        perform public._d24_flag((v_res->>'invoice_row_id')::uuid, 'replay_payload_mismatch', true);
        perform public._d24_refresh_state((v_res->>'invoice_row_id')::uuid, 'event', r.provider_event_id);
      end if;
      update public.hosted_invoice_deferred_events set state = 'applied', settled_at = now(), attempts = attempts + 1, last_error = null
      where provider_event_id = r.provider_event_id;
      v_applied := v_applied + 1;
    exception when others then
      perform set_config('d24.writer', 'on', true);
      if sqlstate = '22023' or (r.attempts + 1 >= 5 and sqlstate not like '40%' and sqlstate not like '53%' and sqlstate not in ('55P03', '57014')) then
        update public.hosted_invoice_deferred_events set state = 'rejected', settled_at = now(), attempts = attempts + 1, last_error = left(sqlerrm, 500)
        where provider_event_id = r.provider_event_id;
        v_rejected := v_rejected + 1;
      elsif sqlstate like '40%' or sqlstate like '53%' or sqlstate in ('55P03', '57014') then
        -- transient (deadlock, serialization, lock timeout, resources, cancel): retry later and do NOT count it toward quarantine
        update public.hosted_invoice_deferred_events set last_error = left(sqlerrm, 500) where provider_event_id = r.provider_event_id;
        v_failed := v_failed + 1;
      else
        update public.hosted_invoice_deferred_events set attempts = attempts + 1, last_error = left(sqlerrm, 500) where provider_event_id = r.provider_event_id;
        v_failed := v_failed + 1;
      end if;
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'rejected', v_rejected, 'failed', v_failed);
end $$;
alter table public.hosted_invoice_deferred_events
  drop column last_error_code, drop column last_attempt_at, drop column attempt_base, drop column requeue_count;
revoke all on function public.d24_drain_deferred(integer) from public, anon, authenticated;
grant execute on function public.d24_drain_deferred(integer) to service_role;
notify pgrst, 'reload schema';
commit;
