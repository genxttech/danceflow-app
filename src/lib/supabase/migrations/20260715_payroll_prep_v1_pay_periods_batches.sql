begin;

create or replace function public.current_studio_payroll_role(p_studio_id uuid)
returns text language sql stable security definer set search_path=public as $$
  select usr.role from public.user_studio_roles usr
  where usr.studio_id=p_studio_id and usr.user_id=auth.uid() and usr.active=true
    and usr.role in ('studio_owner','studio_admin')
  order by case usr.role when 'studio_owner' then 1 else 2 end limit 1;
$$;
revoke execute on function public.current_studio_payroll_role(uuid) from public, anon;
grant execute on function public.current_studio_payroll_role(uuid) to authenticated, service_role;

create or replace function public.payroll_transition_bypass_enabled()
returns boolean language sql stable security invoker set search_path=public as $$
  select coalesce(current_setting('danceflow.payroll_transition_bypass', true),'')='1';
$$;

create or replace function public.enforce_instructor_earning_payroll_lock()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if public.payroll_transition_bypass_enabled() then return new; end if;
  if old.payroll_batch_id is not null or old.locked_at is not null then
    if new.earning_amount is distinct from old.earning_amount
      or new.pay_mode is distinct from old.pay_mode
      or new.pay_rate_amount is distinct from old.pay_rate_amount
      or new.pay_percentage is distinct from old.pay_percentage
      or new.attendance_count is distinct from old.attendance_count
      or new.taxable_compensation_amount is distinct from old.taxable_compensation_amount
      or new.reimbursement_amount is distinct from old.reimbursement_amount
      or new.deduction_amount is distinct from old.deduction_amount
      or new.worker_classification_snapshot is distinct from old.worker_classification_snapshot
      or new.accounting_category_snapshot is distinct from old.accounting_category_snapshot
      or new.pay_period_id is distinct from old.pay_period_id
      or new.payroll_batch_id is distinct from old.payroll_batch_id
      or new.status is distinct from old.status then
      raise exception 'Batched payroll earnings are locked.';
    end if;
  end if;
  if new.status='paid' and old.status is distinct from 'paid'
     and public.current_studio_payroll_role(old.studio_id) is distinct from 'studio_owner' then
    raise exception 'Only the studio owner can mark payroll paid.';
  end if;
  return new;
end; $$;
drop trigger if exists trg_enforce_instructor_earning_payroll_lock on public.instructor_earnings;
create trigger trg_enforce_instructor_earning_payroll_lock before update on public.instructor_earnings
for each row execute function public.enforce_instructor_earning_payroll_lock();

create or replace function public.enforce_payroll_status_transition()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_role text;
begin
  if public.payroll_transition_bypass_enabled() then return new; end if;
  v_role:=public.current_studio_payroll_role(old.studio_id);
  if v_role is null then raise exception 'Payroll access denied.'; end if;
  if old.status in ('paid','void') and new.status is distinct from old.status then
    raise exception 'Closed payroll records cannot be changed.';
  end if;
  if new.status in ('paid','void') and old.status is distinct from new.status and v_role<>'studio_owner' then
    raise exception 'Only the studio owner can close or void payroll.';
  end if;
  return new;
end; $$;
drop trigger if exists trg_enforce_payroll_pay_period_transition on public.payroll_pay_periods;
create trigger trg_enforce_payroll_pay_period_transition before update on public.payroll_pay_periods
for each row execute function public.enforce_payroll_status_transition();
drop trigger if exists trg_enforce_payroll_batch_transition on public.payroll_batches;
create trigger trg_enforce_payroll_batch_transition before update on public.payroll_batches
for each row execute function public.enforce_payroll_status_transition();

create or replace function public.refresh_payroll_batch_totals(p_batch_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.payroll_batches where id=p_batch_id) then raise exception 'Payroll batch not found.'; end if;
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.payroll_batches pb set
    compensation_total=t.compensation_total,
    reimbursement_total=t.reimbursement_total,
    deduction_total=t.deduction_total,
    net_payment_total=t.net_payment_total,
    earning_count=t.earning_count,
    updated_at=now()
  from (
    select coalesce(sum(taxable_compensation_amount),0) compensation_total,
      coalesce(sum(reimbursement_amount),0) reimbursement_total,
      coalesce(sum(deduction_amount),0) deduction_total,
      coalesce(sum(taxable_compensation_amount+reimbursement_amount-deduction_amount),0) net_payment_total,
      count(*)::int earning_count
    from public.instructor_earnings where payroll_batch_id=p_batch_id and status<>'void'
  ) t where pb.id=p_batch_id;
end; $$;
revoke execute on function public.refresh_payroll_batch_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_batch_totals(uuid) to service_role;

create or replace function public.create_payroll_pay_period(p_studio_id uuid,p_period_start date,p_period_end date,p_pay_date date default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
  if p_period_end<p_period_start then raise exception 'Pay-period end date must be on or after start date.'; end if;
  insert into public.payroll_pay_periods(studio_id,period_start,period_end,pay_date,status,created_by,updated_by)
  values(p_studio_id,p_period_start,p_period_end,p_pay_date,'open',auth.uid(),auth.uid()) returning id into v_id;
  return v_id;
end; $$;
revoke execute on function public.create_payroll_pay_period(uuid,date,date,date) from public, anon;
grant execute on function public.create_payroll_pay_period(uuid,date,date,date) to authenticated, service_role;

create or replace function public.assign_earnings_to_pay_period(p_studio_id uuid,p_pay_period_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_start date; v_end date; v_status text; v_count int;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
  select period_start,period_end,status into v_start,v_end,v_status from public.payroll_pay_periods
  where id=p_pay_period_id and studio_id=p_studio_id;
  if v_start is null then raise exception 'Pay period not found.'; end if;
  if v_status not in ('open','in_review') then raise exception 'Only open or in-review periods can receive earnings.'; end if;
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.instructor_earnings set pay_period_id=p_pay_period_id,updated_at=now()
  where studio_id=p_studio_id and earning_date between v_start and v_end
    and status in ('pending','approved') and payroll_batch_id is null and pay_period_id is null;
  get diagnostics v_count=row_count;
  update public.payroll_pay_periods set status=case when status='open' then 'in_review' else status end,
    updated_by=auth.uid(),updated_at=now() where id=p_pay_period_id;
  return v_count;
end; $$;
revoke execute on function public.assign_earnings_to_pay_period(uuid,uuid) from public, anon;
grant execute on function public.assign_earnings_to_pay_period(uuid,uuid) to authenticated, service_role;

create or replace function public.create_payroll_batch_from_period(p_studio_id uuid,p_pay_period_id uuid,p_provider text default 'manual')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_status text; v_id uuid; v_count int;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
  select status into v_status from public.payroll_pay_periods where id=p_pay_period_id and studio_id=p_studio_id;
  if v_status not in ('in_review','approved') then raise exception 'The pay period must be in review or approved.'; end if;
  select count(*) into v_count from public.instructor_earnings where studio_id=p_studio_id
    and pay_period_id=p_pay_period_id and payroll_batch_id is null and status='approved';
  if v_count=0 then raise exception 'No approved, unbatched earnings are available.'; end if;
  insert into public.payroll_batches(studio_id,pay_period_id,provider,status,created_by,updated_by)
  values(p_studio_id,p_pay_period_id,coalesce(nullif(trim(p_provider),''),'manual'),'draft',auth.uid(),auth.uid()) returning id into v_id;
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.instructor_earnings set payroll_batch_id=v_id,locked_at=now(),updated_at=now()
  where studio_id=p_studio_id and pay_period_id=p_pay_period_id and payroll_batch_id is null and status='approved';
  perform public.refresh_payroll_batch_totals(v_id);
  return v_id;
end; $$;
revoke execute on function public.create_payroll_batch_from_period(uuid,uuid,text) from public, anon;
grant execute on function public.create_payroll_batch_from_period(uuid,uuid,text) to authenticated, service_role;

create or replace function public.approve_payroll_batch(p_studio_id uuid,p_batch_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
  select status into v_status from public.payroll_batches where id=p_batch_id and studio_id=p_studio_id;
  if v_status not in ('draft','in_review') then raise exception 'Only draft or in-review batches can be approved.'; end if;
  perform public.refresh_payroll_batch_totals(p_batch_id);
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.payroll_batches set status='approved',approved_at=now(),approved_by=auth.uid(),locked_at=now(),updated_by=auth.uid(),updated_at=now()
  where id=p_batch_id and studio_id=p_studio_id;
  update public.payroll_pay_periods set status='approved',approved_at=coalesce(approved_at,now()),approved_by=coalesce(approved_by,auth.uid()),
    locked_at=coalesce(locked_at,now()),updated_by=auth.uid(),updated_at=now()
  where id=(select pay_period_id from public.payroll_batches where id=p_batch_id) and status in ('open','in_review');
end; $$;
revoke execute on function public.approve_payroll_batch(uuid,uuid) from public, anon;
grant execute on function public.approve_payroll_batch(uuid,uuid) to authenticated, service_role;

create or replace function public.mark_payroll_batch_paid(p_studio_id uuid,p_batch_id uuid,p_payment_method text default 'external_payroll',p_provider_batch_reference text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_status text; v_period_id uuid; v_unpaid int;
begin
  if public.current_studio_payroll_role(p_studio_id)<>'studio_owner' then raise exception 'Only the studio owner can mark payroll paid.'; end if;
  select status,pay_period_id into v_status,v_period_id from public.payroll_batches where id=p_batch_id and studio_id=p_studio_id;
  if v_status<>'approved' then raise exception 'The payroll batch must be approved before payment.'; end if;
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.instructor_earnings set status='paid',paid_at=now(),paid_by=auth.uid(),
    payment_method=coalesce(nullif(trim(p_payment_method),''),'external_payroll'),updated_at=now()
  where studio_id=p_studio_id and payroll_batch_id=p_batch_id and status='approved';
  update public.payroll_batches set status='paid',paid_at=now(),paid_by=auth.uid(),
    payment_method=coalesce(nullif(trim(p_payment_method),''),'external_payroll'),
    provider_batch_reference=nullif(trim(p_provider_batch_reference),''),locked_at=coalesce(locked_at,now()),updated_by=auth.uid(),updated_at=now()
  where id=p_batch_id and studio_id=p_studio_id;
  select count(*) into v_unpaid from public.payroll_batches where studio_id=p_studio_id and pay_period_id=v_period_id and status not in ('paid','void');
  if v_unpaid=0 then
    update public.payroll_pay_periods set status='paid',paid_at=now(),paid_by=auth.uid(),locked_at=coalesce(locked_at,now()),updated_by=auth.uid(),updated_at=now()
    where id=v_period_id and studio_id=p_studio_id;
  end if;
end; $$;
revoke execute on function public.mark_payroll_batch_paid(uuid,uuid,text,text) from public, anon;
grant execute on function public.mark_payroll_batch_paid(uuid,uuid,text,text) to authenticated, service_role;

commit;
