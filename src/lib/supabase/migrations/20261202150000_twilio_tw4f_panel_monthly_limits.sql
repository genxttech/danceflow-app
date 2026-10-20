-- 20261202150000_twilio_tw4f_panel_monthly_limits.sql
-- TW-4F platform-admin panel follow-up: the monthly spending limit of each legal business, READ-ONLY, for the supervised-pilot panel.
--   tw4_panel_monthly_limits(actor)   per legal business: the calendar month and its timezone, the owner-approved limit, the platform ceiling, the effective
--                                     limit, next month's limit and timezone, what the month has spent or set aside, and the last few limit changes.
-- The same private helpers as the owner's sms_monthly_limit_overview compute every figure (_tw4ml_month_key, _tw4ml_tz_for, _tw4ml_limit_for,
-- _tw4ml_ceiling_for, _tw4ml_effective_limit, _tw4ml_month_parts), so the panel and the owner screen can never disagree. Same JSON keys as that
-- function, plus legal_entity_id; credit fields are left out (the panel already reads them from tw4_panel_overview).
-- READ-ONLY and NON-FINANCIAL: no table, no write, no authority. It never records a timezone (it does not call _tw4ml_ensure_tz). Only a platform
-- admin actor (re-checked here) through the service role may call it.
-- Depends on 20261128090000 (monthly limits) and 20261130090000 (admin panel). Independent of 20261201090000 (it only calls _tw4ml_month_parts,
-- whichever version is installed).
-- Rollback order: application first (the panel degrades to "not available" without it), then rollback/20261202150000_..._rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.sms_monthly_limit_overview(uuid)') is null or to_regprocedure('public._tw4ml_month_parts(uuid,text)') is null then
    raise exception 'TW-4F panel monthly limits precondition failed: 20261128090000 is not applied';
  end if;
  if to_regprocedure('public.tw4_panel_overview(uuid)') is null or to_regprocedure('public._tw4_r1_is_platform_admin(uuid)') is null then
    raise exception 'TW-4F panel monthly limits precondition failed: 20261130090000 is not applied';
  end if;
end $$;

create or replace function public.tw4_panel_monthly_limits(p_actor uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'legal_entity_id', e.id,
      'legal_business', true,
      'month', k.cur,
      'timezone', public._tw4ml_tz_for(e.id, k.cur),
      'next_month_timezone', public._tw4ml_tz_for(e.id, k.nxt),
      'limit_cents', public._tw4ml_limit_for(e.id, k.cur),
      'ceiling_cents', public._tw4ml_ceiling_for(e.id),
      'effective_limit_cents', public._tw4ml_effective_limit(e.id, k.cur),
      'next_month_limit_cents', public._tw4ml_limit_for(e.id, k.nxt),
      'parts', public._tw4ml_month_parts(e.id, k.cur),
      'pilot_business', exists (select 1 from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = e.id),
      'recent_changes', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (
          select l.effective_month, l.limit_cents, l.previous_limit_cents, l.spend_at_change_cents, l.changed_by_role, l.created_at
            from public.studio_sms_monthly_limits l where l.legal_entity_id = e.id order by l.created_at desc limit 5) r), '[]'::jsonb)
    ) order by e.created_at)
    from public.studio_sms_legal_entities e
    cross join lateral (select public._tw4ml_month_key(e.id, now()) as cur) c
    cross join lateral (select c.cur, public._tw4ml_key_add(c.cur, 1) as nxt) k
  ), '[]'::jsonb);
end $$;

revoke all on function public.tw4_panel_monthly_limits(uuid) from public, anon, authenticated;
grant execute on function public.tw4_panel_monthly_limits(uuid) to service_role;

commit;
