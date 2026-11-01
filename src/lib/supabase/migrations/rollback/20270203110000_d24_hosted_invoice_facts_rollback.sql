-- Rollback of 20270203110000_d24_hosted_invoice_facts.sql. REFUSES while any D24 row exists (the rows are permanent evidence): export first.
-- Roll the app back first (clear D24_HOSTED_INVOICE_EVENTS), then run this.
begin;
set local lock_timeout = '5s';
lock table public.hosted_invoice_registry, public.hosted_invoices, public.hosted_invoice_payments, public.hosted_credit_notes,
  public.hosted_invoice_status_transitions, public.hosted_invoice_source_events, public.hosted_invoice_recon_audit, public.hosted_invoice_deferred_events in access exclusive mode;
do $$
begin
  if exists (select 1 from public.hosted_invoice_registry)
     or exists (select 1 from public.hosted_invoices)
     or exists (select 1 from public.hosted_invoice_payments)
     or exists (select 1 from public.hosted_credit_notes)
     or exists (select 1 from public.hosted_invoice_status_transitions)
     or exists (select 1 from public.hosted_invoice_source_events)
     or exists (select 1 from public.hosted_invoice_recon_audit)
     or exists (select 1 from public.hosted_invoice_deferred_events) then
    raise exception 'd24 rollback refused: rows exist; export them as evidence first';
  end if;
end $$;
drop function if exists public.d24_drain_deferred(integer);
drop function if exists public.d24_defer_event(text, uuid, text, bigint, text, boolean, text, text, jsonb);
drop function if exists public.d24_acknowledge_anomalies(uuid, text[], uuid, text);
drop function if exists public.d24_apply_event(text, uuid, text, bigint, text, boolean, text, text, jsonb);
drop function if exists public._d24_apply_core(text, text, bigint, text, boolean, text, text, jsonb);
drop function if exists public._d24_validate_event(text, text, bigint, text, boolean, text, text, jsonb);
drop function if exists public._d24_classify(uuid);
drop function if exists public.d24_register_invoice(uuid, text, text, boolean, text, text, uuid);
drop function if exists public._d24_key_lock(text, text);
drop function if exists public._d24_try_adopt(uuid);
drop function if exists public._d24_flag(uuid, text, boolean);
drop function if exists public._d24_refresh_state(uuid, text, text);
drop table public.hosted_invoice_deferred_events;
drop table public.hosted_invoice_recon_audit;
drop table public.hosted_invoice_source_events;
drop table public.hosted_invoice_status_transitions;
drop table public.hosted_credit_notes;
drop table public.hosted_invoice_payments;
drop table public.hosted_invoices;
drop table public.hosted_invoice_registry;
drop function if exists public._d24_add_code(text[], text);
drop function if exists public._d24_derive_state(uuid, text, text[], text[]);
drop function if exists public._d24_deferred_guard();
drop function if exists public._d24_child_studio_check();
drop function if exists public._d24_parent_studio_check();
drop function if exists public._d24_audit_studio_check();
drop function if exists public._d24_identity_guard();
drop function if exists public._d24_append_only();
drop function if exists public._d24_require_writer();
commit;
