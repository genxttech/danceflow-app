-- Rollback for 20270120104000_competition_cf1_rb3_evidence_reconciliation.sql. Restores the RB3-only state: the RB3 body of
-- _cf1_entry_refund_evidence_reason (md5 of pg_proc.prosrc c4e51b4094dfb43d92c93935a21f3a7b) and drops every object the migration added.
-- REFUSES while any reconciliation row exists: the rows are append-only audit evidence of owner-side decisions, so export them first
-- (the table can then only be dropped by an operator who has removed the rows deliberately, outside this script).
-- Run BEFORE the RB3 rollback (20270120102000), after the F3 / later CF1 rollbacks.
begin;

do $$
begin
  if to_regclass('public.competition_cf1_rb3_reconciliations') is not null
     and exists (select 1 from public.competition_cf1_rb3_reconciliations) then
    raise exception 'CF1-RB3R rollback: reconciliation audit rows exist (%); export them before rolling back.',
      (select count(*) from public.competition_cf1_rb3_reconciliations);
  end if;
end $$;

create or replace function public._cf1_entry_refund_evidence_reason(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_blocked boolean;
  v_recorded boolean;
  v_pending boolean;
  v_unattr_succeeded boolean;
  v_unattr_pending boolean;
begin
  if p_entry_id is null or public._cf1_refund_evidence_mode() <> 'r2_ledger' then
    return null;
  end if;

  -- Allocations that name the entry. failed / canceled refunds (including a succeeded refund Stripe later reversed) do not count.
  select coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open')), false),
         coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and not (a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open'))), false),
         coalesce(bool_or(r.status in ('requested', 'pending', 'requires_action')), false)
    into v_blocked, v_recorded, v_pending
  from public.event_order_refund_allocations a
  join public.event_order_refunds r on r.id = a.refund_id
  cross join lateral (
    select exists (select 1 from public.event_competition_refund_exception_scopes s
                   where s.entry_id = a.entry_id and s.refund_id = a.refund_id
                     and s.kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat'))
           and not exists (select 1 from public.event_competition_refund_exception_scopes s
                           where s.entry_id = a.entry_id and s.refund_id = a.refund_id
                             and s.kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat')
                             and (s.resolution is null or s.resolution not in ('keep_entry', 'result_stands', 'k0_correction'))) as resolved
  ) x
  where a.entry_id = p_entry_id and a.line_kind = 'entry'
    and r.status in ('requested', 'pending', 'requires_action', 'succeeded');

  -- Dashboard (externally initiated) refunds on the entry's order that have no allocation at all: R2 cannot say which entry they concern.
  select coalesce(bool_or(r.status = 'succeeded'), false),
         coalesce(bool_or(r.status in ('pending', 'requires_action')), false)
    into v_unattr_succeeded, v_unattr_pending
  from public.event_competition_entries e
  join public.event_orders o on o.id = e.order_id
  join public.event_order_refunds r on r.order_id = o.id
  where e.id = p_entry_id
    and o.payment_status is distinct from 'refunded'
    and r.source = 'stripe_dashboard'
    and r.status in ('succeeded', 'pending', 'requires_action')
    and not exists (select 1 from public.event_order_refund_allocations a2 where a2.refund_id = r.id);

  return case when v_blocked then 'entry_refund_withdrawal_blocked'
              when v_recorded then 'entry_refund_recorded'
              when v_pending or v_unattr_pending then 'entry_refund_pending'
              when v_unattr_succeeded then 'entry_refund_unattributed_order'
              else null end;
end;
$$;
revoke all on function public._cf1_entry_refund_evidence_reason(uuid) from public, anon, authenticated, service_role;

drop function public.cf1_refund_evidence_state(uuid);
drop function public.revoke_cf1_refund_evidence_release(uuid, text, uuid);
drop function public.cosign_cf1_refund_evidence_release(uuid, uuid);
drop function public.request_cf1_refund_evidence_release(uuid, text, uuid);
drop function public._cf1_rb3r_guard(uuid, uuid, text, boolean);
drop function public._cf1_rb3r_result(public.competition_cf1_rb3_reconciliations, boolean);
drop function public._cf1_rb3_release_valid(uuid);
drop function public._cf1_rb3_raw(uuid);
drop function public._cf1_rb3_snapshot(uuid);
drop table public.competition_cf1_rb3_reconciliations;
drop function public._cf1_rb3r_protect();

do $$
begin
  if (select md5(replace(prosrc, E'', '')) from pg_proc where oid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure) is distinct from 'c4e51b4094dfb43d92c93935a21f3a7b' then
    raise exception 'CF1-RB3R rollback postflight: the RB3 body was not restored exactly.';
  end if;
end $$;

commit;
