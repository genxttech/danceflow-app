-- Rollback for 20261103090000_phase9b_payroll_approval_evidence.sql.
--
-- Restores the exact Phase 9A definitions of approve_payroll_batch,
-- mark_payroll_batch_paid and enforce_payroll_batch_integrity (copied from
-- 20261102090000_phase9a_payroll_integrity.sql) and removes the Phase 9B
-- evidence objects.
--
-- Payroll evidence is never destroyed by this file: it refuses to run if any
-- approval snapshot, payment evidence or export event exists. Rolling back
-- after evidence has been written needs a separately reviewed decision about
-- that evidence. Roll the application back first (the 9B app reads the
-- evidence tables).

begin;

do $$
begin
  if to_regclass('public.payroll_batch_approval_snapshots') is null
     or to_regprocedure('public.record_payroll_export(uuid, uuid, text, integer, numeric)') is null then
    raise exception 'Phase 9B rollback preflight: Phase 9B is not applied.';
  end if;
  if exists (select 1 from public.payroll_batch_approval_snapshots)
     or exists (select 1 from public.payroll_batch_approval_snapshot_lines)
     or exists (select 1 from public.payroll_batch_payment_evidence)
     or exists (select 1 from public.payroll_export_events) then
    raise exception 'Phase 9B rollback refused: payroll evidence exists and must not be dropped without a separate decision.';
  end if;
end
$$;

create or replace function public.enforce_payroll_batch_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass boolean := public.payroll_transition_bypass_enabled();
  v_stamps constant text[] := array['status', 'compensation_total', 'reimbursement_total', 'deduction_total',
    'net_payment_total', 'earning_count', 'approved_at', 'approved_by', 'paid_at', 'paid_by', 'payment_method',
    'voided_at', 'voided_by', 'void_reason', 'locked_at'];
  v_payment_fields constant text[] := array['status', 'paid_at', 'paid_by', 'payment_method',
    'provider_batch_reference', 'locked_at', 'updated_by', 'updated_at'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_period_studio uuid;
  v_period_status text;
begin
  if tg_op = 'INSERT' then
    select studio_id, status into v_period_studio, v_period_status
    from public.payroll_pay_periods where id = new.pay_period_id;
    if v_period_studio is null or v_period_studio <> new.studio_id then
      raise exception 'Payroll batch pay period must belong to the same studio.';
    end if;
    if v_period_status in ('paid', 'void') then
      raise exception 'Closed pay periods cannot receive payroll batches.';
    end if;
    if new.status <> 'draft' or new.compensation_total <> 0 or new.reimbursement_total <> 0
       or new.deduction_total <> 0 or new.net_payment_total <> 0 or new.earning_count <> 0
       or new.approved_at is not null or new.paid_at is not null or new.voided_at is not null
       or new.locked_at is not null then
      raise exception 'New payroll batches must start as empty drafts.';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);

  if new.studio_id is distinct from old.studio_id or new.pay_period_id is distinct from old.pay_period_id
     or new.batch_number is distinct from old.batch_number then
    raise exception 'Payroll batch studio, pay period and number cannot be changed.';
  end if;

  if old.status in ('paid', 'void') then
    if (v_new - 'updated_at') is distinct from (v_old - 'updated_at') then
      raise exception 'Closed payroll records cannot be changed.';
    end if;
    return new;
  end if;

  if not v_bypass and exists (select 1 from unnest(v_stamps) f where (v_new -> f) is distinct from (v_old -> f)) then
    raise exception 'Payroll batch status and totals are managed by payroll operations.';
  end if;

  if old.status = 'approved' then
    -- Approved totals are frozen; the only change left is canonical payment.
    if (v_new - v_payment_fields) is distinct from (v_old - v_payment_fields)
       or (new.status = 'approved'
           and (v_new - array['updated_by', 'updated_at']) is distinct from (v_old - array['updated_by', 'updated_at'])) then
      raise exception 'Approved payroll batches are locked.';
    end if;
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('in_review', 'approved', 'void'))
            or (old.status = 'in_review' and new.status in ('approved', 'void'))
            or (old.status = 'approved' and new.status = 'paid')) then
      raise exception 'Invalid payroll batch transition from % to %.', old.status, new.status;
    end if;
    if new.status = 'approved' and exists (
      select 1 from public.instructor_earnings e
      where e.payroll_batch_id = new.id and e.status not in ('approved', 'void')) then
      raise exception 'Only approved earnings can be approved in a payroll batch.';
    end if;
    if new.status = 'paid' and exists (
      select 1 from public.instructor_earnings e
      where e.payroll_batch_id = new.id and e.status not in ('paid', 'void')) then
      raise exception 'A payroll batch is paid only after its earnings are paid.';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_payroll_batch_integrity() from public, anon, authenticated;

create or replace function public.approve_payroll_batch(p_studio_id uuid, p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_batch record;
  v_period_status text;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select id, pay_period_id, status into v_batch
  from public.payroll_batches
  where id = p_batch_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Payroll batch not found.'; end if;
  if v_batch.status not in ('draft', 'in_review') then
    raise exception 'Only draft or in-review batches can be approved.';
  end if;
  select status into v_period_status
  from public.payroll_pay_periods
  where id = v_batch.pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if exists (
    select 1 from public.instructor_earnings e
    where e.payroll_batch_id = v_batch.id
      and (e.studio_id <> p_studio_id or e.pay_period_id is distinct from v_batch.pay_period_id
           or e.status not in ('approved', 'void') or e.locked_at is null)
  ) then
    raise exception 'Payroll batch contains earnings that are not approved for this studio.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  perform public.refresh_payroll_batch_totals(v_batch.id);
  update public.payroll_batches
  set status = 'approved', approved_at = now(), approved_by = auth.uid(), locked_at = now(),
      updated_by = auth.uid(), updated_at = now()
  where id = v_batch.id and studio_id = p_studio_id;
  update public.payroll_pay_periods
  set status = 'approved', approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, auth.uid()),
      locked_at = coalesce(locked_at, now()), updated_by = auth.uid(), updated_at = now()
  where id = v_batch.pay_period_id and studio_id = p_studio_id and status in ('open', 'in_review');
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.approve_payroll_batch(uuid, uuid) from public, anon;
grant execute on function public.approve_payroll_batch(uuid, uuid) to authenticated, service_role;

create or replace function public.mark_payroll_batch_paid(p_studio_id uuid, p_batch_id uuid, p_payment_method text default 'external_payroll'::text, p_provider_batch_reference text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_batch record;
  v_method text := coalesce(nullif(trim(p_payment_method), ''), 'external_payroll');
  v_expected int;
  v_paid int;
  v_totals record;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'platform_admin') then
    raise exception 'Only the studio owner can mark payroll paid.';
  end if;
  select id, pay_period_id, status, compensation_total, reimbursement_total, deduction_total, net_payment_total, earning_count
    into v_batch
  from public.payroll_batches
  where id = p_batch_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Payroll batch not found.'; end if;
  if v_batch.status <> 'approved' then
    raise exception 'The payroll batch must be approved before payment.';
  end if;
  perform 1 from public.payroll_pay_periods
  where id = v_batch.pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;

  if exists (
    select 1 from public.instructor_earnings e
    where e.payroll_batch_id = v_batch.id
      and (e.studio_id <> p_studio_id or e.pay_period_id is distinct from v_batch.pay_period_id
           or e.status not in ('approved', 'void') or e.locked_at is null)
  ) then
    raise exception 'Payroll batch contains earnings that are not approved for this studio.';
  end if;

  select coalesce(sum(taxable_compensation_amount), 0) compensation_total,
    coalesce(sum(reimbursement_amount), 0) reimbursement_total,
    coalesce(sum(deduction_amount), 0) deduction_total,
    coalesce(sum(taxable_compensation_amount + reimbursement_amount - deduction_amount), 0) net_payment_total,
    count(*)::int earning_count
    into v_totals
  from public.instructor_earnings
  where payroll_batch_id = v_batch.id and studio_id = p_studio_id and status = 'approved';
  if (v_totals.compensation_total, v_totals.reimbursement_total, v_totals.deduction_total, v_totals.net_payment_total, v_totals.earning_count)
     is distinct from (v_batch.compensation_total, v_batch.reimbursement_total, v_batch.deduction_total, v_batch.net_payment_total, v_batch.earning_count) then
    raise exception 'Payroll batch totals do not match its approved earnings.';
  end if;
  v_expected := v_totals.earning_count;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.instructor_earnings
  set status = 'paid', paid_at = now(), paid_by = auth.uid(), payment_method = v_method, updated_at = now()
  where studio_id = p_studio_id and payroll_batch_id = v_batch.id and status = 'approved';
  get diagnostics v_paid = row_count;
  if v_paid <> v_expected then
    raise exception 'Payroll batch payment did not cover every approved earning.';
  end if;
  update public.payroll_batches
  set status = 'paid', paid_at = now(), paid_by = auth.uid(), payment_method = v_method,
      provider_batch_reference = coalesce(nullif(trim(p_provider_batch_reference), ''), provider_batch_reference),
      locked_at = coalesce(locked_at, now()), updated_by = auth.uid(), updated_at = now()
  where id = v_batch.id and studio_id = p_studio_id;
  update public.payroll_pay_periods
  set status = 'paid', paid_at = now(), paid_by = auth.uid(), locked_at = coalesce(locked_at, now()),
      updated_by = auth.uid(), updated_at = now()
  where id = v_batch.pay_period_id and studio_id = p_studio_id and status = 'approved'
    and not exists (select 1 from public.payroll_batches b
                    where b.pay_period_id = v_batch.pay_period_id and b.status not in ('paid', 'void'))
    and not exists (select 1 from public.instructor_earnings e
                    where e.pay_period_id = v_batch.pay_period_id and e.payroll_batch_id is null and e.status <> 'void');
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.mark_payroll_batch_paid(uuid, uuid, text, text) from public, anon;
grant execute on function public.mark_payroll_batch_paid(uuid, uuid, text, text) to authenticated, service_role;

drop function public.get_payroll_batch_export(uuid, uuid);
drop function public.record_payroll_export(uuid, uuid, text, integer, numeric);
drop table public.payroll_export_events;
drop table public.payroll_batch_payment_evidence;
drop table public.payroll_batch_approval_snapshot_lines;
drop table public.payroll_batch_approval_snapshots;
drop table public.payroll_evidence_activation;
drop function public.payroll_approval_snapshot_fingerprint(uuid);
drop function public.payroll_snapshot_line_text(uuid, uuid, text, uuid, text, uuid, text, text, date, numeric, text,
  numeric, numeric, integer, numeric, text, text, text, text, numeric, numeric, numeric, text);
drop function public.prevent_payroll_evidence_change();
drop index public.instructor_earnings_id_studio_batch_key;
drop index public.payroll_batches_id_studio_period_key;
drop index public.payroll_pay_periods_id_studio_key;

commit;
