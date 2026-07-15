begin;

create or replace function public.refresh_payroll_pay_period_totals(p_pay_period_id uuid)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists(select 1 from public.payroll_pay_periods where id=p_pay_period_id) then
    raise exception 'Pay period not found.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass','1',true);

  update public.payroll_pay_periods pp
  set compensation_total=t.compensation_total,
      reimbursement_total=t.reimbursement_total,
      deduction_total=t.deduction_total,
      net_payment_total=t.net_payment_total,
      updated_at=now()
  from (
    select
      coalesce(sum(taxable_compensation_amount),0) compensation_total,
      coalesce(sum(reimbursement_amount),0) reimbursement_total,
      coalesce(sum(deduction_amount),0) deduction_total,
      coalesce(sum(taxable_compensation_amount+reimbursement_amount-deduction_amount),0) net_payment_total
    from public.instructor_earnings
    where pay_period_id=p_pay_period_id and status<>'void'
  ) t
  where pp.id=p_pay_period_id;
end;
$$;

revoke execute on function public.refresh_payroll_pay_period_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_pay_period_totals(uuid) to service_role;

create or replace function public.create_payroll_pay_period(
  p_studio_id uuid,
  p_period_start date,
  p_period_end date,
  p_pay_date date default null
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare
  v_id uuid;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then
    raise exception 'Payroll access denied.';
  end if;

  if p_period_end<p_period_start then
    raise exception 'Pay-period end date must be on or after start date.';
  end if;

  if exists (
    select 1
    from public.payroll_pay_periods pp
    where pp.studio_id=p_studio_id
      and pp.status<>'void'
      and daterange(pp.period_start, pp.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'This pay period overlaps another active pay period.';
  end if;

  insert into public.payroll_pay_periods(
    studio_id,period_start,period_end,pay_date,status,created_by,updated_by
  )
  values(
    p_studio_id,p_period_start,p_period_end,p_pay_date,'open',auth.uid(),auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

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
  perform public.refresh_payroll_pay_period_totals(p_pay_period_id);
  return v_count;
end; $$;
revoke execute on function public.assign_earnings_to_pay_period(uuid,uuid) from public, anon;
grant execute on function public.assign_earnings_to_pay_period(uuid,uuid) to authenticated, service_role;

create or replace function public.assign_single_earning_to_pay_period(
  p_studio_id uuid,
  p_pay_period_id uuid,
  p_earning_id uuid
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_start date;
  v_end date;
  v_period_status text;
  v_earning_date date;
  v_earning_status text;
  v_existing_period uuid;
  v_batch_id uuid;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then
    raise exception 'Payroll access denied.';
  end if;

  select period_start,period_end,status
    into v_start,v_end,v_period_status
  from public.payroll_pay_periods
  where id=p_pay_period_id and studio_id=p_studio_id;

  if v_start is null then raise exception 'Pay period not found.'; end if;
  if v_period_status not in ('open','in_review') then
    raise exception 'Only open or in-review periods can receive earnings.';
  end if;

  select earning_date,status,pay_period_id,payroll_batch_id
    into v_earning_date,v_earning_status,v_existing_period,v_batch_id
  from public.instructor_earnings
  where id=p_earning_id and studio_id=p_studio_id;

  if v_earning_date is null then raise exception 'Earning not found.'; end if;
  if v_earning_status not in ('pending','approved') then
    raise exception 'Only pending or approved earnings can be assigned.';
  end if;
  if v_batch_id is not null then raise exception 'Batched earnings cannot be reassigned.'; end if;
  if v_existing_period is not null and v_existing_period<>p_pay_period_id then
    raise exception 'This earning is already assigned to another pay period.';
  end if;
  if v_earning_date<v_start or v_earning_date>v_end then
    raise exception 'This earning falls outside the pay-period dates.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.instructor_earnings
  set pay_period_id=p_pay_period_id,updated_at=now()
  where id=p_earning_id and studio_id=p_studio_id;

  update public.payroll_pay_periods
  set status=case when status='open' then 'in_review' else status end,
      updated_by=auth.uid(),updated_at=now()
  where id=p_pay_period_id and studio_id=p_studio_id;

  perform public.refresh_payroll_pay_period_totals(p_pay_period_id);
end;
$$;

revoke execute on function public.assign_single_earning_to_pay_period(uuid,uuid,uuid) from public, anon;
grant execute on function public.assign_single_earning_to_pay_period(uuid,uuid,uuid) to authenticated, service_role;

create or replace function public.remove_earning_from_pay_period(
  p_studio_id uuid,
  p_pay_period_id uuid,
  p_earning_id uuid
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_period_status text;
  v_batch_id uuid;
begin
  if public.current_studio_payroll_role(p_studio_id) not in ('studio_owner','studio_admin') then
    raise exception 'Payroll access denied.';
  end if;

  select status into v_period_status
  from public.payroll_pay_periods
  where id=p_pay_period_id and studio_id=p_studio_id;

  if v_period_status is null then raise exception 'Pay period not found.'; end if;
  if v_period_status not in ('open','in_review') then
    raise exception 'Only open or in-review periods can be changed.';
  end if;

  select payroll_batch_id into v_batch_id
  from public.instructor_earnings
  where id=p_earning_id and studio_id=p_studio_id and pay_period_id=p_pay_period_id;

  if not found then raise exception 'Assigned earning not found.'; end if;
  if v_batch_id is not null then raise exception 'Batched earnings cannot be removed.'; end if;

  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.instructor_earnings
  set pay_period_id=null,updated_at=now()
  where id=p_earning_id and studio_id=p_studio_id and pay_period_id=p_pay_period_id;

  perform public.refresh_payroll_pay_period_totals(p_pay_period_id);
end;
$$;

revoke execute on function public.remove_earning_from_pay_period(uuid,uuid,uuid) from public, anon;
grant execute on function public.remove_earning_from_pay_period(uuid,uuid,uuid) to authenticated, service_role;

create or replace function public.void_empty_payroll_pay_period(
  p_studio_id uuid,
  p_pay_period_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_role text;
  v_earning_count int;
  v_batch_count int;
begin
  v_role:=public.current_studio_payroll_role(p_studio_id);
  if v_role<>'studio_owner' then
    raise exception 'Only the studio owner can void a pay period.';
  end if;

  select count(*) into v_earning_count
  from public.instructor_earnings
  where studio_id=p_studio_id and pay_period_id=p_pay_period_id;

  select count(*) into v_batch_count
  from public.payroll_batches
  where studio_id=p_studio_id and pay_period_id=p_pay_period_id;

  if v_earning_count>0 or v_batch_count>0 then
    raise exception 'Remove all unbatched earnings before voiding this pay period.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.payroll_pay_periods
  set status='void',voided_at=now(),voided_by=auth.uid(),void_reason=nullif(trim(p_reason),''),
      updated_by=auth.uid(),updated_at=now(),locked_at=now()
  where id=p_pay_period_id and studio_id=p_studio_id and status in ('open','in_review');

  if not found then raise exception 'Only an open or in-review pay period can be voided.'; end if;
end;
$$;

revoke execute on function public.void_empty_payroll_pay_period(uuid,uuid,text) from public, anon;
grant execute on function public.void_empty_payroll_pay_period(uuid,uuid,text) to authenticated, service_role;

commit;
