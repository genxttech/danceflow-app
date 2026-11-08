-- Rollback of scripts/release/d7_dev_smoke_grant.sql. DEV-ONLY. Not run against hosted DEV by its author.
-- Default action: set the grant's status to 'canceled' (history kept; works BEFORE and AFTER the D7 migrations, and is audited once they exist).
-- Alternative (variant B, commented out at the bottom): DELETE the row. Applicable ONLY while the D7 migrations are NOT applied
-- (after 20270203100000 the service role has no DELETE; after 20270203090000 a delete is audited as a 'delete' event, and events are permanent).
-- Edit v_studio (must match the grant script); the nil UUID makes the script refuse.

begin;
set local lock_timeout = '5s';

do $$
declare
  v_studio uuid := '00000000-0000-0000-0000-000000000000';   -- <<< EDIT: same studio as the grant script
  v_note constant text := 'DEV D7 smoke test, remove after';
  v_n integer;
begin
  if v_studio = '00000000-0000-0000-0000-000000000000' then
    raise exception 'd7_dev_smoke_grant_rollback refused: edit v_studio first';
  end if;
  if exists (select 1 from public.studios where id = 'dd6c35ce-0765-4247-afc2-9738817e991c')
     or exists (select 1 from public.usage_addon_entitlements where id in ('095f8801-7d18-4c73-8d0e-141bd93dcbca', 'b515dc91-5d28-4c19-90d8-4cd589ad57fe')) then
    raise exception 'd7_dev_smoke_grant_rollback refused: a PROD marker row exists, this looks like the PRODUCTION database';
  end if;
  if not exists (select 1 from public.studios where id = 'a25932ab-93a6-4a35-9434-1e7442135a73')
     or not exists (select 1 from public.usage_addon_entitlements where id = 'a3b1df74-0f56-44fe-a217-8f60d9fc7cc4')
     or to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'd7_dev_smoke_grant_rollback refused: cannot confirm this is the DEV database';
  end if;

  perform set_config('app.entitlement_actor', 'd7_dev_smoke_grant', true);
  perform set_config('app.entitlement_reason', 'DEV D7 smoke test grant removed (scripts/release/d7_dev_smoke_grant_rollback.sql)', true);

  -- Only the marked smoke grant is touched: studio + feature + source + exact note + still active.
  update public.usage_addon_entitlements
  set status = 'canceled', updated_at = now()
  where studio_id = v_studio and feature_key = 'organizer_suite' and source = 'manual_grant'
    and notes = v_note and status = 'active';
  get diagnostics v_n = row_count;
  if v_n > 1 then
    raise exception 'd7_dev_smoke_grant_rollback: % rows matched, expected at most 1; rolled back', v_n;
  end if;
  raise notice 'd7_dev_smoke_grant_rollback: canceled % row(s)', v_n;
end $$;

select id, studio_id, source, status, period_end, notes
from public.usage_addon_entitlements
where source = 'manual_grant' and notes = 'DEV D7 smoke test, remove after';

commit;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- VARIANT B (delete) -- ONLY if the D7 migrations are NOT applied on that database. Uncomment and run as its own transaction.
-- Refuses once the audit table exists.
--
-- begin;
-- do $$ begin
--   if to_regclass('public.usage_addon_entitlement_events') is not null then
--     raise exception 'variant B refused: D7 migrations are applied; use the cancel variant above';
--   end if;
-- end $$;
-- delete from public.usage_addon_entitlements
-- where studio_id = '00000000-0000-0000-0000-000000000000'  -- EDIT
--   and feature_key = 'organizer_suite' and source = 'manual_grant' and notes = 'DEV D7 smoke test, remove after';
-- commit;
