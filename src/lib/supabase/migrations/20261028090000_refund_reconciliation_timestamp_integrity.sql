-- 20261028090000_refund_reconciliation_timestamp_integrity.sql
--
-- REFUND-RECON-2: the canonical refund reconciliation RPC dates the refund
-- progress it applies.
--
-- public.sync_payment_accounting_entry_row (accounting foundation, unchanged)
-- keeps ONE cumulative refund entry per payment and dates it
--     coalesce(payments.refunded_at::date, <payment paid date>).
-- public._apply_payment_refund_and_reevaluate (REFUND-RECON-1, 800b4ded) never
-- wrote refunded_at, so a refund reconciled only through it (Stripe dashboard /
-- webhook refunds, GC-3.5 checkout-conflict refunds) was booked on the ORIGINAL
-- payment's date -- i.e. in the payment's accounting period, not the refund's.
--
-- Change (one line in the applied update; everything else byte-identical):
--     refunded_at = greatest(refunded_at, now())
--   * set only when refund progress is APPLIED (cumulative amount increases, or
--     the payment completes to 'refunded'); exact replays, stale/lower amounts and
--     a stale partial after a full refund never reach the update, so they never
--     touch refunded_at;
--   * "most recent refund progress" semantics -- the convention every other
--     writer already uses (staff refund action; the pre-PKG-P1 webhook): the one
--     cumulative refund entry is dated at the latest refund;
--   * never moves backwards (greatest() ignores a NULL refunded_at).
-- The new value is written in the same UPDATE as status/refund_amount, so the
-- accounting trigger sees it in the same sync. Accounting functions, the
-- trigger, per-entry period locks (locked_at), package re-evaluation, the Group
-- Class enrollment helper, conflict recording, the status enum and Stripe
-- identity columns are all unchanged.
--
-- Signature, return type, owner, SECURITY DEFINER, search_path and ACL
-- (postgres + service_role) are preserved.


begin;

-- >>> REFUND-RECON-2 PRECONDITIONS
do $$
declare
  v_missing text;
begin
  if (select count(*) from pg_proc where proname = '_apply_payment_refund_and_reevaluate') <> 1 then
    raise exception 'REFUND-RECON-2: unexpected _apply_payment_refund_and_reevaluate overloads';
  end if;
  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public._apply_payment_refund_and_reevaluate(uuid,text,numeric,text,text,text)'::regprocedure
      and p.prosecdef
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig = array['search_path=public']
      and pg_get_function_result(p.oid) = 'TABLE(applied boolean, package_deactivated boolean, conflict_recorded boolean)'
      and md5(replace(p.prosrc, E'\r', '')) = '800b4ded082779735ce79ff7bb5ab3c8'
      and (select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x) = 'postgres=X/postgres,service_role=X/postgres'
  ) then
    raise exception 'REFUND-RECON-2: _apply_payment_refund_and_reevaluate is not the reviewed REFUND-RECON-1 body';
  end if;

  -- Behavior this change relies on (refund effects + the accounting sync that consumes refunded_at), pinned exactly.
  select string_agg(want.sig, ', ') into v_missing
  from (values
    ('public._sync_group_class_purchase_refund(uuid,uuid,boolean)', 'bd861352a8e8d2c4cfe727ac1b4b8f89'),
    ('public._reevaluate_and_deactivate_package_if_unsettled(uuid,text)', '6fec069baaa30cbed1b57eb7825b021a'),
    ('public._record_payment_settlement_conflict(uuid,uuid,uuid,text,text,text,text)', '045835d65560af7677a698f52e5501f9'),
    ('public.enforce_attendee_cancel_no_terminal_attendance()', 'd7e90072acc77b158bd4121306d30db6'),
    ('public.sync_payment_accounting_entry()', '732032d8149b52844c636185cb6aa202'),
    ('public.sync_payment_accounting_entry_row(uuid)', 'd52d31d97d4504793af20b018490cb38'),
    ('public.accounting_upsert_entry(uuid,uuid,date,text,text,text,numeric,numeric,numeric,numeric,text,text,text,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid)', '548b512c2cf4ca3534ff2541594a1c7c'),
    ('public.accounting_mark_source_voided(text,uuid,text)', '883ff6fb8c8b3c1aa00564f570ee3d8e'),
    ('public.accounting_assert_entry_mutable()', 'f94269788e32046f52c56a641234620b')
  ) as want(sig, body_md5)
  where to_regprocedure(want.sig) is null
     or (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p where p.oid = to_regprocedure(want.sig)) <> want.body_md5;
  if v_missing is not null then
    raise exception 'REFUND-RECON-2: dependency drift: %', v_missing;
  end if;

  -- The accounting trigger must re-sync on refunded_at (it does: AFTER INSERT OR UPDATE OF ... refunded_at ...).
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.payments'::regclass
      and t.tgname = 'trg_sync_payment_accounting_entry'
      and not t.tgisinternal
      and t.tgenabled = 'O'
      and t.tgfoid = 'public.sync_payment_accounting_entry()'::regprocedure
      and pg_get_triggerdef(t.oid) like '%refunded_at%'
  ) then
    raise exception 'REFUND-RECON-2: payment accounting trigger missing, disabled or not re-syncing on refunded_at';
  end if;

  if not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'payments' and c.column_name = 'refunded_at'
      and c.data_type = 'timestamp with time zone' and c.is_nullable = 'YES'
  ) then
    raise exception 'REFUND-RECON-2: payments.refunded_at is not a nullable timestamptz';
  end if;

  if (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e
        join pg_attribute a on a.atttypid = e.enumtypid
        where a.attrelid = 'public.payments'::regclass and a.attname = 'status') <> 'pending,paid,refunded,failed,voided' then
    raise exception 'REFUND-RECON-2: payments.status is not the reviewed payment_status enum';
  end if;
end $$;
-- <<< REFUND-RECON-2 PRECONDITIONS

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
        -- REFUND-RECON-2: refund progress is dated when it is applied (accounting dates the refund entry from
        -- refunded_at); never moved backwards; replays and stale events never reach this update.
        refunded_at = greatest(refunded_at, now()),
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
