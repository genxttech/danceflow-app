-- Rollback of 20270203090000_organizer_suite_entitlement_integrity.sql.
-- REFUSES while any audit event exists (append-only evidence of entitlement changes). Export the events first if a rollback is
-- ever required; this file never deletes them. Entitlement rows and their statuses are not changed by this rollback.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.usage_addon_entitlement_events') is not null then
    execute 'lock table public.usage_addon_entitlement_events in access exclusive mode';
    if exists (select 1 from public.usage_addon_entitlement_events) then
      raise exception 'entitlement-integrity rollback refused: audit events exist; they are permanent evidence (export them first, never delete)';
    end if;
  end if;
end $$;

drop trigger if exists usage_addon_entitlements_audit_trg on public.usage_addon_entitlements;
drop function if exists public.expire_due_usage_addon_entitlements(timestamptz, text);
drop function if exists public.usage_addon_entitlement_is_current(text, date, date, text, timestamptz);
drop function if exists public.usage_addon_entitlement_start_instant(date, text);
drop function if exists public.usage_addon_entitlement_end_instant(date, text);
drop function if exists public.usage_addon_entitlement_safe_timezone(text);
drop function if exists public.usage_addon_entitlements_audit();

-- Dropping the (verified empty) events table also drops its guard triggers.
drop table if exists public.usage_addon_entitlement_events;
drop function if exists public.usage_addon_entitlement_events_guard();

drop index if exists public.usage_addon_entitlements_one_active_manual_grant_studio;
drop index if exists public.usage_addon_entitlements_one_active_manual_grant_organizer;
commit;
