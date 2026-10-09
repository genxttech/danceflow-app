-- Phase 9A: payroll integrity hardening.
--
-- Makes the canonical payroll chain authoritative and tenant-safe:
--   pending earning -> approved earning -> draft batch -> approved batch
--   -> paid batch (studio owner or platform admin only)
-- No alternate path (direct table write, per-earning shortcut, cross-studio
-- identifier) can reach "paid", alter an approved batch, or touch another
-- studio's payroll.
--
-- Changes (all integrity/security; no new product state, no data rewrite):
--   1. public.payroll_actor_role(studio): studio_owner, platform_admin
--      (profiles.platform_role) or studio_admin for an explicit, existing
--      studio; NULL otherwise. Prepare = owner/admin/platform_admin;
--      disburse (mark paid, void a pay period) = owner/platform_admin.
--   2. Every payroll RPC is recreated with fail-closed, studio-scoped lookups
--      (absence raises; no NULL comparison can pass) and studio-scoped
--      writes. approve_payroll_batch previously recomputed totals and
--      approved/locked the pay period of ANOTHER studio's batch.
--   3. The UPDATE-only earning lock is replaced by a BEFORE INSERT OR UPDATE
--      integrity trigger: same-studio instructor/appointment/client/pay
--      period/batch, earning date inside its pay period, no insert into or
--      assignment to a non-draft batch, an explicit earning transition graph
--      (paid only through batch payment), and an approved earning whose
--      amount changes returns to pending (review required).
--   4. The generic period/batch status trigger is replaced by per-table
--      triggers with explicit transition graphs, terminal paid/void, frozen
--      totals once a batch is approved, and structural checks for approve,
--      pay and void.
--   5. Direct INSERT/UPDATE policies on payroll_pay_periods and
--      payroll_batches are dropped: those rows are written only by the
--      SECURITY DEFINER RPCs (the app already writes them only that way).
--   6. One totals path: refresh_payroll_batch_totals and
--      refresh_payroll_pay_period_totals (recreated, change-only writes, the
--      transition bypass restored afterwards), driven by statement-level
--      triggers on instructor_earnings so totals cannot go stale. Closed
--      records are skipped: approved/paid batch totals are frozen (their
--      earnings are locked) and paid/void periods are terminal.
--   7. Payroll history is never physically removed. A BEFORE DELETE guard
--      refuses deleting an earning once it is history (status not pending,
--      or assigned to a pay period or batch, locked, approved or paid) and
--      deleting a pay period / batch past open / draft. Parent cascades
--      (instructor and studio ON DELETE CASCADE) fire it, so the parent
--      delete fails atomically. ON DELETE SET NULL from appointments and
--      clients is refused for history rows, so an earning keeps its source
--      identity. Pending, unassigned earnings keep their existing behavior.
--
-- Not in this slice: approval snapshots / export or finalization records
-- (9B), compensation history (9C), shared CSV (9D), earning_date studio-local
-- business date (9E).
--
-- Preflight fails closed unless every replaced function is byte-identical to
-- the reviewed DEV == PROD baseline (2026-10-09). Rollback:
-- rollback/20261102090000_phase9a_payroll_integrity_rollback.sql.

begin;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================

do $$
declare
  v_expected constant jsonb := jsonb_build_object(
    'approve_payroll_batch', 'ec05a7e2203e29b729d8b60825d0dc5a',
    'assign_earnings_to_pay_period', '28922bbee9b620c95e6ae7fc96e41908',
    'assign_single_earning_to_pay_period', '169612b453ff3fc63e10885c5530c6b4',
    'create_payroll_batch_from_period', '0a2216841e02dd62eb8b658b16f936e9',
    'create_payroll_pay_period', 'a5a86bec6a9e11e6b9a3a32a8eae94cd',
    'current_studio_payroll_role', '509cb29bd3ff5963cea5593443b0a76d',
    'enforce_instructor_earning_payroll_lock', 'c363d0720f4a073095588971d144d5de',
    'enforce_payroll_status_transition', '286f8acb77efe7a7fc5c9fdbcb2de872',
    'mark_payroll_batch_paid', '4892a60d706940fe59ef95d606245db6',
    'payroll_transition_bypass_enabled', '0ed02c1b2413316db92166cd8d9596ff',
    'refresh_payroll_batch_totals', 'd1b4d4f0eda14c9b8571029ecadc6515',
    'refresh_payroll_pay_period_totals', '681d7649a65f0388f855bbf4ab606841',
    'remove_earning_from_pay_period', '4f9f8423a973629ec9c7a3b9aee213e8',
    'void_empty_payroll_pay_period', '4361c2f3a6e90234228511e0445f117c'
  );
  r record;
  v_md5 text;
  v_count int;
begin
  for r in select key, value from jsonb_each_text(v_expected) loop
    select count(*), max(md5(p.prosrc)) into v_count, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.key;
    if v_count <> 1 or v_md5 is distinct from r.value then
      raise exception 'Phase 9A preflight: public.% is not the reviewed definition (count %, md5 %).', r.key, v_count, v_md5;
    end if;
  end loop;

  if to_regprocedure('public.payroll_actor_role(uuid)') is not null
     or to_regprocedure('public.enforce_instructor_earning_integrity()') is not null
     or to_regprocedure('public.enforce_payroll_pay_period_integrity()') is not null
     or to_regprocedure('public.enforce_payroll_batch_integrity()') is not null
     or to_regprocedure('public.refresh_payroll_totals_after_earning_change()') is not null
     or to_regprocedure('public.prevent_payroll_history_delete()') is not null then
    raise exception 'Phase 9A preflight: Phase 9A objects already exist.';
  end if;

  if (select count(*) from pg_trigger
      where not tgisinternal
        and ((tgrelid = 'public.instructor_earnings'::regclass and tgname = 'trg_enforce_instructor_earning_payroll_lock')
          or (tgrelid = 'public.payroll_pay_periods'::regclass and tgname = 'trg_enforce_payroll_pay_period_transition')
          or (tgrelid = 'public.payroll_batches'::regclass and tgname = 'trg_enforce_payroll_batch_transition'))) <> 3 then
    raise exception 'Phase 9A preflight: expected payroll lock/transition triggers are missing.';
  end if;

  if (select count(*) from pg_policies where schemaname = 'public'
      and policyname in ('payroll_pay_periods_insert', 'payroll_pay_periods_update',
                         'payroll_batches_insert', 'payroll_batches_update')) <> 4 then
    raise exception 'Phase 9A preflight: expected payroll period/batch write policies are missing.';
  end if;

  if exists (select 1 from pg_class
             where oid in ('public.instructor_earnings'::regclass, 'public.payroll_pay_periods'::regclass, 'public.payroll_batches'::regclass)
               and not relrowsecurity) then
    raise exception 'Phase 9A preflight: RLS is not enabled on a payroll table.';
  end if;

  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'platform_role') is distinct from 'text' then
    raise exception 'Phase 9A preflight: profiles.platform_role is missing.';
  end if;
end
$$;

-- ============================================================================
-- 1. ACTOR ROLE
-- ============================================================================

create function public.payroll_actor_role(p_studio_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_studio_id is null or auth.uid() is null then null
    when exists (select 1 from public.user_studio_roles usr
                 where usr.studio_id = p_studio_id and usr.user_id = auth.uid()
                   and usr.active = true and usr.role = 'studio_owner') then 'studio_owner'
    when exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.platform_role = 'platform_admin')
         and exists (select 1 from public.studios s where s.id = p_studio_id) then 'platform_admin'
    when exists (select 1 from public.user_studio_roles usr
                 where usr.studio_id = p_studio_id and usr.user_id = auth.uid()
                   and usr.active = true and usr.role = 'studio_admin') then 'studio_admin'
    else null
  end;
$$;
revoke all on function public.payroll_actor_role(uuid) from public, anon;
grant execute on function public.payroll_actor_role(uuid) to authenticated, service_role;

-- ============================================================================
-- 2. TOTALS (one calculation path)
-- ============================================================================

create or replace function public.refresh_payroll_batch_totals(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('danceflow.payroll_transition_bypass', true), '');
begin
  if p_batch_id is null then return; end if;
  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.payroll_batches pb set
    compensation_total = t.compensation_total,
    reimbursement_total = t.reimbursement_total,
    deduction_total = t.deduction_total,
    net_payment_total = t.net_payment_total,
    earning_count = t.earning_count,
    updated_at = now()
  from (
    select coalesce(sum(e.taxable_compensation_amount), 0) compensation_total,
      coalesce(sum(e.reimbursement_amount), 0) reimbursement_total,
      coalesce(sum(e.deduction_amount), 0) deduction_total,
      coalesce(sum(e.taxable_compensation_amount + e.reimbursement_amount - e.deduction_amount), 0) net_payment_total,
      count(*)::int earning_count
    from public.instructor_earnings e
    join public.payroll_batches b on b.id = e.payroll_batch_id and b.studio_id = e.studio_id
    where e.payroll_batch_id = p_batch_id and e.status <> 'void'
  ) t
  where pb.id = p_batch_id
    and pb.status in ('draft', 'in_review')
    and (pb.compensation_total, pb.reimbursement_total, pb.deduction_total, pb.net_payment_total, pb.earning_count)
        is distinct from (t.compensation_total, t.reimbursement_total, t.deduction_total, t.net_payment_total, t.earning_count);
  perform set_config('danceflow.payroll_transition_bypass', v_prev, true);
end;
$$;
revoke all on function public.refresh_payroll_batch_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_batch_totals(uuid) to service_role;

create or replace function public.refresh_payroll_pay_period_totals(p_pay_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := coalesce(current_setting('danceflow.payroll_transition_bypass', true), '');
begin
  if p_pay_period_id is null then return; end if;
  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.payroll_pay_periods pp set
    compensation_total = t.compensation_total,
    reimbursement_total = t.reimbursement_total,
    deduction_total = t.deduction_total,
    net_payment_total = t.net_payment_total,
    updated_at = now()
  from (
    select coalesce(sum(e.taxable_compensation_amount), 0) compensation_total,
      coalesce(sum(e.reimbursement_amount), 0) reimbursement_total,
      coalesce(sum(e.deduction_amount), 0) deduction_total,
      coalesce(sum(e.taxable_compensation_amount + e.reimbursement_amount - e.deduction_amount), 0) net_payment_total
    from public.instructor_earnings e
    join public.payroll_pay_periods p on p.id = e.pay_period_id and p.studio_id = e.studio_id
    where e.pay_period_id = p_pay_period_id and e.status <> 'void'
  ) t
  where pp.id = p_pay_period_id
    and pp.status not in ('paid', 'void')
    and (pp.compensation_total, pp.reimbursement_total, pp.deduction_total, pp.net_payment_total)
        is distinct from (t.compensation_total, t.reimbursement_total, t.deduction_total, t.net_payment_total);
  perform set_config('danceflow.payroll_transition_bypass', v_prev, true);
end;
$$;
revoke all on function public.refresh_payroll_pay_period_totals(uuid) from public, anon, authenticated;
grant execute on function public.refresh_payroll_pay_period_totals(uuid) to service_role;

create function public.refresh_payroll_totals_after_earning_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.refresh_payroll_batch_totals(s.id)
      from (select distinct payroll_batch_id id from new_rows where payroll_batch_id is not null) s;
    perform public.refresh_payroll_pay_period_totals(s.id)
      from (select distinct pay_period_id id from new_rows where pay_period_id is not null) s;
  elsif tg_op = 'UPDATE' then
    perform public.refresh_payroll_batch_totals(s.id)
      from (select payroll_batch_id id from new_rows union select payroll_batch_id from old_rows) s
      where s.id is not null;
    perform public.refresh_payroll_pay_period_totals(s.id)
      from (select pay_period_id id from new_rows union select pay_period_id from old_rows) s
      where s.id is not null;
  else
    perform public.refresh_payroll_batch_totals(s.id)
      from (select distinct payroll_batch_id id from old_rows where payroll_batch_id is not null) s;
    perform public.refresh_payroll_pay_period_totals(s.id)
      from (select distinct pay_period_id id from old_rows where pay_period_id is not null) s;
  end if;
  return null;
end;
$$;
revoke all on function public.refresh_payroll_totals_after_earning_change() from public, anon, authenticated;

-- ============================================================================
-- 3. EARNING INTEGRITY (replaces the UPDATE-only lock)
-- ============================================================================

create function public.enforce_instructor_earning_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass boolean := public.payroll_transition_bypass_enabled();
  v_locked boolean;
  v_changed boolean;
  v_period record;
  v_batch record;
  -- Fields that decide what is paid, to whom, for what: any change sends an
  -- approved earning back to review and is refused once the earning is locked.
  v_payroll_fields constant text[] := array[
    'instructor_id', 'appointment_id', 'client_id', 'earning_date', 'source_type', 'appointment_type',
    'gross_revenue_basis', 'pay_mode', 'pay_rate_amount', 'pay_percentage', 'attendance_count',
    'earning_amount', 'adjustment_type', 'worker_classification_snapshot', 'accounting_category_snapshot',
    'taxable_compensation_amount', 'reimbursement_amount', 'deduction_amount'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
begin
  -- Tenant references (every caller, every path).
  if tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id then
    raise exception 'Payroll earnings cannot move between studios.';
  end if;
  -- Payroll history keeps its source identity: refuse the ON DELETE SET NULL
  -- cascade from appointments / clients (or any nulling) once it is history.
  if tg_op = 'UPDATE'
     and (old.status <> 'pending' or old.pay_period_id is not null or old.payroll_batch_id is not null
          or old.locked_at is not null or old.approved_at is not null or old.paid_at is not null)
     and ((old.appointment_id is not null and new.appointment_id is null)
          or (old.client_id is not null and new.client_id is null)) then
    raise exception 'Payroll history must keep its source appointment and client.';
  end if;
  if tg_op = 'INSERT' or new.instructor_id is distinct from old.instructor_id then
    if not exists (select 1 from public.instructors i where i.id = new.instructor_id and i.studio_id = new.studio_id) then
      raise exception 'Payroll earning instructor must belong to the same studio.';
    end if;
  end if;
  if new.appointment_id is not null and (tg_op = 'INSERT' or new.appointment_id is distinct from old.appointment_id) then
    if not exists (select 1 from public.appointments a where a.id = new.appointment_id and a.studio_id = new.studio_id) then
      raise exception 'Payroll earning appointment must belong to the same studio.';
    end if;
  end if;
  if new.client_id is not null and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id) then
    if not exists (select 1 from public.clients c where c.id = new.client_id and c.studio_id = new.studio_id) then
      raise exception 'Payroll earning client must belong to the same studio.';
    end if;
  end if;
  if new.pay_period_id is not null and (tg_op = 'INSERT' or new.pay_period_id is distinct from old.pay_period_id
                                         or new.earning_date is distinct from old.earning_date) then
    select studio_id, period_start, period_end into v_period
    from public.payroll_pay_periods where id = new.pay_period_id;
    if not found or v_period.studio_id <> new.studio_id then
      raise exception 'Payroll earning pay period must belong to the same studio.';
    end if;
    if new.earning_date < v_period.period_start or new.earning_date > v_period.period_end then
      raise exception 'This earning falls outside the pay-period dates.';
    end if;
  end if;
  if new.payroll_batch_id is not null and (tg_op = 'INSERT' or new.payroll_batch_id is distinct from old.payroll_batch_id) then
    select studio_id, pay_period_id, status into v_batch
    from public.payroll_batches where id = new.payroll_batch_id;
    if not found or v_batch.studio_id <> new.studio_id then
      raise exception 'Payroll earning batch must belong to the same studio.';
    end if;
    if v_batch.pay_period_id is distinct from new.pay_period_id then
      raise exception 'Payroll earning batch must belong to the earning pay period.';
    end if;
    if v_batch.status <> 'draft' then
      raise exception 'Earnings can only be added to a draft payroll batch.';
    end if;
    if new.status <> 'approved' then
      raise exception 'Only approved earnings can be added to a payroll batch.';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if not v_bypass and (new.status <> 'pending' or new.pay_period_id is not null or new.payroll_batch_id is not null
                         or new.locked_at is not null or new.paid_at is not null or new.paid_by is not null
                         or new.approved_at is not null or new.approved_by is not null) then
      raise exception 'New payroll earnings must start pending and unassigned.';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);

  -- Paid and void are terminal. The only change a void earning accepts is
  -- being detached from its pay period by the canonical RPC.
  if old.status in ('paid', 'void') then
    if old.status = 'void' and v_bypass and old.payroll_batch_id is null and new.pay_period_id is null
       and (v_new - array['pay_period_id', 'updated_at']) = (v_old - array['pay_period_id', 'updated_at']) then
      return new;
    end if;
    if (v_new - 'updated_at') is distinct from (v_old - 'updated_at') then
      raise exception 'Paid or void payroll earnings cannot be changed.';
    end if;
    return new;
  end if;

  v_locked := old.payroll_batch_id is not null or old.locked_at is not null;

  if v_locked then
    -- Locked into a batch: only the canonical batch payment may change it
    -- (approved -> paid with payment stamps); notes stay editable.
    if (v_new - array['status', 'paid_at', 'paid_by', 'payment_method', 'notes', 'updated_at'])
       is distinct from (v_old - array['status', 'paid_at', 'paid_by', 'payment_method', 'notes', 'updated_at']) then
      raise exception 'Batched payroll earnings are locked.';
    end if;
    if new.status is distinct from old.status
       or new.paid_at is distinct from old.paid_at or new.paid_by is distinct from old.paid_by
       or new.payment_method is distinct from old.payment_method then
      if not v_bypass or old.status <> 'approved' or new.status <> 'paid'
         or not exists (select 1 from public.payroll_batches b
                        where b.id = old.payroll_batch_id and b.studio_id = old.studio_id and b.status = 'approved') then
        raise exception 'Batched payroll earnings are locked.';
      end if;
    end if;
    return new;
  end if;

  -- Unlocked (pending or approved, not in a batch).
  if not v_bypass and (new.pay_period_id is distinct from old.pay_period_id
                       or new.payroll_batch_id is distinct from old.payroll_batch_id
                       or new.locked_at is distinct from old.locked_at) then
    raise exception 'Payroll period and batch assignment is managed by payroll operations.';
  end if;
  if new.paid_at is distinct from old.paid_at or new.paid_by is distinct from old.paid_by
     or new.payment_method is distinct from old.payment_method then
    raise exception 'Payroll is paid only through an approved payroll batch.';
  end if;
  if new.payroll_batch_id is not null and new.locked_at is null then
    raise exception 'Batched payroll earnings must be locked.';
  end if;

  v_changed := exists (
    select 1 from unnest(v_payroll_fields) f
    where (v_new -> f) is distinct from (v_old -> f)
  );

  if new.status = 'paid' then
    raise exception 'Payroll is paid only through an approved payroll batch.';
  end if;

  if old.status = 'pending' then
    if new.status = 'approved' then
      new.approved_at := coalesce(new.approved_at, now());
      new.approved_by := coalesce(new.approved_by, auth.uid());
    elsif new.status = 'pending' then
      if new.approved_at is not null or new.approved_by is not null then
        raise exception 'Pending payroll earnings cannot carry an approval.';
      end if;
    end if;
  elsif old.status = 'approved' then
    if new.status = 'approved' and v_changed then
      -- Amount or payroll identity changed after approval: review again.
      new.status := 'pending';
      new.approved_at := null;
      new.approved_by := null;
    elsif new.status = 'pending' then
      if not v_changed then
        raise exception 'Approved earnings return to review only when their payroll amount changes.';
      end if;
      new.approved_at := null;
      new.approved_by := null;
    elsif new.status = 'approved' and (new.approved_at is distinct from old.approved_at
                                       or new.approved_by is distinct from old.approved_by) then
      raise exception 'Payroll approval stamps cannot be rewritten.';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_instructor_earning_integrity() from public, anon, authenticated;

drop trigger if exists trg_enforce_instructor_earning_payroll_lock on public.instructor_earnings;
drop function public.enforce_instructor_earning_payroll_lock();

create trigger trg_enforce_instructor_earning_integrity
before insert or update on public.instructor_earnings
for each row execute function public.enforce_instructor_earning_integrity();

create trigger trg_instructor_earnings_totals_insert
after insert on public.instructor_earnings
referencing new table as new_rows
for each statement execute function public.refresh_payroll_totals_after_earning_change();
create trigger trg_instructor_earnings_totals_update
after update on public.instructor_earnings
referencing old table as old_rows new table as new_rows
for each statement execute function public.refresh_payroll_totals_after_earning_change();
create trigger trg_instructor_earnings_totals_delete
after delete on public.instructor_earnings
referencing old table as old_rows
for each statement execute function public.refresh_payroll_totals_after_earning_change();

-- ============================================================================
-- 4. PAY PERIOD AND BATCH INTEGRITY (replaces the generic status trigger)
-- ============================================================================

create function public.enforce_payroll_pay_period_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass boolean := public.payroll_transition_bypass_enabled();
  v_stamps constant text[] := array['status', 'compensation_total', 'reimbursement_total', 'deduction_total',
    'net_payment_total', 'approved_at', 'approved_by', 'paid_at', 'paid_by', 'voided_at', 'voided_by',
    'void_reason', 'locked_at'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.compensation_total <> 0 or new.reimbursement_total <> 0
       or new.deduction_total <> 0 or new.net_payment_total <> 0 or new.approved_at is not null
       or new.paid_at is not null or new.voided_at is not null or new.locked_at is not null then
      raise exception 'New pay periods must start open with no totals.';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);

  if new.studio_id is distinct from old.studio_id or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end then
    raise exception 'Pay period studio and dates cannot be changed.';
  end if;

  if old.status in ('paid', 'void') then
    if (v_new - 'updated_at') is distinct from (v_old - 'updated_at') then
      raise exception 'Closed payroll records cannot be changed.';
    end if;
    return new;
  end if;

  if not v_bypass and exists (select 1 from unnest(v_stamps) f where (v_new -> f) is distinct from (v_old -> f)) then
    raise exception 'Pay period status and totals are managed by payroll operations.';
  end if;

  if new.status is distinct from old.status then
    if not ((old.status = 'open' and new.status in ('in_review', 'approved', 'void'))
            or (old.status = 'in_review' and new.status in ('approved', 'void'))
            or (old.status = 'approved' and new.status = 'paid')) then
      raise exception 'Invalid pay period transition from % to %.', old.status, new.status;
    end if;
    if new.status = 'approved' and not exists (
      select 1 from public.payroll_batches b
      where b.pay_period_id = new.id and b.studio_id = new.studio_id and b.status in ('approved', 'paid')) then
      raise exception 'A pay period is approved only through an approved payroll batch.';
    end if;
    if new.status = 'paid' and (
      exists (select 1 from public.payroll_batches b
              where b.pay_period_id = new.id and b.status not in ('paid', 'void'))
      or exists (select 1 from public.instructor_earnings e
                 where e.pay_period_id = new.id and e.payroll_batch_id is null and e.status <> 'void')) then
      raise exception 'A pay period is paid only when every batch is closed and every earning is paid.';
    end if;
    if new.status = 'void' and (
      exists (select 1 from public.payroll_batches b where b.pay_period_id = new.id)
      or exists (select 1 from public.instructor_earnings e where e.pay_period_id = new.id)) then
      raise exception 'Remove all unbatched earnings before voiding this pay period.';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_payroll_pay_period_integrity() from public, anon, authenticated;

create function public.enforce_payroll_batch_integrity()
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

drop trigger if exists trg_enforce_payroll_pay_period_transition on public.payroll_pay_periods;
drop trigger if exists trg_enforce_payroll_batch_transition on public.payroll_batches;
drop function public.enforce_payroll_status_transition();

create trigger trg_enforce_payroll_pay_period_integrity
before insert or update on public.payroll_pay_periods
for each row execute function public.enforce_payroll_pay_period_integrity();
create trigger trg_enforce_payroll_batch_integrity
before insert or update on public.payroll_batches
for each row execute function public.enforce_payroll_batch_integrity();

-- ============================================================================
-- 4b. PAYROLL HISTORY IS NEVER PHYSICALLY DELETED
-- ============================================================================

create function public.prevent_payroll_history_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'instructor_earnings' then
    if old.status <> 'pending' or old.pay_period_id is not null or old.payroll_batch_id is not null
       or old.locked_at is not null or old.approved_at is not null or old.paid_at is not null then
      raise exception 'Payroll history cannot be deleted.';
    end if;
  elsif tg_table_name = 'payroll_pay_periods' then
    if old.status not in ('open', 'in_review') then
      raise exception 'Payroll history cannot be deleted.';
    end if;
  elsif tg_table_name = 'payroll_batches' then
    if old.status not in ('draft', 'in_review') then
      raise exception 'Payroll history cannot be deleted.';
    end if;
  end if;
  return old;
end;
$$;
revoke all on function public.prevent_payroll_history_delete() from public, anon, authenticated;

create trigger trg_prevent_instructor_earning_history_delete
before delete on public.instructor_earnings
for each row execute function public.prevent_payroll_history_delete();
create trigger trg_prevent_payroll_pay_period_history_delete
before delete on public.payroll_pay_periods
for each row execute function public.prevent_payroll_history_delete();
create trigger trg_prevent_payroll_batch_history_delete
before delete on public.payroll_batches
for each row execute function public.prevent_payroll_history_delete();

-- Pay periods and batches are written only by the payroll RPCs.
drop policy payroll_pay_periods_insert on public.payroll_pay_periods;
drop policy payroll_pay_periods_update on public.payroll_pay_periods;
drop policy payroll_batches_insert on public.payroll_batches;
drop policy payroll_batches_update on public.payroll_batches;

-- ============================================================================
-- 5. PAYROLL RPCS (studio-scoped, fail closed, bypass restored on return)
-- ============================================================================

create or replace function public.create_payroll_pay_period(p_studio_id uuid, p_period_start date, p_period_end date, p_pay_date date default null::date)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Pay-period end date must be on or after start date.';
  end if;
  if exists (
    select 1 from public.payroll_pay_periods pp
    where pp.studio_id = p_studio_id and pp.status <> 'void'
      and daterange(pp.period_start, pp.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'This pay period overlaps another active pay period.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  insert into public.payroll_pay_periods(studio_id, period_start, period_end, pay_date, status, created_by, updated_by)
  values (p_studio_id, p_period_start, p_period_end, p_pay_date, 'open', auth.uid(), auth.uid())
  returning id into v_id;
  perform set_config('danceflow.payroll_transition_bypass', '', true);
  return v_id;
end;
$function$;
revoke all on function public.create_payroll_pay_period(uuid, date, date, date) from public, anon;
grant execute on function public.create_payroll_pay_period(uuid, date, date, date) to authenticated, service_role;

create or replace function public.assign_earnings_to_pay_period(p_studio_id uuid, p_pay_period_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period record;
  v_count int;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select id, period_start, period_end, status into v_period
  from public.payroll_pay_periods
  where id = p_pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if v_period.status not in ('open', 'in_review') then
    raise exception 'Only open or in-review periods can receive earnings.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.instructor_earnings set pay_period_id = v_period.id, updated_at = now()
  where studio_id = p_studio_id and earning_date between v_period.period_start and v_period.period_end
    and status in ('pending', 'approved') and payroll_batch_id is null and pay_period_id is null;
  get diagnostics v_count = row_count;
  update public.payroll_pay_periods set status = 'in_review', updated_by = auth.uid(), updated_at = now()
  where id = v_period.id and studio_id = p_studio_id and status = 'open';
  perform set_config('danceflow.payroll_transition_bypass', '', true);
  return v_count;
end;
$function$;
revoke all on function public.assign_earnings_to_pay_period(uuid, uuid) from public, anon;
grant execute on function public.assign_earnings_to_pay_period(uuid, uuid) to authenticated, service_role;

create or replace function public.assign_single_earning_to_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_earning_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period record;
  v_earning record;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select id, period_start, period_end, status into v_period
  from public.payroll_pay_periods
  where id = p_pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if v_period.status not in ('open', 'in_review') then
    raise exception 'Only open or in-review periods can receive earnings.';
  end if;

  select id, earning_date, status, pay_period_id, payroll_batch_id into v_earning
  from public.instructor_earnings
  where id = p_earning_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Earning not found.'; end if;
  if v_earning.status not in ('pending', 'approved') then
    raise exception 'Only pending or approved earnings can be assigned.';
  end if;
  if v_earning.payroll_batch_id is not null then raise exception 'Batched earnings cannot be reassigned.'; end if;
  if v_earning.pay_period_id is not null and v_earning.pay_period_id <> v_period.id then
    raise exception 'This earning is already assigned to another pay period.';
  end if;
  if v_earning.earning_date < v_period.period_start or v_earning.earning_date > v_period.period_end then
    raise exception 'This earning falls outside the pay-period dates.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.instructor_earnings set pay_period_id = v_period.id, updated_at = now()
  where id = v_earning.id and studio_id = p_studio_id;
  update public.payroll_pay_periods set status = 'in_review', updated_by = auth.uid(), updated_at = now()
  where id = v_period.id and studio_id = p_studio_id and status = 'open';
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_single_earning_to_pay_period(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.remove_earning_from_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_earning_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period_status text;
  v_earning record;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select status into v_period_status
  from public.payroll_pay_periods
  where id = p_pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if v_period_status not in ('open', 'in_review') then
    raise exception 'Only open or in-review periods can be changed.';
  end if;

  select id, payroll_batch_id into v_earning
  from public.instructor_earnings
  where id = p_earning_id and studio_id = p_studio_id and pay_period_id = p_pay_period_id
  for update;
  if not found then raise exception 'Assigned earning not found.'; end if;
  if v_earning.payroll_batch_id is not null then raise exception 'Batched earnings cannot be removed.'; end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.instructor_earnings set pay_period_id = null, updated_at = now()
  where id = v_earning.id and studio_id = p_studio_id and pay_period_id = p_pay_period_id;
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.remove_earning_from_pay_period(uuid, uuid, uuid) from public, anon;
grant execute on function public.remove_earning_from_pay_period(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.create_payroll_batch_from_period(p_studio_id uuid, p_pay_period_id uuid, p_provider text default 'manual'::text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period_status text;
  v_id uuid;
  v_count int;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'studio_admin', 'platform_admin') then
    raise exception 'Payroll access denied.';
  end if;
  select status into v_period_status
  from public.payroll_pay_periods
  where id = p_pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if v_period_status not in ('in_review', 'approved') then
    raise exception 'The pay period must be in review or approved.';
  end if;
  select count(*) into v_count from public.instructor_earnings
  where studio_id = p_studio_id and pay_period_id = p_pay_period_id and payroll_batch_id is null and status = 'approved';
  if v_count = 0 then raise exception 'No approved, unbatched earnings are available.'; end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  insert into public.payroll_batches(studio_id, pay_period_id, provider, status, created_by, updated_by)
  values (p_studio_id, p_pay_period_id, coalesce(nullif(trim(p_provider), ''), 'manual'), 'draft', auth.uid(), auth.uid())
  returning id into v_id;
  update public.instructor_earnings set payroll_batch_id = v_id, locked_at = now(), updated_at = now()
  where studio_id = p_studio_id and pay_period_id = p_pay_period_id and payroll_batch_id is null and status = 'approved';
  perform set_config('danceflow.payroll_transition_bypass', '', true);
  return v_id;
end;
$function$;
revoke all on function public.create_payroll_batch_from_period(uuid, uuid, text) from public, anon;
grant execute on function public.create_payroll_batch_from_period(uuid, uuid, text) to authenticated, service_role;

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

create or replace function public.void_empty_payroll_pay_period(p_studio_id uuid, p_pay_period_id uuid, p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if coalesce(public.payroll_actor_role(p_studio_id), '') not in ('studio_owner', 'platform_admin') then
    raise exception 'Only the studio owner can void a pay period.';
  end if;
  select status into v_status
  from public.payroll_pay_periods
  where id = p_pay_period_id and studio_id = p_studio_id
  for update;
  if not found then raise exception 'Pay period not found.'; end if;
  if exists (select 1 from public.instructor_earnings where studio_id = p_studio_id and pay_period_id = p_pay_period_id)
     or exists (select 1 from public.payroll_batches where studio_id = p_studio_id and pay_period_id = p_pay_period_id) then
    raise exception 'Remove all unbatched earnings before voiding this pay period.';
  end if;
  if v_status not in ('open', 'in_review') then
    raise exception 'Only an open or in-review pay period can be voided.';
  end if;

  perform set_config('danceflow.payroll_transition_bypass', '1', true);
  update public.payroll_pay_periods
  set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = nullif(trim(p_reason), ''),
      updated_by = auth.uid(), updated_at = now(), locked_at = now()
  where id = p_pay_period_id and studio_id = p_studio_id and status in ('open', 'in_review');
  perform set_config('danceflow.payroll_transition_bypass', '', true);
end;
$function$;
revoke all on function public.void_empty_payroll_pay_period(uuid, uuid, text) from public, anon;
grant execute on function public.void_empty_payroll_pay_period(uuid, uuid, text) to authenticated, service_role;

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================

do $$
begin
  if (select count(*) from pg_trigger
      where not tgisinternal and tgenabled = 'O'
        and ((tgrelid = 'public.instructor_earnings'::regclass and tgname in (
               'trg_enforce_instructor_earning_integrity', 'trg_instructor_earnings_totals_insert',
               'trg_instructor_earnings_totals_update', 'trg_instructor_earnings_totals_delete'))
          or (tgrelid = 'public.payroll_pay_periods'::regclass and tgname = 'trg_enforce_payroll_pay_period_integrity')
          or (tgrelid = 'public.payroll_batches'::regclass and tgname = 'trg_enforce_payroll_batch_integrity')
          or (tgrelid = 'public.instructor_earnings'::regclass and tgname = 'trg_prevent_instructor_earning_history_delete')
          or (tgrelid = 'public.payroll_pay_periods'::regclass and tgname = 'trg_prevent_payroll_pay_period_history_delete')
          or (tgrelid = 'public.payroll_batches'::regclass and tgname = 'trg_prevent_payroll_batch_history_delete'))) <> 9 then
    raise exception 'Phase 9A postflight: payroll integrity triggers are not all enabled.';
  end if;
  if exists (select 1 from pg_trigger where not tgisinternal and tgname in (
               'trg_enforce_instructor_earning_payroll_lock', 'trg_enforce_payroll_pay_period_transition',
               'trg_enforce_payroll_batch_transition')) then
    raise exception 'Phase 9A postflight: superseded payroll triggers still exist.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
             and tablename in ('payroll_pay_periods', 'payroll_batches') and cmd <> 'SELECT') then
    raise exception 'Phase 9A postflight: direct pay period/batch write policies remain.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and not p.prosecdef and p.proname in (
               'payroll_actor_role', 'create_payroll_pay_period', 'assign_earnings_to_pay_period',
               'assign_single_earning_to_pay_period', 'remove_earning_from_pay_period',
               'create_payroll_batch_from_period', 'approve_payroll_batch', 'mark_payroll_batch_paid',
               'void_empty_payroll_pay_period', 'enforce_instructor_earning_integrity',
               'enforce_payroll_pay_period_integrity', 'enforce_payroll_batch_integrity',
               'prevent_payroll_history_delete')) then
    raise exception 'Phase 9A postflight: a payroll function is not SECURITY DEFINER.';
  end if;
  if has_function_privilege('anon', 'public.mark_payroll_batch_paid(uuid, uuid, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.refresh_payroll_batch_totals(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.refresh_payroll_pay_period_totals(uuid)', 'execute') then
    raise exception 'Phase 9A postflight: payroll function grants are too broad.';
  end if;
end
$$;

commit;
