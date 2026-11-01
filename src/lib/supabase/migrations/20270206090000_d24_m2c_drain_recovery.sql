-- 20270206090000_d24_m2c_drain_recovery.sql
-- D24 M2-C: controlled deferred drain, poison-event isolation, monitoring evidence and audited dead-letter requeue.
--   * hosted_invoice_deferred_events   + last_error_code, last_attempt_at, attempt_base, requeue_count (additive; evidence columns stay immutable).
--   * hosted_invoice_drain_runs        append-only audit row per controlled drain run (and per failed run reported by the caller).
--   * hosted_invoice_deferred_requeues append-only audit row per operator-initiated requeue of a rejected event. Nothing is ever deleted.
--   * d24_drain_deferred(integer)      REPLACED (same signature): records the error code, orders retried events behind fresh ones (a stuck event cannot starve newer
--                                      ones), and counts quarantine attempts from attempt_base so a requeued event gets a full, fresh attempt budget.
--   * d24_run_drain(batch, trigger)    service-role entry point for ONE bounded batch: singleton advisory lock (second runner returns outcome 'busy'), lock_timeout,
--                                      batch capped at 100, writes the drain-run audit row in the same transaction. The caller loops (bounded) in the application.
--   * d24_record_drain_failure(...)    audit row for a run that failed before it could audit itself (error code only, never a message or payload).
--   * d24_drain_health(...)            read-only monitoring: counts by state and recovery class, oldest pending age, attempts, error CODES, alarms. No payload, no messages.
--   * d24_requeue_deferred_event(...)  rejected -> pending, reason and actor required, append-only evidence, max 5 requeues per event. SERVICE ROLE ONLY.
--                                      p_actor is NOT verified here: the authorization wrapper belongs to D24 M2-B, which must pass a verified identity.
-- Automatic recovery (transient retry, bounded quarantine) is the drain; manual recovery (requeue) is a separate, audited function. They never call each other.
-- Dark: nothing calls these functions until an operator or a scheduler is authorized. NOT APPLIED to any shared environment by this file. No cron job is registered here.
-- Requires 20270203110000_d24_hosted_invoice_facts.sql. Rollback: rollback/20270206090000_d24_m2c_drain_recovery_rollback.sql

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.hosted_invoice_deferred_events') is null
     or to_regprocedure('public.d24_drain_deferred(integer)') is null
     or to_regprocedure('public._d24_apply_core(text,text,bigint,text,boolean,text,text,jsonb)') is null then
    raise exception 'd24 m2c precondition failed: D24 M1 (20270203110000) is not applied';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Deferred events: recovery bookkeeping (evidence columns remain immutable via the guard below)
-- ---------------------------------------------------------------------------------------------------------------------

alter table public.hosted_invoice_deferred_events
  add column last_error_code text,
  add column last_attempt_at timestamptz,
  add column attempt_base integer not null default 0,
  add column requeue_count integer not null default 0;
alter table public.hosted_invoice_deferred_events
  add constraint hosted_invoice_deferred_base_chk check (attempt_base >= 0 and attempt_base <= attempts),
  add constraint hosted_invoice_deferred_requeue_chk check (requeue_count >= 0),
  add constraint hosted_invoice_deferred_code_chk check (last_error_code is null or last_error_code ~ '^[0-9A-Z]{5}$');

-- A settled event can only leave 'rejected' through d24_requeue_deferred_event (flag d24.requeue), exactly once per requeue, with attempts untouched.
create or replace function public._d24_deferred_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare v_requeue boolean;
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
  v_requeue := old.state = 'rejected' and new.state = 'pending' and coalesce(current_setting('d24.requeue', true), '') = 'on';
  if v_requeue then
    if new.settled_at is not null or new.attempts is distinct from old.attempts or new.attempt_base is distinct from old.attempts
       or new.requeue_count is distinct from old.requeue_count + 1 then
      raise exception 'd24: a requeue must keep attempts and advance requeue_count by exactly one' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.state <> 'pending' and (new.state is distinct from old.state or new.settled_at is distinct from old.settled_at) then
    raise exception 'd24: a settled deferred event cannot change state' using errcode = '42501';
  end if;
  if new.attempts < old.attempts then
    raise exception 'd24: attempts cannot decrease' using errcode = '42501';
  end if;
  if new.attempt_base is distinct from old.attempt_base or new.requeue_count is distinct from old.requeue_count then
    raise exception 'd24: recovery bookkeeping changes only through a requeue' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Audit tables (append-only, service-role read)
-- ---------------------------------------------------------------------------------------------------------------------

create table public.hosted_invoice_drain_runs (
  id bigint generated always as identity primary key,
  trigger_kind text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  outcome text not null,
  error_code text,
  batch_size integer,
  picked integer,
  applied integer,
  rejected integer,
  failed integer,
  oldest_pending_age_seconds bigint,
  pending_after bigint,
  constraint hosted_invoice_drain_runs_trigger_chk check (trigger_kind in ('scheduled', 'manual')),
  constraint hosted_invoice_drain_runs_outcome_chk check (outcome in ('completed', 'error')),
  constraint hosted_invoice_drain_runs_code_chk check (error_code is null or error_code ~ '^[A-Za-z0-9_]{1,32}$'),
  constraint hosted_invoice_drain_runs_shape_chk check ((outcome = 'error') = (error_code is not null))
);
create index hosted_invoice_drain_runs_started_idx on public.hosted_invoice_drain_runs (started_at desc);

create table public.hosted_invoice_deferred_requeues (
  id bigint generated always as identity primary key,
  provider_event_id text not null references public.hosted_invoice_deferred_events(provider_event_id) on delete restrict,
  requeued_at timestamptz not null default now(),
  actor_user_id uuid not null,
  reason text not null,
  requeue_number integer not null,
  prior_attempts integer not null,
  prior_error_code text,
  prior_error text,
  constraint hosted_invoice_deferred_requeues_reason_chk check (length(btrim(reason)) between 1 and 500),
  constraint hosted_invoice_deferred_requeues_unique unique (provider_event_id, requeue_number)
);

do $$
declare t text;
begin
  foreach t in array array['hosted_invoice_drain_runs', 'hosted_invoice_deferred_requeues'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public._d24_require_writer()', t || '_writer_trg', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._d24_append_only()', t || '_append_trg', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public._d24_append_only()', t || '_trunc_trg', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Drain (automatic recovery). Same signature and result keys as M1, plus 'picked'.
-- Each event is its own savepoint, so one poison event never blocks or rolls back the others.
--   22023 (validation)                     -> rejected at once (permanent; kept as evidence with its code)
--   transient 40xxx / 53xxx / 55P03 / 57014 -> stays pending, NOT counted toward quarantine, queued behind other events of the same tier
--   anything else                          -> counted; rejected when this attempt is the 5th since attempt_base (so a requeue earns a fresh budget of 5)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_drain_deferred(p_limit integer default 25)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  r public.hosted_invoice_deferred_events%rowtype;
  v_picked integer := 0;
  v_applied integer := 0;
  v_rejected integer := 0;
  v_failed integer := 0;
  v_started timestamptz := clock_timestamp();
  v_res jsonb;
begin
  perform set_config('d24.writer', 'on', true);
  for r in select * from public.hosted_invoice_deferred_events where state = 'pending'
           order by attempts - attempt_base, coalesce(last_attempt_at, '-infinity'::timestamptz), event_created, provider_event_id
           limit least(greatest(coalesce(p_limit, 25), 1), 100) for update skip locked loop
    -- run-level budget: a blocked key must not stack one lock wait per event until the caller's statement timeout rolls the whole batch back
    exit when v_picked > 0 and clock_timestamp() - v_started > interval '20 seconds';
    v_picked := v_picked + 1;
    begin
      v_res := public._d24_apply_core(r.provider_event_id, r.event_type, r.event_created, r.stripe_account_id, r.livemode, r.payload_hash, r.object_kind, r.object_snapshot);
      if r.payload_mismatch and (v_res->>'invoice_row_id') is not null then
        perform public._d24_flag((v_res->>'invoice_row_id')::uuid, 'replay_payload_mismatch', true);
        perform public._d24_refresh_state((v_res->>'invoice_row_id')::uuid, 'event', r.provider_event_id);
      end if;
      update public.hosted_invoice_deferred_events
      set state = 'applied', settled_at = now(), attempts = attempts + 1, last_error = null, last_error_code = null, last_attempt_at = now()
      where provider_event_id = r.provider_event_id;
      v_applied := v_applied + 1;
    exception when others then
      perform set_config('d24.writer', 'on', true);
      if sqlstate = '22023' or ((r.attempts - r.attempt_base) + 1 >= 5 and sqlstate not like '40%' and sqlstate not like '53%' and sqlstate not in ('55P03', '57014')) then
        update public.hosted_invoice_deferred_events
        set state = 'rejected', settled_at = now(), attempts = attempts + 1, last_error = left(sqlerrm, 500), last_error_code = sqlstate, last_attempt_at = now()
        where provider_event_id = r.provider_event_id;
        v_rejected := v_rejected + 1;
      elsif sqlstate like '40%' or sqlstate like '53%' or sqlstate in ('55P03', '57014') then
        update public.hosted_invoice_deferred_events
        set last_error = left(sqlerrm, 500), last_error_code = sqlstate, last_attempt_at = now()
        where provider_event_id = r.provider_event_id;
        v_failed := v_failed + 1;
      else
        update public.hosted_invoice_deferred_events
        set attempts = attempts + 1, last_error = left(sqlerrm, 500), last_error_code = sqlstate, last_attempt_at = now()
        where provider_event_id = r.provider_event_id;
        v_failed := v_failed + 1;
      end if;
    end;
  end loop;
  return jsonb_build_object('picked', v_picked, 'applied', v_applied, 'rejected', v_rejected, 'failed', v_failed);
end $$;

-- ONE bounded batch, singleton. The application loops (bounded by batches and wall-clock) and stops on 'busy'.
create or replace function public.d24_run_drain(p_batch_size integer default 25, p_trigger text default 'manual')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_batch integer := least(greatest(coalesce(p_batch_size, 25), 1), 100);
  v_started timestamptz := clock_timestamp();
  v_oldest bigint;
  v_res jsonb;
  v_after bigint;
  v_run bigint;
begin
  if p_trigger is null or p_trigger not in ('scheduled', 'manual') then
    raise exception 'd24_run_drain: trigger must be scheduled or manual' using errcode = '22023';
  end if;
  -- only one controlled run at a time; the loser backs off without touching any event (skip locked would make a second runner safe, but not quiet)
  if not pg_try_advisory_xact_lock(hashtextextended('d24:drain-run', 0)) then
    return jsonb_build_object('outcome', 'busy');
  end if;
  perform set_config('lock_timeout', '1s', true);   -- a lock wait becomes transient 55P03 for that event instead of an open-ended stall
  perform set_config('d24.writer', 'on', true);
  select floor(extract(epoch from (now() - min(received_at))))::bigint into v_oldest
  from public.hosted_invoice_deferred_events where state = 'pending';
  v_res := public.d24_drain_deferred(v_batch);
  select count(*) into v_after from public.hosted_invoice_deferred_events where state = 'pending';
  insert into public.hosted_invoice_drain_runs
    (trigger_kind, started_at, finished_at, outcome, batch_size, picked, applied, rejected, failed, oldest_pending_age_seconds, pending_after)
  values (p_trigger, v_started, clock_timestamp(), 'completed', v_batch, (v_res->>'picked')::int, (v_res->>'applied')::int, (v_res->>'rejected')::int,
          (v_res->>'failed')::int, v_oldest, v_after)
  returning id into v_run;
  return v_res || jsonb_build_object('outcome', 'completed', 'run_id', v_run, 'batch_size', v_batch, 'pending_after', v_after,
                                     'more', (v_res->>'picked')::int = v_batch and v_after > 0);
end $$;

-- A run that failed before it could audit itself (the transaction rolled back). Error CODE only: never a message, never a payload.
create or replace function public.d24_record_drain_failure(p_trigger text, p_error_code text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_run bigint;
begin
  if p_trigger is null or p_trigger not in ('scheduled', 'manual') or p_error_code is null or p_error_code !~ '^[A-Za-z0-9_]{1,32}$' then
    raise exception 'd24_record_drain_failure: trigger and a short error code are required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  insert into public.hosted_invoice_drain_runs (trigger_kind, outcome, error_code) values (p_trigger, 'error', p_error_code) returning id into v_run;
  return jsonb_build_object('outcome', 'recorded', 'run_id', v_run);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Monitoring (read-only; exposes counts, ages and error CODES only)
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_drain_health(p_stale_pending_seconds integer default 900, p_run_gap_seconds integer default 1800)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_by_state jsonb;
  v_recovery jsonb;
  v_codes jsonb;
  v_last jsonb;
  v_pending bigint;
  v_oldest bigint;
  v_rejected bigint;
  v_mismatch bigint;
  v_last_ok timestamptz;
  v_err_1h bigint;
  v_last_outcome text;
  v_requeues bigint;
  v_requeues_24h bigint;
  v_alarms text[] := '{}';
begin
  select count(*) filter (where state = 'pending'),
         floor(extract(epoch from (now() - min(received_at) filter (where state = 'pending'))))::bigint,
         count(*) filter (where state = 'rejected'),
         count(*) filter (where payload_mismatch)
  into v_pending, v_oldest, v_rejected, v_mismatch
  from public.hosted_invoice_deferred_events;

  select jsonb_build_object(
    'pending', jsonb_build_object('count', v_pending, 'oldest_age_seconds', v_oldest,
                                  'max_attempts', coalesce(max(attempts) filter (where state = 'pending'), 0)),
    'applied', jsonb_build_object('count', count(*) filter (where state = 'applied')),
    'rejected', jsonb_build_object('count', v_rejected)),
  jsonb_build_object(
    'pending_fresh', count(*) filter (where state = 'pending' and last_error_code is null and requeue_count = 0),
    'pending_requeued', count(*) filter (where state = 'pending' and last_error_code is null and requeue_count > 0),
    'pending_retrying', count(*) filter (where state = 'pending' and last_error_code is not null),
    'rejected_validation', count(*) filter (where state = 'rejected' and last_error_code = '22023'),
    'rejected_exhausted', count(*) filter (where state = 'rejected' and coalesce(last_error_code, '') <> '22023'),
    'applied_after_requeue', count(*) filter (where state = 'applied' and requeue_count > 0))
  into v_by_state, v_recovery
  from public.hosted_invoice_deferred_events;

  select coalesce(jsonb_object_agg(code, n), '{}'::jsonb) into v_codes
  from (select coalesce(last_error_code, 'unknown') as code, count(*) as n
        from public.hosted_invoice_deferred_events
        where state in ('pending', 'rejected') and (last_error_code is not null or state = 'rejected') group by 1) c;

  select to_jsonb(x) into v_last from (
    select id as run_id, trigger_kind, outcome, error_code, started_at, finished_at, picked, applied, rejected, failed, pending_after
    from public.hosted_invoice_drain_runs order by id desc limit 1) x;
  select outcome into v_last_outcome from public.hosted_invoice_drain_runs order by id desc limit 1;
  select finished_at into v_last_ok from public.hosted_invoice_drain_runs where outcome = 'completed' order by id desc limit 1;
  select count(*) into v_err_1h from public.hosted_invoice_drain_runs where outcome = 'error' and started_at > now() - interval '1 hour';
  select count(*), count(*) filter (where requeued_at > now() - interval '24 hours') into v_requeues, v_requeues_24h from public.hosted_invoice_deferred_requeues;

  if v_pending > 0 and v_oldest > p_stale_pending_seconds then v_alarms := array_append(v_alarms, 'pending_stale'); end if;
  if v_rejected > 0 then v_alarms := array_append(v_alarms, 'rejected_present'); end if;
  if v_pending > 0 and (v_last_ok is null or v_last_ok < now() - make_interval(secs => p_run_gap_seconds)) then v_alarms := array_append(v_alarms, 'drain_not_running'); end if;
  if v_last_outcome = 'error' or v_err_1h >= 3 then v_alarms := array_append(v_alarms, 'drain_errors'); end if;
  if v_mismatch > 0 then v_alarms := array_append(v_alarms, 'payload_mismatch_present'); end if;

  return jsonb_build_object('generated_at', now(), 'by_state', v_by_state, 'recovery', v_recovery, 'error_codes', v_codes,
                            'payload_mismatch_count', v_mismatch, 'last_run', coalesce(v_last, 'null'::jsonb),
                            'runs_with_errors_last_hour', v_err_1h, 'requeues_total', v_requeues, 'requeues_last_24h', v_requeues_24h,
                            'alarms', to_jsonb(v_alarms));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Operator-initiated requeue (manual recovery). Service role only. p_actor is NOT verified here: M2-B's authorization wrapper must pass a verified identity.
-- Never deletes or edits evidence: the snapshot, hash and received_at are immutable; the only change is rejected -> pending with a fresh attempt budget,
-- and the prior error is copied into the append-only requeue log before it is cleared.
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.d24_requeue_deferred_event(p_provider_event_id text, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.hosted_invoice_deferred_events%rowtype;
begin
  if p_provider_event_id is null or length(p_provider_event_id) = 0 or p_actor is null or p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception 'd24_requeue_deferred_event: event, actor and a reason (1-500 chars) are required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  select * into r from public.hosted_invoice_deferred_events where provider_event_id = p_provider_event_id for update;
  if not found then raise exception 'd24_deferred_event_not_found' using errcode = 'P0002'; end if;
  if r.state <> 'rejected' then
    raise exception 'd24_requeue_requires_rejected_event' using errcode = '55000';
  end if;
  if r.requeue_count >= 5 then
    raise exception 'd24_requeue_limit_reached' using errcode = '55000';
  end if;
  insert into public.hosted_invoice_deferred_requeues (provider_event_id, actor_user_id, reason, requeue_number, prior_attempts, prior_error_code, prior_error)
  values (r.provider_event_id, p_actor, p_reason, r.requeue_count + 1, r.attempts, r.last_error_code, r.last_error);
  perform set_config('d24.requeue', 'on', true);
  update public.hosted_invoice_deferred_events
  set state = 'pending', settled_at = null, attempt_base = attempts, requeue_count = requeue_count + 1, last_error = null, last_error_code = null
  where provider_event_id = r.provider_event_id;
  perform set_config('d24.requeue', 'off', true);
  return jsonb_build_object('outcome', 'requeued', 'provider_event_id', r.provider_event_id, 'requeue_count', r.requeue_count + 1);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function public.d24_drain_deferred(integer) from public, anon, authenticated;
revoke all on function public.d24_run_drain(integer, text) from public, anon, authenticated;
revoke all on function public.d24_record_drain_failure(text, text) from public, anon, authenticated;
revoke all on function public.d24_drain_health(integer, integer) from public, anon, authenticated;
revoke all on function public.d24_requeue_deferred_event(text, uuid, text) from public, anon, authenticated;
-- the bare batch function is internal: callers use d24_run_drain (singleton, lock_timeout, audit). M1 granted it to service_role; revoke that grant.
revoke execute on function public.d24_drain_deferred(integer) from service_role;
grant execute on function public.d24_run_drain(integer, text) to service_role;
grant execute on function public.d24_record_drain_failure(text, text) to service_role;
grant execute on function public.d24_drain_health(integer, integer) to service_role;
grant execute on function public.d24_requeue_deferred_event(text, uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
