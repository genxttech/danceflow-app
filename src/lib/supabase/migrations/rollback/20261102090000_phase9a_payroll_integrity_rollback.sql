-- Rollback for 20261102090000_phase9a_payroll_integrity.sql.
--
-- Restores the exact pre-9A payroll definitions (captured from DEV == PROD
-- on 2026-10-09): the eight payroll RPCs, both totals functions, the
-- UPDATE-only earning lock and generic status trigger, and the direct
-- pay period/batch INSERT/UPDATE policies. Removes the Phase 9A actor-role
-- helper, integrity triggers, totals triggers and payroll-history delete
-- guard (pre-9A had no delete guard).
--
-- WARNING: this reopens the Phase 9A defects (cross-studio batch approval,
-- per-earning payment outside a batch, inserts into approved batches).
-- Roll the application back first: the 9A app no longer exposes a
-- per-earning "mark paid" action, so it is compatible with either schema.
-- No payroll rows are changed.
--
-- Line endings: the pre-9A bodies of enforce_instructor_earning_payroll_lock,
-- enforce_payroll_status_transition, refresh_payroll_batch_totals and
-- refresh_payroll_pay_period_totals were originally applied with CRLF line
-- endings. They are rebuilt with CRLF (execute + replace) so every restored
-- body is byte-identical to the pre-9A baseline the migration preflight pins.

begin;

do $$
begin
  if to_regprocedure('public.payroll_actor_role(uuid)') is null
     or to_regprocedure('public.enforce_instructor_earning_integrity()') is null then
    raise exception 'Phase 9A rollback preflight: Phase 9A is not applied.';
  end if;
end
$$;

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
-- Originally applied with CRLF line endings: restored byte-identically.
do $crlf$
begin
  execute replace($def$CREATE OR REPLACE FUNCTION public.enforce_instructor_earning_payroll_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
end; $function$$def$, E'\n', E'\r\n');
end
$crlf$;
-- Originally applied with CRLF line endings: restored byte-identically.
do $crlf$
begin
  execute replace($def$CREATE OR REPLACE FUNCTION public.enforce_payroll_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
end; $function$$def$, E'\n', E'\r\n');
end
$crlf$;
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
-- Originally applied with CRLF line endings: restored byte-identically.
do $crlf$
begin
  execute replace($def$CREATE OR REPLACE FUNCTION public.refresh_payroll_batch_totals(p_batch_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end; $function$$def$, E'\n', E'\r\n');
end
$crlf$;
-- Originally applied with CRLF line endings: restored byte-identically.
do $crlf$
begin
  execute replace($def$CREATE OR REPLACE FUNCTION public.refresh_payroll_pay_period_totals(p_pay_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$$def$, E'\n', E'\r\n');
end
$crlf$;
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

revoke all on function public.refresh_payroll_batch_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_batch_totals(uuid) to service_role;
revoke all on function public.refresh_payroll_pay_period_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_pay_period_totals(uuid) to service_role;
revoke all on function public.create_payroll_pay_period(uuid, date, date, date) from public, anon;
grant execute on function public.create_payroll_pay_period(uuid, date, date, date) to authenticated, service_role;
revoke all on function public.assign_earnings_to_pay_period(uuid, uuid) from public, anon;
grant execute on function public.assign_earnings_to_pay_period(uuid, uuid) to authenticated, service_role;
revoke all on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.remove_earning_from_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.remove_earning_from_pay_period(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.create_payroll_batch_from_period(uuid, uuid, text) from public, anon;
grant execute on function public.create_payroll_batch_from_period(uuid, uuid, text) to authenticated, service_role;
revoke all on function public.approve_payroll_batch(uuid, uuid) from public, anon;
grant execute on function public.approve_payroll_batch(uuid, uuid) to authenticated, service_role;
revoke all on function public.mark_payroll_batch_paid(uuid, uuid, text, text) from public, anon;
grant execute on function public.mark_payroll_batch_paid(uuid, uuid, text, text) to authenticated, service_role;
revoke all on function public.void_empty_payroll_pay_period(uuid, uuid, text) from public, anon;
grant execute on function public.void_empty_payroll_pay_period(uuid, uuid, text) to authenticated, service_role;

drop trigger trg_enforce_instructor_earning_integrity on public.instructor_earnings;
drop trigger trg_instructor_earnings_totals_insert on public.instructor_earnings;
drop trigger trg_instructor_earnings_totals_update on public.instructor_earnings;
drop trigger trg_instructor_earnings_totals_delete on public.instructor_earnings;
drop trigger trg_enforce_payroll_pay_period_integrity on public.payroll_pay_periods;
drop trigger trg_enforce_payroll_batch_integrity on public.payroll_batches;
drop trigger trg_prevent_instructor_earning_history_delete on public.instructor_earnings;
drop trigger trg_prevent_payroll_pay_period_history_delete on public.payroll_pay_periods;
drop trigger trg_prevent_payroll_batch_history_delete on public.payroll_batches;
drop function public.prevent_payroll_history_delete();
drop function public.enforce_instructor_earning_integrity();
drop function public.enforce_payroll_pay_period_integrity();
drop function public.enforce_payroll_batch_integrity();
drop function public.refresh_payroll_totals_after_earning_change();
drop function public.payroll_actor_role(uuid);

create policy payroll_pay_periods_insert on public.payroll_pay_periods as PERMISSIVE for INSERT to authenticated
with check (((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_pay_periods.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND (usr.role = ANY (ARRAY['studio_owner'::app_role, 'studio_admin'::app_role]))))) AND (status = ANY (ARRAY['open'::text, 'in_review'::text, 'approved'::text]))));
create policy payroll_pay_periods_update on public.payroll_pay_periods as PERMISSIVE for UPDATE to authenticated
using ((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_pay_periods.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND (usr.role = ANY (ARRAY['studio_owner'::app_role, 'studio_admin'::app_role]))))))
with check ((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_pay_periods.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND ((usr.role = 'studio_owner'::app_role) OR ((usr.role = 'studio_admin'::app_role) AND (payroll_pay_periods.status = ANY (ARRAY['open'::text, 'in_review'::text, 'approved'::text]))))))));
create policy payroll_batches_insert on public.payroll_batches as PERMISSIVE for INSERT to authenticated
with check (((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_batches.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND (usr.role = ANY (ARRAY['studio_owner'::app_role, 'studio_admin'::app_role]))))) AND (status = ANY (ARRAY['draft'::text, 'in_review'::text, 'approved'::text]))));
create policy payroll_batches_update on public.payroll_batches as PERMISSIVE for UPDATE to authenticated
using ((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_batches.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND (usr.role = ANY (ARRAY['studio_owner'::app_role, 'studio_admin'::app_role]))))))
with check ((EXISTS ( SELECT 1
   FROM user_studio_roles usr
  WHERE ((usr.studio_id = payroll_batches.studio_id) AND (usr.user_id = auth.uid()) AND (usr.active = true) AND ((usr.role = 'studio_owner'::app_role) OR ((usr.role = 'studio_admin'::app_role) AND (payroll_batches.status = ANY (ARRAY['draft'::text, 'in_review'::text, 'approved'::text]))))))));
CREATE TRIGGER trg_enforce_instructor_earning_payroll_lock BEFORE UPDATE ON public.instructor_earnings FOR EACH ROW EXECUTE FUNCTION enforce_instructor_earning_payroll_lock();
CREATE TRIGGER trg_enforce_payroll_pay_period_transition BEFORE UPDATE ON public.payroll_pay_periods FOR EACH ROW EXECUTE FUNCTION enforce_payroll_status_transition();
CREATE TRIGGER trg_enforce_payroll_batch_transition BEFORE UPDATE ON public.payroll_batches FOR EACH ROW EXECUTE FUNCTION enforce_payroll_status_transition();
commit;
