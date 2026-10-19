-- 20261124090000_twilio_tw4f3b_ui_credit_reads.sql
-- TW-4F-3b-UI: read-only functions for the prepaid-credit screens. No table, constraint, trigger or existing function changes; nothing here can move money.
--   sms_credit_purchases(studio, limit)  the legal business's purchases for an owner/administrator of one of its locations (pending / paid / failed / expired, refunds)
--   sms_credit_admin_overview()          platform-admin monitoring: published prices with provider cost, accounts needing attention, stale pending purchases,
--                                        reconciliation variances, and the ConfiDance pilot ceiling (a separate, non-spendable authorization)
-- Requires 20261123090000 (TW-4F-3b-pay). Rollback: rollback/20261124090000_twilio_tw4f3b_ui_credit_reads_rollback.sql (drops both functions; no data).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_credit_checkout_context(uuid,uuid)') is null then
    raise exception 'TW-4F-3b-UI precondition failed: TW-4F-3b-pay is not applied';
  end if;
end $$;

create or replace function public.sms_credit_purchases(p_studio_id uuid, p_limit int default 20)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_entity uuid;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from (
    select t.created_at, t.amount_cents, t.refunded_cents, t.disputed_cents, t.settled_at,
           case when t.status = 'pending' and t.expires_at is not null and t.expires_at <= now() then 'expired' else t.status end as status,
           coalesce(t.paid_by_studio_id = p_studio_id, false) as this_location
      from public.studio_sms_credit_topups t
     where t.legal_entity_id = v_entity
     order by t.created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) h), '[]'::jsonb);
end $$;

create or replace function public.sms_credit_admin_overview()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public._sms_onb_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'prices', coalesce((select jsonb_agg(jsonb_build_object('kind', p.kind, 'customer_price_cents', p.customer_price_cents, 'provider_cost_cents', p.provider_cost_cents, 'description', p.description) order by p.kind)
                          from public.studio_sms_price_list p where p.active), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.attention desc, a.balance_cents) from (
        select e.id as legal_entity_id, e.legal_name, ca.balance_cents, ca.reserved_cents, ca.hold, ca.hold_reason,
               (ca.low_balance_flagged_at is not null) as low_balance,
               coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.legal_entity_id = e.id and t.status = 'pending' and (t.expires_at is null or t.expires_at > now())), 0) as pending_cents,
               (select count(*) from public.studio_sms_entity_studios es where es.legal_entity_id = e.id) as locations,
               (ca.balance_cents < 0 or ca.hold or ca.low_balance_flagged_at is not null) as attention
          from public.studio_sms_credit_accounts ca join public.studio_sms_legal_entities e on e.id = ca.legal_entity_id
         order by (ca.balance_cents < 0 or ca.hold or ca.low_balance_flagged_at is not null) desc, ca.balance_cents limit 100) a), '[]'::jsonb),
    'stale_pending', coalesce((select jsonb_agg(jsonb_build_object('legal_name', e.legal_name, 'amount_cents', t.amount_cents, 'created_at', t.created_at, 'expires_at', t.expires_at) order by t.created_at)
                                 from public.studio_sms_credit_topups t join public.studio_sms_legal_entities e on e.id = t.legal_entity_id
                                where t.status = 'pending' and coalesce(t.expires_at, t.created_at) < now() - interval '1 hour'), '[]'::jsonb),
    'variances', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc) from (
        select e.legal_name, c.kind, c.provider_cost_cents, c.expected_cost_cents, c.variance_cents, c.created_at
          from public.studio_sms_provider_charges c join public.studio_sms_legal_entities e on e.id = c.legal_entity_id
         where c.status = 'variance' order by c.created_at desc limit 20) v), '[]'::jsonb),
    'pilot', (select jsonb_build_object('legal_name', e.legal_name, 'ceiling_cents', x.ceiling_cents,
                'used_cents', coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r where r.legal_entity_id = x.legal_entity_id and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0))
                from public.studio_sms_pilot_exceptions x join public.studio_sms_legal_entities e on e.id = x.legal_entity_id));
end $$;

revoke all on function public.sms_credit_purchases(uuid, int), public.sms_credit_admin_overview() from public, anon;
grant execute on function public.sms_credit_purchases(uuid, int), public.sms_credit_admin_overview() to authenticated;

commit;
