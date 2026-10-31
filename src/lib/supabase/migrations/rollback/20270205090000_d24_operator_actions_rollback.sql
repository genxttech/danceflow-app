-- Rollback of 20270205090000_d24_operator_actions.sql. REFUSES while any operator evidence exists (dismissals, requeues, dismissal audit rows): export first.
-- Roll the app back first (clear D24_OPERATOR_ACTIONS), then run this. A requeued event is back in 'pending'/'applied' history; the M1 guard is restored below.
begin;
set local lock_timeout = '5s';
lock table public.hosted_invoice_dismissals, public.hosted_invoice_deferred_requeues, public.hosted_invoice_recon_audit in access exclusive mode;
do $$
begin
  if exists (select 1 from public.hosted_invoice_dismissals) or exists (select 1 from public.hosted_invoice_deferred_requeues)
     or exists (select 1 from public.hosted_invoice_recon_audit where trigger_kind = 'dismissal') then
    raise exception 'd24 m2b rollback refused: operator evidence exists; export it first';
  end if;
end $$;

drop function if exists public.d24_op_list_deferred(text, integer, integer);
drop function if exists public.d24_op_get_invoice(uuid);
drop function if exists public.d24_op_list_invoices(text, uuid, boolean, integer, integer);
drop function if exists public.d24_op_requeue_deferred(text, text);
drop function if exists public.d24_op_dismiss_unmatched(uuid, text);
drop function if exists public.d24_op_acknowledge_anomalies(uuid, text[], text);
drop function if exists public._d24_op_studio_ackable(text);
drop function if exists public._d24_op_reason(text);
drop function if exists public._d24_op_is_studio_operator(uuid, uuid);
drop function if exists public._d24_op_is_platform_admin(uuid);
drop function if exists public._d24_op_caller();
drop table public.hosted_invoice_deferred_requeues;
drop table public.hosted_invoice_dismissals;

alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_trigger_chk;
alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_ack_chk;
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_trigger_chk check (trigger_kind in ('event', 'registration', 'acknowledgement'));
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_ack_chk
  check (trigger_kind <> 'acknowledgement' or (actor_user_id is not null and reason is not null and length(btrim(reason)) > 0));

create or replace function public._d24_deferred_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'd24: deferred events are permanent evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if coalesce(current_setting('d24.writer', true), '') <> 'on' then
      raise exception 'd24: INSERT on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  if coalesce(current_setting('d24.writer', true), '') <> 'on' then
    raise exception 'd24: UPDATE on % is only allowed through the d24 functions', tg_table_name using errcode = '42501';
  end if;
  if new.provider_event_id is distinct from old.provider_event_id or new.event_type is distinct from old.event_type
     or new.stripe_account_id is distinct from old.stripe_account_id or new.livemode is distinct from old.livemode
     or new.event_created is distinct from old.event_created or new.payload_hash is distinct from old.payload_hash
     or new.object_kind is distinct from old.object_kind or new.object_snapshot is distinct from old.object_snapshot
     or new.received_at is distinct from old.received_at then
    raise exception 'd24: deferred event evidence is immutable' using errcode = '42501';
  end if;
  if old.state <> 'pending' and (new.state is distinct from old.state or new.settled_at is distinct from old.settled_at) then
    raise exception 'd24: a settled deferred event cannot change state' using errcode = '42501';
  end if;
  if new.attempts < old.attempts then
    raise exception 'd24: attempts cannot decrease' using errcode = '42501';
  end if;
  return new;
end $$;

-- M1 state: the p_actor function is executable by service_role only.
grant execute on function public.d24_acknowledge_anomalies(uuid, text[], uuid, text) to service_role;
commit;
