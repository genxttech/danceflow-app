-- 20261027090000_refund_reconciliation_integrity.sql
--
-- REFUND-RECON-1: repair the shared Stripe refund reconciliation RPC.
--
-- public._apply_payment_refund_and_reevaluate (PKG-P1, 20260913091100) has failed
-- on EVERY call with SQLSTATE 42804 since it shipped:
--     update public.payments set status = p_new_status ...
-- assigns the TEXT parameter p_new_status into payments.status, which is the
-- ENUM public.payment_status, with no cast. Its only caller is the canonical
-- Stripe webhook (updatePaymentRefundByPaymentIntent, reached from
-- charge.refunded / charge.updated / refund.created / refund.updated /
-- charge.refund.updated), so every Stripe-originated refund of a `payments` row
-- failed to reconcile (stale refund state; package re-evaluation never ran) even
-- though Stripe had returned the money.
--
-- Changes (same signature, return type, owner, SECURITY DEFINER, search_path, ACL):
--   1. The enum cast (the 42804 fix). Only the two canonical refund outcomes are
--      accepted: 'refunded' (full) and 'paid' (partial: DanceFlow keeps a
--      partially refunded payment 'paid' with a cumulative refund_amount; there
--      is no partial payment status). Anything else is refused.
--   2. Cumulative refund_amount is monotonic: a stale/lower cumulative amount
--      never lowers the stored refund, a duplicate partial is a no-op, and a
--      stale partial arriving after the full refund is treated as already applied
--      (previously it would have raised a false settlement-conflict review). A
--      null refund id never erases a stored one.
--   3. Group Class direct-payment enrollments (GC-3.5): after the payment is
--      reconciled, a new internal helper applies the locked enrollment effects,
--      ONLY when the payment is payment_type 'group_class_direct_payment' AND a
--      CONVERTED purchase hold in the SAME studio binds this payment to its
--      attendee (positive linkage; external_reference is never interpreted):
--        full refund, no recorded attendance -> attendee cancelled (cancelled_at
--          set), payment_status 'refunded'; the seat is released naturally;
--        full refund, attended/no_show recorded -> payment_status 'refunded'
--          only; booking and attendance history kept (works WITH the GCSD1
--          guard, which is unchanged; no exception is raised);
--        partial refund -> payment_status 'partial'; still booked;
--        conflict payment (no attendee) -> nothing to change.
--      The effect is idempotent, runs on duplicate deliveries too (converges),
--      and is isolated: if it fails, the payment reconciliation still commits
--      and a WARNING is raised.
--   Unchanged: package re-evaluation (called exactly as before, on an applied
--   update with a package), the settlement-conflict record for a genuinely
--   unexpected prior status, and no Stripe identity column is written except
--   the refund id. Payment-row triggers (accounting sync, rewards, Stripe
--   identity guards) run as they always do on this update.

begin;

-- >>> REFUND-RECON-1 PRECONDITIONS
do $$
declare
  v_missing text;
begin
  if (select count(*) from pg_proc where proname = '_apply_payment_refund_and_reevaluate') <> 1 then
    raise exception 'REFUND-RECON-1: unexpected _apply_payment_refund_and_reevaluate overloads';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and pg_get_function_result(p.oid) = 'TABLE(applied boolean, package_deactivated boolean, conflict_recorded boolean)'
      and md5(replace(p.prosrc, E'\r', '')) = 'd1f9bb5384bd7c54544133b3299bbf5a'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'REFUND-RECON-1: _apply_payment_refund_and_reevaluate is not the reviewed PKG-P1 predecessor';
  end if;
  if to_regprocedure('public._sync_group_class_purchase_refund(uuid,uuid,boolean)') is not null then
    raise exception 'REFUND-RECON-1: _sync_group_class_purchase_refund already exists';
  end if;

  -- Dependencies whose behavior this repair relies on, pinned exactly.
  select string_agg(want.sig, ', ') into v_missing
  from (values
    ('public._reevaluate_and_deactivate_package_if_unsettled(uuid,text)', '6fec069baaa30cbed1b57eb7825b021a'),
    ('public._record_payment_settlement_conflict(uuid,uuid,uuid,text,text,text,text)', '045835d65560af7677a698f52e5501f9'),
    ('public.enforce_attendee_cancel_no_terminal_attendance()', 'd7e90072acc77b158bd4121306d30db6')
  ) as want(sig, body_md5)
  where to_regprocedure(want.sig) is null
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p where p.oid = to_regprocedure(want.sig)) <> want.body_md5;
  if v_missing is not null then
    raise exception 'REFUND-RECON-1: dependency drift: %', v_missing;
  end if;

  if (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e
        join pg_attribute a on a.atttypid = e.enumtypid
        where a.attrelid = 'public.payments'::regclass and a.attname = 'status') <> 'pending,paid,refunded,failed,voided' then
    raise exception 'REFUND-RECON-1: payments.status is not the reviewed payment_status enum';
  end if;

  select string_agg(want.tbl || '.' || want.col, ', ') into v_missing
  from (values
    ('group_class_enrollment_holds', 'payment_id'), ('group_class_enrollment_holds', 'attendee_id'),
    ('group_class_enrollment_holds', 'status'), ('group_class_enrollment_holds', 'studio_id'),
    ('group_class_enrollment_holds', 'appointment_id'), ('group_class_enrollment_holds', 'client_id'),
    ('appointment_attendees', 'payment_status'), ('appointment_attendees', 'cancelled_at'),
    ('appointment_attendees', 'updated_at'), ('attendance_records', 'appointment_id'),
    ('attendance_records', 'client_id'), ('attendance_records', 'status'), ('payments', 'payment_type')
  ) as want(tbl, col)
  where not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = want.tbl and c.column_name = want.col);
  if v_missing is not null then
    raise exception 'REFUND-RECON-1: required column missing: %', v_missing;
  end if;

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.appointment_attendees'::regclass and c.conname = 'appointment_attendees_payment_status_check'
      and pg_get_constraintdef(c.oid) = 'CHECK ((payment_status = ANY (ARRAY[''unpaid''::text, ''partial''::text, ''paid''::text, ''waived''::text, ''refunded''::text])))'
  ) then
    raise exception 'REFUND-RECON-1: attendee payment_status values drifted';
  end if;
end $$;
-- <<< REFUND-RECON-1 PRECONDITIONS

-- ----------------------------------------------------------------------------
-- Group Class enrollment effect of a reconciled refund (internal, owner-only).
-- Returns a bounded outcome code; never raises for expected states.
-- ----------------------------------------------------------------------------
create function public._sync_group_class_purchase_refund(
  p_payment_id uuid,
  p_studio_id uuid,
  p_fully_refunded boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold record;
  v_attendee record;
  v_attendance_recorded boolean;
begin
  -- Positive linkage only: the CONVERTED purchase hold of this studio that names this payment.
  select h.attendee_id, h.appointment_id, h.client_id
    into v_hold
    from public.group_class_enrollment_holds h
    where h.payment_id = p_payment_id
      and h.status = 'converted'
      and h.studio_id = p_studio_id;

  if v_hold.attendee_id is null then
    return 'no_enrollment';
  end if;

  select a.id, a.status, a.payment_status
    into v_attendee
    from public.appointment_attendees a
    where a.id = v_hold.attendee_id
      and a.studio_id = p_studio_id
      and a.appointment_id = v_hold.appointment_id
      and a.client_id = v_hold.client_id
    for update;

  if v_attendee.id is null then
    return 'no_enrollment';
  end if;

  if not p_fully_refunded then
    -- Partial: never cancels; never downgrades an enrollment already refunded/partial.
    if v_attendee.status = 'booked' and v_attendee.payment_status not in ('partial', 'refunded') then
      update public.appointment_attendees
        set payment_status = 'partial', updated_at = now()
        where id = v_attendee.id;
      return 'partial';
    end if;
    return 'unchanged';
  end if;

  select exists (
    select 1 from public.attendance_records ar
    where ar.appointment_id = v_hold.appointment_id
      and ar.client_id = v_hold.client_id
      and ar.status in ('attended', 'no_show')
  ) into v_attendance_recorded;

  if v_attendee.status = 'booked' and not v_attendance_recorded then
    update public.appointment_attendees
      set status = 'cancelled', cancelled_at = now(), payment_status = 'refunded', updated_at = now()
      where id = v_attendee.id;
    return 'cancelled';
  end if;

  -- Attendance/no-show recorded (history is never rewritten) or already cancelled: record the refund only.
  if v_attendee.payment_status is distinct from 'refunded' then
    update public.appointment_attendees
      set payment_status = 'refunded', updated_at = now()
      where id = v_attendee.id;
    return 'refunded_enrollment_kept';
  end if;
  return 'unchanged';
end;
$$;

revoke all on function public._sync_group_class_purchase_refund(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The repaired shared reconciler.
-- ----------------------------------------------------------------------------
create or replace function public._apply_payment_refund_and_reevaluate(
  p_payment_id uuid,
  p_new_status text,
  p_refund_amount numeric,
  p_stripe_refund_id text,
  p_stripe_event_id text,
  p_stripe_event_type text
) returns table(applied boolean, package_deactivated boolean, conflict_recorded boolean)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_client_package_id uuid;
  v_studio_id uuid;
  v_payment_type text;
  v_current_status text;
  v_current_refund numeric;
  v_new_status public.payment_status;
  v_deactivated boolean := false;
begin
  -- REFUND-RECON-1: only the canonical refund outcomes, cast explicitly to the enum (was SQLSTATE 42804).
  if p_new_status is null or p_new_status not in ('paid', 'refunded') then
    raise exception 'REFUND_RECON_INVALID_STATUS: refund reconciliation accepts only paid or refunded.';
  end if;
  if p_refund_amount is null or p_refund_amount < 0 then
    raise exception 'REFUND_RECON_INVALID_AMOUNT: refund amount must be a non-negative cumulative amount.';
  end if;
  v_new_status := p_new_status::public.payment_status;

  update public.payments
    set status = v_new_status,
        refund_amount = p_refund_amount,
        stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id)
    where id = p_payment_id
      and status = 'paid'
      -- cumulative refund is monotonic: never lowered; a same-amount partial is a duplicate
      and coalesce(refund_amount, 0) <= p_refund_amount
      and (v_new_status = 'refunded' or coalesce(refund_amount, 0) < p_refund_amount)
    returning client_package_id, studio_id, payment_type into v_client_package_id, v_studio_id, v_payment_type;

  if found then
    if v_client_package_id is not null then
      v_deactivated := public._reevaluate_and_deactivate_package_if_unsettled(
        v_client_package_id,
        format('Automatically deactivated: originating payment %s was refunded.', p_payment_id)
      );
    end if;
    if v_payment_type = 'group_class_direct_payment' then
      begin
        perform public._sync_group_class_purchase_refund(p_payment_id, v_studio_id, v_new_status = 'refunded');
      exception when others then
        raise warning 'REFUND_RECON_GC_SYNC_FAILED payment=% sqlstate=%', p_payment_id, sqlstate;
      end;
    end if;
    return query select true, v_deactivated, false;
    return;
  end if;

  select status::text, coalesce(refund_amount, 0), studio_id, client_package_id, payment_type
    into v_current_status, v_current_refund, v_studio_id, v_client_package_id, v_payment_type
    from public.payments where id = p_payment_id;

  -- Duplicate delivery (same outcome already applied) or a stale/lower cumulative amount: nothing to apply.
  if v_current_status = p_new_status
     or (v_current_status = 'refunded' and p_new_status = 'paid' and v_current_refund >= p_refund_amount) then
    if v_payment_type = 'group_class_direct_payment' then
      begin
        perform public._sync_group_class_purchase_refund(p_payment_id, v_studio_id, v_current_status = 'refunded');
      exception when others then
        raise warning 'REFUND_RECON_GC_SYNC_FAILED payment=% sqlstate=%', p_payment_id, sqlstate;
      end;
    end if;
    return query select false, false, false; -- duplicate delivery, already applied
    return;
  end if;

  perform public._record_payment_settlement_conflict(
    v_studio_id, p_payment_id, v_client_package_id, p_stripe_event_id, p_stripe_event_type, null,
    format(
      'Stripe reported a refund (%s) at %s against a payment DanceFlow''s own record shows as ''%s'', not ''paid''. Verify in Stripe whether money was actually returned, and reconcile manually.',
      p_stripe_event_type, now(), v_current_status
    )
  );
  return query select false, false, true;
end;
$$;

revoke all on function public._apply_payment_refund_and_reevaluate(uuid, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public._apply_payment_refund_and_reevaluate(uuid, text, numeric, text, text, text) to service_role;

commit;
