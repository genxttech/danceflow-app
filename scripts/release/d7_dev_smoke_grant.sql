-- D7 DEV-ONLY smoke-test manual grant (Organizer Suite, source 'manual_grant', open-ended, status active).
-- Purpose: give ONE hosted-DEV studio a CURRENT complimentary Organizer Suite grant so the D7 core smoke plan (S1, S3, S4..S8) can run.
-- NEVER run against PROD. Not run against hosted DEV by its author (disposable-Postgres test only); running it on DEV needs owner approval.
-- Rollback: scripts/release/d7_dev_smoke_grant_rollback.sql (sets status 'canceled'; it never deletes after the D7 migrations).
--
-- HOW TO USE: edit v_studio below (the nil UUID makes the script refuse), then
--   supabase db query --linked -f scripts/release/d7_dev_smoke_grant.sql -o json
-- The whole script is one transaction: any refusal leaves the database untouched.
--
-- WHICH STUDIO: it must have a Starter/Growth/Pro studio_subscriptions row (active or trialing; the Organizer plan does not consult the grant
-- and would not exercise it) and ideally NO other active Organizer Suite row (a Stripe-sourced row would keep access current and hide the
-- "no entitlement" and "lapsed grant" smoke cases S2/S3). See docs/billing/D7-DEV-SMOKE-GRANT.md section 3 for the findings on DEV today.
--
-- DEV-ONLY CHECK (fail closed, three independent signals; LIMITS in the doc, section 4):
--   (1) none of the known PROD marker rows exists (DanceAbel studio dd6c35ce-..., the two PROD manual grants 095f8801-... and b515dc91-...);
--   (2) the known DEV marker rows DO exist (DEV studio a25932ab-..., DEV Stripe-item entitlement a3b1df74-...);
--   (3) the Supabase migration-history table exists (DEV has one; PROD does not: d7 core runbook section 3 step 2).
-- If DEV is ever rebuilt or those fixture rows are removed, the script refuses (update the markers deliberately, never loosen the logic).

begin;
set local lock_timeout = '5s';

do $$
declare
  v_studio uuid := '00000000-0000-0000-0000-000000000000';   -- <<< EDIT: the DEV studio that should receive the smoke grant
  v_note constant text := 'DEV D7 smoke test, remove after';
  v_tz text;
  v_plan text;
  v_status text;
  v_other_active integer;
  v_id uuid;
begin
  if v_studio = '00000000-0000-0000-0000-000000000000' then
    raise exception 'd7_dev_smoke_grant refused: edit v_studio first';
  end if;

  -- (1) PROD markers must be absent.
  if exists (select 1 from public.studios where id = 'dd6c35ce-0765-4247-afc2-9738817e991c')
     or exists (select 1 from public.usage_addon_entitlements where id in ('095f8801-7d18-4c73-8d0e-141bd93dcbca', 'b515dc91-5d28-4c19-90d8-4cd589ad57fe')) then
    raise exception 'd7_dev_smoke_grant refused: a PROD marker row exists, this looks like the PRODUCTION database';
  end if;
  -- (2) DEV markers must be present.
  if not exists (select 1 from public.studios where id = 'a25932ab-93a6-4a35-9434-1e7442135a73')
     or not exists (select 1 from public.usage_addon_entitlements where id = 'a3b1df74-0f56-44fe-a217-8f60d9fc7cc4') then
    raise exception 'd7_dev_smoke_grant refused: the DEV marker rows are missing, cannot confirm this is the DEV database';
  end if;
  -- (3) migration-history table (present on DEV, absent on PROD).
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'd7_dev_smoke_grant refused: supabase_migrations.schema_migrations is missing, cannot confirm this is the DEV database';
  end if;

  select s.timezone into v_tz from public.studios s where s.id = v_studio;
  if not found then
    raise exception 'd7_dev_smoke_grant refused: studio % does not exist', v_studio;
  end if;

  select sp.code, ss.status into v_plan, v_status
  from public.studio_subscriptions ss join public.subscription_plans sp on sp.id = ss.subscription_plan_id
  where ss.studio_id = v_studio
  order by ss.created_at desc limit 1;
  if v_plan is null or v_plan not in ('starter', 'growth', 'pro') or v_status not in ('active', 'trialing') then
    raise exception 'd7_dev_smoke_grant refused: studio % needs an active/trialing Starter, Growth or Pro subscription (found plan=%, status=%)', v_studio, v_plan, v_status;
  end if;

  -- the unique partial index (migration 20270203090000) would also reject this, but fail with a clear message even before it exists
  if exists (select 1 from public.usage_addon_entitlements
             where studio_id = v_studio and feature_key = 'organizer_suite' and source = 'manual_grant' and status = 'active') then
    raise exception 'd7_dev_smoke_grant refused: studio % already has an active manual Organizer Suite grant', v_studio;
  end if;

  select count(*) into v_other_active from public.usage_addon_entitlements
  where studio_id = v_studio and feature_key = 'organizer_suite' and status = 'active';
  if v_other_active > 0 then
    raise notice 'd7_dev_smoke_grant: studio % already has % other active Organizer Suite row(s); they keep access current and mask smoke cases S2/S3', v_studio, v_other_active;
  end if;

  -- Attribution for the audit trigger once the D7 migrations exist (transaction-local; harmless before them).
  perform set_config('app.entitlement_actor', 'd7_dev_smoke_grant', true);
  perform set_config('app.entitlement_reason', 'DEV D7 smoke test grant (scripts/release/d7_dev_smoke_grant.sql)', true);

  insert into public.usage_addon_entitlements
    (studio_id, workspace_type, feature_key, quantity_included, source, status, period_start, period_end, notes)
  values
    (v_studio, 'studio', 'organizer_suite', 1, 'manual_grant', 'active', null, null, v_note)
  returning id into v_id;

  raise notice 'd7_dev_smoke_grant: inserted entitlement % for studio % (plan %, timezone %)', v_id, v_studio, v_plan, coalesce(v_tz, 'NULL->UTC');
end $$;

-- evidence: the grant as stored
select id, studio_id, feature_key, source, status, period_start, period_end, notes
from public.usage_addon_entitlements
where source = 'manual_grant' and notes = 'DEV D7 smoke test, remove after' and status = 'active';

commit;
