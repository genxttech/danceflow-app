-- Rollback for 20261028090000_refund_reconciliation_timestamp_integrity.sql (REFUND-RECON-2).
--
-- Restores the exact REFUND-RECON-1 body of public._apply_payment_refund_and_reevaluate
-- (md5 800b4ded082779735ce79ff7bb5ab3c8), which reconciles refunds without writing
-- refunded_at. Function definition only: no row is updated or deleted, so every
-- refunded_at value and accounting entry already written is preserved.
-- Refuses to run unless the live body is the REFUND-RECON-2 body (md5 6867f57dca8ae457c04cf557c21420e7).

begin;

do $$
begin
  if (select count(*) from pg_proc where proname = '_apply_payment_refund_and_reevaluate') <> 1
     or not exists (
       select 1 from pg_proc p
       where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
         and md5(replace(p.prosrc, E'\r', '')) = '6867f57dca8ae457c04cf557c21420e7'
     ) then
    raise exception 'REFUND-RECON-2 rollback: live _apply_payment_refund_and_reevaluate is not the REFUND-RECON-2 body';
  end if;
end $$;

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

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
      and md5(replace(p.prosrc, E'\r', '')) = '800b4ded082779735ce79ff7bb5ab3c8'
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'REFUND-RECON-2 rollback: post-check failed (REFUND-RECON-1 body/posture not restored)';
  end if;
end $$;

commit;
