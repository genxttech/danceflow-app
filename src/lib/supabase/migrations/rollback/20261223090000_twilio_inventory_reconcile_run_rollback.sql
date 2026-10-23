-- Rollback of 20261223090000_twilio_inventory_reconcile_run.sql: restores tw4_reconcile_run_begin and the job check exactly as they are on main (20261205) and drops
-- tw4_reconcile_run_alive. REFUSES while any 'inventory_reconcile' run exists (run history is never deleted). The restored body is verified against its main
-- fingerprint and the transaction aborts if it differs.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.tw4_reconcile_run_alive(uuid,text)') is null then
    raise exception 'inventory-reconcile-run rollback precondition failed: the migration is not applied';
  end if;
  if exists (select 1 from public.studio_sms_reconcile_runs r where r.job = 'inventory_reconcile') then
    raise exception 'inventory-reconcile-run rollback refused: inventory reconciliation runs exist' using errcode = '55000';
  end if;
  if exists (select 1 from regexp_matches((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.studio_sms_reconcile_runs'::regclass
                                            and c.conname = 'studio_sms_reconcile_runs_job_check'), '''([a-z_]+)''', 'g') m
              where m[1] not in ('usage_reconcile', 'sender_reverify', 'inventory_reconcile')) then
    raise exception 'inventory-reconcile-run rollback precondition failed: a later migration added a job (roll it back first)';
  end if;
  if position('20261223' in (select p.prosrc from pg_proc p where p.oid = 'public.tw4_reconcile_run_begin(text,text,integer)'::regprocedure)) = 0 then
    raise exception 'inventory-reconcile-run rollback precondition failed: tw4_reconcile_run_begin was changed after this migration (roll back the later migration first)';
  end if;
end $$;

create or replace function public.tw4_reconcile_run_begin(p_job text, p_runner text, p_lease_seconds int default 300)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  if p_job is null or p_job not in ('usage_reconcile', 'sender_reverify') or p_runner is null or char_length(btrim(p_runner)) not between 3 and 80
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

drop function public.tw4_reconcile_run_alive(uuid, text);

-- the 20261205 check, exactly
alter table public.studio_sms_reconcile_runs drop constraint studio_sms_reconcile_runs_job_check;
alter table public.studio_sms_reconcile_runs add constraint studio_sms_reconcile_runs_job_check check (job in ('usage_reconcile', 'sender_reverify'));

do $$
begin
  if left(md5(replace((select p.prosrc from pg_proc p where p.oid = 'public.tw4_reconcile_run_begin(text,text,integer)'::regprocedure), chr(13), '')), 8) <> '447385b7' then
    raise exception 'inventory-reconcile-run rollback postcondition failed: tw4_reconcile_run_begin differs from its main definition';
  end if;
  if not has_function_privilege('service_role', 'public.tw4_reconcile_run_begin(text,text,integer)', 'EXECUTE') or has_function_privilege('anon', 'public.tw4_reconcile_run_begin(text,text,integer)', 'EXECUTE') then
    raise exception 'inventory-reconcile-run rollback postcondition failed: unexpected privileges';
  end if;
end $$;

commit;
