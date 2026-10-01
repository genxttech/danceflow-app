-- LAUNCH-SEC-1A: payroll RPC authorization fails closed.
--
-- The eight SECURITY DEFINER payroll RPCs below are executable by
-- `authenticated` and guarded by public.current_studio_payroll_role(), which
-- returns NULL when the caller is not an active studio_owner/studio_admin of
-- p_studio_id (no role, another studio's role, instructor, front_desk, ...).
-- The previous guards were written as
--     if <role> not in ('studio_owner','studio_admin') then raise ...
--     if <role> <> 'studio_owner' then raise ...
-- and in PL/pgSQL a NULL role makes both conditions NULL, so the exception
-- was never raised. Each RPC then set danceflow.payroll_transition_bypass
-- and wrote payroll rows, so the payroll triggers did not stop it either.
--
-- This migration recreates each function from its CURRENT released body
-- (byte-identical in DEV and PROD before this change) with exactly one
-- change: the guard is made NULL-safe.
--   owner/admin RPCs: coalesce(current_studio_payroll_role(p_studio_id), '')
--                     not in ('studio_owner','studio_admin')
--   owner-only RPCs:  ... is distinct from 'studio_owner'
-- No permission is broadened: owner/admin RPCs still admit owner and admin;
-- mark_payroll_batch_paid and void_empty_payroll_pay_period still admit only
-- the owner. Signatures, return types, SECURITY DEFINER, search_path, business
-- logic, the payroll transition bypass and trigger interactions are unchanged.
-- EXECUTE grants are re-asserted to their existing state (authenticated,
-- service_role; never public/anon).
--
-- No table, column, policy, trigger or other function is changed.

begin;

CREATE OR REPLACE FUNCTION public.create_payroll_pay_period(p_studio_id uuid, p_period_start date, p_period_end date, p_pay_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then
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
$function$
;
revoke all on function public.create_payroll_pay_period(uuid, date, date, date) from public, anon;
grant execute on function public.create_payroll_pay_period(uuid, date, date, date) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_earnings_to_pay_period(p_studio_id uuid, p_pay_period_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_start date; v_end date; v_status text; v_count int;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
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
end; $function$
;
revoke all on function public.assign_earnings_to_pay_period(uuid, uuid) from public, anon;
grant execute on function public.assign_earnings_to_pay_period(uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assign_single_earning_to_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_earning_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_start date;
  v_end date;
  v_period_status text;
  v_earning_date date;
  v_earning_status text;
  v_existing_period uuid;
  v_batch_id uuid;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then
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
$function$
;
revoke all on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.remove_earning_from_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_earning_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_period_status text;
  v_batch_id uuid;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then
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
$function$
;
revoke all on function public.remove_earning_from_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.remove_earning_from_pay_period(uuid, uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_payroll_batch_from_period(p_studio_id uuid, p_pay_period_id uuid, p_provider text DEFAULT 'manual'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text; v_id uuid; v_count int;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
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
end; $function$
;
revoke all on function public.create_payroll_batch_from_period(uuid, uuid, text) from public, anon;
grant execute on function public.create_payroll_batch_from_period(uuid, uuid, text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.approve_payroll_batch(p_studio_id uuid, p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  if coalesce(public.current_studio_payroll_role(p_studio_id), '') not in ('studio_owner','studio_admin') then raise exception 'Payroll access denied.'; end if;
  select status into v_status from public.payroll_batches where id=p_batch_id and studio_id=p_studio_id;
  if v_status not in ('draft','in_review') then raise exception 'Only draft or in-review batches can be approved.'; end if;
  perform public.refresh_payroll_batch_totals(p_batch_id);
  perform set_config('danceflow.payroll_transition_bypass','1',true);
  update public.payroll_batches set status='approved',approved_at=now(),approved_by=auth.uid(),locked_at=now(),updated_by=auth.uid(),updated_at=now()
  where id=p_batch_id and studio_id=p_studio_id;
  update public.payroll_pay_periods set status='approved',approved_at=coalesce(approved_at,now()),approved_by=coalesce(approved_by,auth.uid()),
    locked_at=coalesce(locked_at,now()),updated_by=auth.uid(),updated_at=now()
  where id=(select pay_period_id from public.payroll_batches where id=p_batch_id) and status in ('open','in_review');
end; $function$
;
revoke all on function public.approve_payroll_batch(uuid, uuid) from public, anon;
grant execute on function public.approve_payroll_batch(uuid, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_payroll_batch_paid(p_studio_id uuid, p_batch_id uuid, p_payment_method text DEFAULT 'external_payroll'::text, p_provider_batch_reference text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text; v_period_id uuid; v_unpaid int;
begin
  if public.current_studio_payroll_role(p_studio_id) is distinct from 'studio_owner' then raise exception 'Only the studio owner can mark payroll paid.'; end if;
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
end; $function$
;
revoke all on function public.mark_payroll_batch_paid(uuid, uuid, text, text) from public, anon;
grant execute on function public.mark_payroll_batch_paid(uuid, uuid, text, text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.void_empty_payroll_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_earning_count int;
  v_batch_count int;
begin
  v_role:=public.current_studio_payroll_role(p_studio_id);
  if v_role is distinct from 'studio_owner' then
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
$function$
;
revoke all on function public.void_empty_payroll_pay_period(uuid, uuid, text) from public, anon;
grant execute on function public.void_empty_payroll_pay_period(uuid, uuid, text) to authenticated, service_role;

commit;
