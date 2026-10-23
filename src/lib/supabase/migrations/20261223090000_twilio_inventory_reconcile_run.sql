-- 20261223090000_twilio_inventory_reconcile_run.sql
-- TW-4F A9: the scheduled per-subaccount number-inventory reconciliation runs under the shared reconciliation run lease (studio_sms_reconcile_runs, 20261205).
--   * a third job kind, 'inventory_reconcile' (the job check constraint is extended, never replaced; tw4_reconcile_run_begin accepts it; nothing else in that function
--     changes), so a scheduled pass is one run at a time and every pass, including one that could not read anything, leaves a completed or FAILED run row;
--   * tw4_reconcile_run_alive(run, job): read-only, service role. The runner asks it between subaccounts and stops when the run's lease is gone (the number functions it
--     calls take their own per-onboarding leases and do not know the run).
-- Nothing here reads a provider, writes inventory evidence, changes health rules, registers a scheduler, charges or sends anything.
-- Requires 20261205090000. Rollback: rollback/20261223090000_twilio_inventory_reconcile_run_rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_reconcile_runs') is null or to_regprocedure('public.tw4_reconcile_run_begin(text,text,integer)') is null then
    raise exception 'inventory-reconcile-run precondition failed: 20261205090000 is not applied';
  end if;
  if to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is not null then
    raise exception 'inventory-reconcile-run precondition failed: already applied';
  end if;
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_reconcile_run_begin(text,text,integer)'::regprocedure), chr(13), '')), 8) <> '447385b7' then
    raise exception 'inventory-reconcile-run precondition failed: public.tw4_reconcile_run_begin(text,text,integer) differs from its main definition';
  end if;
end $$;

-- the job vocabulary: the live list plus the new job (extended, not replaced)
do $$
declare
  v_def text;
  v_jobs text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_reconcile_runs'::regclass and c.conname = 'studio_sms_reconcile_runs_job_check';
  select array_agg(distinct m[1] order by m[1]) into v_jobs from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_jobs is null or not ('usage_reconcile' = any (v_jobs)) or not ('sender_reverify' = any (v_jobs)) then
    raise exception 'could not read the reconciliation jobs from %', v_def;
  end if;
  v_jobs := (select array_agg(distinct x order by x) from unnest(v_jobs || array['inventory_reconcile']) x);
  alter table public.studio_sms_reconcile_runs drop constraint studio_sms_reconcile_runs_job_check;
  execute format('alter table public.studio_sms_reconcile_runs add constraint studio_sms_reconcile_runs_job_check check (job = any (%L::text[]))', v_jobs);
end $$;

create or replace function public.tw4_reconcile_run_begin(p_job text, p_runner text, p_lease_seconds int default 300)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  -- 20261223: 'inventory_reconcile' is a job (the number-inventory reconciliation); nothing else in this function changes
  if p_job is null or p_job not in ('usage_reconcile', 'sender_reverify', 'inventory_reconcile') or p_runner is null or char_length(btrim(p_runner)) not between 3 and 80
     or p_lease_seconds is null or p_lease_seconds not between 60 and 900 then
    raise exception 'invalid reconciliation run' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_reconcile_run:' || p_job));
  update public.studio_sms_reconcile_runs set status = 'failed', finished_at = clock_timestamp(), error = 'lease expired before the run finished'
   where job = p_job and status = 'running' and lease_expires_at <= clock_timestamp();
  insert into public.studio_sms_reconcile_runs (job, runner, lease_expires_at) values (p_job, btrim(p_runner), clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict (job) where status = 'running' do nothing returning id into v_id;
  if v_id is null then
    return jsonb_build_object('acquired', false, 'reason', 'busy');
  end if;
  return jsonb_build_object('acquired', true, 'run_id', v_id,
                            'lease_expires_at', (select r.lease_expires_at from public.studio_sms_reconcile_runs r where r.id = v_id));
end $$;

-- is this run still the job's live lease holder? (read-only; a runner stops as soon as it is not)
create or replace function public.tw4_reconcile_run_alive(p_run_id uuid, p_job text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select exists (select 1 from public.studio_sms_reconcile_runs r where r.id = p_run_id and r.job = p_job and r.status = 'running' and r.lease_expires_at > clock_timestamp()); $$;

revoke all on function public.tw4_reconcile_run_alive(uuid, text) from public, anon, authenticated;
grant execute on function public.tw4_reconcile_run_alive(uuid, text) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.tw4_reconcile_run_alive(uuid,text)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_reconcile_run_alive(uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_reconcile_run_alive(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_reconcile_run_begin(text,text,integer)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_reconcile_run_begin(text,text,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_reconcile_run_begin(text,text,integer)', 'EXECUTE') then
    raise exception 'inventory-reconcile-run postcondition failed: unexpected privileges';
  end if;
end $$;

commit;
