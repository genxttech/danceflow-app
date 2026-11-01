-- Rollback of 20270209090000_d24_m3c_client_invoice.sql. REFUSES (unless `set d24.m3c_rollback_exported = 'yes';` was run in the same session AFTER exporting
-- studio_client_invoices, studio_client_invoice_lines and studio_client_invoice_audit) while any invoice, line or audit row exists, and ALWAYS refuses while an
-- M3-A creation intent exists for the 'studio_client_invoice' type (a provider draft invoice would be orphaned: resolve/export those intents first).
-- Stop the creation flow first. Unregisters the ownership type from the M3-A registry.
begin;
set local lock_timeout = '5s';
lock table public.studio_client_invoices, public.studio_client_invoice_lines, public.studio_client_invoice_audit, public.studio_client_invoice_limits in access exclusive mode;
do $$
begin
  if exists (select 1 from public.hosted_invoice_creation_intents where business_object_type = 'studio_client_invoice') then
    raise exception 'd24 m3c rollback refused: creation intents exist for studio_client_invoice';
  end if;
  if exists (select 1 from public.hosted_invoice_registry where business_object_type = 'studio_client_invoice') then
    raise exception 'd24 m3c rollback refused: registry rows exist for studio_client_invoice';
  end if;
  if (exists (select 1 from public.studio_client_invoices) or exists (select 1 from public.studio_client_invoice_lines) or exists (select 1 from public.studio_client_invoice_audit))
     and coalesce(current_setting('d24.m3c_rollback_exported', true), '') <> 'yes' then
    raise exception 'd24 m3c rollback refused: client invoice evidence exists; export it first';
  end if;
end $$;
delete from public.hosted_invoice_business_object_types where business_object_type = 'studio_client_invoice';
drop function if exists public.studio_client_invoice_link_registration(uuid, uuid, uuid, integer, text);
drop function if exists public.studio_client_invoice_creation_spec(uuid, uuid);
drop function if exists public.d24_owns_studio_client_invoice(uuid, text);
drop function if exists public.studio_client_invoice_save_draft(uuid, uuid, uuid, integer, uuid, text, uuid, text, jsonb);
drop function if exists public._sci_json(public.studio_client_invoices, text);
drop table public.studio_client_invoice_audit;
drop table public.studio_client_invoice_lines;
drop table public.studio_client_invoices;
drop table public.studio_client_invoice_limits;
drop function if exists public._sci_content_hash(uuid, text, uuid, text, uuid);
drop function if exists public._sci_parse_lines(jsonb);
drop function if exists public._sci_check_totals();
drop function if exists public._sci_line_guard();
drop function if exists public._sci_invoice_guard();
drop function if exists public._sci_limits_guard();
drop function if exists public._sci_refuse();
drop function if exists public._sci_require_writer();
drop function if exists public._sci_aal();
drop function if exists public._sci_authorize(uuid, text);
drop function if exists public._sci_actor_role(uuid);
drop function if exists public.studio_billing_permission(uuid, text);
commit;
