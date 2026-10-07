-- ROLLBACK for 20261027090000_refund_reconciliation_integrity.sql
--
-- Restores the exact PKG-P1 predecessor of public._apply_payment_refund_and_reevaluate
-- (body md5 d1f9bb5384bd7c54544133b3299bbf5a -- which fails every call with SQLSTATE
-- 42804; restoring it re-breaks Stripe refund reconciliation, so roll back only if
-- the repair itself is wrong) and drops the internal helper
-- public._sync_group_class_purchase_refund. Same signature, owner, SECURITY
-- DEFINER, search_path and ACL.
--
-- Data-safe: no payment, refund, package, client, attendee or settlement-conflict
-- row is changed or deleted. Refunds already reconciled by the repaired function
-- stay exactly as written.

begin;

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
      and md5(replace(p.prosrc, E'\r', '')) = '800b4ded082779735ce79ff7bb5ab3c8'
  ) then
    raise exception 'REFUND-RECON-1 rollback: _apply_payment_refund_and_reevaluate is not the reviewed repaired body';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = to_regprocedure('public._sync_group_class_purchase_refund(uuid,uuid,boolean)')
      and md5(replace(p.prosrc, E'\r', '')) = 'bd861352a8e8d2c4cfe727ac1b4b8f89'
  ) then
    raise exception 'REFUND-RECON-1 rollback: _sync_group_class_purchase_refund is not the reviewed helper';
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
  v_current_status text;
  v_deactivated boolean := false;
begin
  update public.payments
    set status = p_new_status, refund_amount = p_refund_amount, stripe_refund_id = p_stripe_refund_id
    where id = p_payment_id and status = 'paid'
    returning client_package_id, studio_id into v_client_package_id, v_studio_id;

  if found then
    if v_client_package_id is not null then
      v_deactivated := public._reevaluate_and_deactivate_package_if_unsettled(
        v_client_package_id,
        format('Automatically deactivated: originating payment %s was refunded.', p_payment_id)
      );
    end if;
    return query select true, v_deactivated, false;
  end if;

  select status, studio_id, client_package_id
    into v_current_status, v_studio_id, v_client_package_id
    from public.payments where id = p_payment_id;

  if v_current_status = p_new_status then
    return query select false, false, false; -- duplicate delivery, already applied
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

drop function public._sync_group_class_purchase_refund(uuid, uuid, boolean);

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and md5(replace(p.prosrc, E'\r', '')) = 'd1f9bb5384bd7c54544133b3299bbf5a'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'REFUND-RECON-1 rollback: predecessor not restored exactly';
  end if;
  if to_regprocedure('public._sync_group_class_purchase_refund(uuid,uuid,boolean)') is not null then
    raise exception 'REFUND-RECON-1 rollback: helper still exists';
  end if;
end $$;

commit;
