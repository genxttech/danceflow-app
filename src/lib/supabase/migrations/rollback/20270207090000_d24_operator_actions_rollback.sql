-- Rollback of 20270207090000_d24_operator_actions.sql. REFUSES while any operator evidence exists (dismissals, dismissal audit rows): export first.
-- Requeue evidence belongs to M2-C (20270206090000) and is untouched. Roll the app back first (clear D24_OPERATOR_ACTIONS), then run this.
begin;
set local lock_timeout = '5s';
lock table public.hosted_invoice_dismissals, public.hosted_invoice_recon_audit, public.hosted_invoice_operator_config, public.hosted_invoice_operator_config_audit in access exclusive mode;
do $$
begin
  if exists (select 1 from public.hosted_invoice_operator_config_audit) or exists (select 1 from public.hosted_invoice_dismissals) or exists (select 1 from public.hosted_invoice_recon_audit where trigger_kind = 'dismissal') then
    raise exception 'd24 m2b rollback refused: operator evidence exists; export it first';
  end if;
end $$;

drop function if exists public.d24_op_set_enabled(boolean, text);
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
drop function if exists public._d24_op_identity();
drop function if exists public._d24_op_config_guard() cascade;
drop table public.hosted_invoice_dismissals;
drop table public.hosted_invoice_operator_config_audit;
drop table public.hosted_invoice_operator_config;

alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_trigger_chk;
alter table public.hosted_invoice_recon_audit drop constraint hosted_invoice_recon_audit_ack_chk;
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_trigger_chk check (trigger_kind in ('event', 'registration', 'acknowledgement'));
alter table public.hosted_invoice_recon_audit add constraint hosted_invoice_recon_audit_ack_chk
  check (trigger_kind <> 'acknowledgement' or (actor_user_id is not null and reason is not null and length(btrim(reason)) > 0));

-- prior state: M1 p_actor ack function and M2-C requeue function executable by service_role only
grant execute on function public.d24_acknowledge_anomalies(uuid, text[], uuid, text) to service_role;
grant execute on function public.d24_requeue_deferred_event(text, uuid, text) to service_role;
commit;
